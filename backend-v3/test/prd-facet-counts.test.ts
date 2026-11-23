import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase, actor } from "./helpers.js";
import { Identity } from "../src/identity/service.js";
import { FeishuProvider } from "../src/identity/provider.js";
import { SourcingService } from "../src/sourcing/service.js";
test("multivalue facet counts count people once even when imported skill and direction arrays repeat or contain padding", async (t) => {
  const { db, config, cleanup } = await testDatabase();
  t.after(cleanup);
  const a = await actor(db),
    s = new SourcingService(
      new Identity(db, config, new FeishuProvider(config)),
    );
  await db.query(
    "INSERT INTO leads(name,org,school,skills,direction,source,line,owner_id) VALUES('Synthetic A','Synthetic','X',ARRAY['Python','Python',' Python '],'AI / AI','其他','high',$1),('Synthetic B','Synthetic','Y',ARRAY['Python','Rust'],'AI / Data','其他','high',$1)",
    [a.id],
  );
  const all = await s.query(a, {}),
    count = (facet: string, value: string) =>
      all.facets[facet].find((r: any) => r.value === value)?.count;
  assert.equal(all.total, 2);
  assert.equal(count("skills", "Python"), 2);
  assert.equal(count("skills", "Rust"), 1);
  assert.equal(count("direction", "AI"), 2);
  assert.equal(count("direction", "Data"), 1);
  const selected = await s.query(a, {
    filters: { school: ["X"], skills: ["Python"] },
  });
  assert.equal(selected.total, 1);
  assert.equal(
    selected.facets.skills.find((r: any) => r.value === "Python")?.count,
    1,
  );
  assert.equal(
    selected.facets.school.find((r: any) => r.value === "Y")?.count,
    1,
  );
});
