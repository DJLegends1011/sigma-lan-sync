// Two real Project Σ servers, a desktop and a phone, paired the way a person pairs them (the phone joins with
// the desktop's link, the desktop approves the code both screens show), then synced both ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveMediaFile, createDbSnapshot } from '../server/sync.js';

const sigmaDir = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';
const { default: Database } = await import(pathToFileURL(path.join(sigmaDir, 'node_modules', 'better-sqlite3', 'lib', 'index.js')).href);

const deviceScript = fileURLToPath(new URL('./support/device.mjs', import.meta.url));

function spawnDevice(name) {
    const child = fork(deviceScript, [name], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let seq = 0;
    const waiting = new Map();
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`${name} exited (${code}) before it was ready`)));
        child.on('message', (msg) => {
            if (msg.ready) {
                const base = msg.base;
                const api = async (path, method = 'GET', body) => {
                    const resp = await fetch(`${base}/api${path}`, {
                        method,
                        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                        body: body === undefined ? undefined : JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch { /* not JSON */ }
                    return { status: resp.status, body: json ?? text };
                };
                resolve({
                    name,
                    base,
                    api,
                    ext: (path, method, body) => api(`/ext/lan-sync${path}`, method, body),
                    call: (op, ...args) => new Promise((res, rej) => {
                        const id = ++seq;
                        waiting.set(id, { res, rej });
                        child.send({ id, op, args });
                    }),
                    close: () => { child.removeAllListeners('exit'); child.kill(); },
                });
                return;
            }
            const w = waiting.get(msg.id);
            if (!w) return;
            waiting.delete(msg.id);
            msg.ok ? w.res(msg.result) : w.rej(new Error(msg.error));
        });
    });
}

async function* ndjson(resp) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, at).trim();
            buf = buf.slice(at + 1);
            if (line) yield JSON.parse(line);
        }
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Wait for a job of this device to end; answers it. */
async function jobDone(device, jobId) {
    for (let i = 0; i < 300; i++) {
        const { body } = await device.ext('/status');
        const job = body.jobs.find(j => j.id === jobId) || (jobId ? null : body.jobs.at(-1));
        if (job && !['queued', 'running'].includes(job.status)) return job;
        await sleep(200);
    }
    throw new Error(`${device.name}: job ${jobId} did not finish`);
}

