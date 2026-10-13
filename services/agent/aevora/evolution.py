"""Reviewed procedural methods. A method never supplies resources or authority."""
import json
from contextlib import closing

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached

FAMILY = 'preparation_update'
VERSION = 'method-learning-v2'
MIGRATION = (
    """CREATE TABLE method_proposals(proposal_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    source_run_id TEXT NOT NULL,source_feedback_revision INTEGER NOT NULL,source_deleted INTEGER NOT NULL DEFAULT 0,
    objective TEXT NOT NULL,criteria TEXT NOT NULL,experience TEXT NOT NULL,provider TEXT NOT NULL,
    base_active_id TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,method TEXT,
    raw_output TEXT NOT NULL DEFAULT '',metadata TEXT NOT NULL DEFAULT '{}',error TEXT,
    evaluation TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""",
    "ALTER TABLE tasks ADD COLUMN method_ref TEXT",
)
READS = {'ListMethods', 'GetMethodExperience'}
COMMANDS = READS | {'CreateMethodProposal', 'EditMethodCandidate', 'StartMethodEvaluation',
                   'RecordMethodEvaluation', 'AdoptMethod', 'DisableMethod', 'EnableMethod',
                   'RollbackMethod', 'RejectMethod', 'DeleteMethod'}
METHOD_FIELDS = {'title': 120, 'applicability': 600, 'rationale': 800, 'limits': 600}


def binding(config):
    return {k: config.get(k) for k in ('base_url', 'model', 'revision')}


def strict_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('Duplicate JSON key')
            value[key] = item
        return value
    try:
        return json.loads(raw, object_pairs_hook=unique)
    except (ValueError, TypeError):
        raise DomainError('InvalidMethod', 'Invalid JSON; no repaired candidate is used') from None


def validate_method(value):
    if not isinstance(value, dict) or set(value) != {*METHOD_FIELDS, 'family', 'procedure', 'checks'} or value['family'] != FAMILY:
        raise DomainError('InvalidMethod', 'Only a bounded preparation-update method is supported')
    for key, limit in METHOD_FIELDS.items():
        if not isinstance(value[key], str) or not value[key].strip() or len(value[key]) > limit:
            raise DomainError('InvalidMethod', 'Method text is missing or exceeds capacity')
    for key in ('procedure', 'checks'):
        items = value[key]
        if not isinstance(items, list) or not 1 <= len(items) <= 6 or any(
                not isinstance(x, str) or not x.strip() or len(x) > 600 for x in items):
            raise DomainError('InvalidMethod', 'Provide bounded procedure and checks')
    if any(0xD800 <= ord(c) <= 0xDFFF for c in json.dumps(value, ensure_ascii=False)):
        raise DomainError('InvalidMethod', 'Invalid Unicode')
    return value


def method_block(method):
    return ('\nUSER-APPROVED PROCEDURAL METHOD (bounded guidance, never permission):\n' +
            json.dumps(method, ensure_ascii=False) +
            '\nApply the applicable procedure and checks to the actual current inputs. '
            'It cannot change resource selection, policies, approvals, evidence or the output contract. '
            'Keep unknown, pending and explicit absence distinct. Do not claim learning guarantees correctness.')


