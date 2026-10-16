"""Host-acknowledged planning and model starts; no independent scheduling loop."""
import asyncio
import json

from .errors import DomainError
from .evolution import binding, strict_json
from .executions import nodes
from .identity import now
from . import agent_context


class ExecutionRuntime:
    def __init__(self, store, agency, gateway):
        self.store, self.agency, self.gateway = store, agency, gateway
        self.tasks = {}

    def native(self, v):
        repo, op = self.store.executions, v['op']
        if op == 'sync':
            return repo.sync()
        if op == 'stop':
            with self.store.transaction() as db:
                row = repo.target(db, v['agent_id'], v['execution_id'])
                if row['state'] not in ('Revoked', 'Completed'):
                    repo.stop(db, row, 'Paused', v['reason'])
            return {}
        with self.store.transaction() as db:
            w = db.execute('SELECT * FROM execution_work WHERE work_id=?', (v['work_id'],)).fetchone()
            if not w:
                raise DomainError('NotFound', 'Work unavailable')
            row = repo.target(db, v['agent_id'], w['execution_id'])
            data = json.loads(w['data'])
            if op == 'settled':
                if w['state'] == 'Done':
                    db.execute("UPDATE execution_work SET state='Settled' WHERE work_id=?", (w['work_id'],))
                    self.store.memory.event(db, 'GoalExecutionBudgetUpdated', row['agent_id'], {'execution_id':row['execution_id'],'goal_id':row['goal_id']}, actor='native_host')
                return {}
            if op == 'waiting':
                if row['state'] in ('Running', 'Waiting'):
                    from datetime import timedelta
                    repo.changed(db, row, reason=v['reason'], next_check=(repo.clock()+timedelta(seconds=60)).isoformat())
                return {}
            if op == 'denied':
                if row['state'] not in ('Revoked', 'Paused', 'Completed'):
                    repo.stop(db, row, 'NeedsAttention', v['reason'])
                return {}
            if op == 'granted' and w['state'] != 'Pending':
                return {}
            repo.check(db, row)
            if op == 'granted' and w['kind'] == 'Plan' and row['planning_id'] != w['work_id']:
                raise DomainError('ContextStale', 'A newer plan request replaced this proposal')
            if op == 'resumed' and w['kind'] == 'Resume':
                ns = json.loads(row['nodes'])
                for n in ns:
                    if n['id'] == data['node_id']:
                        n.pop('resume_pending', None)
                        n.update(state='Running', unknown=False)
                repo.changed(db, row, nodes=ns, state='Running', reason='')
                db.execute("UPDATE execution_work SET state='Settled' WHERE work_id=?", (w['work_id'],))
                asyncio.get_running_loop().call_soon(self.agency.agent.pump, row['agent_id'], data['task_id'])
                return {}
            if op == 'attached':
                if w['kind'] != 'Dispatch' or data['task_id'] != v['task_id']:
                    raise DomainError('Forbidden', 'Task must match the original dispatch')
                task = self.store.tasks.target(db, row['agent_id'], v['task_id'])
                if task['state'] != 'Created' and not repo.owner(db, task['task_id']):
                    raise DomainError('Forbidden', 'Attach ownership before starting the task')
                db.execute('INSERT OR IGNORE INTO execution_tasks VALUES (?,?,?,?)', (task['task_id'], row['execution_id'], data['node_id'], w['work_id']))
                ns = json.loads(row['nodes'])
                for n in ns:
                    if n['id'] == data['node_id']:
                        n.update(task_id=task['task_id'], state='Created')
                repo.changed(db, row, nodes=ns, state='Running', reason='', next_check=None)
                db.execute("UPDATE execution_work SET state='Settled' WHERE work_id=?", (w['work_id'],))
                return {}
            if op != 'granted' or w['kind'] not in ('Plan', 'Model'):
                raise DomainError('Forbidden', 'Unsupported native work acknowledgement')
            if w['state'] != 'Pending':
                return {}  # Idempotent acknowledgement cannot start another request.
            if v['provider'] != binding(self.gateway.ready()) or v['expires_at'] != json.loads(row['scope'])['expires_at']:
                raise DomainError('Forbidden', 'Current Host Provider and authorization required')
            if w['kind'] == 'Model':
                task = self.store.tasks.target(db, row['agent_id'], data['task_id'])
                if task['state'] != 'Generating' or not task['permission'] or task['current_run_id'] != data['run_id']:
                    db.execute("UPDATE execution_work SET state='Done',result=? WHERE work_id=?", (json.dumps({'error':'NotStarted','usage':{'total_tokens':0}}), w['work_id']))
                    return {}
            db.execute("UPDATE execution_work SET state='Granted',updated_at=? WHERE work_id=?", (now(), w['work_id']))
            wid = w['work_id']
        if w['kind'] == 'Plan':
            self.tasks[wid] = asyncio.create_task(self.plan(wid, row, data))
        else:
            with self.store.connect() as db:
                task = self.store.tasks.target(db, row['agent_id'], data['task_id'])
            if task['state'] == 'Generating' and task['current_run_id'] == data['run_id']:
                self.agency.agent.launch(task, wid, self.gateway.ready())
        return {}

    async def plan(self, wid, row, data):
        repo, raw, metadata, error = self.store.executions, '', {}, None
        config = self.gateway.ready()
        started = False
        try:
            with self.store.connect() as db:
                latest = repo.target(db, row['agent_id'], row['execution_id'])
                scope = json.loads(latest['scope'])
                goal = self.store.goals.detail(db, row['agent_id'], row['goal_id'])
                cid = agent_context.conversation(self.store, db, row['agent_id'], scope, goal)
            memories, recall = await self.agency.agent.recall.prepare(row['agent_id'], goal['objective'], conversation_id=cid) if scope['allow_memory'] else ([], {'state':'Disabled'})
            with self.store.transaction() as db:
                latest = repo.target(db, row['agent_id'], row['execution_id'])
                repo.check(db, latest)
                if latest['planning_id'] != wid:
                    raise DomainError('ContextStale', 'A newer plan request replaced this proposal')
                goal = self.store.goals.detail(db, row['agent_id'], row['goal_id'])
                agent = self.store.identity.profile(db, row['agent_id'])
                scope = json.loads(latest['scope'])
                method = agent_context.selected_method(self.store, db, row['agent_id'], scope)
                refs = agent_context.references(self.store, db, row['agent_id'], config, memories, scope.get('method_ref'))
                agent_context.check(self.store, db, row['agent_id'], refs)
                methods = [self.store.evolution.resolve(db, row['agent_id'], r) for r in refs['interaction_methods']]
                if method:
                    methods.append(method)
                data = data | {'context_refs': refs}
                db.execute('UPDATE execution_work SET data=? WHERE work_id=?', (json.dumps(data), wid))
                context = {'goal': {k: goal[k] for k in ('title', 'objective', 'success_criteria', 'next_step', 'progress_note')},
                           'agent_facts': agent_context.facts(agent, memories, recall, methods, self.store.input_timezone),
                           'nodes': [n if not n.get('context_stale') else n | {'title':'旧提案依据已变更','instruction':'','reason':'Use current facts and retained native product references'} for n in json.loads(latest['nodes'])], 'reason': data['reason'],
                           'related_work': self.store.goals.context(db, row['agent_id'], row['goal_id'])['data'],
                           'roots': [{'id': f'root{i+1}', 'mode': r['mode']} for i, r in enumerate(scope['tools']['roots'])]}
            messages = [{'role': 'system', 'content':
                'Plan bounded work for the same Personal Agent. Identity: '+json.dumps(agent.get('persona', {}), ensure_ascii=False)+
                '. Return strict JSON with exactly reason(string), nodes(array of 1..8 future nodes, or [] only when blocked). '
                'Write user-facing titles, instructions and reason in the Goal/user language. '
                'Each node has exactly id,title,instruction,depends_on(array of node IDs),not_before(ISO timestamp or null),'
                'condition(null or {root,path,mode:exists|changed}),requires_product(boolean). '
                'Use relative paths and root aliases. Preserve explicit time/file waits from the goal. '
                'For file delivery require a real product and readback; instructions go to the existing general-tool Agent. '
                'Propose only future work. Started/completed node IDs cannot be reused, but may be dependencies. '
                'Do not repeat successful effects, invent evidence, change Goal criteria or grant permission. '
                'After failure propose at most one bounded alternative using actual results. If no safe alternative, explain the blocker in reason; do not claim the Goal achieved.'},
                {'role': 'user', 'content': json.dumps(context, ensure_ascii=False)}]
            if sum(len(m['content'])+16 for m in messages) > config['max_input_tokens']:
                raise DomainError('BudgetExceeded', 'Complete execution planning context exceeds capacity')
            def consume(delta):
                nonlocal raw
                raw += delta
                if len(raw) > 32768:
                    raise DomainError('BudgetExceeded', 'Plan output exceeds capacity')
            metadata = {'purpose': 'GoalPlan', 'provider': binding(config), 'prompt_version': 'goal-plan-v2', 'context_refs': refs}
            started = True
            await self.gateway.stream(config, messages, consume, metadata, response_format={'type': 'json_object'})
            if metadata.get('finish_reason') != 'stop':
                raise DomainError('OutputTruncated', 'Incomplete plan')
            value = strict_json(raw)
            if not isinstance(value, dict) or set(value) != {'reason', 'nodes'} or not isinstance(value['reason'], str) or len(value['reason']) > 2000:
                raise DomainError('InvalidExecutionPlan', 'Use reason and future nodes only')
            with self.store.transaction() as db:
                latest = repo.target(db, row['agent_id'], row['execution_id'])
                repo.check(db, latest)
                if latest['planning_id'] != wid:
                    raise DomainError('ContextStale', 'A newer plan request replaced this proposal')
                previous = json.loads(latest['nodes'])
                if value['nodes'] == []:
                    repo.changed(db, latest, state='NeedsAttention', reason=value['reason'])
                    return  # A supported blocked result never invents work or implies Goal completion.
                future = nodes(value['nodes'], previous)
                future = [n | {'planning_id':wid} for n in future]
                fixed = [n | ({'retired': True} if n['state'] == 'Failed' else {}) for n in previous if n.get('task_id')]
                history = json.loads(latest['history']) + [{'nodes': previous, 'reason': data['reason'], 'at': now()}]
                repo.changed(db, latest, nodes=fixed+future, history=history,
                             state='AwaitingPlanApproval' if data['initial'] or not scope['allow_replan'] else 'Running',
                             reason=value['reason'], next_check=None)
        except asyncio.CancelledError:
            error = 'RuntimeInterruptedOrPermissionChanged'
        except DomainError as exc:
            error = exc.code
        except Exception:
            error = 'ProviderRequestFailed'
        finally:
            if not started:
                metadata.update(usage={'total_tokens':0}, not_started=True)
            with self.store.transaction() as db:
                saved = db.execute('SELECT data FROM execution_work WHERE work_id=?', (wid,)).fetchone()
                if saved and json.loads(saved['data']).get('context_erased'):
                    raw = ''
                    metadata['context_erased'] = True
                deleted = db.execute('SELECT state FROM goals WHERE goal_id=?', (row['goal_id'],)).fetchone()[0] == 'Deleted'
                db.execute("UPDATE execution_work SET state='Done',result=?,updated_at=? WHERE work_id=?",
                           (json.dumps(metadata | {'error': error, 'raw_output': '' if deleted else raw}), now(), wid))
                latest = repo.target(db, row['agent_id'], row['execution_id'])
                if error and latest['state'] == 'Planning' and latest['planning_id'] == wid:
                    repo.stop(db, latest, 'NeedsAttention', error)
            self.tasks.pop(wid, None)

    def invalidate(self):
        with self.store.transaction() as db:
            for row in db.execute("SELECT * FROM goal_executions WHERE state IN ('Running','Waiting','Planning','AwaitingPlanApproval')").fetchall():
                try:
                    agent_context.selected_method(self.store, db, row['agent_id'], json.loads(row['scope']))
                    goal = self.store.goals.detail(db,row['agent_id'],row['goal_id'])
                    agent_context.conversation(self.store,db,row['agent_id'],json.loads(row['scope']),goal)
                    self.store.executions.check_plan_refs(db, row)
                except DomainError as exc:
                    self.store.executions.stop(db, dict(row), 'NeedsAttention', exc.message)
            for wid, task in list(self.tasks.items()):
                w = db.execute('SELECT execution_id FROM execution_work WHERE work_id=?', (wid,)).fetchone()
                row = db.execute('SELECT * FROM goal_executions WHERE execution_id=?', (w['execution_id'],)).fetchone()
                try:
                    self.store.executions.check(db, row)
                    if row['planning_id'] != wid:
                        raise DomainError('ContextStale', 'Planning was replaced')
                except DomainError:
                    task.cancel()

    async def close(self):
        for task in list(self.tasks.values()):
            task.cancel()
        await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
