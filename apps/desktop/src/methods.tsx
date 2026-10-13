import {CheckField,Select} from './controls';
import {useEffect,useState} from 'react';
import type {Execute,Provider} from './chat';
import {Modal,PageTabs} from './ui';
import {MethodEditor,MethodChanges} from './method-editor';

export type MethodRef={proposal_id:string;revision:number;mode:'active'|'evaluation'};
export type Method={family:'preparation_update';title:string;applicability:string;procedure:string[];checks:string[];rationale:string;limits:string};
export type MethodSnapshot={reference:MethodRef;method:Method};
export type LearningSource={task_id:string;run_id:string};
export type EvaluationDraft={title:string;instruction:string;sources:string[];method_ref:MethodRef|null;planned:boolean};
export type MethodTask={task_id:string;title:string;state:string;kind:string;instruction:string;sources:string[];method_ref?:MethodRef|null};
export type Experience={title:string;instruction:string;attempt_state:string;applied_method_ref:MethodRef|null;historical_receipts:{outcome?:string;bytes_written?:number}[];body_reviews:{editor:string;state:string;save_approved:boolean}[];current_method:MethodSnapshot|null;feedback:{revision:number;quality:string;note:string}};
export type Proposal={proposal_id:string;revision:number;state:string;objective:string;criteria:string[];method:Method|null;source_deleted:number;error?:string;
 experience?:{baseline_method?:MethodSnapshot|null};evaluation?:{improved:boolean;no_regression:boolean;checks:boolean[];reviewer:string;note:string};metadata?:{usage?:{total_tokens?:number}}};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
export const providerBinding=(p:Provider)=>({base_url:p.base_url??'',model:p.model??'',revision:p.revision??0});
const explain=(e:unknown)=>{try{const error=JSON.parse(String(e)).error;return ({RevisionConflict:'反馈或工作方法已改变，请重新打开反馈并核对当前版本。',ContextStale:'反馈或比较方法已失效，请重新确认当前资料。'} as Record<string,string>)[error?.code]??error?.message??String(e);}catch{return String(e);}};
const names:Record<string,string>={Generating:'正在提出候选',Proposed:'待独立评价',Evaluating:'独立评价中',Eligible:'符合采用条件，待批准',Active:'当前使用',Disabled:'已停用',RolledBack:'已回滚',Rejected:'已拒绝',Failed:'候选生成失败',FailedEvaluation:'未证明改善',Invalidated:'反馈或原方法已改变',Deleted:'已删除'};

