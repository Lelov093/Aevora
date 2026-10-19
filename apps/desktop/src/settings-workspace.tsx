import {useEffect,useRef,type ReactNode} from 'react';
import {Icon} from './ui';

export const settingsPages=[
  ['persona','身份与表达','identity'],['memory','记忆与学习','memory'],
  ['provider','模型与连接','provider'],['voice','语音与桌面陪伴','voice'],
  ['proactivity','主动帮助与通知','proactivity'],['permissions','权限与预算','lock'],
  ['runtime','本地数据与运行','settings']
] as const;
export type SettingsPage=typeof settingsPages[number][0];

export function SettingsWorkspace({open,page,change,close,children}:{open:boolean;page:SettingsPage;change:(v:SettingsPage)=>void;close:()=>void;children:ReactNode}){
  const back=useRef<HTMLButtonElement>(null),previous=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    if(!open)return;
    previous.current=document.activeElement as HTMLElement|null;
    back.current?.focus();
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]')){e.preventDefault();close();}};
    window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('keydown',escape);requestAnimationFrame(()=>{if(previous.current?.isConnected)previous.current.focus();});};
  },[open]);
  return <section hidden={!open} className="settings-workspace" aria-label="设置" id="settings-dialog">
    <aside className="settings-sidebar"><h1>设置</h1><button ref={back} type="button" className="text-button settings-back" onClick={close}>← 返回应用</button>
      <nav aria-label="设置分类">{settingsPages.map(([key,label,icon])=><button type="button" key={key} id={'settings-'+key} className={page===key?'selected':''} aria-current={page===key?'page':undefined} onClick={()=>change(key)}><Icon name={icon}/><span>{label}</span></button>)}</nav>
      <p className="settings-local"><Icon name="lock"/>保存在本机</p>
    </aside>
    <div className="settings-workspace-content">{children}</div>
  </section>;
}

export function SettingSection({title,description,status,children,initiallyOpen=false}:{title:string;description?:string;status?:string;children:ReactNode;initiallyOpen?:boolean}){
  return <details className="setting-section" open={initiallyOpen||undefined}><summary><span><strong>{title}</strong>{description&&<span className="setting-description">{description}</span>}</span><span className="setting-section-state">{status&&<small>{status}</small>}<span className="setting-toggle"><span className="setting-configure">配置</span><span className="setting-collapse">收起</span><Icon name="chevron"/></span></span></summary><div className="setting-section-body">{children}</div></details>;
}
