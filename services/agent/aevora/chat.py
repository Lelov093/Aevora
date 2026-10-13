"""Managed foreground tasks. Streams are transient; terminal confirmation is durable."""
import asyncio

import httpx

from .errors import DomainError
from .gateway import ModelGateway
from .memory_governance import cached
from .context import build_context
from .conversation_work import approved as approved_work
from .recall import current
from .work import VERSION as WORK_VERSION, decode as decode_work, reply_prefix


class ChatRuntime:
    def __init__(self, store, config=None, recall=None):
        self.store = store
        self.gateway = ModelGateway(config)
        self.tasks = {}
        self.live = {}
        self.metadata = {}
        self.subscribers = set()
        self.closed = False
        self.recall = recall

    def broadcast(self, event):
        for queue in list(self.subscribers):
            if queue.full():
                # Full-text projections are replaceable; don't block provider reads on a stale window.
                queue.get_nowait()
            queue.put_nowait(event)

    def snapshot(self):
        return self.store.snapshot() | {"provider": self.gateway.public(), "live_runs": [{k:v for k,v in r.items() if k != 'raw_text'} for r in self.live.values()]}

    def send(self, command):
        if self.closed:
            raise DomainError("ProviderUnavailable", "Runtime is shutting down")
        # Returning an old idempotent command must work even if the credential was removed later.
        from contextlib import closing
        import json
        with closing(self.store.connect()) as db:
            old = cached(db, command, json.dumps(command, sort_keys=True, separators=(",", ":")))
            if old is not None:
                return old
        config = self.gateway.ready()
        response, messages = self.store.conversation.start(command, config)
        if messages is not None:
            run = response["data"]
            rid = run["run_id"]
            self.live[rid] = {"run_id": rid, "agent_id": run["agent_id"], "conversation_id": run["conversation_id"],
                              "text": "", "state": "Running", "saved": False}
            self.tasks[rid] = asyncio.create_task(self.generate(run, messages, config))
        return response

    async def generate(self, run, messages, config):
        rid, aid = run["run_id"], run["agent_id"]
        metadata = {}
        work_enabled = bool(run['context'].get('work_version'))
        self.live[rid]['raw_text'] = ''
        self.metadata[rid] = metadata
        state, error = "Failed", None
        try:
            if self.recall:
                import json
                with self.store.connect() as db:
                    source = db.execute("SELECT content,sequence FROM messages WHERE message_id=? AND agent_id=?", (run["input_message_id"], aid)).fetchone()
                memories, recalled = await self.recall.prepare(aid, source[0])
                with self.store.transaction() as db:
                    latest = self.store.conversation.run(db, aid, rid)
                    self.store.conversation.target(db, aid, run["conversation_id"])
                    if latest["state"] != "Created":
                        return
                    if not current(db, aid, memories):
                        raise DomainError("RecallUpdating", "Memory changed before send; current index must be ready")
                    approval = latest['context'].get('goal_context')
                    projection = self.store.goals.approved_context(db, aid, approval) if approval else None
                    work_approval = latest['context'].get('work_context')
                    work_projection = approved_work(self.store, db, aid, run['conversation_id'], work_approval) if work_approval else None
                    messages, refs = build_context(db, self.store.identity.profile(db, aid), run["conversation_id"], source[0],
                        config, latest["context"].get("history_before_sequence", source["sequence"]), memories, recalled,
                        input_timezone=self.store.input_timezone, goal_projection=projection, work_suggestions=work_enabled, work_projection=work_projection)
                    if work_enabled:
                        refs['work_version'] = WORK_VERSION
                    refs["input_message_id"] = run["input_message_id"]
                    db.execute("UPDATE runs SET context=? WHERE run_id=?", (json.dumps(refs), rid))
            if not self.store.conversation.running(aid, rid):
                return
            # There is no await between this final authority check and handing the request to the gateway.
            with self.store.transaction() as db:
                latest = self.store.conversation.run(db, aid, rid)
                if latest["context"].get("context_stale"):
                    raise DomainError("ContextStale", "Memory changed before provider send")
                if latest['context'].get('goal_context'):
                    self.store.goals.approved_context(db, aid, latest['context']['goal_context'])
                if latest['context'].get('work_context'):
                    approved_work(self.store, db, aid, run['conversation_id'], latest['context']['work_context'])
                if latest['context'].get('method_context'):
                    self.store.evolution.resolve(db, aid, latest['context']['method_context'])
                refs = latest["context"] | {"request_sent": True}
                import json
                db.execute("UPDATE runs SET context=? WHERE run_id=?", (json.dumps(refs), rid))
            def consume(delta):
                live = self.live[rid]
                if work_enabled:
                    live['raw_text'] += delta
                    if len(live['raw_text']) > 65536:
                        raise DomainError('BudgetExceeded', 'Work response exceeded local capacity')
                    live['text'] = reply_prefix(live['raw_text'])
                    self.broadcast({"type": "RunDelta", **{k:v for k,v in live.items() if k != 'raw_text'}})
                    return
                if len(live["text"]) + len(delta) > 32_768:
                    raise DomainError("BudgetExceeded", "Provider output exceeded the local text limit")
                live["text"] += delta
                self.broadcast({"type": "RunDelta", **live})
            if work_enabled:
                await self.gateway.stream(config, messages, consume, metadata, response_format={'type': 'json_object'})
            else:
                await self.gateway.stream(config, messages, consume, metadata)
            reason = metadata.get("finish_reason")
            if reason == 'stop' and work_enabled:
                self.live[rid]['text'] = decode_work(self.live[rid]['raw_text'])[0]
            if reason == "stop" and self.live[rid]["text"]:
                state = "Completed"
            else:
                error = "OutputTruncated" if reason == "length" else "ProviderIncomplete"
        except asyncio.CancelledError:
            return  # CancelRun/shutdown owns terminal persistence, so no competing completion.
        except DomainError as exc:
            error = exc.code
        except (httpx.TimeoutException, TimeoutError):
            error = "ProviderTimeout"
        except httpx.TransportError:
            error = "StreamInterrupted"
        except Exception:
            error = "ProviderProtocolError"
        finally:
            if rid in self.live and self.live[rid]["state"] == "Running":
                text = self.live[rid]["text"]
                try:
                    result = self.store.conversation.finish(aid, rid, state, text, metadata, error,
                        work_raw=self.live[rid].get('raw_text', ''))
                    self.broadcast({"type": "RunSaved", "run": result})
                    del self.live[rid]
                except Exception:
                    # A received answer must never look saved if its final transaction failed.
                    try:
                        result = self.store.conversation.finish(aid, rid, "Failed", text, metadata, "PersistenceFailed",
                            work_raw=self.live[rid].get('raw_text', ''))
                        self.broadcast({"type": "RunSaved", "run": result})
                        del self.live[rid]
                    except Exception:
                        self.live[rid].update(state="Failed", error_code="PersistenceFailed", saved=False)
                        self.broadcast({"type": "RunUnsaved", **{k:v for k,v in self.live[rid].items() if k != 'raw_text'}})
            self.tasks.pop(rid, None)
            self.metadata.pop(rid, None)

    def cancel(self, command):
        rid, aid = command["payload"]["run_id"], command["agent_id"]
        live = self.live.get(rid, {})
        # Scoped repository validation occurs before touching the task.
        result = self.store.conversation.finish(aid, rid, "Cancelled", live.get("text", ""), self.metadata.get(rid, {}), cancel_command=command, work_raw=live.get('raw_text', ''))
        if rid in self.live:
            self.live[rid]["state"] = "Cancelled"
            task = self.tasks.get(rid)
            if task:
                task.cancel()
            del self.live[rid]
        self.broadcast({"type": "RunSaved", "run": result})
        return {"command_id": command["command_id"], "status": "persisted", "data": result}

    def invalidate(self):
        """The repository has already persisted invalidation; now cancel owned in-flight I/O."""
        for rid, live in list(self.live.items()):
            with self.store.connect() as db:
                run = self.store.conversation.run(db, live["agent_id"], rid)
            refs = run["context"]
            if refs.get("context_stale") and (refs.get("request_sent") or refs.get("conversation_deleted")):
                text = "" if refs.get("conversation_deleted") or refs.get("context_erased") else live["text"]
                result = self.store.conversation.finish(live["agent_id"], rid, "Failed", text, self.metadata.get(rid, {}), "ContextStale", work_raw=live.get('raw_text', ''))
                live["state"] = "Failed"
                if rid in self.tasks:
                    self.tasks[rid].cancel()
                del self.live[rid]
                self.broadcast({"type": "RunSaved", "run": result})

    async def close(self):
        self.closed = True
        for rid, live in list(self.live.items()):
            try:
                self.store.conversation.finish(live["agent_id"], rid, "Failed", live["text"], self.metadata.get(rid, {}), "RuntimeInterrupted", work_raw=live.get('raw_text', ''))
            except Exception:
                pass  # Startup recovery marks any unresolved persisted Run; don't invent saved confirmation.
            live["state"] = "Failed"
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.live.clear()
