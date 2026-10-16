"""Durable bounded Agency: goals, attempts, reviewed actions and truthful receipts."""
import asyncio
import json
from contextlib import closing
from uuid import uuid4

import httpx

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached
from . import task_report
from .recall import current
from .planned_tasks import PlannedRepository, PlannedRuntime, COMMANDS as PLAN_COMMANDS
from .network_tasks import NetworkRepository, NetworkRuntime, COMMANDS as NETWORK_COMMANDS, candidates
from .agent_tasks import AgentRepository, COMMANDS as AGENT_COMMANDS
from .agent_runtime import AgentRuntime

MIGRATION = (
    """CREATE TABLE tasks(task_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    title TEXT NOT NULL,instruction TEXT NOT NULL,sources TEXT NOT NULL,output_path TEXT NOT NULL,
    state TEXT NOT NULL,revision INTEGER NOT NULL,permission INTEGER NOT NULL,current_run_id TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""",
    """CREATE TABLE task_runs(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),
    state TEXT NOT NULL,context TEXT NOT NULL,metadata TEXT NOT NULL,raw_output TEXT NOT NULL DEFAULT '',error TEXT,
    created_at TEXT NOT NULL,completed_at TEXT)""",
    """CREATE TABLE task_actions(action_id TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL REFERENCES task_runs(run_id),
    body TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL)""",
)
READS = {"ListTasks", "GetTask"}
COMMANDS = READS | PLAN_COMMANDS | NETWORK_COMMANDS | AGENT_COMMANDS | {"CreateTask", "RetryTask", "PauseTask", "CancelTask", "ApproveTask", "RejectTask", "RevokeTaskPermission"}


