import {CheckField,Select} from './controls';
import {Modal} from './ui';
import type {MethodRef} from './methods';
import {useEffect,useState} from 'react';
import type {Execute} from './chat';
import {GoalDialog,type Goal} from './goals';
import {TaskResult} from './task-result';
import type {TaskResultValue} from './schedules';
export type Feedback={run_id:string;task_id:string;revision:number;note:string;quality:'Helpful'|'NeedsRevision'|'Unsure';deleted:number};
export type WorkReference={run_id:string;revision:number};
export type WorkSuggestion={kind:'file_task';title:string;instruction:string;skill_id?:string}|{kind:'goal';title:string;objective:string;success_criteria:string;next_step:string}|{kind:'goal_next_step';next_step:string};
export type WorkResponse=WorkReference&{method_ref?:MethodRef|null;origin?:'user'|'model';can_prepare_file?:boolean;available_method?:{title:string;applicability:string}|null;state:string;suggestion:WorkSuggestion|null;source_message_id:string;source_conversation_id:string;context_goal_id:string|null;task_id:string|null;goal_id:string|null;task_result?:TaskResultValue;feedback?:Feedback|null};
export type WorkSeed={work:WorkResponse;goal?:Goal|null};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function FeedbackForm({agentId,taskId,runId,value,disabled,execute,learn,inline=false}:{agentId:string;taskId:string;runId:string;value?:Feedback|null;disabled:boolean;execute:Execute;learn?:()=>void;inline?:boolean}){
 const [open,setOpen]=useState(false);
 const [note,setNote]=useState(value?.note??''),[quality,setQuality]=useState<Feedback['quality']>(value?.quality??'Unsure'),[error,setError]=useState(''),[saved,setSaved]=useState(false),[deleteMethods,setDeleteMethods]=useState(false);
 useEffect(()=>{setNote(value?.note??'');setQuality(value?.quality??'Unsure');},[runId,value?.revision]);
 async function save(remove=false){setError('');setSaved(false);try{const target={task_id:taskId,run_id:runId};await execute(remove?{...envelope(),type:'DeleteTaskFeedback',agent_id:agentId,expected_revision:value?.revision??0,payload:{...target,delete_methods:deleteMethods}}:{...envelope(),type:'SaveTaskFeedback',agent_id:agentId,expected_revision:value?.revision??0,payload:{...target,note,quality}});setSaved(true);}catch(e){setError(explain(e));}}
 const content=<><p className="small muted">记录你对这次工作的评价；不代表工具成功、目标达成或 Agent 已学会。目标续办发送前会显示这些反馈。</p>
  <label>这次工作的帮助程度<Select value={quality} onChange={e=>{setQuality(e.target.value as Feedback['quality']);setSaved(false);}}><option value="Helpful">有帮助</option><option value="NeedsRevision">需要修正</option><option value="Unsure">尚未判断</option></Select></label>
  <label>有用之处、需要修正的方法或下一次要求<textarea data-feedback-note maxLength={1000} rows={3} value={note} onChange={e=>{setNote(e.target.value);setSaved(false);}}/></label>
  <button data-save-feedback disabled={disabled||!note.trim()} onClick={()=>void save()}>保存反馈</button>{value&&!value.deleted&&<button className="text-button" data-delete-feedback disabled={disabled} onClick={()=>void save(true)}>删除反馈</button>}
  {value&&!value.deleted&&<label className="check"><CheckField type="checkbox" checked={deleteMethods} onChange={e=>setDeleteMethods(e.target.checked)}/>删除反馈时同时删除由它形成的方法；不勾选则保留独立批准的方法并标记来源已删除。</label>}
  {learn&&value&&!value.deleted&&<button data-learn-feedback className="text-button" disabled={disabled||note!==value.note||quality!==value.quality} onClick={learn}>查看方法／继续改进…</button>}
  {saved&&<p className="small success" role="status">反馈已保存</p>}{error&&<p className="error" role="alert">{error}</p>}
 </>;
 return <section className="work-feedback" data-feedback-run={runId}>{inline?<><h3>我的反馈与下一次改进</h3>{content}</>:<><button className="text-button" onClick={()=>setOpen(true)}>{value&&!value.deleted?"已保存反馈 · 查看方法／继续改进…":"记录反馈与改进…"}</button><Modal open={open} close={()=>setOpen(false)} title="反馈与工作方法" id={"feedback-"+runId}>{content}</Modal></>}</section>;
}

