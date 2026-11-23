import { DiscoveryPolicy } from './policy.js';
import { parse, z, platforms, publicUrl } from './schema.js';
import { fail } from '../http/errors.js';
export class DiscoveryCapabilities {
    identity;
    policy;
    constructor(identity) {
        this.identity = identity;
        this.policy = new DiscoveryPolicy(identity);
    }
    async list(a) { this.policy.writer(a); const saved = (await this.identity.db.query('SELECT * FROM discovery_capabilities')).rows; return platforms.options.map(platform => { const r = saved.find(r => r.platform === platform); return { platform, mode: r?.data.publicFetch ? 'verified_public_fetch' : 'manual_import', import: true, automatic: platform === 'other', search: platform === 'other' ? 'github_repository_search' : 'manual', detail: r?.data.publicFetch ? 'allowlisted_public_page' : 'manual', contact: 'manual_review_required', directContact: 'unverified', version: r?.version || 0, hosts: r?.data.hosts || [], verifiedAt: r?.updated_at || null, limitations: ['登录平台由本人浏览器操作，不能自动搜索或私信；公开读取仅支持已确认的主机。'] }; }); }
    async update(a, input) {
        this.policy.admin(a);
        const b = parse(z.object({ platform: platforms, version: z.number().int().min(0), publicFetch: z.boolean(), hosts: z.array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/)).max(20), verificationUrl: publicUrl, note: z.string().trim().min(10).max(2000) }).strict(), input);
        if (!['research', 'competition', 'campus', 'other'].includes(b.platform))
            fail(422, 'platform_manual_only');
        if (b.publicFetch && (!b.hosts.length || !b.hosts.includes(new URL(b.verificationUrl).hostname)))
            fail(422, 'verification_host_required');
        return this.identity.db.tx(async (c) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),18003)');
            const old = (await c.query('SELECT version FROM discovery_capabilities WHERE platform=$1 FOR UPDATE', [b.platform])).rows[0];
            if ((old?.version || 0) !== b.version)
                fail(409, 'version_conflict');
            const row = (await c.query('INSERT INTO discovery_capabilities(platform,data) VALUES($1,$2) ON CONFLICT(platform) DO UPDATE SET data=$2,version=discovery_capabilities.version+1,updated_at=now() RETURNING platform,version', [b.platform, { ...b, verifiedBy: a.id }])).rows[0];
            await this.identity.audit(c, a.id, 'discovery.capability', null, { platform: b.platform });
            return row;
        });
    }
}
//# sourceMappingURL=capabilities.js.map