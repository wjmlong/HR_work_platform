/** Business displays use minutes; source timestamps and form payloads stay intact. */
export function formatDateTime(value: unknown, seconds = false): string {
  if (value == null || value === '') return '—';
  if (value instanceof Date && !Number.isFinite(value.getTime())) return '—';
  const text = value instanceof Date ? value.toISOString() : String(value);
  // Calendar-only values keep their original precision, without invented time.
  if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(text)) return text.replaceAll('-', '/');
  const date = value instanceof Date ? value : new Date(text);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...(seconds ? { second: '2-digit' as const } : {}),
  });
}

export function formatRelativeTime(value: unknown, now = Date.now()): string {
  if (value == null || value === '') return '—';
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) return '—';
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 0 || minutes >= 7 * 24 * 60) return formatDateTime(value);
  if (minutes === 0) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + ' 小时前';
  return Math.floor(minutes / (24 * 60)) + ' 天前';
}
