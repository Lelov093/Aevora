import {CheckField,Select} from './controls';
import {useEffect,useRef,useState} from 'react';
import type {Execute,Provider} from './chat';
import type {GoalFields,GoalSummary} from './goals';
import type {BodyReview} from './schedules';
import {bodyReviewLabel} from './task-result';
export type GoalApproval={goal_id:string;goal_revision:number;allow_outbound:true;feedback?:{run_id:string;revision:number}[];tasks:{task_id:string;revision:number}[];schedules:{schedule_id:string;revision:number}[]};
export type Projection={references:Omit<GoalApproval,'allow_outbound'>;data:GoalFields&{followup_silenced?:boolean;user_feedback?:{task_id:string;note:string;quality:string}[];tasks:{title:string;state:string;permission:number;outputs:{label:string;outcome:string|null;bytes_written:number|null;body_review?:BodyReview|null}[]}[];schedules?:{title:string;state:string;due_at:string}[];omitted_tasks?:number;omitted_schedules?:number}};
export function GoalContextPicker({agentId,items,seedId,sequence,provider,disabled,read,changed,purpose='chat',selectGoal}:{selectGoal?:(id:string)=>Promise<void>;agentId:string;items:GoalSummary[];seedId?:string|null;sequence:number;provider:Provider;disabled:boolean;read:Execute;changed:(v:GoalApproval|null,pending:boolean)=>void;purpose?:'chat'|'task'}){
 const prefix=purpose==='task'?'task':'chat';
 const [id,setId]=useState(seedId??''),[projection,setProjection]=useState<Projection|null>(null),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const signature=useRef(''),confirmation=useRef(false),target=useRef(''),callback=useRef(changed);callback.current=changed;
 useEffect(()=>{if(seedId!==undefined)setId(seedId??'');},[seedId]);
 useEffect(()=>{let active=true;const identity=JSON.stringify([agentId,id,provider.revision]);
  if(target.current!==identity){target.current=identity;signature.current='';confirmation.current=false;setConfirmed(false);setProjection(null);callback.current(null,!!id);}
  if(!id){setError('');return;}
  void read<Projection>({protocol_version:1,command_id:crypto.randomUUID(),type:'GetGoalContext',agent_id:agentId,payload:{goal_id:id}}).then(v=>{
   if(!active)return;const next=JSON.stringify(v.references);
   if(signature.current!==next){signature.current=next;confirmation.current=false;setConfirmed(false);callback.current(null,true);}
   setProjection(v);setError('');if(confirmation.current)callback.current({...v.references,allow_outbound:true},true);
  }).catch(e=>{if(active){setError(String(e));confirmation.current=false;setConfirmed(false);setProjection(null);callback.current(null,true);}});
  return()=>{active=false;};
 },[id,sequence,provider.revision,agentId]);
 function choose(value:string){confirmation.current=false;setConfirmed(false);callback.current(null,!!value);if(selectGoal)void selectGoal(value).then(()=>setId(value)).catch(e=>{setError(String(e));callback.current(null,!!id);});else setId(value);}
 return <section className="goal-context" aria-label="本次目标续办上下文">
  <label>{purpose==='task'?'正文使用的目标资料':'本次回看目标'}<Select id={`${prefix}-goal-select`} disabled={disabled} value={id} onChange={e=>choose(e.target.value)}><option value="">{purpose==='task'?'不带入目标资料':'普通对话'}</option>{items.map(g=><option key={g.goal_id} value={g.goal_id} disabled={g.state!=='Active'}>{g.title}{g.state!=='Active'?' · 不可续办':''}</option>)}</Select></label>
  {projection&&<><section id={purpose==='task'?'task-goal-context-preview':'goal-context-preview'}><h3>本次将发送的资料</h3><GoalContextPreview data={projection.data}/></section>
   <label className="check"><CheckField id={purpose==='task'?'task-goal-context-consent':'goal-context-consent'} type="checkbox" disabled={disabled} checked={confirmed} onChange={e=>{confirmation.current=e.target.checked;setConfirmed(e.target.checked);changed(e.target.checked?{...projection.references,allow_outbound:true}:null,true);}}/>允许{purpose==='task'?'本任务生成正文时':'本次'}向 {provider.model||'当前模型'}（{provider.base_url||'尚未配置'}）发送上述目标资料；{purpose==='task'?'资料变化后需重新准备任务，文件和保存仍分别授权。':'回复只作建议，修改和行动另行确认。'}</label><p className="small muted">{purpose==='task'?'也可选择不带入目标资料；关联目标不会自动授予出站权限。':'普通对话不自动带入目标资料或此前的目标回看回复。'}</p></>}
  {id&&!projection&&!error&&<p className="small" role="status">正在读取当前目标资料…</p>}{error&&<p className="error" role="alert">目标上下文不可用，请重新选择或刷新。</p>}
 </section>;
}

export function GoalContextPreview({data}:{data:Projection["data"]}){return <section className="goal-data-preview"><p>{data.objective}</p>{data.followup_silenced!==undefined&&<p className="small muted">Host 主动提醒状态：{data.followup_silenced?"此目标已暂停，等待你自行联系":"遵循已授权主动帮助设置"}</p>}<p>达成条件：{data.success_criteria}</p><p>用户记录的进展备注（不会自动更新）：{data.progress_note||'无'}</p><p>下一步：{data.next_step||'未确认'}</p><ul>{data.tasks.map((t,i)=><li key={i}>{t.title} · {t.state} · {t.permission?'独立任务授权保留':'权限已撤销'}<ul>{t.outputs.map((o,j)=><li key={j}>{o.label} · {o.outcome??'无写入回执'} · {o.bytes_written??'未知'} 字节 · {bodyReviewLabel(o.body_review)}</li>)}</ul></li>)}</ul><ul>{data.schedules?.map((s,i)=><li key={i}>{s.title} · {s.state} · {new Date(s.due_at).toLocaleString()}</li>)}</ul><ul>{data.user_feedback?.map((f,i)=><li key={i}>用户反馈（非工具证据）：{f.note} · {f.quality}</li>)}</ul>{data.omitted_tasks!==undefined&&data.omitted_schedules!==undefined&&<p className="small muted">省略较早任务 {data.omitted_tasks} 项、约定 {data.omitted_schedules} 项。</p>}<p className="small muted">只发送有界状态、正文编辑／保存审批状态、明确反馈和历史回执，不发送源消息、历史报告或文件路径；不保证文件现在存在，不判断目标达成。</p></section>;}
