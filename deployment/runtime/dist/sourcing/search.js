import { searchTermPlan } from './terms.js';
function exact(text, word) {
    const out = [];
    const lower = text.toLowerCase(), w = word.toLowerCase();
    let from = 0;
    while (from <= text.length) {
        const at = lower.indexOf(w, from);
        if (at < 0)
            break;
        const before = text[at - 1] || "", after = text[at + w.length] || "";
        if (!(/^[a-z0-9_]+$/i.test(w) && (/[a-z0-9_]/i.test(before) || /[a-z0-9_]/i.test(after))))
            out.push({
                start: at,
                end: at + w.length,
                text: text.slice(at, at + w.length),
            });
        from = at + Math.max(w.length, 1);
    }
    return out;
}
export function searchEvidence(text, query, mode = "all") {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length)
        return { matched: true, ranges: [], kind: "exact" };
    let broad = false;
    const results = words.map((w) => {
        const hits = exact(text, w);
        if (hits.length)
            return hits;
        const plan = searchTermPlan(w);
        if (!plan.broaden)
            return [];
        const found = plan.grams.flatMap(g => exact(text, g)), hit = new Set(found.map(r => r.text));
        const coverage = plan.coverage.filter(grams => grams.some(gram => hit.has(gram))).length;
        if (w.length > 4 && coverage / w.length < 0.4 || !found.length)
            return [];
        broad = true;
        return found;
    });
    const matched = mode === "all"
        ? results.every((x) => x.length > 0)
        : results.some((x) => x.length > 0);
    if (!matched)
        return { matched: false, ranges: [], kind: "none" };
    const merged = [];
    for (const r of results
        .flat()
        .sort((a, b) => a.start - b.start || b.end - a.end)) {
        const last = merged.at(-1);
        if (last && r.start <= last.end) {
            last.end = Math.max(last.end, r.end);
            last.text = text.slice(last.start, last.end);
        }
        else
            merged.push({ ...r });
    }
    return { matched, ranges: merged, kind: broad ? "broad" : "exact" };
}
// Accept broad coverage across the whole record, then project its exact source
// spans back to each field. Rechecking thresholds per field loses valid evidence.
export function recordSearchEvidence(fields, query, mode = "all") {
    let offset = 0;
    const spans = Object.entries(fields).map(([key, text]) => { const start = offset; offset += text.length + 1; return { key, text, start, end: start + text.length }; });
    const combined = spans.map(s => s.text).join("\n"), accepted = searchEvidence(combined, query, mode);
    return Object.fromEntries(spans.map(s => {
        const ranges = accepted.ranges.flatMap(r => {
            const start = Math.max(r.start, s.start) - s.start, end = Math.min(r.end, s.end) - s.start;
            return start < end ? [{ start, end, text: s.text.slice(start, end) }] : [];
        });
        return [s.key, { matched: !query.trim() || ranges.length > 0, ranges, kind: ranges.length ? accepted.kind : query.trim() ? "none" : "exact" }];
    }));
}
//# sourceMappingURL=search.js.map