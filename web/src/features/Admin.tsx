import InterviewAccessAdmin from './InterviewAccess';
import BusinessConfig from "./business-config/BusinessConfig";
import EvolutionAdmin from "./EvolutionAdmin";
import { useState } from "react";
import { api, query } from "../lib/api";
import {
  useApp,
  useResource,
  Resource,
  tokens,
  date,
  type Row,
} from "../lib/state";
import {
  PageHeader,
  Panel,
  Dialog,
  Form,
  Field,
  Empty,
  values,
} from "../components/ui";
const roleNames: Row = {
    admin: "管理员",
    manager: "负责人",
    recruiter: "招聘专员",
    interviewer: "面试官",
    viewer: "只读成员",
  },
  statusNames: Row = {
    pending: "待审批",
    active: "已启用",
    disabled: "已停用",
    rejected: "已拒绝",
  };
export default function Admin() {
  const { revision, refresh, isAdmin } = useApp(),
    [tab, setTab] = useState(isAdmin ? "members" : "dictionary"),
    [member, setMember] = useState<Row | null>(null),
    [skill, setSkill] = useState<Row | null>(null);
  const members = useResource<Row[]>(
      (s) => (isAdmin ? api("/members", { signal: s }) : Promise.resolve([])),
      [revision],
    ),
    dictionary = useResource<Row[]>(
      (s) => api("/dictionary", { signal: s }),
      [revision],
    ),
    status = useResource<Row | null>(
      (s) =>
        isAdmin ? api("/admin/status", { signal: s }) : Promise.resolve(null),
      [revision],
    ),
    audit = useResource<Row[]>(
      (s) =>
        isAdmin
          ? query("/admin/audit/query", { limit: 50 }, s)
          : Promise.resolve([]),
      [revision],
    );
  return (
    <>
      <PageHeader
        title="管理设置"
        description="管理成员、词典与审计记录"
      />
      <div className="segments tabs">
        {(isAdmin
          ? [
              ["members", "成员审批"],
              ["dictionary", "技能词典"],
              ["business", "业务配置"],
              ["evolution", "技能组自进化"],
              ["runtime", "运行与审计"],
            ]
          : [["dictionary", "技能词典"]]
        ).map(([v, t]) => (
          <button
            key={v}
            className={tab === v ? "active" : ""}
            onClick={() => setTab(v)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "business" && isAdmin && <BusinessConfig/>}
      {tab === "evolution" && isAdmin && <EvolutionAdmin/>}
      {tab === "members" && isAdmin && <InterviewAccessAdmin/>}
      {tab === "members" && (
        <Panel title="企业成员">
          <Resource {...members} preserve={members.data!==undefined} retry={members.reload}>
            <p className="notice">
              员工使用飞书首次登录后进入待审批。管理员按角色和业务范围授权，无本地注册或密码。
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>审批状态</th>
                    <th>角色</th>
                    <th>通讯录状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data?.map((m) => (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td>{statusNames[m.status]}</td>
                      <td>
                        {m.roles.map((r: string) => roleNames[r]).join(" / ") ||
                          "未分配"}
                      </td>
                      <td>{m.directory_active ? "在职校验有效" : "已失效"}</td>
                      <td>
                        <button onClick={() => setMember(m)}>
                          {m.status === "pending"
                            ? "审批并分配角色"
                            : "修改权限"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Resource>
        </Panel>
      )}
      {tab === "dictionary" && (
        <Panel
          title="专业技能与真实别名"
        >
          <p className="notice">
            依据当前 PRD 的业务分组规则归一技能，并保留原文依据。
            分组关系仅用于规则对照，不表示技术等同。词条与别名通过业务配置发布，既有岗位需要另行预览采用。
            {isAdmin&&<button onClick={()=>setTab("business")}>前往业务配置维护</button>}
          </p>
          <Resource {...dictionary} preserve={dictionary.data!==undefined} retry={dictionary.reload}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>标准名称</th>
                    <th>类别</th>
                    <th>真实别名</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {dictionary.data?.map((d) => (
                    <tr key={d.name}>
                      <td>{d.name}</td>
                      <td>{d.category}</td>
                      <td>{d.aliases.join(" / ")}</td>
                      <td>
                        <span className="muted">{d.active===false?"已停用":"版本化维护"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Resource>
        </Panel>
      )}
      {tab === "runtime" && (
        <>
          <Panel title="运行状态">
            <Resource {...status} preserve={status.data!==undefined} retry={status.reload}>
              {status.data && (
                <>
                  <dl className="facts">
                    <div>
                      <dt>服务版本</dt>
                      <dd>{status.data.version}</dd>
                    </div>
                    <div>
                      <dt>当前实例</dt>
                      <dd>{status.data.instance}</dd>
                    </div>
                    <div>
                      <dt>企业飞书</dt>
                      <dd>
                        {status.data.feishuConfigured ? "已配置" : "未配置"}
                      </dd>
                    </div>
                    <div>
                      <dt>自动搜集</dt>
                      <dd>未配置</dd>
                    </div>
                    <div>
                      <dt>外部大模型</dt>
                      <dd>未配置</dd>
                    </div>
                  </dl>
                  <div className="toolbar">
                    {status.data.tasks.map((t: Row) => (
                      <span className="status" key={t.state}>
                        {t.state}：{t.count}
                      </span>
                    ))}
                  </div>
                  <p className="notice">
                    当前库已完成 {status.data.backup?.count || 0} 份本机备份。
                    {status.data.backup?.latest && (
                      <>
                        最近：{date(status.data.backup.latest.createdAt)}，
                        {status.data.backup.latest.fileCount} 个原始文件、
                        {status.data.backup.latest.tableCount} 张表。{" "}
                      </>
                    )}
                    备份由本机独立任务保存，含
                    SQL、原始文件与私有配置。恢复操作先在空白隔离目标验证，避免覆盖运行中的新数据。
                  </p>
                </>
              )}
            </Resource>
          </Panel>
          <Panel title="最近 50 条审计">
            <Resource {...audit} preserve={audit.data!==undefined} retry={audit.reload}>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作</th>
                      <th>实例</th>
                      <th>对象</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.data?.map((a) => (
                      <tr key={a.id}>
                        <td>{date(a.at)}</td>
                        <td>{a.kind}</td>
                        <td>{a.instance}</td>
                        <td>{a.entity_id?.slice(0, 16) || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Resource>
          </Panel>
        </>
      )}
      {member && (
        <Dialog
          title={member.name + " · 审批与权限"}
          onClose={() => setMember(null)}
        >
          <Form
            onCancel={() => setMember(null)}
            onSubmit={async (form) => {
              const b = values(form),
                roles = new FormData(form).getAll("role");
              await api("/members/" + member.id, {
                method: "PATCH",
                body: { version: member.version, status: b.status, roles },
              });
              setMember(null);
              refresh();
            }}
          >
            <Field label="审批状态">
              <select
                name="status"
                defaultValue={
                  member.status === "pending" ? "active" : member.status
                }
              >
                <option value="active" disabled={!member.directory_active}>
                  批准 / 启用
                </option>
                <option value="disabled">停用</option>
                <option value="rejected">拒绝</option>
              </select>
            </Field>
            <fieldset>
              <legend>分配角色（启用时至少一个）</legend>
              {Object.entries(roleNames).map(([v, t]) => (
                <label className="check" key={v}>
                  <input
                    type="checkbox"
                    name="role"
                    value={v}
                    defaultChecked={member.roles.includes(v)}
                  />
                  {String(t)}
                </label>
              ))}
            </fieldset>
            <p className="notice">
              权限变更立即使旧会话失效。只读角色仍需在具体申请中授予范围；最后一位有效管理员不能移除。
            </p>
          </Form>
        </Dialog>
      )}
      {skill && (
        <Dialog
          title={skill.name ? "编辑技能词条" : "新增技能词条"}
          onClose={() => setSkill(null)}
        >
          <Form
            onCancel={() => setSkill(null)}
            onSubmit={async (form) => {
              const b = values(form);
              await api("/dictionary", {
                method: "PUT",
                body: {
                  name: b.name,
                  category: b.category,
                  aliases: tokens(b.aliases),
                },
              });
              setSkill(null);
              refresh();
            }}
          >
            <Field label="标准名称" required>
              <input
                name="name"
                required
                readOnly={!!skill.name}
                defaultValue={skill.name}
              />
            </Field>
            <Field label="类别" required>
              <input
                name="category"
                required
                defaultValue={skill.category || "custom"}
              />
            </Field>
            <Field label="真实别名（逗号分隔）">
              <textarea
                name="aliases"
                rows={4}
                defaultValue={skill.aliases
                  ?.filter((v: string) => v !== skill.name.toLowerCase())
                  .join("，")}
              />
            </Field>
          </Form>
        </Dialog>
      )}
    </>
  );
}
