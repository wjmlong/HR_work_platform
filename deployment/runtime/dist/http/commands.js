import { createHmac } from "node:crypto";
import { fail } from "./errors.js";
function canonical(v) {
    if (v === undefined)
        return "null";
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(canonical).join(",") + "]";
    return ("{" +
        Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
            .join(",") +
        "}");
}
export class Commands {
    db;
    requestKey;
    constructor(db, requestKey) {
        this.db = db;
        this.requestKey = requestKey;
    }
    async run(a, key, input, fn, policy) {
        if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{3,200}$/.test(key))
            fail(422, "idempotency_key_required");
        // A response created under an older membership must not survive revocation.
        // HMAC also prevents offline guesses of credential-bearing command inputs.
        const hash = createHmac("sha256", this.requestKey ? await this.requestKey() : this.db.config.secret)
            .update(canonical({ input, membershipVersion: a.version }))
            .digest("hex");
        return this.db.tx(async (c) => {
            await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                a.id + ":" + key,
            ]);
            const user = (await c.query("SELECT version,status FROM users WHERE id=$1 FOR SHARE", [a.id])).rows[0];
            const scoped = a.temporaryScope && !!(await c.query('SELECT 1 FROM active_interview_grants WHERE user_id=$1 AND interview_id=$2', [a.id, a.temporaryScope.interviewId])).rowCount;
            if (!user || user.version !== a.version || (user.status !== "active" && !(user.status === 'pending' && scoped)) || (a.temporaryScope && !scoped))
                fail(403, "membership_changed");
            // This guard runs for both first execution and committed-response replay.
            // Configured routes store IDs/version receipts and re-project current ACLs.
            if (policy)
                await policy.authorize();
            const prior = (await c.query("SELECT * FROM idempotency_keys WHERE actor_id=$1 AND key=$2", [a.id, key])).rows[0];
            if (prior) {
                if (prior.request_hash !== hash)
                    fail(409, "idempotency_conflict");
                if (policy) {
                    if (!prior.response || !Object.hasOwn(prior.response, 'configuredReceipt'))
                        fail(409, 'client_update_required');
                    return policy.fromReceipt(prior.response.configuredReceipt);
                }
                return prior.response;
            }
            const response = await fn(), stored = policy ? { configuredReceipt: policy.toReceipt(response) } : response;
            await c.query("INSERT INTO idempotency_keys(actor_id,key,request_hash,response) VALUES($1,$2,$3,$4)", [a.id, key, hash, JSON.stringify(stored ?? null)]);
            return policy ? policy.fromReceipt(stored.configuredReceipt) : response;
        });
    }
}
//# sourceMappingURL=commands.js.map