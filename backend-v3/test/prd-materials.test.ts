import {PINNED_COMPAT_ALGORITHM} from '../src/business-config/bindings.js';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { TaskService } from "../src/tasks/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
import { MaterialService } from "../src/materials/service.js";
import { Dictionary } from "../src/dictionary/service.js";
import { parseProfile, encodeRaw, decodeRaw } from "../src/parsing/profile.js";
import { compareProfile, ALGORITHM } from "../src/parsing/match.js";
import { applyCorrections } from "../src/parsing/corrections.js";

test("PRD manual supplement removes only the corrected missing-field warning and retains its human provenance", () => {
  const p = applyCorrections(parseProfile("姓名：合成补充"), [
    {
      field: "phone",
      value: "13800000000",
      actorId: "synthetic",
      reason: "人工核对原件",
      at: "2026-10-19T00:00:00Z",
    },
  ]);
  assert.equal(p.profile.phone, "13800000000");
  assert.ok(!p.warnings.includes("missing_phone"));
  assert.ok(p.warnings.includes("missing_email"));
  assert.equal(p.assertions[0].reason, "人工核对原件");
});

test("PRD reference score uses fixed 60/25/15 weights, one education rank deduction, baselines and honest unknown fields", () => {
  const raw = "姓名：合成校验\n本科\n3年工作经验\n技能：Python";
  const compared = compareProfile(parseProfile(raw), raw, {
    skills: ["Python", "Java"],
    experienceYears: 5,
    education: "master",
  });
  assert.equal(compared.skillPoints, 30);
  assert.equal(compared.experience.points, 15);
  assert.equal(compared.education.points, 7);
  assert.equal(compared.score.value, 52);
  assert.equal(compared.score.lower, 52);
  assert.equal(compared.score.upper, 52);
  assert.equal(compared.education.status, "not_matched");
  assert.equal(compared.score.color, "orange");
  const empty = compareProfile(parseProfile(""), "", { skills: [] });
  assert.equal(empty.score.value, 67);
  assert.equal(empty.skillPoints, 42);
  assert.equal(empty.experience.points, 13);
  assert.equal(empty.education.points, 12);
  const unknown = compareProfile(parseProfile("技能：Python"), "技能：Python", {
    skills: ["Python"],
    experienceYears: 5,
    education: "bachelor",
  });
  assert.equal(unknown.education.status, "unknown");
  assert.equal(unknown.education.actual, null);
  assert.equal(unknown.score.value, 73);
  assert.equal(unknown.score.upper, 73);
  assert.ok(unknown.score.unknownFields.includes("education"));
  assert.deepEqual(
    compareProfile(
      parseProfile(raw + "\n年龄：60\n性别：女"),
      raw + "\n年龄：60\n性别：女",
      { skills: ["Python", "Java"], experienceYears: 5, education: "master" },
    ).score,
    compared.score,
  );
});

test("PRD profile keeps bachelor school separate, extracts company/city/intent and never infers age from graduation", () => {
  const raw =
    "姓名：合成履历\n本科院校：浙江工业大学\n硕士院校：上海交通大学\n专业：机械工程\n工作单位：杭州合成科技有限公司\n首次就业：2019-07\n所在城市：杭州\n求职意向：算法工程师\n毕业时间：2019年\n技能：torch\n邮箱：sample@example.invalid";
  const p = parseProfile(raw, undefined, new Date("2026-10-19T00:00:00Z"));
  assert.equal(p.profile.bachelorSchool, "浙江工业大学");
  assert.equal(p.profile.school, "上海交通大学");
  assert.deepEqual(p.profile.companies, ["杭州合成科技有限公司"]);
  assert.equal(p.profile.location, "杭州");
  assert.equal(p.profile.intent, "算法工程师");
  assert.equal(p.profile.age, null);
  assert.equal(p.profile.gender, "");
  assert.equal(p.profile.experienceYears, 7);
  assert.ok(p.profile.skills.includes("PyTorch"));
  assert.ok(p.warnings.includes("missing_phone"));
  assert.ok(!p.warnings.includes("missing_email"));
  assert.equal(decodeRaw(encodeRaw(raw)), raw);
  for (const e of p.evidence) assert.equal(raw.slice(e.start, e.end), e.text);
});

test("PRD comparison evidence includes original sentence, bounded context, individual missing fields and optional school preference", () => {
  const line =
      "前文".repeat(100) +
      "<script>Python</script> 项目已由人工复核" +
      "后文".repeat(100),
    raw = "姓名：合成人\n" + line + "\n本科院校：浙江工业大学\n本科";
  const m = compareProfile(parseProfile(raw), raw, {
    skills: ["Python", "Java"],
    schoolPreferences: ["浙江工业大学"],
  });
  assert.equal(m.school.status, "matched");
  assert.equal(m.skills[1].evidence.length, 0);
  const e = m.skills[0].evidence[0];
  assert.equal(e.line, 2);
  assert.ok(e.context.text.length <= 160);
  assert.ok(e.context.text.includes("<script>Python</script>"));
  assert.equal(raw.slice(e.context.start, e.context.end), e.context.text);
  assert.equal(m.evidenceAbsentText, "简历原文中未检索到相关内容");
  for (const key of [
    "missing_phone",
    "missing_email",
    "missing_experienceYears",
    "missing_location",
  ])
    assert.ok(m.warnings.includes(key));
  assert.ok(m.statement.includes("不构成淘汰结论"));
  const above = compareProfile(parseProfile("10年工作经验"), "10年工作经验", {
    skills: [],
    experienceYears: 3,
    experienceMaxYears: 5,
  });
  assert.equal(above.experience.status, "not_matched");
  assert.equal(above.experience.points, 25); // Formula uses minimum; comparison still shows the full interval.
});

