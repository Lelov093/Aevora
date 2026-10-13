import {useEffect,useRef,useState} from 'react';

export function usePanelWidth(key:string,initial:number,min:number,max:number){
 const [width,setWidth]=useState(()=>{try{const v=Number(localStorage.getItem(key));return v>=min&&v<=max?v:initial;}catch{return initial;}});
 useEffect(()=>{try{localStorage.setItem(key,String(width));}catch{}},[key,width]);
 return {width,min,max,initial,setWidth:(v:number)=>setWidth(Math.max(min,Math.min(max,v)))};
}
export function Divider({panel,side,label}:{panel:ReturnType<typeof usePanelWidth>;side:'left'|'right';label:string}){
 const drag=useRef<{x:number;width:number}|null>(null);
 return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width} tabIndex={0} className="panel-divider" title="拖动调节 · 方向键微调 · 双击恢复" onDoubleClick={()=>panel.setWidth(panel.initial)} onKeyDown={e=>{
  if(e.key==='Home'){e.preventDefault();panel.setWidth(panel.initial);}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();panel.setWidth(panel.width+(e.key==='ArrowRight'?1:-1)*(side==='left'?1:-1)*(e.shiftKey?40:10));}
 }} onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={x:e.clientX,width:panel.width};e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.classList.add('dragging');}} onPointerMove={e=>{if(drag.current)panel.setWidth(drag.current.width+(e.clientX-drag.current.x)*(side==='left'?1:-1));}} onPointerUp={e=>{drag.current=null;e.currentTarget.classList.remove('dragging');if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}} onLostPointerCapture={e=>{drag.current=null;e.currentTarget.classList.remove('dragging');}}/>;
}
