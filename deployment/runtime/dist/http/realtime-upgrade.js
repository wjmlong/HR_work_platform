import http from 'node:http';
import { maintenanceResponse } from './maintenance.js';
/** A WebSocket stays on its selected API instance for its entire lifetime. */
export function realtimeUpgrades(server, origin, targets, maintenance) {
    let next = 0;
    const sockets = new Set();
    server.on('upgrade', (req, socket, head) => {
        const reject = (status) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
        if (req.headers.host !== origin.host || req.headers.origin !== origin.origin)
            return reject(403);
        if (req.method !== 'GET' || !/^\/api\/v4\/interviews\/[0-9a-f-]{36}\/assistant\/[0-9a-f-]{36}\/relay\?mode=(hints|voice)$/.test(req.url || '') || req.headers['transfer-encoding'] || req.headers['content-length'] || head.length > 65536)
            return reject(400);
        if (maintenanceResponse(req.url, maintenance()))
            return reject(503);
        const headers = { host: origin.host, origin: origin.origin, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': req.headers['sec-websocket-version'], 'sec-websocket-protocol': req.headers['sec-websocket-protocol'], cookie: req.headers.cookie, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress || 'unknown' };
        const upstream = http.request({ hostname: '127.0.0.1', port: targets[next++ % targets.length], method: 'GET', path: req.url, headers });
        let peer, done = false;
        const timer = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 15000);
        const cleanup = () => { if (done)
            return; done = true; clearTimeout(timer); upstream.destroy(); socket.destroy(); peer?.destroy(); sockets.delete(socket); if (peer)
            sockets.delete(peer); };
        sockets.add(socket);
        socket.on('error', cleanup);
        socket.on('close', cleanup);
        upstream.on('error', () => { reject(502); cleanup(); });
        upstream.on('response', response => { reject(response.statusCode || 502); response.resume(); cleanup(); });
        upstream.on('upgrade', (response, remote, rest) => {
            clearTimeout(timer);
            peer = remote;
            sockets.add(remote);
            remote.on('error', cleanup);
            remote.on('close', cleanup);
            const accept = response.headers['sec-websocket-accept'];
            if (response.statusCode !== 101 || typeof accept !== 'string' || response.headers['sec-websocket-protocol'] !== 'recruit-realtime') {
                cleanup();
                return;
            }
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: recruit-realtime\r\n\r\n');
            if (head.length)
                remote.write(head);
            if (rest.length)
                socket.write(rest);
            remote.pipe(socket);
            socket.pipe(remote);
        });
        upstream.end();
    });
    return () => { for (const socket of sockets)
        socket.destroy(); sockets.clear(); };
}
//# sourceMappingURL=realtime-upgrade.js.map