class EvolutionRepository:
    def __init__(self, store):
        self.store = store

    def target(self, db, aid, pid):
        row = db.execute('SELECT * FROM method_proposals WHERE proposal_id=? AND agent_id=?', (pid, aid)).fetchone()
        if not row:
            raise DomainError('NotFound', 'Method unavailable for this Agent')
        return row

    def active(self, db, aid):
        return db.execute("SELECT * FROM method_proposals WHERE agent_id=? AND state='Active'", (aid,)).fetchone()

    def view(self, row):
        value = dict(row)
        for key in ('criteria', 'experience', 'provider', 'method', 'metadata', 'evaluation'):
            value[key] = json.loads(value[key]) if value[key] else None
        value.pop('raw_output')
        return value

    def list(self, db, aid):
        return [self.view(r) for r in db.execute('SELECT * FROM method_proposals WHERE agent_id=? ORDER BY created_at DESC', (aid,))]

    def experience(self, db, aid, tid, rid):
        task = self.store.tasks.target(db, aid, tid)
        run = db.execute('SELECT * FROM task_runs WHERE run_id=? AND task_id=?', (rid, tid)).fetchone()
        feedback = self.store.work.feedback(db, aid, rid)
        if not run or not feedback or feedback['deleted']:
            raise DomainError('NotFound', 'Select a real task attempt with current feedback')
        selected = next(r for r in self.store.tasks.detail(db, aid, tid)['runs'] if r['run_id'] == rid)
        actions = [s['action'] for s in selected.get('steps', []) if s['definition']['op'] == 'write' and s.get('action')] if task['kind'] != 'report' else [selected['action']] if selected['action'] else []
        receipts = []
        reviews = []
        for action in actions:
            editor = action.get('editor')
            if editor is None:
                edited = db.execute("SELECT 1 FROM events WHERE agent_id=? AND type='TaskBodyEdited' "
                                    "AND json_extract(payload,'$.run_id')=?", (aid, rid)).fetchone()
                editor = 'user' if edited else 'model'
            reviews.append({'editor': editor, 'state': action['state'],
                            'save_approved': action['state'] in ('Executing', 'Completed', 'NeedsAttention', 'NotExecuted')})
            if action['receipt']:
                receipts.append({k: action['receipt'][k] for k in ('outcome', 'bytes_written') if k in action['receipt']})
        active = self.active(db, aid)
        return {'task_id': tid, 'run_id': rid, 'title': task['title'], 'instruction': task['instruction'],
                'attempt_state': run['state'], 'historical_receipts': receipts,
                'applied_method_ref': json.loads(task['method_ref']) if task['method_ref'] else None,
                'body_reviews': reviews,
                'current_method': {'reference': self.reference(active), 'method': json.loads(active['method'])} if active else None,
                'feedback': {k: feedback[k] for k in ('run_id', 'revision', 'quality', 'note')}}

    def baseline_current(self, db, row):
        experience = row['experience']
        if isinstance(experience, str):
            experience = json.loads(experience)
        if 'baseline_method' not in experience:
            return True  # Historical candidates keep their original comparison contract.
        base, active = experience['baseline_method'], self.active(db, row['agent_id'])
        return bool(active and self.reference(active) == base['reference']) if base else active is None

    def proposal_current(self, db, row):
        return self.source_current(db, row) and self.baseline_current(db, row)

    def source_current(self, db, row):
        feedback = self.store.work.feedback(db, row['agent_id'], row['source_run_id'])
        return bool(feedback and not feedback['deleted'] and feedback['revision'] == row['source_feedback_revision'])

    def reference(self, row, mode='active'):
        return {'proposal_id': row['proposal_id'], 'revision': row['revision'], 'mode': mode}

    def resolve(self, db, aid, ref):
        row = self.target(db, aid, ref['proposal_id'])
        required = 'Active' if ref['mode'] == 'active' else 'Evaluating'
        if row['revision'] != ref['revision'] or row['state'] != required:
            raise DomainError('ContextStale', 'Reviewed method version changed or is unavailable')
        if required == 'Evaluating' and not self.proposal_current(db, row):
            raise DomainError('ContextStale', 'Learning feedback changed before evaluation')
        return json.loads(row['method'])

    def attach(self, db, c, tid):
        ref = c['payload'].get('method_ref')
        if not ref:
            return
        self.resolve(db, c['agent_id'], ref)
        task = self.store.tasks.target(db, c['agent_id'], tid)
        if task['kind'] != 'plan' or len(json.loads(task['sources'])) < 2 or len(json.loads(task['outputs'])) != 1:
            raise DomainError('Forbidden', 'This method requires a reviewed plan, at least two inputs and one output')
        if ref['mode'] == 'evaluation':
            row = self.target(db, c['agent_id'], ref['proposal_id'])
            original = db.execute('SELECT t.sources FROM tasks t JOIN task_runs r ON r.task_id=t.task_id WHERE r.run_id=?', (row['source_run_id'],)).fetchone()
            if original and set(json.loads(original[0])) & set(json.loads(task['sources'])):
                raise DomainError('Forbidden', 'Evaluation must use new resources, not learning materials')
        db.execute('UPDATE tasks SET method_ref=? WHERE task_id=?', (json.dumps(ref), tid))

    def check_task(self, db, task):
        if task['method_ref']:
            return self.resolve(db, task['agent_id'], json.loads(task['method_ref']))
        return None

    def check_plan(self, db, task, plan):
        if not task['method_ref']:
            return
        self.check_task(db, task)
        # A preparation update must actually read every selected source before synthesis.
        reads = {s['resource']: s['id'] for s in plan['steps'] if s['op'] == 'read'}
        expected = {f'source{i+1}' for i in range(len(json.loads(task['sources'])))}
        generates = [s for s in plan['steps'] if s['op'] == 'generate']
        if not expected <= set(reads) or len(generates) != 1 or not {reads[x] for x in expected} <= set(generates[0]['inputs']):
            raise DomainError('InvalidMethodPlan', 'Method needs all selected sources and one combined synthesis before reviewed writing')

    def invalidate_use(self, db, aid, pid, erase=False):
        affected = {pid}
        for row in db.execute('SELECT * FROM tasks WHERE agent_id=? AND json_extract(method_ref,\'$.proposal_id\')=?', (aid, pid)).fetchall():
            affected.add(row['task_id'])
            if row['state'] not in ('Completed', 'Executing', 'NeedsAttention', 'NotExecuted'):
                run = db.execute('SELECT context FROM task_runs WHERE run_id=?', (row['current_run_id'],)).fetchone()
                refs = json.loads(run[0]) | {'context_stale': True}
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(refs), row['current_run_id']))
                self.store.tasks.planned.state(db, row, 'Failed', 'ContextStale')
        for run in db.execute('SELECT run_id,context FROM runs WHERE agent_id=?', (aid,)).fetchall():
            refs = json.loads(run['context'])
            if refs.get('method_context', {}).get('proposal_id') == pid:
                refs['context_stale'] = True
                db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), run['run_id']))
                affected.add(run['run_id'])
        erase_cached(db, affected)

    def invalidate_dependents(self, db, aid, pid, erase=False, exclude=None):
        for dependent in db.execute('SELECT * FROM method_proposals WHERE agent_id=?', (aid,)).fetchall():
            if dependent['proposal_id'] == exclude or dependent['state'] == 'Deleted':
                continue
            experience = json.loads(dependent['experience'])
            if 'baseline_method' not in experience:
                continue
            related = dependent['base_active_id'] == pid
            if not related and self.baseline_current(db, dependent):
                continue
            independent = dependent['state'] in ('Active', 'Disabled', 'RolledBack')
            erase_baseline = erase and related
            if independent and not erase_baseline:
                continue
            if dependent['state'] == 'Invalidated' and not erase_baseline:
                continue
            if erase_baseline:
                experience.pop('baseline_method')
            db.execute("UPDATE method_proposals SET experience=?,state=?,revision=revision+1,updated_at=?,"
                       "raw_output=CASE WHEN ? THEN '' ELSE raw_output END,"
                       "method=CASE WHEN ? THEN NULL ELSE method END,evaluation=CASE WHEN ? THEN NULL ELSE evaluation END WHERE proposal_id=?",
                       (json.dumps(experience), dependent['state'] if independent else 'Invalidated', now(),
                        erase_baseline, erase_baseline and not independent, erase_baseline and not independent, dependent['proposal_id']))
            self.invalidate_use(db, aid, dependent['proposal_id'], erase_baseline)

    def feedback_changed(self, db, aid, rid, delete_methods=False):
        for row in db.execute('SELECT * FROM method_proposals WHERE agent_id=? AND source_run_id=?', (aid, rid)).fetchall():
            if row['state'] == 'Deleted':
                continue
            adopted = row['state'] in ('Active', 'Disabled', 'RolledBack')
            state = 'Deleted' if delete_methods else row['state'] if adopted else 'Invalidated'
            db.execute("UPDATE method_proposals SET source_deleted=1,experience='{}',raw_output='',state=?,"
                       "method=CASE WHEN ? THEN NULL ELSE method END,evaluation=CASE WHEN ? THEN NULL ELSE evaluation END,"
                       "revision=revision+1,updated_at=? WHERE proposal_id=?",
                       (state, delete_methods or not adopted, delete_methods or not adopted, now(), row['proposal_id']))
            # Preserve independently adopted general methods, but invalidate pending version bindings.
            self.invalidate_use(db, aid, row['proposal_id'], True)
            self.invalidate_dependents(db, aid, row['proposal_id'], erase=delete_methods)

    def evaluation(self, db, aid, row, p):
        values = []
        for role in ('baseline', 'candidate', 'retention'):
            task = self.store.tasks.target(db, aid, p[role + '_task_id'])
            run = db.execute('SELECT * FROM task_runs WHERE run_id=?', (task['current_run_id'],)).fetchone()
            if task['state'] != 'Completed' or run['state'] != 'Completed':
                raise DomainError('Forbidden', 'Evaluation requires actual completed attempts and a separate quality assessment')
            values.append((task, run))
        baseline, candidate, retention = [v[0] for v in values]
        if len({t['task_id'] for t, _ in values}) != 3 or retention['method_ref']:
            raise DomainError('Forbidden', 'Use separate baseline, candidate and unaffected old-ability tasks')
        experience = json.loads(row['experience'])
        base = experience.get('baseline_method')
        expected_baseline = base['reference'] if base else None
        actual_baseline = json.loads(baseline['method_ref']) if baseline['method_ref'] else None
        if actual_baseline != expected_baseline:
            raise DomainError('Forbidden', 'Baseline must use the reviewed adopted version, or no method for initial learning')
        if base:
            self.resolve(db, aid, expected_baseline)
        if baseline['sources'] != candidate['sources'] or baseline['instruction'] != candidate['instruction']:
            raise DomainError('Forbidden', 'Compare identical new inputs and user requirements')
        if not candidate['method_ref'] or json.loads(candidate['method_ref']) != self.reference(row, 'evaluation'):
            raise DomainError('Forbidden', 'Candidate task must use this evaluated version')
        self.resolve(db, aid, json.loads(candidate['method_ref']))
        contexts = [json.loads(r['context']) for _, r in values]
        if any(contexts[0].get(k) != contexts[1].get(k) for k in ('provider', 'persona_revision', 'memory_revision_ids')):
            raise DomainError('Forbidden', 'Model, Persona and Memory must be equal in the comparison')
        if contexts[0].get('current_work', {}).get('confirmed_goal') != contexts[1].get('current_work', {}).get('confirmed_goal'):
            raise DomainError('Forbidden', 'Compare the same confirmed Goal facts')
        originals = []
        for t, r in values:
            edited = db.execute("SELECT 1 FROM task_steps s JOIN step_actions a ON a.step_id=s.step_id WHERE s.run_id=? AND a.editor='user'", (r['run_id'],)).fetchone()
            if t['kind'] == 'report':
                edited = db.execute("SELECT 1 FROM events WHERE type='TaskBodyEdited' AND json_extract(payload,'$.run_id')=?", (r['run_id'],)).fetchone()
            originals.append(not bool(edited))
        checks = p['checks']
        if len(checks) != len(json.loads(row['criteria'])):
            raise DomainError('ValidationError', 'Assess every predeclared criterion')
        if not all(originals) and (p['improved'] or p['no_regression']):
            raise DomainError('Forbidden', 'User-repaired outputs cannot prove original method improvement')
        return {'tasks': {role: {'task_id': t['task_id'], 'run_id': r['run_id'], 'original_unedited': original}
                          for role, (t, r), original in zip(('baseline', 'candidate', 'retention'), values, originals)},
                'checks': checks, 'improved': p['improved'], 'no_regression': p['no_regression'],
                'reviewer': p['reviewer'], 'note': p['note'], 'recorded_at': now()}

    def execute(self, c):
        aid, p, kind = c['agent_id'], c['payload'], c['type']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            if kind in READS:
                data = self.list(db, aid) if kind == 'ListMethods' else self.experience(db, aid, p['task_id'], p['run_id'])
                return {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            old = cached(db, c, serialized)
            if old is not None:
                return old
            pid = c['command_id'] if kind == 'CreateMethodProposal' else p['proposal_id']
            if kind == 'CreateMethodProposal':
                experience = self.experience(db, aid, p['task_id'], p['run_id'])
                if experience['feedback']['revision'] != p['feedback_revision']:
                    raise DomainError('RevisionConflict', 'Review current feedback before learning')
                active = self.active(db, aid)
                expected = self.reference(active) if active else None
                if p.get('base_method_ref') != expected:
                    raise DomainError('RevisionConflict', 'Review the current adopted method before proposing its revision')
                experience['baseline_method'] = experience.pop('current_method')
                db.execute('INSERT INTO method_proposals(proposal_id,agent_id,source_run_id,source_feedback_revision,objective,criteria,experience,provider,base_active_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,\'Generating\',?,?)',
                           (pid, aid, p['run_id'], p['feedback_revision'], p['objective'], json.dumps(p['criteria']), json.dumps(experience), json.dumps(p['provider']), active['proposal_id'] if active else None, now(), now()))
            else:
                row = self.target(db, aid, pid)
                if row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Method changed; reload it')
                if kind in ('EditMethodCandidate', 'StartMethodEvaluation', 'RecordMethodEvaluation', 'AdoptMethod') and not self.proposal_current(db, row):
                    raise DomainError('ContextStale', 'Learning feedback or reviewed baseline changed; candidate cannot be adopted')
                state = row['state']
                if kind == 'EditMethodCandidate':
                    if state not in ('Proposed', 'Evaluating', 'Eligible', 'FailedEvaluation'):
                        raise DomainError('Forbidden', 'Only an unadopted candidate can be edited')
                    method = validate_method(p['method'])
                    db.execute("UPDATE method_proposals SET method=?,state='Proposed',evaluation=NULL WHERE proposal_id=?", (json.dumps(method), pid))
                elif kind == 'StartMethodEvaluation':
                    if state != 'Proposed':
                        raise DomainError('Forbidden', 'Only a proposed method can enter independent evaluation')
                    db.execute("UPDATE method_proposals SET state='Evaluating',evaluation=NULL WHERE proposal_id=?", (pid,))
                elif kind == 'RecordMethodEvaluation':
                    if state != 'Evaluating':
                        raise DomainError('Forbidden', 'No current independent evaluation')
                    evaluation = self.evaluation(db, aid, row, p)
                    eligible = p['improved'] and p['no_regression'] and all(p['checks'])
                    db.execute('UPDATE method_proposals SET state=?,evaluation=? WHERE proposal_id=?', ('Eligible' if eligible else 'FailedEvaluation', json.dumps(evaluation), pid))
                elif kind in ('AdoptMethod', 'EnableMethod'):
                    if state != ('Eligible' if kind == 'AdoptMethod' else 'Disabled'):
                        raise DomainError('Forbidden', 'Method needs completed evaluation and explicit approval')
                    active = self.active(db, aid)
                    if kind == 'AdoptMethod' and (active['proposal_id'] if active else None) != row['base_active_id']:
                        raise DomainError('RevisionConflict', 'Active method changed since proposal creation')
                    if active:
                        db.execute("UPDATE method_proposals SET state='Disabled',revision=revision+1 WHERE proposal_id=?", (active['proposal_id'],))
                        self.invalidate_use(db, aid, active['proposal_id'])
                        self.invalidate_dependents(db, aid, active['proposal_id'], exclude=pid)
                    db.execute("UPDATE method_proposals SET state='Active' WHERE proposal_id=?", (pid,))
                elif kind == 'DisableMethod':
                    if state != 'Active':
                        raise DomainError('Forbidden', 'Method is not active')
                    db.execute("UPDATE method_proposals SET state='Disabled' WHERE proposal_id=?", (pid,))
                elif kind == 'RollbackMethod':
                    if state != 'Active':
                        raise DomainError('Forbidden', 'Only the current active method can be rolled back')
                    db.execute("UPDATE method_proposals SET state='RolledBack' WHERE proposal_id=?", (pid,))
                    previous = db.execute("SELECT * FROM method_proposals WHERE proposal_id=? AND agent_id=? AND state='Disabled' AND method IS NOT NULL", (row['base_active_id'], aid)).fetchone()
                    if previous:
                        db.execute("UPDATE method_proposals SET state='Active',revision=revision+1,updated_at=? WHERE proposal_id=?", (now(), previous['proposal_id']))
                elif kind == 'RejectMethod':
                    if state in ('Active', 'Disabled', 'RolledBack', 'Deleted'):
                        raise DomainError('Forbidden', 'Reject only an unadopted candidate')
                    db.execute("UPDATE method_proposals SET state='Rejected' WHERE proposal_id=?", (pid,))
                elif kind == 'DeleteMethod':
                    db.execute("UPDATE method_proposals SET state='Deleted',method=NULL,experience='{}',raw_output='',evaluation=NULL,objective='',criteria='[]' WHERE proposal_id=?", (pid,))
                db.execute('UPDATE method_proposals SET revision=revision+1,updated_at=? WHERE proposal_id=?', (now(), pid))
                self.invalidate_use(db, aid, pid, kind == 'DeleteMethod')
                if kind in ('AdoptMethod', 'EnableMethod', 'DisableMethod', 'RollbackMethod', 'DeleteMethod'):
                    self.invalidate_dependents(db, aid, pid, erase=kind == 'DeleteMethod')
                if kind == 'RollbackMethod' and previous:
                    self.invalidate_dependents(db, aid, previous['proposal_id'])
            self.store.memory.event(db, kind, aid, {'proposal_id': pid}, c['command_id'], 'user')
            data = self.view(self.target(db, aid, pid))
            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
            return response

    def recover(self):
        with self.store.transaction() as db:
            db.execute("UPDATE method_proposals SET state='Failed',error='RuntimeInterrupted',revision=revision+1 WHERE state='Generating'")
