import {ToolScopeFields,emptyToolScope,GeneralToolObservations} from './general-tools';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CheckField,NumberField,Select} from './controls';
import {Modal} from './ui';
import {Markdown} from './markdown';
import type {Execute,Provider} from './chat';
import type {Search} from './network-tasks';
import type {Task} from './tasks';
import {providerBinding,type Proposal,type MethodRef,type EvaluationDraft} from './methods';
import type {WorkSeed} from './work';
import {DocumentResources,DocumentObservations,type DocumentResource} from './document-work';

const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function AgentWorkDialog({agentId,provider,search,conversationId,seed,evaluation,initialText='',disabled,read,execute,close,created}:{agentId:string;provider:Provider;search?:Search;conversationId?:string;seed?:WorkSeed;evaluation?:EvaluationDraft;initialText?:string;disabled:boolean;read:Execute;execute:Execute;close:()=>void;created:(id:string)=>void}){
 const [tools,setTools]=useState(emptyToolScope);
 const [documents,setDocuments]=useState<DocumentResource[]>([]);
 const suggested=seed?.work.suggestion;
 const [title,setTitle]=useState(evaluation?.title??(suggested&&'title' in suggested?suggested.title:'查证或处理事务'));
 const [instruction,setInstruction]=useState(evaluation?.instruction??(suggested&&'instruction' in suggested?suggested.instruction:initialText));
 const [sources,setSources]=useState(evaluation?.sources.join('\n')??''),[outputs,setOutputs]=useState<string[]>([]),[network,setNetwork]=useState(evaluation?.agent_limits?.allow_search??false),[memory,setMemory]=useState(evaluation?.agent_limits?.allow_memory??false),[budget,setBudget]=useState(evaluation?.agent_limits?.max_decisions??8);
 const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[methods,setMethods]=useState<Proposal[]>([]),[method,setMethod]=useState<MethodRef|null>(evaluation?.method_ref??null);
 useEffect(()=>{void read<Proposal[]>({...envelope(),type:'ListMethods',agent_id:agentId,payload:{}}).then(setMethods).catch(e=>setError(explain(e)));},[agentId]);
 useEffect(()=>setConsent(false),[provider.base_url,provider.model,provider.revision,search?.revision]);
 function changed(){setConsent(false);}
 async function pick(index?:number){try{const paths=await invoke<string[]>('choose_task_resource',{kind:index===undefined?'sources':'output'});if(paths.length){if(index===undefined)setSources(paths.join('\n'));else setOutputs(old=>Array.from({length:2},(_,j)=>index===j?paths[0]:old[j]??''));changed();}}catch(e){setError(explain(e));}}
 async function create(){setBusy(true);setError('');try{const t=await execute<Task>({...envelope(),type:'CreateAgentTask',agent_id:agentId,payload:{title,instruction,tools,...(documents.length?{documents}:{}),sources:sources.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),outputs:outputs.filter(v=>v.trim()).map((path,i)=>({path,label:`产物 ${i+1}`})),max_decisions:budget,allow_file_outbound:true,provider:providerBinding(provider),allow_search:network,allow_memory:memory,...(conversationId?{conversation_id:conversationId}:{}),...(seed?{work_suggestion:{run_id:seed.work.run_id,revision:seed.work.revision}}:{}),...(method?{method_ref:method}:{})}});created(t.task_id);close();}catch(e){setError(explain(e));}finally{setBusy(false);}}
 return <Modal open close={close} title="查证或处理事务" id="agent-work-dialog"><p>告诉它需要查清或处理什么。它会依据实际读取和检索结果选择下一步；可以只返回结论；文件变更与命令按本次授权展示具体预览后执行。</p>
  <details><summary>事项名称</summary><label>名称<input id="agent-work-title" maxLength={120} value={title} onChange={e=>{setTitle(e.target.value);changed();}}/></label></details>
  <label>需求<textarea id="agent-work-instruction" maxLength={4000} value={instruction} onChange={e=>{setInstruction(e.target.value);changed();}}/></label>
  <details open={!!sources}><summary>选定本地资料（可选）</summary><button className="secondary" onClick={()=>void pick()}>选择本地资料…</button><label>UTF-8 .md / .txt 路径，每行一个，最多八个<textarea id="agent-work-sources" value={sources} onChange={e=>{setSources(e.target.value);changed();}}/></label><p className="small muted">只读取你选定的文件，按字符范围获取内容；选定资料尚未实际读取时不能标为完整完成。片段读取不等于全文读取；不会浏览其他目录，PDF仍需先提取成文本。</p></details>
  <ToolScopeFields value={tools} change={value=>{setTools(value);changed();}}/>
  <DocumentResources value={documents} changed={v=>{setDocuments(v);changed();}}/>
  <label className="check"><CheckField id="agent-work-network" checked={network} disabled={!search?.allowed||!search?.credential_present} onChange={e=>{setNetwork(e.target.checked);changed();}}/>允许为这次需求检索公开资料，并读取实际搜索结果中的页面</label>
  {network&&<p className="small muted">搜索关键词发送到 {search?.service}，可能包含本次需求或所选资料中的相关概念；最多三次搜索、六次页面读取，受现有搜索额度约束。没有获得跨域重定向或其他网站的额外授权。</p>}
  <details><summary>学习策略与记忆</summary><label>协作策略<Select id="agent-work-method" disabled={!!evaluation?.method_ref} value={method?.proposal_id??''} onChange={e=>{const p=methods.find(v=>v.proposal_id===e.target.value);setMethod(p?{proposal_id:p.proposal_id,revision:p.revision,mode:'active'}:null);changed();}}><option value="">不指定协作策略</option>{methods.filter(p=>p.family==='collaboration'&&p.state==='Active').map(p=><option key={p.proposal_id} value={p.proposal_id}>{p.method?.title}</option>)}{evaluation?.method_ref&&<option value={evaluation.method_ref.proposal_id}>本次比较指定的策略版本</option>}</Select></label><label className="check"><CheckField checked={memory} onChange={e=>{setMemory(e.target.checked);changed();}}/>允许本次工作使用当前有效 Memory（仍需已有召回用途授权）</label><p className="small muted">已批准的沟通策略可按情境影响表达。方法与记忆都不能授予工具权限。</p></details>
  <details><summary>需要保存产物时选择新位置（可选）</summary>{[0,1].map(i=><label key={i}>新建产物 {i+1} 路径<input id={`agent-work-output-${i}`} value={outputs[i]??''} onChange={e=>{setOutputs(old=>Array.from({length:2},(_,j)=>i===j?e.target.value:old[j]??''));changed();}}/><button className="secondary" onClick={()=>void pick(i)}>选择新建位置…</button></label>)}<p className="small muted">不覆盖已有文件，实际写入前展示完整正文。填写产物位置后，未确认写入不能标为完整完成。</p></details>
  <label>本次最多模型决策次数<NumberField id="agent-work-budget" min={2} max={24} value={budget} onChange={e=>{setBudget(Number(e.target.value));changed();}}/></label>
  <details><summary>本次出站与行动范围</summary><p>需求、选定资料的读取片段、工具结果、Persona、已批准的适用策略{memory?'及当前有效记忆':''}可发送至 {provider.base_url} / {provider.model}。最多 {budget} 次模型请求，受每次输入／输出限额约束；遇到需要补充信息、未授权资源、未知写入或预算限制会停下。不会自动重试失败请求。</p></details>
  <label className="check"><CheckField id="agent-work-consent" checked={consent} onChange={e=>setConsent(e.target.checked)}/>批准这次需求的上述模型用途、资源范围和预算</label>
  <button id="agent-work-start" disabled={disabled||busy||!consent||!instruction.trim()||!title.trim()||tools.roots.some(r=>!r.path.trim())||tools.urls.length>6||documents.some(d=>!d.path.trim()||!d.label.trim()||!d.scope.trim())||!provider.credential_present||!provider.chat_allowed} onClick={()=>void create()}>开始处理</button>{error&&<p role="alert" className="error">{error}</p>}
 </Modal>;
}

