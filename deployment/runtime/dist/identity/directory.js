import { fail } from '../http/errors.js';
// This is a display cache only. Grant creation always re-verifies contact().
export class Directory {
    identity;
    now;
    cache;
    loading;
    error = null;
    retryAt = 0;
    constructor(identity, now = Date.now) {
        this.identity = identity;
        this.now = now;
    }
    refresh() {
        if (this.loading)
            return this.loading;
        if (!this.identity.provider.directory)
            fail(503, 'directory_not_configured');
        const f = this.identity.config.feishu;
        this.error = null;
        this.loading = Promise.resolve().then(() => this.identity.provider.directory()).then(items => {
            const unique = new Map();
            for (const p of items)
                if (p.tenant === f.tenant && p.appId === f.appId && p.active)
                    unique.set(p.openId, p);
            const values = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.openId.localeCompare(b.openId));
            // Publish only a complete snapshot; keep the previous one while refreshing.
            this.cache = { at: this.now(), items: values };
            this.retryAt = 0;
        }).catch(() => { this.error = 'directory_unavailable'; this.retryAt = this.now() + 60000; }).finally(() => { this.loading = undefined; });
        return this.loading;
    }
    async search(q) {
        if ((!this.cache || this.now() - this.cache.at >= 15 * 60000) && this.now() >= this.retryAt)
            void this.refresh();
        const rows = (this.cache?.items || []).filter(p => (p.name + ' ' + p.openId).toLocaleLowerCase().includes(q.query.trim().toLocaleLowerCase()));
        return {
            items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(p => ({ openId: p.openId, name: p.name })), total: rows.length, page: q.page, pageSize: q.pageSize,
            cachedAt: this.cache ? new Date(this.cache.at).toISOString() : null, refreshing: !!this.loading, error: this.error,
            retryAfterSeconds: this.loading ? 3 : Math.max(0, Math.ceil((this.retryAt - this.now()) / 1000)),
        };
    }
}
//# sourceMappingURL=directory.js.map