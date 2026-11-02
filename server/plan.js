// The plan a pull runs: what the source holds that this library lacks or holds differently, and (in Mirror)
// what this library holds that the source does not. Pure, so it is tested on its own.
//
// Overwrite policy, as TauriTavern names it: "exact" lets the source win every difference; "prefer-newer"
// keeps a target item whose own time is strictly newer (characters and chats carry one; a lorebook does not,
// so it follows the source either way).

export const chatKey = (c) => `${c.charId || ''}\u0000${c.name}`;
export const nameKey = (item) => String(item?.name || '').trim().toLowerCase();

function planSessions(srcList, tgtList, { mirror, preferNewer, validProfileIds }) {
    const tgtById = new Map((tgtList || []).map(x => [x.id, x]));
    const srcById = new Map((srcList || []).map(x => [x.id, x]));
    let sync = false;
    let kept = false;
    for (const s of srcList || []) {
        const t = tgtById.get(s.id);
        const resolvedProfileId = s.profileId
            ? (validProfileIds ? (validProfileIds.has(s.profileId) ? s.profileId : null) : s.profileId)
            : null;
        if (t) {
            const sameContent = (s.baseDigest !== undefined && t.baseDigest !== undefined)
                ? (t.baseDigest === s.baseDigest && (t.profileId || null) === resolvedProfileId)
                : (t.digest === s.digest);
            if (sameContent) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) {
                kept = true;
                continue;
            }
        }
        sync = true;
    }
    if (mirror) {
        for (const t of tgtList || []) {
            if (!srcById.has(t.id)) {
                sync = true;
                break;
            }
        }
    }
    return { sync, kept };
}

/**
 * @param {{characters: object[], chats: object[], worlds: object[], personas?: object[], presets?: object[], playlists?: object[], backgrounds?: object[], connections?: object[]}} source the device pulled from
 * @param {{characters: object[], chats: object[], worlds: object[], personas?: object[], presets?: object[], playlists?: object[], backgrounds?: object[], connections?: object[]}} target this library
 * @param {{datasets: string[], mode: 'incremental'|'mirror', overwrite: 'exact'|'prefer-newer'}} opts
 */
