import {BudgetField,budgetLabel} from './budget-field';
import type {ConversationGroup} from './conversation-organization';
import {SettingSection} from './settings-workspace';
import {MessageActions} from './message-actions';
import {ActionMenu} from './action-menu';
import {AgentComposer} from "./components/boardui/agent-composer";
import {AgentWorkDialog} from './agent-work';
import {InteractionTrialDialog,type ArmedTrial,type TrialRecord} from './interaction-trial';
import type {Proposal} from './methods';
import type {Search} from './network-tasks';
import {InteractionLearningDialog,ConversationLearningPanel,type InteractionFeedback} from './interaction-learning';
import {InteractionMemoryDialog,type UnderstandingKind} from './interaction-memory';
import {GoalFollowupDialog} from './goal-followup';
import {ConversationWorkPicker,type WorkApproval} from './conversation-context';
import {CheckField,NumberField} from './controls';
import {Markdown} from './markdown';
import {WorkCard,type WorkResponse,type WorkSeed} from './work';
import {VoiceControls,ReadReply} from './voice';
import {invoke} from '@tauri-apps/api/core';
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Command } from "../../../packages/protocol/command";
import {Divider,usePanelWidth} from "./layout";
import { Icon,PageTabs,Modal } from "./ui";
import {TaskResult} from './task-result';
import {CommitmentDialog} from './commitments';
import {scheduleNames,type ScheduleView} from './schedules';
import {GoalDialog,type GoalSummary} from './goals';
import {GoalContextPicker,type GoalApproval} from './goal-context';
export type Provider={base_url?:string;model?:string;revision?:number;credential_present?:boolean;chat_allowed?:boolean;max_input_tokens?:number;max_output_tokens?:number;chat_input_unlimited?:boolean;chat_output_unlimited?:boolean};
export type Conversation={conversation_id:string;title:string;display_title?:string;updated_at:string;group_id?:string|null;group_name?:string|null;pinned?:number;match_preview?:string};
export type Message={interaction_trial?:TrialRecord|null;interaction_feedback?:InteractionFeedback|null;interaction_methods?:{proposal_id:string;revision:number}[];message_id:string;content:string;role:string;sequence:number;finality:string;run_id:string;followup_request?:'silence'|'resume'|null;followup_applied?:{goal_id:string;silenced:boolean}[]};
export type Run={run_id:string;agent_id:string;conversation_id:string;input_message_id:string;input_text:string|null;state:string;error_code:string|null;retry_of?:string;
  context:{interaction_trial?:TrialRecord;history_trimmed:boolean;persona_revision:number;context_stale?:boolean;memory_revision_ids?:string[];recall?:{state:string}};provider_metadata:{finish_reason?:string}};
