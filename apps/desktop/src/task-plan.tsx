import {CheckField,Select} from './controls';
import {useState} from 'react';
export type StepDefinition={id:string;op:'list_files'|'read_file'|'search_files'|'write_file'|'manage_files'|'run_command'|'update_plan'|'read'|'generate'|'write'|'search'|'read_web'|'select_sources'|'decide'|'ask'|'finish'|'office_inspect'|'office_read'|'office_calculate'|'office_propose'|'text_propose';question?:string;root?:string;path?:string;program?:string;action?:string;reason?:string;target?:string;version?:string;sheet?:string;formula?:string;source_id?:string;start?:number;length?:number;outcome?:string;resource?:string;instruction?:string;inputs?:string[];output?:string;input?:string;query?:string;url?:string};
export type Deliverable={output:string;instruction:string};
export type Plan={steps:StepDefinition[];delivery_contract?:string;deliverables?:Deliverable[]};
export type Step={step_id:string;position:number;definition:StepDefinition;state:string;error?:string;action_id?:string;origin_step_id?:string;result?:import('./document-work').DocumentObservation & import('./general-tools').ToolObservation & {status?:string;content?:string;original_url?:string;final_url?:string;redirect_url?:string;title?:string;fetched_at?:string;error?:string;message?:string;executed?:boolean;excluded_results?:number};metadata?:{model?:string;usage?:{total_tokens?:number;credits?:number}};action?:{body:string;state:string;receipt?:{outcome:string};editor:string}};
export type Output={label:string;path:string};
const states:Record<string,string>={Pending:'等待前序步骤',Completed:'已完成',Generating:'正在生成',Executing:'正在执行',AwaitingApproval:'等待行动审批',AwaitingInput:'等待补充信息',Failed:'失败',NeedsAttention:'结果未知',NotExecuted:'未写入'};
export function describe(d:StepDefinition,sources:string[],outputs:Output[]){
 if(['office_inspect','office_read','office_calculate','office_propose','text_propose'].includes(d.op))return ({office_inspect:'检查文档',office_read:'读取文档',office_calculate:'计算表格',office_propose:'提出Office修改',text_propose:'提出文本修改'} as Record<string,string>)[d.op]+' · '+d.resource;
 if(['list_files','read_file','search_files','write_file','manage_files','run_command','update_plan'].includes(d.op))return ({list_files:'查看目录',read_file:'读取文本',search_files:'查找文件内容',write_file:'写入文本',manage_files:'处理文件',run_command:'运行已审阅命令',update_plan:'调整工作计划'} as Record<string,string>)[d.op]+' · '+(d.program??d.root??'')+' '+(d.path??'');
 if(d.op==='decide')return '判断下一步';
 if(d.op==='ask')return '请求补充信息：'+d.question;
 if(d.op==='finish')return d.outcome==='complete'?'形成结论并完成':'形成部分结论或说明阻碍';
 if(d.op==='search')return '检索：'+d.query;
 if(d.op==='read_web')return '读取：'+d.url;
 if(d.op==='select_sources')return '审阅并选择公开来源';
 const resource=(id?:string)=>id?.startsWith('source')?sources[Number(id.slice(6))-1]:outputs[Number(id?.slice(6))-1]?.label;
 return d.op==='read'?`读取 ${resource(d.resource)??'已清除的资源'}`:d.op==='write'?`保存 ${resource(d.output)??'产物'}`:d.instruction||'生成内容 · 指令已因记忆治理清除';
}
function decisionFeedback(s:Step){return s.definition.op==='decide'&&['Rejected','ReviewRequired'].includes(s.result?.status??'')&&s.result?.executed===false;}
export function reviewRejected(s:Step){return s.state==='Rejected'&&s.result?.status==='ReviewRejected'&&s.result.executed===false&&s.action?.state==='Rejected';}
export function PlanView({steps,sources,outputs}:{steps:Step[];sources:string[];outputs:Output[]}){
 return <ol className="plan-steps" aria-label="任务步骤">{steps.map((s,i)=><li key={s.step_id} data-step={s.definition.id} data-state={s.state}><strong>步骤 {i+1} · {describe(s.definition,sources,outputs)}</strong><span>{reviewRejected(s)?'审阅退回，动作未执行':decisionFeedback(s)?(s.result?.status==='Rejected'?'校验拒绝，动作未执行':'复核结束提议'):(states[s.state]??s.state)}{s.error?' · '+s.error:''}</span>{s.definition.reason&&<p>{s.definition.reason}</p>}{s.result?.status&&<small>{reviewRejected(s)?'审阅反馈':decisionFeedback(s)?'决策反馈':s.result.status==='ModelDraft'?'结论原稿，待你判断':'实际观察：'+(s.result.status==='Success'?'成功':s.result.status==='Failed'?'失败':s.result.status)}{s.result.error?' · '+s.result.error:''}</small>}{(decisionFeedback(s)||reviewRejected(s))&&s.result?.message&&<p>{s.result.message}</p>}{s.definition.inputs?.length?<small>依据：{s.definition.inputs.map(id=>'步骤 '+(steps.findIndex(v=>v.definition.id===id)+1)).join('、')}</small>:null}{s.metadata?.model&&<small>{s.origin_step_id?'沿用前 Run · 无新增调用':'本步骤模型：'+s.metadata.model+' · 用量 '+(s.metadata.usage?.total_tokens??'未知')+' tokens'}</small>}{s.action?.receipt&&<small>实际回执：{s.action.receipt.outcome}</small>}</li>)}</ol>;
}
export function PlanEditor({plan,steps,sources,outputs,disabled,onSave,onCancel}:{plan:Plan;steps:Step[];sources:string[];outputs:Output[];disabled:boolean;onSave:(plan:Plan)=>Promise<void>;onCancel:()=>void}){
 const [draft,setDraft]=useState<StepDefinition[]>(structuredClone(plan.steps));
 const locked=Math.max(-1,...steps.filter(s=>s.state==='Completed'&&s.definition.op==='write').map(s=>s.position));
 function change(i:number,value:StepDefinition){setDraft(d=>d.map((v,j)=>i===j?value:v));}
 function add(){let i=1;while(draft.some(s=>s.id==='user'+i))i++;setDraft(d=>[...d,{id:'user'+i,op:'read',resource:'source1'}]);}
 return <section className="plan-editor" aria-label="编辑任务计划"><p>已完成的写入及其前序步骤保留。修改未执行步骤后，需重新批准计划和保存正文。</p>{draft.map((d,i)=>{
  const prior=draft.slice(0,i).filter(s=>s.op==='read'||s.op==='generate');
  const resources=[...sources.map((p,j)=>({id:'source'+(j+1),label:p})),...outputs.map((o,j)=>({id:'output'+(j+1),label:o.label})).filter(o=>draft.slice(0,i).some(s=>s.op==='write'&&s.output===o.id))];
  return <fieldset key={d.id} disabled={disabled||i<=locked}><legend>步骤 {i+1}{i<=locked?' · 已执行，保留':''}</legend><label>操作<Select value={d.op} onChange={e=>{const op=e.target.value as StepDefinition['op'];change(i,op==='read'?{id:d.id,op,resource:'source1'}:op==='generate'?{id:d.id,op,instruction:'',inputs:prior.length?[prior[0].id]:[]}:{id:d.id,op,output:'output1',input:prior.find(v=>v.op==='generate')?.id??''});}}><option value="read">读取文件</option><option value="generate">生成正文</option><option value="write">新建文件</option></Select></label>
   {d.op==='read'&&<label>读取范围<Select value={d.resource??''} onChange={e=>change(i,{...d,resource:e.target.value})}>{resources.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</Select></label>}
   {d.op==='generate'&&<><label>本步骤要完成什么<textarea id={"task-plan-instruction-"+d.id} value={d.instruction??''} onChange={e=>change(i,{...d,instruction:e.target.value})}/></label><p>使用哪些前序结果：</p>{prior.map(p=><label className="check" key={p.id}><CheckField type="checkbox" checked={d.inputs?.includes(p.id)??false} onChange={e=>change(i,{...d,inputs:e.target.checked?[...(d.inputs??[]),p.id]:(d.inputs??[]).filter(x=>x!==p.id)})}/>步骤 {draft.findIndex(x=>x.id===p.id)+1} · {describe(p,sources,outputs)}</label>)}</>}
   {d.op==='write'&&<><label>保存位置<Select value={d.output??''} onChange={e=>change(i,{...d,output:e.target.value})}>{outputs.map((o,j)=><option key={o.path} value={'output'+(j+1)}>{o.label} · {o.path}</option>)}</Select></label><label>保存哪个生成结果<Select value={d.input??''} onChange={e=>change(i,{...d,input:e.target.value})}><option value="">请选择</option>{prior.filter(p=>p.op==='generate').map(p=><option key={p.id} value={p.id}>步骤 {draft.findIndex(x=>x.id===p.id)+1}</option>)}</Select></label></>}
   <button className="secondary" onClick={()=>setDraft(v=>v.filter((_,j)=>j!==i))}>移除此步骤</button>
  </fieldset>;
 })}<div className="actions"><button className="secondary" disabled={disabled||draft.length>=16} onClick={add}>添加步骤</button><button id="save-task-plan" disabled={disabled} onClick={()=>void onSave({steps:draft})}>保存修改并重新审阅</button><button className="secondary" onClick={onCancel}>取消编辑</button></div></section>;
}
