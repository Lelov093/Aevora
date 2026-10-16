import type {WorkActivity} from './work-state';
import {SpeechSettings,type SpeechView} from './voice';
import {PresenceSettings,PresenceApp} from './presence';
import type {WorkResponse} from './work';
import {ProactivitySettings,ProactiveNotices,type ProactivityView} from './proactivity';
import type {WorkSeed} from './work';
import type {LearningSource} from './methods';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Command } from "../../../packages/protocol/command";
import "./style.css";
import type {Search} from './network-tasks';
import {Divider,usePanelWidth} from './layout';
import {TasksPanel} from "./tasks";
import type {GoalSummary,Goal} from './goals';
import type {ScheduleView} from './schedules';
import { MemorySettings, MemoryCenter, type Extraction } from "./memory";
import type {Embedding} from "./recall";
import { ConversationSidebar } from "./navigation";
import { Icon, Modal } from "./ui";
import { ChatPanel, ProviderSettings, eraseConversationDraft, type ChatSnapshot, type LiveRun, type Provider } from "./chat";

type Persona = { agent_id: string; persona_id: string; revision: number; identity_description: string;
  communication_style: string; created_by: string; created_at: string };
type Agent = { agent_id: string; name: string; persona_id: string; current_persona_revision: number;
  created_at: string; persona: Persona };
type AgentSummary = Pick<Agent, "agent_id" | "name" | "current_persona_revision"> & {last_active_at?:string};
export type Snapshot = { work_activity?:WorkActivity; speech?:SpeechView; proactivity?:ProactivityView|null;goals?:GoalSummary[]; scheduler?:ScheduleView; scheduler_error?:string|null; runtime_state: string; revision: number; sequence: number; schema_version: number;
  deleted_conversations?:{agent_id:string;conversation_id:string}[];
  agents: AgentSummary[]; selected_agent_id: string | null; selected_agent: Agent | null; chat: ChatSnapshot | null; provider: Provider; extraction: Extraction; embedding:Embedding; live_runs: LiveRun[]; provider_store_error?:string; search?:Search };
export type Host = { status: string; core_pid: number | null; restart_count: number; error: string | null };
type Draft = { identity_description: string; communication_style: string };
const draftFrom = (persona: Persona): Draft => ({
  identity_description:persona.identity_description, communication_style:persona.communication_style
});

function message(e: unknown) {
  const text = String(e);
  try {
    const error = JSON.parse(text).error;
    if(error.code === "RevisionConflict") return "内容已被更新。请检查当前状态并重新载入后再试。";
    const explanations:Record<string,string>={RecallUpdating:"当前记忆索引未就绪或正在更新，请稍后重试。",RecallUnavailable:"召回授权或预算不可用，请检查记忆设置。",SourceRevoked:"此旧来源已撤销，不能重试恢复；可通过新的明确输入建立记忆。",PersistenceFailed:"本机保存或清除未完成，尚未确认成功。",ContextStale:"记忆已改变，旧上下文回复已停止。"};
    if(explanations[error.code])return explanations[error.code];
    return error.message ?? text;
  } catch { return text; }
}
async function send<T>(command: Command) {
  const response = await invoke<{ status: string; data: T }>("runtime_command", {command});
  if(response.status !== "persisted") throw new Error("操作尚未持久化");
  return response.data;
}
const envelope = () => ({protocol_version: 1 as const, command_id: crypto.randomUUID()});

