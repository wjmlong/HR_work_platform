import { decodeRaw } from "../parsing/profile.js";
import { legacyProfile, instant, safe } from "./migration.js";
import { profileInput } from "../recruiting/schema.js";
import { applyCorrections } from "../parsing/corrections.js";
import { decodeJSON, encodeJSON } from "../parsing/json.js";
// Recover explicit source fields omitted by the old V3 mapper. Never overwrite later human edits.
export async function recoverLegacyFacts(db, actorId) {
    return db.tx(async (c) => {
        const archives = (await c.query("SELECT source_sha256,kind,source_key,data_bytes FROM legacy_archives WHERE kind IN ('bundle','mapping')")).rows;
        const changed = [], skipped = [];
        for (const archive of archives.filter((r) => r.kind === "bundle")) {
            const bundle = JSON.parse(decodeRaw(archive.data_bytes)), data = bundle.data || bundle;
            for (const mapping of archives.filter((r) => r.kind === "mapping" && r.source_sha256 === archive.source_sha256)) {
                const map = JSON.parse(decodeRaw(mapping.data_bytes)), t = data.talents?.find((x) => x.id === mapping.source_key);
                if (!t)
                    continue;
                const row = (await c.query("SELECT p.*,a.id application_id,a.version application_version,a.resume_version_id,a.status,a.note application_note,a.source application_source,r.parse_result_id,pr.profile parsed_profile,pr.evidence,pr.human_corrections,pr.document_id,pr.raw_bytes,pr.parser_version FROM candidates p JOIN applications a ON a.candidate_id=p.id JOIN resume_versions r ON r.id=a.resume_version_id JOIN parse_results pr ON pr.id=r.parse_result_id WHERE p.id=$1 AND a.id=$2 FOR UPDATE OF p,a", [map.candidateId, map.applicationId])).rows[0];
                if (!row ||
                    row.version !== 1 ||
                    row.application_version !== 1 ||
                    row.status !== map.status) {
                    skipped.push(map.candidateId);
                    continue;
                }
                const profile = profileInput.parse(legacyProfile(t, row.profile)), hasDiff = JSON.stringify(profile) !==
                    JSON.stringify(profileInput.parse(row.profile));
                if (hasDiff) {
                    const corrections = Object.entries(profile)
                        .filter(([key, value]) => JSON.stringify(value) !==
                        JSON.stringify(row.parsed_profile[key]))
                        .map(([field, value]) => ({
                        field,
                        value,
                        source: "legacy_import",
                        actorId,
                        reason: "恢复旧版备份中的结构化字段；原操作人未提供",
                        at: new Date().toISOString(),
                    }));
                    const corrected = applyCorrections({
                        profile: row.parsed_profile,
                        evidence: decodeJSON(row.evidence),
                        warnings: [],
                        parserVersion: row.parser_version,
                    }, corrections);
                    const parsed = (await c.query("INSERT INTO parse_results(document_id,raw_bytes,profile,evidence,parser_version,human_corrections) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [
                        row.document_id,
                        row.raw_bytes,
                        profile,
                        encodeJSON(corrected.evidence),
                        "legacy-fact-recovery-4.0.0",
                        encodeJSON(corrections),
                    ])).rows[0];
                    const resume = (await c.query("INSERT INTO resume_versions(candidate_id,parse_result_id,parent_id,created_by) VALUES($1,$2,$3,$4) RETURNING id", [row.id, parsed.id, row.resume_version_id, actorId])).rows[0];
                    await c.query("UPDATE candidates SET profile=$2,version=version+1 WHERE id=$1", [row.id, profile]);
                    await c.query("INSERT INTO candidate_profile_versions(candidate_id,version,profile,actor_id) VALUES($1,$2,$3,$4)", [row.id, row.version + 1, profile, actorId]);
                    await c.query("UPDATE applications SET resume_version_id=$2,version=version+1 WHERE id=$1", [row.application_id, resume.id]);
                    changed.push(row.id);
                }
                await c.query("UPDATE candidates SET created_at=coalesce($2,created_at),updated_at=coalesce($3,$2,updated_at) WHERE id=$1", [row.id, instant(t.created), instant(t.updated)]);
                await c.query("UPDATE applications SET note=$2,source=$3,created_at=coalesce($4,created_at),updated_at=coalesce($5,$4,updated_at) WHERE id=$1", [
                    row.application_id,
                    typeof t.note === "string"
                        ? safe(t.note)
                        : row.application_note,
                    typeof t.source === "string"
                        ? safe(t.source)
                        : row.application_source,
                    instant(t.created),
                    instant(t.updated),
                ]);
            }
        }
        return { changed: changed.length, skipped: skipped.length };
    });
}
//# sourceMappingURL=recover-legacy.js.map