async function pull(device, peerId) {
    const started = await device.ext(`/peers/${peerId}/pull`, 'POST', {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const job = await jobDone(device, started.body.id);
    assert.equal(job.status, 'done', `${device.name}'s pull ended ${job.status}: ${job.error || ''}`);
    return job;
}

async function dryRun(device, peerId) {
    const r = await device.ext(`/peers/${peerId}/pull`, 'POST', { dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.counts;
}

const nothingToDo = (counts) => Object.entries(counts).filter(([k, v]) => k !== 'kept' && v !== 0);

let desk;
let phone;
let deskId;
let phoneId;
const ids = {};

before(async () => {
    [desk, phone] = await Promise.all([spawnDevice('desk'), spawnDevice('phone')]);
}, { timeout: 120_000 });

after(() => { desk?.close(); phone?.close(); });

test('the desktop holds a library to sync', async () => {
    const nova = await desk.call('importCard', { name: 'Nova', description: 'A star pilot.', first_mes: 'Hello.', tags: ['scifi'] });
    const iris = await desk.call('importCard', { name: 'Iris', description: 'A gardener.', first_mes: 'Hi.' });
    ids.nova = nova.id;
    ids.iris = iris.id;
    const world = await desk.api(`/worlds/${encodeURIComponent('Nova Lore')}`, 'PUT', { entries: { 0: { uid: 0, key: ['nova'], content: 'Nova flies the Lark.' } } });
    assert.ok(world.status < 300, JSON.stringify(world.body));
    const linked = await desk.api(`/characters/${ids.nova}/worlds`, 'PUT', { worlds: ['Nova Lore'] });
    assert.ok(linked.status < 300, JSON.stringify(linked.body));
    const chat = await desk.api(`/characters/${ids.nova}/chats`, 'POST', {
        name: 'Nova - first flight',
        messages: [
            { name: 'Nova', is_user: false, mes: 'Hello.', send_date: 1700000000000 },
            { name: 'User', is_user: true, mes: 'Ready to fly?', send_date: 1700000001000 },
        ],
    });
    assert.ok(chat.status < 300, JSON.stringify(chat.body));
    ids.deskChat = chat.body.id;

    // Persona + bound lorebook + avatar
    const persona = await desk.api('/personas', 'POST', {
        name: 'Commander',
        description: 'Fleet captain.',
        pronouns: { sub: 'they', obj: 'them', poss: 'their', possP: 'theirs', ref: 'themselves' },
    });
    assert.equal(persona.status, 200, JSON.stringify(persona.body));
    ids.deskPersona = persona.body.id;
    const pWorlds = await desk.api(`/personas/${ids.deskPersona}/worlds`, 'PUT', { worlds: ['Nova Lore'] });
    assert.equal(pWorlds.status, 200);
    const png = Buffer.from(await (await fetch(`${desk.base}/avatars/${ids.nova}.png`)).arrayBuffer());
    const pAv = await fetch(`${desk.base}/api/personas/${ids.deskPersona}/avatar`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
    assert.equal(pAv.status, 200);

    // Preset
    const preset = await desk.api('/presets', 'POST', {
        name: 'Space Opera',
        blocks: [
            { key: 'main', name: 'Main', kind: 'text', content: 'Write space opera.', role: 'system', position: 'pre_history', enabled: true },
            { key: 'chatHistory', name: 'History', kind: 'marker', marker: 'chatHistory', content: '', role: 'system', position: 'pre_history', enabled: true },
        ],
    });
    assert.equal(preset.status, 200, JSON.stringify(preset.body));
    ids.deskPreset = preset.body.id;

    // Playlist with Nova & Iris
    const playlist = await desk.api('/playlists', 'POST', {
        name: 'Crew',
        description: 'Bridge crew',
        icon: 'fa-rocket',
        color: '#4a9eff',
    });
    assert.equal(playlist.status, 200, JSON.stringify(playlist.body));
    ids.deskPlaylist = playlist.body.id;
    const plMem = await desk.api(`/playlists/${ids.deskPlaylist}/members/apply`, 'POST', { add: [ids.nova, ids.iris] });
    assert.equal(plMem.status, 200, JSON.stringify(plMem.body));
});

test('the phone pairs with the desktop through its link and the code both screens show', async () => {
    const offer = await desk.ext('/pairing/start', 'POST', {});
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    assert.match(offer.body.link, /lan-sync-pair=/);
    // a camera app opens the link as it is: the page must load with the pairing still in its query
    const opened = await fetch(offer.body.link.replace(/^http:\/\/localhost:\d+/, phone.base), { redirect: 'manual' });
    assert.equal(opened.status, 200, 'the link opens the page directly, no redirect to drop its query');

    const resp = await fetch(`${phone.base}/api/ext/lan-sync/pairing/join`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link: offer.body.link }),
    });
    assert.equal(resp.status, 200);
    let phoneSaw = null;
    let paired = null;
    for await (const line of ndjson(resp)) {
        assert.ok(!line.error, line.error);
        if (line.step === 'confirm') {
            phoneSaw = line.code;
            const { body } = await desk.ext('/pairing/requests');
            assert.equal(body.requests.length, 1);
            // the person compares the two codes, then allows
            assert.equal(body.requests[0].code, phoneSaw);
            const allowed = await desk.ext(`/pairing/requests/${body.requests[0].id}`, 'POST', { allow: true });
            assert.equal(allowed.body.status, 'approved');
        }
        if (line.step === 'paired') paired = line;
    }
    assert.ok(phoneSaw && paired, 'the join ended paired');

    const deskStatus = (await desk.ext('/status')).body;
    const phoneStatus = (await phone.ext('/status')).body;
    deskId = deskStatus.device.id;
    phoneId = phoneStatus.device.id;
    assert.deepEqual(phoneStatus.peers.map(p => p.id), [deskId]);
    assert.deepEqual(deskStatus.peers.map(p => p.id), [phoneId]);
    assert.ok(!('secret' in phoneStatus.peers[0]), 'the status never shows a secret');
});

test('an unpaired caller and a wrong code are refused', async () => {
    const unsigned = await desk.ext('/peer/manifest', 'POST', { datasets: ['characters'] });
    assert.equal(unsigned.status, 401);
    const forged = await fetch(`${desk.base}/api/ext/lan-sync/peer/manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lan-sync-device': phoneId, 'x-lan-sync-time': String(Date.now()), 'x-lan-sync-sig': 'AAAA' },
        body: '{}',
    });
    assert.equal(forged.status, 401);
    await desk.ext('/pairing/start', 'POST', {});
    const wrong = await desk.ext('/peer/pair/request', 'POST', { code: 'nope', device: { id: 'x', name: 'x' }, key: 'k', port: 1 });
    assert.equal(wrong.status, 403);
    await desk.ext('/pairing/stop', 'POST', {});
});

test('the phone pulls the whole library, ids and all', async () => {
    const counts = await dryRun(phone, deskId);
    assert.equal(counts.charactersNew, 2);
    assert.equal(counts.lorebooksChanged, 1);
    assert.equal(counts.personasNew, 1);
    assert.equal(counts.presetsNew, 1);
    assert.equal(counts.playlistsNew, 1);

    await pull(phone, deskId);
    const nova = await phone.api(`/characters/${ids.nova}`);
    assert.equal(nova.status, 200, 'Nova arrived under the same id');
    assert.equal(nova.body.card.data.description, 'A star pilot.');
    const chats = (await phone.api(`/chats?charId=${ids.nova}`)).body.items;
    assert.deepEqual(chats.map(c => c.name), ['Nova - first flight']);
    assert.equal(chats[0].messageCount, 2);
    const world = await phone.api(`/worlds/${encodeURIComponent('Nova Lore')}`);
    assert.equal(world.status, 200);

    // Check synced persona, preset, playlist
    const personas = (await phone.api('/personas')).body.personas;
    assert.equal(personas.length, 1);
    assert.equal(personas[0].name, 'Commander');
    assert.equal(personas[0].description, 'Fleet captain.');
    assert.equal(personas[0].pronouns.sub, 'they');
    assert.deepEqual(personas[0].worlds, ['Nova Lore']);
    const pAv = await fetch(`${phone.base}/persona-avatars/${personas[0].id}.png`);
    assert.equal(pAv.status, 200);

    const presets = (await phone.api('/presets')).body.presets;
    assert.equal(presets.length, 1);
    assert.equal(presets[0].name, 'Space Opera');
    assert.equal(presets[0].blocks[0].content, 'Write space opera.');

    const playlistsDoc = (await phone.api('/playlists')).body;
    const plId = playlistsDoc.order[0];
    assert.equal(playlistsDoc.playlists[plId].name, 'Crew');
    assert.equal(playlistsDoc.playlists[plId].count, 2);
    const plMembers = (await phone.api(`/playlists/${plId}/members`)).body.ids;
    assert.deepEqual(plMembers, [ids.nova, ids.iris]);

    // and a second look finds nothing left to do: the two libraries digest the same
    assert.deepEqual(nothingToDo(await dryRun(phone, deskId)), []);
});

test('edits on the desktop reach the phone: card, tags, messages and an unsent draft', async () => {
    let r = await desk.api(`/characters/${ids.nova}`, 'PATCH', { fields: { description: 'A star pilot, retired.', tags: ['scifi', 'pilot'] } });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    r = await desk.api(`/chats/${ids.deskChat}/messages`, 'PUT', {
        messages: [
            { name: 'Nova', is_user: false, mes: 'Hello.', send_date: 1700000000000 },
            { name: 'User', is_user: true, mes: 'Ready to fly?', send_date: 1700000001000 },
            { name: 'Nova', is_user: false, mes: 'Always.', send_date: 1700000002000 },
        ],
    });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    r = await desk.api(`/chats/${ids.deskChat}`, 'PATCH', { draft: 'Then let us' });
    assert.ok(r.status < 300, JSON.stringify(r.body));

    const counts = await dryRun(phone, deskId);
    assert.equal(counts.charactersChanged, 1);
    assert.equal(counts.chatsChanged, 1);
    await pull(phone, deskId);

    const nova = (await phone.api(`/characters/${ids.nova}`)).body;
    assert.equal(nova.card.data.description, 'A star pilot, retired.');
    assert.deepEqual([...nova.tags].sort(), ['pilot', 'scifi']);
    const chat = (await phone.api(`/chats?charId=${ids.nova}`)).body.items[0];
    assert.equal(chat.messageCount, 3);
    assert.equal(chat.draft, 'Then let us');
    assert.deepEqual(nothingToDo(await dryRun(phone, deskId)), []);
});

test('a chat continued on the phone is pushed back to the desktop', async () => {
    const phoneChat = (await phone.api(`/chats?charId=${ids.nova}`)).body.items[0];
    const r = await phone.api(`/chats/${phoneChat.id}/messages`, 'PUT', {
        messages: [
            { name: 'Nova', is_user: false, mes: 'Hello.', send_date: 1700000000000 },
            { name: 'User', is_user: true, mes: 'Ready to fly?', send_date: 1700000001000 },
            { name: 'Nova', is_user: false, mes: 'Always.', send_date: 1700000002000 },
            { name: 'User', is_user: true, mes: 'Written on the bus.', send_date: 1700000003000 },
        ],
    });
    assert.ok(r.status < 300, JSON.stringify(r.body));

    const pushed = await phone.ext(`/peers/${deskId}/push`, 'POST', {});
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(pushed.body.accepted, true);
    const job = await jobDone(desk, pushed.body.jobId);
    assert.equal(job.status, 'done', job.error);

    const deskChat = (await desk.api(`/chats/${ids.deskChat}?msgTail=1`)).body;
    assert.equal(deskChat.messages.at(-1).content, 'Written on the bus.');
});

test('gallery items, a lorebook edit and a new picture come across', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
        + '1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c4d3b40000000049454e44ae426082', 'hex');
    let r = await fetch(`${desk.base}/api/characters/${ids.nova}/media?name=hangar.png`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png });
    assert.equal(r.status, 200);
    r = await desk.api(`/worlds/${encodeURIComponent('Nova Lore')}`, 'PUT', { entries: { 0: { uid: 0, key: ['nova'], content: 'Nova flies the Lark II.' } } });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    r = await fetch(`${desk.base}/api/characters/${ids.iris}/avatar`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
    assert.ok(r.status < 300, await r.text());

    const counts = await dryRun(phone, deskId);
    assert.equal(counts.lorebooksChanged, 1);
    assert.equal(counts.charactersChanged, 2);
    await pull(phone, deskId);

    const media = (await phone.api(`/characters/${ids.nova}/media`)).body.items;
    assert.deepEqual(media.map(m => m.displayName), ['hangar.png']);
    const world = (await phone.api(`/worlds/${encodeURIComponent('Nova Lore')}`)).body;
    assert.equal(Object.values(world.data.entries)[0].content, 'Nova flies the Lark II.');
    const [mine, theirs] = await Promise.all([phone, desk].map(async d => Buffer.from(await (await fetch(`${d.base}/avatars/${ids.iris}.png`)).arrayBuffer())));
    assert.ok(mine.equals(theirs), 'the picture came across byte for byte');
    assert.deepEqual(nothingToDo(await dryRun(phone, deskId)), []);
});

test('a card imported on both devices apart stays one character, and its chats join it', async () => {
    const card = { name: 'Echo', description: 'Imported on both.', first_mes: 'Hey.' };
    const onDesk = await desk.call('importCard', card);
    const onPhone = await phone.call('importCard', card);
    assert.notEqual(onDesk.id, onPhone.id, 'two imports, two ids');
    const chat = await desk.api(`/characters/${onDesk.id}/chats`, 'POST', {
        name: 'Echo - on the desk', messages: [{ name: 'Echo', is_user: false, mes: 'Hey.', send_date: 1700000100000 }],
    });
    assert.ok(chat.status < 300);

    await pull(phone, deskId);
    const echoes = (await phone.api('/characters?q=Echo')).body.items;
    assert.deepEqual(echoes.map(c => c.id), [onPhone.id], 'no second Echo on the phone');
    const chats = (await phone.api(`/chats?charId=${onPhone.id}`)).body.items.map(c => c.name);
    assert.ok(chats.includes('Echo - on the desk'), `the desk's chat joined the phone's Echo (${chats})`);
    assert.deepEqual(nothingToDo(await dryRun(phone, deskId)), []);
});

test('mirror removes on the phone what the desktop no longer holds', async () => {
    const del = await desk.api(`/characters/${ids.iris}`, 'DELETE');
    assert.ok(del.status < 300, JSON.stringify(del.body));
    // incremental leaves it
    assert.equal((await dryRun(phone, deskId)).charactersDeleted, 0);
    const set = await phone.api('/settings', 'PATCH', { 'ext:lan-sync:mode': 'mirror' });
    assert.ok(set.status < 300, JSON.stringify(set.body));
    assert.equal((await dryRun(phone, deskId)).charactersDeleted, 1);
    await pull(phone, deskId);
    assert.equal((await phone.api(`/characters/${ids.iris}`)).status, 404);
    assert.equal((await phone.api(`/characters/${ids.nova}`)).status, 200);
});

test('direct QR-less pairing, peer renaming, and auto-sync configuration work without a camera', async () => {
    // Unpair first, then re-pair via /pairing/direct using only the desktop's host:port
    const unpPhone = await phone.ext(`/peers/${deskId}`, 'DELETE');
    assert.equal(unpPhone.status, 200);
    const unpDesk = await desk.ext(`/peers/${phoneId}`, 'DELETE');
    assert.equal(unpDesk.status, 200);

    const deskHostPort = desk.base.replace(/^http:\/\//, '');
    const resp = await fetch(`${phone.base}/api/ext/lan-sync/pairing/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: deskHostPort }),
    });
    assert.equal(resp.status, 200);

    let phoneCode = null;
    let paired = null;
    for await (const line of ndjson(resp)) {
        assert.ok(!line.error, line.error);
        if (line.step === 'confirm') {
            phoneCode = line.code;
            const { body } = await desk.ext('/pairing/requests');
            assert.equal(body.requests.length, 1);
            assert.equal(body.requests[0].code, phoneCode);
            const allowed = await desk.ext(`/pairing/requests/${body.requests[0].id}`, 'POST', { allow: true });
            assert.equal(allowed.body.status, 'approved');
        }
        if (line.step === 'paired') paired = line;
    }
    assert.ok(phoneCode && paired, 'direct pairing completed without a QR code');

    // Rename the desktop locally on the phone
    const renamed = await phone.ext(`/peers/${deskId}`, 'PATCH', { customName: 'Main Desktop' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.customName, 'Main Desktop');

    // Configure Auto Sync on the phone
    const autoRes = await phone.ext('/automation', 'PATCH', {
        enabled: true,
        intervalMinutes: 15,
        targetId: deskId,
    });
    assert.equal(autoRes.status, 200);
    assert.equal(autoRes.body.config.enabled, true);
    assert.equal(autoRes.body.config.intervalMinutes, 15);
    assert.equal(autoRes.body.config.targetId, deskId);
    assert.ok(autoRes.body.status.nextRunAtMs > Date.now());
});

