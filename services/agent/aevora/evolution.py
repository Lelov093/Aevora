"""Reviewed procedural methods. A method never supplies resources or authority."""
import json
from contextlib import closing

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached

FAMILY = 'preparation_update'
FAMILIES = {FAMILY, 'collaboration', 'communication'}
VERSION = 'method-learning-v4'
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
                   'RollbackMethod', 'RejectMethod', 'DeleteMethod', 'CreateConversationMethodProposal',
                   'RecordInteractionMethodEvaluation'}
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
    if not isinstance(value, dict) or set(value) != {*METHOD_FIELDS, 'family', 'procedure', 'checks'} or value['family'] not in FAMILIES:
        raise DomainError('InvalidMethod', 'Use a supported bounded work or communication strategy')
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

    def active(self, db, aid, family=FAMILY):
        return db.execute("SELECT * FROM method_proposals WHERE agent_id=? AND state='Active' AND family=? ORDER BY rowid DESC", (aid, family)).fetchone()

    def active_methods(self, db, aid, family=None):
        return db.execute("SELECT * FROM method_proposals WHERE agent_id=? AND state='Active' AND (? IS NULL OR family=?) ORDER BY rowid", (aid, family, family)).fetchall()

    def check_context(self, db, aid, context):
        for ref in context.get('interaction_methods', []) + context.get('available_work_methods', []):
            self.resolve(db, aid, ref)
        if context.get('method_context'):
            self.resolve(db, aid, context['method_context'])

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
        actions = [s['action'] for s in selected.get('steps', []) if s['definition']['op'] in ('write','office_propose','text_propose','write_file','manage_files','run_command') and s.get('action')] if task['kind'] != 'report' else [selected['action']] if selected['action'] else []
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
        value = {'task_id': tid, 'run_id': rid, 'title': task['title'], 'instruction': task['instruction'],
                'attempt_state': run['state'], 'historical_receipts': receipts,
                'applied_method_ref': json.loads(task['method_ref']) if task['method_ref'] else None,
                'body_reviews': reviews,
                'current_method': {'reference': self.reference(active), 'method': json.loads(active['method'])} if active else None,
                'feedback': {k: feedback[k] for k in ('run_id', 'revision', 'quality', 'note')}}
        if task['kind']=='agent':
            value['action_observations']=[{'op':s['definition']['op'],'action':{k:v for k,v in s['definition'].items() if k not in ('id','url','question','changes')},'state':s['state'],'error':s.get('error'),'observation':{k:({a:b for a,b in s['result'][k].items() if a!='changes'} if k=='receipt' else s['result'][k]) for k in ('status','start','end','total_characters','complete','receipt','editor','outcome','version','range_complete') if k in s['result']}} for s in selected['steps']]
            from .general_actions import OPS, experience_step
            value['action_observations'] = [experience_step(s) if s['definition']['op'] in OPS else v for s, v in zip(selected['steps'], value['action_observations'])]
            value['final_reply']=selected.get('reply')
        return value

    def baseline_current(self, db, row):
        experience = row['experience']
        if isinstance(experience, str):
            experience = json.loads(experience)
        if 'baseline_method' not in experience:
            return True  # Historical candidates keep their original comparison contract.
        base = experience['baseline_method']
        if base:
            active = db.execute("SELECT * FROM method_proposals WHERE proposal_id=? AND agent_id=? AND state='Active'", (base['reference']['proposal_id'], row['agent_id'])).fetchone()
            return bool(active and self.reference(active) == base['reference'])
        return self.active(db, row['agent_id']) is None if row['family'] == FAMILY else True

    def proposal_current(self, db, row):
        return self.source_current(db, row) and self.baseline_current(db, row)

    def source_current(self, db, row):
        if row['source_kind'] == 'conversation':
            try:
                experience = self.store.interaction_learning.experience(db, row['agent_id'], row['source_run_id'])
                if not experience['learning_source_current']:
                    return False
                feedback = experience['feedback']
            except DomainError:
                return False
        else:
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
        method = self.resolve(db, c['agent_id'], ref)
        task = self.store.tasks.target(db, c['agent_id'], tid)
        dynamic = task['kind'] == 'agent' and method['family'] == 'collaboration'
        if not dynamic and (method['family'] == 'communication' or task['kind'] != 'plan' or len(json.loads(task['sources'])) < (2 if method['family'] == FAMILY else 1) or len(json.loads(task['outputs'])) != 1):
            raise DomainError('Forbidden', 'Select a work method for a reviewed plan with suitable inputs and one output')
        if ref['mode'] == 'evaluation':
            row = self.target(db, c['agent_id'], ref['proposal_id'])
            original = db.execute('SELECT t.sources FROM tasks t JOIN task_runs r ON r.task_id=t.task_id WHERE r.run_id=?', (row['source_run_id'],)).fetchone()
            if original and set(json.loads(original[0])) & set(json.loads(task['sources'])):
                raise DomainError('Forbidden', 'Evaluation must use new resources, not learning materials')
            if dynamic:
                learning = db.execute('SELECT t.instruction FROM tasks t JOIN task_runs r ON r.task_id=t.task_id WHERE r.run_id=?', (row['source_run_id'],)).fetchone()
                if learning and task['instruction'] == learning[0]:
                    raise DomainError('Forbidden', 'Evaluate a new request, not the learning request')
        db.execute('UPDATE tasks SET method_ref=? WHERE task_id=?', (json.dumps(ref), tid))

    def check_task(self, db, task):
        if task['method_ref']:
            return self.resolve(db, task['agent_id'], json.loads(task['method_ref']))
        return None

    def check_plan(self, db, task, plan):
        if not task['method_ref']:
            return
        method = self.check_task(db, task)
        if method['family'] != FAMILY:
            return
        # A preparation update must actually read every selected source before synthesis.
        reads = {s['resource']: s['id'] for s in plan['steps'] if s['op'] == 'read'}
        expected = {f'source{i+1}' for i in range(len(json.loads(task['sources'])))}
        generates = [s for s in plan['steps'] if s['op'] == 'generate']
        if not expected <= set(reads) or len(generates) != 1 or not {reads[x] for x in expected} <= set(generates[0]['inputs']):
            raise DomainError('InvalidMethodPlan', 'Method needs all selected sources and one combined synthesis before reviewed writing')

    def invalidate_use(self, db, aid, pid, erase=False):
        from .agent_context import erase_task
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
            linked = [refs.get('method_context', {})] + refs.get('interaction_methods', []) + refs.get('available_work_methods', [])
            if any(r.get('proposal_id') == pid for r in linked):
                refs['context_stale'] = True
                if erase:
                    refs['context_erased'] = True
                    refs.pop('interaction_trial', None)
                    db.execute("UPDATE messages SET content='' WHERE run_id=? AND role='assistant'", (run['run_id'],))
                    self.store.memory.event(db, 'MethodContextErased', aid, {'run_id': run['run_id'], 'proposal_id': pid}, actor='evolution')
                db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), run['run_id']))
                affected.add(run['run_id'])
        for run in db.execute('SELECT r.run_id,r.context,r.task_id,t.method_ref,t.current_run_id,t.state FROM task_runs r JOIN tasks t USING(task_id) WHERE t.agent_id=?', (aid,)).fetchall():
            refs = json.loads(run['context'])
            linked = refs.get('interaction_methods', []) + ([json.loads(run['method_ref'])] if run['method_ref'] else [])
            if not any(ref.get('proposal_id') == pid for ref in linked):
                continue
            refs['context_stale'] = True
            db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(refs), run['run_id']))
            if erase:
                erase_task(db, run['run_id'])
            if run['current_run_id'] == run['run_id'] and run['state'] not in ('Completed','Failed','Cancelled','Executing','NeedsAttention','NotExecuted'):
                self.store.tasks.planned.state(db, self.store.tasks.target(db, aid, run['task_id']), 'Failed', 'ContextStale')
            affected.update((run['task_id'], run['run_id']))
        self.store.executions.invalidate_refs(db, aid, method_id=pid, erase=erase)
        erase_cached(db, affected)

    def invalidate_dependents(self, db, aid, pid, erase=False, exclude=None):
        for dependent in db.execute('SELECT * FROM method_proposals WHERE agent_id=?', (aid,)).fetchall():
            if dependent['proposal_id'] == exclude or dependent['state'] == 'Deleted':
                continue
            experience = json.loads(dependent['experience'])
            if 'baseline_method' not in experience:
                continue
            related = dependent['base_active_id'] == pid
            legacy_changed = dependent['family'] == FAMILY and self.target(db, aid, pid)['family'] == FAMILY and not self.baseline_current(db, dependent)
            if not related and not legacy_changed:
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
            self.store.interaction_learning.erase_comparisons(db, aid, row['proposal_id'])
            self.invalidate_dependents(db, aid, row['proposal_id'], erase=delete_methods)

    def source_context_changed(self, db, aid, rid, erase=False):
        if erase:
            self.feedback_changed(db, aid, rid)
            return
        for row in db.execute('SELECT * FROM method_proposals WHERE agent_id=? AND source_run_id=?', (aid, rid)).fetchall():
            if row['state'] in ('Active', 'Disabled', 'RolledBack', 'Deleted', 'Invalidated'):
                continue
            db.execute("UPDATE method_proposals SET state='Invalidated',revision=revision+1,updated_at=? WHERE proposal_id=?", (now(), row['proposal_id']))
            self.invalidate_use(db, aid, row['proposal_id'])
            self.invalidate_dependents(db, aid, row['proposal_id'])

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
        if baseline['kind'] != candidate['kind'] or (baseline['kind']=='agent' and (baseline['agent_limits'] != candidate['agent_limits'] or [o['label'] for o in json.loads(baseline['outputs'])] != [o['label'] for o in json.loads(candidate['outputs'])])):
            raise DomainError('Forbidden', 'Compare the same execution kind and authorized limits')
        if not candidate['method_ref'] or json.loads(candidate['method_ref']) != self.reference(row, 'evaluation'):
            raise DomainError('Forbidden', 'Candidate task must use this evaluated version')
        self.resolve(db, aid, json.loads(candidate['method_ref']))
        contexts = [json.loads(r['context']) for _, r in values]
        if any(contexts[0].get(k) != contexts[1].get(k) for k in ('provider', 'persona_revision', 'memory_revision_ids', 'interaction_methods', 'search_revision')):
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
            creating = kind in ('CreateMethodProposal', 'CreateConversationMethodProposal')
            pid = c['command_id'] if creating else p['proposal_id']
            if creating:
                dialogue = kind == 'CreateConversationMethodProposal'
                family = 'communication' if dialogue else p.get('family', FAMILY)
                if family not in FAMILIES or (not dialogue and family == 'communication'):
                    raise DomainError('InvalidMethod', 'Communication strategies need interaction feedback')
                experience = self.store.interaction_learning.experience(db, aid, p['run_id']) if dialogue else self.experience(db, aid, p['task_id'], p['run_id'])
                if dialogue and not experience['learning_source_current']:
                    raise DomainError('ContextStale', 'The understanding used by this reply was corrected; learn from a current exchange')
                if dialogue and (not experience['feedback'] or experience['feedback']['deleted'] or experience['feedback']['category'] != 'Strategy'):
                    raise DomainError('Forbidden', 'Facts, preferences and temporary states are not reusable strategies')
                if not dialogue and 'action_observations' in experience and family!='collaboration':
                    raise DomainError('Forbidden', 'Action experiences require the collaboration strategy family')
                if experience['feedback']['revision'] != p['feedback_revision']:
                    raise DomainError('RevisionConflict', 'Review current feedback before learning')
                active = self.active(db, aid) if family == FAMILY else self.target(db, aid, p['base_method_ref']['proposal_id']) if p.get('base_method_ref') else None
                if active and (active['family'] != family or active['state'] != 'Active'):
                    raise DomainError('Forbidden', 'Revise an active method of the same family')
                expected = self.reference(active) if active else None
                if p.get('base_method_ref') != expected:
                    raise DomainError('RevisionConflict', 'Review the current adopted method before proposing its revision')
                experience.pop('current_method', None)
                experience['baseline_method'] = {'reference': self.reference(active), 'method': json.loads(active['method'])} if active else None
                db.execute('INSERT INTO method_proposals(proposal_id,agent_id,source_run_id,source_feedback_revision,objective,criteria,experience,provider,base_active_id,state,created_at,updated_at,family,source_kind) VALUES (?,?,?,?,?,?,?,?,?,\'Generating\',?,?,?,?)',
                           (pid, aid, p['run_id'], p['feedback_revision'], p['objective'], json.dumps(p['criteria']), json.dumps(experience), json.dumps(p['provider']), active['proposal_id'] if active else None, now(), now(), family, 'conversation' if dialogue else 'task'))
            else:
                row = self.target(db, aid, pid)
                if row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Method changed; reload it')
                if kind in ('EditMethodCandidate', 'StartMethodEvaluation', 'RecordMethodEvaluation', 'RecordInteractionMethodEvaluation', 'AdoptMethod') and not self.proposal_current(db, row):
                    raise DomainError('ContextStale', 'Learning feedback or reviewed baseline changed; candidate cannot be adopted')
                state = row['state']
                if kind == 'EditMethodCandidate':
                    if state not in ('Proposed', 'Evaluating', 'Eligible', 'FailedEvaluation'):
                        raise DomainError('Forbidden', 'Only an unadopted candidate can be edited')
                    method = validate_method(p['method'])
                    if method['family'] != row['family']:
                        raise DomainError('InvalidMethod', 'Candidate editing cannot change its learning family')
                    db.execute("UPDATE method_proposals SET method=?,state='Proposed',evaluation=NULL WHERE proposal_id=?", (json.dumps(method), pid))
                elif kind == 'StartMethodEvaluation':
                    if state != 'Proposed':
                        raise DomainError('Forbidden', 'Only a proposed method can enter independent evaluation')
                    db.execute("UPDATE method_proposals SET state='Evaluating',evaluation=NULL WHERE proposal_id=?", (pid,))
                elif kind == 'RecordMethodEvaluation':
                    if row['family'] == 'communication':
                        raise DomainError('Forbidden', 'Communication strategies require interaction comparisons')
                    if state != 'Evaluating':
                        raise DomainError('Forbidden', 'No current independent evaluation')
                    evaluation = self.evaluation(db, aid, row, p)
                    eligible = p['improved'] and p['no_regression'] and all(p['checks'])
                    db.execute('UPDATE method_proposals SET state=?,evaluation=? WHERE proposal_id=?', ('Eligible' if eligible else 'FailedEvaluation', json.dumps(evaluation), pid))
                elif kind == 'RecordInteractionMethodEvaluation':
                    from .interaction_evaluation import record_evaluation
                    if state != 'Evaluating' or row['family'] != 'communication':
                        raise DomainError('Forbidden', 'No current communication strategy evaluation')
                    evaluation = record_evaluation(self.store, db, aid, row, p)
                    eligible = p['improved'] and p['no_regression'] and all(p['checks'])
                    db.execute('UPDATE method_proposals SET state=?,evaluation=? WHERE proposal_id=?', ('Eligible' if eligible else 'FailedEvaluation', json.dumps(evaluation), pid))
                elif kind in ('AdoptMethod', 'EnableMethod'):
                    if state != ('Eligible' if kind == 'AdoptMethod' else 'Disabled'):
                        raise DomainError('Forbidden', 'Method needs completed evaluation and explicit approval')
                    if kind == 'AdoptMethod' and row['family'] == 'communication':
                        from .interaction_evaluation import context_current
                        evaluation = json.loads(row['evaluation'])
                        comparison = db.execute('SELECT context,state FROM interaction_comparisons WHERE comparison_id=? AND agent_id=?', (evaluation['comparison_id'], aid)).fetchone()
                        if not comparison or comparison['state'] != 'Completed' or not context_current(self.store, db, aid, json.loads(comparison['context'])):
                            raise DomainError('ContextStale', 'Applicable strategies or identity changed after evaluation')
                    active = self.active(db, aid) if row['family'] == FAMILY else db.execute("SELECT * FROM method_proposals WHERE proposal_id=? AND agent_id=? AND state='Active'", (row['base_active_id'], aid)).fetchone()
                    if kind == 'AdoptMethod' and (active['proposal_id'] if active else None) != row['base_active_id']:
                        raise DomainError('RevisionConflict', 'Active method changed since proposal creation')
                    if active and active['proposal_id'] != pid:
                        db.execute("UPDATE method_proposals SET state='Disabled',revision=revision+1 WHERE proposal_id=?", (active['proposal_id'],))
                        self.invalidate_use(db, aid, active['proposal_id'])
                        self.invalidate_dependents(db, aid, active['proposal_id'], exclude=pid)
                    if not active and len(self.active_methods(db, aid)) >= 8:
                        raise DomainError('BudgetExceeded', 'Keep at most eight active methods; disable an unused one first')
                    metadata = json.loads(row['metadata']) | {'allow_full_outbound': bool(p['allow_method_outbound'])}
                    db.execute("UPDATE method_proposals SET state='Active',metadata=? WHERE proposal_id=?", (json.dumps(metadata), pid))
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
                        if row['family'] == FAMILY and self.active(db, aid):
                            raise DomainError('RevisionConflict', 'Another preparation method is already active')
                        db.execute("UPDATE method_proposals SET state='Active',revision=revision+1,updated_at=? WHERE proposal_id=?", (now(), previous['proposal_id']))
                elif kind == 'RejectMethod':
                    if state in ('Active', 'Disabled', 'RolledBack', 'Deleted'):
                        raise DomainError('Forbidden', 'Reject only an unadopted candidate')
                    db.execute("UPDATE method_proposals SET state='Rejected' WHERE proposal_id=?", (pid,))
                elif kind == 'DeleteMethod':
                    db.execute("UPDATE method_proposals SET state='Deleted',method=NULL,experience='{}',raw_output='',evaluation=NULL,objective='',criteria='[]' WHERE proposal_id=?", (pid,))
                    self.store.interaction_learning.erase_comparisons(db, aid, pid)
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
            db.execute("UPDATE interaction_comparisons SET state='Failed',error='RuntimeInterrupted' WHERE state='Running'")
