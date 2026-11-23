import JobQuestions from './JobQuestions';
import {usePublishedDictionary} from '../lib/use-published-dictionary';import {refLabel,templateModeLabel} from '../lib/template-ui';
import { RequestScope, readableBrief } from "../lib/workflows";
import { questionsText, togglePoints } from "../lib/prd";
import {resolveBriefCitation,resolveSavedFact,type BriefCitation} from '../lib/citations';
import { useState, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { useApp, useResource, Resource, date, type Row } from "../lib/state";
import {
  PageHeader,
  Panel,
  Dialog,
  Form,
  Field,
  Empty,
  CopyButton,
  values,
} from "../components/ui";
import ApplicationPicker from "../components/ApplicationPicker";
const factNames: Row = {
  name: "姓名",
  email: "邮箱",
  phone: "电话",
  school: "院校",
  major: "专业",
  education: "学历",
  experienceYears: "工作年限",
  firstEmployment: "首次就业",
};
const conclusionNames: Row = {
  strong_yes: "强烈推进",
  yes: "推进",
  hold: "待定",
  no: "不推进",
};
const factName = (s: string) =>
  s.startsWith("skill:") ? "技能 · " + s.slice(6) : factNames[s] || s;
export default function Materials({ brief = false }: { brief?: boolean }) {
  const { revision, notify, openApplication, refresh, canWrite, user } =
      useApp(),
    [family,setFamily]=useState(""),[round,setRound]=useState(""),families=usePublishedDictionary("job_families"),
    [application, setApplication] = useState<Row | null>(null),
    [current, setCurrent] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [shown, setShown] = useState<string[]>([]),
    [history, setHistory] = useState<Row[] | null>(null),
    [citation, setCitation] = useState<BriefCitation | null>(null),
    [rawCitation, setRawCitation] = useState<Row | null>(null);
  useEffect(() => setShown([]), [current?.id, current?.version]);
  const scope = useRef(new RequestScope());
  useEffect(() => () => scope.current.change(), []);
  const select = (a: Row | null) => {
    scope.current.change();
    setApplication(a);
    setCurrent(null);
    setBusy(false);
    setEdit(false);
    setHistory(null);
    setCitation(null);
    setRawCitation(null);
  };
  const kind = brief ? "briefs" : "questions";
  const capabilities = useResource<Row>((signal) => api("/materials/capabilities", { signal }), []);
  const list = useResource<Row>(
    (s) =>
      application
        ? api("/applications/" + application.id + "/materials", { signal: s })
        : Promise.resolve({ questions: [], briefs: [] }),
    [application?.id, revision, kind],
  );
  useEffect(() => {
    setCurrent(null);
  }, [application?.id, kind]);
  async function open(id: string) {
    try {
      await scope.current.run(() => api("/" + kind + "/" + id), setCurrent);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function generate() {
    if (!application) return;
    setBusy(true);
    const token = scope.current.token;
    try {
      const result = await api<Row>(
        "/applications/" + application.id + "/" + kind,
        { method: "POST",...(!brief?{body:{...(family?{family}:{}),...(round?{round:Number(round)}:{})}}:{}) },
      );
      if (!scope.current.is(token)) return;
      setCurrent(result);
      list.reload();
      notify(
        brief
          ? "依据汇总已生成，最终结论请人工填写"
          : "规则题单已生成，请核对后使用",
      );
    } catch (e) {
      if (scope.current.is(token)) notify((e as Error).message, true);
    } finally {
      if (scope.current.is(token)) setBusy(false);
    }
  }
  const text = current
    ? brief
      ? readableBrief({
          data: current.data,
          human_conclusion: current.human_conclusion,
        })
      : questionsText(current.data.questions)
    : "";
  return (
    <>
      <PageHeader
        title={brief ? "决策建议" : "面试题库"}
        description={brief ? "汇总事实与评估形成结论" : "按岗位要求维护面试题目"}
      />
      {!brief && canWrite && <JobQuestions/>}
      {!brief && (
        <p className="notice">
          要点是参考答案（达标线），用于面试官判分与人事做面试官训练；不是让候选人背的标准答案。
        </p>
      )}
      <Panel title={brief ? "汇总设置" : "出题设置"} className="material-settings">
        <div className="material-tools">
          <ApplicationPicker
            value={application?.id || ""}
            selected={application}
            onChange={select}
          />
          {!brief&&<><Field label="岗位族（选填）" hint="限定题库适用范围，不确定时可留空。"><select value={family} onChange={e=>setFamily(e.target.value)}><option value="">未明确</option>{families.data?.options.filter((o:Row)=>o.active).map((o:Row)=><option key={o.id} value={o.id}>{o.label}</option>)}</select></Field><Field label="面试轮次（选填）" hint="填写 1–50；仅在题库限定轮次时必填。"><input type="number" min={1} max={50} placeholder="例如：1" value={round} onChange={e=>setRound(e.target.value)}/></Field></>}
          <div className="material-actions">
          <button
            className="primary"
            disabled={
              !application ||
              busy ||
              (!canWrite && !user.roles.includes("interviewer"))
            }
            onClick={() => void generate()}
          >
            {busy ? "正在生成…" : brief ? "生成依据汇总" : "生成规则题单"}
          </button>
          {application && (
            <button onClick={() => openApplication(application.id)}>
              查看解析依据
            </button>
          )}
          {!application && <span className="muted">先选择候选人与岗位，再生成{brief ? "依据汇总" : "题单"}。</span>}
          </div>
        </div>
        <div className="material-capabilities" aria-label="生成服务状态">
          {capabilities.loading ? <span>正在核对生成服务…</span> : capabilities.error ? <><span role="alert">暂时无法核对生成服务状态。</span><button onClick={capabilities.reload}>重新检查</button></> : <>
            <span><strong>此处生成方式</strong>本地规则题库</span>
            <span><strong>规则服务</strong>{capabilities.data?.rules?.configured ? "已启用" : "未启用"}</span>
            <span><strong>大模型服务</strong>{capabilities.data?.model?.configured ? "已接入，可在岗位参考题库选择 AI 生成" : "未接入"}</span>
            <p>{brief?"此依据汇总使用本地规则，不向模型发送履历。":"此候选人题单使用本地规则；上方岗位参考题库可单独选择公司 AI，不发送候选人履历。"}</p>
          </>}
        </div>
      </Panel>
      {application && (
        <Panel title="已保存材料">
          <Resource {...list} preserve={list.data!==undefined} retry={list.reload}>
            <div className="toolbar">
              {list.data?.[kind]?.map((m: Row) => (
                <button
                  className={current?.id === m.id ? "selected" : ""}
                  key={m.id}
                  onClick={() => void open(m.id)}
                >
                  {date(m.created_at)} · v{m.version}
                </button>
              ))}
              {!list.data?.[kind]?.length && (
                <Empty>为当前申请生成第一份材料</Empty>
              )}
            </div>
          </Resource>
        </Panel>
      )}
      {current && (
        <>
          <Panel
            title={brief ? "可追溯依据汇总" : "面试题单"}
            action={
              <div className="toolbar">
                <CopyButton
                  text={text}
                  label={brief ? "复制纯文本" : "复制全部"}
                />
                {!brief && (
                  <button
                    onClick={() =>
                      setShown((v) =>
                        togglePoints(
                          v,
                          current.data.questions.map((q: Row) => q.id),
                          "all",
                        ),
                      )
                    }
                  >
                    {current.data.questions.every((q: Row) =>
                      shown.includes(q.id),
                    )
                      ? "收起全部要点"
                      : "展开全部要点"}
                  </button>
                )}
                <button
                  onClick={() =>
                    scope.current
                      .run(
                        () =>
                          api<Row[]>("/materials/" + current.id + "/versions"),
                        setHistory,
                      )
                      .catch((e) => notify(e.message, true))
                  }
                >
                  版本历史
                </button>
                {!brief && (canWrite || user.roles.includes("interviewer")) && (
                  <button onClick={() => setEdit(true)}>人工编辑</button>
                )}
              </div>
            }
          >
            {!brief&&current.inputs?.questionTemplate&&<p className="notice">题库：{current.inputs.questionTemplate.document?.label} · {templateModeLabel(current.inputs.questionTemplate.document)} · {refLabel(current.inputs.questionTemplate.ref)} · 本次岗位族 {current.inputs.questionContext?.family||"未明确"}，第 {current.inputs.questionContext?.round||"未明确"} 轮。旧题单保留当次依据。</p>}
            {current.stale && (
              <p className="notice warning">
                来源版本已更新，此份材料已过期，请重新生成并核对。
              </p>
            )}
            {brief ? (
              <>
                {(
                  [
                    ["nextSteps", "推进参考"],
                    ["risks", "风险提示"],
                    ["salaryConversation", "薪资沟通参考"],
                  ] as const
                ).map(([key, title]) => (
                  <section key={key}>
                    <h3>{title}</h3>
                    {current.data[key]?.map((item: Row, i: number) => (
                      <div className="fact-line" key={i}>
                        <p>{item.text}</p>
                        <button
                          onClick={() =>
                            scope.current
                              .run(
                                () =>
                                  resolveBriefCitation(current,item.citation,path=>api(path),item.text),
                                setCitation,
                              )
                              .catch((e) => notify(e.message, true))
                          }
                        >
                          查看依据
                          {item.citation.kind === "rule_template"
                            ? "与规则模板"
                            : ""}
                        </button>
                      </div>
                    ))}
                    {!current.data[key]?.length && (
                      <p className="muted">
                        {current.data[key]
                          ? "当前规则未列出额外事项；仍需人工核对。"
                          : "历史材料未包含此区块，请重新生成。"}
                      </p>
                    )}
                  </section>
                ))}
                <h3>原文事实</h3>
                {current.data.facts.map((f: Row, i: number) => (
                  <div className="fact-line" key={i}>
                    <span>{factName(f.field)}</span>
                    <p>{f.text}</p>
                    <button
                      onClick={() =>
                        scope.current
                          .run(
                            () => resolveSavedFact(current,f,path=>api<Row>(path)),
                            (raw) => setRawCitation(raw),
                          )
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      原文第 {f.citation.line} 行
                    </button>
                  </div>
                ))}
                {current.data.humanAssertions?.length > 0 && (
                  <>
                    <h3>人工核对事实</h3>
                    {current.data.humanAssertions.map((f: Row, i: number) => (
                      <p className="human-fact" key={i}>
                        {factName(f.field)}：{JSON.stringify(f.value)} · 依据：
                        {f.reason} · {date(f.at)}
                      </p>
                    ))}
                  </>
                )}
                <h3>人工面试评估</h3>
                {current.data.evaluations.map((e: Row, i: number) => (
                  <div className="record-row" key={i}>
                    <span>
                      第 {e.round} 轮：{e.summary}
                      <small>
                        人工结论：
                        {conclusionNames[e.humanConclusion] || "未填写"}
                      </small>
                    </span>
                    <button
                      onClick={() =>
                        scope.current
                          .run(
                            () =>
                              resolveBriefCitation(current,e.citation,path=>api(path)),
                            setCitation,
                          )
                          .catch((e) => notify(e.message, true))
                      }
                    >
                      查看原评估 v{e.citation.version}
                    </button>
                  </div>
                ))}
                {!current.data.evaluations.length && (
                  <p className="muted">尚无已提交人工评估</p>
                )}
                <h3>待核实事项</h3>
                {current.data.questions.map((q: Row, i: number) => (
                  <p key={i}>
                    {q.skill} ·{" "}
                    {q.reason === "not_matched"
                      ? "原文未命中"
                      : "需要进一步核实"}
                  </p>
                ))}
                <p className="notice">{current.data.statement}</p>
                <h3>负责人最终结论</h3>
                <p className="human-fact">
                  {current.human_conclusion?.text || "尚未填写人工结论"}
                </p>
                {current.human_conclusion?.at && (
                  <small>{date(current.human_conclusion.at)}</small>
                )}
                {canWrite && (
                  <Form
                    submit="保存人工结论"
                    onSubmit={async (form) => {
                      const next = await api<Row>(
                        "/briefs/" + current.id + "/conclusion",
                        {
                          method: "POST",
                          body: {
                            version: current.version,
                            conclusion: values(form).conclusion,
                          },
                        },
                      );
                      setCurrent(next);
                      notify("人工结论已保存，不会自动改变申请状态");
                    }}
                  >
                    <Field label="负责人最终结论" required>
                      <textarea
                        key={current.id + ":" + current.version}
                        name="conclusion"
                        required
                        rows={4}
                        defaultValue={current.human_conclusion?.text || ""}
                      />
                    </Field>
                  </Form>
                )}
              </>
            ) : (
              <>
                {current.data.missingSkills?.length > 0 && (
                  <p className="notice warning">
                    专业题库尚未覆盖：{current.data.missingSkills.join("、")}
                    。下列通用补充题已明确标注，请补充人工专业题。
                  </p>
                )}
                {current.data.questions.map((q: Row, i: number) => (
                  <article className="question" key={q.id}>
                    {(i === 0 ||
                      current.data.questions[i - 1].group !== q.group) && (
                      <h2 className="question-group">
                        {q.group || "人工补充"}
                      </h2>
                    )}
                    <header>
                      <strong>
                        {i + 1}. {q.skill}
                      </strong>
                      <span className="status">
                        {q.source.kind === "rule_catalog"
                          ? "专业规则题"
                          : q.source.kind === "question_template"
                            ? "已发布题库"
                          : q.source.kind === "human"
                            ? "人工题"
                            : "通用补充题"}
                      </span>
                    </header>
                    <h3>{q.prompt}</h3>
                    <div className="toolbar">
                      <button
                        aria-expanded={shown.includes(q.id)}
                        onClick={() =>
                          setShown((v) =>
                            togglePoints(
                              v,
                              current.data.questions.map((x: Row) => x.id),
                              q.id,
                            ),
                          )
                        }
                      >
                        要点 {shown.includes(q.id) ? "▴" : "▾"}
                      </button>
                      <CopyButton text={questionsText([q] as any)} label="复制单题" />
                    </div>
                    <div className="question-grid">
                      <div>
                        <small>追问建议</small>
                        <ul>
                          {q.followups.map((x: string, i: number) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </div>
                      {shown.includes(q.id) && (
                        <div>
                          <small>参考要点（达标线）</small>
                          <ul>
                            {q.referencePoints.map((x: string, i: number) => (
                              <li key={i}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <small>
                      来源{" "}
                      {q.source.kind === "human"
                        ? "人工补充"
                        : q.source.sourceText || (q.source.kind==="question_template"?"已发布题库版本 "+q.source.version:"已保存的规则来源")}{" "}
                      · 依据{" "}
                      {{
                        matched: "原文命中",
                        not_matched: "原文未命中",
                        unknown: "待人工核实",
                      }[q.basis as string] || "待核实"}{" "}
                      · {q.evidence.length} 段原文证据
                    </small>
                  </article>
                ))}
                {!current.data.questions.length && (
                  <Empty>此题单已清空，可继续添加人工问题</Empty>
                )}
              </>
            )}
          </Panel>
        </>
      )}
      {edit && current && (
        <QuestionEditor
          material={current}
          onClose={() => setEdit(false)}
          onDone={(m) => {
            setEdit(false);
            setCurrent(m);
            refresh();
          }}
        />
      )}
      {history && (
        <Dialog title="材料历史版本" onClose={() => setHistory(null)} wide>
          {history.map((h) => (
            <Panel key={h.version} title={`v${h.version} · ${date(h.at)}`}>
              <SavedMaterialVersion snapshot={h.data} brief={brief}/>
            </Panel>
          ))}
        </Dialog>
      )}
      {rawCitation && (
        <Dialog
          title={`原文引用 · 第 ${rawCitation.citation.line} 行${rawCitation.limited?" · 仅显示获授权的原句片段":""}`}
          onClose={() => setRawCitation(null)}
          wide
        >
          <pre className="raw-text">
            {rawCitation.raw.slice(0, rawCitation.citation.start)}
            <mark>
              {rawCitation.raw.slice(
                rawCitation.citation.start,
                rawCitation.citation.end,
              )}
            </mark>
            {rawCitation.raw.slice(rawCitation.citation.end)}
          </pre>
        </Dialog>
      )}
      {citation && (
        <Dialog
          title={citation.title}
          onClose={() => setCitation(null)}
        >
          <pre className="raw-text">{citation.text}</pre>
        </Dialog>
      )}
    </>
  );
}
function QuestionEditor({
  material,
  onClose,
  onDone,
}: {
  material: Row;
  onClose: () => void;
  onDone: (m: Row) => void;
}) {
  const [questions, setQuestions] = useState<Row[]>(
    material.data.questions.map((q: Row) => ({ ...q })),
  );
  return (
    <Dialog title="人工编辑题单" onClose={onClose} wide>
      <Form
        onCancel={onClose}
        onSubmit={async () =>
          onDone(
            await api("/questions/" + material.id, {
              method: "PATCH",
              body: { version: material.version, questions:questions.map(q=>({...q,referencePoints:q.referencePoints.map((s:string)=>s.trim()).filter(Boolean),followups:q.followups.map((s:string)=>s.trim()).filter(Boolean)})) },
            }),
          )
        }
      >
        <p className="notice">
          可以修订题目、追问与参考要点。生成题的来源和原文证据保留；新增题单独标注人工作者。
        </p>
        {questions.map((q, i) => (
          <fieldset key={q.id}>
            <legend>
              {i + 1}. {q.skill}
            </legend>
            <Field label="题干">
              <textarea
                value={q.prompt}
                required
                onChange={(e) =>
                  setQuestions((a) =>
                    a.map((x, k) =>
                      k === i ? { ...x, prompt: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <div className="form-grid">
              <Field label="追问（每行一条）">
                <textarea
                  value={q.followups.join("\n")}
                  onChange={(e) =>
                    setQuestions((a) =>
                      a.map((x, k) =>
                        k === i
                          ? {
                              ...x,
                              followups: e.target.value
                                .split("\n"),
                            }
                          : x,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="参考要点（每行一条）">
                <textarea
                  value={q.referencePoints.join("\n")}
                  onChange={(e) =>
                    setQuestions((a) =>
                      a.map((x, k) =>
                        k === i
                          ? {
                              ...x,
                              referencePoints: e.target.value
                                .split("\n"),
                            }
                          : x,
                      ),
                    )
                  }
                />
              </Field>
            </div>
            <button
              type="button"
              className="danger"
              onClick={() => setQuestions((a) => a.filter((_, k) => k !== i))}
            >
              移除此题
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            setQuestions((a) => [
              ...a,
              {
                id: "human:" + crypto.randomUUID(),
                skill: "人工补充",
                prompt: "",
                followups: [],
                referencePoints: [],
                source: { kind: "human" },
                basis: "unknown",
                evidence: [],
              },
            ])
          }
        >
          添加人工问题
        </button>
      </Form>
    </Dialog>
  );
}

function SavedMaterialVersion({snapshot,brief}:{snapshot:Row;brief:boolean}){const data=snapshot.data||snapshot;return brief?<><p className="notice">保存时的依据汇总与人工结论，当前权限校验后只读展示。</p>{[['nextSteps','推进参考'],['risks','风险提示'],['salaryConversation','薪资沟通参考']].map(([key,label])=><section key={key}><h3>{label}</h3>{data[key]?.map((r:Row,n:number)=><p key={n}>{r.text}</p>)}</section>)}<h3>保存的原文事实</h3>{data.facts?.map((f:Row,n:number)=><p key={n}>{factName(f.field)}：{f.text} · 原文第 {f.citation?.line||'未记录'} 行</p>)}<h3>保存的人工评估</h3>{data.evaluations?.map((e:Row,n:number)=><p key={n}>第 {e.round} 轮 · {e.summary} · 人工结论 {conclusionNames[e.humanConclusion]||'未填写'} · 评估版本 {e.citation?.version||'未记录'}</p>)}<h3>人工结论</h3><p>{snapshot.humanConclusion?.text||'未填写'}</p></>:<>{data.questions?.map((q:Row,n:number)=><article className="question" key={q.id}><strong>{n+1}. {q.group} · {q.skill}</strong><h3>{q.prompt}</h3><details><summary>保存的参考要点与追问</summary><ul>{q.referencePoints.map((p:string,i:number)=><li key={'p'+i}>{p}</li>)}{q.followups.map((p:string,i:number)=><li key={'f'+i}>追问：{p}</li>)}</ul></details><small>{q.source?.sourceText||'保存的人工或规则来源'} · 题库版本 {q.source?.version||'历史未记录'}</small></article>)}</>;}
