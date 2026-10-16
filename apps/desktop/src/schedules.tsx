import {DateField,Select} from './controls';
import {useEffect,useState} from 'react';
import type {Execute} from './chat';
import {Modal,PageTabs} from './ui';
import {TaskResult} from './task-result';
import type {Goal,GoalSummary} from './goals';

export type CommitmentOrigin={commitment_id:string;source_message_id:string;source_conversation_id:string;source_available:boolean};
export type BodyReview={editor:'user'|'model';state:string;save_approved:boolean};
export type TaskResultValue={reply?:string|null;task_id:string;state:string;revision:number;permission:number;run_id:string;error:string|null;outputs:{output_id:string;label:string;path:string;outcome:string|null;bytes_written:number|null;body_review?:BodyReview|null}[]};
export type Schedule={schedule_id:string;agent_id:string;title:string;instruction:string;task_kind:'file'|'network';due_at:string;time_zone:string;state:'Scheduled'|'Ready'|'Started'|'Cancelled'|'Dismissed';revision:number;triggered_at?:string;delivery_reason?:string;task_id?:string;commitment?:CommitmentOrigin|null;task_result?:TaskResultValue|null;goal?:GoalSummary|null};
export type ScheduleView={settings:{enabled:number;revision:number};items:Schedule[]};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};
export const localValue=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,19);
export function offsetZone(date:Date){const n=-date.getTimezoneOffset();return 'UTC'+(n>=0?'+':'-')+String(Math.floor(Math.abs(n)/60)).padStart(2,'0')+':'+String(Math.abs(n)%60).padStart(2,'0');}
export const scheduleNames={Scheduled:'等待约定时间',Ready:'已到期 · 等待你处理',Started:'已转为任务',Cancelled:'已取消',Dismissed:'已处理'};
export function ScheduleFields({title,instruction,due,kind,setTitle,setInstruction,setDue,setKind}:{title:string;instruction:string;due:string;kind:'file'|'network';setTitle:(v:string)=>void;setInstruction:(v:string)=>void;setDue:(v:string)=>void;setKind:(v:'file'|'network')=>void}){return <>
 <label>约定名称<input id="schedule-title" required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label>
 <label>到时需要处理什么<textarea id="schedule-instruction" required maxLength={4000} rows={3} value={instruction} onChange={e=>setInstruction(e.target.value)}/></label>
 <label>约定时间（本机时区）<DateField id="schedule-due" type="datetime-local" step="1" required value={due} onChange={e=>setDue(e.target.value)}/></label>
 <label>之后准备的任务<Select id="schedule-kind" value={kind} onChange={e=>setKind(e.target.value as 'file'|'network')}><option value="file">文件任务</option><option value="network">联网研究</option></Select></label>
 </>;}

