"""Small local status projection, shared with desktop and native speech labels."""
import json
from pathlib import Path

STATES = json.loads((Path(__file__).resolve().parents[3] / 'packages/protocol/work-states.json').read_text(encoding='utf-8'))


def status(kind, state):
    return STATES[kind].get(state, {'label':state, 'category':'finished'})


def activity(db, aid):
    if not aid:
        return {'primary':None,'items':[]}
    items = []
    for row in db.execute("SELECT t.*,l.execution_id,l.node_id,g.goal_id FROM tasks t LEFT JOIN execution_tasks l USING(task_id) LEFT JOIN goal_tasks g USING(task_id) WHERE t.agent_id=? AND (t.state NOT IN ('Completed','Failed','Cancelled','Rejected','Revoked','NotExecuted','Blocked','Partial') OR (l.execution_id IS NULL AND t.state IN ('Failed','Blocked','Partial') AND t.task_id=(SELECT task_id FROM tasks WHERE agent_id=? ORDER BY updated_at DESC LIMIT 1))) ORDER BY t.updated_at DESC LIMIT 32", (aid,aid)):
        info = status('task',row['state'])
        if row['state'] in ('Failed','Blocked','Partial'):
            info = info | {'category':'attention'}
        if info['category'] == 'finished' or not row['permission'] and row['state'] != 'NeedsAttention':
            continue
        context = db.execute('SELECT context FROM task_runs WHERE run_id=?',(row['current_run_id'],)).fetchone()
        cid = json.loads(context['context']).get('source_conversation_id') if context else None
        if cid and not db.execute("SELECT 1 FROM conversations WHERE agent_id=? AND conversation_id=? AND status<>'Deleted'", (aid,cid)).fetchone():
            cid = None
        items.append({'kind':'task','id':row['task_id'],'title':row['title'],'state':row['state'],**info,
                      'goal_id':row['goal_id'],'conversation_id':cid})
    for row in db.execute("SELECT e.*,g.source_conversation_id,(SELECT title FROM goal_revisions r WHERE r.goal_id=e.goal_id ORDER BY revision DESC LIMIT 1) AS title FROM goal_executions e JOIN goals g USING(goal_id) WHERE e.agent_id=? AND e.state<>'Revoked' AND g.state IN ('Active','Paused') ORDER BY e.updated_at DESC LIMIT 8", (aid,)):
        if row['state'] == 'Completed' and items:
            continue
        cid = json.loads(row['scope']).get('conversation_id') or row['source_conversation_id']
        if cid and not db.execute("SELECT 1 FROM conversations WHERE agent_id=? AND conversation_id=? AND status<>'Deleted'", (aid,cid)).fetchone():
            cid = None
        items.append({'kind':'execution','id':row['execution_id'],'title':row['title'],'state':row['state'],
                      **status('execution',row['state']),'goal_id':row['goal_id'],
                      'conversation_id':cid})
    rank = {'attention':0,'working':1,'waiting':2,'paused':3,'finished':4}
    items.sort(key=lambda i:rank[i['category']])
    return {'primary':items[0] if items else None,'items':items[:8],'omitted':max(0,len(items)-8)}
