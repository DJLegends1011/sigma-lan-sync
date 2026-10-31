// The plan a pull runs: what the source holds that this library lacks or holds differently, and (in Mirror)
// what this library holds that the source does not. Pure, so it is tested on its own.
//
// Overwrite policy, as TauriTavern names it: "exact" lets the source win every difference; "prefer-newer"
// keeps a target item whose own time is strictly newer (characters and chats carry one; a lorebook does not,
// so it follows the source either way).

export const chatKey = (c) => `${c.charId}\u0000${c.name}`;

/**
 * @param {{characters: object[], chats: object[], worlds: object[]}} source the device pulled from
 * @param {{characters: object[], chats: object[], worlds: object[]}} target this library
 * @param {{datasets: string[], mode: 'incremental'|'mirror', overwrite: 'exact'|'prefer-newer'}} opts
 */
export function makePlan(source, target, { datasets, mode, overwrite }) {
    const want = new Set(datasets);
    const mirror = mode === 'mirror';
    const preferNewer = overwrite === 'prefer-newer';
    const plan = {
        characters: { create: [], update: [], delete: [] },
        chats: { create: [], update: [], delete: [] },
        worlds: { put: [], delete: [] },
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
            const meta = s.meta !== t.meta;
            const media = s.mediaCount > t.mediaCount;
            if (!card && !meta && !media) continue;
            if (card && preferNewer && t.updatedAt > s.updatedAt) {
                plan.kept++;
                if (!meta && !media) continue;
                plan.characters.update.push({ id: s.id, sourceId, card: false, meta, media });
                continue;
            }
            plan.characters.update.push({ id: s.id, sourceId, card, meta, media });
        }
        if (mirror) plan.characters.delete = target.characters.filter(t => !sourceChars.has(t.id)).map(t => t.id);
    }

    if (want.has('chats')) {
        // a character the pull creates brings its chats inside its bundle
        const arriving = new Set(plan.characters.create);
        const present = (charId) => targetChars.has(charId) || (want.has('characters') && arriving.has(charId));
        const targetChats = new Map(target.chats.map(c => [chatKey(c), c]));
        const sourceKeys = new Set(source.chats.map(chatKey));
        for (const s of source.chats) {
            if (arriving.has(s.charId) || !present(s.charId)) continue;
            const t = targetChats.get(chatKey(s));
            if (!t) { plan.chats.create.push({ id: s.id, charId: s.charId, name: s.name }); continue; }
            if (t.digest === s.digest) continue;
            if (preferNewer && t.updatedAt > s.updatedAt) { plan.kept++; continue; }
            plan.chats.update.push({ id: s.id, targetId: t.id, charId: s.charId, name: s.name });
        }
        if (mirror) {
            // a chat of a character the source lacks goes with that character, when characters sync at all
            plan.chats.delete = target.chats
                .filter(t => !sourceKeys.has(chatKey(t)) && sourceChars.has(t.charId))
                .map(t => t.id);
        }
    }

    if (want.has('lorebooks')) {
        const targetWorlds = new Map(target.worlds.map(w => [w.name, w]));
        const sourceNames = new Set(source.worlds.map(w => w.name));
        for (const s of source.worlds) {
            if (targetWorlds.get(s.name)?.digest !== s.digest) plan.worlds.put.push(s.name);
        }
        if (mirror) plan.worlds.delete = target.worlds.filter(t => !sourceNames.has(t.name)).map(t => t.name);
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
    const twins = new Map();
    for (const t of target.characters) {
        if (!sourceIds.has(t.id) && !claimed.has(t.id) && !twins.has(t.card)) twins.set(t.card, t.id);
    }
    for (const s of source.characters) {
        if (kept[s.id] || targetIds.has(s.id)) continue;
        const twin = twins.get(s.card);
        if (twin) { kept[s.id] = twin; twins.delete(s.card); }
    }
    const local = (id) => kept[id] || id;
    return {
        aliases: kept,
        source: {
            characters: source.characters.map(c => (kept[c.id] ? { ...c, id: kept[c.id], sourceId: c.id } : c)),
            chats: source.chats.map(c => (kept[c.charId] ? { ...c, charId: local(c.charId) } : c)),
            worlds: source.worlds,
        },
    };
}

/** How much a plan changes, by kind, for a summary line. */
export function planCounts(plan) {
    return {
        charactersNew: plan.characters.create.length,
        charactersChanged: plan.characters.update.length,
        charactersDeleted: plan.characters.delete.length,
        chatsNew: plan.chats.create.length,
        chatsChanged: plan.chats.update.length,
        chatsDeleted: plan.chats.delete.length,
        lorebooksChanged: plan.worlds.put.length,
        lorebooksDeleted: plan.worlds.delete.length,
        kept: plan.kept,
    };
}

export const planSize = (plan) => {
    const c = planCounts(plan);
    return c.charactersNew + c.charactersChanged + c.charactersDeleted + c.chatsNew + c.chatsChanged
        + c.chatsDeleted + c.lorebooksChanged + c.lorebooksDeleted;
};
