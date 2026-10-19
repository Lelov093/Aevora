import {BudgetField,budgetLabel} from './budget-field';
import {SettingSection} from './settings-workspace';
import {taskNames} from './work-state';
import {CheckField,DateField,NumberField,Select} from './controls';
import React,{useEffect,useRef,useState} from "react";
import type {Command} from "../../../packages/protocol/command";
import type {Execute,Provider} from "./chat";
import {Modal,PageTabs} from "./ui";
import {RecallSettings,type Embedding} from "./recall";
import {understandingNames,type UnderstandingKind} from './interaction-memory';

export type Extraction=Provider & {extraction_allowed?:boolean;max_calls?:number;calls_unlimited?:boolean;calls_started?:number;data_categories?:string[];grant_id?:string;worker_error?:string};
type Settings={mode:"Manual"|"Balanced";revision:number};
type Summary={memory_id:string;revision:number;status:string;type:string;content:string;sensitivity:string;policy_reason:string};
type Source={task?:{task_id:string;run_id:string;title:string;state:string}|null;source_id:string;source_type:string;relation?:string;created_at:string;available:boolean;span:string|null;message:{conversation_id:string;role:string;content:string;created_at:string;source_timezone:string|null}|null};
type Revision={revision_id:string;revision_number:number;content:string;policy_reason:string;sensitivity:string;recorded_at:string;valid_from:string|null;valid_until:string|null;scope:string|null;evidence_kind:string;confidence:number;importance:number;sources:Source[];interaction_context?:{kind?:UnderstandingKind;conversation_id?:string}};
type Detail=Summary & {current:Revision;history:Revision[];conflicts:{memory_id:string;revision:number;content:string}[];metadata_error:string|null;metadata_validation:{status:string}};
type Job={job_id:string;state:string;error:string|null;attempt:number;source_range:string[];created_at:string;provider_metadata:{candidate_counts?:Record<string,number>}};
const env=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
function evidenceText(source:Source){
  const text=source.message?.content??"";if(!source.span)return text;
  try{const [start,end]=JSON.parse(source.span) as [number,number];return <>{text.slice(0,start)}<mark>{text.slice(start,end)}</mark>{text.slice(end)}</>;}catch{return text;}
}
const typeName:Record<string,string>={Semantic:"事实与偏好",Episodic:"经历",Prospective:"未来计划"};
const reasons:Record<string,string>={ExplicitLowRisk:"明确请求 · 低风险",DirectLowRisk:"直接陈述 · 低风险",ReviewRequired:"需核对来源与风险",ConflictReviewRequired:"与现有记忆冲突",UserReview:"用户审核",UserApprovedCorrection:"用户批准更正",UserConfirmedInteraction:"用户确认的交流理解"};
const jobStates:Record<string,string>={Pending:"等待提取",Running:"正在提取",Completed:"提取完成",Failed:"提取失败",Cancelled:"已取消"};
function shanghaiTime(value:string){return new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});}
function jobError(error:string){return error==="InvalidTemporalMetadata"?"提取的时间或适用范围没有可核验的原文依据，本批次未保存。请核对来源；重试仍需可用预算。":error;}
function explain(error:unknown){try{const e=JSON.parse(String(error)).error;return ({RevisionConflict:"记忆已更新或与其他记忆冲突，请重新载入并核对。",RecallUpdating:"当前记忆索引未就绪或正在更新，请稍后重试。",RecallUnavailable:"召回授权或预算不可用，请检查记忆设置。",SourceRevoked:"旧来源已撤销，不能通过重试恢复；请重新明确提供新的事实。",ValidationError:"内容或时间格式无效，请核对后重试。",PersistenceFailed:"保存或清除未完成，尚未确认成功。",NotFound:"记录已删除或不可用。"} as Record<string,string>)[e.code]??e.message;}catch{return String(error);}}

