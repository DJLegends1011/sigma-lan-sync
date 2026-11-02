// One device of the two-device test: a real Project Σ server (the extension kit's) in a process of its own,
// since the kit runs one server a process. The parent drives it over IPC and over HTTP.
process.env.CL_LAN_SYNC_NO_DISCOVERY = '1';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sigmaDir = process.env.SIGMA_DIR || 'D:/ProjectSigma-main';
const { startSigma } = await import(pathToFileURL(path.join(sigmaDir, 'tools', 'extension-kit', 'index.mjs')).href);

const extDir = fileURLToPath(new URL('../..', import.meta.url));
const evolutiaDir = path.resolve(extDir, '..', 'evolutia');
const extensions = fs.existsSync(path.join(evolutiaDir, 'manifest.json')) ? [extDir, evolutiaDir] : [extDir];
const sigma = await startSigma({ extensions, prefix: `lan-sync-${process.argv[2] || 'device'}` });
const enabled = await sigma.session.enable('lan-sync');
if (enabled.status !== 200) throw new Error(`could not switch lan-sync on: ${JSON.stringify(enabled.body)}`);
if (extensions.length > 1) {
    const evoEnabled = await sigma.session.enable('evolutia');
    if (evoEnabled.status !== 200) throw new Error(`could not switch evolutia on: ${JSON.stringify(evoEnabled.body)}`);
}

process.on('message', async ({ id, op, args = [] }) => {
    try {
        let result;
        if (op === 'importCard') result = await sigma.session.importCard(...args);
        else if (op === 'close') { sigma.close(); process.send({ id, ok: true }); process.exit(0); }
        else throw new Error(`unknown op ${op}`);
        process.send({ id, ok: true, result });
    } catch (e) {
        process.send({ id, ok: false, error: e.message });
    }
});
process.send({ ready: true, base: sigma.base });
