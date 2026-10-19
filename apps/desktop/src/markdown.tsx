import {isValidElement,type ReactNode} from 'react';
import {CodeBlock} from './code-block';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useState} from 'react';
import {PageTabs} from './ui';

// Raw HTML stays text. No remote images are loaded from model output.
export function Markdown({text}:{text:string}){
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre:({children})=>{const code=isValidElement<{children?:ReactNode;className?:string}>(children)?children:null;return <CodeBlock language={code?.props.className?.replace('language-','')??''} text={String(code?.props.children??'').replace(/\n$/,'')}/>;},
    img:({alt})=><span className="muted">[图片：{alt||'未加载'}]</span>,
    a:({href,children})=><a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  }}>{text}</ReactMarkdown></div>;
}

export function ReportBody({text,id,compact=false}:{text:string;id:string;compact?:boolean}){
  const [view,setView]=useState<'reading'|'source'>('reading');
  if(compact)return <div id={id}><Markdown text={text}/><details className="report-source"><summary>原始文本</summary><pre className="report-preview">{text}</pre></details></div>;
  return <div id={id}><PageTabs label="正文阅读方式" value={view} change={setView} items={[["reading","阅读正文"],["source","原始文本"]]}/>{view==='reading'?<Markdown text={text}/>:<pre className="report-preview">{text}</pre>}</div>;
}
