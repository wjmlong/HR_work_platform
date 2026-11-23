import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

async function screen(t: TestContext, exportStatus = 200) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://recruit.test/' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'FormData'])
    install(key, (dom.window as any)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: string[] = [], blobs: Blob[] = [], notices: [string, boolean?][] = [];
  class DownloadURL extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:statistics-fixture'; }
    static revokeObjectURL() {}
  }
  install('URL', DownloadURL);
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  install('fetch', async (url: string) => {
    calls.push(url);
    let data: unknown;
    if (url === '/api/v4/statistics/query') data = { counts: { applications: 2, people: 2, resumes: 2 }, current: {}, funnel: [], channels: [{ source: '日期区间渠道', applications: 2, screened: 1, interviewed: 1, offered: 0, hired: 0 }], dwell: {}, rejections: {} };
    else if (url === '/api/v4/measurements/protocols') data = [];
    else if (url === '/api/v4/toolkit/overview') data = {
      channels: [{ source: '仅可读来源', applications: 10, interviewed: 5, offered: 2, hired: 1 }],
      numberDefinitions: [{ label: '当前申请数', value: 10, definition: '一人多岗按多条计', source: '招聘看板 / 收件箱' }],
    };
    else if (url === '/api/v4/toolkit/overview?mode=export') {
      if (exportStatus !== 200) return new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: exportStatus });
      data = {
        channels: [{ source: '未授权来源', applications: 12, interviewed: 6, offered: 3, hired: 2 }, { source: '  =SUM(1,2)', applications: 0, interviewed: 0, offered: 0, hired: 0 }],
        numberDefinitions: [{ label: '当前申请数', value: 12, definition: '新鲜导出口径', source: '招聘看板 / 收件箱' }],
        offers: [{ name: '不得进入统计文件的候选人', phone: 'synthetic-private' }],
      };
    } else throw Error('Unexpected request ' + url);
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  });
  const root = createRoot(document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  });
  const [{ default: Statistics }, { Context }] = await Promise.all([import('../src/features/Statistics.tsx'), import('../src/lib/state.tsx')]);
  await act(async () => root.render(React.createElement(Context.Provider, { value: { revision: 0, canManage: false, refresh() {}, notify: (text: string, error?: boolean) => notices.push([text, error]) } as any }, React.createElement(Statistics))));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const exportButton = () => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === '导出渠道转化与口径 CSV');
    assert.ok(button, 'statistics has a channel and count-definition export');
    return button;
  };
  return { calls, blobs, notices, exportButton };
}

test('statistics restores current-application channel and number definitions with an explicit scope', async t => {
  await screen(t);
  const summary = [...document.querySelectorAll('summary')].find(node => node.textContent?.includes('渠道转化与候选人数字口径'));
  assert.ok(summary, 'the moved toolkit panel exists in statistics');
  const panel = summary.closest('details')!;
  assert.match(panel.textContent!, /不受上方日期区间限制/);
  assert.match(panel.textContent!, /当前申请数.*10.*一人多岗按多条计/);
  assert.match(panel.textContent!, /仅可读来源.*50\.0%.*10\.0%/);
  assert.match(document.body.textContent!, /来源渠道有效性.*日期区间渠道/);
});

test('channel export requests export permission again and uses only the fresh permitted aggregate with formula escaping', async t => {
  const view = await screen(t);
  await act(async () => view.exportButton().click());
  assert.equal(view.calls.filter(url => url.endsWith('?mode=export')).length, 1);
  assert.equal(view.blobs.length, 1);
  const csv = await view.blobs[0].text();
  assert.match(csv, /未授权来源","12","6","3","2","50\.0%","16\.7%/);
  assert.match(csv, /"'  =SUM\(1,2\)"/);
  assert.match(csv, /当前申请数","12","新鲜导出口径/);
  assert.doesNotMatch(csv, /仅可读来源|日期区间渠道|不得进入统计文件的候选人|synthetic-private/);
  assert.ok(!csv.includes('NaN'));
});

test('a refused statistics aggregate export produces no cached-data download', async t => {
  const view = await screen(t, 403);
  await act(async () => view.exportButton().click());
  assert.equal(view.calls.filter(url => url.endsWith('?mode=export')).length, 1);
  assert.equal(view.blobs.length, 0);
  assert.equal(view.notices.at(-1)?.[1], true);
});
