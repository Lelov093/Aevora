import {executionNames} from './work-state';
import {useEffect,useRef,useState} from 'react';
import {CheckField} from './controls';
import type {Execute,Provider} from './chat';
import type {Projection} from './goal-context';
import {bodyReviewLabel,taskNames} from './task-result';

export type WorkApproval={conversation_id:string;tasks:{task_id:string;revision:number;run_id?:string}[];executions?:{execution_id:string;revision:number}[];feedback:{run_id:string;revision:number}[];allow_outbound:true};
type WorkReport=Projection['data']['tasks'][number]&{task_id:string;run_id:string|null;run_created_at:string|null;reply_excerpt?:string;reply_truncated?:boolean;report_use:'reported_observation'|'historical_issue';execution:{execution_id:string;node_id:string}|null;feedback:{run_id:string;note:string;quality:string}|null};
type WorkGroup={kind:'independent'|'execution';execution_id?:string;state?:string;reason?:string;task_ids:string[];nodes?:{id:string;title:string;state:string;task_id:string|null;depends_on:string[]}[]};
export type WorkProjection={references:Omit<WorkApproval,'allow_outbound'>;data:{grouping_version:string;groups:WorkGroup[];tasks:WorkReport[];executions?:{execution_id:string}[];omitted_tasks:number;omitted_executions?:number}};

export function ConversationWorkRecords({data}:{data:WorkProjection['data']}){
 const tasks=new Map(data.tasks.map(t=>[t.task_id,t]));
 const qualityNames:Record<string,string>={Helpful:'有帮助',NeedsRevision:'需修订',Unsure:'未明确评价'};
 function report(t:WorkReport,g:WorkGroup){
  const issue=t.report_use==='historical_issue',node=g.nodes?.find(n=>n.task_id===t.task_id);
  const predecessors=node?.depends_on.map(id=>g.nodes?.find(n=>n.id===id)?.title??'未包含的先行步骤')??[];
  return <li key={t.task_id}><strong>{t.title}</strong> · {taskNames[t.state]??t.state}
   {g.kind==='execution'&&<p className="small muted">{!node?'本次未包含此报告的节点依赖信息':predecessors.length?`先行步骤：${predecessors.join('；')}`:'此步骤没有先行依赖'}。依赖顺序不等于事实自动覆盖。</p>}
   <p className="small muted">{t.run_created_at?<>报告记录于 <time dateTime={t.run_created_at}>{new Date(t.run_created_at).toLocaleString()}</time></>:'报告时间未知'} · {issue?'历史问题，原稿不进入本次事实资料':'任务报告，尚不等于独立核实或内容认可'}</p>
   {t.feedback?<p>对应本次报告的反馈 · {qualityNames[t.feedback.quality]??t.feedback.quality}：{t.feedback.note}</p>:<p className="small muted">尚无内容反馈；完成和保存不代表内容通过。</p>}
   {t.reply_excerpt&&<details><summary>{issue?'历史问题原稿（仅本机查看，不随本次发送）':'用于讨论的任务报告'}{t.reply_truncated?'（前 2000 字符）':''}</summary><pre className="report-preview">{t.reply_excerpt}</pre></details>}
   <ul>{t.outputs.map((o,j)=><li key={j}>{o.label} · {o.outcome??'无写入回执'} · {o.bytes_written??'未知'} 字节 · {bodyReviewLabel(o.body_review)}</li>)}</ul>
  </li>;
 }
 return <>{data.groups.map(g=><div key={g.execution_id??'independent'} className="work-sequence">
  <h4>{g.kind==='execution'?`有依赖的工作 · ${executionNames[g.state??'']??g.state??'执行信息未包含'}`:'独立工作（分别记录）'}</h4>
  {g.kind==='execution'?<><p>{g.reason}</p><p className="small muted">按先行依赖顺序查看各阶段报告，再区分当时状态与后续明确更新。</p></>:<p className="small muted">按报告时间排列，不推定这些任务相互更新或覆盖。</p>}
  <ol>{g.task_ids.map(id=>tasks.get(id)).filter((t):t is WorkReport=>!!t).map(t=>report(t,g))}</ol>
  {g.nodes?.filter(n=>!n.task_id||!tasks.has(n.task_id)).map(n=><p key={n.id} className="small muted">{n.title} · {n.state} · {n.task_id?'本次未包含该步报告':'尚未产生任务报告'}</p>)}
 </div>)}</>;
}
export function ConversationWorkPicker({agentId,cid,sequence,provider,disabled,read,changed}:{agentId:string;cid:string|null;sequence:number;provider:Provider;disabled:boolean;read:Execute;changed:(v:WorkApproval|null,available:boolean)=>void}){
 const [value,setValue]=useState<WorkProjection|null>(null),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const identity=useRef(''),signature=useRef(''),confirmation=useRef(false),callback=useRef(changed);callback.current=changed;
 useEffect(()=>{let active=true;const scope=JSON.stringify([agentId,cid,provider.revision]);if(identity.current!==scope){identity.current=scope;signature.current='';confirmation.current=false;setConfirmed(false);setValue(null);callback.current(null,false);}if(!cid){setValue(null);confirmation.current=false;setConfirmed(false);callback.current(null,false);return;}
  void read<WorkProjection>({protocol_version:1,command_id:crypto.randomUUID(),type:'GetConversationWorkContext',agent_id:agentId,payload:{conversation_id:cid}}).then(v=>{
   if(!active)return;const key=JSON.stringify([agentId,cid,provider.revision,v.references,v.data.grouping_version]);
   if(signature.current!==key){signature.current=key;confirmation.current=false;setConfirmed(false);}
   setValue(v);setError('');callback.current(confirmation.current?{...v.references,allow_outbound:true}:null,!!(v.data.tasks.length||v.data.executions?.length));
  }).catch(()=>{if(active){confirmation.current=false;setConfirmed(false);setValue(null);setError('当前工作资料暂不可用，请重新检查。');callback.current(null,false);}});
  return()=>{active=false;};
 },[agentId,cid,sequence,provider.revision]);
 return <section className="goal-context" aria-label="当前对话工作资料"><h3>当前对话的工作进展</h3>{(value?.data.tasks.length||value?.data.executions?.length)?<>
  <ConversationWorkRecords data={value!.data}/>
  <label className="check"><CheckField id="conversation-work-consent" checked={confirmed} disabled={disabled} onChange={e=>{confirmation.current=e.target.checked;setConfirmed(e.target.checked);changed(e.target.checked?{...value!.references,allow_outbound:true}:null,true);}}/>允许向 {provider.model}（{provider.base_url}）发送按过程排列的任务报告、历史回执和对应反馈；需修订原稿仅供本机查看。资料或连接改变后重新确认。</label>
  <p className="small muted">可保持普通交流。不额外读取或发送原始文件正文；报告可能包含任务中记录的名称或路径。历史保存不保证文件现在存在，也不代表内容通过或目标达成。带入这些资料的回复不会自动提取为 Memory。省略较早任务 {value!.data.omitted_tasks??0} 项、执行记录 {value!.data.omitted_executions??0} 项。</p>
 </>:<p className="small muted">当前对话没有关联任务资料。</p>}{error&&<p className="error" role="alert">{error}</p>}</section>;
}
