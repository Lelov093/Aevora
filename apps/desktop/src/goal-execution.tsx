import {BudgetField,budgetLabel} from './budget-field';
import {executionNames as names} from './work-state';
import type {MethodRef,Proposal} from './methods';
import {Select} from './controls';
import {useEffect,useState} from 'react';
import type {Execute,Provider} from './chat';
import type {Goal} from './goals';
import {ToolScopeFields,emptyToolScope,type ToolScope} from './general-tools';
import {providerBinding} from './methods';
import {CheckField,NumberField} from './controls';

const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
type NodeSpec={id:string;title:string;instruction:string;depends_on:string[];not_before:string|null;condition:{root:string;path:string;mode:'exists'|'changed'}|null;requires_product:boolean};
type Node=NodeSpec&{state:string;reason:string;task_id:string|null;retired?:boolean};
type Execution={execution_id:string;revision:number;state:string;reason:string;nodes:Node[];scope:{method_ref?:MethodRef;conversation_id?:string;expires_at:string;allow_replan:boolean;tools:ToolScope;calls_unlimited?:boolean;tokens_unlimited?:boolean;max_calls:number;max_tokens:number;max_tasks:number;allow_future_files:boolean;allow_memory:boolean;allow_search:boolean;max_changes:number;max_commands:number;max_searches:number;max_pages:number;max_active_seconds:number;max_decisions:number};budget?:{calls:number;tokens:number;counts:Record<string,number>;state:string};work:{kind:string;result:{raw_output?:string;error?:string}}[]};
const nodeNames:Record<string,string>={Pending:'等待前置条件',Created:'准备工作',Generating:'正在思考',Running:'正在执行',Executing:'正在操作',Searching:'正在搜索',ReadingWeb:'正在读取页面',AwaitingApproval:'等待具体审批',AwaitingInput:'等待补充信息',Done:'已完成',Failed:'未完成',Paused:'已暂停'};
const permissionNames:Record<string,string>={Active:'有效',Planning:'仅允许规划',Paused:'已暂停',Revoked:'已撤销',Completed:'本轮已结束'};
const explain=(e:unknown)=>{try{return JSON.parse(String(e)).error?.message??String(e);}catch{return String(e);}};

