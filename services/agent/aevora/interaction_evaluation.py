"""Human-reviewed, isolated dialogue comparisons through the normal model gateway."""
import asyncio
import json
from contextlib import closing

from .context import build_context, request_time
from . import interaction_comparison_memory as comparison_memory
from .errors import DomainError
from .evolution import binding
from .identity import now
from .memory_governance import cached


def active_refs(store, db, aid, provider):
    return [store.evolution.reference(row) for row in store.evolution.active_methods(db, aid, 'communication')
            if all(json.loads(row['provider']).get(k) == provider[k] for k in ('base_url', 'model'))
            and json.loads(row['metadata']).get('allow_full_outbound')]


def context_current(store, db, aid, context):
    return (store.identity.profile(db, aid)['current_persona_revision'] == context['persona_revision']
            and active_refs(store, db, aid, context['provider']) == context['active_methods']
            and not context.get('context_stale')
            and comparison_memory.current(store, db, aid, context))


def record_evaluation(store, db, aid, proposal, payload):
    comparison = db.execute('SELECT * FROM interaction_comparisons WHERE comparison_id=? AND proposal_id=? AND agent_id=?',
                            (payload['comparison_id'], proposal['proposal_id'], aid)).fetchone()
    if not comparison or comparison['state'] != 'Completed' or comparison['proposal_revision'] != proposal['revision']:
        raise DomainError('ContextStale', 'Use a completed comparison of this exact candidate revision')
    results = json.loads(comparison['results'])
    if len(results) != 6 or any(r['state'] != 'Completed' for r in results):
        raise DomainError('Forbidden', 'Review all three baseline/candidate pairs; partial results cannot establish improvement')
    if not context_current(store, db, aid, json.loads(comparison['context'])):
        raise DomainError('ContextStale', 'Identity or applicable strategies changed during comparison')
    if len(payload['checks']) != len(json.loads(proposal['criteria'])):
        raise DomainError('ValidationError', 'Assess every predeclared criterion')
    return {k: payload[k] for k in ('comparison_id', 'checks', 'improved', 'no_regression', 'reviewer', 'note')} | {'recorded_at': now()}


