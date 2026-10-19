import {useState,type ReactNode} from 'react';
import {Icon} from './ui';
import {ActionMenu} from './action-menu';

export function MessageActions({content,assistant,disabled,feedback,voice,children}:{content:string;assistant:boolean;disabled:boolean;feedback:(helpful:boolean)=>void;voice?:ReactNode;children:ReactNode}){
  const [copied,setCopied]=useState(false),[error,setError]=useState('');
  async function copy(){try{await navigator.clipboard.writeText(content);setCopied(true);setError('');}catch{setError('复制未完成，请选择正文手动复制。');}}
  return <div className={'message-toolbar '+(assistant?'':'user-toolbar')} aria-label={assistant?'回复操作':'消息操作'}>
    {assistant&&<><button type="button" className="message-action" aria-label="这次回复有帮助" title="有帮助 · 填写反馈" disabled={disabled} onClick={()=>feedback(true)}><Icon name="thumb-up"/></button><button type="button" className="message-action" aria-label="这次回复需要改进" title="需要改进 · 填写反馈" disabled={disabled} onClick={()=>feedback(false)}><Icon name="thumb-down"/></button></>}
    <button type="button" className="message-action" aria-label={copied?'已复制正文':'复制正文'} title={copied?'已复制':'复制'} onClick={()=>void copy()}><Icon name={copied?'check':'copy'}/></button>
    {voice}
    <ActionMenu label={assistant?'更多回复操作':'更多消息操作'}>{children}</ActionMenu>
    {error&&<span className="error" role="alert">{error}</span>}
    <span className="sr-only" role="status">{copied?'正文已复制':''}</span>
  </div>;
}
