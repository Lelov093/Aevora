"""Durable user-owned goals. Work evidence and model advice never imply achievement."""
import json

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached
from .task_results import result as task_result

MIGRATION = (
    """CREATE TABLE goals(goal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id),
        state TEXT NOT NULL, revision INTEGER NOT NULL, source_conversation_id TEXT, source_message_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(source_message_id,source_conversation_id,agent_id) REFERENCES messages(message_id,conversation_id,agent_id))""",
    """CREATE TABLE goal_revisions(goal_id TEXT NOT NULL REFERENCES goals(goal_id), revision INTEGER NOT NULL,
        title TEXT NOT NULL, objective TEXT NOT NULL, success_criteria TEXT NOT NULL, next_step TEXT NOT NULL,
        progress_note TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(goal_id,revision))""",
    """CREATE TABLE goal_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        goal_id TEXT NOT NULL REFERENCES goals(goal_id), linked_at TEXT NOT NULL)""",
    """CREATE TABLE goal_schedules(schedule_id TEXT PRIMARY KEY REFERENCES schedules(schedule_id),
        goal_id TEXT NOT NULL REFERENCES goals(goal_id), linked_at TEXT NOT NULL)""",
)
COMMANDS = {'CreateGoal', 'ListGoals', 'GetGoal', 'EditGoal', 'ChangeGoalState', 'DeleteGoal',
            'LinkGoalWork', 'UnlinkGoalWork', 'GetGoalContext', 'GetGoalSource'}
FIELDS = {'title': 120, 'objective': 2000, 'success_criteria': 1000, 'next_step': 1000, 'progress_note': 1000}


