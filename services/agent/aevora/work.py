"""Conversation work suggestions and user feedback; neither is execution authority."""
import json
import re

from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached

VERSION = 'chat-work-v1'
PROMPT = '''You may propose work, never execute it. Return one JSON object, reply first:
{"reply":"natural answer in the user's language", "suggestion":null}
For an explicit file task, suggestion may be {"kind":"file_task","title":"short title","instruction":"complete user requirements including relevant confirmed preferences"}.
For a user wanting a new continuing objective, suggestion may be {"kind":"goal","title":"short title","objective":"objective","success_criteria":"user-reviewable criteria","next_step":"next step"}.
For a change to the explicitly selected current Goal, suggestion may be {"kind":"goal_next_step","next_step":"proposed next step"}.
Only ONE suggestion or null. Ordinary conversation and missing essential requirements use null; ask a useful clarification in reply. Do not invent missing details, resources, paths, dates or approvals. A file suggestion prepares a task for user resource selection; it cannot read files or promise execution. The native file workflow currently reads only selected UTF-8 .md/.txt text and creates new .md/.txt outputs. It cannot read/extract PDFs, images or Office files. For a clear request to summarize a PDF, explain that limitation and offer file_task to summarize text extracted by the user, preserving the requested deliverable and identifying that text selection is still required. Never imply the PDF itself was read or that unrelated notes or general knowledge are its complete contents. This is a local application with an authorized task workflow, not a simulated environment. When the requested deliverable and requirements are clear, offer file_task even if the user will select files later. Missing paths, output location and resource permission belong to the next user form, not chat clarification; do not ask users to paste paths into chat. New or updated material may justify new work after a completed Task; preserve the current feedback and distinguish this update from repeating the old work. Do not propose recreating work when current evidence shows it already exists: address waiting/Unknown work first. Goal creation and updates require user confirmation. No reminder, network or other tool suggestion is supported. Do not output any other keys or markdown fences. Never claim a suggestion was executed. User feedback is user assessment, not tool evidence or authorization.'''
MIGRATION = (
    """CREATE TABLE work_responses(run_id TEXT PRIMARY KEY REFERENCES runs(run_id),agent_id TEXT NOT NULL,
        raw_output TEXT NOT NULL,suggestion TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,
        task_id TEXT REFERENCES tasks(task_id),goal_id TEXT REFERENCES goals(goal_id))""",
    """CREATE TABLE task_feedback(run_id TEXT PRIMARY KEY REFERENCES task_runs(run_id),task_id TEXT NOT NULL REFERENCES tasks(task_id),
        agent_id TEXT NOT NULL,revision INTEGER NOT NULL,note TEXT NOT NULL,quality TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)""",
)
COMMANDS = {'PrepareFileWork', 'RejectWorkSuggestion', 'SaveTaskFeedback', 'DeleteTaskFeedback'}


def reply_prefix(raw):
    """Only display the first JSON string, without exposing the pending suggestion."""
    start = re.match(r'^\s*\{\s*"reply"\s*:\s*"', raw)
    if not start:
        return ''
    output, i = [], start.end()
    while i < len(raw):
        ch = raw[i]
        if ch == '"':
            break
        if ch == '\\':
            if i + 1 >= len(raw):
                break
            length = 6 if raw[i+1] == 'u' else 2
            if i + length > len(raw):
                break
            try:
                value = json.loads('"' + raw[i:i+length] + '"')
                if len(value) == 1 and 0xD800 <= ord(value) <= 0xDBFF:
                    if i + 12 > len(raw):
                        break
                    value = json.loads('"' + raw[i:i+12] + '"')
                    if len(value) != 1:
                        break
                    length = 12
                if any(0xD800 <= ord(c) <= 0xDFFF for c in value):
                    break
            except ValueError:
                break
            output.append(value)
            i += length
        elif ord(ch) < 32:
            break
        else:
            output.append(ch)
            i += 1
    return ''.join(output)


