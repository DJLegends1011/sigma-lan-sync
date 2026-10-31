// Two real Project Σ servers, a desktop and a phone, paired the way a person pairs them (the phone joins with
// the desktop's link, the desktop approves the code both screens show), then synced both ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
