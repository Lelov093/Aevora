import {useState} from 'react';
import {CheckField,Select} from './controls';
import type {Conversation,Execute} from './chat';
import {understandingNames,type MemoryReference} from './interaction-memory';

export type CaseMemory={conversation_id:string;memories:(MemoryReference&{revision_number?:number})[]};
type MemoryItem={memory_id:string;content:string};
type MemoryPage={items:MemoryItem[];has_more:boolean};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function ComparisonMemoryPicker({agentId,index,value,conversations,disabled,read,change,loading}:{agentId:string;index:number;value:CaseMemory;conversations:Conversation[];disabled:boolean;read:Execute;change:(v:CaseMemory)=>void;loading:(busy:boolean)=>void}){
 const [items,setItems]=useState<MemoryItem[]>([]),[query,setQuery]=useState(''),[page,setPage]=useState(0),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 function working(v:boolean){setBusy(v);loading(v);}
 async function list(next=0){working(true);setError('');try{const data=await read<MemoryPage>({...envelope(),type:'ListMemories',agent_id:agentId,payload:{status:'Active',query,page:next}});setItems(data.items);setPage(next);setMore(data.has_more);}catch(e){setError(explain(e));}finally{working(false);}}
 async function select(item:MemoryItem,checked:boolean){if(!checked){change({...value,memories:value.memories.filter(m=>m.memory_id!==item.memory_id)});return;}working(true);setError('');try{const detail=await read<{type:string;status:string;current:MemoryReference&{revision_number:number}}>({...envelope(),type:'GetMemory',agent_id:agentId,payload:{memory_id:item.memory_id}});if(detail.status!=='Active')throw new Error('这条记忆已改变，请重新选择。');change({...value,memories:[...value.memories,{...detail.current,memory_id:item.memory_id,type:detail.type,current:true}]});}catch(e){setError(explain(e));}finally{working(false);}}
 return <details id={`interaction-memory-case-${index}`}><summary>这个情境参考的记忆（{value.memories.length} 条）</summary>
  <p className="small muted">默认不加载记忆；选中后，两种策略使用相同版本。无关情境可以留空。</p>
  <label>情境所在对话<Select id={`interaction-memory-conversation-${index}`} value={value.conversation_id} disabled={disabled||busy} onChange={e=>change({conversation_id:e.target.value,memories:[]})}>{!conversations.some(c=>c.conversation_id===value.conversation_id)&&<option value={value.conversation_id}>候选来源对话</option>}{conversations.map(c=><option key={c.conversation_id} value={c.conversation_id}>{c.display_title??c.title}</option>)}</Select></label><p className="small muted">用于核对临时状态的适用范围，不加载这段对话历史。切换后请重新选择记忆。</p>
  {value.memories.map(m=><div className="notice" key={m.memory_id}><strong>{m.interaction_context?.kind?understandingNames[m.interaction_context.kind]:m.evidence_kind==='agent_inference'?'待核实推断':'事实／偏好'} · 版本 {m.revision_number??m.revision_id}</strong><p>{m.content}</p><p className="small muted">记录于 {m.recorded_at} · 有效期 {m.valid_from??'起点未指定'} 至 {m.valid_until??'终点未指定'}{m.scope?' · '+m.scope:''}{m.interaction_context?.conversation_id?' · 仅原对话':''}</p><button className="text-button" disabled={disabled||busy} onClick={()=>change({...value,memories:value.memories.filter(v=>v.memory_id!==m.memory_id)})}>移除这条记忆</button></div>)}
  <label>查找已确认的记忆<input id={`interaction-memory-query-${index}`} maxLength={100} value={query} disabled={disabled||busy} onChange={e=>setQuery(e.target.value)}/></label><button id={`interaction-memory-list-${index}`} className="secondary" disabled={disabled||busy} onClick={()=>void list()}>查找记忆</button>
  {items.map(item=><label className="check" key={item.memory_id}><CheckField id={`interaction-memory-pick-${index}-${item.memory_id}`} checked={value.memories.some(m=>m.memory_id===item.memory_id)} disabled={disabled||busy||value.memories.length>=5&&!value.memories.some(m=>m.memory_id===item.memory_id)} onChange={e=>void select(item,e.target.checked)}/>{item.content}</label>)}
  <div>{page>0&&<button className="text-button" disabled={disabled||busy} onClick={()=>void list(page-1)}>上一页记忆</button>}{more&&<button className="text-button" disabled={disabled||busy} onClick={()=>void list(page+1)}>下一页记忆</button>}</div>
  <p className="small muted">每个情境最多五条。过期、被纠正或超出对话范围的版本需要重新核对。</p>{error&&<p role="alert" className="error">{error}</p>}
 </details>;
}