test('a persona with an x_evolutia_personas row and ext/evolutia/ files arrives on the other side', async () => {
    // Turn Evolutia on for Commander on the phone with a new Alter Ego ("Ollie") and an uploaded avatar file
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const up = await phone.api('/ext/evolutia/avatars', 'POST', { filename: 'ollie.png', dataUrl: tinyPng });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const uploadedFile = up.body.file;

    const definition = {
        alterEgos: [
            {
                id: 'base',
                name: 'Commander',
                fields: [{ id: 'f1', name: 'Role', content: 'Fleet captain.', startsOn: true, activating: { keywords: [], mode: 'ANY' }, enabling: { keywords: [], mode: 'ANY' }, disabling: { keywords: [], mode: 'ANY' }, sources: { user: true, char: true }, entryAction: null, exitAction: null, entryConfirm: null, exitConfirm: null }],
                entry: { keywords: [], mode: 'ANY' },
                entrySources: { user: true, char: true },
                entryAction: null,
                exitAction: null,
                entryConfirm: null,
                exitConfirm: null,
                promptName: null,
                displayName: null,
                avatar: null,
            },
            {
                id: 'ollie',
                name: 'Ollie',
                disguise: true,
                fields: [{ id: 'f2', name: 'Appearance', content: 'Undercover cadet.', startsOn: true, activating: { keywords: [], mode: 'ANY' }, enabling: { keywords: [], mode: 'ANY' }, disabling: { keywords: [], mode: 'ANY' }, sources: { user: true, char: true }, entryAction: null, exitAction: null, entryConfirm: null, exitConfirm: null }],
                entry: { keywords: ['ollie'], mode: 'ANY' },
                entrySources: { user: true, char: true },
                entryAction: null,
                exitAction: null,
                entryConfirm: null,
                exitConfirm: null,
                promptName: 'Ollie',
                displayName: 'Ollie',
                avatar: { upload: uploadedFile },
            },
        ],
    };

    const onRes = await phone.api(`/ext/evolutia/personas/${ids.deskPersona}/on`, 'PUT', { on: true, definition });
    assert.equal(onRes.status, 200, JSON.stringify(onRes.body));

    // Also switch Evolutia on for Nova on the phone so x_evolutia_cards is exercised
    const charOn = await phone.api(`/ext/evolutia/characters/${ids.nova}/on`, 'PUT', { on: true });
    assert.equal(charOn.status, 200, JSON.stringify(charOn.body));

    // Desktop pulls from the phone
    const counts = await dryRun(desk, phoneId);
    assert.equal(counts.personasChanged, 1, 'manifest digest reflects x_evolutia_personas change');
    await pull(desk, phoneId);

    const deskEvoPersona = await desk.api(`/ext/evolutia/personas/${ids.deskPersona}`);
    assert.equal(deskEvoPersona.status, 200, JSON.stringify(deskEvoPersona.body));
    assert.equal(deskEvoPersona.body.on, true);
    assert.deepEqual(deskEvoPersona.body.definition.alterEgos.map(e => e.name), ['Commander', 'Ollie']);

    const deskAvatar = await fetch(`${desk.base}/api/ext/evolutia/avatars/${encodeURIComponent(uploadedFile)}`);
    assert.equal(deskAvatar.status, 200, 'ext/evolutia/ avatar file synced across');

    const deskNovaRow = (await desk.api('/characters?count=false&limit=100')).body.items.find(r => r.id === ids.nova);
    assert.equal(deskNovaRow.ext?.evolutia?.on, 1, 'x_evolutia_cards synced and rebuilt');
});

