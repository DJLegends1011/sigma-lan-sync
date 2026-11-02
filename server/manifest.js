// A library's manifest, read straight from SQLite (req.db) and the disk folders (req.paths).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, sha256 } from './crypto.js';

export const DATASETS = ['characters', 'chats', 'lorebooks', 'personas', 'presets', 'playlists', 'backgrounds', 'settings', 'connections'];
const PAGE = 1000;
const EXT_ID_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

const BASE_ALLOWED_SETTINGS = new Set([
    // Assistant & Creator Studio system prompts + prompts-open flags (+ related assistant/studio knobs)
    'assistantSystemPrompt',
    'assistantPromptsOpen',
    'assistantLoreEdits',
    'assistantChatEdits',
    'assistantStreaming',
    'assistantChatTurns',
    'assistantMaxContext',
    'assistantReasoningEffort',
    'assistantMaxReply',
    'assistantTemperature',
    'creatorStudioSystemPrompt',
    'creatorStudioPromptsOpen',
    'creatorStudioMaxContext',
    // Browse & Tagline & Providers & Extensions
    'allowRichTagline',
    'browseSnapSections',
    'collapseAllBrowseSections',
    'disabledProviders',
    'enabledExtensions',
    'disabledExtensions',
]);

const SECRET_SETTINGS_RE = /(Token|Password|Email|RefreshToken|ApiKey|Cookie|Username|Secret)$/i;

/**
 * Check whether a `settings` table key is allowed to sync under the given options.
 */
export function isAllowedSettingKey(key, { includeConnections = false, includeSecrets = false } = {}) {
    if (!key || typeof key !== 'string') return false;
    // Never sync device-local / active-view state
    if (key === 'activeChatId' || key.startsWith('mobile') || key.startsWith('ext:lan-sync:')) return false;
    // Extension settings: ext:<id>:* except ext:lan-sync:* (check secrets on the subkey first)
    if (key.startsWith('ext:')) {
        const m = /^ext:([a-z0-9][a-z0-9-]{1,59}):(.+)$/.exec(key);
        if (!m || m[1] === 'lan-sync') return false;
        if (SECRET_SETTINGS_RE.test(m[2])) return !!includeSecrets;
        return true;
    }
    // Only with Connections on: chatProfileId, assistantProfileId, aiProfile.*
    if (key === 'chatProfileId' || key === 'assistantProfileId' || key.startsWith('aiProfile.')) {
        return !!includeConnections;
    }
    // Secrets: their own opt-in, off by default (site tokens, passwords, emails, refresh tokens, cookies, API keys)
    if (SECRET_SETTINGS_RE.test(key)) {
        return !!includeSecrets;
    }
    // *Nsfw toggles
    if (key.endsWith('Nsfw')) return true;
    // Base allowlist
    return BASE_ALLOWED_SETTINGS.has(key);
}

/**
 * Check whether an `app_store` document key is allowed to sync.
 */
export function isAllowedAppStoreKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (key === 'backup-schedule' || key === 'persona-pictures' || key === 'chat-drafts') return false;
    if (key.startsWith('st-migration-') || key.startsWith('ext-lan-sync')) return false;
    return true;
}

/**
 * Set of extension IDs currently installed on this device (both installed/ and bundled/).
 */
export function installedExtensionIds() {
    const installedRoot = process.env.CL_EXTENSIONS_DIR
        ? path.resolve(process.env.CL_EXTENSIONS_DIR)
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const bundledRoot = path.resolve(installedRoot, '..', 'bundled');
    const out = new Set();
    for (const root of [installedRoot, bundledRoot]) {
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || !EXT_ID_RE.test(e.name)) continue;
            if (fs.existsSync(path.join(root, e.name, 'manifest.json'))) out.add(e.name);
        }
    }
    return out;
}

/**
 * Discover enabled extensions in `db` that declare `lanSync: { tables?: string[], files?: boolean }`
 * in their `manifest.json`. Only tables named `x_<id_with_underscores>_*` are accepted.
 */
