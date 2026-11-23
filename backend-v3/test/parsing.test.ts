import test from "node:test";
import assert from "node:assert/strict";
import { parseProfile, encodeRaw, decodeRaw } from "../src/parsing/profile.js";
import { compareProfile } from "../src/parsing/match.js";
test("rule parser preserves original text including NUL and lone surrogate and emits exact evidence", () => {
  const raw =
    "姓名：测试员\n邮箱：test@example.invalid\n电话：13800000000\n毕业于浙江工业大学，本科\n5年工作经验，PyTorch、JavaScript\n首次就业：2020-03\n\u0000\ud800";
  assert.equal(decodeRaw(encodeRaw(raw)), raw);
  const p = parseProfile(raw);
  assert.equal(p.profile.name, "测试员");
  assert.equal(p.profile.education, "bachelor");
  assert.equal(p.profile.experienceYears, 5);
  assert.ok(p.profile.skills.includes("PyTorch"));
  assert.ok(!p.profile.skills.includes("Java"));
  for (const e of p.evidence) {
    assert.equal(raw.slice(e.start, e.end), e.text);
    assert.equal(e.line, raw.slice(0, e.start).split("\n").length);
  }
});
test("matching distinguishes absence, unknown and no requirement, and protected attributes do not affect professional score", () => {
  const raw =
    "姓名：测试员\n5年工作经验\n主要使用 JavaScript、Python\n项目：实现一个包含测试与监控的稳定服务。";
  const p = parseProfile(raw),
    job = {
      skills: ["Java", "Python"],
      experienceYears: 5,
      education: "bachelor" as const,
    };
  const m = compareProfile(p, raw, job);
  assert.equal(
    m.skills.find((x) => x.requirement === "Java")!.status,
    "not_matched",
  );
  assert.equal(
    m.skills.find((x) => x.requirement === "Python")!.status,
    "matched",
  );
  assert.equal(m.education.status, "unknown");
  assert.equal(m.score.lower, 55);
  assert.equal(m.score.upper, 55);
  assert.equal(m.score.provisional, true);
  const changed = raw + "\n性别：男，年龄：60";
  assert.deepEqual(
    compareProfile(parseProfile(changed), changed, job).score,
    m.score,
  );
  const base = compareProfile(parseProfile(""), "", {
    skills: [],
    experienceYears: null,
    education: null,
  });
  assert.equal(base.score.lower, 67);
  assert.equal(base.education.status, "not_applicable");
  assert.ok(
    compareProfile(parseProfile("短文"), "短文", job).warnings.includes(
      "short_raw",
    ),
  );
});

test("field-style work experience retains exact citation and matching does not repeat the same source range",()=>{
 const raw="姓名：字段验收\n工作经验：5年\n技能：Python";
 const p=parseProfile(raw);assert.equal(p.profile.experienceYears,5);
 const e=p.evidence.find(e=>e.field==="experienceYears")!;assert.equal(raw.slice(e.start,e.end),"5");
 const match=compareProfile(p,raw,{skills:["Python"],experienceYears:5});
 assert.equal(match.skills[0].evidence.length,1);
});

test('name extraction accepts spaced labels and keeps adjacent personal fields out of the name',()=>{
 for(const [raw,name] of [
  ['个人信息\n姓    名：杜小明\n出生日期：1990年8月','杜小明'],
  ['姓名：周小林 出生日期：2000年2月\n手机：13800000000','周小林'],
  ['姓 名：张 三\n性别：男','张三'],
  ['Name: Ada Lovelace Email: ada@example.invalid','Ada Lovelace'],
  ['姓名\n王小华\n求职意向：研发','王小华'],
 ] as const){
  const parsed=parseProfile(raw);assert.equal(parsed.profile.name,name);
  const e=parsed.evidence.find(e=>e.field==='name')!;assert.ok(e);assert.equal(raw.slice(e.start,e.end),e.text);
 }
});
test('a standalone name near the resume header is recognized, while section titles and employers are not names',()=>{
 assert.equal(parseProfile('个人简历\n李小明\n求职意向：开发工程师\n电话：13800000000').profile.name,'李小明');
 assert.equal(parseProfile('个人简历\n项目经验\n教育背景\n工作经历\n清华大学\n个人优势').profile.name,'待确认');
 assert.equal(parseProfile('姓名：待确认\n项目经历：实现服务').profile.name,'待确认');
 assert.equal(parseProfile('文档信息\n项目成果\n个人介绍\n其他内容').profile.name,'待确认');
});
test('contact and company labels cannot hijack the applicant name, and date tails never belong to a name',()=>{
 assert.notEqual(parseProfile('个人简历\n李小明\n紧急联系人姓名：王小华').profile.name,'王小华');
 assert.equal(parseProfile('Company Name: Acme Inc.\nName: Ada Lovelace').profile.name,'Ada Lovelace');
 for(const tail of ['出生日期 2000年2月','2000年2月'])assert.equal(parseProfile('姓名：周小林 '+tail).profile.name,'周小林');
 assert.equal(parseProfile('个人简历\n华为\n工作经历\n李小明').profile.name,'待确认');
});
test('an anonymous recruiting-platform salutation is retained without inventing a full name',()=>{
 const raw='简历编号：synthetic\n关联职位：组织发展\n段女士 在职，看看新机会\n邮箱：synthetic@example.invalid\n求职意向：组织发展\n工作经历：合成资料';
 assert.equal(parseProfile(raw).profile.name,'段女士');
 assert.equal(parseProfile('个人简历\n李小明\n求职意向：销售\n联系猎头\n王女士\n手机：13800000000').profile.name,'李小明');
});

// —— 2026-11-11 修复：同一行挤了多个字段时，所在地区/专业只取第一个值 ——
test('inline location and major stop before household registration and political status',()=>{
 const raw='姓名：合成履历\n现居住地：杭州·上城区   户籍 浙江·杭州   中共党员（含预备党员）\n专业：人力资源管理   政治面貌：中共党员\n邮箱：sample@example.invalid';
 const p=parseProfile(raw);
 assert.equal(p.profile.location,'杭州·上城区');
 assert.equal(p.profile.major,'人力资源管理');
 assert.ok(!String(p.profile.location).includes('党员'));
 const e=p.evidence.find(x=>x.field==='location')!;
 assert.equal(raw.slice(e.start,e.end),'杭州·上城区','原文证据也只覆盖地名');
});

test('major field boundaries preserve academic names containing demographic words',()=>{
 for(const major of ['民族学','中国少数民族语言文学','群众工作'])assert.equal(parseProfile('专业：'+major).profile.major,major);
 const parsed=parseProfile('专业：民族学  政治面貌：群众');
 assert.equal(parsed.profile.major,'民族学');
});