export function Schedules({agentId,value,disabled,paused,execute,prepare,openTask,source,focusId,goalSeed,clearGoalSeed}:{agentId:string;value?:ScheduleView;disabled:boolean;paused:boolean;execute:Execute;prepare:(v:Schedule)=>void;openTask:(id:string)=>void;source:(v:CommitmentOrigin)=>void;focusId?:string|null;goalSeed?:Goal|null;clearGoalSeed:()=>void}){
 const [category,setCategory]=useState<'active'|'history'>('active');
 const [editing,setEditing]=useState<Schedule|null|undefined>(undefined),[title,setTitle]=useState(''),[instruction,setInstruction]=useState(''),[kind,setKind]=useState<'file'|'network'>('file'),[due,setDue]=useState(''),[error,setError]=useState('');
 const enabled=Boolean(value?.settings.enabled),items=value?.items??[];
 useEffect(()=>{if(goalSeed){form(null);setTitle(goalSeed.title);setInstruction(goalSeed.next_step||goalSeed.objective);}},[goalSeed?.goal_id]);
 useEffect(()=>{if(!focusId)return;const row=items.find(s=>s.schedule_id===focusId);setCategory(row&&['Scheduled','Ready'].includes(row.state)?'active':'history');const card=document.querySelector<HTMLElement>(`[data-schedule="${CSS.escape(focusId)}"]`);if(card){requestAnimationFrame(()=>card.scrollIntoView({block:'start'}));}},[focusId,value?.items.length,category]);
 function form(row:Schedule|null){setError('');setEditing(row);setTitle(row?.title??'');setInstruction(row?.instruction??'');setKind(row?.task_kind??'file');setDue(localValue(row?new Date(row.due_at):new Date(Date.now()+300000)));}
 async function toggle(){try{await execute({...envelope(),type:'ConfigureScheduler',agent_id:agentId,expected_revision:value?.settings.revision??0,payload:{enabled:!enabled}});setError('');}catch(e){setError(explain(e));}}
 async function submit(){try{const date=new Date(due);if(!due||Number.isNaN(date.getTime()))throw new Error('请选择有效的本机日期和时间');const payload={title,instruction,task_kind:kind,due_at:date.toISOString(),time_zone:offsetZone(date)};
  if(editing)await execute({...envelope(),type:'EditSchedule',agent_id:agentId,expected_revision:editing.revision,payload:{schedule_id:editing.schedule_id,...payload}});
  else await execute({...envelope(),type:'CreateSchedule',agent_id:agentId,payload:{...payload,...(goalSeed?{goal_id:goalSeed.goal_id,goal_revision:goalSeed.revision}:{})}});
  setEditing(undefined);clearGoalSeed();setError('');
 }catch(e){setError(explain(e));}}
 async function change(row:Schedule,type:'CancelSchedule'|'DismissSchedule'){try{await execute({...envelope(),type,agent_id:agentId,expected_revision:row.revision,payload:{schedule_id:row.schedule_id}});setError('');}catch(e){setError(explain(e));}}
 function card(row:Schedule){return <article key={row.schedule_id} className="schedule-card" data-schedule={row.schedule_id} data-schedule-state={row.state} data-focused={focusId===row.schedule_id}>
  <div className="section-heading"><strong>{row.title}</strong><span className="badge">{scheduleNames[row.state]}</span></div>
  <p className="small muted"><time dateTime={row.due_at}>{new Date(row.due_at).toLocaleString()}</time> · 创建时区 {row.time_zone}{row.state==='Ready'&&row.delivery_reason==='StartupOverdue'?' · 应用退出期间错过，重启后待处理':row.state==='Ready'&&row.delivery_reason==='ResumedOverdue'?' · 提醒恢复时已逾期':''}</p>
  <p className="schedule-instruction">{row.instruction}</p>
  {row.goal&&<p className="small muted">关联目标：{row.goal.title} · 约定独立保留；目标暂停或取消后，请分别处理本约定。</p>}
  {row.commitment&&<p className="small muted">经你确认的对话约定 · {row.commitment.source_available?'来源消息可查看':'来源已删除或不可用，独立约定仍保留'} <button className="text-button" data-commitment-source={row.commitment.commitment_id} disabled={disabled} onClick={()=>source(row.commitment!)}>查看来源消息</button></p>}
  <TaskResult schedule={row} disabled={disabled} openTask={()=>{if(row.task_id)openTask(row.task_id);}}/>
  <div className="actions">{row.state==='Scheduled'&&<button className="secondary" data-edit-schedule={row.schedule_id} disabled={disabled} onClick={()=>form(row)}>修改约定</button>}
   {row.state==='Ready'&&<><button data-prepare-schedule={row.schedule_id} disabled={disabled||!!(row.goal&&row.goal.state!=='Active')} onClick={()=>prepare(row)}>准备{row.task_kind==='network'?'联网':'文件'}任务…</button><button className="secondary" data-dismiss-schedule={row.schedule_id} disabled={disabled} onClick={()=>void change(row,'DismissSchedule')}>已处理</button></>}
   {['Scheduled','Ready'].includes(row.state)&&<button className="secondary" data-cancel-schedule={row.schedule_id} disabled={disabled} onClick={()=>void change(row,'CancelSchedule')}>取消约定</button>}
   {row.state==='Started'&&row.task_id&&<button className="secondary" disabled={disabled} onClick={()=>openTask(row.task_id!)}>查看任务</button>}
  </div>
 </article>;}
 return <section className="schedules-section" aria-label="单次时间约定" id="schedules-section">
  <div className="section-heading"><div><h2>时间约定</h2><p className="small muted">到期后由你决定下一步，约定属于当前 Agent。</p></div><button id="new-schedule" disabled={disabled||!enabled} onClick={()=>{clearGoalSeed();form(null);}}>约定时间…</button></div>
  <div className="actions"><span id="scheduler-enabled">定时提醒{enabled?'已启用':'未启用'}</span><button className="secondary" id="toggle-scheduler" disabled={disabled} onClick={()=>void toggle()}>{enabled?'关闭此 Agent 的定时提醒':'启用此 Agent 的定时提醒'}</button></div>
  {paused&&<p className="notice">后台已暂停，到期约定暂不触发。恢复后，错过的约定会作为逾期待处理项出现。</p>}
  <p className="small muted">应用运行时检查时间；退出期间不执行，重启后补记逾期约定。每条只触发一次。到期仅提醒，准备任务时再选择资源、确认出站及审批保存。</p>
  {error&&<p role="alert" className="error">{error}</p>}
  <PageTabs label="时间约定分类" value={category} change={setCategory} items={[["active","待处理"],["history","已处理与取消"]]}/>
  <div id="active-schedules" hidden={category!=="active"}>{items.filter(r=>['Scheduled','Ready'].includes(r.state)).map(card)}{!items.some(r=>['Scheduled','Ready'].includes(r.state))&&<p className="small muted">还没有待处理的时间约定。</p>}</div>
  <div hidden={category!=='history'}>{items.filter(r=>!['Scheduled','Ready'].includes(r.state)).map(card)}{!items.some(r=>!["Scheduled","Ready"].includes(r.state))&&<p className="muted">还没有已处理的约定。</p>}</div>
  <Modal open={editing!==undefined} close={()=>{setEditing(undefined);clearGoalSeed();}} title={editing?'修改时间约定':'创建单次时间约定'} id="schedule-dialog">
   <form id="schedule-form" onSubmit={e=>{e.preventDefault();void submit();}}>
    <ScheduleFields {...{title,instruction,due,kind,setTitle,setInstruction,setDue,setKind}}/>
    <p className="small muted">这里只保存时间和目标。到期后仍需你选择输入、输出路径并确认任务权限。</p>
    {goalSeed&&<p className="notice">保存时关联长期目标“{goalSeed.title}”；不创建 Task 或授予资源权限。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="actions"><button id="save-schedule" disabled={disabled}>保存约定</button><button type="button" className="secondary" onClick={()=>{setEditing(undefined);clearGoalSeed();}}>取消</button></div>
   </form>
  </Modal>
 </section>;
}
