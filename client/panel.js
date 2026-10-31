// The Sync panel: this device, pairing (show a code, or scan one), the paired devices and what a sync
// carries. Its regions paint on their own, so a status refresh never wipes a field being typed in or the
// camera's picture.
import { qrSvg, startScanner, cameraBlocker } from './qr.js';

const POLL_MS = 1500;

const COUNT_WORDS = [
    ['charactersNew', 'new character', 'new characters'],
    ['charactersChanged', 'changed character', 'changed characters'],
    ['charactersDeleted', 'character to remove', 'characters to remove'],
    ['chatsNew', 'new chat', 'new chats'],
    ['chatsChanged', 'changed chat', 'changed chats'],
    ['chatsDeleted', 'chat to remove', 'chats to remove'],
    ['lorebooksChanged', 'lorebook', 'lorebooks'],
    ['lorebooksDeleted', 'lorebook to remove', 'lorebooks to remove'],
];

export function describeCounts(counts) {
    if (!counts) return '';
    const parts = COUNT_WORDS.filter(([k]) => counts[k]).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
    const kept = counts.kept ? ` (${counts.kept} kept here, newer on this device)` : '';
    return parts.length ? `${parts.join(', ')}${kept}` : `Already in step${kept}`;
}

export function createPanel(ctx) {
    const { CoreAPI } = ctx;
    const esc = (s) => CoreAPI.escapeHtml(String(s ?? ''));
    const call = ctx.server.call;
    const why = (e) => e?.message || String(e);

    let body = null;
    let status = null;
    let offer = null; // { link, expiresAt, warning }
    let requests = [];
    let join = null; // { lines, error, done, abort }
    let scanning = false;
    let stopScan = null;
    let poll = null;
    const checks = new Map(); // peer id -> a dry run's summary line

    const dialog = ctx.ui.dialog({
        id: 'panel',
        label: 'LAN Sync',
        icon: 'fa-arrows-rotate',
        className: 'ls-dialog',
        onClose: () => teardown(),
    });

    const region = (name) => body?.querySelector(`[data-ls-region="${name}"]`);

    function teardown() {
        clearInterval(poll);
        poll = null;
        stopCamera();
        join?.abort?.abort();
        join = null;
        if (offer) call('/pairing/stop', 'POST').catch(() => {});
        offer = null;
        requests = [];
        body = null;
    }

    function stopCamera() {
        stopScan?.();
        stopScan = null;
        scanning = false;
    }

    // ── this device ─────────────────────────────────────────

    function paintDevice() {
        const el = region('device');
        if (!el || !status) return;
        const addresses = status.addresses.length
            ? status.addresses.map(a => `<span class="ls-chip" title="${esc(a.iface)}">${esc(a.address)}${a.kind === 'overlay' ? ' <em>VPN</em>' : ''}</span>`).join('')
            : '<span class="ls-muted">No network address</span>';
        el.querySelector('[data-ls="addresses"]').innerHTML = addresses;
        const warn = el.querySelector('[data-ls="listen-warning"]');
        warn.hidden = !status.loopbackOnly;
    }

    // ── pairing ─────────────────────────────────────────────

    function paintPair() {
        const el = region('pair');
        if (!el) return;
        if (offer) {
            const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
            el.innerHTML = `
                <div class="ls-offer">
                    <div class="ls-qr">${qrSvg(offer.link)}</div>
                    <div class="ls-offer-side">
                        <p class="ls-line">Point the other device's <strong>Camera app</strong> (or Google Lens) at this code and open the link it finds: it opens that device's own Σ with the pairing filled in. Or open LAN Sync there and choose <strong>Scan a Code</strong>.</p>
                        <p class="ls-muted" data-ls="countdown">Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</p>
                        <div class="ls-requests">${requests.length ? requests.map(r => `
                            <div class="ls-request">
                                <p class="ls-line"><strong>${esc(r.name)}</strong> (${esc(r.address)}) wants to pair.</p>
                                <p class="ls-line">Allow it only if it shows <span class="ls-code">${esc(r.code.slice(0, 3))} ${esc(r.code.slice(3))}</span></p>
                                <div class="ls-verbs">
                                    <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="allow" data-id="${esc(r.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i> Allow</button>
                                    <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="deny" data-id="${esc(r.id)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Deny</button>
                                </div>
                            </div>`).join('') : '<p class="ls-muted">Waiting for a device to scan...</p>'}</div>
                        <details class="ls-linkbox">
                            <summary class="ls-muted">No camera? Show the link</summary>
                            <code class="ls-linktext" data-ls="link">${esc(offer.link)}</code>
                        </details>
                        <div class="ls-verbs">
                            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="copy-link"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy Link</button>
                            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="stop-offer">Stop</button>
                        </div>
                    </div>
                </div>`;
            return;
        }
        if (join) {
            const shown = join.lines.map((l) => {
                if (l.step === 'contacting') return `<p class="ls-muted">Reaching ${esc(l.address)}...</p>`;
                if (l.step === 'confirm') return `<p class="ls-line">Check that <strong>${esc(l.name)}</strong> shows <span class="ls-code">${esc(l.code.slice(0, 3))} ${esc(l.code.slice(3))}</span>, then allow it there.</p>`;
                if (l.step === 'paired') return `<p class="ls-line is-success"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Paired with ${esc(l.name)}.</p>`;
                return '';
            }).join('');
            el.innerHTML = `
                <div class="ls-join">
                    ${shown}
                    ${join.error ? `<p class="ls-line is-error">${esc(join.error)}</p>` : ''}
                    <div class="ls-verbs">
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="end-join">${join.done ? 'Done' : 'Cancel'}</button>
                    </div>
                </div>`;
            return;
        }
        if (scanning) {
            const blocker = cameraBlocker();
            el.innerHTML = `
                <div class="ls-scan">
                    <p class="ls-muted">Quickest on a phone: scan the other device's code with your <strong>Camera app</strong> or Google Lens and open the link. It lands here with the pairing filled in.</p>
                    ${blocker ? `<p class="ls-line is-warning">${esc(blocker)}</p>` : '<video class="ls-video" data-ls="video" aria-label="Camera"></video>'}
                    <div class="settings-row">
                        <label class="ls-muted" for="ls-paste">Or paste the pairing link</label>
                        <div class="ls-paste-row">
                            <input id="ls-paste" type="search" autocomplete="off" class="glass-input" data-ls="paste" placeholder="http://localhost:7788/?lan-sync-pair=...">
                            <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="pair-pasted">Pair</button>
                        </div>
                    </div>
                    <div class="ls-verbs"><button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="stop-scan">Cancel</button></div>
                </div>`;
            if (!blocker) {
                startScanner(el.querySelector('[data-ls="video"]'), (text) => { stopScan = null; scanning = false; beginJoin(text); })
                    .then((stop) => { if (scanning) stopScan = stop; else stop(); })
                    .catch((e) => {
                        const v = el.querySelector('[data-ls="video"]');
                        const denied = e?.name === 'NotAllowedError';
                        v?.insertAdjacentHTML('afterend', `<p class="ls-line is-warning">${denied
                            ? 'This page may not use the camera. Use your Camera app as above, allow the camera in this site\'s settings, or paste the link below.'
                            : `The camera did not start (${esc(why(e))}). Use your Camera app as above, or paste the link below.`}</p>`);
                        v?.remove();
                    });
            }
            return;
        }
        el.innerHTML = `
            <p class="ls-line">Pair once, then sync either way. Show a code on one device and scan it with the other.</p>
            <div class="ls-verbs">
                <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="show-code"><i class="fa-solid fa-qrcode" aria-hidden="true"></i> Show a Pairing Code</button>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="scan"><i class="fa-solid fa-camera" aria-hidden="true"></i> Scan a Code</button>
            </div>`;
    }

    async function beginJoin(link) {
        stopCamera();
        const abort = new AbortController();
        join = { lines: [], error: null, done: false, abort };
        paintPair();
        try {
            for await (const line of ctx.server.stream('/pairing/join', 'POST', { link }, { signal: abort.signal })) {
                if (join?.abort !== abort) return;
                if (line.error) join.error = line.error;
                else join.lines.push(line);
                paintPair();
            }
        } catch (e) {
            if (e?.name === 'AbortError' || join?.abort !== abort) return;
            join.error = why(e);
        }
        if (join?.abort !== abort) return;
        join.done = true;
        paintPair();
        if (join.lines.some(l => l.step === 'paired')) refresh();
    }

    // ── paired devices ──────────────────────────────────────

    function jobFor(peerId) {
        const mine = (status?.jobs || []).filter(j => j.key === `pull-${peerId}`);
        return mine.find(j => j.status === 'running' || j.status === 'queued') || mine.at(-1) || null;
    }

    function paintPeers() {
        const el = region('peers');
        if (!el || !status) return;
        if (!status.peers.length) {
            el.innerHTML = '<p class="ls-muted">No paired devices yet.</p>';
            return;
        }
        el.innerHTML = status.peers.map((p) => {
            const job = jobFor(p.id);
            const busy = job && (job.status === 'running' || job.status === 'queued');
            let state = '';
            if (busy) {
                const pr = job.progress;
                const pct = pr?.total ? ` ${Math.round((pr.done / pr.total) * 100)}%` : '';
                state = `<p class="ls-line"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${esc(pr?.note || (job.status === 'queued' ? 'Waiting to start' : 'Syncing'))}${pct}</p>`;
            } else if (job?.status === 'failed') {
                state = `<p class="ls-line is-error">${esc(job.error || 'The last sync failed')}</p>`;
            }
            const last = p.lastSync
                ? `Last synced from it ${esc(CoreAPI.formatRelativeAge ? CoreAPI.formatRelativeAge(p.lastSync.at) : new Date(p.lastSync.at).toLocaleString())}: ${esc(describeCounts(p.lastSync.counts))}`
                : 'Not synced yet';
            return `
                <div class="ls-peer" data-peer="${esc(p.id)}">
                    <div class="ls-peer-head">
                        <i class="fa-solid ${/phone|android|pixel|galaxy|iphone/i.test(p.name) ? 'fa-mobile-screen' : 'fa-display'}" aria-hidden="true"></i>
                        <div class="ls-peer-name">
                            <strong>${esc(p.name)}</strong>
                            <button type="button" class="ls-link" data-ls-act="edit-address" data-id="${esc(p.id)}" title="Change its address">${esc(p.address)}</button>
                        </div>
                    </div>
                    <p class="ls-muted">${last}</p>
                    ${checks.has(p.id) ? `<p class="ls-line">${esc(checks.get(p.id))}</p>` : ''}
                    ${state}
                    <div class="ls-verbs">
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="pull" data-id="${esc(p.id)}"${busy ? ' disabled' : ''}><i class="fa-solid fa-download" aria-hidden="true"></i> Sync From It</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="push" data-id="${esc(p.id)}"><i class="fa-solid fa-upload" aria-hidden="true"></i> Send to It</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="check" data-id="${esc(p.id)}"${busy ? ' disabled' : ''}><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Check</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary ls-danger" data-ls-act="remove" data-id="${esc(p.id)}" title="Unpair"><i class="fa-solid fa-link-slash" aria-hidden="true"></i></button>
                    </div>
                </div>`;
        }).join('');
    }

    // ── what a sync carries ─────────────────────────────────

    function paintOptions() {
        const el = region('options');
        if (!el) return;
        const on = (k) => (ctx.settings.get(k) !== false ? ' checked' : '');
        const sel = (k, v) => (ctx.settings.get(k) === v ? ' selected' : '');
        const toggle = (key, text) => `
            <div class="settings-row">
                <label><input type="checkbox" class="cl-switch-input" data-ls-set="${key}"${on(key)}><span class="cl-switch" aria-hidden="true"></span><span>${text}</span></label>
            </div>`;
        el.innerHTML = `
            <div class="ls-checks">
                ${toggle('syncCharacters', 'Characters (cards, pictures, tags, galleries)')}
                ${toggle('syncChats', 'Chats (messages, notes and unsent drafts)')}
                ${toggle('syncLorebooks', 'Lorebooks')}
            </div>
            <div class="settings-row">
                <label for="ls-mode">Sync mode</label>
                <select id="ls-mode" class="cl-select-fluid" data-ls-set="mode">
                    <option value="incremental"${sel('mode', 'incremental')}>Incremental: bring in what is new or changed</option>
                    <option value="mirror"${sel('mode', 'mirror')}>Mirror: also remove what the other device no longer has</option>
                </select>
            </div>
            <div class="settings-row">
                <label for="ls-overwrite">When both changed</label>
                <select id="ls-overwrite" class="cl-select-fluid" data-ls-set="overwrite">
                    <option value="exact"${sel('overwrite', 'exact')}>Exact: the device synced from wins</option>
                    <option value="prefer-newer"${sel('overwrite', 'prefer-newer')}>Prefer newer: keep this device's newer edits</option>
                </select>
                <span class="settings-hint">Prefer newer compares each device's own clock.</span>
            </div>`;
        // the app draws its own dropdowns over native selects; it does so for its own markup, so ours ask
        el.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    }

    // ── refresh and the clicks ──────────────────────────────

    async function refresh() {
        if (!body) return;
        try {
            status = await call('/status');
        } catch (e) {
            const el = region('peers');
            // a server half loads at boot, so a fresh install answers nothing until the server restarts
            const message = e?.status === 404
                ? 'LAN Sync is installed, but its server part starts only when Σ does. Restart Σ, then open this again.'
                : why(e);
            if (el) el.innerHTML = `<p class="ls-line ${e?.status === 404 ? 'is-warning' : 'is-error'}">${esc(message)}</p>`;
            return;
        }
        paintDevice();
        paintPeers();
    }

    async function tick() {
        if (!body) return;
        if (offer) {
            if (offer.expiresAt <= Date.now()) {
                offer = null;
                requests = [];
                CoreAPI.showToast('The pairing code expired', 'info');
                paintPair();
            } else {
                try {
                    const next = (await call('/pairing/requests')).requests;
                    if (JSON.stringify(next) !== JSON.stringify(requests)) { requests = next; paintPair(); } else {
                        const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
                        const cd = region('pair')?.querySelector('[data-ls="countdown"]');
                        if (cd) cd.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
                    }
                } catch { /* the next tick asks again */ }
            }
        }
        const busy = (status?.jobs || []).some(j => j.status === 'running' || j.status === 'queued');
        if (busy) await refresh();
    }

    async function act(button) {
        const what = button.dataset.lsAct;
        const id = button.dataset.id;
        const peer = status?.peers.find(p => p.id === id);
        try {
            switch (what) {
                case 'show-code': {
                    stopCamera();
                    offer = await call('/pairing/start', 'POST');
                    requests = [];
                    paintPair();
                    break;
                }
                case 'stop-offer':
                    offer = null;
                    requests = [];
                    paintPair();
                    await call('/pairing/stop', 'POST');
                    break;
                case 'copy-link':
                    await navigator.clipboard.writeText(offer.link);
                    CoreAPI.showToast('Pairing link copied', 'success');
                    break;
                case 'allow':
                case 'deny': {
                    const answer = await call(`/pairing/requests/${encodeURIComponent(id)}`, 'POST', { allow: what === 'allow' });
                    if (answer.status === 'approved') {
                        const name = requests.find(r => r.id === id)?.name || 'the device';
                        offer = null;
                        requests = [];
                        CoreAPI.showToast(`Paired with ${name}`, 'success');
                        await refresh();
                    } else {
                        requests = requests.filter(r => r.id !== id);
                    }
                    paintPair();
                    break;
                }
                case 'scan':
                    if (offer) { offer = null; call('/pairing/stop', 'POST').catch(() => {}); }
                    scanning = true;
                    paintPair();
                    break;
                case 'stop-scan':
                    stopCamera();
                    paintPair();
                    break;
                case 'pair-pasted': {
                    const text = region('pair')?.querySelector('[data-ls="paste"]')?.value || '';
                    if (!text.trim()) return;
                    beginJoin(text.trim());
                    break;
                }
                case 'end-join':
                    join?.abort?.abort();
                    join = null;
                    paintPair();
                    break;
                case 'pull': {
                    checks.delete(id);
                    await call(`/peers/${encodeURIComponent(id)}/pull`, 'POST', {});
                    await refresh();
                    break;
                }
                case 'push': {
                    await call(`/peers/${encodeURIComponent(id)}/push`, 'POST', {});
                    CoreAPI.showToast(`${peer?.name || 'The device'} is syncing from this one`, 'success');
                    break;
                }
                case 'check': {
                    button.disabled = true;
                    checks.set(id, 'Comparing...');
                    paintPeers();
                    try {
                        const { counts } = await call(`/peers/${encodeURIComponent(id)}/pull`, 'POST', { dryRun: true });
                        checks.set(id, `Syncing from it would bring: ${describeCounts(counts)}`);
                    } catch (e) {
                        checks.set(id, `Could not compare: ${why(e)}`);
                    }
                    paintPeers();
                    break;
                }
                case 'edit-address': {
                    const address = await CoreAPI.showConfirm({
                        title: `Address of ${peer?.name || 'the device'}`,
                        message: 'Its network address and port, such as 192.168.1.20:7788. Pairing and each sync it sends keep this up to date.',
                        input: { value: peer?.address || '', placeholder: '192.168.1.20:7788' },
                        confirmLabel: 'Save',
                    });
                    if (typeof address !== 'string') return;
                    await call(`/peers/${encodeURIComponent(id)}`, 'PATCH', { address });
                    await refresh();
                    break;
                }
                case 'remove': {
                    const ok = await CoreAPI.showConfirm({
                        title: `Unpair ${peer?.name || 'this device'}?`,
                        message: 'Nothing in either library changes. To sync again, pair again.',
                        confirmLabel: 'Unpair',
                        danger: true,
                    });
                    if (!ok) return;
                    await call(`/peers/${encodeURIComponent(id)}`, 'DELETE');
                    checks.delete(id);
                    await refresh();
                    break;
                }
                default:
            }
        } catch (e) {
            CoreAPI.showToast(why(e), 'error');
        }
    }

    async function setOption(input) {
        const key = input.dataset.lsSet;
        const value = input.type === 'checkbox' ? input.checked : input.value;
        if (key === 'mode' && value === 'mirror') {
            const ok = await CoreAPI.showConfirm({
                title: 'Sync in Mirror mode?',
                message: 'A sync into this device will also delete the characters, chats and lorebooks the other device does not have. Use it when one device is the master copy.',
                confirmLabel: 'Use Mirror',
                danger: true,
            });
            if (!ok) { input.value = ctx.settings.get('mode'); return; }
        }
        ctx.settings.set(key, value);
    }

    return {
        async open({ joinLink = null } = {}) {
            body = dialog.open({ title: 'LAN Sync' });
            body.innerHTML = `
                <div class="ls-panel">
                    <section class="ls-section" data-ls-region="device">
                        <h3 class="ls-heading">This Device</h3>
                        <div class="settings-row">
                            <label for="ls-name">Name it shows other devices</label>
                            <input id="ls-name" type="search" autocomplete="off" maxlength="60" class="glass-input" data-ls-set="deviceName" value="${esc(ctx.settings.get('deviceName'))}" placeholder="This computer's name">
                        </div>
                        <div class="ls-chips" data-ls="addresses"></div>
                        <p class="ls-line is-warning" data-ls="listen-warning" hidden>This Σ only listens on this machine. Set host to 0.0.0.0 in data/server.yaml and restart it so a phone can reach it.</p>
                    </section>
                    <section class="ls-section">
                        <h3 class="ls-heading">Pair a Device</h3>
                        <div data-ls-region="pair"></div>
                    </section>
                    <section class="ls-section">
                        <h3 class="ls-heading">Paired Devices</h3>
                        <div class="ls-peers" data-ls-region="peers"><p class="ls-muted">Reading...</p></div>
                    </section>
                    <section class="ls-section">
                        <h3 class="ls-heading">What a Sync Carries</h3>
                        <div data-ls-region="options"></div>
                        <p class="ls-muted">Each device's connections, presets, personas and settings stay its own. A chat's own pictures do not travel yet.</p>
                    </section>
                </div>`;
            body.addEventListener('click', (ev) => {
                const button = ev.target.closest('[data-ls-act]');
                if (button && body.contains(button)) act(button);
            });
            body.addEventListener('change', (ev) => {
                const input = ev.target.closest('[data-ls-set]');
                if (input) setOption(input);
            });
            body.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' && ev.target.matches('[data-ls="paste"]')) act({ dataset: { lsAct: 'pair-pasted' } });
            });
            paintPair();
            paintOptions();
            clearInterval(poll);
            poll = setInterval(tick, POLL_MS);
            await refresh();
            if (joinLink) beginJoin(joinLink);
        },

        renderSettings(el) {
            el.innerHTML = `
                <div class="settings-row">
                    <span class="settings-hint">Pair this Σ with another (a phone and a desktop, say) and sync characters, chats and lorebooks between them. Also in the More Options menu.</span>
                </div>
                <div><button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-open><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Open LAN Sync</button></div>`;
            el.querySelector('[data-ls-open]').addEventListener('click', () => this.open());
        },
    };
}