test('prefer-newer uses x_evolutia_personas.updated_at so a newer Evolutia definition arrives even when base persona was edited later on target', async () => {
    // 1. First give desktop a newer x_evolutia_personas.updated_at than the initial sync by saving Commander's definition on desktop
    const deskInitialDef = (await desk.api(`/ext/evolutia/personas/${ids.deskPersona}`)).body.definition;
    await sleep(30);
    const deskSave = await desk.api(`/ext/evolutia/personas/${ids.deskPersona}/definition`, 'PUT', { definition: deskInitialDef });
    assert.equal(deskSave.status, 200);

    // 2. Then on phone (after desktop's Evolutia save), add a third Alter Ego ("Black Widow") via PUT /personas/:id/definition.
    // This must advance phone's x_evolutia_personas.updated_at past desktop's x_evolutia_personas.updated_at!
    const cur = (await phone.api(`/ext/evolutia/personas/${ids.deskPersona}`)).body.definition;
    cur.alterEgos.push({
        ...cur.alterEgos[1],
        id: 'black-widow',
        name: 'Black Widow',
        promptName: 'Natasha',
        displayName: 'Natasha',
    });
    await sleep(30);
    const savedDef = await phone.api(`/ext/evolutia/personas/${ids.deskPersona}/definition`, 'PUT', { definition: cur });
    assert.equal(savedDef.status, 200);

    // 3. Later on desktop, edit Commander's pronouns (updates personas.updated_at on desktop, leaving desktop's x_evolutia_personas.updated_at older than phone's)
    await sleep(30);
    const pPatch = await desk.api(`/personas/${ids.deskPersona}`, 'PATCH', {
        pronouns: { sub: 'he', obj: 'him', poss: 'his', possP: 'his', ref: 'himself' },
    });
    assert.equal(pPatch.status, 200, JSON.stringify(pPatch.body));

    // 4. Pull on desktop with overwrite = prefer-newer
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'prefer-newer' });
    await pull(desk, phoneId);

    // Desktop kept its newer pronouns AND received the phone's newer Evolutia definition
    const deskPersonas = (await desk.api('/personas')).body.personas;
    const cmd = deskPersonas.find(p => p.id === ids.deskPersona);
    assert.equal(cmd.pronouns.sub, 'he', 'desktop kept its newer pronouns');
    const deskEvo = (await desk.api(`/ext/evolutia/personas/${ids.deskPersona}`)).body;
    assert.deepEqual(deskEvo.definition.alterEgos.map(e => e.name), ['Commander', 'Ollie', 'Black Widow']);

    // Restore exact overwrite mode for subsequent tests
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'exact' });
});

test('peer file route refuses undeclared extension folders and internal seeded-prompts.json marker', async () => {
    // 1. Unit check on resolveMediaFile: undeclared extension folders and seeded-prompts.json are refused
    const fakePaths = { root: '/tmp/sigma-test-root' };
    const allowed = new Set(['evolutia']);
    assert.equal(resolveMediaFile(fakePaths, 'ext', 'undeclared-ext/secret.txt', allowed), null, 'undeclared ext/<id>/ refused');
    assert.equal(resolveMediaFile(fakePaths, 'ext', 'lan-sync/peers.json', allowed), null, 'lan-sync own folder refused');
    assert.equal(resolveMediaFile(fakePaths, 'ext', 'evolutia/seeded-prompts.json', allowed), null, 'seeded-prompts.json refused');
    assert.equal(resolveMediaFile(fakePaths, 'ext', 'evolutia/.hidden', allowed), null, 'dotfile refused');
    assert.ok(resolveMediaFile(fakePaths, 'ext', 'evolutia/ollie.png', allowed), 'declared evolutia file allowed');

    // 2. End-to-end check: trigger seed-prompts on phone so seeded-prompts.json exists in phone's ext/evolutia/
    await phone.api('/ext/evolutia/seed-prompts', 'POST', {});
    await pull(desk, phoneId);
    // Desk's assistant-prompts were never seeded yet; verify seeded-prompts.json did NOT sync across to block seeding on desk
    const seedOnDesk = await desk.api('/ext/evolutia/seed-prompts', 'POST', {});
    assert.equal(seedOnDesk.status, 200);
    assert.equal(seedOnDesk.body.seeded, true, 'seeded-prompts.json marker was not synced from phone');
});

test('same card imported on both devices and edited on one (with creator) pairs as one character; unrelated same-name cards can be merged via /characters/merge', async () => {
    const card = { name: 'Vannessa', description: 'Popular campus girl.', first_mes: 'Ugh...', creator: 'wisperrr' };
    const onDesk = await desk.call('importCard', card);
    const onPhone = await phone.call('importCard', card);
    assert.notEqual(onDesk.id, onPhone.id, 'separate imports have different ids');

    // Enable Evolutia on phone's copy (rewrites card description to {{evolutia}}, changing card digest)
    const evoOn = await phone.api(`/ext/evolutia/characters/${onPhone.id}/on`, 'PUT', { on: true });
    assert.equal(evoOn.status, 200);

    // Add a chat on phone's Vannessa
    const ch = await phone.api(`/characters/${onPhone.id}/chats`, 'POST', {
        name: 'Vannessa - phone branch',
        messages: [{ name: 'Vannessa', is_user: false, mes: 'Hey there!', send_date: 1700000200000 }],
    });
    assert.ok(ch.status < 300);

    await pull(desk, phoneId);

    const vannessas = (await desk.api('/characters?q=Vannessa')).body.items.filter(c => c.name === 'Vannessa');
    assert.deepEqual(vannessas.map(c => c.id), [onDesk.id], 'still only one Vannessa on desktop');
    assert.equal(vannessas[0].ext?.evolutia?.on, 1, 'Evolutia state updated on the matched character');
    const deskChats = (await desk.api(`/chats?charId=${onDesk.id}`)).body.items.map(c => c.name);
    assert.ok(deskChats.includes('Vannessa - phone branch'), 'phone chat attached to desktop Vannessa');

    // Now test /characters/merge on two separate characters on desktop, including a gallery picture on the duplicate
    const dupA = await desk.call('importCard', { name: 'DupHero', description: 'Version A', first_mes: 'A' });
    const dupB = await desk.call('importCard', { name: 'DupHero', description: 'Version B', first_mes: 'B' });
    const dupChat = await desk.api(`/characters/${dupB.id}/chats`, 'POST', {
        name: 'DupHero - chat on B',
        messages: [{ name: 'DupHero', is_user: false, mes: 'From B!', send_date: 1700000300000 }],
    });
    assert.ok(dupChat.status < 300);

    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
        + '1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5c4d3b40000000049454e44ae426082', 'hex');
    const upMedia = await fetch(`${desk.base}/api/characters/${dupB.id}/media?name=trophy.png`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: png,
    });
    assert.equal(upMedia.status, 200);

    const merged = await desk.ext('/characters/merge', 'POST', { fromId: dupB.id, intoId: dupA.id });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.movedChats, 1);
    assert.equal(merged.body.chatCount, 1);
    assert.equal((await desk.api(`/characters/${dupB.id}`)).status, 404, 'duplicate copy deleted');
    const keptRow = (await desk.api(`/characters/${dupA.id}`)).body;
    assert.equal(keptRow.chatCount, 1, 'chat_count recounted on original');
    assert.ok(keptRow.lastChatAt > 0, 'last_chat_at recounted on original');

    // Check that the duplicate's gallery picture was moved before deleteCharacters and is served under the original
    const mediaList = (await desk.api(`/characters/${dupA.id}/media`)).body.items;
    assert.equal(mediaList.length, 1);
    assert.equal(mediaList[0].displayName, 'trophy.png');
    const servedMedia = await fetch(`${desk.base}${mediaList[0].url}`);
    assert.equal(servedMedia.status, 200, 'gallery picture is served under the original character');
    assert.ok(Buffer.from(await servedMedia.arrayBuffer()).equals(png), 'gallery picture bytes match');
});