class GoalRepository:
    def __init__(self, store):
        self.store = store

    def target(self, db, aid, gid):
        self.store.identity.agent(db, aid)
        row = db.execute('SELECT * FROM goals WHERE goal_id=? AND agent_id=?', (gid, aid)).fetchone()
        if not row or row['state'] == 'Deleted':
            raise DomainError('NotFound', 'Goal unavailable in this Agent')
        return dict(row)

    def list(self, db, aid):
        self.store.identity.agent(db, aid)
        return [dict(r) for r in db.execute('SELECT g.*,r.title,COALESCE(p.silenced,0) AS followup_silenced,COALESCE(p.revision,0) AS followup_revision FROM goals g JOIN goal_revisions r '
            'ON r.goal_id=g.goal_id AND r.revision=g.revision LEFT JOIN goal_followup_policy p ON p.goal_id=g.goal_id WHERE g.agent_id=? AND g.state<>\'Deleted\' '
            'ORDER BY g.updated_at DESC,g.goal_id', (aid,))]

    def detail(self, db, aid, gid):
        row = self.target(db, aid, gid)
        history = [dict(r) for r in db.execute('SELECT * FROM goal_revisions WHERE goal_id=? ORDER BY revision DESC', (gid,))]
        tasks = []
        for link in db.execute('SELECT t.task_id,t.title FROM goal_tasks l JOIN tasks t USING(task_id) '
                               'WHERE l.goal_id=? AND t.agent_id=? ORDER BY l.linked_at DESC,t.task_id', (gid, aid)):
            tasks.append(task_result(db, aid, link['task_id']) | {'title': link['title']})
        schedules = [self.store.scheduler.decorate(db, aid, s) for s in db.execute(
            'SELECT s.* FROM goal_schedules l JOIN schedules s USING(schedule_id) '
            'WHERE l.goal_id=? AND s.agent_id=? ORDER BY l.linked_at DESC,s.schedule_id', (gid, aid))]
        return row | history[0] | {'history': history, 'tasks': tasks, 'schedules': schedules}

    def fields(self, p):
        values = {}
        for key, limit in FIELDS.items():
            value = p.get(key, '')
            if not isinstance(value, str) or len(value.strip()) > limit or (key in ('title', 'objective', 'success_criteria') and not value.strip()):
                raise DomainError('ValidationError', 'Goal needs a title, objective and achievement criteria within capacity')
            values[key] = value.strip()
        return values

    def revision(self, db, row, values, reason, state=None):
        rev, stamp = row['revision'] + 1, now()
        db.execute('INSERT INTO goal_revisions VALUES (?,?,?,?,?,?,?,?,?)',
                   (row['goal_id'], rev, *[values[k] for k in FIELDS], reason, stamp))
        db.execute('UPDATE goals SET revision=?,state=?,updated_at=? WHERE goal_id=?',
                   (rev, state or row['state'], stamp, row['goal_id']))
        self.invalidate(db, row['agent_id'], row['goal_id'])

    def source(self, db, aid, gid):
        row = self.target(db, aid, gid)
        message = None
        if row['source_message_id']:
            try:
                message = self.store.commitments.message(db, aid, row['source_conversation_id'], row['source_message_id'])
            except DomainError:
                pass
        return {'goal_id': gid, 'available': message is not None, 'message': message,
                'conversation_id': row['source_conversation_id']}

    def for_work(self, db, aid, kind, target_id):
        table, key = ('goal_tasks', 'task_id') if kind == 'task' else ('goal_schedules', 'schedule_id')
        link = db.execute(f'SELECT goal_id FROM {table} WHERE {key}=?', (target_id,)).fetchone()
        if not link:
            return None
        row = self.target(db, aid, link[0])
        title = db.execute('SELECT title FROM goal_revisions WHERE goal_id=? AND revision=?', (row['goal_id'], row['revision'])).fetchone()[0]
        return row | {'title': title}

    def attach(self, db, c, kind, target_id):
        p, aid = c['payload'], c['agent_id']
        gid = p.get('goal_id')
        if not gid:
            # A task prepared from a goal-linked reminder must explicitly confirm the same goal.
            if kind == 'task' and p.get('schedule_id') and self.for_work(db, aid, 'schedule', p['schedule_id']):
                raise DomainError('Forbidden', 'Confirm the linked Goal before preparing its task')
            return
        row = self.target(db, aid, gid)
        if row['state'] != 'Active':
            raise DomainError('Forbidden', 'Only an active Goal can accept another work item')
        if p.get('goal_revision') != row['revision']:
            raise DomainError('RevisionConflict', 'Goal changed; review the next step again')
        if kind == 'task' and p.get('schedule_id'):
            origin = self.for_work(db, aid, 'schedule', p['schedule_id'])
            if origin and origin['goal_id'] != gid:
                raise DomainError('Forbidden', 'Reminder and task must belong to the same Goal')
        table, key = ('goal_tasks', 'task_id') if kind == 'task' else ('goal_schedules', 'schedule_id')
        if db.execute(f'SELECT 1 FROM {table} WHERE {key}=?', (target_id,)).fetchone():
            raise DomainError('RevisionConflict', 'Work item is already associated with a Goal')
        db.execute(f'INSERT INTO {table} VALUES (?,?,?)', (target_id, gid, now()))
        values = dict(db.execute('SELECT * FROM goal_revisions WHERE goal_id=? AND revision=?', (gid, row['revision'])).fetchone())
        self.revision(db, row, values, 'WorkLinked')
        self.store.memory.event(db, 'GoalWorkLinked', aid, {'goal_id': gid, 'kind': kind, 'target_id': target_id}, c['command_id'], 'user')

    def context(self, db, aid, gid, exclude_task_id=None):
        value = self.detail(db, aid, gid)
        if value['state'] != 'Active':
            raise DomainError('Forbidden', 'Resume an active Goal explicitly')
        related = [t for t in value['tasks'] if t['task_id'] != exclude_task_id]
        tasks, schedules = related[:8], value['schedules'][:8]
        refs = {'goal_id': gid, 'goal_revision': value['revision'],
                'tasks': [{'task_id': t['task_id'], 'revision': t['revision']} for t in tasks],
                'schedules': [{'schedule_id': s['schedule_id'], 'revision': s['revision']} for s in schedules]}
        feedback = [f for t in tasks if (f := self.store.work.feedback(db, aid, t['run_id'])) and not f['deleted']]
        if feedback:
            refs['feedback'] = [{'run_id': f['run_id'], 'revision': f['revision']} for f in feedback]
        data = {k: value[k] for k in FIELDS}
        data.update(state=value['state'], followup_silenced=bool(self.store.proactivity.followup_policy(db, aid, gid)['silenced']), tasks=[{k: t[k] for k in ('task_id', 'title', 'state', 'permission', 'run_id')} |
            {'outputs': [{k: o[k] for k in ('label', 'outcome', 'bytes_written', 'body_review')} for o in t['outputs']]} for t in tasks],
            schedules=[{k: s[k] for k in ('schedule_id', 'title', 'state', 'due_at')} for s in schedules],
            omitted_tasks=len(related)-len(tasks), omitted_schedules=len(value['schedules'])-len(schedules))
        if feedback:
            data['user_feedback'] = [{k: f[k] for k in ('task_id', 'run_id', 'note', 'quality')} for f in feedback]
        return {'data': data, 'references': refs}

    def approved_context(self, db, aid, approval):
        if not approval or approval.get('allow_outbound') is not True:
            raise DomainError('Forbidden', 'Explicit consent for this Goal context is required')
        projection = self.context(db, aid, approval['goal_id'])
        if {k: v for k, v in approval.items() if k != 'allow_outbound'} != projection['references']:
            raise DomainError('RevisionConflict', 'Goal or work evidence changed; review current context')
        return projection

    def task_creation_context(self, db, c):
        approval = c['payload'].get('goal_context')
        if approval is None:
            return None
        if approval['goal_id'] != c['payload'].get('goal_id'):
            raise DomainError('Forbidden', 'Task context must belong to its explicitly selected Goal')
        return self.approved_context(db, c['agent_id'], approval)

    def bind_task_context(self, db, aid, tid, approved):
        if approved is None:
            return
        # Linking this new task advances the Goal revision. Other approved evidence is unchanged.
        refs = self.context(db, aid, approved['references']['goal_id'], exclude_task_id=tid)['references']
        rid = self.store.tasks.target(db, aid, tid)['current_run_id']
        context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (rid,)).fetchone()[0])
        context['task_goal_context'] = refs
        db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), rid))

    def task_context(self, db, aid, tid):
        task = self.store.tasks.target(db, aid, tid)
        context = json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?', (task['current_run_id'],)).fetchone()[0])
        refs = context.get('task_goal_context')
        if not refs:
            return None
        if context.get('context_stale'):
            raise DomainError('ContextStale', 'Confirmed task Goal context changed; prepare a new task')
        link = self.for_work(db, aid, 'task', tid)
        if not link or link['goal_id'] != refs['goal_id']:
            raise DomainError('ContextStale', 'Confirmed task Goal context changed; prepare a new task')
        projection = self.context(db, aid, refs['goal_id'], exclude_task_id=tid)
        if projection['references'] != refs:
            raise DomainError('ContextStale', 'Goal, related work or feedback changed; prepare a new task')
        return projection['data']

    def invalidate_task_context(self, db, aid, gid=None, feedback_run_id=None, erase=False):
        affected = set()
        for run in db.execute('SELECT r.* FROM task_runs r JOIN tasks t USING(task_id) WHERE t.agent_id=?', (aid,)).fetchall():
            context = json.loads(run['context'])
            refs = context.get('task_goal_context', {})
            if not refs and erase and gid is not None:
                owner = self.store.executions.owner(db, run['task_id'])
                if owner and owner['goal_id'] == gid:
                    refs = {'goal_id': gid}
            if not refs or (gid is not None and refs['goal_id'] != gid) or (
                    feedback_run_id is not None and not any(f['run_id'] == feedback_run_id for f in refs.get('feedback', []))):
                continue
            context['context_stale'] = True
            if erase:
                context['context_erased'] = True
                context.pop('current_work', None)
                db.execute("UPDATE task_runs SET raw_output='',plan=NULL WHERE run_id=?", (run['run_id'],))
                db.execute("UPDATE task_actions SET body='' WHERE run_id=?", (run['run_id'],))
                for step in self.store.tasks.planned.steps(db, run['run_id']):
                    definition = step['definition']
                    definition.pop('instruction', None)
                    db.execute("UPDATE task_steps SET definition=?,context='{}',result='{}',raw_output='' WHERE step_id=?", (json.dumps(definition), step['step_id']))
                    db.execute("UPDATE step_actions SET body='' WHERE step_id=?", (step['step_id'],))
                    if step['action_id']:
                        affected.add(step['action_id'])
            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(context), run['run_id']))
            affected.update((run['run_id'], run['task_id']))
        if erase and affected:
            erase_cached(db, affected)

    def invalidate(self, db, aid, gid, erase=False):
        if erase and db.execute('SELECT state FROM goals WHERE goal_id=?', (gid,)).fetchone()[0] == 'Deleted':
            db.execute('UPDATE conversations SET resume_goal_id=NULL WHERE agent_id=? AND resume_goal_id=?', (aid, gid))
        self.store.proactivity.invalidate_goal(db, aid, gid)
        self.invalidate_task_context(db, aid, gid=gid, erase=erase)
        affected, assistant_ids = set(), set()
        for r in db.execute('SELECT run_id,context FROM runs WHERE agent_id=?', (aid,)).fetchall():
            refs = json.loads(r['context'])
            if refs.get('goal_context', {}).get('goal_id') != gid:
                continue
            refs['context_stale'] = True
            if erase:
                refs['context_erased'] = True
                assistant_ids.update(m[0] for m in db.execute("SELECT message_id FROM messages WHERE run_id=? AND role='assistant'", (r['run_id'],)))
            db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), r['run_id']))
            affected.add(r['run_id'])
        # Propagate through known conversation-history dependencies; no replay can revive old goal advice.
        rows = db.execute('SELECT run_id,context FROM runs WHERE agent_id=?', (aid,)).fetchall()
        assistant_ids.update(m[0] for rid in affected for m in db.execute("SELECT message_id FROM messages WHERE run_id=? AND role='assistant'", (rid,)))
        changed = True
        while changed:
            changed = False
            for r in rows:
                refs = json.loads(r['context'])
                if r['run_id'] not in affected and assistant_ids & set(refs.get('message_ids', [])):
                    refs['context_stale'] = True
                    if erase:
                        refs['context_erased'] = True
                    db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), r['run_id']))
                    affected.add(r['run_id'])
                    assistant_ids.update(m[0] for m in db.execute("SELECT message_id FROM messages WHERE run_id=? AND role='assistant'", (r['run_id'],)))
                    changed = True
        if erase:
            for rid in affected:
                db.execute("UPDATE messages SET content='',finality='partial' WHERE run_id=? AND role='assistant'", (rid,))
                db.execute("UPDATE memory_jobs SET state='Cancelled',error='SourceUnavailable' WHERE run_id=?", (rid,))
        if erase:
            erase_cached(db, {gid, *affected, *assistant_ids})
        self.store.work.invalidate(db, aid, affected, erase)

    def execute(self, c):
        aid, kind, p = c['agent_id'], c['type'], c['payload']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind in ('ListGoals', 'GetGoal', 'GetGoalContext', 'GetGoalSource'):
                data = self.list(db, aid) if kind == 'ListGoals' else {'GetGoal': self.detail, 'GetGoalContext': self.context, 'GetGoalSource': self.source}[kind](db, aid, p['goal_id'])
                return {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            gid = c['command_id'] if kind == 'CreateGoal' else p['goal_id']
            if kind == 'CreateGoal':
                if p.get('confirmed_independent') is not True:
                    raise DomainError('Forbidden', 'Confirm this independent Goal and achievement criteria')
                values, stamp = self.fields(p), now()
                cid, mid = p.get('source_conversation_id'), p.get('source_message_id')
                if bool(cid) != bool(mid):
                    raise DomainError('ValidationError', 'Goal source requires both conversation and message')
                if mid:
                    self.store.commitments.message(db, aid, cid, mid)
                db.execute("INSERT INTO goals VALUES (?,?,'Active',0,?,?,?,?)", (gid, aid, cid, mid, stamp, stamp))
                db.execute('INSERT INTO goal_revisions VALUES (?,?,?,?,?,?,?,?,?)', (gid, 0, *values.values(), 'UserConfirmed', stamp))
                self.store.work.accept(db, c, 'CreateGoal', gid)
            else:
                row = self.target(db, aid, gid)
                if c.get('expected_revision') != row['revision']:
                    raise DomainError('RevisionConflict', 'Goal changed; reload before editing')
                values = dict(db.execute('SELECT * FROM goal_revisions WHERE goal_id=? AND revision=?', (gid, row['revision'])).fetchone())
                if kind == 'EditGoal':
                    self.store.work.accept(db, c, 'EditGoal', gid)
                    self.revision(db, row, self.fields(p), 'UserEdited')
                elif kind == 'ChangeGoalState':
                    state = p['state']
                    if state not in ('Active', 'Paused', 'Cancelled', 'Completed') or state == row['state']:
                        raise DomainError('ValidationError', 'Choose a different supported Goal state')
                    reason = p.get('reason', '').strip()
                    if state == 'Completed' and (p.get('confirmed_achieved') is not True or not reason):
                        raise DomainError('Forbidden', 'Only the user can confirm achievement against the criteria with a reason')
                    self.revision(db, row, values, reason or 'UserStateChanged', state)
                elif kind in ('LinkGoalWork', 'UnlinkGoalWork'):
                    work_kind, target_id = p['kind'], p['target_id']
                    work = self.store.tasks.target(db, aid, target_id) if work_kind == 'task' else self.store.scheduler.target(db, aid, target_id)
                    if work['revision'] != p['target_revision']:
                        raise DomainError('RevisionConflict', 'Work item changed; review again')
                    if kind == 'LinkGoalWork':
                        self.attach(db, c | {'payload': p | {'goal_revision': row['revision']}}, work_kind, target_id)
                    else:
                        table, key = ('goal_tasks', 'task_id') if work_kind == 'task' else ('goal_schedules', 'schedule_id')
                        if not db.execute(f'DELETE FROM {table} WHERE {key}=? AND goal_id=?', (target_id, gid)).rowcount:
                            raise DomainError('NotFound', 'Work item is not linked to this Goal')
                        self.revision(db, row, values, 'WorkUnlinked')
                elif kind == 'DeleteGoal':
                    self.invalidate(db, aid, gid, True)
                    db.execute("UPDATE goal_revisions SET title='',objective='',success_criteria='',next_step='',progress_note='',reason='' WHERE goal_id=?", (gid,))
                    db.execute("UPDATE goals SET state='Deleted',revision=revision+1,source_conversation_id=NULL,source_message_id=NULL,updated_at=? WHERE goal_id=?", (now(), gid))
                    db.execute('DELETE FROM goal_tasks WHERE goal_id=?', (gid,))
                    db.execute('DELETE FROM goal_schedules WHERE goal_id=?', (gid,))
                else:
                    raise DomainError('ValidationError', 'Unknown Goal command')
            self.store.executions.goal_changed(db, aid, gid)
            self.store.memory.event(db, kind, aid, {'goal_id': gid}, c['command_id'], 'user')
            data = {'goal_id': gid, 'deleted': True} if kind == 'DeleteGoal' else self.detail(db, aid, gid)
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response
