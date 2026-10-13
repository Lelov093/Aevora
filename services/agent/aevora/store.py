"""SQLite authority: state, journal and command result commit together."""
import json
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from .errors import DomainError
from .identity import IdentityRepository
from .conversation import ConversationRepository, MIGRATION, RETRY_MIGRATION
from .memory import MemoryRepository
from .memory_schema import MIGRATION as MEMORY_MIGRATION
from .memory_temporal import INPUT_TIMEZONE, input_zone
from .memory_governance import MemoryGovernance, MIGRATION as RECALL_MIGRATION, cached
from .tasks import TaskRepository, MIGRATION as TASK_MIGRATION
from .planned_tasks import MIGRATION as PLAN_MIGRATION
from .network_tasks import MIGRATION as NETWORK_MIGRATION
from .scheduler import MIGRATION as SCHEDULER_MIGRATION, SchedulerRepository, COMMANDS as SCHEDULE_COMMANDS
from .commitments import MIGRATION as COMMITMENT_MIGRATION, CommitmentRepository
from .goals import MIGRATION as GOAL_MIGRATION, GoalRepository, COMMANDS as GOAL_COMMANDS
from .work import MIGRATION as WORK_MIGRATION, WorkRepository, COMMANDS as WORK_COMMANDS
from .evolution import MIGRATION as EVOLUTION_MIGRATION, EvolutionRepository, COMMANDS as EVOLUTION_COMMANDS
from .proactivity import MIGRATION as PROACTIVE_MIGRATION, ProactivityRepository, COMMANDS as PROACTIVE_COMMANDS

SCHEMA_VERSION = 17
MIGRATIONS = {1: (
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL)",
    "INSERT INTO settings VALUES ('runtime', 'Running', 0)",
    """CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
       type TEXT NOT NULL, schema_version INTEGER NOT NULL, actor TEXT NOT NULL,
       timestamp TEXT NOT NULL, command_id TEXT NOT NULL, payload TEXT NOT NULL)""",
    "CREATE TABLE command_results (command_id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL)",
), 2: (
    "CREATE TABLE users (user_id TEXT PRIMARY KEY)",
    "INSERT INTO users VALUES (lower(hex(randomblob(16))))",
    "INSERT INTO settings SELECT 'owner_user_id',user_id,0 FROM users",
    """CREATE TABLE agents (
       agent_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(user_id),
       name TEXT NOT NULL CHECK(length(trim(name))>0), lifecycle_state TEXT NOT NULL,
       persona_id TEXT UNIQUE NOT NULL, current_persona_revision INTEGER NOT NULL,
       created_at TEXT NOT NULL, UNIQUE(agent_id,persona_id),
       FOREIGN KEY(agent_id,current_persona_revision)
       REFERENCES persona_revisions(agent_id,revision) DEFERRABLE INITIALLY DEFERRED)""",
    """CREATE TABLE persona_revisions (
       agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
       persona_id TEXT NOT NULL, identity_description TEXT NOT NULL,
       communication_style TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
       PRIMARY KEY(agent_id,revision),
       FOREIGN KEY(agent_id,persona_id) REFERENCES agents(agent_id,persona_id)
       DEFERRABLE INITIALLY DEFERRED)""",
    "ALTER TABLE events ADD COLUMN agent_id TEXT REFERENCES agents(agent_id)",
    "INSERT INTO settings VALUES ('selected_agent', '', 0)",
), 3: MIGRATION, 4: RETRY_MIGRATION, 5: MEMORY_MIGRATION, 6: (
    "ALTER TABLE messages ADD COLUMN source_timezone TEXT",
    "ALTER TABLE memory_revisions ADD COLUMN temporal_validation TEXT NOT NULL DEFAULT '{}'",
), 7: RECALL_MIGRATION, 8: (
    "CREATE TABLE selection_grants(grant_id TEXT PRIMARY KEY,calls_started INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE selection_requests(request_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),state TEXT NOT NULL,error TEXT,metadata TEXT NOT NULL)",
), 9: TASK_MIGRATION, 10: PLAN_MIGRATION, 11: NETWORK_MIGRATION, 12: SCHEDULER_MIGRATION, 13: COMMITMENT_MIGRATION, 14: GOAL_MIGRATION, 15: WORK_MIGRATION, 16: EVOLUTION_MIGRATION + PROACTIVE_MIGRATION, 17: (
    "ALTER TABLE conversations ADD COLUMN resume_goal_id TEXT REFERENCES goals(goal_id)",
    "UPDATE conversations SET resume_goal_id=(SELECT g.goal_id FROM runs r JOIN goals g ON g.goal_id=json_extract(r.context,'$.goal_context.goal_id') AND g.agent_id=r.agent_id AND g.state='Active' WHERE r.conversation_id=conversations.conversation_id AND r.agent_id=conversations.agent_id AND r.rowid=(SELECT MAX(x.rowid) FROM runs x WHERE x.conversation_id=conversations.conversation_id))",
    "CREATE TABLE goal_followup_policy(goal_id TEXT PRIMARY KEY REFERENCES goals(goal_id),agent_id TEXT NOT NULL REFERENCES agents(agent_id),revision INTEGER NOT NULL,silenced INTEGER NOT NULL,source_message_id TEXT REFERENCES messages(message_id),updated_at TEXT NOT NULL)",
)}

