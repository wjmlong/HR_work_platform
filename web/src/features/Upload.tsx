import {observeSubmittedTasks} from '../lib/upload-completion';
import {useBusinessDefinition} from "../lib/use-business-definition";
import { useEffect, useRef, useState } from "react";
import { UploadSimple, FileText, ArrowsClockwise } from "@phosphor-icons/react";
import { api, query } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  date,
  edu,
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
  JobSelect,
  Status,
  MatchScore,
  Pagination,
} from "../components/ui";
// 年龄：简历解析到就照录；没有则按「18 岁上大学」推算起算年龄 + 工作年限，标注「（预计）」。
// 起算年龄：大专 21、本科 22、硕士 25、博士 28、高中/中专 18，学历未知按本科 22。
const startAge: Record<string, number> = {
  doctor: 28,
  master: 25,
  bachelor: 22,
  associate: 21,
  secondary: 18,
};
function ageValue(profile: Row) {
  const age = Number(profile?.age);
  if (Number.isFinite(age) && age > 0 && age <= 120) return { value: age, estimated: false };
  const years = Number(profile?.experienceYears);
  if (!Number.isFinite(years) || years < 0) return { value: null as number | null, estimated: false };
  return { value: Math.round(years + (startAge[profile?.education] ?? 22)), estimated: true };
}
function displayAge(profile: Row) {
  const a = ageValue(profile);
  if (a.value === null) return { text: "—", estimated: false };
  return { text: a.value + (a.estimated ? "（预计）" : " 岁"), estimated: a.estimated };
}
function scoreValue(a: Row) {
  const s = a?.match?.score;
  if (!s) return null as number | null;
  const v = s.value ?? s.lower;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}
