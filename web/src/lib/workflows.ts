// A response may commit only to the selection that initiated it, including A→B→A.
export class RequestScope {
  private generation = 0;
  change() {
    this.generation++;
  }
  get token() {
    return this.generation;
  }
  is(token: number) {
    return token === this.generation;
  }
  async run<T>(request: () => Promise<T>, commit: (value: T) => void) {
    const token = this.generation;
    try {
      const result = await request();
      if (!this.is(token)) return false;
      commit(result);
      return true;
    } catch (error) {
      if (this.is(token)) throw error;
      return false;
    }
  }
}
export const businessDate = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
export function statisticsRange(from: string, to: string) {
  const valid = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v + "T00:00:00+08:00")) &&
    businessDate(new Date(v + "T00:00:00+08:00")) === v;
  if (!valid(from) || !valid(to) || from >= to) return null;
  return {
    from: new Date(from + "T00:00:00+08:00").toISOString(),
    to: new Date(to + "T00:00:00+08:00").toISOString(),
  };
}
export function evidenceResumeId(
  application: { resume_version_id?: string },
  match: { latest?: { resume_version_id?: string } | null },
) {
  return match.latest?.resume_version_id || application.resume_version_id;
}
export function extractionWarnings(raw: {
  raw: string;
  profile: Record<string, unknown>;
}) {
  const p = raw.profile,
    missing = [
      !p.phone ? "电话（联系方式）" : "",
      !p.email ? "邮箱（联系方式）" : "",
      !p.education ? "学历" : "",
      !p.school ? "院校" : "",
      p.experienceYears == null ? "工作年限" : "",
      !p.location ? "所在地" : "",
    ].filter(Boolean);
  return [
    ...(raw.raw.trim().length < 50
      ? [
          "原文不足 50 字，可能是扫描件或图片版，解析结论可信度低；请补充原文并人工核对",
        ]
      : []),
    ...(missing.length ? ["未提取字段：" + missing.join("、")] : []),
  ];
}
export const toggleMember = (selected: string[], id: string) =>
  selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id];
export function finishApplicationFlow(
  currentId: string,
  next: { id?: string } | undefined,
  actions: {
    closeForm: () => void;
    refresh: () => void;
    reload: () => void;
    open: (id: string) => void;
  },
) {
  actions.closeForm();
  actions.refresh();
  if (next?.id && next.id !== currentId) actions.open(next.id);
  else actions.reload();
}
export const readableBrief = (material: {
  data: unknown;
  human_conclusion?: { text?: string } | null;
}) =>
  JSON.stringify(
    {
      factsAndAssessment: material.data,
      humanConclusion: material.human_conclusion?.text || null,
    },
    null,
    2,
  );
export const readableComparison = (match: {
  resume_version_id: string;
  algorithm_version: string;
  dictionary_version: number;
  job_version: number;
  data: unknown;
}) =>
  "专业条件对照 · 仅供人工参考；未命中不等于不具备，不代表录用结论，由人工最终确认。年龄、性别不进入筛选评分。\n" +
  JSON.stringify(
    {
      resumeVersionId: match.resume_version_id,
      algorithmVersion: match.algorithm_version,
      dictionaryVersion: match.dictionary_version,
      jobVersion: match.job_version,
      comparison: match.data,
    },
    null,
    2,
  );
