"""User-reviewed facts from work originating in this conversation, never file prose."""
import json

from .errors import DomainError
from .memory_governance import erase_cached
from .task_results import result


def projection(store, db, aid, cid):
    store.conversation.target(db, aid, cid)
    rows = db.execute('SELECT DISTINCT t.task_id,t.title FROM work_responses w JOIN runs r USING(run_id) '
                      'JOIN tasks t ON t.task_id=w.task_id WHERE r.conversation_id=? AND w.agent_id=? AND t.agent_id=? '
                      'ORDER BY t.updated_at DESC,t.task_id', (cid, aid, aid)).fetchall()
    refs = {'conversation_id': cid, 'tasks': [], 'feedback': []}
    data = {'tasks': [], 'user_feedback': [], 'omitted_tasks': max(0, len(rows)-8)}
    for row in rows[:8]:
        task = result(db, aid, row['task_id'])
        refs['tasks'].append({'task_id': task['task_id'], 'revision': task['revision']})
        data['tasks'].append({k: task[k] for k in ('task_id', 'state', 'permission')} | {'title': row['title'],
            'outputs': [{k: o[k] for k in ('label', 'outcome', 'bytes_written', 'body_review')} for o in task['outputs']]})
        feedback = store.work.feedback(db, aid, task['run_id'])
        if feedback and not feedback['deleted']:
            refs['feedback'].append({'run_id': feedback['run_id'], 'revision': feedback['revision']})
            data['user_feedback'].append({k: feedback[k] for k in ('task_id', 'note', 'quality')})
    return {'references': refs, 'data': data}


def approved(store, db, aid, cid, approval):
    if approval.get('allow_outbound') is not True or approval.get('conversation_id') != cid:
        raise DomainError('Forbidden', 'Review work from this conversation before sending it')
    value = projection(store, db, aid, cid)
    if {k: v for k, v in approval.items() if k != 'allow_outbound'} != value['references']:
        raise DomainError('RevisionConflict', 'Work or feedback changed; review current facts')
    return value


def erase_feedback(store, db, aid, rid):
    affected, messages = set(), set()
    rows = db.execute('SELECT run_id,context FROM runs WHERE agent_id=?', (aid,)).fetchall()
    contexts = {r['run_id']: json.loads(r['context']) for r in rows}
    for key, refs in contexts.items():
        if any(f['run_id'] == rid for f in refs.get('work_context', {}).get('feedback', [])):
            affected.add(key)
    while True:
        messages = {r[0] for key in affected for r in db.execute(
            "SELECT message_id FROM messages WHERE run_id=? AND role='assistant'", (key,))}
        more = {key for key, refs in contexts.items() if messages & set(refs.get('message_ids', []))}
        if more <= affected:
            break
        affected |= more
    for key in affected:
        refs = contexts[key] | {'context_stale': True, 'context_erased': True}
        db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), key))
        db.execute("UPDATE messages SET content='',finality='partial' WHERE run_id=? AND role='assistant'", (key,))
    store.work.invalidate(db, aid, affected, True)
    erase_cached(db, affected)
