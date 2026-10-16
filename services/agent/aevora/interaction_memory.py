"""User-confirmed understanding from a real exchange, using canonical Memory."""
import json
from datetime import datetime, timezone
from uuid import uuid4

from .errors import DomainError
from .identity import now
from .memory_policy import classify, fact_identity

VERSION = 'interaction-memory-v1'
KINDS = {'Fact', 'Preference', 'TemporaryState', 'SharedExperience', 'RelationshipUnderstanding'}
COMMANDS = {'GetInteractionMemory', 'RememberInteraction'}


def manual_validity(payload, input_timezone):
    values = {k: payload.get(k) for k in ('valid_from', 'valid_until', 'scope')}
    for key in ('valid_from', 'valid_until'):
        if values[key]:
            try:
                instant = datetime.fromisoformat(values[key].replace('Z', '+00:00'))
                if instant.tzinfo is None:
                    raise ValueError()
                values[key] = instant.astimezone(timezone.utc).isoformat()
            except ValueError:
                raise DomainError('ValidationError', 'Validity requires an explicit timezone') from None
    if values['valid_from'] and values['valid_until'] and values['valid_from'] >= values['valid_until']:
        raise DomainError('ValidationError', 'Validity end must follow its start')
    return values | {'temporal_validation': {'version': 'manual-edit-v1', 'status': 'user_supplied',
        'source_timezone': input_timezone, 'supplied_validity': {k: values[k] for k in ('valid_from', 'valid_until')}}}


def revision_data(row):
    return {k: row[k] for k in ('memory_id', 'revision_id', 'content', 'evidence_kind',
        'recorded_at', 'valid_from', 'valid_until', 'scope')} | {
        'type': row['type'], 'interaction_context': json.loads(row['interaction_context'])}


def used_memories(store, db, aid, context):
    """Resolve exact retained revisions; never substitute the latest content."""
    result = []
    snapshots = {r['revision_id']: r for r in context.get('memory_references', [])}
    for rid in context.get('memory_revision_ids', []):
        row = db.execute('''SELECT r.*,m.type,m.status,m.current_revision_id FROM memory_revisions r
            JOIN memories m ON m.memory_id=r.memory_id WHERE r.agent_id=? AND r.revision_id=?''', (aid, rid)).fetchone()
        if row and row['status'] not in ('Forgotten', 'Rejected'):
            value = revision_data(row)
            value.update({k: v for k, v in snapshots.get(rid, {}).items() if k in ('type', 'evidence_kind', 'interaction_context')})
            value['sources'] = [dict(s) for s in db.execute('''SELECT ms.source_type,ms.source_id,ms.source_role,ms.relation,
                ms.created_at,m.created_at AS source_message_created_at,m.source_timezone
                FROM memory_sources ms LEFT JOIN messages m ON m.message_id=ms.source_id AND m.agent_id=ms.agent_id
                WHERE ms.agent_id=? AND ms.revision_id=?''', (aid, rid))]
            result.append(value | {'current': row['status'] == 'Active' and row['current_revision_id'] == rid})
    return result


def view(store, db, aid, rid):
    experience = store.interaction_learning.experience(db, aid, rid)
    run = store.conversation.run(db, aid, rid)
    source_ids = [r[0] for r in db.execute('SELECT message_id FROM messages WHERE agent_id=? AND (message_id=? OR run_id=?)',
                                         (aid, run['input_message_id'], rid))]
    mids = {m['memory_id'] for m in experience['memory_context']}
    for sid in source_ids:
        mids.update(r[0] for r in db.execute('SELECT memory_id FROM memory_sources WHERE agent_id=? AND source_id=?', (aid, sid)))
    memories = [store.memory.detail(db, aid, mid) for mid in sorted(mids)]
    return experience | {'memories': [m for m in memories if m['status'] == 'Active']}