export function makePlan(source, target, { datasets, mode, overwrite }) {
    const want = new Set(datasets);
    const mirror = mode === 'mirror';
    const preferNewer = overwrite === 'prefer-newer';
    const hasTargetProfileList = Array.isArray(target.profileIds) || Array.isArray(target.connections);
    const validProfileIds = hasTargetProfileList
        ? new Set([
            ...(target.profileIds || []),
            ...(target.connections || []).map(c => c.id),
            ...(want.has('connections') ? (source.connections || []).map(c => c.id) : []),
        ])
        : null;
    const plan = {
        characters: { create: [], update: [], delete: [] },
        chats: { create: [], update: [], delete: [] },
        worlds: { put: [], delete: [] },
        personas: { create: [], update: [], delete: [] },
        presets: { create: [], update: [], delete: [] },
        playlists: { create: [], update: [], delete: [] },
        backgrounds: { create: [], update: [], delete: [] },
        settings: { put: [] },
        appStore: { put: [] },
        unboundStudio: { put: [], delete: [] },
        connections: { create: [], update: [], delete: [] },
        kept: 0, // items the target kept because its own copy is newer
    };

    const targetChars = new Map(target.characters.map(c => [c.id, c]));
    const sourceChars = new Map(source.characters.map(c => [c.id, c]));

    if (want.has('characters')) {
        for (const s of source.characters) {
            // a source character known here under another id (an alias) carries sourceId: its id on the source
            const sourceId = s.sourceId ?? s.id;
            const t = targetChars.get(s.id);
            if (!t) { plan.characters.create.push(sourceId); continue; }
            const card = s.card !== t.card;
            const tgtAliases = new Set(t.charAliases || []);
            const srcAliases = new Set(s.charAliases || []);
            const aliasesDiff = (s.charAliases || []).some(a => !tgtAliases.has(a))
                || (mirror && (t.charAliases || []).some(a => !srcAliases.has(a)));
            const meta = s.meta !== t.meta || aliasesDiff;
            let media;
            if (Array.isArray(s.mediaKeys) && Array.isArray(t.mediaKeys)) {
                const tgtMedia = new Set(t.mediaKeys);
                const srcMedia = new Set(s.mediaKeys);
                media = s.mediaKeys.some(k => !tgtMedia.has(k)) || (mirror && t.mediaKeys.some(k => !srcMedia.has(k)));
            } else {
                media = s.mediaSig ? s.mediaSig !== t.mediaSig : s.mediaCount > t.mediaCount;
            }
            let syncStudio = false;
            let studioKept = false;
            if (Array.isArray(s.studioSessions) && Array.isArray(t.studioSessions)) {
                const stPlan = planSessions(s.studioSessions, t.studioSessions, { mirror, preferNewer, validProfileIds });
                syncStudio = stPlan.sync;
                studioKept = stPlan.kept;
            } else {
                const studio = (s.studioDigest || '') !== (t.studioDigest || '') && (mirror || Boolean(s.studioDigest));
                studioKept = studio && preferNewer && (t.studioUpdatedAt ?? 0) > (s.studioUpdatedAt ?? 0);
                syncStudio = studio && !studioKept;
            }
            const tgtVerKeys = new Set(t.versionKeys || []);
            const versions = Array.isArray(s.versionKeys) && s.versionKeys.some(k => !tgtVerKeys.has(k));
            if (!card && !meta && !media && !syncStudio && !studioKept && !versions) continue;
            const cardMetaKept = (card || meta) && preferNewer && t.updatedAt > s.updatedAt;
            if (cardMetaKept) plan.kept++;
            if (studioKept && !cardMetaKept) plan.kept++;
            const syncCard = card && !cardMetaKept;
            const syncMeta = meta && !cardMetaKept;
            const syncVersions = versions;
            if (!syncCard && !syncMeta && !media && !syncStudio && !syncVersions) continue;
            plan.characters.update.push({
                id: s.id,
                sourceId,
                card: syncCard,
                meta: syncMeta,
                media,
                ...(syncStudio ? { studio: true } : {}),
                ...(syncVersions ? { versions: true } : {}),
            });
        }
        if (mirror) plan.characters.delete = target.characters.filter(t => !sourceChars.has(t.id)).map(t => t.id);

        const srcUnbound = source.unboundStudio || [];
        const tgtUnbound = target.unboundStudio || [];
        const tgtUnboundById = new Map(tgtUnbound.map(u => [u.id, u]));
        const srcUnboundIds = new Set(srcUnbound.map(u => u.id));
        for (const s of srcUnbound) {
            const t = tgtUnboundById.get(s.id);
            if (!t) { plan.unboundStudio.put.push(s.id); continue; }
            const resolvedProfileId = s.profileId
                ? (validProfileIds ? (validProfileIds.has(s.profileId) ? s.profileId : null) : s.profileId)
                : null;
            const sameContent = (s.baseDigest !== undefined && t.baseDigest !== undefined)
                ? (t.baseDigest === s.baseDigest && (t.profileId || null) === resolvedProfileId)
                : (t.digest === s.digest);
            if (sameContent) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.unboundStudio.put.push(s.id);
        }
        if (mirror) plan.unboundStudio.delete = tgtUnbound.filter(t => !srcUnboundIds.has(t.id)).map(t => t.id);
    }

    if (want.has('chats')) {
        // a character the pull creates brings its chats inside its bundle (or via direct DB sync)
        const arriving = new Set(plan.characters.create);
        const present = (charId) => !charId || targetChars.has(charId) || (want.has('characters') && arriving.has(charId));
        const targetById = new Map(target.chats.map(c => [c.id, c]));
        const targetByKey = new Map(target.chats.map(c => [chatKey(c), c]));
        const matchedTargetIds = new Set();
        for (const s of source.chats) {
            if (s.charId && (arriving.has(s.charId) || !present(s.charId))) continue;
            const t = targetById.get(s.id) || targetByKey.get(chatKey(s));
            if (!t) { plan.chats.create.push({ id: s.id, charId: s.charId, name: s.name }); continue; }
            matchedTargetIds.add(t.id);
            if (s.baseDigest !== undefined && t.baseDigest !== undefined) {
                const baseDiff = s.baseDigest !== t.baseDigest || s.name !== t.name;
                let syncAsst = false;
                let asstKept = false;
                if (Array.isArray(s.asstSessions) && Array.isArray(t.asstSessions)) {
                    const asstPlan = planSessions(s.asstSessions, t.asstSessions, { mirror, preferNewer, validProfileIds });
                    syncAsst = asstPlan.sync;
                    asstKept = asstPlan.kept;
                } else {
                    const asstDiff = (s.asstDigest || '') !== (t.asstDigest || '') && (mirror || Boolean(s.asstDigest));
                    asstKept = asstDiff && preferNewer && (t.asstUpdatedAt ?? 0) > (s.asstUpdatedAt ?? 0);
                    syncAsst = asstDiff && !asstKept;
                }
                const baseKept = baseDiff && preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0);
                if (baseKept) plan.kept++;
                if (asstKept && !baseKept) plan.kept++;
                const syncBase = baseDiff && !baseKept;
                if (!syncBase && !syncAsst) continue;
                plan.chats.update.push({ id: s.id, targetId: t.id, charId: s.charId, name: s.name, base: syncBase, asst: syncAsst });
                continue;
            }
            if (t.digest === s.digest && t.name === s.name) continue;
            if (preferNewer && t.updatedAt > s.updatedAt) { plan.kept++; continue; }
            plan.chats.update.push({ id: s.id, targetId: t.id, charId: s.charId, name: s.name });
        }
        if (mirror) {
            // a chat of a character the source lacks goes with that character, when characters sync at all
            plan.chats.delete = target.chats
                .filter(t => !matchedTargetIds.has(t.id) && (!t.charId || sourceChars.has(t.charId)))
                .map(t => t.id);
        }
    }

    if (want.has('lorebooks')) {
        const targetWorlds = new Map(target.worlds.map(w => [w.name, w]));
        const sourceNames = new Set(source.worlds.map(w => w.name));
        for (const s of source.worlds) {
            const t = targetWorlds.get(s.name);
            if (!t) { plan.worlds.put.push(s.name); continue; }
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.worlds.put.push(s.name);
        }
        if (mirror) plan.worlds.delete = target.worlds.filter(t => !sourceNames.has(t.name)).map(t => t.name);
    }

    if (want.has('personas')) {
        const srcList = source.personas || [];
        const tgtList = target.personas || [];
        const byId = new Map(tgtList.map(p => [p.id, p]));
        const srcNameCounts = new Map();
        const tgtNameCounts = new Map();
        for (const s of srcList) {
            const k = nameKey(s);
            if (k) srcNameCounts.set(k, (srcNameCounts.get(k) || 0) + 1);
        }
        for (const t of tgtList) {
            const k = nameKey(t);
            if (k) tgtNameCounts.set(k, (tgtNameCounts.get(k) || 0) + 1);
        }
        const byUniqueName = new Map();
        for (const t of tgtList) {
            const k = nameKey(t);
            if (k && tgtNameCounts.get(k) === 1 && srcNameCounts.get(k) === 1) byUniqueName.set(k, t);
        }
        const matchedTargetIds = new Set();
        for (const s of srcList) {
            const t = byId.get(s.id) || byUniqueName.get(nameKey(s));
            if (!t) {
                plan.personas.create.push({ id: s.id, name: s.name });
                continue;
            }
            matchedTargetIds.add(t.id);
            if (t.digest === s.digest) continue;
            if (s.baseDigest !== undefined && t.baseDigest !== undefined) {
                const baseDiff = s.baseDigest !== t.baseDigest;
                const extDiff = (s.extDigest || '') !== (t.extDigest || '') && (mirror || Boolean(s.extDigest));
                const baseKept = baseDiff && preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0);
                const extKept = extDiff && preferNewer && (t.extUpdatedAt ?? t.updatedAt ?? 0) > (s.extUpdatedAt ?? s.updatedAt ?? 0);
                if (baseKept) plan.kept++;
                if (extKept && !baseKept) plan.kept++;
                const syncBase = baseDiff && !baseKept;
                const syncExt = extDiff && !extKept;
                if (!syncBase && !syncExt) continue;
                plan.personas.update.push({ id: s.id, targetId: t.id, name: s.name, base: syncBase, ext: syncExt });
                continue;
            }
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.personas.update.push({ id: s.id, targetId: t.id, name: s.name });
        }
        if (mirror) plan.personas.delete = tgtList.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);
    }

    if (want.has('presets')) {
        const srcList = source.presets || [];
        const tgtList = target.presets || [];
        const byId = new Map(tgtList.map(p => [p.id, p]));
        const byName = new Map(tgtList.map(p => [nameKey(p), p]));
        const matchedTargetIds = new Set();
        for (const s of srcList) {
            const t = byId.get(s.id) || byName.get(nameKey(s));
            if (!t) {
                plan.presets.create.push({ id: s.id, name: s.name });
                continue;
            }
            matchedTargetIds.add(t.id);
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.presets.update.push({ id: s.id, targetId: t.id, name: s.name });
        }
        if (mirror) plan.presets.delete = tgtList.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);
    }

    if (want.has('playlists')) {
        const srcList = source.playlists || [];
        const tgtList = target.playlists || [];
        const byId = new Map(tgtList.map(p => [p.id, p]));
        const byName = new Map(tgtList.map(p => [nameKey(p), p]));
        const matchedTargetIds = new Set();
        for (const s of srcList) {
            const t = byId.get(s.id) || byName.get(nameKey(s));
            if (!t) {
                plan.playlists.create.push({ id: s.id, name: s.name, members: s.members || [] });
                continue;
            }
            matchedTargetIds.add(t.id);
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.playlists.update.push({ id: s.id, targetId: t.id, name: s.name, members: s.members || [], targetMembers: t.members || [] });
        }
        if (mirror) plan.playlists.delete = tgtList.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);
    }

    if (want.has('backgrounds')) {
        const srcList = source.backgrounds || [];
        const tgtList = target.backgrounds || [];
        const byId = new Map(tgtList.map(b => [b.id, b]));
        const byHash = new Map(tgtList.filter(b => b.contentHash).map(b => [b.contentHash, b]));
        const matchedTargetIds = new Set();
        for (const s of srcList) {
            const t = byId.get(s.id) || (s.contentHash ? byHash.get(s.contentHash) : null);
            if (!t) {
                plan.backgrounds.create.push({ id: s.id, file: s.file, name: s.name });
                continue;
            }
            matchedTargetIds.add(t.id);
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.backgrounds.update.push({ id: s.id, targetId: t.id, file: s.file, name: s.name });
        }
        if (mirror) plan.backgrounds.delete = tgtList.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);
    }

    if (want.has('settings')) {
        const srcDocs = source.appStore || [];
        const tgtDocs = new Map((target.appStore || []).map(d => [d.key, d]));
        for (const s of srcDocs) {
            const t = tgtDocs.get(s.key);
            if (!t) { plan.appStore.put.push(s.key); continue; }
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.appStore.put.push(s.key);
        }

        const srcSettings = source.settings || [];
        const tgtSettings = new Map((target.settings || []).map(s => [s.key, s]));
        const installed = Array.isArray(target.installedExtensions) ? new Set(target.installedExtensions) : null;
        for (const s of srcSettings) {
            const t = tgtSettings.get(s.key);
            if (s.key === 'enabledExtensions' && Array.isArray(s.extensions)) {
                const validRemote = installed ? s.extensions.filter(id => installed.has(id)) : s.extensions;
                const localList = Array.isArray(t?.extensions) ? t.extensions : [];
                const merged = mirror
                    ? [...new Set([...validRemote, ...(localList.includes('lan-sync') ? ['lan-sync'] : [])])]
                    : [...new Set([...localList, ...validRemote])];
                if (t && merged.length === localList.length && merged.every((id, i) => id === localList[i])) continue;
                if (!t && merged.length === 0) continue;
                plan.settings.put.push(s.key);
                continue;
            }
            if (s.profileId && validProfileIds && !validProfileIds.has(s.profileId)) continue;
            if (!t) {
                plan.settings.put.push(s.key);
                continue;
            }
            if (t.digest === s.digest) continue;
            // The settings table has no per-key timestamp; in Prefer-newer mode keep existing local tweaks
            if (preferNewer && s.key !== 'enabledExtensions') {
                plan.kept++;
                continue;
            }
            plan.settings.put.push(s.key);
        }
    }

    if (want.has('connections')) {
        const srcList = source.connections || [];
        const tgtList = target.connections || [];
        const byId = new Map(tgtList.map(p => [p.id, p]));
        const byName = new Map(tgtList.map(p => [nameKey(p), p]));
        const matchedTargetIds = new Set();
        for (const s of srcList) {
            const t = byId.get(s.id) || byName.get(nameKey(s));
            if (!t) {
                plan.connections.create.push({ id: s.id, name: s.name });
                continue;
            }
            matchedTargetIds.add(t.id);
            if (t.digest === s.digest) continue;
            if (preferNewer && (t.updatedAt ?? 0) > (s.updatedAt ?? 0)) { plan.kept++; continue; }
            plan.connections.update.push({ id: s.id, targetId: t.id, name: s.name });
        }
        if (mirror) plan.connections.delete = tgtList.filter(t => !matchedTargetIds.has(t.id)).map(t => t.id);
    }

    return plan;
}

