import {CheckField} from './controls';
import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {Execute,Provider} from './chat';
import type {GoalSummary} from './goals';
import type {Task} from './tasks';
import {Modal} from './ui';
export type Search={service:string;endpoint:string;allowed:boolean;revision:number;credential_present:boolean};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function NetworkCreate({agentId,provider,search,disabled,execute,close,created,seed}:{agentId:string;provider:Provider;search?:Search;disabled:boolean;execute:Execute;close:()=>void;created:(id:string)=>void;seed?:{schedule_id:string;revision:number;title:string;instruction:string;goal?:GoalSummary|null}}){
 const [title,setTitle]=useState(seed?.title??'公开资料研究'),[goal,setGoal]=useState(seed?.instruction??''),[path,setPath]=useState(''),[path2,setPath2]=useState(''),[label2,setLabel2]=useState('行动清单');
 const [personal,setPersonal]=useState(false),[consent,setConsent]=useState(false),[key,setKey]=useState(''),[error,setError]=useState('');
 async function configure(allowed:boolean){try{await execute({...envelope(),type:'ConfigureSearch',expected_revision:search?.revision??0,payload:{allowed,api_key:key}});setKey('');setError('');}catch(e){setError(explain(e));}}
 async function pick(second=false){try{const values=await invoke<string[]>('choose_task_resource',{kind:'output'});if(values.length){(second?setPath2:setPath)(values[0]);setConsent(false);}}catch(e){setError(explain(e));}}
 async function submit(){try{const t=await execute<Task>({...envelope(),type:'CreateNetworkTask',agent_id:agentId,payload:{title,instruction:goal,outputs:[{label:'研究报告',path},...(path2?[{label:label2,path:path2}]:[])],allow_model_outbound:true,allow_memory:personal,...(seed?{schedule_id:seed.schedule_id,schedule_revision:seed.revision,...(seed.goal?{goal_id:seed.goal.goal_id,goal_revision:seed.goal.revision}:{})}:{})}});created(t.task_id);close();}catch(e){setError(explain(e));}}
 return <Modal open close={close} title="受限联网研究" id="network-create-dialog"><form id="network-create-form" onSubmit={e=>{e.preventDefault();void submit();}}>
  {seed&&<p className="notice">来自已到期约定：{seed.title}。请确认保存位置与出站权限，提交后才生成查询计划。</p>}
  <p id="network-draft-notice" className="notice">生成的是供你审阅的研究草稿。请核对事实、适用条件与来源；摘要可能未覆盖全部细节。批准保存表示你接受当前正文，不代表系统已验证所有结论。</p>
  <section className="network-settings"><h3>Tavily Search</h3><p>凭据：{search?.credential_present?'已由本机 Host 保管':'未配置'} · 用途：{search?.allowed?'已允许批准后的查询':'尚未允许'}</p>
   <label>搜索 Key（留空保留当前凭据）<input id="search-api-key" type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)}/></label>
   <p className="small muted">只向 Tavily 发送你批准的查询，每个任务最多 3 次 basic 搜索（包括重试）、每次 5 个候选。启用用途不会立即发起请求。</p>
   <button type="button" className="secondary" disabled={disabled||(!search?.credential_present&&!key)} onClick={()=>void configure(!search?.allowed)}>{search?.allowed?'撤销搜索用途':'允许搜索用途'}</button>
  </section>
  <label>任务名称<input required maxLength={120} value={title} onChange={e=>{setTitle(e.target.value);setConsent(false);}}/></label>
  <label>需要研究的目标与公开信息范围<textarea id="network-goal" required maxLength={4000} rows={3} value={goal} onChange={e=>{setGoal(e.target.value);setConsent(false);}}/></label>
  <label>报告的新建绝对路径<input id="network-output" required value={path} onChange={e=>{setPath(e.target.value);setConsent(false);}}/></label><button type="button" className="secondary" onClick={()=>void pick()}>选择保存位置…</button>
  <label>第二份产物用途（可选）<input value={label2} onChange={e=>{setLabel2(e.target.value);setConsent(false);}}/></label>
  <label>第二份产物的新建绝对路径（可选）<input value={path2} onChange={e=>{setPath2(e.target.value);setConsent(false);}}/></label><button type="button" className="secondary" onClick={()=>void pick(true)}>选择第二份保存位置…</button>
  <label className="check"><CheckField id="network-personal" type="checkbox" checked={personal} onChange={e=>{setPersonal(e.target.checked);setConsent(false);}}/>报告阶段使用 Persona 和已启用的相关当前 Memory。它们不会自动进入搜索查询。</label>
  <label className="check"><CheckField id="network-model-consent" type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许将目标、实际读取的公开正文、上述选定个人上下文及本任务实际保存的首份产物发送到 {provider.base_url} / {provider.model}。先审阅查询，再选择最多 6 个来源批准访问；每份正文与路径另行审批保存。</label>
  <p className="small muted">仅公开 HTTPS 静态 HTML / UTF-8 文本。来源过大、不支持或不可读会明确显示；不会执行网页指令，也不会自动写入 Memory。</p>
  {error&&<p className="error" role="alert">{error}</p>}<div className="actions"><button id="create-network-submit" disabled={disabled||!consent||!search?.allowed||!search?.credential_present||!provider.chat_allowed||!provider.credential_present}>生成查询计划</button><button type="button" className="secondary" onClick={close}>取消</button></div>
 </form></Modal>;
}

