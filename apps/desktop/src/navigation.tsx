import {CheckField,Select} from './controls';
import { useEffect, useState } from "react";
import type { ChatSnapshot, Conversation, Execute } from "./chat";
import { Icon } from "./ui";
import {Modal} from "./ui";
import {eraseConversationDraft} from "./chat";
export function ConversationSidebar({agentId,chat,sequence,disabled,pane,newConversation,choose,read,execute,openMemory,openTasks,openSettings,openChat,collapsed}:{
  agentId:string;chat:ChatSnapshot;sequence:number;disabled:boolean;pane:string;newConversation:()=>Promise<void>;
  choose:(id:string)=>Promise<void>;read:Execute;execute:Execute;openMemory:()=>void;openTasks:()=>void;openSettings:()=>void;openChat:()=>void;collapsed:boolean}){
  const [query,setQuery]=useState("");const [results,setResults]=useState<Conversation[]>([]);
  const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  const [deleting,setDeleting]=useState<string|null>(null),[deleteBusy,setDeleteBusy]=useState(false);
  const [derived,setDerived]=useState<{memory_id:string;revision:number;content:string;multiple_sources:boolean}[]>([]);
  const [scope,setScope]=useState<"conversation_only"|"selected_memories">("conversation_only"),[chosen,setChosen]=useState<string[]>([]);
  async function deletion(){if(!chat.selected_conversation_id)return;setDeleting(chat.selected_conversation_id);setScope("conversation_only");setChosen([]);setError("");setDeleteBusy(true);
    try{setDerived(await read<typeof derived>({protocol_version:1,command_id:crypto.randomUUID(),type:"ListConversationMemories",agent_id:agentId,payload:{conversation_id:chat.selected_conversation_id}}));}catch(e){setError(String(e));}finally{setDeleteBusy(false);}}
  useEffect(()=>{
    let active=true;setError("");setLoading(!!query.trim());
    const timer=setTimeout(()=>{if(query.trim())void read<Conversation[]>({protocol_version:1,command_id:crypto.randomUUID(),type:"ListConversations",agent_id:agentId,payload:{query}})
      .then(value=>{if(active)setResults(value);}).catch(()=>{if(active)setError("搜索未完成，请检查连接后再试。");}).finally(()=>{if(active)setLoading(false);});},180);
    return()=>{active=false;clearTimeout(timer);};
  },[query,agentId,sequence]);
  const items=query.trim()?results:chat.conversations;
  return <aside className={"sidebar "+(collapsed?"collapsed":"")} aria-label="主导航">
    <nav className="primary-nav" aria-label="产品页面">
      <button id="open-chat" title="对话" aria-label="对话" className={"nav-button "+(pane==='chat'?'selected':'')} onClick={openChat}><Icon name="chat"/><span>对话</span></button>

      <button id="open-memory" title="记忆" aria-label="记忆" className={"nav-button "+(pane==='memory'?'selected':'')} onClick={openMemory}><Icon name="memory"/><span>记忆</span></button>
    </nav>
    <div className="sidebar-history" hidden={pane!=='chat'||collapsed}>
    <button id="new-conversation" className="new-chat" disabled={disabled} onClick={()=>void newConversation()}><Icon name="plus"/>新对话</button>
    <label className="search-box"><Icon name="search"/><input id="conversation-search" aria-label="搜索当前 Agent 的对话" placeholder="搜索对话" maxLength={200} value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="清除搜索" onClick={()=>setQuery("")}><Icon name="close"/></button>}</label>
    <div className="nav-heading"><span>{query.trim()?"搜索结果":"最近对话"}</span><small>{loading?"搜索中…":items.length}</small></div>
    <div className="conversation-list" aria-busy={loading}>
      {error?<p role="alert" className="error">{error}</p>:loading?<p className="sidebar-hint" role="status">正在查找本机历史…</p>:items.length?items.map(c=><button key={c.conversation_id} data-conversation={c.conversation_id} aria-current={pane==="chat"&&c.conversation_id===chat.selected_conversation_id?"page":undefined}
        className={"conversation-link "+(pane==="chat"&&c.conversation_id===chat.selected_conversation_id?"selected":"")} disabled={disabled} onClick={()=>void choose(c.conversation_id).catch(()=>{})} title={c.display_title||c.title}>
        <span className="conversation-title">{c.display_title||c.title}</span>
        <small>{query.trim()&&c.match_preview?c.match_preview:new Date(c.updated_at).toLocaleDateString("zh-CN",{month:"short",day:"numeric"})}</small>
      </button>):<p className="sidebar-hint">{query.trim()?"没有匹配的对话":"从一个新对话开始吧"}</p>}
    </div>
    </div>
    <div className="sidebar-bottom"><button id="open-tasks" title="所有事项" aria-label="所有事项" className={"nav-button "+(pane==='tasks'?'selected':'')} onClick={openTasks}><Icon name="work"/><span>所有事项</span></button>{pane==='chat'&&!collapsed&&chat.selected_conversation_id&&<button id="delete-conversation" className="text-button" disabled={disabled} onClick={()=>void deletion()}>删除当前对话…</button>}
      <button title="设置" aria-label="设置" className="nav-button" onClick={openSettings}><Icon name="settings"/><span>设置</span></button>{!collapsed&&<p className="local-note"><Icon name="lock"/>保存在本机</p>}</div>
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