export function GoalExecution({agentId,goal,provider,sequence,disabled,schedulerEnabled,read,execute,openTask}:{agentId:string;goal:Goal;provider:Provider;sequence:number;disabled:boolean;schedulerEnabled:boolean;read:Execute;execute:Execute;openTask:(id:string)=>void}){
 const [value,setValue]=useState<Execution|null>(null),[tools,setTools]=useState(emptyToolScope),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [renewing,setRenewing]=useState(false);
 const [catalogRevision,setCatalogRevision]=useState(0);
 const [methods,setMethods]=useState<Proposal[]>([]),[method,setMethod]=useState<MethodRef|null>(null),[conversations,setConversations]=useState<{conversation_id:string;display_title:string}[]>([]),[conversation,setConversation]=useState(goal.source_conversation_id??'');
 const methodCurrent=!method||methods.some(m=>m.proposal_id===method.proposal_id&&m.revision===method.revision&&m.state==='Active'&&m.family==='collaboration');
 useEffect(()=>{setConsent(false);},[provider.base_url,provider.model,provider.revision]);
 useEffect(()=>{setValue(null);setMethod(null);setConversation(goal.source_conversation_id??'');setConsent(false);setRenewing(false);},[agentId,goal.goal_id]);
 useEffect(()=>{if(value&&!renewing)return;let active=true;void Promise.all([read<Proposal[]>({...envelope(),type:'ListMethods',agent_id:agentId,payload:{}}),read<{conversation_id:string;display_title:string}[]>({...envelope(),type:'ListConversations',agent_id:agentId,payload:{}})]).then(([m,c])=>{if(active){setMethods(m);setConversations(c);}}).catch(e=>{if(active)setError(explain(e));});return()=>{active=false;};},[agentId,goal.goal_id,value?.execution_id,renewing,catalogRevision]);
 const [expires,setExpires]=useState(()=>new Date(Date.now()+86400000-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)),[calls,setCalls]=useState(32),[tokens,setTokens]=useState(1200000),[tasks,setTasks]=useState(3);
 const [callsUnlimited,setCallsUnlimited]=useState(false),[tokensUnlimited,setTokensUnlimited]=useState(false);
 const [limits,setLimits]=useState({max_changes:8,max_commands:4,max_searches:3,max_pages:6,max_active_seconds:1800,max_decisions:24});
 const [future,setFuture]=useState(false),[replan,setReplan]=useState(false),[memory,setMemory]=useState(false),[network,setNetwork]=useState(false),[consent,setConsent]=useState(false),[approved,setApproved]=useState(false),[editing,setEditing]=useState<string|null>(null);
 useEffect(()=>{let active=true;void read<Execution|null>({...envelope(),type:'GetGoalExecution',agent_id:agentId,payload:{goal_id:goal.goal_id}}).then(v=>{if(active){setValue(v);setError('');}}).catch(e=>{if(active)setError(explain(e));});return()=>{active=false;};},[agentId,goal.goal_id,sequence]);
 useEffect(()=>setApproved(false),[value?.revision]);
 async function create(){setBusy(true);try{
  const scope={...(method?{method_ref:method}:{}),...(conversation?{conversation_id:conversation}:{}),expires_at:new Date(expires).toISOString(),provider:providerBinding(provider),tools,allow_memory:memory,allow_search:network,allow_future_files:future,allow_replan:replan,max_calls:calls,max_tokens:tokens,calls_unlimited:callsUnlimited,tokens_unlimited:tokensUnlimited,max_tasks:tasks,...limits,max_searches:network?limits.max_searches:0};
  const result=value&&renewing?await execute<Execution>({...envelope(),type:'RenewGoalExecution',agent_id:agentId,expected_revision:value.revision,payload:{execution_id:value.execution_id,scope,allow_outbound:true}}):await execute<Execution>({...envelope(),type:'CreateGoalExecution',agent_id:agentId,payload:{goal_id:goal.goal_id,goal_revision:goal.revision,scope,allow_outbound:true}});setValue(result);setConsent(false);setRenewing(false);
 }catch(e){setError(explain(e));}finally{setBusy(false);}}
 async function control(type:'ApproveGoalExecution'|'PauseGoalExecution'|'ResumeGoalExecution'|'RevokeGoalExecution'){
  if(!value)return;setBusy(true);try{setValue(await execute<Execution>({...envelope(),type,agent_id:agentId,expected_revision:value.revision,payload:{execution_id:value.execution_id,acknowledge:true}}));setApproved(false);}catch(e){setError(explain(e));}finally{setBusy(false);}
 }
 async function save(){if(!value||editing===null)return;try{const nodes=JSON.parse(editing) as NodeSpec[];setValue(await execute<Execution>({...envelope(),type:'EditGoalExecutionPlan',agent_id:agentId,expected_revision:value.revision,payload:{execution_id:value.execution_id,nodes}}));setEditing(null);}catch(e){setError(explain(e));}}
 return <section aria-label="目标的长期执行"><h4>让Agent持续推进</h4>
  <p className="small muted">在明确的资源、期限和总预算内自动推进；需要具体命令审批或扩大范围时等待你。关闭通知不会授予或撤销行动权限。</p>
  {!value||renewing?<details open={renewing||undefined}><summary>准备长期授权并生成计划</summary>
   <p>当前目标：{goal.objective}。达成条件：{goal.success_criteria}。</p>
   <div onChange={()=>setConsent(false)}><ToolScopeFields value={tools} change={v=>{setTools(v);setConsent(false);}}/>
   <button className="text-button" onClick={()=>{setCatalogRevision(v=>v+1);setConsent(false);}}>刷新可用策略与会话</button><label>工作协作策略<Select value={method?.proposal_id??''} onChange={e=>{const m=methods.find(v=>v.proposal_id===e.target.value);setMethod(m?{proposal_id:m.proposal_id,revision:m.revision,mode:'active'}:null);}}><option value="">不指定工作策略</option>{methods.filter(m=>m.family==='collaboration'&&m.state==='Active').map(m=><option key={m.proposal_id} value={m.proposal_id}>{m.method?.title??m.proposal_id} · v{m.revision}</option>)}</Select></label>{!methodCurrent&&<p role="alert" className="error">所选策略已变更，请重新选择当前版本或不指定。</p>}
   <label>工作返回会话<Select value={conversation} onChange={e=>setConversation(e.target.value)}><option value="">不另指定（沿用仍有效的目标来源）</option>{conversations.map(c=><option key={c.conversation_id} value={c.conversation_id}>{c.display_title}</option>)}</Select></label><p className="small muted">仅保留本机工作归属；供普通交流使用前仍需确认工作资料。Memory召回沿既有独立Embedding／Selection用途与额度，本处主模型总账不包含辅助用途。</p>
   <label>授权到期（本地时间）<input type="datetime-local" value={expires} onChange={e=>setExpires(e.target.value)}/></label>
   <BudgetField label="累计模型请求上限" min={1} max={1000} value={calls} unlimited={callsUnlimited} onChange={setCalls} onUnlimitedChange={setCallsUnlimited}/>
   <BudgetField label="累计 tokens 上限（含未知预留）" min={64} max={10000000} value={tokens} unlimited={tokensUnlimited} onChange={setTokens} onUnlimitedChange={setTokensUnlimited}/>
   <label>最多子任务<NumberField min={1} max={100} value={tasks} onChange={e=>setTasks(Number(e.target.value))}/></label>
   <label className="check"><CheckField checked={future} onChange={e=>setFuture(e.target.checked)}/>允许所选目录在有效期内后续到达／变化的文件出站；不选则只使用当前版本</label>
   <label className="check"><CheckField checked={replan} onChange={e=>setReplan(e.target.checked)}/>允许根据实际结果在原范围调整未来节点</label>
   <label className="check"><CheckField checked={memory} onChange={e=>setMemory(e.target.checked)}/>允许使用当前有效Memory</label>
   <label className="check"><CheckField checked={network} onChange={e=>setNetwork(e.target.checked)}/>允许已配置的公开搜索（仍受累计额度限制）</label>
   <details><summary>其他累计额度</summary>{([['max_changes','累计变更目标次数',1000],['max_commands','累计具体批准命令次数',100],['max_searches','累计搜索次数',100],['max_pages','累计页面次数',100],['max_active_seconds','累计主动执行秒数',86400],['max_decisions','每Task最多决策次数',24]] as const).map(([key,label,max])=><label key={key}>{label}<NumberField min={key==='max_decisions'?2:key==='max_changes'||key==='max_active_seconds'?1:0} max={max} value={limits[key]} onChange={e=>setLimits({...limits,[key]:Number(e.target.value)})}/></label>)}</details></div>
   <p className="small muted">本次累计最多{limits.max_changes}个变更目标次数、{limits.max_commands}次具体审批后的命令、{limits.max_pages}次页面读取、{limits.max_active_seconds}秒主动执行；每Task仍受工具范围中的较小上限约束。退出后不执行，重启仅恢复有效授权；默认无长期执行。</p>
   {!schedulerEnabled&&<p className="notice">先在“时间约定”中明确启用此Agent的本地调度。</p>}
   <label className="check"><CheckField checked={consent} onChange={e=>setConsent(e.target.checked)}/>我确认当前模型、目标、资料出站和以上总范围；先请求计划，审阅后再启动执行</label>
   <button disabled={disabled||busy||!methodCurrent||!consent||!schedulerEnabled||!provider.chat_allowed||goal.state!=='Active'} onClick={()=>void create()}>{renewing?'重新确认许可并生成待审计划':'生成待审计划'}</button>{renewing&&<button className="secondary" onClick={()=>setRenewing(false)}>取消调整</button>}
  </details>:<>
   <p role="status"><strong>{names[value.state]??value.state}</strong> · {value.reason}</p>
   <p className="small">许可到期：{new Date(value.scope.expires_at).toLocaleString()}；请求预留／启动 {value.budget?.calls??0}/{budgetLabel(value.scope.max_calls,value.scope.calls_unlimited)} 次／tokens记账 {value.budget?.tokens??0}/{budgetLabel(value.scope.max_tokens,value.scope.tokens_unlimited)}（含未知预留）。当前许可：{permissionNames[value.budget?.state??'']??'等待同步'}。</p>
   <p className="small muted">累计变更{value.budget?.counts?.changes??0}/{value.scope.max_changes}；命令{value.budget?.counts?.commands??0}/{value.scope.max_commands}；搜索{value.budget?.counts?.searches??0}/{value.scope.max_searches}；页面{value.budget?.counts?.pages??0}/{value.scope.max_pages}。</p>
   <ol>{value.nodes.map(n=><li key={n.id}><strong>{n.title}</strong> · {nodeNames[n.state]??n.state}{n.retired?'（已被后续方案替代，原失败保留）':''}<p>{n.instruction}</p><p className="small">依赖：{n.depends_on.map(id=>value.nodes.find(d=>d.id===id)?.title??id).join('、')||'无'}；最早：{n.not_before?new Date(n.not_before).toLocaleString():'条件满足时'}；文件：{n.condition?`${n.condition.root}/${n.condition.path} · ${n.condition.mode==='exists'?'等待出现':'等待变化'}`:'无'}；{n.reason}</p>{n.task_id&&<button className="text-button" onClick={()=>openTask(n.task_id!)}>查看实际任务与产物</button>}</li>)}</ol>
   {['AwaitingPlanApproval','Paused','NeedsAttention'].includes(value.state)&&<><button className="secondary" disabled={disabled||busy} onClick={()=>setEditing(JSON.stringify(value.nodes.filter(n=>!n.task_id).map(n=>Object.fromEntries(['id','title','instruction','depends_on','not_before','condition','requires_product'].map(k=>[k,n[k as keyof Node]]))),null,2))}>编辑未来节点…</button>{editing!==null&&<><label>未来节点JSON<textarea rows={12} value={editing} onChange={e=>setEditing(e.target.value)}/></label><button onClick={()=>void save()}>保存并重新审阅</button></>}</>}
   {['AwaitingPlanApproval','Paused','NeedsAttention'].includes(value.state)&&<><label className="check"><CheckField checked={approved} onChange={e=>setApproved(e.target.checked)}/>我已审阅当前计划／等待原因；确认继续有效范围内工作，可能产生新的模型／搜索／页面调用。未知副作用须先核对。</label><button disabled={disabled||busy||!approved||goal.state!=='Active'} onClick={()=>void control(value.state==='AwaitingPlanApproval'?'ApproveGoalExecution':'ResumeGoalExecution')}>{value.state==='AwaitingPlanApproval'?'确认计划并开始':'恢复／继续'}</button></>}
   {['Running','Waiting','Planning'].includes(value.state)&&<button className="secondary" disabled={disabled||busy} onClick={()=>void control('PauseGoalExecution')}>暂停此执行及所属工作</button>}
   {['Paused','NeedsAttention','AwaitingPlanApproval'].includes(value.state)&&<button className="secondary" disabled={disabled||busy} onClick={()=>{setMethod(value.scope.method_ref??null);setConversation(value.scope.conversation_id??goal.source_conversation_id??'');setTools(value.scope.tools);setLimits({max_changes:value.scope.max_changes,max_commands:value.scope.max_commands,max_searches:value.scope.max_searches,max_pages:value.scope.max_pages,max_active_seconds:value.scope.max_active_seconds,max_decisions:value.scope.max_decisions});setCalls(value.scope.max_calls);setTokens(value.scope.max_tokens);setTasks(value.scope.max_tasks);setFuture(value.scope.allow_future_files);setReplan(value.scope.allow_replan);setMemory(value.scope.allow_memory);setNetwork(value.scope.allow_search);setConsent(false);setRenewing(true);}}>重新授权期限／范围／总额度…</button>}
   <p className="small muted">重新授权保留全部已用预算和历史尝试，停止旧子任务；新未来计划仍需审阅。</p>
   {!['Revoked','Completed'].includes(value.state)&&<button className="secondary" disabled={disabled||busy} onClick={()=>void control('RevokeGoalExecution')}>撤销此长期许可</button>}
   {['Revoked','Completed'].includes(value.state)&&<><p className="small muted">旧执行记录与计数保留；新的明确授权单独计数。</p><button className="secondary" disabled={disabled||busy||goal.state!=='Active'} onClick={()=>{setValue(null);setConsent(false);}}>为此目标准备新一期授权…</button></>}
   <details><summary>计划原稿与限制</summary>{value.work.filter(w=>w.kind==='Plan').map((w,i)=><div key={i}><p>{w.result.error}</p><pre className="report-preview">{w.result.raw_output??'尚未返回'}</pre></div>)}</details>
  </>}{error&&<p role="alert" className="error">{error}</p>}
 </section>;
}
