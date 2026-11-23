import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDateTime, formatRelativeTime} from '../src/lib/date-time';

test('business timestamps display minutes without rounding into the next minute', () => {
  const timestamp = '2026-11-17T23:59:59.999';
  assert.equal(formatDateTime(timestamp), '2026/11/17 23:59');
  assert.equal(timestamp, '2026-11-17T23:59:59.999');
  assert.equal(formatDateTime('2026-11-17T09:05:03'), '2026/11/17 09:05');
});

test('calendar values retain year, month or date precision without invented midnight', () => {
  assert.equal(formatDateTime('2026'), '2026');
  assert.equal(formatDateTime('2026-03'), '2026/03');
  assert.equal(formatDateTime('2026-03-02'), '2026/03/02');
});

test('empty and invalid timestamps display a placeholder', () => {
  for (const value of [null, undefined, '', 'not-a-date', new Date(NaN)]) assert.equal(formatDateTime(value), '—');
});

test('audit timestamps can explicitly retain seconds', () => {
  assert.equal(formatDateTime('2026-11-17T09:05:03', true), '2026/11/17 09:05:03');
});

test('sync labels use relative minutes, with clear future and old timestamps', () => {
  const now = new Date('2026-11-17T09:05:00').getTime();
  assert.equal(formatRelativeTime('2026-11-17T09:04:30', now), '刚刚');
  assert.equal(formatRelativeTime('2026-11-17T09:02:00', now), '3 分钟前');
  assert.equal(formatRelativeTime('2026-11-17T07:02:00', now), '2 小时前');
  assert.equal(formatRelativeTime('2026-11-18T09:05:00', now), '2026/11/18 09:05');
  assert.equal(formatRelativeTime('2026-11-01T09:05:00', now), '2026/11/1 09:05');
  assert.equal(formatRelativeTime(undefined, now), '—');
});
