import {budgetLabel} from './budget-field';
import {useEffect,useState} from 'react';
import type {Snapshot} from './main';
import {speechAction,type SpeechView} from './voice';
import {SettingSection,type SettingsPage} from './settings-workspace';

export function PermissionsOverview({snapshot,active,openPage,openWork}:{snapshot:Snapshot;active:boolean;openPage:(page:SettingsPage)=>void;openWork:()=>void}){
  const {provider,extraction,embedding,search,proactivity}=snapshot;
  const [speech,setSpeech]=useState<SpeechView|undefined>(snapshot.speech),[speechError,setSpeechError]=useState('');
  useEffect(()=>{if(!active)return;let current=true;void speechAction<SpeechView>('snapshot').then(value=>{if(current){setSpeech(value);setSpeechError('');}}).catch(e=>{if(current){setSpeech(undefined);setSpeechError(String(e));}});return()=>{current=false;};},[active]);
  const purposes=[
    {title:'对话',allowed:provider.chat_allowed,destination:provider.base_url,detail:`单次输入估算上限 ${budgetLabel(provider.max_input_tokens,provider.chat_input_unlimited)} · 输出上限 ${budgetLabel(provider.max_output_tokens,provider.chat_output_unlimited)}`,page:'provider' as const},
    {title:'记忆提取',allowed:extraction?.extraction_allowed,destination:extraction?.base_url,detail:`本授权已开始 ${extraction?.calls_started??0} / ${budgetLabel(extraction?.max_calls,extraction?.calls_unlimited)} 次`,page:'memory' as const},
    {title:'记忆索引与召回',allowed:embedding?.embedding_allowed,destination:embedding?.base_url,detail:`本授权已开始 ${embedding?.calls_started??0} / ${budgetLabel(embedding?.max_calls,embedding?.calls_unlimited)} 次 · 输入估算 ${embedding?.input_estimate_used??0} / ${budgetLabel(embedding?.max_total_input_tokens,embedding?.input_unlimited)}`,page:'memory' as const},
    {title:'候选相关性筛选',allowed:embedding?.selection?.selection_allowed,destination:embedding?.selection?.base_url,detail:`本授权已开始 ${embedding?.selection?.calls_started??0} / ${budgetLabel(embedding?.selection?.max_calls,embedding?.selection?.calls_unlimited)} 次`,page:'memory' as const},
    {title:'公开搜索',allowed:search?.allowed,destination:search?.endpoint,detail:'每项工作的搜索范围和调用预算另行确认。',page:'provider' as const},
    {title:'语音输入',allowed:speech?.config.asr.enabled,destination:speech?.config.endpoint??speech?.config.region,detail:speech?`已开始 ${speech.config.asr.calls_started} 次 · 已提交 ${Math.ceil(speech.config.asr.units_submitted)} 秒`:'请到语音设置查看最新状态与预算。',page:'voice' as const,unknown:!speech},
    {title:'回复朗读',allowed:speech?.config.tts.enabled,destination:speech?.config.endpoint??speech?.config.region,detail:speech?`已开始 ${speech.config.tts.calls_started} 次 · 已提交 ${speech.config.tts.units_submitted} 字符`:'请到语音设置查看最新状态与预算。',page:'voice' as const,unknown:!speech}
  ];
  return <section className="settings-section permissions-overview"><h2>权限与预算</h2><p className="muted">统一查看用途状态，授权与撤销仍在对应配置中确认。</p>
    {speechError&&<p className="error" role="alert">语音用途状态暂不可用：{speechError}</p>}
    <div className="permission-list">{purposes.map(p=><div className="permission-row" key={p.title}><div><h3>{p.title}<span className="badge">{p.unknown?'待查看':p.allowed?'已开启':'未开启'}</span></h3><p>{p.detail}</p>{p.destination&&<small>{p.destination}</small>}</div><button className="secondary" onClick={()=>openPage(p.page)}>管理</button></div>)}</div>
    <SettingSection title="主动帮助" description="观察、模型思考和通知分别授权。" status={proactivity?.settings.observe?'已开启观察':'未开启观察'}><p>每日模型判断上限 {proactivity?.settings.max_daily_calls??0} 次；通知上限 {proactivity?.settings.max_daily_notifications??0} 次。实际行动仍需明确授权。</p><button className="secondary" onClick={()=>openPage('proactivity')}>管理主动帮助</button></SettingSection>
    <div className="settings-footer"><p className="small muted">资源与长期执行的权限、期限和总预算属于具体工作；本页不授予行动权限。计数不等于服务商余额，失败与未知用量保留在原记录中。</p><button className="secondary" onClick={openWork}>查看事项权限与执行记录</button></div>
  </section>;
}
