import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CheckField,NumberField,Select} from './controls';
import type {Execute} from './chat';
import type {Step} from './task-plan';
export type ToolRoot={path:string;mode:'read'|'write';recursive:boolean;auto_create:boolean};
export type ToolScope={roots:ToolRoot[];programs:('python'|'powershell')[];urls:string[];command_timeout_seconds:number;execution_seconds:number;max_total_tokens:number};
export const emptyToolScope=():ToolScope=>({roots:[],programs:[],urls:[],command_timeout_seconds:60,execution_seconds:900,max_total_tokens:1000000});
export const generalWrites=['write_file','manage_files','run_command'];
export type ToolProduct={root:string;path:string;version:string;bytes:number};
export type ToolObservation={preview?:Record<string,unknown>;entries?:unknown[];matches?:unknown[];next_offset?:number|null;truncated?:boolean;receipt?:{outcome:string;status?:string;exit_code?:number;truncated?:boolean;stdout?:string;stderr?:string;error?:string;products?:ToolProduct[];verification?:string}};

export function ToolScopeFields({value,change}:{value:ToolScope;change:(v:ToolScope)=>void}){
 const [error,setError]=useState('');
 const update=(i:number,v:Partial<ToolRoot>)=>change({...value,roots:value.roots.map((r,j)=>i===j?{...r,...v}:r)});
 async function pick(){try{const paths=await invoke<string[]>('choose_task_resource',{kind:'directory'});if(paths[0])change({...value,roots:[...value.roots,{path:paths[0],mode:'read',recursive:true,auto_create:false}]});}catch(e){setError(String(e));}}
 return <section aria-label="通用工具范围"><h3>本次可用工具与资源</h3><p className="small muted">选择需要查看或处理的目录。只读操作在本次范围内执行，文件修改与命令会先展示具体内容。</p>
  {value.roots.map((r,i)=><fieldset key={i}><legend>目录 {i+1}</legend><label>位置<input aria-label={`目录 ${i+1} 位置`} value={r.path} onChange={e=>update(i,{path:e.target.value})}/></label><label>允许操作<Select aria-label={`目录 ${i+1} 操作`} value={r.mode} onChange={e=>update(i,{mode:e.target.value as ToolRoot['mode'],auto_create:false})}><option value="read">查看文件与文本</option><option value="write">查看并处理文件</option></Select></label><label className="check"><CheckField checked={r.recursive} onChange={e=>update(i,{recursive:e.target.checked})}/>包括子目录（观察深度最多3层）</label>{r.mode==='write'&&<label className="check"><CheckField checked={r.auto_create} onChange={e=>update(i,{auto_create:e.target.checked})}/>允许在此目录内直接新建、建目录与复制；最多8个变更目标，不覆盖已有文件</label>}<button className="text-button" onClick={()=>change({...value,roots:value.roots.filter((_,j)=>i!==j)})}>移除此目录</button></fieldset>)}
  <button id="add-tool-directory" className="secondary" disabled={value.roots.length>=4} onClick={()=>void pick()}>选择目录…</button>
  <details><summary>公开网页与本地计算（可选）</summary><label>允许读取的公开HTTPS网页，每行一个<textarea id="tool-urls" value={value.urls.join('\n')} onChange={e=>change({...value,urls:e.target.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean)})}/></label><p className="small muted">仅公开静态网页，不含登录、JS执行、PDF或附件；与搜索共用最多6次页面读取。</p>
   {(['python','powershell'] as const).map(program=><label className="check" key={program}><CheckField checked={value.programs.includes(program)} onChange={e=>change({...value,programs:e.target.checked?[...value.programs,program]:value.programs.filter(p=>p!==program)})}/>允许提出 {program==='python'?'Python':'Windows PowerShell'} 本地计算／转换方案</label>)}
   {!!value.programs.length&&<p className="notice">具体命令、脚本、输入与产物需要另行审阅后批准。程序具有当前Windows用户权限，工作目录不构成系统沙箱；不会获得Host凭据。不用于安装、联网、系统设置或发布。</p>}
   <label>命令单次上限（秒，最多120）<NumberField min={1} max={120} value={value.command_timeout_seconds} onChange={e=>change({...value,command_timeout_seconds:Number(e.target.value)})}/></label><label>累计主动执行上限（秒，最多1800；等待你时不计）<NumberField min={1} max={1800} value={value.execution_seconds} onChange={e=>change({...value,execution_seconds:Number(e.target.value)})}/></label><label>任务总模型用量预算（含未知用量保守预留）<NumberField min={64} max={1000000} value={value.max_total_tokens} onChange={e=>change({...value,max_total_tokens:Number(e.target.value)})}/></label>
  </details>{error&&<p role="alert" className="error">{error}</p>}
 </section>;
}

