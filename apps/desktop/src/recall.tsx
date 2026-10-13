import {CheckField,NumberField} from './controls';
import {PageTabs} from './ui';
import React,{useState} from "react";
import type {Execute,Provider} from "./chat";

export type Embedding=Provider & {embedding_allowed?:boolean;dimensions?:number;max_calls?:number;calls_started?:number;
  max_total_input_tokens?:number;input_estimate_used?:number;worker_error?:string;
  selection?:Provider & {selection_allowed?:boolean;max_calls?:number;calls_started?:number}};
export function RecallSettings({provider,embedding,execute,disabled}:{provider:Provider;embedding:Embedding;execute:Execute;disabled:boolean}){
  const [category,setCategory]=useState<'embedding'|'selection'>('embedding');
  const [base,setBase]=useState(embedding.base_url??provider.base_url??"");
  const [model,setModel]=useState(embedding.model??"text-embedding-v4"),[key,setKey]=useState("");
  const [reuse,setReuse]=useState(false),[calls,setCalls]=useState(48),[tokens,setTokens]=useState(32768);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const selection=embedding.selection??{};
  const [selectionCalls,setSelectionCalls]=useState(48);
  async function saveSelection(allowed:boolean){
    setBusy(true);setError("");setNotice("");
    try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:"ConfigureProvider",expected_revision:provider.revision??0,
      payload:{base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,
        max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,
        selection_allowed:allowed,selection_max_calls:selectionCalls}});
      setNotice(allowed?"已授权候选相关性筛选；查询会增加一次模型请求，无关或失败结果不会自动回退。":"已关闭候选相关性筛选；召回使用Embedding基础筛选。");
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function save(allowed:boolean){
    setBusy(true);setError("");setNotice("");
    try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:"ConfigureProvider",expected_revision:provider.revision??0,
      payload:{base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,
        max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,
        embedding:{base_url:base,model,api_key:key,embedding_allowed:allowed,use_chat_credential:reuse,max_calls:calls,max_total_input_tokens:tokens}}});
      setKey("");setNotice(allowed?"已保存独立Embedding授权；后台开始构建当前记忆索引。":"召回出站已关闭；本地记忆仍可查看与治理。");
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <section className="memory-configuration"><PageTabs label="召回设置分类" value={category} change={setCategory} items={[["embedding","索引与召回"],["selection","相关性筛选"]]}/><div hidden={category!=="embedding"}>
    <p>召回：{embedding.embedding_allowed?"已授权":"未授权"} · {embedding.dimensions??1024}维 · 本授权请求 {embedding.calls_started??0}/{embedding.max_calls??0} 次</p>
    <p className="small">独立授权：将各 Agent 的当前生效记忆与召回查询发送至下方目的地；索引与查询共享预算。</p><details><summary>索引更新与暂停说明</summary><p>各 Agent 分别检索。索引更新期间不会回退旧事实。暂停会停止后台索引，主动前台查询仍受预算约束。</p></details>
    <p className="muted small">当前目的地：{embedding.base_url||"未配置"} / {embedding.model||"未配置"}。输入估算已用 {embedding.input_estimate_used??0}/{embedding.max_total_input_tokens??0}；每次估算上限4096。未授权时不会调用。</p>
    <label>Embedding API Base URL<input id="embedding-url" value={base} onChange={e=>setBase(e.target.value)} disabled={disabled||busy}/></label>
    <label>Embedding模型<input id="embedding-model" value={model} onChange={e=>setModel(e.target.value)} disabled={disabled||busy}/></label>
    <label>Embedding API Key<input id="embedding-key" type="password" autoComplete="off" value={key} placeholder={embedding.credential_present?"留空保留此目的地的原Key":"独立Key或明确复用同目的地Chat Key"} onChange={e=>setKey(e.target.value)} disabled={disabled||busy||reuse}/></label>
    <label className="check"><CheckField id="embedding-reuse-key" type="checkbox" checked={reuse} onChange={e=>setReuse(e.target.checked)}/>明确复用当前Chat凭据（仅允许相同目的地）</label>
    <div className="budget-fields"><label>新授权请求上限<NumberField id="embedding-calls" type="number" min={1} max={1000} value={calls} onChange={e=>setCalls(Number(e.target.value))}/></label>
      <label>总输入估算上限<NumberField id="embedding-tokens" type="number" min={512} max={1000000} value={tokens} onChange={e=>setTokens(Number(e.target.value))}/></label></div>
    <div className="actions"><button id="allow-embedding" disabled={disabled||busy} onClick={()=>void save(true)}>授权出站与本次预算</button>
      <button id="disable-embedding" className="secondary" disabled={disabled||busy} onClick={()=>void save(false)}>保存配置并关闭出站</button></div>
    </div><div hidden={category!=="selection"}>
    <p>候选相关性筛选：{selection.selection_allowed?"已授权":"未授权"} · 本授权请求 {selection.calls_started??0}/{selection.max_calls??0} 次</p>
    <p className="small">独立授权：复用当前 Chat 连接与凭据，将查询和有效记忆候选出站筛选；通常多一次调用与等待。</p><details><summary>候选筛选的作用与失败处理</summary><p>模型只选择候选，不能更改来源、修订或权限。开启后失败会明确报错，不自动使用未经筛选的结果。</p></details>
    <p className="muted small">筛选目的地：{selection.base_url||"未配置"} / {selection.model||"未配置"}；单次输入估算上限32768、输出上限4096。</p>
    <label>新筛选授权请求上限<NumberField id="selection-calls" type="number" min={1} max={1000} value={selectionCalls} disabled={disabled||busy} onChange={e=>setSelectionCalls(Number(e.target.value))}/></label>
    <div className="actions"><button id="allow-selection" disabled={disabled||busy||!provider.credential_present} onClick={()=>void saveSelection(true)}>授权候选筛选并明确复用Chat配置</button>
      <button id="disable-selection" className="secondary" disabled={disabled||busy} onClick={()=>void saveSelection(false)}>关闭候选筛选</button></div>
    </div>
    {embedding.worker_error&&<p role="alert" className="error">索引处理已停止：{embedding.worker_error}。请重启恢复持久任务。</p>}
    {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
