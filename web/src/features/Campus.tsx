import FieldViewSwitch from '../components/business/FieldViewSwitch';
import ConfiguredForm from "../components/business/ConfiguredForm";
import { useEffect, useRef, useState } from "react";
import { Eye, EyeSlash, Plus, DownloadSimple } from "@phosphor-icons/react";
import { api, query, download } from "../lib/api";
import {
  useApp,
  useResource,
  useDebounced,
  Resource,
  pct,
  type Row,
} from "../lib/state";
import {
  Panel,
  Dialog,
  Form,
  Field,
  values,
  Empty,
  Pagination,
} from "../components/ui";
import MemberPicker from "../components/MemberPicker";
import {
  campusRegions,
  campusTiers,
  campusStatuses,
  credentialChange,
  campusExportBody,
  unexpiredCredentials,
} from "../lib/campus";
function CampusNative({ active }: { active: boolean }) {
  const { revision, refresh, notify, isAdmin, canWrite } = useApp();
  const [text, setText] = useState(""),
    [region, setRegion] = useState(""),
    [tier, setTier] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [deleted, setDeleted] = useState(false),
    [edit, setEdit] = useState<Row | null>(null),
    [remove, setRemove] = useState<Row | null>(null),
    [exporting, setExporting] = useState(false),
    [granting, setGranting] = useState(false),
    [revealed, setRevealed] = useState<Record<string, Row>>({});
  const generation = useRef(0),
    search = useDebounced(text);
  const permissions = useResource<Row | null>(
    (s) =>
      canWrite
        ? api("/campus/permissions", { signal: s })
        : Promise.resolve(null),
    [revision, canWrite],
  );
  const p = permissions.data,
    request = {
      query: search,
      region: region || undefined,
      tier: tier || undefined,
      status: status || undefined,
      accountSearch: !!p?.read,
      page,
      pageSize: 25,
      deleted,
    };
  const result = useResource<Row | null>(
    (s) =>
      canWrite && p
        ? query("/campus/query", request, s)
        : Promise.resolve(null),
    [JSON.stringify(request), revision, !!p, canWrite],
  );
  function remask() {
    generation.current++;
    setRevealed({});
  }
  useEffect(() => {
    remask();
    if (!active) {
      setEdit(null);
      setRemove(null);
      setExporting(false);
      setGranting(false);
    }
    return () => {
      generation.current++;
    };
  }, [active, search, region, tier, status, page, revision, deleted]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) remask();
    };
    window.addEventListener("blur", remask);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", remask);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (!Object.keys(revealed).length) return;
    const next = Math.min(
      ...Object.values(revealed).map((value) => value.expiresAt),
    );
    const timer = setTimeout(
      () =>
        setRevealed((old) =>
          unexpiredCredentials(
            old as Record<string, Row & { expiresAt: number }>,
            Date.now(),
          ),
        ),
      Math.max(0, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [revealed]);
  async function reveal(row: Row) {
    if (revealed[row.id]) {
      setRevealed((old) => {
        const next = { ...old };
        delete next[row.id];
        return next;
      });
      return;
    }
    const token = generation.current;
    try {
      const secret = await api<Row>("/campus/" + row.id + "/reveal", {
        method: "POST",
        body: { version: row.version },
      });
      if (token === generation.current && active)
        setRevealed((old) => ({
          ...old,
          [row.id]: { ...secret, expiresAt: Date.now() + 30000 },
        }));
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const k = result.data?.kpis;
  if (!canWrite)
    return <p className="notice">校招台账仅向已获招聘业务权限的成员开放。</p>;
  return (
    <>
      <p className="notice warning campus-warning">
        <strong>账号密码仅限招聘团队内部维护，请勿外发。</strong>
        <br />
        服务端加密保存，查看、修改和敏感导出分别授权。密码仅在当前页面短时显示，切页、离开窗口或刷新即收起。
      </p>
      <Resource
        {...permissions}
        loading={permissions.loading && !p}
        retry={permissions.reload}
      >
        <div className="campus-kpis">
          {[
            ["目标院校总数", k?.total ?? "—"],
            ["已注册", k?.registered ?? "—"],
            ["已发布招聘信息", k?.published ?? "—"],
            ["网址待补", k?.missingUrl ?? "—"],
            ["发布覆盖率", pct(k?.coverage)],
          ].map(([label, value]) => (
            <div className="kpi" key={label}>
              <strong>{value}</strong>
              <small>{label}</small>
            </div>
          ))}
        </div>
        <div className="campus-toolbar">
          <input
            aria-label="搜索校招院校、城市、账号或备注"
            placeholder={
              p?.read
                ? "搜院校 / 城市 / 账号 / 备注…"
                : "搜院校 / 城市 / 网址 / 备注…"
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="校招地区"
            value={region}
            onChange={(e) => {
              setRegion(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部地区</option>
            {campusRegions.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <select
            aria-label="校招状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(campusStatuses).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <select
            aria-label="院校层次"
            value={tier}
            onChange={(e) => {
              setTier(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部层次</option>
            {campusTiers.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => {
              remask();
              setEdit({});
            }}
          >
            <Plus size={16} />
            新增院校
          </button>
          <button
            onClick={() => {
              remask();
              setExporting(true);
            }}
          >
            <DownloadSimple size={16} />
            导出 CSV
          </button>
          {isAdmin && (
            <button
              onClick={() => {
                remask();
                setGranting(true);
              }}
            >
              凭证权限
            </button>
          )}
        </div>
        {isAdmin && (
          <label className="check">
            <input
              type="checkbox"
              checked={deleted}
              onChange={(e) => {
                setDeleted(e.target.checked);
                setPage(1);
              }}
            />
            已删除记录
          </label>
        )}
        <Panel>
          <Resource {...result} preserve={result.data!==undefined} retry={result.reload}>
            <div className="table-scroll">
              <table className="campus-table">
                <thead>
                  <tr>
                    <th>院校</th>
                    <th>城市 / 地区</th>
                    <th>层次</th>
                    <th>就业网</th>
                    <th>账号 / 密码</th>
                    <th>状态</th>
                    <th>最近发布</th>
                    <th>备注</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data?.items.map((row: Row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.school}</strong>
                      </td>
                      <td>
                        {row.city || "—"}
                        <small>{row.region || "—"}</small>
                      </td>
                      <td>{row.tier || "—"}</td>
                      <td>
                        {row.url ? (
                          <a href={row.url} target="_blank" rel="noreferrer">
                            打开就业网 ↗
                          </a>
                        ) : (
                          <span className="missing-url">未填</span>
                        )}
                      </td>
                      <td>
                        <div className="campus-credentials">
                          <code>
                            {revealed[row.id]
                              ? revealed[row.id].account || "—"
                              : row.hasAccount
                                ? "••••••"
                                : "—"}
                          </code>
                          <span> / </span>
                          <code>
                            {revealed[row.id]
                              ? revealed[row.id].password || "—"
                              : row.hasPassword
                                ? "••••••"
                                : "—"}
                          </code>
                          {p?.read &&
                            !deleted &&
                            (row.hasAccount || row.hasPassword) && (
                              <button
                                className="icon-button"
                                onClick={() => void reveal(row)}
                                aria-label={
                                  (revealed[row.id] ? "收起" : "查看") +
                                  row.school +
                                  "账号密码"
                                }
                              >
                                {revealed[row.id] ? (
                                  <EyeSlash size={17} />
                                ) : (
                                  <Eye size={17} />
                                )}
                              </button>
                            )}
                        </div>
                      </td>
                      <td>
                        <span className={"campus-state " + row.status}>
                          {campusStatuses[row.status]}
                        </span>
                      </td>
                      <td>{row.last_post || "—"}</td>
                      <td className="campus-note">{row.note || "—"}</td>
                      <td>
                        <div className="toolbar">
                          {deleted ? (
                            <button
                              onClick={() =>
                                setRemove({ ...row, restore: true })
                              }
                            >
                              恢复
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => {
                                  remask();
                                  setEdit(row);
                                }}
                              >
                                编辑
                              </button>
                              <button
                                className="text-button danger"
                                onClick={() => {
                                  remask();
                                  setRemove(row);
                                }}
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
              {!result.data?.items.length && (
                <Empty>暂无符合条件的院校，请调整筛选或新增院校</Empty>
              )}
            </div>
            <Pagination
              page={page}
              total={result.data?.total || 0}
              onChange={setPage}
            />
          </Resource>
        </Panel>
      </Resource>
      {edit && (
        <CampusEditor
          row={edit}
          credentialWrite={!!p?.write}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
            notify("院校台账已保存");
          }}
        />
      )}
      {remove && (
        <Dialog
          title={remove.restore ? "恢复院校" : "确认删除院校"}
          onClose={() => setRemove(null)}
        >
          <Form
            submit={remove.restore ? "确认恢复" : "确认删除"}
            onCancel={() => setRemove(null)}
            onSubmit={async () => {
              await api("/campus/" + remove.id + "/delete", {
                method: "POST",
                body: {
                  version: remove.version,
                  confirm: true,
                  restore: !!remove.restore,
                },
              });
              setRemove(null);
              refresh();
            }}
          >
            <p>
              确认{remove.restore ? "恢复" : "删除"}「{remove.school}」？
              {!remove.restore &&
                "删除后从当前台账与 KPI 移除，管理员可在已删除记录中恢复。"}
            </p>
          </Form>
        </Dialog>
      )}
      {exporting && (
        <CampusExport
          request={request}
          allowSecrets={!!p?.read && !!p?.export}
          total={result.data?.total || 0}
          onClose={() => setExporting(false)}
        />
      )}
      {granting && (
        <CredentialGrants
          onClose={() => setGranting(false)}
          onDone={() => {
            setGranting(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
function CampusEditor({
  row,
  credentialWrite,
  onClose,
  onDone,
}: {
  row: Row;
  credentialWrite: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [accountAction, setAccountAction] = useState(
      row.id ? "keep" : "replace",
    ),
    [passwordAction, setPasswordAction] = useState(row.id ? "keep" : "replace");
  return (
    <Dialog
      title={row.id ? "编辑院校 · " + row.school : "新增院校"}
      onClose={onClose}
    >
      <ConfiguredForm kind="campus" id={row.id} core={row} customFields={row.customFields} mode={row.id?"edit":"create"}
        onCancel={onClose}
        onSubmit={async (payload,form) => {
          const b = values(form),
            body = {
              ...payload,
              status:b.status,lastPost:b.lastPost,
              ...(credentialWrite
                ? {
                    credentials: {
                      account: credentialChange(accountAction, b.account || ""),
                      password: credentialChange(
                        passwordAction,
                        b.password || "",
                      ),
                    },
                  }
                : {}),
            };
          await api(row.id ? "/campus/" + row.id : "/campus", {
            method: row.id ? "PATCH" : "POST",
            body: row.id ? { ...body, version: row.version } : body,
          });
          onDone();
        }}
      >
        <div className="form-grid">
          {[
            [
              "account",
              "账号",
              accountAction,
              setAccountAction,
              row.hasAccount,
            ],
            [
              "password",
              "密码",
              passwordAction,
              setPasswordAction,
              row.hasPassword,
            ],
          ].map(([key, label, action, setAction, exists]: any) => (
            <Field
              key={key}
              label={label}
              hint={
                row.id ? (exists ? "已保存，默认保持原值" : "尚未保存") : ""
              }
            >
              {credentialWrite ? (
                <>
                  <select
                    aria-label={label + "修改方式"}
                    value={action}
                    onChange={(e) => setAction(e.target.value)}
                  >
                    {row.id && <option value="keep">保持原值</option>}
                    <option value="replace">
                      {row.id ? "替换为新值" : "设置"}
                    </option>
                    <option value="clear">清空</option>
                  </select>
                  {action === "replace" && (
                    <input
                      name={key}
                      aria-label={label + "新值"}
                      type={key === "password" ? "password" : "text"}
                      autoComplete="off"
                      maxLength={2000}
                      placeholder={"输入" + label + "新值"}
                    />
                  )}
                </>
              ) : (
                <span className="muted">未获凭证修改权限</span>
              )}
            </Field>
          ))}
        </div>
        <div className="form-grid">
          <Field label="注册 / 发布状态" required>
            <select name="status" defaultValue={row.status || "unregistered"}>
              {Object.entries(campusStatuses).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="最近发布">
            <input
              name="lastPost"
              type="date"
              defaultValue={row.last_post || ""}
            />
          </Field>
        </div>
        <p className="muted">
          注册状态、发布状态和日期均由人工维护。保存网址不会自动改变状态。
        </p>
      </ConfiguredForm>
    </Dialog>
  );
}
function CampusExport({
  request,
  allowSecrets,
  total,
  onClose,
}: {
  request: Row;
  allowSecrets: boolean;
  total: number;
  onClose: () => void;
}) {
  const [include, setInclude] = useState(false);
  return (
    <Dialog title="导出校招台账" onClose={onClose}>
      <Form
        submit="下载 CSV"
        onCancel={onClose}
        onSubmit={async (form) => {
          const b = values(form),
            body = campusExportBody(request, include, b.confirmed === "on"),
            blob = await api<Blob>("/campus/export", {
              method: "POST",
              body,
              raw: true,
            });
          download(
            blob,
            "校招渠道-" + new Date().toISOString().slice(0, 10) + ".csv",
          );
          onClose();
        }}
      >
        <p>导出当前全部筛选结果，共 {total} 条，不受分页限制。</p>
        {allowSecrets && (
          <label className="check">
            <input
              type="checkbox"
              checked={include}
              onChange={(e) => setInclude(e.target.checked)}
            />
            包含账号密码
          </label>
        )}
        {include ? (
          <p className="notice warning" role="alert">
            <strong>文件含账号密码，注意存放</strong>
            <label className="check">
              <input name="confirmed" type="checkbox" required />
              我已确认文件的接收方与存放位置
            </label>
          </p>
        ) : (
          <p className="muted">
            默认导出院校、网址与发布信息，不包含账号密码。
          </p>
        )}
      </Form>
    </Dialog>
  );
}
function CredentialGrants({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [ids, setIds] = useState<string[]>([]),
    grants = useResource<Row[]>(
      (s) => api("/campus/grants", { signal: s }),
      [],
    );
  return (
    <Dialog title="校招凭证权限" onClose={onClose} wide>
      <Form
        onCancel={onClose}
        onSubmit={async (form) => {
          if (ids.length !== 1) throw Error("请选择一位招聘成员");
          const b = values(form);
          await api("/campus/grants", {
            method: "PUT",
            body: {
              userId: ids[0],
              read: b.read === "on",
              write: b.write === "on",
              export: b.export === "on",
            },
          });
          onDone();
        }}
      >
        <p className="notice">
          管理员默认拥有凭证权限；其他招聘成员按人分别授权。全部取消后保存即可撤销。
        </p>
        <MemberPicker
          role="owner"
          value={ids}
          onChange={setIds}
          multiple={false}
        />
        {[
          ["read", "查看账号密码与账号检索"],
          ["write", "设置、替换、清空账号密码"],
          ["export", "允许敏感导出（还需查看权限）"],
        ].map(([key, label]) => (
          <label className="check" key={key}>
            <input
              name={key}
              type="checkbox"
              key={key + ids.join(",")}
              defaultChecked={
                !!grants.data?.find((r) => r.user_id === ids[0])?.["can_" + key]
              }
            />
            {label}
          </label>
        ))}
        <Resource {...grants} preserve={grants.data!==undefined} retry={grants.reload}>
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>查看</th>
                <th>修改</th>
                <th>敏感导出</th>
              </tr>
            </thead>
            <tbody>
              {grants.data?.map((r) => (
                <tr key={r.user_id}>
                  <td>{r.name}</td>
                  <td>{r.can_read ? "是" : "否"}</td>
                  <td>{r.can_write ? "是" : "否"}</td>
                  <td>{r.can_export ? "是" : "否"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Resource>
      </Form>
    </Dialog>
  );
}

export default function Campus(props:{active:boolean}){return <FieldViewSwitch kind="campus"><CampusNative {...props}/></FieldViewSwitch>;}