export type LiveRun={run_id:string;agent_id:string;conversation_id:string;text:string;state:string;saved:boolean;error_code?:string};
export type ChatSnapshot={conversation_groups?:ConversationGroup[];organization_revision?:number;conversations:Conversation[];selected_conversation_id:string|null;messages:Message[];has_more:boolean;runs:Run[];memory_jobs:{job_id:string;run_id:string;state:string;error:string|null}[];erasure_sequence?:number;work?:WorkResponse[];resume_goal_id?:string|null};
export type Execute=<T>(command:Command)=>Promise<T>;
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
const errors:Record<string,string>={ProviderUnavailable:"模型连接不可用，请检查设置",ProviderTimeout:"模型响应超时",StreamInterrupted:"连接中断",OutputTruncated:"达到输出上限，回复不完整",ProviderIncomplete:"模型未返回完整回复",RuntimeInterrupted:"运行中断，未自动重发",PersistenceFailed:"保存失败，未确认完成",ProviderProtocolError:"模型响应格式不支持",InvalidWorkSuggestion:"工作建议格式无效，未形成可执行建议"};
const stateNames:Record<string,string>={Created:"准备中",Running:"正在回复 · 尚未保存",Completed:"已完成并保存",Failed:"回复失败",Cancelled:"已停止回复"};
function explain(error:unknown){const text=String(error);try{return JSON.parse(text).error?.message??text;}catch{return text;}}
// Unsaved drafts and uncertain command acknowledgements remain scoped to a local conversation.
const drafts=new Map<string,string>();
const pendingCommands=new Map<string,Command>();
export function eraseConversationDraft(agentId:string,cid:string){const scope=agentId+":"+cid;drafts.delete(scope);for(const key of pendingCommands.keys())if(key.startsWith(scope+":"))pendingCommands.delete(key);}
export function ProviderSettings({provider,disabled,execute,storeError}:{provider:Provider;disabled:boolean;execute:Execute;storeError?:string}) {
  const [draft,setDraft] = useState({base_url:provider.base_url??"",model:provider.model??"",api_key:"",
    chat_allowed:provider.chat_allowed??false,max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,chat_input_unlimited:provider.chat_input_unlimited??false,chat_output_unlimited:provider.chat_output_unlimited??false});
  const [error,setError] = useState("");
  const [saved,setSaved] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [baseRevision,setBaseRevision] = useState(provider.revision??0);
  function reload(){setDraft({base_url:provider.base_url??"",model:provider.model??"",api_key:"",chat_allowed:provider.chat_allowed??false,
    max_input_tokens:provider.max_input_tokens??4096,max_output_tokens:provider.max_output_tokens??512,chat_input_unlimited:provider.chat_input_unlimited??false,chat_output_unlimited:provider.chat_output_unlimited??false});setBaseRevision(provider.revision??0);setDirty(false);setError("");}
  useEffect(()=>{if(!dirty)reload();},[provider.revision,dirty]);
  async function save(e:React.FormEvent) {
    e.preventDefault();setError("");setSaved(false);
    try {await execute({...envelope(),type:"ConfigureProvider",expected_revision:baseRevision,payload:draft});setDraft(d=>({...d,api_key:""}));setSaved(true);setDirty(false);}
    catch(e){setError(explain(e));}
  }
  return <section className="settings-section settings"><h2>模型与连接</h2><p className="muted">为对话选择模型，并明确哪些内容可以发送至服务商。</p>
    <SettingSection title="对话模型连接" description={provider.model||"配置服务地址、模型和密钥"} status={provider.chat_allowed?"已允许对话出站":"未授权"} initiallyOpen={!provider.credential_present}><form id="provider-form" onChange={()=>{setDirty(true);setSaved(false);}} onSubmit={e=>void save(e)}>
      <div className="settings-form-grid"><label className="field-wide">API Base URL<input id="provider-url" value={draft.base_url} required disabled={disabled} onChange={e=>setDraft(d=>({...d,base_url:e.target.value}))}/></label>
      <label className="field-wide">模型<input id="provider-model" value={draft.model} required disabled={disabled} onChange={e=>setDraft(d=>({...d,model:e.target.value}))}/></label>
      <label className="field-wide">API Key<input id="provider-key" type="password" autoComplete="off" value={draft.api_key} disabled={disabled}
        placeholder={provider.credential_present?"••••••••（留空保留，换地址需新 Key）":"输入 API Key"} onChange={e=>setDraft(d=>({...d,api_key:e.target.value}))}/></label></div>
      <details><summary>单次输入与输出上限</summary><div className="budget-fields"><BudgetField label="输入估算上限" id="provider-input-limit" min={512} max={32768} value={draft.max_input_tokens} unlimited={draft.chat_input_unlimited} disabled={disabled} onChange={n=>setDraft(d=>({...d,max_input_tokens:n}))} onUnlimitedChange={v=>setDraft(d=>({...d,chat_input_unlimited:v}))}/>
        <BudgetField label="输出上限" id="provider-output-limit" min={32} max={4096} value={draft.max_output_tokens} unlimited={draft.chat_output_unlimited} disabled={disabled} onChange={n=>setDraft(d=>({...d,max_output_tokens:n}))} onUnlimitedChange={v=>setDraft(d=>({...d,chat_output_unlimited:v}))}/></div><p className="settings-caption">不设限：对话输入不受本地 Token 估算阈值限制，输出使用服务商默认长度。模型上下文容量、近期对话条数和请求超时仍有效；任务与辅助用途保留独立限制。</p></details><div className="settings-authorization"><p><strong>本次保存目的地</strong> · {draft.base_url||"未填写"} · {draft.model||"未填写模型"}；输入上限 {budgetLabel(draft.max_input_tokens,draft.chat_input_unlimited)}、输出上限 {budgetLabel(draft.max_output_tokens,draft.chat_output_unlimited)}。</p>
      <label className="check"><CheckField type="checkbox" checked={draft.chat_allowed} onChange={e=>setDraft(d=>({...d,chat_allowed:e.target.checked}))}/>
        允许 Chat 将 Persona、当前输入、有界近期对话及已启用召回时的相关当前记忆发送到上述 Provider。提取与 Embedding 在“记忆与学习”中分别授权。</label>
      <p>密钥由本机 Windows 用户加密保存。输入预算为估算，实际用量以服务商返回为准。</p>
      {dirty&&baseRevision!==(provider.revision??0)&&<p className="notice">连接设置已在其他窗口更新，你的草稿仍保留。<button type="button" className="text-button" onClick={reload}>重新载入</button></p>}
      <div className="actions"><button id="provider-save" disabled={disabled}>保存配置</button>{saved&&<span role="status" className="success">配置已保存</span>}</div></div>
    {error&&<p role="alert" className="error">{error}</p>}</form></SettingSection>{!error&&storeError&&<p role="alert" className="error">{storeError}</p>}</section>;
}

