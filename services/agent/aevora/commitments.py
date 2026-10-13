"""User-confirmed future intent and its conversation origin; no copied source prose."""
from uuid import uuid4

from .errors import DomainError

MIGRATION = (
    """CREATE TABLE commitments(commitment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        schedule_id TEXT NOT NULL UNIQUE REFERENCES schedules(schedule_id),
        source_conversation_id TEXT NOT NULL, source_message_id TEXT NOT NULL, confirmed_at TEXT NOT NULL,
        FOREIGN KEY(source_message_id,source_conversation_id,agent_id) REFERENCES messages(message_id,conversation_id,agent_id))""",
    "CREATE INDEX commitments_conversation ON commitments(agent_id,source_conversation_id)",
)


class CommitmentRepository:
    def __init__(self, store):
        self.store = store

    def message(self, db, aid, cid, mid):
        self.store.conversation.target(db, aid, cid)
        row = db.execute("SELECT * FROM messages WHERE agent_id=? AND conversation_id=? AND message_id=?",
                         (aid, cid, mid)).fetchone()
        if not row or row['finality'] != 'final' or not row['content'].strip():
            raise DomainError('SourceUnavailable', 'Choose a persisted complete message in this Agent')
        if row['role'] == 'assistant':
            run = self.store.conversation.run(db, aid, row['run_id'])
            if run['state'] != 'Completed' or run['context'].get('context_stale'):
                raise DomainError('SourceUnavailable', 'Incomplete or invalidated replies cannot originate an agreement')
        return dict(row)

    def confirm(self, db, c, sid, stamp):
        p, aid = c['payload'], c['agent_id']
        if p.get('confirmed_independent') is not True:
            raise DomainError('Forbidden', 'Explicitly confirm an independent goal and time; a message grants no authority')
        self.message(db, aid, p['source_conversation_id'], p['source_message_id'])
        kid = str(uuid4())
        db.execute('INSERT INTO commitments VALUES (?,?,?,?,?,?)',
                   (kid, aid, sid, p['source_conversation_id'], p['source_message_id'], stamp))
        self.store.memory.event(db, 'CommitmentConfirmed', aid,
                               {'commitment_id': kid, 'schedule_id': sid, 'source_message_id': p['source_message_id']}, c['command_id'], 'user')

    def for_schedule(self, db, aid, sid):
        row = db.execute('SELECT * FROM commitments WHERE schedule_id=? AND agent_id=?', (sid, aid)).fetchone()
        if not row:
            return None
        result = dict(row)
        # No source excerpt in the agreement, event, command cache or scheduler view.
        try:
            self.message(db, aid, row['source_conversation_id'], row['source_message_id'])
            result['source_available'] = True
        except DomainError:
            result['source_available'] = False
        return result

    def source_view(self, db, aid, kid):
        self.store.identity.agent(db, aid)
        row = db.execute('SELECT * FROM commitments WHERE commitment_id=? AND agent_id=?', (kid, aid)).fetchone()
        if not row:
            raise DomainError('NotFound', 'Agreement origin unavailable in this Agent')
        try:
            message = self.message(db, aid, row['source_conversation_id'], row['source_message_id'])
        except DomainError:
            message = None
        return {'commitment_id': kid, 'available': message is not None, 'message': message,
                'conversation_id': row['source_conversation_id']}