class TaskRepository:
    def __init__(self, store):
        self.store = store
        self.planned = PlannedRepository(store)
        self.network = NetworkRepository(store, self.planned)
        self.agent = AgentRepository(store)

    def target(self, db, aid, tid):
        self.store.identity.agent(db, aid)
        row = db.execute("SELECT * FROM tasks WHERE task_id=? AND agent_id=?", (tid, aid)).fetchone()
        if not row:
            raise DomainError("NotFound", "Task unavailable for this Agent")
        return row

    def detail(self, db, aid, tid):
        value = dict(self.target(db, aid, tid))
        value["sources"] = json.loads(value["sources"])
        value["outputs"] = json.loads(value["outputs"])
        value['method_ref'] = json.loads(value['method_ref']) if value['method_ref'] else None
        runs = []
        for row in db.execute("SELECT * FROM task_runs WHERE task_id=? ORDER BY rowid DESC", (tid,)):
            run = dict(row)
            run["context"], run["metadata"] = json.loads(run["context"]), json.loads(run["metadata"])
            run["plan"] = json.loads(run["plan"]) if run["plan"] else None
            run['feedback'] = self.store.work.feedback(db, aid, row['run_id'])
            action = db.execute("SELECT * FROM task_actions WHERE run_id=?", (row["run_id"],)).fetchone()
            run["action"] = dict(action) if action else None
            if action:
                run["action"]["receipt"] = json.loads(action["receipt"]) if action["receipt"] else None
            if value['kind'] in ('plan','network','agent'):
                run['steps']=self.planned.steps(db,row['run_id'])
                pending=next((s for s in run['steps'] if not self.planned.resolved(s)),None)
                run['action']=pending['action'] if pending else None
            runs.append(run)
        value["runs"] = runs
        if value['kind'] in ('plan','network','agent'):value['current_step']=next((s for s in runs[0]['steps'] if not self.planned.resolved(s)),None)
        if value['kind']=='agent':
            from .agent_actions import source_catalog, local_evidence
            value['agent_limits']=json.loads(value['agent_limits'])
            value['candidates']=source_catalog(runs[0]['steps'])
            value['local_evidence']=local_evidence(value['sources'],runs[0]['steps'])
        if value['kind']=='network':
            value['candidates']=candidates(runs[0]['steps'])
            value['network']=runs[0]['context']
        if value['kind'] in ('network','agent'):
            value['network_requests']=[dict(r) | {'metadata':json.loads(r['metadata'])} for r in db.execute('SELECT n.* FROM network_requests n JOIN task_runs r ON r.run_id=n.run_id WHERE r.task_id=? ORDER BY n.rowid',(tid,))]
        value["activity"] = [dict(e) for e in db.execute("SELECT type,timestamp FROM events WHERE agent_id=? AND json_extract(payload,'$.task_id')=? ORDER BY sequence", (aid, tid))]
        if value['kind']=='agent':
            source=runs[0]['context']
            cid=source.get('source_conversation_id')
            value['agent_source']={'conversation_id':cid,'available':bool(cid and db.execute("SELECT 1 FROM conversations WHERE conversation_id=? AND agent_id=? AND status<>'Deleted'",(cid,aid)).fetchone())}
        value['schedule'] = self.store.scheduler.for_task(db, aid, tid)
        value['goal'] = self.store.goals.for_work(db, aid, 'task', tid)
        source = db.execute("SELECT r.conversation_id,r.input_message_id,c.status FROM work_responses w JOIN runs r USING(run_id) JOIN conversations c USING(conversation_id) WHERE w.task_id=? AND w.agent_id=?", (tid, aid)).fetchone()
        if source:
            value['work_source'] = {'conversation_id': source['conversation_id'], 'message_id': source['input_message_id'], 'available': source['status'] != 'Deleted'}
        if not value.get('work_source') and value.get('agent_source',{}).get('conversation_id'):
            value['work_source']=value['agent_source']
        return value

    def transition(self, db, row, state, error=None, receipt=None):
        tid, rid, aid = row["task_id"], row["current_run_id"], row["agent_id"]
        db.execute("UPDATE tasks SET state=?,revision=revision+1,updated_at=? WHERE task_id=?", (state, now(), tid))
        db.execute("UPDATE task_runs SET state=?,error=?,completed_at=? WHERE run_id=?",
                   (state, error, None if state in ("Created", "Generating", "AwaitingApproval", "Executing") else now(), rid))
        db.execute("UPDATE task_actions SET state=?,receipt=COALESCE(?,receipt) WHERE run_id=?",
                   (state, json.dumps(receipt) if receipt is not None else None, rid))
        self.store.memory.event(db, "Task" + state, aid, {"task_id": tid, "run_id": rid, "error": error}, actor="task_runtime")

    def new_run(self, db, tid):
        rid = str(uuid4())
        old = db.execute('SELECT r.context FROM tasks t JOIN task_runs r ON r.run_id=t.current_run_id WHERE t.task_id=?', (tid,)).fetchone()
        refs = json.loads(old[0]) if old else {}
        context = {k: refs[k] for k in ('task_goal_context',) if k in refs}
        db.execute("INSERT INTO task_runs(run_id,task_id,state,context,metadata,error,created_at) VALUES (?,?,?,?,'{}',NULL,?)", (rid, tid, "Created", json.dumps(context), now()))
        db.execute("UPDATE tasks SET current_run_id=?,state='Created',revision=revision+1,updated_at=? WHERE task_id=?", (rid, now(), tid))

    def execute(self, c):
        aid, kind, p = c["agent_id"], c["type"], c["payload"]
        if kind in AGENT_COMMANDS:
            return self.agent.execute(c)
        if kind not in READS and kind not in ('CreateTask','CreatePlannedTask','CreateNetworkTask'):
            with closing(self.store.connect()) as db:
                if self.target(db,aid,p['task_id'])['kind']=='agent':return self.agent.execute(c)
        if kind in NETWORK_COMMANDS:return self.network.execute(c)
        if kind in PLAN_COMMANDS and not (kind == 'EditTaskBody' and self._is_report(aid, p['task_id'])):
            if kind != 'CreatePlannedTask':
                with closing(self.store.connect()) as db:
                    if self.target(db,aid,p['task_id'])['kind']=='network':return self.network.execute(c)
            return self.planned.execute(c)
        if kind not in READS and kind!='CreateTask':
            with closing(self.store.connect()) as db:
                if self.target(db,aid,p['task_id'])['kind']=='network':return self.network.execute(c)
                if self.target(db,aid,p['task_id'])['kind']=='plan':return self.planned.execute(c)
        serialized = json.dumps(c, sort_keys=True, separators=(",", ":"))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind in READS:
                data = ([self.detail(db, aid, r[0]) for r in db.execute("SELECT task_id FROM tasks WHERE agent_id=? ORDER BY updated_at DESC", (aid,))]
                        if kind == "ListTasks" else self.detail(db, aid, p["task_id"]))
            else:
                old = cached(db, c, serialized)
                if old is not None:
                    return old
                if kind == "CreateTask":
                    goal_context = self.store.goals.task_creation_context(db, c)
                    if not p["title"].strip() or not p["instruction"].strip():
                        raise DomainError("ValidationError", "Task title and instruction cannot be blank")
                    tid = c["command_id"]
                    db.execute("INSERT INTO tasks(task_id,agent_id,title,instruction,sources,output_path,state,revision,permission,current_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'Created',0,1,NULL,?,?)",
                        (tid, aid, p["title"].strip(), p["instruction"].strip(), json.dumps(p["sources"]), p["output_path"], now(), now()))
                    self.new_run(db, tid)
                    self.store.work.accept(db, c, 'CreateTask', tid)
                    self.store.scheduler.attach(db, c, tid)
                    self.store.goals.attach(db, c, 'task', tid)
                    self.store.goals.bind_task_context(db, aid, tid, goal_context)
                    self.store.memory.event(db, "TaskCreated", aid, {"task_id": tid}, c["command_id"], "user")
                else:
                    tid = p["task_id"]
                    row = self.target(db, aid, tid)
                    if row["revision"] != c["expected_revision"]:
                        raise DomainError("RevisionConflict", "Task changed; review its current proposal")
                    state = row["state"]
                    if kind == "RevokeTaskPermission":
                        db.execute("UPDATE tasks SET permission=0,revision=revision+1,updated_at=? WHERE task_id=?", (now(), tid))
                        self.store.memory.event(db, "TaskPermissionRevoked", aid, {"task_id": tid}, c["command_id"], "user")
                        if state not in ("Executing", "NeedsAttention", "Completed", "NotExecuted"):
                            self.transition(db, row, "Revoked")
                    elif kind == "RetryTask":
                        if not row["permission"] or state not in ("Failed", "Paused", "Cancelled", "Rejected", "NotExecuted"):
                            raise DomainError("Forbidden", "Retry requires a resolved safe outcome and current permission")
                        self.store.goals.task_context(db, aid, tid)
                        self.new_run(db, tid)
                    elif kind in ("ApproveTask", "EditTaskBody"):
                        self.store.goals.task_context(db, aid, tid)
                        if not row["permission"] or state != "AwaitingApproval":
                            raise DomainError("Forbidden", "Only a current authorized proposal can execute")
                        run = db.execute("SELECT context FROM task_runs WHERE run_id=?", (row["current_run_id"],)).fetchone()
                        if json.loads(run[0]).get("context_stale"):
                            raise DomainError("ContextStale", "Memory changed; generate a new proposal")
                        from .recall import active
                        if not set(json.loads(run[0]).get("memory_revision_ids", [])) <= {m["revision_id"] for m in active(db, aid)}:
                            raise DomainError("ContextStale", "Memory validity changed; generate a new proposal")
                        if kind == "EditTaskBody":
                            if not p['body'].strip() or len(p['body']) > 32768:
                                raise DomainError('ValidationError', 'A complete body within capacity is required')
                            previous = db.execute('SELECT action_id FROM task_actions WHERE run_id=?',
                                                  (row['current_run_id'],)).fetchone()
                            if previous is None:
                                raise DomainError('Forbidden', 'No pending body to edit')
                            action_id = str(uuid4())
                            db.execute('UPDATE task_actions SET action_id=?,body=?,created_at=? WHERE run_id=?',
                                       (action_id, p['body'], now(), row['current_run_id']))
                            self.transition(db, row, 'AwaitingApproval')
                            self.store.memory.event(db, 'TaskBodyEdited', aid,
                                {'task_id': tid, 'run_id': row['current_run_id'],
                                 'previous_action_id': previous[0], 'action_id': action_id,
                                 'body_origin': 'user'}, c['command_id'], 'user')
                        else:
                            self.transition(db, row, "Executing")
                    else:
                        if state in ("Executing", "NeedsAttention", "Completed", "NotExecuted"):
                            raise DomainError("Forbidden", "A write outcome must be reconciled before another action")
                        new_state = {"PauseTask": "Paused", "CancelTask": "Cancelled", "RejectTask": "Rejected"}[kind]
                        if kind == "RejectTask" and state != "AwaitingApproval":
                            raise DomainError("Forbidden", "There is no approval pending")
                        self.transition(db, row, new_state)
                data = self.detail(db, aid, tid)
            response = {"command_id": c["command_id"], "status": "persisted", "data": data}
            if kind not in READS:
                db.execute("INSERT INTO command_results VALUES (?,?,?)", (c["command_id"], serialized, json.dumps(response)))
        if kind == "ApproveTask":
            self.store.probe_point("action.intent", {"task_id": tid, "action_id": data["runs"][0]["action"]["action_id"]})
        return response

    def _is_report(self, aid, tid):
        with closing(self.store.connect()) as db:
            return self.target(db, aid, tid)['kind'] == 'report'

    def receipt(self, value):
        aid, tid, action_id = value["agent_id"], value["task_id"], value["action_id"]
        with closing(self.store.connect()) as db:
            if self.target(db,aid,tid)['kind'] in ('plan','network','agent'):return self.planned.receipt(value)
        receipt = value["receipt"]
        if receipt.get("outcome") not in ("Success", "NotExecuted", "Unknown"):
            raise DomainError("ValidationError", "Invalid native receipt")
        self.store.probe_point("action.before_receipt", {"task_id": tid, "action_id": action_id, "receipt": receipt})
        with self.store.transaction() as db:
            row = self.target(db, aid, tid)
            action = db.execute("SELECT * FROM task_actions WHERE action_id=? AND run_id=?", (action_id, row["current_run_id"])).fetchone()
            if not action or row["state"] not in ("Executing", "NeedsAttention"):
                raise DomainError("Forbidden", "No unresolved approved action")
            state = {"Success": "Completed", "NotExecuted": "NotExecuted", "Unknown": "NeedsAttention"}[receipt["outcome"]]
            self.transition(db, row, state, receipt.get("error"), receipt)
            return self.detail(db, aid, tid)

    def recover(self):
        with self.store.transaction() as db:
            self.planned.recover(db)
            db.execute("UPDATE network_requests SET state='Failed',error='RuntimeInterrupted' WHERE state='Running'")
            for row in db.execute("SELECT * FROM tasks WHERE kind='report' AND state IN ('Created','Generating','Executing')").fetchall():
                if row["state"] == "Executing":
                    self.transition(db, row, "NeedsAttention", "RuntimeInterrupted", {"outcome": "Unknown", "error": "RuntimeInterrupted"})
                else:
                    self.transition(db, row, "Failed", "RuntimeInterrupted")

    def invalidate(self, db, aid, revision_ids, erase):
        self.planned.invalidate(db,aid,revision_ids,erase)
        ids = set()
        for run in db.execute("SELECT r.* FROM task_runs r JOIN tasks t ON t.task_id=r.task_id WHERE t.agent_id=? AND t.kind='report'", (aid,)).fetchall():
            refs = json.loads(run["context"])
            if not set(refs.get("memory_revision_ids", [])) & set(revision_ids):
                continue
            refs.update(context_stale=True, context_erased=bool(erase))
            db.execute("UPDATE task_runs SET context=? WHERE run_id=?", (json.dumps(refs), run["run_id"]))
            action = db.execute("SELECT action_id FROM task_actions WHERE run_id=?", (run["run_id"],)).fetchone()
            ids.update((run["task_id"], run["run_id"]))
            if action:
                ids.add(action[0])
            if erase:
                db.execute("UPDATE task_actions SET body='' WHERE run_id=?", (run["run_id"],))
                db.execute("UPDATE task_runs SET raw_output='' WHERE run_id=?", (run["run_id"],))
            row = self.target(db, aid, run["task_id"])
            if row["current_run_id"] == run["run_id"] and row["state"] in ("Created", "Generating", "AwaitingApproval"):
                self.transition(db, row, "Failed", "ContextStale")
        # Both edit and erasure invalidate cached old proposals; only erasure removes saved body.
        if ids:
            erase_cached(db, ids)


