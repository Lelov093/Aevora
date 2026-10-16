"""User-reviewed facts from work originating in this conversation, never file prose."""
import json

from .errors import DomainError
from .memory_governance import erase_cached
from .task_results import result


def work_groups(data):
    """Group selected reports by actual ownership, with dependency order inside executions."""
    groups = []
    independent = [t for t in data['tasks'] if not t['execution']]
    if independent:
        independent.sort(key=lambda t: (t['run_created_at'] or '', t['task_id']))
        groups.append({'kind': 'independent', 'task_ids': [t['task_id'] for t in independent]})
    executions = {e['execution_id']: e for e in data.get('executions', [])}
    for task in data['tasks']:
        if task['execution']:
            eid = task['execution']['execution_id']
            executions.setdefault(eid, {'execution_id': eid, 'nodes': []})
    for eid, execution in executions.items():
        nodes = {n['id']: n for n in execution['nodes']}
        ordered = []
        seen = set()

        def visit(key):
            if key in seen or key not in nodes:
                return
            seen.add(key)
            for dep in nodes[key]['depends_on']:
                visit(dep)
            ordered.append(nodes[key])

        for key in nodes:
            visit(key)
        positions = {n['id']: i for i, n in enumerate(ordered)}
        tasks = [t for t in data['tasks'] if t['execution'] and t['execution']['execution_id'] == eid]
        tasks.sort(key=lambda t: (positions.get(t['execution']['node_id'], len(positions)), t['run_created_at'] or '', t['task_id']))
        groups.append(execution | {'kind': 'execution', 'nodes': ordered, 'task_ids': [t['task_id'] for t in tasks]})
    return groups


def model_data(data):
    """Same reviewed groups, without duplicate prose or rejected draft text."""
    tasks = {t['task_id']: t for t in data['tasks']}
    groups = []
    for group in data['groups']:
        reports = []
        for tid in group['task_ids']:
            report = dict(tasks[tid])
            if report['report_use'] == 'historical_issue':
                report.pop('reply_excerpt', None)
                report.pop('reply_truncated', None)
            reports.append(report)
        groups.append({k: v for k, v in group.items() if k != 'task_ids'} | {'reports': reports})
    return {'grouping_version': data['grouping_version'], 'groups': groups,
            'omitted_tasks': data['omitted_tasks'], 'omitted_executions': data.get('omitted_executions', 0)}


def projection(store, db, aid, cid):
    from .work_status import status
    store.conversation.target(db, aid, cid)
    rows = db.execute('SELECT t.task_id,t.title,t.updated_at,r.created_at AS run_created_at,r.completed_at AS run_completed_at, '
        'l.execution_id,l.node_id FROM tasks t '
        'LEFT JOIN task_runs r ON r.run_id=t.current_run_id AND r.task_id=t.task_id '
        'LEFT JOIN execution_tasks l ON l.task_id=t.task_id WHERE t.agent_id=? AND ('
        'EXISTS (SELECT 1 FROM work_responses w JOIN runs r USING(run_id) WHERE w.task_id=t.task_id AND w.agent_id=? AND r.conversation_id=?) '
        'OR (t.kind=\'agent\' AND EXISTS (SELECT 1 FROM task_runs ar WHERE ar.task_id=t.task_id AND '
        'json_extract(ar.context,\'$.source_conversation_id\')=?)) '
        'OR EXISTS (SELECT 1 FROM execution_tasks l JOIN goal_executions e USING(execution_id) JOIN goals g USING(goal_id) '
        'WHERE l.task_id=t.task_id AND g.state<>\'Deleted\' AND (g.source_conversation_id=? OR json_extract(e.scope,\'$.conversation_id\')=?))) '
        'ORDER BY t.updated_at DESC,t.task_id', (aid, aid, cid, cid, cid, cid)).fetchall()
    refs = {'conversation_id': cid, 'tasks': [], 'feedback': []}
    data = {'tasks': [], 'user_feedback': [], 'omitted_tasks': max(0, len(rows)-8)}
    for row in rows[:8]:
        task = result(db, aid, row['task_id'])
        refs['tasks'].append({'task_id': task['task_id'], 'revision': task['revision'], 'run_id':task['run_id']})
        data['tasks'].append({k: task[k] for k in ('task_id', 'run_id', 'state', 'permission')} |
            {k: row[k] for k in ('title', 'updated_at', 'run_created_at', 'run_completed_at')} | {
            'execution': {'execution_id': row['execution_id'], 'node_id': row['node_id']} if row['execution_id'] else None,
            'outputs': [{k: o[k] for k in ('label', 'outcome', 'bytes_written', 'body_review')} for o in task['outputs']]})
        if task.get('reply'):
            data['tasks'][-1]['reply_excerpt']=task['reply'][:2000]
            data['tasks'][-1]['reply_truncated']=len(task['reply'])>2000
        feedback = store.work.feedback(db, aid, task['run_id'])
        data['tasks'][-1]['feedback'] = None
        data['tasks'][-1]['report_use'] = 'reported_observation'
        if feedback and not feedback['deleted']:
            refs['feedback'].append({'run_id': feedback['run_id'], 'revision': feedback['revision']})
            data['user_feedback'].append({k: feedback[k] for k in ('task_id', 'run_id', 'note', 'quality')})
            data['tasks'][-1]['feedback'] = data['user_feedback'][-1]
            if feedback['quality'] == 'NeedsRevision':
                data['tasks'][-1]['report_use'] = 'historical_issue'
    executions = db.execute("SELECT e.* FROM goal_executions e JOIN goals g USING(goal_id) WHERE e.agent_id=? AND g.state<>'Deleted' AND (g.source_conversation_id=? OR json_extract(e.scope,'$.conversation_id')=?) ORDER BY e.updated_at DESC", (aid,cid,cid)).fetchall()
    if executions:
        refs['executions'] = [{'execution_id': e['execution_id'], 'revision':e['revision']} for e in executions[:8]]
        data['executions'] = [{'execution_id':e['execution_id'],'goal_id':e['goal_id'],'state':e['state'],
                               'reason':status('execution',e['state'])['label'],'next_check':e['next_check'],
                               'nodes':[{k:n[k] for k in ('id', 'title', 'state', 'task_id', 'depends_on')}
                                        for n in json.loads(e['nodes']) if not n.get('retired')]} for e in executions[:8]]
        data['omitted_executions'] = max(0,len(executions)-8)
    data['grouping_version'] = 'conversation-work-sequence-v1'
    data['groups'] = work_groups(data)
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