export function NetworkReview({task,disabled,execute,onQueryDirty}:{task:Task;disabled:boolean;execute:Execute;onQueryDirty:(dirty:boolean)=>void}){
 const plan=task.runs[0]?.plan;
 const originalQueries=plan?.steps.filter(s=>s.op==='search').map(s=>s.query).join('\n')??'';
 const originals=plan?.deliverables??[];
 const [draft,setDraft]=useState(originalQueries),[requirements,setRequirements]=useState(originals),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState('');
 function dirty(query:string,values:typeof requirements){onQueryDirty(query!==originalQueries||JSON.stringify(values)!==JSON.stringify(originals));}
 async function send(type:'EditNetworkQueries'|'SelectNetworkSources'|'ApproveNetworkRedirect'|'SkipNetworkSource',values={}){try{await execute({...envelope(),type,agent_id:task.agent_id,expected_revision:task.revision,payload:{task_id:task.task_id,...values}} as Parameters<Execute>[0]);setError('');}catch(e){setError(explain(e));}}
 const sources=task.runs[0]?.steps?.filter(s=>s.definition.op==='read_web')??[];
 return <section className="network-review" aria-label="联网范围与来源">
  {task.state==='AwaitingPlanApproval'&&<><label>批准前可编辑查询（每行一条，最多 3 条）<textarea id="network-queries" rows={3} value={draft} onChange={e=>{setDraft(e.target.value);dirty(e.target.value,requirements);}}/></label>
   {requirements.map((d,i)=><label key={d.output}>{task.outputs[i]?.label??'产物'}的具体要求<textarea id={'network-deliverable-'+(i+1)} rows={4} maxLength={4000} value={d.instruction} onChange={e=>{const values=requirements.map((v,j)=>j===i?{...v,instruction:e.target.value}:v);setRequirements(values);dirty(draft,values);}}/></label>)}
   {!requirements.length&&<p className="small">本任务未单独记录各份产物要求，将按原任务目标继续。</p>}
   <button id="save-network-queries" className="secondary" disabled={disabled||requirements.some(d=>!d.instruction.trim())} onClick={()=>void send('EditNetworkQueries',{queries:draft.split(/\r?\n/).filter(q=>q.trim()),...(requirements.length?{deliverables:requirements}:{})})}>保存计划并重新审阅</button><p className="small">请核对每份产物是否完整覆盖你的问题、语言和格式要求。修改查询或产物要求后请先保存，再批准整个计划。来源仍需另选另批，每份正文仍需批准保存。搜索摘要仅用于选源。</p></>}
  {task.state!=='AwaitingPlanApproval'&&originals.length>0&&<section aria-label="本轮产物要求"><h3>{task.runs[0]?.plan_approved?'已批准的产物要求':'本轮产物要求（尚未批准）'}</h3>{originals.map((d,i)=><div key={d.output}><strong>{task.outputs[i]?.label??'产物'}</strong><p className="delivery-requirement">{d.instruction}</p></div>)}</section>}
  {task.state==='AwaitingSources'&&<><h3>选择要读取的来源 · {selected.length}/6</h3><p>批准后，Host 会向所选公开网站发送 GET，并将实际提取正文送交当前模型生成报告。跨主机跳转需另行审批。</p>{!task.candidates?.length&&<p className="notice">没有可用的公开 HTTPS 候选。不会生成假来源；可取消后创建新任务。</p>}{task.candidates?.map(s=><label className="source-candidate check" key={s.source_id}><CheckField type="checkbox" data-source={s.source_id} checked={selected.includes(s.source_id)} disabled={disabled||(!selected.includes(s.source_id)&&selected.length>=6)} onChange={e=>setSelected(v=>e.target.checked?[...v,s.source_id]:v.filter(id=>id!==s.source_id))}/><span><strong>{s.title}</strong><code>{s.url}</code><span className="small">搜索摘要：{s.snippet}</span></span></label>)}<button id="approve-network-sources" disabled={disabled||!selected.length} onClick={()=>void send('SelectNetworkSources',{source_ids:selected})}>批准访问所选来源并生成报告</button></>}
  {task.state==='AwaitingRedirectApproval'&&<div className="notice"><p>该来源要求跨主机跳转。新目的地：<code>{task.current_step?.result?.redirect_url}</code>。批准后会重新读取该来源并检查每次跳转。</p><div className="actions"><button disabled={disabled} onClick={()=>void send('ApproveNetworkRedirect')}>批准此目的地并继续</button><button className="secondary" disabled={disabled} onClick={()=>void send('SkipNetworkSource')}>跳过此来源</button></div></div>}
  {sources.length>0&&<><h3>实际来源正文</h3>{sources.map(s=><details key={s.step_id}><summary>{s.definition.resource} · {s.result?.title||s.definition.url} · {s.result?.status??s.state}</summary><p className="small">原始 URL：{s.definition.url}<br/>最终 URL：{s.result?.final_url??'尚未读取'}<br/>获取时间：{s.result?.fetched_at??'未知'}{s.result?.error?' · '+s.result.error:''}</p><pre className="report-preview">{s.result?.content||'没有可用正文；不作为报告证据。'}</pre></details>)}</>}
  <details><summary>网络请求记录 · {task.network_requests?.length??0} 次已开始</summary><p className="small">未知用量保持未知。继续不会刷新已成功的来源；未完成的再次请求可能增加费用。</p>{task.network_requests?.map(r=><p className="small" key={r.request_id}>{r.kind==='search'?'搜索':'来源读取'} · {r.state} · credits {r.metadata?.usage?.credits??'未知或不适用'}{r.error?' · '+r.error:''}</p>)}</details>
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