export function WorkCard({agentId,work,source,disabled,read,execute,prepare,openTask,openGoal,learn}:{agentId:string;work:WorkResponse;source:string;disabled:boolean;read:Execute;execute:Execute;prepare:(v:WorkSeed)=>void;openTask:(id:string)=>void;openGoal:()=>void;learn:(taskId:string,runId:string)=>void}){
 const [error,setError]=useState(''),[goal,setGoal]=useState<Goal|undefined>(),[dialog,setDialog]=useState(false);
 const suggestion=work.suggestion;
 const requestsPdf=/\.pdf\b/i.test(source)||(suggestion?.kind==='file_task'&&/\.pdf\b/i.test(suggestion.instruction));
 async function proceed(){setError('');try{const g=work.context_goal_id?await read<Goal>({...envelope(),type:'GetGoal',agent_id:agentId,payload:{goal_id:work.context_goal_id}}):undefined;setGoal(g);if(suggestion?.kind==='file_task')prepare({work,goal:g});else setDialog(true);}catch(e){setError(explain(e));}}
 async function reject(){try{await execute({...envelope(),type:'RejectWorkSuggestion',agent_id:agentId,expected_revision:work.revision,payload:{run_id:work.run_id}});}catch(e){setError(explain(e));}}
 async function prepareRequest(useMethod=false){setError('');try{const w=await execute<WorkResponse>({...envelope(),type:'PrepareFileWork',agent_id:agentId,expected_revision:work.revision,payload:{run_id:work.run_id,use_method:useMethod}});const g=w.context_goal_id?await read<Goal>({...envelope(),type:'GetGoal',agent_id:agentId,payload:{goal_id:w.context_goal_id}}):undefined;prepare({work:w,goal:g});}catch(e){setError(explain(e));}}
 return <section className="conversation-work" data-work-run={work.run_id} data-work-state={work.state}>
  {requestsPdf&&['None','Pending'].includes(work.state)&&<p className="notice" data-file-format-notice>当前文件任务只读取 UTF-8 .md/.txt，尚不能直接读取 PDF。可沿用这条需求，选择你已提取的论文文本并确认概括要求；选读笔记不能代替论文全文，未提取时可稍后继续。</p>}
  {work.state==='None'&&work.can_prepare_file&&<><button data-user-file-work className="text-button" disabled={disabled} onClick={()=>void prepareRequest()}>{requestsPdf?'选择论文的提取文本…':'用这条需求选择文件…'}</button>{work.available_method&&<section className="suggested-method"><h4>已采用的工作方法</h4><p>{work.available_method.title}</p><p className="small muted">适用条件：{work.available_method.applicability}</p><button data-user-method-work disabled={disabled} onClick={()=>void prepareRequest(true)}>使用此方法选择文件…</button></section>}<p className="small muted">沿用你这条需求准备草稿；文件、要求和保存位置由你确认，尚未执行。</p></>}
  {work.origin==='user'&&work.state==='Pending'&&<p className="small muted">你从这条需求发起的任务草稿。</p>}
  {work.state==='Pending'&&suggestion&&<><strong>{suggestion.kind==='file_task'?suggestion.title:suggestion.kind==='goal'?suggestion.title:'调整目标的下一步'}</strong><p>{suggestion.kind==='file_task'?suggestion.instruction:suggestion.next_step}</p><p className="small muted">待你确认的建议；尚未执行。资源和行动另行授权。</p><button data-continue-work disabled={disabled} onClick={()=>void proceed()}>{suggestion.kind==='file_task'?'继续准备任务…':'查看并确认目标…'}</button><button data-reject-work className="text-button" disabled={disabled} onClick={()=>void reject()}>不采用</button></>}
  {work.state==='Invalidated'&&<p className="small muted">此建议的上下文已改变，请在当前上下文中重新讨论。</p>}{work.state==='Rejected'&&<p className="small muted">已不采用这项建议，没有执行。</p>}
  {work.task_result&&<><TaskResult schedule={{schedule_id:work.run_id,task_id:work.task_id??undefined,task_result:work.task_result}} disabled={disabled} openTask={()=>openTask(work.task_id!)} />{work.task_result.run_id&&<FeedbackForm agentId={agentId} taskId={work.task_id!} runId={work.task_result.run_id} value={work.feedback} disabled={disabled} execute={execute} learn={()=>learn(work.task_id!,work.task_result!.run_id!)}/>}</>}
  {work.state==='Accepted'&&work.goal_id&&<button className="text-button" disabled={disabled} onClick={openGoal}>查看已确认目标</button>}
  {error&&<p className="error" role="alert">{error}</p>}
  {dialog&&suggestion&&suggestion.kind!=='file_task'&&<GoalDialog agentId={agentId} value={suggestion.kind==='goal_next_step'?goal:undefined} initial={suggestion.kind==='goal'?{...suggestion,progress_note:''}:goal?{...goal,next_step:suggestion.next_step}:undefined} source={suggestion.kind==='goal'?{conversation_id:work.source_conversation_id,message_id:work.source_message_id,content:source}:undefined} workReference={{run_id:work.run_id,revision:work.revision}} disabled={disabled} execute={execute} close={()=>setDialog(false)} saved={()=>{}}/>}
 </section>;
}
