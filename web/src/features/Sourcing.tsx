import SourcingDiscovery from './SourcingDiscovery';
import {readSavedView} from '../lib/field-views';
import FieldViewSwitch from '../components/business/FieldViewSwitch';
import ConfiguredForm from "../components/business/ConfiguredForm";
import Campus from "./Campus";
import Referrals from "./Referrals";
import { skillTokens } from "../lib/prd";
import MemberPicker from "../components/MemberPicker";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  MagnifyingGlass,
  X,
  CaretUp,
  CaretDown,
  DownloadSimple,
} from "@phosphor-icons/react";
import { api, query, download } from "../lib/api";
import {
  useApp,
  useResource,
  useDebounced,
  Resource,
  leadStates,
  education,
  tokens,
  date,
  pct,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  Field,
  Form,
  Dialog,
  Status,
  Tags,
  Pagination,
  Empty,
  values,
} from "../components/ui";
const lines: Row = {
  high: "高端线",
  focus: "集中线",
  social: "社媒线",
  all: "全部",
};
const sourceOptions = [
  "顶会论文",
  "导师主页",
  "实验室官网",
  "领英",
  "脉脉",
  "内推",
  "校友引荐",
  "工厂/展会",
  "论坛/社区",
  "抖音/社媒",
  "其他",
];
const descriptions: Row = {
  high: "高端线：以海外重点高校、国内目标院校的专业研究人才为目标，沿论文作者、专利发明人的成果主线，人工核对顶会论文、导师主页、实验室官网信息与联系方式。",
  focus:
    "集中线：通过工厂、展会、产业园区、供应商名录发现符合要求的人才，人工识别目标人选并跟进。",
  social:
    "社媒线：通过论坛、抖音评论区与知乎、B站等技术社区发现合适的活跃作者和账号，人工对接核验。",
  all: "全部线索：显示系统中的全部线路。",
};
const names: Row = {
  school: "院校",
  major: "专业",
  skills: "技能",
  direction: "研究方向",
  state: "状态",
  source: "来源",
  contactAvailability: "联系方式",
  followupAge: "跟进时效",
};
const virtual: Row = {
  contactAvailability: { present: "有联系方式", missing: "缺联系方式" },
  followupAge: {
    overdue: "逾期未跟进",
    recent7: "7 天内动过",
    older14: "14 天以上没动",
    never: "从未跟进",
  },
};
const label = (k: string, v: string) =>
  k === "state"
    ? leadStates.find(([key]) => key === v)?.[1] || v
    : virtual[k]?.[v] || v;
