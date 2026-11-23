import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { FileStore } from "../src/files/storage.js";
import { extractFile } from "../src/files/extract.js";
// Controlled tiny ZIP builder produces a real DOCX container, no external fixture or private resume.
function zip(name: string, data: string) {
  const n = Buffer.from(name),
    d = Buffer.from(data);
  let crc = 0xffffffff;
  for (const b of d) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const l = Buffer.alloc(30);
  l.writeUInt32LE(0x04034b50);
  l.writeUInt32LE(crc, 14);
  l.writeUInt32LE(d.length, 18);
  l.writeUInt32LE(d.length, 22);
  l.writeUInt16LE(n.length, 26);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(d.length, 20);
  c.writeUInt32LE(d.length, 24);
  c.writeUInt16LE(n.length, 28);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50);
  e.writeUInt16LE(1, 8);
  e.writeUInt16LE(1, 10);
  e.writeUInt32LE(c.length + n.length, 12);
  e.writeUInt32LE(l.length + n.length + d.length, 16);
  return Buffer.concat([l, n, d, c, n, e]);
}
function pdf() {
  const parts = ["%PDF-1.4\n"],
    offsets = [0];
  let size = parts[0].length;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 44 >>\nstream\nBT /F1 12 Tf 50 700 Td (Python resume) Tj ET\nendstream",
  ];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(size);
    const v = i + 1 + " 0 obj\n" + objects[i] + "\nendobj\n";
    parts.push(v);
    size += v.length;
  }
  const start = size;
  parts.push(
    "xref\n0 6\n0000000000 65535 f \n" +
      offsets
        .slice(1)
        .map((x) => String(x).padStart(10, "0") + " 00000 n \n")
        .join("") +
      "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
      start +
      "\n%%EOF",
  );
  return Buffer.from(parts.join(""));
}
test("real PDF DOCX UTF8 GBK extraction, private atomic files, bounds and traversal rejection", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recruit-v3-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  for (const [name, data, want] of [
    ["简历.txt", Buffer.from("姓名：测试员\nPython"), "测试员"],
    ["gbk.txt", iconv.encode("姓名：合成人员", "gbk"), "合成人员"],
    [
      "简历.docx",
      zip(
        "word/document.xml",
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>姓名：文档员</w:t></w:r></w:p></w:body></w:document>',
      ),
      "文档员",
    ],
    ["resume.pdf", pdf(), "Python resume"],
  ] as const) {
    const file = await store.put(name, data);
    assert.deepEqual(await readFile(store.path(file.blobKey)), data);
    const x = await extractFile(store.path(file.blobKey), file.kind);
    assert.ok(x.includes(want), name);
  }
  const entities = await store.put(
    "entities.docx",
    zip(
      "word/document.xml",
      '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>R&amp;D &lt;test&gt;</w:t></w:r></w:p></w:document>',
    ),
  );
  assert.equal(
    (await extractFile(store.path(entities.blobKey), entities.kind)).trim(),
    "R&D <test>",
  );
  const empty = await store.put("empty.txt", Buffer.from(" \n"));
  assert.equal(
    (await extractFile(store.path(empty.blobKey), empty.kind)).trim(),
    "",
  );
  const bad = await store.put("bad.docx", zip("../evil", "bad"));
  await assert.rejects(
    extractFile(store.path(bad.blobKey), bad.kind),
    /invalid_document/,
  );
  await assert.rejects(
    store.put("a.doc", Buffer.from("old")),
    /unsupported_format/,
  );
  await assert.rejects(
    store.put("a.pdf", Buffer.from("not pdf")),
    /invalid_document/,
  );
  await assert.rejects(
    store.put("a.txt", Buffer.alloc(10 * 1024 * 1024 + 1)),
    /file_too_large/,
  );
  assert.throws(() => store.path("../secrets"), /invalid_blob/);
});

test("review: ordinary external hyperlinks are ignored while external content remains rejected", async (t) => {
  const { zipEntries } = await import("./zip.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "v3-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const document =
    '<w:document xmlns:w="urn:w"><w:p><w:hyperlink><w:r><w:t>GitHub 项目 Python</w:t></w:r></w:hyperlink></w:p></w:document>';
  const relation = (type: string) =>
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' +
    type +
    '" Target="https://example.invalid/cv" TargetMode="External"/></Relationships>';
  const good = await store.put(
    "link.docx",
    zipEntries([
      ["word/document.xml", document],
      ["word/_rels/document.xml.rels", relation("hyperlink")],
    ]),
  );
  assert.match(
    await extractFile(store.path(good.blobKey), good.kind),
    /GitHub 项目 Python/,
  );
  const bad = await store.put(
    "external.docx",
    zipEntries([
      ["word/document.xml", document],
      ["word/_rels/document.xml.rels", relation("aFChunk")],
    ]),
  );
  await assert.rejects(
    extractFile(store.path(bad.blobKey), bad.kind),
    /invalid_document/,
  );
});
