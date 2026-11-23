import ConfiguredForm from "../components/business/ConfiguredForm";
import {useBusinessDefinition} from "../lib/use-business-definition";
import { useState } from "react";
import { api } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  date,
  education,
  tokens,
  type Row,
} from "../lib/state";
import {
  Dialog,
  Form,
  Field,
  Panel,
  Status,
  Empty,
  values,
} from "../components/ui";
export default function Person({
  id,
  jobs,
  onClose,
}: {
  id: string;
  jobs: Row[];
  onClose: () => void;
}) {
  const { revision, refresh, canWrite, notify, openApplication } = useApp(),
    p = useResource<Row>(
      (s) => api("/candidates/" + id, { signal: s }),
      [id, revision],
    ),
    applicationDef=useBusinessDefinition("application"),
    [action, setAction] = useState("");
  const person = p.data;
  const sources = applicationDef.data?.fields.find(f=>f.coreKey === "source")?.options?.filter(o=>o.active) || [];
  const active = person?.applications.some((a:Row) => a.is_current && !["hired","terminated","rejected","hired_other"].includes(a.status));
  const applyLabel = person?.applications.length ? "开始新的招聘流程" : "开始推进";
  return (
    <Dialog
      title={person ? person.profile.name + " · 人员档案" : "人员档案"}
      onClose={onClose}
      wide
    >
      <Resource {...p} preserve={p.data!==undefined} retry={p.reload}>
        {person && (
          <>
            <div className="toolbar detail-actions">
              {canWrite && (
                <>
                  <button onClick={() => setAction("edit")}>
                    编辑人员档案
                  </button>
                  <button disabled={active} onClick={() => setAction("apply")}>{applyLabel}</button>
                  {!active && person.lifecycle === "inbox" && <button onClick={() => setAction("archive")}>仅留档</button>}
                  <button
                    className="danger"
                    disabled={person.applications.length > 0}
                    title="先回收所有关联申请，才可删除人员"
                    onClick={() => setAction("delete")}
                  >
                    删除误建人员
                  </button>
                </>
              )}
            </div>
            <Panel title="简历信息">
              <p>{person.profile.intent || '意向岗位待确认'}</p>
              <p>{person.profile.school || '院校未注明'}{person.profile.major ? ' · '+person.profile.major : ''}</p>
              <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{person.profile.summary || '原始资料未提供个人描述，可下载简历查看。'}</p>
              {person.archive_reason && <p>留档说明：{person.archive_reason}</p>}
            </Panel>
            <Panel title="招聘经历">
              {person.applications.map((a: Row) => (
                <div className="record-row" key={a.id}>
                  <span>
                    {jobs.find((j) => j.id === a.job_id)?.name || "已授权岗位"}
                  </span>
                  <Status value={a.status} />
                  <span className="status">
                    {a.is_current ? "当前流程" : "历史归档"}
                  </span>
                  <button
                    onClick={() => {
                      onClose();
                      openApplication(a.id);
                    }}
                  >
                    查看申请
                  </button>
                </div>
              ))}
              {!person.applications.length && <Empty>尚无岗位申请</Empty>}
            </Panel>
            <Panel title="简历版本">
              <p className="muted">
                采用版本只影响当前流程；已归档岗位申请与历史对照保留。
              </p>
              {person.resumes.map((r: Row) => (
                <div className="record-row" key={r.id}>
                  <span>
                    {r.parent_id
                      ? "修订解析版本"
                      : r.kind === "paste"
                        ? "文本来源版本（无原始附件）"
                        : "原始附件版本"}{" "}
                    · {date(r.created_at)}
                    <small>版本 {r.id.slice(0, 8)}</small>
                  </span>
                  <a
                    className="button"
                    href={"/api/v4/resumes/" + r.id + "/file"}
                  >
                    {r.kind === "paste"
                      ? "下载留存文本（JSON）"
                      : "下载原始附件"}
                  </a>
                  {canWrite && (
                    <button
                      disabled={
                        !person.applications.some((a: Row) => a.is_current)
                      }
                      onClick={() => setAction("resume:" + r.id)}
                    >
                      为当前流程采用此版本
                    </button>
                  )}
                </div>
              ))}
            </Panel>
            {person.history.length > 0 && (
              <details>
                <summary>人员档案修改历史（{person.history.length}）</summary>
                <ol className="timeline">
                  {person.history.map((h: Row) => (
                    <li key={h.candidate_id + ":" + h.version}>
                      版本 {h.version} · {date(h.at)}
                      <p>
                        {h.profile.name} · {h.profile.school || "院校未注明"} ·{" "}
                        {h.profile.skills?.join(" / ")}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {action && (
              <Dialog
                title={
                  action === "edit"
                    ? "编辑人员档案"
                    : action === "apply"
                      ? applyLabel
                      : action === "archive" ? "仅留档" : action === "delete"
                        ? "删除误建人员"
                        : "采用简历版本"
                }
                onClose={() => setAction("")}
              >
                {action==='edit'?<ConfiguredForm kind="resume" coreOnly core={person.profile} onCancel={()=>setAction('')} onSubmit={async body=>{
                  const {definitionVersion,definitionRevision,customFields,...profile}=body;await api('/candidates/'+id,{method:'PATCH',body:{version:person.version,profile,definitionVersion,definitionRevision,customFields}});setAction('');refresh();notify('人员档案已保存');
                }}><p className="notice">人员备注单独留历史。简历扩展事实请从申请详情核对并创建新版本。</p></ConfiguredForm>:
                <Form
                  onCancel={() => setAction("")}
                  onSubmit={async (form) => {
                    const b = values(form);
                    let startedApplication: Row | undefined;
                    if (action === "edit") {
                      const profile = {
                        ...person.profile,
                        name: b.name,
                        phone: b.phone,
                        email: b.email,
                        school: b.school,
                        major: b.major,
                        skills: tokens(b.skills),
                        summary: b.summary,
                        location: b.location,
                        expectedSalary: b.expectedSalary,
                      };
                      await api("/candidates/" + id, {
                        method: "PATCH",
                        body: { version: person.version, profile },
                      });
                    } else if (action === "apply")
                      startedApplication = await api<Row>("/applications", {
                        method: "POST",
                        body: {
                          candidateId: id,
                          startNew: !!person.applications.length,
                          definitionVersion:applicationDef.data?.ref.version,definitionRevision:applicationDef.data?.aclRevision,
                          jobId: b.jobId,
                          source: b.source,
                          resumeVersionId: b.resumeId || undefined,
                        },
                      });
                    else if (action === "archive") {
                      await api("/candidates/"+id+"/archive",{method:"POST",body:{version:person.version,reason:b.reason}});
                    } else if (action === "delete") {
                      await api("/candidates/" + id + "/delete", {
                        method: "POST",
                        body: { version: person.version, reason: b.reason },
                      });
                      onClose();
                    } else {
                      const a = person.applications.find(
                        (a: Row) => a.id === b.applicationId,
                      );
                      await api("/applications/" + a.id + "/resume", {
                        method: "POST",
                        body: {
                          version: a.version,
                          resumeVersionId: action.slice(7),
                        },
                      });
                    }
                    setAction("");
                    refresh();
                    notify("已保存");
                    if(startedApplication){onClose();openApplication(startedApplication.id);}
                  }}
                >
                  {action === "edit" ? (
                    <>
                      <div className="form-grid">
                        {[
                          ["name", "姓名"],
                          ["phone", "电话"],
                          ["email", "邮箱"],
                          ["school", "院校"],
                          ["major", "专业"],
                          ["location", "所在地"],
                          ["expectedSalary", "期望薪资"],
                        ].map(([k, label]) => (
                          <Field key={k} label={label} required={k === "name"}>
                            <input
                              name={k}
                              required={k === "name"}
                              defaultValue={person.profile[k]}
                            />
                          </Field>
                        ))}
                      </div>
                      <Field label="技能">
                        <input
                          name="skills"
                          defaultValue={person.profile.skills.join("，")}
                        />
                      </Field>
                      <Field label="档案备注">
                        <textarea
                          name="summary"
                          defaultValue={person.profile.summary}
                        />
                      </Field>
                      <p className="notice">
                        修改人员档案不会改写原始简历。更正专业对照请从申请详情创建简历新版本。
                      </p>
                    </>
                  ) : action === "apply" ? (
                    <>
                      <Field label="目标岗位" required>
                        <select name="jobId" required>
                          <option value="">请选择</option>
                          {jobs
                            .filter((j) => j.open)
                            .map((j) => (
                              <option key={j.id} value={j.id}>
                                {j.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="简历版本">
                        <select name="resumeId" defaultValue={person.resumes.at(-1)?.id || ""}>
                          <option value="">暂不选择</option>
                          {person.resumes.map((r: Row) => (
                            <option key={r.id} value={r.id}>
                              {date(r.created_at)} · {r.id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="来源" required>
                        <select name="source" required defaultValue={sources.some(o=>o.id==="其他")?"其他":sources[0]?.id || ""}><option value="">请选择来源</option>{sources.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select>
                      </Field>
                    </>
                  ) : action === "archive" ? (<><p>这份简历将移至人才库／历史档案，原邮件和简历仍保留。</p><Field label="留档理由" required><textarea name="reason" required maxLength={2000}/></Field></>) : action === "delete" ? (
                    <>
                      <p>保留原文和历史，管理员可从回收记录恢复。</p>
                      <Field label="删除理由" required>
                        <textarea name="reason" required />
                      </Field>
                    </>
                  ) : (
                    <>
                      <p className="notice">
                        这会重新计算指定申请的专业条件，并将旧对照保留为历史。
                      </p>
                      <Field label="选择需要切换的申请" required>
                        <select name="applicationId" required>
                          <option value="">请选择</option>
                          {person.applications
                            .filter((a: Row) => a.is_current)
                            .map((a: Row) => (
                              <option value={a.id} key={a.id}>
                                {jobs.find((j) => j.id === a.job_id)?.name ||
                                  a.id.slice(0, 8)}
                              </option>
                            ))}
                        </select>
                      </Field>
                    </>
                  )}
                </Form>}
              </Dialog>
            )}
          </>
        )}
      </Resource>
    </Dialog>
  );
}
