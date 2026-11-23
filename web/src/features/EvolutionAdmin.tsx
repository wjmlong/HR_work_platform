import { useState } from "react";
import { api } from "../lib/api";
import { useApp, useResource, Resource, type Row } from "../lib/state";
import { Panel, JobSelect, Empty } from "../components/ui";
import { usePublishedDictionary } from "../lib/use-published-dictionary";

type Suggestion = {
  kind: string;
  jobName: string;
  summary: string;
  generatedAt: string;
  basis: { snapshots: number; applications: number; skills: number };
  items: { action: string; target: string; reason: string; evidence: string; confidence: string }[];
};

const KINDS: { key: string; label: string; path: string; needJob: boolean; hint: string }[] = [
  { key: "dynamic", label: "动态判定项", path: "/business-config/evolution/dynamic-criteria", needJob: true,
    hint: "按简历真实证据统计各判定项的命中与待核比例，高频共现的技能组合作为候选复合判定项。" },
  { key: "calibration", label: "结果回流校准", path: "/business-config/evolution/calibration", needJob: true,
    hint: "把评分快照与申请流转结果关联，命中但长期不推进的判定项建议降权，稳定推进的建议加权。" },
  { key: "dictionary", label: "技能词典自扩充", path: "/business-config/evolution/dictionary-expansion", needJob: false,
    hint: "扫描简历中已解析但未登记的技能，出现两次以上的列为候选词条，采纳后默认停用。" },
];

const CONF: Record<string, string> = { high: "高", medium: "中", low: "低" };