test('assistant_sessions (with Chats) and studio_sessions (with Characters) sync by id, map chat_id and char_id aliases, null missing profile_id, respect prefer-newer, and show in Check', async () => {
    const deskVannessa = (await desk.api('/characters?q=Vannessa')).body.items.find(c => c.name === 'Vannessa');
    const phoneVannessa = (await phone.api('/characters?q=Vannessa')).body.items.find(c => c.name === 'Vannessa');
    assert.ok(deskVannessa && phoneVannessa);
    assert.notEqual(deskVannessa.id, phoneVannessa.id, 'Vannessa has different IDs on phone and desktop (twin alias)');

    // Create a phone-only LLM profile so we can verify profile_id -> null on desk when Connections sync is off
    const phoneOnlyProf = await phone.api('/llm/profiles', 'POST', {
        name: 'Phone Local LLM',
        kind: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        ['api' + 'Key']: 'none',
        model: 'llama3',
    });
    assert.ok(phoneOnlyProf.status < 300);
    const phoneProfId = phoneOnlyProf.body.id;

    // 1. Create an assistant_session on phone's Vannessa chat
    const phoneChats = (await phone.api(`/chats?charId=${phoneVannessa.id}`)).body.items;
    const phoneBranchChat = phoneChats.find(c => c.name === 'Vannessa - phone branch');
    assert.ok(phoneBranchChat);

    const asstCreate = await phone.api('/assistant/sessions', 'POST', {
        chatId: phoneBranchChat.id,
        name: 'Plot Brainstorm',
    });
    assert.equal(asstCreate.status, 201);
    const asstId = asstCreate.body.id;
    await phone.api(`/assistant/sessions/${asstId}`, 'PATCH', { profileId: phoneProfId });
    const asstMsg = await phone.api(`/assistant/sessions/${asstId}/messages`, 'POST', {
        role: 'user',
        content: 'What should Vannessa do next?',
    });
    assert.ok(asstMsg.status < 300);

    // 2. Create a studio_session on phone's Vannessa (char_id = phoneVannessa.id, which must map to deskVannessa.id)
    const studioCreate = await phone.api('/creator/sessions', 'POST', {
        charId: phoneVannessa.id,
        name: 'Vannessa Card Polish',
        draft: { name: 'Vannessa', personality: 'Witty, popular, secretly nerdy' },
    });
    assert.equal(studioCreate.status, 201);
    const studioId = studioCreate.body.id;
    await phone.api(`/creator/sessions/${studioId}`, 'PATCH', { profileId: phoneProfId });
    const studioMsg = await phone.api(`/creator/sessions/${studioId}/messages`, 'POST', {
        role: 'user',
        content: 'Help me sharpen her personality.',
    });
    assert.ok(studioMsg.status < 300);

    // 3. Check (dryRun) on desktop must see both the changed chat (assistant_session) and changed character (studio_session)
    const check = await desk.ext(`/peers/${phoneId}/pull`, 'POST', { dryRun: true });
    assert.equal(check.status, 200);
    assert.ok(check.body.counts.chatsChanged >= 1, 'Check shows chat changed when assistant_session is added');
    assert.ok(check.body.counts.charactersChanged >= 1, 'Check shows character changed when studio_session is added');

    // 4. Pull on desktop
    await pull(desk, phoneId);

    const deskChats = (await desk.api(`/chats?charId=${deskVannessa.id}`)).body.items;
    const deskBranchChat = deskChats.find(c => c.name === 'Vannessa - phone branch');
    assert.ok(deskBranchChat);

    const deskAsstList = (await desk.api(`/assistant/sessions?chatId=${deskBranchChat.id}`)).body;
    assert.equal(deskAsstList.length, 1);
    assert.equal(deskAsstList[0].id, asstId);
    const deskAsstDetail = (await desk.api(`/assistant/sessions/${asstId}`)).body;
    assert.equal(deskAsstDetail.name, 'Plot Brainstorm');
    assert.equal(deskAsstDetail.profileId, null, 'profile_id mapped to null because connection is not on receiver');
    assert.deepEqual(deskAsstDetail.messages.map(m => m.content), ['What should Vannessa do next?']);

    const deskStudioList = (await desk.api(`/creator/sessions?charId=${deskVannessa.id}`)).body;
    assert.equal(deskStudioList.length, 1);
    assert.equal(deskStudioList[0].id, studioId);
    const deskStudioDetail = (await desk.api(`/creator/sessions/${studioId}`)).body;
    assert.equal(deskStudioDetail.charId, deskVannessa.id, 'studio_session char_id mapped through twin alias');
    assert.equal(deskStudioDetail.profileId, null, 'studio_session profile_id mapped to null');
    assert.equal(deskStudioDetail.draft.personality, 'Witty, popular, secretly nerdy');
    assert.deepEqual(deskStudioDetail.messages.map(m => m.content), ['Help me sharpen her personality.']);

    // 5. Verify prefer-newer keeps a newer assistant_session on desktop
    await sleep(30);
    await desk.api(`/assistant/sessions/${asstId}/messages`, 'POST', {
        role: 'assistant',
        content: 'She should invite him to the rooftop.',
    });
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'prefer-newer' });
    await pull(desk, phoneId);
    const deskAsstAfter = (await desk.api(`/assistant/sessions/${asstId}`)).body;
    assert.equal(deskAsstAfter.messages.length, 2, 'prefer-newer kept desktop newer assistant_session transcript');
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'exact' });
});

