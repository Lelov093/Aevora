import {Select} from './controls';
import {useEffect,useState} from 'react';
import type {Run} from './tasks';
import type {Output} from './task-plan';
import {PlanView} from './task-plan';
import {ReportBody} from './markdown';
import {taskNames} from './task-result';

export function TaskHistory({taskId,runs,sources,outputs,multi}:{taskId:string;runs:Run[];sources:string[];outputs:Output[];multi:boolean}){
  const [id,setId]=useState(runs[0]?.run_id??'');
  useEffect(()=>setId(runs[0]?.run_id??''),[taskId,runs[0]?.run_id]);
  const run=runs.find(r=>r.run_id===id);
  return <section aria-label="执行历史"><h3>执行历史 · {runs.length} 次</h3>
    <label>回看一次执行<Select value={id} onChange={e=>setId(e.target.value)}>{runs.map((r,i)=><option key={r.run_id} value={r.run_id}>{new Date(r.created_at).toLocaleString()} · {taskNames[r.state]??r.state}{i===0?' · 最近一次':''}</option>)}</Select></label>
    {run&&<>
      <p className="small muted">历史记录不会改变当前任务、审批或回执。<br/><code>{run.run_id}</code></p>
      {run.reply&&<section><h4>此执行的结论原稿</h4><ReportBody id={'historical-reply-'+run.run_id} text={run.reply}/></section>}
      {run.error&&<p className="error">{run.error}</p>}
      {multi&&<PlanView steps={run.steps??[]} sources={sources} outputs={outputs}/>}
      <p className="small">模型：{run.metadata.model??(run.steps?.some(s=>s.metadata?.model)?'见各步骤':'未记录或尚未调用')} · 总 tokens：{run.metadata.usage?.total_tokens??'未知或未调用'}{run.context.context_stale?' · 上下文已失效':''}</p>
      {run.feedback&&!run.feedback.deleted&&<section><h4>此执行的用户反馈</h4><p>{run.feedback.quality==='Helpful'?'有帮助':run.feedback.quality==='NeedsRevision'?'需要修正':'尚未判断'}</p><blockquote>{run.feedback.note}</blockquote></section>}
      {run.action&&<section><h4>此执行的保存提案</h4><ReportBody id={'historical-body-'+run.run_id} text={run.action.body||'正文已因治理清除'}/>{run.action.receipt&&<p>历史写入回执：{run.action.receipt.outcome} · {run.action.receipt.bytes_written??'未知'} 字节{run.action.receipt.error?' · '+run.action.receipt.error:''}</p>}</section>}
    </>}
  </section>;
}