/**
 * The source's manifest in this library's ids. aliases maps a source id to the id the same character has
 * here (one imported on both devices apart); a character the source holds under an id this library lacks,
 * whose card digests the same as one here that the source does not hold, is the same character and gains
 * an alias. Answers the translated manifest and the aliases, stale ones (pointing at nothing here) dropped.
 */
export function alignSource(source, target, aliases = {}) {
    const targetIds = new Set(target.characters.map(c => c.id));
    const sourceIds = new Set(source.characters.map(c => c.id));
    const kept = Object.fromEntries(Object.entries(aliases).filter(([from, to]) => targetIds.has(to) && sourceIds.has(from)));
    const claimed = new Set(Object.values(kept));

    // 1. Exact card digest twin match
    const twins = new Map();
    for (const t of target.characters) {
        if (!sourceIds.has(t.id) && !claimed.has(t.id) && !twins.has(t.card)) twins.set(t.card, t.id);
    }
    for (const s of source.characters) {
        if (kept[s.id] || targetIds.has(s.id)) continue;
        const twin = twins.get(s.card);
        if (twin) {
            kept[s.id] = twin;
            claimed.add(twin);
            twins.delete(s.card);
        }
    }

    // Helper: pair unclaimed source & target characters when a key matches 1-to-1 (exactly one candidate each way)
    const pairUniqueByKeys = (keysOf) => {
        const srcByKey = new Map();
        const tgtByKey = new Map();
        for (const s of source.characters) {
            if (kept[s.id] || targetIds.has(s.id)) continue;
            for (const k of keysOf(s)) {
                if (!k) continue;
                if (!srcByKey.has(k)) srcByKey.set(k, []);
                srcByKey.get(k).push(s.id);
            }
        }
        for (const t of target.characters) {
            if (sourceIds.has(t.id) && !kept[t.id]) continue;
            if (claimed.has(t.id)) continue;
            for (const k of keysOf(t)) {
                if (!k) continue;
                if (!tgtByKey.has(k)) tgtByKey.set(k, []);
                tgtByKey.get(k).push(t.id);
            }
        }
        for (const [k, sIds] of srcByKey.entries()) {
            const tIds = tgtByKey.get(k);
            if (sIds.length === 1 && tIds?.length === 1) {
                const sId = sIds[0];
                const tId = tIds[0];
                if (!kept[sId] && !claimed.has(tId)) {
                    kept[sId] = tId;
                    claimed.add(tId);
                }
            }
        }
    };

    // 2. Same provider link (provider_links: same site + remote id) or same char_aliases (e.g. version_uid, avatar_file)
    pairUniqueByKeys(c => Array.isArray(c.providerLinks) ? c.providerLinks : []);
    pairUniqueByKeys(c => Array.isArray(c.charAliases) ? c.charAliases : []);

    // 3. Same (name, creator, createDate) when uniquely matching 1-to-1 each way, and at least one of creator/createDate is non-empty
    pairUniqueByKeys((c) => {
        const nm = nameKey(c);
        if (!nm) return [];
        const cr = String(c.creator || '').trim().toLowerCase();
        const dt = String(c.createDate || '').trim();
        if (!cr && !dt) return [];
        return [`${nm}\u0000${cr}\u0000${dt}`];
    });

    const local = (id) => kept[id] || id;
    return {
        aliases: kept,
        source: {
            characters: source.characters.map(c => (kept[c.id] ? { ...c, id: kept[c.id], sourceId: c.id } : c)),
            chats: source.chats.map(c => (c.charId && kept[c.charId] ? { ...c, charId: local(c.charId) } : c)),
            worlds: source.worlds,
            personas: source.personas || [],
            presets: source.presets || [],
            playlists: (source.playlists || []).map(p => {
                const members = (p.members || []).map(local);
                return { ...p, members };
            }),
            backgrounds: source.backgrounds || [],
            settings: source.settings || [],
            appStore: source.appStore || [],
            unboundStudio: source.unboundStudio || [],
            connections: source.connections || [],
        },
    };
}

