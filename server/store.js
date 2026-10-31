// What one account keeps: its device identity, its paired devices, its auto-sync config, and the digests
// of its last scan. All of it lives in the account's own folder (ctx.files.user), never in the library,
// so a sync never carries it.
import os from 'node:os';
import { randomId } from './crypto.js';
import { detectPlatform } from './discovery.js';

const DEFAULT_AUTOMATION = {
    enabled: false,
    intervalMinutes: 30,
    targetId: '',
    mode: 'incremental',
};

export function makeStore(files) {
    const identity = () => {
        let id = files.readJson('identity.json', null);
        if (!id?.deviceId) {
            id = { deviceId: randomId(12), platform: detectPlatform(), createdAt: Date.now() };
            files.writeJson('identity.json', id);
        } else if (!id.platform) {
            id = { ...id, platform: detectPlatform() };
            files.writeJson('identity.json', id);
        }
        return id;
    };

    const readPeers = () => {
        const doc = files.readJson('peers.json', null);
        return Array.isArray(doc?.peers) ? doc.peers : [];
    };
    const writePeers = (peers) => files.writeJson('peers.json', { peers });

    const automation = () => {
        const doc = files.readJson('automation.json', null);
        if (!doc || typeof doc !== 'object') return { ...DEFAULT_AUTOMATION };
        return {
            enabled: doc.enabled === true,
            intervalMinutes: [5, 15, 30, 60, 180, 360, 720, 1440].includes(Number(doc.intervalMinutes))
                ? Number(doc.intervalMinutes)
                : 30,
            targetId: typeof doc.targetId === 'string' ? doc.targetId : '',
            mode: doc.mode === 'mirror' ? 'mirror' : 'incremental',
        };
    };
    const saveAutomation = (patch) => {
        const next = { ...automation(), ...patch };
        files.writeJson('automation.json', next);
        return next;
    };

    return {
        identity,
        peers: readPeers,
        peer: (id) => readPeers().find(p => p.id === id) || null,
        /** Add or replace a paired device by its id, preserving local customName/aliases if already set. */
        savePeer(peer) {
            const existing = readPeers().find(p => p.id === peer.id);
            const merged = existing
                ? {
                    ...existing,
                    ...peer,
                    customName: peer.customName !== undefined ? peer.customName : existing.customName,
                    aliases: peer.aliases !== undefined ? peer.aliases : existing.aliases,
                }
                : peer;
            const peers = readPeers().filter(p => p.id !== peer.id);
            peers.push(merged);
            writePeers(peers);
            return merged;
        },
        /** Merge fields onto a paired device; answers it, or null when it is not paired. */
        updatePeer(id, fields) {
            const peers = readPeers();
            const at = peers.findIndex(p => p.id === id);
            if (at < 0) return null;
            peers[at] = { ...peers[at], ...fields };
            writePeers(peers);
            return peers[at];
        },
        removePeer(id) {
            const peers = readPeers();
            const kept = peers.filter(p => p.id !== id);
            writePeers(kept);
            return kept.length !== peers.length;
        },
        automation,
        saveAutomation,
        digestCache: () => files.readJson('digest-cache.json', null) || { chars: {}, chats: {} },
        saveDigestCache: (cache) => files.writeJson('digest-cache.json', cache),
    };
}

/** The name this device goes by: the account's setting, else the machine's name. */
export function deviceName(setting) {
    const named = String(setting || '').trim();
    if (named) return named.slice(0, 60);
    const host = os.hostname();
    return host && host !== 'localhost' ? host.slice(0, 60) : 'Project Σ';
}
