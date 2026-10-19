"""Rebuildable SQLite vectors and one owned worker. Current revisions remain authoritative."""
import asyncio
import json
import math
import time
from contextlib import closing
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from .errors import DomainError
from .gateway import EmbeddingGateway, ModelGateway
from .identity import now
from .memory_governance import cached
from . import relevance

VERSION = "recall-v5"
MINIMUM_SCORE = .40  # G4 development calibration: weakest positive .4161; strongest negative .3923.


def profile(config):
    return json.dumps({k: config[k] for k in ("base_url", "model", "dimensions", "profile")}, sort_keys=True)


def metadata_supported(row):
    if not any(row[key] for key in ("valid_from", "valid_until", "scope")):
        return True
    return json.loads(row["temporal_validation"]).get("status") in ("validated", "user_supplied")


def valid_at(row, timestamp):
    if not metadata_supported(row):
        return False
    for key in ("valid_from", "valid_until"):
        if row[key]:
            try:
                bound = datetime.fromisoformat(row[key].replace("Z", "+00:00"))
                if bound.tzinfo is None:
                    return False
                if key == "valid_from" and timestamp < bound or key == "valid_until" and timestamp >= bound:
                    return False
            except ValueError:
                return False
    return True


def active(db, aid):
    timestamp = datetime.now(timezone.utc)
    return [dict(r) for r in db.execute("""SELECT m.memory_id,m.agent_id,m.current_revision_id AS revision_id,
        m.revision,m.subject_key,m.type,r.content,r.recorded_at,r.valid_from,r.valid_until,r.scope,r.evidence_kind,r.temporal_validation,r.interaction_context
        FROM memories m JOIN memory_revisions r ON r.revision_id=m.current_revision_id
        WHERE m.agent_id=? AND m.status='Active'""", (aid,)) if valid_at(r, timestamp)]


def current(db, aid, references):
    available = {r["revision_id"]: r for r in active(db, aid)}
    return all(r["revision_id"] in available and available[r["revision_id"]]["memory_id"] == r["memory_id"] for r in references)


