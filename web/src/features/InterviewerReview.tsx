import {refLabel} from '../lib/template-ui';
import { useState } from "react";
import { api, query, download } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  pct,
  date,
  type Row,
} from "../lib/state";
import { PageHeader, Panel, Empty } from "../components/ui";
const dims = [
  ["professional", "专业能力"],
  ["communication", "沟通表达"],
  ["logicalThinking", "逻辑思维"],
  ["culturalFit", "文化匹配"],
];
const score = (n: number | null) => (n == null ? "—" : n.toFixed(2));
export default function InterviewerReview() {
  const { revision, notify, openApplication } = useApp(),
    [who, setWho] = useState("");
  const all = useResource<Row>(
    (s) => query("/interviewer-review/query", {}, s),
    [revision],
  );
  const data = useResource<Row>(
    (s) =>
      query(
        "/interviewer-review/query",
        { interviewerId: who || undefined },
        s,
      ),
    [who, revision],
  );
  const d = data.data,
    k = d?.kpis;
  return (
    <>
      <PageHeader
        title="面试官评价"
        description="复核面试评估的评分口径"
      />
      <div className="control-row review-controls">
        <label className="control-field">面试官
        <select
          aria-label="筛选面试官"
          value={who}
          onChange={(e) => setWho(e.target.value)}
        >
          <option value="">全部面试官</option>
          {all.data?.interviewers
            .filter((r: Row) => r.id)
            .map((r: Row) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
        </label>
        <button
          onClick={() =>
            api<Blob>("/interviewer-review/export", {
              method: "POST",
              body: { interviewerId: who || undefined },
              raw: true,
            })
              .then((b) => download(b, "面试官评价.csv"))
              .catch((e) => notify(e.message, true))
          }
        >
          导出 CSV
        </button>
        <button onClick={()=>api<Blob>('/interviewer-review/cohorts/export',{method:'POST',body:{interviewerId:who||undefined},raw:true}).then(b=>download(b,'评估模板维度与样本.csv')).catch(e=>notify(e.message,true))}>导出模板维度与样本 CSV</button>
      </div>
      <p className="notice">会议提出的“提问与行为反馈”需要面试原始记录和实际模型接入；当前尚未开通，不会把评分均值当成行为评价。</p>
      <p className="notice">
        默认可比样本不足 3
        场统一显示“数据不足”。评分选填；缺失值不计为零。每场以主责面试官最新正式提交的评估为准。
      </p>
      <Resource {...data} preserve={data.data!==undefined} retry={data.reload}>
        <div className="review-kpis">
          {k &&
            [
              ["面试官人数", k.interviewers],
              ["已完成面试", k.completed],
              ["整体通过率", pct(k.passRate)],
              ["默认四维平均评分", score(k.averageScore)],
              ["默认可比有分场次", k.scoredSessions],
            ].map(([title, value]) => (
              <div className="kpi" key={title}>
                <small>{title}</small>
                <strong>{value}</strong>
              </div>
            ))}
        </div>
        <Panel title="面试官总览">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>面试官</th>
                  <th>通过情况</th>
                  <th>安排 / 完成</th>
                  <th>通过率</th>
                  <th>默认可比均分</th>
                  <th>评分口径复核提示</th>
                </tr>
              </thead>
              <tbody>
                {d?.interviewers.map((r: Row) => (
                  <tr key={r.id || "unassigned"}>
                    <td>
                      <strong>{r.name}</strong>
                    </td>
                    <td>
                      <div className="bar-track">
                        <div style={{ width: (r.passRate || 0) * 100 + "%" }} />
                      </div>
                      <small>
                        通过 {r.passed} · 未通过 {r.failed}
                      </small>
                    </td>
                    <td>
                      {r.assigned} / {r.completed}
                    </td>
                    <td>{pct(r.passRate)}</td>
                    <td>
                      {score(r.averageScore)}
                      <small>
                        {r.scoredSessions} 场 · {r.scoreSamples} 个维度分 · 默认可比完成 {r.comparableCompleted??r.completed} 场
                      </small>
                    </td>
                    <td>
                      <span className={"verdict " + r.verdict.color}>
                        {r.verdict.title}
                      </span>
                      <small>{r.verdict.advice}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!d?.interviewers.length && <Empty>尚无面试记录</Empty>}
          </div>
        </Panel>
        <Panel title="按评估模板分别统计"><p className="muted">不同模板版本不合并均分；有效样本分母逐维显示，缺分不计 0。</p>{d?.cohorts?.map((c:Row)=><section className="template-cohort" key={c.key}><h3>{c.label} · {refLabel(c.templateRef)}{c.legacy?' · 历史口径':''}</h3><p>{c.defaultComparable?'PRD 默认可比样本':'自定义量表，单独核对'} · 已完成 {c.completed} 场 · 有分数 {c.scoredSessions} 场</p><div className="table-scroll"><table><thead><tr><th>维度</th><th>平均分</th><th>有效样本数</th></tr></thead><tbody>{c.dimensions.map((dim:Row)=><tr key={dim.id}><td>{dim.label}</td><td>{score(c.dimensionAverages[dim.id])}</td><td>{c.dimensionSamples[dim.id]}</td></tr>)}</tbody></table></div></section>)}{!d?.cohorts?.length&&<Empty>暂无已提交的可统计评估</Empty>}</Panel>
        <div className="dashboard-bottom">
          <Panel title="PRD 默认四维评分分布">
            {dims.map(([key, label]) => (
              <div className={"dimension-row " + key} key={key}>
                <span>{label}</span>
                <div className="bar-track">
                  <div
                    style={{
                      width: ((d?.dimensionAverages[key] || 0) / 5) * 100 + "%",
                    }}
                  />
                </div>
                <strong>{score(d?.dimensionAverages[key] ?? null)}</strong>
                <small>n={d?.dimensionSamples[key] || 0}</small>
              </div>
            ))}
            <p className="muted">
              优先围绕均分最低的维度，结合题库要点进行专项追问训练。
            </p>
          </Panel>
          <Panel title="最近面试记录（最多 30 条）">
            {d?.details.map((r: Row) => (
              <div className="review-detail" key={r.id}>
                <span className={"status " + r.status}>
                  {
                    (
                      {
                        passed: "已通过",
                        failed: "未通过",
                        pending: "待进行",
                        cancelled: "已取消",
                        legacy_completed: "旧记录待补结果",
                      } as Row
                    )[r.status]
                  }
                </span>
                <button
                  className="text-button"
                  onClick={() => openApplication(r.applicationId)}
                >
                  {r.interviewerName} · {r.candidateName} · 第 {r.round} 轮
                </button>
                <small>
                  {date(r.startsAt)} · {r.templateLabel} · {refLabel(r.templateRef)} ·{" "}
                  {(r.dimensions?.map((d:Row)=>[d.id,d.label])||dims)
                    .map(
                      ([key, label]:string[]) =>
                        label + " " + (r.scores[key] ?? "—"),
                    )
                    .join(" / ")}
                </small>
                {r.questionCoverage && (
                  <small>题目覆盖：{r.questionCoverage}</small>
                )}
              </div>
            ))}
            {!d?.details.length && <Empty>暂无明细</Empty>}
          </Panel>
        </div>
      </Resource>
    </>
  );
}