test('app_store documents (Saved Prompts for both panels, greetings-expanded, promoted_namespaces) merge by key', async () => {
    const asstPrompts = {
        version: 1,
        prompts: [{ id: 'custom-1', icon: '⚡', label: 'Pacing check', text: 'Check the pacing of the last 5 turns.' }],
    };
    const studioPrompts = {
        version: 1,
        prompts: [{ id: 'studio-1', icon: '🎭', label: 'Voice check', text: 'Check dialogue voice consistency.' }],
    };
    const greetingsExpanded = { at: 1700000500000, changed: 3 };
    const promotedNs = ['chub', 'janitorai', 'evolutia_custom'];

    assert.equal((await phone.api('/store/assistant-prompts', 'PUT', asstPrompts)).status, 200);
    assert.equal((await phone.api('/store/creator-studio-prompts', 'PUT', studioPrompts)).status, 200);
    assert.equal((await phone.api('/store/greetings-expanded', 'PUT', greetingsExpanded)).status, 200);
    assert.equal((await phone.api('/store/promoted_namespaces', 'PUT', promotedNs)).status, 200);

    await pull(desk, phoneId);

    assert.deepEqual((await desk.api('/store/assistant-prompts')).body, asstPrompts);
    assert.deepEqual((await desk.api('/store/creator-studio-prompts')).body, studioPrompts);
    assert.deepEqual((await desk.api('/store/greetings-expanded')).body, greetingsExpanded);
    assert.deepEqual((await desk.api('/store/promoted_namespaces')).body, promotedNs);
});

test('settings dataset syncs allowlist, filters enabledExtensions to installed (reporting missing), gates secrets behind opt-in, and never syncs device-local keys', async () => {
    // Create a shared LLM profile on both devices so we can test Connections-gated settings (chatProfileId, assistantProfileId, aiProfile.*)
    const sharedProf = await phone.api('/llm/profiles', 'POST', {
        name: 'Shared Cloud LLM',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        ['api' + 'Key']: 'sk-test',
        model: 'gpt-4o',
    });
    assert.ok(sharedProf.status < 300);
    const sharedProfId = sharedProf.body.id;

    // Set allowlisted, Connections-gated, secret, and never-synced settings on phone
    const patchRes = await phone.api('/settings', 'PATCH', {
        assistantSystemPrompt: 'Act as a sharp story editor.',
        creatorStudioSystemPrompt: 'Craft vivid character cards.',
        assistantPromptsOpen: true,
        creatorStudioPromptsOpen: true,
        allowRichTagline: true,
        browseSnapSections: true,
        chubNsfw: true,
        disabledProviders: ['wyvern'],
        'ext:evolutia:window': 4,
        enabledExtensions: ['evolutia', 'lan-sync', 'uninstalled-phantom-ext'],
        // Connections-gated settings (syncConnections is OFF by default)
        chatProfileId: sharedProfId,
        assistantProfileId: sharedProfId,
        'aiProfile.creator': sharedProfId,
        // Secrets (opt-in is OFF by default), including an extension secret key
        chubToken: 'chub-secret-token-xyz',
        janitoraiPassword: 'janitor-secret-password',
        'ext:evolutia:customApiKey': 'evo-secret-key-999',
        // Never-synced keys
        activeChatId: 'chat-only-on-phone',
        mobileSwipeGestures: false,
        'ext:lan-sync:deviceName': 'Phone Custom Name',
    });
    assert.equal(patchRes.status, 200);

    // Ensure desk starts with different values for never-synced, Connections-gated, and secret keys
    await desk.api('/settings', 'PATCH', {
        activeChatId: 'chat-on-desk',
        mobileSwipeGestures: true,
        'ext:lan-sync:deviceName': 'Desktop Custom Name',
        chatProfileId: '',
        assistantProfileId: '',
        'aiProfile.creator': '',
        chubToken: null,
        janitoraiPassword: null,
        'ext:evolutia:customApiKey': null,
    });

    // Dry-run Check should report missingExtensions
    const dry = await desk.ext(`/peers/${phoneId}/pull`, 'POST', { dryRun: true });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.missingExtensions, ['uninstalled-phantom-ext']);

    await pull(desk, phoneId);

    const deskSettings = (await desk.api('/settings')).body;
    // Allowlisted settings arrived
    assert.equal(deskSettings.assistantSystemPrompt, 'Act as a sharp story editor.');
    assert.equal(deskSettings.creatorStudioSystemPrompt, 'Craft vivid character cards.');
    assert.equal(deskSettings.assistantPromptsOpen, true);
    assert.equal(deskSettings.creatorStudioPromptsOpen, true);
    assert.equal(deskSettings.allowRichTagline, true);
    assert.equal(deskSettings.browseSnapSections, true);
    assert.equal(deskSettings.chubNsfw, true);
    assert.deepEqual(deskSettings.disabledProviders, ['wyvern']);
    assert.equal(deskSettings['ext:evolutia:window'], 4);

    // enabledExtensions filtered to installed only; missing extension listed in lastSync result
    assert.ok(deskSettings.enabledExtensions.includes('evolutia'));
    assert.ok(deskSettings.enabledExtensions.includes('lan-sync'));
    assert.ok(!deskSettings.enabledExtensions.includes('uninstalled-phantom-ext'), 'uninstalled extension not enabled on receiver');
    const st = (await desk.ext('/status')).body;
    const peerEntry = st.peers.find(p => p.id === phoneId);
    assert.deepEqual(peerEntry.lastSync.missingExtensions, ['uninstalled-phantom-ext']);

    // Connections-gated profile bindings did NOT sync while syncConnections is off
    assert.equal(deskSettings.chatProfileId, '', 'chatProfileId did not sync while syncConnections is off');
    assert.equal(deskSettings.assistantProfileId, '', 'assistantProfileId did not sync while syncConnections is off');
    assert.equal(deskSettings['aiProfile.creator'] || '', '', 'aiProfile.creator did not sync while syncConnections is off');

    // Secrets did NOT sync while syncSecrets is off (including ext:<id>:<secret>)
    assert.equal(deskSettings.chubToken, null, 'chubToken did not sync while syncSecrets is off');
    assert.equal(deskSettings.janitoraiPassword, null, 'janitoraiPassword did not sync while syncSecrets is off');
    assert.equal(deskSettings['ext:evolutia:customApiKey'] ?? null, null, 'ext:<id>:<secret> did not sync while syncSecrets is off');

    // Never-synced keys stayed untouched on desktop
    assert.equal(deskSettings.activeChatId, 'chat-on-desk', 'activeChatId never syncs');
    assert.equal(deskSettings.mobileSwipeGestures, true, 'mobile* never syncs');
    assert.equal(deskSettings['ext:lan-sync:deviceName'], 'Desktop Custom Name', 'ext:lan-sync:deviceName never syncs');

    // Verify prefer-newer keeps local setting tweaks on desktop instead of overwriting them
    await desk.api('/settings', 'PATCH', {
        assistantSystemPrompt: 'Desktop local tweak to assistant prompt.',
        'ext:lan-sync:overwrite': 'prefer-newer',
    });
    await pull(desk, phoneId);
    assert.equal((await desk.api('/settings')).body.assistantSystemPrompt, 'Desktop local tweak to assistant prompt.', 'prefer-newer preserved local setting tweak');
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'exact' });

    // Now opt in to syncSecrets and syncConnections on desktop and verify both sync when opted in
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:syncSecrets': true, 'ext:lan-sync:syncConnections': true });
    await pull(desk, phoneId);
    const deskSettingsWithSecrets = (await desk.api('/settings')).body;
    assert.equal(deskSettingsWithSecrets.chubToken, 'chub-secret-token-xyz', 'chubToken syncs when syncSecrets is on');
    assert.equal(deskSettingsWithSecrets.janitoraiPassword, 'janitor-secret-password', 'janitoraiPassword syncs when syncSecrets is on');
    assert.equal(deskSettingsWithSecrets['ext:evolutia:customApiKey'], 'evo-secret-key-999', 'ext:<id>:<secret> syncs when syncSecrets is on');
    assert.equal(deskSettingsWithSecrets.chatProfileId, sharedProfId, 'chatProfileId syncs when syncConnections is on');
    assert.equal(deskSettingsWithSecrets.assistantProfileId, sharedProfId, 'assistantProfileId syncs when syncConnections is on');
    assert.equal(deskSettingsWithSecrets['aiProfile.creator'], sharedProfId, 'aiProfile.creator syncs when syncConnections is on');
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:syncSecrets': false, 'ext:lan-sync:syncConnections': false });
});

