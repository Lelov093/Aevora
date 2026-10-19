import { useEffect, useRef, type ReactNode } from "react";
import {
  AlignLeft, ThumbsUp, ThumbsDown, Copy, FileText, Folder, Layers, ArrowUp, Bell, PanelLeft, PanelRight, MoreHorizontal, Square, Brain, BriefcaseBusiness, Check, ChevronDown, GripVertical,
  LockKeyhole, Menu, MessageCircle, Mic, Orbit, Paperclip, Pause, Play, Plus,
  RotateCcw, Search, Settings, SlidersHorizontal, UserRound, Volume2, X, type LucideIcon
} from "lucide-react";
const icons: Record<string, LucideIcon> = {
  'thumb-up':ThumbsUp,'thumb-down':ThumbsDown,copy:Copy,file:FileText,folder:Folder,layers:Layers,
  'panel-left':PanelLeft,'panel-right':PanelRight,more:MoreHorizontal,stop:Square,menu: Menu, work: BriefcaseBusiness, plus: Plus, search: Search, chat: MessageCircle,
  memory: Brain, settings: Settings, chevron: ChevronDown, close: X, send: ArrowUp,
  pause: Pause, play: Play, retry: RotateCcw, lock: LockKeyhole, mic: Mic,
  voice: Volume2, paperclip: Paperclip, check: Check, grip: GripVertical,
  identity: UserRound, provider: SlidersHorizontal, proactivity: Bell, presence: Orbit, text: AlignLeft
};
export function PageTabs<T extends string>({items,value,change,label}:{items:readonly (readonly [T,string])[];value:T;change:(value:T)=>void;label:string}){
  return <nav className="page-tabs" aria-label={label}>{items.map(([key,text])=><button type="button" key={key} aria-current={value===key?'page':undefined} className={value===key?'selected':''} onClick={()=>change(key)}>{text}</button>)}</nav>;
}
export function Icon({name}:{name:string}){const Symbol=icons[name]??MessageCircle;return <Symbol aria-hidden="true" size={18} strokeWidth={1.65}/>;}
export function Modal({open,close,title,id,children}:{open:boolean;close:()=>void;title:string;id:string;children:ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;if(open&&!dialog?.open)dialog?.showModal();if(!open&&dialog?.open)dialog.close();},[open]);
  return <dialog id={id} ref={ref} aria-labelledby={id+"-title"} onCancel={e=>{if(e.target===e.currentTarget)close();}} onClose={e=>{if(e.target===e.currentTarget)close();}}>
    <div className="dialog-header"><h2 id={id+"-title"}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close"/></button></div>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