async function context(t: any, skills = ["Python", "Java"]) {
  const f = await testDatabase();
  t.after(f.cleanup);
  const root = await mkdtemp(path.join(os.tmpdir(), "prd-materials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = await actor(f.db),
    identity = new Identity(f.db, f.config, new FeishuProvider(f.config)),
    store = new FileStore(root),
    r = new RecruitingService(identity),
    tasks = new TaskService(identity, store),
    worker = new Worker(identity, store, "prd-worker"),
    materials = new MaterialService(identity, store);
  await new Dictionary(f.db).seed();
  const job = await r.createJob(a, {
      name: "Synthetic grouped questions",
      level: "P5",
      requirements: { skills },
    }),
    upload = await tasks.upload(a, {
      name: "fixture.txt",
      data: Buffer.from(
        "姓名：合成题库\n本科\n技能：Python\u0000\n5年工作经验\n项目结果、约束与具体职责由面试官结合事实进一步核对。\n原句中含有控制字符\u0000也必须保留。",
      ),
      jobId: job.id,
    });
  await worker.once();
  const done = await tasks.get(a, upload.id);
  assert.equal(done.state, "succeeded");
  return {
    ...f,
    a,
    r,
    job,
    tasks,
    worker,
    materials,
    applicationId: done.result.applicationId,
  };
}
test("PRD question set has six groups 2/2/2/4/3/3 and one first-missing-skill probe, all with usable points and immutable revisions", async (t) => {
  const f = await context(t),
    q = await f.materials.questions(f.a, f.applicationId);
  const groups = [
    "开场破冰",
    "自我介绍",
    "离职动机",
    "行为面试（STAR）",
    "专业深挖",
    "风险核对",
  ];
  assert.deepEqual(
    groups.map(
      (g) => q.data.questions.filter((x: any) => x.group === g).length,
    ),
    [2, 2, 2, 4, 3, 3],
  );
  assert.equal(q.data.questions.length, 17);
  const weak = q.data.questions.find((x: any) => x.group === "弱项专项");
  assert.equal(weak.skill, "Java");
  assert.ok(
    weak.referencePoints
      .join(" ")
      .includes("坦诚+学习路径也算过，含糊应付不算"),
  );
  for (const item of q.data.questions)
    assert.ok(
      item.prompt &&
        item.referencePoints.length &&
        item.source &&
        item.followups.length,
    );
  assert.equal(
    q.data.statement,
    "要点是参考答案（达标线），用于面试官判分与人事做面试官训练；不是让候选人背的标准答案。",
  );
  const edited = await f.materials.editQuestions(f.a, q.id, {
    version: 1,
    questions: q.data.questions.map((x: any, i: number) => ({
      ...x,
      prompt: i === 0 ? "人工补充问题" : x.prompt,
    })),
  });
  assert.equal(edited.version, 2);
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM material_versions WHERE material_id=$1",
        [q.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (await f.r.application(f.a, f.applicationId)).status,
    "screening",
  );
});
test("PRD algorithm upgrades queue existing current resumes once and self-heal without changing any human workflow", async (t) => {
  const f = await context(t);
  await f.db.query(
    "UPDATE match_snapshots SET algorithm_version='old-rule' WHERE application_id=$1",
    [f.applicationId],
  );
  assert.equal((await f.tasks.matches(f.a, f.applicationId)).stale, true);
  assert.equal(await f.worker.enqueueStaleMatches(), 1);
  assert.equal(await f.worker.enqueueStaleMatches(), 0);
  await f.worker.once();
  const match = await f.tasks.matches(f.a, f.applicationId);
  assert.equal(match.stale, false);
  assert.equal(match.latest.algorithm_version, PINNED_COMPAT_ALGORITHM);
  assert.ok(
    match.latest.data.skills
      .find((s: any) => s.requirement === "Python")
      .evidence[0].context.text.includes("\u0000"),
  );
  const list = await f.r.applications(f.a, {});
  assert.equal(list.items[0].match.score.value, match.latest.data.score.value);
  assert.equal(
    (await f.r.application(f.a, f.applicationId)).status,
    "screening",
  );
});

test("PRD generic school label follows the explicitly declared highest degree without being displaced by a later bachelor school", () => {
  const raw =
    "姓名：合成院校核对\n学历：硕士\n学校：合成大学\n本科院校：合成理工学院";
  const parsed = parseProfile(raw);
  assert.equal(parsed.profile.school, "合成大学");
  assert.equal(parsed.profile.bachelorSchool, "合成理工学院");
});
test("PRD expected salary remains a source-backed fact and never changes reference score", () => {
  const raw =
    "姓名：合成期望\n技能：Python\n5年工作经验\n学历：本科\n期望薪资：30-40k，14薪";
  const p = parseProfile(raw);
  assert.equal(p.profile.expectedSalary, "30-40k，14薪");
  assert.ok(
    p.evidence.some(
      (e) =>
        e.field === "expectedSalary" && raw.slice(e.start, e.end) === e.text,
    ),
  );
  assert.deepEqual(
    compareProfile(p, raw, { skills: ["Python"] }).score,
    compareProfile(
      parseProfile(raw.replace("期望薪资：30-40k，14薪", "期望薪资：15-20k")),
      raw.replace("期望薪资：30-40k，14薪", "期望薪资：15-20k"),
      { skills: ["Python"] },
    ).score,
  );
});
