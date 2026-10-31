// The two ways the server half talks: to its own Σ over the public HTTP API (so every write it makes is a
// write like the app's own: guarded, reported on the change feed, seen by every open tab), and to a paired
// device's server half with signed requests.
import os from 'node:os';
import { signHeaders } from './crypto.js';

const EXT_ROOT = '/api/ext/lan-sync';

const bareIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
const hostPart = (ip) => (ip.includes(':') ? `[${ip}]` : ip);

/** This server's own address, as the request reached it. */
export function localBase(req) {
    return `http://${hostPart(bareIp(req.socket.localAddress) || '127.0.0.1')}:${req.socket.localPort}`;
}

/** The address a request came from, without its IPv4-in-IPv6 prefix. */
export const remoteIp = (req) => bareIp(req.socket.remoteAddress);

/** The address the server listens on, and whether only this machine can reach it. */
export function listenInfo(req) {
    const address = req.socket.server?.address?.();
    const host = typeof address === 'object' && address ? bareIp(address.address) : '';
    return { host, loopbackOnly: host === '127.0.0.1' || host === '::1' || host === 'localhost' };
}

// 100.64.0.0/10 is the shared range Tailscale and other overlay networks hand out
const isOverlay = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** The IPv4 addresses another device may reach this one by, network addresses first. */
export function reachableAddresses(port) {
    const out = [];
    for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            if (a.address.startsWith('169.254.')) continue;
            const kind = isOverlay(a.address) ? 'overlay' : isPrivate(a.address) ? 'lan' : 'other';
            out.push({ address: `${a.address}:${port}`, ip: a.address, iface, kind });
        }
    }
    const rank = { lan: 0, overlay: 1, other: 2 };
    return out.sort((x, y) => rank[x.kind] - rank[y.kind]);
}

async function errorOf(resp) {
    const text = await resp.text().catch(() => '');
    let said = '';
    try { said = JSON.parse(text)?.error || ''; } catch { /* not JSON */ }
    const err = new Error(said || text.slice(0, 200) || `HTTP ${resp.status}`);
    err.status = resp.status;
    return err;
}

const withTimeout = (signal, ms) => (ms ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)) : signal);

/** A client for this server's own API, at the address the request reached it on. */
export function localClient(base) {
    const request = async (path, { method = 'GET', json, body, headers = {}, signal, ok = true } = {}) => {
        const init = { method, headers: { ...headers }, signal };
        if (json !== undefined) {
            init.body = JSON.stringify(json);
            init.headers['Content-Type'] = 'application/json';
        } else if (body !== undefined) {
            init.body = body;
            // a stream body is sent as it arrives
            if (typeof body?.getReader === 'function' || typeof body?.pipe === 'function') init.duplex = 'half';
        }
        const resp = await fetch(`${base}${path}`, init);
        if (ok && !resp.ok) throw await errorOf(resp);
        return resp;
    };
    return {
        base,
        request,
        json: async (path, opts) => (await request(path, opts)).json(),
    };
}

/** A client for a paired device's server half: every request signed with the pair's secret. */
export function peerClient({ address, deviceId, secret }) {
    const base = `http://${address}`;
    const request = async (path, { method = 'GET', json, signal, timeout = 30_000 } = {}) => {
        const full = `${EXT_ROOT}${path}`;
        const bodyText = method === 'GET' ? '' : JSON.stringify(json ?? {});
        const headers = signHeaders({ deviceId, secret }, method, full, bodyText);
        if (method !== 'GET') headers['Content-Type'] = 'application/json';
        let resp;
        try {
            resp = await fetch(`${base}${full}`, { method, headers, body: method === 'GET' ? undefined : bodyText, signal: withTimeout(signal, timeout) });
        } catch (e) {
            if (signal?.aborted) throw e;
            throw new Error(`could not reach ${address}: ${e.cause?.code || e.message}`);
        }
        if (!resp.ok) throw await errorOf(resp);
        return resp;
    };
    return {
        address,
        request,
        json: async (path, opts) => (await request(path, opts)).json(),
    };
}

/** An unsigned call to another device's pairing routes, which answer only to the pairing code. */
export async function pairingCall(address, path, json, { timeout = 5000, signal } = {}) {
    const resp = await fetch(`http://${address}${EXT_ROOT}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
        signal: withTimeout(signal, timeout),
    });
    if (!resp.ok) throw await errorOf(resp);
    return resp.json();
}
