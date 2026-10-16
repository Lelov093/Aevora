import {CheckField,DateField,NumberField,Select} from './controls';
import {Icon,Modal,PageTabs} from './ui';
import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import type {ChatSnapshot,Execute,Run} from './chat';
type Purpose={model:string;enabled:boolean;credential_present:boolean;max_calls:number;calls_started:number;units_submitted:number;grant_id:string;api_key?:string;consent?:boolean;new_budget?:boolean};
export type SpeechConfig={revision:number;region:string;workspace_id:string;endpoint:string|null;store_error?:string|null;testing_unlimited?:boolean;
 asr:Purpose&{max_seconds:number};tts:Purpose&{max_characters:number;voice:string;rate:number;free_until:string;availability_error?:string|null;free_tier_only_confirmed?:boolean}};
export type Activity={operation_id:string;owner:string;agent_id:string;conversation_id:string;kind:'asr'|'tts';state:string;text:string;final_text?:string;error?:string|null;recording?:boolean;playback_active?:boolean;limit_reached?:boolean;source_id?:string;seconds?:number;first_audio_ms?:number};
export type SpeechView={config:SpeechConfig;activity:Activity|null};
export const speechAction=<T,>(action:string,payload:Record<string,unknown>={})=>invoke<T>('speech_command',{payload:{action,...payload}});
const terminal=(a?:Activity|null)=>!a||['Completed','Failed','Cancelled'].includes(a.state);
const names:Record<string,string>={Connecting:'正在连接语音',Listening:'正在听 · 松开结束',Transcribing:'正在完成转写',Synthesizing:'正在合成声音',Speaking:'正在说话',Completed:'本轮语音完成',Failed:'语音未完成',Cancelled:'本轮语音已停止'};
const envelope=()=>({protocol_version:1 as const,command_id:crypto.randomUUID()});

