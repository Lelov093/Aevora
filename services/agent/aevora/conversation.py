"""Conversation/Run repository. Every state transition and event share one transaction."""
import json
from contextlib import closing
from uuid import uuid4

from .context import build_context
from .errors import DomainError
from .identity import now
from .memory_governance import cached
from .conversation_work import approved as approved_work

MIGRATION = (
    """CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents,
       title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
       UNIQUE(conversation_id,agent_id))""",
    """CREATE TABLE selected_conversations (agent_id TEXT PRIMARY KEY REFERENCES agents,
       conversation_id TEXT NOT NULL, FOREIGN KEY(conversation_id,agent_id) REFERENCES conversations(conversation_id,agent_id))""",
    """CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
       input_message_id TEXT NOT NULL, command_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
       outcome TEXT, error_code TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, provider_config_revision INTEGER NOT NULL,
       context TEXT NOT NULL, provider_metadata TEXT NOT NULL DEFAULT '{}', started_at TEXT, completed_at TEXT,
       retry_of TEXT REFERENCES runs, UNIQUE(run_id,conversation_id,agent_id),
       FOREIGN KEY(conversation_id,agent_id) REFERENCES conversations(conversation_id,agent_id),
       FOREIGN KEY(agent_id,provider_config_revision) REFERENCES agent_provider_versions(agent_id,revision)
       DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(input_message_id,run_id,conversation_id,agent_id)
       REFERENCES messages(message_id,run_id,conversation_id,agent_id) DEFERRABLE INITIALLY DEFERRED)""",
    # Only non-secret configured request profile is retained with each revision, for reproducibility.
    """CREATE TABLE agent_provider_versions (agent_id TEXT NOT NULL REFERENCES agents, revision INTEGER NOT NULL,
       config TEXT NOT NULL, PRIMARY KEY(agent_id,revision))""",
    """CREATE TABLE messages (message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
       role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL,
       sequence INTEGER NOT NULL, run_id TEXT NOT NULL, finality TEXT NOT NULL CHECK(finality IN ('final','partial')),
       UNIQUE(conversation_id,sequence), UNIQUE(run_id,role), UNIQUE(message_id,run_id,conversation_id,agent_id),
       FOREIGN KEY(run_id,conversation_id,agent_id) REFERENCES runs(run_id,conversation_id,agent_id)
       DEFERRABLE INITIALLY DEFERRED)""",
    "CREATE UNIQUE INDEX one_foreground_run_per_agent ON runs(agent_id) WHERE state IN ('Created','Running')",
    "ALTER TABLE events ADD COLUMN conversation_id TEXT REFERENCES conversations",
    "ALTER TABLE events ADD COLUMN run_id TEXT REFERENCES runs",
)

# A retry refers to an existing user Message; its Run does not own that Message.
# Keep v3 unchanged so existing databases receive an explicit, atomic migration.
RETRY_MIGRATION = (
    "CREATE UNIQUE INDEX message_scope ON messages(message_id,conversation_id,agent_id)",
    """CREATE TABLE runs_new (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
       input_message_id TEXT NOT NULL, command_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
       outcome TEXT, error_code TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, provider_config_revision INTEGER NOT NULL,
       context TEXT NOT NULL, provider_metadata TEXT NOT NULL DEFAULT '{}', started_at TEXT, completed_at TEXT,
       retry_of TEXT, UNIQUE(run_id,conversation_id,agent_id),
       FOREIGN KEY(conversation_id,agent_id) REFERENCES conversations(conversation_id,agent_id),
       FOREIGN KEY(agent_id,provider_config_revision) REFERENCES agent_provider_versions(agent_id,revision)
       DEFERRABLE INITIALLY DEFERRED,
       FOREIGN KEY(retry_of,conversation_id,agent_id) REFERENCES runs(run_id,conversation_id,agent_id),
       FOREIGN KEY(input_message_id,conversation_id,agent_id)
       REFERENCES messages(message_id,conversation_id,agent_id) DEFERRABLE INITIALLY DEFERRED)""",
    "INSERT INTO runs_new SELECT * FROM runs ORDER BY rowid",
    "DROP TABLE runs",
    "ALTER TABLE runs_new RENAME TO runs",
    "CREATE UNIQUE INDEX one_foreground_run_per_agent ON runs(agent_id) WHERE state IN ('Created','Running')",
)


