import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './ui';

export function ActionMenu({label,children,className='',trigger,triggerClassName='icon-button',id}:{label:string;children:ReactNode;className?:string;trigger?:ReactNode;triggerClassName?:string;id?:string}){
  const button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState({top:0,left:0});
  useLayoutEffect(()=>{if(!open)return;const place=()=>{const rect=button.current!.getBoundingClientRect(),height=panel.current?.offsetHeight??240,width=panel.current?.offsetWidth??240;setPosition({left:Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8)),top:Math.max(8,rect.bottom+height+8<window.innerHeight?rect.bottom+6:rect.top-height-6)});};place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};},[open]);
  useEffect(()=>{
    if(!open)return;
    const close=(event:PointerEvent)=>{if(!button.current?.contains(event.target as Node)&&!panel.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}};
    document.addEventListener('pointerdown',close);
    document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[open]);
  return <span className={'action-menu '+className}>
    <button ref={button} id={id} type="button" className={triggerClassName} aria-label={label} title={label} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{trigger??<Icon name="more"/>}</button>
    {open&&createPortal(<div ref={panel} className="action-menu-content" role="group" aria-label={label} style={position} onClick={event=>{const target=event.target as HTMLElement;if(target.closest('button:not(:disabled)')&&!target.closest('[data-menu-stay]'))setOpen(false);}}>{children}</div>,document.body)}
  </span>;
}
