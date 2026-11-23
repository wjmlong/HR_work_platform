import { useState } from "react";
import { query } from "../lib/api";
import { useApp, useResource, useDebounced, type Row } from "../lib/state";
import { Field } from "./ui";
export default function ApplicationPicker({
  value,
  onChange,
  disabled = false,
  selected=null,
}: {
  value: string;
  onChange: (a: Row | null) => void;
  disabled?: boolean;
  selected?:Row|null;
}) {
  const [cached,setCached]=useState<Row|null>(null),[text, setText] = useState(""),
    q = useDebounced(text),
    { revision } = useApp(),
    r = useResource<Row>(
      (s) => query("/applications/query", { query: q, pageSize: 100 }, s),
      [q, revision],
    );
  const chosen=selected||cached;
  return (
    <div className="application-picker">
      <Field label="检索候选人">
      <input
        disabled={disabled}
        aria-label="检索候选人申请"
        placeholder="先搜索姓名、院校或技能"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      </Field>
      <Field label="候选人 · 岗位申请" required>
        <select
          disabled={disabled}
          name="applicationId"
          required
          value={value}
          onChange={e=>{const next=r.data?.items.find((a:Row)=>a.id===e.target.value)||null;setCached(next);onChange(next)}}
        >
          <option value="">
            {r.loading ? "正在加载…" : "选择候选人与岗位"}
          </option>
          {chosen?.id===value&&!r.data?.items.some((a:Row)=>a.id===value)&&<option value={value}>{chosen.profile.name} · {chosen.job_name}（已选）</option>}
          {r.data?.items.map((a: Row) => (
            <option key={a.id} value={a.id}>
              {a.profile.name} · {a.job_name}
            </option>
          ))}
        </select>
      </Field>
      {r.error && <p role="alert">{r.error}</p>}
      {r.data?.total > 100 && (
        <small>当前显示前 100 条，请输入更具体条件</small>
      )}
    </div>
  );
}
