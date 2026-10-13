"""Single local scheduling boundary. Time creates a reminder, never tool authority."""
import asyncio
import json
from datetime import datetime, timezone

from .errors import DomainError
from .memory_governance import cached
from .memory_temporal import aware, input_zone
from .task_results import result as task_result

MIGRATION = (
    """CREATE TABLE scheduler_settings(agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
        enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE schedules(schedule_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        title TEXT NOT NULL, instruction TEXT NOT NULL, task_kind TEXT NOT NULL,
        due_at TEXT NOT NULL, time_zone TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
        triggered_at TEXT, delivery_reason TEXT, task_id TEXT REFERENCES tasks(task_id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE INDEX schedules_due ON schedules(state,due_at)",
)
COMMANDS = {"ListSchedules", "ConfigureScheduler", "CreateSchedule", "EditSchedule", "CancelSchedule", "DismissSchedule", "CreateCommitment", "GetCommitmentSource"}


def utc_now():
    return datetime.now(timezone.utc)


class SchedulerRepository:
    def __init__(self, store, clock=utc_now):
        self.store, self.clock = store, clock

    def settings(self, db, aid):
        self.store.identity.agent(db, aid)
        row = db.execute("SELECT * FROM scheduler_settings WHERE agent_id=?", (aid,)).fetchone()
        return dict(row) if row else {"agent_id": aid, "enabled": 0, "revision": 0}

    def view(self, db, aid):
        return {"settings": self.settings(db, aid), "items": [self.decorate(db, aid, r) for r in db.execute(
            "SELECT * FROM schedules WHERE agent_id=? ORDER BY CASE state WHEN 'Ready' THEN 0 WHEN 'Scheduled' THEN 1 ELSE 2 END,due_at DESC", (aid,))]}

    def decorate(self, db, aid, row):
        return dict(row) | {'commitment': self.store.commitments.for_schedule(db, aid, row['schedule_id']),
                           'goal': self.store.goals.for_work(db, aid, 'schedule', row['schedule_id']),
                           'task_result': task_result(db, aid, row['task_id']) if row['task_id'] else None}

    def for_task(self, db, aid, tid):
        row = db.execute('SELECT * FROM schedules WHERE agent_id=? AND task_id=?', (aid, tid)).fetchone()
        return self.decorate(db, aid, row) if row else None

    def target(self, db, aid, sid):
        self.store.identity.agent(db, aid)
        row = db.execute("SELECT * FROM schedules WHERE schedule_id=? AND agent_id=?", (sid, aid)).fetchone()
        if not row:
            raise DomainError("NotFound", "Time agreement unavailable for this Agent")
        return row

    def fields(self, p):
        title, instruction = p["title"].strip(), p["instruction"].strip()
        if not title or not instruction or len(title) > 120 or len(instruction) > 4000:
            raise DomainError("ValidationError", "Time agreement needs a title and instruction")
        due = aware(p["due_at"]).astimezone(timezone.utc)
        input_zone(p["time_zone"].removeprefix("UTC") or "UTC")
        if due <= self.clock():
            raise DomainError("ValidationError", "Choose a future time for this single agreement")
        if p["task_kind"] not in ("file", "network"):
            raise DomainError("ValidationError", "Choose a supported task preparation flow")
        return title, instruction, p["task_kind"], due.isoformat(), p["time_zone"]

    def execute(self, c):
        aid, kind, p = c["agent_id"], c["type"], c["payload"]
        serialized = json.dumps(c, sort_keys=True, separators=(",", ":"))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind == "ListSchedules":
                return {"command_id": c["command_id"], "status": "persisted", "data": self.view(db, aid)}
            if kind == "GetCommitmentSource":
                return {"command_id": c["command_id"], "status": "persisted", "data": self.store.commitments.source_view(db, aid, p['commitment_id'])}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            stamp = self.clock().isoformat()
            if kind == "ConfigureScheduler":
                setting = self.settings(db, aid)
                if c.get("expected_revision") != setting["revision"]:
                    raise DomainError("RevisionConflict", "Reminder setting changed; refresh it")
                db.execute("INSERT INTO scheduler_settings VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision",
                           (aid, int(p["enabled"]), setting["revision"] + 1))
                data = self.settings(db, aid)
                event = "SchedulerEnabled" if p["enabled"] else "SchedulerDisabled"
                payload = {"enabled": p["enabled"]}
            elif kind in ("CreateSchedule", "CreateCommitment"):
                if not self.settings(db, aid)["enabled"]:
                    raise DomainError("Forbidden", "Explicitly enable this Agent's local reminders first")
                sid = c["command_id"]
                db.execute("INSERT INTO schedules(schedule_id,agent_id,title,instruction,task_kind,due_at,time_zone,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'Scheduled',0,?,?)",
                           (sid, aid, *self.fields(p), stamp, stamp))
                if kind == 'CreateCommitment':
                    self.store.commitments.confirm(db, c, sid, stamp)
                self.store.goals.attach(db, c, 'schedule', sid)
                data, event, payload = self.decorate(db, aid, self.target(db, aid, sid)), "ScheduleCreated", {"schedule_id": sid}
            else:
                row = self.target(db, aid, p["schedule_id"])
                sid = row["schedule_id"]
                if c.get("expected_revision") != row["revision"]:
                    raise DomainError("RevisionConflict", "Time agreement changed; review current state")
                if kind == "EditSchedule":
                    if row["state"] != "Scheduled":
                        raise DomainError("Forbidden", "Only a not-yet-triggered agreement can be edited")
                    db.execute("UPDATE schedules SET title=?,instruction=?,task_kind=?,due_at=?,time_zone=?,revision=revision+1,updated_at=? WHERE schedule_id=?",
                               (*self.fields(p), stamp, sid))
                    event = "ScheduleEdited"
                else:
                    allowed = ("Scheduled", "Ready") if kind == "CancelSchedule" else ("Ready",)
                    if kind not in ("CancelSchedule", "DismissSchedule") or row["state"] not in allowed:
                        raise DomainError("Forbidden", "This reminder cannot be changed in its current state")
                    state = "Cancelled" if kind == "CancelSchedule" else "Dismissed"
                    db.execute("UPDATE schedules SET state=?,revision=revision+1,updated_at=? WHERE schedule_id=?", (state, stamp, sid))
                    event = "Schedule" + state
                data, payload = self.decorate(db, aid, self.target(db, aid, sid)), {"schedule_id": sid}
            self.store.memory.event(db, event, aid, payload, c["command_id"], "user")
            response = {"command_id": c["command_id"], "status": "persisted", "data": data}
            db.execute("INSERT INTO command_results VALUES (?,?,?)", (c["command_id"], serialized, json.dumps(response)))
            return response

    def attach(self, db, command, task_id):
        """Called inside normal user-created Task transaction; no scheduled execution path."""
        p = command["payload"]
        if not p.get("schedule_id"):
            return
        row = self.target(db, command["agent_id"], p["schedule_id"])
        if row["state"] != "Ready" or row["revision"] != p.get("schedule_revision"):
            raise DomainError("RevisionConflict", "Reminder changed or was already handled; refresh before preparing a task")
        actual_kind = "network" if command["type"] == "CreateNetworkTask" else "file"
        if actual_kind != row["task_kind"]:
            raise DomainError("Forbidden", "Task preparation must match this time agreement")
        db.execute("UPDATE schedules SET state='Started',task_id=?,revision=revision+1,updated_at=? WHERE schedule_id=?",
                   (task_id, self.clock().isoformat(), row["schedule_id"]))
        self.store.memory.event(db, "ScheduleTaskStarted", command["agent_id"],
                                {"schedule_id": row["schedule_id"], "task_id": task_id}, command["command_id"], "user")

    def tick(self, reason="Due"):
        with self.store.transaction() as db:
            if db.execute("SELECT value FROM settings WHERE key='runtime'").fetchone()[0] != "Running":
                return 0
            stamp = self.clock().isoformat()
            due = db.execute("SELECT s.* FROM schedules s JOIN scheduler_settings c USING(agent_id) WHERE s.state='Scheduled' AND c.enabled=1 AND s.due_at<=?", (stamp,)).fetchall()
            for row in due:
                db.execute("UPDATE schedules SET state='Ready',triggered_at=?,delivery_reason=?,revision=revision+1,updated_at=? WHERE schedule_id=?",
                           (stamp, reason, stamp, row["schedule_id"]))
                self.store.memory.event(db, "ScheduleDue", row["agent_id"],
                                        {"schedule_id": row["schedule_id"], "due_at": row["due_at"], "delivery_reason": reason}, actor="scheduler")
            return len(due)


class SchedulerRuntime:
    """One loop, active only while Core lives. Errors surface in the local snapshot."""
    def __init__(self, repository, proactive=None):
        self.repo, self.worker = repository, None
        self.proactive = proactive
        self.wakeup, self.reason, self.error = asyncio.Event(), "StartupOverdue", None

    async def start(self):
        self.worker = asyncio.create_task(self.run())

    def wake(self, reason="Due"):
        self.reason = reason
        self.wakeup.set()

    async def run(self):
        while True:
            try:
                self.repo.tick(self.reason)
                if self.proactive:
                    self.proactive.tick()
                self.error = None
            except Exception:
                self.error = "Local reminders could not be persisted; due agreements remain pending"
            self.reason = "Due"
            self.wakeup.clear()
            try:
                await asyncio.wait_for(self.wakeup.wait(), 1)
            except asyncio.TimeoutError:
                pass

    async def close(self):
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
