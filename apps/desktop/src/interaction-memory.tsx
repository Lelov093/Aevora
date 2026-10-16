import {useEffect,useRef,useState} from 'react';
import type {Command} from '../../../packages/protocol/command';
import {CheckField,DateField,Select} from './controls';
import {Modal} from './ui';
import type {Execute} from './chat';

export type UnderstandingKind='Fact'|'Preference'|'TemporaryState'|'SharedExperience'|'RelationshipUnderstanding';
export const understandingNames:Record<UnderstandingKind,string>={Fact:'明确事实',Preference:'偏好',TemporaryState:'临时状态',SharedExperience:'共同经历',RelationshipUnderstanding:'相处理解'};
export type MemoryReference={memory_id:string;revision_id:string;content:string;type:string;evidence_kind:string;current:boolean;recorded_at:string;valid_from:string|null;valid_until:string|null;scope:string|null;interaction_context:{kind?:UnderstandingKind;conversation_id?:string}};
type MemoryDetail={memory_id:string;revision:number;current:MemoryReference&{sources:{source_type:string;source_role:string;relation:string;available:boolean}[]}};
type View={input:string;reply:string;memory_context:MemoryReference[];memories:MemoryDetail[]};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const localDate=(v:string|null)=>v?new Date(new Date(v).getTime()+8*3600000).toISOString().slice(0,19):'';
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function InteractionMemoryDialog({agentId,runId,disabled,read,execute,close,seedKind='SharedExperience',seedContent=''}:{agentId:string;runId:string;disabled:boolean;read:Execute;execute:Execute;close:()=>void;seedKind?:UnderstandingKind;seedContent?:string}){
 const [view,setView]=useState<View|null>(null),[selected,setSelected]=useState('');
 const [kind,setKind]=useState<UnderstandingKind>(seedKind),[content,setContent]=useState(seedContent.slice(0,1000));
 const [from,setFrom]=useState(''),[until,setUntil]=useState(''),[scope,setScope]=useState('');
 const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[forgotten,setForgotten]=useState(false);
 const pending=useRef<Command|null>(null);
 const memory=view?.memories.find(m=>m.memory_id===selected);
 const changed=()=>{setConsent(false);setSaved(false);pending.current=null;};
 useEffect(()=>{let alive=true;void read<View>({...envelope(),type:'GetInteractionMemory',agent_id:agentId,payload:{run_id:runId}}).then(v=>{if(alive)setView(v);}).catch(e=>{if(alive)setError(explain(e));});return()=>{alive=false;};},[agentId,runId]);
 function select(id:string){setSelected(id);const m=view?.memories.find(v=>v.memory_id===id);setContent(m?.current.content??seedContent.slice(0,1000));setKind(m?.current.interaction_context?.kind??(m?.current.type==='Episodic'?'SharedExperience':m?'Fact':seedKind));setFrom(localDate(m?.current.valid_from??null));setUntil(localDate(m?.current.valid_until??null));setScope(m?.current.scope??'');changed();}
 async function save(){setBusy(true);setError('');try{pending.current??={...envelope(),type:'RememberInteraction',agent_id:agentId,payload:{run_id:runId,kind,content,confirm_local:true,valid_from:from?from+'+08:00':null,valid_until:until?until+'+08:00':null,scope:scope||null,...(memory?{replace_memory_id:memory.memory_id,replace_expected_revision:memory.revision}:{})}};const value=await execute<MemoryDetail>(pending.current);setView(v=>v?{...v,memories:[...v.memories.filter(m=>m.memory_id!==value.memory_id),value],memory_context:v.memory_context.map(m=>m.memory_id===value.memory_id?{...m,current:false}:m)}:v);setSelected(value.memory_id);setSaved(true);setConsent(false);pending.current=null;}catch(e){setError(explain(e));}finally{setBusy(false);}}
 async function forget(){if(!memory)return;setBusy(true);setError('');try{await execute({...envelope(),type:'ForgetMemory',agent_id:agentId,expected_revision:memory.revision,payload:{memory_id:memory.memory_id}});setForgotten(true);}catch(e){setError(explain(e));}finally{setBusy(false);}}
 return <Modal open close={close} title="记住这次交流／纠正理解" id="interaction-memory-dialog">
  {forgotten?<p role="status">已停止使用这条记忆及应用内依赖内容。原会话是否删除仍由你选择。</p>:<>
  {view&&<details><summary>原始交流与本次使用的记忆（{view.memory_context.length} 条）</summary><p>你：{view.input}</p><p>Agent：{view.reply}</p>{view.memory_context.map(m=><p key={m.revision_id}>{m.content}{!m.current?'（历史版本）':''}</p>)}<p className="small muted">交流原文是经历依据；Agent 的表述不等于你的事实，新的理解以你确认的下文为准。</p></details>}
  <label>新增或纠正<Select id="interaction-memory-target" disabled={disabled||busy} value={selected} onChange={e=>select(e.target.value)}><option value="">记住一条新的理解或经历</option>{view?.memories.map(m=><option key={m.memory_id} value={m.memory_id}>纠正：{m.current.content.slice(0,48)}</option>)}</Select></label>
  <label>记住什么<Select id="interaction-memory-kind" disabled={disabled||busy} value={kind} onChange={e=>{setKind(e.target.value as UnderstandingKind);changed();}}>{Object.entries(understandingNames).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></label>
  <label>希望它记住的内容<textarea id="interaction-memory-content" disabled={disabled||busy} maxLength={1000} value={content} onChange={e=>{setContent(e.target.value);changed();}} placeholder="例如：我们聊过创作中的压力。聊点子时，我通常更希望先讨论想法；明确请你给方案时，再帮助推进。"/></label>
  {kind==='RelationshipUnderstanding'&&<p className="small muted">这是可以改变的相处理解；不把一次交流概括为固定性格、亲密程度或长期情绪。</p>}
  {kind==='TemporaryState'&&<p className="notice">没有结束时间时，只在原对话中使用；提供结束时间后，可在有效期内用于其他相关交流。不会自动成为长期偏好。</p>}
  <details><summary>时间与适用范围（可选）</summary><label>开始时间（上海时间）<DateField id="interaction-memory-from" disabled={disabled||busy} type="datetime-local" value={from} onChange={e=>{setFrom(e.target.value);changed();}}/></label><label>结束时间（上海时间）<DateField id="interaction-memory-until" disabled={disabled||busy} type="datetime-local" value={until} onChange={e=>{setUntil(e.target.value);changed();}}/></label><label>适用范围<input id="interaction-memory-scope" disabled={disabled||busy} maxLength={200} value={scope} onChange={e=>{setScope(e.target.value);changed();}}/></label><p className="small muted">未确定时间不表示永久有效。当前明确请求优先于过往偏好。</p></details>
  <label className="check"><CheckField id="interaction-memory-consent" disabled={disabled||busy} checked={consent} onChange={e=>setConsent(e.target.checked)}/>确认将上面的个人信息或相处理解保存在本机，{memory?'替换这条记忆的当前理解':'作为当前记忆使用'}；启用召回后可发送给已授权的模型。</label>
  <button id="interaction-memory-save" disabled={disabled||busy||!view||!consent||!content.trim()||saved||from==='invalid-date'||until==='invalid-date'} onClick={()=>void save()}>{memory?'保存纠正':'记住这条内容'}</button>
  {saved&&<p role="status">已保存当前记忆。启用召回且相关时用于后续交流；未生成或采用沟通策略。</p>}
  {memory&&<details><summary>不再使用这条理解</summary><p className="small muted">停止召回并清除应用内依赖内容，历史用量保留。</p><button id="interaction-memory-forget" className="text-button" disabled={disabled||busy} onClick={()=>void forget()}>不再使用这条记忆</button></details>}
  </>}{error&&<p role="alert" className="error">{error}</p>}
 </Modal>;
}
