"""Finite reviewed plans with durable per-step attempts and native effects."""
import asyncio
import json
from uuid import uuid4
from contextlib import closing
import httpx
from .errors import DomainError
from .identity import now
from .memory_governance import cached, erase_cached
from .recall import current, active
from . import task_plan, task_report, task_text, general_actions

MIGRATION = (
    "ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'report'",
    "ALTER TABLE tasks ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE task_runs ADD COLUMN plan TEXT",
    "ALTER TABLE task_runs ADD COLUMN plan_approved INTEGER NOT NULL DEFAULT 0",
    """CREATE TABLE task_steps(step_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES task_runs(run_id),
    position INTEGER NOT NULL,definition TEXT NOT NULL,state TEXT NOT NULL,result TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',metadata TEXT NOT NULL DEFAULT '{}',raw_output TEXT NOT NULL DEFAULT '',error TEXT,
    action_id TEXT,origin_step_id TEXT,UNIQUE(run_id,position))""",
    """CREATE TABLE step_actions(action_id TEXT PRIMARY KEY,step_id TEXT NOT NULL REFERENCES task_steps(step_id),
    body TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,created_at TEXT NOT NULL,editor TEXT NOT NULL)""",
)
COMMANDS = {'CreatePlannedTask','ApproveTaskPlan','EditTaskPlan','EditTaskBody'}

