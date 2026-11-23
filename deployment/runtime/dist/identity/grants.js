import { requireRole } from './service.js';
import { fail, found } from '../http/errors.js';
import { parse, z, version } from '../http/validation.js';
export const grantInput = z.object({ openId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), role: z.enum(['interviewer', 'coordinator']) }).strict();
export const scheduleInput = z.object({ version, startsAt: z.iso.datetime({ offset: true }).optional(), durationMinutes: z.number().int().min(5).max(480).optional(), location: z.string().max(1000).optional(), meetingUrl: z.union([z.literal(''), z.url().refine(v => /^https?:\/\//.test(v))]).optional() }).strict();
export class InterviewGrants {
    identity;
    constructor(identity) {
        this.identity = identity;
    }
    get db() { return this.identity.db; }
    async verifiedUser(sql, openId) {
        parse(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), openId);
        const p = await this.identity.provider.contact(openId), f = this.identity.config.feishu;
        if (p.tenant !== f.tenant || p.appId !== f.appId || p.openId !== openId)
            fail(403, 'identity_not_allowed');
        if (!p.active)
            fail(409, 'directory_inactive');
        const u = (await sql.query("INSERT INTO users(tenant,app_id,open_id,name,roles,status) VALUES($1,$2,$3,$4,'{}','pending') ON CONFLICT(tenant,app_id,open_id) DO UPDATE SET name=EXCLUDED.name WHERE users.directory_active AND users.status IN ('active','pending') RETURNING *", [p.tenant, p.appId, p.openId, p.name])).rows[0];
        if (!u)
            fail(409, 'membership_disabled');
        return u;
    }
    async grant(a, interviewId, input) {
        requireRole(a, 'admin');
        const b = parse(grantInput, input);
        return this.db.tx(c => this.put(c, interviewId, b, 'manual', '', a.id));
    }
    // Worker-only entrypoint: caller owns a transaction and has verified the bound calendar event.
    async put(c, interviewId, p, source, sourceKey, actorId) {
        parse(grantInput, p);
        const i = found((await c.query("SELECT * FROM interviews WHERE id=$1 AND deleted_at IS NULL AND status<>'cancelled' FOR UPDATE", [interviewId])).rows[0]);
        // Administrative revocation belongs to the interview/user pair, not a transport.
        // Serialize with revoke() using the interview lock above.
        const related = (await c.query('SELECT g.* FROM interview_access_grants g JOIN users u ON u.id=g.user_id WHERE g.interview_id=$1 AND u.tenant=$2 AND u.app_id=$3 AND u.open_id=$4 ORDER BY g.created_at,g.id', [interviewId, this.identity.config.feishu.tenant, this.identity.config.feishu.appId, p.openId])).rows;
        if (source === 'calendar') {
            const revoked = related.find(g => g.revoked_reason === 'admin_revoked');
            if (revoked) {
                await c.query("UPDATE interview_access_grants SET revoked_at=coalesce(revoked_at,now()),revoked_reason='admin_revoked',updated_at=now() WHERE interview_id=$1 AND user_id=$2 AND revoked_at IS NULL", [interviewId, revoked.user_id]);
                return revoked;
            }
            const manual = related.find(g => g.source === 'manual' && !g.revoked_at);
            if (manual) {
                // Attendance changes cannot add an alternate grant or override an explicit role.
                await this.verifiedUser(c, p.openId);
                const redundant = (await c.query("UPDATE interview_access_grants SET revoked_at=now(),revoked_reason='superseded_by_manual',updated_at=now() WHERE interview_id=$1 AND user_id=$2 AND source='calendar' AND revoked_at IS NULL RETURNING id", [interviewId, manual.user_id])).rows;
                for (const row of redundant)
                    await this.identity.audit(c, actorId, 'interview.access.revoke', row.id, { reason: 'superseded_by_manual', interviewId });
                return manual;
            }
        }
        const previous = (await c.query('SELECT g.* FROM interview_access_grants g JOIN users u ON u.id=g.user_id WHERE g.interview_id=$1 AND u.tenant=$2 AND u.app_id=$3 AND u.open_id=$4 AND g.source=$5 AND g.source_key=$6', [interviewId, this.identity.config.feishu.tenant, this.identity.config.feishu.appId, p.openId, source, sourceKey])).rows[0];
        const u = await this.verifiedUser(c, p.openId);
        if (source === 'manual') {
            // A new explicit admin grant is the only operation that clears the pair's veto.
            await c.query("UPDATE interview_access_grants SET revoked_at=coalesce(revoked_at,now()),revoked_reason='superseded_by_manual',updated_at=now() WHERE interview_id=$1 AND user_id=$2 AND source='calendar'", [interviewId, u.id]);
        }
        const expiry = new Date(new Date(i.starts_at).getTime() + (i.duration_minutes + 48 * 60) * 60000);
        if (expiry.getTime() <= Date.now())
            fail(409, 'interview_access_window_ended');
        const g = (await c.query("INSERT INTO interview_access_grants(interview_id,user_id,role,source,source_key,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(interview_id,user_id,source,source_key) DO UPDATE SET role=EXCLUDED.role,expires_at=GREATEST(EXCLUDED.expires_at,interview_access_grants.extended_until),revoked_at=NULL,revoked_reason=NULL,updated_at=now() RETURNING *", [interviewId, u.id, p.role, source, sourceKey, expiry, actorId])).rows[0];
        if (!previous || previous.revoked_at || previous.role !== g.role || new Date(previous.expires_at).getTime() !== new Date(g.expires_at).getTime())
            await this.identity.audit(c, actorId, 'interview.access.grant', g.id, { interviewId, userId: u.id, role: p.role, source, expiresAt: g.expires_at });
        return g;
    }
    async syncCalendarParticipants(c, interviewId, participants, sourceKey, actorId = null) {
        if (!sourceKey || sourceKey.length > 1000)
            fail(422, 'invalid_calendar_source');
        await c.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE', [interviewId]);
        const users = [];
        for (const p of new Map(participants.map(p => [p.openId, p])).values())
            users.push((await this.put(c, interviewId, p, 'calendar', sourceKey, actorId)).user_id);
        const removed = (await c.query("UPDATE interview_access_grants SET revoked_at=now(),revoked_reason='participant_removed',updated_at=now() WHERE interview_id=$1 AND source='calendar' AND source_key=$2 AND NOT(user_id=ANY($3::uuid[])) AND revoked_at IS NULL RETURNING id", [interviewId, sourceKey, users])).rows;
        for (const g of removed)
            await this.identity.audit(c, actorId, 'interview.access.revoke', g.id, { reason: 'participant_removed' });
    }
    async revoke(a, id) {
        requireRole(a, 'admin');
        return this.db.tx(async (c) => {
            const target = found((await c.query('SELECT * FROM interview_access_grants WHERE id=$1', [id])).rows[0]);
            await c.query('SELECT id FROM interviews WHERE id=$1 FOR UPDATE', [target.interview_id]);
            const rows = (await c.query("UPDATE interview_access_grants SET revoked_at=coalesce(revoked_at,now()),revoked_reason='admin_revoked',updated_at=now() WHERE interview_id=$1 AND user_id=$2 RETURNING *", [target.interview_id, target.user_id])).rows;
            for (const g of rows)
                await this.identity.audit(c, a.id, 'interview.access.revoke', g.id, { interviewId: g.interview_id, userId: g.user_id, requestedGrantId: id });
            return found(rows.find(g => g.id === id));
        });
    }
    async extend(a, id, expiresAt) {
        requireRole(a, 'admin');
        parse(z.iso.datetime({ offset: true }), expiresAt);
        if (new Date(expiresAt).getTime() <= Date.now())
            fail(422, 'expiry_must_be_future');
        return this.db.tx(async (c) => { const g = found((await c.query('SELECT * FROM interview_access_grants WHERE id=$1 FOR UPDATE', [id])).rows[0]); if (g.revoked_at)
            fail(409, 'grant_revoked'); await this.verifiedUser(c, (await c.query('SELECT open_id FROM users WHERE id=$1', [g.user_id])).rows[0].open_id); const row = (await c.query('UPDATE interview_access_grants SET extended_until=GREATEST(expires_at,$2::timestamptz),expires_at=GREATEST(expires_at,$2::timestamptz),updated_at=now() WHERE id=$1 RETURNING *', [id, expiresAt])).rows[0]; await this.identity.audit(c, a.id, 'interview.access.extend', id, { expiresAt: row.expires_at }); return row; });
    }
    async list(a, interviewId) { requireRole(a, 'admin'); return (await this.db.query('SELECT g.*,u.name,u.open_id FROM interview_access_grants g JOIN users u ON u.id=g.user_id WHERE interview_id=$1 ORDER BY g.created_at,g.id', [interviewId])).rows; }
    async mine(a) {
        return (await this.db.query("SELECT i.id,i.application_id,i.round,i.starts_at,i.duration_minutes,i.form,i.status,i.location,i.meeting_url,i.version,c.profile->>'name' candidate_name,j.name job_name,CASE WHEN bool_or(g.role='coordinator') THEN 'coordinator' ELSE 'interviewer' END role,max(g.expires_at) expires_at FROM active_interview_grants g JOIN users u ON u.id=g.user_id JOIN interviews i ON i.id=g.interview_id JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id WHERE g.user_id=$1 AND u.version=$2 AND u.tenant=$3 AND u.app_id=$4 GROUP BY i.id,c.id,j.id ORDER BY i.starts_at,i.id", [a.id, a.version, this.identity.config.feishu.tenant, this.identity.config.feishu.appId])).rows;
    }
    async schedule(a, interviewId, input) {
        const b = parse(scheduleInput, input);
        return this.db.tx(async (c) => {
            const who = await this.identity.interviewActor(a, interviewId, 'coordinate', c);
            const i = found((await c.query('SELECT * FROM interviews WHERE id=$1 FOR UPDATE', [interviewId])).rows[0]);
            if (i.version !== b.version)
                fail(409, 'version_conflict');
            const row = (await c.query('UPDATE interviews SET starts_at=$2,duration_minutes=$3,location=$4,meeting_url=$5,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version', [interviewId, b.startsAt ?? i.starts_at, b.durationMinutes ?? i.duration_minutes, b.location ?? i.location, b.meetingUrl ?? i.meeting_url])).rows[0];
            await this.identity.audit(c, who.id, 'interview.edit', interviewId, { version: row.version, scoped: true });
            return row;
        });
    }
}
//# sourceMappingURL=grants.js.map