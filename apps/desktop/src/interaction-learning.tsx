import {useEffect,useState} from 'react';
import {CheckField,Select} from './controls';
import {Modal} from './ui';
import type {Execute,Provider} from './chat';
import {MethodsPanel,providerBinding,type Proposal,type MethodRef} from './methods';
import {understandingNames,type MemoryReference,type UnderstandingKind} from './interaction-memory';

export type InteractionFeedback={revision:number;category:'Strategy'|'Preference'|'FactCorrection'|'TemporaryState';note:string;deleted:number};
type Experience={input:string;reply:string;feedback:InteractionFeedback|null;applied_methods:MethodRef[];memory_context?:MemoryReference[];learning_source_current?:boolean};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const categories=[['Strategy','交流与协作策略'],['Preference','个人偏好'],['FactCorrection','事实纠正'],['TemporaryState','本次临时状态']] as const;
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function InteractionLearningDialog({agentId,runId,provider,disabled,read,execute,close,created,remember}:{agentId:string;runId:string;provider:Provider;disabled:boolean;read:Execute;execute:Execute;close:()=>void;created?:(id:string)=>void;remember?:(kind:UnderstandingKind,content:string)=>void}){
 const [experience,setExperience]=useState<Experience|null>(null),[methods,setMethods]=useState<Proposal[]>([]);
 const [category,setCategory]=useState<InteractionFeedback['category']>('Strategy'),[note,setNote]=useState(''),[baseId,setBaseId]=useState('');
 const [objective,setObjective]=useState(''),[criteria,setCriteria]=useState('相关情境中的表现有改善\n明确要求解决问题时仍能提供实际帮助\n无关情境不机械套用'),[consent,setConsent]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[deleteMethods,setDeleteMethods]=useState(false);
 const base=methods.find(m=>m.proposal_id===baseId);
 async function load(){const [e,m]=await Promise.all([read<Experience>({...envelope(),type:'GetInteractionExperience',agent_id:agentId,payload:{run_id:runId}}),read<Proposal[]>({...envelope(),type:'ListMethods',agent_id:agentId,payload:{}})]);setExperience(e);setMethods(m);if(e.feedback&&!e.feedback.deleted){setCategory(e.feedback.category);setNote(e.feedback.note);}setConsent(false);}
 useEffect(()=>{void load().catch(e=>setError(explain(e)));},[agentId,runId]);
 useEffect(()=>setConsent(false),[provider.base_url,provider.model,provider.revision]);
 async function save(remove=false){setBusy(true);setError('');try{const f=await execute<InteractionFeedback>(remove?{...envelope(),type:'DeleteInteractionFeedback',agent_id:agentId,expected_revision:experience?.feedback?.revision??0,payload:{run_id:runId,delete_methods:deleteMethods}}:{...envelope(),type:'SaveInteractionFeedback',agent_id:agentId,expected_revision:experience?.feedback?.revision??0,payload:{run_id:runId,category,note}});setExperience(old=>old?{...old,feedback:f}:old);setSaved(!remove);setConsent(false);if(remove)setNote('');}catch(e){setError(explain(e));}finally{setBusy(false);}}
 async function propose(){if(!experience?.feedback)return;setBusy(true);setError('');try{const proposal=await execute<Proposal>({...envelope(),type:'CreateConversationMethodProposal',agent_id:agentId,payload:{run_id:runId,feedback_revision:experience.feedback.revision,objective,criteria:criteria.split('\n').map(x=>x.trim()).filter(Boolean),provider:providerBinding(provider),allow_outbound:true,...(base?{base_method_ref:{proposal_id:base.proposal_id,revision:base.revision,mode:'active' as const}}:{})}});close();created?.(proposal.proposal_id);}catch(e){setError(explain(e));}finally{setBusy(false);}}
 const feedbackCurrent=!!experience?.feedback&&!experience.feedback.deleted&&experience.feedback.category===category&&experience.feedback.note===note;
 return <Modal open close={close} title="交流反馈与学习" id="interaction-learning-dialog">
  {experience&&<details><summary>这次交流与参考策略（{experience.applied_methods.length} 项）</summary><p>你：{experience.input}</p><p>Agent：{experience.reply}</p><p className="small muted">参考策略不等于确认产生收益。候选生成使用这两条消息，不自动发送整段历史。</p></details>}
  <label>这条反馈属于<Select id="interaction-feedback-category" value={category} onChange={e=>{setCategory(e.target.value as InteractionFeedback['category']);setSaved(false);setConsent(false);}}>{categories.map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></label>
  <label>希望它理解或改善什么？<textarea id="interaction-feedback-note" maxLength={2000} value={note} onChange={e=>{setNote(e.target.value);setSaved(false);setConsent(false);}} placeholder="例如：刚才我只想交流感受，你太快开始给方案了。"/></label>
  <button id="interaction-feedback-save" disabled={disabled||busy||!experience||!note.trim()} onClick={()=>void save()}>保存反馈</button>{saved&&<p role="status">反馈已保存在本机，尚未生成或采用策略。</p>}
  {category!=='Strategy'?<><p className="notice">反馈记录不会自动改写记忆。你可以在原交流旁确认保存或纠正；临时状态不会自动成为长期偏好。</p><button id="interaction-feedback-remember" className="text-button" disabled={disabled||busy||!note.trim()} onClick={()=>remember?.(category==='TemporaryState'?'TemporaryState':category==='Preference'?'Preference':'Fact',note)}>记住／纠正这条理解…</button></>:<section>
   {(experience?.memory_context??[]).length>0&&<details><summary>这次回复实际参考的记忆（{experience?.memory_context?.length} 条）</summary>{experience?.memory_context?.map(m=><p key={m.revision_id}>{m.interaction_context?.kind?understandingNames[m.interaction_context.kind]:m.evidence_kind==='agent_inference'?'Agent 推断':'事实／偏好'}：{m.content}{!m.current?'（历史版本）':''}</p>)}<p className="small muted">候选生成会同时使用这些实际记忆依据。个人事实与相处理解保持为记忆，不直接变成通用策略。</p></details>}
   {experience?.learning_source_current===false&&<p className="notice">这次回复使用的理解已经被纠正。原交流可以回看，请从使用新理解的后续回复提出学习候选。</p>}
   <label>新策略或修订<Select id="interaction-method-baseline" value={baseId} onChange={e=>{setBaseId(e.target.value);setConsent(false);}}><option value="">提出一个独立策略，保留已有策略</option>{methods.filter(m=>m.family==='communication'&&m.state==='Active').map(m=><option key={m.proposal_id} value={m.proposal_id}>修订：{m.method?.title}</option>)}</Select></label>
   {base?.method&&<details><summary>拟修订的完整策略</summary><p>{base.method.applicability}</p><ol>{base.method.procedure.map((v,i)=><li key={i}>{v}</li>)}</ol><p>{base.method.checks.join('；')}</p><p>{base.method.rationale}</p><p>{base.method.limits}</p></details>}
   <label>可复用的改进目标<textarea id="interaction-method-objective" maxLength={500} value={objective} onChange={e=>{setObjective(e.target.value);setConsent(false);}} placeholder="明确哪些情境需要改变，同时保留哪些能力。"/></label>
   <label>评价要求（每行一项，最多六项）<textarea id="interaction-method-criteria" value={criteria} onChange={e=>{setCriteria(e.target.value);setConsent(false);}}/></label>
   <details><summary>生成候选会发送什么？</summary><p>上面展示的两条消息、实际参考的记忆内容与版本、已保存反馈、改进目标、评价要求{base?'及拟修订策略的完整内容':''}发送至 {provider.base_url} / {provider.model}。候选生成最多一次请求；独立比较和采用另行确认。</p></details>
   <label className="check"><CheckField id="interaction-method-consent" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许本次候选生成使用上述内容</label>
   <button id="interaction-method-propose" disabled={disabled||busy||experience?.learning_source_current===false||!feedbackCurrent||!consent||!objective.trim()||!criteria.trim()||!provider.credential_present} onClick={()=>void propose()}>提出策略候选</button>
  </section>}
  {experience?.feedback&&!experience.feedback.deleted&&<details><summary>删除反馈</summary><label className="check"><CheckField checked={deleteMethods} onChange={e=>setDeleteMethods(e.target.checked)}/>同时删除由它形成的策略；否则保留已独立批准的策略并清除来源</label><button className="text-button" disabled={disabled||busy} onClick={()=>void save(true)}>删除这条反馈</button></details>}
  {error&&<p role="alert" className="error">{error}</p>}
 </Modal>;
}

export function ConversationLearningPanel({agentId,provider,sequence,disabled,read,execute,seedId,prepareTrial}:{prepareTrial?:(value:Proposal)=>void;agentId:string;provider:Provider;sequence:number;disabled:boolean;read:Execute;execute:Execute;seedId?:string}){
 const [items,setItems]=useState<Proposal[]>([]),[error,setError]=useState('');
 useEffect(()=>{let alive=true;void read<Proposal[]>({...envelope(),type:'ListMethods',agent_id:agentId,payload:{}}).then(value=>{if(alive)setItems(value.filter(v=>v.family==='communication'));}).catch(e=>{if(alive)setError(explain(e));});return()=>{alive=false;};},[agentId,sequence]);
 return <><p className="small muted">这些策略属于当前 Agent，可在适用的交流中使用。直接从回复的“交流反馈与学习”开始，不必建立任务或目标。</p><MethodsPanel agentId={agentId} items={items} tasks={[]} provider={provider} sequence={sequence} disabled={disabled} read={read} execute={execute} seedId={seedId} prepareTrial={prepareTrial} openTask={()=>{}} prepareEvaluation={()=>{}}/>{error&&<p role="alert" className="error">{error}</p>}</>;
}
