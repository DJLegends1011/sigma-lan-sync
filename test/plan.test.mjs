import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, alignSource, planCounts } from '../server/plan.js';
import { isAllowedSettingKey } from '../server/manifest.js';
import { buildPairLink, parsePairLink } from '../client/pair-link.js';

const all = ['characters', 'chats', 'lorebooks', 'personas', 'presets', 'playlists'];
const char = (id, o = {}) => ({ id, card: `c-${id}`, meta: `m-${id}`, mediaCount: 0, updatedAt: 1, ...o });
const chat = (id, charId, name, o = {}) => ({ id, charId, name, digest: `d-${id}`, updatedAt: 1, ...o });

test('a character the target lacks is created, and its chats ride its bundle', () => {
    const source = { characters: [char('a')], chats: [chat('x', 'a', 'Chat 1')], worlds: [] };
    const target = { characters: [], chats: [], worlds: [] };
    const plan = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.deepEqual(plan.characters.create, ['a']);
    assert.deepEqual(plan.chats.create, []);
});

test('equal digests plan nothing', () => {
    const lib = { characters: [char('a')], chats: [chat('x', 'a', 'Chat 1')], worlds: [{ name: 'W', digest: 'w' }] };
    const plan = makePlan(lib, structuredClone(lib), { datasets: all, mode: 'mirror', overwrite: 'exact' });
    assert.deepEqual(Object.values(planCounts(plan)).reduce((a, b) => a + b, 0), 0);
});

test('chats match by character and name, not by id', () => {
    const source = { characters: [char('a')], chats: [chat('src-1', 'a', 'Chat 1', { digest: 'new' })], worlds: [] };
    const target = { characters: [char('a')], chats: [chat('tgt-9', 'a', 'Chat 1', { digest: 'old' })], worlds: [] };
    const plan = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.deepEqual(plan.chats.update, [{ id: 'src-1', targetId: 'tgt-9', charId: 'a', name: 'Chat 1' }]);
});

test('prefer-newer keeps a target copy whose own time is newer', () => {
    const source = { characters: [char('a', { card: 'x', updatedAt: 5 })], chats: [chat('s', 'a', 'C', { digest: 'x', updatedAt: 5 })], worlds: [] };
    const target = { characters: [char('a', { card: 'y', updatedAt: 9 })], chats: [chat('t', 'a', 'C', { digest: 'y', updatedAt: 9 })], worlds: [] };
    const newer = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'prefer-newer' });
    assert.equal(newer.characters.update.length, 0);
    assert.equal(newer.chats.update.length, 0);
    assert.equal(newer.kept, 2);
    const exact = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.equal(exact.characters.update.length, 1);
    assert.equal(exact.chats.update.length, 1);
});

test('incremental never deletes; mirror deletes what the source lacks', () => {
    const source = { characters: [char('a')], chats: [], worlds: [] };
    const target = { characters: [char('a'), char('b')], chats: [chat('t', 'a', 'Only here'), chat('u', 'b', 'Of b')], worlds: [{ name: 'Old', digest: 'o' }] };
    const inc = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.equal(inc.characters.delete.length + inc.chats.delete.length + inc.worlds.delete.length, 0);
    const mirror = makePlan(source, target, { datasets: all, mode: 'mirror', overwrite: 'exact' });
    assert.deepEqual(mirror.characters.delete, ['b']);
    // the chat of b goes with b; the chat of a that the source lacks goes on its own
    assert.deepEqual(mirror.chats.delete, ['t']);
    assert.deepEqual(mirror.worlds.delete, ['Old']);
});

test('a dataset left out is left alone', () => {
    const source = { characters: [char('a', { card: 'new' })], chats: [], worlds: [{ name: 'W', digest: 'x' }] };
    const target = { characters: [char('a')], chats: [], worlds: [] };
    const plan = makePlan(source, target, { datasets: ['lorebooks'], mode: 'mirror', overwrite: 'exact' });
    assert.equal(plan.characters.update.length, 0);
    assert.deepEqual(plan.worlds.put, ['W']);
});

