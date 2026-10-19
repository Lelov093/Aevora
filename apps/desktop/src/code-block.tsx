import {useState} from 'react';
import {Icon} from './ui';

export function CodeBlock({text,language}:{text:string;language:string}){
  const [copied,setCopied]=useState(false),[error,setError]=useState('');
  async function copy(){try{await navigator.clipboard.writeText(text);setCopied(true);setError('');}catch{setError('复制未完成，请选择代码手动复制。');}}
  return <section className="message-code" aria-label={language?language+' 代码':'代码'}>
    <header><span>{language||'代码'}</span><button type="button" className="icon-button" aria-label={copied?'已复制代码':'复制代码'} title={copied?'已复制':'复制代码'} onClick={()=>void copy()}><Icon name={copied?'check':'copy'}/></button></header>
    <pre><code>{text}</code></pre>{error&&<p className="error" role="alert">{error}</p>}
  </section>;
}
