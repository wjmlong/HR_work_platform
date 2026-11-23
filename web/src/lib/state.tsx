import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type DependencyList,
  type ReactNode,
} from "react";
export type Row = Record<string, any>;
export type User = {
  id: string;
  name: string;
  status: string;
  roles: string[];
  csrf: string;
  temporaryAccess?: boolean;
  calendarSyncEnabled?: boolean;
  environment?: string;
};
type AppState = {
  user: User;
  revision: number;
  refresh: () => void;
  notify: (text: string, error?: boolean) => void;
  canWrite: boolean;
  canManage: boolean;
  isAdmin: boolean;
  openApplication: (id: string, edit?:boolean) => void;
  openPerson: (id: string) => void;
};
export const Context = createContext<AppState>(null!);
export function useApp() {
  return useContext(Context);
}
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList = [],
) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    Promise.resolve()
      .then(() => loader(controller.signal))
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message || "加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [...deps, version]);
  return { data, error, loading, reload };
}
export function useDebounced<T>(value: T, ms = 120) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setResult(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return result;
}
export function Resource({loading,error,retry,children,preserve=false}:{loading:boolean;error:string;retry?:()=>void;children:ReactNode;preserve?:boolean}) {
  return <>
    {error&&<div className="notice error" role="alert">{error} {retry&&<button onClick={retry}>重试</button>}</div>}
    {loading&&<div className="loading" role="status">正在加载…</div>}
    {(preserve||!loading&&!error)&&children}
  </>;
}
export const stages = [
  ["screening", "待筛选"],
  ["screened", "初筛通过"],
  ["interviewing", "面试中"],
  ["collecting", "资料收集中"],
  ["background_check", "背调中"],
  ["offered", "已发 offer"],
  ["hired", "已入职"],
  ["terminated", "录用终止"],
  ["hired_other", "录用到其他"],
  ["on_hold", "待定"],
  ["reserve", "人才储备"],
  ["rejected", "已淘汰"],
] as const;
export const leadStates = [
  ["uncontacted", "未联系"],
  ["contacted", "已联系未回"],
  ["replied", "已回复"],
  ["resume_received", "已拿到简历"],
  ["uploaded", "已上传系统"],
  ["declined", "明确拒绝"],
] as const;
export const education = [
  ["", "未注明"],
  ["none", "不限"],
  ["secondary", "高中/中专"],
  ["associate", "大专"],
  ["bachelor", "本科"],
  ["master", "硕士"],
  ["doctor", "博士"],
] as const;
export const edu = (v: string) =>
  education.find(([key]) => key === v)?.[1] || "未注明";
export const date = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString("zh-CN", { hour12: false }) : "—";
export const tokens = (v: string) => [
  ...new Set(
    v
      .split(/[，,、;；\n]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
export const pct = (v: number | null | undefined) =>
  v == null ? "—" : (100 * v).toFixed(1) + "%";