test('the same card imported apart on both devices is one character, not a new one', () => {
    const source = { characters: [char('src-echo', { card: 'same' })], chats: [chat('c1', 'src-echo', 'Echo chat')], worlds: [] };
    const target = { characters: [char('tgt-echo', { card: 'same' })], chats: [], worlds: [] };
    const { aliases, source: aligned } = alignSource(source, target, {});
    assert.deepEqual(aliases, { 'src-echo': 'tgt-echo' });
    const plan = makePlan(aligned, target, { datasets: all, mode: 'mirror', overwrite: 'exact' });
    assert.deepEqual(plan.characters.create, []);
    assert.deepEqual(plan.characters.delete, []);
    // its chat lands on this library's copy
    assert.deepEqual(plan.chats.create, [{ id: 'c1', charId: 'tgt-echo', name: 'Echo chat' }]);
});

test('an alias updates by the source id, and a stale one is dropped', () => {
    const source = { characters: [char('s1', { card: 'v2', meta: 'm' })], chats: [], worlds: [] };
    const target = { characters: [char('t1', { card: 'v1', meta: 'm' })], chats: [], worlds: [] };
    const { source: aligned } = alignSource(source, target, { s1: 't1' });
    const plan = makePlan(aligned, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.deepEqual(plan.characters.update, [{ id: 't1', sourceId: 's1', card: true, meta: false, media: false }]);
    const gone = alignSource(source, { characters: [], chats: [], worlds: [] }, { s1: 't1' });
    assert.deepEqual(gone.aliases, {});
});

test('a pairing link round-trips, and junk is refused', () => {
    const offer = { id: 'dev1', name: 'Desk', addresses: ['192.168.1.20:7788'], code: 'abc', expiresAt: 123, key: 'k'.repeat(43) };
    const link = buildPairLink(offer, 7788);
    // the page, not the root, whose redirect drops the query
    assert.match(link, /^http:\/\/localhost:7788\/library\.html\?lan-sync-pair=/);
    assert.deepEqual(parsePairLink(link), offer);
    assert.deepEqual(parsePairLink(`scanned: ${link}`), offer);
    assert.equal(parsePairLink('https://example.com'), null);
    assert.equal(parsePairLink(''), null);
});

test('personas, presets and playlists match by id or name, translate member aliases, and respect prefer-newer and mirror', () => {
    const source = {
        characters: [char('s-char', { card: 'same' })],
        chats: [],
        worlds: [],
        personas: [{ id: 'p-src', name: 'Capt', digest: 'p2', updatedAt: 10 }],
        presets: [{ id: 'pr-src', name: 'Story', digest: 'pr2', updatedAt: 2 }],
        playlists: [{ id: 'pl-src', name: 'Sci-Fi', digest: 'pl2', updatedAt: 10, members: ['s-char'] }],
    };
    const target = {
        characters: [char('t-char', { card: 'same' })],
        chats: [],
        worlds: [],
        personas: [{ id: 'p-tgt', name: 'capt', digest: 'p1', updatedAt: 5 }, { id: 'p-old', name: 'OldPersona', digest: 'po', updatedAt: 1 }],
        presets: [{ id: 'pr-tgt', name: 'Story', digest: 'pr1', updatedAt: 9 }],
        playlists: [],
    };
    const { source: aligned } = alignSource(source, target, {});
    assert.deepEqual(aligned.playlists[0].members, ['t-char']);

    const plan = makePlan(aligned, target, { datasets: all, mode: 'mirror', overwrite: 'prefer-newer' });
    assert.deepEqual(plan.personas.update, [{ id: 'p-src', targetId: 'p-tgt', name: 'Capt' }]);
    assert.deepEqual(plan.personas.delete, ['p-old']);
    // preset on target is newer (9 > 2) -> kept
    assert.equal(plan.presets.update.length, 0);
    assert.equal(plan.kept, 1);
    assert.deepEqual(plan.playlists.create, [{ id: 'pl-src', name: 'Sci-Fi', members: ['t-char'] }]);
});

test('alignSource does not pair unrelated cards that only share a name when creator and createDate are empty, and pairs by providerLinks or non-empty creator', () => {
    const source1 = { characters: [char('s1', { name: 'Alice', card: 'c1', creator: '', createDate: '' })], chats: [], worlds: [] };
    const target1 = { characters: [char('t1', { name: 'Alice', card: 'c2', creator: '', createDate: '' })], chats: [], worlds: [] };
    assert.deepEqual(alignSource(source1, target1, {}).aliases, {}, 'name-only with empty creator/createDate is not paired');

    const source2 = { characters: [char('s1', { name: 'Alice', card: 'c1', creator: 'wisperrr', createDate: '' })], chats: [], worlds: [] };
    const target2 = { characters: [char('t1', { name: 'Alice', card: 'c2', creator: 'wisperrr', createDate: '' })], chats: [], worlds: [] };
    assert.deepEqual(alignSource(source2, target2, {}).aliases, { s1: 't1' }, 'unique name + non-empty creator pairs');

    const source3 = { characters: [char('s1', { name: 'Alice', card: 'c1', providerLinks: ['chub:123'] })], chats: [], worlds: [] };
    const target3 = { characters: [char('t1', { name: 'Alice', card: 'c2', providerLinks: ['chub:123'] })], chats: [], worlds: [] };
    assert.deepEqual(alignSource(source3, target3, {}).aliases, { s1: 't1' }, 'unique providerLink pairs');

    const source4 = { characters: [char('s1', { name: 'Alice', card: 'c1', charAliases: ['version_uid:uid-42'] })], chats: [], worlds: [] };
    const target4 = { characters: [char('t1', { name: 'AliceRenamed', card: 'c2', charAliases: ['version_uid:uid-42'] })], chats: [], worlds: [] };
    assert.deepEqual(alignSource(source4, target4, {}).aliases, { s1: 't1' }, 'unique charAliases pairs even when name and digest differ');
});

test('personas do not match by name when two personas share the same name on either side', () => {
    const source = {
        characters: [], chats: [], worlds: [],
        personas: [{ id: 'p-src', name: 'Alex', digest: 'd1', updatedAt: 10 }],
    };
    const target = {
        characters: [], chats: [], worlds: [],
        personas: [
            { id: 'p-t1', name: 'Alex', digest: 'd2', updatedAt: 5 },
            { id: 'p-t2', name: 'alex', digest: 'd3', updatedAt: 6 },
        ],
    };
    const plan = makePlan(source, target, { datasets: all, mode: 'incremental', overwrite: 'exact' });
    assert.equal(plan.personas.update.length, 0);
    assert.deepEqual(plan.personas.create, [{ id: 'p-src', name: 'Alex' }]);
});

test('isAllowedSettingKey gates ext:<id>:<secret> behind includeSecrets, app_store is gated on settings dataset only, and prefer-newer skips differing existing settings', () => {
    assert.equal(isAllowedSettingKey('ext:evolutia:window', { includeSecrets: false }), true);
    assert.equal(isAllowedSettingKey('ext:evolutia:apiKey', { includeSecrets: false }), false);
    assert.equal(isAllowedSettingKey('ext:evolutia:apiKey', { includeSecrets: true }), true);
    assert.equal(isAllowedSettingKey('ext:some-ext:accessToken', { includeSecrets: false }), false);
    assert.equal(isAllowedSettingKey('ext:some-ext:password', { includeSecrets: false }), false);
    assert.equal(isAllowedSettingKey('ext:some-ext:password', { includeSecrets: true }), true);

    const source = {
        characters: [], chats: [], worlds: [],
        appStore: [{ key: 'assistant-prompts', digest: 'd-new', updatedAt: 20 }],
        settings: [
            { key: 'assistantSystemPrompt', digest: 's-new' },
            { key: 'allowRichTagline', digest: 's-added' },
        ],
    };
    const target = {
        characters: [], chats: [], worlds: [],
        appStore: [{ key: 'assistant-prompts', digest: 'd-old', updatedAt: 10 }],
        settings: [
            { key: 'assistantSystemPrompt', digest: 's-local-tweak' },
        ],
    };

    // With settings dataset OFF (only chats + characters on), appStore is not planned
    const withoutSettings = makePlan(source, target, { datasets: ['characters', 'chats'], mode: 'incremental', overwrite: 'exact' });
    assert.deepEqual(withoutSettings.appStore.put, []);
    assert.deepEqual(withoutSettings.settings.put, []);

    // With settings dataset ON and prefer-newer, differing existing settings are kept while missing settings and newer appStore docs are put
    const preferNewerPlan = makePlan(source, target, { datasets: ['settings'], mode: 'incremental', overwrite: 'prefer-newer' });
    assert.deepEqual(preferNewerPlan.appStore.put, ['assistant-prompts']);
    assert.deepEqual(preferNewerPlan.settings.put, ['allowRichTagline']);
    assert.equal(preferNewerPlan.kept, 1);
});

test('makePlan does not count target-only assistant/studio sessions in incremental mode or uninstalled enabledExtensions when merge would not change target', () => {
    const source = {
        characters: [],
        chats: [{
            id: 'chat-alexa',
            charId: 'char-alexa',
            name: 'Alexa - 1',
            updatedAt: 100,
            asstUpdatedAt: 0,
            baseDigest: 'b1',
            asstDigest: '',
            asstSessions: [],
            digest: 'b1',
        }],
        worlds: [],
        settings: [{
            key: 'enabledExtensions',
            digest: 'src-ext-digest',
            extensions: ['sigma-pwa', 'lan-sync', 'evolutia'],
        }],
    };
    const target = {
        characters: [{ id: 'char-alexa', name: 'Alexa', card: 'c1', meta: 'm1', mediaCount: 0, mediaSig: '', updatedAt: 100 }],
        chats: [{
            id: 'chat-alexa',
            charId: 'char-alexa',
            name: 'Alexa - 1',
            updatedAt: 100,
            asstUpdatedAt: 200,
            baseDigest: 'b1',
            asstDigest: 'asst-target-only',
            asstSessions: [{ id: 'asst-1', updatedAt: 200, profileId: null, baseDigest: 'a1', digest: 'a1' }],
            digest: 'b1|asst-target-only',
        }],
        worlds: [],
        installedExtensions: ['lan-sync', 'evolutia', 'triviumdb'],
        settings: [{
            key: 'enabledExtensions',
            digest: 'tgt-ext-digest',
            extensions: ['lan-sync', 'triviumdb', 'evolutia'],
        }],
    };

    const incPlan = makePlan(source, target, { datasets: ['characters', 'chats', 'settings'], mode: 'incremental', overwrite: 'exact' });
    assert.deepEqual(incPlan.chats.update, [], 'target-only assistant session is not counted as a change in incremental mode');
    assert.deepEqual(incPlan.settings.put, [], 'uninstalled remote extension + local-only target extension is not counted when merged list matches target');

    const mirrorPlan = makePlan(source, target, { datasets: ['characters', 'chats', 'settings'], mode: 'mirror', overwrite: 'exact' });
    assert.equal(mirrorPlan.chats.update.length, 1, 'in mirror mode, target-only assistant session will be removed so it is counted');
    assert.equal(mirrorPlan.settings.put.includes('enabledExtensions'), true, 'in mirror mode, local-only extension triviumdb will be removed so it is counted');
});
