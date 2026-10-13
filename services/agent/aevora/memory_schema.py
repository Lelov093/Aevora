"""Memory authority and durable extraction jobs, first introduced in schema v5."""
MIGRATION = (
    """CREATE TABLE memory_settings(agent_id TEXT PRIMARY KEY REFERENCES agents,
        mode TEXT NOT NULL CHECK(mode IN ('Manual','Balanced')), revision INTEGER NOT NULL)""",
    "INSERT INTO memory_settings SELECT agent_id,'Balanced',0 FROM agents",
    """CREATE TABLE memory_jobs(job_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
        run_id TEXT UNIQUE NOT NULL,source_range TEXT NOT NULL,extractor_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,dedup_key TEXT UNIQUE NOT NULL,state TEXT NOT NULL
        CHECK(state IN ('Pending','Running','Completed','Failed','Cancelled')),attempt INTEGER NOT NULL DEFAULT 0,
        group_attempt INTEGER NOT NULL DEFAULT 0,next_retry_at TEXT,error TEXT,created_at TEXT NOT NULL,
        completed_at TEXT,provider_metadata TEXT NOT NULL DEFAULT '{}',provider_revision INTEGER,
        grant_id TEXT,UNIQUE(job_id,agent_id),
        FOREIGN KEY(run_id,conversation_id,agent_id) REFERENCES runs(run_id,conversation_id,agent_id))""",
    """CREATE TABLE memories(memory_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents,type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Candidate','Active','Rejected','Superseded','Forgotten','Archived')),
        current_revision_id TEXT NOT NULL,revision INTEGER NOT NULL,subject_key TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(memory_id,agent_id),
        FOREIGN KEY(current_revision_id,memory_id,agent_id)
        REFERENCES memory_revisions(revision_id,memory_id,agent_id) DEFERRABLE INITIALLY DEFERRED)""",
    """CREATE TABLE memory_revisions(revision_id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,agent_id TEXT NOT NULL,
        revision_number INTEGER NOT NULL,content TEXT NOT NULL,importance REAL NOT NULL,confidence REAL NOT NULL,
        sensitivity TEXT NOT NULL,evidence_kind TEXT NOT NULL,edited_by TEXT NOT NULL,change_reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,valid_from TEXT,valid_until TEXT,scope TEXT,supersedes_revision_id TEXT,
        policy_reason TEXT NOT NULL,job_id TEXT,UNIQUE(revision_id,memory_id,agent_id),
        UNIQUE(memory_id,revision_number),
        FOREIGN KEY(memory_id,agent_id) REFERENCES memories(memory_id,agent_id) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY(job_id,agent_id) REFERENCES memory_jobs(job_id,agent_id))""",
    """CREATE TABLE memory_sources(revision_id TEXT NOT NULL,memory_id TEXT NOT NULL,agent_id TEXT NOT NULL,
        source_type TEXT NOT NULL,source_id TEXT NOT NULL,source_role TEXT NOT NULL,span TEXT,
        relation TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(revision_id,source_id),
        FOREIGN KEY(revision_id,memory_id,agent_id) REFERENCES memory_revisions(revision_id,memory_id,agent_id))""",
    """CREATE TABLE extraction_grants(grant_id TEXT PRIMARY KEY,calls_started INTEGER NOT NULL DEFAULT 0)""",
)

CANDIDATE = {
    "type": "object", "additionalProperties": False,
    "required": ["type", "content", "confidence", "importance", "sensitivity", "evidence_kind", "sources", "reason"],
    "properties": {
        "type": {"enum": ["Semantic", "Episodic", "Prospective"]},
        "content": {"type": "string", "minLength": 1, "maxLength": 1000},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "importance": {"type": "number", "minimum": 0, "maximum": 1},
        "sensitivity": {"enum": ["low", "sensitive", "unknown", "prohibited"]},
        "evidence_kind": {"enum": ["user_statement", "agent_inference"]},
        "sources": {"type": "array", "minItems": 1, "maxItems": 4, "items": {
            "type": "object", "additionalProperties": False, "required": ["message_id", "quote"],
            "properties": {"message_id": {"type": "string", "minLength": 1, "maxLength": 64},
                           "quote": {"type": "string", "minLength": 1, "maxLength": 2000}}}},
        "reason": {"type": "string", "maxLength": 500},
        "valid_from": {"type": ["string", "null"], "format": "date-time"},
        "valid_until": {"type": ["string", "null"], "format": "date-time"},
        "scope": {"type": ["string", "null"], "maxLength": 200},
    },
}
RESULT_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["candidates"],
                 "properties": {"candidates": {"type": "array", "maxItems": 5, "items": CANDIDATE}}}
import copy
RESULT_SCHEMA_V1 = copy.deepcopy(RESULT_SCHEMA)
CANDIDATE["required"].append("source_message_ids")
CANDIDATE["properties"]["source_message_ids"] = {"type": "array", "minItems": 1, "maxItems": 4,
    "uniqueItems": True, "items": {"type": "string", "minLength": 1, "maxLength": 64}}


_COMMON = {key: copy.deepcopy(CANDIDATE["properties"][key])
           for key in ("type", "confidence", "importance", "sensitivity", "reason")}
_DIRECT = {"type": "object", "required": ["evidence_kind", "source_unit_id"],
           "properties": {"evidence_kind": {"const": "user_statement"},
               "source_unit_id": {"type": "string", "minLength": 1, "maxLength": 80},
               **{key: copy.deepcopy(CANDIDATE["properties"][key]) for key in ("valid_from", "valid_until", "scope")}}}
_INFERENCE = {"type": "object", "required": ["evidence_kind", "content", "sources", "source_message_ids"],
              "properties": {"evidence_kind": {"const": "agent_inference"},
                  **{key: copy.deepcopy(CANDIDATE["properties"][key]) for key in ("content", "sources", "source_message_ids")}}}
RESULT_SCHEMA_V3 = {"type": "object", "additionalProperties": False, "required": ["candidates"],
                    "$defs": {"common": {"type": "object", "required": list(_COMMON), "properties": _COMMON}},
                    "properties": {"candidates": {"type": "array", "maxItems": 5,
                        "items": {"oneOf": [{"allOf": [{"$ref": "#/$defs/common"}, branch],
                                              "unevaluatedProperties": False} for branch in (_DIRECT, _INFERENCE)]}}}}


def schema_for(version):
    schemas = {"extractor-v1": RESULT_SCHEMA_V1, "extractor-v2": RESULT_SCHEMA, "extractor-v3": RESULT_SCHEMA_V3}
    if version not in schemas:
        from .errors import DomainError
        raise DomainError("InvalidExtraction", "Unknown extraction protocol version")
    return schemas[version]
