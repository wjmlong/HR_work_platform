import JobTemplates from './business-config/JobTemplates';
import ConfiguredList from '../components/business/ConfiguredList';
import ConfiguredForm from "../components/business/ConfiguredForm";
import {useBusinessDefinition} from "../lib/use-business-definition";
import { useState } from "react";
import { api } from "../lib/api";
import { useApp, education, edu, tokens, date, type Row } from "../lib/state";
import { skillTokens } from "../lib/prd";
import {
  PageHeader,
  Panel,
  Dialog,
  Form,
  Field,
  Tags,
  Empty,
  values,
  CopyButton,
} from "../components/ui";
const levels = [
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "M1",
  "M2",
  "M3",
  "专业服务",
];
export default function Jobs({ jobs }: { jobs: Row[] }) {
  const { refresh, notify, canWrite } = useApp(),
    definition = useBusinessDefinition("job"),
    [fieldMode,setFieldMode]=useState(false),[templates,setTemplates]=useState<Row|null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [close, setClose] = useState<Row | null>(null),
    [jd, setJd] = useState<Row | null>(null),
    [fStatus,setFStatus]=useState(''),[fLevel,setFLevel]=useState(''),[fDept,setFDept]=useState(''),[fSkill,setFSkill]=useState(''),
    [deptPeek,setDeptPeek]=useState('');
  const peekDept=deptPeek||String(edit?.department||''),
    peekJobs=jobs.filter(j=>j.open&&String(j.department||'')===peekDept),
    peekPlanned=peekJobs.reduce((n,j)=>n+Number(j.headcount||0),0),
    levels=[...new Set(jobs.map(j=>String(j.level||'未定级')))].sort(),
    departments=[...new Set(jobs.map(j=>String(j.department||'—')))].sort(),
    skillOptions=[...new Set(jobs.flatMap(j=>(j.hard_skills||[]) as string[]))].sort(),
    shownJobs=jobs.filter(j=>{
      if(fStatus==='open'&&!j.open)return false;
      if(fStatus==='closed'&&j.open)return false;
      if(fLevel&&String(j.level||'未定级')!==fLevel)return false;
      if(fDept&&String(j.department||'—')!==fDept)return false;
      if(fSkill&&!(j.hard_skills||[]).includes(fSkill))return false;
      return true;
    });
  async function toggle(j: Row) {
    try {
      if (j.open) {
        setClose({
          job: j,
          ...(await api("/jobs/" + j.id + "/close-preview", {
            method: "POST",
            body: { version: j.version },
          })),
        });
      } else {
        if (!j.level) {
          setEdit(j);
          notify("请先补充内部岗位等级再重新开启");
          return;
        }
        await api("/jobs/" + j.id, {
          method: "PATCH",
          body: { version: j.version, level: j.level, open: true,definitionVersion:definition.data?.ref.version,definitionRevision:definition.data?.aclRevision },
        });
        refresh();
      }
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  return (
    <>
      <PageHeader
        title="岗位管理"
        description="维护在招岗位与任职要求"
      >
        {canWrite && (
          <button className="primary" onClick={() => setEdit({})}>
            ＋ 新建岗位
          </button>
        )}
      </PageHeader>
      <div className="segments section-toolbar"><button className={fieldMode?'active':''} onClick={()=>setFieldMode(true)}>字段视图与导出</button><button className={!fieldMode?'active':''} onClick={()=>setFieldMode(false)}>常规业务列表</button></div>
      {fieldMode?<ConfiguredList kind="job" action={row=><>{canWrite&&<button className="small" onClick={()=>{const job=jobs.find(j=>j.id===row.id);if(job)setEdit(job);else notify('岗位已变化，请刷新后重试',true);}}>编辑</button>}<button className="small" disabled={!canWrite} onClick={()=>setTemplates(jobs.find(j=>j.id===row.id)||row)}>招聘模板</button><a className="small" href={"#people?job="+row.id}>查看申请</a></>}/>:<Panel action={<small className="hint" title="筛选只作用于当前岗位列表，不改动服务器数据">显示 {shownJobs.length} / {jobs.length} 个岗位</small>}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>岗位名称</th>
                <th className="filterable">等级
                  <select className="th-filter" aria-label="按等级筛选" value={fLevel} onChange={e=>setFLevel(e.target.value)}>
                    <option value="">全部</option>{levels.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </th>
                <th className="filterable">状态
                  <select className="th-filter" aria-label="按状态筛选" value={fStatus} onChange={e=>setFStatus(e.target.value)}>
                    <option value="">全部</option><option value="open">在招</option><option value="closed">已关闭</option>
                  </select>
                </th>
                <th className="filterable">部门 / 需求 / 紧急度
                  <select className="th-filter" aria-label="按部门筛选" value={fDept} onChange={e=>setFDept(e.target.value)}>
                    <option value="">全部部门</option>{departments.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </th>
                <th>薪资区间 / 市场参考</th>
                <th className="filterable">硬性技能
                  <select className="th-filter" aria-label="按技能筛选" value={fSkill} onChange={e=>setFSkill(e.target.value)}>
                    <option value="">全部技能</option>{skillOptions.map(v=><option key={v} value={v}>{v}</option>)}
                  </select>
                </th>
                <th>收到简历</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shownJobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <strong>{j.name}</strong>
                    <small
                      className="job-note-clamp"
                      title={
                        (j.requirements?.experienceDescription ||
                          (j.requirements?.experienceYears == null
                            ? "经验不限"
                            : j.requirements?.experienceYears + " 年以上")) +
                        " · " +
                        edu(j.requirements?.education)
                      }
                    >
                      {j.requirements?.experienceDescription ||
                        (j.requirements?.experienceYears == null
                          ? "经验不限"
                          : j.requirements?.experienceYears + " 年以上")}{" "}
                      · {edu(j.requirements?.education)}
                    </small>
                  </td>
                  <td>
                    <span className={j.level ? "grade" : "missing"}>
                      {j.level || "未定级"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={"status " + (j.open ? "replied" : "declined")}
                    >
                      {j.open ? "在招" : "已关闭"}
                    </span>
                    {!j.open && (
                      <small>{j.close_reason || date(j.closed_at)}</small>
                    )}
                  </td>
                  <td>
                    {j.department || "—"}
                    <small>
                      需求 {j.headcount} 人 ·{" "}
                      {j.urgency === "urgent" ? "紧急" : "常规"}
                    </small>
                  </td>
                  <td>
                    {j.salary_visible ? (
                      <>
                        {j.salary_range || <span className="missing">未填写</span>}
                        <small>市场：{j.market_salary || <span className="missing">未填写</span>}</small>
                        <small>
                          来源：{j.market_source || <span className="missing">未填写</span>}{" "}
                          {j.market_reference_date}
                        </small>
                        {j.salary_note && <small>建议：{j.salary_note}</small>}
                      </>
                    ) : (
                      <span className="muted">未获内部薪资权限</span>
                    )}
                  </td>
                  <td title={((j.hard_skills?.length?j.hard_skills:j.requirements?.skills||[]) as string[]).join('、')||'未配置技能组'}>
                    <Tags values={(j.hard_skills?.length?j.hard_skills:j.requirements?.skills||[]).slice(0, 5)} />
                  </td>
                  <td>
                    <a className="text-button" href={"#people?job=" + j.id}>
                      {j.resume_count || 0}
                    </a>
                  </td>
                  <td>
                    <div className="toolbar cell-actions">
                      {canWrite && (
                        <>
                          <button className="small" onClick={() => setEdit(j)}>编辑</button>
                          <button className="small" onClick={()=>setTemplates(j)}>招聘模板</button>
                          <button className="small" onClick={() => void toggle(j)}>
                            {j.open ? "关闭" : "重新开启"}
                          </button>
                        </>
                      )}
                      <button
                        className="small"
                        onClick={() =>
                          api<Row>("/jobs/" + j.id + "/public-jd")
                            .then(setJd)
                            .catch((e) => notify(e.message, true))
                        }
                      >
                        对外 JD
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!jobs.length && <Empty>暂无岗位</Empty>}
        </div>
      </Panel>}
      {templates&&<JobTemplates job={templates} onClose={()=>setTemplates(null)}/>}
      {edit && (
        <Dialog
          title={edit.id ? "编辑岗位" : "新建岗位"}
          onClose={() => setEdit(null)}
          wide
        >
          <ConfiguredForm kind="job" id={edit.id} mode={edit.id?"edit":"create"}
            core={{...edit,headcount:edit.headcount??1,urgency:edit.urgency??'normal',salaryRange:edit.salary_range,marketSalary:edit.market_salary,marketSource:edit.market_source,marketReferenceDate:edit.market_reference_date,salaryNote:edit.salary_note}}
            customFields={edit.customFields} onCancel={()=>setEdit(null)} onSubmit={async body=>{
              await api(edit.id?'/jobs/'+edit.id:'/jobs',{method:edit.id?'PATCH':'POST',body:{...body,...(edit.id?{version:edit.version}:{})}});
              setEdit(null);refresh();notify('岗位已保存');
            }}>
            <p className="notice">年龄、性别不参与自动筛选、评分或排序。内部薪酬仅用于招聘参考。</p>
            <div className="toolbar">
              <label>编制对照
                <select aria-label="按部门查看编制对照" value={deptPeek} onChange={e=>setDeptPeek(e.target.value)}>
                  <option value="">{edit?.department?`本岗位部门：${edit.department}`:"选择部门"}</option>
                  {departments.filter(v=>v!=='—').map(v=><option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <small>{peekDept?`该部门在招 ${peekJobs.length} 个岗位 · 计划招聘 ${peekPlanned} 人`:"选择部门后显示现有编制"}<span className="hint" title="按岗位档案中同部门、状态为在招的记录统计；计划人数取各岗位「需求人数」合计，不含本次新建岗位">口径</span></small>
            </div>
          </ConfiguredForm>
        </Dialog>
      )}
      {close && (
        <Dialog title="确认关闭招聘" onClose={() => setClose(null)}>
          <Form
            onCancel={() => setClose(null)}
            submit="确认关闭"
            onSubmit={async (form) => {
              const b = values(form);
              await api("/jobs/" + close.job.id, {
                method: "PATCH",
                body: {
                  version: close.job.version,
                  definitionVersion:definition.data?.ref.version,definitionRevision:definition.data?.aclRevision,
                  level: b.level || close.job.level,
                  open: false,
                  closeConfirm: true,
                  closePreviewHash: close.hash,
                  closeReason: b.reason,
                },
              });
              setClose(null);
              refresh();
            }}
          >
            <p className={close.count ? "notice warning" : "notice"}>
              当前仍有 {close.count} 位非终态候选人。关闭后岗位关系和历史保留。
            </p>
            {close.count > 0 && (
              <p>
                {close.candidates.map((c: Row) => c.name).join("、")}
                {close.count > 50 ? "等" : ""}
              </p>
            )}
            {!close.job.level && (
              <Field label="内部岗位等级" required>
                <select name="level" required>
                  <option value="">请补充等级</option>
                  {(definition.data?.fields.find(f=>f.coreKey==='level')?.options.filter(o=>o.active).map(o=>o.id)||[]).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="关闭原因">
              <textarea name="reason" />
            </Field>
          </Form>
        </Dialog>
      )}
      {jd && (
        <Dialog title={jd.name + " · 对外 JD"} onClose={() => setJd(null)} wide>
          <CopyButton
            text={[
              jd.name,
              jd.department,
              jd.description,
              "技能：" + jd.skills.join("、"),
            ].join("\n")}
          />
          <p className="raw-text">{jd.description}</p>
          <Tags values={jd.skills} />
          <p>
            {edu(jd.education)} · {jd.experienceYears ?? "不限"}
            {jd.experienceMaxYears != null
              ? "-" + jd.experienceMaxYears
              : ""}{" "}
            年
          </p>
        </Dialog>
      )}
    </>
  );
}
