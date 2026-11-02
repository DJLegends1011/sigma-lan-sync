// Direct SQLite + Disk Synchronization for Project Σ.
// Pulls an atomic SQLite snapshot (`VACUUM INTO`) from the paired device, attaches it (`ATTACH DATABASE`),
// merges all selected tables inside a single native SQLite transaction, and syncs missing/changed media files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildManifestFromDb,
    buildFileManifest,
    eachLimited,
    DATASETS,
    enabledLanSyncExtensions,
    isAllowedSettingKey,
    isAllowedAppStoreKey,
    installedExtensionIds,
} from './manifest.js';
import { makePlan, planCounts, planSize, alignSource } from './plan.js';
import { sha256 } from './crypto.js';

const enc = encodeURIComponent;

const datasetsOf = (o) => DATASETS.filter(d => o[d] !== false);

/**
 * Create an atomic SQLite snapshot of `db` in a temporary file.
 * Strips `llm_profiles` unless `includeConnections` is true, strips non-allowlisted `settings` (and secrets
 * unless `includeSecrets` is true), and always strips `changes` and `x_lan_sync_*`.
 * @param {import('better-sqlite3').Database} db
 * @param {{includeConnections?: boolean, includeSecrets?: boolean}} [opts]
 * @returns {string} Path to temporary `.db` file (caller must unlink)
 */
export function createDbSnapshot(db, { includeConnections = false, includeSecrets = false } = {}) {
    const tmpFile = path.join(os.tmpdir(), `sigma-lan-sync-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db.prepare('VACUUM INTO ?').run(tmpFile);
    // Clean up private/transient tables inside the snapshot copy using a temporary ATTACH on the same db handle
    const schema = `snap_${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(tmpFile);
    try {
        // Zero deleted cells on delete so stripped secrets/profiles never linger in free pages
        db.pragma(`${schema}.secure_delete = ON`);
        try { db.exec(`DELETE FROM ${schema}.change_log`); } catch { /* ignore */ }
        try { db.exec(`DELETE FROM ${schema}.changes`); } catch { /* ignore */ }
        if (!includeConnections) {
            try { db.exec(`DELETE FROM ${schema}.llm_profiles`); } catch { /* ignore */ }
        }
        try {
            const sRows = db.prepare(`SELECT key FROM ${schema}.settings`).all();
            const delSetting = db.prepare(`DELETE FROM ${schema}.settings WHERE key = ?`);
            for (const r of sRows) {
                if (r.key === 'activePersonaId' || r.key === 'activePresetId') continue;
                if (!isAllowedSettingKey(r.key, { includeConnections, includeSecrets })) {
                    delSetting.run(r.key);
                }
            }
        } catch { /* ignore */ }
        try {
            const aRows = db.prepare(`SELECT key FROM ${schema}.app_store`).all();
            const delDoc = db.prepare(`DELETE FROM ${schema}.app_store WHERE key = ?`);
            for (const r of aRows) {
                if (!isAllowedAppStoreKey(r.key)) delDoc.run(r.key);
            }
        } catch { /* ignore */ }
        const extTables = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name LIKE 'x_lan_sync_%'`).all();
        for (const t of extTables) {
            db.exec(`DELETE FROM ${schema}."${t.name.replace(/"/g, '""')}"`);
        }
    } finally {
        try { db.exec(`DETACH DATABASE ${schema}`); } catch { /* ignore */ }
    }
    // Belt and braces: open the detached snapshot and VACUUM it so the file is rebuilt without free pages
    const Database = db.constructor;
    if (typeof Database === 'function') {
        const snapDb = new Database(tmpFile);
        try {
            snapDb.pragma('secure_delete = ON');
            snapDb.exec('VACUUM');
        } finally {
            snapDb.close();
        }
    }
    return tmpFile;
}

/**
 * Resolve a physical file path inside `paths` for `{ kind, relPath }` safely (prevents path traversal).
 */
export function resolveMediaFile(paths, kind, relPath, allowedExtIds = null) {
    const roots = {
        avatars: paths?.avatarsDir,
        gallery: paths?.galleryRoot,
        personas: paths?.personaAvatarsDir,
        attachments: paths?.attachmentsRoot,
        backgrounds: paths?.backgroundsDir,
        ext: paths?.root ? path.join(paths.root, 'ext') : null,
    };
    const root = roots[kind];
    if (!root || typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return null;
    if (kind === 'ext') {
        const parts = relPath.split(/[\\/]/).filter(Boolean);
        const firstSeg = parts[0] || '';
        if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(firstSeg) || firstSeg === 'lan-sync') return null;
        if (parts.some(seg => seg.startsWith('.') || seg === 'seeded-prompts.json')) return null;
        const allowed = allowedExtIds instanceof Set
            ? allowedExtIds
            : (Array.isArray(allowedExtIds) ? new Set(allowedExtIds) : null);
        if (!allowed || !allowed.has(firstSeg)) return null;
    }
    const base = path.resolve(root);
    const full = path.resolve(base, relPath);
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return full;
}

/**
 * Pull from a paired device directly into this library's SQLite database (`db`) and disk folders (`paths`).
 */