const defaults = {
  targetJob: "",
  targetJobs: [] as string[],
  line: "high",
  lines: [] as string[],
  schools: [] as string[],
  majors: [] as string[],
  skills: [] as string[],
  regions: [] as string[],
  education: [] as string[],
  experience: "",
  keywords: [] as string[],
  sources: [] as string[],
  organizations: [] as string[],
  limit: 30,
  exclusions: ["已在库"],
  notes: "",
  saveTemplate: false,
};
export default function Sourcing({ jobs }: { jobs: Row[] }) {
  const [tab, setTab] = useState(()=>readSavedView(location.hash,'campus')?'campus':'all');
  return (
    <>
      <PageHeader
        title="人才搜集"
        description="检索外部线索并保存搜索条件"
      />
      <div className="sourcing-tabs" role="tablist" aria-label="人才搜集页面">
        {[['discovery','搜集任务'],['all','全部线索'],['high','高端线'],['focus','展会论坛线'],['social','社媒线'],['campus','校招就业网'],['referral','内部推荐']].map(([id,title])=><button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)}>{title}</button>)}
      </div>
      {tab !== "referral" && <div role="tabpanel" hidden={tab === "campus" || tab === "discovery"}>
        {tab!=='all'&&tab!=='campus'&&<p className="muted">线路 Tab 作用于常规业务列表；字段视图使用自己的已保存筛选条件。</p>}
        <FieldViewSwitch key={tab} kind="lead"><LeadPool jobs={jobs} activeLine={['campus','discovery'].includes(tab)?'all':tab}/></FieldViewSwitch>
      </div>}
      {tab === "discovery" && <SourcingDiscovery jobs={jobs}/> }
      {tab === "referral" && <div role="tabpanel"><Referrals jobs={jobs}/></div>}
      <div role="tabpanel" hidden={tab !== "campus"}>
        <Campus active={tab === "campus"} />
      </div>
    </>
  );
}
function LeadPool({ jobs, activeLine }: { jobs: Row[]; activeLine: string }) {
  const { revision, refresh, notify, canManage, canWrite } = useApp(),
    [setup, setSetup] = useState<Row>(defaults),
    [collapsed, setCollapsed] = useState(false),
    [setupBusy, setSetupBusy] = useState(false),
    [setupError, setSetupError] = useState(""),
    [keywords, setKeywords] = useState(""),
    [poolLine, setPoolLine] = useState("all"),
    [deleted, setDeleted] = useState(false),
    [search, setSearch] = useState(""),
    [mode, setMode] = useState("all"),
    [filters, setFilters] = useState<Record<string, string[]>>({}),
    [facetsOpen, setFacetsOpen] = useState(true),
    [page, setPage] = useState(1),
    [edit, setEdit] = useState<Row | null>(null),
    [stateAction, setStateAction] = useState<Row | null>(null),
    [follow, setFollow] = useState<Row | null>(null),
    [detail, setDetail] = useState<Row | null>(null),
    [exporting, setExporting] = useState(false),
    [savedTick, setSavedTick] = useState(0),
    [savedSearches, setSavedSearches] = useState<Row[]>([]),
    [saveName, setSaveName] = useState(""),
    [pickedSaved, setPickedSaved] = useState("");
  const loaded = useResource<Row>(
      (s) => api("/sourcing/setup", { signal: s }),
      [],
    ),
    dictionary = useResource<Row[]>(
      (s) => api("/dictionary", { signal: s }),
      [revision],
    ),
    initialized = useRef(false),
    debounced = useDebounced(search);
  useEffect(()=>{setPoolLine(activeLine);setPage(1);},[activeLine]);
  useEffect(()=>{let alive=true;api<Row>('/toolkit/saved-searches').then(r=>{if(alive)setSavedSearches(r.items||[]);}).catch(()=>{});return()=>{alive=false;};},[savedTick]);
  const saveCurrentSearch=async()=>{
   const name=saveName.trim()||(search.trim()||'当前筛选条件');
   try{
    await api('/toolkit/saved-searches',{method:'POST',body:{name,query:{search,mode,line:poolLine,filters}}});
    setSaveName('');setSavedTick(t=>t+1);notify('搜索条件已保存');
   }catch(e){notify((e as Error).message,true);}
  };
  const applySavedSearch=(q:Row)=>{
   setSearch(String(q.search||''));setMode(String(q.mode||'all'));setPoolLine(String(q.line||'all'));
   setFilters((q.filters as Record<string,string[]>)||{});setPage(1);notify('已应用保存的搜索条件');
  };
  const removeSavedSearch=async()=>{
   if(!pickedSaved)return;
   try{await api('/toolkit/saved-searches/remove',{method:'POST',body:{name:pickedSaved}});setPickedSaved('');setSavedTick(t=>t+1);notify('已删除保存的搜索条件');}
   catch(e){notify((e as Error).message,true);}
  };
  useEffect(() => {
    if (loaded.data && !initialized.current) {
      setSetup(
        Object.keys(loaded.data).length
          ? {
              ...defaults,
              ...loaded.data,
              targetJobs: loaded.data.targetJobs || [loaded.data.targetJob],
              lines: loaded.data.lines || [loaded.data.line],
            }
          : defaults,
      );
      setKeywords((loaded.data.keywords || []).join(" "));
      initialized.current = true;
    }
  }, [loaded.data]);
  const request = {
      line: poolLine,
      deleted,
      query: debounced,
      matchMode: mode,
      filters,
      page,
      pageSize: 25,
    },
    key = JSON.stringify(request);
  const data = useResource<Row>(
      (s) =>
        canWrite
          ? query("/leads/query", request, s)
          : Promise.resolve({ items: [], facets: {}, total: 0 }),
      [key, revision],
    ),
    metrics = useResource<Row>(
      (s) =>
        canWrite
          ? query("/leads/metrics", request, s)
          : Promise.resolve({
              total: 0,
              following: 0,
              acquired: 0,
              conversionRate: null,
            }),
      [key, revision],
    ),
    total = useResource<Row>(
      (s) =>
        canWrite
          ? query("/leads/metrics", {}, s)
          : Promise.resolve({ total: 0 }),
      [revision],
    );
  const patch = (k: string, v: unknown) => setSetup((s) => ({ ...s, [k]: v })),
    toggle = (k: string, v: string) => {
      setFilters((s) => ({
        ...s,
        [k]: s[k]?.includes(v)
          ? s[k].filter((x) => x !== v)
          : ["contactAvailability", "followupAge"].includes(k)
            ? [v]
            : [...(s[k] || []), v],
      }));
      setPage(1);
    };
  async function saveSetup() {
    const missing = [
      !setup.targetJobs.length && "目标岗位",
      !setup.lines.length && "搜集线路",
    ].filter(Boolean);
    if (missing.length) {
      setSetupError("还差必填项：" + missing.join("、"));
      return;
    }
    setSetupError("");
    setSetupBusy(true);
    try {
      await api("/sourcing/setup", {
        method: "PUT",
        body: {
          ...setup,
          keywords: keywords.trim().split(/\s+/).filter(Boolean),
          targetJob: setup.targetJobs.join("、"),
          line: setup.lines[0],
        },
      });
      await api("/sourcing/requests", { method: "POST" });
      notify("本次检索条件已保存。数据源尚未接入，暂不会真的触发搜集。");
    } catch (e) {
      setSetupError((e as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }
  const normalized = (raw: string[]) => [
    ...new Set(
      raw.map(
        (v) =>
          dictionary.data?.find((d) => d.aliases.includes(v.toLowerCase()))
            ?.name || v,
      ),
    ),
  ];
  return (
    <>
      <section className="setup-panel">
        <button
          className="setup-heading"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <span>
            <b>开始前</b>
            <strong>搜集任务设置</strong>
            <small>先定义“要找什么人”，再开始搜集</small>
          </span>
          <span>
            {collapsed ? "展开" : "收起"}
            {collapsed ? <CaretDown size={14} /> : <CaretUp size={14} />}
          </span>
        </button>
        {collapsed ? (
          <div className="setup-summary">
            本次条件：
            {setup.targetJobs.length
              ? setup.targetJobs.join("、")
              : "岗位未选择"}{" "}
            ·{" "}
            {setup.lines.map((v: string) => lines[v]).join("、") ||
              "线路未选择"}{" "}
            · {setup.skills.join("、") || "技能不限"}
            {[
              ["院校", setup.schools],
              ["专业", setup.majors],
              ["地区", setup.regions],
              ["学历", setup.education],
              ["来源", setup.sources],
              ["机构", setup.organizations],
              ["关键词", keywords.trim().split(/\s+/).filter(Boolean)],
              ["排除", setup.exclusions],
            ].map(([name, items]) =>
              (items as string[]).length
                ? ` · ${name}：${(items as string[]).join("、")}`
                : "",
            )}
            {setup.experience ? ` · 经验：${setup.experience}` : ""}
            {setup.notes ? ` · 备注：${setup.notes}` : ""} · 目标 {setup.limit}{" "}
            条
          </div>
        ) : (
          <div className="setup-body">
            <Field label="① 目标岗位" required>
              <ChipInput
                label="目标岗位"
                value={setup.targetJobs}
                onChange={(v) => patch("targetJobs", v)}
                suggestions={jobs.map((j) => j.name)}
              />
            </Field>
            <Field label="② 搜集线路" required>
              <div className="chips">
                {["high", "focus", "social"].map((v) => (
                  <button
                    key={v}
                    className={setup.lines.includes(v) ? "selected" : ""}
                    onClick={() =>
                      patch(
                        "lines",
                        setup.lines.includes(v)
                          ? setup.lines.filter((x: string) => x !== v)
                          : [...setup.lines, v],
                      )
                    }
                  >
                    {lines[v]}
                  </button>
                ))}
              </div>
            </Field>
            <div className="form-grid">
              <Field label="院校范围" hint="可多选，不限时留空">
                <ChipInput
                  label="院校范围"
                  value={setup.schools}
                  onChange={(v) => patch("schools", v)}
                />
              </Field>
              <Field label="专业方向">
                <ChipInput
                  label="专业方向"
                  value={setup.majors}
                  onChange={(v) => patch("majors", v)}
                />
              </Field>
            </div>
            <Field label="技能要求" hint="沿用真实别名归一词典；回车添加">
              <ChipInput
                label="技能要求"
                value={setup.skills}
                onChange={(v) => patch("skills", normalized(v))}
                suggestions={dictionary.data?.map((d) => d.name)}
              />
            </Field>
            <div className="form-grid">
              <Field label="经验年限区间">
                <div className="toolbar">
                  {[0, 1].map((index) => (
                    <select
                      key={index}
                      aria-label={index ? "最高工作年限" : "最低工作年限"}
                      value={setup.experience.split("–")[index] || ""}
                      onChange={(e) => {
                        const range = setup.experience.split("–");
                        range[index] = e.target.value;
                        if (
                          range[0] &&
                          range[1] &&
                          Number(range[0]) > Number(range[1])
                        )
                          range.reverse();
                        patch("experience", range.join("–"));
                      }}
                    >
                      <option value="">
                        {index ? "上限不限" : "下限不限"}
                      </option>
                      {[0, 1, 2, 3, 5, 8, 10, 15, 20].map((v) => (
                        <option key={v} value={v}>
                          {v} 年
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              </Field>
              <Field label="最低学历">
                <select
                  value={setup.education[0] || ""}
                  onChange={(e) =>
                    patch("education", e.target.value ? [e.target.value] : [])
                  }
                >
                  {education
                    .filter(([v]) => v !== "none")
                    .map(([v, t]) => (
                      <option key={v} value={v}>
                        {v ? t : "不限"}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="期望所在地">
                <ChipInput
                  label="期望所在地"
                  value={setup.regions}
                  onChange={(v) => patch("regions", v)}
                  suggestions={[
                    "杭州",
                    "上海",
                    "深圳",
                    "北京",
                    "宁波",
                    "苏州",
                    "成都",
                    "武汉",
                    "西安",
                    "海外",
                  ]}
                />
              </Field>
              <Field label="补充关键词">
                <input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="空格分隔，如：一作 顶会 具身智能"
                />
              </Field>
            </div>
            <Field label="目标搜集量">
              <div className="inline-field">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={setup.limit}
                  onChange={(e) => patch("limit", Number(e.target.value))}
                />
                条
              </div>
            </Field>
            <Field label="排除条件">
              <div className="chips">
                {[
                  "已在库",
                  "已明确拒绝",
                  "6个月内联系过",
                  "在职竞争对手核心岗",
                  "无有效联系方式",
                ].map((v) => (
                  <button
                    className={setup.exclusions.includes(v) ? "selected" : ""}
                    key={v}
                    onClick={() =>
                      patch(
                        "exclusions",
                        setup.exclusions.includes(v)
                          ? setup.exclusions.filter((x: string) => x !== v)
                          : [...setup.exclusions, v],
                      )
                    }
                  >
                    {v}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="本次备注">
              <textarea
                rows={2}
                value={setup.notes}
                onChange={(e) => patch("notes", e.target.value)}
                placeholder="如：Q4 组建，优先 3 个月可到岗"
              />
            </Field>
            <p className="notice subtle">
              这是搜集之前的条件设定，不会更改下面的线索池筛选。当前尚未接入自动数据源。
            </p>
            {setupError && (
              <p className="notice error" role="alert">
                {setupError}
              </p>
            )}
            <footer className="setup-footer">
              <label className="check">
                <input
                  type="checkbox"
                  checked={setup.saveTemplate}
                  onChange={(e) => patch("saveTemplate", e.target.checked)}
                />
                保存为常用模板
              </label>
              <button
                onClick={() => {
                  setSetup({ ...defaults });
                  setSetupError("");
                  setKeywords("");
                }}
              >
                重置本次条件
              </button>
              <button
                className="primary"
                disabled={setupBusy}
                onClick={() => void saveSetup()}
              >
                {setupBusy ? "正在保存…" : "开始搜集"}
              </button>
            </footer>
          </div>
        )}
      </section>
      {loaded.error && (
        <p className="notice error">设置加载失败：{loaded.error}</p>
      )}
      {canWrite && (
        <>
          <div className="kpi-grid sourcing-kpis">
            {[
              ["线索总数", metrics.data?.total ?? "—"],
              ["在跟线索", metrics.data?.following ?? "—"],
              ["已拿到简历 / 已上传", metrics.data?.acquired ?? "—"],
              ["转化率", metrics.data ? pct(metrics.data.conversionRate) : "—"],
            ].map(([t, v]) => (
              <div className="kpi" key={String(t)}>
                <strong>{v}</strong>
                <span>{t}</span>
              </div>
            ))}
          </div>
          <p className="line-description">{descriptions[poolLine]}</p>
          {canManage && (
            <label className="check">
              <input
                type="checkbox"
                checked={deleted}
                onChange={(e) => {
                  setDeleted(e.target.checked);
                  setPage(1);
                }}
              />
              回收记录（可恢复）
            </label>
          )}
          <div className="search-toolbar">
            <MagnifyingGlass size={19} />
            <input
              aria-label="搜索全部线索字段"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="搜姓名 / 单位 / 方向 / 成果 / 联系方式 / 备注…"
            />
            {search && (
              <button
                className="icon-button"
                aria-label="清空搜索"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
              >
                ×
              </button>
            )}
            <select
              aria-label="多词匹配方式"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">多词全部满足（AND）</option>
              <option value="any">满足任一词（OR）</option>
            </select>
          </div>
          <div className="toolbar saved-search-bar">
            <input aria-label="保存搜索条件名称" placeholder="给当前搜索命名" value={saveName} onChange={e=>setSaveName(e.target.value)} />
            <button className="small" onClick={()=>void saveCurrentSearch()}>保存当前搜索</button>
            <select aria-label="应用已保存的搜索条件" value={pickedSaved} onChange={e=>{
              setPickedSaved(e.target.value);
              const hit=savedSearches.find(s=>s.name===e.target.value);
              if(hit)applySavedSearch(hit.query||hit);
            }}>
              <option value="">已保存条件（{savedSearches.length}）</option>
              {savedSearches.map(s=><option key={s.name} value={s.name}>{s.name}{s.newMatches?` · 新线索 ${s.newMatches}`:''}</option>)}
            </select>
            <button className="small" disabled={!pickedSaved} onClick={()=>void removeSavedSearch()}>删除所选</button>
            <small className="hint" title="保存搜索词、匹配方式、线路与筛选项；保存后出现的新线索会在下拉里标出数量，不发送外部通知">保存口径</small>
          </div>
          <Panel
            title={
              <span>
                筛选项 <small>筛选后 {data.data?.total ?? "—"} 条</small>
              </span>
            }
            action={
              <button onClick={() => setFacetsOpen((v) => !v)}>
                {facetsOpen ? "收起" : "展开"}
              </button>
            }
          >
            {facetsOpen &&
              Object.entries(names).map(([k, title]) => (
                <div className="facet-row" key={k}>
                  <label>{String(title)}</label>
                  <FacetChoices
                    facet={k}
                    options={data.data?.facets[k] || []}
                    selected={filters[k] || []}
                    toggle={(v) => toggle(k, v)}
                  />
                </div>
              ))}
          </Panel>
          {(search || Object.values(filters).some((v) => v.length)) && (
            <div className="active-filters">
              <strong>生效条件</strong>
              {search && (
                <button
                  onClick={() => {
                    setSearch("");
                    setPage(1);
                  }}
                >
                  搜索：{search}
                  <X size={13} />
                </button>
              )}
              {Object.entries(filters).flatMap(([k, items]) =>
                items.map((v) => (
                  <button key={k + v} onClick={() => toggle(k, v)}>
                    {names[k]}：{label(k, v)}
                    <X size={13} />
                  </button>
                )),
              )}
              <button
                className="text-button"
                onClick={() => {
                  setSearch("");
                  setFilters({});
                  setMode("all");
                  setPage(1);
                }}
              >
                全部清除
              </button>
            </div>
          )}
          <div className="toolbar section-toolbar">
            <button className="primary" onClick={() => setEdit({})}>
              <Plus size={16} />
              新建线索
            </button>
            <button onClick={() => setExporting(true)}>
              <DownloadSimple size={16} />
              导出 CSV（当前筛选结果）
            </button>
            <small>指标与导出都按当前筛选范围</small>
          </div>
          <Panel className="lead-table">
            <Resource {...data} preserve={data.data!==undefined} retry={data.reload}>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        "姓名",
                        "现任职单位",
                        "院校 / 专业",
                        "技能",
                        "研究方向 / 成果",
                        "联系方式",
                        "来源",
                        "状态",
                        "跟进日",
                        "备注",
                        "操作",
                      ].map((t) => (
                        <th key={t}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.data?.items.map((r: Row) => (
                      <tr className={r.overdue ? "overdue" : ""} key={r.id}>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              api<Row>("/leads/" + r.id)
                                .then(setDetail)
                                .catch((e) => notify(e.message, true))
                            }
                          >
                            <Hit text={r.name} hit={r.hits.name} />
                          </button>
                          {r.overdue && (
                            <small className="text-danger">逾期未跟进</small>
                          )}
                        </td>
                        <td>
                          <Hit text={r.org} hit={r.hits.org} />
                          <small>负责人：{r.owner_name || "未分配"}</small>
                        </td>
                        <td>
                          <Hit text={r.school || "—"} hit={r.hits.school} />
                          <small>
                            <Hit text={r.major} hit={r.hits.major} />
                          </small>
                        </td>
                        <td>
                          <Tags values={r.skills} />
                          {search && r.hits.skills.ranges.length > 0 && (
                            <small>命中技能</small>
                          )}
                        </td>
                        <td>
                          <Hit text={r.direction} hit={r.hits.direction} />
                        </td>
                        <td>
                          <Hit text={r.contact || "—"} hit={r.hits.contact} />
                        </td>
                        <td>
                          <Hit text={r.source} hit={r.hits.source} />
                        </td>
                        <td>
                          <select
                            aria-label={r.name + "的线索状态"}
                            value={r.state}
                            disabled={
                              deleted ||
                              (["uploaded", "declined"].includes(r.state) &&
                                !canManage)
                            }
                            onChange={(e) =>
                              setStateAction({ ...r, target: e.target.value })
                            }
                          >
                            {leadStates.map(([v, t]) => (
                              <option value={v} key={v}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <Status value={r.state} lead />
                        </td>
                        <td>{date(r.last_followup_at)}</td>
                        <td>
                          <Hit text={r.note} hit={r.hits.note} />
                        </td>
                        <td>
                          <div className="vertical-actions">
                            {deleted ? (
                              <button
                                onClick={() =>
                                  api("/leads/" + r.id + "/delete", {
                                    method: "POST",
                                    body: { version: r.version, restore: true },
                                  })
                                    .then(() => {
                                      notify("线索已恢复");
                                      refresh();
                                    })
                                    .catch((e) => notify(e.message, true))
                                }
                              >
                                恢复线索
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => setFollow(r)}
                                  disabled={["uploaded", "declined"].includes(
                                    r.state,
                                  )}
                                >
                                  跟进
                                </button>
                                <button onClick={() => setEdit(r)}>编辑</button>
                                <button
                                  className="danger"
                                  onClick={() =>
                                    setStateAction({ ...r, deleting: true })
                                  }
                                >
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.data?.items.length && (
                  <Empty>
                    {search || Object.values(filters).some((v) => v.length)
                      ? "试试放宽筛选条件"
                      : "点击新建，录入第一条线索"}
                  </Empty>
                )}
              </div>
              <Pagination
                page={page}
                total={data.data?.total || 0}
                onChange={setPage}
              />
            </Resource>
          </Panel>
          <Panel title="渠道有效性分析">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>线索</th>
                    <th>在跟</th>
                    <th>已拿到简历 / 上传</th>
                    <th>转化率</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.data?.channels.map((c: Row) => (
                    <tr key={c.source}>
                      <td>{c.source}</td>
                      <td>{c.total}</td>
                      <td>{c.following}</td>
                      <td>{c.acquired}</td>
                      <td>{pct(c.conversionRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          {edit && (
            <LeadEditor
              lead={edit}
              dictionary={dictionary.data || []}
              schools={(data.data?.facets?.school || []).map(
                (row: Row) => row.value,
              )}
              onClose={() => setEdit(null)}
              onDone={() => {
                setEdit(null);
                refresh();
              }}
            />
          )}
          {stateAction && (
            <LeadState
              lead={stateAction}
              onClose={() => setStateAction(null)}
              onDone={() => {
                setStateAction(null);
                refresh();
              }}
            />
          )}
          {follow && (
            <Followup
              lead={follow}
              onClose={() => setFollow(null)}
              onDone={() => {
                setFollow(null);
                refresh();
              }}
            />
          )}
          {detail && (
            <Dialog
              title={detail.name + " · 跟进记录"}
              onClose={() => setDetail(null)}
              wide
            >
              <p>
                负责人：{detail.owner_name || "未分配"} · 创建：
                {date(detail.created_at)} · 最近实际联系：
                {date(detail.last_contacted_at)}
              </p>
              <p className="muted">
                普通编辑不会刷新联系时钟；逾期按实际联系动作计算。
              </p>
              <ol className="timeline">
                {detail.followups.map((f: Row) => (
                  <li key={f.id}>
                    <strong>
                      {f.kind === "contact" ? "实际联系" : "跟进备注"}
                    </strong>{" "}
                    · {date(f.occurred_at)} · {f.actor_name || "原始记录未注明"}
                    <p>{f.note}</p>
                  </li>
                ))}
              </ol>
              <pre className="raw-text">
                {detail.raw || "未保存原始线索文本"}
              </pre>
            </Dialog>
          )}
          {exporting && (
            <Dialog title="确认导出范围" onClose={() => setExporting(false)}>
              <Form
                onCancel={() => setExporting(false)}
                submit="下载 CSV"
                onSubmit={async (form) => {
                  const scope = values(form).scope;
                  const blob = await api<Blob>("/leads/export", {
                    method: "POST",
                    body: { scope, query: request },
                    raw: true,
                  });
                  download(
                    blob,
                    "人才线索-" +
                      new Date().toISOString().slice(0, 10) +
                      ".csv",
                  );
                  setExporting(false);
                }}
              >
                <p>
                  当前结果 {data.data?.total ?? 0} 条，系统全部{" "}
                  {total.data?.total ?? "—"} 条。导出不受分页限制。
                </p>
                <label className="check">
                  <input
                    name="scope"
                    type="radio"
                    value="filtered"
                    defaultChecked
                  />
                  仅导出当前筛选结果（含当前线路）
                </label>
                {canWrite && (
                  <label className="check">
                    <input name="scope" type="radio" value="all" />
                    导出全部线路与全部条件
                  </label>
                )}
              </Form>
            </Dialog>
          )}
        </>
      )}
    </>
  );
}
function FacetChoices({
  facet,
  options,
  selected,
  toggle,
}: {
  facet: string;
  options: Row[];
  selected: string[];
  toggle: (v: string) => void;
}) {
  const [expanded, setExpanded] = useState(false),
    limit =
      ({ school: 12, major: 12, skills: 20, direction: 16 } as Row)[facet] ||
      Infinity;
  const visible = options.filter(
      (f, index) => expanded || index < limit || selected.includes(f.value),
    ),
    hidden = options.length - visible.length;
  return (
    <div className="chips">
      {visible.map((f) => (
        <button
          key={f.value}
          aria-pressed={selected.includes(f.value)}
          className={selected.includes(f.value) ? "selected" : ""}
          onClick={() => toggle(f.value)}
        >
          {label(facet, f.value) || "未填写"} <small>{f.count}</small>
        </button>
      ))}
      {hidden > 0 && (
        <button onClick={() => setExpanded(true)}>还有 {hidden} 项 ▾</button>
      )}
      {expanded && options.length > limit && (
        <button onClick={() => setExpanded(false)}>收起更多选项</button>
      )}
      {!options.length && <small className="muted">暂无选项</small>}
    </div>
  );
}
function ChipInput({
  value,
  onChange,
  suggestions = [],
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions?: string[];
  label: string;
}) {
  const [text, setText] = useState("");
  function add(v: string) {
    if (v.trim())
      onChange([
        ...new Set([
          ...value,
          ...(label.includes("技能") ? skillTokens(v) : tokens(v)),
        ]),
      ]);
    setText("");
  }
  return (
    <div>
      <div className="chips">
        {value.map((v) => (
          <button
            key={v}
            className="selected"
            aria-label={"移除" + label + v}
            onClick={() => onChange(value.filter((x) => x !== v))}
          >
            {v}
            <X size={12} />
          </button>
        ))}
      </div>
      <input
        aria-label={label + "自填"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          }
        }}
        placeholder="输入后回车添加"
      />
      {suggestions.length > 0 && (
        <div className="chips suggestions">
          {suggestions
            .filter((v) => !value.includes(v))
            .slice(0, 12)
            .map((v) => (
              <button key={v} onClick={() => add(v)}>
                {v}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
function Hit({ text, hit }: { text: string; hit?: Row }) {
  if (!hit?.ranges?.length) return <>{text}</>;
  const parts = [];
  let end = 0;
  for (const r of hit.ranges) {
    parts.push(text.slice(end, r.start));
    parts.push(<mark key={r.start}>{text.slice(r.start, r.end)}</mark>);
    end = r.end;
  }
  parts.push(text.slice(end));
  return <>{parts}</>;
}
function LeadEditor({
  lead,
  dictionary,
  schools,
  onClose,
  onDone,
}: {
  lead: Row;
  dictionary: Row[];
  schools: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { user } = useApp();
  const [ownerIds, setOwnerIds] = useState<string[]>([
    lead.owner_id || user.id,
  ]);
  const [skills, setSkills] = useState((lead.skills || []).join("，")),
    [initialState, setInitialState] = useState(lead.state || "uncontacted"),
    normalized = skillTokens(skills).map(
      (v) =>
        dictionary.find((d) => d.aliases.includes(v.toLowerCase()))?.name || v,
    );
  return (
    <Dialog title={lead.id ? "编辑线索" : "新建线索"} onClose={onClose} wide>
      <ConfiguredForm kind="lead" id={lead.id} core={lead} customFields={lead.customFields} mode={lead.id?"edit":"create"}
        onCancel={onClose}
        onSubmit={async (payload,form) => {
          if (!ownerIds.length) throw Error("请选择线索负责人");
          const b = values(form),
            body = {
              ...payload,
              line: b.line,
              ownerId: ownerIds[0],
              raw: b.raw,
              ...(!lead.id
                ? {
                    state: initialState,
                    ...(b.followupDate ? { followupDate: b.followupDate } : {}),
                    ...(b.occurredAt
                      ? { occurredAt: new Date(b.occurredAt).toISOString() }
                      : {}),
                  }
                : {}),
            };
          await api(lead.id ? "/leads/" + lead.id : "/leads", {
            method: lead.id ? "PATCH" : "POST",
            body: lead.id ? { ...body, version: lead.version } : body,
          });
          onDone();
        }}
      >
        <div className="form-grid">
          <Field label="搜集线路" required>
            <select name="line" defaultValue={lead.line || "high"}>
              {Object.entries(lines)
                .filter(([v]) => v !== "all")
                .map(([v, t]) => (
                  <option value={v} key={v}>
                    {String(t)}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <datalist id="lead-school-options">
          {schools.map((school) => (
            <option value={school} key={school} />
          ))}
        </datalist>
        <div className="form-grid">
          <Field label="状态">
            <select
              value={initialState}
              disabled={!!lead.id}
              onChange={(e) => setInitialState(e.target.value)}
            >
              {leadStates.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          {lead.id ? (
            <Field label="最近跟进">
              <input readOnly value={date(lead.last_followup_at)} />
            </Field>
          ) : (
            <Field label="跟进日（不代表实际联系）">
              <input type="date" name="followupDate" />
            </Field>
          )}
        </div>
        {!lead.id &&
          initialState !== "uncontacted" &&
          initialState !== "declined" && (
            <Field
              label="实际联系时间"
              required={initialState === "contacted"}
              hint="只填写确实发生的联系；未知时不填，不使用新建时间代替。"
            >
              <input
                name="occurredAt"
                type="datetime-local"
                required={initialState === "contacted"}
              />
            </Field>
          )}
        <MemberPicker
          role="owner"
          value={ownerIds}
          onChange={setOwnerIds}
          multiple={false}
        />
        <Field label="原始线索文本">
          <textarea
            name="raw"
            rows={4}
            maxLength={100000}
            defaultValue={lead.raw}
          />
        </Field>
        <p className="notice">
          编辑资料不会更新最近联系时间。实际联系请使用“跟进”或“已联系未回”动作。
        </p>
      </ConfiguredForm>
    </Dialog>
  );
}
function LeadState({
  lead,
  onClose,
  onDone,
}: {
  lead: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog
      title={lead.deleting ? "确认删除线索" : "人工更新线索状态"}
      onClose={onClose}
    >
      <Form
        onCancel={onClose}
        submit="确认保存"
        onSubmit={async (form) => {
          const b = values(form);
          await api(
            "/leads/" + lead.id + (lead.deleting ? "/delete" : "/transition"),
            {
              method: "POST",
              body: lead.deleting
                ? { version: lead.version }
                : {
                    version: lead.version,
                    state: lead.target,
                    confirm: true,
                    reason: b.reason,
                    occurredAt: b.occurredAt
                      ? new Date(b.occurredAt).toISOString()
                      : undefined,
                  },
            },
          );
          onDone();
        }}
      >
        <p>
          {lead.name} ·{" "}
          {lead.deleting
            ? "记录将软删除，保留历史。"
            : `由 ${label("state", lead.state)} 变更为 ${label("state", lead.target)}`}
        </p>
        {!lead.deleting && (
          <>
            <Field label="操作说明" required>
              <textarea name="reason" required />
            </Field>
            {lead.target === "contacted" && (
              <Field label="实际联系时间" required>
                <input
                  name="occurredAt"
                  type="datetime-local"
                  required
                  defaultValue={new Date(
                    Date.now() - new Date().getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)}
                />
              </Field>
            )}
            <p className="muted">
              终态重开和跳步需要负责人权限。不会自动触达联系人。
            </p>
          </>
        )}
      </Form>
    </Dialog>
  );
}
function Followup({
  lead,
  onClose,
  onDone,
}: {
  lead: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog title={lead.name + " · 记录跟进"} onClose={onClose}>
      <Form
        onCancel={onClose}
        onSubmit={async (form) => {
          const b = values(form);
          await api("/leads/" + lead.id + "/followups", {
            method: "POST",
            body: {
              version: lead.version,
              kind: b.kind,
              note: b.note,
              occurredAt: new Date(b.occurredAt).toISOString(),
            },
          });
          onDone();
        }}
      >
        <Field label="记录类型">
          <select name="kind">
            <option value="note">备注（不刷新联系时钟）</option>
            <option value="contact">实际联系（刷新联系时钟）</option>
          </select>
        </Field>
        <Field label="发生时间" required>
          <input
            name="occurredAt"
            type="datetime-local"
            required
            defaultValue={new Date(
              Date.now() - new Date().getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)}
          />
        </Field>
        <Field label="跟进内容" required>
          <textarea name="note" rows={5} required />
        </Field>
      </Form>
    </Dialog>
  );
}