export function GeneralToolReview({step,editing,draft,onDraft,save,cancel}:{step:Step;editing:boolean;draft:string;onDraft:(s:string)=>void;save:()=>void;cancel:()=>void}){
 const preview=step.result?.preview;
 const operation=String(preview?.operation??step.definition.op);
 const command=operation==='run_command';
 return <section aria-label="审阅工具行动"><h3>具体行动预览</h3><p>批准只适用于当前对象、版本和参数；修改后重新审阅。</p>
  {step.definition.op==='run_command'&&<p className="notice">请审阅完整命令和脚本、工作目录及所有文件副作用。当前进程具有Windows用户权限；不属于系统沙箱。</p>}
  {editing?<><label>完整行动JSON<textarea id="task-body-editor" rows={14} value={draft} onChange={e=>onDraft(e.target.value)}/></label><button id="save-task-body" onClick={save}>保存行动并重新预览</button><button className="secondary" onClick={cancel}>取消编辑</button></>:operation==='write_file'?<div id="general-tool-preview"><p>文件：{String(preview?.path??'')}</p><h4>修改前</h4><pre className="report-preview">{String(preview?.before??'（新建文件）')}</pre><h4>保存后完整正文</h4><pre className="report-preview">{String(preview?.after??'')}</pre></div>:command?<div id="general-tool-preview"><p>程序：{String(preview?.program??'')}</p><p>工作目录：{String(preview?.cwd??'')}</p><h4>参数</h4><pre className="report-preview">{JSON.stringify(preview?.args??[],null,2)}</pre><h4>完整脚本</h4><pre className="report-preview">{String(preview?.script??'（无独立脚本）')}</pre><h4>输入版本与文件产物</h4><pre className="report-preview">{JSON.stringify({inputs:preview?.inputs??[],outputs:preview?.outputs??[]},null,2)}</pre></div>:<pre className="report-preview" id="general-tool-preview">{JSON.stringify(preview??step.definition,null,2)}</pre>}
 </section>;
}

export function ActionRevisionReview({disabled,submit}:{disabled:boolean;submit:(feedback:string)=>Promise<void>}){
 const [feedback,setFeedback]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState('');
 async function send(){if(disabled||sending||!feedback.trim())return;setSending(true);setError('');try{await submit(feedback.trim());setFeedback('');}catch(e){setError(String(e));}finally{setSending(false);}}
 return <section aria-label="指出问题并重新提案"><label>这份提案需要改什么？<textarea id="action-review-feedback" maxLength={2000} rows={3} disabled={disabled||sending} value={feedback} onChange={e=>setFeedback(e.target.value)}/></label><p className="small muted">说明会发给本任务的模型。当前行动不执行，原稿和理由保留；新提案按原权限重新预览，命令仍须逐次批准。</p><button id="revise-agent-action" className="secondary" disabled={disabled||sending||!feedback.trim()} onClick={()=>void send()}>{sending?'正在发送…':'退回并请求新提案'}</button>{error&&<p role="alert" className="error">{error}</p>}</section>;
}

export function GeneralToolObservations({steps,agentId,taskId,execute,disabled}:{steps:Step[];agentId:string;taskId:string;execute:Execute;disabled:boolean}){
 const [preview,setPreview]=useState<{path:string;content?:string|null}>(),[error,setError]=useState('');
 const products=steps.flatMap(s=>(s.action?.receipt?.outcome==='Success'?s.result?.receipt?.products??[]:[]).map((p,i)=>({...p,id:`tool:${s.action_id}:${i}`})));
 async function inspect(id:string,open=false){setError('');try{const v=await execute<{path:string;content?:string|null}>({protocol_version:1,command_id:crypto.randomUUID(),type:open?'OpenTaskArtifact':'PreviewTaskArtifact',agent_id:agentId,payload:{task_id:taskId,output_id:id}});if(!open)setPreview(v);}catch(e){setError(String(e));}}
 return <section aria-label="实际工具观察与产物">{steps.filter(s=>s.definition.op==='run_command'&&s.result?.receipt).map(s=><details key={s.step_id} open><summary>命令结果 · {s.result?.receipt?.status==='Failed'?'失败':s.action?.receipt?.outcome} · 退出码 {s.result?.receipt?.exit_code??'未知'}</summary><button className="text-button" disabled={disabled} onClick={()=>void inspect(`tool-log:${s.action_id}:0`)}>查看完整有界日志</button><pre className="report-preview">{s.result?.receipt?.stdout}{s.result?.receipt?.stderr}</pre>{s.result?.receipt?.truncated&&<p>输出已截断，完整有界日志保存在本机任务目录。</p>}{s.result?.receipt?.error&&<p className="error">{s.result.receipt.error}</p>}</details>)}
  {steps.filter(s=>s.result?.entries||s.result?.matches).map(s=><details key={s.step_id}><summary>{s.definition.op==='list_files'?'目录观察':'实际匹配'}{s.result?.truncated?'（已达上限）':''}</summary><pre className="report-preview">{JSON.stringify(s.result?.entries??s.result?.matches,null,2)}</pre>{s.result?.next_offset!=null&&<p>还有下一页，当前并非全部结果。</p>}</details>)}
  {!!products.length&&<><h3>实际产物</h3>{products.map(p=><div key={p.id}><span>{p.root} / {p.path} · {p.bytes} 字节 </span><button className="text-button" disabled={disabled} onClick={()=>void inspect(p.id)}>预览</button><button className="text-button" disabled={disabled} onClick={()=>void inspect(p.id,true)}>打开所在位置</button></div>)}</>}
  {preview&&<section><h3>{preview.path}</h3><pre className="report-preview">{preview.content??'此文件不支持文本预览，可打开所在位置查看。'}</pre></section>}{error&&<p role="alert" className="error">{error}</p>}
 </section>;
}