class TaskRuntime:
    def __init__(self, store, gateway, recall):
        self.store, self.gateway, self.recall = store, gateway, recall
        self.tasks = {}
        self.metadata = {}
        self.planned = PlannedRuntime(store,gateway,recall)
        self.network = NetworkRuntime(store,gateway,recall)
        self.agent = AgentRuntime(store,gateway,recall)

    @property
    def active(self):return bool(self.tasks or self.planned.tasks or self.network.tasks or self.agent.tasks)

    def command(self, command):
        if command['type'] in ('ApproveTaskPlan','ApproveTask','RetryTask','ReviseAgentAction'):
            with closing(self.store.connect()) as db:
                row=self.store.tasks.target(db,command['agent_id'],command['payload']['task_id'])
                if row['kind'] in ('plan','network','agent'):
                    refs=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(row['current_run_id'],)).fetchone()[0])
                    config=self.gateway.ready()
                    if refs.get('provider') and refs['provider']!={k:config[k] for k in ('base_url','model','revision')}:
                        raise DomainError('Forbidden','Provider binding changed; create a newly authorized task')
        response = self.store.tasks.execute(command)
        self.invalidate()
        if isinstance(response['data'],dict) and response['data'].get('kind') in ('plan','network','agent'):
            (self.agent if response['data']['kind']=='agent' else self.network if response['data']['kind']=='network' else self.planned).pump(command['agent_id'],response['data']['task_id'])
        return response

    def receipt(self,value):
        result=self.store.tasks.receipt(value)
        if result.get('kind') in ('plan','network','agent'):(self.agent if result['kind']=='agent' else self.network if result['kind']=='network' else self.planned).pump(value['agent_id'],value['task_id'])
        return result

    def input(self, value):
        aid, tid = value["agent_id"], value["task_id"]
        with closing(self.store.connect()) as db:
            if self.store.tasks.target(db,aid,tid)['kind']=='agent':
                self.agent.input(value)
                return self.store.tasks.detail(db,aid,tid)
            if self.store.tasks.target(db,aid,tid)['kind']=='network':
                self.network.input(value)
                return self.store.tasks.detail(db,aid,tid)
            if self.store.tasks.target(db,aid,tid)['kind']=='plan':
                self.planned.input(value)
                return self.store.tasks.detail(db,aid,tid)
        config = self.gateway.ready()
        binding = {k: config[k] for k in ("base_url", "model", "revision")}
        if value["provider"] != binding:
            raise DomainError("Forbidden", "File outbound permission belongs to another provider revision")
        with self.store.transaction() as db:
            row = self.store.tasks.target(db, aid, tid)
            if row["state"] != "Created" or not row["permission"]:
                raise DomainError("Forbidden", "Task cannot accept file input")
            files = value["files"]
            if [f["path"] for f in files] != json.loads(row["sources"]) or any(not isinstance(f["content"], str) for f in files):
                raise DomainError("Forbidden", "Read receipt does not match selected resources")
            rid = row["current_run_id"]
            self.store.tasks.transition(db, row, "Generating")
            context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
            context.update({"read_receipts": [{"path": f["path"], "characters": len(f["content"])} for f in files],
                       "provider": binding, "purpose": "TaskReport", "prompt_version": task_report.VERSION,
                       "output_contract": task_report.OUTPUT_CONTRACT})
            db.execute("UPDATE task_runs SET context=? WHERE run_id=?", (json.dumps(context), rid))
            task = dict(row)
        self.tasks[rid] = asyncio.create_task(self.generate(task, files, config))
        with closing(self.store.connect()) as db:
            return self.store.tasks.detail(db, aid, tid)

    def fail_input(self, value):
        with closing(self.store.connect()) as db:
            if self.store.tasks.target(db,value['agent_id'],value['task_id'])['kind']=='agent':
                self.agent.input(value)
                return self.store.tasks.detail(db,value['agent_id'],value['task_id'])
        with self.store.transaction() as db:
            row = self.store.tasks.target(db, value["agent_id"], value["task_id"])
            if row["state"] == "Created":
                self.store.tasks.transition(db, row, "Failed", value["error"])
            elif row['kind'] in ('plan','network') and row['state']=='Running':
                step=self.store.tasks.planned.current_step(db,row['current_run_id'])
                if step:db.execute("UPDATE task_steps SET state='Failed',error=? WHERE step_id=?",(value['error'],step['step_id']))
                self.store.tasks.planned.state(db,row,'Failed',value['error'])
            return self.store.tasks.detail(db, row["agent_id"], row["task_id"])

    async def generate(self, task, files, config):
        aid, tid, rid = task["agent_id"], task["task_id"], task["current_run_id"]
        metadata = {"purpose": "TaskReport", "model": config["model"], "provider_revision": config["revision"]}
        self.metadata[rid] = metadata
        text = ""
        error = None
        try:
            with closing(self.store.connect()) as db:
                self.store.goals.task_context(db, aid, tid)
            memories, recall = await self.recall.prepare(aid, task["instruction"])
            with self.store.transaction() as db:
                agent = self.store.identity.profile(db, aid)
                row = self.store.tasks.target(db, aid, tid)
                if row["state"] != "Generating" or row["current_run_id"] != rid:
                    return
                if not current(db, aid, memories):
                    raise DomainError("ContextStale", "Memory changed")
                from .task_results import current_work
                work_state = current_work(db, aid, tid, self.store.goals.task_context(db, aid, tid))
                messages = task_report.messages(agent, task["instruction"], files, memories, self.store.input_timezone, work_state)
                estimate = sum(len(m["content"]) + 16 for m in messages)
                if estimate > config["max_input_tokens"]:
                    raise DomainError("BudgetExceeded", "Complete selected files and context exceed configured input capacity; choose smaller files or increase capacity")
                context = json.loads(db.execute("SELECT context FROM task_runs WHERE run_id=?", (rid,)).fetchone()[0])
                context.update(memory_revision_ids=[m["revision_id"] for m in memories], persona_revision=agent["current_persona_revision"],
                               recall=recall, request_sent=True, estimated_input_tokens=estimate)
                context['current_work'] = work_state
                db.execute("UPDATE task_runs SET context=? WHERE run_id=?", (json.dumps(context), rid))
                self.store.memory.event(db, "TaskModelRequestStarted", aid, {"task_id": tid, "run_id": rid, "purpose": "TaskReport"})
            def consume(delta):
                nonlocal text
                text += delta
                if len(text) > 32768:
                    raise DomainError("BudgetExceeded", "Report exceeded supported local text capacity")
            await self.gateway.stream(config, messages, consume, metadata)
            if metadata.get("finish_reason") != "stop":
                raise DomainError("OutputTruncated", "Report is incomplete")
            if not text.strip():
                raise DomainError("ProviderProtocolError", "Report body is empty")
            with self.store.transaction() as db:
                row = self.store.tasks.target(db, aid, tid)
                refs = json.loads(db.execute("SELECT context FROM task_runs WHERE run_id=?", (rid,)).fetchone()[0])
                if row["state"] != "Generating" or row["current_run_id"] != rid:
                    return
                if refs.get("context_stale") or not current(db, aid, memories):
                    raise DomainError("ContextStale", "Memory changed during report generation")
                self.store.goals.task_context(db, aid, tid)
                db.execute("INSERT INTO task_actions VALUES (?,?,?,'AwaitingApproval',NULL,?)", (str(uuid4()), rid, text, now()))
                db.execute("UPDATE task_runs SET metadata=?,raw_output=? WHERE run_id=?", (json.dumps(metadata), text, rid))
                self.store.tasks.transition(db, row, "AwaitingApproval")
        except asyncio.CancelledError:
            return
        except DomainError as exc:
            error = exc.code
        except (httpx.TimeoutException, TimeoutError):
            error = "ProviderTimeout"
        except httpx.TransportError:
            error = "StreamInterrupted"
        except Exception:
            error = "ProviderProtocolError"
        finally:
            with self.store.transaction() as db:
                db.execute("UPDATE task_runs SET metadata=? WHERE run_id=?", (json.dumps(metadata), rid))
                refs = json.loads(db.execute("SELECT context FROM task_runs WHERE run_id=?", (rid,)).fetchone()[0])
                if not refs.get("context_erased"):
                    db.execute("UPDATE task_runs SET raw_output=? WHERE run_id=?", (text, rid))
                row = self.store.tasks.target(db, aid, tid)
                if error and row["current_run_id"] == rid and row["state"] == "Generating":
                    self.store.tasks.transition(db, row, "Failed", error)
            self.tasks.pop(rid, None)
            self.metadata.pop(rid, None)

    def invalidate(self):
        self.agent.invalidate()
        self.planned.invalidate()
        self.network.invalidate()
        for rid, task in list(self.tasks.items()):
            with closing(self.store.connect()) as db:
                state = db.execute("SELECT state FROM task_runs WHERE run_id=?", (rid,)).fetchone()[0]
            if state != "Generating":
                task.cancel()

    async def close(self):
        with self.store.transaction() as db:
            for rid in list(self.tasks):
                row = db.execute("SELECT t.* FROM tasks t WHERE current_run_id=?", (rid,)).fetchone()
                if row and row["state"] == "Generating":
                    self.store.tasks.transition(db, row, "Failed", "RuntimeInterrupted")
        pending = list(self.tasks.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await self.agent.close()
        await self.planned.close()
        await self.network.close()
