// LAN Sync, the server half. Three groups of routes under /api/ext/lan-sync:
//   the page's own (status, nearby discovery, pairing, paired devices, automation, pull and push),
//   pairing (/peer/pair/*: unsigned, answering either to a live QR code or a direct LAN/manual pairing request),
//   peer (/peer/*: signed with a paired device's secret, read-only views of this library).
// A paired device can read this library and ask it to pull; nothing a peer sends writes here directly.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { parsePairLink, buildPairLink } from '../client/pair-link.js';
import { randomId, keyPair, deriveSecret, shortCode, hmac, safeEqual, verifySignature } from './crypto.js';
import { makeStore, deviceName } from './store.js';
import { createLanDiscovery, detectPlatform } from './discovery.js';
import { localBase, localClient, peerClient, pairingCall, firstReachable, listenInfo, reachableAddresses, remoteIp } from './http.js';
import { buildManifestFromDb, buildFileManifest, walk, chatRows, characterWorlds, playlistMembers, DATASETS, enabledLanSyncExtensions } from './manifest.js';
import { runPull, createDbSnapshot, resolveMediaFile, mergeDuplicateCharacter } from './sync.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5;
const enc = encodeURIComponent;

function normalizeManualAddress(raw) {
    let s = String(raw || '').trim().replace(/\/+$/, '');
    s = s.replace(/^https?:\/\//i, '');
    if (!s) return null;
    if (!/:\d{1,5}$/.test(s)) s = `${s}:7788`;
    if (!/^[^\s/]+:\d{1,5}$/.test(s)) return null;
    return s;
}

export function register(router, ctx) {
    // a pairing offer per account: its code, its key pair and the requests it has heard
    const offers = new Map();
    // direct (QR-less) pairing requests per account: from nearby discovery or manual IP
    const directRequests = new Map(); // handle -> Map<requestId, request>
    // persistent X25519 keypair per account for QR-less nearby / manual pairing
    const directKeysByHandle = new Map();
    // UDP multicast/broadcast LAN discovery
    const discovery = createLanDiscovery();
    // background auto-sync state per account
    const autoStates = new Map();

    const getDirectKeys = (handle) => {
        let keys = directKeysByHandle.get(handle);
        if (!keys) {
            keys = keyPair();
            directKeysByHandle.set(handle, keys);
        }
        return keys;
    };

    const getDirectRequestMap = (handle) => {
        let map = directRequests.get(handle);
        if (!map) {
            map = new Map();
            directRequests.set(handle, map);
        }
        const now = Date.now();
        for (const [id, r] of map) {
            if (r.expiresAt + 2 * 60 * 1000 < now) map.delete(id);
        }
        return map;
    };

    const parts = (req) => {
        const store = makeStore(ctx.files.user(req));
        const me = store.identity();
        const name = deviceName(ctx.setting(req.db, 'deviceName'));
        const port = req.socket.localPort;
        const listen = listenInfo(req);
        const handle = req.userHandle || 'default';
        const dKeys = getDirectKeys(handle);
        discovery.announce({
            id: me.deviceId,
            name,
            platform: me.platform || detectPlatform(),
            port,
            loopbackOnly: listen.loopbackOnly,
            publicKey: dKeys.publicKey,
        });
        return {
            store,
            me,
            name,
            platform: me.platform || detectPlatform(),
            local: localClient(localBase(req)),
            port,
            listen,
            handle,
            directKeys: dKeys,
        };
    };

    const syncOptions = (db) => ({
        characters: ctx.setting(db, 'syncCharacters') !== false,
        chats: ctx.setting(db, 'syncChats') !== false,
        lorebooks: ctx.setting(db, 'syncLorebooks') !== false,
        personas: ctx.setting(db, 'syncPersonas') !== false,
        presets: ctx.setting(db, 'syncPresets') !== false,
        playlists: ctx.setting(db, 'syncPlaylists') !== false,
        backgrounds: ctx.setting(db, 'syncBackgrounds') !== false,
        settings: ctx.setting(db, 'syncSettings') !== false,
        connections: ctx.setting(db, 'syncConnections') === true,
        secrets: ctx.setting(db, 'syncSecrets') === true,
        mode: ctx.setting(db, 'mode') === 'mirror' ? 'mirror' : 'incremental',
        overwrite: ctx.setting(db, 'overwrite') === 'prefer-newer' ? 'prefer-newer' : 'exact',
    });

    // without accounts every request is the owner's; with them, a paired device has no session to call with
    router.use((req, res, next) => {
        if (ctx.multiUser) return res.status(409).json({ error: 'LAN Sync needs a server without accounts for now' });
        next();
    });

    const liveOffer = (handle) => {
        const offer = offers.get(handle);
        if (offer && offer.expiresAt + 2 * 60 * 1000 < Date.now()) { offers.delete(handle); return null; }
        return offer || null;
    };

    const collectPendingRequests = (handle) => {
        const offer = liveOffer(handle);
        const fromOffer = offer ? [...offer.requests.values()].filter(r => r.status === 'pending') : [];
        const dMap = getDirectRequestMap(handle);
        const fromDirect = [...dMap.values()].filter(r => r.status === 'pending' && r.expiresAt > Date.now());
        return [...fromOffer, ...fromDirect].map(r => ({
            id: r.id,
            name: r.device.name,
            platform: r.device.platform || 'device',
            address: r.ip,
            code: r.sas,
        }));
    };

    // ── background auto-sync scheduler (TauriTavern SyncAutomationService style) ──

    const ensureAutomationTimer = (req) => {
        const { store, me, port, handle } = parts(req);
        const db = req.db;
        let st = autoStates.get(handle);
        if (!st) {
            st = {
                timer: null,
                running: false,
                nextRunAtMs: null,
                lastAttemptAtMs: null,
                lastAcceptedAtMs: null,
                lastErrorAtMs: null,
                lastError: '',
            };
            autoStates.set(handle, st);
        }
        const cfg = store.automation();
        if (!cfg.enabled || !cfg.targetId) {
            if (st.timer) {
                clearInterval(st.timer);
                st.timer = null;
            }
            st.nextRunAtMs = null;
            return st;
        }
        const intervalMs = cfg.intervalMinutes * 60 * 1000;
        if (!st.timer || st.intervalMs !== intervalMs) {
            if (st.timer) clearInterval(st.timer);
            st.intervalMs = intervalMs;
            st.nextRunAtMs = Date.now() + intervalMs;
            st.timer = setInterval(async () => {
                const latestCfg = store.automation();
                if (!latestCfg.enabled || !latestCfg.targetId || st.running) return;
                const record = store.peer(latestCfg.targetId);
                if (!record) {
                    st.lastError = 'Selected auto-sync target device is no longer paired';
                    st.lastErrorAtMs = Date.now();
                    return;
                }
                const discovered = discovery.snapshot().find(d => d.id === record.id);
                const targetAddress = discovered?.addresses?.[0] || record.address;
                st.running = true;
                st.lastAttemptAtMs = Date.now();
                try {
                    const { mode: _m, ...options } = syncOptions(db);
                    const peer = peerClient({ address: targetAddress, deviceId: me.deviceId, secret: record.secret });
                    await peer.json('/peer/pull-request', { method: 'POST', json: { port, options }, timeout: 10_000 });
                    store.updatePeer(record.id, { address: targetAddress, lastPushRequestAt: Date.now() });
                    st.lastAcceptedAtMs = Date.now();
                    st.lastError = '';
                    st.lastErrorAtMs = null;
                } catch (e) {
                    st.lastError = e.message || String(e);
                    st.lastErrorAtMs = Date.now();
                } finally {
                    st.running = false;
                    st.nextRunAtMs = Date.now() + latestCfg.intervalMinutes * 60 * 1000;
                }
            }, intervalMs);
            st.timer.unref?.();
        }
        return st;
    };

    // ── this device & discovery ─────────────────────────────

    router.get('/status', (req, res) => {
        const { store, me, name, platform, port, handle } = parts(req);
        const offer = liveOffer(handle);
        const listen = listenInfo(req);
        const autoState = ensureAutomationTimer(req);
        const discovered = discovery.snapshot().filter(d => d.id !== me.deviceId);
        const discoveredById = new Map(discovered.map(d => [d.id, d]));

        const peers = store.peers().map((p) => {
            const live = discoveredById.get(p.id);
            let address = p.address;
            let peerPlatform = p.platform || 'device';
            if (live) {
                if (live.addresses?.[0] && live.addresses[0] !== p.address) {
                    address = live.addresses[0];
                    store.updatePeer(p.id, { address, name: live.name || p.name, platform: live.platform || p.platform });
                } else if (live.platform && live.platform !== p.platform) {
                    peerPlatform = live.platform;
                    store.updatePeer(p.id, { platform: peerPlatform });
                }
            }
            const { secret, aliases, ...rest } = p;
            return {
                ...rest,
                address,
                platform: peerPlatform,
                online: Boolean(live),
            };
        });

        const pairedIds = new Set(peers.map(p => p.id));
        const nearby = discovered
            .filter(d => !pairedIds.has(d.id))
            .map(d => ({
                id: d.id,
                name: d.name,
                platform: d.platform || 'device',
                address: d.addresses?.[0] || '',
                addresses: d.addresses || [],
            }));

        res.json({
            device: { id: me.deviceId, name, platform },
            port,
            loopbackOnly: listen.loopbackOnly,
            addresses: listen.loopbackOnly
                ? [{ address: `127.0.0.1:${port}`, ip: '127.0.0.1', iface: 'loopback', kind: 'loopback' }]
                : reachableAddresses(port),
            pairing: offer && !offer.closed && offer.expiresAt > Date.now() ? { expiresAt: offer.expiresAt } : null,
            requests: collectPendingRequests(handle),
            peers,
            nearby,
            automation: {
                config: store.automation(),
                status: {
                    running: autoState.running,
                    nextRunAtMs: autoState.nextRunAtMs,
                    lastAttemptAtMs: autoState.lastAttemptAtMs,
                    lastAcceptedAtMs: autoState.lastAcceptedAtMs,
                    lastErrorAtMs: autoState.lastErrorAtMs,
                    lastError: autoState.lastError,
                },
            },
            jobs: ctx.jobs.list(req.db),
        });
    });

    router.post('/discovery/refresh', (req, res) => {
        const { me } = parts(req);
        discovery.query();
        const discovered = discovery.snapshot().filter(d => d.id !== me.deviceId);
        res.json({ nearby: discovered });
    });

    router.patch('/automation', (req, res) => {
        const { store } = parts(req);
        const body = req.body || {};
        const patch = {};
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
        if (body.intervalMinutes !== undefined) patch.intervalMinutes = Number(body.intervalMinutes);
        if (typeof body.targetId === 'string') patch.targetId = body.targetId.trim();
        if (body.mode === 'mirror' || body.mode === 'incremental') patch.mode = body.mode;
        const config = store.saveAutomation(patch);
        const st = ensureAutomationTimer(req);
        res.json({
            config,
            status: {
                running: st.running,
                nextRunAtMs: st.nextRunAtMs,
                lastAttemptAtMs: st.lastAttemptAtMs,
                lastAcceptedAtMs: st.lastAcceptedAtMs,
                lastErrorAtMs: st.lastErrorAtMs,
                lastError: st.lastError,
            },
        });
    });

    // ── pairing: the device that shows the QR code or receives a direct LAN request ──

    router.post('/pairing/start', (req, res) => {
        const { me, name, port, handle } = parts(req);
        // a server bound to loopback can still pair with another Σ on this same machine
        const loopbackOnly = listenInfo(req).loopbackOnly;
        // virtual adapters ride the code only when nothing better exists; three addresses keep the code small
        const ranked = reachableAddresses(port);
        const usable = ranked.filter(a => a.kind !== 'virtual');
        const addresses = loopbackOnly ? [`127.0.0.1:${port}`] : (usable.length ? usable : ranked).slice(0, 3).map(a => a.address);
        if (!addresses.length) return res.status(409).json({ error: 'This machine has no network address another device could reach' });
        const warning = loopbackOnly
            ? 'This Σ only listens on this machine, so only another Σ on this machine can pair. Set host to 0.0.0.0 in data/server.yaml (or CL_HOST) and restart it to pair a phone.'
            : null;
        const keys = keyPair();
        const offer = { code: randomId(12), expiresAt: Date.now() + PAIRING_TTL_MS, keys, requests: new Map(), closed: false };
        offers.set(handle, offer);
        const link = buildPairLink({ id: me.deviceId, name, addresses, code: offer.code, expiresAt: offer.expiresAt, key: keys.publicKey }, port);
        res.json({ link, expiresAt: offer.expiresAt, addresses, warning });
    });

    router.post('/pairing/stop', (req, res) => {
        const { handle } = parts(req);
        offers.delete(handle);
        res.json({ ok: true });
    });

    router.get('/pairing/requests', (req, res) => {
        const { handle } = parts(req);
        res.json({ requests: collectPendingRequests(handle) });
    });

    router.post('/pairing/requests/:rid', (req, res) => {
        const { store, me, handle } = parts(req);
        const offer = liveOffer(handle);
        const dMap = getDirectRequestMap(handle);
        const fromOffer = offer?.requests.get(req.params.rid);
        const fromDirect = dMap.get(req.params.rid);
        const request = fromOffer || fromDirect;
        if (!request || request.status !== 'pending') return res.status(404).json({ error: 'That pairing request is gone' });
        if (req.body?.allow !== true) {
            request.status = 'denied';
            return res.json({ ok: true, status: 'denied' });
        }
        const privateKey = fromOffer ? offer.keys.privateKey : request.offerKeys.privateKey;
        const code = fromOffer ? offer.code : request.code;
        const secret = deriveSecret(privateKey, request.key, { code, offerId: me.deviceId, joinId: request.device.id });
        store.savePeer({
            id: request.device.id,
            name: request.device.name,
            platform: request.device.platform || 'device',
            address: `${request.ip}:${request.port}`,
            secret,
            pairedAt: Date.now(),
        });
        request.status = 'approved';
        request.proof = hmac(secret, `paired|${request.id}`);
        if (fromOffer) {
            // one device a code: once approved, the offer answers only the device it approved
            offer.closed = true;
        }
        res.json({ ok: true, status: 'approved' });
    });

    // ── pairing: the routes the joining device calls (QR code or direct LAN / manual IP) ──

    router.get('/peer/pair/info', (req, res) => {
        const { me, name, platform, port, directKeys } = parts(req);
        res.json({
            id: me.deviceId,
            name,
            platform,
            port,
            key: directKeys.publicKey,
        });
    });

    router.post('/peer/pair/request', (req, res) => {
        const { me, handle, directKeys } = parts(req);
        const { code, direct, device, key, port } = req.body || {};
        if (typeof device?.id !== 'string' || !device.id || typeof key !== 'string') {
            return res.status(400).json({ error: 'A pairing request names its device and its key' });
        }
        if (device.id === me.deviceId) return res.status(400).json({ error: 'A device cannot pair with itself' });
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            return res.status(400).json({ error: 'A pairing request names its port' });
        }

        // Direct QR-less pairing (from nearby discovery or manual IP connection)
        if (direct === true) {
            const dMap = getDirectRequestMap(handle);
            const pendingCount = [...dMap.values()].filter(r => r.status === 'pending').length;
            if (pendingCount >= MAX_PENDING) {
                return res.status(429).json({ error: 'Too many pairing requests are waiting' });
            }
            const id = randomId(9);
            const directCode = String(code || randomId(12));
            dMap.set(id, {
                id,
                code: directCode,
                offerKeys: directKeys,
                device: {
                    id: device.id,
                    name: String(device.name || 'A device').slice(0, 60),
                    platform: String(device.platform || 'device').slice(0, 20),
                },
                key,
                ip: remoteIp(req),
                port: portNum,
                sas: shortCode(directKeys.publicKey, key, directCode),
                expiresAt: Date.now() + PAIRING_TTL_MS,
                status: 'pending',
            });
            return res.json({ requestId: id, code: directCode, key: directKeys.publicKey });
        }

        // QR / pairing link offer
        const offer = liveOffer(handle);
        if (!offer || offer.closed) return res.status(409).json({ error: 'Pairing is not open on that device' });
        if (offer.expiresAt < Date.now()) return res.status(410).json({ error: 'That pairing code has expired' });
        if (!safeEqual(code, offer.code)) return res.status(403).json({ error: 'Invalid pairing code' });
        if ([...offer.requests.values()].filter(r => r.status === 'pending').length >= MAX_PENDING) {
            return res.status(429).json({ error: 'Too many pairing requests are waiting' });
        }
        const id = randomId(9);
        offer.requests.set(id, {
            id,
            device: {
                id: device.id,
                name: String(device.name || 'A device').slice(0, 60),
                platform: String(device.platform || 'device').slice(0, 20),
            },
            key,
            ip: remoteIp(req),
            port: portNum,
            sas: shortCode(offer.keys.publicKey, key, offer.code),
            status: 'pending',
        });
        res.json({ requestId: id });
    });

    router.post('/peer/pair/result', (req, res) => {
        const { me, name, platform, handle } = parts(req);
        const offer = liveOffer(handle);
        const dMap = getDirectRequestMap(handle);
        const { requestId, code } = req.body || {};
        const fromOffer = offer?.requests.get(requestId);
        const fromDirect = dMap.get(requestId);
        const request = fromOffer || fromDirect;
        const expectedCode = fromOffer ? offer.code : fromDirect?.code;
        if (!request || !expectedCode || !safeEqual(code, expectedCode)) {
            return res.status(404).json({ error: 'No such pairing request' });
        }
        if (request.status === 'approved') {
            return res.json({ status: 'approved', device: { id: me.deviceId, name, platform }, proof: request.proof });
        }
        if (request.status === 'denied') return res.json({ status: 'denied' });
        const expiresAt = fromOffer ? offer.expiresAt : request.expiresAt;
        if (expiresAt < Date.now()) return res.json({ status: 'expired' });
        res.json({ status: 'pending' });
    });

    // ── pairing: the joining device's own page (QR link, Nearby device, or Manual IP) ──

    async function streamJoinHandshake(req, res, target) {
        const { store, me, name, platform, port } = parts(req);
        const hangUp = new AbortController();
        res.on('close', () => { if (!res.writableEnded) hangUp.abort(); });
        res.setHeader('Content-Type', 'application/x-ndjson');
        const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);

        const keys = keyPair();
        line({ step: 'contacting', name: target.name });
        const address = await firstReachable(target.addresses, { signal: hangUp.signal });
        if (hangUp.signal.aborted) return;
        if (!address) {
            return res.end(`${JSON.stringify({ error: `Could not reach ${target.name} at ${target.addresses.join(', ')}. Check both devices are on the same network.` })}\n`);
        }
        line({ step: 'reached', address });

        let offerId = target.id;
        let offerName = target.name;
        let offerPlatform = target.platform || 'device';
        let offerKey = target.key;
        let offerCode = target.code || randomId(12);

        if (target.direct && (!offerId || !offerKey)) {
            try {
                const infoResp = await fetch(`http://${address}/api/ext/lan-sync/peer/pair/info`, {
                    signal: AbortSignal.any([hangUp.signal, AbortSignal.timeout(5000)]),
                });
                if (!infoResp.ok) throw new Error(`HTTP ${infoResp.status}`);
                const info = await infoResp.json();
                offerId = info.id;
                offerName = info.name || offerName;
                offerPlatform = info.platform || offerPlatform;
                offerKey = info.key;
                discovery.recordProbedPeer({
                    id: offerId,
                    name: offerName,
                    platform: offerPlatform,
                    address,
                    port: info.port,
                    publicKey: offerKey,
                });
            } catch (e) {
                if (hangUp.signal.aborted) return;
                return res.end(`${JSON.stringify({ error: `Could not read LAN Sync info from ${address}: ${e.message}` })}\n`);
            }
        }

        if (offerId === me.deviceId) {
            return res.end(`${JSON.stringify({ error: 'That address belongs to this device itself.' })}\n`);
        }

        // If already paired with this device and connected manually, update its address in place
        const existingPeer = store.peer(offerId);
        if (existingPeer && target.manualConnect) {
            store.updatePeer(offerId, { address, name: offerName, platform: offerPlatform });
            return res.end(`${JSON.stringify({ step: 'paired', name: existingPeer.customName || offerName, updatedAddress: true })}\n`);
        }

        let requestId;
        try {
            const answer = await pairingCall(address, '/peer/pair/request', {
                code: offerCode,
                direct: Boolean(target.direct),
                device: { id: me.deviceId, name, platform },
                key: keys.publicKey,
                port,
            }, { timeout: 5000, signal: hangUp.signal });
            requestId = answer.requestId;
            if (answer.code) offerCode = answer.code;
            if (answer.key) offerKey = answer.key;
        } catch (e) {
            if (hangUp.signal.aborted) return;
            return res.end(`${JSON.stringify({ error: `${offerName} refused the pairing: ${e.message}` })}\n`);
        }

        line({ step: 'confirm', name: offerName, code: shortCode(offerKey, keys.publicKey, offerCode) });
        while (!hangUp.signal.aborted) {
            await new Promise(r => setTimeout(r, 1200));
            let answer;
            try {
                answer = await pairingCall(address, '/peer/pair/result', { requestId, code: offerCode }, { timeout: 4000, signal: hangUp.signal });
            } catch (e) {
                if (hangUp.signal.aborted) return;
                return res.end(`${JSON.stringify({ error: `Lost ${offerName} while waiting: ${e.message}` })}\n`);
            }
            if (answer.status === 'pending') continue;
            if (answer.status !== 'approved') {
                return res.end(`${JSON.stringify({ error: answer.status === 'denied' ? `${offerName} declined the pairing` : 'The pairing request expired before it was approved' })}\n`);
            }
            const secret = deriveSecret(keys.privateKey, offerKey, { code: offerCode, offerId, joinId: me.deviceId });
            if (!safeEqual(answer.proof, hmac(secret, `paired|${requestId}`))) {
                return res.end(`${JSON.stringify({ error: 'The other device did not prove its pairing key. Nothing was paired.' })}\n`);
            }
            const peerName = String(answer.device?.name || offerName).slice(0, 60);
            const peerPlatform = String(answer.device?.platform || offerPlatform || 'device').slice(0, 20);
            store.savePeer({ id: offerId, name: peerName, platform: peerPlatform, address, secret, pairedAt: Date.now() });
            return res.end(`${JSON.stringify({ step: 'paired', name: peerName })}\n`);
        }
    }

    router.post('/pairing/join', async (req, res) => {
        const { me } = parts(req);
        const offer = parsePairLink(req.body?.link);
        if (!offer) return res.status(400).json({ error: 'That is not a LAN Sync pairing link' });
        if (offer.id === me.deviceId) return res.status(400).json({ error: 'That code is this device\'s own. Scan it with the other device.' });
        if (offer.expiresAt < Date.now()) return res.status(410).json({ error: 'That pairing code has expired. Show a new one.' });
        await streamJoinHandshake(req, res, {
            id: offer.id,
            name: offer.name,
            addresses: offer.addresses,
            code: offer.code,
            key: offer.key,
            direct: false,
        });
    });

    router.post('/pairing/direct', async (req, res) => {
        const { me } = parts(req);
        const { deviceId, address } = req.body || {};
        if (deviceId) {
            const nearby = discovery.snapshot().find(d => d.id === deviceId);
            if (!nearby && !address) {
                return res.status(404).json({ error: 'Device is no longer nearby. Refresh and try again.' });
            }
            if (deviceId === me.deviceId) {
                return res.status(400).json({ error: 'Cannot pair a device with itself' });
            }
            const addresses = nearby?.addresses?.length ? nearby.addresses : [normalizeManualAddress(address)].filter(Boolean);
            await streamJoinHandshake(req, res, {
                id: nearby?.id || deviceId,
                name: nearby?.name || address || 'Nearby device',
                platform: nearby?.platform || 'device',
                addresses,
                key: nearby?.publicKey || null,
                direct: true,
            });
            return;
        }
        const cleanAddr = normalizeManualAddress(address);
        if (!cleanAddr) {
            return res.status(400).json({ error: 'Enter an IP address and port, such as 192.168.1.20:7788' });
        }
        await streamJoinHandshake(req, res, {
            id: null,
            name: cleanAddr,
            addresses: [cleanAddr],
            key: null,
            direct: true,
            manualConnect: true,
        });
    });

    // ── paired devices ──────────────────────────────────────

    router.patch('/peers/:id', (req, res) => {
        const { store } = parts(req);
        const fields = {};
        if (typeof req.body?.address === 'string') {
            const address = normalizeManualAddress(req.body.address);
            if (!address) return res.status(400).json({ error: 'An address is host:port, such as 192.168.1.20:7788' });
            fields.address = address;
        }
        if (typeof req.body?.customName === 'string') {
            fields.customName = req.body.customName.trim().slice(0, 60);
        }
        const peer = store.updatePeer(req.params.id, fields);
        if (!peer) return res.status(404).json({ error: 'No such paired device' });
        const { secret, aliases, ...shown } = peer;
        res.json(shown);
    });

    router.delete('/peers/:id', (req, res) => {
        const { store } = parts(req);
        const removed = store.removePeer(req.params.id);
        const auto = store.automation();
        if (auto.targetId === req.params.id) {
            store.saveAutomation({ enabled: false, targetId: '' });
            ensureAutomationTimer(req);
        }
        res.json({ removed });
    });

    const startPull = (req, peerRecord, options, label) => {
        const { store, me } = parts(req);
        const db = req.db;
        const paths = req.paths;
        const peer = peerClient({ address: peerRecord.address, deviceId: me.deviceId, secret: peerRecord.secret });
        return ctx.jobs.run(db, {
            key: `pull-${peerRecord.id}`,
            label,
            run: async ({ signal, progress }) => {
                const aliases = store.peer(peerRecord.id)?.aliases || {};
                const result = await runPull({ db, paths, ctx, peer, store, options, aliases, signal, progress });
                store.updatePeer(peerRecord.id, {
                    aliases: result.aliases,
                    lastSync: {
                        at: Date.now(),
                        direction: 'pull',
                        counts: result.counts,
                        errors: result.errors.slice(0, 20),
                        missingExtensions: result.missingExtensions || [],
                    },
                });
                if (result.errors.length) {
                    throw new Error(`${result.errors.length} item${result.errors.length === 1 ? '' : 's'} could not be synced: ${result.errors.slice(0, 3).map(e => `${e.what} (${e.error})`).join('; ')}`);
                }
                return { counts: result.counts, missingExtensions: result.missingExtensions || [] };
            },
        });
    };

    router.post('/peers/:id/pull', async (req, res) => {
        const { store, me } = parts(req);
        const record = store.peer(req.params.id);
        if (!record) return res.status(404).json({ error: 'No such paired device' });
        const options = syncOptions(req.db);
        const displayName = record.customName || record.name;
        if (req.body?.dryRun) {
            const peer = peerClient({ address: record.address, deviceId: me.deviceId, secret: record.secret });
            try {
                const { counts, missingExtensions } = await runPull({ db: req.db, paths: req.paths, ctx, peer, store, aliases: record.aliases || {}, options: { ...options, dryRun: true } });
                return res.json({ counts, options, missingExtensions: missingExtensions || [] });
            } catch (e) {
                return res.status(502).json({ error: e.message });
            }
        }
        res.json(startPull(req, record, options, `Syncing from ${displayName}`));
    });

    router.post('/peers/:id/push', async (req, res) => {
        const { store, me, port } = parts(req);
        const record = store.peer(req.params.id);
        if (!record) return res.status(404).json({ error: 'No such paired device' });
        const { mode, ...options } = syncOptions(req.db);
        const peer = peerClient({ address: record.address, deviceId: me.deviceId, secret: record.secret });
        try {
            const answer = await peer.json('/peer/pull-request', { method: 'POST', json: { port, options }, timeout: 10_000 });
            store.updatePeer(record.id, { lastPushRequestAt: Date.now() });
            res.json(answer);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    // ── the peer routes: signed ─────────────────────────────

    const signed = (req, res, next) => {
        const { store } = parts(req);
        const record = store.peer(req.get('x-lan-sync-device') || '');
        const bodyText = req.method === 'GET' ? '' : JSON.stringify(req.body ?? {});
        const ok = record && verifySignature(record.secret, {
            method: req.method, path: req.originalUrl, time: req.get('x-lan-sync-time'), signature: req.get('x-lan-sync-sig'), bodyText,
        });
        if (!ok) return res.status(401).json({ error: 'This device is not paired with that one (or its clock is more than ten minutes off)' });
        req.peer = record;
        next();
    };

    // a local answer handed on as it arrives
    const relay = async (res, resp) => {
        res.status(resp.status);
        for (const h of ['content-type', 'content-length', 'x-bundle-count', 'x-bundle-skipped-count']) {
            const v = resp.headers.get(h);
            if (v) res.setHeader(h, v);
        }
        if (!resp.body) return res.end();
        const body = Readable.fromWeb(resp.body);
        res.on('close', () => body.destroy());
        body.pipe(res);
    };

    router.post('/peer/hello', signed, (req, res) => {
        const { me, name, platform } = parts(req);
        res.json({ device: { id: me.deviceId, name, platform }, version: ctx.manifest.version, datasets: DATASETS });
    });

    router.post('/peer/manifest', signed, async (req, res, next) => {
        const { store } = parts(req);
        const datasets = (Array.isArray(req.body?.datasets) ? req.body.datasets : DATASETS).filter(d => DATASETS.includes(d));
        const includeSecrets = req.body?.includeSecrets === true;
        try {
            res.json(buildManifestFromDb(req.db, req.paths, store, { datasets, includeSecrets }));
        } catch (e) { next(e); }
    });

    router.post('/peer/db-snapshot', signed, (req, res, next) => {
        const includeConnections = req.body?.includeConnections === true;
        const includeSecrets = req.body?.includeSecrets === true;
        let tmpFile = null;
        try {
            tmpFile = createDbSnapshot(req.db, { includeConnections, includeSecrets });
            const stat = fs.statSync(tmpFile);
            res.setHeader('Content-Type', 'application/x-sqlite3');
            res.setHeader('Content-Length', String(stat.size));
            const stream = fs.createReadStream(tmpFile);
            const cleanup = () => {
                if (tmpFile) {
                    const f = tmpFile;
                    tmpFile = null;
                    try { fs.unlinkSync(f); } catch { /* ignore */ }
                }
            };
            res.on('close', cleanup);
            stream.on('end', cleanup);
            stream.on('error', (err) => { cleanup(); next(err); });
            stream.pipe(res);
        } catch (e) {
            if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
            next(e);
        }
    });

    router.post('/peer/files-manifest', signed, (req, res, next) => {
        const datasets = (Array.isArray(req.body?.datasets) ? req.body.datasets : DATASETS).filter(d => DATASETS.includes(d));
        try {
            res.json({ files: buildFileManifest(req.db, req.paths, { datasets }) });
        } catch (e) { next(e); }
    });

    router.get('/peer/file/:kind', signed, (req, res) => {
        const relPath = String(req.query.path || '');
        const allowedExtIds = new Set(enabledLanSyncExtensions(req.db).filter(e => e.files).map(e => e.id));
        const fullPath = resolveMediaFile(req.paths, req.params.kind, relPath, allowedExtIds);
        if (!fullPath) return res.status(400).json({ error: 'Invalid media file path' });
        let stat;
        try {
            stat = fs.statSync(fullPath);
            if (!stat.isFile()) return res.status(404).json({ error: 'Not a file' });
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        const stream = fs.createReadStream(fullPath);
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    });

    router.post('/peer/bundle', signed, async (req, res, next) => {
        const { local } = parts(req);
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string').slice(0, 100) : [];
        if (!ids.length) return res.status(400).json({ error: 'A bundle names its characters' });
        try {
            await relay(res, await local.request('/api/bundle/export', {
                method: 'POST', json: { ids, include: { chats: true, media: true, worlds: true } },
            }));
        } catch (e) { next(e); }
    });

    router.get('/peer/character/:id/card', signed, async (req, res, next) => {
        const { local } = parts(req);
        try { await relay(res, await local.request(`/api/characters/${enc(req.params.id)}/export`)); } catch (e) { next(e); }
    });

    router.get('/peer/character/:id/meta', signed, async (req, res, next) => {
        const { local } = parts(req);
        try {
            const detail = await local.json(`/api/characters/${enc(req.params.id)}`);
            res.json({ tags: detail.tags || [], fav: !!detail.fav, updateLocked: !!detail.updateLocked, worlds: await characterWorlds(local, req.params.id) });
        } catch (e) { next(e); }
    });

    router.get('/peer/character/:id/media', signed, async (req, res, next) => {
        const { local } = parts(req);
        try { res.json({ items: await walk(local, `/api/characters/${enc(req.params.id)}/media`) }); } catch (e) { next(e); }
    });

    router.get('/peer/media/:charId/:file', signed, async (req, res, next) => {
        const { local } = parts(req);
        if (/[\\/]|\.\./.test(req.params.file)) return res.status(400).json({ error: 'Bad file name' });
        try { await relay(res, await local.request(`/gallery/${enc(req.params.charId)}/${enc(req.params.file)}`)); } catch (e) { next(e); }
    });

    router.get('/peer/chat/:id', signed, async (req, res, next) => {
        const { local } = parts(req);
        try {
            const { chat, rows } = await chatRows(local, req.params.id);
            res.json({ name: chat.name, chatMetadata: chat.chatMetadata || {}, draft: chat.draft || null, rows });
        } catch (e) { next(e); }
    });

    router.get('/peer/world/:name', signed, async (req, res, next) => {
        const { local } = parts(req);
        try { res.json(await local.json(`/api/worlds/${enc(req.params.name)}`)); } catch (e) { next(e); }
    });

    router.get('/peer/persona/:id', signed, async (req, res, next) => {
        const { local } = parts(req);
        try {
            const [persona, worlds] = await Promise.all([
                local.json(`/api/personas/${enc(req.params.id)}`),
                local.json(`/api/personas/${enc(req.params.id)}/worlds`),
            ]);
            res.json({ ...persona, worlds: Array.isArray(worlds) ? worlds : [] });
        } catch (e) { next(e); }
    });

    router.get('/peer/persona/:id/avatar', signed, async (req, res, next) => {
        const { local } = parts(req);
        try { await relay(res, await local.request(`/persona-avatars/${enc(req.params.id)}.png`, { ok: false })); } catch (e) { next(e); }
    });

    router.get('/peer/preset/:id', signed, async (req, res, next) => {
        const { local } = parts(req);
        try { res.json(await local.json(`/api/presets/${enc(req.params.id)}`)); } catch (e) { next(e); }
    });

    router.get('/peer/playlist/:id', signed, async (req, res, next) => {
        const { local } = parts(req);
        try {
            const doc = await local.json('/api/playlists');
            const p = doc?.playlists?.[req.params.id];
            if (!p) return res.status(404).json({ error: 'no such playlist' });
            const members = await playlistMembers(local, req.params.id);
            res.json({ id: req.params.id, ...p, members });
        } catch (e) { next(e); }
    });

    router.post('/characters/merge', (req, res) => {
        const { store } = parts(req);
        const { fromId, intoId, peerId = null } = req.body || {};
        try {
            const out = mergeDuplicateCharacter(req.db, req.paths, store, { fromId, intoId, peerId, ctx });
            res.json(out);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // "push", as TauriTavern does it: the other device asks this one to pull from it. The asker chooses what
    // to sync and how to overwrite; Mirror stays this device's own choice, since its deletions happen here.
    router.post('/peer/pull-request', signed, (req, res) => {
        const { store } = parts(req);
        const port = Number(req.body?.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'A pull request names its port' });
        const record = store.updatePeer(req.peer.id, { address: `${remoteIp(req)}:${port}` });
        const asked = req.body?.options || {};
        const own = syncOptions(req.db);
        const options = {
            characters: asked.characters !== false,
            chats: asked.chats !== false,
            lorebooks: asked.lorebooks !== false,
            personas: asked.personas !== false,
            presets: asked.presets !== false,
            playlists: asked.playlists !== false,
            backgrounds: asked.backgrounds !== false,
            settings: asked.settings !== false,
            connections: asked.connections === true && own.connections === true,
            secrets: asked.secrets === true && own.secrets === true,
            overwrite: asked.overwrite === 'prefer-newer' ? 'prefer-newer' : 'exact',
            mode: own.mode,
        };
        const displayName = record.customName || record.name;
        const job = startPull(req, record, options, `Syncing from ${displayName} (sent from it)`);
        res.json({ accepted: true, jobId: job.id });
    });
}
