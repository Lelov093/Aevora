import {CheckField} from './controls';
import {useState} from 'react';
import type {Execute} from './chat';
import {Modal} from './ui';
import {ScheduleFields,localValue,offsetZone,type Schedule,type ScheduleView} from './schedules';

export function CommitmentDialog({agentId,conversationId,message,value,disabled,execute,close,created}:{agentId:string;conversationId:string;message:{message_id:string;role:string;content:string};value?:ScheduleView;disabled:boolean;execute:Execute;close:()=>void;created:(s:Schedule)=>void}){
 const [title,setTitle]=useState(''),[instruction,setInstruction]=useState(''),[kind,setKind]=useState<'file'|'network'>('file'),[due,setDue]=useState(localValue(new Date(Date.now()+300000))),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
 const enabled=Boolean(value?.settings.enabled);
 const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
 const failure=(e:unknown)=>{try{setError(JSON.parse(String(e)).error?.message??String(e));}catch{setError(String(e));}};
 async function enable(){try{await execute({...envelope(),type:'ConfigureScheduler',agent_id:agentId,expected_revision:value?.settings.revision??0,payload:{enabled:true}});setError('');}catch(e){failure(e);}}
 async function submit(){try{const date=new Date(due);if(!confirmed||!due||Number.isNaN(date.getTime()))throw new Error('请确认有效时间与独立约定');
  const row=await execute<Schedule>({...envelope(),type:'CreateCommitment',agent_id:agentId,payload:{title,instruction,task_kind:kind,due_at:date.toISOString(),time_zone:offsetZone(date),source_conversation_id:conversationId,source_message_id:message.message_id,confirmed_independent:true}});
  created(row);close();
 }catch(e){failure(e);}}
 return <Modal open close={close} title="从这条消息建立单次约定" id="commitment-dialog">
  <p className="small muted">来源：{message.role==='user'?'你的输入':'Agent 已保存回复'}。请独立填写目标并确认具体时间；消息本身不是行动授权。</p>
  <details><summary>查看来源原文</summary><blockquote className="commitment-source-text">{message.content}</blockquote></details>
  {!enabled&&<p className="notice">此 Agent 的定时提醒尚未启用。<button id="enable-commitment-scheduler" type="button" disabled={disabled} onClick={()=>void enable()}>启用定时提醒</button></p>}
  <form id="commitment-form" onSubmit={e=>{e.preventDefault();void submit();}} onChange={e=>{if((e.target as HTMLElement).id!=='commitment-confirm')setConfirmed(false);}}>
   <ScheduleFields {...{title,instruction,due,kind,setTitle,setInstruction,setDue,setKind}}/>
   <p className="small muted">时间不会从消息自动解析。这里只建立提醒；到期后准备 Task 仍需另外选资源和授权。</p>
   <label className="check"><CheckField id="commitment-confirm" type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认以上目标和时间，作为独立约定保存。删除来源会话只清除原文，约定与已经授权的 Task 仍保留，取消需分别操作。</label>
   {error&&<p className="error" role="alert">{error}</p>}
   <div className="actions"><button id="save-commitment" disabled={disabled||!enabled||!confirmed}>确认并保存约定</button><button type="button" className="secondary" onClick={close}>取消</button></div>
  </form>
 </Modal>;
}
