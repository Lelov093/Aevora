import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useState} from 'react';
import {PageTabs} from './ui';

// Raw HTML stays text. No remote images are loaded from model output.
export function Markdown({text}:{text:string}){
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    img:({alt})=><span className="muted">[图片：{alt||'未加载'}]</span>,
    a:({href,children})=><a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  }}>{text}</ReactMarkdown></div>;
}

export function ReportBody({text,id}:{text:string;id:string}){
  const [view,setView]=useState<'reading'|'source'>('reading');
  return <div id={id}><PageTabs label="正文阅读方式" value={view} change={setView} items={[["reading","阅读正文"],["source","原始文本"]]}/>{view==='reading'?<Markdown text={text}/>:<pre className="report-preview">{text}</pre>}</div>;
}