class Store:
    def __init__(self, path: Path, input_timezone=INPUT_TIMEZONE):
        input_zone(input_timezone)
        self.input_timezone = input_timezone
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.migrate()
        with closing(self.connect()) as db:
            self.identity = IdentityRepository(db.execute(
                "SELECT value FROM settings WHERE key='owner_user_id'").fetchone()[0])
        self.conversation = ConversationRepository(self)
        self.memory = MemoryRepository(self)
        self.governance = MemoryGovernance(self)
        self.tasks = TaskRepository(self)
        self.scheduler = SchedulerRepository(self)
        self.commitments = CommitmentRepository(self)
        self.goals = GoalRepository(self)
        self.work = WorkRepository(self)
        self.evolution = EvolutionRepository(self)
        self.proactivity = ProactivityRepository(self)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def migrate(self):
        with closing(self.connect()) as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise DomainError("SchemaIncompatible", "Database is newer than this Core")
            # SQLite's table-rebuild procedure disables FK enforcement before BEGIN.
            # Validate the complete graph before committing; normal connections keep FK ON.
            db.execute("PRAGMA foreign_keys=OFF")
            try:
                db.execute("BEGIN IMMEDIATE")
                for target in range(version + 1, SCHEMA_VERSION + 1):
                    for sql in MIGRATIONS[target]:
                        db.execute(sql)
                    db.execute(f"PRAGMA user_version={target}")
                if db.execute("PRAGMA foreign_key_check").fetchone():
                    raise sqlite3.IntegrityError("Migration would leave invalid foreign keys")
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.execute("PRAGMA foreign_keys=ON")

    def snapshot(self):
        with closing(self.connect()) as db:
            db.execute("BEGIN")
            row = db.execute("SELECT value, revision FROM settings WHERE key='runtime'").fetchone()
            selected = db.execute("SELECT value FROM settings WHERE key='selected_agent'").fetchone()[0]
            return {"runtime_state": row["value"], "revision": row["revision"],
                    "sequence": db.execute("SELECT COALESCE(MAX(sequence),0) FROM events").fetchone()[0],
                    "schema_version": SCHEMA_VERSION, "agents": self.identity.list(db),
                    "deleted_conversations": [dict(r) for r in db.execute("SELECT agent_id,conversation_id FROM conversations WHERE status='Deleted'")],
                    "selected_agent_id": selected or None,
                    "selected_agent": self.identity.profile(db, selected) if selected else None,
                    "scheduler": self.scheduler.view(db, selected) if selected else None,
                    "goals": self.goals.list(db, selected) if selected else [],
                    "proactivity": self.proactivity.view(db, selected) if selected else None,
                    "chat": self.conversation.snapshot(db, selected) if selected else None}

    def events(self, after):
        with closing(self.connect()) as db:
            return [dict(r) | {"payload": json.loads(r["payload"])}
                    for r in db.execute("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 100", (after,))]

    def execute(self, command):
        if command['type'] in EVOLUTION_COMMANDS:
            return self.evolution.execute(command)
        if command['type'] in PROACTIVE_COMMANDS:
            return self.proactivity.execute(command)
        if command['type'] in WORK_COMMANDS:
            return self.work.execute(command)
        if command["type"] in GOAL_COMMANDS:
            return self.goals.execute(command)
        if command["type"] in SCHEDULE_COMMANDS:
            return self.scheduler.execute(command)
        if command["type"] == "GetSnapshot":
            return {"command_id": command["command_id"], "status": "persisted", "data": self.snapshot()}
        if command["type"] == "ListConversationMemories":
            with closing(self.connect()) as db:
                db.execute("BEGIN")
                data = self.governance.conversation_memories(db, command["agent_id"], command["payload"]["conversation_id"])
            return {"command_id": command["command_id"], "status": "persisted", "data": data}
        if command["type"] in ("ListMemories", "GetMemory", "GetMemorySettings", "ListMemoryJobs", "ListEmbeddingJobs"):
            with closing(self.connect()) as db:
                db.execute("BEGIN")
                data = self.memory.read(db, command)
            return {"command_id": command["command_id"], "status": "persisted", "data": data}
        if command["type"] in ("ListConversations", "ListMessages", "GetRun", "GetConversationWorkContext", "GetConversationWorkResponses"):
            with closing(self.connect()) as db:
                db.execute("BEGIN")
                kind = command["type"]
                if kind == "GetConversationWorkResponses":
                    data = self.conversation.work_responses(db, command['agent_id'], command['payload']['conversation_id'], command['payload']['run_ids'])
                elif kind == "GetConversationWorkContext":
                    from .conversation_work import projection
                    data = projection(self, db, command['agent_id'], command['payload']['conversation_id'])
                elif kind == "ListConversations":
                    data = self.conversation.list(db, command["agent_id"], command["payload"].get("query", ""))
                elif kind == "ListMessages":
                    data = self.conversation.messages(db, command["agent_id"], command["payload"])
                else:
                    data = self.conversation.run(db, command["agent_id"], command["payload"]["run_id"])
            return {"command_id": command["command_id"], "status": "persisted", "data": data}
        if command["type"] in ("ListAgents", "GetAgent", "GetPersonaHistory"):
            with closing(self.connect()) as db:
                db.execute("BEGIN")
                if command["type"] == "ListAgents":
                    data = self.identity.list(db)
                elif command["type"] == "GetAgent":
                    data = self.identity.profile(db, command["agent_id"])
                else:
                    data = self.identity.history(db, command["agent_id"], command["payload"]["persona_id"])
            return {"command_id": command["command_id"], "status": "persisted", "data": data}
        serialized = json.dumps(command, sort_keys=True, separators=(",", ":"))
        with self.transaction() as db:
            old = cached(db, command, serialized)
            if old is not None:
                return old
            if command["type"] == "RetryEmbeddingJob":
                row = db.execute("SELECT * FROM embedding_jobs WHERE job_id=? AND agent_id=?", (command["payload"]["job_id"], command["agent_id"])).fetchone()
                if not row or row["state"] not in ("Failed", "Cancelled"):
                    raise DomainError("NotFound", "Retryable embedding Job unavailable for this Agent")
                current = db.execute("SELECT 1 FROM memories WHERE memory_id=? AND agent_id=? AND current_revision_id=? AND status='Active'", (row["memory_id"], command["agent_id"], row["revision_id"])).fetchone()
                if not current:
                    raise DomainError("SourceRevoked", "Old revision cannot be reindexed")
                db.execute("UPDATE embedding_jobs SET state='Pending',error=NULL WHERE job_id=?", (row["job_id"],))
                data = {"job_id": row["job_id"], "state": "Pending"}
                response = {"command_id": command["command_id"], "status": "persisted", "data": data}
                db.execute("INSERT INTO command_results VALUES (?,?,?)", (command["command_id"], serialized, json.dumps(response)))
                return response
            if command["type"] in ("EditMemory", "ForgetMemory", "DeleteMemory", "DeleteConversation"):
                data = (self.governance.delete_conversation(db, command) if command["type"] == "DeleteConversation"
                        else self.governance.change(db, command))
                response = {"command_id": command["command_id"], "status": "persisted", "data": data}
                db.execute("INSERT INTO command_results VALUES (?,?,?)", (command["command_id"], serialized, json.dumps(response)))
                return response
            if command["type"] in ("CreateAgent", "SelectAgent", "EditPersona"):
                return self.identity_command(db, command, serialized)
            if command["type"] in ("CreateConversation", "SelectConversation", "SetConversationGoal"):
                return self.conversation.command(db, command, serialized)
            if command["type"] in ("ConfigureMemory", "ReviewMemory", "RetryMemoryJob"):
                return self.memory.command(db, command, serialized)
            if command["type"] not in ("Pause", "Resume"):
                raise DomainError("ValidationError", "Unknown command")
            row = db.execute("SELECT * FROM settings WHERE key='runtime'").fetchone()
            if command.get("expected_revision") != row["revision"]:
                raise DomainError("RevisionConflict", "Refresh snapshot before changing runtime")
            state = "Paused" if command["type"] == "Pause" else "Running"
            revision = row["revision"] + 1
            db.execute("UPDATE settings SET value=?, revision=? WHERE key='runtime'", (state, revision))
            db.execute("""INSERT INTO events(event_id,type,schema_version,actor,timestamp,command_id,payload)
                VALUES (?,?,?,?,?,?,?)""",
                (str(uuid4()), "RuntimePaused" if state == "Paused" else "RuntimeResumed", 1,
                 "user", datetime.now(timezone.utc).isoformat(), command["command_id"],
                 json.dumps({"state": state, "revision": revision})))
            response = {"command_id": command["command_id"], "status": "persisted",
                        "data": {"runtime_state": state, "revision": revision}}
            db.execute("INSERT INTO command_results VALUES (?,?,?)",
                       (command["command_id"], serialized, json.dumps(response)))
            return response

    def event(self, db, command_id, event_type, agent_id, payload):
        db.execute("""INSERT INTO events(event_id,type,schema_version,actor,timestamp,command_id,agent_id,payload)
            VALUES (?,?,1,'user',?,?,?,?)""",
            (str(uuid4()), event_type, datetime.now(timezone.utc).isoformat(), command_id,
             agent_id, json.dumps(payload)))

    def identity_command(self, db, command, serialized):
        kind = command["type"]
        if kind == "CreateAgent":
            data = self.identity.create(db, command["payload"])
            agent_id = data["agent_id"]
            self.event(db, command["command_id"], "AgentCreated", agent_id, {"agent_id": agent_id})
            self.event(db, command["command_id"], "PersonaCreated", agent_id,
                       {"persona_id": data["persona_id"], "revision": 1})
            # Creation opens the newly created identity, without changing any existing Agent.
            db.execute("UPDATE settings SET value=?,revision=revision+1 WHERE key='selected_agent'", (agent_id,))
        elif kind == "SelectAgent":
            agent_id = command["agent_id"]
            data = self.identity.profile(db, agent_id)
            db.execute("UPDATE settings SET value=?,revision=revision+1 WHERE key='selected_agent'", (agent_id,))
            self.event(db, command["command_id"], "AgentSelected", agent_id, {})
        else:
            agent_id = command["agent_id"]
            data = self.identity.edit(db, command)
            self.event(db, command["command_id"], "PersonaEdited", agent_id,
                       {"persona_id": data["persona_id"], "revision": data["current_persona_revision"]})
        response = {"command_id": command["command_id"], "status": "persisted", "data": data}
        db.execute("INSERT INTO command_results VALUES (?,?,?)",
                   (command["command_id"], serialized, json.dumps(response)))
        return response
