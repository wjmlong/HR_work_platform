import { mkdir, open, rename, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "../http/errors.js";
const formats = { '.pdf': 'pdf', '.docx': 'docx', '.txt': 'txt', '.doc': 'doc', '.wps': 'wps', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpeg', '.webp': 'webp' };
export const supportedResumeFile = (name) => typeof name === 'string' && Object.hasOwn(formats, path.extname(name).toLowerCase());
export class FileStore {
    root;
    constructor(root) {
        this.root = root;
    }
    path(key) {
        if (!/^[a-f0-9]{64}$/.test(key))
            fail(422, "invalid_blob");
        return path.join(this.root, key);
    }
    async put(name, data, kindOverride) {
        if (!data.length)
            fail(422, "empty_file");
        if (data.length > 10 * 1024 * 1024)
            fail(413, "file_too_large");
        const ext = path.extname(name).toLowerCase(), kind = kindOverride ||
            formats[ext];
        if (!kind)
            fail(422, "unsupported_format");
        if ((kind === 'doc' || kind === 'wps') && !data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
            fail(422, 'invalid_document');
        if (kind === 'png' && !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
            fail(422, 'invalid_document');
        if ((kind === 'jpg' || kind === 'jpeg') && !data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
            fail(422, 'invalid_document');
        if (kind === 'webp' && (data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WEBP'))
            fail(422, 'invalid_document');
        if (kind === "pdf" && !data.subarray(0, 5).equals(Buffer.from("%PDF-")))
            fail(422, "invalid_document");
        if (kind === "docx" &&
            (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50))
            fail(422, "invalid_document");
        const sha256 = createHash("sha256").update(data).digest("hex");
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const temp = path.join(this.root, ".tmp-" + randomUUID()), fh = await open(temp, "wx", 0o600);
        try {
            await fh.writeFile(data);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        try {
            await rename(temp, this.path(sha256));
        }
        catch (e) {
            await unlink(temp).catch(() => { });
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
    async read(key) {
        const data = await readFile(this.path(key));
        if (createHash("sha256").update(data).digest("hex") !== key)
            fail(503, "file_integrity_error");
        return data;
    }
}
//# sourceMappingURL=storage.js.map