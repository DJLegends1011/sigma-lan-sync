// LAN Sync, the server half. Three groups of routes under /api/ext/lan-sync:
//   the page's own (status, pairing, paired devices, pull and push),
//   pairing (/peer/pair/*: unsigned, answering only to a live pairing code),
//   peer (/peer/*: signed with a paired device's secret, read-only views of this library).
// A paired device can read this library and ask it to pull; nothing a peer sends writes here directly.
import { Readable } from 'node:stream';
import { parsePairLink, buildPairLink } from '../client/pair-link.js';
import { randomId, keyPair, deriveSecret, shortCode, hmac, safeEqual, verifySignature } from './crypto.js';
import { makeStore, deviceName } from './store.js';
import { localBase, localClient, peerClient, pairingCall, firstReachable, listenInfo, reachableAddresses, remoteIp } from './http.js';
import { buildManifest, walk, chatRows, characterWorlds, playlistMembers, DATASETS } from './manifest.js';
import { runPull } from './sync.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5;
const enc = encodeURIComponent;

export function register(router, ctx) {
    // a pairing offer per account: its code, its key pair and the requests it has heard
    const offers = new Map();

    const parts = (req) => {
        const store = makeStore(ctx.files.user(req));
        return {
            store,
            me: store.identity(),
            name: deviceName(ctx.setting(req.db, 'deviceName')),
            local: localClient(localBase(req)),
            port: req.socket.localPort,
        };
    };

    const syncOptions = (db) => ({
        characters: ctx.setting(db, 'syncCharacters') !== false,
        chats: ctx.setting(db, 'syncChats') !== false,
        lorebooks: ctx.setting(db, 'syncLorebooks') !== false,
        personas: ctx.setting(db, 'syncPersonas') !== false,
        presets: ctx.setting(db, 'syncPresets') !== false,
        playlists: ctx.setting(db, 'syncPlaylists') !== false,
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

    // ── this device ─────────────────────────────────────────

    router.get('/status', (req, res) => {
        const { store, me, name, port } = parts(req);
        const offer = liveOffer(req.userHandle);
        const listen = listenInfo(req);
        res.json({
            device: { id: me.deviceId, name },
            port,
            loopbackOnly: listen.loopbackOnly,
            addresses: listen.loopbackOnly
                ? [{ address: `127.0.0.1:${port}`, ip: '127.0.0.1', iface: 'loopback', kind: 'loopback' }]
                : reachableAddresses(port),
            pairing: offer && !offer.closed && offer.expiresAt > Date.now() ? { expiresAt: offer.expiresAt } : null,
            peers: store.peers().map(({ secret, aliases, ...p }) => p),
            jobs: ctx.jobs.list(req.db),
        });
    });

    // ── pairing: the device that shows the QR code ──────────

    router.post('/pairing/start', (req, res) => {
        const { me, name, port } = parts(req);
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
        offers.set(req.userHandle, offer);
        const link = buildPairLink({ id: me.deviceId, name, addresses, code: offer.code, expiresAt: offer.expiresAt, key: keys.publicKey }, port);
        res.json({ link, expiresAt: offer.expiresAt, addresses, warning });
    });

    router.post('/pairing/stop', (req, res) => {
        offers.delete(req.userHandle);
        res.json({ ok: true });
    });

    router.get('/pairing/requests', (req, res) => {
        const offer = liveOffer(req.userHandle);
        const pending = offer ? [...offer.requests.values()].filter(r => r.status === 'pending') : [];
        res.json({ requests: pending.map(r => ({ id: r.id, name: r.device.name, address: r.ip, code: r.sas })) });
    });

    router.post('/pairing/requests/:rid', (req, res) => {
        const { store, me } = parts(req);
        const offer = liveOffer(req.userHandle);
        const request = offer?.requests.get(req.params.rid);
        if (!request || request.status !== 'pending') return res.status(404).json({ error: 'That pairing request is gone' });
        if (req.body?.allow !== true) {
            request.status = 'denied';
            return res.json({ ok: true, status: 'denied' });
        }
        const secret = deriveSecret(offer.keys.privateKey, request.key, { code: offer.code, offerId: me.deviceId, joinId: request.device.id });
        store.savePeer({ id: request.device.id, name: request.device.name, address: `${request.ip}:${request.port}`, secret, pairedAt: Date.now() });
        request.status = 'approved';
        request.proof = hmac(secret, `paired|${request.id}`);
        // one device a code: once approved, the offer answers only the device it approved
        offer.closed = true;
        res.json({ ok: true, status: 'approved' });
    });

    // ── pairing: the routes the scanning device calls (no signature yet: the code is the key) ──

    router.post('/peer/pair/request', (req, res) => {
        const { me } = parts(req);
        const offer = liveOffer(req.userHandle);
        const { code, device, key, port } = req.body || {};
        if (!offer || offer.closed) return res.status(409).json({ error: 'Pairing is not open on that device' });
        if (offer.expiresAt < Date.now()) return res.status(410).json({ error: 'That pairing code has expired' });
        if (!safeEqual(code, offer.code)) return res.status(403).json({ error: 'Invalid pairing code' });
        if (typeof device?.id !== 'string' || !device.id || typeof key !== 'string') return res.status(400).json({ error: 'A pairing request names its device and its key' });
        if (device.id === me.deviceId) return res.status(400).json({ error: 'A device cannot pair with itself' });
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return res.status(400).json({ error: 'A pairing request names its port' });
        if ([...offer.requests.values()].filter(r => r.status === 'pending').length >= MAX_PENDING) {
            return res.status(429).json({ error: 'Too many pairing requests are waiting' });
        }
        const id = randomId(9);
        offer.requests.set(id, {
            id,
            device: { id: device.id, name: String(device.name || 'A device').slice(0, 60) },
            key,
            ip: remoteIp(req),
            port: portNum,
            sas: shortCode(offer.keys.publicKey, key, offer.code),
            status: 'pending',
        });
        res.json({ requestId: id });
    });

    router.post('/peer/pair/result', (req, res) => {
        const { me, name } = parts(req);
        const offer = liveOffer(req.userHandle);
        const { requestId, code } = req.body || {};
        const request = offer?.requests.get(requestId);
        if (!request || !safeEqual(code, offer.code)) return res.status(404).json({ error: 'No such pairing request' });
        if (request.status === 'approved') return res.json({ status: 'approved', device: { id: me.deviceId, name }, proof: request.proof });
        if (request.status === 'denied') return res.json({ status: 'denied' });
        if (offer.expiresAt < Date.now()) return res.json({ status: 'expired' });
        res.json({ status: 'pending' });
    });

    // ── pairing: the scanning device's own page ─────────────

    router.post('/pairing/join', async (req, res) => {
        const { store, me, name, port } = parts(req);
        const offer = parsePairLink(req.body?.link);
        if (!offer) return res.status(400).json({ error: 'That is not a LAN Sync pairing link' });
        if (offer.id === me.deviceId) return res.status(400).json({ error: 'That code is this device\'s own. Scan it with the other device.' });
        if (offer.expiresAt < Date.now()) return res.status(410).json({ error: 'That pairing code has expired. Show a new one.' });

        const hangUp = new AbortController();
        res.on('close', () => { if (!res.writableEnded) hangUp.abort(); });
        res.setHeader('Content-Type', 'application/x-ndjson');
        const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);

        const keys = keyPair();
        // every address the code names is asked at once; the first Σ to answer is the one paired with
        line({ step: 'contacting', name: offer.name });
        const address = await firstReachable(offer.addresses, { signal: hangUp.signal });
        if (hangUp.signal.aborted) return;
        if (!address) {
            return res.end(`${JSON.stringify({ error: `Could not reach ${offer.name} at ${offer.addresses.join(', ')}. Check both devices are on the same network.` })}\n`);
        }
        line({ step: 'reached', address });
        let requestId;
        try {
            const answer = await pairingCall(address, '/peer/pair/request', {
                code: offer.code, device: { id: me.deviceId, name }, key: keys.publicKey, port,
            }, { timeout: 5000, signal: hangUp.signal });
            requestId = answer.requestId;
        } catch (e) {
            if (hangUp.signal.aborted) return;
            return res.end(`${JSON.stringify({ error: `${offer.name} refused the pairing: ${e.message}` })}\n`);
        }

        line({ step: 'confirm', name: offer.name, code: shortCode(offer.key, keys.publicKey, offer.code) });
        while (!hangUp.signal.aborted) {
            await new Promise(r => setTimeout(r, 1200));
            let answer;
            try {
                answer = await pairingCall(address, '/peer/pair/result', { requestId, code: offer.code }, { timeout: 4000, signal: hangUp.signal });
            } catch (e) {
                if (hangUp.signal.aborted) return;
                return res.end(`${JSON.stringify({ error: `Lost ${offer.name} while waiting: ${e.message}` })}\n`);
            }
            if (answer.status === 'pending') continue;
            if (answer.status !== 'approved') {
                return res.end(`${JSON.stringify({ error: answer.status === 'denied' ? `${offer.name} declined the pairing` : 'The pairing code expired before it was approved' })}\n`);
            }
            const secret = deriveSecret(keys.privateKey, offer.key, { code: offer.code, offerId: offer.id, joinId: me.deviceId });
            // the proof holds only if the device that approved holds the key the QR code pinned
            if (!safeEqual(answer.proof, hmac(secret, `paired|${requestId}`))) {
                return res.end(`${JSON.stringify({ error: 'The other device did not prove the key its QR code showed. Nothing was paired.' })}\n`);
            }
            const peerName = String(answer.device?.name || offer.name).slice(0, 60);
            store.savePeer({ id: offer.id, name: peerName, address, secret, pairedAt: Date.now() });
            return res.end(`${JSON.stringify({ step: 'paired', name: peerName })}\n`);
        }
    });

    // ── paired devices ──────────────────────────────────────

    router.patch('/peers/:id', (req, res) => {
        const { store } = parts(req);
        const fields = {};
        if (typeof req.body?.address === 'string') {
            const address = req.body.address.trim();
            if (!/^[^\s/]+:\d{1,5}$/.test(address)) return res.status(400).json({ error: 'An address is host:port, such as 192.168.1.20:7788' });
            fields.address = address;
        }
        const peer = store.updatePeer(req.params.id, fields);
        if (!peer) return res.status(404).json({ error: 'No such paired device' });
        const { secret, aliases, ...shown } = peer;
        res.json(shown);
    });

    router.delete('/peers/:id', (req, res) => {
        const { store } = parts(req);
        res.json({ removed: store.removePeer(req.params.id) });
    });

    const startPull = (req, peerRecord, options, label) => {
        const { store, me, local } = parts(req);
        const peer = peerClient({ address: peerRecord.address, deviceId: me.deviceId, secret: peerRecord.secret });
        return ctx.jobs.run(req.db, {
            key: `pull-${peerRecord.id}`,
            label,
            run: async ({ signal, progress }) => {
                const aliases = store.peer(peerRecord.id)?.aliases || {};
                const result = await runPull({ local, peer, store, options, aliases, signal, progress });
                store.updatePeer(peerRecord.id, {
                    aliases: result.aliases,
                    lastSync: { at: Date.now(), direction: 'pull', counts: result.counts, errors: result.errors.slice(0, 20) },
                });
                if (result.errors.length) {
                    throw new Error(`${result.errors.length} item${result.errors.length === 1 ? '' : 's'} could not be synced: ${result.errors.slice(0, 3).map(e => `${e.what} (${e.error})`).join('; ')}`);
                }
            },
        });
    };

    router.post('/peers/:id/pull', async (req, res) => {
        const { store, me, local } = parts(req);
        const record = store.peer(req.params.id);
        if (!record) return res.status(404).json({ error: 'No such paired device' });
        const options = syncOptions(req.db);
        if (req.body?.dryRun) {
            const peer = peerClient({ address: record.address, deviceId: me.deviceId, secret: record.secret });
            try {
                const { counts } = await runPull({ local, peer, store, aliases: record.aliases || {}, options: { ...options, dryRun: true } });
                return res.json({ counts, options });
            } catch (e) {
                return res.status(502).json({ error: e.message });
            }
        }
        res.json(startPull(req, record, options, `Syncing from ${record.name}`));
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
        const { me, name } = parts(req);
        res.json({ device: { id: me.deviceId, name }, version: ctx.manifest.version, datasets: DATASETS });
    });

    router.post('/peer/manifest', signed, async (req, res, next) => {
        const { store, local } = parts(req);
        const datasets = (Array.isArray(req.body?.datasets) ? req.body.datasets : DATASETS).filter(d => DATASETS.includes(d));
        try {
            res.json(await buildManifest(local, store, { datasets }));
        } catch (e) { next(e); }
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
            overwrite: asked.overwrite === 'prefer-newer' ? 'prefer-newer' : 'exact',
            mode: own.mode,
        };
        const job = startPull(req, record, options, `Syncing from ${record.name} (sent from it)`);
        res.json({ accepted: true, jobId: job.id });
    });
}
