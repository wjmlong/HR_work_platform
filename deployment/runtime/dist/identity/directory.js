import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export const DIRECTORY_REFRESH_MS = 10 * 60000;
// Shared display cache only. Grant creation still re-verifies contact().
export class Directory {
    identity;
    now;
    loading;
    error = null;
    key;
    file;
    constructor(identity, now = Date.now) {
        this.identity = identity;
        this.now = now;
        const { schema, feishu: f, storageRoot } = identity.config;
        this.key = createHash('sha256').update(JSON.stringify([schema, f.tenant, f.appId])).digest('hex');
        this.file = path.join(storageRoot, 'directory-cache', this.key + '.json');
    }
    async snapshot() {
        try {
            return JSON.parse(await readFile(this.file, 'utf8'));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
    }
    start() {
        void this.refresh();
        const timer = setInterval(() => void this.refresh(), DIRECTORY_REFRESH_MS);
        timer.unref();
        return { close: async () => { clearInterval(timer); await this.loading; } };
    }
    refresh() {
        if (this.loading)
            return this.loading;
        this.loading = this.update().catch(() => { this.error = 'directory_unavailable'; }).finally(() => { this.loading = undefined; });
        return this.loading;
    }
    async update() {
        if (!this.identity.provider.directory || !this.identity.provider.configured())
            return;
        const client = await this.identity.db.pool.connect();
        let locked = false;
        try {
            const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', ['directory:' + this.key]);
            if (!lock.rows[0].acquired)
                return;
            locked = true;
            const previous = await this.snapshot();
            if (previous?.version === 2 && this.now() - previous.at < DIRECTORY_REFRESH_MS)
                return;
            const f = this.identity.config.feishu, unique = new Map();
            for (const p of await this.identity.provider.directory())
                if (p.tenant === f.tenant && p.appId === f.appId && p.active)
                    unique.set(p.openId, p);
            const items = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.openId.localeCompare(b.openId));
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const temporary = this.file + '.' + randomUUID() + '.tmp';
            try {
                await writeFile(temporary, JSON.stringify({ version: 2, at: this.now(), items }), { mode: 0o600 });
                await rename(temporary, this.file);
            }
            finally {
                await rm(temporary, { force: true });
            }
            this.error = null;
        }
        finally {
            try {
                if (locked)
                    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', ['directory:' + this.key]);
            }
            finally {
                client.release(true);
            }
        }
    }
    async decorate(rows, openId) {
        const people = new Map((await this.snapshot())?.items.map(p => [p.openId, p]) || []);
        return rows.map(row => ({ ...row, departments: people.get(openId(row))?.departments || [] }));
    }
    async search(q) {
        const cache = await this.snapshot();
        const rows = (cache?.items || []).filter(p => (p.name + ' ' + p.openId + ' ' + (p.departments || []).join(' ')).toLocaleLowerCase().includes(q.query.trim().toLocaleLowerCase()));
        return { items: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map(p => ({ openId: p.openId, name: p.name, departments: p.departments || [] })), total: rows.length, page: q.page, pageSize: q.pageSize,
            cachedAt: cache ? new Date(cache.at).toISOString() : null, refreshing: !cache && !this.error, error: this.error, retryAfterSeconds: cache ? 600 : 3 };
    }
}
//# sourceMappingURL=directory.js.map