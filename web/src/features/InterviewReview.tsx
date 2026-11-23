import {formatDateTime} from '../lib/date-time';
import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useApp, useResource, Resource, type Row } from "../lib/state";
import { Dialog, Panel } from "../components/ui";

// I-1~I-6：上下文速览 / 评估理由标签 / AI 输出自查与归档。
// AI 只生成草稿；纪要正式落库必须由人逐项确认后触发。

const SECTION_NAMES: Record<string, string> = {
  jobRuler: "岗位标尺",
  priorRounds: "前几轮结论",
  historySamples: "历史样本",
  currentDimensions: "本轮维度",
};

export function useInterviewEvidence(interviewId: string) {
  return useResource<Row>(
    (signal) => api("/interviews/" + interviewId + "/assistant/evidence", { signal }),
    [interviewId],
  );
}

// I-3：每个评分维度挂可点开的原文理由标签，评分本身仍是人工填写。
export function EvidenceTags({ items, dimensionId }: { items?: Row[]; dimensionId: string }) {
  const entry = (items || []).find((x) => String(x.dimensionId) === String(dimensionId));
  return (
    <details className="evidence-tags">
      <summary>理由标签 {entry?.quotes?.length ? "· " + entry.quotes.length + " 条原文" : "· 暂无"}</summary>
      {entry?.quotes?.length ? (
        <>
          <small className="muted">来自 AI 草稿的原文引用，评分前请逐条核对。</small>
          {entry.quotes.map((q: Row, n: number) => (
            <blockquote key={n}>{q.quote}</blockquote>
          ))}
        </>
      ) : (
        <p className="muted">暂无可核对的原文依据；缺失不等于不具备能力。</p>
      )}
      {entry?.notCovered && <p className="muted">该维度曾被标为未覆盖，请人工确认。</p>}
    </details>
  );
}

type Bundle = { card: Row; evidence: Row; review: Row };

export default function InterviewReviewDialog({ interviewId, title, onClose }: { interviewId: string; title?: string; onClose: () => void }) {
  const { notify } = useApp();
  const bundle = useResource<Bundle>(
    async (signal) => {
      const [card, evidence, review] = await Promise.all([
        api<Row>("/interviews/" + interviewId + "/assistant/context-card", { signal }),
        api<Row>("/interviews/" + interviewId + "/assistant/evidence", { signal }),
        api<Row>("/interviews/" + interviewId + "/assistant/output-review", { signal }),
      ]);
      return { card, evidence, review };
    },
    [interviewId],
  );
  const [tab, setTab] = useState("context");
  const d = bundle.data;
  const root = "/interviews/" + interviewId + "/assistant/output-review";
  return (
    <Dialog title={title || "面试上下文与输出自查"} wide onClose={onClose}>
      <Resource {...bundle} retry={bundle.reload}>
        {d && (
          <>
            <div className="sourcing-tabs toolkit-tabs" role="tablist" aria-label="面试复盘分区">
              {[["context", "上下文速览"], ["evidence", "评分理由标签"], ["review", "输出自查与归档"]].map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
              ))}
              <small className="hint" title="材料按固定顺序展示；默认隐去姓名等无关字段；AI 草稿不自动归档">固定顺序 · 默认脱敏</small>
            </div>

            {tab === "context" && <ContextCard card={d.card} />}
            {tab === "evidence" && (
              <Panel title="评分理由标签">
                <p className="muted">只展示已校验的原文连续子串，按维度聚合；标签不代替评分，也不自动生成结论。</p>
                {d.evidence?.items?.length ? d.evidence.items.map((e: Row) => (
                  <article key={e.dimensionId} className="review-evidence-block">
                    <strong>{e.label}</strong>
                    <EvidenceTags items={[e]} dimensionId={e.dimensionId} />
                  </article>
                )) : <p>本场暂无 AI 草稿证据，请按面试记录人工填写依据。</p>}
              </Panel>
            )}
            {tab === "review" && (
              <OutputReview
                key={d.review.expectedVersion}
                reload={bundle.reload}
                review={d.review}
                save={async (body) => {
                  await api(root, { method: "POST", body });
                  notify("自查草稿已保存，尚未归档");
                  bundle.reload();
                }}
                archive={async (body) => {
                  await api(root + "/archive", { method: "POST", body: { ...body, confirmed: true } });
                  notify("纪要已由本人确认并归档到面试记录");
                  bundle.reload();
                }}
              />
            )}
          </>
        )}
      </Resource>
    </Dialog>
  );
}

