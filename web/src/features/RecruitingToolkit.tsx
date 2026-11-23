import { useState } from "react";
import Dashboard from "./Dashboard";
import People from "./People";
import { api, downloadCsv } from "../lib/api";
import { useApp, useResource, Resource, date, type Row } from "../lib/state";
import { PageHeader, Panel, Empty } from "../components/ui";

type Cell = string | number | null | undefined;
const exportCsv = downloadCsv;

const REJECTION_TEMPLATES = [
  { stage: "初筛未通过", text: "感谢您应聘本公司岗位。经初步评估，您目前的经历与该岗位当前的核心要求匹配度有限，本次暂不进入下一环节。我们会将您的资料保留在人才库，后续有更契合的岗位会主动联系。" },
  { stage: "面试未通过", text: "感谢您参加面试并与团队深入交流。经过综合评估，本岗位本次选择了在相关经验上更贴近当前阶段需求的候选人。您的专业表现给团队留下印象，期待未来有机会合作。" },
  { stage: "薪酬未达成一致", text: "感谢您在整个流程中的耐心沟通。双方对薪酬结构的预期目前存在差距，本次暂不继续推进。若后续岗位预算或您的预期有变化，欢迎随时联系。" },
  { stage: "岗位冻结 / 编制调整", text: "感谢您对本岗位的关注。因公司近期编制与招聘节奏调整，该岗位本次暂停推进，与您的个人能力无关。我们已保留您的资料，恢复招聘时会优先联系。" },
  { stage: "背调 / 资料未齐", text: "感谢您配合完成前面的流程。因部分必要资料尚未齐备，本次流程暂时无法继续。如您方便补充相关材料，我们可重新安排评估。" },
];
const BACKGROUND_ITEMS = ["学历", "任职起止", "公司主体", "汇报线", "团队规模", "离职原因"];
const MINUTES_ITEMS = ["结论", "证据", "疑点", "下一轮建议", "是否推进"];
const OFFER_GATES = ["编制确认", "薪资审批", "背调完成", "offer 审批"];
const QUALITY_HEADERS = ["候选人", "来源", "匹配分", "面试结论", "入职日期", "3个月留存", "用人经理评价", "转正结果", "1个月观察点", "3个月观察点", "用人经理评分"];
const checked = (v: Row | undefined, keys: string[]) => keys.filter(k => v?.[k] === true);
const TOOLKIT_TABS = [
  ["board", "流程看板"],
  ["todo", "待办与跟进"],
  ["check", "核查与纪要"],
  ["jobs", "岗位素材"],
  ["data", "补录与说明"],
] as const;