export function VoiceControls({agentId,cid,chat,disabled,canSend,onText,execute}:{agentId:string;cid:string|null;chat:ChatSnapshot;disabled:boolean;canSend:boolean;
 onText:(text:string,send:boolean)=>Promise<Run|null>;execute:Execute}){
 const [helpOpen,setHelpOpen]=useState(false);
 const owner=getCurrentWindow().label,scope=agentId+':'+cid;
 const [view,setView]=useState<SpeechView|null>(null),[mode,setMode]=useState(false),[error,setError]=useState(''),[starting,setStarting]=useState(false);
 const [autoRun,setAutoRun]=useState<string|null>(null);
 const held=useRef(false),operation=useRef<string|null>(null),processed=useRef(new Set<string>());
 const scopeRef=useRef(scope);scopeRef.current=scope;
 const latest=useRef({mode,canSend,onText,disabled});latest.current={mode,canSend,onText,disabled};
 const active=chat.runs.find(r=>['Created','Running'].includes(r.state));
 useEffect(()=>{
   let mounted=true;setMode(false);operation.current=null;setView(null);
   const refresh=()=>void speechAction<SpeechView>('snapshot').then(v=>{if(mounted)setView(v);}).catch(e=>{if(mounted)setError(String(e));});
   refresh();const event=listen('speech-event',refresh),settings=listen('speech-settings',()=>{setMode(false);setAutoRun(null);refresh();});
   const hidden=listen<string>('speech-surface-hidden',e=>{if(e.payload===owner){held.current=false;setMode(false);setAutoRun(null);}});
   const blur=()=>{held.current=false;if(operation.current)void speechAction('cancel_owned');};window.addEventListener('blur',blur);
   const release=()=>{held.current=false;if(operation.current)void speechAction('end_capture',{operation_id:operation.current}).catch(()=>{});};window.addEventListener('pointerup',release);window.addEventListener('keyup',release);
   return()=>{mounted=false;held.current=false;setAutoRun(null);void speechAction('cancel_owned');window.removeEventListener('blur',blur);window.removeEventListener('pointerup',release);window.removeEventListener('keyup',release);void event.then(f=>f());void settings.then(f=>f());void hidden.then(f=>f());};
 },[scope]);
 const needsDeviceRefresh=!!view?.activity&&(!terminal(view.activity)||!!view.activity.recording||!!view.activity.playback_active);
 useEffect(()=>{
   if(!needsDeviceRefresh)return;let mounted=true;
   const timer=setInterval(()=>void speechAction<SpeechView>('snapshot').then(v=>{if(mounted)setView(v);}).catch(()=>{}),200);
   return()=>{mounted=false;clearInterval(timer);};
 },[scope,needsDeviceRefresh]);
 useEffect(()=>{
   const a=view?.activity;
   if(!a||a.operation_id!==operation.current||a.agent_id!==agentId||a.conversation_id!==cid||a.owner!==owner||a.state!=='Completed'||!a.final_text||processed.current.has(a.operation_id))return;
   processed.current.add(a.operation_id);operation.current=null;held.current=false;
   const capturedScope=scopeRef.current,send=latest.current.mode&&latest.current.canSend&&!latest.current.disabled;
   void latest.current.onText(a.final_text,send).then(r=>{if(scopeRef.current===capturedScope&&r&&send&&latest.current.mode)setAutoRun(r.run_id);}).catch(e=>setError(String(e)));
 },[view,agentId,cid,owner]);
 useEffect(()=>{
   const id=autoRun;if(!id||!mode||!cid)return;const run=chat.runs.find(r=>r.run_id===id);
   if(!run||['Created','Running'].includes(run.state))return;setAutoRun(null);
   if(run.state!=='Completed'||run.context.context_stale)return;
   const m=chat.messages.find(m=>m.run_id===id&&m.role==='assistant'&&m.finality==='final');if(!m)return;
   void speechAction('speak',{agent_id:agentId,conversation_id:cid,source:{kind:'message',id:m.message_id}}).catch(e=>setError(String(e)));
 },[chat,mode,cid,agentId,autoRun]);
 async function start(){
   if(starting||held.current||!cid||disabled||!view?.config.asr.enabled||active&&active.conversation_id!==cid)return;
   held.current=true;setStarting(true);setError('');setAutoRun(null);const currentScope=scope;
   try{
     await speechAction('stop');if(active)await execute({...envelope(),type:'CancelRun',agent_id:agentId,payload:{run_id:active.run_id}});
     if(scopeRef.current!==currentScope||!held.current)return;
     const a=await speechAction<Activity>('begin_capture',{agent_id:agentId,conversation_id:cid});operation.current=a.operation_id;
     if(!held.current||scopeRef.current!==currentScope)await speechAction('end_capture',{operation_id:a.operation_id});
     const next=await speechAction<SpeechView>('snapshot');if(scopeRef.current===currentScope)setView(next);
   }catch(e){held.current=false;operation.current=null;setError(String(e));}finally{setStarting(false);}
 }
 function end(){held.current=false;if(operation.current)void speechAction('end_capture',{operation_id:operation.current}).catch(e=>setError(String(e)));}
 async function stop(){held.current=false;setAutoRun(null);operation.current=null;setMode(false);try{setView(await speechAction<SpeechView>('stop'));}catch(e){setError(String(e));}}
 const [seconds,setSeconds]=useState(0);
 useEffect(()=>{if(!view?.activity?.recording){setSeconds(0);return;}const began=Date.now();const timer=setInterval(()=>setSeconds((Date.now()-began)/1000),100);return()=>clearInterval(timer);},[view?.activity?.operation_id,view?.activity?.recording]);
 const a=view?.activity,own=a?.owner===owner&&a.agent_id===agentId&&a.conversation_id===cid;
 return <div className="voice-controls" aria-label="语音交互" onKeyDown={e=>{if(e.key==='Enter'&&e.target instanceof HTMLInputElement&&e.target.type==='checkbox')e.preventDefault();}}><div className="voice-buttons">
  <button id="voice-hold" type="button" className={a?.recording&&own?'recording':'secondary'} disabled={disabled||!cid||!view?.config.asr.enabled||!!active&&active.conversation_id!==cid}
   onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);void start();}} onPointerUp={end} onPointerCancel={()=>void stop()}
   onBlur={()=>{if(held.current){held.current=false;void speechAction('cancel_owned');}}}
   onKeyDown={e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();void start();}}} onKeyUp={e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();end();}}}><Icon name="mic"/>{a?.recording&&own?'正在听 · 松开结束':starting?'正在准备…':'按住说话'}</button>
  {!terminal(a)&&<button id="voice-stop" type="button" className="text-button" onClick={()=>void stop()}>停止{a?.kind==='tts'?'说话':'语音'}</button>}
  <label className="voice-mode"><CheckField role="switch" id="voice-session" type="checkbox" checked={mode} disabled={!mode&&(disabled||!cid||!view?.config.asr.enabled||!view?.config.tts.enabled||!!view?.config.tts.availability_error||!canSend)} onChange={e=>{setMode(e.target.checked);setAutoRun(null);if(!e.target.checked&&own&&a?.kind==='tts')void speechAction('cancel_owned');}}/>语音会话</label>
  <button type="button" className="text-button" aria-expanded={helpOpen} onClick={()=>setHelpOpen(!helpOpen)}>语音说明</button></div><div hidden={!helpOpen}>{view?.config.asr.enabled&&<p className="small muted">{mode?canSend&&!disabled?'松开发送并朗读回复 · 按住时才开启麦克风。':'当前只转写，请在主窗口确认上下文及发送条件。':'转写可修改后发送。语音会话：松开发送并朗读回复。'}</p>}
  {!view?.config.asr.enabled&&<p className="small muted">在设置中允许语音识别后可用。</p>}
  {view?.config.testing_unlimited&&<p className="small muted">本次语音测试不设本地总预算；服务免费额度与到期规则仍有效。</p>}
  </div>{mode&&<p className="small voice-mode-status" role="status">{canSend&&!disabled?"语音会话：松开发送并朗读回复":"当前只转写；请先确认发送条件"}</p>}
  {view?.config.tts.availability_error&&<p className="small notice">{view.config.tts.availability_error}</p>}
  {own&&a&&<div id="voice-status" data-state={a.state} role="status"><span>{names[a.state]??a.state}{a.recording?' · '+seconds.toFixed(1)+'秒':a.seconds!==undefined?' · '+a.seconds.toFixed(1)+'秒':''}</span>{a.kind==='asr'&&!terminal(a)&&a.text&&<p className="voice-transcript">{a.text}</p>}{a.kind==='tts'&&!terminal(a)&&<details><summary>本次朗读范围</summary><p>{a.text}</p></details>}</div>}
  {own&&a?.limit_reached&&<p className="small notice">已到30秒上限，已停止采音。</p>}
  {(error||own&&a?.error)&&<p role="alert" className="error">{error||a?.error}</p>}
 </div>;
}
export function ReadReply({agentId,cid,id,disabled,content}:{agentId:string;cid:string|null;id:string;disabled:boolean;content:string}){
 const [error,setError]=useState(''),[choosing,setChoosing]=useState(false);const paragraphs=content.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
 async function read(index?:number){setError('');try{await speechAction('speak',{agent_id:agentId,conversation_id:cid,source:{kind:'message',id,...(index===undefined?{}:{paragraph_index:index})}});}catch(e){setError(String(e));}}
 return <span className="reply-voice">{content.length<=1000?<button type="button" className="text-button" data-read-reply={id} disabled={disabled||!cid} onClick={()=>void read()}>听回复</button>:<><button type="button" className="text-button" onClick={()=>setChoosing(true)}>选择段落朗读…</button><Modal open={choosing} close={()=>setChoosing(false)} title="选择本次朗读的段落" id={"read-reply-"+id}>{paragraphs.map((p,i)=><div key={i}><p>{p}</p><button type="button" className="text-button" disabled={disabled||!cid||p.length>1000} onClick={()=>void read(i)}>朗读第{i+1}段</button></div>)}</Modal></>}{error&&<span className="error" role="alert">{error}</span>}</span>;
}

