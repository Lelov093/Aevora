"""Explicit interaction feedback; facts, preferences and transient states are not skills."""
import json

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached

MIGRATION = (
    "ALTER TABLE method_proposals ADD COLUMN family TEXT NOT NULL DEFAULT 'preparation_update'",
    "ALTER TABLE method_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'task'",
    """CREATE TABLE interaction_feedback(run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
        agent_id TEXT NOT NULL REFERENCES agents(agent_id),revision INTEGER NOT NULL,
        category TEXT NOT NULL,note TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)""",
    """CREATE TABLE interaction_comparisons(comparison_id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES method_proposals,
        agent_id TEXT NOT NULL REFERENCES agents(agent_id),proposal_revision INTEGER NOT NULL,state TEXT NOT NULL,
        cases TEXT NOT NULL,context TEXT NOT NULL,results TEXT NOT NULL DEFAULT '[]',error TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""",
)
READS = {'GetInteractionExperience', 'ListInteractionComparisons'}
COMMANDS = READS | {'SaveInteractionFeedback', 'DeleteInteractionFeedback'}


def corrected_work_history(db, aid, cid):
    """Work-review replies depending on an explicitly corrected reply; no text erasure."""
    rows = db.execute("SELECT r.run_id,r.context,m.message_id,f.category,f.deleted FROM runs r "
        "LEFT JOIN messages m ON m.run_id=r.run_id AND m.role='assistant' "
        "LEFT JOIN interaction_feedback f ON f.run_id=r.run_id AND f.agent_id=r.agent_id "
        "WHERE r.agent_id=? AND r.conversation_id=? AND json_extract(r.context,'$.work_context') IS NOT NULL",
        (aid, cid)).fetchall()
    contexts = {r['run_id']: json.loads(r['context']) for r in rows}
    affected = {r['run_id'] for r in rows if r['category'] == 'FactCorrection' and not r['deleted']}
    while affected:
        messages = {r['message_id'] for r in rows if r['run_id'] in affected and r['message_id']}
        more = {rid for rid, refs in contexts.items() if messages.intersection(refs.get('message_ids', []))}
        if more <= affected:
            break
        affected |= more
    return {rid: contexts[rid] for rid in affected}


class InteractionLearning:
    def __init__(self, store):
        self.store = store

    def feedback(self, db, aid, rid):
        row = db.execute('SELECT * FROM interaction_feedback WHERE agent_id=? AND run_id=?', (aid, rid)).fetchone()
        return dict(row) if row else None

    def experience(self, db, aid, rid):
        run = self.store.conversation.run(db, aid, rid)
        self.store.conversation.target(db, aid, run['conversation_id'])
        if run['state'] != 'Completed' or run['context'].get('conversation_deleted') or run['context'].get('context_erased'):
            raise DomainError('Forbidden', 'Use an available completed interaction, not a partial or erased reply')
        messages = db.execute('SELECT role,content FROM messages WHERE agent_id=? AND (message_id=? OR (run_id=? AND role=\'assistant\' AND finality=\'final\'))',
                              (aid, run['input_message_id'], rid)).fetchall()
        pair = {r['role']: r['content'] for r in messages}
        if not pair.get('user') or not pair.get('assistant'):
            raise DomainError('NotFound', 'Source interaction is unavailable')
        from .interaction_memory import used_memories
        return {'run_id': rid, 'conversation_id': run['conversation_id'], 'input': pair['user'],
                'reply': pair['assistant'], 'feedback': self.feedback(db, aid, rid),
                'memory_context': used_memories(self.store, db, aid, run['context']),
                'learning_source_current': not run['context'].get('context_stale', False),
                'applied_methods': run['context'].get('interaction_methods', [])}

    def comparisons(self, db, aid, pid):
        self.store.evolution.target(db, aid, pid)
        values = []
        for row in db.execute('SELECT * FROM interaction_comparisons WHERE agent_id=? AND proposal_id=? ORDER BY rowid DESC', (aid, pid)):
            value = dict(row)
            for key in ('cases', 'context', 'results'):
                value[key] = json.loads(value[key])
            from .interaction_memory import used_memories
            value['memory_contexts'] = [case | {'memories': used_memories(self.store, db, aid, case)}
                                        for case in value['context'].get('memory_contexts', [])]
            from .interaction_evaluation import context_current
            value['context_current'] = value['state'] != 'Invalidated' and context_current(self.store, db, aid, value['context'])
            values.append(value)
        return values

    def erase_comparisons(self, db, aid, pid):
        # Preserve usage and failures, but remove deleted source/candidate text and generated content.
        for row in db.execute('SELECT comparison_id,results FROM interaction_comparisons WHERE agent_id=? AND proposal_id=?', (aid, pid)).fetchall():
            results = [{k: v for k, v in r.items() if k not in ('text', 'raw')} for r in json.loads(row['results'])]
            db.execute("UPDATE interaction_comparisons SET cases='[]',context='{}',results=?,state='Invalidated',updated_at=? WHERE comparison_id=?",
                       (json.dumps(results), now(), row['comparison_id']))

    def delete_conversation(self, db, aid, cid):
        for row in db.execute('SELECT f.run_id FROM interaction_feedback f JOIN runs r ON r.run_id=f.run_id WHERE f.agent_id=? AND r.conversation_id=?', (aid, cid)).fetchall():
            db.execute("UPDATE interaction_feedback SET note='',deleted=1,revision=revision+1 WHERE run_id=?", (row['run_id'],))
            self.store.evolution.feedback_changed(db, aid, row['run_id'])

    def execute(self, c):
        aid, p, kind = c['agent_id'], c['payload'], c['type']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind in READS:
                data = self.experience(db, aid, p['run_id']) if kind == 'GetInteractionExperience' else self.comparisons(db, aid, p['proposal_id'])
                return {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            if kind == 'SaveInteractionFeedback':
                self.experience(db, aid, p['run_id'])
            else:
                self.store.conversation.run(db, aid, p['run_id'])
            feedback = self.feedback(db, aid, p['run_id'])
            if c.get('expected_revision') != (feedback['revision'] if feedback else 0):
                raise DomainError('RevisionConflict', 'Interaction feedback changed; review the current feedback')
            revision = (feedback['revision'] if feedback else 0) + 1
            deleted = kind == 'DeleteInteractionFeedback'
            db.execute('INSERT INTO interaction_feedback VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET revision=excluded.revision,category=excluded.category,note=excluded.note,deleted=excluded.deleted,updated_at=excluded.updated_at',
                       (p['run_id'], aid, revision, feedback['category'] if deleted and feedback else p.get('category', 'Strategy'), '' if deleted else p['note'], int(deleted), now()))
            if not deleted and p['category'] == 'FactCorrection':
                cid = self.store.conversation.run(db, aid, p['run_id'])['conversation_id']
                for rid, refs in corrected_work_history(db, aid, cid).items():
                    db.execute('UPDATE runs SET context=? WHERE run_id=?',
                               (json.dumps(refs | {'context_stale': True}), rid))
            self.store.evolution.feedback_changed(db, aid, p['run_id'], p.get('delete_methods', False))
            self.store.memory.event(db, kind, aid, {'run_id': p['run_id'], 'revision': revision}, c['command_id'], 'user')
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': self.feedback(db, aid, p['run_id'])}
            # Updating/deleting feedback erases previous command acknowledgements containing that note.
            erase_cached(db, {p['run_id']})
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response