export function LearnMethodDialog({agentId,taskId,runId,provider,disabled,read,execute,close}:{agentId:string;taskId:string;runId:string;provider:Provider;disabled:boolean;read:Execute;execute:Execute;close:()=>void}){
 const [experience,setExperience]=useState<Experience|null>(null);
 const [objective,setObjective]=useState('更新准备资料时，先比较旧进展和新资料，再列变化、缺口及待确认事项，避免重复已完成工作。');
 const [criteria,setCriteria]=useState('变化和缺口有来源依据\n保留待确认状态，不写成确定不存在\n不重复提出已完成工作');
 const [consent,setConsent]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>setConsent(false),[provider.base_url,provider.model,provider.revision]);
 useEffect(()=>{let alive=true;void read<Experience>({...envelope(),type:'GetMethodExperience',agent_id:agentId,payload:{task_id:taskId,run_id:runId}}).then(v=>{if(alive){setExperience(v);setConsent(false);}}).catch(e=>{if(alive)setError(explain(e));});return()=>{alive=false;};},[agentId,taskId,runId]);
 async function propose(){if(!experience)return;setBusy(true);setError('');try{await execute({...envelope(),type:'CreateMethodProposal',agent_id:agentId,payload:{task_id:taskId,run_id:runId,feedback_revision:experience.feedback.revision,objective,criteria:criteria.split('\n').map(x=>x.trim()).filter(Boolean),provider:providerBinding(provider),allow_outbound:true,...(experience.current_method?{base_method_ref:experience.current_method.reference}:{})}});close();}catch(e){setError(explain(e));}finally{setBusy(false);}}
 async function disableCurrent(){if(!experience?.current_method)return;setBusy(true);setError('');try{await execute({...envelope(),type:'DisableMethod',agent_id:agentId,expected_revision:experience.current_method.reference.revision,payload:{proposal_id:experience.current_method.reference.proposal_id}});close();}catch(e){setError(explain(e));}finally{setBusy(false);}}
 return <Modal open close={close} title="从这次工作改进方法" id="method-learn-dialog"><p>选择一个可复用的处理方法。这里只生成候选，独立评价和采用另行确认。</p>
  {experience&&<div id="method-experience"><strong>{experience.title} · {experience.attempt_state}</strong><p>{experience.instruction}</p><p>已记录反馈（{experience.feedback.quality}）：{experience.feedback.note}</p><p>本次工作{experience.applied_method_ref?`使用方法版本 ${experience.applied_method_ref.revision}`:'未加载工作方法'}；{experience.body_reviews.some(r=>r.editor==='user')?'包含人工修订正文':'未记录人工修订正文'}。保存成功与内容评价分别判断。</p>{experience.body_reviews.map((r,i)=><p key={i}>正文 {i+1}：{r.editor==='user'?'人工修订':'模型原稿'} · {r.save_approved?'已批准保存':'尚未批准保存'}</p>)}{experience.historical_receipts.map((r,i)=><p key={i}>历史回执：{r.outcome??'Unknown'}{r.bytes_written!==undefined?` · ${r.bytes_written} 字节`:''}</p>)}</div>}
  {experience?.current_method&&<section id="method-current-baseline"><strong>当前采用：{experience.current_method.method.title} · 版本 {experience.current_method.reference.revision}</strong><p>{experience.current_method.method.applicability}</p><ol>{experience.current_method.method.procedure.map((v,i)=><li key={i}>{v}</li>)}</ol><p>检查：{experience.current_method.method.checks.join('；')}</p><p>依据：{experience.current_method.method.rationale}</p><p>限制：{experience.current_method.method.limits}</p><button id="method-keep-current" className="secondary" disabled={busy} onClick={close}>保留现有方法，暂不提出候选</button><button id="method-disable-current" className="text-button" disabled={disabled||busy} onClick={()=>void disableCurrent()}>停用此方法</button></section>}
  <label>希望改善什么？<textarea id="method-objective" maxLength={500} value={objective} onChange={e=>{setObjective(e.target.value);setConsent(false);}}/></label>
  <label>评价要求（每行一项，最多六项）<textarea id="method-criteria" value={criteria} onChange={e=>{setCriteria(e.target.value);setConsent(false);}}/></label>
  <p className="small muted">以上任务要求、实际状态、正文审阅状态、反馈、改进目标及评价要求{experience?.current_method?'，以及展示的当前方法完整内容':''}发送至 {provider.base_url} / {provider.model}。文件正文、路径及完整历史不会自动发送；开发反馈不冒充真实用户研究。</p>
  <label className="check"><CheckField id="method-consent" type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许这一次候选生成使用上述内容；原方法继续使用，候选需另行评价与采用。</label>
  {error&&<p role="alert" className="error">{error}</p>}<button id="method-propose" disabled={disabled||busy||!experience||!consent||!objective.trim()||!criteria.trim()||!provider.credential_present} onClick={()=>void propose()}>{experience?.current_method?'提出修订候选':'提出一个候选'}</button>
 </Modal>;
}

