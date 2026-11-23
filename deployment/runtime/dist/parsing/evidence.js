export function withContext(raw, evidence, max = 160) {
    const lineStart = raw.lastIndexOf('\n', Math.max(0, evidence.start - 1)) + 1;
    const next = raw.indexOf('\n', evidence.end), lineEnd = next < 0 ? raw.length : next;
    let start = lineStart, end = lineEnd;
    if (end - start > max) {
        start = Math.max(lineStart, evidence.start - Math.floor((max - (evidence.end - evidence.start)) / 2));
        end = Math.min(lineEnd, start + max);
        start = Math.max(lineStart, end - max);
    }
    if (start > 0 && /[\uDC00-\uDFFF]/.test(raw[start]) && /[\uD800-\uDBFF]/.test(raw[start - 1]))
        start++;
    if (end < raw.length && /[\uDC00-\uDFFF]/.test(raw[end]) && /[\uD800-\uDBFF]/.test(raw[end - 1]))
        end--;
    return { ...evidence, context: { start, end, text: raw.slice(start, end), highlights: [{ start: Math.max(0, evidence.start - start), end: Math.min(end - start, evidence.end - start) }] } };
}
//# sourceMappingURL=evidence.js.map