// LAN peer discovery for Project Σ (modeled after TauriTavern's LanPeerDiscovery).
// Uses a zero-dependency UDP multicast + subnet broadcast beacon so two Project Σ instances
// on the same Wi-Fi / LAN discover each other automatically without needing a QR code or camera.
import dgram from 'node:dgram';
import os from 'node:os';
import { reachableAddresses } from './http.js';

const DISCOVERY_PORT = 47788;
const MULTICAST_ADDR = '239.255.77.88';
const ANNOUNCE_INTERVAL_MS = 10_000;
const PEER_TTL_MS = 45_000;
const PROTOCOL_MAGIC = 'sigma-lan-sync-v2';

export function detectPlatform() {
    if (process.env.TERMUX_VERSION || process.platform === 'android') return 'android';
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    if (process.platform === 'linux') return 'linux';
    return process.platform || 'device';
}

function subnetBroadcasts() {
    const out = new Set(['255.255.255.255']);
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
            const ipParts = a.address.split('.').map(Number);
            const maskParts = a.netmask.split('.').map(Number);
            if (ipParts.length === 4 && maskParts.length === 4) {
                const bcast = ipParts.map((b, i) => (b | (~maskParts[i] & 0xff))).join('.');
                out.add(bcast);
            }
        }
    }
    return [...out];
}

export function createLanDiscovery() {
    let localAnnouncement = null; // { id, name, platform, port, addresses, publicKey }
    const peers = new Map(); // deviceId -> { id, name, platform, port, addresses, publicKey, seenAt }
    let socket = null;
    let timer = null;

    function prune() {
        const cutoff = Date.now() - PEER_TTL_MS;
        for (const [id, p] of peers) {
            if (p.seenAt < cutoff) peers.delete(id);
        }
    }

    function onMessage(buf, rinfo) {
        let msg;
        try {
            msg = JSON.parse(buf.toString('utf8'));
        } catch {
            return;
        }
        if (!msg || msg.magic !== PROTOCOL_MAGIC) return;

        if (msg.type === 'query') {
            if (localAnnouncement && msg.id !== localAnnouncement.id) {
                sendAnnounce(rinfo.address, rinfo.port);
            }
            return;
        }

        if (msg.type === 'announce' && typeof msg.id === 'string' && msg.id) {
            if (msg.loopbackOnly) return;
            if (localAnnouncement && msg.id === localAnnouncement.id) return;
            const port = Number(msg.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return;
            const fromAddr = msg.loopbackOnly ? `127.0.0.1:${port}` : `${rinfo.address}:${port}`;
            const rawAddrs = Array.isArray(msg.addresses)
                ? msg.addresses.filter(a => typeof a === 'string' && /^[^\s/]+:\d{1,5}$/.test(a))
                : [];
            const addresses = [fromAddr, ...rawAddrs.filter(a => a !== fromAddr)].slice(0, 6);
            peers.set(msg.id, {
                id: msg.id,
                name: String(msg.name || 'Project Σ').slice(0, 60),
                platform: String(msg.platform || 'device').slice(0, 20),
                port,
                addresses,
                publicKey: typeof msg.publicKey === 'string' ? msg.publicKey : null,
                seenAt: Date.now(),
            });
        }
    }

    function sendPacket(payload, targets) {
        if (!socket) return;
        const data = Buffer.from(JSON.stringify(payload), 'utf8');
        for (const { address, port } of targets) {
            try {
                socket.send(data, 0, data.length, port, address);
            } catch { /* ignore interface errors */ }
        }
    }

    function broadcastTargets() {
        const targets = [{ address: MULTICAST_ADDR, port: DISCOVERY_PORT }];
        for (const bcast of subnetBroadcasts()) {
            targets.push({ address: bcast, port: DISCOVERY_PORT });
        }
        return targets;
    }

    function sendAnnounce(targetIp = null, targetPort = DISCOVERY_PORT) {
        if (!localAnnouncement || !socket) return;
        let addresses;
        if (localAnnouncement.loopbackOnly) {
            addresses = [`127.0.0.1:${localAnnouncement.port}`];
        } else {
            const ranked = reachableAddresses(localAnnouncement.port).filter(a => a.kind !== 'virtual');
            addresses = ranked.slice(0, 4).map(a => a.address);
        }
        const payload = {
            magic: PROTOCOL_MAGIC,
            type: 'announce',
            id: localAnnouncement.id,
            name: localAnnouncement.name,
            platform: localAnnouncement.platform,
            port: localAnnouncement.port,
            loopbackOnly: Boolean(localAnnouncement.loopbackOnly),
            addresses,
            publicKey: localAnnouncement.publicKey,
        };
        if (targetIp) {
            sendPacket(payload, [{ address: targetIp, port: targetPort }]);
        } else {
            sendPacket(payload, broadcastTargets());
        }
    }

    function sendQuery() {
        if (!socket) return;
        sendPacket({
            magic: PROTOCOL_MAGIC,
            type: 'query',
            id: localAnnouncement?.id || '',
        }, broadcastTargets());
    }

    function ensureSocket() {
        if (socket) return;
        try {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            sock.on('error', () => { /* ignore UDP bind errors in restricted sandboxes */ });
            sock.on('message', onMessage);
            sock.bind(DISCOVERY_PORT, () => {
                try {
                    sock.setBroadcast(true);
                } catch { /* ignore */ }
                try {
                    sock.addMembership(MULTICAST_ADDR);
                    sock.setMulticastTTL(2);
                    sock.setMulticastLoopback(true);
                } catch { /* ignore when multicast unavailable */ }
                sendAnnounce();
                sendQuery();
            });
            sock.unref?.();
            socket = sock;
            timer = setInterval(() => {
                prune();
                sendAnnounce();
            }, ANNOUNCE_INTERVAL_MS);
            timer.unref?.();
        } catch {
            socket = null;
        }
    }

    return {
        announce(info) {
            if (process.env.CL_LAN_SYNC_NO_DISCOVERY === '1') return;
            if (!info?.id || !info?.port || info.loopbackOnly) return;
            localAnnouncement = {
                id: info.id,
                name: String(info.name || 'Project Σ').slice(0, 60),
                platform: info.platform || detectPlatform(),
                port: Number(info.port),
                loopbackOnly: Boolean(info.loopbackOnly),
                publicKey: info.publicKey || null,
            };
            ensureSocket();
            sendAnnounce();
        },
        query() {
            if (process.env.CL_LAN_SYNC_NO_DISCOVERY === '1') return;
            if (localAnnouncement?.loopbackOnly) return;
            ensureSocket();
            sendQuery();
            sendAnnounce();
        },
        snapshot() {
            prune();
            return [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
        },
        recordProbedPeer(peer) {
            if (!peer?.id || !peer?.address) return;
            const existing = peers.get(peer.id);
            const addresses = [peer.address, ...(existing?.addresses || []).filter(a => a !== peer.address)].slice(0, 6);
            peers.set(peer.id, {
                id: peer.id,
                name: String(peer.name || existing?.name || 'Project Σ').slice(0, 60),
                platform: String(peer.platform || existing?.platform || 'device').slice(0, 20),
                port: Number(peer.port) || existing?.port || 7788,
                addresses,
                publicKey: peer.publicKey || existing?.publicKey || null,
                seenAt: Date.now(),
            });
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (socket) {
                try { socket.close(); } catch { /* ignore */ }
                socket = null;
            }
        },
    };
}
