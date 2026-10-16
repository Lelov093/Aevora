import {GoalExecution} from './goal-execution';
import {GoalFollowupDialog} from './goal-followup';
import {CheckField,Select} from './controls';
import {useEffect,useState} from 'react';
import type {Execute,Provider} from './chat';
import {Modal,PageTabs} from './ui';
import type {Schedule,ScheduleView,TaskResultValue} from './schedules';
import {TaskResult} from './task-result';

export type GoalSummary={goal_id:string;agent_id:string;title:string;state:'Active'|'Paused'|'Completed'|'Cancelled';revision:number;followup_silenced?:number;followup_revision?:number;source_conversation_id?:string|null;source_message_id?:string|null};
export type GoalFields={title:string;objective:string;success_criteria:string;next_step:string;progress_note:string};
export type Goal=GoalSummary&GoalFields&{history:(GoalFields&{revision:number;reason:string;created_at:string})[];tasks:(TaskResultValue&{title:string})[];schedules:Schedule[]};
export type GoalSource={conversation_id:string;message_id:string;content:string};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const empty:GoalFields={title:'',objective:'',success_criteria:'',next_step:'',progress_note:''};
const names={Active:'持续推进',Paused:'已暂停',Completed:'用户已确认达成',Cancelled:'已取消'};
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function GoalDialog({agentId,value,source,initial,workReference,disabled,execute,close,saved}:{agentId:string;value?:Goal;source?:GoalSource;initial?:GoalFields;workReference?:{run_id:string;revision:number};disabled:boolean;execute:Execute;close:()=>void;saved:(v:Goal)=>void}){
 const [fields,setFields]=useState<GoalFields>(initial??value??empty),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const change=(key:keyof GoalFields,v:string)=>{setFields(f=>({...f,[key]:v}));setConfirmed(false);};
 async function submit(){try{if(!confirmed)throw new Error('请确认独立目标和达成条件');
  const content=Object.fromEntries(Object.keys(empty).map(k=>[k,fields[k as keyof GoalFields]])) as GoalFields;
  const link=workReference?{work_suggestion:workReference}:{};
  const result=await execute<Goal>(value?{...envelope(),type:'EditGoal',agent_id:agentId,expected_revision:value.revision,payload:{goal_id:value.goal_id,...content,...link}}:
   {...envelope(),type:'CreateGoal',agent_id:agentId,payload:{...content,confirmed_independent:true,...link,...(source?{source_conversation_id:source.conversation_id,source_message_id:source.message_id}:{})}});
  saved(result);close();
 }catch(e){setError(explain(e));}}
 return <Modal open close={close} title={value?'更新长期目标':'确认一个长期目标'} id="goal-dialog">
  <p className="small muted">目标和达成条件由你确认。模型回复、完成任务数或写入回执不能替你判断目标达成。</p>
  {source&&<details><summary>来源消息仅供参考</summary><blockquote>{source.content}</blockquote></details>}
  <form id="goal-form" onSubmit={e=>{e.preventDefault();void submit();}}>
   <label>目标名称<input id="goal-title" required maxLength={120} value={fields.title} onChange={e=>change('title',e.target.value)}/></label>
   <label>持续希望实现什么<textarea id="goal-objective" required maxLength={2000} rows={3} value={fields.objective} onChange={e=>change('objective',e.target.value)}/></label>
   <label>怎样才算达成<textarea id="goal-criteria" required maxLength={1000} rows={2} value={fields.success_criteria} onChange={e=>change('success_criteria',e.target.value)}/></label>
   <label>下一步（仍需另行授权）<textarea id="goal-next-step" maxLength={1000} rows={2} value={fields.next_step} onChange={e=>change('next_step',e.target.value)}/></label>
   <label>我的进展备注（用户陈述，不是工具回执）<textarea id="goal-progress-note" maxLength={1000} rows={2} value={fields.progress_note} onChange={e=>change('progress_note',e.target.value)}/></label>
   <label className="check"><CheckField id="goal-confirm" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认此独立目标、达成条件和下一步；保存目标不授予行动权限。</label>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="actions"><button id="save-goal" disabled={disabled||!confirmed}>确认保存</button><button type="button" className="secondary" onClick={close}>取消</button></div>
  </form>
 </Modal>;
}

