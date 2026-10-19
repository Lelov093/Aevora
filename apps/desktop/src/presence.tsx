import type {WorkApproval} from './conversation-context';
import {CheckField,Select} from './controls';
import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import type {Snapshot,Host} from './main';
import type {Command} from '../../../packages/protocol/command';
import type {Execute,Run} from './chat';
import type {GoalApproval} from './goal-context';
import {VoiceControls,ReadReply,speechAction} from './voice';
import {Markdown} from './markdown';
import {Icon} from './ui';
import {OrbVisual} from './orb';
export type PresenceConfig={enabled:boolean;always_on_top:boolean;conversation_context?:{agent_id:string;conversation_id:string;goal_context:GoalApproval|null;work_context?:WorkApproval|null;pending:boolean}|null};
export const presenceAction=<T,>(action:string,payload:Record<string,unknown>={})=>invoke<T>('presence_command',{payload:{action,...payload}});
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});
async function send<T>(command:Command):Promise<T>{const r=await invoke<{status:string;data:T}>('runtime_command',{command});if(r.status!=='persisted')throw new Error('操作未确认保存');return r.data;}
export function PresenceStatus({openSettings,collapsed}:{openSettings:()=>void;collapsed:boolean}){
 const [value,setValue]=useState<PresenceConfig|null>(null),[unavailable,setUnavailable]=useState(false);
 useEffect(()=>{let active=true;void presenceAction<PresenceConfig>('snapshot').then(v=>{if(active)setValue(v);}).catch(()=>{if(active)setUnavailable(true);});const subscription=listen<PresenceConfig>('presence-settings',event=>{if(active){setValue(event.payload);setUnavailable(false);}});return()=>{active=false;void subscription.then(stop=>stop());};},[]);
 return <button type="button" className="presence-status" aria-label={'桌面 Presence · '+(unavailable?'状态不可用':value?(value.enabled?'开启':'关闭'):'读取中')} title="桌面 Presence 设置" onClick={openSettings}><Icon name="presence"/>{!collapsed&&<><span>桌面 Presence</span><small>{unavailable?'不可用':value?(value.enabled?'开启':'关闭'):'…'}</small></>}</button>;
}
export function PresenceSettings(){
 const [value,setValue]=useState<PresenceConfig|null>(null),[error,setError]=useState(''),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{void presenceAction<PresenceConfig>('snapshot').then(setValue).catch(e=>setError(String(e)));},[]);
 async function change(enabled:boolean,top:boolean){setSaving(true);setNotice('');try{setValue(await presenceAction<PresenceConfig>('configure',{enabled,always_on_top:top}));setError('');setNotice('已保存');}catch(e){setError(String(e));}finally{setSaving(false);}}
 return <section className="settings-section"><h2>轻量 Presence</h2><p className="muted">主窗口收起时，通过 Orb 快速交流。开关立即保存。</p>
  <label className="check"><CheckField role="switch" disabled={saving||!value} id="presence-enable" type="checkbox" checked={value?.enabled??false} onChange={e=>void change(e.target.checked,value?.always_on_top??false)}/>开启桌面 Orb（主窗口可见时收起）</label>
  <label className="check"><CheckField role="switch" disabled={saving||!value} id="presence-top" type="checkbox" checked={value?.always_on_top??false} onChange={e=>void change(value?.enabled??false,e.target.checked)}/>轻量窗口保持置顶</label>
  <button type="button" className="secondary" id="presence-reset-position" disabled={saving||!value} onClick={()=>{setSaving(true);setNotice('');void presenceAction<PresenceConfig>('reset_position').then(v=>{setValue(v);setError('');setNotice('位置已重置');}).catch(e=>setError(String(e))).finally(()=>setSaving(false));}}>重置 Orb 位置</button><details><summary>Orb 操作与关闭说明</summary><p>拖动 Orb 可移动；点击打开快速交流。位置保存在本机，重新打开时沿用。</p><p>Presence 与语音、主动帮助分别开启。关闭 Orb 只关闭此入口；后台运行与已授权任务仍保留。不会启用 Live2D、主动权限或开机启动。</p></details>{(saving||notice)&&<p role="status" className="small muted">{saving?"正在保存…":notice}</p>}{error&&<p role="alert" className="error">{error}</p>}
 </section>;
}
export function PresenceApp(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[host,setHost]=useState<Host|null>(null),[config,setConfig]=useState<PresenceConfig|null>(null);
 const [expanded,setExpanded]=useState(false),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [replyOpen,setReplyOpen]=useState(false);
 const [surfaceVisible,setSurfaceVisible]=useState(true),[documentVisible,setDocumentVisible]=useState(!document.hidden);
 const drag=useRef<{x:number;y:number;moved:boolean}|null>(null);
 const generation=useRef(0),agent=snapshot?.selected_agent,cid=snapshot?.chat?.selected_conversation_id??null;
 const current=useRef({agent:agent?.agent_id,cid});current.current={agent:agent?.agent_id,cid};
 async function refresh(){const id=++generation.current;try{
   const [s,h,p,visible]=await Promise.all([send<Snapshot>({...envelope(),type:'GetSnapshot',payload:{}}),invoke<Host>('host_status'),presenceAction<PresenceConfig>('snapshot'),getCurrentWindow().isVisible()]);
   if(id!==generation.current)return;setSnapshot(s);setHost(h);setConfig(p);setSurfaceVisible(visible!==false);
   void invoke('frontend_snapshot',{revision:s.revision});
 }catch(e){setError(String(e));}}
 useEffect(()=>{
   document.documentElement.classList.add('presence-document');document.body.classList.add('presence-body');void invoke('frontend_ready');void refresh();
   const timer=setInterval(()=>void refresh(),3000);let pending:ReturnType<typeof setTimeout>|undefined;
   const update=()=>{if(!pending)pending=setTimeout(()=>{pending=undefined;void refresh();},80);};
   const listeners=['runtime-event','speech-event','speech-settings','presence-settings','presence-context','host-status'].map(e=>listen(e,update));
   return()=>{document.documentElement.classList.remove('presence-document');document.body.classList.remove('presence-body');clearInterval(timer);if(pending)clearTimeout(pending);for(const l of listeners)void l.then(off=>off());};
 },[]);
 useEffect(()=>{
   const visibility=()=>setDocumentVisible(!document.hidden);
   document.addEventListener('visibilitychange',visibility);
   const native=listen<boolean>('presence-visibility',e=>setSurfaceVisible(e.payload));
   return()=>{document.removeEventListener('visibilitychange',visibility);void native.then(off=>off());};
 },[]);
 useEffect(()=>{setText('');setError('');setReplyOpen(false);},[agent?.agent_id,cid]);
 useEffect(()=>{void invoke('frontend_identity',{view:{ui_token:'r3-presence',expanded,selected_agent:snapshot?.selected_agent,chat:snapshot?.chat,runtime_state:snapshot?.runtime_state,rendered_text:document.getElementById('presence-root')?.textContent,alerts:Array.from(document.querySelectorAll('[role="alert"]')).map(e=>e.textContent)}});},[snapshot,expanded]);
 async function act<T>(c:Command){setBusy(true);try{const result=await send<T>(c);await refresh();return result;}finally{setBusy(false);}}
 async function open(context:Record<string,unknown>={}){try{await presenceAction('open_main',{context:{agent_id:agent?.agent_id,conversation_id:cid,...context}});}catch(e){setError(String(e));}}
 async function expand(on:boolean){try{await presenceAction('expand',{expanded:on});if(!on){await speechAction('cancel_owned');}setExpanded(on);}catch(e){setError(String(e));}}
 const context=config?.conversation_context;
 const currentContext=context?.agent_id===agent?.agent_id&&context?.conversation_id===cid?context:null;
 const blocked=!!currentContext?.pending&&!currentContext.goal_context;
 const paused=snapshot?.runtime_state==='Paused',ready=!!snapshot?.provider.chat_allowed&&!!snapshot?.provider.credential_present;
 const disabled=busy||host?.status!=='Ready',active=snapshot?.chat?.runs.find(r=>['Created','Running'].includes(r.state));
 const latest=snapshot?.chat?.messages.filter(m=>m.role==='assistant').slice(-1)[0];
 const notice=snapshot?.proactivity?.notices.find(n=>n.state==='Notified');
 const due=snapshot?.scheduler?.items.find(s=>s.state==='Ready');
 const activity=snapshot?.work_activity?.primary,work=activity?.category==='working',attention=notice||due||activity?.category==='attention';
 const audio=snapshot?.speech?.activity?.agent_id===agent?.agent_id?snapshot?.speech?.activity:null;
 const foreground=host?.status!=='Ready'?'Connecting'
   :audio?.recording?'Listening'
   :audio?.state==='Speaking'?'Speaking'
   :(audio&&['Connecting','Transcribing','Synthesizing'].includes(audio.state))||active?'Thinking'
   :attention?'Attention':work?'Working':paused?'Paused':activity?.category==='waiting'?'Waiting':activity?.category==='paused'?'WorkPaused':'Idle';
 const labels:Record<string,string>={Idle:'空闲',Listening:'正在听',Speaking:'正在说话',Thinking:'正在回应',Working:'正在工作',Waiting:'等待工作条件',WorkPaused:'工作已暂停',Attention:'待你查看',Paused:'后台暂停',Connecting:'正在连接'};
 async function submit(value:string,auto:boolean):Promise<Run|null>{
   setText(value);if(!auto)return null;if(!agent||!cid||blocked||!ready||active)throw new Error('请先打开主窗口确认上下文或等待当前回复结束。');
   setError('');const scope={agent:agent.agent_id,cid};
   try{const run=await act<Run>({...envelope(),type:'SendMessage',agent_id:agent.agent_id,payload:{conversation_id:cid,text:value,work_suggestions:true,...(currentContext?.goal_context?{goal_context:currentContext.goal_context}:{}),...(currentContext?.work_context?{work_context:currentContext.work_context}:{})}});
    if(current.current.agent===scope.agent&&current.current.cid===scope.cid)setText('');return run;
   }catch(e){setError(String(e));throw e;}
 }
 async function pauseWork(){if(!activity||!agent)return;try{if(activity.kind==='task'){const t=await send<{revision:number}>({...envelope(),type:'GetTask',agent_id:agent.agent_id,payload:{task_id:activity.id}});await act({...envelope(),type:'PauseTask',agent_id:agent.agent_id,expected_revision:t.revision,payload:{task_id:activity.id}});}else if(activity.goal_id){const e=await send<{revision:number}>({...envelope(),type:'GetGoalExecution',agent_id:agent.agent_id,payload:{goal_id:activity.goal_id}});await act({...envelope(),type:'PauseGoalExecution',agent_id:agent.agent_id,expected_revision:e.revision,payload:{execution_id:activity.id,acknowledge:true}});}}catch(e){setError(String(e));}}
 async function readSource(kind:string,id:string){try{await speechAction('speak',{agent_id:agent?.agent_id,conversation_id:cid,source:{kind,id}});}catch(e){setError(String(e));}}
 async function handleNotice(type:'DismissProactiveNotice'|'SnoozeProactiveNotice'|'HandleProactiveNotice'){
   if(!notice||!agent)return;try{
    await act(type==='SnoozeProactiveNotice'?{...envelope(),type,agent_id:agent.agent_id,payload:{check_id:notice.check_id,minutes:60}}:{...envelope(),type,agent_id:agent.agent_id,payload:{check_id:notice.check_id}});
    if(type==='HandleProactiveNotice')await open(notice.execution_id?{pane:'tasks',view_goal_id:notice.goal_id}:{pane:'chat',goal_id:notice.goal_id});
   }catch(e){setError(String(e));}
 }
 return <main id="presence-root" className={(expanded?'presence-panel':'presence-orb-shell')+(!surfaceVisible||!documentVisible?' motion-paused':'')}>
  {!expanded?<><button id="presence-orb" aria-label={'打开 '+(agent?.name??'Aevora')+' · '+labels[foreground]} title="点击交流，拖动移动" className={'presence-orb '+foreground.toLowerCase()}
    onPointerDown={e=>{if(e.button!==0||!e.isPrimary)return;drag.current={x:e.clientX,y:e.clientY,moved:false};e.currentTarget.setPointerCapture(e.pointerId);}}
    onPointerMove={e=>{const d=drag.current;if(!d||d.moved||!(e.buttons&1)||Math.hypot(e.clientX-d.x,e.clientY-d.y)<6)return;d.moved=true;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);void presenceAction('drag').catch(e=>setError(String(e)));}}
    onClick={e=>{if(e.detail===0||!drag.current?.moved)void expand(true);}}><OrbVisual/></button><span className="orb-state" role="status">{labels[foreground]}</span>{error&&<span className="error" role="alert" title={error}>移动未完成</span>}</>:<>
   <header className="presence-header"><button className="text-button" title="拖动窗口" aria-label="拖动窗口" onPointerDown={()=>void presenceAction('drag')}><Icon name="grip"/></button><strong>{agent?.name??'Aevora'}</strong><span className="badge">{labels[foreground]}</span><button id="presence-collapse" className="text-button" onClick={()=>void expand(false)}>收起</button><button id="presence-close" className="text-button" aria-label="关闭 Presence" onClick={()=>void presenceAction('configure',{enabled:false,always_on_top:config?.always_on_top??false})}><Icon name="close"/></button></header>
   <div className="presence-content"><p className="small muted">{paused?'后台已暂停 · 前台交流仍可用':'同一个 Agent · 当前会话'}{snapshot?.chat?.conversations.find(c=>c.conversation_id===cid)?.display_title?' · '+snapshot.chat.conversations.find(c=>c.conversation_id===cid)?.display_title:''}</p>
    {!agent||!cid?<button disabled={disabled} onClick={()=>void open({pane:'chat'})}>打开主窗口开始对话</button>:<>
     {blocked&&<p className="notice">目标上下文待确认。<button className="text-button" onClick={()=>void open({pane:'chat'})}>打开原会话确认</button></p>}
     {currentContext?.work_context&&<p className="small">使用主窗口已确认的当前工作状态与反馈；资料改变后需重新确认。</p>}{currentContext?.goal_context&&<p className="small">使用本次已确认的目标资料；变化后需重新确认。</p>}
     {active&&<p className="small" role="status">{active.conversation_id===cid?'正在生成回复…':'此 Agent 正在另一会话回复。'}<button className="text-button" onClick={()=>void open({pane:'chat',conversation_id:active.conversation_id})}>查看原会话</button>{active.conversation_id===cid&&<button className="text-button" onClick={()=>void act({...envelope(),type:'CancelRun',agent_id:agent.agent_id,payload:{run_id:active.run_id}}).catch(e=>setError(String(e)))}>停止回复</button>}</p>}
     <VoiceControls agentId={agent.agent_id} cid={cid} chat={snapshot!.chat!} disabled={disabled} canSend={ready&&!blocked} execute={act as Execute} onText={submit}/>
     <form onSubmit={e=>{e.preventDefault();void submit(text,true).catch(()=>{});}}><label className="sr-only" htmlFor="presence-input">快速消息</label><textarea id="presence-input" rows={2} maxLength={snapshot?.provider.chat_input_unlimited?undefined:12000} value={text} onChange={e=>setText(e.target.value)} placeholder="说出需求，或写一句话…" disabled={disabled}/><button id="presence-send" disabled={disabled||!text.trim()||!ready||blocked||!!active}>发送</button></form>
     {latest&&<section className="presence-reply"><button type="button" className="text-button" aria-expanded={replyOpen} onClick={()=>setReplyOpen(!replyOpen)}>{replyOpen?'收起最近回复':'查看最近回复'}</button><div hidden={!replyOpen}><Markdown text={latest.content}/>{latest.finality==='final'&&<ReadReply agentId={agent.agent_id} cid={cid} id={latest.message_id} content={latest.content} disabled={disabled}/>}</div></section>}
     <label className="small">续办已有目标<Select id="presence-goal" value="" onChange={e=>{if(e.target.value)void open({pane:'chat',goal_id:e.target.value});}}><option value="">选择后打开主窗口确认…</option>{snapshot?.goals?.filter(g=>g.state==='Active').map(g=><option key={g.goal_id} value={g.goal_id}>{g.title}</option>)}</Select></label>
     {snapshot?.chat?.work?.some(w=>w.state==='Pending'&&['file_task','agent_task'].includes(w.suggestion?.kind??'')||w.state==='None'&&w.can_prepare_file)&&<button id="presence-continue-work" className="secondary" onClick={()=>void open({pane:'chat',work_run_id:snapshot.chat!.work!.find(w=>w.state==='Pending'&&['file_task','agent_task'].includes(w.suggestion?.kind??'')||w.state==='None'&&w.can_prepare_file)!.run_id})}>沿这条需求选择文件…</button>}
    </>}
    {notice?<section className="presence-notice"><strong>{notice.execution_id?"工作状态":"主动跟进"}</strong><p>{notice.message}</p><button className="text-button" onClick={()=>void readSource('notice',notice.check_id)}>听一下</button><button disabled={disabled} onClick={()=>void handleNotice('HandleProactiveNotice')}>查看并续办…</button><button className="text-button" disabled={disabled} onClick={()=>void handleNotice('SnoozeProactiveNotice')}>稍后</button><button className="text-button" disabled={disabled} onClick={()=>void handleNotice('DismissProactiveNotice')}>忽略</button></section>:due?<section className="presence-notice"><strong>约定到期：{due.title}</strong><button className="text-button" onClick={()=>void readSource('schedule',due.schedule_id)}>听一下</button><button onClick={()=>void open({pane:'tasks',schedule_id:due.schedule_id})}>查看约定…</button></section>:null}
    {activity&&<section className="presence-task" aria-label="当前实际工作"><strong>{activity.title}</strong><p role="status">{activity.label}</p>{activity.kind==='task'&&<button className="text-button" onClick={()=>void readSource('task',activity.id)}>听进展</button>}<button className="text-button" onClick={()=>void open({pane:'tasks',...(activity.conversation_id?{conversation_id:activity.conversation_id}:{}),...(activity.kind==='task'?{task_id:activity.id}:{view_goal_id:activity.goal_id})})}>查看实际工作…</button>{['working','waiting'].includes(activity.category)&&<button className="text-button" disabled={disabled} onClick={()=>void pauseWork()}>暂停本项</button>}</section>}
    {error&&<p role="alert" className="error">{error}</p>}
   </div><footer className="presence-footer"><button id="presence-pause" className="secondary" disabled={disabled||!snapshot} onClick={()=>void act({...envelope(),type:paused?'Resume':'Pause',expected_revision:snapshot!.revision,payload:{}}).catch(e=>setError(String(e)))}>{paused?'恢复后台':'暂停后台'}</button><button id="presence-main" onClick={()=>void open({pane:'chat'})}>打开 Aevora</button></footer>
  </>}
 </main>;
}