def decode(raw):
    def unique(pairs):
        result = {}
        for k, v in pairs:
            if k in result:
                raise ValueError('Duplicate key')
            result[k] = v
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {'reply', 'suggestion'}:
            raise ValueError()
        text = value['reply']
        if not isinstance(text, str) or not text.strip() or len(text) > 32768:
            raise ValueError()
        suggestion = value['suggestion']
        if suggestion is not None:
            fields = {'file_task': {'title': 120, 'instruction': 4000},
                      'goal': {'title': 120, 'objective': 2000, 'success_criteria': 1000, 'next_step': 1000},
                      'goal_next_step': {'next_step': 1000}}
            if not isinstance(suggestion, dict) or suggestion.get('kind') not in fields:
                raise ValueError()
            sizes = fields[suggestion['kind']]
            optional = {'skill_id'} if suggestion['kind'] == 'file_task' else set()
            if not {'kind', *sizes} <= set(suggestion) or set(suggestion) - {'kind', *sizes} - optional or any(not isinstance(suggestion[k], str)
                or not suggestion[k].strip() or len(suggestion[k]) > limit
                or any(0xD800 <= ord(ch) <= 0xDFFF for ch in suggestion[k]) for k, limit in sizes.items()):
                raise ValueError()
            if 'skill_id' in suggestion and (not isinstance(suggestion['skill_id'], str) or not 1 <= len(suggestion['skill_id']) <= 128):
                raise ValueError()
        if any(0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError()
        return text, suggestion
    except (ValueError, TypeError):
        raise DomainError('InvalidWorkSuggestion', 'Work response was invalid; no actionable suggestion saved') from None


class WorkRepository:
    def __init__(self, store):
        self.store = store

    def source_text(self, db, run):
        row = db.execute("SELECT content FROM messages WHERE message_id=? AND conversation_id=? AND role='user' AND finality='final'", (run['input_message_id'], run['conversation_id'])).fetchone()
        return row[0] if row else ''

    def capture(self, db, run, raw, completed):
        suggestion = decode(raw)[1] if completed else None
        if suggestion and suggestion.get('skill_id'):
            ref = run['context'].get('method_context')
            if not ref or ref['proposal_id'] != suggestion['skill_id']:
                raise DomainError('InvalidWorkSuggestion', 'Method suggestion did not match the authorized current method')
            self.store.evolution.resolve(db, run['agent_id'], ref)
        db.execute('INSERT OR REPLACE INTO work_responses VALUES (?,?,?,?,?,0,NULL,NULL)',
                   (run['run_id'], run['agent_id'], raw, json.dumps(suggestion) if suggestion else None,
                    'Pending' if suggestion else 'None' if completed else 'Invalid'))

    def current(self, db, aid, rid):
        run = self.store.conversation.run(db, aid, rid)
        self.store.conversation.target(db, aid, run['conversation_id'])
        refs = run['context']
        if run['state'] != 'Completed' or refs.get('context_stale'):
            raise DomainError('ContextStale', 'Review a current completed work suggestion')
        if refs.get('persona_revision') != self.store.identity.profile(db, aid)['current_persona_revision']:
            raise DomainError('ContextStale', 'Persona changed; review again')
        from .recall import active
        if not set(refs.get('memory_revision_ids', [])) <= {m['revision_id'] for m in active(db, aid)}:
            raise DomainError('ContextStale', 'Memory changed; review again')
        if refs.get('goal_context'):
            self.store.goals.approved_context(db, aid, refs['goal_context'])
        if refs.get('work_context'):
            from .conversation_work import approved
            approved(self.store, db, aid, run['conversation_id'], refs['work_context'])
        if refs.get('method_context'):
            self.store.evolution.resolve(db, aid, refs['method_context'])
        return run

    def response(self, db, aid, rid):
        row = db.execute('SELECT * FROM work_responses WHERE run_id=? AND agent_id=?', (rid, aid)).fetchone()
        if not row:
            return None
        data = {k: row[k] for k in ('run_id', 'state', 'revision', 'task_id', 'goal_id')}
        data['suggestion'] = json.loads(row['suggestion']) if row['suggestion'] else None
        run = self.store.conversation.run(db, aid, rid)
        data['source_message_id'] = run['input_message_id']
        data['source_conversation_id'] = run['conversation_id']
        approval = run['context'].get('goal_context')
        data['context_goal_id'] = approval.get('goal_id') if approval else None
        data['method_ref'] = run['context'].get('method_context') if data['suggestion'] and data['suggestion'].get('skill_id') else None
        data['origin'] = 'user' if db.execute("SELECT 1 FROM events WHERE type='PrepareFileWork' AND agent_id=? AND json_extract(payload,'$.run_id')=?", (aid, rid)).fetchone() else 'model'
        data['can_prepare_file'], data['available_method'] = False, None
        if data['state'] == 'None':
            try:
                self.current(db, aid, rid)
                text = self.source_text(db, run)
                data['can_prepare_file'] = len(text) <= 4000 and bool(text.strip())
                ref = run['context'].get('method_context')
                if ref and data['can_prepare_file']:
                    method = self.store.evolution.resolve(db, aid, ref)
                    data['available_method'] = {'title': method['title'], 'applicability': method['applicability']}
            except DomainError:
                pass
        if data['state'] == 'Pending':
            try:
                self.current(db, aid, rid)
            except DomainError:
                data['state'] = 'Invalidated'
        if data['task_id']:
            from .task_results import result
            data['task_result'] = result(db, aid, data['task_id'])
            task = self.store.tasks.target(db, aid, data['task_id'])
            data['feedback'] = self.feedback(db, aid, task['current_run_id'])
        return data

    def accept(self, db, c, kind, target_id):
        ref = c['payload'].get('work_suggestion')
        if not ref:
            return
        aid, rid = c['agent_id'], ref['run_id']
        run = self.current(db, aid, rid)
        row = db.execute('SELECT * FROM work_responses WHERE run_id=? AND agent_id=?', (rid, aid)).fetchone()
        if not row or row['state'] != 'Pending' or row['revision'] != ref['revision']:
            raise DomainError('RevisionConflict', 'Suggestion already handled or changed')
        suggestion = json.loads(row['suggestion'])
        expected = {'CreateTask': 'file_task', 'CreatePlannedTask': 'file_task', 'CreateGoal': 'goal', 'EditGoal': 'goal_next_step'}[kind]
        if suggestion['kind'] != expected:
            raise DomainError('Forbidden', 'Suggestion does not support this operation')
        if suggestion.get('skill_id') and c['payload'].get('method_ref') != run['context'].get('method_context'):
            raise DomainError('ContextStale', 'Keep the reviewed method version or discuss a new suggestion')
        approval = run['context'].get('goal_context')
        if kind == 'EditGoal' and (not approval or approval['goal_id'] != target_id):
            raise DomainError('Forbidden', 'Only the explicitly selected Goal may be updated')
        if kind == 'CreateGoal' and (c['payload'].get('source_message_id') != run['input_message_id']
            or c['payload'].get('source_conversation_id') != run['conversation_id']):
            raise DomainError('Forbidden', 'Keep the reviewed suggestion source')
        db.execute('UPDATE work_responses SET state=\'Accepted\',revision=revision+1,task_id=?,goal_id=? WHERE run_id=?',
                   (target_id if kind in ('CreateTask', 'CreatePlannedTask') else None, target_id if kind not in ('CreateTask', 'CreatePlannedTask') else None, rid))

    def feedback(self, db, aid, rid):
        row = db.execute('SELECT * FROM task_feedback WHERE agent_id=? AND run_id=?', (aid, rid)).fetchone()
        return dict(row) if row else None

    def invalidate(self, db, aid, run_ids, erase=False):
        for rid in run_ids:
            db.execute("UPDATE work_responses SET state=CASE WHEN state='Pending' THEN 'Invalidated' ELSE state END,"
                       "raw_output=CASE WHEN ? THEN '' ELSE raw_output END,suggestion=CASE WHEN ? THEN NULL ELSE suggestion END "
                       "WHERE agent_id=? AND run_id=?", (erase, erase, aid, rid))

    def execute(self, c):
        aid, p, kind = c['agent_id'], c['payload'], c['type']
        serialized = json.dumps(c, sort_keys=True, separators=(',', ':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db, aid)
            old = cached(db, c, serialized)
            if old is not None:
                return old
            if kind == 'PrepareFileWork':
                run = self.current(db, aid, p['run_id'])
                row = db.execute('SELECT * FROM work_responses WHERE run_id=? AND agent_id=?', (run['run_id'], aid)).fetchone()
                if not row or row['state'] != 'None' or row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'This request already has work or has changed')
                text = self.source_text(db, run).strip()
                if not text or len(text) > 4000:
                    raise DomainError('ValidationError', 'Use a complete request within the task instruction capacity; no requirements are truncated')
                suggestion = {'kind': 'file_task', 'title': text.splitlines()[0][:120], 'instruction': text}
                if p['use_method']:
                    ref = run['context'].get('method_context')
                    if not ref:
                        raise DomainError('Forbidden', 'No adopted method was available in this request')
                    self.store.evolution.resolve(db, aid, ref)
                    suggestion['skill_id'] = ref['proposal_id']
                # An explicit user draft, not a repaired or invented model response.
                db.execute("UPDATE work_responses SET suggestion=?,state='Pending',revision=revision+1 WHERE run_id=?", (json.dumps(suggestion), run['run_id']))
                data = None
            elif kind == 'RejectWorkSuggestion':
                run = self.store.conversation.run(db, aid, p['run_id'])
                row = db.execute('SELECT * FROM work_responses WHERE run_id=? AND agent_id=?', (run['run_id'], aid)).fetchone()
                if not row or row['state'] != 'Pending' or row['revision'] != c['expected_revision']:
                    raise DomainError('RevisionConflict', 'Suggestion changed')
                db.execute("UPDATE work_responses SET state='Rejected',revision=revision+1 WHERE run_id=?", (run['run_id'],))
                data = self.response(db, aid, run['run_id'])
            else:
                task = self.store.tasks.target(db, aid, p['task_id'])
                rid = p['run_id']
                if not db.execute('SELECT 1 FROM task_runs WHERE run_id=? AND task_id=?', (rid, task['task_id'])).fetchone():
                    raise DomainError('NotFound', 'Feedback must reference this task attempt')
                old_feedback = self.feedback(db, aid, rid)
                revision = old_feedback['revision'] if old_feedback else 0
                if c['expected_revision'] != revision:
                    raise DomainError('RevisionConflict', 'Feedback changed; reload it')
                if kind == 'DeleteTaskFeedback' and (not old_feedback or old_feedback['deleted']):
                    raise DomainError('NotFound', 'Feedback unavailable')
                note = p.get('note', '').strip() if kind == 'SaveTaskFeedback' else ''
                quality = p.get('quality', 'Unsure') if kind == 'SaveTaskFeedback' else 'Unsure'
                if kind == 'SaveTaskFeedback' and (not note or len(note) > 1000 or quality not in ('Helpful', 'NeedsRevision', 'Unsure')):
                    raise DomainError('ValidationError', 'Provide bounded user feedback')
                db.execute('INSERT OR REPLACE INTO task_feedback VALUES (?,?,?,?,?,?,?,?)',
                           (rid, task['task_id'], aid, revision+1, note, quality, int(kind == 'DeleteTaskFeedback'), now()))
                self.store.evolution.feedback_changed(db, aid, rid, p.get('delete_methods', False))
                from .conversation_work import erase_feedback
                erase_feedback(self.store, db, aid, rid)
                self.store.goals.invalidate_task_context(db, aid, feedback_run_id=rid, erase=True)
                g = self.store.goals.for_work(db, aid, 'task', task['task_id'])
                if g:
                    self.store.goals.invalidate(db, aid, g['goal_id'])
                    self.store.proactivity.invalidate_goal(db, aid, g['goal_id'])
                # Erase only replies that actually received the superseded feedback.
                # Earlier Goal replies and independent source messages are not derived from it.
                affected = set()
                for row in db.execute('SELECT run_id,context FROM runs WHERE agent_id=?', (aid,)).fetchall():
                    refs = json.loads(row['context'])
                    if any(f['run_id'] == rid for f in refs.get('goal_context', {}).get('feedback', [])):
                        refs.update(context_stale=True, context_erased=True)
                        db.execute('UPDATE runs SET context=? WHERE run_id=?', (json.dumps(refs), row['run_id']))
                        db.execute("UPDATE messages SET content='',finality='partial' WHERE run_id=? AND role='assistant'", (row['run_id'],))
                        affected.add(row['run_id'])
                self.invalidate(db, aid, affected, True)
                erase_cached(db, affected)
                erase_cached(db, {rid})
                data = self.feedback(db, aid, rid)
            self.store.memory.event(db, kind, aid, {'run_id': p['run_id']}, c['command_id'], 'user')
            if kind == 'PrepareFileWork':
                data = self.response(db, aid, p['run_id'])
            result = {'command_id': c['command_id'], 'status': 'persisted', 'data': data}
            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(result)))
            return result
