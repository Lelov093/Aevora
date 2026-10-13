import {useState} from 'react';
import type {Execute} from './chat';
import type {GoalSummary} from './goals';
import {Select} from './controls';
import {Modal} from './ui';

export function GoalFollowupDialog({agentId,goals,seedId,silenced,sourceMessageId,disabled,execute,close}:{agentId:string;goals:GoalSummary[];seedId?:string|null;silenced:boolean;sourceMessageId?:string;disabled:boolean;execute:Execute;close:()=>void}){
 const [id,setId]=useState(seedId??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const goal=goals.find(g=>g.goal_id===id);
 async function save(){if(!goal)return;setBusy(true);setError('');try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:'SetGoalFollowupPolicy',agent_id:agentId,expected_revision:goal.followup_revision??0,payload:{goal_id:id,silenced,...(sourceMessageId?{source_message_id:sourceMessageId}:{})}});close();}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <Modal open close={()=>{if(!busy)close();}} title={silenced?'暂停目标主动提醒':'恢复目标主动提醒'} id="goal-followup-dialog"><label>作用于哪个目标<Select id="followup-goal" value={id} disabled={disabled||busy} onChange={e=>setId(e.target.value)}><option value="">选择一个目标</option>{goals.map(g=><option key={g.goal_id} value={g.goal_id} disabled={!silenced&&g.state!=='Active'}>{g.title}{g.followup_silenced?' · 已暂停主动提醒':''}</option>)}</Select></label><p>{silenced?'确认后，Host 将持续停止此目标的主动判断和通知，重启后仍生效；你可以自行联系，并在需要时明确恢复。':'只解除此目标的静默状态。观察、判断、通知仍受现有总开关、授权、安静时段及预算限制。'}</p><p className="small muted">此操作独立于任务执行和单次时间约定；已有任务与明确约定按原规则保留。对话中的一句话只提供此确认入口。</p>{error&&<p className="error" role="alert">{error}</p>}<div className="actions"><button id="confirm-goal-followup" disabled={disabled||busy||!goal} onClick={()=>void save()}>{busy?'正在保存…':silenced?'确认暂停此目标主动提醒':'确认恢复此目标主动提醒'}</button><button className="secondary" disabled={busy} onClick={close}>返回</button></div></Modal>;
}
