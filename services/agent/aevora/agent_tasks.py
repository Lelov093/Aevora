"""Persistent dynamic tasks using the existing native step/action/receipt boundaries."""
import json
from uuid import uuid4

from .errors import DomainError
from .identity import now
from .memory_governance import cached

MIGRATION = ("ALTER TABLE tasks ADD COLUMN agent_limits TEXT NOT NULL DEFAULT '{}'",
             "ALTER TABLE task_runs ADD COLUMN reply TEXT")
COMMANDS = {'CreateAgentTask', 'AnswerAgentTask', 'ReviseAgentAction'}


class AgentRepository:
    def __init__(self, store):
        self.store = store

    def execute(self, c):
        aid, p, kind = c['agent_id'], c['payload'], c['type']
        if kind not in COMMANDS:
            if kind != 'RetryTask':
                return self.store.tasks.planned.execute(c)
            return self.retry(c)
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            old = cached(db, c, serialized)
            if old is not None:
                return old
            if kind == 'CreateAgentTask':
                tid = c['command_id']
                goal_context = self.store.goals.task_creation_context(db, c)
                if not p['title'].strip() or not p['instruction'].strip():
                    raise DomainError('ValidationError', 'Describe the request before authorizing actions')
                if p.get('conversation_id'):
                    self.store.conversation.target(db, aid, p['conversation_id'])
                context = {'source_conversation_id': p.get('conversation_id'), 'decisions_started': 0, 'network_available': p['allow_search']}
                db.execute("INSERT INTO tasks(task_id,agent_id,title,instruction,sources,output_path,state,permission,revision,created_at,updated_at,kind,outputs,agent_limits) VALUES (?,?,?,?,?,?,'Created',1,0,?,?,'agent',?,?)",
                           (tid, aid, p['title'], p['instruction'], json.dumps(p['sources']), p['outputs'][0]['path'] if p['outputs'] else '', now(), now(), json.dumps(p['outputs']), json.dumps({'max_decisions': p['max_decisions'], 'allow_search': p['allow_search'], 'allow_memory': p['allow_memory'], 'documents': p.get('documents', []), 'tools': p.get('tools', {})})))
                self.store.tasks.planned.next_run(db, self.store.tasks.target(db, aid, tid), None, False, [])
                row = self.store.tasks.target(db, aid, tid)
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), row['current_run_id']))
                self.store.goals.attach(db, c, 'task', tid)
                self.store.goals.bind_task_context(db, aid, tid, goal_context)
                self.store.executions.attach_task(db, c, tid)
                self.store.evolution.attach(db, c, tid)
                self.store.work.accept(db, c, 'CreateAgentTask', tid)
                self.store.memory.event(db, 'TaskCreated', aid, {'task_id': tid, 'kind': 'agent'}, c['command_id'], 'user')
            elif kind == 'ReviseAgentAction':
                from . import general_actions
                tid = p['task_id']
                row = self.store.tasks.target(db, aid, tid)
                repo = self.store.tasks.planned
                step = repo.current_step(db, row['current_run_id'])
                if row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Review the current action before sending feedback')
                if (row['kind'] != 'agent' or row['state'] != 'AwaitingApproval' or not row['permission']
                        or not step or not step['action'] or step['action_id'] != p['action_id']
                        or step['action']['state'] != 'AwaitingApproval'
                        or step['definition']['op'] not in general_actions.WRITES | {'write'}):
                    raise DomainError('Forbidden', 'Only the current unexecuted general/text proposal can be returned for revision')
                if not p['feedback'].strip():
                    raise DomainError('ValidationError', 'Describe the issue for the next proposal')
                context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (row['current_run_id'],)).fetchone()[0])
                if context.get('context_stale'):
                    raise DomainError('ContextStale', 'Create work with current authorized context')
                self.store.evolution.check_task(db, row)
                self.store.goals.task_context(db, aid, tid)
                result = step['result'] | {'status': 'ReviewRejected', 'executed': False,
                                           'source': 'user_review', 'message': p['feedback'].strip()}
                db.execute("UPDATE step_actions SET state='Rejected' WHERE action_id=?", (step['action_id'],))
                db.execute("UPDATE task_steps SET state='Rejected',result=? WHERE step_id=?", (json.dumps(result), step['step_id']))
                self.store.memory.event(db, 'AgentActionRevisionRequested', aid,
                                        {'task_id': tid, 'step_id': step['step_id'], 'action_id': step['action_id']}, c['command_id'], 'user')
                repo.state(db, row, 'Running')
            else:
                tid = p['task_id']
                row = self.store.tasks.target(db, aid, tid)
                step = self.store.tasks.planned.current_step(db, row['current_run_id'])
                if row['kind'] != 'agent' or row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Review the current work')
                if not row['permission'] or row['state'] != 'AwaitingInput' or not step or step['definition']['op'] != 'ask':
                    raise DomainError('Forbidden', 'No current clarification awaits your answer')
                if not p['answer'].strip():
                    raise DomainError('ValidationError', 'Provide the missing information')
                db.execute("UPDATE task_steps SET state='Completed',result=? WHERE step_id=?", (json.dumps({'answer': p['answer'], 'source': 'user'}), step['step_id']))
                self.store.tasks.planned.state(db, row, 'Running')
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': self.store.tasks.detail(db, aid, tid)}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response

    def retry(self, c):
        aid, p = c['agent_id'], c['payload']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            old = cached(db, c, serialized)
            if old is not None:
                return old
            row = self.store.tasks.target(db, aid, p['task_id'])
            if row['revision'] != c['expected_revision'] or row['state'] not in ('Paused', 'Failed', 'Cancelled', 'Rejected', 'NotExecuted') or not row['permission']:
                raise DomainError('Forbidden', 'Resolve effects and review current permission before another attempt')
            if db.execute("SELECT 1 FROM network_requests WHERE run_id=? AND state='Running'", (row['current_run_id'],)).fetchone():
                raise DomainError('Forbidden', 'Wait for the in-flight network receipt before another attempt')
            repo = self.store.tasks.planned
            steps = repo.steps(db, row['current_run_id'])
            prefix = []
            for step in steps:
                if not repo.resolved(step):
                    break
                prefix.append(step)
            pending = steps[len(prefix)] if len(prefix) < len(steps) else None
            if pending and pending['definition']['op'] in ('search', 'read_web') and not p.get('acknowledge_network_retry'):
                raise DomainError('Forbidden', 'Acknowledge a possible additional network charge before another attempt')
            run = db.execute('SELECT context FROM task_runs WHERE run_id=?', (row['current_run_id'],)).fetchone()
            context = json.loads(run['context'])
            context.pop('stop_requested', None)
            if context.get('context_stale'):
                raise DomainError('ContextStale', 'Create newly authorized work using current context')
            self.store.evolution.check_task(db, row)
            plan = {'steps': [s['definition'] for s in prefix]}
            if pending and pending['definition']['op'] != 'decide':
                plan['steps'].append(pending['definition'])
            row = repo.next_run(db, row, plan, False, prefix)
            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), row['current_run_id']))
            if not context.get('provider'):
                repo.state(db, row, 'Created')
            elif pending and pending['definition']['op'] == 'write' and pending['action']:
                step = repo.current_step(db, row['current_run_id'])
                action = str(uuid4())
                db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,?)", (action, step['step_id'], pending['action']['body'], now(), pending['action']['editor']))
                db.execute("UPDATE task_steps SET state='AwaitingApproval',action_id=? WHERE step_id=?", (action, step['step_id']))
                repo.state(db, row, 'AwaitingApproval')
            else:
                if pending and pending.get('action'):
                    editor = pending['action'].get('editor', 'model')
                    current = repo.current_step(db, row['current_run_id'])
                    if current:
                        db.execute('UPDATE task_steps SET context=? WHERE step_id=?', (json.dumps(dict(pending['context'], proposal_editor=editor)), current['step_id']))
                repo.state(db, row, 'Running')
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': self.store.tasks.detail(db, aid, row['task_id'])}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response
