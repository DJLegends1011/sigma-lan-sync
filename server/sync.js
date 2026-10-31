// A pull: scan both libraries, plan, then apply the plan through this server's own API. The order is
// TauriTavern's: transfers first, deletions last, so a sync stopped part way never leaves a library with
// less than it started with. Lorebooks go before characters, whose links name them.
import { buildManifest, walk, chatRows, eachLimited } from './manifest.js';
import { makePlan, planCounts, planSize, alignSource } from './plan.js';

const enc = encodeURIComponent;
const BUNDLE_BATCH = 10;

const datasetsOf = (o) => ['characters', 'chats', 'lorebooks'].filter(d => o[d] !== false);

const addCounts = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, (a?.[k] || 0) + b[k]]));

/**
 * Pull from a paired device into this library.
 * @param {object} p
 * @param {ReturnType<import('./http.js').localClient>} p.local
 * @param {ReturnType<import('./http.js').peerClient>} p.peer
 * @param {ReturnType<import('./store.js').makeStore>} p.store
 * @param {Record<string, string>} [p.aliases] the device's character ids mapped to this library's, for the same character imported on both
 * @param {{characters?: boolean, chats?: boolean, lorebooks?: boolean, mode: string, overwrite: string, dryRun?: boolean}} p.options
 * @returns {Promise<{counts: object, errors: object[], aliases: Record<string, string>}>}
 */
export async function runPull({ local, peer, store, options, aliases = {}, signal, progress = () => {} }) {
    // a second pass runs only when the import met characters this library already held under other ids:
    // their chats and edits then come across under the ids just learned
    let result = await pullPass({ local, peer, store, options, aliases, signal, progress });
    if (result.learned && !options.dryRun) {
        const again = await pullPass({ local, peer, store, options, aliases: result.aliases, signal, progress });
        again.counts = addCounts(result.counts, again.counts);
        again.errors = [...result.errors, ...again.errors];
        result = again;
    }
    return { counts: result.counts, errors: result.errors, aliases: result.aliases };
}

