"""Agent identity and immutable Persona revisions within repository transactions."""
from datetime import datetime, timezone
from uuid import uuid4

from .errors import DomainError


def now():
    return datetime.now(timezone.utc).isoformat()


class IdentityRepository:
    def __init__(self, owner_id):
        self.owner_id = owner_id

    def list(self, db):
        return [dict(row) for row in db.execute(
            """SELECT agent_id,name,lifecycle_state,current_persona_revision,created_at,
               (SELECT MAX(timestamp) FROM events WHERE events.agent_id=agents.agent_id) AS last_active_at
               FROM agents WHERE owner_user_id=? ORDER BY created_at,agent_id""",
            (self.owner_id,))]

    def agent(self, db, agent_id):
        row = db.execute("SELECT * FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        if row is None:
            raise DomainError("NotFound", "Agent not found")
        if row["owner_user_id"] != self.owner_id:
            raise DomainError("Forbidden", "Agent is outside the local owner")
        return dict(row)

    def profile(self, db, agent_id):
        agent = self.agent(db, agent_id)
        persona = db.execute(
            "SELECT * FROM persona_revisions WHERE agent_id=? AND revision=?",
            (agent_id, agent["current_persona_revision"])).fetchone()
        return agent | {"persona": dict(persona)}

    def target(self, db, agent_id, persona_id):
        agent = self.agent(db, agent_id)
        if agent["persona_id"] != persona_id:
            raise DomainError("Forbidden", "Persona does not belong to this Agent")
        return agent

    def history(self, db, agent_id, persona_id):
        self.target(db, agent_id, persona_id)
        return [dict(r) for r in db.execute(
            "SELECT * FROM persona_revisions WHERE agent_id=? ORDER BY revision DESC", (agent_id,))]

    def create(self, db, payload):
        name = payload["name"].strip()
        description = payload["identity_description"].strip()
        if not name or not description:
            raise DomainError("ValidationError", "Name and initial Persona description are required")
        agent_id, persona_id, created = str(uuid4()), str(uuid4()), now()
        db.execute("""INSERT INTO agents(agent_id,owner_user_id,name,lifecycle_state,
            persona_id,current_persona_revision,created_at) VALUES (?,?,?,'Active',?,1,?)""",
            (agent_id, self.owner_id, name, persona_id, created))
        db.execute("""INSERT INTO persona_revisions
            (agent_id,revision,persona_id,identity_description,communication_style,created_by,created_at)
            VALUES (?,1,?,?,?,'user',?)""",
            (agent_id, persona_id, description, payload["communication_style"].strip(), created))
        return self.profile(db, agent_id)

    def edit(self, db, command):
        agent_id, payload = command["agent_id"], command["payload"]
        agent = self.target(db, agent_id, payload["persona_id"])
        if command.get("expected_revision") != agent["current_persona_revision"]:
            raise DomainError("RevisionConflict", "Persona changed; reload before saving")
        description = payload["identity_description"].strip()
        if not description:
            raise DomainError("ValidationError", "Persona description cannot be blank")
        revision = agent["current_persona_revision"] + 1
        db.execute("""INSERT INTO persona_revisions
            (agent_id,revision,persona_id,identity_description,communication_style,created_by,created_at)
            VALUES (?,?,?,?,?,'user',?)""",
            (agent_id, revision, agent["persona_id"], description, payload["communication_style"].strip(), now()))
        db.execute("UPDATE agents SET current_persona_revision=? WHERE agent_id=?", (revision, agent_id))
        return self.profile(db, agent_id)