class PlannedRepository:
    def __init__(self, store): self.store=store
    def target(self,db,aid,tid): return self.store.tasks.target(db,aid,tid)
    def steps(self,db,rid):
        rows=[]
        for r in db.execute('SELECT * FROM task_steps WHERE run_id=? ORDER BY position',(rid,)):
            r=dict(r)
            for k in ('definition','result','context','metadata'):r[k]=json.loads(r[k])
            a=db.execute('SELECT * FROM step_actions WHERE action_id=?',(r['action_id'],)).fetchone()
            r['action']=dict(a) if a else None
            if a:r['action']['receipt']=json.loads(a['receipt']) if a['receipt'] else None
            rows.append(r)
        return rows
    def resolved(self,step):
        return step['state']=='Completed' or general_actions.review_rejected(step) or (step['state']=='Failed' and step['definition']['op']=='decide'
            and step['result'].get('status')=='Rejected' and step['result'].get('executed') is False)
    def current_step(self,db,rid):
        return next((s for s in self.steps(db,rid) if not self.resolved(s)),None)
    def state(self,db,row,state,error=None):
        db.execute('UPDATE tasks SET state=?,revision=revision+1,updated_at=? WHERE task_id=?',(state,now(),row['task_id']))
        db.execute('UPDATE task_runs SET state=?,error=?,completed_at=? WHERE run_id=?',
                   (state,error,None if state in ('Planning','Running','Generating','Searching','ReadingWeb','AwaitingSources','AwaitingRedirectApproval','AwaitingPlanApproval','AwaitingApproval','AwaitingInput','Executing') else now(),row['current_run_id']))
        self.store.memory.event(db,'Task'+state,row['agent_id'],{'task_id':row['task_id'],'run_id':row['current_run_id'],'error':error},actor='task_runtime')
    def install(self,db,rid,plan,prefix=()):
        for i,d in enumerate(plan['steps']):
            old=prefix[i] if i<len(prefix) else None
            db.execute('INSERT INTO task_steps(step_id,run_id,position,definition,state,result,context,metadata,raw_output,action_id,origin_step_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                (str(uuid4()),rid,i,json.dumps(d),old['state'] if old else 'Pending',json.dumps(old['result']) if old else '{}',
                 json.dumps(old['context']) if old else '{}',json.dumps(old['metadata']) if old else '{}',old['raw_output'] if old else '',old['action_id'] if old else None,old['step_id'] if old else None))
    def next_run(self,db,row,plan,approved,prefix):
        rid=str(uuid4())
        old=db.execute('SELECT context FROM task_runs WHERE run_id=?',(row['current_run_id'],)).fetchone()
        refs=json.loads(old[0]) if old else {}
        context=refs if plan else {k:refs[k] for k in ('task_goal_context',) if k in refs}
        context.pop('request_sent',None)
        db.execute("INSERT INTO task_runs(run_id,task_id,state,context,metadata,error,created_at,plan,plan_approved) VALUES (?,?,?,?,'{}',NULL,?,?,?)",
            (rid,row['task_id'],'Created',json.dumps(context),now(),json.dumps(plan) if plan else None,int(approved)))
        db.execute("UPDATE tasks SET current_run_id=?,state='Created',revision=revision+1,updated_at=? WHERE task_id=?",(rid,now(),row['task_id']))
        if plan:self.install(db,rid,plan,prefix)
        return self.target(db,row['agent_id'],row['task_id'])
    def execute(self,c):
        aid,kind,p=c['agent_id'],c['type'],c['payload'];tid=c['command_id'] if kind=='CreatePlannedTask' else p['task_id']
        serialized=json.dumps(c,sort_keys=True,separators=(',',':'))
        with self.store.transaction() as db:
            self.store.identity.agent(db,aid)
            old=cached(db,c,serialized)
            if old is not None:return old
            if kind=='CreatePlannedTask':
                goal_context=self.store.goals.task_creation_context(db,c)
                if not p['title'].strip() or not p['instruction'].strip():raise DomainError('ValidationError','Task must have a goal')
                db.execute("INSERT INTO tasks(task_id,agent_id,title,instruction,sources,output_path,state,revision,permission,created_at,updated_at,kind,outputs) VALUES (?,?,?,?,?,?,'Created',0,1,?,?,'plan',?)",
                    (tid,aid,p['title'].strip(),p['instruction'].strip(),json.dumps(p['sources']),p['outputs'][0]['path'],now(),now(),json.dumps(p['outputs'])))
                row=self.target(db,aid,tid);self.next_run(db,row,None,False,[])
                self.store.evolution.attach(db,c,tid)
                self.store.work.accept(db,c,'CreatePlannedTask',tid)
                self.store.scheduler.attach(db,c,tid)
                self.store.goals.attach(db,c,'task',tid)
                self.store.goals.bind_task_context(db,aid,tid,goal_context)
            else:
                row=self.target(db,aid,tid)
                if row['kind'] not in ('plan','network','agent'):raise DomainError('Forbidden','This command requires a planned task')
                if row['revision']!=c['expected_revision']:raise DomainError('RevisionConflict','Task changed; review again')
                if row['kind']=='agent' and kind in ('ApproveTaskPlan','EditTaskPlan'):
                    raise DomainError('Forbidden','This work reviews each effect, not a fixed upfront plan')
                state=row['state'];rid=row['current_run_id'];step=self.current_step(db,rid)
                run=db.execute('SELECT * FROM task_runs WHERE run_id=?',(rid,)).fetchone()
                refs=json.loads(run['context'])
                if kind not in ('RevokeTaskPermission','PauseTask','CancelTask','RejectTask'):
                    self.store.evolution.check_task(db,row)
                if kind=='RevokeTaskPermission':
                    db.execute('UPDATE tasks SET permission=0 WHERE task_id=?',(tid,))
                    if state not in ('Executing','NeedsAttention','Completed'):self.state(db,row,'Revoked')
                    else:db.execute('UPDATE tasks SET revision=revision+1 WHERE task_id=?',(tid,))
                elif kind in ('PauseTask','CancelTask','RejectTask'):
                    if state == 'Executing' and step and step['definition']['op'] == 'run_command' and kind != 'RejectTask':
                        refs['stop_requested'] = 'Paused' if kind == 'PauseTask' else 'Cancelled'
                        db.execute('UPDATE task_runs SET context=? WHERE run_id=?', (json.dumps(refs), rid))
                        db.execute('UPDATE tasks SET revision=revision+1 WHERE task_id=?', (tid,))
                        response = {'command_id':c['command_id'],'status':'persisted','data':self.store.tasks.detail(db,aid,tid)}
                        db.execute('INSERT INTO command_results VALUES (?,?,?)',(c['command_id'],serialized,json.dumps(response)))
                        return response
                    if state in ('Executing','NeedsAttention','Completed'):raise DomainError('Forbidden','Resolve the write outcome first')
                    if kind=='RejectTask' and state not in ('AwaitingApproval','AwaitingPlanApproval'):raise DomainError('Forbidden','Nothing awaits review')
                    self.state(db,row,{'PauseTask':'Paused','CancelTask':'Cancelled','RejectTask':'Rejected'}[kind])
                else:
                    if not row['permission']:raise DomainError('Forbidden','Task permission has been revoked')
                    self.store.goals.task_context(db,aid,tid)
                    if refs.get('context_stale'):raise DomainError('ContextStale','Task context changed; create a new task with current sources and new output paths')
                    if not set(refs.get('memory_revision_ids',[])) <= {m['revision_id'] for m in active(db,aid)}:raise DomainError('ContextStale','Memory validity changed')
                    if kind=='RetryTask':
                        if row['kind']=='network':
                            if db.execute("SELECT 1 FROM network_requests WHERE run_id=? AND state='Running'",(rid,)).fetchone():raise DomainError('Forbidden','Wait for the in-flight request receipt before continuing')
                            pending=self.current_step(db,rid)
                            if pending and pending['definition']['op'] in ('search','read_web') and db.execute('SELECT 1 FROM network_requests WHERE run_id=? AND step_id=?',(rid,pending['step_id'])).fetchone() and not p.get('acknowledge_network_retry'):raise DomainError('Forbidden','Explicitly acknowledge another network attempt and possible additional charges')
                        if state not in ('Paused','Failed','Cancelled','Rejected','NotExecuted'):raise DomainError('Forbidden','Retry requires a resolved safe outcome')
                        steps=self.steps(db,rid);prefix=[]
                        for s in steps:
                            if s['state']!='Completed':break
                            prefix.append(s)
                        plan=json.loads(run['plan']) if run['plan'] else None
                        row=self.next_run(db,row,plan,bool(run['plan_approved']),prefix)
                        pending=steps[len(prefix)] if len(prefix)<len(steps) else None
                        edited=pending and pending['definition']['op']=='write' and pending['action'] and pending['action']['editor']=='user'
                        if plan and edited and run['plan_approved']:
                            new_step=self.current_step(db,row['current_run_id']);action=str(uuid4())
                            db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,'user')",(action,new_step['step_id'],pending['action']['body'],now()))
                            db.execute("UPDATE task_steps SET state='AwaitingApproval',action_id=? WHERE step_id=?",(action,new_step['step_id']))
                            self.state(db,row,'AwaitingApproval')
                        elif plan:self.state(db,row,'Running' if run['plan_approved'] else 'AwaitingPlanApproval')
                    elif kind=='EditTaskPlan':
                        if state in ('Planning','Generating','Running','Executing','NeedsAttention','Completed'):raise DomainError('Forbidden','Pause before editing an unexecuted plan')
                        plan=task_plan.validate(p['plan'],{f'source{i+1}' for i in range(len(json.loads(row['sources'])))},{f'output{i+1}' for i in range(len(json.loads(row['outputs'])))})
                        self.store.evolution.check_plan(db,row,plan)
                        steps=self.steps(db,rid);last=max((i for i,s in enumerate(steps) if s['definition']['op']=='write' and s['state']=='Completed'),default=-1)
                        prefix=steps[:last+1]
                        if [s['definition'] for s in prefix]!=plan['steps'][:len(prefix)]:raise DomainError('Forbidden','Completed effects and their dependencies are immutable')
                        self.state(db,row,'Superseded');row=self.next_run(db,row,plan,False,prefix);self.state(db,row,'AwaitingPlanApproval')
                    elif kind=='ApproveTaskPlan':
                        if state!='AwaitingPlanApproval' or not run['plan']:raise DomainError('Forbidden','No current plan awaits approval')
                        db.execute('UPDATE task_runs SET plan_approved=1 WHERE run_id=?',(rid,));self.state(db,row,'Running')
                    elif kind=='EditTaskBody':
                        if state!='AwaitingApproval' or not step or not p['body'].strip() or len(p['body'])>32768:raise DomainError('Forbidden','Only a complete pending body can be edited')
                        from . import document_actions, general_actions
                        if step['definition']['op'] in general_actions.WRITES:
                            try:
                                proposal = json.loads(p['body'])
                            except (ValueError, TypeError):
                                raise DomainError('InvalidToolAction', 'Edit the complete tool action JSON')
                            proposal.pop('id', None)
                            value = general_actions.parse(proposal, json.loads(row['agent_limits']).get('tools', {}), self.steps(db, rid))
                            value['id'] = step['definition']['id']
                            db.execute("UPDATE step_actions SET state='Superseded' WHERE action_id=?", (step['action_id'],))
                            db.execute("UPDATE task_steps SET definition=?,state='Pending',action_id=NULL,result='{}' WHERE step_id=?", (json.dumps(value), step['step_id']))
                            step_context = dict(step['context'], proposal_editor='user')
                            db.execute('UPDATE task_steps SET context=? WHERE step_id=?', (json.dumps(step_context), step['step_id']))
                            self.state(db, row, 'Running')
                            response = {'command_id': c['command_id'], 'status': 'persisted', 'data': self.store.tasks.detail(db, aid, tid)}
                            db.execute('INSERT INTO command_results VALUES (?,?,?)', (c['command_id'], serialized, json.dumps(response)))
                            return response
                        document_write = step['definition']['op'] in document_actions.WRITES
                        if document_write:
                            try: changes=json.loads(p['body'])
                            except (ValueError, TypeError): raise DomainError('InvalidDocumentAction','Edit a complete typed change list')
                            document=document_actions.resource(json.loads(row['agent_limits']).get('documents',[]),step['definition']['resource'])
                            document_actions.patch(changes,document)
                            definition=step['definition'] | {'changes':changes}
                            db.execute("UPDATE task_steps SET definition=?,state='Pending',result='{}' WHERE step_id=?",(json.dumps(definition),step['step_id']))
                        db.execute("UPDATE step_actions SET state='Superseded' WHERE action_id=?",(step['action_id'],))
                        action=str(uuid4());db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,'user')",(action,step['step_id'],p['body'],now()))
                        db.execute('UPDATE task_steps SET action_id=? WHERE step_id=?',(action,step['step_id']));self.state(db,row,'Running' if document_write else 'AwaitingApproval')
                    elif kind=='ApproveTask':
                        if state!='AwaitingApproval' or not step:raise DomainError('Forbidden','No current authorized body awaits approval')
                        if not set(refs.get('memory_revision_ids',[])) <= {m['revision_id'] for m in active(db,aid)}:raise DomainError('ContextStale','Memory validity changed')
                        step_context = dict(step['context'], approval={'action_id': step['action_id'],
                            'mode': 'PreauthorizedScope' if step['result'].get('auto_execute') is True else 'ExplicitAction'})
                        db.execute('UPDATE task_steps SET context=? WHERE step_id=?', (json.dumps(step_context), step['step_id']))
                        db.execute("UPDATE task_steps SET state='Executing' WHERE step_id=?",(step['step_id'],))
                        db.execute("UPDATE step_actions SET state='Executing' WHERE action_id=?",(step['action_id'],));self.state(db,row,'Executing')
                    else:raise DomainError('ValidationError','Unknown planned task command')
            data=self.store.tasks.detail(db,aid,tid)
            response={'command_id':c['command_id'],'status':'persisted','data':data}
            db.execute('INSERT INTO command_results VALUES (?,?,?)',(c['command_id'],serialized,json.dumps(response)))
        if kind=='ApproveTask':self.store.probe_point('action.intent',{'task_id':tid,'action_id':data['current_step']['action_id']})
        return response
    def receipt(self,v):
        receipt=v['receipt'];aid,tid=v['agent_id'],v['task_id']
        if receipt.get('outcome') not in ('Success','Unknown','NotExecuted'):raise DomainError('ValidationError','Invalid native outcome')
        self.store.probe_point('action.before_receipt',v)
        with self.store.transaction() as db:
            row=self.target(db,aid,tid);step=self.current_step(db,row['current_run_id'])
            if row['state'] not in ('Executing','NeedsAttention') or not step or step['action_id']!=v['action_id']:raise DomainError('Forbidden','No unresolved approved step')
            state={'Success':'Completed','Unknown':'NeedsAttention','NotExecuted':'NotExecuted'}[receipt['outcome']]
            db.execute('UPDATE task_steps SET state=?,error=? WHERE step_id=?',(state,receipt.get('error'),step['step_id']))
            db.execute('UPDATE step_actions SET state=?,receipt=? WHERE action_id=?',(state,json.dumps(receipt),v['action_id']))
            self.store.memory.event(db,'TaskStepReceipt',aid,{'task_id':tid,'step_id':step['step_id'],'outcome':receipt['outcome']},actor='native_host')
            if row['kind']=='agent':
                action=db.execute('SELECT editor FROM step_actions WHERE action_id=?',(v['action_id'],)).fetchone()
                db.execute('UPDATE task_steps SET result=? WHERE step_id=?',(json.dumps({'receipt':{k:receipt[k] for k in ('outcome','bytes_written','error','verification','changes','version','products','status','exit_code','stdout','stderr','truncated','elapsed_ms') if k in receipt},'editor':action['editor'],'status':receipt.get('status', 'Failed' if receipt.get('error') else 'Success')}),step['step_id']))
                context=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(row['current_run_id'],)).fetchone()[0])
                context['active_ms']=context.get('active_ms',0)+int(receipt.get('elapsed_ms',0))
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?',(json.dumps(context),row['current_run_id']))
                if state=='NotExecuted':
                    db.execute("UPDATE task_steps SET state='Completed' WHERE step_id=?",(step['step_id'],))
                    state='Completed'  # The failed effect is now an observation; its action/receipt remains NotExecuted.
            task_state=state
            if state=='Completed':
                task_state=('Running' if row['permission'] else 'Revoked') if row['kind']=='agent' else 'Completed' if not self.current_step(db,row['current_run_id']) else 'Running' if row['permission'] else 'Revoked'
            if row['kind']=='agent' and state=='Completed' and context.get('stop_requested'):
                task_state=context['stop_requested']
            self.state(db,row,task_state,receipt.get('error'))
            return self.store.tasks.detail(db,aid,tid)
    def recover(self,db):
        for row in db.execute("SELECT * FROM tasks WHERE kind IN ('plan','network','agent') AND state IN ('Created','Planning','Running','Generating','Searching','ReadingWeb','Executing')").fetchall():
            step=self.current_step(db,row['current_run_id'])
            state='NeedsAttention' if row['state']=='Executing' else 'Failed'
            if step:
                db.execute('UPDATE task_steps SET state=?,error=? WHERE step_id=?',(state,'RuntimeInterrupted',step['step_id']))
                if state=='NeedsAttention':db.execute("UPDATE step_actions SET state='NeedsAttention',receipt=? WHERE action_id=?",(json.dumps({'outcome':'Unknown','error':'RuntimeInterrupted'}),step['action_id']))
            self.state(db,row,state,'RuntimeInterrupted')
    def invalidate(self,db,aid,ids,erase):
        affected=set()
        for r in db.execute("SELECT r.* FROM task_runs r JOIN tasks t ON t.task_id=r.task_id WHERE t.agent_id=? AND t.kind IN ('plan','network','agent')",(aid,)).fetchall():
            ctx=json.loads(r['context'])
            if not set(ctx.get('memory_revision_ids',[])) & set(ids):continue
            ctx.update(context_stale=True,context_erased=bool(erase));db.execute('UPDATE task_runs SET context=? WHERE run_id=?',(json.dumps(ctx),r['run_id']))
            affected.update((r['run_id'],r['task_id']))
            if erase:
                db.execute("UPDATE task_runs SET raw_output='',plan=NULL,reply=NULL WHERE run_id=?",(r['run_id'],))
                task_kind=db.execute('SELECT kind FROM tasks WHERE task_id=?',(r['task_id'],)).fetchone()['kind']
                for step in self.steps(db,r['run_id']):
                    d=step['definition'];d.pop('instruction',None);d.pop('changes',None)
                    if task_kind=='agent':
                        for key in ('reason','question','query','script','args','body','patch','items','path','target','outputs'):d.pop(key,None)
                    db.execute("UPDATE task_steps SET definition=?,result='{}',raw_output='' WHERE step_id=?",(json.dumps(d),step['step_id']))
                    for a in db.execute('SELECT action_id FROM step_actions WHERE step_id=?',(step['step_id'],)):
                        affected.add(a[0]);db.execute("UPDATE step_actions SET body='' WHERE action_id=?",(a[0],))
            row=self.target(db,aid,r['task_id'])
            if row['current_run_id']==r['run_id'] and row['state'] not in ('Completed','Executing','NeedsAttention','Revoked'):self.state(db,row,'Failed','ContextStale')
        if affected:erase_cached(db,affected)