function ContextCard({ card }: { card: Row }) {
  const sections: Record<string, ReactNode> = {
    jobRuler: (
      <div>
        <p><strong>{card.jobRuler?.jobName || "未关联岗位"}</strong> · {card.jobRuler?.department || "未填部门"} · {card.jobRuler?.level || "未定级"}</p>
        {card.jobRuler?.dimensions?.length ? (
          <ul>{card.jobRuler.dimensions.map((x: Row) => <li key={x.id}>{x.label}{x.description ? " · " + x.description : ""}</li>)}</ul>
        ) : <p className="muted">尚未配置本岗位能力维度。</p>}
        <details><summary>岗位要求（按字段权限显示）</summary><pre className="review-pre">{JSON.stringify(card.jobRuler?.requirements || {}, null, 2)}</pre></details>
      </div>
    ),
    priorRounds: card.priorRounds?.length ? (
      <ul>{card.priorRounds.map((r: Row, n: number) => (
        <li key={n}>第 {r.round} 轮 · {r.status === "submitted" ? "已提交" : "草稿"} · {r.summary || "未填写摘要"}{r.conclusion ? " · 结论 " + r.conclusion : ""}</li>
      ))}</ul>
    ) : <p className="muted">暂无前几轮结论。</p>,
    historySamples: card.historySamples?.length ? (
      <ul>{card.historySamples.map((r: Row, n: number) => (
        <li key={n}>同岗位第 {r.round} 轮样本 · {r.summary || "未填写摘要"}</li>
      ))}</ul>
    ) : <p className="muted">暂无同岗位历史样本，评分松紧度需人工校准。</p>,
    currentDimensions: (
      <ol className="rule-points">{card.currentDimensions?.map((x: Row) => <li key={x.id}>{x.label}{x.description ? " · " + x.description : ""}</li>) || []}</ol>
    ),
  };
  return (
    <>
      {card.uncertainty?.length > 0 && (
        <div className="review-uncertain" role="note">
          <strong>我拿不准</strong>
          <ul>{card.uncertainty.map((u: Row, n: number) => <li key={n}>{u.message}</li>)}</ul>
          <small>以上为不确定场景声明，不作为能力结论，请在自查中逐项处理。</small>
        </div>
      )}
      <p className="muted">材料顺序：{card.materialOrder?.join(" → ") || "岗位标尺 → 简历原文 → 前几轮结论 → 本轮维度"} · 默认隐去姓名等无关字段，顺序与访问已留审计。</p>
      {(card.order || Object.keys(SECTION_NAMES)).map((key: string, n: number) => (
        <Panel key={key} title={n + 1 + ". " + (SECTION_NAMES[key] || key)}>{sections[key] || null}</Panel>
      ))}
    </>
  );
}

