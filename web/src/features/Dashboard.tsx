import MailboxUpdateButton from './MailboxUpdateButton';
import {useCompactLayout} from '../lib/use-compact-layout';
import { useState } from "react";
import { api, query } from "../lib/api";
import {
  useApp,
  useResource,
  useDebounced,
  Resource,
  stages,
  date,
  pct,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  JobSelect,
  Empty,
  Dialog, Form, Field,
} from "../components/ui";
import { TransitionDialog } from "./People";
import ScreeningAccess from "./ScreeningAccess";
import { ccTemplates } from "../lib/prd";
import "./dashboard-board.css";
const names: Record<string, string> = Object.fromEntries(stages);
const activeStages = stages.filter(([stage]) => !["hired","terminated","rejected","hired_other"].includes(stage));
export default function Dashboard({ jobs, embedded = false }: { jobs: Row[]; embedded?: boolean }) {
  const { revision, refresh, notify, openApplication, canWrite, isAdmin } = useApp();
  const [job, setJob] = useState(""),
    [text, setText] = useState(""),
    [edit, setEdit] = useState<Row | null>(null),
    [screening, setScreening] = useState(false),
    [busy, setBusy] = useState(false),
    [showAllMetrics, setShowAllMetrics] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [batchTo, setBatchTo] = useState("interviewing");
  const [batchReview,setBatchReview]=useState<Row|null>(null),[batchReason,setBatchReason]=useState(''),[batchOpinion,setBatchOpinion]=useState(''),[batchConfirm,setBatchConfirm]=useState(false);
  const batchTargets = activeStages.filter(([s]) => !["on_hold", "reserve"].includes(s));
  const compact = useCompactLayout();
  const [selectedStage, setSelectedStage] = useState("");
  const visibleStage = compact ? selectedStage || "screening" : selectedStage;
  const search = useDebounced(text),
    result = useResource<Row>(
      (signal) =>
        query(
          "/dashboard/query",
          { jobId: job || undefined, query: search },
          signal,
        ),
      [job, search, revision],
    );
  const d = result.data,
    k = d?.kpis;
  async function move(a: Row, to: string) {
    if (busy || !canWrite || to === a.status) return;
    if (
      ["rejected", "terminated", "hired_other", "on_hold", "reserve"].includes(to) ||
      ["hired", "terminated", "rejected", "hired_other"].includes(a.status)
    ) {
      setEdit({ ...a, target: to });
      return;
    }
    setBusy(true);
    try {
      const moved=await api<Row>("/applications/" + a.id + "/transition", {
        method: "POST",
        body: { version: a.version, to, interaction: "drag" },
      });
      refresh();
      notify(
        moved.ccReminder
          ? "已保存。待补充抄送记录："+(moved.ccReminder.to||[]).join('、')+"；请在详情页核对准备事项。"
          : "环节已保存",
      );
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function prepareBatch() {
    if (busy || !selected.length || !canWrite) return;
    const rows=(d?.board||[]).flatMap((column:Row)=>column.items).filter((row:Row)=>selected.includes(row.id));
    if(rows.length!==new Set(selected).size){notify('所选记录已不在当前看板，请重新选择',true);return;}
    if(rows.length>50){notify('每次最多流转50人，请减少选择',true);return;}
    setBusy(true);
    try{
      const items=[];
      for(const row of rows){const cc=ccTemplates[batchTo]?await api<Row>('/applications/'+row.id+'/cc-options?stage='+batchTo):null;items.push({id:row.id,version:row.version,...(cc?{ccTemplateRef:cc.template.ref,ccRecipientIds:[]}:{}),name:row.profile?.name||'未授权姓名',status:row.status});}
      setBatchReview({to:batchTo,items});setBatchReason('');setBatchOpinion('');setBatchConfirm(false);
    }catch(e){notify((e as Error).message,true);}finally{setBusy(false);}
  }
  async function batchMove() {
    if (busy || !batchReview || !canWrite) return;
    setBusy(true);
    try {
      const r = await api<Row>("/applications/batch-transition", {
        method: "POST",
        body: { items:batchReview.items.map(({name:_n,status:_s,...item}:Row)=>item), to:batchReview.to, reason:batchReason,opinion:batchOpinion,confirm:batchConfirm,ccMethod:'deferred' },
      });
      const failed = (r.results || []).filter((x: Row) => !x.ok);
      notify(
        `批量流转完成：成功 ${r.succeeded} 人` +
          (failed.length ? `，失败 ${failed.length} 人 · ${failed.slice(0, 2).map((x: Row) => x.error).join("、")}` : "")+
          ((r.results||[]).some((x:Row)=>x.ccReminder)||ccTemplates[batchReview.to]?'；请逐条核对抄送及准备事项，暂未实际抄送。':''),
        failed.length > 0,
      );
      setSelected(failed.map((x:Row)=>x.id));setBatchReview(null);
      refresh();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const metrics = k
    ? [
        ["候选人总数", k.candidates],
        ["在流程中", k.inProcess],
        ["待筛选", k.screening],
        ["面试中", k.interviewing],
        ["资料 / 背调", k.collectionAndBackground],
        ["已发 offer", k.offered],
        ["已入职", k.hired],
        ["录用终止", k.terminated],
        ["录用到其他", k.hiredOther],
        ["待定 / 储备", k.onHold + k.reserve],
        ["已淘汰", k.rejected],
        ["Offer 转化率", pct(k.offerConversion)],
        ["在招岗位", k.jobs.open + " / " + k.jobs.total],
      ]
    : [];
  const primaryMetrics = metrics.filter((_, i) => [0, 1, 2, 3, 6].includes(i));
  const otherMetrics = metrics.filter((_, i) => ![0, 1, 2, 3, 6].includes(i));
  const boardControls = <>
    {canWrite && <MailboxUpdateButton />}
    {isAdmin && <button className="small" onClick={() => setScreening(true)}>临时权限</button>}
    <input
      aria-label="搜索姓名、技能、学校或公司"
      placeholder="搜索姓名 / 技能 / 学校 / 公司"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
    <JobSelect jobs={jobs} value={job} onChange={setJob} />
    <select aria-label="看板显示环节" value={visibleStage} onChange={e => setSelectedStage(e.target.value)}>
      {!compact && <option value="">全部环节</option>}
      {activeStages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </>;
  return (
    <>
      {embedded ? (
        <div className="toolbar section-toolbar embedded-board-controls">{boardControls}</div>
      ) : (
        <PageHeader
          title="招聘进行中"
          description="按环节推进候选人流程"
        >
          {boardControls}
        </PageHeader>
      )}
      {canWrite && selected.length > 0 && (
        <div className="board-batch-bar">
          <strong>已选 {selected.length} 人</strong>
          <select aria-label="批量流转目标环节" value={batchTo} onChange={(e) => setBatchTo(e.target.value)}>
            {batchTargets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="primary small" disabled={busy} onClick={() => void prepareBatch()}>批量流转</button>
          <button className="small" onClick={() => setSelected([])}>清空选择</button>
          <small className="hint" title="逐条复用单条流转的全部校验；版本冲突、节点未齐备等会单独返回失败，不影响其它人">执行口径</small>
        </div>
      )}
      <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
        {k && (
          <div className="board-statistics">
            <div className="board-metrics-summary">
              {primaryMetrics.map(([title, value]) => (
                <div className="board-metric" key={title}>
                  <small>{title}</small><strong>{value}</strong>
                </div>
              ))}
              <button className="text-button board-metrics-toggle"
                aria-expanded={showAllMetrics} aria-controls="board-more-metrics"
                onClick={() => setShowAllMetrics(!showAllMetrics)}>
                {showAllMetrics ? "收起统计" : "更多统计"}<span aria-hidden="true">{showAllMetrics ? "⌃" : "⌄"}</span>
              </button>
            </div>
            <div id="board-more-metrics" className="board-metrics-extra" hidden={!showAllMetrics}>
              {otherMetrics.map(([title, value]) => (
                <div className="board-metric" key={title}>
                  <small>{title}</small><strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
        {d && d.warnings.length > 0 && (
          <div className="dashboard-warnings" role="status">
            {d.warnings.map((w: Row) => (
              <div key={w.code}>
                <strong>
                  {w.code} · {w.count} 项
                </strong>{" "}
                {w.message}
                {w.names?.length > 0 && <span>：{w.names.join("、")}</span>}
                {w.applicationIds?.[0] && (
                  <button
                    className="text-button"
                    onClick={() => openApplication(w.applicationIds[0])}
                  >
                    查看并补录
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div
          className={"board dashboard-board" + (visibleStage ? " single-stage" : "")}
          aria-label="候选人流程看板"
          aria-busy={busy}
        >
          {d?.board.filter((column: Row) => activeStages.some(([stage]) => stage === column.stage) && (!visibleStage || column.stage === visibleStage)).map((column: Row) => (
            <section
              className={"board-column " + column.stage}
              key={column.stage}
              onDragOver={(e) => {
                if (canWrite && !busy) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const all = d!.board.flatMap((c: Row) => c.items),
                  a = all.find(
                    (x: Row) => x.id === e.dataTransfer.getData("text/plain"),
                  );
                if (a) void move(a, column.stage);
              }}
            >
              <header>
                <strong>{names[column.stage]}</strong>
                <span>{column.total}</span>
                {column.stage==='interviewing'&&<small className="hint" title="面试中的人请在「面试安排」核对是否有未来排期；无排期的人员需补排期后再推进">排期请核对</small>}
                {canWrite && column.items.length > 0 && <label className="check board-select-all">
                  <input type="checkbox" aria-label={"全选" + names[column.stage]}
                    checked={column.items.every((a: Row) => selected.includes(a.id))}
                    onChange={(e) => {
                      const ids = column.items.map((a: Row) => a.id);
                      setSelected((s) => e.target.checked ? [...new Set([...s, ...ids])] : s.filter((x) => !ids.includes(x)));
                    }} />本列
                </label>}
              </header>
              <div className="board-cards" tabIndex={0}
                role="region" aria-label={names[column.stage] + "候选人列表"}
                key={column.stage + job + search}>
                {column.items.map((a: Row) => (
                  <div className="board-card-wrap" key={a.id}>
                    {canWrite && <input type="checkbox" className="board-select"
                      aria-label={"选择 " + a.profile.name}
                      checked={selected.includes(a.id)}
                      onChange={(e) => setSelected((s) => e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id))} />}
                    <button
                      type="button"
                      className="candidate-card board-candidate"
                      draggable={canWrite && !busy}
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", a.id)}
                      onClick={() => openApplication(a.id)}
                      aria-label={a.profile.name + "，" + a.job_name + "，查看详情"}
                    >
                      <strong className="board-candidate-name">{a.profile.name}</strong>
                      <span className="board-candidate-job" title={a.job_name}>{a.job_name}</span>
                    </button>
                  </div>
                ))}
                {!column.items.length && <Empty>暂无候选人</Empty>}
                {column.hasMore && (
                  <a
                    href={
                      "#people?job=" +
                      encodeURIComponent(job) +
                      "&stage=" +
                      column.stage
                    }
                  >
                    查看全部 {column.total} 人
                  </a>
                )}
              </div>
              <footer className="board-column-footer">
                {column.total > 5 && <span>共 {column.total} 人 · 向下滚动查看更多</span>}
              </footer>
            </section>
          ))}
        </div>
        <p className="board-help hint" title="候选人总数＝收件箱简历＋当前岗位申请；当前岗位申请是进行中的流程数，各岗位『收到简历』按岗位维度统计，已归档/已删除申请不计入，因此几个数字可能不同">点击候选人查看详情与调整环节 · 悬停看候选人数字口径</p>
        <div className="dashboard-bottom">
          <Panel
            title="招聘漏斗 · 累计经过（人次）"
            action={<small className="hint" title="与左侧「招聘环节」的当前在岗人数口径不同：此处统计曾经过该环节的人次，排除录用终止与淘汰，所以同名标签的数值可能不一样">累计口径 · 悬停看差异说明</small>}
          >
            <div className="funnel">
              {d?.funnel.map((f: Row, i: number) => (
                <div className="funnel-row" key={f.stage}>
                  <span>{names[f.stage]}</span>
                  <div className="bar-track">
                    <div
                      style={{
                        width:
                          Math.max(
                            1,
                            d.funnel[0]?.count
                              ? (f.count / d.funnel[0].count) * 100
                              : 0,
                          ) + "%",
                        opacity: 1 - i * 0.08,
                      }}
                    />
                  </div>
                  <strong>{f.count}</strong>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="待办事项">
            {d?.todos.length ? (
              d.todos.map((todo: Row, i: number) => (
                <div className="todo-row" key={todo.id || todo.kind + i}>
                  <span className={"todo-dot " + todo.kind} />
                  <div>
                    <strong>
                      {todo.kind === "interview"
                        ? todo.name + " · 第 " + todo.round + " 轮面试"
                        : todo.kind === "arrival"
                          ? todo.name + " · 跟进入职"
                          : todo.kind === "cc"
                            ? "补录抄送记录"
                            : "补录录用终止原因"}
                    </strong>
                    <small>
                      {todo.kind === "interview"
                        ? date(todo.starts_at)
                        : todo.kind === "arrival"
                          ? "近 7 天已发 offer"
                          : todo.count + " 项待处理"}
                    </small>
                  </div>
                  {(todo.application_id || todo.id) && (
                    <button
                      className="text-button"
                      onClick={() =>
                        openApplication(todo.application_id || todo.id)
                      }
                    >
                      查看
                    </button>
                  )}
                </div>
              ))
            ) : (
              <Empty>暂无待办事项</Empty>
            )}
          </Panel>
        </div>
      </Resource>
      {batchReview&&<Dialog title={'确认批量流转至「'+names[batchReview.to]+'」'} onClose={()=>{if(!busy)setBatchReview(null);}}>
        <p>本次处理 {batchReview.items.length} 人，按当前查看的版本逐条校验。</p>
        <ul>{batchReview.items.map((item:Row)=><li key={item.id}>{item.name}：{names[item.status]} → {names[batchReview.to]}</li>)}</ul>
        <Form submit="确认批量流转" onCancel={()=>setBatchReview(null)} onSubmit={batchMove}>
          <Field label="调整原因"><input required maxLength={2000} value={batchReason} onChange={e=>setBatchReason(e.target.value)}/></Field>
          <Field label="人工核对意见（至少5字）"><textarea required minLength={5} maxLength={3000} value={batchOpinion} onChange={e=>setBatchOpinion(e.target.value)}/></Field>
          <label className="check"><input type="checkbox" checked={batchConfirm} onChange={e=>setBatchConfirm(e.target.checked)}/>确认包含跨阶段、回退或重新开启的调整；未确认时这些记录将单独失败</label>
          {ccTemplates[batchReview.to]&&<p className="notice">本次记录为「暂不抄送」，请在各申请详情中核对准备事项并补录实际抄送。</p>}
        </Form>
      </Dialog>}
      {screening && (
        <ScreeningAccess jobs={jobs} initialJob={job || undefined} onClose={() => setScreening(false)} />
      )}
      {edit && (
        <TransitionDialog
          application={edit}
          target={edit.target}
          jobs={jobs}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
            notify("流转记录已保存");
          }}
        />
      )}
    </>
  );
}
