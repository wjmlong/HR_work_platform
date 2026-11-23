import {useState} from 'react';
import {api,query,downloadCsv} from '../lib/api';
import {useApp,useDebounced,useResource,Resource,date,edu,type Row} from '../lib/state';
import {PageHeader,Panel,Pagination,Empty,Tags,Dialog} from '../components/ui';
import MailboxUpdateButton from './MailboxUpdateButton';

export default function CandidateCollection({lifecycle}:{lifecycle:'inbox'|'archive'}) {
 const {revision,openPerson,canManage,refresh,notify}=useApp();
 const [text,setText]=useState(''),[page,setPage]=useState(1),[deleted,setDeleted]=useState(false),search=useDebounced(text);
 const [threshold,setThreshold]=useState(60),[preview,setPreview]=useState<Row|null>(null),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[resultText,setResultText]=useState('');
 const [missingContact,setMissingContact]=useState(false),[eduFilter,setEduFilter]=useState(''),[intentFilter,setIntentFilter]=useState('');
 const result=useResource<Row>(s=>query('/candidates/query',{query:search,lifecycle,page,deleted},s),[search,lifecycle,page,deleted,revision]);
 const inbox=lifecycle==='inbox';
 const allPeople:Row[]=result.data?.items||[];
 const missingCount=allPeople.filter(p=>!p.profile?.phone&&!p.profile?.email).length;
 const intents=[...new Set(allPeople.map(p=>String(p.profile?.intent||'岗位待确认').slice(0,20)))].sort();
 const people=allPeople.filter(p=>{
  if(missingContact&&(p.profile?.phone||p.profile?.email))return false;
  if(eduFilter==='empty'&&p.profile?.education)return false;
  if(eduFilter&&eduFilter!=='empty'&&p.profile?.education!==eduFilter)return false;
  if(intentFilter&&String(p.profile?.intent||'岗位待确认').slice(0,20)!==intentFilter)return false;
  return true;
 });

 const runPreview=async()=>{
  setBusy(true);
  try{
   const p=await api<Row>('/candidates/matching/preview',{method:'POST',body:{threshold:Number(threshold)}});
   setPreview(p);setSelected((p.items||[]).map((x:Row)=>x.candidateId));setResultText('');
  }catch(e){notify((e as Error).message,true);}finally{setBusy(false);}
 };
 const adopt=async()=>{
  if(!preview)return;
  const rows=(preview.items||[]).filter((x:Row)=>selected.includes(x.candidateId));
  if(!rows.length){notify('没有勾选任何候选人',true);return;}
  setBusy(true);
  let ok=0;const errors:string[]=[];
  for(const r of rows){
   try{
    await api('/applications',{method:'POST',body:{candidateId:r.candidateId,jobId:r.jobId,resumeVersionId:r.resumeVersionId,source:'收件箱匹配'}});
    ok++;
   }catch(e){errors.push(String(r.name)+'：'+(e as Error).message);}
  }
  setBusy(false);setPreview(null);
  setResultText('已加入待筛选 '+ok+' 人'+(errors.length?'；失败 '+errors.length+' 人（'+errors.slice(0,3).join(' / ')+'）':''));
  refresh();result.reload();notify('已完成：'+ok+' 人进入待筛选');
 };

 return <>
  <PageHeader title={inbox?'简历收件箱':'人才库／历史档案'} description={inbox?'查看新收简历并确认岗位':'查询已结束的招聘经历'}>
   {inbox&&<MailboxUpdateButton/>}
  </PageHeader>
  <div className="toolbar section-toolbar">
   <input aria-label="搜索收件人员" placeholder="搜索姓名 / 技能 / 院校" value={text} onChange={e=>{setText(e.target.value);setPage(1);}}/>
   {inbox&&<>
    <label className="check">匹配阈值 <input type="number" min={0} max={100} value={threshold} onChange={e=>setThreshold(Number(e.target.value))} style={{width:72}}/> %</label>
    <button disabled={busy} onClick={()=>void runPreview()}>{busy?'计算中…':'按匹配分预览并流转'}</button>
    <a className="button" href="#mailbox">原始来信</a><a className="button" href="#upload">待处理资料</a>
   </>}
   {!inbox&&<a className="button" href="#people?mode=applications">查询全部岗位申请</a>}
   <label className="check"><input type="checkbox" checked={missingContact} onChange={e=>setMissingContact(e.target.checked)}/>只看缺联系方式（{missingCount}）</label>
   <label className="check">学历<select value={eduFilter} onChange={e=>setEduFilter(e.target.value)}><option value="">全部</option><option value="doctor">博士</option><option value="master">硕士</option><option value="bachelor">本科</option><option value="associate">大专</option><option value="empty">未识别</option></select></label>
   <label className="check">意向岗位<select value={intentFilter} onChange={e=>setIntentFilter(e.target.value)}><option value="">全部</option>{intents.map(v=><option key={v} value={v}>{v}</option>)}</select></label>
   {canManage&&<label className="check"><input type="checkbox" checked={deleted} onChange={e=>{setDeleted(e.target.checked);setPage(1);}}/>回收记录</label>}
   <button className="small" onClick={()=>downloadCsv((inbox?'简历收件箱':'人才库')+'-当前筛选结果.csv',[
    ['姓名','意向岗位','联系方式','学历','院校','技能','收录时间','留档说明'],
    ...people.map((p:Row)=>[p.profile.name,p.profile.intent||'',p.profile.phone||p.profile.email||'',edu(p.profile.education),p.profile.school||'',(p.profile.skills||[]).join('、'),date(p.created_at),p.archive_reason||''])
   ])}>导出当前结果 CSV</button>
  </div>
  {resultText&&<p className="notice">{resultText}</p>}
  <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
   <Panel><div className="table-scroll"><table><thead><tr><th>姓名</th><th>意向岗位</th><th>简历信息</th><th>{inbox?'收录时间':'留档说明'}</th><th>操作</th></tr></thead><tbody>
    {people.map((person:Row)=><tr key={person.id}><td>{person.profile.name}<small>{person.profile.phone||person.profile.email||'联系方式未提供'}</small></td><td>{person.profile.intent||'岗位待确认'}</td><td>{edu(person.profile.education)} · {person.profile.school||'院校未注明'}<Tags values={person.profile.skills?.slice(0,3)}/></td><td>{inbox?date(person.created_at):person.archive_reason||'查看档案中的招聘结果'}</td><td>{deleted?<a className="button" href="#people?mode=people">查看回收与恢复</a>:<button onClick={()=>openPerson(person.id)}>查看简历与处理</button>}</td></tr>)}
   </tbody></table></div>
   {!people.length&&<Empty>{allPeople.length?'没有符合筛选条件的简历':'暂无待查看的简历'}</Empty>}
   <Pagination page={page} total={result.data?.total||0} onChange={setPage}/>
   </Panel>
  </Resource>
  {preview&&<Dialog title={'匹配预览 · 阈值 '+preview.threshold+'%'} onClose={()=>setPreview(null)} wide>
   <p className="notice"><strong>达到阈值 {preview.items?.length||0} 人</strong><i className="info-tip" title={'扫描收件箱 '+preview.scanned+' 份简历；按「期望职位同名岗位」算出 '+preview.scored+' 份匹配分；没写意向或匹配不到同名岗位的 '+(Number(preview.skippedNoIntent||0)+Number(preview.skippedNoJob||0))+' 份留在收件箱，不自动推进。确认后才会创建岗位申请并进入「待筛选」'}>i</i> 确认后才会创建岗位申请并进入「待筛选」。</p>
   <div className="table-scroll"><table><thead><tr><th>选择</th><th>姓名</th><th>期望职位</th><th>匹配岗位</th><th>匹配分</th><th>匹配依据</th></tr></thead><tbody>
    {(preview.items||[]).map((x:Row)=><tr key={x.candidateId}>
     <td><input type="checkbox" checked={selected.includes(x.candidateId)} onChange={e=>setSelected(s=>e.target.checked?[...s,x.candidateId]:s.filter(v=>v!==x.candidateId))}/></td>
     <td>{x.name}</td><td>{x.intent||'—'}</td><td>{x.jobName}</td><td><strong>{x.score}%</strong></td><td><small>{x.matchBasis}</small></td>
    </tr>)}
   </tbody></table></div>
   {!preview.items?.length&&<Empty>没有达到阈值的简历，可把阈值调低后再预览</Empty>}
   <div className="toolbar">
    <button className="primary" disabled={busy||!selected.length} onClick={()=>void adopt()}>{busy?'处理中…':'确认将 '+selected.length+' 人加入待筛选'}</button>
    <button disabled={busy} onClick={()=>setPreview(null)}>取消</button>
   </div>
  </Dialog>}
 </>;
}
