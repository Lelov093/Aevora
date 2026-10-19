/** Adapted from BoardUI's free AgentComposer (MIT); see README.md and LICENSE.txt.
 * Keeps the source pill/controls/status composition; Aevora owns all state and actions.
 */
import {useRef, type KeyboardEvent, type ReactNode, type RefObject} from 'react';
import {Icon} from '../../ui';
import {ComposerLoader} from './composer-loader';

export interface AgentComposerProps {
  value:string;
  inputUnlimited?:boolean;
  onValueChange:(value:string)=>void;
  onSubmit:()=>void;
  onStop:()=>void;
  busy:boolean;
  disabled:boolean;
  sendDisabled:boolean;
  model:string;
  openProvider:()=>void;
  placeholder:string;
  inputRef:RefObject<HTMLTextAreaElement|null>;
  attachments:ReactNode;
  voice:ReactNode;
  status:ReactNode;
}

export function AgentComposer({value,onValueChange,onSubmit,onStop,busy,disabled,sendDisabled,
  model,openProvider,placeholder,inputRef,attachments,voice,status,inputUnlimited=false}:AgentComposerProps){
  const attachmentsRef=useRef<HTMLDetailsElement>(null);
  function keyDown(event:KeyboardEvent<HTMLTextAreaElement>){
    // Keep Aevora's multiline / Chinese IME behavior instead of the starter's Enter-to-send.
    if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){
      event.preventDefault();if(!sendDisabled)onSubmit();
    }
  }
  return <div className="boardui-composer-wrap">
    <ComposerLoader active={busy} radius={26} colors={['#0a66dd','#66a6ff','#89f7fe','#68e0cf']} intensity={.45} bloom={10}>
      <form id="chat-form" className="boardui-composer" onSubmit={event=>{event.preventDefault();if(!sendDisabled)onSubmit();}}>
        <details ref={attachmentsRef} className="composer-popover attachments-popover">
          <summary aria-label="资料与工具" title="资料与工具"><Icon name="plus"/></summary>
          <div className="composer-popover-content" onClick={event=>{if((event.target as HTMLElement).closest('button:not(:disabled)'))attachmentsRef.current?.removeAttribute('open');}}>{attachments}</div>
        </details>
        <label className="sr-only" htmlFor="chat-input">消息</label>
        <textarea id="chat-input" ref={inputRef} rows={1} maxLength={inputUnlimited?undefined:12000} value={value}
          disabled={disabled} onChange={event=>onValueChange(event.target.value)} onKeyDown={keyDown}
          placeholder={placeholder}/>
        <button type="button" className="composer-model text-button" onClick={openProvider} title={'当前模型：'+(model||'尚未选择')} aria-label="查看模型与连接">
          <span>{model||'配置模型'}</span><Icon name="chevron"/>
        </button>
        <details className="composer-popover voice-popover">
          <summary aria-label="语音输入与会话" title="语音输入与会话"><Icon name="mic"/></summary>
          <div className="composer-popover-content">{voice}</div>
        </details>
        {busy?<button id="cancel-run" type="button" className="boardui-send boardui-stop" disabled={disabled} onClick={onStop} title="停止回复" aria-label="停止回复"><Icon name="stop"/></button>:
          <button id="send-message" type="submit" className="boardui-send" disabled={sendDisabled} title="发送 · Ctrl + Enter" aria-label="发送消息"><Icon name="send"/></button>}
      </form>
    </ComposerLoader>
    <div className="boardui-composer-status">{status}<span className="composer-shortcut">Ctrl + Enter 发送</span></div>
  </div>;
}
