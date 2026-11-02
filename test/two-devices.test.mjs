// Two real Project Σ servers, a desktop and a phone, paired the way a person pairs them (the phone joins with
// the desktop's link, the desktop approves the code both screens show), then synced both ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveMediaFile } from '../server/sync.js';

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
