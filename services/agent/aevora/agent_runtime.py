"""Bounded model/tool/observation loop; native results, not model claims, drive progress."""
import asyncio
import json
import time
from contextlib import closing
from uuid import uuid4

from . import agent_actions
from . import document_actions, general_actions
from .errors import DomainError
from .evolution import binding
from .identity import now
from .recall import current
from .network_sources import extract_page
from . import agent_context


class DecisionFeedback(DomainError):
    """A model proposal to reconsider; never a Host execution or permission grant."""
    def __init__(self, code, message, status='Rejected'):
        super().__init__(code, message)
        self.status = status


def request_room(context, limits, config, metadata, elapsed_ms):
    reserve = config['max_input_tokens'] + config['max_output_tokens']
    spent = context.get('token_spent_or_reserved', 0)
    actual = (metadata.get('usage') or {}).get('total_tokens')
    if isinstance(actual, int):
        spent = max(0, spent - reserve) + actual
    tools = limits.get('tools', {})
    return (context['decisions_started'] < limits['max_decisions']
            and spent + reserve <= tools.get('max_total_tokens', limits['max_decisions'] * reserve)
            and context.get('active_ms', 0) + elapsed_ms < tools.get('execution_seconds', 900) * 1000)


class AgentRuntime:
    def __init__(self, store, gateway, recall):
        self.store, self.gateway, self.recall, self.tasks = store, gateway, recall, {}

    def input(self, v):
        aid, tid = v['agent_id'], v['task_id']
        with self.store.transaction() as db:
            row = self.store.tasks.target(db, aid, tid)
            rid = row['current_run_id']
            repo = self.store.tasks.planned
            context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
            step = repo.current_step(db, rid)
            if v.get('phase') == 'start':
                if row['state'] != 'Running' or not row['permission'] or not step or step['step_id'] != v['step_id'] or step['definition']['op'] not in ('search', 'read_web'):
                    raise DomainError('Forbidden', 'No current authorized network action')
                db.execute("INSERT INTO network_requests VALUES (?,?,?,?,?,'Running',?,NULL)", (v['request_id'], aid, rid, step['step_id'], step['definition']['op'], json.dumps({'action': step['definition']})))
                repo.state(db, row, 'Searching' if step['definition']['op'] == 'search' else 'ReadingWeb')
                return
            if v.get('phase') == 'result':
                request = db.execute('SELECT * FROM network_requests WHERE request_id=? AND agent_id=?', (v['request_id'], aid)).fetchone()
                if not request or request['state'] != 'Running' or not step or request['step_id'] != step['step_id']:
                    raise DomainError('Forbidden', 'Network result must match its actual current request')
                metadata = json.loads(request['metadata']) | v.get('metadata', {})
                error, result = v.get('error'), v.get('result', {})
                if not error and step['definition']['op'] == 'read_web':
                    if result.get('original_url') != step['definition']['url']:
                        raise DomainError('Forbidden', 'Source receipt differs from the selected source')
                    if result.get('status') == 'RedirectApprovalRequired':
                        error = 'RedirectNotAuthorized'  # Preserve the observation; choose another source or stop.
                    else:
                        try:
                            result = extract_page(result, min(12000, self.gateway.config['max_input_tokens']))
                        except DomainError as exc:
                            error = exc.code
                if not error and step['definition']['op'] == 'search':
                    items = result.get('results')
                    if result.get('query') != step['definition']['query'] or not isinstance(items, list) or len(items) > 5 or any(not isinstance(item.get('url'), str) or not item['url'].startswith('https://') for item in items):
                        raise DomainError('InvalidSearchReceipt', 'Search results differ from the actual query')
                    result['status'] = 'Success'
                context['active_ms'] = context.get('active_ms', 0) + int(metadata.get('elapsed_ms', 0))
                db.execute('UPDATE network_requests SET state=?,metadata=?,error=? WHERE request_id=?', ('Failed' if error else 'Completed', json.dumps(metadata), error, v['request_id']))
                if row['state'] not in ('Searching', 'ReadingWeb') or not row['permission'] or context.get('context_stale'):
                    return  # Preserve usage without resurrecting revoked or erased content.
                if error:
                    result = {'status': 'Failed', 'error': error}
                    if error == 'NetworkPermissionChanged':
                        context['network_available'] = False
                step_metadata = step['metadata'] | {'network': metadata}
                db.execute("UPDATE task_steps SET state='Completed',result=?,metadata=?,error=? WHERE step_id=?", (json.dumps(result), json.dumps(step_metadata), error, step['step_id']))
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                repo.state(db, row, 'Running')
            elif v.get('step_id') or (v.get('error') and step):
                if row['state'] != 'Running' or not row['permission'] or not step or (v.get('step_id') and v['step_id'] != step['step_id']):
                    raise DomainError('Forbidden', 'Tool result is not current')
                error = v.get('error')
                if error:
                    result = {'status': 'Failed', 'error': error}
                    if error in ('NetworkPermissionChanged', 'SearchRequestLimit'):
                        context['network_available'] = False
                else:
                    if step['definition']['op'] in general_actions.READS | general_actions.WRITES:
                        if binding(self.gateway.ready()) != v['provider'] or not isinstance(v.get('tool'), dict) or v['tool'].get('status') != 'Success':
                            raise DomainError('Forbidden', 'Current bound native tool observation required')
                        result = v['tool']
                        context['active_ms'] = context.get('active_ms', 0) + int(result.get('elapsed_ms', 0))
                        if step['definition']['op'] in general_actions.WRITES:
                            action = str(uuid4())
                            body = json.dumps(step['definition'], ensure_ascii=False)
                            editor = step['context'].get('proposal_editor', 'model')
                            db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,?)", (action, step['step_id'], body, now(), editor))
                            db.execute("UPDATE task_steps SET state='AwaitingApproval',action_id=?,result=? WHERE step_id=?", (action, json.dumps(result), step['step_id']))
                            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                            repo.state(db, row, 'AwaitingApproval')
                            return
                    elif step['definition']['op'] in document_actions.OPS:
                        if binding(self.gateway.ready()) != v['provider']:
                            raise DomainError('Forbidden', 'Current Host provider binding required')
                        d = step['definition']
                        result = v['document']
                        if result.get('resource') != d['resource'] or result.get('status') != 'Success' or not isinstance(result.get('version'), str):
                            raise DomainError('Forbidden', 'Document receipt differs from selected action')
                        if d['op'] in document_actions.WRITES:
                            action = str(uuid4())
                            body = json.dumps(d['changes'], ensure_ascii=False)
                            editor = step.get('action', {}).get('editor', 'model') if step.get('action') else 'model'
                            db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,?)", (action, step['step_id'], body, now(), editor))
                            db.execute("UPDATE task_steps SET state='AwaitingApproval',action_id=?,result=? WHERE step_id=?", (action, json.dumps(result), step['step_id']))
                            repo.state(db, row, 'AwaitingApproval')
                            return
                    else:
                        if step['definition']['op'] != 'read' or binding(self.gateway.ready()) != v['provider']:
                            raise DomainError('Forbidden', 'A bound native read is required')
                        d = step['definition']
                        resource = d['resource']
                        path = json.loads(row['sources'])[int(resource[6:])-1] if resource.startswith('source') else json.loads(row['outputs'])[int(resource[6:])-1]['path']
                        result = v['file']
                        if result.get('path') != path or result.get('start') != d['start'] or not isinstance(result.get('content'), str) or len(result['content']) > d['length']:
                            raise DomainError('Forbidden', 'Read receipt differs from the selected resource range')
                        result = result | {'status': 'Success'}
                db.execute("UPDATE task_steps SET state='Completed',result=?,error=? WHERE step_id=?", (json.dumps(result), error, step['step_id']))
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                self.store.memory.event(db, 'AgentToolObserved', aid, {'task_id': tid, 'step_id': step['step_id'], 'error': error}, actor='native_host')
                repo.state(db, row, 'Running')
            else:
                config = self.gateway.ready()
                if row['state'] != 'Created' or not row['permission'] or v['provider'] != binding(config):
                    raise DomainError('Forbidden', 'A current Host-bound action scope is required')
                if json.loads(row['agent_limits'])['allow_search'] and type(v.get('search_revision')) is not int:
                    raise DomainError('Forbidden', 'Network scope requires a Host search configuration binding')
                context.update(provider=binding(config), search_revision=v.get('search_revision'), purpose='AgentDecision')
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                repo.state(db, row, 'Running')
        self.pump(aid, tid)

    def pump(self, aid, tid):
        with self.store.transaction() as db:
            row = self.store.tasks.target(db, aid, tid)
            rid, repo = row['current_run_id'], self.store.tasks.planned
            if row['state'] != 'Running' or not row['permission'] or rid in self.tasks or repo.current_step(db, rid):
                return
            owner = self.store.executions.owner(db, tid)
            if owner:
                try:
                    self.store.executions.check(db, owner)
                except DomainError:
                    return  # Reconciliation can persist while the execution awaits explicit resumption.
            try:
                config = self.gateway.ready()
            except DomainError as exc:
                repo.state(db, row, 'Failed', exc.code)
                return
            context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
            limits = json.loads(row['agent_limits'])
            if context.get('decisions_started', 0) >= limits['max_decisions']:
                repo.state(db, row, 'Failed', 'AgentDecisionLimit')
                return
            tools = limits.get('tools', {})
            if context.get('active_ms', 0) >= tools.get('execution_seconds', 900) * 1000:
                repo.state(db, row, 'Failed', 'ExecutionTimeLimit')
                return
            reserve = config['max_input_tokens'] + config['max_output_tokens']
            if context.get('token_spent_or_reserved', 0) + reserve > tools.get('max_total_tokens', limits['max_decisions'] * reserve):
                repo.state(db, row, 'Failed', 'TaskTokenBudget')
                return
            context['token_spent_or_reserved'] = context.get('token_spent_or_reserved', 0) + reserve
            context['decisions_started'] = context.get('decisions_started', 0) + 1
            sid = str(uuid4())
            position = db.execute('SELECT COUNT(*) FROM task_steps WHERE run_id=?', (rid,)).fetchone()[0]
            db.execute("INSERT INTO task_steps(step_id,run_id,position,definition,state) VALUES (?,?,?,?,'Generating')", (sid, rid, position, json.dumps({'id': f'action_{position+1}', 'op': 'decide'})))
            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
            repo.state(db, row, 'Generating')
            if not self.store.executions.reserve_model(db, row, sid, reserve):
                self.launch(dict(row), sid, config)

    def launch(self, row, sid, config):
        rid = row['current_run_id']
        if rid not in self.tasks:
            self.tasks[rid] = asyncio.create_task(self.decide(dict(row), sid, config))

    def check(self, db, row, context, config):
        owner = self.store.executions.owner(db, row['task_id'])
        if owner:
            self.store.executions.check(db, owner)
        if context.get('context_stale') or context.get('provider') != binding(config) or binding(self.gateway.config) != binding(config):
            raise DomainError('ContextStale', 'Action scope or Provider changed')
        self.store.evolution.check_task(db, row)
        self.store.evolution.check_context(db, row['agent_id'], context)

    async def decide(self, row, sid, config):
        aid, tid, rid = row['agent_id'], row['task_id'], row['current_run_id']
        began = time.monotonic()
        raw, error, metadata = '', None, {'purpose': 'AgentDecision', 'prompt_version': agent_actions.VERSION, 'provider': binding(config)}
        started = False
        feedback, continue_deciding = None, False
        try:
            limits = json.loads(row['agent_limits'])
            with self.store.connect() as db:
                source = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0]).get('source_conversation_id')
                if source:
                    try:
                        self.store.conversation.target(db, aid, source)
                    except DomainError:
                        source = None
            memories, recall = await self.recall.prepare(aid, row['instruction'], conversation_id=source) if limits.get('allow_memory') else ([], {'state': 'Disabled'})
            with self.store.transaction() as db:
                latest = self.store.tasks.target(db, aid, tid)
                context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
                if latest['current_run_id'] != rid or latest['state'] != 'Generating' or not latest['permission']:
                    return
                self.check(db, latest, context, config)
                if not current(db, aid, memories):
                    raise DomainError('ContextStale', 'Memory changed')
                agent = self.store.identity.profile(db, aid)
                context.update(persona_revision=agent['current_persona_revision'], recall=recall,
                    memory_revision_ids=sorted(set(context.get('memory_revision_ids', [])) | {m['revision_id'] for m in memories}))
                from .interaction_evaluation import active_refs
                context['interaction_methods'] = active_refs(self.store, db, aid, config)
                communication = [self.store.evolution.resolve(db, aid, ref) for ref in context['interaction_methods']]
                steps = self.store.tasks.planned.steps(db, rid)
                messages = agent_actions.messages(agent, row['instruction'], json.loads(row['sources']), json.loads(row['outputs']), steps,
                    context['network_available'], limits['max_decisions']-context['decisions_started']+1, memories, self.store.evolution.check_task(db, latest), communication, limits.get('documents', []), limits.get('tools'), context.get('short_plan'))
                context['shared_facts'] = {'persona_revision': agent['current_persona_revision'],
                                         'request_time': agent_context.request_time(self.store.input_timezone)}
                messages.append({'role': 'user', 'content': json.dumps({'trusted_request_time': context['shared_facts']['request_time']})})
                goal_context = (self.store.executions.goal_context(db, aid, tid)
                                or self.store.goals.task_context(db, aid, tid))
                if goal_context:
                    messages.append({'role': 'user', 'content': json.dumps({'confirmed_goal_context': goal_context}, ensure_ascii=False)})
                if sum(len(m['content'])+16 for m in messages) > config['max_input_tokens']:
                    raise DomainError('BudgetExceeded', 'Actual observations exceed the configured context; no evidence is silently dropped')
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                self.store.memory.event(db, 'AgentDecisionStarted', aid, {'task_id': tid, 'step_id': sid}, actor='task_runtime')
            def consume(delta):
                nonlocal raw
                raw += delta
                if len(raw) > 65536:
                    raise DomainError('BudgetExceeded', 'Action output exceeded capacity')
            started = True
            await self.gateway.stream(config, messages, consume, metadata, response_format={'type': 'json_object'})
            if metadata.get('finish_reason') != 'stop':
                raise DomainError('OutputTruncated', 'Incomplete next action')
            try:
                value = agent_actions.parse(raw, json.loads(row['sources']), json.loads(row['outputs']), steps, context['network_available'], limits.get('documents', []), limits.get('tools'))
            except DomainError as exc:
                if exc.code in {'InvalidMethod', 'InvalidAgentAction', 'InvalidToolAction', 'InsufficientSourceEvidence', 'InvalidSourceCitation'}:
                    message = 'Return one valid JSON object with unique keys and the documented action fields.' if exc.code == 'InvalidMethod' else exc.message
                    raise DecisionFeedback(exc.code, message) from None
                raise
            with self.store.transaction() as db:
                latest = self.store.tasks.target(db, aid, tid)
                if latest['current_run_id'] != rid or latest['state'] != 'Generating' or not latest['permission']:
                    return
                context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
                self.check(db, latest, context, config)
                if self.store.identity.profile(db, aid)['current_persona_revision'] != context['persona_revision'] or not current(db, aid, memories):
                    raise DomainError('ContextStale', 'Identity or Memory changed during the decision')
                actual_steps = [s for s in steps if s['definition']['op'] != 'decide']
                if (value['op'] == 'finish' and value['outcome'] == 'blocked' and not context.get('stop_reviewed')
                        and any(s['result'].get('status') == 'Success' for s in actual_steps)
                        and not any(s.get('error') or s['result'].get('status') == 'Failed'
                                    or s['result'].get('receipt', {}).get('outcome') in ('Unknown', 'NotExecuted') for s in actual_steps)
                        and request_room(context, limits, config, metadata, int((time.monotonic() - began) * 1000))):
                    raise DecisionFeedback('StopReviewRequired',
                        'Review the proposed blocked result once. Successful observations show no execution failure. '
                        'Use an already authorized action if it can resolve pending work; otherwise confirm blocked with the specific missing permission, information or budget. '
                        'Do not repeat failed or unknown actions, invent permission, or claim unfinished work complete.', 'ReviewRequired')
                definition = value | {'id': f'action_{len(steps)}'}
                for key in ('question', 'reply'):
                    definition.pop(key, None)
                if value['op'] == 'write':
                    definition.pop('body', None)  # Legacy write stores body in step_actions.
                state, result = 'Pending', {}
                op = value['op']
                if op == 'update_plan':
                    context['short_plan'] = value['items']
                    db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))
                    state, task_state = 'Completed', 'Running'
                    result = {'status': 'Success', 'items': value['items']}
                elif op == 'write':
                    action = str(uuid4())
                    db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,'model')", (action, sid, value['body'], now()))
                    db.execute('UPDATE task_steps SET action_id=? WHERE step_id=?', (action, sid))
                    state, task_state = 'AwaitingApproval', 'AwaitingApproval'
                elif op == 'ask':
                    definition['question'] = value['question']
                    state, task_state = 'AwaitingInput', 'AwaitingInput'
                elif op == 'finish':
                    state, task_state = 'Completed', {'complete':'Completed','partial':'Partial','blocked':'Blocked'}[value['outcome']]
                    result = {'reply': value['reply'], 'status': 'ModelDraft', 'outcome': value['outcome']}
                    db.execute('UPDATE task_runs SET reply=? WHERE run_id=?', (value['reply'], rid))
                else:
                    task_state = 'Running'
                db.execute('UPDATE task_steps SET definition=?,state=?,result=? WHERE step_id=?', (json.dumps(definition), state, json.dumps(result), sid))
                self.store.tasks.planned.state(db, latest, task_state)
        except asyncio.CancelledError:
            error = 'RuntimeInterrupted'
        except DecisionFeedback as exc:
            error, feedback = exc.code, exc
        except DomainError as exc:
            error = exc.code
        except Exception:
            error = 'ProviderRequestFailed'
        finally:
            if not started:
                metadata.update(usage={'total_tokens':0}, not_started=True)
            with self.store.transaction() as db:
                ctx = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
                ctx['active_ms'] = ctx.get('active_ms', 0) + int((time.monotonic() - began) * 1000)
                actual = (metadata.get('usage') or {}).get('total_tokens')
                if isinstance(actual, int):
                    ctx['token_spent_or_reserved'] = max(0, ctx.get('token_spent_or_reserved', 0) - config['max_input_tokens'] - config['max_output_tokens']) + actual
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(ctx), rid))
                db.execute('UPDATE task_steps SET raw_output=?,metadata=?,error=? WHERE step_id=?', ('' if ctx.get('context_erased') else raw, json.dumps(metadata), error, sid))
                self.store.executions.model_finished(db, sid, metadata | {'error': error})
                latest = self.store.tasks.target(db, aid, tid)
                if error and latest['current_run_id'] == rid and latest['state'] == 'Generating':
                    if feedback:
                        result = {'status': feedback.status, 'error': feedback.code, 'message': feedback.message, 'executed': False}
                        db.execute("UPDATE task_steps SET state=?,result=? WHERE step_id=?",
                                   ('Completed' if feedback.status == 'ReviewRequired' else 'Failed', json.dumps(result), sid))
                        try:
                            self.check(db, latest, ctx, config)
                            if not latest['permission'] or self.store.identity.profile(db, aid)['current_persona_revision'] != ctx['persona_revision'] or not current(db, aid, memories):
                                raise DomainError('ContextStale', 'Decision context changed')
                            if feedback.status == 'ReviewRequired':
                                ctx['stop_reviewed'] = True
                            elif ctx.get('validation_corrections', 0) < 2:
                                ctx['validation_corrections'] = ctx.get('validation_corrections', 0) + 1
                            else:
                                raise DomainError('DecisionCorrectionLimit', 'Repeated invalid decisions; no further automatic correction')
                            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(ctx), rid))
                            self.store.tasks.planned.state(db, latest, 'Running')
                            continue_deciding = True
                        except DomainError as exc:
                            self.store.tasks.planned.state(db, latest, 'Failed', exc.code)
                    else:
                        db.execute("UPDATE task_steps SET state='Failed' WHERE step_id=?", (sid,))
                        self.store.tasks.planned.state(db, latest, 'Failed', error)
            self.tasks.pop(rid, None)
        if not error or continue_deciding:
            self.pump(aid, tid)

    def invalidate(self):
        with closing(self.store.connect()) as db:
            for rid, task in list(self.tasks.items()):
                if db.execute('SELECT state FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0] != 'Generating':
                    task.cancel()

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
