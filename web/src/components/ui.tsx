import {
  cloneElement,
  isValidElement,
  type ReactElement,
  useEffect,
  useRef,
  useId,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  X,
  ArrowLeft,
  ArrowRight,
  WarningCircle,
  Copy,
} from "@phosphor-icons/react";
import { useApp, stages, leadStates, type Row } from "../lib/state";
import { createPortal } from "react-dom";
import { dialogs } from "../lib/dialog";
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="toolbar">{children}</div>}
    </div>
  );
}
export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      {title && (
        <header className="panel-heading">
          <h2>{title}</h2>
          {action}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
export function Field({
  label,
  required,
  children,
  hint,
}: {
  label: ReactNode;
  required?: boolean;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field" role="group" aria-labelledby={id}>
      <span id={id}>
        {label}
        {required && <b className="required"> *</b>}
        {hint && <i className="info-tip" title={hint}>i</i>}
      </span>
      {isValidElement(children) &&
      typeof children.type === "string" &&
      ["input", "select", "textarea"].includes(children.type)
        ? cloneElement(children as ReactElement<Record<string, unknown>>, {
            "aria-labelledby": id,
          })
        : children}
    </div>
  );
}
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const release = ref.current ? dialogs.activate(ref.current) : () => {};
    return () => {
      release();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>,
    document.body,
  );
}
export function Form({
  onSubmit,
  children,
  submit = "保存",
  onCancel,
}: {
  onSubmit: (form: HTMLFormElement) => Promise<void>;
  children: ReactNode;
  submit?: string;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(e.currentTarget);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save}>
      {children}
      {error && (
        <p className="notice error" role="alert">
          <WarningCircle size={18} />
          {error}
        </p>
      )}
      <footer className="form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            取消
          </button>
        )}
        <button className="primary" disabled={busy} type="submit">
          {busy ? "正在保存…" : submit}
        </button>
      </footer>
    </form>
  );
}
export const values = (form: HTMLFormElement) =>
  Object.fromEntries(new FormData(form)) as Record<string, string>;
export function Empty({ children = "暂无记录" }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Pagination({
  page,
  total,
  size = 25,
  onChange,
}: {
  page: number;
  total: number;
  size?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        共 {total} 条 · 第 {page} / {Math.max(1, Math.ceil(total / size))} 页
      </span>
      <button
        disabled={page <= 1}
        aria-label="上一页"
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft size={16} />
      </button>
      <button
        disabled={page * size >= total}
        aria-label="下一页"
        onClick={() => onChange(page + 1)}
      >
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
export function Status({
  value,
  lead = false,
}: {
  value: string;
  lead?: boolean;
}) {
  const title =
    (lead ? leadStates : stages).find(([id]) => id === value)?.[1] || value;
  return <span className={"status " + value}>{title}</span>;
}
export function Tags({ values = [] }: { values?: string[] }) {
  return (
    <span className="tags">
      {values.map((v, i) => (
        <span className="tag" key={v + ":" + i}>
          {v}
        </span>
      ))}
    </span>
  );
}
export function MatchScore({ match }: { match?: Row | null }) {
  const score = match?.score;
  const unscored = !!score?.unscoredDimensions?.includes?.("skills");
  return (
    <span className={"score " + (!score || unscored ? "muted" : "")} title={unscored ? "岗位未配置技能组，无法计算有效参考分" : undefined}>
      {unscored
        ? "无法计算"
        : score
          ? score.provisional
            ? `${score.value ?? score.lower}% · 待核实`
            : score.lower + "%"
          : "待核对"}
    </span>
  );
}
export function CopyButton({
  text,
  label = "复制纯文本",
}: {
  text: string;
  label?: string;
}) {
  const { notify } = useApp();
  return (
    <button
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => notify("已复制为纯文本"))
          .catch(() => notify("复制失败，请手动选择文本", true))
      }
    >
      <Copy size={16} />
      {label}
    </button>
  );
}
export function ErrorBoundaryNotice({ error }: { error: string }) {
  return (
    <p className="notice error" role="alert">
      {error}
    </p>
  );
}
export function JobSelect({
  jobs,
  value,
  onChange,
  all = true,
  label = "岗位",
  onlyOpen = false,
}: {
  jobs: Row[];
  value: string;
  onChange: (v: string) => void;
  all?: boolean;
  label?: string;
  onlyOpen?: boolean;
}) {
  const options = onlyOpen ? jobs.filter((j) => j.open !== false) : jobs;
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{all ? "全部岗位" : "选择目标岗位"}</option>
      {options.map((j) => (
        <option value={j.id} key={j.id}>
          {j.name}
          {j.open === false ? "（已关闭）" : ""}
        </option>
      ))}
    </select>
  );
}