function OutputReview({ review, save, archive, reload }: { reload: () => void; review: Row; save: (b: Row) => Promise<void>; archive: (b: Row) => Promise<void> }) {
  const { notify } = useApp();
  const [minutes, setMinutes] = useState<Record<string, string>>({ ...(review.state?.minutes || {}) });
  const [checked, setChecked] = useState<Record<string, boolean>>({ ...(review.state?.checked || {}) });
  const [notValidWhen, setNotValidWhen] = useState(String(review.state?.notValidWhen || ""));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const items: string[] = review.minutesItems || [];
  const checks: Row[] = review.checklist || [];
  const missing: string[] = [];
  for (const item of items) if (!String(minutes[item] || "").trim()) missing.push("纪要「" + item + "」");
  for (const c of checks) if (!checked[c.id]) missing.push("自查「" + c.label + "」");
  if (!notValidWhen.trim()) missing.push("结论不成立条件");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { if((e as {code?:string}).code === "version_conflict")setConflict(true); notify((e as Error).message, true); } finally { setBusy(false); }
  };
  const body = () => ({ minutes, checked, notValidWhen, expectedVersion: review.expectedVersion });
  if(review.readOnly) return (
    <Panel title="输出自查 · 只读">
      <p className="notice">另一位面试官正在编写私有草稿，当前无法查看或修改。请等待原作者确认归档后，再载入最新记录进行共享修订。</p>
      <div className="toolbar">
        <button className="small" disabled>保存草稿</button>
        <button className="primary small" disabled>确认归档</button>
        <button className="small" onClick={reload}>载入最新记录</button>
      </div>
    </Panel>
  );
  return (
    <>
      {conflict && <p className="notice">记录已被其他人更新，本页输入仍保留。请先复制需要保留的内容，再<button className="small" onClick={reload}>载入最新记录</button>后核对保存。</p>}
      {review.archived && <p className="notice">已于 {formatDateTime(review.archived.at)} 由本人确认归档；以下为已归档内容，可修订后重新归档。</p>}
      <Panel title="面试纪要 · 人工填写">
        <p className="muted">5 项必填。「是否推进」与结论只能由人填写，AI 不给录用建议。</p>
        {review.draft && (
          <button className="small" disabled={busy} onClick={() => {
            const patch: Record<string, string> = {};
            for (const key of items) if (!String(minutes[key] || "").trim() && review.draft?.[key]) patch[key] = review.draft[key];
            setMinutes({ ...minutes, ...patch });
            notify("已把 AI 草稿填入空白项；请逐项核对");
          }}>采用 AI 草稿填入</button>
        )}
        {!review.draft && <p className="muted">本场暂无已结束的 AI 会话草稿，可手工填写。</p>}
        <div className="review-minutes">
          {items.map((item) => (
            <label key={item} className="review-minute-row">
              <span>{item}</span>
              <textarea value={minutes[item] || ""} maxLength={2000} rows={2}
                onChange={(e) => setMinutes((s) => ({ ...s, [item]: e.target.value }))} />
            </label>
          ))}
          <label className="review-minute-row"><span>结论不成立条件</span>
            <input value={notValidWhen} maxLength={500} placeholder="写明在什么条件下上述结论不成立"
              onChange={(e) => setNotValidWhen(e.target.value)} />
          </label>
        </div>
      </Panel>
      <Panel title="输出自查清单">
        <p className="muted">每项 AI 输出归档前逐项勾选；不勾选不会写入正式纪要。</p>
        <div className="review-checks">
          {checks.map((c: Row) => (
            <label key={c.id} className="check" title={c.hint}>
              <input type="checkbox" checked={!!checked[c.id]} onChange={(e) => setChecked((s) => ({ ...s, [c.id]: e.target.checked }))} />
              {c.label} <span className="hint" title={c.hint}>?</span>
            </label>
          ))}
        </div>
      </Panel>
      <div className="toolbar">
        <button className="small" disabled={busy} onClick={() => void run(() => save(body()))}>保存草稿</button>
        <button className="primary small" disabled={busy || missing.length > 0} onClick={() => void run(() => archive(body()))}>确认归档</button>
      </div>
      {missing.length > 0 && <p className="muted">归档还需完成：{missing.join("、")}</p>}
      {missing.length === 0 && <p className="muted">已齐备，可确认归档；归档会写入面试记录并留审计。</p>}
    </>
  );
}
