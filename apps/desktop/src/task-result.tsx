import {Markdown} from './markdown';
import type {Schedule} from './schedules';
import type {BodyReview} from './schedules';

export const bodyReviewLabel=(value?:BodyReview|null)=>value?`${value.editor==='user'?'人工编辑稿':'模型原稿'} · ${value.save_approved?'已批准保存':'尚未批准保存'}`:'尚无保存正文';

import {taskNames} from './work-state';
export {taskNames} from './work-state';
const receiptNames:Record<string,string>={Success:'有成功写入回执',Unknown:'写入结果未知 · 请核对',NotExecuted:'已确认未写入'};
export function TaskResult({schedule,disabled,openTask}:{schedule:Pick<Schedule,'schedule_id'|'task_id'|'task_result'>;disabled:boolean;openTask:()=>void}){
 const value=schedule.task_result;if(!value)return null;
 return <section className="agreement-result" data-agreement-result={schedule.schedule_id} data-task-state={value.state} aria-label="关联任务结果">
  <p className="small"><strong>关联任务：{taskNames[value.state]??value.state}</strong>{value.permission===0?' · 权限已撤销':''}{value.error?` · ${value.error}`:''}</p>
  {value.reply&&<details open><summary>结论或部分结果（模型原稿）</summary><Markdown text={value.reply}/></details>}<ul>{value.outputs.map(o=><li key={o.output_id}><span>{o.label} · {o.outcome?receiptNames[o.outcome]??o.outcome:'尚无写入回执'}{o.bytes_written!==null&&o.bytes_written!==undefined?` · ${o.bytes_written} 字节`:''} · {bodyReviewLabel(o.body_review)}</span><br/><code>{o.path}</code></li>)}</ul>
  <p className="small muted">这里显示历史写入记录。当前文件是否存在及内容，以任务中的本机预览为准；任务完成也不代表内容质量已通过验收。</p>
  <button className="secondary" data-open-agreement-task={schedule.schedule_id} disabled={disabled} onClick={openTask}>查看任务与产物</button>
 </section>;
}
