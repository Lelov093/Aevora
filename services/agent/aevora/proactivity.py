"""Local observation and notification policy, separate from tool permissions."""
import json
from datetime import datetime, timedelta, timezone

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached

MIGRATION = (
    """CREATE TABLE proactive_settings(agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),revision INTEGER NOT NULL,
    observe INTEGER NOT NULL,think INTEGER NOT NULL,notify INTEGER NOT NULL,goal_ids TEXT NOT NULL,provider TEXT NOT NULL,
    quiet_start INTEGER NOT NULL,quiet_end INTEGER NOT NULL,max_daily_calls INTEGER NOT NULL,
    max_daily_notifications INTEGER NOT NULL,cooldown_minutes INTEGER NOT NULL)""",
    """CREATE TABLE proactive_checks(check_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,goal_id TEXT NOT NULL,
    signature TEXT NOT NULL,settings_revision INTEGER NOT NULL,state TEXT NOT NULL,context TEXT NOT NULL,
    decision TEXT,reason TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',next_step TEXT NOT NULL DEFAULT '',
    raw_output TEXT NOT NULL DEFAULT '',metadata TEXT NOT NULL DEFAULT '{}',error TEXT,due_at TEXT,created_at TEXT NOT NULL,
    notified_at TEXT,UNIQUE(agent_id,goal_id,signature))""",
    "CREATE TABLE proactive_budgets(agent_id TEXT NOT NULL,local_date TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,notifications INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent_id,local_date))",
)
COMMANDS = {'ConfigureProactivity', 'GetProactivity', 'PreviewProactivityContext', 'DismissProactiveNotice', 'SnoozeProactiveNotice', 'HandleProactiveNotice', 'SetGoalFollowupPolicy'}


