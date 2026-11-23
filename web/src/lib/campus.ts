export const campusRegions = [
  "华北",
  "华东",
  "华南",
  "华中",
  "西南",
  "西北",
  "东北",
  "海外",
];
export const campusTiers = [
  "C9",
  "985",
  "211",
  "双一流",
  "普通本科",
  "科研院所",
  "海外",
];
export const campusStatuses: Record<string, string> = {
  unregistered: "未注册",
  registered: "已注册·未发布",
  published: "已发布",
  renewal: "需年度续期",
  invalid: "账号失效",
};
export function credentialChange(action: string, value: string) {
  if (action === "replace") return { action: "replace", value };
  if (action === "clear") return { action: "clear" };
  return { action: "keep" };
}
export function campusExportBody(
  query: Record<string, unknown>,
  includeCredentials: boolean,
  confirmed: boolean,
) {
  if (includeCredentials && !confirmed) throw Error("文件含账号密码，注意存放");
  return {
    query,
    includeCredentials,
    confirmation: includeCredentials ? "文件含账号密码，注意存放" : "",
  };
}

export function unexpiredCredentials<T extends { expiresAt: number }>(
  values: Record<string, T>,
  now: number,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.expiresAt > now),
  );
}
