import {useEffect,useRef,useState} from 'react';
import {CheckField} from './controls';
import type {Execute,Provider} from './chat';
import type {Projection} from './goal-context';
import {bodyReviewLabel,taskNames} from './task-result';

export type WorkApproval={conversation_id:string;tasks:{task_id:string;revision:number}[];feedback:{run_id:string;revision:number}[];allow_outbound:true};
type WorkProjection={references:Omit<WorkApproval,'allow_outbound'>;data:Pick<Projection['data'],'tasks'|'user_feedback'|'omitted_tasks'>};
export function ConversationWorkPicker({agentId,cid,sequence,provider,disabled,read,changed}:{agentId:string;cid:string|null;sequence:number;provider:Provider;disabled:boolean;read:Execute;changed:(v:WorkApproval|null,available:boolean)=>void}){
 const [value,setValue]=useState<WorkProjection|null>(null),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const identity=useRef(''),signature=useRef(''),confirmation=useRef(false),callback=useRef(changed);callback.current=changed;
 useEffect(()=>{let active=true;const scope=JSON.stringify([agentId,cid,provider.revision]);if(identity.current!==scope){identity.current=scope;signature.current='';confirmation.current=false;setConfirmed(false);setValue(null);callback.current(null,false);}if(!cid){setValue(null);confirmation.current=false;setConfirmed(false);callback.current(null,false);return;}
  void read<WorkProjection>({protocol_version:1,command_id:crypto.randomUUID(),type:'GetConversationWorkContext',agent_id:agentId,payload:{conversation_id:cid}}).then(v=>{
   if(!active)return;const key=JSON.stringify([agentId,cid,provider.revision,v.references]);
   if(signature.current!==key){signature.current=key;confirmation.current=false;setConfirmed(false);}
   setValue(v);setError('');callback.current(confirmation.current?{...v.references,allow_outbound:true}:null,!!v.data.tasks.length);
  }).catch(()=>{if(active){confirmation.current=false;setConfirmed(false);setValue(null);setError('当前工作资料暂不可用，请重新检查。');callback.current(null,false);}});
  return()=>{active=false;};
 },[agentId,cid,sequence,provider.revision]);
 return <section className="goal-context" aria-label="当前对话工作资料"><h3>当前对话的工作进展</h3>{value?.data.tasks.length?<><ul>{value.data.tasks.map((t,i)=><li key={i}>{t.title} · {taskNames[t.state]??t.state}<ul>{t.outputs.map((o,j)=><li key={j}>{o.label} · {o.outcome??'无写入回执'} · {o.bytes_written??'未知'} 字节 · {bodyReviewLabel(o.body_review)}</li>)}</ul></li>)}</ul>{value.data.user_feedback?.map((f,i)=><p key={i}>已保存反馈：{f.note} · {f.quality}</p>)}<label className="check"><CheckField id="conversation-work-consent" checked={confirmed} disabled={disabled} onChange={e=>{confirmation.current=e.target.checked;setConfirmed(e.target.checked);changed(e.target.checked?{...value.references,allow_outbound:true}:null,true);}}/>允许向 {provider.model}（{provider.base_url}）发送这些工作状态与已保存反馈，供后续回复使用；资料或连接改变后重新确认。</label><p className="small muted">可保持普通交流。这里只包含本对话的有界状态、历史回执和反馈；文件正文与路径不在范围内，历史保存不保证文件现在存在，也不代表内容通过或目标达成。带入这些资料的回复不会自动提取为 Memory。省略较早任务 {value.data.omitted_tasks??0} 项。</p></>:<p className="small muted">当前对话没有关联任务资料。</p>}{error&&<p className="error" role="alert">{error}</p>}</section>;
}
