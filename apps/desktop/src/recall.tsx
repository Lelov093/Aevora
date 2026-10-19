import {BudgetField,budgetLabel} from './budget-field';
import {CheckField} from './controls';
import {SettingSection} from './settings-workspace';
import React,{useState} from "react";
import type {Execute,Provider} from "./chat";

export type Embedding=Provider & {embedding_allowed?:boolean;dimensions?:number;max_calls?:number;calls_unlimited?:boolean;calls_started?:number;
  input_unlimited?:boolean;max_total_input_tokens?:number;input_estimate_used?:number;worker_error?:string;
  selection?:Provider & {selection_allowed?:boolean;max_calls?:number;calls_unlimited?:boolean;calls_started?:number}};
export function RecallSettings({provider,embedding,execute,disabled}:{provider:Provider;embedding:Embedding;execute:Execute;disabled:boolean}){
  const [base,setBase]=useState(embedding.base_url??provider.base_url??"");
  const [model,setModel]=useState(embedding.model??"text-embedding-v4"),[key,setKey]=useState("");
  const [reuse,setReuse]=useState(false),[calls,setCalls]=useState(48),[tokens,setTokens]=useState(32768);
  const [callsUnlimited,setCallsUnlimited]=useState(false),[inputUnlimited,setInputUnlimited]=useState(false),[selectionUnlimited,setSelectionUnlimited]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [feedbackScope,setFeedbackScope]=useState<'embedding'|'selection'>('embedding');
  const feedback=<>{error&&<p role="alert" className="error settings-feedback">{error}</p>}{notice&&<p role="status" className="settings-feedback">{notice}</p>}</>;
  const selection=embedding.selection??{};
  const [selectionCalls,setSelectionCalls]=useState(48);
  async function saveSelection(allowed:boolean){
    setFeedbackScope('selection');setBusy(true);setError("");setNotice("");
    try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:"ConfigureProvider",expected_revision:provider.revision??0,
      payload:{base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,
        max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,
        selection_allowed:allowed,selection_max_calls:selectionCalls,selection_calls_unlimited:selectionUnlimited}});
      setNotice(allowed?"已授权候选相关性筛选；查询会增加一次模型请求，无关或失败结果不会自动回退。":"已关闭候选相关性筛选；召回使用Embedding基础筛选。");
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function save(allowed:boolean){
    setFeedbackScope('embedding');setBusy(true);setError("");setNotice("");
    try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:"ConfigureProvider",expected_revision:provider.revision??0,
      payload:{base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,
        max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,
        embedding:{base_url:base,model,api_key:key,embedding_allowed:allowed,use_chat_credential:reuse,max_calls:calls,max_total_input_tokens:tokens,calls_unlimited:callsUnlimited,input_unlimited:inputUnlimited}}});
      setKey("");setNotice(allowed?"已保存独立Embedding授权；后台开始构建当前记忆索引。":"召回出站已关闭；本地记忆仍可查看与治理。");
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <section className="memory-configuration"><SettingSection title="跨会话召回" description="在新交流中找回相关记忆，独立授权索引与查询。" status={embedding.embedding_allowed?"已授权":"未授权"}>
    <p className="settings-caption">当前预算已请求 {embedding.calls_started??0}/{budgetLabel(embedding.max_calls,embedding.calls_unlimited)} 次 · 输入估算 {embedding.input_estimate_used??0}/{budgetLabel(embedding.max_total_input_tokens,embedding.input_unlimited)}</p>
    <div className="settings-form-grid">
     <label className="field-wide">API Base URL<input id="embedding-url" value={base} onChange={e=>setBase(e.target.value)} disabled={disabled||busy}/></label>
     <label className="field-wide">Embedding 模型<input id="embedding-model" value={model} onChange={e=>setModel(e.target.value)} disabled={disabled||busy}/></label>
     <label className="field-wide">API Key<input id="embedding-key" type="password" autoComplete="off" value={key} placeholder={embedding.credential_present?"留空保留此目的地的原 Key":"填写独立 Key，或明确复用同目的地的 Chat 凭据"} onChange={e=>setKey(e.target.value)} disabled={disabled||busy||reuse}/></label>
     <BudgetField label="新授权请求上限" id="embedding-calls" min={1} max={1000} value={calls} unlimited={callsUnlimited} disabled={disabled||busy} onChange={setCalls} onUnlimitedChange={setCallsUnlimited}/>
     <BudgetField label="总输入估算上限" id="embedding-tokens" min={512} max={1000000} value={tokens} unlimited={inputUnlimited} disabled={disabled||busy} onChange={setTokens} onUnlimitedChange={setInputUnlimited}/>
    </div>
    <label className="check"><CheckField id="embedding-reuse-key" type="checkbox" checked={reuse} onChange={e=>setReuse(e.target.checked)}/>复用当前 Chat 凭据，仅限相同目的地</label>
    <div className="settings-authorization"><p><strong>本次授权</strong> · {base||"未填写目的地"} / {model||"未填写模型"}</p><p>发送各 Agent 的当前生效记忆与召回查询；分别检索，索引与查询共享上述预算。</p>
     <div className="actions"><button id="allow-embedding" disabled={disabled||busy} onClick={()=>void save(true)}>授权出站与本次预算</button><button id="disable-embedding" className="secondary" disabled={disabled||busy} onClick={()=>void save(false)}>保存配置并关闭出站</button></div>
    </div>
    {embedding.worker_error&&<p role="alert" className="error">索引处理已停止：{embedding.worker_error}。请重启恢复持久任务。</p>}
    {feedbackScope==='embedding'&&feedback}<details><summary>当前连接与索引运行详情</summary><p>已存目的地：{embedding.base_url||"未配置"} / {embedding.model||"未配置"} · {embedding.dimensions??1024} 维。单次输入估算上限 4096；未授权时不会调用。</p><p>索引更新期间不回退旧事实。暂停停止后台索引；前台查询仍受预算约束。</p></details>
    </SettingSection><SettingSection title="候选相关性筛选" description="可选的模型筛选，使用独立用途与预算。" status={selection.selection_allowed?"已授权":"未授权"}>
    <p className="settings-caption">当前预算已请求 {selection.calls_started??0}/{budgetLabel(selection.max_calls,selection.calls_unlimited)} 次</p>
    <BudgetField label="新授权请求上限" id="selection-calls" min={1} max={1000} value={selectionCalls} unlimited={selectionUnlimited} disabled={disabled||busy} onChange={setSelectionCalls} onUnlimitedChange={setSelectionUnlimited}/>
    <div className="settings-authorization"><p><strong>本次授权</strong> · {provider.base_url||"未配置"} / {provider.model||"未配置"}</p><p>复用当前 Chat 连接与凭据，发送查询和有效记忆候选；通常增加一次调用与等待。</p><div className="actions"><button id="allow-selection" disabled={disabled||busy||!provider.credential_present} onClick={()=>void saveSelection(true)}>授权筛选并复用 Chat 配置</button><button id="disable-selection" className="secondary" disabled={disabled||busy} onClick={()=>void saveSelection(false)}>关闭候选筛选</button></div></div>
    {feedbackScope==='selection'&&feedback}<details><summary>当前连接与筛选规则</summary><p>已存目的地：{selection.base_url||"未配置"} / {selection.model||"未配置"}。单次输入估算上限 32768、输出上限 4096。</p><p>模型只能选择候选，不能更改来源、修订或权限。失败明确报错，不回退为未经筛选的结果。</p></details>
    </SettingSection>
    {embedding.worker_error&&<p role="alert" className="error">索引处理已停止，请展开跨会话召回查看。</p>}
  </section>;
}
