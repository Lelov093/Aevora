import {Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes} from 'react';
import {createPortal} from 'react-dom';
import {CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Minus, Plus, X} from 'lucide-react';

// Preserve real form change events, including parent consent-invalidation handlers.
function changeValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
 Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,'value')!.set!.call(el,value);
 el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
}
function labelFor(el: HTMLElement | null, fallback: string) {
 const label=el?.closest('label'); return label ? Array.from(label.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim()||fallback : fallback;
}
function Popup({anchor,close,children,className=''}:{anchor:HTMLElement;close:()=>void;children:ReactNode;className?:string}) {
 const ref=useRef<HTMLDivElement>(null),[at,setAt]=useState({left:0,top:0,width:0,maxHeight:320});
 useLayoutEffect(()=>{
  function position(){const r=anchor.getBoundingClientRect(),width=Math.min(className==='calendar-popup'?320:Math.max(r.width,280),innerWidth-16);if(ref.current)ref.current.style.width=width+'px';const h=Math.min(ref.current?.scrollHeight??320,className==='calendar-popup'?500:320),below=innerHeight-r.bottom-12,above=r.top-12;
   const up=below<h&&above>below; const height=Math.max(100,Math.min(h,up?above:below));
   setAt({left:Math.max(8,Math.min(r.left,innerWidth-width-8)),top:up?Math.max(8,r.top-height-6):r.bottom+6,width,maxHeight:height});}
  position(); window.addEventListener('resize',position); window.addEventListener('scroll',position,true);
  const outside=(e:PointerEvent)=>{if(!anchor.contains(e.target as Node)&&!ref.current?.contains(e.target as Node))close();};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();anchor.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
  return()=>{window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);};
 },[anchor]);
 return createPortal(<div ref={ref} className={'control-popup '+className} style={at} onClick={e=>e.stopPropagation()}>{children}</div>,anchor.closest('dialog')??document.body);
}
type Option={value:string;label:string;disabled:boolean};
function textOf(node:ReactNode):string {return Children.toArray(node).map(c=>isValidElement<{children?:ReactNode}>(c)?textOf(c.props.children):String(c)).join('');}
function optionsOf(children:ReactNode):Option[]{return Children.toArray(children).flatMap(c=>{
 if(!isValidElement<{children?:ReactNode;value?:string;disabled?:boolean}>(c))return [];
 if(c.type===Fragment)return optionsOf(c.props.children);
 return [{value:String(c.props.value??textOf(c.props.children)),label:textOf(c.props.children),disabled:!!c.props.disabled}];
});}
export function Select({children,...props}:SelectHTMLAttributes<HTMLSelectElement>) {
 const ref=useRef<HTMLSelectElement>(null),trigger=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null),id=useId();
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0),[label,setLabel]=useState('');
 const options=optionsOf(children),value=String(props.value??props.defaultValue??''),selected=options.find(o=>o.value===value);
 const visible=options.filter(o=>o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 useEffect(()=>{setLabel(props['aria-label']??labelFor(trigger.current,'选择'));});
 useEffect(()=>{if(props.disabled)setOpen(false);},[props.disabled]);
 useEffect(()=>{if(open)list.current?.querySelector<HTMLElement>(`[data-option-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active,open]);
 function show(){if(ref.current?.matches(':disabled'))return;setQuery('');setActive(Math.max(0,options.findIndex(o=>o.value===value)));setOpen(true);}
 function choose(o:Option){if(o.disabled||!ref.current||ref.current.matches(':disabled'))return;changeValue(ref.current,o.value);setOpen(false);trigger.current?.focus();}
 function move(direction:number){if(!visible.some(o=>!o.disabled))return;let i=active;for(let n=0;n<visible.length;n++){i=(i+direction+visible.length)%visible.length;if(!visible[i].disabled){setActive(i);break;}}}
 return <div className="select-control">
  <select {...props} ref={ref} className="native-select-bridge" tabIndex={-1} aria-hidden="true" onFocus={()=>trigger.current?.focus()}>{children}</select>
  <button id={props.id?props.id+'-control':undefined} ref={trigger} type="button" className="select-trigger" disabled={props.disabled} role="combobox" aria-label={props['aria-label']??label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" onClick={()=>open?setOpen(false):show()} onKeyDown={e=>{
   if(['ArrowDown','ArrowUp','Enter',' '].includes(e.key)){e.preventDefault();show();}
  }}><span>{selected?.label??'请选择…'}</span><ChevronDown size={17}/></button>
  {open&&trigger.current&&<Popup anchor={trigger.current} close={()=>setOpen(false)}><div className="select-menu" onKeyDown={e=>{
   if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();move(e.key==='ArrowDown'?1:-1);}
   else if(e.key==='Home'||e.key==='End'){e.preventDefault();setActive(e.key==='Home'?visible.findIndex(o=>!o.disabled):visible.map(o=>!o.disabled).lastIndexOf(true));}
   else if(e.key==='Enter'){e.preventDefault();if(visible[active])choose(visible[active]);}
   else if(e.key==='Tab')setOpen(false);
   else if(options.length<8&&e.key.length===1){const i=visible.findIndex(o=>!o.disabled&&o.label.toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase()));if(i>=0)setActive(i);}
  }}>{options.length>=8&&<input className="select-search" aria-label="搜索选项" placeholder="搜索…" autoFocus value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}}/>}
   <div ref={list} id={id} className="select-options" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={visible[active]?id+'-'+active:undefined}>
    {visible.map((o,i)=><div key={o.value} id={id+'-'+i} role="option" aria-selected={o.value===value} aria-disabled={o.disabled} data-option-index={i} className={'select-option '+(i===active?'focused':'')} onPointerMove={()=>{if(!o.disabled)setActive(i);}} onClick={()=>choose(o)}><span>{o.label}</span>{o.value===value&&<Check size={17}/>}</div>)}
    {!visible.length&&<p className="muted small">没有匹配的选项</p>}
   </div><MenuFocus searchable={options.length>=8} list={list}/>
  </div></Popup>}
 </div>;
}
function MenuFocus({searchable,list}:{searchable:boolean;list:React.RefObject<HTMLDivElement|null>}){useEffect(()=>{if(!searchable)list.current?.focus();},[]);return null;}
export function CheckField(props:InputHTMLAttributes<HTMLInputElement>){return <span className={'check-control '+(props.role==='switch'?'switch-control':'')}><input {...props} type="checkbox"/><span className="check-visual" aria-hidden="true">{props.role!=='switch'&&<Check size={14}/>}</span></span>;}
export function NumberField(props:InputHTMLAttributes<HTMLInputElement>){
 const ref=useRef<HTMLInputElement>(null);
 function step(direction:number){const el=ref.current;if(!el)return;const old=el.value;try{direction>0?el.stepUp():el.stepDown();const next=el.value;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,old);changeValue(el,next);}catch{}el.focus();}
 return <span className="number-control"><input {...props} ref={ref} type="number"/><span className="number-actions"><button type="button" aria-label="减少" disabled={props.disabled||props.readOnly||props.min!==undefined&&Number(props.value)<=Number(props.min)} onClick={()=>step(-1)}><Minus size={13}/></button><button type="button" aria-label="增加" disabled={props.disabled||props.readOnly||props.max!==undefined&&Number(props.value)>=Number(props.max)} onClick={()=>step(1)}><Plus size={13}/></button></span></span>;
}
function validDate(value:string,timed:boolean){if(!value)return true;const m=value.match(timed?/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/:/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return false;const y=+m[1],mo=+m[2],d=+m[3];return y>=1&&mo>=1&&mo<=12&&d>=1&&d<=new Date(y,mo,0).getDate()&&(!timed||+m[4]<24&&+m[5]<60&&+(m[6]??0)<60);}
export function DateField({type,...props}:InputHTMLAttributes<HTMLInputElement>){
 const timed=type==='datetime-local',ref=useRef<HTMLInputElement>(null),button=useRef<HTMLButtonElement>(null);
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(String(props.value??'')),[date,setDate]=useState(''),[time,setTime]=useState('00:00:00'),[month,setMonth]=useState(new Date());
 useEffect(()=>{if(props.value!=='invalid-date')setDraft(String(props.value??''));},[props.value]);
 function show(){const v=validDate(draft,timed)&&draft?draft:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19);setDate(v.slice(0,10));setTime(v.slice(11,19)||'00:00:00');setMonth(new Date(+v.slice(0,4),+v.slice(5,7)-1,1));setOpen(true);}
 function apply(value:string){if(props.disabled||props.readOnly||ref.current?.matches(':disabled'))return;if(ref.current){changeValue(ref.current,value);setDraft(value);}setOpen(false);button.current?.focus();}
 const year=month.getFullYear(),mo=month.getMonth(),first=(new Date(year,mo,1).getDay()+6)%7,days=new Date(year,mo+1,0).getDate();
 function calendarKey(e:React.KeyboardEvent<HTMLButtonElement>,day:number){
  const delta:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
  if(!(e.key in delta))return;e.preventDefault();const next=new Date(year,mo,day+delta[e.key]);const v=`${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;setDate(v);setMonth(new Date(next.getFullYear(),next.getMonth(),1));const grid=e.currentTarget.parentElement;requestAnimationFrame(()=>grid?.querySelector<HTMLButtonElement>(`[data-day="${v}"]`)?.focus());
 }
 return <span className="date-control"><input {...props} type="text" ref={ref} value={draft} placeholder={timed?'YYYY-MM-DDTHH:mm:ss':'YYYY-MM-DD'} aria-invalid={!validDate(draft,timed)} onChange={e=>{const value=e.target.value.replace(' ','T');setDraft(value);const valid=validDate(value,timed);e.target.setCustomValidity(valid?'':'请输入有效日期与时间');props.onChange?.({...e,target:{...e.target,value:valid?value:'invalid-date'},currentTarget:{...e.currentTarget,value:valid?value:'invalid-date'}});}}/><button ref={button} type="button" className="date-open" aria-label="选择日期" disabled={props.disabled||props.readOnly} onClick={show}><CalendarDays size={18}/></button>
 {open&&button.current&&<Popup anchor={ref.current!} close={()=>setOpen(false)} className="calendar-popup"><div className="calendar-heading"><button type="button" aria-label="上一月" onClick={()=>setMonth(new Date(year,mo-1,1))}><ChevronLeft size={17}/></button><strong>{year}年 {mo+1}月</strong><button type="button" aria-label="下一月" onClick={()=>setMonth(new Date(year,mo+1,1))}><ChevronRight size={17}/></button></div><div className="calendar-grid">{['一','二','三','四','五','六','日'].map(d=><small key={d}>{d}</small>)}{Array.from({length:first+days},(_,i)=>{const day=i-first+1,v=`${year}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;return day<1?<span key={i}/>:<button key={i} type="button" data-day={v} aria-label={v} autoFocus={date===v} onKeyDown={e=>calendarKey(e,day)} aria-pressed={date===v} className={date===v?'selected':''} onClick={()=>setDate(v)}>{day}</button>;})}</div>
 {timed&&<label className="calendar-time">时间（时 : 分 : 秒）<span>{time.split(':').map((v,i)=><NumberField key={i} aria-label={['小时','分钟','秒'][i]} min={0} max={i===0?23:59} value={Number(v)} onChange={e=>setTime(old=>old.split(':').map((x,j)=>j===i?String(e.target.value).padStart(2,'0'):x).join(':'))}/>)}</span></label>}
 <div className="calendar-footer"><button type="button" className="text-button" disabled={props.required} onClick={()=>apply('')}><X size={14}/>清空</button><button type="button" onClick={()=>apply(date+(timed?'T'+time:''))} disabled={!validDate(date+(timed?'T'+time:''),timed)}>应用</button></div></Popup>}
 </span>;
}
