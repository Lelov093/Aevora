import {useEffect,useState} from 'react';
import {CheckField} from './controls';
import {Modal} from './ui';
import {providerBinding,type Proposal,type Method} from './methods';
import type {Provider} from './chat';

export type TrialGrant={proposal_id:string;revision:number;provider:ReturnType<typeof providerBinding>;allow_outbound:true};
export type TrialRecord=TrialGrant&{title:string;method:Method};
export type ArmedTrial={title:string;grant:TrialGrant};

export function InteractionTrialDialog({value,provider,disabled,close,confirm}:{value:Proposal;provider:Provider;disabled:boolean;close:()=>void;confirm:(trial:ArmedTrial)=>void}){
 const [consent,setConsent]=useState(false);
 useEffect(()=>setConsent(false),[provider.base_url,provider.model,provider.revision,value.revision]);
 const method=value.method;
 return <Modal open close={close} title="候选策略试用一次" id="interaction-trial-dialog">
  <p>仅对下一次发送的回复加载此候选。发送后清除本次选择；历史仍保留，策略不会因此被正式采用。</p>
  {method&&<><h3>{method.title} · 版本 {value.revision}</h3><p>{method.applicability}</p><ol>{method.procedure.map((v,i)=><li key={i}>{v}</li>)}</ol><p>检查：{method.checks.join('；')}</p><p>依据：{method.rationale}</p><p>限制：{method.limits}</p></>}
  <p className="small muted">完整候选与这次正常对话上下文发送至 {provider.base_url} / {provider.model}，沿用当前单次用量上限。试用不授予工具权限，不自动记为评价通过；正式采用仍需独立评价与批准。</p>
  <label className="check"><CheckField id="interaction-trial-consent" checked={consent} onChange={e=>setConsent(e.target.checked)}/>允许下一次回复使用此候选</label>
  <button id="interaction-trial-arm" disabled={disabled||!consent||!method||value.state!=='Evaluating'||!provider.chat_allowed||!provider.credential_present} onClick={()=>confirm({title:method!.title,grant:{proposal_id:value.proposal_id,revision:value.revision,provider:providerBinding(provider),allow_outbound:true}})}>用于下一次回复</button>
 </Modal>;
}
