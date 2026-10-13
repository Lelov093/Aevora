import {useEffect,useState} from 'react';
import type {Execute} from './chat';
import type {CommitmentOrigin} from './schedules';
import {Modal} from './ui';

type Source={available:boolean;conversation_id:string;message:{role:string;content:string;created_at:string}|null};
export function CommitmentSource({agentId,origin,disabled,read,openConversation,close}:{agentId:string;origin:CommitmentOrigin;disabled:boolean;read:Execute;openConversation:(id:string)=>Promise<void>;close:()=>void}){
 const [value,setValue]=useState<Source|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;if(!origin.source_available){setValue(null);return;}
  void read<Source>({protocol_version:1,command_id:crypto.randomUUID(),type:'GetCommitmentSource',agent_id:agentId,payload:{commitment_id:origin.commitment_id}})
   .then(v=>{if(active)setValue(v);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};
 },[agentId,origin.commitment_id,origin.source_available]);
 return <Modal open close={close} title="约定的来源消息" id="commitment-source-dialog">
  {error?<p className="error" role="alert">{error}</p>:!origin.source_available||value?.available===false?<p id="commitment-source-unavailable" className="notice">来源消息已删除或不可用。你独立确认的约定仍保留，取消约定或任务需分别操作。</p>:value?.message?<><p className="small muted">{value.message.role==='user'?'你的输入':'Agent 回复'} · {new Date(value.message.created_at).toLocaleString()}</p><blockquote id="commitment-source-content" className="commitment-source-text">{value.message.content}</blockquote><button id="open-commitment-conversation" disabled={disabled} onClick={()=>{void openConversation(value.conversation_id).then(close).catch(e=>setError(String(e)));}}>打开来源会话</button></>:<p role="status">正在读取来源消息…</p>}
 </Modal>;
}