export function AgentWorkProgress({agentId,task,disabled,execute}:{agentId:string;task:Task;disabled:boolean;execute:Execute}){
 const [answer,setAnswer]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const run=task.runs[0];
 async function respond(){setBusy(true);setError('');try{await execute({...envelope(),type:'AnswerAgentTask',agent_id:agentId,expected_revision:task.revision,payload:{task_id:task.task_id,answer}});setAnswer('');}catch(e){setError(explain(e));}finally{setBusy(false);}}
 return <section id="agent-work-progress"><p className="small muted">已开始 {run.context.decisions_started??0} / {task.agent_limits?.max_decisions??'?'} 次模型决策。每一步依据当时实际结果，完成状态与内容质量分别判断。</p>
  {!!task.local_evidence?.length&&<details id="agent-local-evidence"><summary>本地资料实际读取：{task.local_evidence.filter(v=>v.state!=='Unread').length}/{task.local_evidence.length} 份</summary><ul>{task.local_evidence.map(v=><li key={v.resource}>{v.citation} · {v.state==='Unread'?'尚未读取':v.state==='Full'?'已读取全文':'只读取了片段，全文未覆盖'}{v.ranges.length>0&&<> · 字符范围 {v.ranges.map(r=>`${r[0]}–${r[1]}`).join('、')} / {v.total_characters??'总量未知'}</>}</li>)}</ul><p className="small muted">读取范围不证明内容质量；结论仍需与你的实际需求和来源核对。</p></details>}
  {!!run.context.short_plan?.length&&<ol aria-label="当前工作计划">{run.context.short_plan.map((v,i)=><li key={i}>{v.completed_steps.length?'已有实际进展 · ':'待完成 · '}{v.text}</li>)}</ol>}
  <GeneralToolObservations steps={run.steps??[]} agentId={agentId} taskId={task.task_id} execute={execute} disabled={disabled}/>
  {run.reply&&<section><h3>{task.state==='Partial'?'部分结果':task.state==='Blocked'?'当前阻碍':'结论与可讨论内容'}</h3><Markdown text={run.reply}/><p className="small muted">模型原稿，仍需你判断事实、推断与实际帮助。</p></section>}
  {!!task.agent_limits?.documents?.length&&<DocumentObservations steps={run.steps??[]} resources={task.agent_limits.documents}/>}
  {task.state==='AwaitingInput'&&<><p>{task.current_step?.definition.question}</p><label>补充信息<textarea id="agent-work-answer" maxLength={2000} value={answer} onChange={e=>setAnswer(e.target.value)}/></label><button id="agent-work-answer-send" disabled={disabled||busy||!answer.trim()} onClick={()=>void respond()}>提交补充信息</button></>}
  {!!task.candidates?.length&&<details><summary>实际搜索发现的公开来源</summary><ul>{task.candidates.map(s=><li key={s.source_id}><a href={s.url} target="_blank" rel="noreferrer">[{s.source_id}] {s.title||s.url}</a>（搜索发现不等于正文已读取）</li>)}</ul></details>}
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
