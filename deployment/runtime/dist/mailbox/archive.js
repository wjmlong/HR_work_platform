import { constants } from 'node:fs';
import { open, realpath, readdir, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z, parse } from '../http/validation.js';
import { fail } from '../http/errors.js';
const mailboxId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const messageKey = z.string().regex(/^[a-f0-9]{64}$/);
const attachment = z.object({ id: z.string().regex(/^\d{1,3}$/), name: z.string().max(200), file: z.string().regex(/^attachment-\d{1,3}$/), size: z.number().int().min(0).max(64 * 1024 * 1024), sha256: messageKey, contentType: z.string().max(200), inline: z.boolean(), importable: z.boolean() });
const metadata = z.object({ id: messageKey, mailboxId, subject: z.string().max(2000), senderName: z.string().max(500), senderEmail: z.string().max(500), receivedAt: z.string().max(100), archivedAt: z.string().max(100), messageId: z.string().max(2000), rawSize: z.number().int().positive().max(64 * 1024 * 1024), rawSha256: messageKey, body: z.string().max(1024 * 1024), bodyWarning: z.string().max(300).optional(), attachments: z.array(attachment).max(200) });
export class MailboxArchive {
    root;
    constructor(root) {
        this.root = root;
    }
    async read(parts, limit) {
        try {
            const base = await realpath(this.root), expected = path.join(base, ...parts), resolved = await realpath(expected);
            if (resolved !== expected || !resolved.startsWith(base + path.sep))
                fail(422, 'invalid_mailbox_path');
            const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > limit)
                    fail(422, 'mailbox_file_limit');
                return await handle.readFile();
            }
            finally {
                await handle.close();
            }
        }
        catch (e) {
            if (e.code === 'ENOENT')
                fail(404, 'mailbox_not_found');
            throw e;
        }
    }
    async accounts() {
        let dirs;
        try {
            dirs = await readdir(this.root, { withFileTypes: true });
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return [];
            throw e;
        }
        const items = [];
        for (const dir of dirs) {
            if (!dir.isDirectory() || !mailboxId.safeParse(dir.name).success)
                continue;
            items.push(await this.status(dir.name));
        }
        return items;
    }
    async status(id) {
        parse(mailboxId, id);
        const raw = JSON.parse((await this.read([id, 'status.json'], 64 * 1024)).toString('utf8'));
        const status = parse(z.object({ id: mailboxId, account: z.string().max(300), state: z.enum(['syncing', 'ready', 'error']), messageCount: z.number().int().nonnegative().default(0), startedAt: z.string().optional(), lastSyncedAt: z.string().optional(), lastRequestId: z.string().nullable().optional(), updatedAt: z.string().optional(), error: z.string().max(300).optional() }), raw);
        return { ...status, stale: !status.updatedAt || Date.now() - Date.parse(status.updatedAt) > 180000 };
    }
    async list(id, query) {
        await this.status(id);
        const rows = parse(z.array(metadata.omit({ archivedAt: true, messageId: true, rawSize: true, rawSha256: true, body: true })).max(100000), JSON.parse((await this.read([id, 'index.json'], 32 * 1024 * 1024)).toString('utf8')));
        const q = query.q.trim().toLocaleLowerCase(), filtered = rows.filter(m => !q || [m.subject, m.senderName, m.senderEmail, ...m.attachments.map(a => a.name)].some(s => s.toLocaleLowerCase().includes(q)));
        return { items: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: filtered.length, page: query.page, pageSize: query.pageSize };
    }
    async message(id, key) { parse(mailboxId, id); parse(messageKey, key); const value = parse(metadata, JSON.parse((await this.read([id, 'messages', key, 'message.json'], 2 * 1024 * 1024)).toString('utf8'))); if (value.id !== key || value.mailboxId !== id)
        fail(422, 'invalid_mailbox_path'); return value; }
    async file(id, key, attachmentId) {
        const message = await this.message(id, key), a = attachmentId === undefined ? undefined : message.attachments.find(a => a.id === attachmentId);
        if (attachmentId !== undefined && !a)
            fail(404, 'mailbox_attachment_not_found');
        const data = await this.read([id, 'messages', key, a?.file || 'original.eml'], 64 * 1024 * 1024);
        if (createHash('sha256').update(data).digest('hex') !== (a?.sha256 || message.rawSha256))
            fail(503, 'mailbox_integrity_error');
        return { data, name: a?.name || '邮件原文.eml', attachment: a, message };
    }
    async synchronization(id, requestId) {
        parse(mailboxId, id);
        parse(z.uuid(), requestId);
        try {
            const result = JSON.parse((await this.read([id, 'requests', requestId + '.json'], 4096)).toString('utf8'));
            return { completed: result.requestId === requestId, state: 'ready' };
        }
        catch (e) {
            if (e.code !== 'mailbox_not_found')
                throw e;
            const status = await this.status(id);
            return { completed: false, state: status.state };
        }
    }
    async requestSync(id) {
        await this.status(id);
        const requestId = randomUUID(), base = await realpath(this.root), folder = await realpath(path.join(base, id));
        if (folder !== path.join(base, id))
            fail(422, 'invalid_mailbox_path');
        const temp = path.join(folder, '.request-' + requestId);
        await writeFile(temp, requestId, { mode: 0o600, flag: 'wx' });
        try {
            await link(temp, path.join(folder, 'sync.request'));
            return { accepted: true, requestId };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const pending = parse(z.uuid(), (await this.read([id, 'sync.request'], 100)).toString('utf8').trim());
            return { accepted: true, requestId: pending };
        }
        finally {
            await unlink(temp);
        }
    }
}
//# sourceMappingURL=archive.js.map