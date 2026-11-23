import { requireRole } from "../identity/service.js";
import { z, parse } from "../http/validation.js";
import { fail } from "../http/errors.js";
import { instant } from "./migration.js";
const legacyTime = z
    .union([
    z.number().int().nonnegative(),
    z
        .string()
        .regex(/^\d{1,15}$/)
        .transform(Number),
])
    .refine((v) => Number.isSafeInteger(v) && v <= 8640000000000000);
const memberInput = z
    .array(z
    .object({
    tenant_key: z.string().min(1),
    app_id: z.string().min(1),
    open_id: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["pending", "active", "disabled", "rejected"]),
    role: z.enum(["viewer", "editor", "admin"]),
    directory_active: z.boolean(),
    last_verified_at: legacyTime.optional(),
    created_at: legacyTime.optional(),
})
    .passthrough())
    .max(100000);
export async function importMembers(db, a, input, dryRun = true) {
    requireRole(a, "admin");
    const members = parse(memberInput, input);
    return db.tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('legacy-member-import',0))");
        const live = (await c.query("SELECT * FROM users FOR UPDATE")).rows, create = [], conflicts = [];
        let existing = 0;
        const seen = new Set();
        for (const m of members) {
            const key = JSON.stringify([m.tenant_key, m.app_id, m.open_id]);
            if (seen.has(key)) {
                conflicts.push("duplicate_membership_identity");
                continue;
            }
            seen.add(key);
            const roles = [m.role === "editor" ? "recruiter" : m.role], old = live.find((u) => u.tenant === m.tenant_key &&
                u.app_id === m.app_id &&
                u.open_id === m.open_id);
            if (old) {
                existing++;
                if (old.status !== m.status ||
                    old.directory_active !== m.directory_active ||
                    roles.some((r) => !old.roles.includes(r)) ||
                    old.roles.some((r) => !roles.includes(r)))
                    conflicts.push("membership_authority_conflict");
            }
            else
                create.push({ ...m, roles });
        }
        const report = {
            ready: conflicts.length === 0,
            create: create.length,
            existing,
            conflicts: [...new Set(conflicts)],
        };
        if (dryRun)
            return report;
        if (!report.ready)
            fail(409, "membership_authority_conflict");
        for (const m of create)
            await c.query("INSERT INTO users(tenant,app_id,open_id,name,roles,status,directory_active,verified_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,coalesce($8,now()),coalesce($9,now()))", [
                m.tenant_key,
                m.app_id,
                m.open_id,
                m.name,
                m.roles,
                m.status,
                m.directory_active,
                instant(m.last_verified_at),
                instant(m.created_at),
            ]);
        await c.query("INSERT INTO audit_events(actor_id,kind,instance,detail) VALUES($1,'migration.members',$2,$3)", [a.id, db.config.instance, { created: create.length, existing }]);
        return { ...report, imported: true };
    });
}
//# sourceMappingURL=members.js.map