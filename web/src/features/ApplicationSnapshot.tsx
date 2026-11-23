import { date, edu, type Row } from "../lib/state";

export default function ApplicationSnapshot({ a, match, events, person }: {
  a: Row; match?: Row; events?: Row[]; person?: Row;
}) {
  const p = a?.profile || {};
  const score = match?.score?.value;
  const skills = (match?.skills || []).slice(0, 5);
  const days = Math.max(0, Math.floor((Date.now() - new Date(a.created_at).getTime()) / 86400000));
  const timeline = (events || []).slice(-3).reverse();
  return <details className="panel snapshot-card" open>
    <summary>面试速览卡 <small className="hint" title="一屏汇总简历要点、匹配依据与流程节点；数据来自当前申请与最新匹配快照">数据来源</small></summary>
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
      <a className="button small" href="#people?mode=people">在人员字段视图中选择导出</a>
      <small className="muted">匹配分只作人工参考，不构成淘汰结论；年龄、性别不参与评分</small>
    </div>
  </details>;
}
