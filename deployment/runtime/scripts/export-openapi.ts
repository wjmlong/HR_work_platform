import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig,readEnvironment,ROOT } from "../src/config.js";
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import { Database } from "../src/db.js";
import { buildApp } from "../src/http/app.js";
// buildApp initializes the catalog. Never point documentation generation at
// a live database schema, including before the release has been upgraded.
const schema='recruit_test_openapi'+randomBytes(8).toString('hex'),db=new Database(loadConfig({...readEnvironment(),RECRUIT_V4_SCHEMA:schema}));
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
try {
  await db.migrate();app=await buildApp({db,config:db.config});
  await app.ready();
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--output'))throw Error('Usage: export-openapi [--output FILE]');
  const output=args.length?path.resolve(args[1]):path.resolve(ROOT,'../docs/api/openapi.v4.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(app.swagger(), null, 2) + "\n",
  );
  console.log(JSON.stringify({exported:true,isolated:true,schema,output}));
} finally {
  await app?.close();
  await db.query('DROP SCHEMA "'+schema+'" CASCADE');
  await db.close();
}
