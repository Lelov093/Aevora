"""Read-only task progress and historical write receipts, without report/source prose."""
import json


def body_review(action):
    if not action:
        return None
    return {'editor': action['editor'], 'state': action['state'],
            'save_approved': action['state'] in ('Executing', 'Completed', 'NeedsAttention', 'NotExecuted')}


def result(db, aid, tid):
    task = db.execute('SELECT * FROM tasks WHERE agent_id=? AND task_id=?', (aid, tid)).fetchone()
    if not task:
        return None
    run = db.execute('SELECT error,reply FROM task_runs WHERE task_id=? AND run_id=?',
                     (tid, task['current_run_id'])).fetchone()
    outputs = json.loads(task['outputs']) if task['kind'] in ('plan', 'network', 'agent') else [
        {'label': '报告', 'path': task['output_path']}]
    outputs = [o | {'output_id': f'output{i}'} for i, o in enumerate(outputs, 1)]
    if task['kind'] == 'agent':
        outputs += [d | {'output_id': f'document{i}'} for i, d in enumerate(json.loads(task['agent_limits']).get('documents', []), 1) if d['mode'] != 'read']
    actions = {}
    if task['kind'] in ('plan', 'network', 'agent'):
        # Current-run steps include successful checkpoints inherited on explicit retry.
        for step in db.execute('SELECT s.definition,a.action_id,a.receipt,a.editor,a.state FROM task_steps s '
                               'LEFT JOIN step_actions a ON a.action_id=s.action_id WHERE s.run_id=? ORDER BY s.position',
                               (task['current_run_id'],)):
            definition = json.loads(step['definition'])
            if definition.get('op') == 'write' and step['action_id']:
                actions[definition['output']] = step
            elif definition.get('op') in ('office_propose','text_propose') and step['action_id']:
                actions[definition['resource']] = step
    else:
        action = db.execute("SELECT a.action_id,a.receipt,a.state,CASE WHEN EXISTS (SELECT 1 FROM events e "
                            "WHERE e.agent_id=? AND e.type='TaskBodyEdited' AND json_extract(e.payload,'$.action_id')=a.action_id) "
                            "THEN 'user' ELSE 'model' END AS editor FROM task_actions a WHERE a.run_id=?",
                            (aid, task['current_run_id'])).fetchone()
        if action:
            actions['output1'] = action
    products = []
    for index, output in enumerate(outputs, 1):
        ref = output['output_id']
        action = actions.get(ref)
        receipt = json.loads(action['receipt']) if action and action['receipt'] else {}
        # These fields describe accepted native receipts, never current file availability.
        products.append(output | {'output_id': ref, 'action_id': action['action_id'] if action else None,
            'outcome': receipt.get('outcome'), 'bytes_written': receipt.get('bytes_written'),
            'body_review': body_review(action)})
    if task['kind'] == 'agent':
        for step in db.execute('SELECT s.definition,a.action_id,a.receipt,a.editor,a.state FROM task_steps s JOIN step_actions a ON a.action_id=s.action_id WHERE s.run_id=?', (task['current_run_id'],)):
            receipt = json.loads(step['receipt']) if step['receipt'] else {}
            for i, product in enumerate(receipt.get('products', [])):
                products.append(product | {'output_id': f"tool:{step['action_id']}:{i}", 'label': product['path'], 'action_id': step['action_id'], 'outcome': receipt.get('outcome'), 'bytes_written': product.get('bytes'), 'body_review': body_review(step)})
    return {'task_id': tid, 'state': task['state'], 'revision': task['revision'],
            'permission': task['permission'], 'run_id': task['current_run_id'],
            'error': run['error'] if run else None, 'outputs': products,
            'reply': run['reply'] if run and task['kind']=='agent' else None}


def current_work(db, aid, tid, goal_context=None):
    """Own task facts, plus separately confirmed bounded Goal data when provided."""
    value = result(db, aid, tid)
    task = db.execute('SELECT title,method_ref FROM tasks WHERE task_id=? AND agent_id=?', (tid, aid)).fetchone()
    data = {k: value[k] for k in ('task_id', 'run_id', 'state')} | {
        'title': task['title'], 'method_ref': json.loads(task['method_ref']) if task['method_ref'] else None,
        'outputs': [{k: o[k] for k in ('label', 'outcome', 'bytes_written', 'body_review')} for o in value['outputs']]}
    if goal_context is not None:
        data['confirmed_goal'] = goal_context
    return data
