"""Scoped Memory repositories; domain, source, job and Journal writes are atomic."""
import json
from contextlib import closing
from uuid import uuid4

from jsonschema import Draft202012Validator, FormatChecker

from .errors import DomainError
from .identity import now
from .memory_schema import schema_for
from .memory_policy import POLICY_VERSION, decide, fact_identity, normalized
from .memory_temporal import VERSION as TEMPORAL_VERSION, duplicate, validate as validate_temporal
from .memory_selection import materialize, source_units

EXTRACTOR_VERSION = "extractor-v3"
PROMPT_VERSION = "memory-extract-v4"


def topic_key(stored_key, content):
    """Read legacy topicless facts consistently without changing old authority."""
    return stored_key or (fact_identity(content) or (None,))[0]


class MemoryRepository:
    def __init__(self, store):
        self.store = store

    def event(self, db, kind, aid, payload, command_id=None, actor="memory_worker"):
        db.execute("""INSERT INTO events(event_id,type,schema_version,actor,timestamp,command_id,agent_id,payload)
            VALUES (?,?,1,?,?,?,?,?)""", (str(uuid4()), kind, actor, now(), command_id or str(uuid4()), aid, json.dumps(payload)))

    def settings(self, db, aid):
        self.store.identity.profile(db, aid)
        row = db.execute("SELECT * FROM memory_settings WHERE agent_id=?", (aid,)).fetchone()
        return dict(row) if row else {"agent_id": aid, "mode": "Balanced", "revision": 0}

    def enqueue(self, db, run, assistant_id):
        source = [run["input_message_id"], assistant_id]
        key = json.dumps([run["agent_id"], source, EXTRACTOR_VERSION, PROMPT_VERSION])
        jid = str(uuid4())
        cursor = db.execute("""INSERT OR IGNORE INTO memory_jobs(job_id,agent_id,conversation_id,run_id,source_range,
            extractor_version,prompt_version,dedup_key,state,created_at) VALUES (?,?,?,?,?,?,?,?,'Pending',?)""",
            (jid, run["agent_id"], run["conversation_id"], run["run_id"], json.dumps(source), EXTRACTOR_VERSION, PROMPT_VERSION, key, now()))
        if cursor.rowcount:
            self.event(db, "MemoryJobQueued", run["agent_id"], {"job_id": jid, "run_id": run["run_id"]})

    def job(self, db, aid, jid):
        self.store.identity.profile(db, aid)
        row = db.execute("SELECT * FROM memory_jobs WHERE job_id=? AND agent_id=?", (jid, aid)).fetchone()
        if not row:
            raise DomainError("NotFound", "Memory job unavailable for this Agent")
        return dict(row) | {"source_range": json.loads(row["source_range"]), "provider_metadata": json.loads(row["provider_metadata"])}

    def sources(self, db, job):
        run = self.store.conversation.run(db, job["agent_id"], job["run_id"])
        if run["state"] != "Completed" or run["context"].get("context_stale"):
            raise DomainError("SourceUnavailable", "Only a completed turn can be extracted")
        result = []
        for mid in job["source_range"]:
            if db.execute("SELECT 1 FROM memory_revocations WHERE agent_id=? AND source_id=?", (job["agent_id"], mid)).fetchone():
                raise DomainError("SourceRevoked", "This source was revoked; a new explicit user input is required")
            row = db.execute("SELECT * FROM messages WHERE message_id=? AND agent_id=? AND conversation_id=? AND finality='final'",
                             (mid, job["agent_id"], job["conversation_id"])).fetchone()
            if not row:
                raise DomainError("SourceUnavailable", "Extraction source no longer available")
            result.append(dict(row))
        return result

    def detail(self, db, aid, mid):
        self.store.identity.profile(db, aid)
        row = db.execute("SELECT * FROM memories WHERE memory_id=? AND agent_id=?", (mid, aid)).fetchone()
        if not row:
            raise DomainError("NotFound", "Memory unavailable for this Agent")
        revisions = []
        for rev in db.execute("SELECT * FROM memory_revisions WHERE memory_id=? AND agent_id=? ORDER BY revision_number DESC", (mid, aid)):
            sources = []
            for source in db.execute("SELECT * FROM memory_sources WHERE revision_id=? AND agent_id=?", (rev["revision_id"], aid)):
                source = dict(source)
                message = db.execute("SELECT message_id,conversation_id,role,content,created_at,source_timezone FROM messages WHERE message_id=? AND agent_id=? AND content<>''",
                                     (source["source_id"], aid)).fetchone() if source["source_type"] == "message" else None
                source.update(available=message is not None or source["source_type"] == "user_edit", message=dict(message) if message else None)
                if source['source_type'] == 'task_run':
                    task = db.execute('SELECT t.task_id,t.title,r.run_id,r.state FROM task_runs r JOIN tasks t USING(task_id) WHERE t.agent_id=? AND r.run_id=?', (aid,source['source_id'])).fetchone()
                    source.update(available=task is not None, task=dict(task) if task else None)
                sources.append(source)
            revisions.append(dict(rev) | {"sources": sources, "temporal_validation": json.loads(rev["temporal_validation"]),
                                         "interaction_context": json.loads(rev["interaction_context"])})
        key = topic_key(row["subject_key"], revisions[0]["content"])
        conflicts = [{k: r[k] for k in ("memory_id", "revision", "content")} for r in db.execute("""SELECT m.memory_id,m.revision,m.subject_key,r.content FROM memories m
            JOIN memory_revisions r ON r.revision_id=m.current_revision_id
            WHERE m.agent_id=? AND m.status='Active' AND m.memory_id<>?""", (aid, mid))
            if key is not None and topic_key(r["subject_key"], r["content"]) == key]
        metadata_error = None
        try:
            if revisions[0]["evidence_kind"] == "user_edit":
                metadata_validation = revisions[0]["temporal_validation"]
            elif not any(s["message"] for s in revisions[0]["sources"]) and revisions[0]["temporal_validation"].get("status") == "validated":
                # Conversation-only deletion removes evidence prose, not the prior validation fact.
                metadata_validation = revisions[0]["temporal_validation"] | {"source_unavailable": True}
            else:
                _, metadata_validation = validate_temporal(revisions[0], [s["message"] for s in revisions[0]["sources"] if s["message"]])
        except DomainError as exc:
            metadata_error = exc.message
            metadata_validation = {"version": TEMPORAL_VERSION, "status": "unsupported"}
        return dict(row) | {"current": revisions[0], "history": revisions, "conflicts": conflicts,
                            "metadata_validation": metadata_validation, "metadata_error": metadata_error}

    def list(self, db, aid, payload):
        self.store.identity.profile(db, aid)
        status = payload.get("status", "Candidate")
        page = payload.get("page", 0)
        query = payload.get("query", "")
        clause = "m.status=?" if status != "History" else "m.status IN ('Rejected','Superseded','Forgotten','Archived')"
        args = [aid] + ([status] if status != "History" else []) + [query, page * 25]
        rows = db.execute(f"""SELECT m.*,r.content,r.sensitivity,r.policy_reason,r.recorded_at FROM memories m
            JOIN memory_revisions r ON r.revision_id=m.current_revision_id
            WHERE m.agent_id=? AND {clause} AND instr(lower(r.content),lower(?))>0
            ORDER BY m.updated_at DESC,m.memory_id LIMIT 26 OFFSET ?""", args).fetchall()
        return {"items": [dict(row) for row in rows[:25]], "has_more": len(rows) > 25}

    def read(self, db, command):
        kind, aid, p = command["type"], command["agent_id"], command["payload"]
        if kind == "ListMemories":
            return self.list(db, aid, p)
        if kind == "GetMemory":
            return self.detail(db, aid, p["memory_id"])
        if kind == "GetMemorySettings":
            return self.settings(db, aid)
        self.store.identity.profile(db, aid)
        if kind == "ListEmbeddingJobs":
            return [dict(r) | {"metadata": json.loads(r["metadata"])} for r in db.execute(
                "SELECT * FROM embedding_jobs WHERE agent_id=? ORDER BY created_at DESC LIMIT 30", (aid,))]
        return [self.job(db, aid, row[0]) for row in db.execute(
            "SELECT job_id FROM memory_jobs WHERE agent_id=? ORDER BY created_at DESC LIMIT 30", (aid,))]

    def command(self, db, c, serialized):
        aid, p, kind = c["agent_id"], c["payload"], c["type"]
        self.store.identity.profile(db, aid)
        if kind == "ConfigureMemory":
            current = self.settings(db, aid)
            if current["revision"] != c["expected_revision"]:
                raise DomainError("RevisionConflict", "Memory policy changed; reload before saving")
            db.execute("INSERT INTO memory_settings VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET mode=excluded.mode,revision=excluded.revision",
                       (aid, p["mode"], current["revision"] + 1))
            self.event(db, "MemoryPolicyChanged", aid, {"mode": p["mode"], "revision": current["revision"] + 1}, c["command_id"], "user")
            data = self.settings(db, aid)
        elif kind == "RetryMemoryJob":
            job = self.job(db, aid, p["job_id"])
            if job["state"] not in ("Failed", "Cancelled"):
                raise DomainError("ValidationError", "Only failed/cancelled jobs can be retried")
            self.sources(db, job)
            db.execute("UPDATE memory_jobs SET state='Pending',group_attempt=0,next_retry_at=NULL,error=NULL,completed_at=NULL WHERE job_id=?", (job["job_id"],))
            self.event(db, "MemoryJobRetryRequested", aid, {"job_id": job["job_id"]}, c["command_id"], "user")
            data = self.job(db, aid, job["job_id"])
        else:
            detail = self.detail(db, aid, p["memory_id"])
            if detail["revision"] != c["expected_revision"]:
                raise DomainError("RevisionConflict", "Memory changed; reload before review")
            if detail["status"] != "Candidate":
                raise DomainError("ValidationError", "Only pending candidates can be reviewed")
            if p["decision"] == "Approve" and detail["current"]["sensitivity"] != "low" and not p.get("confirm_sensitive", False):
                raise DomainError("Forbidden", "Explicit local sensitive/unknown storage approval required")
            # Revalidate availability at approval, never silently approve deleted sources.
            if p["decision"] == "Approve" and any(not s["available"] for s in detail["current"]["sources"]):
                raise DomainError("SourceUnavailable", "Review sources are no longer available")
            if p["decision"] == "Approve":
                canonical, checked = validate_temporal(detail["current"], [s["message"] for s in detail["current"]["sources"]])
                detail["current"] = canonical | {"temporal_validation": checked}
            status = "Active" if p["decision"] == "Approve" else "Rejected"
            replace = p.get("replace_memory_id")
            if status == "Active" and detail["conflicts"] and not replace:
                raise DomainError("ValidationError", "Choose an Active memory to correct, or reject the conflicting candidate")
            if replace:
                target = self.detail(db, aid, replace)
                if status != "Active" or target["status"] != "Active" or target["revision"] != p.get("replace_expected_revision"):
                    raise DomainError("RevisionConflict", "Replacement target changed or is not Active")
                self.replace(db, detail, target, c)
                data = self.detail(db, aid, replace)
            else:
                db.execute("UPDATE memories SET status=?,revision=revision+1,updated_at=? WHERE memory_id=?", (status, now(), detail["memory_id"]))
                self.event(db, "MemoryCommitted" if status == "Active" else "MemoryRejected", aid,
                           {"memory_id": detail["memory_id"], "revision_id": detail["current_revision_id"], "reason": "UserReview"}, c["command_id"], "user")
                data = self.detail(db, aid, detail["memory_id"])
        response = {"command_id": c["command_id"], "status": "persisted", "data": data}
        db.execute("INSERT INTO command_results VALUES (?,?,?)", (c["command_id"], serialized, json.dumps(response)))
        return response

    def replace(self, db, candidate, target, command):
        aid, rid = candidate["agent_id"], str(uuid4())
        rev = candidate["current"]
        number = target["current"]["revision_number"] + 1
        self.store.governance.revoke_sources(db, aid, target["memory_id"], "UserApprovedCorrection")
        self.store.governance.invalidate(db, aid, [r["revision_id"] for r in target["history"]])
        db.execute("DELETE FROM memory_embeddings WHERE revision_id IN (SELECT revision_id FROM memory_revisions WHERE memory_id=?)", (target["memory_id"],))
        db.execute("UPDATE embedding_jobs SET state='Cancelled',error='RevisionRevoked' WHERE memory_id=? AND state IN ('Pending','Running','Failed')", (target["memory_id"],))
        self.insert_revision(db, rid, target["memory_id"], aid, number, rev, "UserApprovedCorrection", rev["job_id"], target["current_revision_id"], "user")
        for s in rev["sources"]:
            db.execute("INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)", (rid, target["memory_id"], aid, s["source_type"], s["source_id"], s["source_role"], s["span"], "supports", now()))
        db.execute("UPDATE memories SET current_revision_id=?,revision=revision+1,updated_at=? WHERE memory_id=?", (rid, now(), target["memory_id"]))
        db.execute("UPDATE memories SET status='Superseded',revision=revision+1,updated_at=? WHERE memory_id=?", (now(), candidate["memory_id"]))
        self.event(db, "MemoryEdited", aid, {"memory_id": target["memory_id"], "revision_id": rid, "previous_revision_id": target["current_revision_id"]}, command["command_id"], "user")
        self.event(db, "MemorySuperseded", aid, {"memory_id": candidate["memory_id"]}, command["command_id"], "user")

    def insert_revision(self, db, rid, mid, aid, number, item, reason, jid, supersedes=None, actor="memory_worker"):
        db.execute("""INSERT INTO memory_revisions(revision_id,memory_id,agent_id,revision_number,content,importance,confidence,
            sensitivity,evidence_kind,edited_by,change_reason,recorded_at,valid_from,valid_until,scope,supersedes_revision_id,
            policy_reason,job_id,temporal_validation,interaction_context) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (rid, mid, aid, number, item["content"], item["importance"], item["confidence"], item["sensitivity"],
                    item["evidence_kind"], actor, reason, now(), item.get("valid_from"), item.get("valid_until"),
                    item.get("scope"), supersedes, reason, jid, json.dumps(item["temporal_validation"]),
                    json.dumps(item.get('interaction_context', {}))))

    def complete(self, jid, result, metadata):
        with self.store.transaction() as db:
            raw = db.execute("SELECT agent_id FROM memory_jobs WHERE job_id=?", (jid,)).fetchone()
            job = self.job(db, raw[0], jid)
            if job["state"] != "Running":
                return
            Draft202012Validator(schema_for(job["extractor_version"]), format_checker=FormatChecker()).validate(result)
            messages = {s["message_id"]: s for s in self.sources(db, job)}
            if job["extractor_version"] == "extractor-v3":
                result = materialize(result, source_units(list(messages.values())))
                Draft202012Validator(schema_for("extractor-v2"), format_checker=FormatChecker()).validate(result)
            validated = []
            for item in result["candidates"]:
                if job["extractor_version"] != "extractor-v1" and item["source_message_ids"] != [s["message_id"] for s in item["sources"]]:
                    raise DomainError("InvalidSource", "Source IDs must agree with exact quote references")
                sources = []
                for ref in item["sources"]:
                    source = messages.get(ref["message_id"])
                    if not source or ref["quote"] not in source["content"]:
                        raise DomainError("InvalidSource", "Candidate source is outside the completed turn or quote is unsupported")
                    sources.append(source)
                if len({s["message_id"] for s in sources}) != len(sources):
                    raise DomainError("InvalidSource", "Duplicate source references")
                item, checked = validate_temporal(item, sources)
                validated.append((item | {"temporal_validation": checked}, sources))
            mode = self.settings(db, job["agent_id"])["mode"]
            counts = {"Active": 0, "Candidate": 0, "Rejected": 0, "Duplicate": 0}
            for item, sources in validated:
                existing = db.execute("""SELECT m.*,r.content,r.valid_from,r.valid_until,r.scope FROM memories m JOIN memory_revisions r
                    ON m.current_revision_id=r.revision_id WHERE m.agent_id=? AND m.status IN ('Active','Candidate')""", (job["agent_id"],)).fetchall()
                def is_duplicate(record):
                    old_sources = [dict(s) for s in db.execute("""SELECT s.message_id,s.content,s.created_at,s.source_timezone
                        FROM memory_sources ms JOIN messages s ON s.message_id=ms.source_id AND s.agent_id=ms.agent_id
                        WHERE ms.revision_id=? AND ms.source_type='message'""", (record["current_revision_id"],))]
                    return duplicate(item, sources, record, old_sources)
                if any(is_duplicate(e) for e in existing):
                    counts["Duplicate"] += 1
                    continue
                preliminary = decide(item, sources, mode)
                # Older reviewed facts may predate a domain's trusted topic key.
                # Infer their topic for conflict checks without rewriting history
                # or automatically granting old records new authority.
                conflict = bool(preliminary["key"] and any(
                    topic_key(e["subject_key"], e["content"]) == preliminary["key"]
                    and e["status"] in ("Active", "Candidate") for e in existing))
                policy = decide(item, sources, mode, conflict)
                counts[policy["status"]] += 1
                if policy["status"] == "Rejected":
                    self.event(db, "MemoryCandidateRejected", job["agent_id"], {"job_id": jid, "reason": policy["reason"]})
                    continue  # Prohibited/assistant content is never duplicated into a Memory body.
                mid, rid = str(uuid4()), str(uuid4())
                db.execute("INSERT INTO memories VALUES (?,?,?,?,?,?,?, ?,?)", (mid, job["agent_id"], item["type"], policy["status"], rid, 1, policy["key"], now(), now()))
                self.insert_revision(db, rid, mid, job["agent_id"], 1, item | {"sensitivity": policy["sensitivity"]}, policy["reason"], jid)
                for ref, source in zip(item["sources"], sources):
                    offset = source["content"].index(ref["quote"])
                    db.execute("INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)", (rid, mid, job["agent_id"], "message", source["message_id"], source["role"], json.dumps([offset, offset+len(ref["quote"])]), "supports", now()))
                self.event(db, "MemoryCandidateCreated", job["agent_id"], {"job_id": jid, "memory_id": mid, "revision_id": rid, "policy_reason": policy["reason"]})
                if policy["status"] == "Active":
                    self.event(db, "MemoryCommitted", job["agent_id"], {"memory_id": mid, "revision_id": rid, "reason": policy["reason"]})
            settings = self.settings(db, job["agent_id"])
            db.execute("UPDATE memory_jobs SET state='Completed',completed_at=?,error=NULL,provider_metadata=? WHERE job_id=?", (now(), json.dumps(metadata | {"candidate_counts": counts, "policy_version": POLICY_VERSION, "temporal_version": TEMPORAL_VERSION, "policy_mode": mode, "policy_revision": settings["revision"]}), jid))
            self.event(db, "MemoryJobCompleted", job["agent_id"], {"job_id": jid, "candidate_counts": counts, "provider_metadata": metadata})
            return result
