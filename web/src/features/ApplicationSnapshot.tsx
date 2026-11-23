import { downloadCsv } from "../lib/api";
import { date, edu, type Row } from "../lib/state";

export default function ApplicationSnapshot({ a, match, events, person }: {
  a: Row; match?: Row; events?: Row[]; person?: Row;
}) {
  const p = a?.profile || {};
  const score = match?.score?.value;
  const skills = (match?.skills || []).slice(0, 5);
  const days = Math.max(0, Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000));
  const timeline = (events || []).slice(-3).reverse();
  const rows: (string | number | null | undefined)[][] = [
    ["姓名", p.name, "应聘岗位", a.job_name],
    ["当前环节", a.status, "来源", a.source],
    ["匹配分", score ?? "无法计算", "流程天数", days],
    ["学历", edu(p.education), "工作年限", p.experienceYears ?? "未注明"],
    ["院校", p.school || "未注明", "意向岗位", p.intent || "未注明"],
    ["联系方式", [p.phone, p.email].filter(Boolean).join(" / ") || "未提供", "历史申请", person?.applications?.length ?? "—"],
    [],
    ["技能", "判定"],
    ...skills.map((s: Row) => [s.label || s.requirement, s.status]),
    [],
    ["流程节点", "时间"],
    ...(events || []).map((e: Row) => [e.to_state, date(e.at)]),
  ];
  return <details className="panel snapshot-card" open>
    <summary>面试速览卡 <small className="hint" title="一屏汇总简历要点、匹配依据与流程节点；数据来自当前申请与最新匹配快照，可直接导出">数据来源</small></summary>
    <div className="kpi-grid">
      {[
        ["匹配分", score == null ? "—" : score + "%"],
        ["工作年限", p.experienceYears ?? "未注明"],
        ["学历", edu(p.education)],
        ["流程天数", days],
      ].map(([t, v]) => <div className="kpi" key={String(t)}><strong>{v}</strong><span>{t}</span></div>)}
    </div>
    <div className="snapshot-grid">
      <div>
        <ul className="rule-points compact">
          <li><strong>岗位</strong>　{a.job_name} · {a.status}</li>
          <li><strong>联系方式</strong>　{[p.phone, p.email].filter(Boolean).join(" / ") || "未提供"}</li>
          <li><strong>院校 / 专业</strong>　{p.school || "未注明"} · {p.major || "未注明"}</li>
          <li><strong>意向岗位</strong>　{p.intent || "未注明"}</li>
          <li><strong>历史申请</strong>　{person?.applications?.length ?? "—"} 条</li>
        </ul>
      </div>
      <div>
        <strong>技能命中</strong>
        <ul className="rule-points compact">
          {skills.length ? skills.map((s: Row) => <li key={s.requirement}>
            {s.status === "matched" ? "✓" : s.status === "unknown" ? "?" : "○"} {s.label || s.requirement}
            {s.reason && <span className="hint" title={`${s.reason} · 解析方式：${s.method || "—"}`}>依据</span>}
          </li>) : <li>暂无技能评分</li>}
        </ul>
        <strong>最近流程节点</strong>
        <ul className="rule-points compact">
          {timeline.length ? timeline.map((e: Row, i: number) => <li key={i}>{e.to_state} · {date(e.at)}</li>) : <li>暂无事件记录</li>}
        </ul>
      </div>
    </div>
    <div className="toolbar">
      <button className="small" onClick={() => downloadCsv("候选人速览-" + (p.name || "未命名") + ".csv", rows)}>导出速览 CSV</button>
      <small className="muted">匹配分只作人工参考，不构成淘汰结论；年龄、性别不参与评分</small>
    </div>
  </details>;
}
