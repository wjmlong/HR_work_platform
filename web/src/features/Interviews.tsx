import CalendarSync from './CalendarSync';
import {InterviewAccess} from './InterviewAccess';
import DirectoryPicker,{type DirectoryMember} from '../components/DirectoryPicker';
import FeishuSchedulePrompt from './FeishuSchedulePrompt';
import InterviewAssistant from './InterviewAssistant';
import InterviewReviewDialog, {EvidenceTags, useInterviewEvidence} from './InterviewReview';
import {EvaluationRecordedFields} from '../components/business/FieldHistory';
import ObjectTemplateUpgrade from './business-config/ObjectTemplateUpgrade';import {evaluationDimensions,evaluationScores,missingEvaluationDimension,refLabel,templateModeLabel} from '../lib/template-ui';
import FieldViewSwitch from '../components/business/FieldViewSwitch';
import ConfiguredForm from "../components/business/ConfiguredForm";
import MemberPicker from "../components/MemberPicker";
import { useEffect, useState } from "react";
import ApplicationPicker from "../components/ApplicationPicker";
import { api, query, downloadCsv } from "../lib/api";
import InterviewCalendar from "./InterviewCalendar";
import {
  useApp,
  useResource,
  Resource,
  useDebounced,
  date,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  Dialog,
  Field,
  Form,
  values,
  Empty,
  Pagination,
} from "../components/ui";
const states: Record<string, string> = {
  pending: "待进行",
  passed: "已通过",
  failed: "未通过",
  cancelled: "已取消",
  no_show: "爽约／未到场",
  legacy_completed: "历史已完成（结果待补录）",
};
const dims = [
  ["professional", "专业能力"],
  ["communication", "沟通表达"],
  ["logicalThinking", "逻辑思维"],
  ["culturalFit", "文化匹配"],
];
const conclusions: Record<string, string> = {
  strong_yes: "强烈推进",
  yes: "推进",
  hold: "待定",
  no: "不推进",
};
function InterviewsNative({
  evaluate = false,
  initialMine = false,
  onReview,
}: {
  evaluate?: boolean;
  initialMine?: boolean;
  onReview?: (id: string) => void;
}) {
  const { revision, refresh, notify, user, canWrite, openApplication, isAdmin } =
      useApp(),
    [access,setAccess]=useState<Row|null>(null),
    [assistant, setAssistant] = useState<Row | null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [removal,setRemoval]=useState<Row|null>(null),
    [deleted,setDeleted]=useState(false),
    [evaluation, setEvaluation] = useState<Row | null>(null),
    [history, setHistory] = useState<Row[] | null>(null),
    [text, setText] = useState(""),
    [page, setPage] = useState(1),
    [view, setView] = useState<"list" | "week">("list"),
    [mineOnly, setMineOnly] = useState(initialMine && !evaluate),
    search = useDebounced(text);
  const data = useResource<Row>(
    (s) => query("/interviews/query", { query: search, page, deleted }, s),
    [search, page, deleted, revision],
  );
  async function versions(i: Row) {
    try {
      const list = await api<Row[]>(
        "/applications/" + i.application_id + "/evaluation-history",
      );
      setHistory(
        (
          await Promise.all(
            list
              .filter((e) => e.interview_id === i.id)
              .map((e) => api<Row[]>("/evaluations/" + e.id + "/versions")),
          )
        ).flat(),
      );
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const shown = (data.data?.items || []).filter((i: Row) =>
    !mineOnly || (i.status !== "cancelled" && !deleted &&
      (i.primary_interviewer_id === user.id || i.interviewer_ids?.includes(user.id))));
  return (
    <>
      <PageHeader
        title={evaluate ? "面试评估" : "面试安排"}
        description={evaluate ? "填写面试评分与评估意见" : "安排面试日程与主责面试官"}
      >
        {canWrite && !evaluate && (
          <button className="primary" onClick={() => setEdit({})}>
            ＋ 安排面试
          </button>
        )}
        {!evaluate && <>
          <button className={view === "list" ? "primary small" : "small"} onClick={() => setView("list")}>列表</button>
          {!mineOnly&&<button className={view === "week" ? "primary small" : "small"} onClick={() => setView("week")}>周日历</button>}
          <button className="small" onClick={() => downloadCsv("面试安排-当前页.csv", [
            ["候选人", "岗位", "轮次", "开始时间", "时长(分钟)", "形式", "地点", "状态", "主责面试官"],
            ...shown.map((i: Row) => [i.candidate_name, i.job_name, i.round, i.starts_at,
              i.duration_minutes, i.form, i.location, i.status, i.primary_interviewer_name || ""]),
          ])}>导出 CSV</button>
        </>}
      </PageHeader>
      {isAdmin&&!evaluate&&!mineOnly&&<CalendarSync/>}
      <div className="interview-search">
      <Field label="检索面试候选人或岗位">
      <input
        aria-label="检索面试候选人或岗位"
        placeholder={evaluate ? "检索待评估面试" : "检索全部面试安排"}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPage(1);
        }}
      />
      </Field>
      {!evaluate && <div className="toolbar interview-tabs">
        <button className={!mineOnly ? "primary small" : "small"} onClick={() => { setMineOnly(false); setPage(1); }}>全部面试</button>
        <button className={mineOnly ? "primary small" : "small"} onClick={() => { setMineOnly(true); setDeleted(false); setView("list"); setPage(1); }}>待我评估</button>
        {canWrite&&!mineOnly&&<label className="check"><input type="checkbox" checked={deleted} onChange={e=>{setDeleted(e.target.checked);setPage(1);}}/>回收记录</label>}
      </div>}
      </div>
      <Panel>
        <Resource {...data} preserve={data.data!==undefined} retry={data.reload}>
          {view === "week" && !evaluate && !mineOnly ? <InterviewCalendar items={shown} onPick={(i) => setEdit(i)} /> : <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>候选人 / 岗位</th>
                  <th>轮次 / 时间</th>
                  <th>时长 / 形式</th>
                  <th>状态</th>
                  <th>主责面试官</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i: Row) => (
                  <tr key={i.id}>
                    <td>
                      {i.candidate_name}
                      <small>{i.job_name}</small>
                    </td>
                    <td>
                      第 {i.round} 轮<small>{date(i.starts_at)}</small>
                    </td>
                    <td>
                      {i.duration_minutes} 分钟 · {i.form}
                      <small>
                        {i.location}
                        {i.meeting_url && (
                          <a
                            href={i.meeting_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            会议链接
                          </a>
                        )}
                      </small>
                    </td>
                    <td>
                      <span className={"status " + i.status}>
                        {states[i.status] || i.status}
                      </span>
                    </td>
                    <td>
                      {i.primary_interviewer_name || "待补录"}
                      <small>{i.interviewer_ids?.length || 0} 位参与者</small>
                    </td>
                    <td>
                      <div className="toolbar">
                        {isAdmin&&!deleted&&!mineOnly&&<button onClick={()=>setAccess(i)}>本场临时权限</button>}
                        <button
                          onClick={() => openApplication(i.application_id)}
                        >
                          候选人
                        </button>
                        {!deleted&&canWrite && !evaluate && !mineOnly && (
                          <button onClick={() => setEdit(i)}>编辑安排</button>
                        )}
                        <button
                          className={evaluate || mineOnly ? "primary" : ""}
                          disabled={
                            deleted || i.status === "cancelled" ||
                            (!canWrite && i.primary_interviewer_id !== user.id)
                          }
                          onClick={() => setEvaluation(i)}
                        >
                          主责评估 / 打分
                        </button>
                        {!deleted&&!canWrite &&(mineOnly || evaluate) &&
                          i.interviewer_ids?.includes(user.id) &&
                          i.primary_interviewer_id !== user.id && (
                            <button
                              onClick={() =>
                                setEvaluation({ ...i, personal: true })
                              }
                            >
                              本人补充意见
                            </button>
                          )}
                        {!deleted&&i.status !== "cancelled" && (canWrite || i.interviewer_ids?.includes(user.id)) && <button onClick={()=>setAssistant(i)}>AI 辅助面试</button>}
                        {onReview&&!deleted&&i.status !== "cancelled"&&(mineOnly || evaluate)&&<button onClick={()=>onReview(i.id)}>上下文与输出自查</button>}
                        {(mineOnly || evaluate)&&<button onClick={() => void versions(i)}>
                          评估历史
                        </button>}
                        {canWrite&&!evaluate&&!mineOnly&&<button onClick={()=>setRemoval(i)}>{deleted?"恢复安排":"删除安排"}</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty>{mineOnly ? "当前没有待我评估的面试" : "尚无面试安排"}</Empty>}
          </div>
          {mineOnly ? <p className="hint">待我评估：共 {shown.length} 场（当前页）</p> : <Pagination
            page={page}
            total={data.data?.total || 0}
            onChange={setPage}
          />}
          </>}
        </Resource>
      </Panel>
      {removal&&<Dialog title={deleted?'恢复面试安排':'删除误建面试安排'} onClose={()=>setRemoval(null)}>
        <Form submit={deleted?'确认恢复':'移入回收记录'} onCancel={()=>setRemoval(null)} onSubmit={async()=>{
          await api('/interviews/'+removal.id+'/delete',{method:'POST',body:{version:removal.version,restore:deleted}});
          setRemoval(null);setPage(1);refresh();notify(deleted?'面试安排已恢复':'已移入回收记录');
        }}>
          <p>{removal.candidate_name} · 第 {removal.round} 轮 · {date(removal.starts_at)}</p>
          <p>{deleted?'恢复后重新显示这场面试，原有评估记录仍保留。':'从面试安排中移除，可在“回收记录”恢复。候选人、招聘流程和已有评估不会删除。'}</p>
          <p>已开启共享日历同步时，删除会同步取消日程并撤销临时权限；恢复不会自动重新授权或补发邀请。</p>
        </Form>
      </Dialog>}
      {access&&<InterviewAccess interview={access} onClose={()=>setAccess(null)}/>}
      {assistant && <InterviewAssistant interview={assistant} onClose={()=>setAssistant(null)}/>}
      {edit && (
        <Schedule
          edit={edit}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
          }}
        />
      )}
      {evaluation && (
        <Evaluation
          defaultDraft={evaluate}
          interview={evaluation}
          onClose={() => setEvaluation(null)}
          onDone={() => {
            setEvaluation(null);
            refresh();
          }}
        />
      )}
      {history && (
        <Dialog title="评估历史版本" onClose={() => setHistory(null)} wide>
          {history.length ? (
            history.map((h) => (
              <Panel
                key={h.evaluation_id + ":" + h.version}
                title={`${h.author_name || "面试官"} · v${h.version} · ${h.status === "draft" ? "草稿" : "已提交"} · ${date(h.at)}`}
              >
                <small>实际录入：{h.editor_name || "历史未记录"} · {h.template?.label||h.configuration_refs?.evaluationTemplate?.document?.label||"历史默认四维"} · {refLabel(h.template?.ref||h.configuration_refs?.evaluationTemplate?.ref)}</small>
                <p>
                  {(h.template?.dimensions||h.configuration_refs?.evaluationTemplate?.document?.dimensions||dims.map(([id,label])=>({id,label,active:true}))).filter((d:any)=>d.active).map((d:any)=>[d.id,d.label])
                    .map(
                      ([key, label]:string[]) => label + " " + (h.data.scores?.[key]??h.data[key]??"未评"),
                    )
                    .join(" / ")}
                </p>
                <EvaluationRecordedFields row={h}/>
                <strong>
                  人工结论：{conclusions[h.data.conclusion] || "未填写"}
                </strong>
              </Panel>
            ))
          ) : (
            <Empty>没有可查看的评估版本</Empty>
          )}
        </Dialog>
      )}
    </>
  );
}
export function Schedule({
  edit,
  onClose,
  onDone,
}: {
  edit: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const [created,setCreated]=useState<Row|null>(null);
  const [selected, setSelected] = useState<Row | null>(edit.prefillApplication || null),
    [ids, setIds] = useState<string[]>(edit.interviewer_ids || []),
    [primary, setPrimary] = useState(edit.primary_interviewer_id || "");
  const { notify,isAdmin,user } = useApp();
  const [directory,setDirectory]=useState<DirectoryMember[]>([]),[directoryPrimary,setDirectoryPrimary]=useState('');
  const useDirectory=isAdmin;
  const roster=useResource<Row[]>(signal=>isAdmin&&edit.id?api('/interviews/'+edit.id+'/directory-schedule',{signal}):Promise.resolve([]),[edit.id,isAdmin]);
  useEffect(()=>{if(edit.id&&roster.data){setDirectory(roster.data as DirectoryMember[]);setDirectoryPrimary(roster.data.find(m=>m.primary)?.openId||'');}},[roster.data,edit.id]);
  const members = useResource<Row>(
    (s) =>
      ids.length
        ? api(
            "/assignment-members?role=interviewer&pageSize=100&ids=" +
              ids.join(","),
            { signal: s },
          )
        : Promise.resolve({ items: [] }),
    [ids.join(",")],
  );
  if(created?.directory)return <DirectoryScheduleResult receipt={created} members={directory} onDone={onDone}/>;
  if(created)return <FeishuSchedulePrompt interview={created} names={(members.data?.items||[]).filter((p:Row)=>ids.includes(p.id)).map((p:Row)=>p.name)} onDone={onDone}/>;
  return (
    <Dialog title={edit.id ? "编辑面试安排" : "安排面试"} onClose={onClose}>
      <ConfiguredForm kind="interview" id={edit.id} mode={edit.id?"edit":"create"} omitCoreKeys={edit.id?['round']:[]} core={{...edit,round:edit.round||1,durationMinutes:edit.duration_minutes||60,form:edit.form||'线上视频',startsAt:edit.starts_at,meetingUrl:edit.meeting_url}} customFields={edit.customFields}
        onCancel={onClose}
        onSubmit={async (payload,form) => {
          const b = values(form);
          if(useDirectory){
            if(!directory.length)throw Error("请选择至少一位内部员工");
            const primaryOpenId=directory.length===1?directory[0].openId:directoryPrimary;
            if(!directory.some(m=>m.openId===primaryOpenId))throw Error("请选择本场主责面试官");
            const receipt=await api<Row>(edit.id?"/interviews/"+edit.id+"/directory-schedule":"/interviews/directory-schedule",{method:edit.id?"PATCH":"POST",body:{...payload,directoryMembers:directory.map(({openId,role})=>({openId,role})),primaryOpenId,...(edit.id?{version:edit.version,status:b.status}:{applicationId:b.applicationId,alsoAdvance:b.advance==="on",applicationVersion:selected?.version,stageConfirmation:b.advance==="on"})}});
            notify("面试与本场临时权限已保存；员工仍须飞书登录。");
            if(!edit.id&&!user.calendarSyncEnabled)setCreated({...receipt,directory:true});else onDone();return;
          }
          const base = {
            ...payload,
            ...(edit.id&&JSON.stringify(ids)===JSON.stringify(edit.interviewer_ids)&&primary===edit.primary_interviewer_id?{}:{interviewerIds: ids,primaryInterviewerId: ids.length === 1 ? ids[0] : primary}),
          };
          if (!ids.length) throw Error("至少选择一位面试官");
          if (ids.length > 1 && !ids.includes(primary))
            throw Error("请选择参与本场的主责面试官");
          const result = await api<Row>(
            edit.id ? "/interviews/" + edit.id : "/interviews",
            {
              method: edit.id ? "PATCH" : "POST",
              body: edit.id
                ? { ...base, version: edit.version, status: b.status }
                : {
                    ...base,
                    applicationId: b.applicationId,
                    alsoAdvance: b.advance === "on",
                    applicationVersion: selected?.version,
                    stageConfirmation: b.advance === "on",
                  },
            },
          );
          if (result.overlaps?.length)
            notify(
              "已保存，与 " +
                result.overlaps.length +
                " 场已有面试重叠，请核对",
            );
          if(!edit.id&&!user.calendarSyncEnabled)setCreated(result);else onDone();
        }}
      >
        {!edit.id && (
          <ApplicationPicker
            value={selected?.id || ""}
            selected={selected}
            onChange={setSelected}
          />
        )}
        {useDirectory?<>{roster.error&&<p role="alert">{roster.error}<button type="button" onClick={roster.reload}>重试加载本场参与人</button></p>}{roster.loading&&edit.id&&<p>正在加载本场参与人…</p>}<DirectoryPicker value={directory} onChange={setDirectory}/><Field label="主责面试官"><select required value={directory.length===1?directory[0].openId:directoryPrimary} onChange={e=>setDirectoryPrimary(e.target.value)}><option value="">请选择</option>{directory.map(m=><option key={m.openId} value={m.openId}>{m.name} · {m.openId}</option>)}</select></Field></>:<>
        <MemberPicker
          role="interviewer"
          value={ids}
          onChange={(next) => {
            setIds(next);
            if (!next.includes(primary))
              setPrimary(next.length === 1 ? next[0] : "");
          }}
        />
        <Field label="主责面试官" required>
          <select
            value={ids.length === 1 ? ids[0] : primary}
            onChange={(e) => setPrimary(e.target.value)}
            required
          >
            <option value="">请选择主责面试官</option>
            {members.data?.items.map((p: Row) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        </>}
        {edit.id ? (
          <Field label="实际面试结果">
            <select
              name="status"
              defaultValue={
                edit.status === "legacy_completed" ? "pending" : edit.status
              }
            >
              {Object.entries(states)
                .filter(([key]) => key !== "legacy_completed")
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
        ) : (
          <label className="check">
            <input name="advance" type="checkbox" defaultChecked />
            确认同时将候选人推进到“面试中”
          </label>
        )}
        <p className="notice">
          结果由人工记录；未通过、取消或爽约均不会自动结束招聘流程。四维打分与题目覆盖通过“主责评估
          / 打分”维护。
        </p>
      </ConfiguredForm>
    </Dialog>
  );
}
function DirectoryScheduleResult({receipt,members,onDone}:{receipt:Row;members:DirectoryMember[];onDone:()=>void}){
 const saved=useResource<Row>(async signal=>{
  const [materials,grants]=await Promise.all([api<Row>('/interviews/'+receipt.id+'/materials',{signal}),api<Row[]>('/interviews/'+receipt.id+'/access-grants',{signal})]);
  const ids=[...new Set(grants.filter(g=>members.some(m=>m.openId===g.open_id)).map(g=>g.user_id as string))];
  const eligible=ids.length?await api<Row>('/assignment-members?role=interviewer&pageSize=100&ids='+ids.join(','),{signal}):{items:[]};
  return {interview:materials.interview,eligible:ids.length===members.length&&ids.every(id=>eligible.items.some((m:Row)=>m.id===id))};
 },[receipt.id]);
 if(saved.data?.eligible)return <FeishuSchedulePrompt interview={saved.data.interview} names={members.map(m=>m.name)} onDone={onDone}/>;
 return <Dialog title="面试已保存" onClose={onDone}><Resource {...saved} retry={saved.reload}>{saved.data&&<><p>共享日历同步未开启，当前参与人包含尚未审批或不具备永久面试角色的员工，旧版飞书邀请暂不可用。</p><p>本场临时权限已开通，员工仍可通过企业飞书登录参加面试。请由 HR 确认会议安排；本次没有发送日程邀请。</p></>}</Resource><p className="muted">面试安排已保存，请勿重复新建。</p><button className="primary" onClick={onDone}>完成</button></Dialog>;
}
function Evaluation({interview,onClose,onDone,defaultDraft=false}:{interview:Row;onClose:()=>void;onDone:()=>void;defaultDraft?:boolean}) {
 const {user,notify}=useApp(),personal=!!interview.personal,[dirty,setDirty]=useState(false),[upgrade,setUpgrade]=useState(false);
 const evidence=useInterviewEvidence(interview.id);
 const loaded=useResource<any>(async signal=>{const [old,basis]=await Promise.all([personal?api<Row[]>('/applications/'+interview.application_id+'/evaluations',{signal}).then(rows=>rows.find(e=>e.interview_id===interview.id&&e.author_id===user.id)||null):api('/interviews/'+interview.id+'/evaluation',{signal}),api('/interviews/'+interview.id+'/evaluation-template?forPrimary='+(!personal),{signal})]);return {old,template:basis.template};},[interview.id,personal]);
 const old=loaded.data?.old,template=loaded.data?.template,dimensions=evaluationDimensions(template);
 return <Dialog title={'第 '+interview.round+' 轮 · '+(personal?'本人补充意见':'主责面试评估')} onClose={onClose} wide><Resource {...loaded} retry={loaded.reload}>{template&&<>
 <p className="status">{template.label} · {templateModeLabel(template)} · {refLabel(template.ref)}</p>
 {old&&<button type="button" onClick={()=>{if(dirty){notify('表单有未保存修改，请先保存或取消后重新进入',true);return;}setUpgrade(true);}}>预览更换评估模板</button>}
 {upgrade?<ObjectTemplateUpgrade kind="evaluation" id={interview.id} forPrimary={!personal} onCancel={()=>setUpgrade(false)} onDone={()=>{setUpgrade(false);setDirty(false);loaded.reload();notify('已建立新模板的私有草稿，请核对并正式提交');}}/>:
 <div onChangeCapture={()=>setDirty(true)}><ConfiguredForm key={(old?.version||0)+':'+template.ref.configId+':'+template.ref.version} kind="evaluation" id={old?.id} allowIncomplete childrenFirst core={old?.data||{}} customFields={old?.customFields||{}} onCancel={onClose} submit="保存评估" onSubmit={async(payload,form)=>{
  const b=values(form),{definitionVersion,definitionRevision,customFields,...text}=payload,scores=evaluationScores(template,b),missing=b.status==='submitted'?missingEvaluationDimension(template,scores):null;if(missing){(form.elements.namedItem('score.'+missing.id) as HTMLElement)?.focus();throw Error('请补充有效评分：'+missing.label+'（1–5 分，步长 0.5）');}
  await api('/interviews/'+interview.id+'/evaluation',{method:'PUT',body:{version:old?.version||0,definitionVersion,definitionRevision,customFields,templateRef:template.ref,status:b.status,forPrimary:!personal,data:{...text,...scores,conclusion:b.conclusion||null}}});
  setDirty(false);onDone();
 }}>
 <p className="notice">人工评分供人事参考与针对性训练，不自动推进或淘汰。主责：{old?.author_name||interview.primary_interviewer_name||'本场主责面试官'}。{old?.editor_name?'上次录入：'+old.editor_name:''}</p>
 <div className="form-grid">{dimensions.map((d:any)=><Field key={d.id} label={d.label+(d.required?'（正式提交必填）':'')} hint={d.description}><select name={'score.'+d.id} defaultValue={old?.data?.scores?.[d.id]??old?.data?.[d.id]??''}><option value="">未评分</option>{Array.from({length:9},(_,i)=>1+i*0.5).map(n=><option key={n} value={n}>{n} / 5</option>)}</select><EvidenceTags items={evidence.data?.items} dimensionId={d.id}/></Field>)}
 {template.mode!=='custom'&&<Field label="综合评分（不计入四维均分）"><select name="overallScore" defaultValue={old?.data.overallScore??''}><option value="">未评分</option>{Array.from({length:9},(_,i)=>1+i*0.5).map(n=><option key={n} value={n}>{n} / 5</option>)}</select></Field>}</div>
 <details><summary>查看当前评分锚点</summary>{dimensions.map((d:any)=><p key={d.id}><strong>{d.label}：</strong>{d.anchors.map((a:any)=>a.score+' 分 '+a.label).join('；')||'未设置锚点，需人工核对依据'}</p>)}</details>
 <div className="form-grid"><Field label="人工综合结论"><select name="conclusion" defaultValue={old?.data.conclusion||''}><option value="">尚未填写</option>{Object.entries(conclusions).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Field><Field label="保存为"><select name="status" defaultValue={old?.status||(defaultDraft?'draft':'submitted')}><option value="draft">草稿（作者与录入者可见）</option><option value="submitted">正式提交</option></select></Field></div><p className="muted">安排页与评估页维护同一份主责评估。各作者意见保留独立版本；模板变更不会改写旧提交。</p>
 </ConfiguredForm></div>}</>}</Resource></Dialog>;
}

export default function Interviews(props:{evaluate?:boolean; initialMine?:boolean}){
 const {openApplication,notify,user}=useApp(),[assistant,setAssistant]=useState<Row|null>(null),[reviewId,setReviewId]=useState<string|null>(null);
 return props.evaluate?<InterviewsNative {...props} onReview={setReviewId}/>:<><FieldViewSwitch kind="interview" action={r=><><button onClick={()=>openApplication(r.application_id)}>打开申请与面试安排</button>{user.roles?.some((role:string)=>['admin','manager','recruiter','interviewer'].includes(role))&&<button onClick={()=>void api<Row>('/interviews/'+r.id+'/assistant/context').then(setAssistant).catch(e=>notify(e.message,true))}>AI 辅助面试</button>}<button onClick={()=>setReviewId(r.id)}>上下文与输出自查</button></>}><InterviewsNative {...props} onReview={setReviewId}/></FieldViewSwitch>{assistant&&<InterviewAssistant interview={assistant} onClose={()=>setAssistant(null)}/>}{reviewId&&<InterviewReviewDialog interviewId={reviewId} onClose={()=>setReviewId(null)}/>}</>;
}
