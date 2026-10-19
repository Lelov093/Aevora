import {ConversationHistory} from './conversation-organization';
import {ActionMenu} from './action-menu';
import {PresenceStatus} from './presence';
import type {Task} from './tasks';
import {taskNames} from './work-state';
import {CheckField,Select} from './controls';
import { useEffect, useState, type ReactNode } from "react";
import type { ChatSnapshot, Conversation, Execute } from "./chat";
import { Icon } from "./ui";
import {Modal} from "./ui";
import {eraseConversationDraft} from "./chat";
export function ConversationSidebar({agentId,chat,sequence,disabled,pane,newConversation,choose,read,execute,openMemory,openTasks,openChat,collapsed,agentControl,toggleNavigation,openPresence,openTask,selectedTaskId}:{
  agentId:string;chat:ChatSnapshot;sequence:number;disabled:boolean;pane:string;newConversation:(groupId?:string)=>Promise<void>;
  choose:(id:string)=>Promise<void>;read:Execute;execute:Execute;openMemory:()=>void;openTasks:()=>void;openChat:()=>void;collapsed:boolean;agentControl:ReactNode;toggleNavigation:()=>void;openPresence:()=>void;openTask:(cid:string,taskId:string)=>Promise<void>;selectedTaskId:string|null}){
  const [query,setQuery]=useState("");const [results,setResults]=useState<Conversation[]>([]);
  const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  const [deleting,setDeleting]=useState<string|null>(null),[deleteBusy,setDeleteBusy]=useState(false);
  const [derived,setDerived]=useState<{memory_id:string;revision:number;content:string;multiple_sources:boolean}[]>([]);
  const [scope,setScope]=useState<"conversation_only"|"selected_memories">("conversation_only"),[chosen,setChosen]=useState<string[]>([]);
  async function deletion(cid:string){setDeleting(cid);setScope("conversation_only");setChosen([]);setError("");setDeleteBusy(true);
    try{setDerived(await read<typeof derived>({protocol_version:1,command_id:crypto.randomUUID(),type:"ListConversationMemories",agent_id:agentId,payload:{conversation_id:cid}}));}catch(e){setError(String(e));}finally{setDeleteBusy(false);}}
  useEffect(()=>{
    let active=true;setError("");setLoading(!!query.trim());
    const timer=setTimeout(()=>{if(query.trim())void read<Conversation[]>({protocol_version:1,command_id:crypto.randomUUID(),type:"ListConversations",agent_id:agentId,payload:{query}})
      .then(value=>{if(active)setResults(value);}).catch(()=>{if(active)setError("搜索未完成，请检查连接后再试。");}).finally(()=>{if(active)setLoading(false);});},180);
    return()=>{active=false;clearTimeout(timer);};
  },[query,agentId,sequence]);
  const [tasks,setTasks]=useState<Task[]>([]),[taskError,setTaskError]=useState('');
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  useEffect(()=>{let active=true;void read<Task[]>({protocol_version:1,command_id:crypto.randomUUID(),type:'ListTasks',agent_id:agentId,payload:{}}).then(value=>{if(active){setTasks(value);setTaskError('');}}).catch(()=>{if(active)setTaskError('关联工作暂不可用，请到所有事项重试。');});return()=>{active=false;};},[agentId,sequence]);
  function renderConversation(conversation:Conversation,actions:ReactNode,location:string){
          const cid=conversation.conversation_id;
          const selected=pane==='chat'&&cid===chat.selected_conversation_id;
          const related=tasks.filter(task=>task.work_source?.conversation_id===cid||task.schedule?.commitment?.source_conversation_id===cid);
          const open=expanded[cid]??selected;
          return <div key={location+cid} className="conversation-group">
            <div className={'conversation-row '+(selected?'selected':'')}>
              <button data-conversation={cid} aria-current={selected?'page':undefined} className="conversation-link" disabled={disabled} onClick={()=>void choose(cid).catch(()=>{})} title={(conversation.display_title||conversation.title)+' · '+new Date(conversation.updated_at).toLocaleDateString('zh-CN')}><Icon name="chat"/><span className="conversation-title">{conversation.display_title||conversation.title}</span></button>
              {Boolean(related.length)&&<button className="icon-button conversation-expander" aria-label={(open?'收起':'展开')+'关联任务：'+(conversation.display_title||conversation.title)} aria-expanded={open} onClick={()=>setExpanded(value=>({...value,[cid]:!open}))}><Icon name="chevron"/></button>}
              <ActionMenu label={'会话操作：'+(conversation.display_title||conversation.title)} className="conversation-options">{actions}<button id={selected&&(location!=='pinned'||!conversation.group_id)?'delete-conversation':undefined} className="text-button" disabled={disabled} onClick={()=>void deletion(cid)}>删除此对话…</button></ActionMenu>
            </div>
            {Boolean(related.length)&&open&&<div className="conversation-tasks" aria-label="关联任务">{related.map(task=><button key={task.task_id} data-sidebar-task={task.task_id} className={'conversation-task '+(selected&&selectedTaskId===task.task_id?'selected':'')} disabled={disabled} onClick={()=>void openTask(cid,task.task_id)}><span>{task.title}</span><small>{taskNames[task.state]??task.state}</small></button>)}</div>}
            {query.trim()&&<p className="search-match">{conversation.group_name&&<span className="search-group-name">{conversation.group_name}</span>}{conversation.match_preview}</p>}
          </div>;

  }
  return <aside className={"sidebar "+(collapsed?"collapsed":"")} aria-label="主导航">
    <div className="sidebar-brand"><span hidden={collapsed}>Aevora</span><button id="toggle-navigation" className="icon-button" aria-label={collapsed?'展开导航':'收起导航'} aria-expanded={!collapsed} onClick={toggleNavigation}><Icon name="panel-left"/></button></div>
    <div hidden={collapsed} className="sidebar-search"><label className="search-box"><Icon name="search"/><input id="conversation-search" aria-label="搜索当前 Agent 的对话" placeholder="搜索对话" maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button className="icon-button" aria-label="清除搜索" onClick={()=>setQuery('')}><Icon name="close"/></button>}</label></div>
    <nav className="primary-nav" aria-label="产品页面">
      <button id="new-conversation" title="新对话" aria-label="新对话" className="nav-button" disabled={disabled} onClick={()=>void newConversation()}><Icon name="plus"/><span>新对话</span></button>
      <button id="open-memory" title="记忆" aria-label="记忆" className={'nav-button '+(pane==='memory'?'selected':'')} onClick={openMemory}><Icon name="memory"/><span>记忆</span></button>
      <button id="open-tasks" title="所有事项" aria-label="所有事项" className={'nav-button '+(pane==='tasks'?'selected':'')} onClick={openTasks}><Icon name="layers"/><span>所有事项</span></button>
    </nav>
    <div className="sidebar-history" hidden={collapsed}>
      {error?<p role="alert" className="error">{error}</p>:<ConversationHistory agentId={agentId} chat={chat} query={query} results={results} loading={loading} disabled={disabled} execute={execute} newConversation={newConversation} renderConversation={renderConversation}/>}
      {taskError&&<p className="sidebar-hint" role="status">{taskError}</p>}
    </div>
    <div className="sidebar-bottom">
      <PresenceStatus collapsed={collapsed} openSettings={openPresence}/>

      <div className="sidebar-agent-card">{agentControl}</div>
    </div>
    <Modal open={!!deleting} close={()=>{if(!deleteBusy)setDeleting(null);}} title="删除会话与来源范围" id="conversation-delete-dialog">
      <p className="notice" id="commitment-delete-policy">你独立确认的长期目标、时间约定及已授权 Task 不随会话删除；来源原文会清除且不可再回看。请到任务中分别取消或删除不再需要的目标、约定或 Task。</p>
      <p>清除当前会话消息正文并取消依赖该来源的记忆处理。操作无法撤回，其他Agent不受影响。</p>
      <label>删除范围<Select id="conversation-delete-scope" value={scope} disabled={deleteBusy} onChange={e=>setScope(e.target.value as typeof scope)}><option value="conversation_only">仅删除会话，保留记忆并标记来源已删除</option><option value="selected_memories">删除会话及选中的派生记忆</option></Select></label>
      {deleteBusy?<p role="status">正在读取或清除本机数据…</p>:<>{derived.length?<><h3>来自此会话的记忆（{derived.length}）</h3>{derived.map(m=><label className="check" key={m.memory_id}><CheckField type="checkbox" disabled={scope==="conversation_only"} checked={scope==="selected_memories"&&chosen.includes(m.memory_id)} onChange={e=>setChosen(v=>e.target.checked?[...v,m.memory_id]:v.filter(id=>id!==m.memory_id))}/><span>{m.content}{m.multiple_sources&&<small> · 有多个来源，删除将清除整条记忆</small>}</span></label>)}</>:<p>没有派生记忆。</p>}</>}
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="actions"><button id="confirm-conversation-delete" className="danger" disabled={disabled||deleteBusy||!!error} onClick={()=>{if(!deleting)return;setDeleteBusy(true);void execute({protocol_version:1,command_id:crypto.randomUUID(),type:"DeleteConversation",agent_id:agentId,payload:{conversation_id:deleting,scope,memory_ids:scope==="selected_memories"?chosen:[],memory_revisions:Object.fromEntries(derived.filter(m=>chosen.includes(m.memory_id)).map(m=>[m.memory_id,m.revision]))}}).then(()=>{eraseConversationDraft(agentId,deleting);setDeleting(null);setDerived([]);}).catch(e=>setError(String(e))).finally(()=>setDeleteBusy(false));}}>确认删除{scope==="selected_memories"?"会话及 "+chosen.length+" 条记忆":"会话"}</button><button className="secondary" disabled={deleteBusy} onClick={()=>setDeleting(null)}>取消</button></div>
    </Modal>
  </aside>;
}
