import {useEffect, useState} from 'react';
import {formatDateTime, formatRelativeTime} from '../lib/date-time';

export default function RelativeTime({value, empty = '—'}: {value?: string | null; empty?: string}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  if (!value) return <>{empty}</>;
  return <time dateTime={value} title={formatDateTime(value)}>{formatRelativeTime(value, now)}</time>;
}