const taskLabels: Record<string, string> = {
  queued: "排队中",
  running: "解析中",
  succeeded: "已完成",
  awaiting_duplicate_decision: "等待重复确认",
  failed: "解析失败",
  needs_text: "需要文本补充",
  cancelled: "已取消",
};
export default function Upload({ jobs }: { jobs: Row[] }) {
  const { revision, refresh, notify, openApplication, canWrite } = useApp(),
    resumeDefinition=useBusinessDefinition("resume"),
    applicationDef=useBusinessDefinition("application"),
    [job, setJob] = useState(""),
    [source, setSource] = useState(""),
    [customSource, setCustomSource] = useState(false),
    sourceInit=useRef(false),
    [note, setNote] = useState(""),
    [paste, setPaste] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [taskPage, setTaskPage] = useState(1),
    [local, setLocal] = useState<
      { key: string; file: File; state: string; error?: string }[]
    >([]),
    [task, setTask] = useState<Row | null>(null),
    [drag, setDrag] = useState(false),
    input = useRef<HTMLInputElement>(null);
  const taskResult = useResource<Row>(
    (s) =>
      query(
        "/tasks/query",
        {
          kind: "ingest",
          view: showHistory ? "history" : "actionable",
          page: taskPage,
        },
        s,
      ),
    [showHistory, taskPage, revision],
  );
  const tasks = {
    ...taskResult,
    data: taskResult.data?.items as Row[] | undefined,
  };
  const recent = useResource<Row>(
    (s) => query("/applications/query", { pageSize: 50 }, s),
    [revision],
  );
  const [srcFilter,setSrcFilter]=useState(''),[scoreFilter,setScoreFilter]=useState(''),[ageFilter,setAgeFilter]=useState('');
  const [cross,setCross]=useState<Row|null>(null),[crossOpen,setCrossOpen]=useState(false),[crossBusy,setCrossBusy]=useState(false),[crossThreshold,setCrossThreshold]=useState(60);
  const runCross=async()=>{
   setCrossBusy(true);
   try{
    const r=await api<Row>('/candidates/matching/cross-job',{method:'POST',body:{threshold:Number(crossThreshold)}});
    setCross(r);setCrossOpen(true);
   }catch(e){notify((e as Error).message,true);}finally{setCrossBusy(false);}
  };
  const recentRows:Row[]=recent.data?.items||[];
  const sources=[...new Set(recentRows.map(a=>String(a.source||'—')))].sort();
  // 来源以业务配置「招聘来源」维度为准，历史已用来源作为补充，避免配置漏项时无法选。
  const configuredSources=applicationDef.data?.fields.find((f:Row)=>f.coreKey==="source")?.options?.filter((o:Row)=>o.active)||[];
  const sourceOptions=[...new Set([...configuredSources.map((o:Row)=>String(o.label||o.id)),...sources.filter(s=>s&&s!=="—")])];
  const effectiveOptions=source&&!sourceOptions.includes(source)?[...sourceOptions,source]:sourceOptions;
  // 只在配置首次加载时给默认值，之后不再回填，用户可以自由改选或清空。
  useEffect(()=>{
    if(!sourceInit.current&&sourceOptions.length){setSource(sourceOptions[0]);sourceInit.current=true;}
  },[sourceOptions.join("|")]);
  const filtered=recentRows.filter(a=>{
   if(srcFilter&&String(a.source||'—')!==srcFilter)return false;
   const sc=scoreValue(a);
   if(scoreFilter==='ge75'&&!(sc!==null&&sc>=75))return false;
   if(scoreFilter==='60to74'&&!(sc!==null&&sc>=60&&sc<75))return false;
   if(scoreFilter==='lt60'&&!(sc!==null&&sc<60))return false;
   if(scoreFilter==='none'&&sc!==null)return false;
   const av=ageValue(a.profile).value;
   if(ageFilter==='le30'&&!(av!==null&&av<=30))return false;
   if(ageFilter==='31to40'&&!(av!==null&&av>=31&&av<=40))return false;
   if(ageFilter==='41to50'&&!(av!==null&&av>=41&&av<=50))return false;
   if(ageFilter==='gt50'&&!(av!==null&&av>50))return false;
   if(ageFilter==='none'&&av!==null)return false;
   return true;
  });
  const [submitted,setSubmitted]=useState<string[]>([]);
  const track=(task:Row)=>{if(task.id)setSubmitted(ids=>[...new Set([...ids,task.id])]);};
  useEffect(()=>{if(!submitted.length)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
   const poll=async()=>{try{const result=await observeSubmittedTasks(submitted,id=>api<Row>("/tasks/"+id,{signal:abort.signal}));if(abort.signal.aborted)return;if(result.completed.length){setSubmitted(ids=>ids.filter(id=>!result.completed.some(t=>t.id===id)));tasks.reload();recent.reload();refresh();}else timer=setTimeout(poll,1500);}catch{if(!abort.signal.aborted)timer=setTimeout(poll,1500);}};void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[submitted,tasks.reload,recent.reload,refresh]);
  const active = (taskResult.data?.active || 0) > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tasks.reload(), 1500);
    return () => clearInterval(timer);
  }, [active, tasks.reload]);
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    let changed = false;
    for (const t of tasks.data || []) {
      if (
        seen.current[t.id] &&
        seen.current[t.id] !== t.state &&
        [
          "succeeded",
          "awaiting_duplicate_decision",
          "failed",
          "needs_text",
        ].includes(t.state)
      )
        changed = true;
      seen.current[t.id] = t.state;
    }
    if (changed) {
      recent.reload();
      refresh();
    }
  }, [tasks.data]);
  async function send(item: { key: string; file: File }) {
    if (!job) {
      notify("请先选择目标岗位", true);
      return;
    }
    setLocal((all) =>
      all.map((x) =>
        x.key === item.key ? { ...x, state: "uploading", error: "" } : x,
      ),
    );
    const form = new FormData();
    form.append("jobId", job);
    form.append("source", source);
    form.append("note", note);
    form.append("file", item.file);
    try {
      track(await api<Row>("/uploads", { method: "POST", body: form, key: item.key }));
      setLocal((all) => all.filter((x) => x.key !== item.key));
      tasks.reload();
    } catch (e) {
      setLocal((all) =>
        all.map((x) =>
          x.key === item.key
            ? { ...x, state: "failed", error: (e as Error).message }
            : x,
        ),
      );
    }
  }
  async function addFiles(files: FileList | File[]) {
    if (!job) {
      notify("请先选择目标岗位，再上传简历", true);
      return;
    }
    const items = Array.from(files).map((file) => ({
      key: crypto.randomUUID(),
      file,
      state: "waiting",
    }));
    setLocal((all) => [...all, ...items]);
    for (const item of items) await send(item);
  }
  return (
    <>
      <PageHeader
        title="上传简历"
        description="上传简历并核对解析结果"
      />
      {resumeDefinition.data?.fields.some(f=>!f.coreKey&&f.active&&f.required)&&<p className="notice warning">扩展必填字段需人工核对。文件解析保留原始事实，上传完成后请打开申请详情补充并创建简历版本。</p>}
      <Panel>
        <div className="upload-options">
          <JobSelect
            jobs={jobs.filter((j) => j.open)}
            value={job}
            onChange={setJob}
            all={false}
          />
          {customSource ? (
            <div className="source-custom">
              <input
                aria-label="自定义简历来源"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="输入来源名称"
                title="自定义来源不会自动写入业务配置；如需长期可用，请在业务配置里新增"
              />
              <button className="small" onClick={()=>{setCustomSource(false);setSource(effectiveOptions[0]||"");}}>返回列表</button>
            </div>
          ) : (
            <select
              aria-label="简历来源"
              value={effectiveOptions.includes(source)?source:effectiveOptions[0]||""}
              onChange={(e)=>{if(e.target.value==="__custom__"){setCustomSource(true);setSource("");}else setSource(e.target.value);}}
              title="选项来自业务配置「招聘来源」维度，并补充历史已用来源；可选自定义输入新值"
            >
              {effectiveOptions.map((x)=><option key={x} value={x}>{x}</option>)}
              <option value="__custom__">＋ 自定义来源</option>
            </select>
          )}
          <input
            aria-label="上传备注"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="备注（可选，如：周一面试初筛）"
          />
        </div>
        <div
          className={"dropzone " + (drag ? "drag" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void addFiles(e.dataTransfer.files);
          }}
        >
          <button
            className="drop-trigger"
            onClick={() => input.current?.click()}
          >
            <span className="upload-symbol">
              <UploadSimple size={32} />
            </span>
            <strong>点击选择文件，或把简历拖到这里</strong>
            <span>
              支持一次选择多份，单份最大 10MB；重复简历由你决定如何处理
            </span>
          </button>
          <div className="format-tags">
            <span>PDF</span>
            <span>Word .docx</span>
            <span>纯文本 .txt</span>
            <span className="muted">扫描件请补充粘贴文本</span>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept=".pdf,.docx,.txt"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <div className="toolbar subtle">
          <button onClick={() => setPaste((v) => !v)}>
            <FileText size={16} />
            {paste ? "收起文本面板" : "没有文件？粘贴简历文本解析"}
          </button>
          <small>
            原件、原文与历史版本保留；解析与规则匹配不会自动推进或淘汰。
          </small>
        </div>
        <button
          className="text-button small"
          onClick={() => {
            setShowHistory((v) => !v);
            setTaskPage(1);
          }}
        >
          {showHistory ? "收起已完成队列" : "查看处理历史"}
        </button>
        {paste && (
          <Form
            submit="保存文本并解析"
            onSubmit={async (form) => {
              const b = values(form);
              if (!job) throw Error("请选择目标岗位");
              track(await api<Row>("/uploads/text", {
                method: "POST",
                body: { jobId: job, text: b.text, source, note },
              }));
              form.reset();
              tasks.reload();
              notify("文本已保存，正在排队解析");
            }}
          >
            <Field label="简历原文" required>
              <textarea
                name="text"
                rows={8}
                required
                maxLength={2097152}
                placeholder="粘贴简历全文，缺失字段可以后续补充核对。"
              />
            </Field>
          </Form>
        )}
      </Panel>
      {(showHistory ||
        taskPage > 1 ||
        local.length > 0 ||
        tasks.error ||
        tasks.data?.length) && (
        <Panel
          title="处理队列"
          action={
            <button onClick={tasks.reload}>
              <ArrowsClockwise size={16} />
              刷新
            </button>
          }
        >
          {tasks.error && (
            <p className="notice error" role="alert">
              {tasks.error}
            </p>
          )}
          <div className="queue">
            {local.map((item) => (
              <div className="queue-row" key={item.key}>
                <FileText size={19} />
                <span>
                  {item.file.name}
                  <small>{item.error}</small>
                </span>
                <span>
                  {item.state === "failed"
                    ? "上传未完成"
                    : item.state === "waiting"
                      ? "等待上传"
                      : "文件上传中"}
                </span>
                {item.state === "failed" ? (
                  <button onClick={() => void send(item)}>重试上传</button>
                ) : (
                  <progress aria-label="正在上传" />
                )}
              </div>
            ))}
            {tasks.data?.map((t) => (
              <div className="queue-row" key={t.id}>
                <FileText size={19} />
                <span>
                  {t.file_name || "简历"}
                  <small>{date(t.created_at)}</small>
                </span>
                <span className={t.state === "failed" ? "text-danger" : ""}>
                  {taskLabels[t.state]}
                </span>
                {["running", "queued"].includes(t.state) ? (
                  <progress aria-label={taskLabels[t.state]} />
                ) : null}
                <div className="toolbar">
                  {t.state === "succeeded" && t.result?.applicationId && (
                    <button
                      onClick={() => openApplication(t.result.applicationId)}
                    >
                      解析明细
                    </button>
                  )}
                  {["needs_text", "awaiting_duplicate_decision"].includes(
                    t.state,
                  ) && (
                    <button className="primary" onClick={() => setTask(t)}>
                      处理
                    </button>
                  )}
                  {t.state === "failed" && (
                    <button
                      onClick={() =>
                        api("/tasks/" + t.id + "/retry", { method: "POST" })
                          .then(tasks.reload)
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      重试解析
                    </button>
                  )}
                  {!["succeeded", "cancelled"].includes(t.state) && (
                    <button
                      onClick={() =>
                        api("/tasks/" + t.id + "/cancel", { method: "POST" })
                          .then(tasks.reload)
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Pagination
            page={taskPage}
            total={taskResult.data?.total || 0}
            onChange={setTaskPage}
          />
        </Panel>
      )}
      <Panel title="最近上传" action={<div className="toolbar"><small className="hint" title="按申请创建时间倒序，最多取最近 50 条；筛选只作用于这一页显示的数据，不改动服务器数据">显示 {filtered.length} / {recentRows.length} 条 · 最近 50 条内筛选</small><button className="small" disabled={crossBusy} onClick={()=>void runCross()}>{crossBusy?'计算中…':'跨岗提醒'+(cross?.alerts?.length?' '+cross.alerts.length:'')}</button></div>}>
        <Resource {...recent} preserve={recent.data!==undefined} retry={recent.reload}>
          {filtered.length ? (
            <div className="table-scroll">
              <table className="recent-table">
                <thead>
                  <tr>
                    <th>候选人</th>
                    <th>应聘岗位</th>
                    <th>联系方式</th>
                    <th className="filterable"><span className="hint" title="简历写了年龄就照录；没写则按 18 岁上大学的起算年龄 + 工作年限推算，标注「（预计）」。鼠标悬停在具体数值上可看依据">年龄</span>
                      <select className="th-filter" aria-label="按年龄筛选" value={ageFilter} onChange={e=>setAgeFilter(e.target.value)}>
                        <option value="">全部</option>
                        <option value="le30">30 岁及以下</option>
                        <option value="31to40">31–40 岁</option>
                        <option value="41to50">41–50 岁</option>
                        <option value="gt50">50 岁以上</option>
                        <option value="none">无法测算</option>
                      </select>
                    </th>
                    <th>学历 / 年限</th>
                    <th className="filterable"><span className="hint" title="简历导入时登记的来源渠道，选项按当前页实际出现的值生成">来源</span>
                      <select className="th-filter" aria-label="按来源筛选" value={srcFilter} onChange={e=>setSrcFilter(e.target.value)}>
                        <option value="">全部</option>
                        {sources.map(s=><option key={s} value={s}>{s}</option>)}
                      </select>
                    </th>
                    <th className="filterable"><span className="hint" title="按岗位当前发布的评分标准算出的匹配度；分数带「待核实」表示有字段未识别或维度未评分">专业对照</span>
                      <select className="th-filter" aria-label="按匹配分筛选" value={scoreFilter} onChange={e=>setScoreFilter(e.target.value)}>
                        <option value="">全部</option>
                        <option value="ge75">75% 及以上</option>
                        <option value="60to74">60–74%</option>
                        <option value="lt60">低于 60%</option>
                        <option value="none">未评分</option>
                      </select>
                    </th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a: Row) => (
                    <tr key={a.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => openApplication(a.id)}
                        >
                          {a.profile.name}
                        </button>
                      </td>
                      <td>{a.job_name}</td>
                      <td>
                        {a.profile.phone || "—"}
                        <small>{a.profile.email}</small>
                      </td>
                      <td
                        title={
                          displayAge(a.profile).estimated
                            ? "简历未写年龄；按 18 岁上大学测算的起算年龄 + 工作年限推算，仅供参考"
                            : "简历原文摘录"
                        }
                      >
                        {displayAge(a.profile).text}
                      </td>
                      <td>
                        {edu(a.profile.education)} /{" "}
                        {a.profile.experienceYears ?? "未注明"} 年
                      </td>
                      <td>{a.source}</td>
                      <td>
                        <MatchScore match={a.match} />
                      </td>
                      <td>
                        <button
                          className="primary small"
                          onClick={() => openApplication(a.id)}
                        >
                          解析明细
                        </button>
                        {canWrite&&a.is_current!==false&&a.resume_version_id&&<button className="small" onClick={()=>openApplication(a.id,true)}>编辑资料</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{recentRows.length?'没有符合筛选条件的记录，可调整上方筛选框':'上传第一份简历，开始人工核对'}</Empty>
          )}
        </Resource>
      </Panel>
      {crossOpen&&cross&&<Dialog title={'跨岗位匹配提醒 · 阈值 '+cross.threshold+'%'} onClose={()=>setCrossOpen(false)} wide>
       <p className="notice">已对 {cross.scanned} 条当前申请在 {cross.jobs} 个在招岗位各算一次分，排除 {cross.commonTermsExcluded||0} 个共性词后 <strong>{cross.alerts?.length||0} 人</strong>触发提醒。仅提示，不自动转岗。<i className="info-tip" title="判定：当前岗位分数低于阈值，且其它在招岗位最高分达到阈值。为避免误推荐，跨岗算分剔除了「投资/融资/银行/财务管理」等多数简历都有的共性词（按 326 份简历文档频率与岗位复用度生成），技术/资质专名保留；岗位主评分不受影响">i</i></p>
       <div className="toolbar">
        <label className="check">阈值 <input type="number" min={0} max={100} value={crossThreshold} onChange={e=>setCrossThreshold(Number(e.target.value))} style={{width:72}}/> %</label>
        <button className="small" disabled={crossBusy} onClick={()=>void runCross()}>重新计算</button>
       </div>
       <div className="table-scroll"><table><thead><tr><th>候选人</th><th>当前岗位 / 匹配分</th><th>建议岗位 / 匹配分</th><th>评分依据（命中技能）</th><th>操作</th></tr></thead><tbody>
        {(cross.alerts||[]).map((x:Row)=><tr key={x.applicationId}>
         <td>{x.name}</td>
         <td>{x.currentJobName} · {x.currentScore===null?'未评分':x.currentScore+'%'}</td>
         <td><strong>{x.bestJobName} · {x.bestScore}%</strong><small>命中 {x.bestHitCount||0} 项</small></td>
         <td><small className="hint" title={(x.bestEvidence||[]).map((e:Row)=>e.label+'（'+e.method+'）：'+e.reason).join('\n')||'无命中依据'}>{(x.bestEvidence||[]).map((e:Row)=>e.label).join('、')||'—'}</small></td>
         <td><button className="small" onClick={()=>{setCrossOpen(false);openApplication(x.applicationId);}}>查看简历</button></td>
        </tr>)}
       </tbody></table></div>
       {!cross.alerts?.length&&<Empty>没有触发提醒的候选人，可把阈值调低后再计算</Empty>}
      </Dialog>}
      {task && (
        <TaskAction
          task={task}
          onClose={() => setTask(null)}
          onDone={() => {
            track(task);
            setTask(null);
            tasks.reload();
            refresh();
          }}
        />
      )}
    </>
  );
}
function TaskAction({
  task,
  onClose,
  onDone,
}: {
  task: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const { notify } = useApp();
  const [choice, setChoice] = useState("replace");
  const [selected, setSelected] = useState(
    task.result?.duplicates?.[0]?.candidateId || "",
  );
  const comparison = useResource<Row>(
    (s) =>
      task.state === "awaiting_duplicate_decision"
        ? api("/tasks/" + task.id, { signal: s })
        : Promise.resolve({}),
    [task.id],
  );
  const old = comparison.data?.comparison?.candidates?.find(
    (p: Row) => p.id === selected,
  );
  const incoming = comparison.data?.comparison?.incoming;
  return (
    <Dialog
      title={
        task.state === "needs_text" ? "补充简历文本" : "重复简历 · 人工确认"
      }
      onClose={onClose}
      wide={task.state === "awaiting_duplicate_decision"}
    >
      <Form
        onCancel={onClose}
        submit="确认并继续"
        onSubmit={async (form) => {
          const b = values(form);
          if (task.state === "needs_text")
            await api("/tasks/" + task.id + "/text", {
              method: "POST",
              body: { text: b.text },
            });
          else {
            if (
              choice === "replace" &&
              (!incoming || !old || old.changedSinceDetection)
            )
              throw Error(
                "请先加载并核对新旧档案；已有档案变化时请取消并重新导入",
              );
            const d = task.result.duplicates.find(
              (d: Row) => d.candidateId === b.candidateId,
            );
            const result = await api<Row>("/tasks/" + task.id + "/duplicate", {
              method: "POST",
              body:
                choice === "replace"
                  ? {
                      choice,
                      candidateId: d.candidateId,
                      candidateVersion: d.candidateVersion,
                    }
                  : { choice },
            });
            if (result.transferRequired)
              notify(
                "已保留原岗位与流程；如需改派到本次上传所选岗位，请在详情页使用流转",
              );
          }
          onDone();
        }}
      >
        {task.state === "needs_text" ? (
          <>
            <p className="notice">
              未提取到可用文本。扫描件 OCR 未配置，请粘贴原文。
            </p>
            <Field label="简历全文" required>
              <textarea name="text" required rows={12} />
            </Field>
          </>
        ) : (
          <>
            <p className="notice">
              系统只提示疑似重复。覆盖会采用新简历并保留旧版本；岗位与流程保持不变。若需改派岗位，请使用流转。
            </p>
            <Field label="处理方式">
              <select
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="replace">覆盖当前画像与简历（保留历史）</option>
                <option value="keep_separate">并存：作为独立候选人保留</option>
                <option value="skip">跳过此次导入</option>
              </select>
            </Field>
            {task.result.duplicates.length > 0 && (
              <Field label="选择对应候选人" required>
                <select
                  name="candidateId"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  required
                >
                  {task.result.duplicates.map((d: Row) => (
                    <option key={d.candidateId} value={d.candidateId}>
                      {d.name} ·{" "}
                      {
                        ({ high: "高", medium: "中", low: "低" } as Row)[
                          d.confidence
                        ]
                      }
                      置信度 ·{" "}
                      {d.reason === "same_file"
                        ? "文件指纹相同"
                        : d.reason === "same_contact"
                          ? "联系方式相同"
                          : "姓名相似"}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Resource {...comparison} preserve={comparison.data!==undefined} retry={comparison.reload}>
              {incoming && old && (
                <>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>对比字段</th>
                          <th>已有候选人</th>
                          <th>本次上传</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            "name",
                            "phone",
                            "email",
                            "education",
                            "school",
                            "bachelorSchool",
                            "experienceYears",
                            "location",
                            "skills",
                          ] as const
                        ).map((key) => {
                          const labels: Row = {
                            name: "姓名",
                            phone: "电话",
                            email: "邮箱",
                            education: "学历",
                            school: "最高学历院校",
                            bachelorSchool: "本科院校",
                            experienceYears: "工作年限",
                            location: "城市",
                            skills: "技能",
                          };
                          const display = (p: Row) =>
                            key === "education"
                              ? edu(p[key])
                              : Array.isArray(p[key])
                                ? p[key].join("、")
                                : (p[key] ?? "未注明");
                          return (
                            <tr key={key}>
                              <th>{labels[key]}</th>
                              <td>{display(old.profile) || "未注明"}</td>
                              <td>{display(incoming.profile) || "未注明"}</td>
                            </tr>
                          );
                        })}
                        <tr>
                          <th>岗位与流程</th>
                          <td>
                            {old.applications.map((app: Row, n: number) => (
                              <div key={n}>
                                {app.job_name} · <Status value={app.status} />
                                {app.is_current ? "（当前）" : "（历史）"}
                              </div>
                            ))}
                          </td>
                          <td>{incoming.job_name}（覆盖时不会改派）</td>
                        </tr>
                        <tr>
                          <th>文件</th>
                          <td>原有文件与各版本保留</td>
                          <td>{incoming.file_name}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {old.changedSinceDetection && (
                    <p role="alert" className="notice warning">
                      已有档案在重复检测后被修改。本次覆盖会被拦截，请取消并重新导入核对。
                    </p>
                  )}
                </>
              )}
            </Resource>
          </>
        )}
      </Form>
    </Dialog>
  );
}
