import ApplicationSnapshot from './ApplicationSnapshot';
import ResumeWorkflow from './ResumeWorkflow';
import {Schedule} from './Interviews';
import FieldHistory from '../components/business/FieldHistory';
import {comparisonModeLabel} from '../lib/upload-completion';
import ApplicationChecklist from '../components/business/ApplicationChecklist';import {optionalOriginal,refLabel} from '../lib/template-ui';
import ConfiguredForm from "../components/business/ConfiguredForm";
import MemberPicker from "../components/MemberPicker";
import {
  evidenceResumeId,
  extractionWarnings,
  readableComparison,
  finishApplicationFlow,
} from "../lib/workflows";
import { useEffect, useMemo, useState } from "react";
import { api, query } from "../lib/api";
import { usePublishedDictionary } from "../lib/use-published-dictionary";
import {
  useApp,
  useResource,
  Resource,
  stages,
  date,
  edu,
  education,
  tokens,
  type Row,
} from "../lib/state";
import {
  Dialog,
  Panel,
  Form,
  Field,
  Empty,
  Status,
  Tags,
  MatchScore,
  CopyButton,
  values,
} from "../components/ui";
import { TransitionDialog } from "./People";
const marks: Record<string, string> = {
  matched: "✓ 命中",
  not_matched: "○ 未命中",
  unknown: "? 未识别",
  not_applicable: "— 不适用",
};
// 旧快照里没有 label / reason / method：前端按当前字典把编号翻成可读技能名，
// 并从原文证据推导命中原因与解析方式，保证历史分数也能看懂，不必先重算。
function explainSkillRow(s: Row, labels: Record<string, string>) {
  const key = String(s.requirement ?? s.skill ?? "");
  const label = s.label || labels[key] || key;
  if (s.reason) return { label, method: s.method || "规则判定", reason: s.reason };
  const assertions: Row[] = s.assertions || [];
  if (assertions.length) {
    const last = assertions[assertions.length - 1];
    return { label, method: "人工核对", reason: "由招聘同事人工核对补录：" + (last.reason || "已确认") };
  }
  if (s.status === "unknown") return { label, method: "无法判定", reason: "简历原文为空或未解析，缺少判定依据" };
  const hit = (s.evidence || [])[0];
  if (s.status === "matched" && hit) {
    const text = String(hit.text || "").trim();
    const alias = text.toLowerCase() !== key.toLowerCase() && text.toLowerCase() !== label.toLowerCase();
    return {
      label,
      method: alias ? "词典别名命中" : "原文关键词命中",
      reason: "简历原文第 " + hit.line + " 行出现「" + text + "」" + (alias ? "，按技能词典归入「" + label + "」" : ""),
    };
  }
  return {
    label,
    method: "原文检索无命中",
    reason: "简历原文未出现「" + label + "」及其词典别名，判为未命中；未命中不等于不具备",
  };
}
function skillLabels(dictionary: Row | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const o of dictionary?.options || []) map[o.id] = o.label || o.id;
  return map;
}
export default function ApplicationDetail({
  id,
  initialEdit=false,
  jobs,
  onClose,
}: {
  id: string;
  initialEdit?:boolean;
  jobs: Row[];
  onClose: () => void;
}) {
  const {
      revision,
      refresh,
      notify,
      canWrite,
      canManage,
      openPerson,
      openApplication,
    } = useApp(),
    [tab, setTab] = useState(initialEdit?"profile":"comparison"),
    [action, setAction] = useState(initialEdit?"correction":""),
    [nextRound,setNextRound] = useState(1),
    [highlight, setHighlight] = useState<Row | null>(null);
  const result = useResource<Row>(
    async (signal) => {
      const [app, match, events] = await Promise.all([
        api<Row>("/applications/" + id, { signal }),
        api<Row>("/applications/" + id + "/matches", { signal }),
        api<Row[]>("/applications/" + id + "/events", { signal }),
      ]);
      const [person, raw] = await Promise.all([
        api<Row>("/candidates/" + app.candidate_id, { signal }),
        app.resume_version_id
          ? optionalOriginal(()=>api<Row>("/resumes/" + app.resume_version_id + "/raw", { signal }))
          : null,
      ]);
      const citationId = evidenceResumeId(app, match);
      const evidenceRaw =
        citationId && citationId !== app.resume_version_id
          ? await optionalOriginal(()=>api<Row>("/resumes/" + citationId + "/raw", { signal }))
          : raw;
      return { app, match, events, person, raw, evidenceRaw };
    },
    [id, revision],
  );
  const dictionary = usePublishedDictionary("skills");
  const labels = useMemo(() => skillLabels(dictionary.data), [dictionary.data]);
  const [crossOne, setCrossOne] = useState<Row | null>(null);
  useEffect(() => {
    let alive = true;
    api<Row>("/candidates/matching/cross-job", {
      method: "POST",
      body: { threshold: 60, applicationId: id },
    })
      .then((r) => { if (alive) setCrossOne(r?.items?.[0] || null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);
  const d = result.data,
    a = d?.app,
    raw = d?.raw;
  const done = (next?: Row) =>
    finishApplicationFlow(id, next, {
      closeForm: () => setAction(""),
      refresh,
      reload: result.reload,
      open: openApplication,
    });
  const evidence = (rows: Row[]) =>
    rows.length ? (
      rows.map((e: Row) => (
        <button
          className="evidence"
          key={e.id}
          onClick={() => {
            setHighlight({
              ...e,
              raw: d?.evidenceRaw?.raw||e.text,
              limited:!d?.evidenceRaw,
              ...(d?.evidenceRaw?{}:{start:0,end:e.text.length}),
              resumeVersionId: d?.evidenceRaw?.resumeVersionId||d?.match.latest?.resume_version_id,
            });
            setTab("raw");
          }}
        >
          第 {e.line} 行：{e.text}
        </button>
      ))
    ) : (
      <span className="muted">简历原文中未检索到相关内容</span>
    );
  return (
    <Dialog
      title={a ? `${a.profile.name} · ${a.job_name}` : "候选人申请"}
      onClose={onClose}
      wide
    >
      <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
        {a && (
          <>
            <div className="detail-summary">
              {canWrite&&a.is_current!==false&&raw&&<button aria-label="修改姓名" onClick={()=>setAction("correction")}>{/^(全部行业|不限|个人简历|工作经历|求职意向)$/.test(a.profile.name)?'姓名需核对':a.profile.name} · 编辑</button>}
              <div>
                <Status value={a.status} />
                <span className="muted">
                  {a.source} · {date(a.created_at)}
                </span>
              </div>
              <MatchScore match={d?.match.latest?.data} />
            </div>
            <ApplicationSnapshot a={a} match={d?.match.latest?.data} events={d?.events} person={d?.person}/>
            <details className="panel"><summary>岗位申请补充字段与薪酬沟通</summary>
              {canWrite&&a.is_current!==false?<ConfiguredForm kind="application" id={a.id} core={a} customFields={a.customFields} onCancel={()=>setAction('')} onSubmit={async body=>{await api('/applications/'+a.id+'/fields',{method:'PATCH',body:{...body,version:a.version}});refresh();result.reload();notify('申请字段已保存');}}/>:<p className="muted">按当前授权展示；归档申请不可编辑。</p>}
            </details>
            <div className="toolbar detail-actions">
              {a.is_current === false && (
                <p className="notice warning">
                  此岗位申请已归档，仅供查看历史。
                  {d?.person.applications.find((x: Row) => x.is_current) && (
                    <button
                      onClick={() =>
                        openApplication(
                          d!.person.applications.find((x: Row) => x.is_current)
                            .id,
                        )
                      }
                    >
                      打开当前流程
                    </button>
                  )}
                </p>
              )}
              {canWrite && (
                <>
                  {a.is_current !== false && (
                    <>
                      <button onClick={() => setAction("transition")}>
                        调整环节
                      </button>
                      <button onClick={() => setAction("transfer")}>
                        推荐至其他岗位
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => {
                      onClose();
                      openPerson(a.candidate_id);
                    }}
                  >
                    人员档案与版本
                  </button>
                  {a.is_current !== false && (
                    <button
                      onClick={() => setAction("correction")}
                      disabled={!raw}
                    >
                      编辑资料
                    </button>
                  )}
                </>
              )}
              {canManage && (
                <button onClick={() => setAction("grants")}>授权查看</button>
              )}
              {canWrite && a.is_current !== false && (
                <button className="danger" onClick={() => setAction("delete")}>
                  删除误建申请
                </button>
              )}
            </div>
            <div className="segments tabs">
              {[
                ["comparison", "解析明细"],
                ...(canWrite?[["checklists","资料与准备"]]:[]),
                ["raw", "原文证据"],
                ["history", "流转与跟进"],
                ["profile", "候选人画像"],
              ].map(([v, t]) => (
                <button
                  className={tab === v ? "active" : ""}
                  key={v}
                  onClick={() => {
                    setTab(v);
                    if (v === "raw") setHighlight(null);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab==="checklists"&&canWrite&&<ApplicationChecklist application={a} onChanged={()=>{refresh();result.reload();}}/>}
            {tab === "comparison" && (
              <>
                {canWrite&&<ResumeWorkflow applicationId={id}/>}
                {raw && extractionWarnings(raw as any).length > 0 && (
                  <p className="notice warning" role="status">
                    {extractionWarnings(raw as any).join("；")}
                    。{canWrite&&a.is_current!==false&&<button onClick={()=>setAction("correction")}>补充资料</button>}
                  </p>
                )}
                <details><summary>匹配说明</summary><p>匹配仅供人工参考，不构成淘汰结论。未识别不等于不具备；年龄、性别不参与评分。</p><p>「待核实」由未识别字段或未评分维度触发；橙色分数表示有维度未参与计分。每条技能的「命中原因 / 解析方式」写明判定依据，只用于解释，不参与计分。</p>{d?.match.latest?.data?.summary?.pendingFields?.length>0&&<p>本次待核实字段：{d.match.latest.data.summary.pendingFields.map((k:string)=>k==='skills'?'技能':k==='experienceYears'?'工作年限':k==='education'?'学历':k).join('、')}</p>}</details>
                {crossOne?.alert&&(
                  <p className="notice warning">
                    跨岗提醒：本岗位 {crossOne.currentScore===null?'未评分':crossOne.currentScore+'%'}，与「{crossOne.bestJobName}」匹配 <strong>{crossOne.bestScore}%</strong>（阈值 60%，已排除共性词）。建议在「流转与跟进」核对后考虑转岗，系统不会自动调整。
                    {crossOne.bestEvidence?.length>0&&<small className="muted"> 命中依据：{crossOne.bestEvidence.map((e:Row)=>e.label+'（'+e.method+'）').join('、')}；悬停看原文。</small>}
                  </p>
                )}
                {d?.match.stale && <p className="notice warning">对照已过期或正在生成，历史结果仍保留</p>}
                {canWrite && (
                  <div className="toolbar">
                    <button
                      title="按当前已发布的评分标准重算本条申请；只重算分数，不改动简历档案，也不会重新解析简历"
                      onClick={() =>
                        api("/applications/" + id + "/recompute", {
                          method: "POST",
                        })
                          .then(() => {
                            notify("重算已排队");
                            setTimeout(result.reload, 1500);
                          })
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      重新计算
                    </button>
                    <i className="info-tip" title="只重算本条申请的匹配分，不改动简历档案、不批量重解析；重算后分数与命中原因会按当前评分标准更新">i</i>
                  </div>
                )}
                {d?.match.latest ? (
                  <>
                    <div className="toolbar">
                      <CopyButton
                        label="复制完整对照及声明"
                        text={readableComparison(d.match.latest as any)}
                      />
                    </div>
                    <div className="comparison-parts">
                      <strong>
                        匹配度 {d.match.latest.data.score.unscoredDimensions?.includes('skills') ? '无法计算（技能组未配置）' : d.match.latest.data.score.value + '%'}
                        {(d.match.latest.data.score.unscoredDimensions?.length ?? 0) > 0 && (
                          <span className="muted">
                            （{(d.match.latest.data.score.unscoredDimensions ?? [])
                              .map((k: string) => (k === "skills" ? "技能" : k === "experience" ? "经验" : k))
                              .join("、")}
                            未评分，总分为其余维度合计）
                          </span>
                        )}
                      </strong>
                      <span>
                        技能 {d.match.latest.data.skillPoints ?? "未评分"} /{" "}
                        {d.match.latest.data.weights?.skills ?? 60}
                      </span>
                      <span>
                        经验 {d.match.latest.data.experience.points ?? "未评分"} /{" "}
                        {d.match.latest.data.weights?.experience ?? 25}
                      </span>
                      <span>
                        学历 {d.match.latest.data.education.points} / {d.match.latest.data.weights?.education ?? 15}
                      </span>
                    </div>
                    <p className="muted">
                      共 {d.match.latest.data.summary.total} 条 · 命中{" "}
                      {d.match.latest.data.summary.matched} · 未命中{" "}
                      {d.match.latest.data.summary.notMatched} · 未识别{" "}
                      {d.match.latest.data.summary.unknown} · 不适用{" "}
                      {d.match.latest.data.summary.notApplicable}
                    </p>
                    {(d.match.latest.data.summary.pendingFields?.length ?? 0) > 0 && (
                      <p className="muted">
                        待核实 / 未评分字段：
                        {(d.match.latest.data.summary.pendingFields ?? [])
                          .map((k: string) =>
                            k === "skills"
                              ? "技能"
                              : k === "experienceYears"
                                ? "工作年限"
                                : k === "education"
                                  ? "学历"
                                  : k,
                          )
                          .join("、")}
                      </p>
                    )}
                    <progress
                      className="comparison-progress"
                      aria-label="逐条对照命中率"
                      max={1}
                      value={d.match.latest.data.summary.hitRate || 0}
                      style={{
                        accentColor:
                          d.match.latest.data.summary.hitRate === null
                            ? "#7d8998"
                            : d.match.latest.data.summary.hitRate >= 0.75
                              ? "#21814b"
                              : d.match.latest.data.summary.hitRate >= 0.5
                                ? "#bb7315"
                                : "#d44949",
                      }}
                    />
                    {d.match.latest.data.hardGateHints?.map((hint: Row) => (
                      <p className="notice warning" key={hint.field}>
                        {hint.text}
                      </p>
                    ))}
                    {d.match.latest.data.groups?.length>0&&<section className="template-group"><h3>自定义技能组 · 固定规则版本</h3>{d.match.latest.data.groups.map((g:Row)=><GroupResult key={g.id} group={g} labels={labels}/>)}</section>}<div className="comparison-list">
                      {d.match.latest.data.skills.map((s: Row) => {
                        const x = explainSkillRow(s, labels);
                        return (
                          <div className="comparison-row" key={s.requirement}>
                            <div>
                              <strong>技能 · {x.label}</strong>
                              <span className={"verdict " + s.status}>
                                {marks[s.status]}
                              </span>
                              {x.label !== s.requirement && (
                                <small className="muted">
                                  技能词典条目：{s.requirement}
                                </small>
                              )}
                            </div>
                            <div>
                              <p className="muted match-reason">
                                命中原因：{x.reason} · 解析方式：{x.method}
                              </p>
                              {evidence(s.evidence || [])}
                              {s.assertions?.length > 0 && (
                                <small>人工核对技能，原文证据未被伪造</small>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {[
                        "experience",
                        "education",
                        ...(d.match.latest.data.school?.requirement?.length
                          ? ["school"]
                          : []),
                      ].map((key) => {
                        const f = d.match.latest.data[key];
                        return (
                          <div className="comparison-row" key={key}>
                            <div>
                              <strong>
                                {key === "education"
                                  ? "学历"
                                  : key === "school"
                                    ? "院校偏好（不计分）"
                                    : "工作年限"}
                              </strong>
                              <span className={"verdict " + f.status}>
                                {marks[f.status]}
                              </span>
                            </div>
                            <p>
                              岗位要求：
                              {f.requirement == null
                                ? "未设置"
                                : key === "education"
                                  ? edu(f.requirement)
                                  : key === "school"
                                    ? f.requirement.join("、")
                                    : [
                                        f.range.min ?? "不限",
                                        f.range.max ?? "不限",
                                      ].join("–") + " 年"}{" "}
                              · 实际：
                              {f.actual == null
                                ? "未提取"
                                : key === "education"
                                  ? edu(f.actual)
                                  : key === "school"
                                    ? f.actual.join("、")
                                    : f.actual + "年"}
                            </p>
                            <div>
                              {evidence(f.evidence || [])}
                              {f.assertions?.map((x: Row) => (
                                <p className="human-fact" key={x.field}>
                                  人工核对：{x.reason} · {date(x.at)}
                                </p>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {a.resume_version_id&&<FieldHistory kind="resume" id={a.resume_version_id}/>}<p className="muted">
                      {comparisonModeLabel(d.match.latest.data)} · 词典 v
                      {d.match.latest.dictionary_version} · 岗位 v
                      {d.match.latest.job_version} · 结果为
                      {d.match.latest.data.score.provisional
                        ? "含待核实字段的参考分"
                        : "规则对照分数"}
                      ，不代表录用结论。
                    </p>
                  </>
                ) : (
                  <Empty>尚无专业对照，请补充简历</Empty>
                )}
              </>
            )}
            {tab === "raw" &&
              (raw||highlight?.limited ? (
                <>
                  <div className="toolbar">
                    <CopyButton text={highlight?.raw ?? raw.raw} />
                    {!highlight?.limited&&raw&&<a
                      className="button"
                      href={
                        "/api/v4/resumes/" +
                        (highlight?.resumeVersionId || a.resume_version_id) +
                        "/file"
                      }
                    >
                      下载保留的原件
                    </a>}
                    <button onClick={() => setHighlight(null)}>清除高亮</button>
                  </div>
                  <p className="muted">
                    {highlight?.limited&&"权限限制，仅显示该专业事实片段。"}引用简历版本：
                    {(highlight?.resumeVersionId || a.resume_version_id).slice(
                      0,
                      8,
                    )}
                    。行号和高亮绑定此版本，显示不修改原文。
                  </p>
                  <pre className="raw-text">
                    {highlight ? (
                      <>
                        {highlight.raw.slice(0, highlight.start)}
                        <mark>
                          {highlight.raw.slice(highlight.start, highlight.end)}
                        </mark>
                        {highlight.raw.slice(highlight.end)}
                      </>
                    ) : (
                      raw.raw
                    )}
                  </pre>
                </>
              ) : (
                <Empty>{a.resume_version_id?"当前权限不能查看完整原文；专业对照可使用已授权的原文片段。":"此申请尚无简历"}</Empty>
              ))}
            {tab === "history" && <>
              {canWrite && a.is_current !== false && <div className="flow-actions"><button onClick={()=>setAction("transition")}>调整环节 / 待定 / 储备</button><button onClick={()=>setAction("transfer")}>推荐至其他岗位</button><button onClick={async()=>{try{const next=await api<Row>("/applications/"+a.id+"/next-interview-round");setNextRound(next.round);setAction("schedule");}catch(e){notify((e as Error).message,true);}}}>增加一轮面试</button></div>}
              <p className="muted">所有变更保留操作者、时间和原因；跨岗位推荐保留原申请历史。</p>
              <ol className="timeline">
                {d?.events.map((e: Row) => (
                  <li key={e.id}>
                    <strong>{e.actor_name}</strong> ·{" "}
                    <Status value={e.to_state} />
                    <small>
                      {date(e.at)}{" "}
                      {e.from_state &&
                        "由 " +
                          (stages.find(([id]) => id === e.from_state)?.[1] ||
                            e.from_state) +
                          " 变更"}
                    </small>
                    <p>{e.reason || "人工操作"}</p>
                    {e.from_job_name && (
                      <p>
                        {e.from_job_name} → {e.to_job_name || e.from_job_name}
                      </p>
                    )}
                    {e.opinion && <p>流转意见：{e.opinion}</p>}
                    {e.term_reason && (
                      <p className="termination-summary">
                        录用终止：{e.term_reason} {e.term_detail}
                      </p>
                    )}
                    {e.rejection_reason && (
                      <p>淘汰原因：{e.rejection_reason} {e.rejection_detail}</p>
                    )}
                    {e.cc && <p>抄送记录：{e.cc} · {refLabel(e.cc_snapshot?.templateRef)} · 未验证实际送达</p>}{e.cc_snapshot?.recipients?.length>0&&<p>当次具体责任人：{e.cc_snapshot.recipients.map((p:Row)=>p.name).join("、")}</p>}
                    {e.cc_snapshot?.items && (
                      <ul>
                        {e.cc_snapshot.items.map((item: string) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </>}
            {tab === "profile" && (
              <>
                <dl className="facts">
                  {Object.entries({
                    姓名: a.profile.name,
                    电话: a.profile.phone,
                    邮箱: a.profile.email,
                    院校: a.profile.school,
                    本科院校: a.profile.bachelorSchool,
                    公司: a.profile.companies?.join("、"),
                    求职意向: a.profile.intent,
                    期望薪资: a.profile.expectedSalary,
                    年龄: a.profile.age,
                    性别: a.profile.gender,
                    专业: a.profile.major,
                    学历: edu(a.profile.education),
                    工作年限: a.profile.experienceYears,
                    首次就业: a.profile.firstEmployment,
                    所在地: a.profile.location,
                  }).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v == null || v === "" ? "未注明" : String(v)}</dd>
                    </div>
                  ))}
                </dl>
                <Tags values={a.profile.skills} />
                <p>{a.profile.summary}</p>
                <p className="muted">
                  {canWrite&&a.is_current!==false&&raw&&<button onClick={()=>setAction('correction')}>编辑资料</button>}
                </p>
              </>
            )}
            {action === "schedule" && <Schedule edit={{prefillApplication:a,round:nextRound}} onClose={()=>setAction("")} onDone={()=>{done();notify("面试安排已保存");}}/>}
            {action === "transition" || action === "transfer" ? (
              <TransitionDialog
                application={a}
                jobs={jobs}
                transfer={action === "transfer"}
                onClose={() => setAction("")}
                onDone={done}
              />
            ) : null}
            {action === "delete" && (
              <Dialog title="删除误建申请" onClose={() => setAction("")}>
                <Form
                  onCancel={() => setAction("")}
                  submit="确认软删除"
                  onSubmit={async (form) => {
                    await api("/applications/" + id + "/delete", {
                      method: "POST",
                      body: { version: a.version, reason: values(form).reason },
                    });
                    refresh();
                    onClose();
                  }}
                >
                  <p>
                    从业务列表和统计中移除，保留简历和历史。管理员可在人才库回收记录中恢复。这不会新增淘汰决定。
                  </p>
                  <Field label="删除理由" required>
                    <textarea name="reason" required />
                  </Field>
                </Form>
              </Dialog>
            )}
            {action === "correction" && raw && (
              <Correction
                raw={raw!}
                application={a}
                person={d!.person}
                onClose={() => setAction("")}
                onDone={() => {
                  done();
                  setTab('profile');
                  notify('资料已保存，当前申请已更新');
                }}
              />
            )}
            {action === "grants" && (
              <Grants
                application={a}
                onClose={() => setAction("")}
                onDone={done}
              />
            )}
          </>
        )}
      </Resource>
    </Dialog>
  );
}
function Correction({raw,application,person,onClose,onDone}:{raw:Row;application:Row;person:Row;onClose:()=>void;onDone:()=>void}){
 const [overwrite,setOverwrite]=useState(false);
 const independentName=person.profile.name!==raw.profile.name&&person.profile.name!=='待确认';
 return <Dialog title="编辑候选人资料" onClose={onClose} wide>
  <details><summary>查看原始简历</summary><pre className="mailbox-body">{raw.raw}</pre></details>
  <ConfiguredForm kind="resume" id={raw.resumeVersionId} core={{...raw.profile,name:person.profile.name}} submit="保存修改" onCancel={onClose} onSubmit={async(payload)=>{
   const {definitionVersion,definitionRevision,customFields,...facts}=payload;
   const changes=Object.fromEntries(Object.entries(facts).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(raw.profile[k])));
   if(!Object.keys(changes).length&&!Object.keys(customFields||{}).length){onClose();return;}
   try{await api('/resumes/'+raw.resumeVersionId+'/corrections',{method:'POST',body:{baseParseResultId:raw.parseResultId,reason:'人工核对候选人资料',corrections:changes,definitionVersion,definitionRevision,customFields,application:{id:application.id,version:application.version,candidateVersion:person.version},confirmNameOverwrite:overwrite}});}catch(error){if((error as {code?:string}).code==='candidate_name_conflict')throw Error('人员档案已有独立确认的姓名，请核对并勾选替换姓名后保存。');throw error;}
   onDone();
  }}>
   {independentName&&<label className="check"><input type="checkbox" checked={overwrite} onChange={e=>setOverwrite(e.target.checked)}/>人员档案已有独立确认的姓名“{person.profile.name}”。如本次改名，确认替换该姓名。</label>}
   <p>修改字段同步到人员档案，并用于当前申请。原始简历和修改历史自动保留。</p>
  </ConfiguredForm>
 </Dialog>;
}

function Grants({
  application,
  onClose,
  onDone,
}: {
  application: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string[] | null>(null);
  const people = useResource<Row>(
    (s) => api("/applications/" + application.id + "/grants", { signal: s }),
    [application.id],
  );
  return (
    <Dialog title="授权只读查看" onClose={onClose}>
      <Resource {...people} preserve={people.data!==undefined} retry={people.reload}>
        <Form
          onCancel={onClose}
          onSubmit={async (form) => {
            const userIds = selected ?? people.data?.userIds ?? [];
            await api("/applications/" + application.id + "/grants", {
              method: "PUT",
              body: { version: people.data?.version, userIds },
            });
            onDone();
          }}
        >
          <p className="notice">
            本次选择会替换现有只读授权。仅列出已启用的只读账号，不改变其角色。
          </p>
          <MemberPicker
            role="viewer"
            value={selected ?? people.data?.userIds ?? []}
            onChange={setSelected}
          />
        </Form>
      </Resource>
    </Dialog>
  );
}

function GroupResult({group:g,labels}:{group:Row;labels:Record<string,string>}){return <div className="match-group-result"><strong>{g.label} · {g.mode.toUpperCase()} · {g.satisfied?"已满足":"待人工核对"}</strong><p>{g.note} · 本组得分比例 {Math.round(g.value*100)}%{g.required?" · 必备提示，不自动淘汰":""}</p><ul>{g.items.map((i:Row)=>{if(i.items)return <li key={i.id}><GroupResult group={i} labels={labels}/></li>;const x=explainSkillRow({...i,requirement:i.skill},labels);return <li key={i.id}><strong>{x.label}</strong> · {marks[i.status]||i.status}{i.provisional?" · 证据待核实":""}<div className="muted match-reason">命中原因：{x.reason} · 解析方式：{x.method}</div></li>;})}</ul></div>;}