export function ChatPanel({agentId,agentName,chat,live,provider,search,disabled,execute,read,openProvider,openMemory,openTasks,newConversation,scheduler,goals,goalSeedId,sequence,prepareWork,prepareLearn,workPanel,workRequest=0,locateMessage}:{workPanel?:(view:'artifacts'|'overview')=>React.ReactNode;workRequest?:number;locateMessage?:{conversation_id:string;message_id:string;nonce:number}|null;agentId:string;agentName:string;chat:ChatSnapshot;
  live:LiveRun[];provider:Provider;search?:Search;disabled:boolean;execute:Execute;read:Execute;openProvider:()=>void;openMemory:()=>void;openTasks:(scheduleId?:string,taskId?:string,section?:"tasks"|"goals"|"schedules"|"methods",goalId?:string)=>void;newConversation:()=>Promise<void>;scheduler?:ScheduleView;goals:GoalSummary[];goalSeedId?:string|null;sequence:number;prepareWork:(v:WorkSeed)=>void;prepareLearn:(taskId:string,runId:string)=>void}){
  const cid=chat.selected_conversation_id;const scope=agentId+":"+cid;
  const [text,setText]=useState(drafts.get(scope)||"");const [error,setError]=useState("");
  const [contextOpen,setContextOpen]=useState(!!goalSeedId),[statusOpen,setStatusOpen]=useState(false);
  const rightWidth=usePanelWidth('aevora.contextWidth',400,300,680);
  const [rightTab,setRightTab]=useState<'work'|'progress'|'context'|'learning'>(goalSeedId?'context':'work');
  useEffect(()=>{if(workRequest){setContextOpen(true);setRightTab('work');}},[workRequest]);
  const input=useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(()=>{if(input.current){input.current.style.height='auto';const height=input.current.scrollHeight;input.current.style.height=Math.min(height,144)+'px';input.current.style.overflowY=height>144?'auto':'hidden';}},[text]);
  const [origin,setOrigin]=useState<Message|null>(null),[followup,setFollowup]=useState<{silenced:boolean;sourceMessageId:string}|null>(null);
  const [agentCreating,setAgentCreating]=useState(false);
  const [trialProposal,setTrialProposal]=useState<Proposal|null>(null),[trial,setTrial]=useState<ArmedTrial|null>(null);
  useEffect(()=>{setTrial(null);setTrialProposal(null);},[agentId,cid,provider.base_url,provider.model,provider.revision]);
  const [feedbackSeed,setFeedbackSeed]=useState<string|undefined>(),[interactionSource,setInteractionSource]=useState<string|null>(null),[learningSeed,setLearningSeed]=useState<string|undefined>();
  const [memorySource,setMemorySource]=useState<{runId:string;kind?:UnderstandingKind;content?:string}|null>(null);
  useEffect(()=>{setMemorySource(null);setInteractionSource(null);},[agentId,cid]);
  const [goalOrigin,setGoalOrigin]=useState<Message|null>(null),[goalApproval,setGoalApproval]=useState<GoalApproval|null>(null),[goalPending,setGoalPending]=useState(false);
  const [workApproval,setWorkApproval]=useState<WorkApproval|null>(null),[workAvailable,setWorkAvailable]=useState(false);
  const [older,setOlder]=useState<Message[]>([]),[olderWork,setOlderWork]=useState<WorkResponse[]>([]);const [more,setMore]=useState(chat.has_more);const [loading,setLoading]=useState(false);
  useEffect(()=>{if(!cid||!older.length)return;let active=true;const ids=Array.from(new Set(older.map(m=>m.run_id)));
    void (async()=>{const all:WorkResponse[]=[];for(let i=0;i<ids.length;i+=50){all.push(...await read<WorkResponse[]>({...envelope(),type:'GetConversationWorkResponses',agent_id:agentId,payload:{conversation_id:cid,run_ids:ids.slice(i,i+50)}}));if(!active)return;}setOlderWork(all);})().catch(e=>{if(active)setError(explain(e));});return()=>{active=false;};
  },[sequence,cid,older.length]);
  const mounted=useRef(true);const scroll=useRef<HTMLDivElement>(null);const following=useRef(true);const [jump,setJump]=useState(false);
  useEffect(()=>()=>{mounted.current=false;},[]);
  useEffect(()=>{if(!older.length)setMore(chat.has_more);},[chat.has_more]);
  const active=chat.runs.find(r=>r.state==="Created"||r.state==="Running");
  const latest=chat.runs.find(r=>r.conversation_id===cid);
  const memoryJob=chat.memory_jobs.find(j=>j.run_id===latest?.run_id);
  const streams=live.filter(r=>r.agent_id===agentId&&r.conversation_id===cid);
  const msgs=[...older,...chat.messages].filter((m,i,list)=>list.findIndex(x=>x.message_id===m.message_id)===i).sort((a,b)=>a.sequence-b.sequence);
  const ready=!!provider.credential_present&&!!provider.chat_allowed;
  const retryable=latest&&["Failed","Cancelled"].includes(latest.state)&&latest.input_text!==null;
  const title=chat.conversations.find(c=>c.conversation_id===cid)?.display_title||"新对话";
  useEffect(()=>{if(cid)void invoke('presence_command',{payload:{action:'goal_context',context:{agent_id:agentId,conversation_id:cid,goal_context:goalApproval,work_context:workApproval,pending:goalPending}}}).catch(()=>{});},[agentId,cid,goalApproval,goalPending,workApproval]);
  useLayoutEffect(()=>{if(following.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[msgs.length,streams.map(r=>r.text).join(""),latest?.state]);
  async function submit(retry?:Run,voiceText?:string):Promise<Run|null>{
    if(!cid)return null;setError("");const key=scope+(retry?":retry:"+retry.run_id:":send");
    if(goalPending&&!goalApproval){setError('请先查看并确认本次目标上下文出站');return null;}
    const content=voiceText??retry?.input_text??text;
    const old=pendingCommands.get(key);
    if(!old||old.type!=="SendMessage"||old.payload.text!==content||JSON.stringify(old.payload.interaction_trial??null)!==JSON.stringify(trial?.grant??null)||JSON.stringify(old.payload.goal_context??null)!==JSON.stringify(goalApproval)||JSON.stringify((old.payload as {work_context?:WorkApproval}).work_context??null)!==JSON.stringify(workApproval))pendingCommands.set(key,{...envelope(),type:"SendMessage",agent_id:agentId,payload:{conversation_id:cid,text:content,work_suggestions:true,...(trial?{interaction_trial:trial.grant}:{}),...(retry?{retry_of:retry.run_id}:{}),...(goalApproval?{goal_context:goalApproval}:{}),...(workApproval?{work_context:workApproval}:{})}});
    try{const run=await execute<Run>(pendingCommands.get(key)!);pendingCommands.delete(key);setTrial(null);if(!retry){drafts.delete(scope);if(mounted.current)setText("");}following.current=true;return run;}
    catch(e){if(mounted.current)setError(explain(e));return null;}
  }
  async function loadOlder(){
    if(!cid||!msgs.length)return;setLoading(true);following.current=false;
    const height=scroll.current?.scrollHeight??0;const top=scroll.current?.scrollTop??0;
    try{const page=await read<{messages:Message[];has_more:boolean;work?:WorkResponse[]}>({...envelope(),type:"ListMessages",agent_id:agentId,payload:{conversation_id:cid,before_sequence:msgs[0].sequence}});
      if(!mounted.current)return;setOlderWork(prev=>[...(page.work??[]),...prev]);setOlder(prev=>[...page.messages,...prev]);setMore(page.has_more);
      requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=top+scroll.current.scrollHeight-height;});
    }catch(e){if(mounted.current)setError(explain(e));}finally{if(mounted.current)setLoading(false);}
  }
  useEffect(()=>{
    if(!locateMessage||locateMessage.conversation_id!==cid)return;
    let cancelled=false;following.current=false;
    async function locate(){
      let available=msgs,hasMore=more;
      try{
        while(!available.some(m=>m.message_id===locateMessage!.message_id)&&hasMore&&available.length){
          const before=available[0].sequence;
          const page=await read<{messages:Message[];has_more:boolean;work?:WorkResponse[]}>({...envelope(),type:'ListMessages',agent_id:agentId,payload:{conversation_id:cid!,before_sequence:before}});
          if(cancelled)return;
          if(!page.messages.length||page.messages[0].sequence>=before)break;
          available=[...page.messages,...available];hasMore=page.has_more;
          setOlderWork(old=>[...(page.work??[]),...old]);setOlder(old=>[...page.messages,...old]);setMore(hasMore);
        }
        if(cancelled)return;
        if(!available.some(m=>m.message_id===locateMessage!.message_id)){setError('来源消息已不可用，独立事项仍保留。');return;}
        requestAnimationFrame(()=>{if(cancelled)return;const node=scroll.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(locateMessage!.message_id)}"]`);node?.scrollIntoView({block:'center',behavior:'smooth'});node?.classList.add('source-highlight');setTimeout(()=>node?.classList.remove('source-highlight'),4500);});
      }catch(e){if(!cancelled)setError(explain(e));}
    }
    void locate();return()=>{cancelled=true;};
  },[locateMessage?.nonce,cid]);
  return <section className={"chat-workspace "+(!msgs.length&&!streams.length?"is-empty":"")} aria-label="对话工作区">
<div className="chat-layout" style={{"--context-width":rightWidth.width+"px"} as React.CSSProperties}><div className="chat-main">    <div className="view-heading"><div><Icon name="chat"/><h1 title={title}>{cid?title:agentName}</h1></div><button className={"secondary context-toggle "+(goalPending&&!goalApproval?"needs-confirmation":"")} id="toggle-chat-context" aria-expanded={contextOpen} onClick={()=>{setContextOpen(!contextOpen);if(goalPending)setRightTab("context");}}>{goalPending?(goalApproval?"目标资料已确认":"目标资料待确认"):"工作与资料"}<Icon name="chevron"/></button></div>
    <div ref={scroll} id="chat-messages" className="messages" role="log" aria-label="对话消息" aria-live="polite" onScroll={()=>{const el=scroll.current!;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;setJump(!following.current);}}>
      {more&&<button className="load-older text-button" disabled={disabled||loading} onClick={()=>void loadOlder()}>{loading?"正在载入…":"加载更早消息"}</button>}
      {!msgs.length&&!streams.length&&<div className="empty-state chat-welcome"><span className="avatar large">{agentName.slice(0,1)}</span><h2>你好，我是 {agentName}</h2><p>从一个问题，或一个想法开始。<br/>我们可以在这里继续每一次对话。</p>{!cid&&<button className="secondary" onClick={()=>void newConversation()} disabled={disabled}><Icon name="plus"/>开始新对话</button>}</div>}
      {msgs.map(m=>{
        const assistant=m.role==='assistant';
        const works=[...chat.work??[],...olderWork].filter((w,i,list)=>list.findIndex(x=>x.run_id===w.run_id)===i&&w.run_id===m.run_id);
        const source=(work:WorkResponse)=>msgs.find(x=>x.message_id===work.source_message_id)?.content??'';
        const feedback=(helpful:boolean)=>{setFeedbackSeed(helpful?'这次回复有帮助。':'这次回复需要改进：');setInteractionSource(m.run_id);};
        return <article key={m.message_id} data-message={m.message_id} className={'chat-message '+m.role}>
          {m.finality==='partial'&&<span className="message-partial" role="status">不完整回复 · 已保存残片</span>}
          <div className="message-content"><Markdown text={m.content}/></div>
          {m.role==='user'&&Boolean(m.followup_request||m.followup_applied?.length)&&<div className="notice compact" data-followup-request={m.message_id}>{m.followup_applied?.length?'已在本机确认处理此请求，当前状态以目标设置为准。':'这条请求尚未改变后台主动提醒。'}<button className="text-button" data-confirm-followup-request onClick={()=>setFollowup({silenced:m.followup_request!=='resume',sourceMessageId:m.message_id})} disabled={disabled}>{m.followup_request==='resume'?'选择目标并恢复主动提醒…':'选择目标并暂停主动提醒…'}</button></div>}
          {scheduler?.items.filter(item=>item.commitment?.source_message_id===m.message_id&&item.task_result).map(item=><TaskResult compact key={item.schedule_id} schedule={item} disabled={disabled} openTask={()=>openTasks(item.schedule_id,item.task_id)}/>)}
          {assistant&&works.map(work=><WorkCard key={work.run_id} agentId={agentId} work={work} source={source(work)} disabled={disabled} read={read} execute={execute} prepare={prepareWork} openTask={id=>openTasks(undefined,id)} openGoal={()=>openTasks(undefined,undefined,'goals',work.goal_id??work.context_goal_id??undefined)} learn={prepareLearn}/>)}
          {m.finality==='final'&&Boolean(m.content.trim())&&<MessageActions content={m.content} assistant={assistant} disabled={disabled} feedback={feedback} voice={assistant?<ReadReply compact agentId={agentId} cid={cid} id={m.message_id} content={m.content} disabled={disabled}/>:undefined}>
            {assistant&&<><button className="text-button" data-interaction-memory={m.run_id} disabled={disabled} onClick={()=>setMemorySource({runId:m.run_id})}>记住／纠正理解…</button><button className="text-button" data-interaction-learning={m.run_id} disabled={disabled} onClick={()=>{setFeedbackSeed(undefined);setInteractionSource(m.run_id);}}>交流反馈与学习…</button>
              {m.interaction_feedback&&!m.interaction_feedback.deleted&&<p className="small muted">已记录交流反馈</p>}
              {Boolean(m.interaction_methods?.length)&&<p className="small muted">{m.interaction_methods?.length} 项交流策略作为参考</p>}
              {m.interaction_trial&&<details className="small" data-interaction-trial={m.run_id}><summary>本次试用：{m.interaction_trial.title} · 版本 {m.interaction_trial.revision}（未正式采用）</summary><p>{m.interaction_trial.method.applicability}</p><ol>{m.interaction_trial.method.procedure.map((value,i)=><li key={i}>{value}</li>)}</ol><p>{m.interaction_trial.method.limits}</p></details>}
            </>}
            <button className="text-button" data-create-goal={m.message_id} disabled={disabled} onClick={()=>setGoalOrigin(m)}>建立长期目标…</button>
            <button className="text-button" data-create-commitment={m.message_id} disabled={disabled} onClick={()=>setOrigin(m)}>建立单次约定…</button>
            {m.role==='user'&&<><button className="text-button" disabled={disabled} onClick={()=>setFollowup({silenced:true,sourceMessageId:m.message_id})}>暂停目标主动提醒…</button><button className="text-button" disabled={disabled} onClick={()=>setFollowup({silenced:false,sourceMessageId:m.message_id})}>恢复目标主动提醒…</button></>}
            {works.map(work=><WorkCard preparationOnly key={work.run_id} agentId={agentId} work={work} source={source(work)} disabled={disabled} read={read} execute={execute} prepare={prepareWork} openTask={id=>openTasks(undefined,id)} openGoal={()=>openTasks(undefined,undefined,'goals',work.goal_id??undefined)} learn={prepareLearn}/>)}
            {scheduler?.items.filter(item=>item.commitment?.source_message_id===m.message_id).map(item=><button className="text-button" key={item.schedule_id} data-conversation-schedule={item.schedule_id} disabled={disabled} onClick={()=>openTasks(item.schedule_id)}>{item.title} · {scheduleNames[item.state]}</button>)}
            <button className="text-button" onClick={()=>setStatusOpen(true)}>对话与记忆处理状态…</button>
          </MessageActions>}
        </article>;
      })}
      {streams.map(r=><article key={r.run_id} data-live-run={r.run_id} className="chat-message assistant transient"><span className="message-author">{agentName}<small>{r.state==="Running"?"正在回复 · 尚未保存":"保存失败 · 尚未落盘"}</small></span><div className="message-content"><Markdown text={r.text||"正在等待模型回应…"}/></div></article>)}
    </div>

    <div className="composer-area">
      {trial&&<div className="notice compact" id="interaction-trial-ready" role="status">下一次回复试用：{trial.title} · 版本 {trial.grant.revision}<button className="text-button" disabled={!!active} onClick={()=>setTrial(null)}>取消试用</button></div>}
      {jump&&<button className="jump-latest text-button" onClick={()=>{following.current=true;scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:"smooth"});}}>回到最新消息 ↓</button>}
      {latest&&(latest.state!=='Completed'||latest.error_code||latest.context.context_stale)&&<div id="run-status" data-run={latest.run_id} data-state={latest.state} className={"run-status "+(latest.error_code?"notice":"")} role="status"><span>{stateNames[latest.state]}{latest.error_code?" · "+(latest.error_code==="RecallUpdating"?"记忆索引正在更新或未就绪":latest.error_code==="RecallUnavailable"?"召回授权或预算不可用":latest.error_code==="ContextStale"?"记忆、资料或策略已改变，此回复的上下文已失效":errors[latest.error_code]??latest.error_code):""}{latest.context.context_stale?" · 上下文已失效，未用于后续提取":""}{latest.context.memory_revision_ids?.length?" · 使用当前记忆 "+latest.context.memory_revision_ids.length+" 条":""}{latest.context.recall?.state==="Disabled"?" · 长期记忆召回未启用":""}{latest.context.history_trimmed?" · 仅使用部分近期上下文，完整历史仍保留":""}</span>
        {retryable&&<button id="retry-run" className="text-button" disabled={disabled||!!active||!ready} onClick={()=>void submit(latest)} title="使用原输入发起新请求，可能产生新的模型费用"><Icon name="retry"/>重试回复</button>}</div>}
      {retryable&&latest?.context.interaction_trial&&<p className="small muted">这条回复曾试用候选；重试前请在学习侧栏重新选择并确认候选，或发送新的普通消息。</p>}
      {memoryJob?.state==='Failed'&&<div className="run-status" role="status"><span>{memoryJob.state==="Failed"?"记忆提取失败 · 对话仍已保存":memoryJob.state==="Completed"?"记忆提取已完成 · 保存与审核结果请查看 Memory":memoryJob.state==="Running"?"记忆正在提取 · 尚未确认保存":memoryJob.state==="Cancelled"?"记忆提取已取消":"记忆提取已排队 · 等待授权、预算或后台运行"}</span><button className="text-button" onClick={openMemory}>查看记忆处理</button></div>}
      {active&&active.conversation_id!==cid&&<p className="notice">此 Agent 正在另一会话中回复，完成后可继续发送。</p>}
      {!ready&&<div className="connection-notice"><span>配置模型并允许对话出站后即可发送。本地历史仍可查看。</span><button className="text-button" onClick={openProvider}>配置连接</button></div>}
      {error&&<p className="error" role="alert">{error}</p>}
      {goalPending&&!goalApproval&&<div className="notice compact" role="status">目标资料尚未确认，暂不能发送。<button className="text-button" onClick={()=>{setContextOpen(true);setRightTab("context");}}>查看并确认</button></div>}

      <AgentComposer inputUnlimited={provider.chat_input_unlimited} value={text} onValueChange={value=>{setText(value);drafts.set(scope,value);}}
        onSubmit={()=>void submit()} onStop={()=>{if(active)void execute({...envelope(),type:"CancelRun",agent_id:agentId,payload:{run_id:active.run_id}}).catch(e=>setError(explain(e)));}}
        busy={!!active&&active.conversation_id===cid} disabled={disabled||!cid}
        sendDisabled={disabled||!!active||!cid||!text.trim()||!ready||(goalPending&&!goalApproval)} model={provider.model??''} openProvider={openProvider}
        placeholder={cid?"有什么想一起聊聊？":"点击“新对话”开始交流"} inputRef={input}
        attachments={<><button type="button" id="chat-agent-work" className="text-button" disabled={disabled||!!active} onClick={()=>setAgentCreating(true)}><Icon name="search"/>查证或处理…</button><button id="chat-files" type="button" className="text-button" disabled={disabled} onClick={()=>openTasks()}><Icon name="paperclip"/>处理文件…</button></>}
        voice={<VoiceControls agentId={agentId} cid={cid} chat={chat} disabled={disabled} canSend={ready&&(!goalPending||!!goalApproval)} execute={execute} onText={async(value,auto)=>{setText(value);drafts.set(scope,value);return auto?submit(undefined,value):null;}}/>}
        status={<><button type="button" id={workAvailable&&!workApproval&&!goalApproval?'review-conversation-work':undefined} className="text-button" title="查看并确认当前工作资料。普通交流可继续，资料未经确认不会随消息出站。" onClick={()=>{setContextOpen(true);setRightTab('context');}}><Icon name="paperclip"/>本次资料{workAvailable&&!workApproval&&!goalApproval?' · 可带入工作进展':''}</button><button type="button" className="text-button" onClick={()=>{setContextOpen(true);setRightTab('work');}}><Icon name="work"/>关联工作</button></>}/>

    </div>
    </div>{contextOpen&&<Divider panel={rightWidth} side="right" label="调节对话右栏宽度"/>}<aside className="context-panel" hidden={!contextOpen} aria-label="对话事项与资料"><div className="context-heading"><div className="context-toolbar"><PageTabs label="对话右栏分类" value={rightTab} change={setRightTab} items={[["work","产物"],["progress","进展"],["context","资料"]]}/><ActionMenu label="右栏更多"><button className="text-button" onClick={()=>setRightTab('learning')}>交流策略与学习…</button><button className="text-button" onClick={()=>setStatusOpen(true)}>对话与记忆处理状态…</button></ActionMenu></div><button className="icon-button" aria-label="关闭上下文面板" onClick={()=>setContextOpen(false)}><Icon name="close"/></button></div><div hidden={rightTab!=='work'&&rightTab!=='progress'}>{workPanel?.(rightTab==='progress'?'overview':'artifacts')}</div><div hidden={rightTab!=="learning"}><ConversationLearningPanel prepareTrial={setTrialProposal} agentId={agentId} provider={provider} sequence={sequence} disabled={disabled||!!active} read={read} execute={execute} seedId={learningSeed}/></div><div hidden={rightTab!=="context"}>
    {(goals.length>0||goalSeedId)&&<details className="goal-picker-options" open={!!goalSeedId||undefined}><summary>带入目标资料（可选）</summary><GoalContextPicker agentId={agentId} items={goals} seedId={goalSeedId} selectGoal={id=>execute({...envelope(),type:'SetConversationGoal',agent_id:agentId,payload:{conversation_id:cid!,goal_id:id||null}}).then(()=>{})} sequence={sequence} provider={provider} disabled={disabled||!!active} read={read} changed={(v,pending)=>{setGoalApproval(v);setGoalPending(pending);}}/><p className="small muted">目标资料只在本次明确确认后出站。资料改变后需重新确认；目标不授予执行权限。</p></details>}{!goals.length&&!goalSeedId&&<p className="muted">目前没有长期目标。可从消息的更多菜单建立目标，也可以在所有事项中管理。</p>}<ConversationWorkPicker agentId={agentId} cid={cid} sequence={sequence} provider={provider} disabled={disabled||!!active} read={read} changed={(v,available)=>{setWorkApproval(v);setWorkAvailable(available);}}/></div></aside></div>
    <Modal open={statusOpen} close={()=>setStatusOpen(false)} title="对话与记忆处理状态" id="chat-status-dialog">
      {latest?<><p>{stateNames[latest.state]}{latest.error_code?' · '+(errors[latest.error_code]??latest.error_code):''}</p><p className="small muted">{latest.context.recall?.state==='Disabled'?'长期记忆召回未启用':`本次使用 ${latest.context.memory_revision_ids?.length??0} 条当前记忆`}{latest.context.history_trimmed?' · 仅使用部分近期上下文，完整历史仍保留':''}{latest.context.context_stale?' · 上下文已失效，未用于后续提取':''}</p></>:<p>本会话暂无运行记录。</p>}
      {memoryJob&&<div className="run-status" role="status"><span>{memoryJob.state==="Failed"?"记忆提取失败 · 对话仍已保存":memoryJob.state==="Completed"?"记忆提取已完成 · 保存与审核结果请查看 Memory":memoryJob.state==="Running"?"记忆正在提取 · 尚未确认保存":memoryJob.state==="Cancelled"?"记忆提取已取消":"记忆提取已排队 · 等待授权、预算或后台运行"}</span><button className="text-button" onClick={openMemory}>查看记忆处理</button></div>}
      <button className="text-button" onClick={()=>{setStatusOpen(false);openMemory();}}>查看记忆处理</button>
    </Modal>
    {trialProposal&&<InteractionTrialDialog value={trialProposal} provider={provider} disabled={disabled||!!active} close={()=>setTrialProposal(null)} confirm={value=>{setTrial(value);setTrialProposal(null);input.current?.focus();}}/>}
    {agentCreating&&<AgentWorkDialog agentId={agentId} provider={provider} search={search} conversationId={cid??undefined} initialText={text} disabled={disabled} read={read} execute={execute} close={()=>setAgentCreating(false)} created={id=>openTasks(undefined,id)}/>}
    {interactionSource&&<InteractionLearningDialog initialNote={feedbackSeed} key={interactionSource} agentId={agentId} runId={interactionSource} provider={provider} disabled={disabled} read={read} execute={execute} close={()=>setInteractionSource(null)} remember={(kind,content)=>{setMemorySource({runId:interactionSource,kind,content});setInteractionSource(null);}} created={id=>{setLearningSeed(id);setRightTab("learning");setContextOpen(true);}}/>}
    {memorySource&&<InteractionMemoryDialog key={memorySource.runId} agentId={agentId} runId={memorySource.runId} seedKind={memorySource.kind} seedContent={memorySource.content} disabled={disabled} read={read} execute={execute} close={()=>setMemorySource(null)}/>}
    {followup&&<GoalFollowupDialog agentId={agentId} goals={goals} seedId={goalSeedId} silenced={followup.silenced} sourceMessageId={followup.sourceMessageId} disabled={disabled} execute={execute} close={()=>setFollowup(null)}/>}
    {origin&&cid&&<CommitmentDialog key={origin.message_id} agentId={agentId} conversationId={cid} message={origin} value={scheduler} disabled={disabled} execute={execute} close={()=>setOrigin(null)} created={s=>openTasks(s.schedule_id)}/>}
    {goalOrigin&&cid&&<GoalDialog agentId={agentId} source={{conversation_id:cid,message_id:goalOrigin.message_id,content:goalOrigin.content}} disabled={disabled} execute={execute} close={()=>setGoalOrigin(null)} saved={g=>openTasks(undefined,undefined,"goals",g.goal_id)}/>}
  </section>;
}
