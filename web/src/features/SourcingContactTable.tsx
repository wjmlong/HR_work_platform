import {useEffect, useState} from 'react';
import {api} from '../lib/api';
import type {Row} from '../lib/state';
const types: Record<string,string>={person:'人物',account:'账号',team:'团队',institution:'机构'};
const names: Record<string,string>={email:'邮箱',phone:'电话',wechat:'微信',platform_dm:'私信入口',platform_virtual_phone:'平台虚拟号码'};
export default function SourcingContactTable({rows}:{rows:Row[]}) {
 return <div className="table-wrap discovery-contact-table"><table><caption>已核验线索 · 联系信息与可复制摘要</caption><thead><tr><th>主体 / 类型</th><th>专业方向与来源</th><th>联系信息</th><th>简历</th><th>整理与复制</th></tr></thead><tbody>{rows.map(row=><ContactRow key={row.id+':'+row.version+':'+row.contacts.map((c:Row)=>c.version).join(',')} row={row}/>)}</tbody></table>{!rows.length&&<p>暂无已核验线索。</p>}</div>;
}
function ContactRow({row}:{row:Row}) {
 const [contacts,setContacts]=useState<Row[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[status,setStatus]=useState('');
 useEffect(()=>{let alive=true;setContacts([]);if(row.do_not_contact){setLoading(false);return;}
 void Promise.all(row.contacts.map((c:Row)=>api<Row>('/sourcing/subjects/'+row.id+'/contacts/reveal',{method:'POST',body:{contactId:c.id}}))).then(r=>{if(alive)setContacts(r);}).catch(()=>{if(alive)setError('无法读取联系方式，请刷新或检查权限。');}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[row.id,row.version]);
 const value=(c:Row)=>c.data.value||c.data.entryUrl||'未提供';
 const state=(c:Row)=>c.availability==='invalid'?'已失效':c.availability==='needs_recheck'?'需重新核验':'已核验公开归属';
 const resumes=(row.jobs||[]).filter((j:Row)=>j.resume_version_id).map((j:Row)=>({id:j.resume_version_id,name:'简历原件（'+(j.job_name||'关联岗位')+'）',url:new URL('/api/v4/resumes/'+j.resume_version_id+'/file',window.location.origin).href}));
 const summary=['主体：'+row.display_name,'类型：'+(types[row.entity_type]||row.entity_type),'专业方向：'+((row.directions||[]).join('；')||'待补充'),'来源：'+row.profile_url,...contacts.flatMap(c=>[(names[c.data.type]||c.data.type)+'：'+value(c),'核验状态：'+state(c),'联系限制：'+(c.data.limitations?.join('；')||'未记录')]),...(resumes.length?resumes.map((r:Row)=>r.name+'：'+r.url+'（需登录并具备原件查看权限）'):['简历：暂无已关联简历文件']),'备注：仅整理线索；不代表已联系、求职意愿或录用结论。'].join('\n');
 async function copy(text:string,label:string){try{await navigator.clipboard.writeText(text);setStatus(label+'已复制');}catch{setStatus('复制失败，请选中下方文字手动复制。');}}
 return <tr><td><strong>{row.display_name}</strong><p>{types[row.entity_type]||row.entity_type}</p>{row.do_not_contact&&<p>不可再次联系</p>}</td><td>{(row.directions||[]).join('；')||'待补充'}<p><a href={row.profile_url} target="_blank" rel="noreferrer">查看原始来源</a></p></td><td>{row.do_not_contact?'已限制展示和复制':loading?'正在读取联系方式…':error||(!contacts.length?'尚无已核验联系信息':contacts.map(c=><div className="discovery-contact-value" key={c.id}><strong>{names[c.data.type]||c.data.type}</strong><p>{value(c)}</p><small>{state(c)}</small><p className="muted">{c.data.limitations?.join('；')}</p><button disabled={c.availability==='invalid'} onClick={()=>copy(value(c),'联系方式')}>复制联系方式</button></div>))}</td><td>{row.do_not_contact?'已限制展示':resumes.length?resumes.map((r:Row)=><div key={r.id}><a href={r.url} target="_blank" rel="noreferrer">下载{r.name}</a><p><button onClick={()=>copy(r.url,'简历下载链接')}>复制下载链接</button></p><small>下载需登录及原件权限</small></div>):<span>暂无已关联简历<br/><small>收到本人简历后，在下方跟进管理中交接；解析关联完成后显示下载。</small></span>}</td><td>{!row.do_not_contact&&!loading&&!error&&<><button onClick={()=>copy(summary,'线索摘要')}>复制线索摘要</button><details><summary>查看可复制内容</summary><textarea aria-label={row.display_name+' 线索摘要'} readOnly value={summary} rows={10}/></details></>}<p role="status">{status}</p></td></tr>;
}
