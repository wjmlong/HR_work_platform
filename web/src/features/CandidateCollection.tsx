import {useEffect,useState} from 'react';
import {api,query} from '../lib/api';
import {useApp,useDebounced,useResource,Resource,date,type Row} from '../lib/state';
import {PageHeader,Panel,Pagination,Empty,Dialog} from '../components/ui';
import {NameCell,MatchCell,ResumeCell} from '../components/cells';
import './candidate-collection.css';
import MailboxUpdateButton from './MailboxUpdateButton';
import ConfiguredForm from '../components/business/ConfiguredForm';

export default function CandidateCollection({lifecycle}:{lifecycle:'inbox'|'archive'}) {
 const {revision,openPerson,canManage,canWrite,refresh,notify}=useApp();
 const [text,setText]=useState(''),[page,setPage]=useState(1),[deleted,setDeleted]=useState(false),search=useDebounced(text);
 const [thresholdOpen,setThresholdOpen]=useState(false);
 const [threshold,setThreshold]=useState(60),[preview,setPreview]=useState<Row|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[resultText,setResultText]=useState('');
 const [missingContact,setMissingContact]=useState(false),[eduFilter,setEduFilter]=useState(''),[intentFilter,setIntentFilter]=useState('');
 const result=useResource<Row>(s=>query('/candidates/query',{query:search,lifecycle,page,deleted},s),[search,lifecycle,page,deleted,revision]);
 const inbox=lifecycle==='inbox';
 const allPeople:Row[]=result.data?.items||[];
 const matchingPending=inbox&&allPeople.some(p=>p.inboxMatch?.reason==='matching_pending');
 useEffect(()=>{if(!matchingPending)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')result.reload();},15000);return()=>clearInterval(timer);},[matchingPending,result.reload]);
 const missingCount=allPeople.filter(p=>!p.profile?.phone&&!p.profile?.email).length;
 const positionLabel=(p:Row)=>inbox?(p.inboxMatch?.jobName?p.inboxMatch.jobName+'（'+p.inboxMatch.label+'）':'岗位待确认'):String(p.profile?.intent||'岗位待确认');
 const intents=[...new Set(allPeople.map(positionLabel))].sort();
 const people=allPeople.filter(p=>{
  if(missingContact&&(p.profile?.phone||p.profile?.email))return false;
  if(eduFilter==='empty'&&p.profile?.education)return false;
  if(eduFilter&&eduFilter!=='empty'&&p.profile?.education!==eduFilter)return false;
  if(intentFilter&&positionLabel(p)!==intentFilter)return false;
  return true;
 });

 const runPreview=async()=>{
  if(!canWrite)return;
  setBusy(true);
  try{
   const p=await api<Row>('/candidates/matching/preview',{method:'POST',body:{threshold:Number(threshold)}});
   setPreview(p);setSelected((p.items||[]).map((x:Row)=>x.candidateId));setResultText('');
  }catch(e){notify((e as Error).message,true);}finally{setBusy(false);}
 };
 const adopt=async(body:Row)=>{
  if(!preview||!canWrite)return;
  if(!body.source)throw Error('请选择招聘来源');
  const rows=(preview.items||[]).filter((x:Row)=>selected.includes(x.candidateId));
  if(!rows.length){notify('没有勾选任何候选人',true);return;}
  setBusy(true);
  let ok=0,configurationError:unknown;const errors:string[]=[],completed:string[]=[];
  for(const r of rows){
   try{
    await api('/applications',{method:'POST',body:{...body,candidateId:r.candidateId,jobId:r.jobId,resumeVersionId:r.resumeVersionId,inboxMatchHash:r.inboxMatchHash}});
    ok++;completed.push(r.candidateId);
   }catch(e){errors.push(String(r.name)+'：'+(e as Error).message);if((e as {code?:string}).code==='configuration_changed'){configurationError=e;break;}}
  }
  setBusy(false);setPreview(errors.length?{...preview,items:preview.items.filter((r:Row)=>!completed.includes(r.candidateId))}:null);setSelected(s=>s.filter(id=>!completed.includes(id)));
  setResultText('已加入待筛选 '+ok+' 人'+(errors.length?'；失败 '+errors.length+' 人（'+errors.slice(0,3).join(' / ')+'）':''));
  refresh();result.reload();notify('已完成：'+ok+' 人进入待筛选');
  if(configurationError)throw configurationError;
 };

 return <>
   <PageHeader title={inbox?'简历收件箱':'人才库／历史档案'} description={inbox?'按来信与简历匹配在招岗位；点开可查看依据并处理':'查询已结束的招聘经历'}>
   {inbox&&<><a className="button" href="#inbox/mailbox">原始来信</a><a className="button" href="#upload">待处理资料</a>{canWrite&&<MailboxUpdateButton/>}</>}
  </PageHeader>
  <div className="collection-controls"><div className="collection-search">
   <input aria-label="搜索收件人员" placeholder="搜索姓名 / 技能 / 院校" value={text} onChange={e=>{setText(e.target.value);setPage(1);}}/>
   {inbox&&canWrite&&<div className="collection-preview"><button disabled={busy} aria-expanded={thresholdOpen} onClick={()=>setThresholdOpen(!thresholdOpen)}>按匹配分预览（≥{threshold}%）</button>{thresholdOpen&&<div className="collection-threshold"><label>匹配阈值（%）<input aria-label="匹配阈值" type="number" min={0} max={100} value={threshold} onChange={e=>setThreshold(Math.max(0,Math.min(100,Number(e.target.value))))}/></label><button disabled={busy} onClick={()=>{setThresholdOpen(false);void runPreview();}}>预览并选择流转</button></div>}</div>}
   {!inbox&&<a className="button" href="#people?mode=applications">查询全部岗位申请</a>}
  </div><div className="collection-filters">
   <label className="check"><input type="checkbox" checked={missingContact} onChange={e=>setMissingContact(e.target.checked)}/>只看缺联系方式（{missingCount}）</label>
   <label className="check">学历<select value={eduFilter} onChange={e=>setEduFilter(e.target.value)}><option value="">全部</option><option value="doctor">博士</option><option value="master">硕士</option><option value="bachelor">本科</option><option value="associate">大专</option><option value="empty">未识别</option></select></label>
   <label className="check">{inbox?'岗位匹配':'意向岗位'}<select aria-label={inbox?'筛选匹配岗位':'筛选意向岗位'} value={intentFilter} onChange={e=>setIntentFilter(e.target.value)}><option value="">全部</option>{intents.map(v=><option key={v} value={v}>{v}</option>)}</select></label>
   <button className="collection-clear" onClick={()=>{setText("");setMissingContact(false);setEduFilter("");setIntentFilter("");setDeleted(false);setPage(1);}}>清除筛选</button>
   {canManage&&<label className="check"><input type="checkbox" checked={deleted} onChange={e=>{setDeleted(e.target.checked);setPage(1);}}/>回收记录</label>}

  </div>
  </div>
  <small className="muted">联系方式、学历与岗位筛选仅作用于当前页</small>
  {resultText&&<p className="notice">{resultText}</p>}
  <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
   <Panel><div className="table-scroll"><table className="inbox-table"><colgroup><col className="c-name"/><col className="c-match"/><col className="c-resume"/><col className="c-time"/><col className="c-action"/></colgroup><thead><tr><th>姓名</th><th>{inbox?'岗位匹配':'意向岗位'}</th><th>简历信息</th><th>{inbox?'收录时间':'留档说明'}</th><th>操作</th></tr></thead><tbody>
    {people.map((person:Row)=><tr key={person.id}><td><NameCell profile={person.profile}/></td><td><MatchCell person={person} inbox={inbox}/></td><td><ResumeCell profile={person.profile}/></td><td className="collection-time">{inbox?<time dateTime={person.created_at}>{date(person.created_at).split(' ')[0]}<small>{date(person.created_at).split(' ')[1]}</small></time>:person.archive_reason||'—'}</td><td>{deleted?<a className="button" href="#people?mode=people">查看回收与恢复</a>:<button onClick={()=>openPerson(person.id)}>查看简历与处理</button>}</td></tr>)}
</tbody></table></div>
   {!people.length&&<Empty>{allPeople.length?'没有符合筛选条件的简历':'暂无待查看的简历'}</Empty>}
   <Pagination page={page} total={result.data?.total||0} onChange={setPage}/>
   </Panel>
  </Resource>
  {preview&&<Dialog title={'匹配预览 · 阈值 '+preview.threshold+'%'} onClose={()=>setPreview(null)} wide>
   <p className="notice"><strong>达到阈值 {preview.items?.length||0} 人</strong><i className="info-tip" title={'扫描收件箱 '+preview.scanned+' 份简历；对明确意向或AI推荐的有效岗位计算 '+preview.scored+' 份规则匹配分。岗位待确认的简历留在收件箱。推荐依据来自来信与简历；匹配分沿用岗位规则，不是AI置信度。'}>i</i> 确认后才会创建岗位申请并进入「待筛选」。</p>
   <div className="table-scroll"><table><thead><tr><th>选择</th><th>姓名</th><th>期望职位</th><th>匹配岗位</th><th>匹配分</th><th>匹配依据</th></tr></thead><tbody>
    {(preview.items||[]).map((x:Row)=><tr key={x.candidateId}>
     <td><input type="checkbox" checked={selected.includes(x.candidateId)} onChange={e=>setSelected(s=>e.target.checked?[...s,x.candidateId]:s.filter(v=>v!==x.candidateId))}/></td>
     <td>{x.name}</td><td>{x.intent||'—'}</td><td>{x.jobName}</td><td><strong>{x.score}%</strong></td><td><small>{x.matchBasis}</small></td>
    </tr>)}
   </tbody></table></div>
   {!preview.items?.length&&<Empty>没有达到阈值的简历，可把阈值调低后再预览</Empty>}
   {canWrite&&selected.length>0&&<ConfiguredForm kind="application" mode="create" core={{}} submit={'确认将 '+selected.length+' 人加入待筛选'} onCancel={()=>setPreview(null)} onSubmit={adopt}><p className="muted">所选招聘来源及申请字段将用于本次勾选的人员。</p></ConfiguredForm>}
  </Dialog>}
 </>;
}
