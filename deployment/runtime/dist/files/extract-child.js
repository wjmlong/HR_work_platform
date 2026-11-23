import { readFile } from "node:fs/promises";
import yauzl from "yauzl";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import iconv from "iconv-lite";
async function docx(data) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
            if (err || !zip) {
                reject(Error("zip"));
                return;
            }
            let count = 0, total = 0, xml, settled = false;
            const bad = () => {
                if (settled)
                    return;
                settled = true;
                zip.close();
                reject(Error("zip"));
            };
            zip.on("error", bad);
            zip.on("entry", (entry) => {
                count++;
                total += entry.uncompressedSize;
                if (count > 200 ||
                    total > 20 * 1024 * 1024 ||
                    entry.uncompressedSize > 10 * 1024 * 1024 ||
                    entry.fileName.split("/").some((x) => x === "..") ||
                    entry.fileName.startsWith("/") ||
                    /[\\:]/.test(entry.fileName) ||
                    /\.(exe|dll|js|vbs|bin)$/i.test(entry.fileName) ||
                    /vbaProject/i.test(entry.fileName)) {
                    bad();
                    return;
                }
                zip.openReadStream(entry, (error, stream) => {
                    if (error || !stream) {
                        bad();
                        return;
                    }
                    const parts = [];
                    let size = 0;
                    stream.on("error", bad);
                    stream.on("data", (chunk) => {
                        size += chunk.length;
                        if (size > 10 * 1024 * 1024)
                            bad();
                        else
                            parts.push(chunk);
                    });
                    stream.on("end", () => {
                        if (settled)
                            return;
                        const bytes = Buffer.concat(parts);
                        if (entry.fileName.endsWith(".rels")) {
                            const relXml = bytes.toString("utf8");
                            if (/<!DOCTYPE|<!ENTITY/i.test(relXml) ||
                                XMLValidator.validate(relXml) !== true) {
                                bad();
                                return;
                            }
                            const rels = new XMLParser({ ignoreAttributes: false }).parse(relXml)?.Relationships?.Relationship;
                            for (const rel of rels
                                ? Array.isArray(rels)
                                    ? rels
                                    : [rels]
                                : []) {
                                if (rel["@_TargetMode"] === "External" &&
                                    !/^https?:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/hyperlink$/.test(rel["@_Type"] || "")) {
                                    bad();
                                    return;
                                }
                                // Hyperlinks are text only: targets are never opened or fetched.
                            }
                        }
                        if (entry.fileName === "word/document.xml") {
                            if (xml !== undefined) {
                                bad();
                                return;
                            }
                            xml = bytes.toString("utf8");
                        }
                        zip.readEntry();
                    });
                });
            });
            zip.on("end", () => {
                if (settled)
                    return;
                settled = true;
                try {
                    if (!xml ||
                        /<!DOCTYPE|<!ENTITY/i.test(xml) ||
                        XMLValidator.validate(xml) !== true)
                        throw Error("xml");
                    const parsed = new XMLParser({
                        preserveOrder: true,
                        ignoreAttributes: true,
                        processEntities: true,
                        trimValues: false,
                    }).parse(xml);
                    const walk = (node) => Array.isArray(node)
                        ? node.map(walk).join("")
                        : node && typeof node === "object"
                            ? Object.entries(node)
                                .map(([k, v]) => k === "#text"
                                ? String(v)
                                : k === "w:tab"
                                    ? "\t"
                                    : k === "w:br"
                                        ? "\n"
                                        : walk(v) + (k === "w:p" ? "\n" : ""))
                                .join("")
                            : "";
                    resolve(walk(parsed));
                }
                catch {
                    reject(Error("xml"));
                }
            });
            zip.readEntry();
        });
    });
}
async function extract(file, kind, maxPages = 100) {
    const data = await readFile(file);
    if (data.length > 10 * 1024 * 1024)
        throw Error("limit");
    if (kind === "paste")
        return JSON.parse(data.toString("utf8"));
    if (kind === "txt") {
        if (data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])))
            return iconv.decode(data, "utf16-le");
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(data);
        }
        catch {
            return iconv.decode(data, "gb18030");
        }
    }
    if (kind === "docx")
        return docx(data);
    if (kind === "pdf") {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = getDocument({
            data: new Uint8Array(data),
            useSystemFonts: false,
            disableFontFace: true,
            stopAtErrors: true,
        });
        const pdf = await task.promise;
        try {
            if (pdf.numPages > maxPages)
                throw Error("pages");
            const pages = [];
            let size = 0;
            for (let n = 1; n <= pdf.numPages; n++) {
                const content = await (await pdf.getPage(n)).getTextContent();
                let text = "";
                for (const item of content.items)
                    if ("str" in item)
                        text += item.str + (item.hasEOL ? "\n" : " ");
                size += text.length;
                if (size > 2 * 1024 * 1024)
                    throw Error("limit");
                pages.push(text);
            }
            return pages.join("\n");
        }
        finally {
            await task.destroy();
        }
    }
    throw Error("format");
}
process.once("message", async (m) => {
    try {
        const text = await extract(m.file, m.kind, Number.isInteger(m.maxPages) && m.maxPages > 0 && m.maxPages <= 100 ? m.maxPages : 100);
        if (text.length > 2 * 1024 * 1024)
            throw Error("limit");
        process.send?.({ ok: true, text });
    }
    catch {
        process.send?.({ ok: false });
    }
});
//# sourceMappingURL=extract-child.js.map