def remember(store, db, command):
    aid, p = command['agent_id'], command['payload']
    view(store, db, aid, p['run_id'])  # A retained, completed same-Agent exchange is required.
    run = store.conversation.run(db, aid, p['run_id'])
    kind, content = p['kind'], p['content'].strip()
    if kind not in KINDS or not content or len(content) > 1000 or not p.get('confirm_local'):
        raise DomainError('ValidationError', 'Confirm the bounded understanding to remember locally')
    memory_type = 'Episodic' if kind == 'SharedExperience' else 'Semantic'
    item = {'type': memory_type, 'content': content, 'evidence_kind': 'user_edit',
        'importance': .6, 'confidence': 1., 'sensitivity': 'unknown',
        **manual_validity(p, store.input_timezone)}
    risk = classify(item, [{'role': 'user', 'content': content}])
    if risk['status'] == 'Rejected':
        raise DomainError('Forbidden', 'Credentials cannot be remembered')
    item['sensitivity'] = risk['sensitivity']
    item['interaction_context'] = {'version': VERSION, 'kind': kind, 'source_run_id': p['run_id']}
    if kind == 'TemporaryState' and not item['valid_until']:
        item['interaction_context']['conversation_id'] = run['conversation_id']
    key = (fact_identity(content) or (None,))[0] if kind in ('Fact', 'Preference') else None
    mid = p.get('replace_memory_id')
    if key:
        from .memory import topic_key
        for peer in db.execute('''SELECT m.memory_id,m.subject_key,r.content FROM memories m
                JOIN memory_revisions r ON r.revision_id=m.current_revision_id WHERE m.agent_id=? AND m.status='Active' ''', (aid,)):
            if peer['memory_id'] != mid and topic_key(peer['subject_key'], peer['content']) == key:
                raise DomainError('RevisionConflict', 'Correct the existing memory of this preference instead of adding a conflict')
    if mid:
        detail = store.memory.detail(db, aid, mid)
        if detail['status'] != 'Active' or detail['revision'] != p.get('replace_expected_revision'):
            raise DomainError('RevisionConflict', 'Reload the current memory before correcting it')
        revisions = [r['revision_id'] for r in detail['history']]
        store.governance.revoke_sources(db, aid, mid, 'UserApprovedCorrection')
        store.governance.invalidate(db, aid, revisions)
        db.execute('DELETE FROM memory_embeddings WHERE revision_id IN (SELECT revision_id FROM memory_revisions WHERE memory_id=?)', (mid,))
        db.execute("UPDATE embedding_jobs SET state='Cancelled',error='RevisionRevoked' WHERE memory_id=? AND state IN ('Pending','Running','Failed')", (mid,))
        number, previous = detail['current']['revision_number'] + 1, detail['current_revision_id']
    else:
        mid, number, previous = str(uuid4()), 1, None
    rid = str(uuid4())
    if not previous:
        db.execute("INSERT INTO memories VALUES (?,?,?,'Active',?,1,?,?,?)", (mid, aid, memory_type, rid, key, now(), now()))
    store.memory.insert_revision(db, rid, mid, aid, number, item, 'UserConfirmedInteraction', None, previous, 'user')
    db.execute('INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)',
               (rid, mid, aid, 'user_edit', command['command_id'], 'user', None, 'supports', now()))
    # The exchange proves it happened; the new interpretation is supported by the user's edit.
    for ref in run['context'].get('work_context', {}).get('tasks', []):
        source = db.execute('SELECT r.run_id FROM task_runs r JOIN tasks t USING(task_id) WHERE t.agent_id=? AND t.task_id=? AND r.run_id=?',
                            (aid,ref['task_id'],ref.get('run_id'))).fetchone()
        if source:
            db.execute('INSERT OR IGNORE INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)',
                       (rid,mid,aid,'task_run',source['run_id'],'assistant',None,'related_to',now()))
    for message in db.execute("SELECT message_id,role FROM messages WHERE agent_id=? AND (message_id=? OR (run_id=? AND role='assistant' AND finality='final'))",
                              (aid, run['input_message_id'], p['run_id'])):
        db.execute('INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?)',
                   (rid, mid, aid, 'message', message['message_id'], message['role'], None, 'related_to', now()))
    if previous:
        db.execute('UPDATE memories SET type=?,current_revision_id=?,revision=revision+1,subject_key=?,updated_at=? WHERE memory_id=?',
                   (memory_type, rid, key, now(), mid))
    store.memory.event(db, 'MemoryEdited' if previous else 'MemoryCommitted', aid,
        {'memory_id': mid, 'revision_id': rid, 'reason': 'UserConfirmedInteraction'}, command['command_id'], 'user')
    return store.memory.detail(db, aid, mid)
