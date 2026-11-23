import {useCompactLayout} from '../lib/use-compact-layout';
import CcRecordFields from '../components/business/CcRecordFields';import {ccSelection} from '../lib/template-ui';import {usePublishedDictionary} from '../lib/use-published-dictionary';
import {readSavedView} from '../lib/field-views';
import ConfiguredList from '../components/business/ConfiguredList';
import MailboxUpdateButton from './MailboxUpdateButton';
import ConfiguredForm from "../components/business/ConfiguredForm";
import {
  ccTemplates,
  terminationReasons,
  transitionBody,
  commitCommand,
  transferBody,
  transferStart,
  rejectionReasons,
} from "../lib/prd";
import { useEffect, useState } from "react";
import { Plus, Trash, ArrowCounterClockwise } from "@phosphor-icons/react";
import { api, query, download } from "../lib/api";
import CandidateTools from "./CandidateTools";
import {
  useApp,
  useResource,
  useDebounced,
  Resource,
  stages,
  edu,
  education,
  date,
  tokens,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  Dialog,
  Form,
  Field,
  JobSelect,
  Empty,
  Pagination,
  Status,
  Tags,
  MatchScore,
  values,
} from "../components/ui";
export function TransitionDialog({
  application,
  target,
  jobs,
  onClose,
  onDone,
  transfer = false,
}: {
  application: Row;
  target?: string;
  jobs: Row[];
  onClose: () => void;
  onDone: (application?: Row) => void;
  transfer?: boolean;
}) {
  const [state, setState] = useState(
      target ||
        (transfer ? transferStart(application.status) : application.status),
    ),
    [job, setJob] = useState(""),
    [preview, setPreview] = useState<Row | null>(null);
  const cc=!!ccTemplates[state],reasonOptions=usePublishedDictionary("rejection_reasons"),terminationOptions=usePublishedDictionary("termination_reasons"),[ccRecord,setCcRecord]=useState<any>(null);
  return (
    <Dialog
      title={transfer ? "推荐至另一岗位" : "流转到新环节"}
      onClose={onClose}
    >
      <Form
        onCancel={onClose}
        submit={transfer && !preview ? "查看承接预览" : cc?"保存流转与抄送记录":"确认保存"}
        onSubmit={async (form) => {
          const b = values(form);
          if (transfer && !preview) {
            setPreview(
              await api(
                "/applications/" + application.id + "/transfer-preview",
                {
                  method: "POST",
                  body: { version: application.version, targetJobId: job },
                },
              ),
            );
            return;
          }
          await commitCommand(
            () =>
              api(
                "/applications/" +
                  application.id +
                  (transfer ? "/transfer" : "/transition"),
                {
                  method: "POST",
                  body: {...(transfer
                    ? transferBody(
                        {
                          version: application.version,
                          status: application.status,
                        },
                        job,
                        state,
                        b,
                      )
                    : transitionBody(
                        {
                          version: application.version,
                          status: application.status,
                        },
                        state,
                        b,
                      )),...(cc?ccSelection(ccRecord?.template,ccRecord?.ids||[],ccRecord?.method||"both"):{})},
                },
              ),
            (result: Row) => onDone(result),
          );
        }}
      >
        <p className="notice">
          {application.profile?.name} · {application.job_name} · 当前{" "}
          <Status value={application.status} />
        </p>
        {transfer ? (
          <>
            <Field label="目标岗位" required>
              <select
                name="jobId"
                value={job}
                onChange={(e) => {
                  setJob(e.target.value);setCcRecord(null);
                  setPreview(null);
                }}
                required
              >
                <option value="">请选择在招岗位</option>
                {jobs
                  .filter((j) => j.open && j.id !== application.job_id)
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
              </select>
            </Field>
            <p>
              原申请与所有历史保留，只有新岗位申请成为当前流程。已入职承接为已发
              offer，录用终止和淘汰承接为待筛选。
            </p>
            {application.status === "hired" && (
              <label className="check">
                <input required type="checkbox" />
                确认按内部转岗处理
              </label>
            )}
            {preview && (
              <p className="notice">
                默认承接：
                <Status value={preview.proposedStage} />
                ；保存后按新岗位重新计算匹配。
              </p>
            )}
          </>
        ) : (
          <Field label="目标环节">
            <select value={state} onChange={(e) => {setState(e.target.value);setCcRecord(null);}}>
              {stages.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        )}
        {transfer && (
          <Field label="目标环节">
            <select value={state} onChange={(e) => {setState(e.target.value);setCcRecord(null);}}>
              {stages.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {state === "hired_other" && <p className="notice">录用至其他主体，不进入本公司 offer 与入职流程。请在流转意见记录接收公司、对接人及不推进原因；单独计入招聘工作量。</p>}
        {["on_hold","reserve"].includes(state) && <p className="notice">保留当前岗位及全部历史，记录待定/储备依据和后续跟进安排。</p>}
        {state === "rejected" && (
          <>
            <Field label="淘汰原因" required>
              <select name="rejectReason" required>
                <option value="">请选择</option>
                {reasonOptions.data?.options.filter((o:Row)=>o.active||o.id===application.rejection_reason).map((o:Row)=><option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="淘汰详细说明" required>
              <textarea name="rejectDetail" required maxLength={3000} />
            </Field>
          </>
        )}
        {state === "terminated" && (
          <>
            <Field label="录用终止原因" required>
              <select name="termReason" required>
                <option value="">请选择</option>
                {terminationOptions.data?.options.filter((o:Row)=>o.active||o.id===application.term_reason).map((o:Row)=><option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="终止补充说明（其他原因必填）">
              <textarea name="termDetail" maxLength={3000} />
            </Field>
          </>
        )}
        <Field label="流转原因" required>
          <select name="reason" required>
            <option value="">请选择</option>
            {[
              "简历筛选通过",
              "面试评估通过",
              "补充资料完成",
              "背调完成",
              "录用审批通过",
              "候选人意愿变化",
              "岗位调整",
              "录用至其他主体",
              "待定跟进",
              "人才储备",
              "增加面试轮次",
              "其他",
            ].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <Field label={state==='hired_other'?'接收主体、去向与原因（至少 5 个字）':'流转意见（至少 5 个字）'} required>
          <textarea
            name="opinion"
            required
            minLength={5}
            maxLength={3000}
            rows={3}
            placeholder="记录本次流转依据与后续事项"
          />
        </Field>
        {cc&&(!transfer||job)&&<CcRecordFields key={state+':'+job} applicationId={application.id} stage={state} jobId={transfer?job:undefined} onChange={setCcRecord}/>}
        {["hired", "terminated", "rejected", "hired_other"].includes(application.status) &&
          state !== application.status &&
          !transfer && (
            <label className="check">
              <input required type="checkbox" />
              确认重新开启原终态流程，并保留历史
            </label>
          )}
      </Form>
    </Dialog>
  );
}
function PeopleNative({
  jobs,
  board = false,
  renderHeader = true,
}: {
  jobs: Row[];
  board?: boolean;
  renderHeader?: boolean;
}) {
  const {
      revision,
      refresh,
      notify,
      canWrite,
      canManage,
      openApplication,
      openPerson,
    } = useApp(),
    [job, setJob] = useState(
      new URLSearchParams(location.hash.split("?")[1] || "").get("job") || "",
    ),
    [text, setText] = useState(""),
    [page, setPage] = useState(1),
    [deleted, setDeleted] = useState(false),
    [mode, setMode] = useState(new URLSearchParams(location.hash.split('?')[1]||'').get('mode')==='people'?'people':'applications'),
    [tool, setTool] = useState(""),
    [academic, setAcademic] = useState(""),
    [skill, setSkill] = useState(""),
    [sort, setSort] = useState("new"),
    [flow, setFlow] = useState("all"),
    [stage, setStage] = useState(
      new URLSearchParams(location.hash.split("?")[1] || "").get("stage") || "",
    ),
    [edit, setEdit] = useState<Row | null>(null),
    [create, setCreate] = useState(false),
    search = useDebounced(text);
  const [moreFilters, setMoreFilters] = useState(false);
  const compact = useCompactLayout();
  const visibleStage = board && compact ? stage || "screening" : stage;
  useEffect(() => { setPage(1); }, [visibleStage]);
  const visibleStages = board ? stages.filter(([state]) => !["hired","terminated","rejected","hired_other"].includes(state)) : stages;
  const request = {
    lifecycle: board ? "active" : "all",
    jobId: job || undefined,
    query: search,
    page,
    pageSize: board ? 100 : 25,
    deleted,
    status: visibleStage || undefined,
    education: academic || undefined,
    skill: skill.trim(),
    sort,
    flow,
  };
  const result = useResource<Row>(
    (s) =>
      query(
        mode === "people" && !board
          ? "/candidates/query"
          : "/applications/query",
        mode === "people" && !board
          ? { query: search, page, deleted }
          : request,
        s,
      ),
    [
      job,
      search,
      page,
      deleted,
      mode,
      board,
      visibleStage,
      stage,
      academic,
      skill,
      sort,
      flow,
      revision,
    ],
  );
  const items = result.data?.items || [];
  const filters = (
    <>
      <JobSelect
        jobs={jobs}
        value={job}
        onChange={(v) => {
          setJob(v);
          setPage(1);
        }}
      />
      <input
        aria-label="搜索姓名或技能"
        placeholder="搜索姓名 / 技能 / 院校"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPage(1);
        }}
      />
      {
        <select
          aria-label="查看全部或指定环节"
          value={visibleStage}
          onChange={(e) => {
            setStage(e.target.value);
            setPage(1);
          }}
        >
          {!(board && compact) && <option value="">全部环节</option>}
          {visibleStages.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      }
      {!board && <button aria-expanded={moreFilters} onClick={() => setMoreFilters(!moreFilters)}>{moreFilters ? '收起筛选' : '更多筛选'}{(academic || skill || flow !== 'all' || deleted) ? ' · 已设置' : ''}</button>}
      {!board && mode === "applications" && moreFilters && (
        <>
          <select
            aria-label="人才库学历"
            value={academic}
            onChange={(e) => {
              setAcademic(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部学历</option>
            {education
              .filter(([v]) => !!v)
              .map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            <option value="unknown">未注明</option>
          </select>
          <input
            aria-label="按技能筛选人才库"
            placeholder="技能筛选（Java 不匹配 JavaScript）"
            value={skill}
            onChange={(e) => {
              setSkill(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="人才库排序"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            <option value="new">按上传时间</option>
            <option value="match">按匹配度</option>
            <option value="exp">按工作年限</option>
            <option value="name">按姓名</option>
          </select>
          <select
            aria-label="流转情况"
            value={flow}
            onChange={(e) => {
              setFlow(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部流转情况</option>
            <option value="transferred">有流转记录</option>
            <option value="never">无流转记录</option>
          </select>
        </>
      )}
      {!board && canManage && moreFilters && (
        <label className="check">
          <input
            type="checkbox"
            checked={deleted}
            onChange={(e) => {
              setDeleted(e.target.checked);
              setPage(1);
            }}
          />
          回收记录
        </label>
      )}
    </>
  );
  return (
    <>
      {renderHeader && <PageHeader
        title={board ? "招聘进行中" : "人才库"}
        description={board ? "按环节跟踪岗位申请" : "查询候选人档案与历史申请"}
      >
        {canWrite && <MailboxUpdateButton />}
      </PageHeader>}
      <div className="people-filters" role="search" aria-label="筛选人员与岗位申请">{filters}</div>
      {!board && canWrite && (
        <div className="toolbar section-toolbar">
          <div className="segments">
            {[
              ["applications", "岗位申请"],
              ["people", "候选人"],
            ].map(([v, t]) => (
              <button
                className={mode === v ? "active" : ""}
                key={v}
                onClick={() => {
                  setMode(v);
                  setPage(1);
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <button onClick={() => setTool("scan")}>查重扫描</button>
          <button onClick={() => setTool("reparse")}>重新解析</button>
          <button
            onClick={() =>
              api<Blob>("/candidates/ledger/export", {
                method: "POST",
                body: {
                  jobId: job || undefined,
                  query: search,
                  status: stage || undefined,
                  education: academic || undefined,
                  skill: skill.trim(),
                  flow,
                },
                raw: true,
              })
                .then((blob) =>
                  download(
                    blob,
                    "招聘进度汇总表-" +
                      new Date().toISOString().slice(0, 10) +
                      ".csv",
                  ),
                )
                .catch((e) => notify(e.message, true))
            }
          >
            导出台账（15 列）
          </button>
          <button onClick={() => setCreate(true)}>
            <Plus size={16} />
            新建候选人
          </button>
        </div>
      )}
      <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
        {board ? (
          <>
            <div className={"board recruitment-board" + (visibleStage ? " single-stage" : "")} tabIndex={0} role="region" aria-label="招聘环节看板">
              {visibleStages.filter(([state]) => !visibleStage || state === visibleStage).map(([state, title]) => {
                const list = items.filter((a: Row) => a.status === state);
                return (
                  <section
                    className={"board-column " + state}
                    key={state}
                    onDragOver={(e) => {
                      if (canWrite) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const a = items.find(
                        (x: Row) =>
                          x.id === e.dataTransfer.getData("text/plain"),
                      );
                      if (a && a.status !== state)
                        setEdit({ ...a, target: state });
                    }}
                  >
                    <header>
                      <strong>{title}</strong>
                      <span>{result.data?.stageCounts?.[state] || 0}</span>
                    </header>
                    <div className="board-cards">
                      {list.map((a: Row) => (
                        <article
                          className="candidate-card"
                          key={a.id}
                          draggable={canWrite}
                          onDragStart={(e) =>
                            e.dataTransfer.setData("text/plain", a.id)
                          }
                        >
                          <button
                            className="candidate-title"
                            onClick={() => openApplication(a.id)}
                          >
                            {a.profile.name}
                            <MatchScore match={a.match} />
                          </button>
                          <p title={a.job_name + " · " + a.profile.school}>
                            {a.job_name} · {a.profile.school || "院校未注明"}
                          </p>
                          <Tags
                            values={[
                              edu(a.profile.education),
                              a.profile.experienceYears == null
                                ? "年限未知"
                                : a.profile.experienceYears + "年",
                              a.profile.location,
                            ].filter(Boolean)}
                          />
                          <Tags values={a.profile.skills?.slice(0, 4)} />
                          {canWrite && (
                            <button
                              className="text-button small"
                              onClick={() => setEdit(a)}
                            >
                              调整环节
                            </button>
                          )}
                        </article>
                      ))}
                      {!list.length && (
                        <Empty>
                          {result.data?.stageCounts?.[state]
                            ? "此环节记录尚未在本页加载"
                            : "暂无候选人"}
                        </Empty>
                      )}
                      {list.length < (result.data?.stageCounts?.[state] || 0) &&
                        stage !== state && (
                          <button
                            onClick={() => {
                              setStage(state);
                              setPage(1);
                            }}
                          >
                            查看此环节全部 {result.data?.stageCounts?.[state]}{" "}
                            条
                          </button>
                        )}
                      {list.length > 0 && (
                        <small>
                          本页 {list.length} 条 / 此环节共{" "}
                          {result.data?.stageCounts?.[state] || 0} 条
                        </small>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
            <Pagination
              page={page}
              size={100}
              total={result.data?.total || 0}
              onChange={setPage}
            />
          </>
        ) : (
          <Panel>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>岗位 / 画像</th>
                    <th>{mode === "people" ? "申请数" : "当前环节"}</th>
                    <th>专业条件</th>
                    <th>来源 / 更新</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a: Row) => (
                    <tr key={a.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() =>
                            mode === "people"
                              ? openPerson(a.id)
                              : openApplication(a.id)
                          }
                        >
                          {a.profile.name}
                        </button>
                        {a.flow_count > 0 && (
                          <small className="flow-summary">
                            已流转 {a.flow_count} 次 · {date(a.last_flow_at)}
                          </small>
                        )}
                        <small>
                          {a.profile.phone ||
                            a.profile.email ||
                            "联系方式未注明"}
                        </small>
                      </td>
                      <td>
                        {a.job_name || (mode==='people'&&a.application_count===0?'岗位待确认':a.profile.school||"未关联岗位")}
                        <small>
                          {edu(a.profile.education)} ·{" "}
                          {a.profile.experienceYears ?? "未知"} 年
                        </small>
                      </td>
                      <td>
                        {mode === "people" ? (
                          a.application_count
                        ) : (
                          <>
                            <Status value={a.status} />
                            {a.status === "terminated" && (
                              <small className="termination-summary">
                                录用终止：{a.term_reason || "待补录"}
                              </small>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {mode === "people" ? (
                          <Tags values={a.profile.skills?.slice(0, 3)} />
                        ) : (
                          <MatchScore match={a.match} />
                        )}
                      </td>
                      <td>
                        {a.source}
                        <small>{date(a.updated_at)}</small>
                      </td>
                      <td>
                        {deleted ? (
                          <button
                            onClick={() => setEdit({ ...a, restore: true })}
                          >
                            <ArrowCounterClockwise size={15} />
                            恢复
                          </button>
                        ) : (
                          <button
                            onClick={() =>
                              mode === "people"
                                ? openPerson(a.id)
                                : openApplication(a.id)
                            }
                          >
                            查看档案
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!items.length && (
                <Empty>{text ? "试试放宽搜索条件" : "暂无记录"}</Empty>
              )}
            </div>
            <Pagination
              page={page}
              total={result.data?.total || 0}
              onChange={setPage}
            />
          </Panel>
        )}
      </Resource>
      {edit &&
        (edit.restore ? (
          <Dialog title="恢复历史记录" onClose={() => setEdit(null)}>
            <Form
              onCancel={() => setEdit(null)}
              onSubmit={async (form) => {
                await api(
                  "/" +
                    (mode === "people" ? "candidates" : "applications") +
                    "/" +
                    edit.id +
                    "/delete",
                  {
                    method: "POST",
                    body: {
                      version: edit.version,
                      reason: values(form).reason,
                      restore: true,
                    },
                  },
                );
                setEdit(null);
                refresh();
              }}
            >
              <p>
                恢复原记录与历史。相同候选人的同一岗位已有有效申请时会拒绝冲突。
              </p>
              <Field label="恢复理由" required>
                <input name="reason" required />
              </Field>
            </Form>
          </Dialog>
        ) : (
          <TransitionDialog
            application={edit}
            target={edit.target}
            jobs={jobs}
            onClose={() => setEdit(null)}
            onDone={() => {
              setEdit(null);
              refresh();
              notify("环节已保存");
            }}
          />
        ))}
      {tool && (
        <CandidateTools mode={tool} jobs={jobs} onClose={() => setTool("")} />
      )}
      {create && (
        <Dialog title="新建候选人" onClose={() => setCreate(false)}>
          <ConfiguredForm kind="resume" coreOnly mode="create" core={{}} onCancel={()=>setCreate(false)} onSubmit={async body=>{
            const person=await api<Row>('/candidates',{method:'POST',body});setCreate(false);refresh();openPerson(person.id);
          }}><p className="notice">先建立人员档案，再关联岗位；简历扩展事实需通过简历核对版本保存。</p></ConfiguredForm>
        </Dialog>
      )}
    </>
  );
}

export default function People(props: { jobs: Row[]; board?: boolean }) {
  const { openApplication, canWrite } = useApp();
  const [kind, setKind] = useState<"resume" | "application">(() => readSavedView(location.hash, 'application') ? 'application' : 'resume');
  const [fields, setFields] = useState(() => !!readSavedView(location.hash, kind));
  if (props.board) return <PeopleNative {...props} />;
  return <>
    <PageHeader title="人才库" description="查询候选人档案与历史申请">
      <button aria-expanded={fields} onClick={() => setFields(!fields)}>{fields ? '返回业务列表' : '字段视图与导出'}</button>
      {canWrite && <MailboxUpdateButton />}
    </PageHeader>
    {fields && <div className="people-view-options"><label>字段视图对象 <select value={kind} onChange={e => setKind(e.target.value as 'resume' | 'application')}><option value="resume">已采用简历事实</option><option value="application">岗位申请沟通</option></select></label></div>}
    {fields ? <ConfiguredList kind={kind} action={r => <button onClick={() => openApplication(kind === 'resume' ? r.application_id : r.id)}>打开岗位申请</button>} /> : <PeopleNative {...props} renderHeader={false} />}
  </>;
}
