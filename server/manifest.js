// A library's manifest: one digest per character, chat and lorebook, the way TauriTavern's manifest holds a
// size and a time per file. Digests hash content, not times: a synced write stamps the receiving device's own
// clock, so times alone would see every synced item as changed again on the next pass.
import { canon, sha256 } from './crypto.js';

export const DATASETS = ['characters', 'chats', 'lorebooks'];
const PAGE = 1000;
const CONCURRENCY = 6;

/** Run fn over items, a few at a time, in order of completion. */
export async function eachLimited(items, limit, fn, signal) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            if (signal?.aborted) throw signal.reason ?? new Error('stopped');
            const at = next++;
            await fn(items[at], at);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Every row of a paged list, walking nextCursor. */
export async function walk(local, path, signal) {
    const rows = [];
    let after = null;
    const sep = path.includes('?') ? '&' : '?';
    do {
        const page = await local.json(`${path}${sep}limit=${PAGE}&count=false${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
        rows.push(...(page.items || []));
        after = page.nextCursor || null;
    } while (after);
    return rows;
}

const listOf = (body, key) => (Array.isArray(body) ? body : Array.isArray(body?.[key]) ? body[key] : []);

/** A character's linked lorebook names, in order. */
export async function characterWorlds(local, id, signal) {
    return listOf(await local.json(`/api/characters/${encodeURIComponent(id)}/worlds`, { signal }), 'worlds');
}

/** A stored chat row as it travels: a chat's own pictures do not, so their ids (meaningless elsewhere) are left out. */
export function travellingRow(row) {
    if (!row?.extra?.attachments) return row;
    const { attachments, ...extra } = row.extra;
    return { ...row, extra };
}

/** Every stored row of a chat, oldest first. */
export async function chatRows(local, id, signal) {
    const rows = [];
    const size = 500;
    for (let offset = 0; ; offset += size) {
        const page = await local.json(`/api/chats/${encodeURIComponent(id)}?msgLimit=${size}&msgOffset=${offset}`, { signal });
        const messages = Array.isArray(page.messages) ? page.messages : [];
        rows.push(...messages.map(m => travellingRow(m.raw ?? m)));
        if (messages.length < size) return { chat: page, rows };
    }
}

// a lorebook's content is its data ({entries, ...meta}); the rest of its answer is the shelf's bookkeeping
export const worldContent = (doc) => doc?.data ?? {};

const cardContent = (card) => {
    const { tags, ...data } = card?.data || {};
    return { spec: card?.spec, spec_version: card?.spec_version, data };
};

/**
 * Scan this library.
 * @param {ReturnType<import('./http.js').localClient>} local
 * @param {ReturnType<import('./store.js').makeStore>} store
 * @param {{datasets: string[], signal?: AbortSignal, onProgress?: (note: string) => void}} opts
 */
export async function buildManifest(local, store, { datasets, signal, onProgress = () => {} }) {
    const want = new Set(datasets);
    const cache = store.digestCache();
    const fresh = { chars: {}, chats: {} };
    const manifest = { characters: [], chats: [], worlds: [] };

    if (want.has('characters') || want.has('chats')) {
        const rows = await walk(local, '/api/characters?sort=name', signal);
        await eachLimited(rows, CONCURRENCY, async (row, i) => {
            if (i % 50 === 0) onProgress(`Scanning characters (${i} of ${rows.length})`);
            const id = row.id;
            const enc = encodeURIComponent(id);
            const [detail, head, worlds] = await Promise.all([
                local.json(`/api/characters/${enc}`, { signal }),
                local.request(`/avatars/${enc}.png`, { method: 'HEAD', signal, ok: false }),
                characterWorlds(local, id, signal),
            ]);
            // an avatar's ETag is its size and time on disk: hash its bytes only when that moved
            const etag = head.ok ? head.headers.get('etag') || '' : '';
            let avatar = cache.chars[id]?.etag === etag && etag ? cache.chars[id].avatar : null;
            if (avatar == null) {
                const img = await local.request(`/avatars/${enc}.png`, { signal, ok: false });
                avatar = img.ok ? sha256(Buffer.from(await img.arrayBuffer())) : '';
            }
            fresh.chars[id] = { etag, avatar };
            manifest.characters.push({
                id,
                name: detail.card?.data?.name || row.name || '',
                updatedAt: detail.updatedAt ?? row.updatedAt ?? 0,
                mediaCount: detail.mediaCount ?? 0,
                card: sha256(`${canon(cardContent(detail.card))}|${avatar}`),
                meta: sha256(canon({
                    tags: [...(detail.tags || [])].sort(),
                    fav: !!detail.fav,
                    updateLocked: !!detail.updateLocked,
                    worlds,
                })),
            });
        }, signal);
    }

    if (want.has('chats')) {
        const rows = (await walk(local, '/api/chats?sort=created', signal)).filter(r => r.charId);
        await eachLimited(rows, CONCURRENCY, async (row, i) => {
            if (i % 50 === 0) onProgress(`Scanning chats (${i} of ${rows.length})`);
            const key = `${row.updatedAt}|${row.messageCount}`;
            let digest = cache.chats[row.id]?.key === key ? cache.chats[row.id].rows : null;
            if (digest == null) digest = sha256(canon((await chatRows(local, row.id, signal)).rows));
            fresh.chats[row.id] = { key, rows: digest };
            manifest.chats.push({
                id: row.id,
                charId: row.charId,
                name: row.name,
                updatedAt: row.updatedAt ?? 0,
                messageCount: row.messageCount ?? 0,
                // the draft (the composer's unsent text) never moves updatedAt, so it is read from the row each scan
                digest: sha256(`${digest}|${canon(row.chatMetadata || {})}|${row.draft || ''}`),
            });
        }, signal);
    }

    if (want.has('lorebooks')) {
        onProgress('Scanning lorebooks');
        const rows = await walk(local, '/api/worlds?placeholders=false', signal);
        await eachLimited(rows, CONCURRENCY, async (row) => {
            const doc = await local.json(`/api/worlds/${encodeURIComponent(row.name)}`, { signal });
            manifest.worlds.push({ name: row.name, digest: sha256(canon(worldContent(doc))) });
        }, signal);
    }

    // keep what this scan read alongside what it did not (a dataset left out this time)
    store.saveDigestCache({
        chars: want.has('characters') || want.has('chats') ? fresh.chars : cache.chars,
        chats: want.has('chats') ? fresh.chats : cache.chats,
    });
    return manifest;
}
