import { useState } from "react";
import { api, downloadCsv } from "../lib/api";
import { useApp, useResource, Resource, date, type Row } from "../lib/state";
import { Panel, Field, Form, Dialog, Empty } from "../components/ui";

const GRADES = ["初级", "中级", "高级", "特殊"] as const;
const WEIGHT: Record<string, string> = { 初级: "1.0", 中级: "1.5", 高级: "2.0", 特殊: "一人一议 ≤4.0" };
const RELATIONS = ["前同事", "朋友", "亲属", "其他"] as const;
const EXCLUSIONS: Record<string, string> = {
  none: "无",
  false_material: "虚假材料 / 隐瞒重要信息",
  candidate_abandon: "被推荐人本人原因放弃",
  early_leave: "入职 6 个月内离职 / 试用期不合格",
  violation: "违反办法或规章制度",
};
const EXCLUDED_PERSONS: Record<string, string> = {
  none: "无",
  hr_recruiter: "HR / 专职招聘岗",
  interviewer: "面试官 / 评委 / 审批人",
  conflict_of_interest: "直接上下级或亲属等利益关系",
  current_or_recent_employee: "现职员工 / 离职未满 6 个月",
};
const REVIEWS: Record<string, string> = { pending: "待审核", approved: "审核通过", rejected: "审核不通过" };
const STAGES: [string, string, number][] = [["interview", "面试", 1], ["offered", "录用", 5], ["hired", "入职", 10]];

const csv = downloadCsv;
const emptyStages = () => ({ interview: false, offered: false, hired: false });
const blank = () => ({
  referrerName: "", referrerDept: "", referrerJob: "", referrerPhone: "",
  candidateName: "", targetJob: "", grade: "初级", education: "", currentOrg: "", candidatePhone: "",
  relation: "前同事", relationOther: "", channel: "", reason: "", signedAt: new Date().toISOString().slice(0, 10),
  excludedPerson: "none", conflictDeclared: false, stages: emptyStages(), specialScore: null,
  exclusion: "none", review: "pending", confirmed: false,
});
const blankCheck = () => ({ referrerName: "", candidateName: "", candidatePhone: "", targetJob: "" });

