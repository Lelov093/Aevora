"""User governance. Revocation, context invalidation and erasure share the write transaction."""
import hashlib
import json
from uuid import uuid4

from .errors import DomainError
from .identity import now
from .memory_policy import fact_identity, classify

MIGRATION = (
    "CREATE TABLE memory_revocations(agent_id TEXT NOT NULL,source_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(agent_id,source_id))",
    "CREATE TABLE memory_deletions(memory_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted_at TEXT NOT NULL)",
    """CREATE TABLE memory_embeddings(revision_id TEXT NOT NULL,agent_id TEXT NOT NULL,profile TEXT NOT NULL,
       dimensions INTEGER NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(revision_id,profile),
       FOREIGN KEY(revision_id) REFERENCES memory_revisions(revision_id))""",
    """CREATE TABLE embedding_jobs(job_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,memory_id TEXT NOT NULL,
       revision_id TEXT NOT NULL,profile TEXT NOT NULL,state TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,
       error TEXT,created_at TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',UNIQUE(revision_id,profile))""",
    "CREATE TABLE embedding_grants(grant_id TEXT PRIMARY KEY,calls_started INTEGER NOT NULL DEFAULT 0,input_estimate INTEGER NOT NULL DEFAULT 0)",
)


def cached(db, command, serialized):
    row = db.execute("SELECT request,response FROM command_results WHERE command_id=?", (command["command_id"],)).fetchone()
    if row is None:
        return None
    old = json.loads(row["request"])
    same = (old.get("_erased_request_digest") == hashlib.sha256(serialized.encode()).hexdigest()
            if "_erased_request_digest" in old else row["request"] == serialized)
    if not same:
        raise DomainError("ValidationError", "command_id reused with different request")
    return json.loads(row["response"])


def erase_cached(db, ids):
    """Remove body-bearing acknowledgements but preserve retry identity without storing prose."""
    def mentions(value):
        if isinstance(value, dict):
            return any(mentions(v) for v in value.values())
        if isinstance(value, list):
            return any(mentions(v) for v in value)
        return isinstance(value, str) and value in ids
    for row in db.execute("SELECT * FROM command_results").fetchall():
        if mentions(json.loads(row["request"])) or mentions(json.loads(row["response"])):
            old = json.loads(row["request"])
            digest = old.get("_erased_request_digest") or hashlib.sha256(row["request"].encode()).hexdigest()
            response = {"command_id": row["command_id"], "status": "persisted", "data": {"deleted": True}}
            db.execute("UPDATE command_results SET request=?,response=? WHERE command_id=?",
                       (json.dumps({"_erased_request_digest": digest}), json.dumps(response), row["command_id"]))