export function enabledLanSyncExtensions(db) {
    if (!db) return [];
    let enabledIds = [];
    try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'enabledExtensions'").get();
        if (row?.value) {
            const parsed = JSON.parse(row.value);
            if (Array.isArray(parsed)) enabledIds = parsed.filter(x => typeof x === 'string' && EXT_ID_RE.test(x));
        }
    } catch { return []; }
    if (!enabledIds.length) return [];

    const installedRoot = process.env.CL_EXTENSIONS_DIR
        ? path.resolve(process.env.CL_EXTENSIONS_DIR)
        : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

    const out = [];
    for (const id of enabledIds) {
        if (id === 'lan-sync') continue;
        try {
            const mPath = path.join(installedRoot, id, 'manifest.json');
            if (!fs.existsSync(mPath)) continue;
            const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
            const ls = m?.lanSync;
            if (!ls || typeof ls !== 'object' || Array.isArray(ls)) continue;
            const prefix = `x_${id.replace(/-/g, '_')}_`;
            const tables = (Array.isArray(ls.tables) ? ls.tables : [])
                .filter(t => typeof t === 'string' && t.startsWith(prefix) && /^x_[a-z0-9_]+$/.test(t));
            const files = ls.files === true;
            if (tables.length || files) out.push({ id, tables, files });
        } catch { /* ignore unreadable extension manifest */ }
    }
    return out;
}

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
export async function walk(local, urlPath, signal) {
    const rows = [];
    let after = null;
    const sep = urlPath.includes('?') ? '&' : '?';
    do {
        const page = await local.json(`${urlPath}${sep}limit=${PAGE}&count=false${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
        rows.push(...(page.items || []));
        after = page.nextCursor || null;
    } while (after);
    return rows;
}

const listOf = (body, key) => (Array.isArray(body) ? body : Array.isArray(body?.[key]) ? body[key] : []);

export async function characterWorlds(local, id, signal) {
    return listOf(await local.json(`/api/characters/${encodeURIComponent(id)}/worlds`, { signal }), 'worlds');
}

export function travellingRow(row) {
    if (!row?.extra?.attachments) return row;
    const { attachments, ...extra } = row.extra;
    return { ...row, extra };
}

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

export async function playlistMembers(local, id, signal) {
    const ids = [];
    let after = null;
    do {
        const page = await local.json(`/api/playlists/${encodeURIComponent(id)}/members?limit=1000${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
        ids.push(...(page.ids || []));
        after = page.nextCursor || null;
    } while (after);
    return ids;
}

export const presetBlocksContent = (blocks) => (Array.isArray(blocks) ? blocks : []).map((b, i) => ({
    key: b.key ?? b.block_key ?? null,
    name: b.name ?? null,
    kind: b.kind === 'marker' ? 'marker' : 'text',
    marker: b.kind === 'marker' ? (b.marker ?? null) : null,
    content: typeof b.content === 'string' ? b.content : '',
    role: b.role || 'system',
    position: b.position || 'pre_history',
    depth: Number.isInteger(b.depth) ? b.depth : 0,
    injectionOrder: Number.isInteger(b.injectionOrder ?? b.injection_order) ? (b.injectionOrder ?? b.injection_order) : 100,
    forbidOverrides: !!(b.forbidOverrides ?? b.forbid_overrides),
    enabled: b.enabled !== false && b.enabled !== 0,
    pos: i,
}));

export const worldContent = (doc) => doc?.data ?? {};

function fileAvatarHash(filePath, cacheMap, id) {
    try {
        const st = fs.statSync(filePath);
        const key = `${st.size}:${st.mtimeMs}`;
        if (cacheMap?.[id]?.etag === key && cacheMap[id].avatar) return { etag: key, avatar: cacheMap[id].avatar };
        const avatar = sha256(fs.readFileSync(filePath));
        return { etag: key, avatar };
    } catch {
        return { etag: '', avatar: '' };
    }
}

/**
 * Fast, direct SQLite + disk scan of a library.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, string>} paths
 * @param {ReturnType<import('./store.js').makeStore>} store
 * @param {{datasets?: string[]}} [opts]
 */
export function buildManifestFromDb(db, paths, store, { datasets = DATASETS, includeSecrets = false } = {}) {
    const want = new Set(datasets);
    const cache = store.digestCache();
    const fresh = { chars: {}, chats: {}, personas: {} };
    const manifest = {
        characters: [],
        chats: [],
        worlds: [],
        personas: [],
        presets: [],
        playlists: [],
        backgrounds: [],
        settings: [],
        appStore: [],
        unboundStudio: [],
        connections: [],
    };

    if (want.has('characters') || want.has('chats') || want.has('playlists')) {
        const chars = db.prepare('SELECT id, name, card, content_hash, fav, update_locked, media_localized, lore_dismissed, created_at, updated_at FROM characters ORDER BY name COLLATE NOCASE').all();
        const tagRows = db.prepare('SELECT ct.char_id, t.name FROM char_tags ct JOIN tags t ON t.id = ct.tag_id ORDER BY ct.char_id, t.name COLLATE NOCASE').all();
        const worldRows = db.prepare('SELECT char_id, world_name FROM char_worlds ORDER BY char_id, pos').all();
        const linkRows = db.prepare('SELECT char_id, provider_id, external_id, full_path FROM provider_links ORDER BY char_id, provider_id').all();
        const mediaRows = db.prepare("SELECT char_id, COUNT(*) AS n, GROUP_CONCAT(COALESCE(content_hash, file || ':' || COALESCE(size, 0)), '|') AS sig FROM (SELECT char_id, content_hash, file, size FROM media ORDER BY char_id, display_name) GROUP BY char_id").all();
        let studioRows = [];
        try {
            studioRows = db.prepare('SELECT id, char_id, name, draft, messages, profile_id, updated_at FROM studio_sessions ORDER BY char_id, id').all();
        } catch { /* ignore if table absent */ }

        const tagsByChar = new Map();
        for (const r of tagRows) {
            if (!tagsByChar.has(r.char_id)) tagsByChar.set(r.char_id, []);
            tagsByChar.get(r.char_id).push(r.name);
        }
        const worldsByChar = new Map();
        for (const r of worldRows) {
            if (!worldsByChar.has(r.char_id)) worldsByChar.set(r.char_id, []);
            worldsByChar.get(r.char_id).push(r.world_name);
        }
        const linksByChar = new Map();
        for (const r of linkRows) {
            const key = `${r.provider_id || ''}:${r.external_id || r.full_path || ''}`;
            if (!r.provider_id || (!r.external_id && !r.full_path)) continue;
            if (!linksByChar.has(r.char_id)) linksByChar.set(r.char_id, []);
            linksByChar.get(r.char_id).push(key);
        }
        const mediaByChar = new Map(mediaRows.map(r => [r.char_id, { count: r.n, sig: r.sig || '' }]));
        const studioByChar = new Map();
        for (const s of studioRows) {
            if (s.char_id) {
                if (!studioByChar.has(s.char_id)) studioByChar.set(s.char_id, []);
                studioByChar.get(s.char_id).push(s);
            } else if (want.has('characters')) {
                manifest.unboundStudio.push({
                    id: s.id,
                    name: s.name || '',
                    updatedAt: s.updated_at ?? 0,
                    digest: sha256(canon({ name: s.name || '', draft: s.draft || '{}', messages: s.messages || '[]', profileId: s.profile_id || null })),
                });
            }
        }

        for (const c of chars) {
            const av = paths?.avatarsDir
                ? fileAvatarHash(path.join(paths.avatarsDir, `${c.id}.png`), cache.chars, c.id)
                : { etag: '', avatar: '' };
            fresh.chars[c.id] = av;
            const m = mediaByChar.get(c.id) || { count: 0, sig: '' };
            const stList = studioByChar.get(c.id) || [];
            const studioDigest = stList.length
                ? sha256(canon(stList.map(s => ({ id: s.id, name: s.name || '', draft: s.draft || '{}', messages: s.messages || '[]', profileId: s.profile_id || null }))))
                : '';
            const studioUpdatedAt = stList.length
                ? Math.max(0, ...stList.map(s => Number(s.updated_at) || 0))
                : 0;
            let creator = '';
            let createDate = '';
            try {
                const parsed = JSON.parse(c.card);
                creator = String(parsed?.data?.creator ?? '').trim();
                createDate = String(parsed?.create_date ?? parsed?.data?.create_date ?? parsed?.data?.extensions?.create_date ?? '').trim();
            } catch { /* ignore */ }
            manifest.characters.push({
                id: c.id,
                name: c.name || '',
                creator,
                createDate,
                providerLinks: linksByChar.get(c.id) || [],
                updatedAt: c.updated_at ?? 0,
                studioUpdatedAt,
                studioDigest,
                mediaCount: m.count,
                mediaSig: sha256(m.sig),
                card: sha256(`${c.content_hash || sha256(c.card)}|${av.avatar}`),
                meta: sha256(canon({
                    tags: tagsByChar.get(c.id) || [],
                    fav: !!c.fav,
                    updateLocked: !!c.update_locked,
                    worlds: worldsByChar.get(c.id) || [],
                })),
            });
        }
    }

    if (want.has('chats')) {
        const chats = db.prepare('SELECT id, char_id, name, chat_metadata, draft, persona_id, preset_id, profile_id, message_count, updated_at FROM chats ORDER BY create_date, id').all();
        const worldRows = db.prepare('SELECT chat_id, world_name FROM chat_worlds ORDER BY chat_id, pos').all();
        const attRows = db.prepare("SELECT chat_id, COUNT(*) AS n, GROUP_CONCAT(content_hash, '|') AS sig FROM (SELECT chat_id, content_hash FROM attachments WHERE chat_id IS NOT NULL ORDER BY chat_id, id) GROUP BY chat_id").all();
        let asstRows = [];
        try {
            asstRows = db.prepare('SELECT id, chat_id, name, messages, profile_id, updated_at FROM assistant_sessions ORDER BY chat_id, id').all();
        } catch { /* ignore if table absent */ }
        const worldsByChat = new Map();
        for (const r of worldRows) {
            if (!worldsByChat.has(r.chat_id)) worldsByChat.set(r.chat_id, []);
            worldsByChat.get(r.chat_id).push(r.world_name);
        }
        const asstByChat = new Map();
        for (const a of asstRows) {
            if (!asstByChat.has(a.chat_id)) asstByChat.set(a.chat_id, []);
            asstByChat.get(a.chat_id).push(a);
        }
        const attByChat = new Map(attRows.map(r => [r.chat_id, `${r.n}:${r.sig || ''}`]));
        const msgStmt = db.prepare('SELECT data FROM chat_messages WHERE chat_id = ? ORDER BY seq');

        for (const ch of chats) {
            const attSig = attByChat.get(ch.id) || '';
            const key = `${ch.updated_at}|${ch.message_count}|${attSig}`;
            let rowsDigest = cache.chats?.[ch.id]?.key === key ? cache.chats[ch.id].rows : null;
            if (rowsDigest == null) {
                const rawList = msgStmt.all(ch.id).map(r => r.data);
                rowsDigest = sha256(`${rawList.join('\n')}|${attSig}`);
            }
            fresh.chats[ch.id] = { key, rows: rowsDigest };
            const baseDigest = sha256(`${rowsDigest}|${ch.chat_metadata || '{}'}|${ch.draft || ''}|${ch.persona_id || ''}|${ch.preset_id || ''}|${(worldsByChat.get(ch.id) || []).join(',')}`);
            const asstList = asstByChat.get(ch.id) || [];
            const asstDigest = asstList.length
                ? sha256(canon(asstList.map(a => ({ id: a.id, name: a.name || '', messages: a.messages || '[]', profileId: a.profile_id || null }))))
                : '';
            const asstUpdatedAt = asstList.length
                ? Math.max(0, ...asstList.map(a => Number(a.updated_at) || 0))
                : 0;
            manifest.chats.push({
                id: ch.id,
                charId: ch.char_id,
                name: ch.name,
                updatedAt: ch.updated_at ?? 0,
                asstUpdatedAt,
                baseDigest,
                asstDigest,
                messageCount: ch.message_count ?? 0,
                digest: asstDigest ? sha256(`${baseDigest}|${asstDigest}`) : baseDigest,
            });
        }
    }

    if (want.has('lorebooks')) {
        const worlds = db.prepare('SELECT name, data, updated_at, placeholder FROM worlds WHERE placeholder = 0 ORDER BY name COLLATE NOCASE').all();
        const entryStmt = db.prepare('SELECT uid, data FROM world_entries WHERE world_name = ? ORDER BY uid');
        for (const w of worlds) {
            const entries = entryStmt.all(w.name);
            manifest.worlds.push({
                name: w.name,
                updatedAt: w.updated_at ?? 0,
                digest: sha256(`${w.data}|${entries.map(e => `${e.uid}:${e.data}`).join('\n')}`),
            });
        }
    }

    if (want.has('personas')) {
        const personas = db.prepare('SELECT * FROM personas ORDER BY name COLLATE NOCASE').all();
        const worldRows = db.prepare('SELECT persona_id, world_name FROM persona_worlds ORDER BY persona_id, pos').all();
        const worldsByPersona = new Map();
        for (const r of worldRows) {
            if (!worldsByPersona.has(r.persona_id)) worldsByPersona.set(r.persona_id, []);
            worldsByPersona.get(r.persona_id).push(r.world_name);
        }
        // Include any enabled extension's persona-linked tables (e.g. x_evolutia_personas) in the persona digest
        const extPersonaRows = new Map();
        for (const ext of enabledLanSyncExtensions(db)) {
            for (const table of ext.tables) {
                try {
                    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
                    if (!exists) continue;
                    const cols = db.pragma(`table_info("${table}")`).map(c => c.name);
                    if (!cols.includes('persona_id')) continue;
                    for (const r of db.prepare(`SELECT * FROM "${table}"`).all()) {
                        if (!r.persona_id) continue;
                        if (!extPersonaRows.has(r.persona_id)) extPersonaRows.set(r.persona_id, {});
                        extPersonaRows.get(r.persona_id)[table] = r;
                    }
                } catch { /* ignore */ }
            }
        }
        for (const p of personas) {
            const av = paths?.personaAvatarsDir && p.avatar
                ? fileAvatarHash(path.join(paths.personaAvatarsDir, `${p.id}.png`), cache.personas, p.id)
                : { etag: '', avatar: '' };
            fresh.personas[p.id] = av;
            const extData = extPersonaRows.get(p.id) || null;
            const baseDigest = sha256(canon({
                name: p.name || '',
                description: p.description || '',
                pronouns: {
                    sub: p.pronoun_sub ?? '',
                    obj: p.pronoun_obj ?? '',
                    poss: p.pronoun_poss ?? '',
                    possP: p.pronoun_poss_p ?? '',
                    ref: p.pronoun_ref ?? '',
                },
                worlds: worldsByPersona.get(p.id) || [],
                avatar: av.avatar,
            }));
            const extDigest = extData ? sha256(canon(extData)) : '';
            const extUpdatedAt = extData
                ? Math.max(0, ...Object.values(extData).map(r => Number(r?.updated_at) || 0))
                : 0;
            manifest.personas.push({
                id: p.id,
                name: p.name || '',
                updatedAt: p.updated_at ?? 0,
                extUpdatedAt,
                baseDigest,
                extDigest,
                hasAvatar: !!av.avatar,
                digest: extDigest ? sha256(`${baseDigest}|${extDigest}`) : baseDigest,
            });
        }
    }

    if (want.has('presets')) {
        const presets = db.prepare('SELECT * FROM presets ORDER BY name COLLATE NOCASE').all();
        const blockStmt = db.prepare('SELECT * FROM preset_blocks WHERE preset_id = ? ORDER BY pos');
        for (const p of presets) {
            const blocks = presetBlocksContent(blockStmt.all(p.id));
            manifest.presets.push({
                id: p.id,
                name: p.name || '',
                updatedAt: p.updated_at ?? 0,
                digest: sha256(canon({ name: p.name || '', blocks })),
            });
        }
    }

    if (want.has('playlists')) {
        const lists = db.prepare('SELECT * FROM playlists ORDER BY pos, created_at').all();
        const memStmt = db.prepare('SELECT char_id FROM playlist_chars WHERE playlist_id = ? ORDER BY pos');
        for (const p of lists) {
            const members = memStmt.all(p.id).map(r => r.char_id);
            manifest.playlists.push({
                id: p.id,
                name: p.name || '',
                updatedAt: p.modified_at ?? p.created_at ?? 0,
                members,
                meta: sha256(canon({ name: p.name || '', description: p.description || '', icon: p.icon || '', color: p.color || '' })),
                digest: sha256(canon({ name: p.name || '', description: p.description || '', icon: p.icon || '', color: p.color || '', members })),
            });
        }
    }

    if (want.has('backgrounds')) {
        const bgs = db.prepare('SELECT * FROM backgrounds ORDER BY id').all();
        for (const b of bgs) {
            manifest.backgrounds.push({
                id: b.id,
                file: b.file,
                name: b.display_name,
                contentHash: b.content_hash || `${b.file}:${b.size}`,
                updatedAt: b.added_at ?? 0,
                digest: sha256(canon({ displayName: b.display_name, contentHash: b.content_hash, size: b.size })),
            });
        }
    }

    if (want.has('settings')) {
        try {
            const docs = db.prepare('SELECT key, value, updated_at FROM app_store ORDER BY key').all();
            for (const d of docs) {
                if (!isAllowedAppStoreKey(d.key)) continue;
                manifest.appStore.push({
                    key: d.key,
                    updatedAt: d.updated_at ?? 0,
                    digest: sha256(String(d.value ?? '')),
                });
            }
        } catch { /* ignore if app_store absent */ }
    }

    if (want.has('settings')) {
        const includeConnections = want.has('connections');
        const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
        for (const r of rows) {
            if (!isAllowedSettingKey(r.key, { includeConnections, includeSecrets })) continue;
            let extensions;
            if (r.key === 'enabledExtensions') {
                try {
                    const parsed = JSON.parse(r.value);
                    if (Array.isArray(parsed)) extensions = parsed.filter(x => typeof x === 'string');
                } catch { /* ignore */ }
            }
            manifest.settings.push({
                key: r.key,
                digest: sha256(String(r.value ?? '')),
                ...(extensions ? { extensions } : {}),
            });
        }
    }

    if (want.has('connections')) {
        const profs = db.prepare('SELECT * FROM llm_profiles ORDER BY pos, created_at').all();
        for (const p of profs) {
            manifest.connections.push({
                id: p.id,
                name: p.name || '',
                updatedAt: p.updated_at ?? p.created_at ?? 0,
                digest: sha256(canon({
                    name: p.name,
                    kind: p.kind,
                    baseUrl: p.base_url,
                    apiKey: p.api_key,
                    model: p.model,
                    params: p.params,
                    contextSize: p.context_size,
                    vision: p.vision,
                    maxImages: p.max_images,
                })),
            });
        }
    }

    store.saveDigestCache({
        chars: want.has('characters') || want.has('chats') ? fresh.chars : cache.chars,
        chats: want.has('chats') ? fresh.chats : cache.chats,
        personas: want.has('personas') ? fresh.personas : (cache.personas || {}),
    });
    return manifest;
}

/**
 * Build a manifest of all physical media files on disk for fast delta file transfer.
 */
export function buildFileManifest(db, paths, { datasets = DATASETS } = {}) {
    const want = new Set(datasets);
    const files = [];

    const pushIf = (kind, relPath, fullPath, sizeHint = null) => {
        try {
            const st = fs.statSync(fullPath);
            if (st.isFile()) files.push({ kind, relPath: relPath.replace(/\\/g, '/'), size: st.size });
        } catch {
            if (sizeHint != null) files.push({ kind, relPath: relPath.replace(/\\/g, '/'), size: sizeHint });
        }
    };

    if (want.has('characters')) {
        for (const r of db.prepare('SELECT id FROM characters').iterate()) {
            pushIf('avatars', `${r.id}.png`, path.join(paths.avatarsDir, `${r.id}.png`));
        }
        for (const m of db.prepare('SELECT char_id, file, size FROM media').iterate()) {
            pushIf('gallery', `${m.char_id}/${m.file}`, path.join(paths.galleryRoot, m.char_id, m.file), m.size);
        }
    }
    if (want.has('personas')) {
        for (const p of db.prepare('SELECT id FROM personas WHERE avatar IS NOT NULL').iterate()) {
            pushIf('personas', `${p.id}.png`, path.join(paths.personaAvatarsDir, `${p.id}.png`));
        }
    }
    if (want.has('chats') || want.has('characters')) {
        for (const a of db.prepare('SELECT chat_id, studio_id, file, size FROM attachments').iterate()) {
            if (a.chat_id && !want.has('chats')) continue;
            if (a.studio_id && !want.has('characters')) continue;
            const owner = a.chat_id ?? a.studio_id;
            if (owner) pushIf('attachments', `${owner}/${a.file}`, path.join(paths.attachmentsRoot, owner, a.file), a.size);
        }
    }
    if (want.has('backgrounds')) {
        for (const b of db.prepare('SELECT file, size FROM backgrounds').iterate()) {
            pushIf('backgrounds', b.file, path.join(paths.backgroundsDir, b.file), b.size);
        }
    }
    if (paths?.root) {
        const walkExtDir = (extId, baseDir, relPrefix = '') => {
            let entries = [];
            try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'seeded-prompts.json') continue;
                const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
                const full = path.join(baseDir, entry.name);
                if (entry.isDirectory()) walkExtDir(extId, full, rel);
                else if (entry.isFile()) pushIf('ext', `${extId}/${rel}`, full);
            }
        };
        for (const ext of enabledLanSyncExtensions(db)) {
            if (!ext.files) continue;
            walkExtDir(ext.id, path.join(paths.root, 'ext', ext.id));
        }
    }
    return files;
}

export async function buildManifest(localOrDb, store, opts = {}) {
    if (localOrDb && typeof localOrDb.prepare === 'function') {
        return buildManifestFromDb(localOrDb, opts.paths || {}, store, opts);
    }
    return { characters: [], chats: [], worlds: [], personas: [], presets: [], playlists: [], backgrounds: [], connections: [] };
}
