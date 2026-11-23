import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers.js";
test("real SQL enforces references and a failed transaction leaves no partial write", async () => {
  const { db, cleanup } = await testDatabase();
  try {
    const id = randomUUID();
    await assert.rejects(
      db.tx(async (c) => {
        await c.query("INSERT INTO candidates(id,profile) VALUES($1,$2)", [
          id,
          { name: "合成候选人" },
        ]);
        throw Error("cancel");
      }),
      /cancel/,
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM candidates")).rows[0].n,
      0,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO applications(candidate_id,job_id,status) VALUES($1,$2,$3)",
        [randomUUID(), randomUUID(), "screening"],
      ),
    );
    const again = await db.migrate();
    assert.equal(again, undefined);
    await db.query('INSERT INTO candidates(id,profile) VALUES($1,$2)',[id,{name:'Synthetic uniqueness'}]);
    const jobs=(await db.query("INSERT INTO jobs(name) VALUES('First'),('Second') RETURNING id")).rows;
    await db.query('INSERT INTO applications(candidate_id,job_id) VALUES($1,$2)',[id,jobs[0].id]);
    await assert.rejects(db.query('INSERT INTO applications(candidate_id,job_id) VALUES($1,$2)',[id,jobs[1].id]),(e:any)=>e.code==='23505');
  } finally {
    await cleanup();
  }
});
