import { businessDate, statisticsRange } from "../lib/workflows";
const P50_HINT = "中位数：一半样本在这个天数内完成该环节";
const P90_HINT = "90 分位：九成样本在这个天数内完成，用来看长尾拖慢的情况";
import { useEffect, useState } from "react";
import { api, query, download, downloadCsv } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  stages,
  pct,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  Field,
  Form,
  Dialog,
  values,
  Empty,
} from "../components/ui";
import ApplicationPicker from "../components/ApplicationPicker";
export default function Statistics() {
  const { revision, canManage, notify, refresh } = useApp(),
    [from, setFrom] = useState(businessDate(new Date()).slice(0, 4) + "-01-01"),
    [to, setTo] = useState(businessDate(new Date(Date.now() + 86400000))),
    [protocol, setProtocol] = useState(""),
    [newProtocol, setNewProtocol] = useState(false),
    [sample, setSample] = useState(false),
    [exportingChannels, setExportingChannels] = useState(false);
  const range = statisticsRange(from, to);
  const report = useResource<Row | null>(
      (s) =>
        range ? query("/statistics/query", range, s) : Promise.resolve(null),
      [from, to, revision],
    ),
    protocols = useResource<Row[]>(
      (s) => api("/measurements/protocols", { signal: s }),
      [revision],
    ),
    measurement = useResource<Row | null>(
      (s) =>
        protocol
          ? api("/measurements/" + protocol, { signal: s })
          : Promise.resolve(null),
      [protocol, revision],
    ),
    toolkit = useResource<Row>(
      (s) => api("/toolkit/overview", { signal: s }),
      [revision],
    );
  const exportChannels = async () => {
    setExportingChannels(true);
    try {
      const value = await api<Row>("/toolkit/overview?mode=export");
      downloadCsv("渠道转化与数字口径.csv", [
        ["统计范围", "所有当前有效申请，不受日期区间限制；历史申请总数包含非当前申请"],
        ["来源渠道", "进量", "进面", "已发 offer", "已入职", "进面转化率", "录用转化率"],
        ...(value.channels || []).map((c: Row) => [c.source, c.applications, c.interviewed, c.offered, c.hired,
          pct(c.applications ? c.interviewed / c.applications : 0), pct(c.applications ? c.hired / c.applications : 0)]),
        [],
        ["口径", "当前值", "算法", "出现位置"],
        ...(value.numberDefinitions || []).map((n: Row) => [n.label, n.value, n.definition, n.source]),
      ]);
      notify("渠道转化与数字口径已导出");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setExportingChannels(false);
    }
  };
  const exportReport = () => {
    const r = report.data;
    if (!r) return;
    const rows: (string | number | null | undefined)[][] = [
      ["统计区间", r.cohort?.from, r.cohort?.to],
      [],
      ["环节", "累计人数", "占比"],
      ...(r.funnel || []).map((f: Row) => [stages.find(([v]) => v === f.stage)?.[1] || f.stage, f.count, pct(f.rate)]),
      [],
      ["来源渠道", "进量", "初筛通过", "进面", "已发 offer", "已入职"],
      ...(r.channels || []).map((c: Row) => [c.source, c.applications, c.screened, c.interviewed, c.offered, c.hired]),
      [],
      ["环节", "平均停留天数", "样本段数"],
      ...Object.entries(r.dwell || {}).map(([k, v]) => [stages.find(([id]) => id === k)?.[1] || k,
        (v as Row).meanSeconds == null ? "—" : +((v as Row).meanSeconds / 86400).toFixed(1), (v as Row).samples]),
      [],
      ["时间口径", "转化链路", "样本数", "P50 天", "P90 天"],
      ["完整周期", "投递 → 入职", r.durationAnalysis?.endToEnd?.samples ?? 0, r.durationAnalysis?.endToEnd?.p50 ?? "—", r.durationAnalysis?.endToEnd?.p90 ?? "—"],
      ...(r.durationAnalysis?.transitions || []).map((t: Row) => [t.stage ?? "—", t.label, t.samples, t.p50 ?? "—", t.p90 ?? "—"]),
      [],
      ["岗位", "样本数", "P50 天", "P90 天"],
      ...(r.durationAnalysis?.byJob || []).map((j: Row) => [j.jobName, j.samples, j.p50 ?? "—", j.p90 ?? "—"]),
      [],
      ["淘汰原因", "数量"],
      ...Object.entries(r.rejections || {}).map(([k, v]) => [k, String(v)]),
    ];
    const text = "\ufeff" + rows.map(row => row.map(v => '"' + String(v ?? "").replace(/^(\s*[=+@-])/, "'$1").replace(/"/g, '""') + '"').join(",")).join("\r\n");
    download(new Blob([text], { type: "text/csv;charset=utf-8" }), "招聘数据统计-" + businessDate(new Date()) + ".csv");
    notify("统计报表已导出");
  };
  useEffect(() => {
    if (!protocol && protocols.data?.length)
      setProtocol(protocols.data.at(-1)!.id);
  }, [protocols.data]);
  const r = report.data;
  return (
    <>
      <PageHeader
        title="数据统计"
        description="查看漏斗、渠道与转化时长"
      >
        <label className="inline-field">
          开始
          <input
            aria-label="统计开始日期"
            type="date"
            value={from}
            onInput={(e) => setFrom(e.currentTarget.value)}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="inline-field">
          结束（不含）
          <input
            aria-label="统计结束日期"
            type="date"
            value={to}
            onInput={(e) => setTo(e.currentTarget.value)}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </PageHeader>
      {!range && (
        <p className="notice warning" role="alert">
          请选择有效日期，结束日期必须晚于开始日期。统计按北京时间零点计算。
        </p>
      )}
      <Resource {...report} preserve={report.data!==undefined} retry={report.reload}>
        {r && (
          <>
            <div className="kpi-grid">
              {[
                ["岗位申请", r.counts.applications],
                ["独立候选人", r.counts.people],
                ["已关联简历", r.counts.resumes],
                ["录用终止", r.current.terminated || 0],
                [
                  "人工专业评分",
                  r.meanProfessionalScore == null
                    ? "未评分"
                    : r.meanProfessionalScore.toFixed(2) + " / 5",
                ],
              ].map(([t, v]) => (
                <div className="kpi" key={String(t)}>
                  <strong>{v}</strong>
                  <span>{t}</span>
                </div>
              ))}
            </div>
            {r.unknownHistoricalApplications > 0 && (
              <p className="notice">
                {r.unknownHistoricalApplications}{" "}
                条历史导入申请只有观测状态，先前到达与停留时长未知，不虚构流程历史。
              </p>
            )}
            <div className="two-columns">
              <Panel title="招聘漏斗">
                <p className="muted">
                  当前环节及之后的人数累计；淘汰、录用终止不计入主链路。
                </p>
                {r.funnel.map((f: Row) => (
                  <div className="funnel-row" key={f.stage}>
                    <label>{stages.find(([v]) => v === f.stage)?.[1]}</label>
                    <meter
                      min={0}
                      max={Math.max(r.counts.applications, 1)}
                      value={f.count}
                    />
                    <strong>{f.count}</strong>
                    <span>{pct(f.rate)}</span>
                  </div>
                ))}
              </Panel>
              <Panel title="当前环节分布">
                {Object.entries(r.current).map(([k, v]) => (
                  <div className="record-row" key={k}>
                    <span>
                      {stages.find(([id]) => id === k)?.[1] || "历史未知"}
                    </span>
                    <strong>{String(v)}</strong>
                  </div>
                ))}
              </Panel>
            </div>
            <Panel title="转化时间" action={<div className="toolbar">
              <button className="small" onClick={exportReport}>导出统计 CSV</button>
              <small className="hint" title="P50＝中位数天数，P90＝90 分位天数；两者都不是平均分">指标说明</small>
              <small className="hint" title={r.durationAnalysis?.basis || "按真实事件计算"}>统计口径</small>
            </div>}>
              <div className="kpi-grid">
                {[
                  ["完整入职样本", r.durationAnalysis?.endToEnd?.samples ?? 0],
                  ["P50 天", r.durationAnalysis?.endToEnd?.p50 ?? "—"],
                  ["P90 天", r.durationAnalysis?.endToEnd?.p90 ?? "—"],
                  ["平均周期 天", r.durationAnalysis?.endToEnd?.mean ?? "—"],
                ].map(([t, v]) => <div className="kpi" key={String(t)}>
                  <strong>{v}</strong><span title={String(t).startsWith("P50") ? P50_HINT : String(t).startsWith("P90") ? P90_HINT : undefined}>{t}</span>
                </div>)}
              </div>
              <div className="table-scroll"><table>
                <thead><tr><th>时间口径</th><th>转化链路</th><th>样本数</th>
                  <th><span className="hint" title={P50_HINT}>P50 天</span></th><th><span className="hint" title={P90_HINT}>P90 天</span></th></tr></thead>
                <tbody>
                  <tr><td>完整周期</td><td>投递 → 入职</td><td>{r.durationAnalysis?.endToEnd?.samples ?? 0}</td>
                    <td>{r.durationAnalysis?.endToEnd?.p50 ?? "—"}</td><td>{r.durationAnalysis?.endToEnd?.p90 ?? "—"}</td></tr>
                  {(r.durationAnalysis?.transitions || []).map((t: Row) => <tr key={t.label}>
                    <td>{t.stage ?? "—"}</td><td>{t.label}</td><td>{t.samples}</td><td>{t.p50 ?? "—"}</td><td>{t.p90 ?? "—"}</td></tr>)}
                </tbody>
              </table></div>
              <h4>按岗位拆分</h4>
              <div className="table-scroll"><table>
                <thead><tr><th>岗位</th><th>样本数</th>
                  <th><span className="hint" title={P50_HINT}>P50 天</span></th><th><span className="hint" title={P90_HINT}>P90 天</span></th></tr></thead>
                <tbody>{(r.durationAnalysis?.byJob || []).map((j: Row) => <tr key={j.jobId}>
                  <td>{j.jobName}</td><td>{j.samples}</td><td>{j.p50 ?? "—"}</td><td>{j.p90 ?? "—"}</td></tr>)}</tbody>
              </table></div>
              {!r.durationAnalysis?.endToEnd?.samples && <Empty>暂无完整的投递到入职样本，环节间数据仍按真实事件展示</Empty>}
            </Panel>
            <Panel title="来源渠道有效性">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>来源</th>
                      <th>申请</th>
                      <th>初筛通过</th>
                      <th>面试</th>
                      <th>Offer</th>
                      <th>入职</th>
                      <th>入职转化率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.channels.map((c: Row) => (
                      <tr key={c.source}>
                        <td>{c.source}</td>
                        <td>{c.applications}</td>
                        <td>{c.screened}</td>
                        <td>{c.interviewed}</td>
                        <td>{c.offered}</td>
                        <td>{c.hired}</td>
                        <td>
                          {pct(c.applications ? c.hired / c.applications : 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <div className="two-columns">
              <Panel title="环节停留">
                <p className="muted">只统计真实事件时段；没有证据时留空。</p>
                {Object.entries(r.dwell).map(([k, v]) => (
                  <div className="record-row" key={k}>
                    <span>{stages.find(([id]) => id === k)?.[1]}</span>
                    <strong>
                      {(v as Row).meanSeconds == null
                        ? "—"
                        : ((v as Row).meanSeconds / 86400).toFixed(1) + " 天"}
                    </strong>
                    <small>{(v as Row).samples} 段</small>
                  </div>
                ))}
              </Panel>
              <Panel title="淘汰原因分布">
                {Object.entries(r.rejections).map(([k, v]) => (
                  <div className="record-row" key={k}>
                    <span>{k}</span>
                    <strong>{String(v)}</strong>
                  </div>
                ))}
                {!Object.keys(r.rejections).length && (
                  <Empty>暂无已记录原因</Empty>
                )}
              </Panel>
              <Panel title="录用终止原因分布">
                {Object.entries(r.terminations || {}).map(([reason, count]) => (
                  <div className="record-row" key={reason}>
                    <span className="termination-summary">
                      {reason === "historical_unknown" ? "历史未注明" : reason}
                    </span>
                    <strong>{String(count)}</strong>
                  </div>
                ))}
                {!Object.keys(r.terminations || {}).length && (
                  <Empty>暂无录用终止记录</Empty>
                )}
              </Panel>
            </div>
          </>
        )}
      </Resource>
      <details className="panel">
        <summary>渠道转化与候选人数字口径</summary>
        <p className="muted">渠道转化统计所有当前有效申请，不受上方日期区间限制；各候选人数字按下表口径计算。</p>
        <Resource {...toolkit} retry={toolkit.reload}>
          {toolkit.data && <>
            <div className="toolbar"><button className="small" disabled={exportingChannels} onClick={exportChannels}>
              {exportingChannels ? "正在导出…" : "导出渠道转化与口径 CSV"}
            </button></div>
            <h4>当前申请渠道转化</h4>
            <div className="table-scroll"><table>
              <thead><tr><th>来源渠道</th><th>进量</th><th>进面</th><th>已发 offer</th><th>已入职</th><th>进面转化率</th><th>录用转化率</th></tr></thead>
              <tbody>{(toolkit.data.channels || []).map((c: Row) => <tr key={c.source}>
                <td>{c.source}</td><td>{c.applications}</td><td>{c.interviewed}</td><td>{c.offered}</td><td>{c.hired}</td>
                <td>{pct(c.applications ? c.interviewed / c.applications : 0)}</td><td>{pct(c.applications ? c.hired / c.applications : 0)}</td>
              </tr>)}</tbody>
            </table></div>
            <h4>候选人数字口径</h4>
            <div className="table-scroll"><table>
              <thead><tr><th>口径</th><th>当前值</th><th>算法</th><th>出现位置</th></tr></thead>
              <tbody>{(toolkit.data.numberDefinitions || []).map((n: Row) => <tr key={n.label}>
                <td>{n.label}</td><td><strong>{n.value}</strong></td><td>{n.definition}</td><td>{n.source}</td>
              </tr>)}</tbody>
            </table></div>
          </>}
        </Resource>
      </details>
      <Panel
        title="人工初筛耗时基线"
        action={
          <div className="toolbar">
            {canManage && (
              <button onClick={() => setNewProtocol(true)}>新建测量协议</button>
            )}
            <button
              className="primary"
              disabled={!protocol}
              onClick={() => setSample(true)}
            >
              记录一次初筛
            </button>
          </div>
        }
      >
        <Field label="测量协议">
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value)}
          >
            <option value="">选择协议</option>
            {protocols.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · v{p.version}
              </option>
            ))}
          </select>
        </Field>
        <Resource {...measurement} preserve={measurement.data!==undefined} retry={measurement.reload}>
          {measurement.data && (
            <>
              <p>{measurement.data.protocol.definition}</p>
              <div className="kpi-grid">
                <div className="kpi">
                  <strong>{measurement.data.manual.median ?? "—"} 秒</strong>
                  <span>
                    人工初筛中位数 · {measurement.data.manual.count} 份
                  </span>
                </div>
                <div className="kpi">
                  <strong>{measurement.data.assisted.median ?? "—"} 秒</strong>
                  <span>
                    规则辅助中位数 · {measurement.data.assisted.count} 份
                  </span>
                </div>
                <div className="kpi">
                  <strong>
                    {measurement.data.efficiency == null
                      ? "样本不足"
                      : pct(measurement.data.efficiency)}
                  </strong>
                  <span>描述性效率变化 · 目标 ≥40%</span>
                </div>
              </div>
              <p className="notice">
                {measurement.data.statement} 中断样本排除，不以未知值充当 0 秒。
              </p>
            </>
          )}
        </Resource>
      </Panel>
      {newProtocol && (
        <Dialog title="定义初筛测量协议" onClose={() => setNewProtocol(false)}>
          <Form
            onCancel={() => setNewProtocol(false)}
            onSubmit={async (form) => {
              const b = values(form),
                p = await api<Row>("/measurements/protocols", {
                  method: "POST",
                  body: { name: b.name, definition: b.definition },
                });
              setProtocol(p.id);
              setNewProtocol(false);
              refresh();
            }}
          >
            <Field label="协议名称" required>
              <input name="name" required />
            </Field>
            <Field label="开始、结束与中断口径" required>
              <textarea
                name="definition"
                rows={7}
                required
                placeholder="例如：从打开一份简历开始，到完成人工初筛记录结束；明确是否含岗位切换、资料查询和中断。"
              />
            </Field>
          </Form>
        </Dialog>
      )}
      {sample && (
        <Sample
          protocolId={protocol}
          onClose={() => setSample(false)}
          onDone={() => {
            setSample(false);
            refresh();
            notify("耗时记录已保存");
          }}
        />
      )}
    </>
  );
}
function Sample({
  protocolId,
  onClose,
  onDone,
}: {
  protocolId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [app, setApp] = useState<Row | null>(null),
    [mode, setMode] = useState("manual"),
    [start, setStart] = useState(""),
    [seconds, setSeconds] = useState(0),
    [manual, setManual] = useState(false);
  useEffect(() => {
    if (!start) return;
    const timer = setInterval(
      () =>
        setSeconds(Math.floor((Date.now() - new Date(start).getTime()) / 1000)),
      250,
    );
    return () => clearInterval(timer);
  }, [start]);
  return (
    <Dialog title="记录单份简历初筛耗时" onClose={onClose}>
      <Form
        onCancel={onClose}
        submit={manual ? "保存手动耗时" : "结束计时并保存"}
        onSubmit={async (form) => {
          const b = values(form);
          if (!app?.resume_version_id) throw Error("请选择已关联简历的申请");
          if (!manual && !start) throw Error("请先开始计时");
          await api("/measurements/samples", {
            method: "POST",
            body: {
              protocolId,
              resumeVersionId: app.resume_version_id,
              mode: b.mode,
              interrupted: b.interrupted === "on",
              ...(manual
                ? { seconds: Number(b.seconds) }
                : { startedAt: start, endedAt: new Date().toISOString() }),
            },
          });
          onDone();
        }}
      >
        <ApplicationPicker
          value={app?.id || ""}
          onChange={setApp}
          disabled={!!start}
        />
        <Field label="初筛方式">
          <input type="hidden" name="mode" value={mode} />
          <select
            disabled={!!start}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="manual">人工初筛</option>
            <option value="assisted">规则辅助</option>
          </select>
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={manual}
            disabled={!!start}
            onChange={(e) => setManual(e.target.checked)}
          />
          手动录入已有测量
        </label>
        {manual ? (
          <Field label="实际秒数" required>
            <input name="seconds" type="number" min={1} max={86400} required />
          </Field>
        ) : (
          <div className="timer">
            <strong>{seconds} 秒</strong>
            <button
              type="button"
              className="primary"
              disabled={!!start || !app}
              onClick={() => setStart(new Date().toISOString())}
            >
              开始计时
            </button>
          </div>
        )}
        <label className="check">
          <input name="interrupted" type="checkbox" />
          本次存在中断（保留记录，统计时排除）
        </label>
        <p className="muted">
          同一人、简历、协议、模式只记录一次，重复提交会拒绝。
        </p>
      </Form>
    </Dialog>
  );
}
