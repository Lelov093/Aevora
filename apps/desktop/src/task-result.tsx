import type {ReactNode} from 'react';
import {Markdown} from './markdown';
import {Icon} from './ui';
import type {Schedule} from './schedules';
import type {BodyReview} from './schedules';

export const bodyReviewLabel=(value?:BodyReview|null)=>value?`${value.editor==='user'?'人工编辑稿':'模型原稿'} · ${value.save_approved?'已批准保存':'尚未批准保存'}`:'尚无保存正文';

import {taskNames} from './work-state';
export {taskNames} from './work-state';
const receiptNames:Record<string,string>={Success:'有成功写入回执',Unknown:'写入结果未知 · 请核对',NotExecuted:'已确认未写入'};
export function TaskResult({schedule,disabled,openTask,compact=false,title,detailsContent}:{title?:string;detailsContent?:ReactNode;schedule:Pick<Schedule,'schedule_id'|'task_id'|'task_result'>;disabled:boolean;openTask:()=>void;compact?:boolean}){
 const value=schedule.task_result;if(!value)return null;
 if(compact)return <section className="agreement-result compact-task-result" data-agreement-result={schedule.schedule_id} data-task-state={value.state} aria-label="关联任务结果">
  <div className="task-result-heading"><span className="artifact-type">{value.outputs[0]?.path.split('.').pop()?.toUpperCase().slice(0,6)||'工作'}</span><span className="artifact-filename">{value.outputs[0]?.label||title||'工作报告'}</span><span className="artifact-state">{taskNames[value.state]??value.state}</span><button type="button" className="icon-button" aria-label="查看任务详情" title="查看任务详情" disabled={disabled} onClick={openTask}><Icon name="panel-right"/></button></div>
  {(value.error||value.permission===0)&&<p className="error" role="status">{value.permission===0?'权限已撤销':''}{value.error?' · '+value.error:''}</p>}
  <button type="button" className="artifact-summary" disabled={disabled} onClick={openTask}><span className="artifact-symbol"><Icon name="file"/></span><span><strong>{title||value.outputs[0]?.label||'本次工作报告'}</strong><small>{value.outputs.length?'正文、资料依据与实际执行记录':'查看结论与实际执行记录'}</small></span></button>
  <div className="artifact-flags">{value.outputs.filter(output=>output.outcome==='Unknown'||output.outcome==='NotExecuted').map(output=><span key={output.output_id} className={output.outcome==='Unknown'?'notice':''}>{output.outcome?receiptNames[output.outcome]??output.outcome:'尚无写入回执'} · {bodyReviewLabel(output.body_review)}</span>)}</div>
  <div className="artifact-footer"><button className="text-button task-result-open" data-open-agreement-task={schedule.schedule_id} disabled={disabled} onClick={openTask}>查看产物<Icon name="chevron"/></button><details className="task-result-records"><summary aria-label="报告与历史回执" title="报告与历史回执"><Icon name="more"/></summary><div>
   {value.reply&&<Markdown text={value.reply}/>}
   <ul>{value.outputs.map(output=><li key={output.output_id}><span>{output.outcome?receiptNames[output.outcome]??output.outcome:'尚无写入回执'} · {bodyReviewLabel(output.body_review)}</span><br/><code>{output.path}</code>{output.bytes_written!==null&&output.bytes_written!==undefined?` · ${output.bytes_written} 字节`:''}</li>)}</ul>
   <p className="small muted">历史写入记录不代表文件当前状态、内容认可或目标达成；当前内容从任务中的本机预览核对。</p>{detailsContent}
  </div></details></div>
 </section>;
 return <section className="agreement-result" data-agreement-result={schedule.schedule_id} data-task-state={value.state} aria-label="关联任务结果">
  <p className="small"><strong>关联任务：{taskNames[value.state]??value.state}</strong>{value.permission===0?' · 权限已撤销':''}{value.error?` · ${value.error}`:''}</p>
  {value.reply&&<details open><summary>结论或部分结果（模型原稿）</summary><Markdown text={value.reply}/></details>}<ul>{value.outputs.map(o=><li key={o.output_id}><span>{o.label} · {o.outcome?receiptNames[o.outcome]??o.outcome:'尚无写入回执'}{o.bytes_written!==null&&o.bytes_written!==undefined?` · ${o.bytes_written} 字节`:''} · {bodyReviewLabel(o.body_review)}</span><br/><code>{o.path}</code></li>)}</ul>
  <p className="small muted">这里显示历史写入记录。当前文件是否存在及内容，以任务中的本机预览为准；任务完成也不代表内容质量已通过验收。</p>
  <button className="secondary" data-open-agreement-task={schedule.schedule_id} disabled={disabled} onClick={openTask}>查看任务与产物</button>
 </section>;
}