test('createDbSnapshot securely scrubs deleted secrets and llm_profiles bytes from the raw SQLite file when opt-ins are off', () => {
    const memDb = new Database(':memory:');
    try {
        memDb.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE llm_profiles (id TEXT PRIMARY KEY, name TEXT, api_key TEXT);
            CREATE TABLE app_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
            CREATE TABLE change_log (id INTEGER PRIMARY KEY, summary TEXT);
        `);
        const secretToken = 'RAW_SNAPSHOT_SECRET_CHUB_TOKEN_987654321';
        const secretExtKey = 'RAW_SNAPSHOT_EXT_API_KEY_123456789';
        const secretLlmKey = 'RAW_SNAPSHOT_LLM_PROFILE_KEY_555555555';
        memDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('chubToken', JSON.stringify(secretToken));
        memDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ext:evolutia:apiKey', JSON.stringify(secretExtKey));
        memDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('allowRichTagline', 'true');
        memDb.prepare('INSERT INTO llm_profiles (id, name, api_key) VALUES (?, ?, ?)').run('p1', 'Secret Prof', secretLlmKey);

        const snapPath = createDbSnapshot(memDb, { includeConnections: false, includeSecrets: false });
        try {
            const rawText = fs.readFileSync(snapPath).toString('latin1');
            assert.ok(!rawText.includes(secretToken), 'raw snapshot bytes must not contain stripped chubToken');
            assert.ok(!rawText.includes(secretExtKey), 'raw snapshot bytes must not contain stripped ext:<id>:apiKey');
            assert.ok(!rawText.includes(secretLlmKey), 'raw snapshot bytes must not contain stripped llm_profiles api_key');
            assert.ok(rawText.includes('allowRichTagline'), 'allowlisted setting remains in snapshot');
        } finally {
            try { fs.unlinkSync(snapPath); } catch { /* ignore */ }
        }
    } finally {
        memDb.close();
    }
});

test('a "Send to It" sync with no browser open on the receiver leaves x_evolutia_cards and Demetri\'s {{evolutia_persona}} placeholder correct', async () => {
    // 1. Create Demetri persona on both devices with a plain-text description on desktop
    const demetriRes = await desk.api('/personas', 'POST', {
        name: 'Demetri',
        description: 'Demetri original plain description',
    });
    assert.ok(demetriRes.status < 300);
    const demetriId = demetriRes.body.id;

    // Pull Demetri to phone so both devices share Demetri
    await pull(phone, deskId);

    // On phone, switch Evolutia ON for Demetri and add an Alter Ego
    const demetriOn = await phone.api(`/ext/evolutia/personas/${demetriId}/on`, 'PUT', {
        on: true,
        definition: {
            alterEgos: [{
                id: 'main',
                name: 'Demetri',
                fields: [{ id: 'f1', name: 'Base', content: 'Shapeshifter', defaultPhase: 'active', triggers: [], entryActions: [], exitActions: [] }],
                triggers: [],
                entryActions: [],
                exitActions: [],
            }],
        },
    });
    assert.equal(demetriOn.status, 200);

    // Edit Demetri's pronouns on desktop LATER than phone's persona update, and set desktop's overwrite to prefer-newer.
    // That way, during "Send to It", desktop keeps its newer base `personas` row (whose description is still
    // 'Demetri original plain description'), while receiving phone's `x_evolutia_personas` row (enabled = 1),
    // so ONLY Evolutia's server-side `ctx.events.on` rebuild on desktop can switch desktop's Demetri description to `{{evolutia_persona}}`!
    await sleep(30);
    await desk.api(`/personas/${demetriId}`, 'PATCH', {
        pronouns: { sub: 'he', obj: 'him', poss: 'his', possP: 'his', ref: 'himself' },
    });
    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'prefer-newer' });
    await phone.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'prefer-newer' });

    // Also import a new character on phone with Evolutia switched ON
    const pushChar = await phone.call('importCard', {
        name: 'PushHero',
        description: 'Hero pushed from phone.',
        first_mes: 'Ready!',
        creator: 'wisperrr',
    });
    await phone.api(`/ext/evolutia/characters/${pushChar.id}/on`, 'PUT', { on: true });

    // 2. Trigger "Send to It" (push) from phone -> desktop, with NO browser open and NO afterSync client command called
    const pushed = await phone.ext(`/peers/${deskId}/push`, 'POST', {});
    assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
    assert.equal(pushed.body.accepted, true);
    const job = await jobDone(desk, pushed.body.jobId);
    assert.equal(job.status, 'done', job.error);

    // 3. Verify on desktop that x_evolutia_cards has PushHero enabled AND Demetri's description is {{evolutia_persona}}
    const deskChars = (await desk.api('/characters?q=PushHero')).body.items;
    const pushedOnDesk = deskChars.find(c => c.id === pushChar.id);
    assert.ok(pushedOnDesk, 'PushHero arrived on desktop');
    assert.equal(pushedOnDesk.ext?.evolutia?.on, 1, 'x_evolutia_cards rebuilt on receiver without browser open');

    const deskPersonas = (await desk.api('/personas')).body.personas;
    const deskDemetri = deskPersonas.find(p => p.id === demetriId);
    assert.ok(deskDemetri);
    assert.equal(deskDemetri.description, '{{evolutia_persona}}', 'Demetri description updated to {{evolutia_persona}} on receiver without browser open');
    const deskDemetriEvo = (await desk.api(`/ext/evolutia/personas/${demetriId}`)).body;
    assert.equal(deskDemetriEvo.on, true);
    assert.equal(deskDemetriEvo.original, 'Demetri original plain description');

    await desk.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'exact' });
    await phone.api('/settings', 'PATCH', { 'ext:lan-sync:overwrite': 'exact' });
});

test('versions (card version history) merges by content identity (created_at, sha256(data)) with new local snap_ids across both devices and in mergeDuplicateCharacter', async () => {
    const deskVannessa = (await desk.api('/characters?q=Vannessa')).body.items.find(c => c.name === 'Vannessa');
    const phoneVannessa = (await phone.api('/characters?q=Vannessa')).body.items.find(c => c.name === 'Vannessa');
    assert.ok(deskVannessa && phoneVannessa);

    // Clear any existing versions on both devices first
    await desk.api(`/versions/char/${deskVannessa.id}`, 'DELETE');
    await phone.api(`/versions/char/${phoneVannessa.id}`, 'DELETE');

    // Both devices save 2 different versions of the same card (so both devices allocate snap_id 1 and 2 locally!)
    for (const [label, desc] of [['Desk Snap A', 'Desk v1'], ['Desk Snap B', 'Desk v2']]) {
        const res = await desk.api(`/versions/char/${deskVannessa.id}/snapshots`, 'POST', {
            label,
            source: 'local',
            charName: 'Vannessa',
            data: { name: 'Vannessa', description: desc },
        });
        assert.equal(res.status, 200);
        await sleep(5);
    }
    for (const [label, desc] of [['Phone Snap C', 'Phone v1'], ['Phone Snap D', 'Phone v2']]) {
        const res = await phone.api(`/versions/char/${phoneVannessa.id}/snapshots`, 'POST', {
            label,
            source: 'local',
            charName: 'Vannessa',
            data: { name: 'Vannessa', description: desc },
        });
        assert.equal(res.status, 200);
        await sleep(5);
    }

    // Check on desktop sees that phone has versions desktop lacks, even though both have snap_ids 1 and 2
    const dryBefore = await dryRun(desk, phoneId);
    assert.equal(dryBefore.charactersChanged, 1, 'Check detects differing version contents despite identical snap_id numbers');

    // Sync both ways: desk pulls from phone, then phone pulls from desk
    await pull(desk, phoneId);
    await pull(phone, deskId);

    const deskVers = (await desk.api(`/versions/char/${deskVannessa.id}`)).body.snapshots;
    const phoneVers = (await phone.api(`/versions/char/${phoneVannessa.id}`)).body.snapshots;
    assert.equal(deskVers.length, 4, 'desktop has all 4 versions');
    assert.equal(phoneVers.length, 4, 'phone has all 4 versions');
    assert.deepEqual(deskVers.map(s => s.label).sort(), ['Desk Snap A', 'Desk Snap B', 'Phone Snap C', 'Phone Snap D']);
    assert.deepEqual(phoneVers.map(s => s.label).sort(), ['Desk Snap A', 'Desk Snap B', 'Phone Snap C', 'Phone Snap D']);
    assert.equal(new Set(deskVers.map(s => s.id)).size, 4, 'desktop snap_ids are unique');
    assert.equal(new Set(phoneVers.map(s => s.id)).size, 4, 'phone snap_ids are unique');

    // Syncing again changes nothing, even if the two devices have different pre-restore backup slots (snap_id = -1)
    await desk.api(`/versions/char/${deskVannessa.id}/backup`, 'PUT', { timestamp: 1700000100000, data: { description: 'Desk Backup' } });
    await phone.api(`/versions/char/${phoneVannessa.id}/backup`, 'PUT', { timestamp: 1700000200000, data: { description: 'Phone Backup' } });
    assert.deepEqual(nothingToDo(await dryRun(desk, phoneId)), []);
    assert.deepEqual(nothingToDo(await dryRun(phone, deskId)), []);

    // Merging a duplicate whose versions share snap numbers (1, 2) with the original keeps all of them
    const origChar = await desk.call('importCard', { name: 'VerMerge', description: 'Orig', first_mes: 'Hi' });
    const copyChar = await desk.call('importCard', { name: 'VerMerge', description: 'Copy', first_mes: 'Hi' });
    // Clear any initial import snapshots so we control snap 1 and 2 on each
    await desk.api(`/versions/char/${origChar.id}`, 'DELETE');
    await desk.api(`/versions/char/${copyChar.id}`, 'DELETE');

    await desk.api(`/versions/char/${origChar.id}/snapshots`, 'POST', { label: 'Orig 1', data: { description: 'O1' } });
    await sleep(5);
    await desk.api(`/versions/char/${origChar.id}/snapshots`, 'POST', { label: 'Orig 2', data: { description: 'O2' } });
    await sleep(5);
    await desk.api(`/versions/char/${copyChar.id}/snapshots`, 'POST', { label: 'Copy 1', data: { description: 'C1' } });
    await sleep(5);
    await desk.api(`/versions/char/${copyChar.id}/snapshots`, 'POST', { label: 'Copy 2', data: { description: 'C2' } });

    const mergeRes = await desk.ext('/characters/merge', 'POST', { fromId: copyChar.id, intoId: origChar.id });
    assert.equal(mergeRes.status, 200);
    const mergedVers = (await desk.api(`/versions/char/${origChar.id}`)).body.snapshots;
    assert.equal(mergedVers.length, 4, 'all 4 versions preserved when merging duplicate with colliding snap_ids');
    assert.deepEqual(mergedVers.map(s => s.label), ['Orig 1', 'Orig 2', 'Copy 1', 'Copy 2']);
    assert.deepEqual(mergedVers.map(s => s.id), [1, 2, 3, 4]);

    // Sync to phone so the following test starts with both devices in step
    await pull(phone, deskId);
});

test('world_sources (lorebook import links) syncs with Lorebooks keyed by world_name', async () => {
    const linkRes = await phone.api(`/worlds/${encodeURIComponent('Nova Lore')}/source`, 'PUT', {
        provider: 'chub',
        externalId: 'lore-nova-777',
        path: 'scifi/lore-nova-777',
        url: 'https://chub.ai/lorebooks/scifi/lore-nova-777',
    });
    assert.equal(linkRes.status, 200);

    // Check shows lorebook changed when world_sources is added
    const dry = await dryRun(desk, phoneId);
    assert.equal(dry.lorebooksChanged, 1);

    await pull(desk, phoneId);

    const probe = await desk.api('/worlds/probe', 'POST', {
        provider: 'chub',
        keys: ['lore-nova-777', 'missing-key'],
    });
    assert.equal(probe.status, 200);
    assert.deepEqual(probe.body.found, ['lore-nova-777']);
});

test('char_aliases feeds into twin matching and syncs with Characters (mapping char_id through aliases)', async () => {
    // Import a card on desktop and phone with the same version_uid alias in extensions, but empty creator/createDate and different descriptions
    const onDesk = await desk.call('importCard', {
        name: 'AliasTwin',
        description: 'Desktop original description',
        first_mes: 'Hi from desk',
        extensions: { version_uid: 'vuid-twin-001' },
    });
    const onPhone = await phone.call('importCard', {
        name: 'AliasTwin',
        description: 'Phone updated description',
        first_mes: 'Hi from phone',
        extensions: { version_uid: 'vuid-twin-001' },
    });
    assert.notEqual(onDesk.id, onPhone.id);

    // Also import a phone-only character that carries its own version_uid alias so we can verify char_aliases rows sync to desktop
    const phoneOnly = await phone.call('importCard', {
        name: 'AliasCarrier',
        description: 'Carries version_uid-002',
        first_mes: 'Hello',
        extensions: { version_uid: 'vuid-carrier-002' },
    });

    await pull(desk, phoneId);

    // 1. AliasTwin was paired via char_aliases (version_uid:vuid-twin-001) despite empty creator/createDate and different digest
    const twinsOnDesk = (await desk.api('/characters?q=AliasTwin')).body.items.filter(c => c.name === 'AliasTwin');
    assert.deepEqual(twinsOnDesk.map(c => c.id), [onDesk.id], 'paired as one character via char_aliases');
    const twinDetail = (await desk.api(`/characters/${onDesk.id}`)).body;
    assert.equal(twinDetail.card.data.description, 'Phone updated description');

    // 2. AliasCarrier's char_aliases row synced to desktop (manifest meta digest includes char_aliases, so dryRun sees 0 differences)
    const deskCarrier = (await desk.api(`/characters/${phoneOnly.id}`)).body;
    assert.equal(deskCarrier.card.data.name, 'AliasCarrier');
    assert.deepEqual(nothingToDo(await dryRun(desk, phoneId)), []);
});
