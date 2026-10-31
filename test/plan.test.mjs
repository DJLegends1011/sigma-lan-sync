import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, planCounts, alignSource } from '../server/plan.js';
import { buildPairLink, parsePairLink } from '../client/pair-link.js';

const all = ['characters', 'chats', 'lorebooks'];
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
    assert.match(link, /^http:\/\/localhost:7788\/\?lan-sync-pair=/);
    assert.deepEqual(parsePairLink(link), offer);
    assert.deepEqual(parsePairLink(`scanned: ${link}`), offer);
    assert.equal(parsePairLink('https://example.com'), null);
    assert.equal(parsePairLink(''), null);
});
