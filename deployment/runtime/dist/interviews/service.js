import { Directory } from '../identity/directory.js';
import { evaluationSnapshot } from '../business-config/evaluation-versions.js';
import { mergeTemplateEvaluation, validateEvaluationTemplate } from '../business-config/evaluation-template.js';
import { legacyDefinition, legacyKeys, projectLegacyInterview, assertLegacyField } from '../business-config/legacy-fields.js';
import { requireRole } from "../identity/service.js";
import { RecruitingService } from "../recruiting/service.js";
import { parse } from "../http/validation.js";
import { transitionInput } from "../recruiting/schema.js";
import { interviewInput, interviewPatch, evaluationInput, interviewQuery, interviewDelete } from "./schema.js";
import { fail, found } from "../http/errors.js";
import { BusinessDictionaryService, validateOption } from '../business-config/dictionaries.js';
const writers = ["admin", "manager", "recruiter"];
export class InterviewService {
    identity;
    db;
    constructor(identity) {
        this.identity = identity;
        this.db = identity.db;
    }
    async members(c, ids, verifiedIds = new Set()) {
        const unique = [...new Set(ids)];
        const r = await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='active' AND directory_active AND roles&&ARRAY['admin','manager','recruiter','interviewer']::text[]", [unique]);
        if (unique.some(id => !r.rows.some(row => row.id === id) && !verifiedIds.has(id)))
            fail(422, "interviewer_invalid");
        return unique;
    }
    async overlaps(c, ids, start, duration, except) {
        return (await c.query("SELECT DISTINCT i.id,i.starts_at,i.duration_minutes FROM interviews i JOIN interviewers x ON x.interview_id=i.id WHERE x.user_id=ANY($1::uuid[]) AND i.deleted_at IS NULL AND i.status<>'cancelled' AND ($4::uuid IS NULL OR i.id<>$4) AND i.starts_at<$2::timestamptz+make_interval(mins=>$3) AND i.starts_at+make_interval(mins=>i.duration_minutes)>$2::timestamptz", [ids, start, duration, except || null])).rows;
    }
    async create(a, input, verifiedIds = new Set()) {
        requireRole(a, ...writers);
        const b = parse(interviewInput, input);
        return this.db.tx(async (c) => {
            // Consistent job -> application/child lock order, including explicit advance.
            await c.query('SELECT j.id FROM jobs j JOIN applications x ON x.job_id=j.id WHERE x.id=$1 FOR SHARE OF j', [b.applicationId]);
            await this.identity.applicationAccess(a, b.applicationId, true, c);
            const forms = (await new BusinessDictionaryService(this.identity).dictionary(a, 'interview_forms')).options;
            if (forms.some(o => o.id === b.form))
                validateOption(forms, b.form);
            const ids = await this.members(c, b.interviewerIds, verifiedIds), overlaps = await this.overlaps(c, ids, b.startsAt, b.durationMinutes);
            const primary = b.primaryInterviewerId || (ids.length === 1 ? ids[0] : null);
            if (!primary || !ids.includes(primary))
                fail(422, 'primary_interviewer_required');
            if (b.alsoAdvance && !b.stageConfirmation)
                fail(409, 'stage_confirmation');
            const row = (await c.query("INSERT INTO interviews(application_id,round,starts_at,duration_minutes,form,created_by,primary_interviewer_id,status,location,meeting_url,feedback) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *", [
                b.applicationId,
                b.round,
                b.startsAt,
                b.durationMinutes,
                b.form,
                a.id, primary, b.status, b.location, b.meetingUrl, b.feedback,
            ])).rows[0];
            for (const uid of ids)
                await c.query("INSERT INTO interviewers(interview_id,user_id,temporary_access) VALUES($1,$2,$3)", [row.id, uid, verifiedIds.has(uid)]);
            if (b.alsoAdvance) {
                if (!b.applicationVersion)
                    fail(422, "application_version_required");
                await new RecruitingService(this.identity).transitionTx(c, a, b.applicationId, parse(transitionInput, {
                    version: b.applicationVersion,
                    to: "interviewing",
                    confirm: b.stageConfirmation,
                    reason: b.stageConfirmation ? "人工确认安排并进入面试中" : "",
                    opinion: b.stageConfirmation ? '安排面试时显式确认推进' : '',
                }));
            }
            await this.identity.audit(c, a.id, "interview.create", row.id, {
                applicationId: b.applicationId,
                alsoAdvance: b.alsoAdvance,
            });
            await this.identity.audit(c, a.id, 'feishu.meeting.offered', row.id, { version: row.version });
            return { ...row, interviewerIds: ids, overlaps };
        });
    }
    async update(a, id, input, verifiedIds = new Set()) {
        requireRole(a, ...writers);
        const b = parse(interviewPatch, input);
        return this.db.tx(async (c) => {
            const row = found((await c.query("SELECT * FROM interviews WHERE id=$1 FOR UPDATE", [id]))
                .rows[0]);
            if (row.deleted_at)
                fail(409, 'interview_deleted');
            if (row.version !== b.version)
                fail(409, "version_conflict");
            if (b.form !== undefined) {
                const forms = (await new BusinessDictionaryService(this.identity).dictionary(a, 'interview_forms')).options;
                if (forms.some(o => o.id === b.form))
                    validateOption(forms, b.form, row.form);
            }
            await this.identity.applicationAccess(a, row.application_id, true, c);
            const ids = b.interviewerIds
                ? await this.members(c, b.interviewerIds, verifiedIds)
                : (await c.query("SELECT user_id FROM interviewers WHERE interview_id=$1", [id])).rows.map((x) => x.user_id);
            const primary = b.primaryInterviewerId || row.primary_interviewer_id || (ids.length === 1 ? ids[0] : null);
            if (!primary || !ids.includes(primary))
                fail(422, 'primary_interviewer_required');
            const start = b.startsAt || row.starts_at, duration = b.durationMinutes || row.duration_minutes, overlaps = await this.overlaps(c, ids, start, duration, id);
            const result = (await c.query("UPDATE interviews SET starts_at=$2,duration_minutes=$3,form=$4,status=$5,primary_interviewer_id=$6,location=$7,meeting_url=$8,feedback=$9,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [id, start, duration, b.form ?? row.form, b.status ?? row.status, primary, b.location ?? row.location, b.meetingUrl ?? row.meeting_url, b.feedback ?? row.feedback])).rows[0];
            if (b.interviewerIds) {
                const assignments = (await c.query('SELECT user_id,temporary_access FROM interviewers WHERE interview_id=$1', [id])).rows;
                const temporary = new Set([...assignments.filter(r => r.temporary_access).map(r => r.user_id), ...Array.from(verifiedIds).filter(uid => !assignments.some(r => r.user_id === uid))]);
                await c.query("DELETE FROM interviewers WHERE interview_id=$1", [id]);
                for (const uid of ids)
                    await c.query("INSERT INTO interviewers(interview_id,user_id,temporary_access) VALUES($1,$2,$3)", [id, uid, temporary.has(uid)]);
            }
            await this.identity.audit(c, a.id, "interview.edit", id, {
                version: result.version,
            });
            return { ...result, interviewerIds: ids, overlaps };
        });
    }
    async remove(a, id, input) {
        requireRole(a, ...writers);
        const b = parse(interviewDelete, input);
        return this.db.tx(async (c) => {
            // Share the calendar-creation lock: never remove an invitation in flight.
            const lock = (await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok', ['feishu-meeting:' + id])).rows[0];
            if (!lock.ok)
                fail(409, 'feishu_meeting_busy');
            const row = found((await c.query('SELECT * FROM interviews WHERE id=$1 FOR UPDATE', [id])).rows[0]);
            await this.identity.applicationAccess(a, row.application_id, true, c);
            if (row.version !== b.version)
                fail(409, 'version_conflict');
            const result = (await c.query('UPDATE interviews SET deleted_at=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,version,deleted_at', [id, b.restore ? null : new Date()])).rows[0];
            await this.identity.audit(c, a.id, b.restore ? 'interview.restore' : 'interview.delete', id, { applicationId: row.application_id, version: result.version });
            return result;
        });
    }
    async nextRound(a, applicationId) {
        requireRole(a, 'admin', 'manager', 'recruiter');
        await this.identity.applicationAccess(a, applicationId, true);
        if (!legacyKeys(await legacyDefinition(this.identity, a, 'interview'), a).has('round'))
            fail(403, 'field_read_forbidden');
        const round = Number((await this.db.query('SELECT coalesce(max(round),0)+1 n FROM interviews WHERE application_id=$1 AND deleted_at IS NULL', [applicationId])).rows[0].n);
        if (round > 50)
            fail(409, 'interview_round_limit');
        return { round };
    }
    async list(a) {
        requireRole(a, "admin", "manager", "recruiter", "interviewer");
        const all = a.roles.some((r) => writers.includes(r));
        const [definition, resume, job] = await Promise.all(['interview', 'resume', 'job'].map(kind => legacyDefinition(this.identity, a, kind)));
        return (await this.db.query("SELECT i.*,c.profile->>'name' candidate_name,j.name job_name,array_agg(x.user_id) interviewer_ids FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id JOIN interviewers x ON x.interview_id=i.id WHERE i.deleted_at IS NULL AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND ($1 OR (i.status<>'cancelled' AND EXISTS(SELECT 1 FROM interviewers y WHERE y.interview_id=i.id AND y.user_id=$2 AND NOT y.temporary_access))) GROUP BY i.id,c.id,j.id ORDER BY i.starts_at,i.id LIMIT 1000", [all, a.id])).rows.map(row => projectLegacyInterview(definition, resume, job, a, row));
    }
    async query(a, input) {
        requireRole(a, "admin", "manager", "recruiter", "interviewer");
        const q = parse(interviewQuery, input), all = a.roles.some(r => writers.includes(r));
        if (q.deleted && !all)
            fail(403, "forbidden");
        const [definition, resume, job] = await Promise.all(['interview', 'resume', 'job'].map(kind => legacyDefinition(this.identity, a, kind))), search = [...(legacyKeys(resume, a).has('name') ? ["c.profile->>'name'"] : []), ...(legacyKeys(job, a).has('name') ? ['j.name'] : [])];
        if (q.startsFrom)
            assertLegacyField(definition, a, 'startsAt');
        return this.db.tx(async (c) => {
            await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
            const where = "(i.deleted_at IS NOT NULL)=$4 AND a.deleted_at IS NULL AND c.deleted_at IS NULL AND ($1 OR (i.status<>'cancelled' AND EXISTS(SELECT 1 FROM interviewers y WHERE y.interview_id=i.id AND y.user_id=$2 AND NOT y.temporary_access))) AND " + (search.length ? "concat_ws(' '," + search.join(',') + ")" : "''") + " ILIKE $3 AND ($5::timestamptz IS NULL OR i.starts_at >= $5) AND ($6::timestamptz IS NULL OR i.starts_at < $6)", params = [all, a.id, "%" + q.query.replace(/[\\%_]/g, "\\$&") + "%", q.deleted, q.startsFrom || null, q.startsBefore || null], joins = " FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN jobs j ON j.id=a.job_id ";
            const total = Number((await c.query("SELECT count(*)" + joins + " WHERE " + where, params)).rows[0].count);
            const items = (await c.query("SELECT i.*,c.profile->>'name' candidate_name,j.name job_name,(SELECT name FROM users WHERE id=i.primary_interviewer_id) primary_interviewer_name,(SELECT open_id FROM users WHERE id=i.primary_interviewer_id) primary_open_id,(SELECT array_agg(x.user_id) FROM interviewers x WHERE x.interview_id=i.id) interviewer_ids" + joins + " WHERE " + where + " ORDER BY i.starts_at DESC,i.id LIMIT $7 OFFSET $8", [...params, q.pageSize, (q.page - 1) * q.pageSize])).rows;
            const decorated = await new Directory(this.identity).decorate(items, row => row.primary_open_id);
            return { items: decorated.map(({ primary_open_id, departments, ...row }) => projectLegacyInterview(definition, resume, job, a, { ...row, primary_interviewer_departments: departments })), total, page: q.page, pageSize: q.pageSize };
        });
    }
    async evaluationHistory(a, applicationId) {
        await this.identity.applicationAccess(a, applicationId);
        const privileged = a.roles.some(r => writers.includes(r));
        return (await this.db.query("SELECT e.id,e.interview_id,e.author_id,u.name author_name,i.round,max(v.version)::int latest_visible_version FROM evaluations e JOIN interviews i ON i.id=e.interview_id JOIN users u ON u.id=e.author_id JOIN evaluation_versions v ON v.evaluation_id=e.id WHERE i.application_id=$1 AND (e.author_id=$2 OR v.editor_id=$2 OR ($3 AND v.status='submitted')) GROUP BY e.id,u.id,i.id ORDER BY i.round,e.id", [applicationId, a.id, privileged])).rows;
    }
    async evaluationForInterview(a, id) {
        requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer');
        const interview = found((await this.db.query('SELECT * FROM interviews WHERE id=$1', [id])).rows[0]);
        if (a.temporaryScope)
            await this.identity.interviewActor(a, id);
        await this.identity.applicationAccess(a, interview.application_id);
        if (!interview.primary_interviewer_id && !a.temporaryScope)
            return null;
        const row = (await this.db.query('SELECT e.*,u.name author_name,ed.name editor_name FROM evaluations e JOIN users u ON u.id=e.author_id LEFT JOIN users ed ON ed.id=e.last_editor_id WHERE interview_id=$1 AND author_id=$2', [id, a.temporaryScope ? a.id : interview.primary_interviewer_id])).rows[0];
        if (!row)
            return null;
        if (row.author_id === a.id || row.last_editor_id === a.id)
            return row;
        if (!a.roles.some(r => writers.includes(r)))
            return null;
        const published = (await this.db.query("SELECT v.*,ed.name editor_name FROM evaluation_versions v LEFT JOIN users ed ON ed.id=v.editor_id WHERE evaluation_id=$1 AND v.status='submitted' ORDER BY version DESC LIMIT 1", [row.id])).rows[0];
        return published ? { ...row, data: published.data, configuration_refs: published.configuration_refs, version: published.version, status: published.status, last_editor_id: published.editor_id, editor_name: published.editor_name } : null;
    }
    async evaluate(a, id, input) {
        requireRole(a, 'admin', 'manager', 'recruiter', 'interviewer');
        const b = parse(evaluationInput, input), provided = Object.keys(input.data);
        return this.db.tx(async (c) => {
            const interview = found((await c.query('SELECT * FROM interviews WHERE id=$1 FOR SHARE', [id])).rows[0]);
            await this.identity.applicationAccess(a, interview.application_id, false, c);
            if (interview.deleted_at)
                fail(409, 'interview_deleted');
            if (interview.status === 'cancelled')
                fail(409, 'interview_cancelled');
            a = await this.identity.evaluationActor(a, id, b.forPrimary, c);
            const writer = a.roles.some(r => writers.includes(r));
            const owner = b.forPrimary ? interview.primary_interviewer_id : a.id;
            if (!owner)
                fail(422, 'primary_interviewer_required');
            if (b.forPrimary && owner !== a.id && !writer)
                fail(403, 'forbidden');
            if (!b.forPrimary && !a.temporaryScope && !(await c.query('SELECT 1 FROM interviewers WHERE interview_id=$1 AND user_id=$2 AND NOT temporary_access', [id, a.id])).rowCount)
                fail(403, 'forbidden');
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id + ':' + owner]);
            const old = (await c.query('SELECT * FROM evaluations WHERE interview_id=$1 AND author_id=$2 FOR UPDATE', [id, owner])).rows[0];
            if (old?.status === 'draft' && old.author_id !== a.id && old.last_editor_id !== a.id)
                fail(403, 'private_evaluation_draft');
            if ((old?.version || 0) !== b.version)
                fail(409, 'version_conflict');
            const snapshot = await evaluationSnapshot(this.identity, c, interview, old), template = validateEvaluationTemplate(snapshot.document);
            if (b.templateRef && (b.templateRef.configId !== snapshot.ref.configId || b.templateRef.version !== snapshot.ref.version))
                fail(409, 'configuration_changed');
            const data = mergeTemplateEvaluation(template, old?.data || {}, b.data, provided, b.status);
            const row = old ? (await c.query('UPDATE evaluations SET status=$2,data=$3,last_editor_id=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [old.id, b.status, data, a.id])).rows[0] : (await c.query('INSERT INTO evaluations(interview_id,author_id,status,data,last_editor_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, owner, b.status, data, a.id])).rows[0];
            await c.query('INSERT INTO evaluation_versions(evaluation_id,version,data,status,editor_id,configuration_refs) VALUES($1,$2,$3,$4,$5,$6)', [row.id, row.version, row.data, row.status, a.id, { evaluationTemplate: snapshot }]);
            await this.identity.audit(c, a.id, 'evaluation.save', row.id, { status: row.status, version: row.version, subjectUserId: owner, forPrimary: b.forPrimary });
            return { ...row, configuration_refs: { evaluationTemplate: snapshot }, template: { ...template, ref: snapshot.ref } };
        });
    }
    async evaluationVersions(a, id) {
        const source = found((await this.db.query("SELECT e.*,i.application_id FROM evaluations e JOIN interviews i ON i.id=e.interview_id WHERE e.id=$1", [id])).rows[0]);
        await this.identity.applicationAccess(a, source.application_id);
        const privileged = a.roles.some((r) => writers.includes(r));
        return (await this.db.query("SELECT v.*,e.author_id,e.interview_id,u.name author_name,ed.name editor_name FROM evaluation_versions v JOIN evaluations e ON e.id=v.evaluation_id JOIN users u ON u.id=e.author_id LEFT JOIN users ed ON ed.id=v.editor_id WHERE v.evaluation_id=$1 AND (e.author_id=$2 OR v.editor_id=$2 OR ($3 AND v.status='submitted')) ORDER BY v.version", [id, a.id, privileged])).rows;
    }
    async evaluationVersion(a, id, version) {
        const versions = await this.evaluationVersions(a, id), foundVersion = versions.find((v) => v.version === version);
        if (!foundVersion)
            fail(403, "forbidden");
        return foundVersion;
    }
    async evaluations(a, applicationId, onlySubmitted = false) {
        await this.identity.applicationAccess(a, applicationId);
        const privileged = a.roles.some(r => writers.includes(r));
        return (await this.db.query("SELECT e.id,e.interview_id,e.author_id,e.last_editor_id,e.created_at,v.version,v.data,v.status,v.configuration_refs,i.round FROM evaluations e JOIN interviews i ON i.id=e.interview_id JOIN LATERAL(SELECT * FROM evaluation_versions v WHERE v.evaluation_id=e.id AND (NOT $4 OR v.status='submitted') AND (e.author_id=$2 OR v.editor_id=$2 OR ($3 AND v.status='submitted')) ORDER BY v.version DESC LIMIT 1) v ON true WHERE i.application_id=$1 AND i.deleted_at IS NULL ORDER BY i.round,e.created_at,e.id", [applicationId, a.id, privileged, onlySubmitted])).rows;
    }
}
//# sourceMappingURL=service.js.map