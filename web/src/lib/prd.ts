export const navigation = [
  ["overview", "招聘仪表盘"],
  ["board", "招聘进行中"],
  ["inbox", "简历收件箱"],
  ["upload", "上传简历"],
  ["mailbox", "邮箱来信"],
  ["questions", "面试题库"],
  ["evaluations", "面试评估"],
  ["interviewer-review", "面试官评价"],
  ["briefs", "决策建议"],
  ["people", "人才库／历史档案"],
  ["jobs", "岗位管理"],
  ["interviews", "面试安排"],
  ["statistics", "数据统计"],
  ["toolkit", "招聘助手"],
] as const;
export const initialPage = (hash: string) => {
  const page = hash.replace(/^#/, "").split("?")[0];
  return [...navigation.map(([id]) => id), "sourcing", "admin", "my-interviews"].includes(page)
    ? page
    : "overview";
};
export const skillTokens = (value: string) => [
  ...new Set(
    value
      .split(/[，,、;；\n/|]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
export const terminationReasons = [
  "接受其他 offer",
  "主动放弃",
  "薪资未达预期",
  "到岗时间不匹配",
  "背调未通过",
  "录用审批未通过",
  "岗位编制冻结",
  "其他",
];
export const rejectionReasons = [
  "技能不匹配",
  "经验不足",
  "学历或专业不符",
  "面试未通过",
  "薪酬未谈拢",
  "候选人放弃",
  "岗位需求变更或关闭",
  "背景调查未通过",
  "其他原因",
];
export const transferStart = (status: string) =>
  status === "hired"
    ? "offered"
    : ["terminated", "rejected", "hired_other"].includes(status)
      ? "screening"
      : status;
export function transferBody(
  application: { version: number; status: string },
  targetJobId: string,
  to: string,
  fields: Record<string, string>,
) {
  if (!targetJobId) throw Error("请选择目标岗位");
  return { ...transitionBody(application, to, fields), targetJobId };
}
export const ccTemplates: Record<string, { to: string; items: string[] }> = {
  collecting: {
    to: "用人部门 + 行政 + 信息技术",
    items: [
      "入职资料清单（学历/离职证明/体检报告）",
      "办公位与工位设备",
      "系统账号与邮箱开通申请",
    ],
  },
  background_check: {
    to: "用人部门 + 人力（背调机构）",
    items: ["前雇主证明人确认", "竞业与保密情况核对", "背调结果书面回执"],
  },
  offered: {
    to: "用人部门 + 人力 + 财务 + 行政 + 信息技术",
    items: [
      "offer 审批与用印",
      "薪酬结构与发放口径入系统",
      "入职日与报到安排通知",
      "部门内部提前同步交接计划",
    ],
  },
  hired: {
    to: "用人部门 + 人力 + 行政 + 信息技术 + 财务",
    items: [
      "入职手续与劳动合同",
      "门禁卡与工牌",
      "社保公积金增员",
      "试用期目标与导师安排",
    ],
  },
};
export function transitionBody(
  application: { version: number; status: string },
  to: string,
  fields: Record<string, string>,
  interaction = "form",
) {
  if (
    to === "terminated" &&
    (!fields.termReason ||
      (fields.termReason === "其他" && !fields.termDetail?.trim()))
  )
    throw Error("请填写终止原因，其他原因需填写说明");
  if (
    to === "rejected" &&
    (!fields.rejectReason?.trim() || !fields.rejectDetail?.trim())
  )
    throw Error("请填写淘汰原因与详细说明");
  if (
    interaction === "drag" &&
    !["terminated", "rejected", "hired_other", "on_hold", "reserve"].includes(to) &&
    !["hired", "terminated", "rejected", "hired_other"].includes(application.status)
  )
    return { version: application.version, to, interaction };
  if (!fields.reason?.trim()) throw Error("请选择流转原因");
  if ((fields.opinion || "").trim().length < 5)
    throw Error("流转意见至少填写 5 个字");
  return {
    version: application.version,
    to,
    interaction: "form",
    confirm: true,
    reason: fields.reason,
    opinion: fields.opinion,
    rejectReason: fields.rejectReason || "",
    rejectDetail: fields.rejectDetail || "",
    termReason: fields.termReason || "",
    termDetail: fields.termDetail || "",
    ccMethod: fields.ccMethod || "both",
  };
}
export async function commitCommand<T>(
  request: () => Promise<T>,
  commit: (value: T) => void,
) {
  const result = await request();
  commit(result);
  return true;
}
export function togglePoints(shown: string[], all: string[], target: string) {
  return target === "all"
    ? all.every((id) => shown.includes(id))
      ? []
      : [...all]
    : shown.includes(target)
      ? shown.filter((id) => id !== target)
      : [...shown, target];
}
export function questionsText(
  questions: { group?: string; prompt: string; referencePoints: string[]; followups?:string[] }[],
) {
  let group = "";
  return questions
    .map((q, i) => {
      const heading =
        q.group !== group ? "\n" + (q.group || "人工补充") + "\n" : "";
      group = q.group || "";
      return (
        heading +
        (i + 1) +
        ". " +
        q.prompt +
        "\n要点：" +
        q.referencePoints.join("；") + (q.followups?.length?"\n追问："+q.followups.join("；"):"")
      );
    })
    .join("\n");
}

// Query-bearing legacy links include jobs, stages and saved field views.
export function peopleLanding(hash: string): 'archive' | 'legacy' {
 return new URLSearchParams(hash.split('?')[1] || '').size ? 'legacy' : 'archive';
}
