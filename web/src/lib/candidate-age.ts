// 年龄：简历解析到就照录；没有则按「18 岁上大学」的起算年龄 + 工作年限推算，界面标注「（预计）」。
// 起算年龄：大专 21、本科 22、硕士 25、博士 28、高中/中专 18，学历未知按本科 22。
// 工作年限缺失时不推算，显示「—」；不把缺失的年限当成 0 年，避免凭空给出年龄。
// 这里的值只用于「最近上传」列表的人工查看与页内筛选：不写库，不进入自动筛选、评分、排序或推进条件。
export type AgeProfile =
  | { age?: unknown; experienceYears?: unknown; education?: unknown }
  | null
  | undefined;
export type AgeBucket = "" | "le30" | "31to40" | "41to50" | "gt50" | "none";

export const AGE_START: Record<string, number> = {
  doctor: 28,
  master: 25,
  bachelor: 22,
  associate: 21,
  secondary: 18,
};

export function candidateAge(profile: AgeProfile): {
  value: number | null;
  estimated: boolean;
} {
  const age = Number(profile?.age);
  if (Number.isFinite(age) && age > 0 && age <= 120)
    return { value: age, estimated: false };
  const rawYears = profile?.experienceYears;
  const years =
    rawYears === null || rawYears === undefined || rawYears === "" ? NaN : Number(rawYears);
  if (!Number.isFinite(years) || years < 0) return { value: null, estimated: false };
  const start = AGE_START[String(profile?.education ?? "")] ?? 22;
  return { value: Math.round(years + start), estimated: true };
}

export function candidateAgeText(profile: AgeProfile): {
  text: string;
  estimated: boolean;
} {
  const age = candidateAge(profile);
  if (age.value === null) return { text: "—", estimated: false };
  return {
    text: age.value + (age.estimated ? "（预计）" : " 岁"),
    estimated: age.estimated,
  };
}

export function ageMatches(profile: AgeProfile, bucket: AgeBucket) {
  if (!bucket) return true;
  const value = candidateAge(profile).value;
  if (bucket === "none") return value === null;
  if (value === null) return false;
  if (bucket === "le30") return value <= 30;
  if (bucket === "31to40") return value >= 31 && value <= 40;
  if (bucket === "41to50") return value >= 41 && value <= 50;
  return value > 50;
}