export function SpeechSettings(){
 const [category,setCategory]=useState<"asr"|"tts">("asr");
 const [view,setView]=useState<SpeechView|null>(null),[draft,setDraft]=useState<SpeechConfig|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState(false),[busy,setBusy]=useState(false);
 async function refresh(){const v=await speechAction<SpeechView>('snapshot');setView(v);setDraft({...v.config,asr:{...v.config.asr,api_key:'',consent:false,new_budget:false},tts:{...v.config.tts,api_key:'',consent:false,new_budget:false,free_tier_only_confirmed:false}});}
 useEffect(()=>{void refresh().catch(e=>setError(String(e)));},[]);
 function update(p:'asr'|'tts',key:string,value:unknown){setSaved(false);setDraft(d=>d?{...d,[p]:{...d[p],[key]:value}}:d);}
 function selectTts(model:string){setSaved(false);setDraft(d=>d?{...d,tts:{...d.tts,model,voice:model==='qwen-audio-3.1-tts-flash'?'longanhuan_v3.1':'longanhuan_v3.6',free_until:'',consent:false,free_tier_only_confirmed:false}}:d);}
 async function save(e:React.FormEvent){e.preventDefault();if(!draft)return;setBusy(true);setError('');try{await speechAction('configure',{config:draft});await refresh();setSaved(true);}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function importEnv(){setBusy(true);setError('');try{await speechAction('import_env');await refresh();setSaved(false);}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <section className="settings-section"><h2>语音输入与声音</h2><p className="muted">使用当前 Agent 和对话。音频识别与文字朗读分别授权；文件、目标与执行沿用原确认流程。</p>
  <PageTabs label="语音设置分类" value={category} change={setCategory} items={[["asr","语音识别"],["tts","回复朗读"]]}/>
  <button id="speech-import" type="button" className="secondary" disabled={busy} onClick={()=>void importEnv()}>从本机 .env 载入语音配置（保持关闭）</button>
  {draft&&<form id="speech-settings" onSubmit={e=>void save(e)}><label>地域<input readOnly value="北京 · cn-beijing"/></label><label>业务空间 ID<input id="speech-workspace" value={draft.workspace_id} onChange={e=>setDraft({...draft,workspace_id:e.target.value})}/></label>
   {(['asr','tts'] as const).map(p=><fieldset key={p} hidden={category!==p}><legend>{p==='asr'?'语音识别 ASR':'朗读 TTS'}</legend>{p==='tts'?<label>流式朗读模型<Select id="speech-tts-model" value={draft.tts.model} onChange={e=>selectTts(e.target.value)}><option value="qwen-audio-3.1-tts-flash">qwen-audio-3.1-tts-flash</option><option value="qwen-audio-3.0-tts-flash">qwen-audio-3.0-tts-flash</option></Select></label>:<p>{draft[p].model}</p>}
    <label>API Key<input id={'speech-'+p+'-key'} type="password" autoComplete="off" value={draft[p].api_key??''} placeholder={draft[p].credential_present?'••••••••（留空保留，换业务空间须重新填写）':'填写百炼 Key'} onChange={e=>update(p,'api_key',e.target.value)}/></label>
    {p==='tts'&&<><label>系统音色<input readOnly value={draft.tts.voice}/></label><label>语速<NumberField type="number" min={0.5} max={2} step={0.1} value={draft.tts.rate} onChange={e=>update('tts','rate',Number(e.target.value))}/></label><label>免费额度截止日（北京）<DateField id="speech-tts-until" type="date" value={draft.tts.free_until} onChange={e=>update('tts','free_until',e.target.value)}/></label><p className="small muted">截止日零点保守停用，不会自动改为付费。</p><label className="check"><CheckField id="speech-free-only" type="checkbox" checked={draft.tts.free_tier_only_confirmed??false} onChange={e=>update('tts','free_tier_only_confirmed',e.target.checked)}/>已在百炼开启此模型的免费额度用完即停</label></>}
    {view?.config.testing_unlimited?<p className="notice">本次语音测试不限制本地请求次数、总音频秒数或总字符数；仍记录用量并遵守免费额度与到期规则。</p>:<div className="budget-fields"><label>最多请求<NumberField id={'speech-'+p+'-calls'} type="number" min={1} max={1000} value={draft[p].max_calls} onChange={e=>update(p,'max_calls',Number(e.target.value))}/></label><label>{p==='asr'?'最多音频秒数':'最多提交字符'}<NumberField id={'speech-'+p+'-units'} type="number" min={1} max={1000000} value={p==='asr'?draft.asr.max_seconds:draft.tts.max_characters} onChange={e=>update(p,p==='asr'?'max_seconds':'max_characters',Number(e.target.value))}/></label></div>}
    <p className="small muted">{view?.config.testing_unlimited?'累计记录':'当前预算'}已开始 {view?.config[p].calls_started??0} 次，本地已提交 {Math.ceil(view?.config[p].units_submitted??0)} {p==='asr'?'秒':'字符'}。失败/取消已开始请求也记录；服务计费另记。</p>
    {p==='tts'&&draft.tts.model==='qwen-audio-3.1-tts-flash'&&<p className="small muted">3.1 Flash 按服务返回的输入／输出 Token 计费；本地提交字符数不是免费额度余额。未返回用量的请求仍记为未知。</p>}
    <label className="check"><CheckField role="switch" id={'speech-'+p+'-enable'} type="checkbox" checked={draft[p].enabled} onChange={e=>update(p,'enabled',e.target.checked)}/>{p==='asr'?'开启语音识别':'开启朗读'}</label>
    <label className="check"><CheckField id={'speech-'+p+'-consent'} type="checkbox" checked={draft[p].consent??false} onChange={e=>update(p,'consent',e.target.checked)}/>{p==='asr'?'允许按住期间音频流式发送至上述百炼业务空间；取消只能停止后续发送，不上传记忆、历史或文件。':'允许手动选择的可见回复/通知文字，以及显式语音会话的新成功回复发送至上述百炼业务空间合成声音。'}确认目的地和本预算。</label>
    {!view?.config.testing_unlimited&&<label className="check"><CheckField id={'speech-'+p+'-new-budget'} type="checkbox" checked={draft[p].new_budget??false} onChange={e=>update(p,'new_budget',e.target.checked)}/>明确开始新预算（保留旧记录）</label>}
   </fieldset>)}<button id="speech-save" disabled={busy}>保存语音设置</button>{saved&&<span role="status" className="success">已保存；采音仍由按住操作开始</span>}
  </form>}{(error||view?.config.store_error)&&<p className="error" role="alert">{error||view?.config.store_error}</p>}
 </section>;
}
