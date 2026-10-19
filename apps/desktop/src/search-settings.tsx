import {useState} from 'react';
import type {Execute} from './chat';
import type {Search} from './network-tasks';
import {SettingSection} from './settings-workspace';

export function SearchSettings({search,disabled,execute}:{search?:Search;disabled:boolean;execute:Execute}){
  const [key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function configure(allowed:boolean){
    setBusy(true);setError('');setNotice('');
    try{await execute({protocol_version:1,command_id:crypto.randomUUID(),type:'ConfigureSearch',expected_revision:search?.revision??0,payload:{allowed,api_key:key}});setKey('');setNotice(allowed?'搜索配置与用途已保存，尚未发起查询。':'已撤销搜索用途。');}
    catch(e){try{setError(JSON.parse(String(e)).error.message);}catch{setError(String(e));}}
    finally{setBusy(false);}
  }
  return <section className="settings-section search-settings"><SettingSection title="公开搜索连接" description="Tavily Search；具体查询仍在工作中审阅。" status={search?.allowed?'已允许搜索用途':'未授权'}>
    <p className="settings-caption">当前连接：{search?.endpoint||'由 Host 配置的 Tavily 服务'}；凭据{search?.credential_present?'已由本机 Host 保管':'未配置'}。</p>
    <label className="settings-field">搜索 API Key<input id="settings-search-key" type="password" autoComplete="off" value={key} placeholder={search?.credential_present?'留空保留现有凭据':'填写 Tavily Key'} onChange={e=>setKey(e.target.value)}/></label>
    <div className="settings-authorization"><p><strong>发送范围</strong> · 仅批准的查询。每项联网研究最多 3 次 basic 搜索（含重试），每次 5 个候选。</p><p>保存用途不会立即查询，具体请求仍在工作中确认。</p>
    <div className="actions"><button disabled={disabled||busy||(!search?.credential_present&&!key.trim())} onClick={()=>void configure(true)}>保存并允许搜索用途</button><button className="secondary" disabled={disabled||busy||!search?.allowed} onClick={()=>void configure(false)}>撤销搜索用途</button></div></div>
  {error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}</SettingSection></section>;
}