export function GoalsPanel({provider,agentId,items,sequence,disabled,read,execute,tasks,scheduler,prepare,remind,resume,openTask,openSchedule,openConversation,focusId}:{focusId?:string|null;provider:Provider;agentId:string;items:GoalSummary[];sequence:number;disabled:boolean;read:Execute;execute:Execute;tasks:{task_id:string;title:string;revision:number;goal?:GoalSummary|null}[];scheduler?:ScheduleView;prepare:(g:Goal)=>void;remind:(g:Goal)=>void;resume:(g:Goal)=>void;openTask:(id:string)=>void;openSchedule:(id:string)=>void;openConversation:(id:string,messageId?:string)=>Promise<void>}){
 const [followup,setFollowup]=useState<boolean|null>(null);
 const [detailTab,setDetailTab]=useState<'overview'|'work'|'history'>('overview');
 const [id,setId]=useState(focusId??''),[goal,setGoal]=useState<Goal|null>(null),[dialog,setDialog]=useState<'new'|'edit'|null>(null),[error,setError]=useState('');
 useEffect(()=>{if(focusId)setId(focusId);},[focusId]);
 const [work,setWork]=useState(''),[action,setAction]=useState<'Completed'|'Delete'|'Paused'|'Cancelled'|'Active'|null>(null),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false);
 const [origin,setOrigin]=useState<{available:boolean;message?:{content:string}|null;conversation_id:string}|null>(null);
 useEffect(()=>{let active=true;setOrigin(null);if(!id){setGoal(null);return;}setGoal(null);
  void read<Goal>({...envelope(),type:'GetGoal',agent_id:agentId,payload:{goal_id:id}}).then(v=>{if(active){setGoal(v);setError('');}}).catch(e=>{if(active){setGoal(null);setError(explain(e));}});return()=>{active=false;};
 },[id,sequence,agentId]);
 async function link(kind:'task'|'schedule',targetId:string,revision:number,unlink=false){if(!goal)return;try{await execute({...envelope(),type:unlink?'UnlinkGoalWork':'LinkGoalWork',agent_id:agentId,expected_revision:goal.revision,payload:{goal_id:goal.goal_id,kind,target_id:targetId,target_revision:revision}});setWork('');setError('');}catch(e){setError(explain(e));}}
 async function change(){if(!goal||!action||!confirmed)return;try{await execute(action==='Delete'?{...envelope(),type:'DeleteGoal',agent_id:agentId,expected_revision:goal.revision,payload:{goal_id:goal.goal_id}}:
   {...envelope(),type:'ChangeGoalState',agent_id:agentId,expected_revision:goal.revision,payload:{goal_id:goal.goal_id,state:action,confirmed_achieved:action==='Completed',reason}});
  if(action==='Delete'){setId('');setGoal(null);}setAction(null);setError('');
 }catch(e){setError(explain(e));}}
 function ask(v:typeof action){setAction(v);setReason('');setConfirmed(false);}
 const eligible=[...tasks.filter(t=>!t.goal).map(t=>({key:'task:'+t.task_id,kind:'task' as const,id:t.task_id,title:'任务 · '+t.title,revision:t.revision})),...(scheduler?.items??[]).filter(s=>!s.goal).map(s=>({key:'schedule:'+s.schedule_id,kind:'schedule' as const,id:s.schedule_id,title:'约定 · '+s.title,revision:s.revision}))];
 return <section className="goals-section" aria-label="当前 Agent 的长期目标">
  <div className="section-heading"><div><h2>持续目标</h2><p className="small muted">回看实际进展，确认下一步，再决定是否行动。</p></div><button id="new-goal" disabled={disabled} onClick={()=>setDialog('new')}>建立目标…</button></div>
  <label>回看目标<Select id="goal-select" value={id} disabled={disabled} onChange={e=>{setId(e.target.value);setDetailTab('overview');}}><option value="">选择一个目标</option>{items.map(g=><option key={g.goal_id} value={g.goal_id}>{g.title} · {names[g.state]}</option>)}</Select></label>
  {!items.length&&<p className="small muted">还没有持续目标。目标跨会话保留，可关联多个独立任务和时间约定。</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {goal&&<article id="goal-detail" data-goal={goal.goal_id} data-goal-state={goal.state}>
   <div className="section-heading"><h3>{goal.title}</h3><span className="badge">{names[goal.state]}</span></div>
   <PageTabs label="目标详情分类" value={detailTab} change={setDetailTab} items={[["overview","目标与下一步"],["work","关联工作"],["history","修订历史"]]}/><div hidden={detailTab!=="overview"}><p className="goal-prose">{goal.objective}</p><p><strong>达成条件：</strong>{goal.success_criteria}</p><p><strong>下一步：</strong>{goal.next_step||'尚未确认'}</p><p><strong>我的进展备注：</strong>{goal.progress_note||'尚未填写'}</p>
   <p className="small muted">任务状态和回执只记录实际执行；目标是否达成由你确认。历史写入不保证文件当前仍存在。</p>
   <p className="small muted">主动提醒：{items.find(g=>g.goal_id===goal.goal_id)?.followup_silenced?'已暂停，等待你自行联系':'遵循已授权主动帮助设置'} <button className="text-button" disabled={disabled} onClick={()=>setFollowup(!items.find(g=>g.goal_id===goal.goal_id)?.followup_silenced)}>{items.find(g=>g.goal_id===goal.goal_id)?.followup_silenced?'恢复主动提醒…':'暂停主动提醒…'}</button></p>
   <div className="actions"><button id="edit-goal" className="secondary" disabled={disabled} onClick={()=>setDialog('edit')}>调整目标与下一步…</button>
    {goal.state==='Active'?<><button id="resume-goal-chat" disabled={disabled} onClick={()=>resume(goal)}>新会话回看与续办…</button><button id="goal-prepare-task" className="secondary" disabled={disabled||!goal.next_step.trim()} onClick={()=>prepare(goal)}>准备下一项文件任务…</button><button id="goal-remind" className="secondary" disabled={disabled||!scheduler?.settings.enabled} onClick={()=>remind(goal)}>约定回看时间…</button></>:<button className="secondary" id="reactivate-goal" disabled={disabled} onClick={()=>ask('Active')}>恢复目标…</button>}
   </div>
   {!scheduler?.settings.enabled&&goal.state==='Active'&&<p className="small muted">如需单次回看提醒，请在事项的“时间约定”中启用此 Agent 的定时提醒。</p>}
   <GoalExecution agentId={agentId} goal={goal} provider={provider} sequence={sequence} disabled={disabled} schedulerEnabled={!!scheduler?.settings.enabled} read={read} execute={execute} openTask={openTask}/></div><div hidden={detailTab!=="work"}><h4>关联工作（独立指令与权限）</h4>
   {goal.tasks.map(t=><div key={t.task_id} className="goal-work"><strong>{t.title}</strong><TaskResult schedule={{schedule_id:goal.goal_id+':'+t.task_id,task_id:t.task_id,task_result:t}} disabled={disabled} openTask={()=>openTask(t.task_id)}/><button className="text-button" disabled={disabled} onClick={()=>void link('task',t.task_id,t.revision,true)}>解除目标关联</button></div>)}
   {goal.schedules.map(s=><div key={s.schedule_id} className="goal-work"><button className="text-button" disabled={disabled} onClick={()=>openSchedule(s.schedule_id)}>{s.title} · {s.state} · {new Date(s.due_at).toLocaleString()}</button><button className="text-button" disabled={disabled} onClick={()=>void link('schedule',s.schedule_id,s.revision,true)}>解除目标关联</button></div>)}
   {!goal.tasks.length&&!goal.schedules.length&&<p className="small muted">尚未关联任务或约定。</p>}
   {goal.state==='Active'&&<div className="goal-link"><label>关联已有任务或约定<Select id="goal-work-select" value={work} disabled={disabled} onChange={e=>setWork(e.target.value)}><option value="">选择当前 Agent 的独立工作</option>{eligible.map(w=><option value={w.key} key={w.key}>{w.title}</option>)}</Select></label><button id="goal-link-work" className="secondary" disabled={disabled||!work} onClick={()=>{const w=eligible.find(v=>v.key===work);if(w)void link(w.kind,w.id,w.revision);}}>确认关联</button></div>}
   {goal.source_message_id&&<div className="small"><button className="text-button" id="goal-show-source" disabled={disabled} onClick={()=>void read<typeof origin>({...envelope(),type:'GetGoalSource',agent_id:agentId,payload:{goal_id:goal.goal_id}}).then(setOrigin).catch(e=>setError(explain(e)))}>查看来源消息</button>{origin&&(origin.available?<><blockquote>{origin.message?.content}</blockquote><button className="text-button" onClick={()=>void openConversation(origin.conversation_id,goal.source_message_id??undefined)}>返回来源对话</button></>:<p>来源已删除或不可用，独立目标仍保留。</p>)}</div>}
   </div><div hidden={detailTab!=="history"}><h4>目标修订 · {goal.history.length}</h4>{goal.history.map(r=><div key={r.revision} className="small goal-work"><strong>版本 {r.revision} · {new Date(r.created_at).toLocaleString()}</strong><p>{r.objective}</p><p>达成条件：{r.success_criteria}</p><p>下一步：{r.next_step||'未确认'}</p><p>进展备注：{r.progress_note||'无'} · {r.reason}</p></div>)}</div>
   <div className="actions">{goal.state==='Active'&&<button id="pause-goal" className="secondary" disabled={disabled} onClick={()=>ask('Paused')}>暂停目标…</button>}{!['Cancelled','Completed'].includes(goal.state)&&<><button id="cancel-goal" className="secondary" disabled={disabled} onClick={()=>ask('Cancelled')}>取消目标…</button><button id="complete-goal" className="secondary" disabled={disabled} onClick={()=>ask('Completed')}>我确认目标达成…</button></>}<button id="delete-goal" className="text-button" disabled={disabled} onClick={()=>ask('Delete')}>删除目标…</button></div>
  </article>}
  {followup!==null&&goal&&<GoalFollowupDialog agentId={agentId} goals={items} seedId={goal.goal_id} silenced={followup} disabled={disabled} execute={execute} close={()=>setFollowup(null)}/>}
  {dialog&&<GoalDialog agentId={agentId} value={dialog==='edit'?goal??undefined:undefined} disabled={disabled} execute={execute} close={()=>setDialog(null)} saved={g=>{setId(g.goal_id);setGoal(g);}}/>}
  <Modal open={!!action} close={()=>setAction(null)} title={action==='Delete'?'删除目标':action==='Completed'?'确认目标达成':'更改目标状态'} id="goal-state-dialog">
   <p>{action==='Delete'?'清除目标正文、修订与续办回复，并解除关联；独立任务、时间约定、你的输入、原会话和外部文件保留。此操作无法撤回。':action==='Completed'?'请对照达成条件确认；任务 Completed 或成功写入回执不替代你的判断。':'此操作会停止此目标的长期执行及其派发工作。独立关联任务和时间约定仍按原权限运行，需分别暂停、取消或撤权。'}</p>
   {action==='Completed'&&<><blockquote>{goal?.success_criteria}</blockquote><label>为什么已达成<textarea id="goal-completion-reason" maxLength={1000} value={reason} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label></>}
   <label className="check"><CheckField id="goal-state-confirm" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我理解上述范围并确认</label>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="actions"><button id="apply-goal-state" disabled={disabled||!confirmed||(action==='Completed'&&!reason.trim())} onClick={()=>void change()}>确认</button><button className="secondary" onClick={()=>setAction(null)}>返回</button></div>
  </Modal>
 </section>;
}