class RecallRuntime:
    def __init__(self, store, config=None, selection=None):
        self.store = store
        self.gateway = EmbeddingGateway(config)
        relevance.validate(selection)
        self.selector = ModelGateway(selection)
        self.selection_tasks = set()
        self.worker = self.request = None
        self.closed = False
        self.error = None
        self.testing_unlimited = False

    def enabled(self):
        return bool(self.gateway.config.get("embedding_allowed"))

    def configure(self, config, selection=None):
        self.gateway.configure(config)
        relevance.validate(selection)
        self.selector.configure(selection)

    def public(self):
        config = self.gateway.public()
        with closing(self.store.connect()) as db:
            grant = db.execute("SELECT * FROM embedding_grants WHERE grant_id=?", (config.get("grant_id", ""),)).fetchone()
            selected = self.selector.public()
            selection_grant = db.execute("SELECT * FROM selection_grants WHERE grant_id=?", (selected.get("grant_id", ""),)).fetchone()
            selected["calls_started"] = selection_grant["calls_started"] if selection_grant else 0
        return config | {"calls_started": grant["calls_started"] if grant else 0,
                         "input_estimate_used": grant["input_estimate"] if grant else 0, "worker_error": self.error,
                         "selection": selected}

    async def select_candidates(self, aid, text, candidates, config, metadata):
        estimate = sum(len(m["content"]) + 16 for m in relevance.messages(text, candidates))
        if estimate > config["max_input_tokens"]:
            raise DomainError("BudgetExceeded", "Whole relevance input exceeds the configured budget")
        request_id = str(uuid4())
        metadata.update(version=relevance.VERSION, purpose="MemoryRecallSelection", grant_id=config["grant_id"],
                        provider_revision=config["revision"], model=config["model"], input_estimate=estimate)
        with self.store.transaction() as db:
            db.execute("INSERT OR IGNORE INTO selection_grants(grant_id) VALUES (?)", (config["grant_id"],))
            grant = db.execute("SELECT calls_started FROM selection_grants WHERE grant_id=?", (config["grant_id"],)).fetchone()
            if config.get("calls_unlimited") is not True and grant[0] >= config["max_calls"]:
                raise DomainError("RecallUnavailable", "Recall selection budget exhausted; no unfiltered fallback")
            db.execute("UPDATE selection_grants SET calls_started=calls_started+1 WHERE grant_id=?", (config["grant_id"],))
            db.execute("INSERT INTO selection_requests VALUES (?,?,'Running',NULL,?)", (request_id, aid, json.dumps(metadata)))
        task = asyncio.create_task(relevance.judge(config, text, candidates, metadata, self.selector,
            lambda: self.store.probe_point("selection.delta", {"request_id": request_id, "agent_id": aid, "metadata": metadata})))
        self.selection_tasks.add(task)
        state, error = "Failed", "RuntimeInterrupted"
        try:
            positions = await task
            state, error = "Completed", None
            return [candidates[i] for i in positions]
        except asyncio.CancelledError:
            error = "SelectionRevokedOrStopped"
            raise DomainError("RecallUnavailable", "Recall selection was cancelled; no unfiltered fallback") from None
        except BaseException as exc:
            error = exc.code if isinstance(exc, DomainError) else "RuntimeInterrupted" if isinstance(exc, asyncio.CancelledError) else "RecallSelectionFailed"
            raise
        finally:
            self.selection_tasks.discard(task)
            with self.store.transaction() as db:
                db.execute("UPDATE selection_requests SET state=?,error=?,metadata=? WHERE request_id=?",
                           (state, error, json.dumps(metadata), request_id))

    async def cancel_selection(self):
        tasks = list(self.selection_tasks)
        for task in tasks: task.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)

    def reconcile(self, db, config):
        if not config or not config.get("model"):
            return
        key = profile(config)
        for r in db.execute("""SELECT m.memory_id,m.agent_id,m.current_revision_id,r.valid_from,r.valid_until,r.scope,r.temporal_validation
            FROM memories m JOIN memory_revisions r ON r.revision_id=m.current_revision_id WHERE m.status='Active'""").fetchall():
            if not metadata_supported(r):
                continue
            db.execute("INSERT OR IGNORE INTO embedding_jobs(job_id,agent_id,memory_id,revision_id,profile,state,created_at) VALUES (?,?,?,?,?,'Pending',?)",
                       (str(uuid4()), r["agent_id"], r["memory_id"], r["current_revision_id"], key, now()))

    def reserve(self, db, config, text):
        if not config.get("embedding_allowed") or not config.get("api_key") or not config.get("grant_id"):
            raise DomainError("RecallUnavailable", "Embedding needs its own outbound permission")
        estimate = len(text) + 16
        if estimate > config["max_input_tokens"]:
            raise DomainError("BudgetExceeded", "Embedding input exceeds its estimate budget")
        db.execute("INSERT OR IGNORE INTO embedding_grants(grant_id) VALUES (?)", (config["grant_id"],))
        grant = db.execute("SELECT * FROM embedding_grants WHERE grant_id=?", (config["grant_id"],)).fetchone()
        if not self.testing_unlimited and ((config.get("calls_unlimited") is not True and grant["calls_started"] >= config["max_calls"])
                or (config.get("input_unlimited") is not True and grant["input_estimate"] + estimate > config["max_total_input_tokens"])):
            raise DomainError("RecallUnavailable", "Embedding budget exhausted; no old-context fallback")
        db.execute("UPDATE embedding_grants SET calls_started=calls_started+1,input_estimate=input_estimate+? WHERE grant_id=?", (estimate, config["grant_id"]))
        return {"purpose": "MemoryEmbedding", "provider_revision": config["revision"], "grant_id": config["grant_id"],
                "model": config["model"], "dimensions": config["dimensions"], "input_estimate": estimate,
                "testing_unlimited": self.testing_unlimited}

    async def prepare(self, aid, text, *, reply_preferences=True, conversation_id=None):
        # No configured recall means Chat explicitly reports disabled recall, preserving local governance.
        if not self.gateway.config:
            return [], {"version": VERSION, "state": "Disabled", "candidates": []}
        config = dict(self.gateway.config)
        selection_config = dict(self.selector.config)
        if not self.enabled():
            return [], {"version": VERSION, "state": "Disabled", "candidates": []}
        key = profile(config)
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            rows = [row for row in active(db, aid) if not (
                (local := json.loads(row['interaction_context'])).get('conversation_id')
                and local['conversation_id'] != conversation_id)]
            if not rows:
                return [], {"version": VERSION, "state": "Ready", "candidates": []}
            self.reconcile(db, config)
            indexed = []
            for row in rows:
                vector = db.execute("SELECT vector FROM memory_embeddings WHERE revision_id=? AND agent_id=? AND profile=?", (row["revision_id"], aid, key)).fetchone()
                if not vector:
                    raise DomainError("RecallUpdating", "Current Memory index is updating or failed; retry after it is ready")
                indexed.append((row, json.loads(vector[0])))
            metadata = self.reserve(db, config, text)
        try:
            query = await self.gateway.embed(config, text, metadata)
        finally:
            # Retain billing metadata even when later selection fails or a Run never starts.
            with self.store.transaction() as db:
                self.store.memory.event(db, "MemoryQueryEncoded", aid, {"metadata": metadata})
        began = time.monotonic()
        norm = math.sqrt(sum(x*x for x in query))
        scored = []
        for row, vector in indexed:
            score = sum(a*b for a,b in zip(query, vector)) / (norm * math.sqrt(sum(x*x for x in vector)))
            # Known reply length/language/tone preferences apply to assistant replies.
            # This bounded metadata rule does not classify unknown prose or grant permissions.
            preference = bool(reply_preferences and row["subject_key"] and row["subject_key"].startswith(("user.answer.", "user.communication.")))
            scored.append(row | {"score": score, "rank_reason": "reply_preference" if preference else "semantic_cosine"})
        scored.sort(key=lambda r: (r["rank_reason"] != "reply_preference", -r["score"], r["memory_id"]))
        chosen = [r for r in scored[:5] if r["rank_reason"] == "reply_preference" or r["score"] >= MINIMUM_SCORE]
        selection = {"version": relevance.VERSION, "state": "Disabled"}
        logged = scored[:5]
        if selection_config.get("selection_allowed"):
            preferences = [r for r in scored if r["rank_reason"] == "reply_preference"][:5]
            pool = [r for r in scored if r["rank_reason"] != "reply_preference" and r["score"] >= MINIMUM_SCORE][:10]
            semantic = await self.select_candidates(aid, text, pool, selection_config, selection) if pool and len(preferences) < 5 else []
            selection["state"] = "Completed" if pool and len(preferences) < 5 else "NotNeeded"
            chosen = preferences + semantic[:5-len(preferences)]
            logged = preferences + pool
        # Query encoding may race with an edit/delete. Recheck DB before supplying prose.
        with closing(self.store.connect()) as db:
            eligible = [r for r in active(db, aid) if not (
                (local := json.loads(r['interaction_context'])).get('conversation_id')
                and local['conversation_id'] != conversation_id)]
            if {r["revision_id"] for r in eligible} != {r["revision_id"] for r in rows} or config != self.gateway.config or selection_config != self.selector.config:
                raise DomainError("RecallUpdating", "Memory or embedding configuration changed during recall")
            for row in chosen:
                row['interaction_context'] = json.loads(row['interaction_context'])
                row["sources"] = [dict(s) for s in db.execute("""SELECT ms.source_type,ms.source_id,ms.source_role,ms.relation,ms.created_at,
                    m.created_at AS source_message_created_at,m.source_timezone,
                    CASE WHEN ms.source_type='user_edit' OR (m.content IS NOT NULL AND m.content<>'') THEN 1 ELSE 0 END AS available
                    FROM memory_sources ms LEFT JOIN messages m ON ms.source_id=m.message_id AND ms.agent_id=m.agent_id
                    WHERE ms.revision_id=? AND ms.agent_id=?""", (row["revision_id"], aid))]
        return chosen, {"version": VERSION, "state": "Ready", "profile": key, "minimum_score": MINIMUM_SCORE,
            "selection_config_revision": selection_config.get("revision"),
            "selection": selection, "selected_revision_ids": [r["revision_id"] for r in chosen],
            "candidates": [{k: r[k] for k in ("memory_id", "revision_id", "score", "rank_reason")} for r in logged],
            "query_embedding": metadata, "local_search_seconds": time.monotonic() - began}

    async def search(self, command):
        """A paid semantic read retains command identity so lost acknowledgements cannot rebill."""
        serialized = json.dumps(command, sort_keys=True, separators=(",", ":"))
        aid = command["agent_id"]
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            old = cached(db, command, serialized)
            if old is not None:
                data = old["data"]
                if data.get("deleted"):
                    raise DomainError("SourceRevoked", "Search result was erased")
                if old["status"] == "processing":
                    raise DomainError("RunBusy", "This search is already processing")
                if data.get("error"):
                    raise DomainError(data["error"], "Prior search failed; an explicit new query is required")
                metadata = data["recall"]
                if metadata.get("selection_config_revision") != self.selector.config.get("revision"):
                    raise DomainError("RecallUpdating", "Recall selection configuration changed; submit a new query")
                if metadata["state"] == "Ready" and (not self.enabled() or metadata.get("profile", profile(self.gateway.config)) != profile(self.gateway.config)
                        or not current(db, aid, metadata["candidates"])):
                    raise DomainError("RecallUpdating", "Prior result is no longer current; submit a new query")
                return old
            ids = [r["memory_id"] for r in active(db, aid)]
            pending = {"command_id": command["command_id"], "status": "processing", "data": {"memory_ids": ids}}
            db.execute("INSERT INTO command_results VALUES (?,?,?)", (command["command_id"], serialized, json.dumps(pending)))
        try:
            rows, metadata = await self.prepare(aid, command["payload"]["query"], reply_preferences=False)
            with self.store.transaction() as db:
                row = db.execute("SELECT request FROM command_results WHERE command_id=?", (command["command_id"],)).fetchone()
                if row[0] != serialized or not current(db, aid, rows):
                    raise DomainError("SourceRevoked", "Search result was invalidated")
                items = []
                for row in rows:
                    d = self.store.memory.detail(db, aid, row["memory_id"])
                    items.append({k: d[k] for k in ("memory_id", "revision", "status", "type")} | {
                        "content": d["current"]["content"], "sensitivity": d["current"]["sensitivity"],
                        "policy_reason": d["current"]["policy_reason"]})
                response = {"command_id": command["command_id"], "status": "persisted", "data": {"items": items, "recall": metadata}}
                db.execute("UPDATE command_results SET response=? WHERE command_id=?", (json.dumps(response), command["command_id"]))
            return response
        except BaseException as exc:
            code = "RuntimeInterrupted" if isinstance(exc, asyncio.CancelledError) else exc.code if isinstance(exc, DomainError) else "EmbeddingFailed"
            failed = {"command_id": command["command_id"], "status": "failed", "data": {"error": code}}
            with self.store.transaction() as db:
                db.execute("UPDATE command_results SET response=? WHERE command_id=? AND request=?", (json.dumps(failed), command["command_id"], serialized))
            raise

    def claim(self):
        if not self.enabled():
            return None
        config = dict(self.gateway.config)
        with self.store.transaction() as db:
            self.reconcile(db, config)
            if db.execute("SELECT value FROM settings WHERE key='runtime'").fetchone()[0] != "Running":
                return None
            for job in db.execute("SELECT * FROM embedding_jobs WHERE state='Pending' AND profile=? ORDER BY created_at,job_id", (profile(config),)).fetchall():
                row = db.execute("""SELECT r.content FROM memories m JOIN memory_revisions r ON r.revision_id=m.current_revision_id
                    WHERE m.memory_id=? AND m.agent_id=? AND m.status='Active' AND m.current_revision_id=?""", (job["memory_id"], job["agent_id"], job["revision_id"])).fetchone()
                if not row:
                    db.execute("UPDATE embedding_jobs SET state='Cancelled',error='RevisionRevoked' WHERE job_id=?", (job["job_id"],))
                    continue
                try:
                    metadata = self.reserve(db, config, row[0])
                except DomainError as exc:
                    if exc.code == "BudgetExceeded":
                        db.execute("UPDATE embedding_jobs SET state='Failed',error=? WHERE job_id=?", (exc.code, job["job_id"]))
                        continue
                    return None
                db.execute("UPDATE embedding_jobs SET state='Running',attempt=attempt+1,error=NULL,metadata=? WHERE job_id=?", (json.dumps(metadata), job["job_id"]))
                return dict(job), row[0], config, metadata
        return None

    async def index(self, job, text, config, metadata):
        try:
            vector = await self.gateway.embed(config, text, metadata)
            with self.store.transaction() as db:
                row = db.execute("SELECT state FROM embedding_jobs WHERE job_id=?", (job["job_id"],)).fetchone()
                valid = db.execute("SELECT 1 FROM memories WHERE agent_id=? AND memory_id=? AND current_revision_id=? AND status='Active'",
                                   (job["agent_id"], job["memory_id"], job["revision_id"])).fetchone() is not None
                if not row or row[0] != "Running" or not valid or config != self.gateway.config:
                    db.execute("UPDATE embedding_jobs SET state='Cancelled',error='RevisionRevoked' WHERE job_id=?", (job["job_id"],))
                    return
                db.execute("INSERT OR REPLACE INTO memory_embeddings VALUES (?,?,?,?,?)", (job["revision_id"], job["agent_id"], profile(config), config["dimensions"], json.dumps(vector)))
                db.execute("UPDATE embedding_jobs SET state='Completed',metadata=? WHERE job_id=?", (json.dumps(metadata), job["job_id"]))
                self.store.memory.event(db, "MemoryIndexed", job["agent_id"], {"memory_id": job["memory_id"], "revision_id": job["revision_id"], "metadata": metadata})
        except BaseException as exc:
            if not isinstance(exc, (Exception, asyncio.CancelledError)):
                raise
            code = "RuntimePausedOrStopped" if isinstance(exc, asyncio.CancelledError) else (
                exc.code if isinstance(exc, DomainError) else "ProviderTimeout" if isinstance(exc, (TimeoutError, httpx.TimeoutException)) else "EmbeddingFailed")
            with self.store.transaction() as db:
                db.execute("UPDATE embedding_jobs SET state=?,error=?,metadata=? WHERE job_id=? AND state='Running'",
                           ("Pending" if code == "RuntimePausedOrStopped" else "Failed", code, json.dumps(metadata), job["job_id"]))

    async def loop(self):
        while not self.closed:
            try:
                work = self.claim()
                if work:
                    self.request = asyncio.create_task(self.index(*work))
                    await self.request
                    self.request = None
            except Exception:
                self.error = "EmbeddingWorkerUnavailable"
                return
            await asyncio.sleep(.2)

    async def start(self):
        with self.store.transaction() as db:
            # A killed Core cannot execute select_candidates' finally block. Foreground
            # selection is terminated, never replayed or refunded during recovery.
            db.execute("UPDATE selection_requests SET state='Failed',error='RuntimeInterrupted' WHERE state='Running'")
            db.execute("UPDATE embedding_jobs SET state='Pending',error='RuntimeInterrupted' WHERE state='Running'")
            for row in db.execute("SELECT command_id FROM command_results WHERE json_extract(request,'$.type')='SearchMemories' AND json_extract(response,'$.status')='processing'").fetchall():
                failed = {"command_id": row[0], "status": "failed", "data": {"error": "RuntimeInterrupted"}}
                db.execute("UPDATE command_results SET response=? WHERE command_id=?", (json.dumps(failed), row[0]))
        self.worker = asyncio.create_task(self.loop(), name="aevora-embedding-worker")

    async def pause(self):
        if self.request:
            self.request.cancel()
            await asyncio.gather(self.request, return_exceptions=True)

    async def close(self):
        self.closed = True
        await self.cancel_selection()
        await self.pause()
        if self.worker:
            await self.worker