function PersonaEditor({agent, disabled, save}: {agent: Agent; disabled: boolean;
  save: (draft: Draft, revision: number) => Promise<Agent>}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(agent.persona));
  const [baseRevision, setBase] = useState(agent.persona.revision);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Persona[] | null>(null);
  useEffect(() => {
    if(!dirty) { setDraft(draftFrom(agent.persona)); setBase(agent.persona.revision); }
  }, [agent.persona.revision, dirty]);
  function update(key: keyof Draft, value: string) { setDraft(d => ({...d, [key]:value})); setDirty(true); }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      const updated = await save(draft, baseRevision);
      setDraft(draftFrom(updated.persona)); setBase(updated.persona.revision); setDirty(false); setHistory(null);
    } catch(e) { setError(message(e)); }
  }
  async function loadHistory() {
    try { setHistory(await send<Persona[]>({...envelope(), type:"GetPersonaHistory", agent_id:agent.agent_id,
      payload:{persona_id:agent.persona_id}})); } catch(e) { setError(message(e)); }
  }
  return <section className="settings-section">
    <div className="section-heading"><h2 id="agent-name">{agent.name}</h2><span className="badge">Persona v{agent.persona.revision}</span></div>
    <section className="identity"><p className="small muted">身份信息 · Persona v{agent.current_persona_revision}</p><code>{agent.agent_id}</code></section>
    <form id="persona-form" onSubmit={e => void submit(e)}>
      <label>身份描述<textarea id="edit-description" required maxLength={2000} rows={4}
        value={draft.identity_description} disabled={disabled} onChange={e => update("identity_description",e.target.value)}/></label>
      <label>表达风格<textarea id="edit-style" maxLength={1000} rows={2}
        value={draft.communication_style} disabled={disabled} onChange={e => update("communication_style",e.target.value)}/></label>
      {dirty && baseRevision !== agent.persona.revision && <p className="notice">当前版本已更新，保存前请处理版本冲突。</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button id="save-persona" disabled={disabled || !dirty}>保存 Persona</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => {setDraft(draftFrom(agent.persona));setBase(agent.persona.revision);setDirty(false);setError("");}}>重新载入</button>
        <button type="button" className="secondary" disabled={disabled} onClick={() => void loadHistory()}>修订历史</button></div>
    </form>
    <Modal open={!!history} close={()=>setHistory(null)} title="Persona 修订历史" id="persona-history-dialog">{history && <ol className="history">{history.map(p => <li key={p.revision}>
      <strong>v{p.revision}</strong><time>{new Date(p.created_at).toLocaleString()}</time>
      <p>{p.identity_description}</p><p className="muted">{p.communication_style || "未设表达风格"}</p>
    </li>)}</ol>}</Modal>
    <p className="muted small">Persona 的修改形成新版本；Agent 身份保持不变。</p>
  </section>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"persona"|"provider"|"voice"|"memory"|"proactivity"|"runtime">("persona");
  const [sidebarCollapsed,setSidebarCollapsed]=useState(window.innerWidth<=760);
  useEffect(()=>{const media=matchMedia('(max-width:760px)');const adapt=()=>{if(media.matches)setSidebarCollapsed(true);};media.addEventListener('change',adapt);return()=>media.removeEventListener('change',adapt);},[]);
  const [agentMenu, setAgentMenu] = useState(false);
  const [learnSeed,setLearnSeed]=useState<LearningSource|null>(null);
  const [workSeed,setWorkSeed]=useState<WorkSeed|null>(null);
  const [pane, setPane] = useState<"chat"|"memory"|"tasks">("chat");
  const [focusWorkSection,setFocusWorkSection]=useState<"tasks"|"goals"|"schedules"|"methods">("tasks");
  const [memoryView,setMemoryView]=useState<"memories"|"processing">("memories");
  function navigate(value:typeof pane){setPane(value);if(window.innerWidth<=620)setSidebarCollapsed(true);}
  const navigationWidth=usePanelWidth('aevora.navigationWidth',200,170,340);
  const [focusConversation,setFocusConversation]=useState<string|null>(null);
  const [workRequest,setWorkRequest]=useState(0),[focusGoalId,setFocusGoalId]=useState<string|null>(null);
  const [locateMessage,setLocateMessage]=useState<{conversation_id:string;message_id:string;nonce:number}|null>(null);
  const [focusScheduleId,setFocusScheduleId]=useState<string|null>(null);
  const goalSeed=snapshot?.chat?.resume_goal_id&&snapshot.selected_agent_id?{agent_id:snapshot.selected_agent_id,goal_id:snapshot.chat.resume_goal_id,conversation_id:snapshot.chat.selected_conversation_id}:null;
  const [focusTaskId,setFocusTaskId]=useState<string|null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [style, setStyle] = useState("");
  const presenceOpen=useRef<(v:Record<string,string>)=>Promise<void>>(async()=>{});
  const sequence = useRef(-1);
  const refreshId = useRef(0);
  async function refresh() {
    const id = ++refreshId.current;
    try {
      const status = await invoke<Host>("host_status");
      const next = await send<Snapshot>({...envelope(), type:"GetSnapshot", payload:{}});
      if(id !== refreshId.current || next.sequence < sequence.current) return;
      setHost(status); sequence.current = next.sequence; setSnapshot(next);
      for(const deleted of next.deleted_conversations??[])eraseConversationDraft(deleted.agent_id,deleted.conversation_id);
      setError(previous => previous.includes("Core unavailable") || previous.includes("Core connection unavailable") ? "" : previous);
      void invoke("frontend_snapshot", {revision:next.revision});
    } catch(e) {setHost(await invoke<Host>("host_status"));setError(message(e));}
  }
  useEffect(() => {
    void invoke("frontend_ready"); void refresh();
    const timer = setInterval(() => void refresh(),3000);
    let pending: ReturnType<typeof setTimeout> | undefined;
    const listener = listen("runtime-event", () => {if(!pending)pending=setTimeout(()=>{pending=undefined;void refresh();},100);});
    const speechEvent=listen('speech-event',()=>void refresh());
    const presenceEvent=listen<Record<string,string>>('presence-open',e=>{void presenceOpen.current(e.payload).catch(e=>setError(message(e)));});
    const controlError = listen<string>("runtime-control-error", event => setError(event.payload));
    return () => {clearInterval(timer);if(pending)clearTimeout(pending);void listener.then(off=>off());void controlError.then(off=>off());void speechEvent.then(off=>off());void presenceEvent.then(off=>off());};
  }, []);
  useEffect(() => {
    if(snapshot) void invoke("frontend_identity", {view: {
      window:getCurrentWindow().label, sequence:snapshot.sequence, agents:snapshot.agents,
      runtime_state:snapshot.runtime_state, runtime_revision:snapshot.revision, selected_agent:snapshot.selected_agent,
      rendered_agent_id:document.getElementById("agent-id")?.textContent ?? null,
      alerts:Array.from(document.querySelectorAll('[role="alert"]')).map(el=>el.textContent),
      chat:snapshot.chat,live_runs:snapshot.live_runs,
      rendered_messages:document.getElementById("chat-messages")?.textContent,
      edit_description:(document.getElementById("edit-description") as HTMLTextAreaElement|null)?.value
    }});
  }, [snapshot,creating,settings]);
  async function act<T>(command: Command, reportError = true) {
    setBusy(true);setError("");
    try {const data=await send<T>(command);await refresh();return data;}
    catch(e){if(reportError)setError(message(e));throw e;}
    finally{setBusy(false);}
  }
  async function create(e:React.FormEvent) {
    e.preventDefault();
    try {
      await act<Agent>({...envelope(),type:"CreateAgent",payload:{name,identity_description:description,communication_style:style}});
      setCreating(false);setName("");setDescription("");setStyle("");navigate("chat");
      if(!snapshot?.provider.credential_present){setSettingsTab("provider");setSettings(true);}
    } catch { /* Preserve form and show the actual error. */ }
  }
  const disabled=busy||host?.status!=="Ready";
  const selected=snapshot?.selected_agent;
  useEffect(()=>{setWorkSeed(null);setLearnSeed(null);},[selected?.agent_id]);
  const paused=snapshot?.runtime_state==="Paused";
  const status=host?.status==="Ready"?(paused?"后台已暂停":"运行中"):
    host?.status==="Offline"?"连接已中断":host?.status==="Recovering"?"正在恢复":"正在连接";
  async function newConversation(){
    if(!selected)return;
    try{await act({...envelope(),type:"CreateConversation",agent_id:selected.agent_id,payload:{}});navigate("chat");}catch{}
  }
  async function resumeGoal(g:Goal){if(!selected)return;try{await act({...envelope(),type:'CreateConversation',agent_id:selected.agent_id,payload:{resume_goal_id:g.goal_id}});navigate('chat');}catch{}}
  function openTasks(id?:string,taskId?:string,section?:typeof focusWorkSection,goalId?:string,conversationId=snapshot?.chat?.selected_conversation_id??null){setFocusWorkSection(taskId?'tasks':id?'schedules':section??'tasks');setFocusScheduleId(id??null);setFocusTaskId(taskId??null);setFocusGoalId(goalId??null);setFocusConversation(conversationId);setWorkRequest(v=>v+1);navigate('chat');}
  function allItems(){setFocusTaskId(null);setFocusScheduleId(null);setFocusGoalId(null);navigate('tasks');}
  async function openConversation(id:string,messageId?:string){if(!selected)return;if(id!==snapshot?.chat?.selected_conversation_id)await act({...envelope(),type:'SelectConversation',agent_id:selected.agent_id,payload:{conversation_id:id}});if(messageId)setLocateMessage({conversation_id:id,message_id:messageId,nonce:Date.now()});navigate('chat');}
  function openProvider(){setSettingsTab("provider");setSettings(true);}
  presenceOpen.current=async v=>{
    setSettings(false);
    if(!v.agent_id)return;
    if(selected?.agent_id!==v.agent_id)await act({...envelope(),type:'SelectAgent',agent_id:v.agent_id,payload:{}});
    if(v.conversation_id&&snapshot?.chat?.selected_conversation_id!==v.conversation_id)await act({...envelope(),type:'SelectConversation',agent_id:v.agent_id,payload:{conversation_id:v.conversation_id}});
    if(v.view_goal_id){const fresh=await send<Snapshot>({...envelope(),type:'GetSnapshot',payload:{}});const target=v.conversation_id??fresh.chat?.selected_conversation_id??null;openTasks(undefined,undefined,'goals',v.view_goal_id,target);if(!target)navigate('tasks');return;}
    if(v.goal_id){const g=await send<Goal>({...envelope(),type:'GetGoal',agent_id:v.agent_id,payload:{goal_id:v.goal_id}});await act({...envelope(),type:'CreateConversation',agent_id:v.agent_id,payload:{resume_goal_id:g.goal_id}});navigate('chat');return;}
    if(v.work_run_id){const fresh=await send<Snapshot>({...envelope(),type:'GetSnapshot',payload:{}});let w=fresh.chat?.work?.find(w=>w.run_id===v.work_run_id);if(!w)throw new Error('此需求来源已改变，请在对话中重新确认。');if(w.state==='None'&&w.can_prepare_file)w=await act<WorkResponse>({...envelope(),type:'PrepareFileWork',agent_id:v.agent_id,expected_revision:w.revision,payload:{run_id:w.run_id,use_method:false}});if(w.state!=='Pending'||!['file_task','agent_task'].includes(w.suggestion?.kind??''))throw new Error('当前需求不能直接准备文件任务，请查看原对话。');const g=w.context_goal_id?await send<Goal>({...envelope(),type:'GetGoal',agent_id:v.agent_id,payload:{goal_id:w.context_goal_id}}):null;setWorkSeed({work:w,goal:g});openTasks(undefined,undefined,undefined,undefined,fresh.chat?.selected_conversation_id??null);return;}
    if(v.pane==='tasks'){const fresh=await send<Snapshot>({...envelope(),type:'GetSnapshot',payload:{}});openTasks(v.schedule_id,v.task_id,undefined,undefined,fresh.chat?.selected_conversation_id??null);if(!fresh.chat?.selected_conversation_id)navigate('tasks');}else navigate('chat');
  };

  function taskPanel(embedded=false){
    if(!selected||!snapshot)return null;
    const current=!embedded||focusConversation===snapshot.chat?.selected_conversation_id;
    const cid=snapshot.chat?.selected_conversation_id??undefined;
    return <TasksPanel key={selected.agent_id} embedded={embedded} conversationId={cid}
      contextGoalIds={[...(snapshot.chat?.work?.flatMap(w=>[w.goal_id,w.context_goal_id].filter((id):id is string=>!!id))??[]),...(goalSeed&&goalSeed.conversation_id===cid?[goalSeed.goal_id]:[])]}
      agentId={selected.agent_id} provider={snapshot.provider} search={snapshot.search} sequence={snapshot.sequence} disabled={disabled} read={send} execute={act}
      scheduler={snapshot.scheduler} runtimeState={snapshot.runtime_state} openConversation={openConversation} focusScheduleId={current&&focusWorkSection==='schedules'?focusScheduleId:null} focusTaskId={current&&focusWorkSection==='tasks'?focusTaskId:null} focusGoalId={current&&focusWorkSection==='goals'?focusGoalId:null}
      goals={snapshot.goals??[]} resumeGoal={g=>void resumeGoal(g)} workSeed={workSeed} consumeWorkSeed={()=>setWorkSeed(null)} learnSeed={learnSeed} consumeLearnSeed={()=>setLearnSeed(null)} initialSection={focusWorkSection}
      openOverview={()=>navigate('tasks')} sectionChanged={setFocusWorkSection} selectionChanged={id=>{setFocusTaskId(id);setFocusConversation(cid??null);}}/>
  }
  return <main className="app-shell">
    <header className="app-header"><button className="icon-button" id="toggle-navigation" aria-label={sidebarCollapsed?"展开导航":"收起导航"} aria-expanded={!sidebarCollapsed} onClick={()=>setSidebarCollapsed(!sidebarCollapsed)}><Icon name="menu"/></button>
      <div className="brand" aria-label="Aevora"><span className="brand-mark">a</span><span>AEVORA</span></div>
      <button id="agent-switcher" className="agent-switcher" aria-haspopup="dialog" onClick={()=>setAgentMenu(true)} disabled={!snapshot}>
        <span className="avatar small">{selected?.name.slice(0,1)||"A"}</span><span>{selected?.name||"选择你的 Agent"}</span><Icon name="chevron"/>
      </button>
      <span id="agent-id" hidden>{selected?.agent_id}</span>
      <div className="runtime-bar" aria-live="polite"><span className={"status-dot "+(host?.status==="Ready"?(paused?"paused":"ready"):"offline")}/><span className="runtime-label">{status}</span>
        <button id="runtime-toggle" className="icon-button" aria-label={paused?"恢复后台工作":"暂停后台工作"} title={paused?"恢复后台工作":"暂停后台工作（前台对话仍可用）"} disabled={disabled||!snapshot}
          onClick={()=>{if(snapshot)void act({...envelope(),type:paused?"Resume":"Pause",expected_revision:snapshot.revision,payload:{}}).catch(()=>{});}}><Icon name={paused?"play":"pause"}/></button>
      </div>
      <button id="open-settings" className="icon-button" aria-label="设置" title="设置" disabled={!snapshot} onClick={()=>setSettings(true)}><Icon name="settings"/></button>
    </header>
    <div className="app-body" style={{"--nav-width":navigationWidth.width+"px"} as React.CSSProperties}>
      {selected&&snapshot?.chat&&<ConversationSidebar key={selected.agent_id} agentId={selected.agent_id} chat={snapshot.chat} sequence={snapshot.sequence} disabled={disabled}
        collapsed={sidebarCollapsed} openChat={()=>navigate("chat")} pane={pane} newConversation={newConversation} read={send} execute={act} choose={async cid=>{await act({...envelope(),type:"SelectConversation",agent_id:selected.agent_id,payload:{conversation_id:cid}});navigate("chat");}}
        openMemory={()=>{setMemoryView("memories");navigate("memory");}} openTasks={allItems} openSettings={()=>setSettings(true)}/>}
      {selected&&!sidebarCollapsed&&<Divider panel={navigationWidth} side="left" label="调节左侧导航宽度"/>}
      <div className="main-area">
        {snapshot?.scheduler_error&&<p className="notice" role="alert">定时提醒暂时无法保存触发结果，请检查本机状态；待触发约定仍保留。</p>}
        {selected&&<ProactiveNotices viewWork={id=>{openTasks(undefined,undefined,'goals',id);if(!snapshot?.chat?.selected_conversation_id)navigate('tasks');}} agentId={selected.agent_id} value={snapshot?.proactivity} disabled={disabled} execute={act} continueGoal={id=>{void send<Goal>({...envelope(),type:'GetGoal',agent_id:selected.agent_id,payload:{goal_id:id}}).then(g=>resumeGoal(g)).catch(e=>setError(message(e)));}}/>}
        {snapshot?.work_activity?.primary&&<div id="current-work-state" className="notice" aria-live="polite"><span>{snapshot.work_activity.primary.title} · {snapshot.work_activity.primary.label}</span><button className="secondary" onClick={()=>void (async()=>{const w=snapshot.work_activity!.primary!;const cid=w.conversation_id??snapshot.chat?.selected_conversation_id??null;if(w.conversation_id&&selected&&w.conversation_id!==snapshot.chat?.selected_conversation_id)await act({...envelope(),type:'SelectConversation',agent_id:selected.agent_id,payload:{conversation_id:w.conversation_id}});openTasks(undefined,w.kind==='task'?w.id:undefined,w.kind==='execution'?'goals':'tasks',w.goal_id??undefined,cid);if(!cid)navigate('tasks');})().catch(e=>setError(message(e)))}>查看实际工作</button></div>}
        {snapshot?.scheduler?.items.some(s=>s.state==='Ready')&&pane!=='tasks'&&<div id="schedule-ready-notice" className="notice" aria-live="polite">{selected?.name} 有 {snapshot.scheduler.items.filter(s=>s.state==='Ready').length} 条到期约定等待处理。<button className="secondary" id="open-due-schedules" onClick={()=>openTasks(snapshot.scheduler?.items.find(s=>s.state==='Ready')?.schedule_id)}>查看时间约定</button></div>}
        {(error||host?.error)&&<div role="alert" className="global-error"><span>{error||host?.error}</span><button className="text-button" onClick={()=>{setError("");void refresh();}}>重新检查</button></div>}
        {!snapshot?<div className="empty-state"><span className="brand-mark large">a</span><h1>正在连接 Aevora</h1><p>正在载入本机的身份与对话。</p></div>:
        !selected?<div className="empty-state welcome"><span className="brand-mark large">a</span><p className="eyebrow">YOUR PERSONAL AI</p><h1>从一个属于你的身份开始</h1><p>为你的 Agent 取一个名字，定义它最初的表达方式。<br/>身份与对话会保存在这台设备上。</p><button id="first-agent" onClick={()=>setCreating(true)}><Icon name="plus"/>创建你的 Agent</button></div>:
        pane==="tasks"?<div className="all-items"><button id="return-chat" className="text-button" onClick={()=>navigate("chat")}>← 返回当前对话</button>{taskPanel()}</div>:pane==="memory"?<MemoryCenter initialView={memoryView} key={selected.agent_id} agentId={selected.agent_id} extraction={snapshot.extraction??{}} embedding={snapshot.embedding??{}} sequence={snapshot.sequence} disabled={disabled} runtimeState={snapshot.runtime_state} execute={act} read={send} openTask={id=>openTasks(undefined,id)} openConversation={openConversation}/>:null}
        {selected&&snapshot?.chat&&<div className="chat-mounted" hidden={pane!=="chat"}>
        <ChatPanel key={selected.agent_id+":"+snapshot.chat.selected_conversation_id+":"+snapshot.chat.erasure_sequence} agentId={selected.agent_id} agentName={selected.name} chat={snapshot.chat}
          live={snapshot.live_runs} provider={snapshot.provider} search={snapshot.search} disabled={disabled} execute={act} read={send} openProvider={openProvider} openMemory={()=>{setMemoryView("processing");navigate("memory");}} openTasks={openTasks} newConversation={newConversation} scheduler={snapshot.scheduler} goals={snapshot.goals??[]} goalSeedId={goalSeed?.agent_id===selected.agent_id&&goalSeed.conversation_id===snapshot.chat.selected_conversation_id?goalSeed.goal_id:null} sequence={snapshot.sequence} prepareWork={v=>{setWorkSeed(v);openTasks();}} prepareLearn={(task_id,run_id)=>{setLearnSeed({task_id,run_id});openTasks();}} locateMessage={locateMessage} workRequest={focusConversation===snapshot.chat.selected_conversation_id?workRequest:0} workPanel={pane==='chat'?<><div className="work-expand"><button className="text-button" id="all-items-overview" onClick={()=>navigate('tasks')}>所有事项 / 展开详情 ↗</button></div>{taskPanel(true)}</>:null}/></div>}
      </div>
    </div>
    <Modal open={agentMenu} close={()=>setAgentMenu(false)} title="你的 Agents" id="agents-dialog">
      <p className="muted">每个身份拥有独立的对话与 Persona，一次与你的一个 Agent 协作。</p>
      <div className="agent-list">{snapshot?.agents.map(a=><button key={a.agent_id} data-agent={a.agent_id} className={"agent-card "+(selected?.agent_id===a.agent_id?"selected":"")} disabled={disabled}
        onClick={()=>{void act({...envelope(),type:"SelectAgent",agent_id:a.agent_id,payload:{}}).then(()=>{setAgentMenu(false);navigate("chat");}).catch(()=>{});}}>
        <span className="avatar">{a.name.slice(0,1)}</span><span><strong>{a.name}</strong><small>{a.last_active_at?"最近活动 · "+new Date(a.last_active_at).toLocaleString("zh-CN",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"尚无活动"}{snapshot.agents.filter(item=>item.name===a.name).length>1?" · "+a.agent_id.slice(0,8):""}</small></span>{selected?.agent_id===a.agent_id&&<span className="selected-label">当前</span>}
      </button>)}</div>
      <button id="new-agent" className="secondary" disabled={disabled} onClick={()=>{setAgentMenu(false);setCreating(true);}}><Icon name="plus"/>创建新 Agent</button>
    </Modal>
    <Modal open={creating} close={()=>setCreating(false)} title="创建你的 Agent" id="create-dialog">
      <p className="muted">定义最初的身份与表达方式，日后可以继续调整。</p>
      <form id="create-form" onSubmit={e=>void create(e)}>
        <label>名称<input id="create-name" autoFocus required maxLength={80} value={name} disabled={disabled} onChange={e=>setName(e.target.value)} placeholder="你想怎样称呼它？"/></label>
        <label>初始 Persona 描述<textarea id="create-description" required rows={4} maxLength={2000} value={description} disabled={disabled} onChange={e=>setDescription(e.target.value)} placeholder="例如：与我一起思考和工作的伙伴，理性、坦诚，也保有好奇心。"/></label>
        <label>表达风格 <span className="optional">可选</span><textarea id="create-style" rows={2} maxLength={1000} value={style} disabled={disabled} onChange={e=>setStyle(e.target.value)} placeholder="例如：温和、简洁；遇到复杂问题时详细解释。"/></label>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="actions"><button id="create-submit" disabled={disabled}>{busy?"正在创建…":"创建并打开"}</button><button type="button" className="secondary" onClick={()=>setCreating(false)}>取消</button></div>
      </form>
    </Modal>
    <Modal open={settings} close={()=>setSettings(false)} title="设置" id="settings-dialog">
      <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{([['persona','身份与 Persona'],['provider','模型与连接'],['voice','语音'],['memory','记忆与召回'],['proactivity','主动帮助'],['runtime','Presence 与运行']] as const).map(([tab,label])=><button key={tab} id={"settings-"+tab} className={settingsTab===tab?"selected":""} aria-current={settingsTab===tab?"page":undefined} onClick={()=>setSettingsTab(tab)}><Icon name={{persona:'identity',provider:'provider',voice:'voice',memory:'memory',proactivity:'proactivity',runtime:'presence'}[tab]}/>{label}</button>)}</nav><div className="settings-content"><p className="settings-scope"><Icon name="lock"/>{settingsTab==="persona"?"当前 Agent · "+(selected?.name??"未选择"):["provider","voice","runtime"].includes(settingsTab)?"共享 Host 配置":"当前 Agent 策略 · Host 管理出站授权"}</p>
      <div hidden={settingsTab!=="persona"}>{selected?<PersonaEditor key={selected.agent_id} agent={selected} disabled={disabled} save={(draft,revision)=>act<Agent>({...envelope(),type:"EditPersona",agent_id:selected.agent_id,expected_revision:revision,payload:{persona_id:selected.persona_id,...draft}},false)}/>:<p>创建 Agent 后即可编辑 Persona。</p>}</div>
      <div hidden={settingsTab!=="provider"}>{snapshot&&<ProviderSettings provider={snapshot.provider} disabled={disabled} execute={act} storeError={snapshot.provider_store_error}/>}</div>
      <div hidden={settingsTab!=="memory"}>{selected&&snapshot&&<MemorySettings key={selected.agent_id} agentId={selected.agent_id} provider={snapshot.provider} extraction={snapshot.extraction??{}} embedding={snapshot.embedding??{}} sequence={snapshot.sequence} disabled={disabled} execute={act} read={send}/>}</div>
      <div hidden={settingsTab!=="proactivity"}>{selected&&snapshot&&<ProactivitySettings key={selected.agent_id} agentId={selected.agent_id} value={snapshot.proactivity} goals={snapshot.goals??[]} provider={snapshot.provider} disabled={disabled} read={send} execute={act}/>}</div>
      <div hidden={settingsTab!=="voice"}><SpeechSettings/></div>
      <div hidden={settingsTab!=="runtime"} className="settings-section"><PresenceSettings/><h2>运行与窗口</h2><p>当前状态：{status}</p><p className="muted">关闭主窗口会收起到系统托盘。</p><details><summary>暂停、退出与数据保存说明</summary><p>暂停只影响后台工作，前台对话仍可继续；停止回复使用对话中的独立按钮。身份、对话与记忆保存在本机。</p></details><div className="actions"><button className="secondary" onClick={()=>void invoke("hide_main")}>收起到托盘</button><button className="secondary" onClick={()=>void invoke("quit_app")}>退出 Runtime</button></div><p className="muted small">记忆提取受独立用途与调用预算限制。身份、对话与记忆保存在本机。</p></div>
      {error&&<p className="error" role="alert">{error}</p>}</div></div>
    </Modal>
  </main>;
}
createRoot(document.getElementById("root")!).render(getCurrentWindow().label==='presence'?<PresenceApp/>:<App/>);
