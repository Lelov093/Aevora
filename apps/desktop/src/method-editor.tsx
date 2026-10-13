import type {Method} from './methods';

export function MethodEditor({value,changed,disabled}:{value:Method;changed:(v:Method)=>void;disabled:boolean}){
 const fields=[['title','方法名称',120],['applicability','什么时候使用',600],['rationale','修改依据',800],['limits','适用限制',600]] as const;
 return <div id="method-editor">
  {fields.map(([key,label,max])=><label key={key}>{label}<textarea id={`method-edit-${key}`} rows={key==='title'?1:2} maxLength={max} disabled={disabled} value={value[key]} onChange={e=>changed({...value,[key]:e.target.value})}/></label>)}
  {(['procedure','checks'] as const).map(key=><fieldset key={key}><legend>{key==='procedure'?'处理步骤':'检查要求'}（最多六项）</legend>
   {value[key].map((item,index)=><label key={index}>{index+1}.<textarea id={`method-edit-${key}-${index}`} rows={2} maxLength={600} disabled={disabled} value={item} onChange={e=>changed({...value,[key]:value[key].map((old,i)=>i===index?e.target.value:old)})}/>
    <button type="button" className="text-button" disabled={disabled||value[key].length===1} onClick={()=>changed({...value,[key]:value[key].filter((_,i)=>i!==index)})}>移除此项</button></label>)}
   <button type="button" className="text-button" disabled={disabled||value[key].length>=6} onClick={()=>changed({...value,[key]:[...value[key],'']})}>添加一项</button>
  </fieldset>)}
 </div>;
}

export function MethodChanges({before,after}:{before:Method;after:Method}){
 const fields=[['title','名称'],['applicability','适用条件'],['procedure','步骤'],['checks','检查要求'],['rationale','依据'],['limits','限制']] as const;
 const changed=fields.filter(([key])=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
 const show=(value:string|string[])=>Array.isArray(value)?<ol>{value.map((v,i)=><li key={i}>{v}</li>)}</ol>:<p>{value}</p>;
 return <details id="method-changes"><summary>与确认的原方法比较 · {changed.length} 项变化</summary>
  {changed.length?changed.map(([key,label])=><section key={key}><strong>{label}</strong><p className="small muted">原方法</p>{show(before[key])}<p className="small muted">候选</p>{show(after[key])}</section>):<p>内容相同，尚无方法变化；不代表已经证明改善。</p>}
 </details>;
}
