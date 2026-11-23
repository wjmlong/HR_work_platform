/** Gate every request, including cached browser mutations, before proxying. */
export function maintenanceResponse(url, active) {
    if (!active)
        return null;
    const api = (url || '/').startsWith('/api/') || (url || '/').startsWith('/health/');
    return { status: 503, headers: { 'content-type': api ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' }, body: api ? JSON.stringify({ error: { code: 'maintenance', message: '招聘系统正在维护升级，请稍后重试；当前操作未提交。' } }) : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>招聘工作台维护中</title><main><h1>招聘工作台维护升级中</h1><p>数据正在核验，暂时停止提交。请稍后刷新页面。</p></main></html>' };
}
//# sourceMappingURL=maintenance.js.map