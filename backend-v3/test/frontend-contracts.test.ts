import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor, httpSession } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { SourcingService } from "../src/sourcing/service.js";
import { RecruitingService } from "../src/recruiting/service.js";
import { Worker } from "../src/tasks/worker.js";
import { FileStore } from "../src/files/storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
test("PRD UI: contact/timeliness facets share exact query/export/metrics semantics and setup supports independent multiple targets", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    id = new Identity(db, config, new FeishuProvider(config)),
    s = new SourcingService(id);
  const one = await s.create(a, {
      name: "逾期测试",
      org: "组织",
      direction: "专业",
      source: "其他",
      line: "high",
      contact: "工作主页",
    }),
    two = await s.create(a, {
      name: "新线索",
      org: "组织",
      direction: "专业",
      source: "其他",
      line: "focus",
    });
  await db.query(
    "UPDATE leads SET created_at=now()-interval '8 days' WHERE id=$1",
    [one.id],
  );
  const q = {
    filters: { contactAvailability: ["present"], followupAge: ["overdue"] },
  };
  const r = await s.query(a, q as any);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].id, one.id);
  assert.equal(
    r.facets.contactAvailability.find((v: any) => v.value === "present").count,
    1,
  );
  assert.equal((await s.metrics(a, q as any)).total, 1);
  assert.ok(!(await s.csv(a, q as any)).includes("新线索"));
  await s.setup(a, {
    targetJob: "两个岗位",
    targetJobs: ["岗位A", "岗位B"],
    line: "high",
    lines: ["high", "social"],
    exclusions: ["已拒绝"],
    saveTemplate: true,
  } as any);
  assert.deepEqual((await s.getSetup(a)).lines, ["high", "social"]);
  assert.equal((await s.query(a, {})).total, 2);
});
test("PRD UI: upload provenance, searchable paginated applications, and safe public static assets", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-ui-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  config.storageRoot = dir;
  const { app, headers, actor: a } = await httpSession(db, config);
  t.after(() => app.close());
  const r = new RecruitingService(
      new Identity(db, config, new FeishuProvider(config)),
    ),
    j = await r.createJob(a, {level:"P5", name: "UI岗位" });
  const upload = await app.inject({
    method: "POST",
    url: "/api/v4/uploads/text",
    headers: { ...headers, "idempotency-key": "ui-upload" },
    payload: {
      jobId: j.id,
      text: "姓名：界面回归\nPython 工程项目验证",
      source: "内推",
      note: "来源核对",
    },
  });
  assert.equal(upload.statusCode, 200);
  const w = new Worker(
    new Identity(db, config, new FeishuProvider(config)),
    new FileStore(dir),
    "ui-worker",
  );
  await w.once();
  const record = (await db.query("SELECT * FROM applications")).rows[0];
  assert.equal(record.source, "内推");
  assert.equal(record.note, "来源核对");
  const result = await r.applications(a, { query: "界面回归" });
  assert.equal(result.total, 1);
  assert.equal((await r.applications(a, { query: "不存在" })).total, 0);
  const bad = await app.inject({
    url: "/assets/..%2f.env",
    headers: { host: headers.host, "x-forwarded-proto": "https" },
  });
  assert.ok([400, 404, 422].includes(bad.statusCode));
  assert.ok(!bad.body.includes(config.secret));
});
test("PRD UI: built static UI is public on canonical HTTPS, with correct MIME and traversal protection", async (t) => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-static-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  (config as any).webRoot = dir;
  await mkdir(path.join(dir, "assets"));
  await writeFile(
    path.join(dir, "index.html"),
    '<html lang="zh-CN"><title>招聘工作台</title><div id="root"></div></html>',
  );
  await writeFile(
    path.join(dir, "assets/app-123.js"),
    'console.log("static test")',
  );
  const { buildApp } = await import("../src/http/app.js");
  const app = await buildApp({ db, config });
  t.after(() => app.close());
  const headers = {
    host: new URL(config.origin).host,
    "x-forwarded-proto": "https",
  };
  const root = await app.inject({ url: "/", headers });
  assert.ok(root.body.includes('id="root"'));
  await writeFile(path.join(dir,'assets/chunk.es-123.js'),'export const n=1');
  assert.equal((await app.inject({url:'/assets/chunk.es-123.js',headers})).statusCode,200);
  const asset = await app.inject({ url: "/assets/app-123.js", headers });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"]!, /javascript/);
  assert.equal(
    (
      await app.inject({
        url: "/assets/app-123.js",
        headers: { ...headers, "x-forwarded-proto": "http" },
      })
    ).statusCode,
    421,
  );
});

test("PRD UI: grant edits retain existing members and interview history names remain discoverable only to authorized staff", async t => {
  const {db,config,cleanup}=await testDatabase();t.after(cleanup);
  const {app,headers,actor:a}=await httpSession(db,config);t.after(()=>app.close());
  const id=new Identity(db,config,new FeishuProvider(config));
  const recruiting=new RecruitingService(id), j=await recruiting.createJob(a,{level:"P5",name:"日程岗位"});
  const dir=await mkdtemp(path.join(os.tmpdir(),"v3-ui-assign-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  config.storageRoot=dir;
  const {TaskService}=await import("../src/tasks/service.js");
  await new TaskService(id,new FileStore(dir)).upload(a,{jobId:j.id,name:"合成.txt",data:Buffer.from(JSON.stringify("姓名：日程验收\n5年工作经验 Python")),paste:true});
  await new Worker(id,new FileStore(dir),"ui-history").once();
  const application=(await db.query("SELECT * FROM applications")).rows[0];
  const viewer=await actor(db,["viewer"]);
  const put=await app.inject({method:"PUT",url:`/api/v4/applications/${application.id}/grants`,headers:{...headers,"idempotency-key":"grant-history"},payload:{version:application.version,userIds:[viewer.id]}});
  assert.equal(put.statusCode,200,put.body);
  const get=await app.inject({url:`/api/v4/applications/${application.id}/grants`,headers});
  assert.equal(get.statusCode,200,get.body);assert.deepEqual(get.json().data.userIds,[viewer.id]);assert.equal(get.json().data.version,2);
  const {InterviewService}=await import("../src/interviews/service.js");const interviews=new InterviewService(id);
  const meeting=await interviews.create(a,{applicationId:application.id,round:1,startsAt:"2030-01-01T09:00:00Z",durationMinutes:60,form:"合成",interviewerIds:[a.id]});
  await interviews.update(a,meeting.id,{version:1,status:"cancelled"});
  const list=await interviews.list(a);assert.equal(list.length,1);assert.equal(list[0].candidate_name,"日程验收");assert.equal(list[0].job_name,"日程岗位");
  const other=await actor(db,["interviewer"]);assert.equal((await interviews.list(other)).length,0);
});

test("PRD sourcing searches Chinese state/line names and splits research-direction facets",async t=>{
 const {db,config,cleanup}=await testDatabase();t.after(cleanup);const a=await actor(db),s=new SourcingService(new Identity(db,config,new FeishuProvider(config)));
 const one=await s.create(a,{name:"研究验收",org:"合成",direction:"机器学习 / 大模型",source:"其他",line:"high"});
 const result=await s.query(a,{query:"未联系 高端线"} as any);assert.equal(result.total,1);
 assert.deepEqual(result.facets.direction.map((f:any)=>f.value),["大模型","机器学习"]);
 assert.equal((await s.query(a,{filters:{direction:["机器学习"]}} as any)).items[0].id,one.id);
});
