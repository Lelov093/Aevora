"""Goal-owned durable work. Scheduler selects readiness; only Native Host grants work."""
import json
from datetime import datetime, timezone
from uuid import uuid4

from .errors import DomainError
from .identity import now
from .memory_governance import cached
from .memory_temporal import aware
from .task_results import result as task_result
from . import agent_context

MIGRATION = (
    """CREATE TABLE goal_executions(execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    goal_id TEXT NOT NULL REFERENCES goals(goal_id), revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL, goal_binding TEXT NOT NULL,
    nodes TEXT NOT NULL DEFAULT '[]', history TEXT NOT NULL DEFAULT '[]', next_check TEXT,
    replan_signature TEXT, planning_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE UNIQUE INDEX one_goal_execution ON goal_executions(goal_id) WHERE state NOT IN ('Revoked','Completed')",
    """CREATE TABLE execution_work(work_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES goal_executions(execution_id),
    kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending', data TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE execution_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), execution_id TEXT NOT NULL REFERENCES goal_executions(execution_id),
    node_id TEXT NOT NULL, dispatch_id TEXT NOT NULL UNIQUE)""",
)
COMMANDS = {'CreateGoalExecution', 'GetGoalExecution', 'EditGoalExecutionPlan', 'ApproveGoalExecution',
            'PauseGoalExecution', 'ResumeGoalExecution', 'RevokeGoalExecution', 'RenewGoalExecution'}
ACTIVE = {'Planning', 'Running', 'Waiting', 'AwaitingPlanApproval'}


def binding(goal):
    return {k: goal[k] for k in ('objective', 'success_criteria')}


def nodes(value, previous=()):
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        raise DomainError('InvalidExecutionPlan', 'Use one to eight future nodes')
    fixed = {n['id']: n for n in previous if n.get('task_id') or n['state'] == 'Done'}
    output = []
    for n in value:
        keys = {'id', 'title', 'instruction', 'depends_on', 'not_before', 'condition', 'requires_product'}
        if not isinstance(n, dict) or set(n) != keys:
            raise DomainError('InvalidExecutionPlan', 'Use the documented node fields only')
        if any(not isinstance(n[k], str) or not n[k].strip() or len(n[k]) > size
               for k, size in [('id', 60), ('title', 120), ('instruction', 4000)]):
            raise DomainError('InvalidExecutionPlan', 'Each node needs a bounded ID, title and instruction')
        if n['id'] in fixed:
            raise DomainError('InvalidExecutionPlan', 'Do not replace started or completed nodes; reference their IDs as dependencies')
        if type(n['requires_product']) is not bool or not isinstance(n['depends_on'], list) or len(n['depends_on']) > 8 or any(not isinstance(d, str) for d in n['depends_on']):
            raise DomainError('InvalidExecutionPlan', 'Invalid dependency or product condition')
        if n['not_before'] is not None:
            if not isinstance(n['not_before'], str):
                raise DomainError('InvalidExecutionPlan', 'Use an explicit timestamp or null')
            n = n | {'not_before': aware(n['not_before']).astimezone(timezone.utc).isoformat()}
        cond = n['condition']
        if cond is not None:
            if not isinstance(cond, dict) or set(cond) != {'root', 'path', 'mode'} or cond['mode'] not in ('exists', 'changed'):
                raise DomainError('InvalidExecutionPlan', 'Choose a selected file exists/changed condition')
            if not isinstance(cond['root'], str) or not isinstance(cond['path'], str) or not cond['path'] or len(cond['path']) > 500:
                raise DomainError('InvalidExecutionPlan', 'Selected file reference required')
        output.append(n | {'state': 'Pending', 'task_id': None, 'products': [], 'reason': '', 'dispatch_key': str(uuid4())})
    current = {n['id']: n for n in output}
    if len(current) != len(output):
        raise DomainError('InvalidExecutionPlan', 'Node IDs must be unique')
    all_nodes = fixed | current
    if len(output)+sum(n['state'] not in ('Done','Failed') and not n.get('retired') for n in fixed.values()) > 8:
        raise DomainError('InvalidExecutionPlan', 'At most eight unfinished nodes, including started work')
    checked = set()
    def visit(key, trail):
        if key in trail or key not in all_nodes:
            raise DomainError('InvalidExecutionPlan', 'Dependencies must be acyclic and reference this Goal')
        if key in checked:
            return
        for dep in all_nodes[key]['depends_on']:
            visit(dep, trail | {key})
        checked.add(key)
    for key in current:
        visit(key, set())
    return output


class ExecutionRepository:
    def __init__(self, store):
        self.store = store
        self.clock = lambda: datetime.now(timezone.utc)

    def target(self, db, aid, eid):
        row = db.execute('SELECT * FROM goal_executions WHERE execution_id=? AND agent_id=?', (eid, aid)).fetchone()
        if not row:
            raise DomainError('NotFound', 'Execution unavailable for this Agent')
        return dict(row)

    def view(self, db, row):
        v = dict(row)
        for k in ('nodes', 'history', 'scope', 'goal_binding'):
            v[k] = json.loads(v[k])
        goal = dict(db.execute('SELECT * FROM goals WHERE agent_id=? AND goal_id=?', (row['agent_id'],row['goal_id'])).fetchone())
        try:
            v['return_conversation_id'] = agent_context.conversation(self.store, db, row['agent_id'], v['scope'], goal) if goal['state'] != 'Deleted' else None
        except DomainError:
            v['return_conversation_id'] = None
        v['work'] = [dict(w) | {'data': json.loads(w['data']), 'result': json.loads(w['result'])}
                     for w in db.execute('SELECT * FROM execution_work WHERE execution_id=? ORDER BY rowid', (v['execution_id'],))]
        return v

    def changed(self, db, row, **values):
        values |= {'revision': row['revision'] + 1, 'updated_at': now()}
        db.execute('UPDATE goal_executions SET ' + ','.join(k + '=?' for k in values) + ' WHERE execution_id=?',
                   (*[json.dumps(v) if isinstance(v, (list, dict)) else v for v in values.values()], row['execution_id']))
        self.store.memory.event(db, 'GoalExecutionChanged', row['agent_id'],
                                {'execution_id': row['execution_id'], 'goal_id': row['goal_id']}, actor='scheduler')

    def work(self, db, eid, kind, data, key=None):
        wid = key or str(uuid4())
        db.execute("INSERT OR IGNORE INTO execution_work(work_id,execution_id,kind,data,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                   (wid, eid, kind, json.dumps(data), now(), now()))
        if kind == 'Dispatch':
            db.execute("UPDATE execution_work SET state='Pending' WHERE work_id=? AND state='Stopped'", (wid,))
        if kind == 'Plan':
            db.execute('UPDATE goal_executions SET planning_id=? WHERE execution_id=?', (wid, eid))
        return wid

    def execute(self, c):
        aid, kind, p = c['agent_id'], c['type'], c['payload']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            if kind == 'GetGoalExecution':
                row = db.execute('SELECT * FROM goal_executions WHERE goal_id=? AND agent_id=? ORDER BY rowid DESC LIMIT 1', (p['goal_id'], aid)).fetchone()
                return {'data': self.view(db, row) if row else None, 'status': 'persisted', 'command_id': c['command_id']}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            if kind == 'CreateGoalExecution':
                goal = self.store.goals.detail(db, aid, p['goal_id'])
                if goal['state'] != 'Active' or goal['revision'] != p['goal_revision']:
                    raise DomainError('RevisionConflict', 'Review the active Goal first')
                agent_context.selected_method(self.store, db, aid, p['scope'])
                agent_context.conversation(self.store, db, aid, p['scope'], goal)
                eid = c['command_id']
                if db.execute("SELECT 1 FROM goal_executions WHERE goal_id=? AND state NOT IN ('Revoked','Completed')", (p['goal_id'],)).fetchone():
                    raise DomainError('Forbidden', 'Review or revoke the existing execution; do not duplicate it')
                db.execute("INSERT INTO goal_executions(execution_id,agent_id,goal_id,state,scope,goal_binding,created_at,updated_at) VALUES (?,?,?,'Planning',?,?,?,?)",
                           (eid, aid, p['goal_id'], json.dumps(p['scope']), json.dumps(binding(goal)), now(), now()))
                self.work(db, eid, 'Plan', {'reason': 'Initial plan', 'initial': True})
                self.store.memory.event(db, 'GoalExecutionCreated', aid, {'execution_id':eid,'goal_id':p['goal_id']}, c['command_id'], 'user')
            else:
                eid = p['execution_id']
                row = self.target(db, aid, eid)
                if c.get('expected_revision') != row['revision']:
                    raise DomainError('RevisionConflict', 'Execution changed; refresh before applying')
                if row['state'] == 'Revoked':
                    raise DomainError('Forbidden', 'Revoked execution cannot resume')
                if kind == 'RenewGoalExecution':
                    if row['state'] not in ('Paused', 'NeedsAttention', 'AwaitingPlanApproval'):
                        raise DomainError('Forbidden', 'Pause and review this execution before renewing')
                    goal = self.store.goals.detail(db, aid, row['goal_id'])
                    if goal['state'] != 'Active':
                        raise DomainError('Forbidden', 'Resume the Goal before renewing its execution')
                    agent_context.selected_method(self.store, db, aid, p['scope'])
                    agent_context.conversation(self.store, db, aid, p['scope'], goal)
                    prior = json.loads(row['nodes'])
                    for n in prior:
                        if n.get('task_id'):
                            task = self.store.tasks.target(db, aid, n['task_id'])
                            if task['state'] in ('NeedsAttention', 'Executing'):
                                raise DomainError('Forbidden', 'Wait for the receipt and reconcile unknown effects before renewing')
                            if n['state'] != 'Done':
                                n['retired'] = True
                            db.execute('UPDATE tasks SET permission=0 WHERE task_id=?', (task['task_id'],))
                    self.changed(db, row, state='Planning', scope=p['scope'], goal_binding=binding(goal), nodes=prior,
                                 history=json.loads(row['history'])+[{'nodes':prior,'reason':'User renewed scope; old attempts retained','at':now()}], reason='Renewed authorization; review the new future plan', next_check=None)
                    self.work(db, eid, 'Plan', {'initial':True,'reason':'User explicitly renewed current Goal, scope and cumulative limits'})
                elif kind == 'EditGoalExecutionPlan':
                    if row['state'] not in ('AwaitingPlanApproval', 'Paused', 'NeedsAttention'):
                        raise DomainError('Forbidden', 'Pause active work before reviewing a proposed plan')
                    prior = json.loads(row['nodes'])
                    future = nodes(p['nodes'], prior)
                    fixed = [n for n in prior if n.get('task_id')]
                    self.changed(db, row, nodes=fixed + future, state='AwaitingPlanApproval', next_check=None,
                                 history=json.loads(row['history'])+[{'nodes':prior,'reason':'User edited future work','at':now()}], reason='User edited proposed future work')
                elif kind in ('ApproveGoalExecution', 'ResumeGoalExecution'):
                    goal = self.store.goals.detail(db, aid, row['goal_id'])
                    if goal['state'] != 'Active' or binding(goal) != json.loads(row['goal_binding']):
                        raise DomainError('ContextStale', 'Goal purpose changed; renewed authorization required')
                    if row['state'] not in ('Paused', 'NeedsAttention', 'AwaitingPlanApproval'):
                        raise DomainError('Forbidden', 'Review the plan and current waiting reason first')
                    try:
                        self.check_plan_refs(db, row)
                        fresh_context = True
                    except DomainError:
                        if kind == 'ApproveGoalExecution':
                            raise DomainError('ContextStale', 'Context changed; request a current plan before approval')
                        fresh_context = False
                    ns = json.loads(row['nodes'])
                    if not ns or not fresh_context:
                        self.changed(db, row, state='Planning', reason='Explicit retry of planning', next_check=None)
                        self.work(db, eid, 'Plan', {'initial': True, 'reason': 'User explicitly requested another plan'})
                    else:
                        for n in ns:
                            if not n.get('task_id') or n['state'] == 'Done' or n.get('retired'):
                                continue
                            task = self.store.tasks.target(db, aid, n['task_id'])
                            if task['state'] == 'NeedsAttention':
                                raise DomainError('Forbidden', 'Reconcile the original unknown action first')
                            if task['state'] in ('Paused', 'Failed', 'NotExecuted', 'Running', 'Created'):
                                n['resume_pending'] = True
                                n.update(state=task['state'], unknown=False, request_unknown=False)
                                self.work(db, eid, 'Resume', {'task_id': task['task_id'], 'node_id': n['id'], 'acknowledge_network_retry': True})
                        self.changed(db, row, nodes=ns, state='Running', reason='', next_check=None)
                elif kind in ('PauseGoalExecution', 'RevokeGoalExecution'):
                    self.stop(db, row, 'Revoked' if kind == 'RevokeGoalExecution' else 'Paused', 'User stopped execution')
                else:
                    raise DomainError('ValidationError', 'Unknown execution command')
            data = self.view(db, self.target(db, aid, eid))
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response

    def stop(self, db, row, state, reason):
        self.changed(db, row, state=state, reason=reason)
        for link in db.execute('SELECT task_id FROM execution_tasks WHERE execution_id=?', (row['execution_id'],)).fetchall():
            task = self.store.tasks.target(db, row['agent_id'], link['task_id'])
            if task['state'] == 'Executing':
                context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (task['current_run_id'],)).fetchone()[0])
                context['stop_requested'] = 'Paused'
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), task['current_run_id']))
            elif task['state'] in ('Created', 'Running', 'Generating', 'Searching', 'ReadingWeb', 'AwaitingApproval', 'AwaitingInput'):
                self.store.tasks.planned.state(db, task, 'Paused', reason)
        db.execute("UPDATE execution_work SET state='Stopped',updated_at=? WHERE execution_id=? AND state='Pending'", (now(), row['execution_id']))

    def goal_changed(self, db, aid, gid):
        goal_state = db.execute('SELECT state FROM goals WHERE goal_id=?', (gid,)).fetchone()[0]
        if goal_state == 'Deleted':
            for old in db.execute('SELECT * FROM goal_executions WHERE goal_id=? AND agent_id=?', (gid, aid)).fetchall():
                self.stop(db, dict(old), 'Revoked', 'Goal deleted')
                db.execute("UPDATE goal_executions SET nodes='[]',history='[]',goal_binding='{}' WHERE execution_id=?", (old['execution_id'],))
                for work in db.execute("SELECT * FROM execution_work WHERE execution_id=? AND kind='Plan'", (old['execution_id'],)).fetchall():
                    result = json.loads(work['result'])
                    result.pop('raw_output', None)
                    db.execute('UPDATE execution_work SET result=? WHERE work_id=?', (json.dumps(result), work['work_id']))
            return
        row = db.execute("SELECT * FROM goal_executions WHERE goal_id=? AND agent_id=? AND state NOT IN ('Revoked','Completed') ORDER BY rowid DESC LIMIT 1", (gid, aid)).fetchone()
        if not row or row['state'] == 'Revoked':
            return
        goal = self.store.goals.detail(db, aid, gid)
        if goal['state'] != 'Active' or binding(goal) != json.loads(row['goal_binding']):
            self.stop(db, dict(row), 'Paused', 'Goal stopped or its purpose changed; review authorization')

    def owner(self, db, tid):
        return db.execute('SELECT e.* FROM execution_tasks t JOIN goal_executions e USING(execution_id) WHERE t.task_id=?', (tid,)).fetchone()

    def attach_task(self, db, command, tid):
        ref = command['payload'].get('execution_ref')
        if not ref:
            return
        row = self.target(db, command['agent_id'], ref['execution_id'])
        self.check(db, row)
        scope = json.loads(row['scope'])
        if command['payload'].get('method_ref') != scope.get('method_ref'):
            raise DomainError('Forbidden', 'Child must use exactly the reviewed work strategy')
        w = db.execute("SELECT * FROM execution_work WHERE work_id=? AND execution_id=? AND kind='Dispatch'", (ref['dispatch_id'], row['execution_id'])).fetchone()
        if not w or w['state'] != 'Pending' or json.loads(w['data']) != {'node_id': ref['node_id'], 'task_id': tid}:
            raise DomainError('Forbidden', 'Task must match the pending Host dispatch')
        db.execute('INSERT INTO execution_tasks VALUES (?,?,?,?)', (tid, row['execution_id'], ref['node_id'], ref['dispatch_id']))
        ns = json.loads(row['nodes'])
        for n in ns:
            if n['id'] == ref['node_id']:
                n.update(task_id=tid, state='Created')
        self.changed(db, row, nodes=ns, state='Running', reason='', next_check=None)

    def child_control(self, command):
        feedback = command['type'] == 'SaveTaskFeedback' and command['payload'].get('quality') == 'NeedsRevision'
        if command['type'] not in ('PauseTask', 'CancelTask', 'RejectTask', 'RevokeTaskPermission') and not feedback:
            return
        with self.store.transaction() as db:
            row = self.owner(db, command['payload']['task_id'])
            if row and row['state'] not in ('Revoked', 'Completed'):
                self.stop(db, dict(row), 'NeedsAttention' if feedback else 'Paused',
                          'User feedback requires revision; review dependent work' if feedback else 'User stopped an owned task; review before continuing the execution')

    def goal_context(self, db, aid, tid):
        row = self.owner(db, tid)
        if not row:
            return None
        self.check(db, row)
        goal = self.store.goals.detail(db, aid, row['goal_id'])
        ns = json.loads(row['nodes'])
        feedback = [f for n in ns if n.get('task_id')
                    if (f := self.store.work.feedback(db, aid, self.store.tasks.target(db, aid, n['task_id'])['current_run_id']))
                    and not f['deleted']]
        return {k: goal[k] for k in ('title', 'objective', 'success_criteria', 'progress_note')} | {
            'execution_nodes': [{k: n[k] for k in ('id', 'title', 'state', 'reason', 'depends_on', 'products')} |
                                {'retired': bool(n.get('retired'))} for n in ns],
            'task_feedback': [{k: f[k] for k in ('task_id', 'run_id', 'note', 'quality')} for f in feedback],
            'evidence_notice': 'Product references are actual Host receipt metadata, not file contents or proof that this Task read them. '
                               'Use the authorized tools to read dependency products when the instruction calls for their content. '
                               'Only claim reads present in actual observations; distinguish Host write readback from a separate model-requested read.'}

    def check(self, db, row):
        goal = self.store.goals.detail(db, row['agent_id'], row['goal_id'])
        scope = json.loads(row['scope'])
        if (row['state'] not in ('Running', 'Waiting', 'Planning') or goal['state'] != 'Active'
                or binding(goal) != json.loads(row['goal_binding']) or aware(scope['expires_at']) <= self.clock()
                or db.execute("SELECT value FROM settings WHERE key='runtime'").fetchone()[0] != 'Running'
                or not self.store.scheduler.settings(db, row['agent_id'])['enabled']):
            raise DomainError('ExecutionStopped', 'Execution is paused, expired or no longer authorized')
        agent_context.selected_method(self.store, db, row['agent_id'], scope)
        agent_context.conversation(self.store, db, row['agent_id'], scope, goal)
        self.check_plan_refs(db, row)

    def check_plan_refs(self, db, row):
        work = db.execute('SELECT data FROM execution_work WHERE work_id=?', (row['planning_id'],)).fetchone()
        if work:
            data = json.loads(work['data'])
            if data.get('context_stale') or data.get('context_erased'):
                raise DomainError('ContextStale', 'Planning context changed; review a fresh proposal')
            if data.get('context_refs'):
                agent_context.check(self.store, db, row['agent_id'], data['context_refs'])

    def invalidate_refs(self, db, aid, memory_ids=(), method_id=None, erase=False):
        for raw in db.execute('SELECT * FROM goal_executions WHERE agent_id=?', (aid,)).fetchall():
            row, affected, changed_plans = dict(raw), False, set()
            for work in db.execute("SELECT * FROM execution_work WHERE execution_id=? AND kind='Plan'", (row['execution_id'],)).fetchall():
                data = json.loads(work['data']); refs = data.get('context_refs', {})
                methods = ([refs['method_ref']] if refs.get('method_ref') else []) + refs.get('interaction_methods', [])
                if not (set(memory_ids) & {m['revision_id'] for m in refs.get('memory_references', [])}
                        or method_id and any(r['proposal_id'] == method_id for r in methods)):
                    continue
                affected = affected or work['work_id'] == row['planning_id']
                changed_plans.add(work['work_id'])
                data['context_stale'] = True
                result = json.loads(work['result'])
                if erase:
                    data['context_erased'] = True
                    result.update(raw_output='', context_erased=True)
                db.execute('UPDATE execution_work SET data=?,result=? WHERE work_id=?', (json.dumps(data), json.dumps(result), work['work_id']))
            if changed_plans:
                old_nodes = json.loads(row['nodes'])
                old_history = json.loads(row['history'])
                all_nodes = old_nodes + [n for h in old_history for n in h.get('nodes', [])]
                changed_ids = {n['id'] for n in all_nodes if n.get('planning_id') in changed_plans or affected and not n.get('planning_id')}
                if row['state'] not in ('Revoked','Completed'):
                    if affected:
                        self.stop(db, row, 'NeedsAttention', 'Referenced Memory or strategy changed; review a fresh plan')
                        row = self.target(db, aid, row['execution_id'])
                def cleared(ns):
                    return [n | {'context_stale':True} | ({'title':'已清除依赖内容','instruction':'','reason':'','context_erased':True} if erase else {})
                            if n['id'] in changed_ids else n for n in ns]
                history = [h | {'nodes':cleared(h.get('nodes', []))} for h in old_history]
                self.changed(db, row, nodes=cleared(old_nodes), history=history)
                if erase:
                    for link in db.execute('SELECT task_id FROM execution_tasks WHERE execution_id=?', (row['execution_id'],)):
                        if not any(n.get('task_id') == link['task_id'] and n['id'] in changed_ids for n in old_nodes):
                            continue
                        db.execute("UPDATE tasks SET title='已清除依赖内容',instruction='' WHERE task_id=?", (link['task_id'],))
                        for run in db.execute('SELECT run_id FROM task_runs WHERE task_id=?', (link['task_id'],)):
                            agent_context.erase_task(db, run['run_id'])

    def reserve_model(self, db, task, sid, reserve):
        row = self.owner(db, task['task_id'])
        if row:
            self.check(db, row)
            self.work(db, row['execution_id'], 'Model', {'agent_id': task['agent_id'], 'task_id': task['task_id'],
                      'step_id': sid, 'run_id': task['current_run_id'], 'reserve': reserve}, sid)
        return row is not None

    def model_finished(self, db, sid, metadata):
        db.execute("UPDATE execution_work SET state='Done',result=?,updated_at=? WHERE work_id=? AND kind='Model'",
                   (json.dumps(metadata), now(), sid))

    def tick(self):
        with self.store.transaction() as db:
            for raw in db.execute("SELECT * FROM goal_executions WHERE state IN ('Running','Waiting')").fetchall():
                row = dict(raw)
                try:
                    self.check(db, row)
                except DomainError as exc:
                    self.stop(db, row, 'Paused', exc.message)
                    continue
                ns, altered = json.loads(row['nodes']), False
                for n in ns:
                    if not n.get('task_id') or n.get('resume_pending') or n['state'] == 'Failed':
                        continue
                    t = task_result(db, row['agent_id'], n['task_id'])
                    feedback = self.store.work.feedback(db, row['agent_id'], t['run_id'])
                    if feedback and not feedback['deleted'] and feedback['quality'] == 'NeedsRevision':
                        n.update(state='Failed',reason='User feedback: NeedsRevision; '+feedback['note'])
                        altered=True
                        continue
                    if n['state'] == 'Done':
                        continue
                    before = (n['state'], n.get('reason'))
                    n['reason'] = t['error'] or t['state']
                    if t['state'] == 'Completed':
                        products = [o for o in t['outputs'] if o.get('outcome') == 'Success' and o.get('version')]
                        with_steps = self.store.tasks.planned.steps(db, t['run_id'])
                        observed = any(s['definition']['op'] not in ('decide', 'finish', 'update_plan') and s['result'].get('status') == 'Success' for s in with_steps)
                        n.update(state='Done' if observed and (products or not n['requires_product']) else 'Failed', products=products)
                        altered = True
                    elif t['state'] == 'Failed' and t['error'] == 'RuntimeInterrupted':
                        steps = self.store.tasks.planned.steps(db, t['run_id'])
                        unknown = any(s['metadata'].get('usage') is None and s['state'] == 'Failed' and s['definition']['op'] == 'decide' for s in steps)
                        network = any(s['definition']['op'] in ('search', 'read_web') and s['state'] != 'Completed' for s in steps)
                        if not unknown and not network:
                            n['resume_pending'] = True
                            self.work(db, row['execution_id'], 'Resume', {'task_id': n['task_id'], 'node_id': n['id']})
                            altered = True
                        else:
                            n.update(state='Failed', request_unknown=True)
                            altered = True
                    elif t['state'] in ('Failed', 'Partial', 'Blocked', 'NotExecuted', 'Rejected', 'Cancelled', 'NeedsAttention'):
                        n['state'] = 'Failed'
                        n['unknown'] = t['state'] == 'NeedsAttention'
                        altered = True
                    else:
                        n['state'] = t['state']
                        altered = altered or before != (n['state'], n['reason'])
                if altered:
                    self.changed(db, row, nodes=ns)
                    row = self.target(db, row['agent_id'], row['execution_id'])
                live = [n for n in ns if not n.get('retired')]
                failed = [n for n in live if n['state'] == 'Failed' and not n.get('resume_pending')]
                if failed:
                    signature = json.dumps([(n['id'], n['task_id'], n['reason']) for n in failed])
                    if any(n.get('unknown') for n in failed):
                        self.changed(db, row, state='NeedsAttention', reason='Unknown effect; reconcile the original action before continuing')
                    elif any(n.get('request_unknown') for n in failed):
                        self.changed(db, row, state='NeedsAttention', reason='Interrupted request or network charge is unknown; explicitly confirm before another request')
                    elif json.loads(row['scope'])['allow_replan'] and row['replan_signature'] != signature:
                        self.changed(db, row, state='Planning', reason='Adjust future work after the actual result', replan_signature=signature)
                        self.work(db, row['execution_id'], 'Plan', {'initial': False, 'reason': signature})
                    else:
                        self.changed(db, row, state='NeedsAttention', reason='Work needs review; original failure preserved')
                    continue
                if live and all(n['state'] == 'Done' for n in live):
                    self.changed(db, row, state='Completed', reason='Execution work completed; Goal achievement still requires user confirmation')
                    continue
                if any(n.get('task_id') and n['state'] not in ('Done', 'Failed') for n in live):
                    waiting = any(n['state'] in ('AwaitingApproval', 'AwaitingInput') for n in live)
                    state = 'Waiting' if waiting else 'Running'
                    reason = 'Waiting for approval/input' if waiting else ''
                    if row['state'] != state or row['reason'] != reason:
                        self.changed(db, row, state=state, reason=reason)
                    continue
                if row['next_check'] and aware(row['next_check']) > self.clock():
                    continue
                pending = next((n for n in live if not n.get('task_id') and all(any(d['id'] == dep and d['state'] == 'Done' for d in ns) for dep in n['depends_on'])
                                and (n['not_before'] is None or aware(n['not_before']) <= self.clock())), None)
                if pending:
                    busy = db.execute("SELECT 1 FROM execution_tasks l JOIN tasks t USING(task_id) WHERE t.agent_id=? AND t.state IN ('Created','Running','Generating','Executing','Searching','ReadingWeb','AwaitingApproval','AwaitingInput')", (row['agent_id'],)).fetchone()
                    if not busy:
                        wid = 'dispatch:' + pending['dispatch_key']
                        self.work(db, row['execution_id'], 'Dispatch', {'node_id': pending['id'], 'task_id': str(uuid4())}, wid)
                # Host checks file conditions and products; no file access in Core.
                if row['state'] != 'Waiting':
                    self.changed(db, row, state='Waiting', reason='Waiting for dependency, time, file condition or Host dispatch')

    def sync(self):
        with self.store.connect() as db:
            return [self.view(db, r) | {'check_due': not r['next_check'] or aware(r['next_check']) <= self.clock()}
                    for r in db.execute('SELECT * FROM goal_executions')]

    def recover(self):
        with self.store.transaction() as db:
            for w in db.execute("SELECT * FROM execution_work WHERE state='Pending' AND kind='Model'").fetchall():
                data = json.loads(w['data'])
                step = db.execute('SELECT * FROM task_steps WHERE step_id=?', (data['step_id'],)).fetchone()
                if step and step['state'] == 'Failed':
                    # No persisted Host ack means this Core never launched model I/O.
                    metadata = json.loads(step['metadata']) | {'usage': {'total_tokens': 0}, 'not_started': True}
                    db.execute('UPDATE task_steps SET metadata=? WHERE step_id=?', (json.dumps(metadata), step['step_id']))
                    context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (data['run_id'],)).fetchone()[0])
                    context['token_spent_or_reserved'] = max(0, context.get('token_spent_or_reserved', 0)-data['reserve'])
                    db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), data['run_id']))
                    db.execute("UPDATE execution_work SET state='Done',result=?,updated_at=? WHERE work_id=?",
                               (json.dumps(metadata | {'error': 'NotStarted'}), now(), w['work_id']))
            db.execute("UPDATE execution_work SET state='Done',result=?,updated_at=? WHERE state='Granted'",
                       (json.dumps({'error': 'RuntimeInterrupted', 'usage': None}), now()))
