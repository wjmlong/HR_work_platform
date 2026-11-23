import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  date,
  stages,
  type Row,
} from "../lib/state";
import { RequestScope } from "../lib/workflows";
import {
  Dialog,
  Panel,
  Field,
  Form,
  values,
  Status,
  Empty,
  Pagination,
} from "../components/ui";
const names: Record<string, string> = {
  name: "姓名",
  phone: "电话",
  email: "邮箱",
  school: "最高学历院校",
  bachelorSchool: "本科院校",
  education: "学历",
  experienceYears: "工作年限",
  firstEmployment: "初次就业",
  companies: "公司",
  location: "城市",
  intent: "求职意向",
  expectedSalary:'期望薪资',
  skills: "技能",
  summary: "摘要",
  age: "年龄（仅展示）",
  gender: "性别（仅展示）",
};
export default function CandidateTools({
  mode,
  jobs,
  onClose,
}: {
  mode: string;
  jobs: Row[];
  onClose: () => void;
}) {
  const { revision, refresh, notify, openPerson } = useApp(),
    [source, setSource] = useState(""),
    [target, setTarget] = useState(""),
    [keep, setKeep] = useState(""),
    [preview, setPreview] = useState<Row | null>(null),
    [report, setReport] = useState<Row | null>(null),
    [page, setPage] = useState(1);
  const scope = useRef(new RequestScope());
  useEffect(() => () => scope.current.change(), []);
  const scan = useResource<Row>(
    (s) =>
      mode === "scan"
        ? api("/candidates/tools/scan", { signal: s })
        : Promise.resolve({ groups: [], scanned: 0 }),
    [mode, revision],
  );
  const pair = useResource<Row[]>(
    (s) =>
      mode === "scan" && source && target
        ? Promise.all([
            api<Row>("/candidates/" + source, { signal: s }),
            api<Row>("/candidates/" + target, { signal: s }),
          ])
        : Promise.resolve([]),
    [source, target, revision],
  );
  const candidates: Row[] = Array.from(
    new Map<string, Row>(
      (scan.data?.groups || [])
        .flatMap((g: Row) => g.candidates)
        .map((p: Row) => [p.id, p] as [string, Row]),
    ).values(),
  );
  const current =
    pair.data
      ?.flatMap((p) => p.applications)
      .filter((a) => a.is_current && !a.deleted_at) || [];
  function select(kind: string, value: string) {
    scope.current.change();
    setPreview(null);
    setReport(null);
    setKeep("");
    if (kind === "source") setSource(value);
    else setTarget(value);
  }
  const reset = () => {
    scope.current.change();
    setPreview(null);
    setReport(null);
    setPage(1);
  };
  const job = (id: string) => jobs.find((j) => j.id === id)?.name || "历史岗位";
  return (
    <Dialog
      title={mode === "scan" ? "查重扫描与合并" : "全库重新解析"}
      onClose={onClose}
      wide
    >
      {mode === "scan" ? (
        <>
          <p className="notice warning">
            扫描只列出疑似重复，不会自动合并。合并无法通过业务界面撤销，请先备份。所有原件、各岗位申请、评估与流转历史仍保留；你需明确选择保留的人员画像与当前流程。
          </p>
          <Resource {...scan} preserve={scan.data!==undefined} retry={scan.reload}>
            <p>
              已扫描 {scan.data?.scanned || 0} 人，发现{" "}
              {scan.data?.groups.length || 0} 组疑似重复。
            </p>
            {scan.data?.groups.map((g: Row, n: number) => (
              <Panel
                key={g.candidateIds.join(",")}
                title={`第 ${n + 1} 组 · ${{ high: "高", medium: "中", low: "低" }[g.confidence as string] || "待核对"}置信度`}
              >
                <div className="duplicate-members">
                  {g.candidates.map((p: Row) => (
                    <div key={p.id}>
                      <strong>{p.profile.name}</strong>
                      <small>
                        {p.profile.school || "院校未注明"} ·{" "}
                        {p.profile.phone || p.profile.email || "联系方式未注明"}
                      </small>
                    </div>
                  ))}
                </div>
              </Panel>
            ))}
            {!scan.data?.groups.length && <Empty>未发现疑似重复</Empty>}
          </Resource>
          {candidates.length > 1 && (
            <Form
              submit={preview ? "确认合并" : "生成合并预览"}
              onCancel={onClose}
              onSubmit={async (form) => {
                if (!source || !target || source === target)
                  throw Error("请选择两个不同人员");
                const input = {
                  sourceId: source,
                  targetId: target,
                  keepApplicationId: keep || undefined,
                };
                if (!preview) {
                  await scope.current.run(
                    () =>
                      api<Row>("/candidates/tools/merge-preview", {
                        method: "POST",
                        body: input,
                      }),
                    setPreview,
                  );
                  return;
                }
                const b = values(form),
                  result = await api<Row>("/candidates/tools/merge", {
                    method: "POST",
                    key: "merge:" + preview.hash,
                    body: {
                      ...input,
                      previewHash: preview.hash,
                      confirm: b.confirm === "on",
                      backupAcknowledged: b.backup === "on",
                    },
                  });
                refresh();
                notify("已合并，原件与历史仍保留");
                onClose();
                openPerson(result.candidateId);
              }}
            >
              <div className="form-grid">
                <Field label="并入的来源人员" required>
                  <select
                    value={source}
                    onChange={(e) => select("source", e.target.value)}
                    required
                  >
                    <option value="">请选择来源人员</option>
                    {candidates
                      .filter((p) => p.id !== target)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.profile.name} · {p.profile.school || "院校未知"} ·{" "}
                          {p.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="保留画像的目标人员" required>
                  <select
                    value={target}
                    onChange={(e) => select("target", e.target.value)}
                    required
                  >
                    <option value="">请选择目标人员</option>
                    {candidates
                      .filter((p) => p.id !== source)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.profile.name} · {p.profile.school || "院校未知"} ·{" "}
                          {p.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              {source && target && (
                <Resource {...pair} preserve={pair.data!==undefined} retry={pair.reload}>
                  <Field label="保留为当前的流程" required={current.length > 0}>
                    <select
                      required={current.length > 0}
                      value={keep}
                      onChange={(e) => {
                        scope.current.change();
                        setKeep(e.target.value);
                        setPreview(null);
                      }}
                    >
                      <option value="">
                        {current.length
                          ? "请选择保留的当前流程"
                          : "没有当前流程，全部历史保留"}
                      </option>
                      {current.map((a) => (
                        <option key={a.id} value={a.id}>
                          {job(a.job_id)} ·{" "}
                          {stages.find(([key]) => key === a.status)?.[1] ||
                            a.status}{" "}
                          · {a.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </Resource>
              )}
              {preview && (
                <>
                  <Panel title="合并预览">
                    <p>
                      保留画像：{preview.target.profile.name}（
                      {preview.target.id.slice(0, 8)}）；来源：
                      {preview.source.profile.name}（
                      {preview.source.id.slice(0, 8)}）。
                    </p>
                    <p>
                      保留 {preview.resumes.length} 个简历版本、
                      {preview.applications.length} 条申请历史。
                    </p>
                    {preview.applications.map((a: Row) => (
                      <div className="record-row" key={a.id}>
                        <span>{job(a.job_id)}</span>
                        <Status value={a.status} />
                        <strong>
                          {a.id === keep ? "保留为当前" : "归入历史"}
                        </strong>
                      </div>
                    ))}
                  </Panel>
                  <label className="check">
                    <input name="backup" type="checkbox" required />
                    我已完成备份，理解业务界面不能撤销合并
                  </label>
                  <label className="check">
                    <input name="confirm" type="checkbox" required />
                    已对照资料，确认两条记录属于同一人并保留所选流程
                  </label>
                </>
              )}
            </Form>
          )}
        </>
      ) : (
        <>
          <p className="notice">
            按最新解析规则重读原文，并保留人工更正依据。先核对差异，再批量采用。岗位、环节、来源、备注、抄送、淘汰和终止历史保留；并发变化的记录会跳过。
          </p>
          {report ? (
            <Panel title="重新解析结果">
              <p>
                已更新 {report.updated} 人；跳过 {report.skipped.length} 人。
              </p>
              {report.skipped.map((row: Row) => (
                <p key={row.candidateId}>
                  {preview?.items.find(
                    (p: Row) => p.candidateId === row.candidateId,
                  )?.name || row.candidateId.slice(0, 8)}
                  ：
                  {row.reason === "version_conflict"
                    ? "已被其他人修改，请重新预览核对"
                    : "没有可用简历原文"}
                </p>
              ))}
              <button onClick={reset}>重新生成预览</button>
              <button onClick={onClose}>完成</button>
            </Panel>
          ) : (
            <Form
              submit={preview ? "确认采用新解析版本" : "生成差异预览"}
              onCancel={onClose}
              onSubmit={async (form) => {
                if (!preview) {
                  await scope.current.run(
                    () =>
                      api<Row>("/candidates/tools/reparse-preview", {
                        method: "POST",
                        body: {},
                      }),
                    (value) => {
                      setPreview(value);
                      setPage(1);
                    },
                  );
                  return;
                }
                const result = await api<Row>(
                  "/candidates/tools/reparse-apply",
                  {
                    method: "POST",
                    key: "reparse:" + preview.id,
                    body: {
                      previewId: preview.id,
                      hash: preview.hash,
                      confirm: values(form).confirm === "on",
                    },
                  },
                );
                setReport(result);
                refresh();
              }}
            >
              {preview && (
                <>
                  <p>
                    全库 {preview.total} 人，画像有差异 {preview.changed}{" "}
                    人。预览有效至 {date(preview.expiresAt)}。
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>人员</th>
                          <th>字段差异（原值 → 新解析）</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.items
                          .slice((page - 1) * 25, page * 25)
                          .map((item: Row) => (
                            <tr key={item.candidateId}>
                              <td>{item.name}</td>
                              <td>
                                {item.skip
                                  ? "没有可用简历原文，将跳过"
                                  : Object.keys(item.changes).length
                                    ? Object.entries(item.changes).map(
                                        ([key, change]: [string, any]) => (
                                          <div key={key}>
                                            <strong>
                                              {names[key] || key}：
                                            </strong>
                                            <span>
                                              {JSON.stringify(change.before)} →{" "}
                                              {JSON.stringify(change.after)}
                                            </span>
                                          </div>
                                        ),
                                      )
                                    : "画像未变；仍保存新的解析与依据版本"}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={page}
                    total={preview.items.length}
                    onChange={setPage}
                  />
                  <label className="check">
                    <input name="confirm" type="checkbox" required />
                    已核对预览，确认批量采用新解析版本；并发冲突记录保持原值
                  </label>
                  <button type="button" onClick={reset}>
                    放弃本次预览
                  </button>
                </>
              )}
            </Form>
          )}
        </>
      )}
    </Dialog>
  );
}
