import {archiveSummary} from '../lib/field-views';
import { useState } from "react";
import { api, query, download } from "../lib/api";
import { useApp, useResource, Resource, type Row, date } from "../lib/state";
import { Dialog, Form, Field, Pagination, Empty } from "../components/ui";
import MemberPicker from "../components/MemberPicker";
const kinds = [
  ["recruit-v4-copy", "当前 SQL 备份"],
  ["recruit_workbench_v1", "旧招聘工作台 recruit_workbench_v1"],
  ["talent_sourcing_v1", "旧人才搜集 talent_sourcing_v1"],
  ["talent_campus_v1", "旧校招渠道 talent_campus_v1"],
];
const sections = [
  ["candidates", "候选人"],
  ["jobs", "岗位"],
  ["interviews", "面试"],
  ["leads", "搜集线索"],
  ["campuses", "校招渠道"],
];
const notice: Record<string, string> = {
  resume_attachments_omitted: "此为轻量备份：仅恢复业务数据、简历元数据与解析文本，不包含也不会重建简历附件。",
  original_binary_unavailable: "旧备份仅含文本，无法恢复原始简历二进制文件。",
  credentials_encrypted_without_plaintext_archive:
    "校招账号与密码直接加密保存，不保留明文原始归档。",
  legacy_owner_preserved_in_archive_import_admin_assigned:
    "旧负责人原文保留在归档中；副本记录负责人为本次导入管理员。",
  legacy_contact_time_unknown:
    "旧数据没有实际联系时间，副本保留未知，不填入导入时间。",
  interviewer_identity_mapping_required:
    "请将旧面试官名称明确映射到企业成员，再重新校验。",
  interview_round_date_status_mapping_required:
    "旧面试轮次、日期、时间或状态不完整，请修正文件后重新校验。",
  legacy_interview_duration_60_minutes_requires_confirmation:
    "旧面试未注明时长；确认导入即同意副本按 60 分钟安排，原始数据仍保留。",
  legacy_interview_local_time_Asia_Shanghai:
    "旧面试本地时间按 Asia/Shanghai（UTC+8）解释。",
  backup_integrity_or_credential_key:
    "备份完整性校验未通过，或本机缺少相应校招解密密钥。",
  backup_column_mismatch: "SQL 字段版本与当前版本不一致，请使用受控迁移工具。",
};
export default function Backups({
  mode,
  onClose,
}: {
  mode: "export" | "import";
  onClose: () => void;
}) {
  const { notify } = useApp(),
    [kind, setKind] = useState("recruit-v4-copy"),
    [text, setText] = useState(""),
    [fileName, setFileName] = useState(""),
    [archiveInfo,setArchiveInfo]=useState<string|null>(null),
    [fileError, setFileError] = useState(""),
    [report, setReport] = useState<Row | null>(null),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [selected, setSelected] = useState(""),
    [section, setSection] = useState("candidates"),
    [page, setPage] = useState(1),
    [lite, setLite] = useState(false),
    [revision, setRevision] = useState(0);
  const copies = useResource<Row[]>(
      (s) => api("/admin/backups", { signal: s }),
      [revision],
    ),
    details = useResource<Row | null>(
      (s) =>
        selected
          ? query("/admin/backups/query", { id: selected, section, page }, s)
          : Promise.resolve(null),
      [selected, section, page, revision],
    );
  const reset = () => setReport(null);
  return (
    <Dialog
      title={mode === "export" ? "导出备份" : "导入备份与副本"}
      onClose={onClose}
      wide
    >
      <p className="notice">
        备份包含招聘业务数据，请保存到受控位置。校招凭据以密文导出，解密密钥由本机单独保管；登录会话、OAuth
        临时状态及服务密钥不进入下载文件。
      </p>
      {mode === "export" ? (
        <Form
          submit="下载当前数据备份"
          onCancel={onClose}
          onSubmit={async () => {
            download(
              await api("/admin/backups/export", {
                method: "POST",
                body: { includeFiles: !lite },
                raw: true,
              }),
              "招聘工作台-SQL备份-" +
                new Date().toISOString().slice(0, 10) +
                (lite ? "-轻量" : "") +
                ".json",
            );
            notify(lite ? "轻量备份已下载，仅含业务表" : "备份文件已下载");
          }}
        >
          <label className="check">
            <input type="checkbox" checked={lite} onChange={(e) => setLite(e.target.checked)} />
            省略简历附件，生成轻量备份
          </label>
          <p className="muted">
            完整备份含原始简历文件；轻量备份保留业务数据、简历元数据与解析文本，不含也不会重建简历附件。
            两种格式网页导出、导入均以 64MiB 为上限；超过上限的完整备份请联系管理员使用本机备份/恢复工具。
            <span className="hint" title="两种格式均可导入独立副本。轻量副本没有原始简历附件；完整备份严格校验每个附件的数量、大小与哈希。">两种备份的区别</span>
          </p>
          <p>
            导出当前 SQL
            数据、原始文件、岗位、流程、面试评估及历史版本。独立导入副本请从“导入备份”中的列表单独下载保存。
          </p>
        </Form>
      ) : (
        <>
          <Form
            submit="校验并预览"
            onSubmit={async () => {
              if (!text) throw Error("请先选择 JSON 备份文件");
              setReport(
                await query("/admin/backups/preview", { kind, text, mapping }),
              );
            }}
          >
            <div className="form-grid">
              <Field label="来源格式">
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    reset();
                  }}
                >
                  {kinds.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="JSON 备份文件">
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={async (e) => {
                    reset();
                    setFileError("");
                    setText("");setArchiveInfo(null);
                    const f = e.target.files?.[0];
                    setFileName(f?.name || "");
                    if (!f) return;
                    if (f.size > 64 * 1024 * 1024) {
                      setFileError(
                        "网页导入最多 64MiB；更大备份请联系管理员使用本机备份/恢复工具。",
                      );
                      return;
                    }
                    try {
                      const content=await f.text();setText(content);try{setArchiveInfo(archiveSummary(JSON.parse(content)));}catch{setArchiveInfo(null);}
                    } catch {
                      setFileError("文件读取失败，请重新选择。");
                    }
                  }}
                />
              </Field>
            </div>
            {archiveInfo&&<p className="notice">{archiveInfo}；完整性仍以服务端预览校验为准。</p>}
            {fileError && (
              <p role="alert" className="notice error">
                {fileError}
              </p>
            )}
            <Field label="或粘贴 JSON 备份">
              <textarea
                rows={3}
                value={text}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setText(e.target.value);try{setArchiveInfo(archiveSummary(JSON.parse(e.target.value)));}catch{setArchiveInfo(null);}
                  setFileName("粘贴的 JSON");
                  setFileError("");
                  reset();
                }}
                placeholder="从旧版导出的 JSON 内容；只在当前弹窗内存中处理"
              />
            </Field>
            <p className="muted">
              支持原始 LocalStorage 对象、数组及同名键包裹的
              JSON。选中文件只在页面内存中读取，关闭页面后清除。
            </p>
            {report?.mappings?.map((name: string) => (
              <div key={name}>
                <p>旧面试官：{name}</p>
                <MemberPicker
                  role="interviewer"
                  multiple={false}
                  value={mapping[name] ? [mapping[name]] : []}
                  onChange={(ids) => {
                    setMapping({ ...mapping, [name]: ids[0] });
                    setReport({ ...report, ready: false, token: "" });
                  }}
                />
              </div>
            ))}
          </Form>
          {report && (
            <section className="panel">
              <h3>
                {report.ready ? "校验通过" : "存在待处理冲突"} · {fileName}
              </h3>
              <p>
                {Object.entries(report.counts)
                  .map(
                    ([k, v]) =>
                      (sections.find((x) => x[0] === k)?.[1] || k) + " " + v,
                  )
                  .join(" · ")}
              </p>
              {[...report.conflicts, ...report.warnings].map((v: string) => (
                <p
                  key={v}
                  className={
                    report.conflicts.includes(v) ? "notice error" : "notice"
                  }
                >
                  {notice[v] || v}
                </p>
              ))}
              {report.ready && (
                <Form
                  submit="确认导入独立副本"
                  onSubmit={async (form) => {
                    if (!new FormData(form).has("confirm"))
                      throw Error("请先确认副本导入范围");
                    const r = await query("/admin/backups/apply", {
                      kind,
                      text,
                      mapping,
                      token: report.token,
                      confirm: true,
                    });
                    setText("");
                    setReport(null);
                    setSelected(r.id);
                    setSection(
                      Object.keys(r.counts).find(
                        (k) =>
                          r.counts[k] &&
                          ["candidates", "leads", "campuses"].includes(k),
                      ) || "candidates",
                    );
                    setPage(1);
                    setRevision((v) => v + 1);
                    notify("已导入独立 SQL 副本，可在下方检查");
                  }}
                >
                  <label className="check">
                    <input type="checkbox" name="confirm" required />
                    我已核对数量、冲突及时间/身份映射提示，同意创建独立副本。
                  </label>
                  <p>
                    本次导入不会覆盖当前业务库。确认后可检查副本并重新下载；切换线上入口须先完成迁移核验。
                  </p>
                </Form>
              )}
            </section>
          )}
          <h3>已保存的导入副本</h3>
          <Resource {...copies} preserve={copies.data!==undefined} retry={copies.reload}>
            {!copies.data?.length ? (
              <Empty>尚无导入副本</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>来源</th>
                      <th>副本</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {copies.data?.map((r) => (
                      <tr key={r.id}>
                        <td>{date(r.createdAt)}</td>
                        <td>
                          {kinds.find((x) => x[0] === r.sourceKind)?.[1] ||
                            r.sourceKind}
                          {(r.fileMode === 'omitted' || r.warnings?.includes('resume_attachments_omitted')) && <small>轻量副本 · 不含简历附件</small>}
                        </td>
                        <td>{r.id.slice(0, 12)}</td>
                        <td>
                          <button
                            onClick={() => {
                              setSelected(r.id);
                              setPage(1);
                            }}
                          >
                            检查副本
                          </button>
                          <button
                            onClick={async () => {
                              try {
                                download(
                                  await api("/admin/backups/export", {
                                    method: "POST",
                                    body: { copyId: r.id },
                                    raw: true,
                                  }),
                                  "招聘工作台-导入副本-" + r.id + ".json",
                                );
                              } catch (e) {
                                notify((e as Error).message, true);
                              }
                            }}
                          >
                            {r.fileMode === 'omitted' || r.warnings?.includes('resume_attachments_omitted') ? '下载轻量副本' : '下载副本'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Resource>
          {selected && (
            <section className="panel">
              <h3>副本检查 · {selected.slice(0, 12)}</h3>
              <div className="segments">
                {sections.map(([v, label]) => (
                  <button
                    key={v}
                    className={section === v ? "active" : ""}
                    onClick={() => {
                      setSection(v);
                      setPage(1);
                    }}
                  >
                    {label} {details.data?.counts[v] ?? ""}
                  </button>
                ))}
              </div>
              <p className="muted">
                凭据保持遮罩；副本账号、角色和会话不会用于主服务登录。
              </p>
              <Resource {...details} preserve={details.data!==undefined} retry={details.reload}>
                {details.data && (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {Object.keys(details.data.items[0] || {}).map(
                              (k) => (
                                <th key={k}>
                                  {(
                                    {
                                      name: "姓名/岗位",
                                      school: "院校",
                                      org: "机构",
                                      direction: "方向",
                                      state: "状态",
                                      source: "来源",
                                      created_at: "创建时间",
                                      hasAccount: "账号",
                                      hasPassword: "密码",
                                      last_post: "最近发布",
                                      status: "状态",
                                      city: "城市",
                                      region: "地区",
                                      tier: "层级",
                                      url: "网址",
                                      round: "轮次",
                                      starts_at: "时间",
                                    } as Row
                                  )[k] || k}
                                </th>
                              ),
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {details.data.items.map((r: Row) => (
                            <tr key={r.id}>
                              {Object.entries(r).map(([k, v]) => (
                                <td key={k}>
                                  {k === "hasAccount" || k === "hasPassword"
                                    ? v
                                      ? "••••••"
                                      : "未设置"
                                    : typeof v === "boolean"
                                      ? v
                                        ? "是"
                                        : "否"
                                      : String(v ?? "—")}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pagination
                      page={page}
                      total={details.data.total}
                      onChange={setPage}
                    />
                  </>
                )}
              </Resource>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
