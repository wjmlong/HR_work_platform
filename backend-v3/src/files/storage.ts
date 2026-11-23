import { mkdir, open, rename, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "../http/errors.js";
export type Kind = "pdf" | "docx" | "txt" | "paste";
export class FileStore {
  constructor(readonly root: string) {}
  path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail(422, "invalid_blob");
    return path.join(this.root, key);
  }
  async put(name: string, data: Buffer, kindOverride?: "paste") {
    if (!data.length) fail(422, "empty_file");
    if (data.length > 10 * 1024 * 1024) fail(413, "file_too_large");
    const ext = path.extname(name).toLowerCase(),
      kind: Kind =
        kindOverride ||
        (
          { ".pdf": "pdf", ".docx": "docx", ".txt": "txt" } as Record<
            string,
            Kind
          >
        )[ext];
    if (!kind) fail(422, "unsupported_format");
    if (kind === "pdf" && !data.subarray(0, 5).equals(Buffer.from("%PDF-")))
      fail(422, "invalid_document");
    if (
      kind === "docx" &&
      (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50)
    )
      fail(422, "invalid_document");
    const sha256 = createHash("sha256").update(data).digest("hex");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = path.join(this.root, ".tmp-" + randomUUID()),
      fh = await open(temp, "wx", 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(temp, this.path(sha256));
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
    return {
      blobKey: sha256,
      sha256,
      kind,
      size: data.length,
      name: path
        .basename(name)
        .replace(/[\r\n\0]/g, "")
        .slice(0, 200),
    };
  }
  async read(key: string) {
    const data = await readFile(this.path(key));
    if (createHash("sha256").update(data).digest("hex") !== key)
      fail(503, "file_integrity_error");
    return data;
  }
}