async function pullPass({ local, peer, store, options, aliases, signal, progress }) {
    const datasets = datasetsOf(options);
    const note = (text, done = 0, total = 0) => progress({ done, total, note: text });

    note('Scanning the other device');
    const theirs = await peer.json('/peer/manifest', { method: 'POST', json: { datasets }, signal, timeout: 0 });
    note('Scanning this library');
    const target = await buildManifest(local, store, { datasets, signal, onProgress: (t) => note(t) });

    note('Comparing');
    const aligned = alignSource(theirs, target, aliases);
    const known = aligned.aliases;
    const plan = makePlan(aligned.source, target, { datasets, mode: options.mode, overwrite: options.overwrite });
    const counts = planCounts(plan);
    if (options.dryRun) return { counts, errors: [], aliases: known, learned: false };

    const total = planSize(plan);
    const errors = [];
    let done = 0;
    const step = (text) => { done++; note(text, done, total); };
    const attempt = async (what, fn) => {
        if (signal?.aborted) throw signal.reason ?? new Error('stopped');
        try { await fn(); } catch (e) {
            if (signal?.aborted) throw e;
            errors.push({ what, error: e.message || String(e) });
        }
    };

    // ── lorebooks ──
    for (const name of plan.worlds.put) {
        await attempt(`lorebook "${name}"`, async () => {
            const doc = await peer.json(`/peer/world/${enc(name)}`, { signal });
            await local.request(`/api/worlds/${enc(name)}`, { method: 'PUT', json: doc.data ?? {}, signal });
        });
        step(`Lorebook ${name}`);
    }

    // ── new characters, as Σ's own transfer bundles: card, picture, chats, gallery and lorebooks together ──
    // A bundle never overwrites: a character this library already holds (its id taken, or its provider link
    // matched) comes back diverged, naming the character it matched, which becomes an alias
    let learned = false;
    for (let i = 0; i < plan.characters.create.length; i += BUNDLE_BATCH) {
        const ids = plan.characters.create.slice(i, i + BUNDLE_BATCH);
        await attempt(`${ids.length} new characters`, async () => {
            const bundle = await peer.request('/peer/bundle', { method: 'POST', json: { ids }, signal, timeout: 0 });
            const result = await local.json('/api/bundle/import', {
                method: 'POST', body: bundle.body, headers: { 'Content-Type': 'application/zip' }, signal,
            });
            for (const e of result.errors || []) errors.push({ what: 'a new character', error: e.error || e.message || JSON.stringify(e) });
            for (const d of result.diverged || []) {
                if (d.uid && d.matchId && d.uid !== d.matchId) { known[d.uid] = d.matchId; learned = true; }
            }
        });
        for (const id of ids) step(`New character ${id}`);
    }

    // ── changed characters: fetched by the source's id, written by this library's ──
    for (const item of plan.characters.update) {
        const from = enc(item.sourceId ?? item.id);
        await attempt(`character ${item.id}`, async () => {
            if (item.card) {
                const png = Buffer.from(await (await peer.request(`/peer/character/${from}/card`, { signal })).arrayBuffer());
                await local.request(`/api/characters/${enc(item.id)}/replace`, {
                    method: 'POST', body: png, headers: { 'Content-Type': 'image/png' }, signal,
                });
            }
            // after a replace too: a replace adds the card's tags to the ones held, the source's set is exact
            if (item.card || item.meta) {
                const meta = await peer.json(`/peer/character/${from}/meta`, { signal });
                await local.request(`/api/characters/${enc(item.id)}`, {
                    method: 'PATCH',
                    json: { fields: { tags: meta.tags, 'extensions.fav': meta.fav, 'extensions.update_locked': meta.updateLocked } },
                    signal,
                });
                await local.request(`/api/characters/${enc(item.id)}/worlds`, { method: 'PUT', json: { worlds: meta.worlds }, signal });
            }
            if (item.media) await pullGallery({ local, peer, id: item.id, sourceId: item.sourceId ?? item.id, signal });
        });
        step(`Character ${item.id}`);
    }

    // ── chats ──
    for (const c of plan.chats.create) {
        await attempt(`chat "${c.name}"`, async () => {
            const chat = await peer.json(`/peer/chat/${enc(c.id)}`, { signal, timeout: 120_000 });
            const made = await local.json(`/api/characters/${enc(c.charId)}/chats`, {
                method: 'POST',
                json: { name: chat.name, header: { chat_metadata: chat.chatMetadata || {} }, messages: chat.rows },
                signal,
            });
            if (chat.draft) await local.request(`/api/chats/${enc(made.id)}`, { method: 'PATCH', json: { draft: chat.draft }, signal });
        });
        step(`Chat ${c.name}`);
    }
    for (const c of plan.chats.update) {
        await attempt(`chat "${c.name}"`, async () => {
            const chat = await peer.json(`/peer/chat/${enc(c.id)}`, { signal, timeout: 120_000 });
            const mine = await local.json(`/api/chats/${enc(c.targetId)}?msgTail=1`, { signal });
            const theirs = chat.chatMetadata || {};
            // metadata merges key by key on the server: a key only this side holds is cleared with null
            const metadata = { ...theirs };
            for (const k of Object.keys(mine.chatMetadata || {})) if (!(k in theirs)) metadata[k] = null;
            const { rows: myRows } = await chatRows(local, c.targetId, signal);
            if (JSON.stringify(myRows) !== JSON.stringify(chat.rows)) {
                await local.request(`/api/chats/${enc(c.targetId)}/messages`, { method: 'PUT', json: { messages: chat.rows }, signal });
            }
            await local.request(`/api/chats/${enc(c.targetId)}`, {
                method: 'PATCH', json: { chatMetadata: metadata, draft: chat.draft || null }, signal,
            });
        });
        step(`Chat ${c.name}`);
    }

    // ── Mirror: what the source does not hold, last ──
    for (const id of plan.chats.delete) {
        await attempt(`removing chat ${id}`, () => local.request(`/api/chats/${enc(id)}`, { method: 'DELETE', signal }));
        step('Removing a chat');
    }
    for (let i = 0; i < plan.characters.delete.length; i += 100) {
        const charIds = plan.characters.delete.slice(i, i + 100);
        await attempt(`removing ${charIds.length} characters`, () => local.request('/api/characters/delete', { method: 'POST', json: { charIds }, signal }));
        for (let k = 0; k < charIds.length; k++) step('Removing a character');
    }
    for (const name of plan.worlds.delete) {
        await attempt(`removing lorebook "${name}"`, () => local.request(`/api/worlds/${enc(name)}`, { method: 'DELETE', signal }));
        step(`Removing lorebook ${name}`);
    }

    return { counts, errors, aliases: known, learned };
}

/** Bring over the gallery items this character lacks, matched by name and size (additive: nothing is removed). */
async function pullGallery({ local, peer, id, sourceId, signal }) {
    const theirs = await peer.json(`/peer/character/${enc(sourceId)}/media`, { signal });
    const mine = await walk(local, `/api/characters/${enc(id)}/media`, signal);
    const have = new Set(mine.map(m => `${m.displayName}|${m.size}`));
    const missing = (theirs.items || []).filter(m => !have.has(`${m.displayName}|${m.size}`));
    await eachLimited(missing, 2, async (m) => {
        const bytes = Buffer.from(await (await peer.request(`/peer/media/${enc(sourceId)}/${enc(m.file)}`, { signal, timeout: 120_000 })).arrayBuffer());
        const q = new URLSearchParams({ name: m.displayName || m.file });
        if (m.sourceUrl) q.set('sourceUrl', m.sourceUrl);
        await local.request(`/api/characters/${enc(id)}/media?${q}`, {
            method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' }, signal,
        });
    }, signal);
}
