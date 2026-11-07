import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mergeDuplicateCharacter } from '../server/sync.js';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const sigmaDir = [
    process.env.SIGMA_DIR,
    path.resolve(here, '../../../../ProjectSigma-main'),
    path.resolve(here, '../../../../../ProjectSigma-main'),
    'D:/ProjectSigma-main',
].filter(Boolean).find(d => fs.existsSync(path.join(d, 'package.json')));
const require = createRequire(path.join(sigmaDir, 'package.json'));
const Database = require('better-sqlite3');

test('duplicate merge only moves enabled extension tables explicitly opted in to LAN sync', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-merge-opt-in-'));
    const previous = process.env.CL_EXTENSIONS_DIR;
    const db = new Database(':memory:');
    try {
        process.env.CL_EXTENSIONS_DIR = root;
        for (const id of ['audit-opt-in', 'audit-disabled']) {
            fs.mkdirSync(path.join(root, id));
            fs.writeFileSync(path.join(root, id, 'manifest.json'), JSON.stringify({ id, lanSync: { tables: [`x_${id.replaceAll('-', '_')}_state`] } }));
        }
        db.exec(`
            CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE characters(id TEXT PRIMARY KEY, chat_count INTEGER, last_chat_at INTEGER);
            INSERT INTO characters VALUES ('from', 0, NULL), ('into', 0, NULL);
            CREATE TABLE chats(id TEXT, char_id TEXT, sort_at INTEGER);
            CREATE TABLE media(id INTEGER, char_id TEXT, file TEXT);
            CREATE TABLE char_tags(char_id TEXT, tag_id TEXT, pos INTEGER);
            CREATE TABLE char_worlds(char_id TEXT, world_name TEXT, pos INTEGER);
            CREATE TABLE provider_links(char_id TEXT, provider_id TEXT);
            CREATE TABLE playlist_chars(char_id TEXT, playlist_id TEXT, pos INTEGER);
            CREATE TABLE background_bindings(char_id TEXT);
        `);
        db.prepare('INSERT INTO settings VALUES (?, ?)').run('enabledExtensions', JSON.stringify(['audit-opt-in']));
        for (const table of ['x_audit_opt_in_state', 'x_audit_opt_in_private', 'x_audit_disabled_state', 'x_unrelated_state']) {
            db.exec(`CREATE TABLE ${table}(char_id TEXT PRIMARY KEY, value TEXT); INSERT INTO ${table} VALUES ('from', 'keep');`);
        }
        db.pragma('foreign_keys = ON');
        db.exec(`CREATE TABLE x_cascade_unopted(char_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE, note TEXT); INSERT INTO x_cascade_unopted VALUES ('from', 'cascade-lost');`);
        mergeDuplicateCharacter(db, {}, null, { fromId: 'from', intoId: 'into' });
        assert.equal(db.prepare('SELECT char_id FROM x_audit_opt_in_state').get().char_id, 'into');
        assert.equal(db.prepare('SELECT * FROM x_cascade_unopted').get(), undefined, 'unopted ON DELETE CASCADE table row is deleted with the duplicate');
        for (const table of ['x_audit_opt_in_private', 'x_audit_disabled_state', 'x_unrelated_state']) {
            assert.equal(db.prepare(`SELECT char_id FROM ${table}`).get().char_id, 'from', table);
        }
    } finally {
        db.close();
        if (previous === undefined) delete process.env.CL_EXTENSIONS_DIR; else process.env.CL_EXTENSIONS_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
