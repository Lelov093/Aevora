"""Authenticated loopback HTTP/WebSocket; secrets arrive only through stdin."""
import asyncio
import hmac
import json
import os
import socket
import sys
from pathlib import Path
from contextlib import asynccontextmanager

import uvicorn
from jsonschema import Draft202012Validator
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from .store import DomainError, Store
from .chat import ChatRuntime
from .gateway import ModelGateway
from .extraction import ExtractionRuntime
from .recall import RecallRuntime
from .tasks import TaskRuntime, COMMANDS as TASK_COMMANDS
from .scheduler import SchedulerRuntime
from .evolution_runtime import EvolutionRuntime
from .proactivity_runtime import ProactivityRuntime
from .evolution import binding

PROTOCOL_VERSION = 1
MAX_BODY = 16_384
ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = Draft202012Validator(json.loads((ROOT / "packages/protocol/command.schema.json").read_text()))

def create_app(store, token, instance_id, provider=None):
    recall = RecallRuntime(store, (provider or {}).get("embedding"), (provider or {}).get("selection"))
    chat = ChatRuntime(store, provider, recall)
    memory = ExtractionRuntime(store, (provider or {}).get("extraction"))
    agency = TaskRuntime(store, chat.gateway, recall)
    evolution = EvolutionRuntime(store, chat.gateway)
    proactive = ProactivityRuntime(store, chat.gateway, lambda: bool(chat.tasks or agency.active or evolution.tasks))
    scheduler = SchedulerRuntime(store.scheduler, proactive)
    def snapshot():
        return chat.snapshot() | {"extraction": memory.public(), "embedding": recall.public(), "scheduler_error": scheduler.error}

    @asynccontextmanager
    async def lifespan(app):
        store.conversation.recover()
        store.tasks.recover()
        store.evolution.recover()
        store.proactivity.recover()
        await memory.start()
        await recall.start()
        await scheduler.start()
        yield
        await scheduler.close()
        await proactive.pause()
        await evolution.pause()
        await recall.close()
        await memory.close()
        await chat.close()
        await agency.close()
    def authorized(headers):
        # Native Host has no browser Origin. Every browser-origin request is refused.
        return not headers.get("origin") and hmac.compare_digest(
            headers.get("authorization", ""), "Bearer " + token)

    def error(code, message, status):
        return JSONResponse({"status": "rejected", "error": {"code": code, "message": message}}, status_code=status)

    async def command(request: Request):
        if not authorized(request.headers):
            return error("Forbidden", "Native Host authentication required", 403)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY:
                return error("ValidationError", "Payload too large", 413)
        try:
            value = json.loads(body)
            VALIDATOR.validate(value)
        except Exception:
            return error("ValidationError", "Invalid command or protocol version", 400)
        try:
            if value['type'] == 'CreateMethodProposal':
                result = evolution.command(value)
            elif value['type'] == 'ConfigureProactivity':
                if value['payload']['think'] and value['payload']['provider'] != binding(chat.gateway.ready()):
                    raise DomainError('Forbidden', 'Approve Think for the current Provider')
                await proactive.pause()
                result = store.execute(value)
                scheduler.wake()
            elif value["type"] in TASK_COMMANDS:
                result = agency.command(value)
            elif value["type"] in ("ResolveTask", "PreviewTaskArtifact"):
                return error("Forbidden", "File reconciliation and preview are owned by Native Host", 403)
            elif value["type"] == "SendMessage":
                result = chat.send(value)
            elif value["type"] == "CancelRun":
                result = chat.cancel(value)
            elif value["type"] == "GetSnapshot":
                result = {"command_id": value["command_id"], "status": "persisted", "data": snapshot()}
            elif value["type"] == "SearchMemories":
                result = await recall.search(value)
            elif value["type"] in ("ConfigureProvider", "ConfigureSearch"):
                return error("Forbidden", "Provider configuration is owned by Native Host", 403)
            else:
                result = store.execute(value)
                if value["type"] == "SetGoalFollowupPolicy":
                    await proactive.refresh_policy(value["agent_id"])
                    scheduler.wake()
                if value["type"] in ("EditMemory", "ForgetMemory", "DeleteMemory", "DeleteConversation", "ReviewMemory"):
                    chat.invalidate()
                    agency.invalidate()
                if value["type"] == "Pause":
                    await proactive.pause()
                    await evolution.pause()
                    await memory.pause()
                    await recall.pause()
                if value["type"] == "Resume" or (value["type"] == "ConfigureScheduler" and value["payload"]["enabled"]):
                    scheduler.wake("ResumedOverdue")
                elif value["type"] in ("CreateSchedule", "CreateCommitment", "EditSchedule"):
                    scheduler.wake()
            if value['type'] in ('EditGoal', 'ChangeGoalState', 'DeleteGoal', 'LinkGoalWork', 'UnlinkGoalWork',
                                 'CreateTask', 'CreatePlannedTask', 'CreateNetworkTask', 'CreateSchedule', 'CreateCommitment',
                                 'SaveTaskFeedback', 'DeleteTaskFeedback'):
                chat.invalidate()
            if value['type'] in ('EditMethodCandidate', 'AdoptMethod', 'DisableMethod', 'EnableMethod', 'RollbackMethod', 'DeleteMethod', 'RejectMethod', 'SaveTaskFeedback', 'DeleteTaskFeedback'):
                chat.invalidate()
                agency.invalidate()
                await evolution.invalidate()
            result["protocol_version"] = PROTOCOL_VERSION
            result["runtime_instance_id"] = instance_id
            return JSONResponse(result)
        except DomainError as exc:
            return error(exc.code, exc.message,
                         {"RevisionConflict": 409, "RunBusy": 409, "Forbidden": 403, "NotFound": 404,
                          "ProviderUnavailable": 503}.get(exc.code, 400))
        except Exception:
            return error("PersistenceFailed", "Local transaction failed; no saved confirmation", 500)

    async def events(ws: WebSocket):
        if not authorized(ws.headers):
            await ws.close(code=1008)
            return
        try:
            after = int(ws.query_params.get("after_sequence", "0"))
            if after < 0:
                raise ValueError()
        except ValueError:
            await ws.close(code=1008)
            return
        await ws.accept()
        queue = asyncio.Queue(maxsize=64)
        chat.subscribers.add(queue)
        try:
            await ws.send_json({"type": "Handshake", "protocol_version": 1,
                                "runtime_instance_id": instance_id, "snapshot": snapshot()})
            while True:
                for event in store.events(after):
                    await ws.send_json(event)
                    after = event["sequence"]
                while not queue.empty():
                    await ws.send_json(queue.get_nowait())
                # Receive observes client closure while idle; avoids accumulating dead subscribers.
                try:
                    await asyncio.wait_for(ws.receive_text(), timeout=0.05)
                except asyncio.TimeoutError:
                    pass
        except (WebSocketDisconnect, RuntimeError):
            return
        finally:
            chat.subscribers.discard(queue)

    async def configure(request: Request):
        if not authorized(request.headers):
            return error("Forbidden", "Native Host authentication required", 403)
        try:
            config = await request.json()
            ModelGateway(config)
            ModelGateway((config or {}).get("extraction"))
            from .gateway import EmbeddingGateway
            EmbeddingGateway((config or {}).get("embedding"))
            from .relevance import validate as validate_selection
            validate_selection((config or {}).get("selection"))
            chat_part = lambda c: {k: v for k, v in (c or {}).items() if k not in ("extraction", "embedding", "selection", "revision")}
            if (chat.tasks or agency.active) and chat_part(config) != chat_part(chat.gateway.config):
                return error("RunBusy", "Finish or cancel foreground Runs before changing Chat configuration", 409)
            # Revoking/changing background permission cancels its in-flight request.
            # Foreground Runs retain their captured Chat configuration and continue.
            await memory.pause()
            await proactive.pause()
            await evolution.pause()
            await recall.pause()
            await recall.cancel_selection()
            # An embedding purpose/config change invalidates in-flight recall preparation too.
            if ((config or {}).get("embedding") != chat.gateway.config.get("embedding")
                    or (config or {}).get("selection") != chat.gateway.config.get("selection")):
                with store.transaction() as db:
                    for row in db.execute("SELECT run_id,context FROM runs WHERE state IN ('Created','Running')").fetchall():
                        refs = json.loads(row["context"]) | {"context_stale": True}
                        db.execute("UPDATE runs SET context=? WHERE run_id=?", (json.dumps(refs), row["run_id"]))
                chat.invalidate()
                with store.transaction() as db:
                    for row in db.execute("SELECT t.* FROM tasks t WHERE kind='report' AND state IN ('Created','Generating','AwaitingApproval')").fetchall():
                        store.tasks.transition(db, row, "Failed", "ContextStale")
                    for row in db.execute("SELECT t.* FROM tasks t WHERE kind IN ('plan','network') AND state IN ('Created','Planning','Running','Generating','Searching','ReadingWeb','AwaitingSources','AwaitingRedirectApproval','AwaitingPlanApproval','AwaitingApproval')").fetchall():
                        refs=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(row['current_run_id'],)).fetchone()[0])|{'context_stale':True}
                        db.execute('UPDATE task_runs SET context=? WHERE run_id=?',(json.dumps(refs),row['current_run_id']))
                        store.tasks.planned.state(db,row,'Failed','ContextStale')
                agency.invalidate()
            chat.gateway.configure(config)
            memory.configure((config or {}).get("extraction"))
            recall.configure((config or {}).get("embedding"), (config or {}).get("selection"))
        except Exception:
            return error("ValidationError", "Invalid Provider configuration", 400)
        return JSONResponse({"status": "persisted"})

    async def shutdown(request: Request):
        if not authorized(request.headers):
            return error("Forbidden", "Native Host authentication required", 403)
        await scheduler.close()
        await proactive.pause()
        await evolution.pause()
        await memory.close()
        await recall.close()
        await chat.close()
        await agency.close()
        request.app.state.server.should_exit = True
        return JSONResponse({"status": "accepted"})

    async def task_native(request: Request):
        if not authorized(request.headers):
            return error("Forbidden", "Native Host authentication required", 403)
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                # UTF-8/JSON expansion of the configured bounded input plus receipts.
                if len(body) > max(2 * 1024 * 1024, chat.gateway.config.get("max_input_tokens", 4096) * 6 + 16384):
                    return error("BudgetExceeded", "Selected file input exceeds supported capacity", 413)
            value = json.loads(body)
            if request.url.path == "/task-input":
                data = agency.fail_input(value) if "error" in value and not value.get("phase") else agency.input(value)
            else:
                data = agency.receipt(value)
            return JSONResponse({"status": "persisted", "data": data, "protocol_version": 1, "runtime_instance_id": instance_id})
        except DomainError as exc:
            return error(exc.code, exc.message, 400)
        except Exception:
            return error("PersistenceFailed", "Task receipt or input could not be saved", 500)

    app = Starlette(lifespan=lifespan, routes=[Route("/command", command, methods=["POST"]),
                             Route("/task-input", task_native, methods=["POST"]),
                             Route("/task-receipt", task_native, methods=["POST"]),
                             Route("/provider", configure, methods=["POST"]),
                             Route("/shutdown", shutdown, methods=["POST"]),
                             WebSocketRoute("/events", events)])
    app.state.chat = chat
    app.state.memory = memory
    app.state.recall = recall
    app.state.agency = agency
    app.state.scheduler = scheduler
    app.state.evolution = evolution
    app.state.proactive = proactive
    return app

def main():
    # Host sends UTF-8 bytes, independent of the user's Windows console code page.
    config = json.loads(sys.stdin.buffer.readline())
    store = Store(Path(config["data_dir"]) / "aevora.sqlite3")
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    print(json.dumps({"port": listener.getsockname()[1], "pid": os.getpid(),
                      "protocol_version": 1, "runtime_instance_id": config["instance_id"]}), flush=True)
    app = create_app(store, config["token"], config["instance_id"], config.get("provider"))
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False,
                                         timeout_graceful_shutdown=2))
    app.state.server = server
    server.run(sockets=[listener])

if __name__ == "__main__":
    main()
