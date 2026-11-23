import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
export async function extractFile(file, kind, options = {}) {
    const source = import.meta.url.endsWith(".ts"), child = fileURLToPath(new URL(source ? "./extract-child.ts" : "./extract-child.js", import.meta.url));
    return new Promise((resolve, reject) => {
        const proc = fork(child, [], {
            execArgv: [
                ...(source ? ["--import", import.meta.resolve("tsx")] : []),
                "--max-old-space-size=256",
                "--disallow-code-generation-from-strings",
            ],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
        });
        let done = false;
        const finish = (text) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            proc.kill("SIGKILL");
            if (typeof text === "string" && text.length <= 2 * 1024 * 1024)
                resolve(text);
            else
                reject(Error("invalid_document"));
        };
        const timer = setTimeout(() => finish(), 15000);
        proc.once("error", () => finish());
        proc.once("exit", () => finish());
        proc.on("message", (m) => finish(m?.ok === true ? m.text : undefined));
        proc.send({ file, kind, maxPages: options.maxPages || 100 });
    });
}
//# sourceMappingURL=extract.js.map