class ProactivityRepository:
    def __init__(self, store, clock=None):
        self.store = store
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def settings(self, db, aid):
        row = db.execute('SELECT * FROM proactive_settings WHERE agent_id=?', (aid,)).fetchone()
        return dict(row) if row else {'agent_id': aid, 'revision': 0, 'observe': 0, 'think': 0, 'notify': 0,
            'goal_ids': '[]', 'provider': '{}', 'quiet_start': 22, 'quiet_end': 8, 'max_daily_calls': 2,
            'max_daily_notifications': 2, 'cooldown_minutes': 60}

    def followup_policy(self, db, aid, gid):
        row = db.execute('SELECT * FROM goal_followup_policy WHERE agent_id=? AND goal_id=?', (aid, gid)).fetchone()
        return dict(row) if row else {'revision': 0, 'silenced': 0, 'source_message_id': None}

    def context(self, db, aid, gid):
        projection = self.store.goals.context(db, aid, gid)
        data = projection['data']
        # No files, paths, message history or arbitrary Memory; Goal projection is already bounded.
        return {'data': {k: data[k] for k in ('title', 'objective', 'success_criteria', 'next_step', 'progress_note', 'state', 'tasks')}
                | {'user_feedback': data.get('user_feedback', [])}, 'references': projection['references'], 'followup_revision': self.followup_policy(db, aid, gid)['revision']}

    def signature(self, context):
        refs = context['references']
        if context.get('followup_revision'):
            refs = refs | {'followup_policy_revision': context['followup_revision']}
        return json.dumps(refs, sort_keys=True, separators=(',', ':'))

    def fresh(self, db, row):
        settings = self.settings(db, row['agent_id'])
        if not settings['observe'] or row['goal_id'] not in json.loads(settings['goal_ids']) or self.followup_policy(db, row['agent_id'], row['goal_id'])['silenced']:
            return False
        try:
            return self.signature(self.context(db, row['agent_id'], row['goal_id'])) == row['signature']
        except DomainError:
            return False

    def view(self, db, aid):
        settings = self.settings(db, aid)
        settings['goal_ids'] = json.loads(settings['goal_ids'])
        settings['provider'] = json.loads(settings['provider'])
        notices = []
        for row in db.execute("SELECT * FROM proactive_checks WHERE agent_id=? AND state IN ('Notified','Snoozed') ORDER BY created_at DESC", (aid,)):
            if self.fresh(db, row):
                value = {k: row[k] for k in ('check_id', 'goal_id', 'state', 'message', 'next_step', 'reason', 'notified_at', 'due_at')}
                notices.append(value)
        recent = [{'check_id': r['check_id'], 'goal_id': r['goal_id'], 'state': r['state'], 'decision': r['decision'],
                   'error': r['error'], 'metadata': json.loads(r['metadata'])} for r in db.execute(
                       'SELECT * FROM proactive_checks WHERE agent_id=? ORDER BY created_at DESC LIMIT 8', (aid,))]
        return {'settings': settings, 'notices': notices, 'recent': recent}

    def execute(self, c):
        aid, p, kind = c['agent_id'], c['payload'], c['type']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind in ('GetProactivity', 'PreviewProactivityContext'):
                data = self.view(db, aid) if kind == 'GetProactivity' else [self.context(db, aid, gid) for gid in p['goal_ids']]
                return {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            if kind == 'SetGoalFollowupPolicy':
                goal = self.store.goals.target(db, aid, p['goal_id'])
                old_policy = self.followup_policy(db, aid, p['goal_id'])
                if old_policy['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Goal follow-up policy changed; reload it')
                if not p['silenced'] and goal['state'] != 'Active':
                    raise DomainError('Forbidden', 'Resume follow-up only for an active Goal')
                source = p.get('source_message_id')
                if source:
                    row = db.execute("SELECT m.* FROM messages m JOIN conversations c USING(conversation_id) WHERE m.message_id=? AND m.agent_id=? AND m.role='user' AND m.finality='final' AND c.status<>'Deleted'", (source, aid)).fetchone()
                    if not row or not row['content'].strip():
                        raise DomainError('NotFound', 'Review an available user message as the source')
                db.execute('INSERT OR REPLACE INTO goal_followup_policy VALUES (?,?,?,?,?,?)',
                           (p['goal_id'], aid, old_policy['revision']+1, int(p['silenced']), source, now()))
                db.execute("UPDATE proactive_checks SET state='Invalidated' WHERE agent_id=? AND goal_id=? AND state IN ('Pending','Thinking','Delayed','Snoozed','Notified')", (aid, p['goal_id']))
            elif kind == 'ConfigureProactivity':
                settings = self.settings(db, aid)
                if c['expected_revision'] != settings['revision']:
                    raise DomainError('RevisionConflict', 'Proactive permissions changed; reload them')
                if (p['think'] or p['notify']) and not p['observe']:
                    raise DomainError('Forbidden', 'Observation must be explicitly enabled first')
                if p['observe']:
                    preview = p['contexts']
                    current = [self.context(db, aid, gid) for gid in p['goal_ids']]
                    if preview != [v['references'] for v in current]:
                        raise DomainError('RevisionConflict', 'Review current selected Goal contexts before enabling observation')
                db.execute('INSERT OR REPLACE INTO proactive_settings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                           (aid, settings['revision']+1, int(p['observe']), int(p['think']), int(p['notify']), json.dumps(p['goal_ids']),
                            json.dumps(p['provider']), p['quiet_start'], p['quiet_end'], p['max_daily_calls'], p['max_daily_notifications'], p['cooldown_minutes']))
                # Configuration changes revoke delayed/in-flight work. No old alert is replayed on re-enable.
                db.execute("UPDATE proactive_checks SET state='Invalidated',context='{}',raw_output='',message='',next_step='',reason='' WHERE agent_id=? AND state IN ('Pending','Thinking','Delayed','Snoozed','Notified')", (aid,))
                erase_cached(db, {r[0] for r in db.execute('SELECT check_id FROM proactive_checks WHERE agent_id=?', (aid,))})
            else:
                row = db.execute('SELECT * FROM proactive_checks WHERE check_id=? AND agent_id=?', (p['check_id'], aid)).fetchone()
                if not row or row['state'] not in ('Notified', 'Snoozed') or not self.fresh(db, row):
                    raise DomainError('ContextStale', 'Notification is no longer current')
                state = {'DismissProactiveNotice': 'Dismissed', 'SnoozeProactiveNotice': 'Snoozed', 'HandleProactiveNotice': 'Handled'}[kind]
                due = (self.clock() + timedelta(minutes=p.get('minutes', 60))).isoformat() if state == 'Snoozed' else None
                db.execute('UPDATE proactive_checks SET state=?,due_at=? WHERE check_id=?', (state, due, row['check_id']))
            self.store.memory.event(db, kind, aid, {'check_id': p.get('check_id'), **({'goal_id': p['goal_id'], 'silenced': p['silenced'], 'source_message_id': p.get('source_message_id')} if kind == 'SetGoalFollowupPolicy' else {})}, c['command_id'], 'user')
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': self.view(db, aid)}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response

    def invalidate_goal(self, db, aid, gid):
        ids = {r[0] for r in db.execute('SELECT check_id FROM proactive_checks WHERE agent_id=? AND goal_id=?', (aid, gid))}
        db.execute("UPDATE proactive_checks SET state='Invalidated',context='{}',raw_output='',message='',reason='',next_step='' WHERE agent_id=? AND goal_id=?", (aid, gid))
        erase_cached(db, ids)

    def recover(self):
        with self.store.transaction() as db:
            db.execute("UPDATE proactive_checks SET state='Failed',error='RuntimeInterrupted' WHERE state='Thinking'")