class InteractionEvaluationRuntime:
    def __init__(self, store, gateway):
        self.store, self.gateway, self.tasks = store, gateway, {}

    def command(self, c):
        aid, p, cid = c['agent_id'], c['payload'], c['command_id']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            old = cached(db, c, serialized)
            if old is not None:
                return old
            config = self.gateway.ready()
            if not p['allow_outbound'] or p['provider'] != binding(config) or self.store.snapshot()['runtime_state'] != 'Running':
                raise DomainError('Forbidden', 'Approve this comparison for the current Provider and running Runtime')
            row = self.store.evolution.target(db, aid, p['proposal_id'])
            if row['revision'] != c['expected_revision'] or row['state'] != 'Evaluating' or row['family'] != 'communication' or not self.store.evolution.proposal_current(db, row):
                raise DomainError('ContextStale', 'Select a current communication candidate under evaluation')
            if json.loads(row['provider']) != binding(config):
                raise DomainError('ContextStale', 'Candidate and comparison must use the same Provider configuration')
            experience = json.loads(row['experience'])
            source = experience['input']
            if len(set(p['cases'])) != 3 or source in p['cases']:
                raise DomainError('Forbidden', 'Use three distinct new situations, including an old-ability check; do not replay the learning input')
            if db.execute("SELECT 1 FROM interaction_comparisons WHERE proposal_id=? AND proposal_revision=?", (row['proposal_id'], row['revision'])).fetchone():
                raise DomainError('Forbidden', 'This revision already has a comparison; preserve it and revise explicitly rather than retrying')
            context = {'provider': binding(config), 'persona_revision': self.store.identity.profile(db, aid)['current_persona_revision'],
                       'active_methods': active_refs(self.store, db, aid, config), 'history': 'isolated', 'memory': 'not loaded'}
            context['memory_contexts'] = comparison_memory.prepare(self.store, db, aid, experience['conversation_id'], p.get('memory_contexts'))
            context['memory'] = 'explicit versions' if any(c['memory_revision_ids'] for c in context['memory_contexts']) else 'not loaded'
            context['time_context'] = request_time(self.store.input_timezone)
            # Budget and scope validation for both sides happens before any paid request.
            for index, text in enumerate(p['cases']):
                for role in ('baseline', 'candidate'):
                    self.messages(db, aid, text, index, role, dict(row), context, config)
            db.execute('INSERT INTO interaction_comparisons(comparison_id,proposal_id,agent_id,proposal_revision,state,cases,context,created_at,updated_at) VALUES (?,?,?,?,\'Running\',?,?,?,?)',
                       (cid, row['proposal_id'], aid, row['revision'], json.dumps(p['cases']), json.dumps(context), now(), now()))
            self.store.memory.event(db, 'InteractionComparisonStarted', aid, {'comparison_id': cid, 'proposal_id': row['proposal_id'], 'max_calls': 6}, c['command_id'], 'evolution')
            response = {'command_id': cid, 'status': 'persisted', 'data': {'comparison_id': cid, 'state': 'Running'}}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (cid, serialized, json.dumps(response)))
        self.tasks[cid] = asyncio.create_task(self.generate(cid, aid, p['cases'], context, dict(row), config))
        return response

    def valid(self, db, aid, proposal, context):
        row = self.store.evolution.target(db, aid, proposal['proposal_id'])
        return (row['revision'] == proposal['revision'] and row['state'] == 'Evaluating'
                and self.store.evolution.proposal_current(db, row)
                and context_current(self.store, db, aid, context)
                and binding(self.gateway.config) == context['provider'])

    def messages(self, db, aid, text, index, role, proposal, context, config):
        refs = context['active_methods']
        if role == 'candidate':
            refs = [r for r in refs if r['proposal_id'] != proposal['base_active_id']] + [self.store.evolution.reference(proposal, 'evaluation')]
        case = context['memory_contexts'][index]
        memories = comparison_memory.resolve(self.store, db, aid, case)
        messages, used = build_context(db, self.store.identity.profile(db, aid), case['conversation_id'], text,
            config, before_sequence=0, interaction_refs=refs, memories=memories,
            recall={'state': 'Ready', 'version': 'explicit-comparison-v1'} if memories else None,
            input_timezone=self.store.input_timezone, fixed_time=context['time_context'])
        if used['memory_revision_ids'] != case['memory_revision_ids']:
            raise DomainError('BudgetExceeded', 'Selected memories do not all fit both replies; shorten the situation or select fewer memories')
        return messages, used

    async def generate(self, cid, aid, cases, context, proposal, config):
        results, error = [], None
        try:
            for index, text in enumerate(cases):
                for role in ('baseline', 'candidate'):
                    with closing(self.store.connect()) as db:
                        if not self.valid(db, aid, proposal, context):
                            raise DomainError('ContextStale', 'Comparison context changed')
                        messages, used = self.messages(db, aid, text, index, role, proposal, context, config)
                    raw = ''
                    metadata = {'purpose': 'InteractionMethodEvaluation', 'case': index, 'role': role, 'provider': context['provider'],
                                'memory_revision_ids': used['memory_revision_ids'], 'time_context': used['time_context']}
                    def consume(delta):
                        nonlocal raw
                        raw += delta
                        if len(raw) > 32768:
                            raise DomainError('BudgetExceeded', 'Comparison response exceeded capacity')
                    result = {'case': index, 'role': role, 'state': 'Failed', 'text': '', 'raw': '', 'metadata': metadata}
                    results.append(result)
                    await self.gateway.stream(config, messages, consume, metadata)
                    result.update(text=raw, raw=raw)
                    if metadata.get('finish_reason') != 'stop' or not raw.strip():
                        raise DomainError('OutputTruncated', 'Comparison response was incomplete')
                    result['state'] = 'Completed'
                    with self.store.transaction() as db:
                        if not self.valid(db, aid, proposal, context):
                            raise DomainError('ContextStale', 'Comparison changed while receiving a response')
                        db.execute('UPDATE interaction_comparisons SET results=?,updated_at=? WHERE comparison_id=?', (json.dumps(results), now(), cid))
        except asyncio.CancelledError:
            error = 'RuntimeInterrupted'
        except DomainError as exc:
            error = exc.code
        except Exception:
            error = 'ProviderRequestFailed'
        finally:
            # A failed/partial call retains raw and usage. Never synthesize success or retry.
            if results and results[-1]['state'] != 'Completed':
                results[-1].update(text=raw, raw=raw, error=error)
            done = {(r['case'], r['role']) for r in results}
            results += [{'case': i, 'role': role, 'state': 'NOT_RUN'} for i in range(3) for role in ('baseline', 'candidate') if (i, role) not in done]
            with self.store.transaction() as db:
                comparison = db.execute('SELECT state FROM interaction_comparisons WHERE comparison_id=?', (cid,)).fetchone()
                valid = self.valid(db, aid, proposal, context)
                saved = db.execute('SELECT context FROM interaction_comparisons WHERE comparison_id=?', (cid,)).fetchone()
                erased = json.loads(saved['context']).get('context_erased')
                if comparison['state'] == 'Invalidated' and (erased or not json.loads(saved['context']).get('context_stale')):
                    results = [{k: v for k, v in r.items() if k not in ('text', 'raw')} for r in results]
                state = 'Completed' if valid and not error else 'Failed' if valid else 'Invalidated'
                db.execute('UPDATE interaction_comparisons SET state=?,results=?,error=?,updated_at=? WHERE comparison_id=?', (state, json.dumps(results), error or (None if valid else 'ContextStale'), now(), cid))
                self.store.memory.event(db, 'InteractionComparisonFinished', aid, {'comparison_id': cid, 'state': state, 'error': error}, actor='evolution')
            self.tasks.pop(cid, None)

    async def pause(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def invalidate(self):
        # Context checks before each call and before persistence reject unrelated stale versions.
        with closing(self.store.connect()) as db:
            ids = {r[0] for r in db.execute("SELECT comparison_id FROM interaction_comparisons WHERE state='Invalidated'")}
        tasks = [task for cid, task in list(self.tasks.items()) if cid in ids]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