class PlannedRuntime:
    def __init__(self,store,gateway,recall):self.store,self.gateway,self.recall=store,gateway,recall;self.tasks={}
    def input(self,v):
        aid,tid=v['agent_id'],v['task_id'];config=self.gateway.ready();binding={k:config[k] for k in ('base_url','model','revision')}
        with self.store.transaction() as db:
            row=self.store.tasks.target(db,aid,tid);rid=row['current_run_id'];repo=self.store.tasks.planned
            if not row['permission'] or binding!=v['provider']:raise DomainError('Forbidden','Current bound permission required')
            if v.get('step_id'):
                s=repo.current_step(db,rid)
                if row['state']!='Running' or not s or s['step_id']!=v['step_id'] or s['definition']['op']!='read':raise DomainError('Forbidden','No current native read step')
                ref=s['definition']['resource'];path=(json.loads(row['sources'])[int(ref[6:])-1] if ref.startswith('source') else json.loads(row['outputs'])[int(ref[6:])-1]['path'])
                if v['file']['path']!=path or not isinstance(v['file']['content'],str):raise DomainError('Forbidden','Read does not match the selected resource')
                db.execute("UPDATE task_steps SET state='Completed',result=?,context=? WHERE step_id=?",(json.dumps(v['file']),json.dumps({'native_read':True,'path':path,'characters':len(v['file']['content'])}),s['step_id']))
                self.store.memory.event(db,'TaskStepRead',aid,{'task_id':tid,'step_id':s['step_id'],'resource':ref,'characters':len(v['file']['content'])},actor='native_host')
                repo.state(db,row,'Running')
            else:
                if row['state']!='Created' or [f['path'] for f in v['files']]!=json.loads(row['sources']):raise DomainError('Forbidden','Plan input is not current')
                ctx=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0])
                ctx.update(provider=binding,purpose='TaskPlan',prompt_version=task_plan.VERSION)
                repo.state(db,row,'Planning');db.execute('UPDATE task_runs SET context=? WHERE run_id=?',(json.dumps(ctx),rid))
                self.tasks[rid]=asyncio.create_task(self.model(dict(row),None,v['files'],config));return
        self.pump(aid,tid)
    def pump(self,aid,tid):
        with self.store.transaction() as db:
            row=self.store.tasks.target(db,aid,tid);repo=self.store.tasks.planned;rid=row['current_run_id']
            if row['kind'] not in ('plan','network','agent') or row['state']!='Running' or not row['permission'] or rid in self.tasks:return
            s=repo.current_step(db,rid)
            if not s:repo.state(db,row,'Completed');return
            if s['definition']['op']=='read':return
            previous={x['definition']['id']:x for x in repo.steps(db,rid)}
            if s['definition']['op']=='generate':
                try:config=self.gateway.ready()
                except DomainError as exc:
                    db.execute("UPDATE task_steps SET state='Failed',error=? WHERE step_id=?",(exc.code,s['step_id']))
                    repo.state(db,row,'Failed',exc.code);return
                files=[{'path':ref,'content':previous[ref]['result']['content']} for ref in s['definition']['inputs']]
                db.execute("UPDATE task_steps SET state='Generating' WHERE step_id=?",(s['step_id'],));repo.state(db,row,'Generating')
                self.tasks[rid]=asyncio.create_task(self.model(dict(row),s,files,config))
            else:
                body=previous[s['definition']['input']]['result']['content'];action=str(uuid4())
                db.execute("INSERT INTO step_actions VALUES (?,?,?,'AwaitingApproval',NULL,?,'model')",(action,s['step_id'],body,now()))
                db.execute("UPDATE task_steps SET state='AwaitingApproval',action_id=? WHERE step_id=?",(action,s['step_id']));repo.state(db,row,'AwaitingApproval')
    async def model(self,row,step,files,config):
        aid,tid,rid=row['agent_id'],row['task_id'],row['current_run_id'];repo=self.store.tasks.planned
        raw='';metadata={'model':config['model'],'provider_revision':config['revision'],'purpose':'TaskText' if step else 'TaskPlan'};error=None
        try:
            with closing(self.store.connect()) as db:self.store.goals.task_context(db,aid,tid)
            memories,recall=await self.recall.prepare(aid,row['instruction'])
            with self.store.transaction() as db:
                latest=repo.target(db,aid,tid)
                if latest['current_run_id']!=rid or latest['state']!=('Generating' if step else 'Planning') or not latest['permission']:return
                refs=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0])
                if refs.get('provider')!={k:config[k] for k in ('base_url','model','revision')}:raise DomainError('Forbidden','Provider binding changed; create a newly authorized task')
                if refs.get('context_stale'):raise DomainError('ContextStale','Task context changed')
                agent=self.store.identity.profile(db,aid)
                method=self.store.evolution.check_task(db,latest)
                if not current(db,aid,memories):raise DomainError('ContextStale','Memory changed')
                from .task_results import current_work
                work_state=current_work(db,aid,tid,self.store.goals.task_context(db,aid,tid))
                messages=(task_text.messages(agent,row['instruction'],step['definition'],files,memories,self.store.input_timezone,work_state) if step else task_plan.messages(agent,row['instruction'],files,json.loads(row['outputs']),memories))
                if method:
                    from .evolution import method_block
                    messages[0]['content'] += method_block(method)
                if sum(len(m['content'])+16 for m in messages)>config['max_input_tokens']:raise DomainError('BudgetExceeded','Complete task context exceeds configured capacity')
                context={'memory_revision_ids':[m['revision_id'] for m in memories],'recall':recall,'persona_revision':agent['current_persona_revision'],'prompt_version':task_text.VERSION if step else task_plan.VERSION,'request_sent':True}
                if step:context['current_work']=work_state
                if method:context['method_ref']=json.loads(latest['method_ref'])
                context['output_contract']=task_report.OUTPUT_CONTRACT if step else 'strict-plan-json-v1'
                runctx=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0])
                memory_ids=sorted(set(runctx.get('memory_revision_ids',[])) | set(context['memory_revision_ids']))
                if not step:runctx.update(context)
                runctx['memory_revision_ids']=memory_ids
                db.execute('UPDATE task_runs SET context=? WHERE run_id=?',(json.dumps(runctx),rid))
                if step:db.execute('UPDATE task_steps SET context=? WHERE step_id=?',(json.dumps(context),step['step_id']))
                self.store.memory.event(db,'TaskModelRequestStarted',aid,{'task_id':tid,'run_id':rid,'step_id':step['step_id'] if step else None,'purpose':metadata['purpose']})
            def consume(delta):
                nonlocal raw
                raw+=delta
                if len(raw)>32768:raise DomainError('BudgetExceeded','Task output exceeds supported capacity')
            await self.gateway.stream(config,messages,consume,metadata,**({} if step else {'response_format':{'type':'json_object'}}))
            if metadata.get('finish_reason')!='stop':raise DomainError('OutputTruncated','Task output is incomplete')
            if not raw.strip():raise DomainError('ProviderProtocolError','Task output is empty')
            plan=None if step else task_plan.parse(raw,{f'source{i+1}' for i in range(len(files))},{f'output{i+1}' for i in range(len(json.loads(row['outputs'])))})
            with self.store.transaction() as db:
                latest=repo.target(db,aid,tid);ctx=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0])
                if latest['current_run_id']!=rid or latest['state']!=('Generating' if step else 'Planning'):return
                if ctx.get('context_stale') or not current(db,aid,memories):raise DomainError('ContextStale','Memory changed during execution')
                self.store.evolution.check_task(db,latest)
                self.store.goals.task_context(db,aid,tid)
                if plan:self.store.evolution.check_plan(db,latest,plan)
                if step:
                    db.execute("UPDATE task_steps SET state='Completed',result=? WHERE step_id=?",(json.dumps({'content':raw}),step['step_id']));repo.state(db,latest,'Running')
                else:
                    db.execute('UPDATE task_runs SET plan=? WHERE run_id=?',(json.dumps(plan),rid));repo.install(db,rid,plan);repo.state(db,latest,'AwaitingPlanApproval')
        except asyncio.CancelledError:return
        except DomainError as exc:error=exc.code
        except (httpx.TimeoutException,TimeoutError):error='ProviderTimeout'
        except httpx.TransportError:error='StreamInterrupted'
        except Exception:error='ProviderProtocolError'
        finally:
            with self.store.transaction() as db:
                ctx=json.loads(db.execute('SELECT context FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0]);saved='' if ctx.get('context_erased') else raw
                if step:db.execute('UPDATE task_steps SET metadata=?,raw_output=? WHERE step_id=?',(json.dumps(metadata),saved,step['step_id']))
                else:db.execute('UPDATE task_runs SET metadata=?,raw_output=? WHERE run_id=?',(json.dumps(metadata),saved,rid))
                latest=repo.target(db,aid,tid)
                if error and latest['current_run_id']==rid and latest['state'] in ('Generating','Planning'):
                    if step:db.execute("UPDATE task_steps SET state='Failed',error=? WHERE step_id=?",(error,step['step_id']))
                    repo.state(db,latest,'Failed',error)
            self.tasks.pop(rid,None)
        if not error:self.pump(aid,tid)
    def invalidate(self):
        with closing(self.store.connect()) as db:
            for rid,t in list(self.tasks.items()):
                if db.execute('SELECT state FROM task_runs WHERE run_id=?',(rid,)).fetchone()[0] not in ('Planning','Generating'):t.cancel()
    async def close(self):
        with self.store.transaction() as db:self.store.tasks.planned.recover(db)
        pending=list(self.tasks.values())
        for t in pending:t.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