export function MemoryCenter({agentId,extraction,embedding,sequence,disabled,runtimeState,execute,read,openTask,openConversation,initialView="memories"}:{agentId:string;initialView?:"memories"|"processing";extraction:Extraction;embedding:Embedding;sequence:number;disabled:boolean;runtimeState:string;execute:Execute;read:Execute;openTask?:(id:string)=>void;openConversation:(cid:string)=>Promise<void>}){
  const [view,setView]=useState<'memories'|'processing'>(initialView),[detailTab,setDetailTab]=useState<'content'|'sources'|'history'>('content');
  const [tab,setTab]=useState<"Candidate"|"Active"|"History">("Active"),[query,setQuery]=useState(""),[page,setPage]=useState(0);
  const [items,setItems]=useState<Summary[]>([]),[more,setMore]=useState(false),[jobs,setJobs]=useState<Job[]>([]);
  const [settings,setSettings]=useState<Settings|null>(null);
  const [detail,setDetail]=useState<Detail|null>(null),[confirm,setConfirm]=useState(false),[target,setTarget]=useState("");
  const [error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const blocked=disabled||busy;
  const [indexJobs,setIndexJobs]=useState<{job_id:string;memory_id:string;revision_id:string;state:string;error:string|null;attempt:number}[]>([]);
  const [editing,setEditing]=useState(false),[editRevision,setEditRevision]=useState(0),[content,setContent]=useState("");
  const [from,setFrom]=useState(""),[until,setUntil]=useState(""),[scope,setScope]=useState("");
  const [governance,setGovernance]=useState<"ForgetMemory"|"DeleteMemory"|null>(null);
  const [governanceRevision,setGovernanceRevision]=useState(0);
  const [semantic,setSemantic]=useState(false);
  const [semanticItems,setSemanticItems]=useState<Summary[]>([]);
  const displayed=semantic?semanticItems:items;
  useEffect(()=>{setSemantic(false);setSemanticItems([]);},[sequence]);
  function localDate(value:string|null){return value?new Date(value).toLocaleString("sv-SE",{timeZone:"Asia/Shanghai",hour12:false}).replace(" ","T"):"";}
  function startEdit(){if(detail){setEditing(true);setGovernance(null);setEditRevision(detail.revision);setContent(detail.current.content);setFrom(localDate(detail.current.valid_from));setUntil(localDate(detail.current.valid_until));setScope(detail.current.scope??"");}}
  useEffect(()=>{let stale=false;void read<typeof indexJobs>({...env(),type:"ListEmbeddingJobs",agent_id:agentId,payload:{}}).then(j=>{if(!stale)setIndexJobs(j);}).catch(e=>{if(!stale)setError(String(e));});return()=>{stale=true;};},[agentId,sequence]);
  useEffect(()=>{if(!detail)return;let stale=false;void read<Detail>({...env(),type:"GetMemory",agent_id:agentId,payload:{memory_id:detail.memory_id}}).then(d=>{if(!stale)setDetail(d);}).catch(()=>{if(!stale){setDetail(null);setContent("");setEditing(false);setGovernance(null);}});return()=>{stale=true;};},[sequence,detail?.memory_id]);
  useEffect(()=>{
    let stale=false;setLoading(true);
    const timer=setTimeout(()=>{
      void Promise.all([
        read<{items:Summary[];has_more:boolean}>({...env(),type:"ListMemories",agent_id:agentId,payload:{status:tab,query,page}}),
        read<Job[]>({...env(),type:"ListMemoryJobs",agent_id:agentId,payload:{}}),
        read<Settings>({...env(),type:"GetMemorySettings",agent_id:agentId,payload:{}})
      ]).then(([list,j,s])=>{if(!stale){setItems(list.items);setMore(list.has_more);setJobs(j);setSettings(s);setLoading(false);}}).catch(e=>{if(!stale){setError(String(e));setLoading(false);}});
    },180);
    return()=>{stale=true;clearTimeout(timer);};
  },[agentId,sequence,tab,query,page]);
  async function act(action:()=>Promise<unknown>){setBusy(true);setError("");setNotice("");try{await action();}catch(e){setError(explain(e));}finally{setBusy(false);}}
  async function show(mid:string){await act(async()=>{const d=await read<Detail>({...env(),type:"GetMemory",agent_id:agentId,payload:{memory_id:mid}});setDetail(d);setDetailTab("content");setConfirm(false);setEditing(false);setGovernance(null);setContent("");setTarget(d.conflicts[0]?.memory_id??"");});}
  async function review(decision:"Approve"|"Reject"){
    if(!detail)return;
    await act(async()=>{
      const replaced=detail.conflicts.find(c=>c.memory_id===target);
      await execute({...env(),type:"ReviewMemory",agent_id:agentId,expected_revision:detail.revision,payload:{memory_id:detail.memory_id,decision,confirm_sensitive:confirm,...(decision==="Approve"&&replaced?{replace_memory_id:replaced.memory_id,replace_expected_revision:replaced.revision}:{})}});
      setDetail(null);setNotice(decision==="Approve"?"已批准并保存":"已拒绝，候选保留在历史中");
    });
  }
  return <section className="memory-center">
    <div className="view-heading"><h1>记忆</h1><span className="badge">{settings?.mode==="Manual"?"手动审核":"保守 Balanced"}</span></div>
    <PageTabs label="记忆页面" value={view} change={setView} items={[["memories","记忆内容"],["processing","处理记录"]]}/>
    <div className="memory-scroll"><div hidden={view!=="memories"}>
      {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {jobs.some(j=>j.state==="Pending")&&<p role="status" className="muted">{runtimeState==="Paused"?"后台已暂停，提取任务等待恢复。":!extraction.extraction_allowed?"尚未授权 Memory Extraction，提取任务正在等待。":!extraction.calls_unlimited&&(extraction.calls_started??0)>=(extraction.max_calls??0)?"当前提取预算已耗尽，排队任务等待新的明确授权。":"提取任务已排队，等待后台处理。"}</p>}
      <p className="muted small">{embedding.embedding_allowed?"新会话可使用当前有效记忆；当前索引未就绪时会明确提示更新中。":"跨会话召回尚未获得Embedding授权；本地提取、审核、编辑和遗忘/删除仍可使用。"}</p>
      <div className="memory-toolbar"><nav aria-label="记忆分类" className="settings-tabs">{([['Candidate','待审核'],['Active','已保存'],['History','历史']] as const).map(([key,label])=><button id={"memory-tab-"+key} key={key} disabled={blocked} className={tab===key?"selected":""} aria-current={tab===key?"page":undefined} onClick={()=>{setSemantic(false);setTab(key);setPage(0);}}>{label}</button>)}</nav><input aria-label="搜索记忆" id="memory-search" value={query} disabled={blocked} placeholder="搜索记忆正文" onChange={e=>{setSemantic(false);setQuery(e.target.value);setPage(0);}}/><button id="memory-semantic-search" className="secondary" disabled={blocked||!query.trim()||!embedding.embedding_allowed} onClick={()=>void act(async()=>{const result=await read<{items:Summary[]}>({...env(),type:"SearchMemories",agent_id:agentId,payload:{query:query.trim()}});setSemanticItems(result.items);setMore(false);setSemantic(true);setNotice("语义结果仅包含当前Agent的有效Active记忆；本次查询计入Embedding预算；如已授权候选筛选，也计入独立筛选预算。");})}>语义查找</button></div>
      {loading?<p role="status">正在读取本机记忆…</p>:!displayed.length?<div className="empty-state compact"><h2>{query?"没有匹配的记忆":"这里还没有记忆"}</h2><p>{tab==="Candidate"?"提取后需要确认的候选会出现在这里。":"只有实际持久化的记忆会显示在此处。"}</p></div>:<div className="memory-list">{displayed.map(m=><button data-memory={m.memory_id} key={m.memory_id} className="memory-card" disabled={blocked} onClick={()=>void show(m.memory_id)}><span className="badge">{typeName[m.type]}</span><strong>{m.content}</strong><small>{reasons[m.policy_reason]??m.policy_reason} · {m.sensitivity==="low"?"低风险":"敏感 / 未确定"}</small></button>)}</div>}
      <div className="actions"><button className="secondary" disabled={semantic||page===0||loading} onClick={()=>setPage(page-1)}>上一页</button><span>{semantic?"语义结果 · 最多5条":"第 "+(page+1)+" 页"}</span><button className="secondary" disabled={semantic||!more||loading} onClick={()=>setPage(page+1)}>下一页</button></div>
      {jobs.some(j=>j.state==='Failed')&&<p className="notice">有提取记录未完成。<button className="text-button" onClick={()=>setView('processing')}>查看处理记录</button></p>}
      </div><div hidden={view!=='processing'}>
      <section className="memory-jobs"><h2>提取处理 · 最近 30 项</h2>
        {extraction.worker_error&&<p role="alert" className="error">后台提取处理已停止：{extraction.worker_error}。请重启应用以恢复持久任务。</p>}{runtimeState==="Paused"&&<p>后台已暂停，待处理任务不会领取。</p>}{!extraction.extraction_allowed&&jobs.some(j=>j.state==="Pending")&&<p>待处理任务等待独立 Extraction 授权。</p>}{extraction.extraction_allowed&&!extraction.calls_unlimited&&(extraction.calls_started??0)>=(extraction.max_calls??0)&&<p>当前调用预算已用完，等待新授权。</p>}
        {!jobs.length?<p className="muted">还没有提取任务。</p>:jobs.map(j=><div className="job-row" key={j.job_id} data-memory-job={j.job_id}><div><strong>{jobStates[j.state]}</strong><small>尝试 {j.attempt} 次 · {new Date(j.created_at).toLocaleString()}</small>{j.error&&<span className="error" role="alert">{jobError(j.error)}</span>}{j.provider_metadata.candidate_counts&&<small>待审核 {j.provider_metadata.candidate_counts.Candidate} · 生效 {j.provider_metadata.candidate_counts.Active} · 拒绝 {j.provider_metadata.candidate_counts.Rejected} · 重复 {j.provider_metadata.candidate_counts.Duplicate}</small>}</div>{['Failed','Cancelled'].includes(j.state)&&<button className="secondary" disabled={blocked} onClick={()=>void act(async()=>{await execute({...env(),type:"RetryMemoryJob",agent_id:agentId,payload:{job_id:j.job_id}});setNotice("重试已排队，继续受授权、预算和暂停状态限制");})}>重试提取</button>}</div>)}
      </section>
      <section className="memory-jobs"><h2>召回索引 · 最近 30 项</h2>{!indexJobs.length?<p className="muted">尚未配置索引或没有Active记忆。</p>:indexJobs.map(j=><div className="job-row" key={j.job_id}><div><strong>{j.state==="Completed"?"索引就绪":j.state==="Pending"?"等待索引":j.state==="Running"?"正在索引":j.state==="Failed"?"索引失败":"旧修订已失效"}</strong><small>尝试 {j.attempt} 次</small>{j.error&&<span>{j.error}</span>}</div>{j.state==="Failed"&&<button className="secondary" disabled={blocked} onClick={()=>void act(async()=>{await execute({...env(),type:"RetryEmbeddingJob",agent_id:agentId,payload:{job_id:j.job_id}});})}>重试索引</button>}</div>)}</section></div>
    </div>
    <Modal open={!!detail} close={()=>{setDetail(null);setContent("");setEditing(false);setGovernance(null);}} title="记忆详情与来源" id="memory-dialog">{detail&&<>
      <PageTabs label="记忆详情分类" value={detailTab} change={setDetailTab} items={[["content","正文与管理"],["sources","来源"],["history","版本历史"]]}/>
      <div hidden={detailTab!=="content"}><p className="memory-content">{detail.current.content}</p><p className="muted">{typeName[detail.type]} · {detail.status==="Candidate"?"待审核":detail.status==="Active"?"已生效":detail.status==="Rejected"?"已拒绝":detail.status==="Superseded"?"已替代":detail.status} · revision {detail.current.revision_number} · {reasons[detail.current.policy_reason]??detail.current.policy_reason}</p>
      <SettingSection title="有效期与适用范围"><div id="memory-validity"><p>有效期：{detail.current.valid_from?shanghaiTime(detail.current.valid_from):"开始未确定"} — {detail.current.valid_until?shanghaiTime(detail.current.valid_until):"结束未确定"}（上海时间 UTC+08:00；结束边界不包含在内）</p><p className="muted small">未确定有效期不表示永久有效；临时描述仍以原文和来源时间为准。适用范围：{detail.current.scope||"未提供结构化范围，保留原文限定"}</p></div>
</SettingSection><SettingSection title="修订与证据详情">      <p className="muted small">记录时间：{shanghaiTime(detail.current.recorded_at)}（上海时间 UTC+08:00） · 证据：{detail.current.evidence_kind==="user_statement"?"用户陈述":detail.current.evidence_kind==="user_edit"?"用户确认／更正":"Agent 推断"} · 置信度 {detail.current.confidence}（不表示权限）</p>
      <p className="small muted">{detail.current.interaction_context?.kind&&understandingNames[detail.current.interaction_context.kind]}{detail.current.interaction_context?.conversation_id?" · 临时状态仅适用于原对话":""}</p></SettingSection>
      {detail.metadata_error&&<p id="memory-metadata-error" role="alert" className="error">时间或范围尚未得到完整来源支持。{detail.status==="Candidate"?"不能批准保存或更正已有记忆；可以拒绝此候选，原始记录保留。":"该历史字段不能作为已确认的有效期或范围依据。"}</p>}
      </div><div hidden={detailTab!=="sources"}><h3>当前版本的来源与关联交流</h3>{detail.current.sources.map(s=><div className="memory-source" key={s.source_id}>{s.source_type==="user_edit"?<p>用户独立编辑 · {shanghaiTime(s.created_at)} · 此版本以本次编辑为来源，旧聊天不为新正文作证。</p>:s.source_type==="task_run"&&s.available&&s.task?<><small>关联工作经历（不是内容验收或新解释的证明）</small><p>{s.task.title} · {taskNames[s.task.state]??s.task.state}</p><p className="small">Task {s.task.task_id} · Run {s.task.run_id}</p>{openTask&&<button className="text-button" disabled={blocked} onClick={()=>{if(s.task)openTask(s.task.task_id);setDetail(null);}}>查看来源任务与实际回执</button>}</>:s.available&&s.message?<><small>{s.relation==="related_to"?"关联交流（不为新解释作证）":"支持当前版本"} · {s.message.role==="user"?"用户输入":"助手回复"} · {shanghaiTime(s.message.created_at)}（上海时间 UTC+08:00） · 输入时区：{s.message.source_timezone||"历史输入未记录"}</small><blockquote>{evidenceText(s)}</blockquote><button className="text-button" disabled={blocked} onClick={()=>void act(async()=>{if(s.message)await openConversation(s.message.conversation_id);setDetail(null);})}>打开来源会话</button></>:<p>来源已删除或不可用</p>}</div>)}
      </div><div hidden={detailTab!=="history"}><h3>版本历史 · {detail.history.length}</h3>{detail.history.map(r=><div key={r.revision_id} className="memory-source"><strong>revision {r.revision_number}</strong><p>{r.content}</p><small>{new Date(r.recorded_at).toLocaleString()} · {reasons[r.policy_reason]??r.policy_reason}</small></div>)}</div><div hidden={detailTab!=="content"}>
      {detail.status==="Candidate"&&<>{detail.conflicts.length>0&&<label>批准将更正这条已有记忆<Select value={target} onChange={e=>setTarget(e.target.value)}>{detail.conflicts.map(c=><option key={c.memory_id} value={c.memory_id}>{c.content}</option>)}</Select></label>}{detail.current.sensitivity!=="low"&&<label className="check"><CheckField id="memory-confirm-sensitive" type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>我已核对来源，明确批准这条敏感或未知风险内容保存在本机</label>}
        <p className="small">批准前请核对 <button className="text-button" onClick={()=>setDetailTab("sources")}>当前版本的来源与关联交流</button>。</p><div className="actions"><button id="approve-memory" disabled={blocked||!!detail.metadata_error||(detail.current.sensitivity!=="low"&&!confirm)} onClick={()=>void review("Approve")}>{detail.conflicts.length?"批准并更正已有记忆":"批准并保存"}</button><button id="reject-memory" className="secondary" disabled={blocked} onClick={()=>void review("Reject")}>拒绝</button></div></>}
      {detail.status==="Active"&&<><p className="muted">当前修订索引：{indexJobs.find(j=>j.revision_id===detail.current.revision_id)?.state==="Completed"?"就绪":"未就绪或更新中"}</p><div className="actions"><button id="edit-memory" disabled={blocked} onClick={startEdit}>编辑</button><button id="forget-memory" className="secondary" disabled={blocked} onClick={()=>{setEditing(false);setGovernanceRevision(detail.revision);setGovernance("ForgetMemory");}}>遗忘</button></div></>}
      {editing&&<form id="memory-edit-form" onSubmit={e=>{e.preventDefault();if(detail)void act(async()=>{await execute({...env(),type:"EditMemory",agent_id:agentId,expected_revision:editRevision,payload:{memory_id:detail.memory_id,content,valid_from:from?from+"+08:00":null,valid_until:until?until+"+08:00":null,scope:scope||null}});setEditing(false);setContent("");setDetail(null);setNotice("新修订已保存，索引待更新；不会回退旧事实。");});}}>
        <label>当前记忆正文<textarea id="memory-edit-content" required maxLength={1000} value={content} onChange={e=>setContent(e.target.value)}/></label>
        <div className="budget-fields"><label>有效期开始（上海时间）<DateField type="datetime-local" step={1} value={from} onChange={e=>setFrom(e.target.value)}/></label><label>有效期结束（不包含，上海时间）<DateField type="datetime-local" step={1} value={until} onChange={e=>setUntil(e.target.value)}/></label></div>
        <label>适用范围<input maxLength={200} value={scope} onChange={e=>setScope(e.target.value)}/></label><p className="muted small">留空表示未确定；编辑由你确认，保存时记为独立用户来源。原历史仅解释变化。</p>
        <div className="actions"><button id="save-memory-edit" disabled={blocked||!content.trim()}>保存新修订</button><button type="button" className="secondary" onClick={()=>setEditing(false)}>取消编辑</button></div>
      </form>}
      <details className="memory-delete"><summary>删除记忆与数据范围</summary><p className="small muted">删除清除这条记忆正文、全部历史、向量和应用受控副本；原始来源会话仍保留。若需删除原文，请另行删除来源会话。</p><button id="delete-memory" className="secondary" disabled={blocked} onClick={()=>{setEditing(false);setGovernanceRevision(detail.revision);setGovernance("DeleteMemory");}}>删除记忆…</button></details>
      {governance&&<div className="notice" role="alert">{governanceRevision!==detail.revision&&<p>记忆已在其他窗口更新，请取消并重新核对确认范围。</p>}<p>{governance==="ForgetMemory"?"确认遗忘？将停止记忆召回，原会话仍可能进入近期上下文；历史可保留。旧提取任务不会重新激活它。":"确认删除这条记忆及全部修订？本地清除无法撤回，原始来源会话仍保留。"}</p><div className="actions"><button id="confirm-memory-governance" disabled={blocked||governanceRevision!==detail.revision} onClick={()=>void act(async()=>{await execute({...env(),type:governance,agent_id:agentId,expected_revision:governanceRevision,payload:{memory_id:detail.memory_id}});setDetail(null);setContent("");setGovernance(null);setNotice(governance==="ForgetMemory"?"已遗忘":"已删除记忆及全部历史正文");})}>确认{governance==="ForgetMemory"?"遗忘":"删除"}</button><button className="secondary" onClick={()=>setGovernance(null)}>取消</button></div></div>}
      {error&&<p className="error" role="alert">{error}</p>}</div>
    </>}</Modal>
  </section>;
}

export function MemorySettings({agentId,provider,extraction,embedding,sequence,disabled,execute,read}:{agentId:string;provider:Provider;extraction:Extraction;embedding:Embedding;sequence:number;disabled:boolean;execute:Execute;read:Execute}){
  const [settings,setSettings]=useState<Settings|null>(null),[mode,setMode]=useState<Settings['mode']>('Balanced'),[modeRevision,setModeRevision]=useState(0);
  const modeDirty=useRef(false);const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[calls,setCalls]=useState(12),[callsUnlimited,setCallsUnlimited]=useState(false);
  const [feedbackScope,setFeedbackScope]=useState<'policy'|'extraction'>('policy');
  const feedback=<>{error&&<p className="error settings-feedback" role="alert">{error}</p>}{notice&&<p role="status" className="settings-feedback">{notice}</p>}</>;
  const blocked=disabled||busy;
  useEffect(()=>{let active=true;void read<Settings>({...env(),type:'GetMemorySettings',agent_id:agentId,payload:{}}).then(s=>{if(active){setSettings(s);if(!modeDirty.current){setMode(s.mode);setModeRevision(s.revision);}}}).catch(e=>{if(active)setError(explain(e));});return()=>{active=false;};},[agentId,sequence]);
  async function act(action:()=>Promise<unknown>){setBusy(true);setError('');setNotice('');try{await action();}catch(e){setError(explain(e));}finally{setBusy(false);}}
  async function purpose(allowed:boolean){setFeedbackScope('extraction');await act(async()=>{
    await execute({...env(),type:"ConfigureProvider",expected_revision:provider.revision??0,payload:{base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,extraction_allowed:allowed,extraction_max_calls:calls,extraction_calls_unlimited:callsUnlimited}});
    setNotice(allowed?"已保存独立提取授权与调用预算":"已撤销提取用途；本地记忆仍可查看");
  });}
  return <section className="settings-section"><h2>记忆与学习</h2><p className="muted">保存策略属于当前 Agent；出站用途与预算由 Host 共享管理。</p>
    <div><section className="memory-configuration"><h3>保存策略</h3>
        <p className="muted">选择如何保存记忆；敏感、不确定或冲突内容仍需审核。</p>
        <span className="settings-field-title" id="memory-mode-label">自动化</span><div className="settings-control-line"><Select aria-labelledby="memory-mode-label" aria-label="自动化" id="memory-mode" value={mode} disabled={blocked} onChange={e=>{modeDirty.current=true;setMode(e.target.value as Settings["mode"]);}}><option value="Manual">手动审核（Manual）</option><option value="Balanced">保守自动保存（Balanced）</option></Select><button id="save-memory-mode" disabled={blocked||!settings} onClick={()=>{setFeedbackScope('policy');void act(async()=>{if(settings){const saved=await execute<Settings>({...env(),type:"ConfigureMemory",agent_id:agentId,expected_revision:modeRevision,payload:{mode}});modeDirty.current=false;setModeRevision(saved.revision);}setNotice("记忆策略已保存");});}}>保存策略</button><button className="text-button" disabled={blocked||!settings} onClick={()=>{if(settings){setMode(settings.mode);setModeRevision(settings.revision);modeDirty.current=false;setError("");}}}>重新载入策略</button></div>
        {feedbackScope==='policy'&&feedback}<details><summary>保存策略与审核规则</summary><p>手动审核（Manual）可保存直接、明确的低风险记住请求；保守自动保存（Balanced）可保存经验证的低风险稳定事实。两者均核对完整用户原文；引用、推断、临时或冲突信息，以及敏感或无法分类的内容仍需审核。模型风险标签不能授予保存权限。</p></details>
      </section></div><SettingSection title="自动整理记忆" description="从已完成交流中提取记忆，独立授权与预算。" status={extraction.extraction_allowed?"已授权":"未授权"}><section className="memory-configuration">
        <p className="settings-caption">当前预算已开始 {extraction.calls_started??0}/{budgetLabel(extraction.max_calls,extraction.calls_unlimited)} 次调用</p>

        <div className="settings-authorization"><p><strong>本次授权</strong> · {provider.base_url||"未配置"} / {provider.model||"未配置"}</p><p>发送各 Agent 待处理及未来完整成功对话、各自最多 10 条当前记忆；共享本次预算。</p>
        <div className="actions"><BudgetField label="新授权调用上限" id="extraction-calls" min={1} max={100} value={calls} unlimited={callsUnlimited} disabled={blocked} onChange={setCalls} onUnlimitedChange={setCallsUnlimited}/><button id="allow-extraction" disabled={blocked||!provider.credential_present} onClick={()=>void purpose(true)}>授权本次提取预算</button><button id="revoke-extraction" className="secondary" disabled={blocked||!extraction.extraction_allowed} onClick={()=>void purpose(false)}>撤销提取用途</button></div>
        {extraction.extraction_allowed&&<p className="muted small">实际提取目的地：{extraction.base_url} / {extraction.model}。修改 Chat 连接不会自动迁移已有提取授权。</p>}
</div>{feedbackScope==='extraction'&&feedback}<details><summary>提取失败、暂停与后台运行</summary><p>各 Agent 的内容分别处理与保存。提取可独立失败，不改变聊天成功状态。暂停后台工作会停止领取并尝试取消在途提取；关闭窗口后继续运行。输入估算上限 4096、输出 1024 tokens；无自动重试，预算耗尽后等待新授权。</p></details>
      </section>
</SettingSection><RecallSettings provider={provider} embedding={embedding} execute={execute} disabled={blocked}/>
  </section>;
}