export default function Referrals({ jobs }: { jobs: Row[] }) {
  const { notify, revision, canWrite } = useApp();
  const data = useResource<Row>((s) => api("/referrals/overview", { signal: s }), [revision]);
  const [draft, setDraft] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [checkForm, setCheckForm] = useState<Row>(blankCheck());
  const [checkResult, setCheckResult] = useState<Row | null>(null);
  const [fYear, setFYear] = useState(""), [fReview, setFReview] = useState(""), [fGrade, setFGrade] = useState(""), [fKey, setFKey] = useState("");
  const [onlyDuplicate, setOnlyDuplicate] = useState(false), [onlyFlagged, setOnlyFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = data.data;
  const autoFlags = (row: Row) => (row.flags || []).filter((f: Row) => f.level === "auto");
  const items: Row[] = (d?.items || []).filter((row: Row) => {
    const r = row.referral || {};
    if (fYear && String(row.created_at || "").slice(0, 4) !== fYear) return false;
    if (fReview && r.review !== fReview) return false;
    if (fGrade && r.grade !== fGrade) return false;
    if (fKey && ![r.referrerName, r.candidateName, r.targetJob].some((v: string) => String(v || "").includes(fKey))) return false;
    if (onlyDuplicate && !r.duplicateOf) return false;
    if (onlyFlagged && !autoFlags(row).length && (!r.excludedPerson || r.excludedPerson === "none")) return false;
    return true;
  });
  const years: string[] = ([...new Set((d?.items || []).map((r: Row) => String(r.created_at || "").slice(0, 4)))] as string[]).filter(Boolean).sort().reverse();
  const patch = (k: string, v: unknown) => setDraft((s) => ({ ...(s || blank()), [k]: v }));
  const patchStage = (k: string, v: boolean) => setDraft((s) => ({ ...(s || blank()), stages: { ...((s || blank()).stages || emptyStages()), [k]: v } }));
  const patchEdit = (k: string, v: unknown) => setEditing((s) => ({ ...(s || {}), referral: { ...((s as any)?.referral || {}), [k]: v } }));
  const patchEditStage = (k: string, v: boolean) => setEditing((s) => ({ ...(s || {}), referral: { ...((s as any)?.referral || {}), stages: { ...(((s as any)?.referral?.stages) || emptyStages()), [k]: v } } }));

  const runCheck = async (input?: Row) => {
    const b = input || checkForm;
    if (input) setCheckForm({ referrerName: b.referrerName || "", candidateName: b.candidateName || "", candidatePhone: b.candidatePhone || "", targetJob: b.targetJob || "" });
    try {
      const r = await api<Row>("/referrals/check", { method: "POST", body: {
        referrerName: b.referrerName || "", candidateName: b.candidateName || "",
        candidatePhone: b.candidatePhone || "", targetJob: b.targetJob || "",
      } });
      setCheckResult(r);
      notify(r.duplicateCount ? "查到重复登记，请按第八条确认有效推荐人" : "核查完成，未发现重复登记");
    } catch (e) { notify((e as Error).message, true); }
  };
  const submitNew = async () => {
    if (!draft) return;
    const b = draft;
    if (!String(b.referrerName || "").trim() || !String(b.candidateName || "").trim() || !String(b.targetJob || "").trim()) {
      notify("推荐人、被推荐人、应聘岗位为必填", true); return;
    }
    setBusy(true);
    try {
      const res = await api<Row>("/referrals", { method: "POST", body: { ...b, specialScore: b.grade === "特殊" ? Number(b.specialScore || 0) : null } });
      notify(res?.duplicateOf ? "已登记，但存在更早的同人推荐，本条不重复计分" : "登记已保存，待人力资源部形式审核");
      setDraft(null); data.reload();
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const submitEdit = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = editing.referral || {};
      await api("/referrals/" + editing.id, {
        method: "PATCH",
        body: {
          version: editing.version,
          stages: r.stages || emptyStages(),
          specialScore: r.grade === "特殊" ? Number(r.specialScore || 0) : null,
          exclusion: r.exclusion || "none",
          excludedPerson: r.excludedPerson || "none",
          review: r.review || "pending",
          confirmed: !!r.confirmed,
          conflictDeclared: !!r.conflictDeclared,
          reason: r.reason || "",
        },
      });
      notify("进展已更新，积分按办法重新计算");
      setEditing(null); data.reload();
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const exportLedger = async () => {
    try {
    const exported=await api<Row>('/referrals/overview?mode=export');
    const selected=new Set(items.map(x=>x.id));
    const records=(exported.items || []).filter((x:Row)=>selected.has(x.id));
    csv("内推积分核对登记表.csv", [
    ["序号", "推荐人", "被推荐人", "岗位/档位", "面试 1 分", "录用 5 分", "入职 10 分", "基础分", "权重", "积分合计", "折算金额 元", "核对确认", "备注"],
    ...records.map((row: Row, i: number) => {
      const r = row.referral || {}, c = r.computed || {};
      return [i + 1, r.referrerName, r.candidateName, `${r.targetJob} / ${r.grade}`,
        r.stages?.interview ? 1 : 0, r.stages?.offered ? 5 : 0, r.stages?.hired ? 10 : 0,
        c.base ?? 0, c.weight ?? "一人一议", c.score ?? 0, c.amountCny ?? 0,
        r.confirmed ? "已核对" : "未核对", (c.notes || []).join("；")];
    }),
    ["", "合计", "", "", "", "", "", "", "", records.reduce((n: number, x: Row) => n + Number(x.referral?.computed?.score || 0), 0),
      records.reduce((n: number, x: Row) => n + Number(x.referral?.computed?.amountCny || 0), 0), "", "每年 12 月 31 日截止统计"],
  ]);
    } catch(e) { notify((e as Error).message,true); }
  };
  const exportByReferrer = async () => {
    try { const exported=await api<Row>('/referrals/overview?mode=export');
      csv('内推年度汇总-按推荐人.csv', [['推荐人','推荐数','积分合计','折算金额 元','说明'],...(exported.byReferrer || []).map((x:Row)=>[x.name,x.count,x.score,x.amount,'1 分折算 50 元，计入当年度奖金'])]);
    } catch(e) { notify((e as Error).message,true); }
  };

  return <>
    <Resource {...data} retry={data.reload}>
      {d && <>
        <Panel title="内推积分规则" action={<small className="hint" title="依据《山子高科内部推荐管理办法（试行）V3》2026-10-19 发布；自发布之日起施行，试行期一年">制度依据与试行期</small>}>
          <div className="kpi-grid sourcing-kpis">
            {[
              ["初级档", "1.0×"], ["中级档", "1.5×"], ["高级档", "2.0×"], ["特殊档 · 一人一议", "≤4.0×"],
            ].map(([t, v]) => <div className="kpi" key={String(t)}><strong>{v}</strong><span>{t}</span></div>)}
          </div>
          <ul className="rule-points">
            <li><strong>阶段基础分</strong>　面试 1 分 · 录用 5 分 · 入职 10 分 <span className="hint" title="办法第十条。基础分按被推荐人实际进展累计，未提供材料或未进入该阶段不计分">条款</span></li>
            <li><strong>最终积分</strong>　阶段累计分 × 档位权重，单次封顶 50 分 <span className="hint" title="办法第九、十一条。示例：高级档完成面试、录用、入职，16 × 2.0 = 32 分">计算示例</span></li>
            <li><strong>特殊档</strong>　一人一议，权重上限 4.0 倍，按议定积分填写 <span className="hint" title="办法第六条。人力资源部会同用人部门逐案提出意见，审批后执行，不适用统一积分权重">认定方式</span></li>
            <li><strong>折算与结算</strong>　1 分折算 50 元，计入当年度奖金 <span className="hint" title="办法第十二条。每年 12 月 31 日截止统计，由人力资源部统一核对、登记、结算；积分不可转让、不可兑换现金单独发放">结算口径</span></li>
            <li><strong>有效推荐人</strong>　同一人选以最先提交且材料完备者为准 <span className="hint" title="办法第八条。后推荐的不再重复计分；形式审核确认无重复推荐、无利益冲突后纳入正常招聘流程">查重依据</span></li>
            <li><strong>不纳入积分</strong>　参与资格、利益关系与排除情形 <span className="hint" title="办法第十三条：HR 及专职招聘岗、面试官 / 评委 / 审批人、直接上下级及亲属等利益关系人员不享受激励；第十四条：现职员工或离职未满 6 个月的原员工不纳入积分；第十五条：虚假材料、本人原因放弃、入职 6 个月内离职或试用期不合格、违规等按对应条款处理">适用条款</span></li>
          </ul>
        </Panel>

        <Panel title="查重与参与资格核查" action={<small className="hint" title="查重按被推荐人姓名与手机号；自动命中只基于系统已有数据，亲属关系与离职日期无对应字段，需推荐人声明并由 HR 核对">核查口径</small>}>
          <div className="toolbar referral-check-bar">
            <input aria-label="被推荐人姓名" placeholder="被推荐人姓名" value={checkForm.candidateName} onChange={e => setCheckForm(s => ({ ...s, candidateName: e.target.value }))} />
            <input aria-label="被推荐人手机号" placeholder="手机号" value={checkForm.candidatePhone} onChange={e => setCheckForm(s => ({ ...s, candidatePhone: e.target.value }))} />
            <input aria-label="推荐人姓名" placeholder="推荐人姓名" value={checkForm.referrerName} onChange={e => setCheckForm(s => ({ ...s, referrerName: e.target.value }))} />
            <input aria-label="应聘岗位" placeholder="应聘岗位" value={checkForm.targetJob} onChange={e => setCheckForm(s => ({ ...s, targetJob: e.target.value }))} />
            <button className="primary small" onClick={() => void runCheck()}>核查</button>
          </div>
          {checkResult && <ul className="rule-points compact">
            <li><strong>重复登记 {checkResult.duplicateCount} 条</strong>　{checkResult.validReferrer ? `有效推荐人：${checkResult.validReferrer}` : "未发现同人登记"} <span className="hint" title={checkResult.note || ""}>判定说明</span></li>
            {(checkResult.flags || []).map((f: Row) => <li key={f.code}>
              <strong>{f.label}</strong>　{f.level === "auto" ? "系统自动命中" : "需人工确认"} <span className="hint" title={f.basis}>依据</span>
            </li>)}
          </ul>}
          <div className="kpi-grid sourcing-kpis">
            {[
              ["重复推荐记录", d.exclusionSummary?.duplicateRecords ?? 0],
              ["重复推荐组", d.exclusionSummary?.duplicateGroups ?? 0],
              ["自动命中排除", d.exclusionSummary?.autoFlagged ?? 0],
              ["已声明排除", d.exclusionSummary?.declaredExcluded ?? 0],
            ].map(([t, v]) => <div className="kpi" key={String(t)}><strong>{v}</strong><span>{t}</span></div>)}
          </div>
          <h4>重复推荐组 <small className="hint" title="按被推荐人姓名与手机号归组；组内最早一条为有效推荐人，其余不重复计分">分组口径</small></h4>
          <div className="table-scroll"><table><thead><tr><th>被推荐人</th><th>记录数</th><th>有效推荐人</th><th>最早登记</th><th>处理结果</th></tr></thead><tbody>
            {(d.duplicates || []).map((g: Row) => <tr key={g.key}>
              <td>{g.candidateName}<small>{g.candidatePhone || "未填手机号"}</small></td>
              <td>{g.count}</td><td>{g.validReferrer}</td><td>{date(g.validAt)}</td>
              <td>其余 {g.laterIds?.length || 0} 条不重复计分</td>
            </tr>)}
          </tbody></table></div>
          {!d.duplicates?.length && <Empty>暂无重复推荐</Empty>}
        </Panel>

        <Panel title="推荐登记台账" action={<div className="toolbar">
          {canWrite && <button className="primary small" onClick={() => setDraft(blank())}>＋ 新增推荐登记</button>}
          <button className="small" onClick={exportLedger}>导出年底核对表</button>
          <button className="small" onClick={exportByReferrer}>导出按推荐人汇总</button>
        </div>}>
          <div className="toolbar">
            <select aria-label="按年度筛选" value={fYear} onChange={e => setFYear(e.target.value)}><option value="">全部年度</option>{years.map((y: string) => <option key={y} value={y}>{y} 年</option>)}</select>
            <select aria-label="按审核状态筛选" value={fReview} onChange={e => setFReview(e.target.value)}><option value="">全部状态</option>{Object.entries(REVIEWS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
            <select aria-label="按档位筛选" value={fGrade} onChange={e => setFGrade(e.target.value)}><option value="">全部档位</option>{GRADES.map(g => <option key={g} value={g}>{g} 档</option>)}</select>
            <input aria-label="搜索推荐人或被推荐人" placeholder="搜推荐人 / 被推荐人 / 岗位" value={fKey} onChange={e => setFKey(e.target.value)} />
            <label className="check"><input type="checkbox" checked={onlyDuplicate} onChange={e => setOnlyDuplicate(e.target.checked)} />仅看重复</label>
            <label className="check"><input type="checkbox" checked={onlyFlagged} onChange={e => setOnlyFlagged(e.target.checked)} />仅看命中排除</label>
            <small>显示 {items.length} / {d.items?.length || 0} 条</small>
          </div>
          <div className="table-scroll"><table><thead><tr>
            <th>登记日</th><th>推荐人</th><th>被推荐人</th><th>岗位 / 档位</th><th>阶段进展</th><th>基础分</th><th>权重</th><th>最终积分</th><th>折算金额</th><th>审核</th><th>资格核查</th><th>积分说明</th><th>核对</th><th>操作</th>
          </tr></thead><tbody>
            {items.map((row: Row) => {
              const r = row.referral || {}, c = r.computed || {}, flags = autoFlags(row);
              return <tr key={row.id}>
                <td>{date(row.created_at)}</td>
                <td>{r.referrerName}<small>{r.referrerDept || "部门未填"}</small></td>
                <td>{r.candidateName}<small>{r.currentOrg || "现单位未填"}</small></td>
                <td>{r.targetJob}<small>{r.grade} 档 · {WEIGHT[r.grade] || ""}</small></td>
                <td>{STAGES.map(([k, t, p]) => <span key={k} className="muted" style={{ marginRight: 8 }}>{r.stages?.[k] ? `✓${t} ${p}分` : `○${t}`}</span>)}</td>
                <td>{c.base ?? 0}</td>
                <td>{c.weight ?? "议定"}</td>
                <td><strong>{c.score ?? 0}</strong></td>
                <td>{c.amountCny ?? 0} 元</td>
                <td>{REVIEWS[r.review] || "待审核"}{r.duplicateOf && <small>重复推荐</small>}</td>
                <td><small className="hint" title={(row.flags || []).map((f: Row) => `${f.label}：${f.basis}`).join("；")}>{flags.length ? `${flags.length} 项自动命中` : "无自动命中"}</small>
                  {r.excludedPerson && r.excludedPerson !== "none" && <small>{EXCLUDED_PERSONS[r.excludedPerson]}</small>}</td>
                <td><small className="hint" title={(c.notes || []).join("；") || "按办法第九、十条计算"}>{(c.notes || [])[0]?.slice(0, 16) || "按公式计分"}{(c.notes || []).length > 1 ? " 等" : ""}</small></td>
                <td>{r.confirmed ? "已核对" : "未核对"}</td>
                <td>{canWrite && <button className="small" onClick={() => setEditing({ ...row, referral: { ...r } })}>更新进展</button>}</td>
              </tr>;
            })}
          </tbody></table></div>
          {!items.length && <Empty>暂无内推登记；点击「新增推荐登记」按附件一录入</Empty>}
        </Panel>

        <Panel title="年度积分汇总" action={<small className="hint" title="附件二《年底积分核对登记表》口径：按推荐人汇总，经推荐人核对确认后作为年度奖金核算依据">附件二口径</small>}>
          <div className="table-scroll"><table><thead><tr><th>推荐人</th><th>推荐数</th><th>积分合计</th><th>折算金额 元</th></tr></thead><tbody>
            {(d.byReferrer || []).map((x: Row) => <tr key={x.name}><td>{x.name}</td><td>{x.count}</td><td>{x.score}</td><td>{x.amount}</td></tr>)}
          </tbody></table></div>
          {!d.byReferrer?.length && <Empty>暂无可结算积分</Empty>}
          <p className="muted">积分仅作为年度奖金核算依据 <span className="hint" title="办法第十二条：积分不可转让、不可兑换为现金单独发放">条款</span></p>
        </Panel>
      </>}
    </Resource>

    {draft && <Dialog title="内部推荐登记表" onClose={() => setDraft(null)} wide>
      <Form submit={busy ? "正在保存…" : "提交登记"} onCancel={() => setDraft(null)} onSubmit={submitNew}>
        <ul className="rule-points compact">
          <li>字段对应制度附件一 <span className="hint" title="推荐人姓名、所属部门、岗位、联系电话；被推荐人姓名、应聘岗位、职级档位、最高学历、现单位、手机号、关系、渠道来源、推荐理由、签名与填报日期">字段清单</span></li>
          <li>提交后由人力资源部做形式审核 <span className="hint" title="办法第七条：确认无重复推荐、利益冲突等情形后纳入正常招聘流程">流程依据</span></li>
          <li>推荐人对被推荐人信息负有保密义务 <span className="hint" title="办法第十八条：不得泄露或用于与招聘无关的其他用途">保密要求</span></li>
        </ul>
        <div className="toolbar"><button type="button" className="small" onClick={() => void runCheck(draft)}>先核查重复与资格</button>
          {checkResult && <small className="hint" title={(checkResult.flags || []).map((f: Row) => f.basis).join("；")}>重复 {checkResult.duplicateCount} 条 · 自动命中 {(checkResult.flags || []).filter((f: Row) => f.level === "auto").length} 项</small>}
        </div>
        <div className="form-grid">
          <Field label="推荐人姓名" required><input value={draft.referrerName} onChange={e => patch("referrerName", e.target.value)} /></Field>
          <Field label="所属部门"><input value={draft.referrerDept} onChange={e => patch("referrerDept", e.target.value)} /></Field>
          <Field label="推荐人岗位"><input value={draft.referrerJob} onChange={e => patch("referrerJob", e.target.value)} /></Field>
          <Field label="联系电话"><input value={draft.referrerPhone} onChange={e => patch("referrerPhone", e.target.value)} /></Field>
          <Field label="被推荐人姓名" required><input value={draft.candidateName} onChange={e => patch("candidateName", e.target.value)} /></Field>
          <Field label="应聘岗位" required>
            <input list="referral-jobs" value={draft.targetJob} onChange={e => patch("targetJob", e.target.value)} />
            <datalist id="referral-jobs">{jobs.map(j => <option key={j.id} value={j.name} />)}</datalist>
          </Field>
          <Field label="岗位职级档位" required><select value={draft.grade} onChange={e => patch("grade", e.target.value)}>{GRADES.map(g => <option key={g} value={g}>{g} 档 · {WEIGHT[g]}</option>)}</select></Field>
          <Field label="最高学历"><input value={draft.education} onChange={e => patch("education", e.target.value)} /></Field>
          <Field label="现单位"><input value={draft.currentOrg} onChange={e => patch("currentOrg", e.target.value)} /></Field>
          <Field label="被推荐人手机号"><input value={draft.candidatePhone} onChange={e => patch("candidatePhone", e.target.value)} /></Field>
          <Field label="与被推荐人关系"><select value={draft.relation} onChange={e => patch("relation", e.target.value)}>{RELATIONS.map(v => <option key={v} value={v}>{v}</option>)}</select></Field>
          <Field label="关系补充与渠道来源"><input value={draft.channel} onChange={e => patch("channel", e.target.value)} placeholder="如 前同事 / 校友群" /></Field>
          <Field label="填报日期"><input type="date" value={draft.signedAt} onChange={e => patch("signedAt", e.target.value)} /></Field>
          <Field label="参与资格声明" hint="办法第十三、十四条：HR 与专职招聘岗、面试官与审批人、存在亲属或上下级利益关系者、现职员工或离职未满 6 个月的人选，不纳入积分"><select value={draft.excludedPerson} onChange={e => patch("excludedPerson", e.target.value)}>{Object.entries(EXCLUDED_PERSONS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
        </div>
        {draft.grade === "特殊" && <Field label="特殊档议定积分" hint="一人一议，权重不超过 4.0 倍，单次最高 50 分"><input type="number" min={0} max={50} value={draft.specialScore ?? ""} onChange={e => patch("specialScore", e.target.value === "" ? null : Number(e.target.value))} /></Field>}
        <Field label="推荐理由"><textarea rows={3} value={draft.reason} onChange={e => patch("reason", e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={!!draft.conflictDeclared} onChange={e => patch("conflictDeclared", e.target.checked)} />已确认不存在办法第十三条所列利益冲突与排除情形，材料真实完整</label>
        <p className="muted">阶段进展按实际情况在台账登记，积分由系统按办法计算 <span className="hint" title="提交后点「更新进展」勾选面试、录用、入职；服务端按第九、十、十五条重算，页面不自行改分">计分依据</span></p>
      </Form>
    </Dialog>}

    {editing && <Dialog title={"更新推荐进展 · " + (editing.referral?.candidateName || "")} onClose={() => setEditing(null)} wide>
      <Form submit={busy ? "正在保存…" : "保存进展"} onCancel={() => setEditing(null)} onSubmit={submitEdit}>
        <p className="muted">{editing.referral?.referrerName} 推荐 · {editing.referral?.targetJob} · {editing.referral?.grade} 档 · 登记于 {date(editing.created_at)}</p>
        <Field label="阶段基础分" hint="办法第十条：面试 1 分、录用 5 分、入职 10 分，按实际进展累计">
          <div className="toolbar">{STAGES.map(([k, t, p]) => <label className="check" key={k}>
            <input type="checkbox" checked={!!editing.referral?.stages?.[k]} onChange={e => patchEditStage(k, e.target.checked)} />{t} {p} 分
          </label>)}</div>
        </Field>
        <div className="form-grid">
          <Field label="形式审核" hint="办法第七条：人力资源部对推荐材料做形式审核，确认无重复推荐与利益冲突后纳入流程"><select value={editing.referral?.review || "pending"} onChange={e => patchEdit("review", e.target.value)}>{Object.entries(REVIEWS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
          <Field label="参与资格" hint="办法第十三、十四条的排除人员与排除人选"><select value={editing.referral?.excludedPerson || "none"} onChange={e => patchEdit("excludedPerson", e.target.value)}>{Object.entries(EXCLUDED_PERSONS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
          <Field label="积分调整情形" hint="办法第十五条：虚假材料、本人原因放弃、入职 6 个月内离职或试用期不合格、违规等按条款处理"><select value={editing.referral?.exclusion || "none"} onChange={e => patchEdit("exclusion", e.target.value)}>{Object.entries(EXCLUSIONS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>
          <Field label="年底核对确认" hint="办法第十二条：年底统一填写核对登记表，经推荐人核对确认后签字"><select value={editing.referral?.confirmed ? "yes" : "no"} onChange={e => patchEdit("confirmed", e.target.value === "yes")}><option value="no">未核对</option><option value="yes">已核对确认</option></select></Field>
        </div>
        {editing.referral?.grade === "特殊" && <Field label="特殊档议定积分" hint="一人一议，权重不超过 4.0 倍，单次最高 50 分"><input type="number" min={0} max={50} value={editing.referral?.specialScore ?? ""} onChange={e => patchEdit("specialScore", e.target.value === "" ? null : Number(e.target.value))} /></Field>}
        <Field label="推荐理由与备注"><textarea rows={2} value={editing.referral?.reason || ""} onChange={e => patchEdit("reason", e.target.value)} /></Field>
        <p className="notice subtle">当前积分 <strong>{editing.referral?.computed?.score ?? 0}</strong> 分 · 折算 {editing.referral?.computed?.amountCny ?? 0} 元 <span className="hint" title="基础分 × 档位权重，单次封顶 50 分；保存后由服务端重算，页面不自行改分">计算口径</span></p>
      </Form>
    </Dialog>}
  </>;
}