export async function runPull({ db, paths, ctx, peer, store, options, aliases = {}, signal, progress = () => {} }) {
    const datasets = datasetsOf(options);
    const includeSecrets = options.secrets === true;
    const note = (text, done = 0, total = 0) => progress({ done, total, note: text });

    note('Scanning the other device');
    const theirs = await peer.json('/peer/manifest', { method: 'POST', json: { datasets, includeSecrets }, signal, timeout: 0 });
    note('Scanning this library');
    const target = buildManifestFromDb(db, paths, store, { datasets, includeSecrets });

    note('Comparing');
    const aligned = alignSource(theirs, target, aliases);
    const known = aligned.aliases;
    const plan = makePlan(aligned.source, target, { datasets, mode: options.mode, overwrite: options.overwrite });
    const counts = planCounts(plan);
    const installed = installedExtensionIds();
    const remoteExtEntry = (theirs.settings || []).find(s => s.key === 'enabledExtensions');
    const previewMissingExts = Array.isArray(remoteExtEntry?.extensions)
        ? remoteExtEntry.extensions.filter(id => typeof id === 'string' && !installed.has(id))
        : [];
    if (options.dryRun) return { counts, errors: [], aliases: known, missingExtensions: previewMissingExts };

    const totalChanges = planSize(plan);
    const errors = [];

    // Download the remote SQLite snapshot and merge all selected datasets inside one transaction
    note('Downloading database snapshot', 0, Math.max(1, totalChanges));
    const snapRes = await peer.request('/peer/db-snapshot', {
        method: 'POST',
        json: { datasets, includeConnections: datasets.includes('connections'), includeSecrets },
        signal,
        timeout: 0,
    });
    const snapBytes = Buffer.from(await snapRes.arrayBuffer());
    const tmpSnap = path.join(os.tmpdir(), `sigma-lan-sync-in-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    fs.writeFileSync(tmpSnap, snapBytes);

    let filesToDelete = [];
    let missingExtensions = previewMissingExts;
    try {
        note('Applying database changes', 0, Math.max(1, totalChanges));
        const mergeOut = mergeSnapshotIntoDb({
            db,
            paths,
            ctx,
            tmpSnap,
            plan,
            datasets,
            includeSecrets,
            mode: options.mode,
            overwrite: options.overwrite,
            aliases: known,
        });
        filesToDelete = mergeOut.filesToDelete;
        if (mergeOut.missingExtensions.length) missingExtensions = mergeOut.missingExtensions;
    } finally {
        try { fs.unlinkSync(tmpSnap); } catch { /* ignore */ }
    }

    // Delete local physical files removed in Mirror mode
    for (const f of filesToDelete) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
    }

    // Sync physical media files (avatars, gallery, persona avatars, chat attachments, backgrounds)
    note('Checking media files');
    const remoteFilesResp = await peer.json('/peer/files-manifest', { method: 'POST', json: { datasets }, signal, timeout: 0 });
    const remoteFiles = Array.isArray(remoteFilesResp?.files) ? remoteFilesResp.files : [];

    // Remap remote file paths for any aliased characters
    const allowedExtIds = new Set(enabledLanSyncExtensions(db).filter(e => e.files).map(e => e.id));
    const toFetch = [];
    for (const rf of remoteFiles) {
        let localRel = rf.relPath;
        if (rf.kind === 'avatars' && rf.relPath.endsWith('.png')) {
            const srcCharId = rf.relPath.slice(0, -4);
            const dstCharId = known[srcCharId] || srcCharId;
            localRel = `${dstCharId}.png`;
            // If prefer-newer kept local character card, don't overwrite its avatar
            const charPlan = plan.characters.update.find(u => u.id === dstCharId);
            const isNew = plan.characters.create.includes(srcCharId) || plan.characters.create.includes(dstCharId);
            const targetPath = resolveMediaFile(paths, 'avatars', localRel, allowedExtIds);
            const exists = targetPath && fs.existsSync(targetPath);
            if (exists && !isNew && (!charPlan || !charPlan.card)) continue;
        } else if (rf.kind === 'gallery') {
            const slash = rf.relPath.indexOf('/');
            if (slash > 0) {
                const srcCharId = rf.relPath.slice(0, slash);
                const dstCharId = known[srcCharId] || srcCharId;
                localRel = `${dstCharId}${rf.relPath.slice(slash)}`;
            }
        } else if (rf.kind === 'personas' && rf.relPath.endsWith('.png')) {
            const srcId = rf.relPath.slice(0, -4);
            const upd = plan.personas.update.find(u => u.id === srcId);
            const dstId = upd ? upd.targetId : srcId;
            localRel = `${dstId}.png`;
        }

        const dstFull = resolveMediaFile(paths, rf.kind, localRel, allowedExtIds);
        if (!dstFull) continue;

        let need = false;
        try {
            const st = fs.statSync(dstFull);
            if (st.size !== rf.size || rf.kind === 'avatars' || rf.kind === 'personas') need = true;
        } catch {
            need = true;
        }
        if (need) toFetch.push({ ...rf, localRel, dstFull });
    }

    let fileDone = 0;
    await eachLimited(toFetch, 4, async (item) => {
        fileDone++;
        note(`Downloading ${item.kind}/${item.localRel}`, fileDone, toFetch.length);
        try {
            const resp = await peer.request(`/peer/file/${enc(item.kind)}?path=${enc(item.relPath)}`, { signal, timeout: 120_000 });
            const buf = Buffer.from(await resp.arrayBuffer());
            fs.mkdirSync(path.dirname(item.dstFull), { recursive: true });
            fs.writeFileSync(item.dstFull, buf);
            // If an avatar changed, clear cached WebP thumbnails so the UI shows the new picture
            if (item.kind === 'avatars' && paths.thumbsDir) {
                const charId = path.basename(item.localRel, '.png');
                for (const w of [256, 512, 768]) {
                    try { fs.unlinkSync(path.join(paths.thumbsDir, `${charId}-${w}.webp`)); } catch { /* ignore */ }
                }
            }
        } catch (e) {
            if (signal?.aborted) throw e;
            errors.push({ what: `${item.kind}/${item.relPath}`, error: e.message || String(e) });
        }
    }, signal);

    // Emit change events on the host DB so every open browser tab refreshes its library, personas, presets, etc.
    emitSyncChanges(db, ctx);
    // Allow setImmediate server event listeners (e.g. Evolutia's rebuildCardsTable) to finish before the pull resolves
    await new Promise(r => setImmediate(r));

    return { counts, errors, aliases: known, missingExtensions };
}

/**
 * Attach `tmpSnap` as `remote` and merge all selected datasets inside one atomic SQLite transaction.
 */
function mergeSnapshotIntoDb({ db, paths, ctx, tmpSnap, plan, datasets, includeSecrets = false, mode, overwrite, aliases }) {
    const want = new Set(datasets);
    const mirror = mode === 'mirror';
    const preferNewer = overwrite === 'prefer-newer';
    const filesToDelete = [];
    const missingExtensionsSet = new Set();

    db.prepare('ATTACH DATABASE ? AS remote').run(tmpSnap);
    db.pragma('foreign_keys = OFF');
    try {
        const writableCols = (table, omitAutoId = false) => db.pragma(`table_xinfo("${table}")`)
            .filter(c => c.hidden === 0 && (!omitAutoId || c.name !== 'id'))
            .map(c => c.name);
        const upsertSql = (table, conflictCols, updateCols = null, omitAutoId = false) => {
            const cols = writableCols(table, omitAutoId);
            const colList = cols.map(c => `"${c}"`).join(', ');
            const valList = cols.map(c => `@${c}`).join(', ');
            if (!conflictCols) return `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${valList})`;
            const upd = (updateCols || cols.filter(c => !conflictCols.includes(c)))
                .map(c => `"${c}" = excluded."${c}"`)
                .join(', ');
            return `INSERT INTO "${table}" (${colList}) VALUES (${valList}) ON CONFLICT(${conflictCols.map(c => `"${c}"`).join(', ')}) DO UPDATE SET ${upd}`;
        };

        const tx = db.transaction(() => {
            // ── 1. Lorebooks (worlds, world_entries, global_worlds) ──
            if (want.has('lorebooks')) {
                const upsertWorld = db.prepare(upsertSql('worlds', ['name']));
                const insEntry = db.prepare(upsertSql('world_entries', ['world_name', 'uid'], null, true));
                for (const name of plan.worlds.put) {
                    const rw = db.prepare('SELECT * FROM remote.worlds WHERE name = ?').get(name);
                    if (!rw) continue;
                    upsertWorld.run(rw);
                    db.prepare('DELETE FROM world_entries WHERE world_name = ?').run(name);
                    const entries = db.prepare('SELECT * FROM remote.world_entries WHERE world_name = ?').all(name);
                    for (const e of entries) insEntry.run(e);
                }
                if (mirror) {
                    for (const name of plan.worlds.delete) {
                        try { db.prepare('DELETE FROM world_sources WHERE world_name = ?').run(name); } catch { /* ignore */ }
                        db.prepare('DELETE FROM world_entries WHERE world_name = ?').run(name);
                        db.prepare('DELETE FROM global_worlds WHERE world_name = ?').run(name);
                        db.prepare('DELETE FROM char_worlds WHERE world_name = ?').run(name);
                        db.prepare('DELETE FROM chat_worlds WHERE world_name = ?').run(name);
                        db.prepare('DELETE FROM persona_worlds WHERE world_name = ?').run(name);
                        db.prepare('DELETE FROM worlds WHERE name = ?').run(name);
                    }
                    db.exec('DELETE FROM global_worlds');
                }
                const gws = db.prepare('SELECT * FROM remote.global_worlds ORDER BY pos').all();
                for (const gw of gws) {
                    const exists = db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(gw.world_name);
                    if (exists) {
                        db.prepare('INSERT OR IGNORE INTO global_worlds (world_name, pos) VALUES (?, ?)').run(gw.world_name, gw.pos);
                    }
                }
                // ── 1b. Lorebook import links (world_sources), keyed by world_name ──
                const hasLocalWs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_sources'").get();
                const hasRemoteWs = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'world_sources'").get();
                if (hasLocalWs && hasRemoteWs) {
                    const upsertWs = db.prepare(upsertSql('world_sources', ['world_name']));
                    const seenWsWorlds = new Set();
                    for (const rws of db.prepare('SELECT * FROM remote.world_sources').all()) {
                        if (!db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(rws.world_name)) continue;
                        seenWsWorlds.add(rws.world_name);
                        const locWs = db.prepare('SELECT linked_at FROM world_sources WHERE world_name = ?').get(rws.world_name);
                        if (locWs && preferNewer && (locWs.linked_at ?? 0) > (rws.linked_at ?? 0)) continue;
                        upsertWs.run(rws);
                    }
                    if (mirror) {
                        for (const lws of db.prepare('SELECT world_name FROM world_sources').all()) {
                            if (!seenWsWorlds.has(lws.world_name)) {
                                db.prepare('DELETE FROM world_sources WHERE world_name = ?').run(lws.world_name);
                            }
                        }
                    }
                }
            }

            // Ensure any placeholder worlds referenced by characters/personas/chats exist
            const ensureWorldPlaceholder = (worldName) => {
                if (!worldName) return;
                db.prepare(`
                    INSERT OR IGNORE INTO worlds (name, data, entry_count, placeholder, created_at, updated_at)
                    VALUES (?, '{"entries":{}}', 0, 1, ?, ?)
                `).run(worldName, Date.now(), Date.now());
            };

            // ── 1b. Connections (llm_profiles, synced before studio/assistant sessions so profile_ids resolve) ──
            if (want.has('connections')) {
                const upsertProfile = db.prepare(upsertSql('llm_profiles', ['id']));
                const syncProfileRow = (srcId, dstId) => {
                    const rp = db.prepare('SELECT * FROM remote.llm_profiles WHERE id = ?').get(srcId);
                    if (!rp) return;
                    upsertProfile.run({ ...rp, id: dstId });
                };
                for (const c of plan.connections.create) syncProfileRow(c.id, c.id);
                for (const c of plan.connections.update) syncProfileRow(c.id, c.targetId);
                if (mirror) {
                    for (const delId of plan.connections.delete) {
                        db.prepare('UPDATE chats SET profile_id = NULL WHERE profile_id = ?').run(delId);
                        db.prepare('DELETE FROM llm_profiles WHERE id = ?').run(delId);
                    }
                }
            }

            // ── 2. Characters (characters, tags, char_tags, char_worlds, provider_links, media, card_versions) ──
            if (want.has('characters')) {
                const upsertCharCard = db.prepare(upsertSql('characters', ['id'], ['card', 'content_hash', 'token_estimate', 'media_localized', 'lore_dismissed', 'updated_at']));
                const upsertProviderLink = db.prepare(upsertSql('provider_links', null));
                const mediaCols = writableCols('media').filter(c => c !== 'id');
                const upsertMedia = db.prepare(`INSERT OR REPLACE INTO "media" (${mediaCols.map(c => `"${c}"`).join(', ')}) VALUES (${mediaCols.map(c => `@${c}`).join(', ')})`);

                const syncCharFull = (srcId, dstId, { syncCard = true, syncMeta = true, syncMedia = true } = {}) => {
                    const rc = db.prepare('SELECT * FROM remote.characters WHERE id = ?').get(srcId);
                    if (!rc) return;
                    if (syncCard) {
                        const existing = db.prepare('SELECT rowid FROM characters WHERE id = ?').get(dstId);
                        if (existing) {
                            try { db.prepare('DELETE FROM search_terms_pending WHERE rid = ?').run(existing.rowid); } catch { /* ignore */ }
                        }
                        upsertCharCard.run({ ...rc, id: dstId });
                    }
                    if (syncMeta) {
                        db.prepare('UPDATE characters SET fav = ?, update_locked = ? WHERE id = ?').run(rc.fav, rc.update_locked, dstId);
                        // Tags
                        const rTags = db.prepare('SELECT t.name, ct.pos FROM remote.char_tags ct JOIN remote.tags t ON t.id = ct.tag_id WHERE ct.char_id = ? ORDER BY ct.pos').all(srcId);
                        db.prepare('DELETE FROM char_tags WHERE char_id = ?').run(dstId);
                        for (const rt of rTags) {
                            db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(rt.name);
                            const localTag = db.prepare('SELECT id FROM tags WHERE name = ?').get(rt.name);
                            if (localTag) db.prepare('INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos) VALUES (?, ?, ?)').run(dstId, localTag.id, rt.pos ?? 0);
                        }
                        // Character Worlds
                        const rWorlds = db.prepare('SELECT world_name, pos FROM remote.char_worlds WHERE char_id = ? ORDER BY pos').all(srcId);
                        db.prepare('DELETE FROM char_worlds WHERE char_id = ?').run(dstId);
                        for (const rw of rWorlds) {
                            ensureWorldPlaceholder(rw.world_name);
                            db.prepare('INSERT OR IGNORE INTO char_worlds (char_id, world_name, pos) VALUES (?, ?, ?)').run(dstId, rw.world_name, rw.pos);
                        }
                        // Provider links
                        const rLinks = db.prepare('SELECT * FROM remote.provider_links WHERE char_id = ?').all(srcId);
                        for (const rl of rLinks) {
                            upsertProviderLink.run({ ...rl, char_id: dstId });
                        }
                    }
                    if (syncMedia) {
                        const rMedia = db.prepare('SELECT * FROM remote.media WHERE char_id = ?').all(srcId);
                        if (mirror) {
                            const rFiles = new Set(rMedia.map(m => m.file));
                            const lMedia = db.prepare('SELECT file FROM media WHERE char_id = ?').all(dstId);
                            for (const lm of lMedia) {
                                if (!rFiles.has(lm.file)) {
                                    db.prepare('DELETE FROM media WHERE char_id = ? AND file = ?').run(dstId, lm.file);
                                    if (paths?.galleryRoot) filesToDelete.push(path.join(paths.galleryRoot, dstId, lm.file));
                                }
                            }
                        }
                        for (const rm of rMedia) {
                            upsertMedia.run({ ...rm, char_id: dstId });
                        }
                    }
                };

                for (const srcId of plan.characters.create) {
                    const dstId = aliases[srcId] || srcId;
                    syncCharFull(srcId, dstId, { syncCard: true, syncMeta: true, syncMedia: true });
                }
                for (const item of plan.characters.update) {
                    syncCharFull(item.sourceId ?? item.id, item.id, {
                        syncCard: item.card,
                        syncMeta: item.card || item.meta,
                        syncMedia: item.media || mirror,
                    });
                }
                if (mirror) {
                    for (const delId of plan.characters.delete) {
                        if (paths?.avatarsDir) filesToDelete.push(path.join(paths.avatarsDir, `${delId}.png`));
                        db.prepare('DELETE FROM char_tags WHERE char_id = ?').run(delId);
                        db.prepare('DELETE FROM char_worlds WHERE char_id = ?').run(delId);
                        db.prepare('DELETE FROM provider_links WHERE char_id = ?').run(delId);
                        try { db.prepare('DELETE FROM char_aliases WHERE char_id = ?').run(delId); } catch { /* ignore */ }
                        db.prepare('DELETE FROM media WHERE char_id = ?').run(delId);
                        db.prepare('DELETE FROM playlist_chars WHERE char_id = ?').run(delId);
                        try { db.prepare('DELETE FROM versions WHERE char_id = ?').run(delId); } catch { /* ignore */ }
                        try { db.prepare('DELETE FROM version_seq WHERE char_id = ?').run(delId); } catch { /* ignore */ }
                        const delChats = db.prepare('SELECT id FROM chats WHERE char_id = ?').all(delId);
                        for (const dc of delChats) {
                            db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(dc.id);
                            db.prepare('DELETE FROM chat_worlds WHERE chat_id = ?').run(dc.id);
                            db.prepare('DELETE FROM attachments WHERE chat_id = ?').run(dc.id);
                            db.prepare('DELETE FROM chats WHERE id = ?').run(dc.id);
                        }
                        db.prepare('DELETE FROM characters WHERE id = ?').run(delId);
                    }
                    // Clean up orphan tags
                    db.exec('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM char_tags)');
                }

                // ── 2b. Creator Studio sessions (studio_sessions) with Characters ──
                const hasLocalStudio = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'studio_sessions'").get();
                const hasRemoteStudio = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'studio_sessions'").get();
                if (hasLocalStudio && hasRemoteStudio) {
                    const upsertStudio = db.prepare(upsertSql('studio_sessions', ['id']));
                    const upsertStudioAtt = db.prepare(upsertSql('attachments', null, null, true));
                    const remoteStudios = db.prepare('SELECT * FROM remote.studio_sessions').all();
                    const seenStudioIds = new Set();
                    for (const rss of remoteStudios) {
                        const resolvedCharId = rss.char_id ? (aliases[rss.char_id] || rss.char_id) : null;
                        if (resolvedCharId && !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(resolvedCharId)) continue;
                        seenStudioIds.add(rss.id);
                        const loc = db.prepare('SELECT updated_at FROM studio_sessions WHERE id = ?').get(rss.id);
                        if (loc && preferNewer && (loc.updated_at ?? 0) > (rss.updated_at ?? 0)) continue;
                        const resolvedProfileId = rss.profile_id && db.prepare('SELECT 1 FROM llm_profiles WHERE id = ?').get(rss.profile_id)
                            ? rss.profile_id
                            : null;
                        upsertStudio.run({
                            ...rss,
                            char_id: resolvedCharId,
                            profile_id: resolvedProfileId,
                        });
                        const sAtts = db.prepare('SELECT * FROM remote.attachments WHERE studio_id = ?').all(rss.id);
                        for (const sa of sAtts) {
                            upsertStudioAtt.run({ ...sa, studio_id: rss.id, chat_id: null });
                        }
                    }
                    if (mirror) {
                        for (const lss of db.prepare('SELECT id FROM studio_sessions').all()) {
                            if (!seenStudioIds.has(lss.id)) {
                                const attRows = db.prepare('SELECT file FROM attachments WHERE studio_id = ?').all(lss.id);
                                if (paths?.attachmentsRoot) {
                                    for (const a of attRows) filesToDelete.push(path.join(paths.attachmentsRoot, lss.id, a.file));
                                }
                                db.prepare('DELETE FROM attachments WHERE studio_id = ?').run(lss.id);
                                db.prepare('DELETE FROM studio_sessions WHERE id = ?').run(lss.id);
                            }
                        }
                    }
                }

                // ── 2c. Card version history (versions & version_seq): append-only by (char_id, created_at, sha256(data)) ──
                const hasLocalVersions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'versions'").get();
                const hasRemoteVersions = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'versions'").get();
                if (hasLocalVersions && hasRemoteVersions) {
                    const insVersion = db.prepare(`
                        INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `);
                    const insBackupIgnore = db.prepare(`
                        INSERT OR IGNORE INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
                        VALUES (?, -1, ?, ?, ?, ?, ?)
                    `);
                    const hasLocalVerSeq = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'version_seq'").get();
                    const nextLocalSnapId = (charId) => {
                        const max = db.prepare("SELECT MAX(snap_id) AS m FROM versions WHERE char_id = ? AND snap_id >= 0 AND typeof(snap_id) = 'integer'").get(charId)?.m ?? 0;
                        const last = hasLocalVerSeq
                            ? (db.prepare('SELECT last FROM version_seq WHERE char_id = ?').get(charId)?.last ?? 0)
                            : 0;
                        const next = Math.max(max, last) + 1;
                        if (hasLocalVerSeq) {
                            db.prepare('INSERT INTO version_seq (char_id, last) VALUES (?, ?) ON CONFLICT(char_id) DO UPDATE SET last = excluded.last').run(charId, next);
                        }
                        return next;
                    };
                    const heldByChar = new Map();
                    const heldKeysFor = (charId) => {
                        let set = heldByChar.get(charId);
                        if (!set) {
                            set = new Set(
                                db.prepare('SELECT snap_id, created_at, data FROM versions WHERE char_id = ? AND snap_id >= 0').all(charId)
                                    .map(v => `${v.created_at ?? 0}:${sha256(String(v.data ?? ''))}`)
                            );
                            heldByChar.set(charId, set);
                        }
                        return set;
                    };
                    for (const rv of db.prepare('SELECT * FROM remote.versions ORDER BY created_at ASC, snap_id ASC').all()) {
                        const dstCharId = aliases[rv.char_id] || rv.char_id;
                        if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(dstCharId)) continue;
                        if (rv.snap_id === -1) {
                            insBackupIgnore.run(dstCharId, rv.label, rv.source, rv.created_at, rv.char_name, rv.data);
                            continue;
                        }
                        const vKey = `${rv.created_at ?? 0}:${sha256(String(rv.data ?? ''))}`;
                        const held = heldKeysFor(dstCharId);
                        if (held.has(vKey)) continue;
                        held.add(vKey);
                        const newSnapId = nextLocalSnapId(dstCharId);
                        insVersion.run(dstCharId, newSnapId, rv.label, rv.source, rv.created_at, rv.char_name, rv.data);
                    }
                }

                // ── 2d. Character identity aliases (char_aliases) with Characters ──
                const hasLocalAliases = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'char_aliases'").get();
                const hasRemoteAliases = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'char_aliases'").get();
                if (hasLocalAliases && hasRemoteAliases) {
                    const upsertAlias = db.prepare(`
                        INSERT INTO char_aliases (kind, value, char_id) VALUES (?, ?, ?)
                        ON CONFLICT(kind, value) DO UPDATE SET char_id = excluded.char_id
                    `);
                    const insertIgnoreAlias = db.prepare(`
                        INSERT OR IGNORE INTO char_aliases (kind, value, char_id) VALUES (?, ?, ?)
                    `);
                    const seenAliasKeys = new Set();
                    for (const ra of db.prepare('SELECT kind, value, char_id FROM remote.char_aliases').all()) {
                        const dstCharId = aliases[ra.char_id] || ra.char_id;
                        if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(dstCharId)) continue;
                        seenAliasKeys.add(`${ra.kind}\u0000${ra.value}`);
                        if (preferNewer) {
                            insertIgnoreAlias.run(ra.kind, ra.value, dstCharId);
                        } else {
                            upsertAlias.run(ra.kind, ra.value, dstCharId);
                        }
                    }
                    if (mirror) {
                        for (const la of db.prepare('SELECT kind, value FROM char_aliases').all()) {
                            if (!seenAliasKeys.has(`${la.kind}\u0000${la.value}`)) {
                                db.prepare('DELETE FROM char_aliases WHERE kind = ? AND value = ?').run(la.kind, la.value);
                            }
                        }
                    }
                }
            }

            // ── 3. Personas (personas, persona_worlds, activePersonaId) ──
            const personaIdMap = new Map();
            if (want.has('personas')) {
                // Map remote personas to local personas by id, or by case-insensitive name ONLY when
                // that name is unique on both sides.
                const locPersonas = db.prepare('SELECT id, name FROM personas').all();
                const remPersonas = db.prepare('SELECT id, name FROM remote.personas').all();
                const locById = new Map(locPersonas.map(p => [p.id, p.id]));
                const locNameCounts = new Map();
                const remNameCounts = new Map();
                for (const p of locPersonas) {
                    const k = String(p.name || '').trim().toLowerCase();
                    if (k) locNameCounts.set(k, (locNameCounts.get(k) || 0) + 1);
                }
                for (const p of remPersonas) {
                    const k = String(p.name || '').trim().toLowerCase();
                    if (k) remNameCounts.set(k, (remNameCounts.get(k) || 0) + 1);
                }
                const locByUniqueName = new Map();
                for (const p of locPersonas) {
                    const k = String(p.name || '').trim().toLowerCase();
                    if (k && locNameCounts.get(k) === 1 && remNameCounts.get(k) === 1) {
                        locByUniqueName.set(k, p.id);
                    }
                }
                for (const rp of remPersonas) {
                    const dst = locById.get(rp.id) || locByUniqueName.get(String(rp.name || '').trim().toLowerCase());
                    if (dst) personaIdMap.set(rp.id, dst);
                }

                const upsertPersona = db.prepare(upsertSql('personas', ['id']));
                const syncPersonaRow = (srcId, dstId) => {
                    const rp = db.prepare('SELECT * FROM remote.personas WHERE id = ?').get(srcId);
                    if (!rp) return;
                    personaIdMap.set(srcId, dstId);
                    upsertPersona.run({ ...rp, id: dstId });
                    if (!rp.avatar && paths?.personaAvatarsDir) {
                        filesToDelete.push(path.join(paths.personaAvatarsDir, `${dstId}.png`));
                    }
                    db.prepare('DELETE FROM persona_worlds WHERE persona_id = ?').run(dstId);
                    const rWorlds = db.prepare('SELECT world_name, pos FROM remote.persona_worlds WHERE persona_id = ? ORDER BY pos').all(srcId);
                    for (const rw of rWorlds) {
                        ensureWorldPlaceholder(rw.world_name);
                        db.prepare('INSERT OR IGNORE INTO persona_worlds (persona_id, world_name, pos) VALUES (?, ?, ?)').run(dstId, rw.world_name, rw.pos);
                    }
                };

                for (const p of plan.personas.create) syncPersonaRow(p.id, p.id);
                for (const p of plan.personas.update) {
                    personaIdMap.set(p.id, p.targetId);
                    if (p.base !== false) syncPersonaRow(p.id, p.targetId);
                }
                if (mirror) {
                    for (const delId of plan.personas.delete) {
                        if (paths?.personaAvatarsDir) filesToDelete.push(path.join(paths.personaAvatarsDir, `${delId}.png`));
                        db.prepare('UPDATE chats SET persona_id = NULL WHERE persona_id = ?').run(delId);
                        db.prepare('DELETE FROM persona_worlds WHERE persona_id = ?').run(delId);
                        db.prepare('DELETE FROM personas WHERE id = ?').run(delId);
                    }
                }
                // Sync activePersonaId if the local one is unset or doesn't exist
                const remActive = db.prepare("SELECT value FROM remote.settings WHERE key = 'activePersonaId'").get();
                const locActive = db.prepare("SELECT value FROM settings WHERE key = 'activePersonaId'").get();
                if (remActive?.value) {
                    let rawId = remActive.value;
                    try { rawId = JSON.parse(rawId); } catch { /* raw string */ }
                    const mappedId = personaIdMap.get(rawId) || rawId;
                    const existsHere = db.prepare('SELECT 1 FROM personas WHERE id = ?').get(mappedId);
                    let locExists = false;
                    if (locActive?.value) {
                        let lid = locActive.value;
                        try { lid = JSON.parse(lid); } catch { /* raw */ }
                        locExists = !!db.prepare('SELECT 1 FROM personas WHERE id = ?').get(lid);
                    }
                    if (existsHere && (!locExists || !preferNewer)) {
                        db.prepare("INSERT INTO settings (key, value) VALUES ('activePersonaId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                            .run(JSON.stringify(mappedId));
                    }
                }
            }

            // ── 4. Presets (presets, preset_blocks, activePresetId) ──
            const presetIdMap = new Map();
            if (want.has('presets')) {
                const upsertPreset = db.prepare(upsertSql('presets', ['id']));
                const insBlock = db.prepare(upsertSql('preset_blocks', ['id']));
                const syncPresetRow = (srcId, dstId) => {
                    const rp = db.prepare('SELECT * FROM remote.presets WHERE id = ?').get(srcId);
                    if (!rp) return;
                    presetIdMap.set(srcId, dstId);
                    upsertPreset.run({ ...rp, id: dstId });
                    db.prepare('DELETE FROM preset_blocks WHERE preset_id = ?').run(dstId);
                    const blocks = db.prepare('SELECT * FROM remote.preset_blocks WHERE preset_id = ? ORDER BY pos').all(srcId);
                    for (const b of blocks) {
                        const blockId = dstId === srcId ? b.id : `${dstId}_${b.pos}`;
                        insBlock.run({ ...b, id: blockId, preset_id: dstId });
                    }
                };

                for (const p of plan.presets.create) syncPresetRow(p.id, p.id);
                for (const p of plan.presets.update) syncPresetRow(p.id, p.targetId);
                if (mirror) {
                    for (const delId of plan.presets.delete) {
                        db.prepare('UPDATE chats SET preset_id = NULL WHERE preset_id = ?').run(delId);
                        db.prepare('DELETE FROM preset_blocks WHERE preset_id = ?').run(delId);
                        db.prepare('DELETE FROM presets WHERE id = ?').run(delId);
                    }
                }
                const remActive = db.prepare("SELECT value FROM remote.settings WHERE key = 'activePresetId'").get();
                const locActive = db.prepare("SELECT value FROM settings WHERE key = 'activePresetId'").get();
                if (remActive?.value) {
                    let rawId = remActive.value;
                    try { rawId = JSON.parse(rawId); } catch { /* raw */ }
                    const mappedId = presetIdMap.get(rawId) || rawId;
                    const existsHere = db.prepare('SELECT 1 FROM presets WHERE id = ?').get(mappedId);
                    let locExists = false;
                    if (locActive?.value) {
                        let lid = locActive.value;
                        try { lid = JSON.parse(lid); } catch { /* raw */ }
                        locExists = !!db.prepare('SELECT 1 FROM presets WHERE id = ?').get(lid);
                    }
                    if (existsHere && (!locExists || !preferNewer)) {
                        db.prepare("INSERT INTO settings (key, value) VALUES ('activePresetId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                            .run(JSON.stringify(mappedId));
                    }
                }
            }

            // ── 6. Chats (chats, chat_messages, chat_worlds, attachments, message_attachments) ──
            if (want.has('chats')) {
                const chatUpdateCols = writableCols('chats').filter(c => !['id', 'message_count', 'last_mes'].includes(c));
                const upsertChat = db.prepare(upsertSql('chats', ['id'], chatUpdateCols));
                const insMsg = db.prepare(upsertSql('chat_messages', ['chat_id', 'seq'], null, true));
                const upsertAtt = db.prepare(upsertSql('attachments', null, null, true));

                const syncChatFull = (srcChatId, dstChatId, dstCharId) => {
                    const rch = db.prepare('SELECT * FROM remote.chats WHERE id = ?').get(srcChatId);
                    if (!rch) return;
                    const resolvedCharId = dstCharId ?? (rch.char_id ? (aliases[rch.char_id] || rch.char_id) : null);
                    if (resolvedCharId && !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(resolvedCharId)) return;

                    const resolvedPersonaId = rch.persona_id && db.prepare('SELECT 1 FROM personas WHERE id = ?').get(personaIdMap.get(rch.persona_id) || rch.persona_id)
                        ? (personaIdMap.get(rch.persona_id) || rch.persona_id)
                        : null;
                    const resolvedPresetId = rch.preset_id && db.prepare('SELECT 1 FROM presets WHERE id = ?').get(presetIdMap.get(rch.preset_id) || rch.preset_id)
                        ? (presetIdMap.get(rch.preset_id) || rch.preset_id)
                        : null;
                    const resolvedProfileId = rch.profile_id && db.prepare('SELECT 1 FROM llm_profiles WHERE id = ?').get(rch.profile_id)
                        ? rch.profile_id
                        : null;

                    // Clear existing messages first so trg_chats_count_ai starts from 0
                    db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(dstChatId);

                    upsertChat.run({
                        ...rch,
                        id: dstChatId,
                        char_id: resolvedCharId,
                        persona_id: resolvedPersonaId,
                        preset_id: resolvedPresetId,
                        profile_id: resolvedProfileId,
                        message_count: 0,
                        last_mes: null,
                    });

                    // Messages (triggers on chat_messages automatically maintain chats.message_count & last_mes)
                    const msgs = db.prepare('SELECT * FROM remote.chat_messages WHERE chat_id = ? ORDER BY seq').all(srcChatId);
                    const msgIdMap = new Map();
                    for (const m of msgs) {
                        const info = insMsg.run({ ...m, chat_id: dstChatId });
                        msgIdMap.set(m.id, Number(info.lastInsertRowid));
                    }

                    // Chat worlds
                    db.prepare('DELETE FROM chat_worlds WHERE chat_id = ?').run(dstChatId);
                    const cws = db.prepare('SELECT world_name, pos FROM remote.chat_worlds WHERE chat_id = ? ORDER BY pos').all(srcChatId);
                    for (const cw of cws) {
                        ensureWorldPlaceholder(cw.world_name);
                        db.prepare('INSERT OR IGNORE INTO chat_worlds (chat_id, world_name, pos) VALUES (?, ?, ?)').run(dstChatId, cw.world_name, cw.pos);
                    }

                    // Chat attachments & message_attachments
                    const atts = db.prepare('SELECT * FROM remote.attachments WHERE chat_id = ?').all(srcChatId);
                    const attIdMap = new Map();
                    for (const att of atts) {
                        upsertAtt.run({ ...att, chat_id: dstChatId });
                        const localAtt = db.prepare('SELECT id FROM attachments WHERE file = ?').get(att.file);
                        if (localAtt) attIdMap.set(att.id, localAtt.id);
                    }
                    if (attIdMap.size > 0 && msgIdMap.size > 0) {
                        const rLinks = db.prepare('SELECT ma.* FROM remote.message_attachments ma JOIN remote.chat_messages cm ON cm.id = ma.message_id WHERE cm.chat_id = ?').all(srcChatId);
                        for (const rl of rLinks) {
                            const newMsgId = msgIdMap.get(rl.message_id);
                            const newAttId = attIdMap.get(rl.attachment_id);
                            if (newMsgId && newAttId) {
                                db.prepare('INSERT OR REPLACE INTO message_attachments (message_id, attachment_id, pos) VALUES (?, ?, ?)').run(newMsgId, newAttId, rl.pos);
                            }
                        }
                    }
                };

                // Also sync chats belonging to newly created characters!
                for (const srcCharId of plan.characters.create) {
                    const dstCharId = aliases[srcCharId] || srcCharId;
                    const charChats = db.prepare('SELECT id FROM remote.chats WHERE char_id = ?').all(srcCharId);
                    for (const cc of charChats) {
                        syncChatFull(cc.id, cc.id, dstCharId);
                    }
                }
                for (const c of plan.chats.create) {
                    syncChatFull(c.id, c.id, c.charId);
                }
                for (const c of plan.chats.update) {
                    if (c.base !== false) {
                        syncChatFull(c.id, c.targetId, c.charId);
                    }
                }
                if (mirror) {
                    for (const delId of plan.chats.delete) {
                        const attRows = db.prepare('SELECT file FROM attachments WHERE chat_id = ?').all(delId);
                        if (paths?.attachmentsRoot) {
                            for (const a of attRows) filesToDelete.push(path.join(paths.attachmentsRoot, delId, a.file));
                        }
                        try { db.prepare('DELETE FROM assistant_sessions WHERE chat_id = ?').run(delId); } catch { /* ignore */ }
                        db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(delId);
                        db.prepare('DELETE FROM chat_worlds WHERE chat_id = ?').run(delId);
                        db.prepare('DELETE FROM attachments WHERE chat_id = ?').run(delId);
                        db.prepare('DELETE FROM chats WHERE id = ?').run(delId);
                    }
                }

                // ── 6b. Chat Assistant sessions (assistant_sessions) with Chats ──
                const hasLocalAsst = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assistant_sessions'").get();
                const hasRemoteAsst = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'assistant_sessions'").get();
                if (hasLocalAsst && hasRemoteAsst) {
                    const chatIdMap = new Map();
                    for (const u of plan.chats.update) chatIdMap.set(u.id, u.targetId || u.id);
                    for (const c of plan.chats.create) chatIdMap.set(c.id, c.id);
                    const localChats = db.prepare('SELECT id, char_id, name FROM chats').all();
                    const localById = new Set(localChats.map(c => c.id));
                    const localByKey = new Map(localChats.map(c => [`${c.char_id || ''}\u0000${c.name}`, c.id]));
                    for (const rch of db.prepare('SELECT id, char_id, name FROM remote.chats').all()) {
                        if (chatIdMap.has(rch.id)) continue;
                        const resolvedCharId = rch.char_id ? (aliases[rch.char_id] || rch.char_id) : '';
                        const dstId = localById.has(rch.id)
                            ? rch.id
                            : localByKey.get(`${resolvedCharId}\u0000${rch.name}`);
                        if (dstId) chatIdMap.set(rch.id, dstId);
                    }

                    const upsertAsst = db.prepare(upsertSql('assistant_sessions', ['id']));
                    const remoteAssts = db.prepare('SELECT * FROM remote.assistant_sessions').all();
                    const seenAsstIds = new Set();
                    for (const ras of remoteAssts) {
                        const dstChatId = chatIdMap.get(ras.chat_id) || ras.chat_id;
                        if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(dstChatId)) continue;
                        seenAsstIds.add(ras.id);
                        const loc = db.prepare('SELECT updated_at FROM assistant_sessions WHERE id = ?').get(ras.id);
                        if (loc && preferNewer && (loc.updated_at ?? 0) > (ras.updated_at ?? 0)) continue;
                        const resolvedProfileId = ras.profile_id && db.prepare('SELECT 1 FROM llm_profiles WHERE id = ?').get(ras.profile_id)
                            ? ras.profile_id
                            : null;
                        upsertAsst.run({
                            ...ras,
                            chat_id: dstChatId,
                            profile_id: resolvedProfileId,
                        });
                    }
                    if (mirror) {
                        for (const las of db.prepare('SELECT id FROM assistant_sessions').all()) {
                            if (!seenAsstIds.has(las.id)) {
                                db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(las.id);
                            }
                        }
                    }
                }
            }

            // ── 7. Playlists (playlists, playlist_chars) ──
            if (want.has('playlists')) {
                const upsertPlaylist = db.prepare(upsertSql('playlists', ['id']));
                const syncPlaylistRow = (srcId, dstId, members, isUpdate) => {
                    const rp = db.prepare('SELECT * FROM remote.playlists WHERE id = ?').get(srcId);
                    if (!rp) return;
                    upsertPlaylist.run({ ...rp, id: dstId });

                    if (mirror || !isUpdate) {
                        db.prepare('DELETE FROM playlist_chars WHERE playlist_id = ?').run(dstId);
                    }
                    let pos = (db.prepare('SELECT COALESCE(MAX(pos), -1) + 1 AS next FROM playlist_chars WHERE playlist_id = ?').get(dstId)?.next) ?? 0;
                    for (const charId of members || []) {
                        const mappedChar = aliases[charId] || charId;
                        if (db.prepare('SELECT 1 FROM characters WHERE id = ?').get(mappedChar)) {
                            db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)').run(dstId, mappedChar, pos++);
                        }
                    }
                };
                for (const p of plan.playlists.create) syncPlaylistRow(p.id, p.id, p.members, false);
                for (const p of plan.playlists.update) syncPlaylistRow(p.id, p.targetId, p.members, true);
                if (mirror) {
                    for (const delId of plan.playlists.delete) {
                        db.prepare('DELETE FROM playlist_chars WHERE playlist_id = ?').run(delId);
                        db.prepare('DELETE FROM playlists WHERE id = ?').run(delId);
                    }
                }
            }

            // ── 8. Backgrounds (backgrounds, background_bindings) ──
            if (want.has('backgrounds')) {
                const upsertBg = db.prepare(upsertSql('backgrounds', ['id']));
                const bindCols = writableCols('background_bindings').filter(c => c !== 'id');
                const insBinding = db.prepare(`INSERT OR REPLACE INTO "background_bindings" (${bindCols.map(c => `"${c}"`).join(', ')}) VALUES (${bindCols.map(c => `@${c}`).join(', ')})`);
                const syncBgRow = (srcId, dstId) => {
                    const rb = db.prepare('SELECT * FROM remote.backgrounds WHERE id = ?').get(srcId);
                    if (!rb) return;
                    upsertBg.run({ ...rb, id: dstId });
                };
                for (const b of plan.backgrounds.create) syncBgRow(b.id, b.id);
                for (const b of plan.backgrounds.update) syncBgRow(b.id, b.targetId);
                if (mirror) {
                    for (const delId of plan.backgrounds.delete) {
                        const row = db.prepare('SELECT file FROM backgrounds WHERE id = ?').get(delId);
                        if (row?.file && paths?.backgroundsDir) filesToDelete.push(path.join(paths.backgroundsDir, row.file));
                        db.prepare('DELETE FROM background_bindings WHERE background_id = ?').run(delId);
                        db.prepare('DELETE FROM backgrounds WHERE id = ?').run(delId);
                    }
                }
                const bindings = db.prepare('SELECT * FROM remote.background_bindings').all();
                for (const bb of bindings) {
                    const mappedChar = bb.char_id ? (aliases[bb.char_id] || bb.char_id) : null;
                    if (db.prepare('SELECT 1 FROM backgrounds WHERE id = ?').get(bb.background_id)) {
                        insBinding.run({ ...bb, char_id: mappedChar });
                    }
                }
            }

            // ── 8b. Enabled Extensions' Declared Tables (lanSync.tables) ──
            for (const ext of enabledLanSyncExtensions(db)) {
                const prefix = `x_${ext.id.replace(/-/g, '_')}_`;
                for (const table of ext.tables) {
                    if (!table.startsWith(prefix) || !/^x_[a-z0-9_]+$/.test(table)) continue;
                    const localTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
                    const remoteTableExists = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = ?").get(table);
                    if (!localTableExists || !remoteTableExists) continue;

                    const colInfo = db.pragma(`table_info("${table}")`);
                    const pkCols = colInfo.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
                    if (!pkCols.length) continue;
                    const colNames = new Set(colInfo.map(c => c.name));

                    if (colNames.has('persona_id') && !want.has('personas')) continue;
                    if (colNames.has('char_id') && !want.has('characters')) continue;

                    const upsertExt = db.prepare(upsertSql(table, pkCols));
                    const pkKey = (r) => JSON.stringify(pkCols.map(k => r[k]));
                    const localRows = new Map(db.prepare(`SELECT * FROM "${table}"`).all().map(r => [pkKey(r), r]));
                    const remoteRows = db.prepare(`SELECT * FROM remote."${table}"`).all();

                    const rowTimestamp = (schema, r, rawOwnerId) => {
                        if (r?.updated_at != null) return Number(r.updated_at) || 0;
                        if (colNames.has('persona_id') && rawOwnerId) {
                            return Number(db.prepare(`SELECT updated_at FROM ${schema}.personas WHERE id = ?`).get(rawOwnerId)?.updated_at) || 0;
                        }
                        if (colNames.has('char_id') && rawOwnerId) {
                            return Number(db.prepare(`SELECT updated_at FROM ${schema}.characters WHERE id = ?`).get(rawOwnerId)?.updated_at) || 0;
                        }
                        return 0;
                    };

                    const seenPks = new Set();
                    for (const rRow of remoteRows) {
                        const row = { ...rRow };
                        const rawOwnerId = colNames.has('persona_id') ? rRow.persona_id : (colNames.has('char_id') ? rRow.char_id : null);
                        if (colNames.has('persona_id') && row.persona_id) {
                            const dstPid = personaIdMap.get(row.persona_id) || row.persona_id;
                            if (!db.prepare('SELECT 1 FROM personas WHERE id = ?').get(dstPid)) continue;
                            row.persona_id = dstPid;
                        }
                        if (colNames.has('char_id') && row.char_id) {
                            const dstCid = aliases[row.char_id] || row.char_id;
                            if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(dstCid)) continue;
                            row.char_id = dstCid;
                        }
                        const k = pkKey(row);
                        seenPks.add(k);
                        const existing = localRows.get(k);
                        if (existing && preferNewer) {
                            const localOwnerId = colNames.has('persona_id') ? existing.persona_id : (colNames.has('char_id') ? existing.char_id : null);
                            const remTs = rowTimestamp('remote', rRow, rawOwnerId);
                            const locTs = rowTimestamp('main', existing, localOwnerId);
                            if (locTs > remTs) continue;
                        }
                        upsertExt.run(row);
                    }

                    if (mirror) {
                        const whereClause = pkCols.map(c => `"${c}" = ?`).join(' AND ');
                        const delStmt = db.prepare(`DELETE FROM "${table}" WHERE ${whereClause}`);
                        for (const [k, lRow] of localRows) {
                            if (!seenPks.has(k)) {
                                delStmt.run(...pkCols.map(c => lRow[c]));
                            }
                        }
                    }
                }
            }

            // ── 8c. app_store (Saved Prompts, greetings-expanded, promoted_namespaces) & allowlisted settings ──
            if (want.has('settings')) {
                const hasLocalStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_store'").get();
                const hasRemoteStore = db.prepare("SELECT 1 FROM remote.sqlite_master WHERE type = 'table' AND name = 'app_store'").get();
                if (hasLocalStore && hasRemoteStore) {
                    const upsertDoc = db.prepare(`
                        INSERT INTO app_store (key, value, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                    `);
                    for (const rdoc of db.prepare('SELECT key, value, updated_at FROM remote.app_store').all()) {
                        if (!isAllowedAppStoreKey(rdoc.key)) continue;
                        const loc = db.prepare('SELECT updated_at FROM app_store WHERE key = ?').get(rdoc.key);
                        if (loc && preferNewer && (loc.updated_at ?? 0) > (rdoc.updated_at ?? 0)) continue;
                        upsertDoc.run(rdoc.key, rdoc.value, rdoc.updated_at ?? Date.now());
                    }
                }

                const includeConnections = want.has('connections');
                const installedExts = installedExtensionIds();
                const plannedSettings = new Set(plan.settings?.put || []);
                const upsertSetting = db.prepare(`
                    INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                `);
                for (const rset of db.prepare('SELECT key, value FROM remote.settings').all()) {
                    if (!isAllowedSettingKey(rset.key, { includeConnections, includeSecrets })) continue;
                    if (rset.key === 'enabledExtensions') {
                        let remoteList = [];
                        try {
                            const parsed = JSON.parse(rset.value);
                            if (Array.isArray(parsed)) remoteList = parsed.filter(x => typeof x === 'string');
                        } catch { continue; }
                        for (const extId of remoteList) {
                            if (!installedExts.has(extId)) missingExtensionsSet.add(extId);
                        }
                        const validRemote = remoteList.filter(extId => installedExts.has(extId));
                        let localList = [];
                        try {
                            const locRow = db.prepare("SELECT value FROM settings WHERE key = 'enabledExtensions'").get();
                            const parsedLoc = locRow?.value ? JSON.parse(locRow.value) : [];
                            if (Array.isArray(parsedLoc)) localList = parsedLoc.filter(x => typeof x === 'string');
                        } catch { localList = []; }
                        const merged = mirror
                            ? [...new Set([...validRemote, ...(localList.includes('lan-sync') ? ['lan-sync'] : [])])]
                            : [...new Set([...localList, ...validRemote])];
                        upsertSetting.run('enabledExtensions', JSON.stringify(merged));
                        continue;
                    }
                    if (!plannedSettings.has(rset.key)) continue;
                    if (rset.key === 'chatProfileId' || rset.key === 'assistantProfileId' || rset.key.startsWith('aiProfile.')) {
                        let profId = rset.value;
                        try { profId = JSON.parse(rset.value); } catch { /* raw */ }
                        if (typeof profId === 'string' && profId) {
                            const exists = db.prepare('SELECT 1 FROM llm_profiles WHERE id = ?').get(profId);
                            if (!exists) continue;
                        }
                    }
                    upsertSetting.run(rset.key, rset.value);
                }
            }

            // ── 9. Rebuild FTS5 search indexes if needed ──
            if (want.has('characters')) {
                try { db.exec("INSERT INTO card_tokens_fts(card_tokens_fts) VALUES ('rebuild')"); } catch { /* populated lazily */ }
            }

            // ── 10. Report changes inside the merge transaction so extensions (e.g. Evolutia) rebuild on the server ──
            try { ctx?.report?.(db, { entity: 'library', op: 'changed' }); } catch { /* library not in LibraryWriteEntity */ }
            try {
                ctx?.report?.(db, { entity: 'character', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'persona', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'chat', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'world', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'preset', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'playlist', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'background', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'setting', op: 'updated', all: true });
                ctx?.report?.(db, { entity: 'document', op: 'updated', all: true });
            } catch { /* ignore if db is untracked in unit test */ }
        });

        tx();
    } finally {
        try { db.pragma('foreign_keys = ON'); } catch { /* ignore */ }
        try { db.exec('DETACH DATABASE remote'); } catch { /* ignore */ }
    }
    return { filesToDelete, missingExtensions: [...missingExtensionsSet] };
}

/**
 * Emit change events so open Project Σ tabs immediately refresh characters, chats, personas, presets, playlists, etc.
 */
function emitSyncChanges(db, ctx) {
    try {
        const ins = db.prepare('INSERT INTO change_log (at, entity, op, id, parent_id, summary) VALUES (?, ?, ?, ?, ?, ?)');
        const now = Date.now();
        ins.run(now, 'library', 'changed', 'all', null, JSON.stringify({ reason: 'resync' }));
        ins.run(now, 'persona', 'changed', 'all', null, null);
        ins.run(now, 'preset', 'changed', 'all', null, null);
        ins.run(now, 'playlist', 'changed', 'all', null, null);
        ins.run(now, 'world', 'changed', 'all', null, null);
        ins.run(now, 'settings', 'updated', 'activePersonaId', null, null);
        ins.run(now, 'settings', 'updated', 'activePresetId', null, null);
    } catch { /* ignore if change_log table unavailable */ }
    try {
        ctx?.report?.(db, 'library', 'all', { reason: 'resync' });
    } catch { /* ignore */ }
}

/**
 * Merge a duplicate character (`fromId`) into an existing original character (`intoId`):
 * moves chats, gallery media, provider links, tags, worlds, playlists, studio sessions, and
 * extension char_id rows onto `intoId`, deletes `fromId` with foreign_keys ON so ON DELETE CASCADE
 * cleans up char_aliases/media_jobs/tag_run_links/versions, recounts chat_count & last_chat_at,
 * reports changes via ctx.report, and records the alias `fromId -> intoId` in `peers.json`.
 */
export function mergeDuplicateCharacter(db, paths, store, { fromId, intoId, peerId = null, ctx = null } = {}) {
    if (!fromId || !intoId || fromId === intoId) {
        throw new Error('fromId and intoId must be two distinct character IDs');
    }
    const fromRow = db.prepare('SELECT * FROM characters WHERE id = ?').get(fromId);
    const intoRow = db.prepare('SELECT * FROM characters WHERE id = ?').get(intoId);
    if (!fromRow || !intoRow) {
        throw new Error('Both fromId and intoId must exist in characters');
    }

    const movedChatIds = db.prepare('SELECT id FROM chats WHERE char_id = ?').pluck().all(fromId);
    const movedFiles = [];

    try {
        db.transaction(() => {
            // 1. Move chats & studio sessions (foreign_keys stays ON; intoId is a valid character)
            db.prepare('UPDATE chats SET char_id = ? WHERE char_id = ?').run(intoId, fromId);
            try { db.prepare('UPDATE studio_sessions SET char_id = ? WHERE char_id = ?').run(intoId, fromId); } catch { /* ignore */ }

            // 2. Move gallery media rows AND rename physical gallery files BEFORE deleteCharacters runs
            // (because deleteCharacters deletes gallery/<fromId> as soon as its inner transaction returns).
            const mediaRows = db.prepare('SELECT * FROM media WHERE char_id = ?').all(fromId);
            for (const m of mediaRows) {
                const exists = db.prepare('SELECT 1 FROM media WHERE char_id = ? AND file = ?').get(intoId, m.file);
                if (!exists) {
                    db.prepare('UPDATE media SET char_id = ? WHERE id = ?').run(intoId, m.id);
                    if (paths?.galleryRoot) {
                        const srcFile = path.join(paths.galleryRoot, fromId, m.file);
                        const dstDir = path.join(paths.galleryRoot, intoId);
                        const dstFile = path.join(dstDir, m.file);
                        if (fs.existsSync(srcFile) && !fs.existsSync(dstFile)) {
                            fs.mkdirSync(dstDir, { recursive: true });
                            fs.renameSync(srcFile, dstFile);
                            movedFiles.push({ srcFile, dstFile });
                        }
                    }
                } else {
                    db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
                }
            }

            // 3. Move tags, worlds, provider_links, playlists, background_bindings
            for (const r of db.prepare('SELECT tag_id, pos FROM char_tags WHERE char_id = ?').all(fromId)) {
                db.prepare('INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos) VALUES (?, ?, ?)').run(intoId, r.tag_id, r.pos);
            }
            db.prepare('DELETE FROM char_tags WHERE char_id = ?').run(fromId);

            for (const r of db.prepare('SELECT world_name, pos FROM char_worlds WHERE char_id = ?').all(fromId)) {
                db.prepare('INSERT OR IGNORE INTO char_worlds (char_id, world_name, pos) VALUES (?, ?, ?)').run(intoId, r.world_name, r.pos);
            }
            db.prepare('DELETE FROM char_worlds WHERE char_id = ?').run(fromId);

            for (const r of db.prepare('SELECT * FROM provider_links WHERE char_id = ?').all(fromId)) {
                const hasLink = db.prepare('SELECT 1 FROM provider_links WHERE char_id = ? AND provider_id = ?').get(intoId, r.provider_id);
                if (!hasLink) {
                    db.prepare('UPDATE provider_links SET char_id = ? WHERE char_id = ? AND provider_id = ?').run(intoId, fromId, r.provider_id);
                }
            }
            db.prepare('DELETE FROM provider_links WHERE char_id = ?').run(fromId);

            for (const r of db.prepare('SELECT playlist_id, pos FROM playlist_chars WHERE char_id = ?').all(fromId)) {
                db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)').run(r.playlist_id, intoId, r.pos);
            }
            db.prepare('DELETE FROM playlist_chars WHERE char_id = ?').run(fromId);

            db.prepare('UPDATE OR IGNORE background_bindings SET char_id = ? WHERE char_id = ?').run(intoId, fromId);
            db.prepare('DELETE FROM background_bindings WHERE char_id = ?').run(fromId);

            // Move char_aliases and versions (by content identity with new local snap_ids) onto intoId before deleteCharacters removes fromId
            try {
                for (const ra of db.prepare('SELECT kind, value FROM char_aliases WHERE char_id = ?').all(fromId)) {
                    db.prepare('INSERT OR IGNORE INTO char_aliases (kind, value, char_id) VALUES (?, ?, ?)').run(ra.kind, ra.value, intoId);
                }
            } catch { /* ignore */ }
            try {
                const held = new Set(
                    db.prepare('SELECT created_at, data FROM versions WHERE char_id = ? AND snap_id >= 0').all(intoId)
                        .map(v => `${v.created_at ?? 0}:${sha256(String(v.data ?? ''))}`)
                );
                const hasVerSeq = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'version_seq'").get();
                const nextSnapForInto = () => {
                    const max = db.prepare("SELECT MAX(snap_id) AS m FROM versions WHERE char_id = ? AND snap_id >= 0 AND typeof(snap_id) = 'integer'").get(intoId)?.m ?? 0;
                    const last = hasVerSeq ? (db.prepare('SELECT last FROM version_seq WHERE char_id = ?').get(intoId)?.last ?? 0) : 0;
                    const next = Math.max(max, last) + 1;
                    if (hasVerSeq) {
                        db.prepare('INSERT INTO version_seq (char_id, last) VALUES (?, ?) ON CONFLICT(char_id) DO UPDATE SET last = excluded.last').run(intoId, next);
                    }
                    return next;
                };
                for (const rv of db.prepare('SELECT * FROM versions WHERE char_id = ? ORDER BY created_at ASC, snap_id ASC').all(fromId)) {
                    if (rv.snap_id === -1) {
                        db.prepare('INSERT OR IGNORE INTO versions (char_id, snap_id, label, source, created_at, char_name, data) VALUES (?, -1, ?, ?, ?, ?, ?)')
                            .run(intoId, rv.label, rv.source, rv.created_at, rv.char_name, rv.data);
                        continue;
                    }
                    const vKey = `${rv.created_at ?? 0}:${sha256(String(rv.data ?? ''))}`;
                    if (held.has(vKey)) continue;
                    held.add(vKey);
                    const newSnapId = nextSnapForInto();
                    db.prepare('INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
                        .run(intoId, newSnapId, rv.label, rv.source, rv.created_at, rv.char_name, rv.data);
                }
            } catch { /* ignore */ }

            // 4. Move any extension x_* tables with a char_id column
            const extTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'x_%'").pluck().all();
            for (const tbl of extTables) {
                try {
                    const cols = db.pragma(`table_info("${tbl}")`).map(c => c.name);
                    if (!cols.includes('char_id')) continue;
                    if (cols.includes('enabled') && cols.length === 2) {
                        const fromExt = db.prepare(`SELECT enabled FROM "${tbl}" WHERE char_id = ?`).get(fromId);
                        if (fromExt?.enabled) {
                            db.prepare(`INSERT INTO "${tbl}" (char_id, enabled) VALUES (?, 1) ON CONFLICT(char_id) DO UPDATE SET enabled = MAX(enabled, excluded.enabled)`).run(intoId);
                        }
                    } else {
                        db.prepare(`UPDATE OR IGNORE "${tbl}" SET char_id = ? WHERE char_id = ?`).run(intoId, fromId);
                    }
                    db.prepare(`DELETE FROM "${tbl}" WHERE char_id = ?`).run(fromId);
                } catch { /* ignore */ }
            }

            // 5. Delete the duplicate character with foreign_keys ON so ON DELETE CASCADE cleans up
            // char_aliases, media_jobs, tag_run_links, versions, etc.
            if (ctx?.stores?.characters?.deleteCharacters) {
                ctx.stores.characters.deleteCharacters(db, paths || {}, [fromId]);
            } else {
                db.prepare('DELETE FROM characters WHERE id = ?').run(fromId);
                if (paths?.galleryRoot) {
                    try { fs.rmSync(path.join(paths.galleryRoot, fromId), { recursive: true, force: true }); } catch { /* ignore */ }
                }
                if (paths?.avatarsDir) {
                    try { fs.unlinkSync(path.join(paths.avatarsDir, `${fromId}.png`)); } catch { /* ignore */ }
                }
            }

            // 6. Verify/recount chat_count and last_chat_at on intoId
            db.prepare(`
                UPDATE characters
                SET chat_count = (SELECT COUNT(*) FROM chats ch WHERE ch.char_id = ?),
                    last_chat_at = (SELECT MAX(ch.sort_at) FROM chats ch WHERE ch.char_id = ?)
                WHERE id = ?
            `).run(intoId, intoId, intoId);

            try {
                ctx?.report?.(db, { entity: 'character', op: 'updated', ids: [intoId] });
                if (movedChatIds.length) ctx?.report?.(db, { entity: 'chat', op: 'updated', ids: movedChatIds });
            } catch { /* ignore */ }
        })();
    } catch (err) {
        // Roll back any renamed gallery files if the transaction failed
        for (const { srcFile, dstFile } of movedFiles.reverse()) {
            try {
                fs.mkdirSync(path.dirname(srcFile), { recursive: true });
                if (fs.existsSync(dstFile) && !fs.existsSync(srcFile)) fs.renameSync(dstFile, srcFile);
            } catch { /* ignore */ }
        }
        throw err;
    }

    // Record alias in peers.json so future syncs map fromId -> intoId
    if (store) {
        for (const p of store.peers()) {
            if (peerId && p.id !== peerId) continue;
            const aliases = { ...(p.aliases || {}), [fromId]: intoId };
            store.updatePeer(p.id, { aliases });
        }
    }

    const updatedOrig = db.prepare('SELECT chat_count, last_chat_at FROM characters WHERE id = ?').get(intoId);
    return {
        ok: true,
        fromId,
        intoId,
        movedChats: movedChatIds.length,
        chatCount: updatedOrig?.chat_count ?? 0,
        lastChatAt: updatedOrig?.last_chat_at ?? null,
    };
}