class ConversationRepository:
    def __init__(self, store):
        self.store = store

    def target(self, db, agent_id, conversation_id):
        self.store.identity.agent(db, agent_id)
        row = db.execute("SELECT * FROM conversations WHERE conversation_id=? AND agent_id=?",
                         (conversation_id, agent_id)).fetchone()
        if not row or row["status"] == "Deleted":
            raise DomainError("NotFound", "Conversation not found in this Agent")
        return dict(row)

    def run(self, db, agent_id, run_id):
        self.store.identity.agent(db, agent_id)
        row = db.execute("SELECT * FROM runs WHERE run_id=? AND agent_id=?", (run_id, agent_id)).fetchone()
        if not row:
            raise DomainError("NotFound", "Run not found in this Agent")
        return dict(row) | {"context": json.loads(row["context"]),
                            "provider_metadata": json.loads(row["provider_metadata"])}

    def list(self, db, agent_id, query=""):
        self.store.identity.agent(db, agent_id)
        query = query.strip()
        return [dict(r) for r in db.execute("""SELECT c.*, o.group_id, COALESCE(o.pinned,0) AS pinned, g.name AS group_name,
            CASE WHEN o.custom_title IS NOT NULL THEN o.custom_title WHEN c.title='新对话' THEN COALESCE((SELECT substr(m.content,1,48) FROM messages m
                WHERE m.conversation_id=c.conversation_id AND m.agent_id=c.agent_id AND m.role='user'
                ORDER BY m.sequence LIMIT 1),c.title) ELSE c.title END AS display_title,
            (SELECT substr(m.content, max(1,instr(lower(m.content),lower(?))-20),100) FROM messages m
                WHERE m.conversation_id=c.conversation_id AND m.agent_id=c.agent_id
                AND instr(lower(m.content),lower(?))>0 ORDER BY m.sequence LIMIT 1) AS match_preview
            FROM conversations c LEFT JOIN conversation_organization o ON o.conversation_id=c.conversation_id AND o.agent_id=c.agent_id
            LEFT JOIN conversation_groups g ON g.group_id=o.group_id AND g.agent_id=c.agent_id
            WHERE c.agent_id=? AND c.status<>'Deleted' AND (?='' OR instr(lower(COALESCE(o.custom_title,c.title)),lower(?))>0
                OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.conversation_id
                    AND m.agent_id=c.agent_id AND instr(lower(m.content),lower(?))>0))
            ORDER BY c.updated_at DESC,c.conversation_id""", (query,query,agent_id,query,query,query))]

    def messages(self, db, agent_id, payload):
        self.target(db, agent_id, payload["conversation_id"])
        before = payload.get("before_sequence", 2**63-1)
        rows = db.execute("""SELECT * FROM messages WHERE agent_id=? AND conversation_id=? AND sequence<?
            ORDER BY sequence DESC LIMIT 51""", (agent_id, payload["conversation_id"], before)).fetchall()
        messages = [dict(r) for r in reversed(rows[:50])]
        from .followup import request_hint
        for m in messages:
            m['followup_request'] = request_hint(m['content']) if m['role'] == 'user' else None
            if m['role'] == 'assistant':
                m['interaction_feedback'] = self.store.interaction_learning.feedback(db, agent_id, m['run_id'])
                refs = self.run(db, agent_id, m['run_id'])['context'].get('interaction_methods', [])
                m['interaction_methods'] = refs
                m['interaction_trial'] = self.run(db, agent_id, m['run_id'])['context'].get('interaction_trial')
            m['followup_applied'] = [json.loads(r[0]) for r in db.execute("SELECT payload FROM events WHERE agent_id=? AND type='SetGoalFollowupPolicy' AND json_extract(payload,'$.source_message_id')=? ORDER BY sequence DESC LIMIT 8", (agent_id,m['message_id']))] if m['role'] == 'user' else []
        work = [w for rid in dict.fromkeys(m['run_id'] for m in messages)
                if (w := self.store.work.response(db, agent_id, rid))]
        return {"messages": messages, "has_more": len(rows)>50, 'work': work}

    def work_responses(self, db, aid, cid, run_ids):
        self.target(db, aid, cid)
        values = []
        for rid in dict.fromkeys(run_ids):
            if not db.execute('SELECT 1 FROM runs WHERE agent_id=? AND conversation_id=? AND run_id=?', (aid, cid, rid)).fetchone():
                raise DomainError('NotFound', 'Work response belongs to another conversation or Agent')
            value = self.store.work.response(db, aid, rid)
            if value:
                values.append(value)
        return values

    def snapshot(self, db, agent_id):
        conversations = self.list(db, agent_id)
        selection = db.execute("SELECT conversation_id FROM selected_conversations WHERE agent_id=?", (agent_id,)).fetchone()
        cid = selection[0] if selection else None
        messages = self.messages(db, agent_id, {"conversation_id": cid}) if cid else {"messages": [], "has_more": False}
        # Always include this conversation's recent attempts and any active Run in
        # another conversation. A busy Agent cannot be hidden by a history limit.
        run_ids = [r[0] for r in db.execute(
            "SELECT run_id FROM runs WHERE agent_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 20", (agent_id,cid))]
        run_ids += [r[0] for r in db.execute(
            "SELECT run_id FROM runs WHERE agent_id=? AND state IN ('Created','Running')", (agent_id,)) if r[0] not in run_ids]
        runs = []
        for rid in run_ids:
            run = self.run(db, agent_id, rid)
            source = db.execute("SELECT content FROM messages WHERE message_id=? AND agent_id=? AND role='user'",
                                (run["input_message_id"],agent_id)).fetchone()
            runs.append(run | {"input_text": source[0] if source else None})
        jobs = [dict(row) for row in db.execute(
            "SELECT job_id,run_id,state,error FROM memory_jobs WHERE agent_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 20",
            (agent_id, cid))]
        erasure = db.execute("SELECT COALESCE(MAX(sequence),0) FROM events WHERE agent_id=? AND type IN ('MemoryDeleted','MemoryForgotten','ConversationDeleted','DeleteGoal','MethodContextErased','DeleteMethod')", (agent_id,)).fetchone()[0]
        work = messages.get('work', [])
        return {**self.store.conversation_groups.view(db, agent_id), "conversations": conversations, "selected_conversation_id": cid, **messages, "runs": runs, "memory_jobs": jobs, "erasure_sequence": erasure, 'work': work, 'resume_goal_id': self.target(db, agent_id, cid)['resume_goal_id'] if cid else None}

    def event(self, db, command_id, kind, agent_id, cid, rid, payload, actor="core"):
        db.execute("""INSERT INTO events(event_id,type,schema_version,actor,timestamp,command_id,agent_id,
            conversation_id,run_id,payload) VALUES (?,?,1,?,?,?,?,?,?,?)""",
            (str(uuid4()), kind, actor, now(), command_id, agent_id, cid, rid, json.dumps(payload)))

    def command(self, db, command, serialized):
        kind, aid, payload = command["type"], command["agent_id"], command["payload"]
        self.store.identity.agent(db, aid)
        if kind == "CreateConversation":
            cid, time = str(uuid4()), now()
            gid = payload.get('resume_goal_id')
            if gid and self.store.goals.target(db, aid, gid)['state'] != 'Active':
                raise DomainError('Forbidden', 'Resume an active Goal')
            db.execute("INSERT INTO conversations(conversation_id,agent_id,title,status,created_at,updated_at) VALUES (?,?,?,'Active',?,?)", (cid, aid, payload.get("title", "新对话"), time, time))
            if gid:
                db.execute("UPDATE conversations SET resume_goal_id=? WHERE conversation_id=?", (gid, cid))
            if payload.get("group_id") is not None:
                self.store.conversation_groups.assign_new(db, aid, cid, payload["group_id"])
            self.event(db, command["command_id"], "ConversationCreated", aid, cid, None, {}, "user")
        else:
            cid = payload["conversation_id"]
            self.target(db, aid, cid)
            if kind == 'SetConversationGoal':
                gid = payload['goal_id']
                if gid:
                    self.store.goals.target(db, aid, gid)
                db.execute('UPDATE conversations SET resume_goal_id=? WHERE conversation_id=? AND agent_id=?', (gid, cid, aid))
            self.event(db, command["command_id"], kind if kind == 'SetConversationGoal' else "ConversationSelected", aid, cid, None, {}, "user")
        if kind != "SetConversationGoal":
            db.execute("INSERT INTO selected_conversations VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET conversation_id=excluded.conversation_id", (aid, cid))
        data = self.target(db, aid, cid)
        response = {"command_id": command["command_id"], "status": "persisted", "data": data}
        db.execute("INSERT INTO command_results VALUES (?,?,?)", (command["command_id"], serialized, json.dumps(response)))
        return response

    def start(self, command, config):
        serialized = json.dumps(command, sort_keys=True, separators=(",", ":"))
        with self.store.transaction() as db:
            old = cached(db, command, serialized)
            if old is not None:
                return old, None
            aid, cid = command["agent_id"], command["payload"]["conversation_id"]
            self.target(db, aid, cid)
            if db.execute("SELECT 1 FROM runs WHERE agent_id=? AND state IN ('Created','Running')", (aid,)).fetchone():
                raise DomainError("RunBusy", "This Agent already has a foreground Run")
            text = command["payload"]["text"].strip()
            if not text:
                raise DomainError("ValidationError", "Message cannot be blank")
            if config.get("chat_input_unlimited") is not True and len(text) > 12000:
                raise DomainError("ValidationError", "Message exceeds the finite local length limit")
            retry = command["payload"].get("retry_of")
            mid = None
            before_sequence = None
            if retry:
                previous = self.run(db, aid, retry)
                if previous["conversation_id"] != cid or previous["state"] not in ("Failed", "Cancelled"):
                    raise DomainError("ValidationError", "Retry must reference a failed/cancelled Run in this conversation")
                source = db.execute("SELECT * FROM messages WHERE message_id=? AND agent_id=? AND conversation_id=? AND role='user'",
                                    (previous["input_message_id"], aid, cid)).fetchone()
                if not source or text != source["content"]:
                    raise DomainError("ValidationError", "Retry must use the original user message unchanged")
                if db.execute("SELECT 1 FROM runs WHERE input_message_id=? AND state='Completed'", (source["message_id"],)).fetchone():
                    raise DomainError("ValidationError", "This user turn already has a completed response")
                mid = source["message_id"]
                before_sequence = source["sequence"]
            profile = self.store.identity.profile(db, aid)
            approval = command['payload'].get('goal_context')
            if retry and previous['context'].get('goal_context') and not approval:
                raise DomainError('Forbidden', 'Review current Goal context explicitly before retrying this reply')
            projection = self.store.goals.approved_context(db, aid, approval) if approval else None
            work_approval = command['payload'].get('work_context')
            work_projection = approved_work(self.store, db, aid, cid, work_approval) if work_approval else None
            from .interaction_trial import approve as approve_trial, references as trial_references
            grant = command['payload'].get('interaction_trial')
            if retry and previous['context'].get('interaction_trial') and not grant:
                raise DomainError('Forbidden', 'Confirm candidate trial again before retrying this reply')
            trial = approve_trial(self.store, db, aid, grant, config) if grant else None
            trial_refs = trial_references(self.store, db, aid, trial, config) if trial else None
            model_messages, refs = build_context(db, profile, cid, text, config, before_sequence,
                                                input_timezone=self.store.input_timezone, goal_projection=projection,
                                                work_suggestions=command['payload'].get('work_suggestions', False), work_projection=work_projection,
                                                interaction_refs=trial_refs, chat_limits=True)
            if trial:
                refs['interaction_trial'] = trial
            if command['payload'].get('work_suggestions'):
                from .work import VERSION
                refs['work_version'] = VERSION
            rid, mid, time = str(uuid4()), mid or str(uuid4()), now()
            refs["input_message_id"] = mid
            seq = db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?", (cid,)).fetchone()[0]
            public = {k: v for k, v in config.items() if k not in ("api_key", "extraction", "embedding")}
            db.execute("INSERT OR IGNORE INTO agent_provider_versions VALUES (?,?,?)", (aid, config["revision"], json.dumps(public)))
            db.execute("""INSERT INTO runs(run_id,agent_id,conversation_id,input_message_id,command_id,state,
                provider,model,provider_config_revision,context,retry_of) VALUES (?,?,?,?,?,'Created',?,?,?,?,?)""",
                (rid, aid, cid, mid, command["command_id"], config["base_url"], config["model"], config["revision"], json.dumps(refs), retry))
            if not retry:
                db.execute("""INSERT INTO messages(message_id,conversation_id,agent_id,role,content,created_at,sequence,run_id,finality,source_timezone)
                    VALUES (?,?,?,?,?,?,?,?,'final',?)""", (mid, cid, aid, "user", text, time, seq, rid, self.store.input_timezone))
            db.execute("UPDATE conversations SET updated_at=? WHERE conversation_id=?", (time, cid))
            if not retry:
                self.event(db, command["command_id"], "UserMessageReceived", aid, cid, rid, {"message_id": mid}, "user")
            self.event(db, command["command_id"], "RunCreated", aid, cid, rid,
                       {"retry_of": retry, "input_message_id": mid} if retry else {})
            response = {"command_id": command["command_id"], "status": "persisted", "data": self.run(db, aid, rid)}
            db.execute("INSERT INTO command_results VALUES (?,?,?)", (command["command_id"], serialized, json.dumps(response)))
            return response, model_messages

    def running(self, agent_id, run_id):
        with self.store.transaction() as db:
            run = self.run(db, agent_id, run_id)
            if run["state"] != "Created":
                return False
            db.execute("UPDATE runs SET state='Running',started_at=? WHERE run_id=?", (now(), run_id))
            self.event(db, run["command_id"], "RunStarted", agent_id, run["conversation_id"], run_id, {})
            self.event(db, run["command_id"], "ModelRequestStarted", agent_id, run["conversation_id"], run_id,
                       {"provider_config_revision": run["provider_config_revision"], "purpose": "Chat"})
            return True

    def finish(self, agent_id, run_id, state, text, metadata, error=None, cancel_command=None, work_raw=''):
        with self.store.transaction() as db:
            if cancel_command:
                serialized = json.dumps(cancel_command, sort_keys=True, separators=(",", ":"))
                old = cached(db, cancel_command, serialized)
                if old is not None:
                    return old["data"]
            run = self.run(db, agent_id, run_id)
            if run["state"] in ("Created", "Running"):
                if state == 'Completed':
                    try:
                        self.store.evolution.check_context(db, agent_id, run['context'])
                    except DomainError:
                        run['context']['context_stale'] = True
                        db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(run['context']), run_id))
                if state == 'Completed' and run['context'].get('work_context'):
                    try:
                        approved_work(self.store, db, agent_id, run['conversation_id'], run['context']['work_context'])
                    except DomainError:
                        run['context']['context_stale'] = True
                        db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(run['context']), run_id))
                if run["context"].get("context_stale"):
                    state, error = "Failed", "ContextStale"
                    if run["context"].get("conversation_deleted") or run["context"].get("context_erased"):
                        text = ""
                time = now()
                if run['context'].get('work_version'):
                    if run['context'].get('context_erased') or run['context'].get('conversation_deleted'):
                        work_raw = ''
                    self.store.work.capture(db, run, work_raw, state == 'Completed')
                outcome = error or ("Completed" if state == "Completed" else "Cancelled")
                if text:
                    seq = db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE conversation_id=?", (run["conversation_id"],)).fetchone()[0]
                    assistant_id = str(uuid4())
                    db.execute("""INSERT INTO messages(message_id,conversation_id,agent_id,role,content,created_at,sequence,run_id,finality)
                        VALUES (?,?,?,?,?,?,?,?,?)""", (assistant_id, run["conversation_id"], agent_id,
                        "assistant", text, time, seq, run_id, "final" if state == "Completed" else "partial"))
                    if state == "Completed" and not run['context'].get('goal_context') and not run['context'].get('work_context'):
                        self.store.memory.enqueue(db, run, assistant_id)
                db.execute("UPDATE runs SET state=?,outcome=?,error_code=?,provider_metadata=?,completed_at=? WHERE run_id=?",
                           (state, outcome, error, json.dumps(metadata), time, run_id))
                db.execute("UPDATE conversations SET updated_at=? WHERE conversation_id=?", (time, run["conversation_id"]))
                # Run termination is not evidence that a Provider response arrived.
                # Recovery has no response evidence, even for a previously Running Run.
                if text or any(metadata.get(key) is not None for key in
                               ("http_status", "response_id", "first_output_seconds")):
                    self.event(db, run["command_id"], "ModelResponseReceived", agent_id, run["conversation_id"], run_id,
                               {"finish_reason": metadata.get("finish_reason"), "request_id": metadata.get("request_id")})
                self.event(db, run["command_id"], "Run" + state, agent_id, run["conversation_id"], run_id,
                           {"outcome": outcome, "assistant_saved": bool(text)})
            result = self.run(db, agent_id, run_id)
            if cancel_command:
                response = {"command_id": cancel_command["command_id"], "status": "persisted", "data": result}
                db.execute("INSERT INTO command_results VALUES (?,?,?)", (cancel_command["command_id"], serialized, json.dumps(response)))
            return result

    def recover(self):
        with closing(self.store.connect()) as db:
            interrupted = db.execute("SELECT agent_id,run_id FROM runs WHERE state IN ('Created','Running')").fetchall()
        for aid, rid in interrupted:
            self.finish(aid, rid, "Failed", "", {}, "RuntimeInterrupted")
