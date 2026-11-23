import { useState } from "react";
import { Empty } from "../components/ui";
import { query } from "../lib/api";
import { Resource, useResource, type Row } from "../lib/state";

const dayLabel = (d: Date) => d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
const timeLabel = (v: string) => new Date(v).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const mondayOf = (base: Date) => {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
};

export default function InterviewCalendar({ search, deleted, revision, onPick }: { search: string; deleted: boolean; revision: number; onPick: (i: Row) => void }) {
  const [offset, setOffset] = useState(0);
  const base = new Date();
  base.setDate(base.getDate() + offset * 7);
  const monday = mondayOf(base), sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 7);
  const startsFrom = monday.toISOString(), startsBefore = sunday.toISOString();
  const data = useResource<Row[]>(async signal => {
    const items: Row[] = [], seen = new Set<string>();
    for (let page = 1; ; page++) {
      signal.throwIfAborted();
      const result = await query<{items: Row[]; total: number; pageSize: number}>("/interviews/query", {
        query: search, deleted, startsFrom, startsBefore, page, pageSize: 25,
      }, signal);
      for (const item of result.items) if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
      if (page * result.pageSize >= result.total || !result.items.length) return items;
    }
  }, [search, deleted, startsFrom, startsBefore, revision]);
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(monday); d.setDate(d.getDate() + i); return d;
  });
  const weekItems = (data.data || []).filter((i) => {
    const t = new Date(i.starts_at); return t >= monday && t < sunday;
  });
  const conflicts = new Set<string>();
  for (let x = 0; x < weekItems.length; x++) for (let y = x + 1; y < weekItems.length; y++) {
    const a = weekItems[x], b = weekItems[y];
    if (new Date(a.starts_at).toDateString() !== new Date(b.starts_at).toDateString()) continue;
    const a1 = new Date(a.starts_at).getTime(), a2 = a1 + (Number(a.duration_minutes) || 60) * 60000;
    const b1 = new Date(b.starts_at).getTime(), b2 = b1 + (Number(b.duration_minutes) || 60) * 60000;
    if (a1 < b2 && b1 < a2) { conflicts.add(String(a.id)); conflicts.add(String(b.id)); }
  }
  return <div className="interview-calendar">
    <div className="toolbar">
      <button className="small" onClick={() => setOffset((v) => v - 1)}>← 上一周</button>
      <strong>{dayLabel(monday)} — {dayLabel(new Date(sunday.getTime() - 86400000))}</strong>
      <button className="small" onClick={() => setOffset(0)}>本周</button>
      <button className="small" onClick={() => setOffset((v) => v + 1)}>下一周 →</button>
      <small className="hint" title="只读视图，不拖拽改期；同一天时间区间重叠的面试标红提示，具体冲突需人工核对面试官与会议室">冲突口径</small>
      {conflicts.size > 0 && <span className="notice warning">本周 {conflicts.size} 场面试时间重叠</span>}
    </div>
    <Resource {...data} retry={data.reload}>
    <div className="calendar-grid">
      {days.map((d) => {
        const list = weekItems
          .filter((i) => new Date(i.starts_at).toDateString() === d.toDateString())
          .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
        return <section className="calendar-day" key={d.toISOString()}>
          <header><strong>{dayLabel(d)}</strong><small>{list.length} 场</small></header>
          {list.map((i) => <button key={i.id}
            className={"calendar-event" + (conflicts.has(String(i.id)) ? " conflict" : "")}
            onClick={() => onPick(i)}
            title={`${i.candidate_name} · ${i.job_name} · 第 ${i.round} 轮 · ${i.duration_minutes} 分钟`}>
            <strong>{timeLabel(i.starts_at)}</strong>
            <span>{i.candidate_name}</span>
            <small>{i.job_name} · 第 {i.round} 轮</small>
          </button>)}
          {!list.length && <small className="muted">无安排</small>}
        </section>;
      })}
    </div>
    {!weekItems.length && <Empty>本周暂无面试安排</Empty>}
    </Resource>
  </div>;
}