export function MethodsPanel({agentId,items,tasks,disabled,execute,openTask,prepareEvaluation}:{agentId:string;items:Proposal[];tasks:MethodTask[];disabled:boolean;execute:Execute;openTask:(id:string)=>void;prepareEvaluation:(draft:EvaluationDraft)=>void}){
 const [detailTab,setDetailTab]=useState<'method'|'evaluation'>('method'),[deleting,setDeleting]=useState(false);
 const [error,setError]=useState(''),[selected,setSelected]=useState<string|null>(null),[editing,setEditing]=useState(false),[draft,setDraft]=useState<Method|null>(null),[template,setTemplate]=useState('');
 const [baseline,setBaseline]=useState(''),[candidate,setCandidate]=useState(''),[retention,setRetention]=useState(''),[improved,setImproved]=useState(false),[noRegression,setNoRegression]=useState(false),[checks,setChecks]=useState<boolean[]>([]),[note,setNote]=useState(''),[adoptConsent,setAdoptConsent]=useState(false);
 const value=items.find(x=>x.proposal_id===selected);
 useEffect(()=>{setDetailTab('method');setDeleting(false);setBaseline('');setCandidate('');setRetention('');setChecks(value?.criteria.map(()=>false)??[]);setAdoptConsent(false);setEditing(false);setNote('');setImproved(false);setNoRegression(false);},[selected,value?.revision]);
 async function action(type:'StartMethodEvaluation'|'AdoptMethod'|'EnableMethod'|'DisableMethod'|'RollbackMethod'|'RejectMethod'|'DeleteMethod'){if(!value)return;setError('');try{const target={proposal_id:value.proposal_id};await execute(type==='AdoptMethod'||type==='EnableMethod'?{...envelope(),type,agent_id:agentId,expected_revision:value.revision,payload:{...target,allow_method_outbound:true}}:{...envelope(),type,agent_id:agentId,expected_revision:value.revision,payload:target});}catch(e){setError(explain(e));}}
 async function record(){if(!value)return;setError('');try{await execute({...envelope(),type:'RecordMethodEvaluation',agent_id:agentId,expected_revision:value.revision,payload:{proposal_id:value.proposal_id,baseline_task_id:baseline,candidate_task_id:candidate,retention_task_id:retention,improved,no_regression:noRegression,checks,reviewer:'user',note}});}catch(e){setError(explain(e));}}
 async function edit(){if(!value||!draft)return;setError('');try{const method=draft;await execute({...envelope(),type:'EditMethodCandidate',agent_id:agentId,expected_revision:value.revision,payload:{proposal_id:value.proposal_id,method}});setEditing(false);}catch(e){setError(explain(e));}}
 const choices=tasks.filter(t=>t.state==='Completed');
 const base=value?.experience?.baseline_method??null;
 function prepare(role:'baseline'|'candidate'|'retention'){const t=tasks.find(t=>t.task_id===template);if(!value||!t)return;prepareEvaluation({title:`${value.method?.title??value.objective} · ${role==='baseline'?'原方法比较':role==='candidate'?'修订候选比较':'旧能力检查'}`.slice(0,120),instruction:role==='retention'?'概括所选资料的主要内容，保留事实与未知，不安排活动。':t.instruction,sources:t.sources,planned:role!=='retention',method_ref:role==='baseline'?base?.reference??null:role==='candidate'?{proposal_id:value.proposal_id,revision:value.revision,mode:'evaluation'}:null});}
 const matches=(t:MethodTask,role:number)=>role===0?JSON.stringify(t.method_ref??null)===JSON.stringify(base?.reference??null):role===1?t.method_ref?.proposal_id===value?.proposal_id&&t.method_ref?.revision===value?.revision&&t.method_ref?.mode==='evaluation':!t.method_ref;
 return <section className="settings-section" id="methods-panel"><h2>工作方法</h2><p className="muted">{items.filter(x=>x.state==='Active').length} 项使用中</p><p className="small muted">从反馈形成方法，独立评价后由你采用。事实与偏好仍由 Memory 管理；写入成功不等于方法更好。</p>
  {items.length?<div className="actions">{items.map(x=><button className="secondary" data-method={x.proposal_id} key={x.proposal_id} onClick={()=>setSelected(x.proposal_id)}>{x.method?.title||x.objective||'已删除方法'} · {names[x.state]??x.state}</button>)}</div>:<p>在已保存的任务反馈下选择“改进同类方法”开始。</p>}
  {value&&<section id="method-detail" data-state={value.state}><h3>{value.method?.title||value.objective}</h3><p>{names[value.state]} · 版本 {value.revision}</p>{value.source_deleted!==0&&<p className="notice">原反馈已改变或删除，来源原文不可回看。独立批准的方法可以另行停用或删除。</p>}
   <PageTabs label="方法详情分类" value={detailTab} change={setDetailTab} items={[["method","方法与管理"],["evaluation","比较与评价"]]}/><div hidden={detailTab!=="method"}>
   {value.method&&<><p>{value.method.applicability}</p><ol>{value.method.procedure.map((x,i)=><li key={i}>{x}</li>)}</ol><p>检查：{value.method.checks.join('；')}</p><p>依据：{value.method.rationale}</p><p>限制：{value.method.limits}</p></>}
   {value.method&&base&&<MethodChanges before={base.method} after={value.method}/>}
   {value.error&&<p className="error">{value.error}；未自动重试。</p>}
   </div><div hidden={detailTab!=="evaluation"}>
   {value.evaluation&&<p id="method-evaluation-result">独立评价：{value.evaluation.improved?'观察到改善':'未证明改善'}；旧能力{value.evaluation.no_regression?'未见退化':'未通过'}。评价来源：{value.evaluation.reviewer==='user'?'用户判断':'开发检查'}。{value.evaluation.note}</p>}
   {value.state==='Proposed'&&<button id="method-start-evaluation" disabled={disabled} onClick={()=>{setDetailTab('evaluation');void action('StartMethodEvaluation');}}>开始独立评价</button>}
   {value.state==='Evaluating'&&<div id="method-evaluation-form"><p>用未参与候选生成的新资料建立两个相同要求的任务：{base?`基线使用确认的原方法版本 ${base.reference.revision}`:'基线不加载方法'}，候选选择此评价版本；另做一项普通摘要。审阅实际原稿后填写，修订稿不能证明原稿改善。</p>
    <label>用已有任务的要求与材料准备比较草稿<Select id="method-evaluation-template" value={template} onChange={e=>setTemplate(e.target.value)}><option value="">选择作为模板的任务…</option>{choices.map(t=><option key={t.task_id} value={t.task_id}>{t.title}</option>)}</Select></label><p className="small muted">选择未参与候选生成的材料。草稿沿用要求与材料，保存位置需重新选择；准备草稿不会出站或执行。</p><div className="actions">{(['baseline','candidate','retention'] as const).map(role=><button id={`method-prepare-${role}`} key={role} disabled={disabled||!template} onClick={()=>prepare(role)}>准备{role==='baseline'?'基线':role==='candidate'?'候选':'旧能力'}任务…</button>)}</div>
    {([['基线任务',baseline,setBaseline],['候选任务',candidate,setCandidate],['旧能力检查',retention,setRetention]] as const).map(([label,id,set],role)=><label key={label}>{label}<Select id={`method-evaluation-${role}`} value={id} onChange={e=>set(e.target.value)}><option value="">选择已完成任务</option>{choices.filter(t=>matches(t,role)).map(t=><option key={t.task_id} value={t.task_id}>{t.title}</option>)}</Select>{id&&<button className="text-button" onClick={()=>openTask(id)}>查看任务与产物</button>}</label>)}
    {value.criteria.map((x,i)=><label className="check" key={i}><CheckField type="checkbox" checked={checks[i]??false} onChange={e=>setChecks(old=>old.map((v,j)=>i===j?e.target.checked:v))}/>{x}</label>)}
    <label className="check"><CheckField type="checkbox" checked={improved} onChange={e=>setImproved(e.target.checked)}/>新方法比现有方法有实际改善</label><label className="check"><CheckField type="checkbox" checked={noRegression} onChange={e=>setNoRegression(e.target.checked)}/>必要旧能力未见退化</label>
    <label>观察到的差异、失败与代价<textarea id="method-evaluation-note" maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label><button id="method-record-evaluation" disabled={disabled||!baseline||!candidate||!retention||!note.trim()} onClick={()=>void record()}>保存评价（可以不通过）</button>
   </div>}
   </div>
   {['Proposed','Evaluating','Eligible','FailedEvaluation'].includes(value.state)&&<><button id="method-edit-candidate" className="text-button" disabled={disabled} onClick={()=>{setDraft(value.method);setEditing(true);}}>修订候选（旧评价失效）</button><button className="text-button" disabled={disabled} onClick={()=>void action('RejectMethod')}>不采用</button></>}
   {editing&&draft&&<><MethodEditor value={draft} changed={setDraft} disabled={disabled}/><button id="method-save-edit" disabled={disabled} onClick={()=>void edit()}>保存候选修订</button></>}
   {['Eligible','Disabled'].includes(value.state)&&<><label className="check"><CheckField id="method-adopt-consent" type="checkbox" checked={adoptConsent} onChange={e=>setAdoptConsent(e.target.checked)}/>批准使用此方法；适用对话可发送标题与适用条件，独立授权的文件任务可发送完整流程及检查要求至当前 Provider。</label><button id="method-adopt" disabled={disabled||!adoptConsent} onClick={()=>void action(value.state==='Eligible'?'AdoptMethod':'EnableMethod')}>{value.state==='Eligible'?'采用方法':'重新启用'}</button></>}
   {value.state==='Active'&&<><button id="method-disable" disabled={disabled} onClick={()=>void action('DisableMethod')}>停用</button><button id="method-rollback" disabled={disabled} onClick={()=>void action('RollbackMethod')}>回滚到采用前</button></>}
   {value.state!=='Deleted'&&<><button className="text-button" disabled={disabled} onClick={()=>setDeleting(true)}>删除方法…</button><Modal open={deleting} close={()=>setDeleting(false)} title="删除方法" id="method-delete-dialog"><p>清除方法内容和评价，不删除已执行 Task 或外部文件；回滚不能恢复删除的数据。</p><button disabled={disabled} onClick={()=>void action('DeleteMethod')}>确认删除方法</button></Modal></>}
  </section>}{error&&<p role="alert" className="error">{error}</p>}
 </section>;
}
