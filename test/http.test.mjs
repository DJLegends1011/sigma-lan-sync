import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { firstReachable } from '../server/http.js';

function fakeSigma(name = 'project-sigma') {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/health' ? { ok: true, name } : {}));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('a dead address listed first does not hold up the one that answers', async () => {
    const sigma = await fakeSigma();
    const good = `127.0.0.1:${sigma.address().port}`;
    // 10.255.255.1 is unroutable here: a sequential try would wait out its whole timeout
    const started = Date.now();
    const found = await firstReachable(['10.255.255.1:7788', good], { timeout: 3000 });
    sigma.close();
    assert.equal(found, good);
    assert.ok(Date.now() - started < 1500, `answered in ${Date.now() - started}ms`);
});

test('a server that is not Project Σ is passed over, and none answering is null', async () => {
    const other = await fakeSigma('something-else');
    const found = await firstReachable([`127.0.0.1:${other.address().port}`], { timeout: 1000 });
    other.close();
    assert.equal(found, null);
});
