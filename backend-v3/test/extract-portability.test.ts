import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
test("source extraction resolves its TS loader from the installed module when invoked outside backend cwd", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recruit-extract-cwd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "synthetic.txt");
  await writeFile(file, "Synthetic source text");
  const script =
    "import {extractFile} from " +
    JSON.stringify(new URL("../src/files/extract.ts", import.meta.url).href) +
    ";const value=await extractFile(" +
    JSON.stringify(file) +
    ',"txt");if(value!=="Synthetic source text")throw Error("wrong_text");';
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: dir, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(r.status, 0, r.stderr);
});