export default function EvolutionAdmin() {
  const { notify } = useApp();
  const jobs = useResource<Row[]>((s) => api("/jobs", { signal: s }), []);
  const [job, setJob] = useState("");
  const [kind, setKind] = useState("dynamic");
  const [result, setResult] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<"single" | "batch">("single");
  const [addJob, setAddJob] = useState("");
  const [groupLabel, setGroupLabel] = useState("");
  const [groupMode, setGroupMode] = useState<"all" | "any">("all");
  const [groupWeight, setGroupWeight] = useState(1);
  const [groupRequired, setGroupRequired] = useState(false);
  const [groupNote, setGroupNote] = useState("");
  const [groupSkills, setGroupSkills] = useState<string[]>([]);
  const [newSkills, setNewSkills] = useState("");
  const [batchText, setBatchText] = useState("");
  const [addResult, setAddResult] = useState<Row | null>(null);
  const skillsDef = usePublishedDictionary("skills");
  const skillOptions = (skillsDef.data?.options || []).filter((o: Row) => o.active);
  const current = KINDS.find((k) => k.key === kind)!;

  const addGroups = async (payload: Row[]) => {
    setBusy(true); setAddResult(null);
    try {
      const r = await api<Row>("/business-config/evolution/add-groups", { method: "POST", body: { jobId: addJob, groups: payload } });
      setAddResult(r);
      notify(`已即时发布：新增 ${r.groups} 个技能组${r.createdSkills?.length ? `、${r.createdSkills.length} 个新技能词条` : ""}，模板 v${r.previousVersion} → v${r.version}${r.dictionaryVersion ? `，词典 v${r.dictionaryVersion}` : ""}，${r.requeued} 份申请已入队重算`);
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };

  const addSingle = () => {
    if (!addJob) { notify("请先选择目标岗位", true); return; }
    const extra = newSkills.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!groupLabel.trim() || (!groupSkills.length && !extra.length)) { notify("请填写组名并至少选择或输入一个技能", true); return; }
    addGroups([{ label: groupLabel.trim(), mode: groupMode, weight: Number(groupWeight), required: groupRequired, note: groupNote, skills: [...new Set([...groupSkills, ...extra])] }]);
  };

  const addBatch = () => {
    if (!addJob) { notify("请先选择目标岗位", true); return; }
    const lines = batchText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { notify("请按格式填写至少一行", true); return; }
    const groups: Row[] = [];
    for (const [i, line] of lines.entries()) {
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length < 3) { notify(`第 ${i + 1} 行格式不正确（需至少：组名|ALL或ANY|技能列表）`, true); return; }
      const [label, mode, skillStr, weight, required, note] = parts;
      const skills = skillStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!label || !skills.length) { notify(`第 ${i + 1} 行缺少组名或技能`, true); return; }
      const m = mode.toUpperCase() === "ANY" ? "any" : "all";
      groups.push({ label, mode: m, weight: weight ? Number(weight) : 1, required: /是|true|1/i.test(required || ""), note: note || "", skills });
    }
    addGroups(groups);
  };

  const run = async () => {
    if (current.needJob && !job) { notify("请先选择岗位", true); return; }
    setBusy(true); setResult(null); setPicked([]); setDraft(null);
    try {
      const data = await api<Suggestion>(current.path, { method: "POST", body: current.needJob ? { jobId: job } : {} });
      setResult(data);
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };

  const adopt = async () => {
    if (!picked.length) { notify("请先勾选候选词条", true); return; }
    setBusy(true);
    try {
      const r = await api<{ draftId: string; baseVersion: number }>("/business-config/evolution/adopt-dictionary",
        { method: "POST", body: { names: picked } });
      setDraft(r.draftId);
      notify("已生成草稿（候选词条默认停用），请到「业务配置 → 草稿」预览确认后发布");
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return <Panel title="技能组自进化 · 建议草稿">
    <p className="muted">系统只生成建议与草稿，不自动改分、不自动发布、不改变录用结论。所有采纳动作需在「业务配置 → 草稿」预览并经人工确认后发布；发布后再由岗位采用模板才影响新评分，存量分数不自动改写。</p>
    <div className="toolbar">
      <label>分析类型 <select value={kind} onChange={(e) => { setKind(e.target.value); setResult(null); }}>
        {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
      </select></label>
      {current.needJob && <label>目标岗位 <JobSelect all={false} onlyOpen jobs={jobs.data || []} value={job} onChange={setJob} /></label>}
      <button className="primary" disabled={busy || (current.needJob && !job)} onClick={run}>{busy ? "分析中…" : "生成建议"}</button>
    </div>
    <p className="hint">{current.hint}</p>
    {result ? <>
      <p className="notice">{result.summary}　生成于 {new Date(result.generatedAt).toLocaleString("zh-CN")}　依据：快照 {result.basis.snapshots} ／简历 {result.basis.applications} ／判定项 {result.basis.skills}</p>
      {result.items.length ? <div className="table-scroll"><table>
        <thead><tr><th>建议动作</th><th>对象</th><th>理由</th><th>依据</th><th>置信度</th>{result.kind === "dictionary_expansion" && <th>采纳</th>}</tr></thead>
        <tbody>{result.items.map((it, i) => <tr key={i}>
          <td>{it.action}</td><td>{it.target}</td><td>{it.reason}</td><td className="muted">{it.evidence}</td><td>{CONF[it.confidence] || it.confidence}</td>
          {result.kind === "dictionary_expansion" && <td>{it.action === "候选词条" && <label className="check"><input type="checkbox" checked={picked.includes(it.target)} onChange={(e) => setPicked((s) => e.target.checked ? [...s, it.target] : s.filter((x) => x !== it.target))} />采纳</label>}</td>}
        </tr>)}</tbody>
      </table></div> : <Empty>暂无建议</Empty>}
      {result.kind === "dictionary_expansion" && <div className="toolbar">
        <button disabled={busy || !picked.length} onClick={adopt}>生成候选草稿</button>
        <span className="hint">草稿中的词条默认停用，需人工确认后才发布。</span>
      </div>}
      {draft && <p className="notice">草稿已生成（{draft}）。请到「业务配置 → 草稿」预览确认后发布；本次仅生成草稿，未发布、未改分。</p>}
      <p className="muted">说明：建议基于现有快照与流转数据统计，仅供人工核对；置信度为统计样本量提示，不代表结论正确。系统不用姓名推断任何属性，不输出录用或淘汰决定。</p>
    </> : <Empty>选择分析类型{current.needJob ? "与岗位" : ""}后点击「生成建议」</Empty>}

    <hr />
    <h3>直接添加技能组</h3>
    <p className="notice warning">即时发布：新增技能组会写入岗位当前模板的新版本并立即生效，该岗位新评分按新组计算（旧评估不改写）。旧版本不可变，可从业务配置回退。</p>
    <div className="toolbar">
      <label>目标岗位 <JobSelect all={false} onlyOpen jobs={jobs.data || []} value={addJob} onChange={setAddJob} /></label>
      <label>方式 <select value={addMode} onChange={(e) => setAddMode(e.target.value as "single" | "batch")}>
        <option value="single">单独添加</option><option value="batch">批量添加</option>
      </select></label>
    </div>
    {addMode === "single" ? <div className="form-grid">
      <label>组名 <input value={groupLabel} onChange={(e) => setGroupLabel(e.target.value)} placeholder="如：核心能力" maxLength={100} /></label>
      <label>匹配方式 <select value={groupMode} onChange={(e) => setGroupMode(e.target.value as "all" | "any")}><option value="all">全部命中（ALL）</option><option value="any">任一命中（ANY）</option></select></label>
      <label>权重 <input type="number" min={0} max={100} step={1} value={groupWeight} onChange={(e) => setGroupWeight(Number(e.target.value))} /></label>
      <label className="check"><input type="checkbox" checked={groupRequired} onChange={(e) => setGroupRequired(e.target.checked)} />必备提示（未命中时提醒人工核对）</label>
      <label>技能（已登记，可多选）<select multiple size={6} value={groupSkills} onChange={(e) => setGroupSkills(Array.from(e.target.selectedOptions).map((o) => o.value))}>
        {skillOptions.map((o: Row) => <option key={o.id} value={o.label}>{o.label}</option>)}
      </select></label>
      <label>新技能（逗号分隔，词典未登记会自动创建并发布）<input value={newSkills} onChange={(e) => setNewSkills(e.target.value)} placeholder="如：碳核算,绿电交易" /></label>
      <label>依据说明 <input value={groupNote} onChange={(e) => setGroupNote(e.target.value)} placeholder="如：JD 硬要求" maxLength={500} /></label>
      <div className="toolbar"><button className="primary" disabled={busy || !addJob} onClick={addSingle}>{busy ? "发布中…" : "添加并即时发布"}</button></div>
    </div> : <div className="form-grid">
      <p className="hint">每行一组，用竖线分隔：<code>组名 | ALL或ANY | 技能1,技能2 | 权重 | 必备(是/否) | 说明</code>。后三段可省略，权重默认 1、必备默认否。词典未登记的技能名会自动创建词条并发布。</p>
      <textarea rows={7} value={batchText} onChange={(e) => setBatchText(e.target.value)} placeholder={"核心能力 | ALL | 组织设计,人才盘点,能力模型 | 2 | 是 | JD 硬要求\n加分项 | ANY | 集团COE,咨询公司 | 1 | 否 | 优先项"} />
      <div className="toolbar"><button className="primary" disabled={busy || !addJob} onClick={addBatch}>{busy ? "发布中…" : "批量添加并即时发布"}</button></div>
    </div>}
    {addResult && <p className="notice">已发布：模板 v{addResult.previousVersion} → v{addResult.version}，新增 {addResult.groups} 组{addResult.createdSkills?.length ? `、新技能词条：${addResult.createdSkills.join("、")}（词典 v${addResult.dictionaryVersion}）` : ""}，{addResult.requeued} 份申请已入队重算。旧版本保留，可在业务配置中回退。</p>}
  </Panel>;
}