export default function RecruitingToolkit({ jobs, initialTab = "board" }: { jobs: Row[]; initialTab?: string }) {
  const { notify, canWrite } = useApp();
  const data = useResource<Row | null>(
    (s) => canWrite ? api("/toolkit/overview", { signal: s }) : Promise.resolve(null),
    [canWrite],
  );
  const [answer, setAnswer] = useState("");
  const [selectedTab, setSelectedTab] = useState(initialTab);
  const tab = canWrite ? selectedTab : "board";
  const tabs = canWrite ? TOOLKIT_TABS : TOOLKIT_TABS.slice(0, 1);
  const [crossRows, setCrossRows] = useState<Row[] | null>(null);
  const [bgMap, setBgMap] = useState<Record<string, string[]>>({});
  const [gateMap, setGateMap] = useState<Record<string, string[]>>({});
  const [minuteTarget, setMinuteTarget] = useState("");
  const [minuteDraft, setMinuteDraft] = useState<Record<string, string>>({});
  const [jobExtras, setJobExtras] = useState<Record<string, Row>>({});
  const [levelDraft, setLevelDraft] = useState<Record<string, string>>({});
  const [realName, setRealName] = useState<Record<string, string>>({});
  const [riskDraft, setRiskDraft] = useState<Record<string, string>>({});
  const [searchTerms, setSearchTerms] = useState("");
  const [searchRows, setSearchRows] = useState<Row[] | null>(null);
  const [offerBase, setOfferBase] = useState("");
  const d = data.data;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify("已复制到剪贴板"); }
    catch { notify("复制失败，请手动选中文本", true); }
  };
  const save = async (scope: string, id: string, kind: string, payload: Row, label: string) => {
    try {
      await api("/toolkit/record", { method: "POST", body: { scope, id, kind, payload, version: Object.values(d || {}).flatMap(v=>Array.isArray(v)?v:[]).find((r: Row)=>r.id===id)?.version } });
      notify(label + "已保存到业务库");
      data.reload();
    } catch (e) { notify((e as Error).message, true); }
  };
  const exportOverview = async (name: string, rows: (value: Row) => Cell[][]) => {
    try { const value=await api<Row>('/toolkit/overview?mode=export'); exportCsv(name,rows(value)); }
    catch(e) { notify((e as Error).message,true); }
  };
  const exportCross = async () => {
    try { const value=await api<Row>('/candidates/matching/cross-job',{method:'POST',body:{threshold:50,mode:'export'}});
      exportCsv('存量人才跨岗推荐.csv', [['候选人','当前岗位','当前分数','建议岗位','建议分数','是否触发提醒'],...(value.items || []).map((x: Row)=>[x.name,x.currentJobName,x.currentScore ?? '',x.bestJobName,x.bestScore ?? '',x.alert?'是':'否'])]);
    } catch(e) { notify((e as Error).message,true); }
  };
  const loadCross = async () => {
    try {
      const r = await api<Row>("/candidates/matching/cross-job", { method: "POST", body: { threshold: 50 } });
      setCrossRows(r.items || []);
      notify("已计算跨岗位匹配，可导出推荐名单");
    } catch (e) { notify((e as Error).message, true); }
  };
  const toggleIn = (map: Record<string, string[]>, set: (v: Record<string, string[]>) => void, id: string, item: string, on: boolean) =>
    set({ ...map, [id]: on ? [...(map[id] || []), item] : (map[id] || []).filter(x => x !== item) });
  const extra = (j: Row) => jobExtras[j.id] || j.extras || { hardestPoint: "", triples: ["", "", ""], salaryRange: "" };
  const patchExtra = (j: Row, k: string, v: unknown) => setJobExtras(s => ({ ...s, [j.id]: { ...extra(j), [k]: v } }));
  const patchTriple = (j: Row, i: number, v: string) => {
    const t = [...(extra(j).triples || ["", "", ""])]; t[i] = v;
    setJobExtras(s => ({ ...s, [j.id]: { ...extra(j), triples: t } }));
  };
  const runSearch = async () => {
    const terms = searchTerms.split(/[\s,，、]+/).map(x => x.trim()).filter(Boolean).slice(0, 12);
    if (!terms.length) { notify("请先输入能力三元组关键词", true); return; }
    try {
      const r = await api<Row>("/toolkit/search", { method: "POST", body: { terms } });
      setSearchRows(r.items || []);
      notify(`已按 ${terms.length} 个关键词检索简历原文`);
    } catch (e) { notify((e as Error).message, true); }
  };
  const offerPlans = () => {
    const n = Number(offerBase) || 0;
    return [
      ["现金年包", n, "仅固定现金，不含奖金与股权"],
      ["总包", Math.round(n * 1.15), "含目标奖金 15%"],
      ["含股权总包", Math.round(n * 1.15), "另按授予协议单独计算股权估值"],
    ] as Cell[][];
  };

  return <>
    <PageHeader title="招聘助手" description={canWrite ? "流程看板与招聘工具集中入口" : undefined} />
    <div className="sourcing-tabs toolkit-tabs" role="tablist" aria-label="招聘助手功能分区">
      {tabs.map(([id, label]) =>
        <button key={id} role="tab" aria-selected={tab === id} onClick={() => setSelectedTab(id)}>{label}</button>)}
      {canWrite && <small className="hint" title="流程看板为原「招聘进行中」；单页只显示当前分区；渠道转化与数字口径已移到「数据统计」">分区说明</small>}
    </div>
    {tab === "board" && (canWrite ? <Dashboard jobs={jobs} embedded /> : <People jobs={jobs} board renderHeader={false} />)}
    {tab !== "board" && <Resource {...data} retry={data.reload}>
      {d && <>
        {tab === "todo" && <>
        {/* #13 面试前一天提醒 */}
        {(d.tomorrowInterviews?.length || 0) > 0 && (
          <p className="notice warning">明天有 <strong>{d.tomorrowInterviews.length}</strong> 场面试
            <span className="hint" title={d.tomorrowInterviews.map((t: Row) => `${t.name} · ${t.job_name} · 第 ${t.round} 轮 · ${date(t.starts_at)}`).join("；")}>查看名单</span>
          </p>
        )}

        {/* #22 固定问句快捷查询 */}
        <Panel title="常用问题一键查" action={<small className="hint" title="数据按当前在招流程实时统计；本周从周一起算">数据截至 {date(d.generatedAt)}</small>}>
          <div className="toolbar">
            {[
              ["本周新增简历", `本周新增申请 ${d.quick.newThisWeek} 条`],
              ["待筛选多少人", `待筛选 ${d.quick.screening} 人；积压最多的岗位是「${d.quick.bottleneckJob}」`],
              ["在招岗位数", `当前在招 ${d.quick.openJobs} 个岗位，面试中 ${d.quick.interviewing} 人`],
              ["Offer 转化率", `已发 offer ${d.quick.offered} 人、已入职 ${d.quick.hired} 人，转化率 ${d.quick.offerConversion}%`],
              ["淘汰人数", `已淘汰 ${d.quick.rejected} 人，可按下方话术生成对外说明`],
              ["面试中无排期", `面试中 ${d.quick.interviewing} 人，其中 ${d.quick.interviewingWithoutSchedule} 人没有未来排期`],
              ["明天面试", `明天有 ${d.tomorrowInterviews?.length || 0} 场面试，页面打开即提醒`],
            ].map(([q, a]) => <button key={q} className="small" onClick={() => setAnswer(a)}>{q}</button>)}
          </div>
          {answer && <p className="notice">{answer}</p>}
        </Panel>

        {/* P2-10 四套数字口径 */}
        <Panel title="Offer 到岗跟进与面试待办" action={<button className="small" onClick={() => void exportOverview("offer跟进与风险.csv", (d) => [
          ["候选人", "岗位", "发offer时间", "距今天数", "建议跟进", "风险等级"],
          ...(d.offers || []).map((o: Row) => [o.name, o.job_name, date(o.updated_at),
            Math.max(0, Math.floor((Date.now() - new Date(o.updated_at).getTime()) / 86400000)),
            "每周跟进一次", o.followup?.risk || "未标记"]),
        ])}>导出跟进表</button>}>
          <div className="table-scroll"><table><thead><tr><th>候选人</th><th>岗位</th><th>发 offer</th><th>距今</th><th>风险等级</th><th>操作</th></tr></thead><tbody>
            {(d.offers || []).map((o: Row) => <tr key={o.id}>
              <td>{o.name}</td><td>{o.job_name}</td><td>{date(o.updated_at)}</td>
              <td>{Math.max(0, Math.floor((Date.now() - new Date(o.updated_at).getTime()) / 86400000))} 天</td>
              <td><select value={riskDraft[o.id] ?? o.followup?.risk ?? ""} onChange={e => setRiskDraft(r => ({ ...r, [o.id]: e.target.value }))}>
                <option value="">未标记</option><option value="高">高</option><option value="中">中</option><option value="低">低</option>
              </select></td>
              <td><button className="small" onClick={() => void save("application", o.id, "followup", { risk: riskDraft[o.id] ?? o.followup?.risk ?? "", at: new Date().toISOString() }, "风险等级")}>保存</button></td>
            </tr>)}
          </tbody></table></div>
          {!d.offers?.length && <Empty>当前没有已发 offer 的候选人</Empty>}
          {(d.quick.interviewingWithoutSchedule || 0) > 0 && (
            <p className="notice warning">有 {d.quick.interviewingWithoutSchedule} 人处于「面试中」但没有未来排期，名单如下，请补排期后再推进。</p>
          )}
          <h4>面试中但无未来排期 <small>{d.noSchedule?.length || 0}</small></h4>
          <div className="table-scroll"><table><thead><tr><th>候选人</th><th>岗位</th><th>进入该环节</th><th>建议动作</th></tr></thead><tbody>
            {(d.noSchedule || []).map((n: Row) => <tr key={n.id}><td>{n.name}</td><td>{n.job_name}</td><td>{date(n.updated_at)}</td><td><a className="button small" href="#interviews">去补排期</a></td></tr>)}
          </tbody></table></div>
          {!d.noSchedule?.length && <Empty>面试中的人都有未来排期</Empty>}
          <p className="muted">未来面试排期 {d.todos?.length || 0} 场 · 明天 {d.tomorrowInterviews?.length || 0} 场，待办明细在「流程看板」统一查看 <span className="hint" title="原「未来面试排期」表与看板待办事项重复，合并后只保留摘要；「面试中无排期」名单仍按 P1-8 要求逐人可见">去重说明</span></p>
          <p className="muted">风险等级、清单与纪要已写入业务表，随申请进入 SQL 备份 <span className="hint" title="不发送外部提醒；页面打开即显示未来排期与前一天提醒">提醒方式</span></p>
        </Panel>

        {/* #12 拒信话术 / #15 纪要模板说明 */}
        </>}
        {tab === "check" && <>
        <Panel title="标准话术与纪要模板">
          <h4>对外拒因话术</h4>
          <div className="table-scroll"><table><thead><tr><th>适用环节</th><th>话术</th><th>操作</th></tr></thead><tbody>
            {REJECTION_TEMPLATES.map(t => <tr key={t.stage}><td>{t.stage}</td><td>{t.text}</td>
              <td><button className="small" onClick={() => void copy(t.text)}>复制</button></td></tr>)}
          </tbody></table></div>
          <p className="muted">纪要 5 项必填：{MINUTES_ITEMS.join(" · ")} <span className="hint" title="每场面试在下方按场登记，保存后随面试记录进入备份">登记位置</span></p>
        </Panel>

        {/* #10 / #18 / #15 按人按场落库 */}
        <Panel title="核查清单与面试纪要" action={<small className="hint" title="清单绑定到具体申请或面试，保存后后端可读取；Offer 前节点未齐备时无法流转到已发 offer">已落库</small>}>
          <h4>背调 6 项 <small className="hint" title="办法建议的固定 6 项：学历、任职起止、公司主体、汇报线、团队规模、离职原因；进入背调环节的候选人应逐项填完">清单口径</small></h4>
          <div className="table-scroll"><table><thead><tr><th>候选人</th><th>岗位</th><th>已完成项</th><th>操作</th></tr></thead><tbody>
            {(d.backgroundApps || []).map((a: Row) => {
              const on = bgMap[a.id] || checked(a.checklist, BACKGROUND_ITEMS);
              return <tr key={a.id}><td>{a.name}</td><td>{a.job_name}</td>
                <td><div className="toolbar">{BACKGROUND_ITEMS.map(k => <label className="check" key={k}>
                  <input type="checkbox" checked={on.includes(k)} onChange={e => toggleIn(bgMap, setBgMap, a.id, k, e.target.checked)} />{k}
                </label>)}</div><small>{on.length} / 6</small></td>
                <td><button className="small" onClick={() => void save("application", a.id, "backgroundCheck", Object.fromEntries(BACKGROUND_ITEMS.map(k => [k, on.includes(k)])), "背调清单")}>保存</button></td>
              </tr>;
            })}
          </tbody></table></div>
          {!d.backgroundApps?.length && <Empty>当前没有进入背调环节的候选人</Empty>}

          <h4>Offer 前 4 项节点 <small className="hint" title="后端已阻断：4 项未全部勾选时，无法流转到「已发 offer」">阻断已生效</small></h4>
          <div className="table-scroll"><table><thead><tr><th>候选人</th><th>当前环节</th><th>节点</th><th>齐备</th><th>操作</th></tr></thead><tbody>
            {(d.offerGateApps || []).map((a: Row) => {
              const on = gateMap[a.id] || checked(a.gates, OFFER_GATES);
              return <tr key={a.id}><td>{a.name}</td><td>{a.status}</td>
                <td><div className="toolbar">{OFFER_GATES.map(k => <label className="check" key={k}>
                  <input type="checkbox" checked={on.includes(k)} onChange={e => toggleIn(gateMap, setGateMap, a.id, k, e.target.checked)} />{k}
                </label>)}</div></td>
                <td>{on.length} / 4 {on.length === 4 ? "· 可流转" : "· 不可流转"}</td>
                <td><button className="small" onClick={() => void save("application", a.id, "offerGates", Object.fromEntries(OFFER_GATES.map(k => [k, on.includes(k)])), "Offer 前节点")}>保存</button></td>
              </tr>;
            })}
          </tbody></table></div>
          {!d.offerGateApps?.length && <Empty>当前没有临近 offer 的候选人</Empty>}

          <h4>面试纪要 5 项</h4>
          <div className="toolbar">
            <select aria-label="选择面试" value={minuteTarget} onChange={e => { setMinuteTarget(e.target.value); const t = (d.recentInterviews || []).find((x: Row) => x.id === e.target.value); setMinuteDraft(t?.minutes || {}); }}>
              <option value="">选择一场面试</option>
              {(d.recentInterviews || []).map((i: Row) => <option key={i.id} value={i.id}>{i.name} · {i.job_name} · 第 {i.round} 轮 · {date(i.starts_at)}</option>)}
            </select>
            <small className="hint" title="结论、证据、疑点、下一轮建议、是否推进，5 项填完才能保存">必填项</small>
          </div>
          {minuteTarget && <>
            <div className="toolbar">{MINUTES_ITEMS.map(k => <label className="check" key={k}>{k}
              <input value={minuteDraft[k] || ""} onChange={e => setMinuteDraft(m => ({ ...m, [k]: e.target.value }))} placeholder={`填写${k}`} />
            </label>)}</div>
            <div className="toolbar">
              <button className="small" onClick={() => {
                if (MINUTES_ITEMS.some(k => !String(minuteDraft[k] || "").trim())) { notify("5 项必填，请填完再保存", true); return; }
                void save("interview", minuteTarget, "minutes", minuteDraft, "面试纪要");
              }}>保存纪要</button>
              <button className="small" onClick={() => void copy(MINUTES_ITEMS.map(k => `${k}：${minuteDraft[k] || "待填"}`).join("\n"))}>复制纪要</button>
              <small>{MINUTES_ITEMS.filter(k => String(minuteDraft[k] || "").trim()).length} / 5 项已填</small>
            </div>
          </>}
          <p className="muted">最近面试 {d.recentInterviews?.length || 0} 场，已有纪要 {d.recentInterviews?.filter((i: Row) => i.minutes && MINUTES_ITEMS.every(k => String(i.minutes[k] || "").trim())).length || 0} 份</p>
        </Panel>

        {/* #1 / #3 / #7 / #16 / #19 / #20 / #4 岗位素材、检索与报价 */}
        </>}
        {tab === "jobs" && <>
        <Panel title="岗位素材、能力三元组与报价">
          <ul className="rule-points compact">
            <li>最难招的点与能力三元组保存在岗位档案，可随时修改 <span className="hint" title="写入 jobs.configuration_refs.toolkit.jobExtras，随岗位进入 SQL 备份">存储位置</span></li>
            <li>部门编制余量取同部门在招岗位数与计划招聘合计 <span className="hint" title="来自 jobs.headcount 与部门维度聚合，新建岗位时可作为参照">口径</span></li>
            <li>三元组检索在简历原文中做关键词召回，不接语义模型 <span className="hint" title="按空格或逗号分隔多个关键词，最多 12 个；返回命中词最多的候选人">检索方式</span></li>
          </ul>
          <div className="table-scroll"><table><thead><tr>
            <th>岗位</th><th>部门 / 编制</th><th>等级</th><th>最难招的点</th><th>能力三元组</th><th>薪资区间</th><th>操作</th>
          </tr></thead><tbody>
            {(d.jobMaterials || []).map((j: Row) => <tr key={j.id}>
              <td>{j.name}</td>
              <td>{j.department}<small>本部门在招 {j.dept_open_jobs} 个 / 计划 {j.dept_planned} 人</small></td>
              <td>{j.level || "未定级"}{!j.level && <small className="text-danger">待补录</small>}</td>
              <td><input disabled={!j.extrasWritable?.hardestPoint} value={extra(j).hardestPoint || ""} onChange={e => patchExtra(j, "hardestPoint", e.target.value)} placeholder="一句话记录用人侧痛点" /></td>
              <td>{[0, 1, 2].map(i => <input key={i} disabled={!j.extrasWritable?.triples} style={{ display: "block", marginBottom: 3, width: 150 }} value={(extra(j).triples || [])[i] || ""} onChange={e => patchTriple(j, i, e.target.value)} placeholder={`做什么＋用什么＋到什么程度 ${i + 1}`} />)}</td>
              <td><input disabled={!j.extrasWritable?.salaryRange} value={extra(j).salaryRange ?? j.salary_range ?? ""} onChange={e => patchExtra(j, "salaryRange", e.target.value)} placeholder="如 45–65k" /></td>
              <td><button className="small" onClick={() => void save("job", j.id, "jobExtras", Object.fromEntries(Object.entries(extra(j)).filter(([key])=>j.extrasWritable?.[key])), "岗位素材")}>保存</button></td>
            </tr>)}
          </tbody></table></div>
          <div className="toolbar">
            <input aria-label="能力三元组关键词" placeholder="输入三元组关键词，空格分隔" value={searchTerms} onChange={e => setSearchTerms(e.target.value)} />
            <button className="small" onClick={() => void runSearch()}>按三元组找人</button>
            <button className="small" onClick={() => void exportOverview("岗位素材表.csv", (d) => [
              ["岗位", "部门", "等级", "计划人数", "部门在招岗位数", "部门计划招聘合计", "最难招的点", "能力三元组1", "能力三元组2", "能力三元组3", "薪资区间"],
              ...(d.jobMaterials || []).map((j: Row) => [j.name, j.department, j.level || "未定级", j.headcount, j.dept_open_jobs, j.dept_planned,
                j.extras?.hardestPoint || "", ...(j.extras?.triples || ["", "", ""]), j.extras?.salaryRange ?? j.salary_range ?? ""]),
            ])}>导出岗位素材表</button>
            <button className="small" onClick={() => void exportOverview("招聘质量回溯表.csv", (d) => [QUALITY_HEADERS,
              ...(d.offers || []).map((o: Row) => [o.name, "", "", "", "", "", "", "", "", "", ""]),
            ])}>导出质量回溯模板</button>
            <button className="small" onClick={() => void loadCross()}>计算存量人才跨岗推荐</button>
            <button className="small" disabled={!crossRows} onClick={() => void exportCross()}>导出推荐名单</button>
          </div>
          {searchRows && <p className="notice">按 {searchTerms} 检索到 {searchRows.length} 人：{searchRows.slice(0, 8).map((x: Row) => `${x.name} 命中 ${x.hits} 项`).join("、") || "无命中"}</p>}
          {crossRows && <p className="notice">已计算 {crossRows.length} 条当前申请，其中 {crossRows.filter((x: Row) => x.alert).length} 条触发跨岗提醒，可导出。</p>}
          <h4>三档报价方案 <small className="hint" title="输入现金年包基数，按现金年包 / 总包 / 含股权总包 三档生成模板；具体方案仍需按办法与审批确定">计算口径</small></h4>
          <div className="toolbar">
            <input aria-label="现金年包基数，单位元" type="number" min={0} placeholder="现金年包基数，单位元" value={offerBase} onChange={e => setOfferBase(e.target.value)} />
            <button className="small" onClick={() => exportCsv("报价方案.csv", [["方案", "金额 元", "说明"], ...offerPlans()])}>导出报价方案</button>
          </div>
          <div className="table-scroll"><table><thead><tr><th>方案</th><th>金额 元</th><th>说明</th></tr></thead><tbody>
            {offerPlans().map((p: Cell[]) => <tr key={String(p[0])}><td>{p[0]}</td><td>{p[1]}</td><td>{p[2]}</td></tr>)}
          </tbody></table></div>
        </Panel>

        {/* P1-4 / P2-14 数据补录 */}
        </>}
        {tab === "data" && <>
        <Panel title="待补录主数据" action={<small className="hint" title="岗位等级由用人部门定义，系统不自动编造；真实姓名需人工核对后补录">需人工确认</small>}>
          <h4>未定级岗位 <small>{d.unleveledJobs?.length || 0}</small></h4>
          <div className="table-scroll"><table><thead><tr><th>岗位</th><th>部门</th><th>状态</th><th>内部等级</th><th>操作</th></tr></thead><tbody>
            {(d.unleveledJobs || []).map((j: Row) => <tr key={j.id}>
              <td>{j.name}</td><td>{j.department || "—"}</td><td>{j.open ? "在招" : "已关闭"}</td>
              <td><input value={levelDraft[j.id] || ""} onChange={e => setLevelDraft(s => ({ ...s, [j.id]: e.target.value }))} placeholder="如 P6 / M2" /></td>
              <td><button className="small" disabled={!String(levelDraft[j.id] || "").trim()} onClick={() => void save("job", j.id, "level", { value: levelDraft[j.id].trim() }, "岗位等级")}>补录</button></td>
            </tr>)}
          </tbody></table></div>
          {!d.unleveledJobs?.length && <Empty>所有岗位均已定级</Empty>}
          <h4>平台隐名候选人 <small>{d.hiddenNames?.length || 0}</small> <small className="hint" title="补录真实姓名后，才允许流转到面试环节；补录值写入候选人档案">补录作用</small></h4>
          <div className="table-scroll"><table><thead><tr><th>平台显示名</th><th>当前申请数</th><th>真实姓名</th><th>操作</th></tr></thead><tbody>
            {(d.hiddenNames || []).map((c: Row) => <tr key={c.id}>
              <td>{c.name}</td><td>{c.applications}</td>
              <td>{c.real_name || <input value={realName[c.id] || ""} onChange={e => setRealName(s => ({ ...s, [c.id]: e.target.value }))} placeholder="填写真实姓名" />}</td>
              <td>{!c.real_name && <button className="small" disabled={!String(realName[c.id] || "").trim()} onClick={() => void save("candidate", c.id, "realName", { value: realName[c.id].trim() }, "真实姓名")}>补录</button>}</td>
            </tr>)}
          </tbody></table></div>
          {!d.hiddenNames?.length && <Empty>无平台隐名候选人</Empty>}
        </Panel>

        <Panel title="本轮未做">
          <ul className="rule-points compact">
            <li>高绩效者反推画像、内部活水、动态人才雷达 <span className="hint" title="依赖人事主数据或平台级定时能力，修改说明标注「先不做系统」">原因</span></li>
            <li>非简历材料上传、面试官智能排班 <span className="hint" title="需新增文件类型与排班数据表">原因</span></li>
            <li>语义召回模型 <span className="hint" title="已先补齐能力三元组与关键词检索，暂不接模型">原因</span></li>
          </ul>
        </Panel>
        </>}
      </>}
    </Resource>}
  </>;
}
