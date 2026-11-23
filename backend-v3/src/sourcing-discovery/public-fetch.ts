import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const)
    denied.addSubnet(address, prefix, 'ipv4');
export function publicAddress(ip: string) { return isIP(ip) === 4 && !denied.check(ip, 'ipv4'); }
export async function fetchPublicPage(url: string, hosts: string[], resolve: typeof lookup = lookup) { let current = new URL(url); for (let redirects = 0; redirects <= 3; redirects++) {
    if (current.protocol !== 'https:' || current.username || current.password || current.port && current.port !== '443' || !hosts.includes(current.hostname) || current.search || current.hash)
        throw Error('public_url_not_allowed');
    const records = await resolve(current.hostname, { all: true, family: 4 });
    if (!records.length || records.some(r => !publicAddress(r.address)))
        throw Error('private_address_blocked');
    const target = records[0];
    const result = await new Promise<{
        status: number;
        location?: string;
        text: string;
        type: string;
    }>((accept, reject) => { let done = false; const finish = (error?: Error, value?: any) => { if (done)
        return; done = true; clearTimeout(timer); error ? reject(error) : accept(value); }; const req = https.request(current, { method: 'GET', headers: { 'user-agent': 'RecruitSourcing/1.0 (public evidence review)', 'accept': 'text/html,text/plain' }, lookup: (_host, opts, cb: any) => opts.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family) }, res => { const chunks: Buffer[] = []; let size = 0; res.on('data', (c: Buffer) => { size += c.length; if (size > 100 * 1024) {
        finish(Error('page_too_large'));
        req.destroy();
    }
    else
        chunks.push(c); }); res.on('error', () => finish(Error('fetch_failed'))); res.on('end', () => finish(undefined, { status: res.statusCode || 0, location: res.headers.location, text: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] || '') })); }); const timer = setTimeout(() => { finish(Error('fetch_timeout')); req.destroy(); }, 10000); req.on('error', () => finish(Error('fetch_failed'))); req.end(); });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
        current = new URL(result.location, current);
        continue;
    }
    if (result.status !== 200)
        throw Error('source_unavailable');
    if (!/^text\/(html|plain)/i.test(result.type))
        throw Error('unsupported_content');
    const text = result.text.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 10000);
    if (text.length < 30)
        throw Error('source_body_missing');
    return { url: current.href, text, capturedAt: new Date().toISOString() };
} throw Error('redirect_limit'); }
