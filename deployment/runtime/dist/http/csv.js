export function csvCell(value) {
    const text = value == null ? '' : String(value), safe = /^[=+\-@\t\r]/.test(text.trimStart()) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
}
export function csvDocument(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
//# sourceMappingURL=csv.js.map