class MemoryGovernance:
    def __init__(self, store):
        self.store = store

    def revoke_sources(self, db, aid, mid, reason):
        ids = [r[0] for r in db.execute("SELECT DISTINCT source_id FROM memory_sources WHERE memory_id=? AND agent_id=? AND source_type='message'", (mid, aid))]
        for sid in ids:
            db.execute("INSERT OR IGNORE INTO memory_revocations VALUES (?,?,?)", (aid, sid, reason))
        for job in db.execute("SELECT job_id,source_range FROM memory_jobs WHERE agent_id=?", (aid,)).fetchall():
            if set(json.loads(job["source_range"])) & set(ids):
                db.execute("UPDATE memory_jobs SET state='Cancelled',error='SourceRevoked',completed_at=? WHERE job_id=?", (now(), job["job_id"]))

    def invalidate(self, db, aid, revision_ids, erase=False):
        self.store.tasks.invalidate(db, aid, revision_ids, erase)
        affected = set()
        for run in db.execute("SELECT run_id,context FROM runs WHERE agent_id=?", (aid,)).fetchall():
            refs = json.loads(run["context"])
            if not set(refs.get("memory_revision_ids", [])) & set(revision_ids):
                continue
            refs["context_stale"] = True
            if erase:
                refs["context_erased"] = True
            affected.add(run["run_id"])
            db.execute("UPDATE runs SET context=? WHERE run_id=?", (json.dumps(refs), run["run_id"]))
            self.store.work.invalidate(db, aid, [run['run_id']], erase)
            db.execute("UPDATE memory_jobs SET state='Cancelled',error='ContextStale',completed_at=? WHERE run_id=? AND state<>'Completed'", (now(), run["run_id"]))
            # Completed answers are known derived context too. Erasure clears their body;
            # ordinary edits keep the old answer visible with an explicit stale indication.
            if erase:
                db.execute("UPDATE messages SET content='',finality='partial' WHERE run_id=? AND role='assistant'", (run["run_id"],))
                db.execute("UPDATE memory_jobs SET state='Cancelled',error='ContextStale',completed_at=? WHERE run_id=?", (now(), run["run_id"]))
        return affected

    def change(self, db, c):
        repo = self.store.memory
        aid, p, kind = c["agent_id"], c["payload"], c["type"]
        detail = repo.detail(db, aid, p["memory_id"])
        if c["expected_revision"] != detail["revision"]:
            raise DomainError("RevisionConflict", "Memory changed; reload before saving")
        mid = detail["memory_id"]
        revisions = [r["revision_id"] for r in detail["history"]]
        self.revoke_sources(db, aid, mid, kind)
        affected = self.invalidate(db, aid, revisions, kind in ("ForgetMemory", "DeleteMemory"))
        db.execute("DELETE FROM memory_embeddings WHERE revision_id IN (SELECT revision_id FROM memory_revisions WHERE memory_id=?)", (mid,))
        db.execute("UPDATE embedding_jobs SET state='Cancelled',error='RevisionRevoked' WHERE memory_id=? AND state IN ('Pending','Running','Failed')", (mid,))
        if kind == "EditMemory":
            if detail["status"] != "Active":
                raise DomainError("ValidationError", "Only Active memories can be edited")
            content = p["content"].strip()
            if not content:
                raise DomainError("ValidationError", "Memory content cannot be blank")
            key = (fact_identity(content) or (None,))[0]
            if key:
                from .memory import topic_key
                for peer in db.execute("""SELECT m.subject_key,r.content FROM memories m JOIN memory_revisions r ON r.revision_id=m.current_revision_id
                        WHERE m.agent_id=? AND m.status='Active' AND m.memory_id<>?""", (aid,mid)):
                    if topic_key(peer["subject_key"],peer["content"]) == key:
                        raise DomainError("RevisionConflict", "Another Active memory already holds this fact; review it before changing topics")
            # A manual edit is a new source. Previous message evidence cannot attest to new prose.
            item = detail["current"] | {"content": content, "evidence_kind": "user_edit",
                "valid_from": p.get("valid_from"), "valid_until": p.get("valid_until"), "scope": p.get("scope"),
                "temporal_validation": {"version": "manual-edit-v1", "status": "user_supplied", "source_timezone": self.store.input_timezone,
                    "supplied_validity": {k: p.get(k) for k in ("valid_from", "valid_until")}}}
            risk = classify(item | {"type": detail["type"], "sensitivity": "unknown"}, [{"role": "user", "content": content}])
            if risk["sensitivity"] == "prohibited":
                raise DomainError("ValidationError", "Credentials cannot be stored as Memory")
            item["sensitivity"] = risk["sensitivity"]
            item["confidence"] = 1.0  # Direct user edit, not an inherited model confidence estimate.
            from datetime import datetime, timezone
            for key in ("valid_from", "valid_until"):
                if item[key]:
                    try:
                        value = datetime.fromisoformat(item[key].replace("Z", "+00:00"))
                        if value.tzinfo is None:
                            raise ValueError()
                        item[key] = value.astimezone(timezone.utc).isoformat()
                    except ValueError:
                        raise DomainError("ValidationError", "Validity requires a date with explicit timezone") from None
            if item["valid_from"] and item["valid_until"] and item["valid_from"] >= item["valid_until"]:
                raise DomainError("ValidationError", "Validity end must be after start")
            rid = str(uuid4())
            repo.insert_revision(db, rid, mid, aid, detail["current"]["revision_number"] + 1, item,
                                 "UserEdit", None, detail["current_revision_id"], "user")
            db.execute("INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)", (rid, mid, aid, "user_edit", c["command_id"], "user", None, "supports", now()))
            key = (fact_identity(content) or (None,))[0]
            db.execute("UPDATE memories SET current_revision_id=?,revision=revision+1,subject_key=?,updated_at=? WHERE memory_id=?", (rid, key, now(), mid))
            repo.event(db, "MemoryEdited", aid, {"memory_id": mid, "revision_id": rid}, c["command_id"], "user")
            return repo.detail(db, aid, mid)
        if kind == "ForgetMemory":
            db.execute("UPDATE memories SET status='Forgotten',revision=revision+1,updated_at=? WHERE memory_id=?", (now(), mid))
            repo.event(db, "MemoryForgotten", aid, {"memory_id": mid}, c["command_id"], "user")
            return repo.detail(db, aid, mid)
        # Remove the circular current pointer/revision graph in this deferred transaction.
        db.execute("DELETE FROM memory_sources WHERE memory_id=?", (mid,))
        db.execute("DELETE FROM memory_revisions WHERE memory_id=?", (mid,))
        db.execute("DELETE FROM memories WHERE memory_id=?", (mid,))
        db.execute("INSERT INTO memory_deletions VALUES (?,?,?,?)", (mid, aid, detail["revision"] + 1, now()))
        message_ids = {r[0] for rid in affected for r in db.execute("SELECT message_id FROM messages WHERE run_id=? AND role='assistant'", (rid,))}
        erase_cached(db, {mid, *revisions, *affected, *message_ids})
        repo.event(db, "MemoryDeleted", aid, {"memory_id": mid}, c["command_id"], "user")
        return {"memory_id": mid, "deleted": True}

    def conversation_memories(self, db, aid, cid):
        self.store.conversation.target(db, aid, cid)
        rows = db.execute("""SELECT DISTINCT ms.memory_id FROM memory_sources ms JOIN messages m
            ON ms.source_id=m.message_id AND ms.agent_id=m.agent_id
            WHERE ms.agent_id=? AND m.conversation_id=? AND ms.source_type='message'""", (aid, cid))
        result = []
        for row in rows.fetchall():
            d = self.store.memory.detail(db, aid, row[0])
            count = db.execute("SELECT COUNT(DISTINCT source_id) FROM memory_sources WHERE memory_id=?", (row[0],)).fetchone()[0]
            result.append({"memory_id": row[0], "revision": d["revision"], "content": d["current"]["content"], "multiple_sources": count > 1})
        return result

    def delete_conversation(self, db, c):
        aid, p = c["agent_id"], c["payload"]
        cid = p["conversation_id"]
        derived = {m["memory_id"]: m for m in self.conversation_memories(db, aid, cid)}
        chosen = p.get("memory_ids", [])
        if p["scope"] == "conversation_only" and chosen:
            raise DomainError("ValidationError", "Conversation-only deletion cannot select memories")
        if len(set(chosen)) != len(chosen) or any(mid not in derived for mid in chosen):
            raise DomainError("ValidationError", "Only displayed derived memories can be selected")
        expected = p.get("memory_revisions", {})
        for mid in chosen:
            if expected.get(mid) != derived[mid]["revision"]:
                raise DomainError("RevisionConflict", "Derived memory changed; review deletion scope again")
            self.change(db, c | {"type": "DeleteMemory", "expected_revision": expected[mid], "payload": {"memory_id": mid}})
        messages = {r[0] for r in db.execute("SELECT message_id FROM messages WHERE conversation_id=? AND agent_id=?", (cid, aid))}
        runs = {r[0] for r in db.execute("SELECT run_id FROM runs WHERE conversation_id=? AND agent_id=?", (cid, aid))}
        for sid in messages:
            db.execute("INSERT OR IGNORE INTO memory_revocations VALUES (?,?,'ConversationDeleted')", (aid, sid))
        # References from other conversations must not reuse erased history.
        for row in db.execute("SELECT run_id,context FROM runs WHERE agent_id=?", (aid,)).fetchall():
            refs = json.loads(row["context"])
            if row["run_id"] in runs or messages & set(refs.get("message_ids", [])):
                refs["context_stale"] = True
                refs["conversation_deleted"] = row["run_id"] in runs
                db.execute("UPDATE runs SET context=? WHERE run_id=?", (json.dumps(refs), row["run_id"]))
        db.execute("UPDATE messages SET content='',finality='partial' WHERE conversation_id=? AND agent_id=?", (cid, aid))
        self.store.work.invalidate(db, aid, runs, True)
        db.execute("UPDATE memory_jobs SET state='Cancelled',error='SourceUnavailable',completed_at=? WHERE conversation_id=? AND agent_id=?", (now(), cid, aid))
        db.execute("UPDATE conversations SET title='',status='Deleted',updated_at=? WHERE conversation_id=? AND agent_id=?", (now(), cid, aid))
        db.execute("DELETE FROM selected_conversations WHERE conversation_id=? AND agent_id=?", (cid, aid))
        erase_cached(db, {cid, *messages, *runs})
        self.store.memory.event(db, "ConversationDeleted", aid, {"conversation_id": cid, "memory_ids": chosen}, c["command_id"], "user")
        return {"conversation_id": cid, "deleted": True, "deleted_memory_ids": chosen}