/** How much a plan changes, by kind, for a summary line. */
export function planCounts(plan) {
    return {
        charactersNew: plan.characters.create.length,
        charactersChanged: plan.characters.update.length + (plan.unboundStudio?.put || []).length,
        charactersDeleted: plan.characters.delete.length + (plan.unboundStudio?.delete || []).length,
        chatsNew: plan.chats.create.length,
        chatsChanged: plan.chats.update.length,
        chatsDeleted: plan.chats.delete.length,
        lorebooksChanged: plan.worlds.put.length,
        lorebooksDeleted: plan.worlds.delete.length,
        personasNew: (plan.personas?.create || []).length,
        personasChanged: (plan.personas?.update || []).length,
        personasDeleted: (plan.personas?.delete || []).length,
        presetsNew: (plan.presets?.create || []).length,
        presetsChanged: (plan.presets?.update || []).length,
        presetsDeleted: (plan.presets?.delete || []).length,
        playlistsNew: (plan.playlists?.create || []).length,
        playlistsChanged: (plan.playlists?.update || []).length,
        playlistsDeleted: (plan.playlists?.delete || []).length,
        backgroundsNew: (plan.backgrounds?.create || []).length,
        backgroundsChanged: (plan.backgrounds?.update || []).length,
        backgroundsDeleted: (plan.backgrounds?.delete || []).length,
        settingsChanged: (plan.settings?.put || []).length + (plan.appStore?.put || []).length,
        connectionsNew: (plan.connections?.create || []).length,
        connectionsChanged: (plan.connections?.update || []).length,
        connectionsDeleted: (plan.connections?.delete || []).length,
        kept: plan.kept,
    };
}

export const planSize = (plan) => {
    const c = planCounts(plan);
    return c.charactersNew + c.charactersChanged + c.charactersDeleted + c.chatsNew + c.chatsChanged
        + c.chatsDeleted + c.lorebooksChanged + c.lorebooksDeleted
        + c.personasNew + c.personasChanged + c.personasDeleted
        + c.presetsNew + c.presetsChanged + c.presetsDeleted
        + c.playlistsNew + c.playlistsChanged + c.playlistsDeleted
        + c.backgroundsNew + c.backgroundsChanged + c.backgroundsDeleted
        + c.settingsChanged
        + c.connectionsNew + c.connectionsChanged + c.connectionsDeleted;
};
