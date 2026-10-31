// The Sync panel (modeled after TauriTavern's SyncMainView):
//   - Top status overview + active pairing requests banner (works for both QR and direct LAN pairing)
//   - Devices in the golden zone: unpaired nearby devices (one-click Pair) + paired devices (with Online badge,
//     platform icons, click-to-rename, Download / Upload / Check), plus "Connect manually" (ip:port) & Refresh
//   - Collapsible "QR code or pairing link" fold (with native phone camera snapshot that bypasses Android getUserMedia)
//   - Collapsible "Sync preferences & Auto sync" fold
import { qrSvg, startScanner, cameraBlocker, cameraPermission, decodeQrFromImage } from './qr.js';

const POLL_MS = 1500;
const AUTO_INTERVALS = [
    [5, 'Every 5 minutes'],
    [15, 'Every 15 minutes'],
    [30, 'Every 30 minutes'],
    [60, 'Every hour'],
    [180, 'Every 3 hours'],
    [360, 'Every 6 hours'],
    [720, 'Every 12 hours'],
    [1440, 'Every 24 hours'],
];

const COUNT_WORDS = [
    ['charactersNew', 'new character', 'new characters'],
    ['charactersChanged', 'changed character', 'changed characters'],
    ['charactersDeleted', 'character to remove', 'characters to remove'],
    ['chatsNew', 'new chat', 'new chats'],
    ['chatsChanged', 'changed chat', 'changed chats'],
    ['chatsDeleted', 'chat to remove', 'chats to remove'],
    ['lorebooksChanged', 'lorebook', 'lorebooks'],
    ['lorebooksDeleted', 'lorebook to remove', 'lorebooks to remove'],
    ['personasNew', 'new persona', 'new personas'],
    ['personasChanged', 'changed persona', 'changed personas'],
    ['personasDeleted', 'persona to remove', 'personas to remove'],
    ['presetsNew', 'new preset', 'new presets'],
    ['presetsChanged', 'changed preset', 'changed presets'],
    ['presetsDeleted', 'preset to remove', 'presets to remove'],
    ['playlistsNew', 'new playlist', 'new playlists'],
    ['playlistsChanged', 'changed playlist', 'changed playlists'],
    ['playlistsDeleted', 'playlist to remove', 'playlists to remove'],
    ['backgroundsNew', 'new background', 'new backgrounds'],
    ['backgroundsChanged', 'changed background', 'changed backgrounds'],
    ['backgroundsDeleted', 'background to remove', 'backgrounds to remove'],
    ['connectionsNew', 'new connection', 'new connections'],
    ['connectionsChanged', 'changed connection', 'changed connections'],
    ['connectionsDeleted', 'connection to remove', 'connections to remove'],
];

const PLATFORM_ICONS = {
    windows: { icon: 'fa-brands fa-windows', label: 'Windows' },
    macos: { icon: 'fa-brands fa-apple', label: 'macOS' },
    ios: { icon: 'fa-brands fa-app-store-ios', label: 'iOS' },
    android: { icon: 'fa-brands fa-android', label: 'Android' },
    linux: { icon: 'fa-brands fa-linux', label: 'Linux' },
};

function platformIconHtml(platform, name = '') {
    const p = String(platform || '').toLowerCase();
    if (PLATFORM_ICONS[p]) {
        return `<i class="${PLATFORM_ICONS[p].icon} ls-platform-icon" title="${PLATFORM_ICONS[p].label}" aria-hidden="true"></i>`;
    }
    const mobile = /phone|android|pixel|galaxy|iphone/i.test(name);
    return `<i class="fa-solid ${mobile ? 'fa-mobile-screen' : 'fa-display'} ls-platform-icon" aria-hidden="true"></i>`;
}

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

    // ── overview & incoming pairing requests banner ─────────

    function paintDevice() {
        const el = region('device');
        if (!el || !status) return;
        const primary = status.addresses?.[0]?.address || `127.0.0.1:${status.port || 7788}`;
        const pillEl = el.querySelector('[data-ls="primary-address"]');
        if (pillEl) pillEl.textContent = primary;
        const addresses = status.addresses.length
            ? status.addresses.map(a => `<span class="ls-chip" title="${esc(a.iface)}">${esc(a.address)}${a.kind === 'overlay' ? ' <em>VPN</em>' : ''}</span>`).join('')
            : '<span class="ls-muted">No network address</span>';
        el.querySelector('[data-ls="addresses"]').innerHTML = addresses;
        const warn = el.querySelector('[data-ls="listen-warning"]');
        warn.hidden = !status.loopbackOnly;
    }

    function paintRequests() {
        const el = region('requests');
        if (!el) return;
        const active = requests.length ? requests : (status?.requests || []);
        if (!active.length && !join) {
            el.innerHTML = '';
            el.hidden = true;
            return;
        }
        el.hidden = false;
        const reqHtml = active.map(r => `
            <div class="ls-request">
                <p class="ls-line">${platformIconHtml(r.platform, r.name)} <strong>${esc(r.name)}</strong> (${esc(r.address)}) wants to pair.</p>
                <p class="ls-line">Confirm both screens show <span class="ls-code">${esc(r.code.slice(0, 3))} ${esc(r.code.slice(3))}</span></p>
                <div class="ls-verbs">
                    <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="allow" data-id="${esc(r.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i> Allow</button>
                    <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="deny" data-id="${esc(r.id)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Deny</button>
                </div>
            </div>`).join('');

        let joinHtml = '';
        if (join) {
            const shown = join.lines.map((l) => {
                if (l.step === 'contacting') return `<p class="ls-muted"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Connecting to ${esc(l.name)}...</p>`;
                if (l.step === 'reached') return `<p class="ls-muted">Found it at ${esc(l.address)}.</p>`;
                if (l.step === 'confirm') return `<p class="ls-line">Check that <strong>${esc(l.name)}</strong> shows <span class="ls-code">${esc(l.code.slice(0, 3))} ${esc(l.code.slice(3))}</span>, then click <strong>Allow</strong> on that device.</p>`;
                if (l.step === 'paired') return `<p class="ls-line is-success"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${l.updatedAddress ? `Updated address for ${esc(l.name)}.` : `Paired with ${esc(l.name)}.`}</p>`;
                return '';
            }).join('');
            joinHtml = `
                <div class="ls-request">
                    ${shown}
                    ${join.error ? `<p class="ls-line is-error">${esc(join.error)}</p>` : ''}
                    <div class="ls-verbs">
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="end-join">${join.done ? 'Done' : 'Cancel'}</button>
                    </div>
                </div>`;
        }
        el.innerHTML = reqHtml + joinHtml;
    }

    // ── devices (nearby unpaired + paired targets, TauriTavern style) ──

    function jobFor(peerId) {
        const mine = (status?.jobs || []).filter(j => j.key === `pull-${peerId}`);
        return mine.find(j => j.status === 'running' || j.status === 'queued') || mine.at(-1) || null;
    }

    function paintPeers() {
        const el = region('peers');
        if (!el || !status) return;
        const nearby = status.nearby || [];
        const peers = [...(status.peers || [])].sort((a, b) => (b.lastSync?.at || 0) - (a.lastSync?.at || 0));

        if (!nearby.length && !peers.length) {
            el.innerHTML = `
                <div class="ls-empty">
                    <p class="ls-line">No devices yet.</p>
                    <p class="ls-muted">Open LAN Sync on your other device and click <strong>Refresh</strong> to find it automatically on your Wi-Fi, or click <strong>Connect manually</strong> to enter its IP address.</p>
                </div>`;
            return;
        }

        const nearbyCards = nearby.map(d => `
            <div class="ls-peer is-nearby" data-nearby="${esc(d.id)}">
                <div class="ls-peer-head">
                    ${platformIconHtml(d.platform, d.name)}
                    <div class="ls-peer-name">
                        <div class="ls-peer-title-row">
                            <strong>${esc(d.name)}</strong>
                            <span class="ls-pill is-new">Nearby</span>
                        </div>
                        <span class="ls-muted ls-mono">${esc(d.address)}</span>
                    </div>
                    <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="pair-nearby" data-id="${esc(d.id)}" data-address="${esc(d.address)}">
                        <i class="fa-solid fa-link" aria-hidden="true"></i> Pair
                    </button>
                </div>
            </div>`).join('');

        const pairedCards = peers.map((p) => {
            const job = jobFor(p.id);
            const busy = job && (job.status === 'running' || job.status === 'queued');
            const displayName = p.customName || p.name;
            let state = '';
            if (busy) {
                const pr = job.progress;
                const pct = pr?.total ? ` ${Math.round((pr.done / pr.total) * 100)}%` : '';
                state = `<p class="ls-line"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${esc(pr?.note || (job.status === 'queued' ? 'Waiting to start' : 'Syncing'))}${pct}</p>`;
            } else if (job?.status === 'failed') {
                state = `<p class="ls-line is-error">${esc(job.error || 'The last sync failed')}</p>`;
            }
            const last = p.lastSync
                ? `Last synced ${esc(CoreAPI.formatRelativeAge ? CoreAPI.formatRelativeAge(p.lastSync.at) : new Date(p.lastSync.at).toLocaleString())}: ${esc(describeCounts(p.lastSync.counts))}`
                : 'Not synced yet';
            return `
                <div class="ls-peer" data-peer="${esc(p.id)}">
                    <div class="ls-peer-head">
                        ${platformIconHtml(p.platform, displayName)}
                        <div class="ls-peer-name">
                            <div class="ls-peer-title-row">
                                <button type="button" class="ls-name-btn" data-ls-act="rename-peer" data-id="${esc(p.id)}" title="Click to rename">
                                    <strong>${esc(displayName)}</strong>
                                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
                                </button>
                                ${p.online ? '<span class="ls-pill is-online">Online</span>' : ''}
                            </div>
                            <button type="button" class="ls-link" data-ls-act="edit-address" data-id="${esc(p.id)}" title="Change its address">${esc(p.address)}</button>
                        </div>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary ls-danger ls-peer-remove" data-ls-act="remove" data-id="${esc(p.id)}" title="Unpair" aria-label="Unpair ${esc(displayName)}"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                    </div>
                    <p class="ls-muted">${last}</p>
                    ${checks.has(p.id) ? `<p class="ls-line">${esc(checks.get(p.id))}</p>` : ''}
                    ${state}
                    <div class="ls-verbs">
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="pull" data-id="${esc(p.id)}"${busy ? ' disabled' : ''}><i class="fa-solid fa-download" aria-hidden="true"></i> Download</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="push" data-id="${esc(p.id)}"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="check" data-id="${esc(p.id)}"${busy ? ' disabled' : ''}><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Check</button>
                    </div>
                </div>`;
        }).join('');

        el.innerHTML = nearbyCards + pairedCards;
    }

    // ── QR code & pairing link fold ─────────────────────────

    function paintPair() {
        const el = region('pair');
        if (!el) return;
        if (offer) {
            const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
            el.innerHTML = `
                <div class="ls-offer">
                    <div class="ls-qr">${qrSvg(offer.link)}</div>
                    <div class="ls-offer-side">
                        <p class="ls-line">Point the other device's <strong>Camera app</strong> at this code, or open LAN Sync there and use <strong>Take a Photo of Code</strong>.</p>
                        <p class="ls-muted" data-ls="countdown">Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</p>
                        <details class="ls-linkbox">
                            <summary class="ls-muted">Show pairing link</summary>
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
        if (scanning) {
            const blocker = cameraBlocker();
            el.innerHTML = `
                <div class="ls-scan">
                    <p class="ls-muted">On Android / mobile, tap <strong>Take a Photo of Code</strong> (opens your native camera directly without browser permission popups) or <strong>Scan Image</strong>.</p>
                    <div class="ls-verbs">
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="snap-qr"><i class="fa-solid fa-camera" aria-hidden="true"></i> Take a Photo of Code</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="pick-qr"><i class="fa-solid fa-image" aria-hidden="true"></i> Scan Image</button>
                        <input type="file" accept="image/*" capture="environment" data-ls="qr-camera" hidden>
                        <input type="file" accept="image/*" data-ls="qr-file" hidden>
                    </div>
                    ${blocker ? `<p class="ls-line is-warning">${esc(blocker)}</p>` : '<video class="ls-video" data-ls="video" aria-label="Camera"></video>'}
                    <div class="ls-verbs"><button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="stop-scan">Close Camera</button></div>
                </div>`;
            bindQrFileInputs(el);
            if (!blocker) {
                const video = el.querySelector('[data-ls="video"]');
                const instead = (html) => {
                    video?.insertAdjacentHTML('afterend', `<p class="ls-line is-warning">${html}</p>`);
                    video?.remove();
                };
                const blocked = 'Live camera preview is blocked in this browser mode. Tap <strong>Take a Photo of Code</strong> above to use your camera directly.';
                cameraPermission().then((state) => {
                    if (!scanning || !video?.isConnected) return;
                    if (state === 'denied') { instead(blocked); return; }
                    startScanner(video, (text) => { stopScan = null; scanning = false; beginJoin(text); })
                        .then((stop) => { if (scanning) stopScan = stop; else stop(); })
                        .catch((e) => instead(e?.name === 'NotAllowedError'
                            ? blocked
                            : `The live camera did not start (${esc(why(e))}). Tap <strong>Take a Photo of Code</strong> above.`));
                });
            }
            return;
        }
        el.innerHTML = `
            <div class="ls-verbs">
                <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="show-code"><i class="fa-solid fa-qrcode" aria-hidden="true"></i> Show QR Code</button>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="snap-qr"><i class="fa-solid fa-camera" aria-hidden="true"></i> Take a Photo of Code</button>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="pick-qr"><i class="fa-solid fa-image" aria-hidden="true"></i> Scan Image</button>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="scan"><i class="fa-solid fa-video" aria-hidden="true"></i> Live Camera</button>
                <input type="file" accept="image/*" capture="environment" data-ls="qr-camera" hidden>
                <input type="file" accept="image/*" data-ls="qr-file" hidden>
            </div>
            <div class="settings-row">
                <label class="ls-muted" for="ls-paste">Or paste a pairing link</label>
                <div class="ls-paste-row">
                    <input id="ls-paste" type="search" autocomplete="off" class="glass-input" data-ls="paste" placeholder="http://localhost:7788/library.html?lan-sync-pair=...">
                    <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-act="pair-pasted">Pair</button>
                </div>
            </div>`;
        bindQrFileInputs(el);
    }

    function bindQrFileInputs(container) {
        for (const input of container.querySelectorAll('input[type="file"]')) {
            input.addEventListener('change', async () => {
                const file = input.files?.[0];
                input.value = '';
                if (!file) return;
                try {
                    const text = await decodeQrFromImage(file);
                    if (!text) {
                        CoreAPI.showToast('No QR code found in that picture. Try getting closer or keeping it flat.', 'warning');
                        return;
                    }
                    beginJoin(text);
                } catch (e) {
                    CoreAPI.showToast(`Could not read that picture: ${why(e)}`, 'error');
                }
            });
        }
    }

    async function runJoinStream(endpoint, payload) {
        stopCamera();
        const abort = new AbortController();
        join = { lines: [], error: null, done: false, abort };
        paintRequests();
        try {
            for await (const line of ctx.server.stream(endpoint, 'POST', payload, { signal: abort.signal })) {
                if (join?.abort !== abort) return;
                if (line.error) join.error = line.error;
                else join.lines.push(line);
                paintRequests();
            }
        } catch (e) {
            if (e?.name === 'AbortError' || join?.abort !== abort) return;
            join.error = why(e);
        }
        if (join?.abort !== abort) return;
        join.done = true;
        paintRequests();
        if (join.lines.some(l => l.step === 'paired')) {
            await refresh();
        }
    }

    function beginJoin(link) {
        return runJoinStream('/pairing/join', { link });
    }

    function beginDirectJoin(payload) {
        return runJoinStream('/pairing/direct', payload);
    }

    // ── preferences & auto-sync fold ────────────────────────

    function optionsSummaryText() {
        const mode = ctx.settings.get('mode') === 'mirror' ? 'Mirror' : 'Incremental';
        const overwrite = ctx.settings.get('overwrite') === 'prefer-newer' ? 'Prefer newer' : 'Exact';
        const autoOn = status?.automation?.config?.enabled;
        return `${mode} · ${overwrite} · Auto sync: ${autoOn ? 'On' : 'Off'}`;
    }

    function paintOptions() {
        const sumEl = body?.querySelector('[data-ls="prefs-summary"]');
        if (sumEl) sumEl.textContent = optionsSummaryText();

        const el = region('options');
        if (!el) return;
        const on = (k) => (ctx.settings.get(k) !== false ? ' checked' : '');
        const onExplicit = (k) => (ctx.settings.get(k) === true ? ' checked' : '');
        const sel = (k, v) => (ctx.settings.get(k) === v ? ' selected' : '');
        const toggle = (key, text, explicit = false) => `
            <div class="settings-row">
                <label><input type="checkbox" class="cl-switch-input" data-ls-set="${key}"${explicit ? onExplicit(key) : on(key)}><span class="cl-switch" aria-hidden="true"></span><span>${text}</span></label>
            </div>`;

        const autoCfg = status?.automation?.config || { enabled: false, intervalMinutes: 30, targetId: '' };
        const autoSt = status?.automation?.status || {};
        const peers = status?.peers || [];
        let autoStatusLine = 'Scheduled auto-upload while Project Σ is running.';
        if (autoSt.lastError) {
            autoStatusLine = `Last auto-sync failed: ${autoSt.lastError}`;
        } else if (autoSt.lastAcceptedAtMs) {
            const age = CoreAPI.formatRelativeAge ? CoreAPI.formatRelativeAge(autoSt.lastAcceptedAtMs) : new Date(autoSt.lastAcceptedAtMs).toLocaleTimeString();
            autoStatusLine = `Last auto-sync request accepted ${age}.`;
        }

        el.innerHTML = `
            <div class="settings-row">
                <label for="ls-name">Device name shown on LAN</label>
                <input id="ls-name" type="search" autocomplete="off" maxlength="60" class="glass-input" data-ls-set="deviceName" value="${esc(ctx.settings.get('deviceName'))}" placeholder="${esc(status?.device?.name || 'This device')}">
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
                    <option value="exact"${sel('overwrite', 'exact')}>Initiator wins (Exact)</option>
                    <option value="prefer-newer"${sel('overwrite', 'prefer-newer')}>Newer copy wins (Prefer newer)</option>
                </select>
            </div>
            <div class="ls-subhead">Datasets to Sync</div>
            <div class="ls-checks">
                ${toggle('syncCharacters', 'Characters (cards, pictures, tags, galleries)')}
                ${toggle('syncChats', 'Chats (messages, attachments, notes and unsent drafts)')}
                ${toggle('syncLorebooks', 'Lorebooks (worlds and global bindings)')}
                ${toggle('syncPersonas', 'Personas (names, descriptions, pronouns, pictures, lorebooks)')}
                ${toggle('syncPresets', 'Prompt presets (blocks and ordering)')}
                ${toggle('syncPlaylists', 'Playlists (folders and character memberships)')}
                ${toggle('syncBackgrounds', 'Backgrounds (chat wallpapers and bindings)')}
                ${toggle('syncConnections', 'Connections (LLM profiles and API keys — opt-in)', true)}
            </div>
            <div class="ls-auto-box">
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-ls-auto="enabled"${autoCfg.enabled ? ' checked' : ''}>
                        <span class="cl-switch" aria-hidden="true"></span>
                        <span><strong>Auto sync</strong> (scheduled upload while running)</span>
                    </label>
                </div>
                <div class="ls-auto-grid">
                    <div class="settings-row">
                        <label for="ls-auto-interval">Interval</label>
                        <select id="ls-auto-interval" class="cl-select-fluid" data-ls-auto="intervalMinutes">
                            ${AUTO_INTERVALS.map(([m, label]) => `<option value="${m}"${Number(autoCfg.intervalMinutes) === m ? ' selected' : ''}>${esc(label)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="settings-row">
                        <label for="ls-auto-target">Target device</label>
                        <select id="ls-auto-target" class="cl-select-fluid" data-ls-auto="targetId">
                            <option value="">Choose paired device...</option>
                            ${peers.map(p => `<option value="${esc(p.id)}"${autoCfg.targetId === p.id ? ' selected' : ''}>${esc(p.customName || p.name)} (${esc(p.address)})</option>`).join('')}
                        </select>
                    </div>
                </div>
                <p class="ls-muted" data-ls="auto-status">${esc(autoStatusLine)}</p>
            </div>`;
        el.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    }

    // ── refresh and clicks ──────────────────────────────────

    async function refresh() {
        if (!body) return;
        try {
            status = await call('/status');
            requests = status.requests || [];
        } catch (e) {
            const el = region('peers');
            const message = e?.status === 404
                ? 'LAN Sync is installed, but its server part starts only when Σ does. Restart Σ, then open this again.'
                : why(e);
            if (el) el.innerHTML = `<p class="ls-line ${e?.status === 404 ? 'is-warning' : 'is-error'}">${esc(message)}</p>`;
            return;
        }
        paintDevice();
        paintRequests();
        paintPeers();
        const sumEl = body?.querySelector('[data-ls="prefs-summary"]');
        if (sumEl) sumEl.textContent = optionsSummaryText();
    }

    async function tick() {
        if (!body) return;
        if (offer && offer.expiresAt <= Date.now()) {
            offer = null;
            CoreAPI.showToast('The pairing code expired', 'info');
            paintPair();
        } else if (offer) {
            const left = Math.max(0, Math.round((offer.expiresAt - Date.now()) / 1000));
            const cd = region('pair')?.querySelector('[data-ls="countdown"]');
            if (cd) cd.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        }
        try {
            const nextStatus = await call('/status');
            const prevReqs = JSON.stringify(requests);
            const nextReqs = JSON.stringify(nextStatus.requests || []);
            const prevNearby = JSON.stringify(status?.nearby || []);
            const nextNearby = JSON.stringify(nextStatus.nearby || []);
            const busy = (status?.jobs || []).some(j => j.status === 'running' || j.status === 'queued')
                || (nextStatus.jobs || []).some(j => j.status === 'running' || j.status === 'queued');
            status = nextStatus;
            requests = nextStatus.requests || [];
            if (prevReqs !== nextReqs) paintRequests();
            if (prevNearby !== nextNearby || busy) {
                paintDevice();
                paintPeers();
            }
        } catch { /* next tick retries */ }
    }

    async function act(button) {
        const what = button.dataset.lsAct;
        const id = button.dataset.id;
        const peer = status?.peers.find(p => p.id === id);
        try {
            switch (what) {
                case 'refresh-nearby': {
                    button.disabled = true;
                    try {
                        await call('/discovery/refresh', 'POST', {});
                        await new Promise(r => setTimeout(r, 350));
                        await refresh();
                        paintOptions();
                    } finally {
                        button.disabled = false;
                    }
                    break;
                }
                case 'connect-manual': {
                    const address = await CoreAPI.showConfirm({
                        title: 'Connect manually',
                        message: 'Enter the other device\'s LAN IP address and port (for example 192.168.1.20:7788). No camera or QR code needed.',
                        input: { value: '', placeholder: '192.168.1.20:7788' },
                        confirmLabel: 'Connect',
                    });
                    if (typeof address !== 'string' || !address.trim()) return;
                    beginDirectJoin({ address: address.trim() });
                    break;
                }
                case 'pair-nearby': {
                    const address = button.dataset.address || '';
                    beginDirectJoin({ deviceId: id, address });
                    break;
                }
                case 'rename-peer': {
                    const current = peer?.customName || peer?.name || '';
                    const customName = await CoreAPI.showConfirm({
                        title: `Rename ${peer?.name || 'device'}`,
                        message: 'Set a local nickname for this device (leave blank to use its own name).',
                        input: { value: current, placeholder: peer?.name || 'My Phone' },
                        confirmLabel: 'Save',
                    });
                    if (typeof customName !== 'string') return;
                    await call(`/peers/${encodeURIComponent(id)}`, 'PATCH', { customName });
                    await refresh();
                    paintOptions();
                    break;
                }
                case 'show-code': {
                    stopCamera();
                    offer = await call('/pairing/start', 'POST');
                    paintPair();
                    break;
                }
                case 'stop-offer':
                    offer = null;
                    paintPair();
                    await call('/pairing/stop', 'POST');
                    break;
                case 'copy-link':
                    await navigator.clipboard.writeText(offer.link);
                    CoreAPI.showToast('Pairing link copied', 'success');
                    break;
                case 'allow':
                case 'deny': {
                    const reqItem = requests.find(r => r.id === id);
                    const answer = await call(`/pairing/requests/${encodeURIComponent(id)}`, 'POST', { allow: what === 'allow' });
                    if (answer.status === 'approved') {
                        const name = reqItem?.name || 'the device';
                        offer = null;
                        requests = requests.filter(r => r.id !== id);
                        CoreAPI.showToast(`Paired with ${name}`, 'success');
                        await refresh();
                        paintOptions();
                    } else {
                        requests = requests.filter(r => r.id !== id);
                    }
                    paintRequests();
                    paintPair();
                    break;
                }
                case 'scan':
                    if (offer) { offer = null; call('/pairing/stop', 'POST').catch(() => {}); }
                    scanning = true;
                    paintPair();
                    break;
                case 'snap-qr':
                    region('pair')?.querySelector('[data-ls="qr-camera"]')?.click();
                    break;
                case 'pick-qr':
                    region('pair')?.querySelector('[data-ls="qr-file"]')?.click();
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
                    paintRequests();
                    break;
                case 'pull': {
                    checks.delete(id);
                    await call(`/peers/${encodeURIComponent(id)}/pull`, 'POST', {});
                    await refresh();
                    break;
                }
                case 'push': {
                    await call(`/peers/${encodeURIComponent(id)}/push`, 'POST', {});
                    CoreAPI.showToast(`${peer?.customName || peer?.name || 'The device'} is syncing from this one`, 'success');
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
                        title: `Address of ${peer?.customName || peer?.name || 'the device'}`,
                        message: 'Its network address and port, such as 192.168.1.20:7788. LAN discovery and each sync keep this up to date automatically.',
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
                        title: `Unpair ${peer?.customName || peer?.name || 'this device'}?`,
                        message: 'Nothing in either library changes. To sync again, pair again.',
                        confirmLabel: 'Unpair',
                        danger: true,
                    });
                    if (!ok) return;
                    await call(`/peers/${encodeURIComponent(id)}`, 'DELETE');
                    checks.delete(id);
                    await refresh();
                    paintOptions();
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
        const sumEl = body?.querySelector('[data-ls="prefs-summary"]');
        if (sumEl) sumEl.textContent = optionsSummaryText();
    }

    async function setAutoOption(input) {
        const key = input.dataset.lsAuto;
        const value = input.type === 'checkbox' ? input.checked : input.value;
        try {
            const patch = { [key]: key === 'intervalMinutes' ? Number(value) : value };
            if (key === 'enabled' && value === true) {
                const targetSelect = region('options')?.querySelector('[data-ls-auto="targetId"]');
                const targetId = targetSelect?.value || status?.automation?.config?.targetId || status?.peers?.[0]?.id || '';
                if (!targetId) {
                    input.checked = false;
                    CoreAPI.showToast('Pair or select a target device first to enable Auto sync', 'warning');
                    return;
                }
                patch.targetId = targetId;
            }
            const res = await call('/automation', 'PATCH', patch);
            if (status) status.automation = res;
            paintOptions();
        } catch (e) {
            CoreAPI.showToast(why(e), 'error');
        }
    }

    return {
        async open({ joinLink = null } = {}) {
            body = dialog.open({ title: 'LAN Sync' });
            body.innerHTML = `
                <div class="ls-panel">
                    <section class="ls-section ls-overview" data-ls-region="device">
                        <div class="ls-overview-line">
                            <span class="ls-pill is-online"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Ready</span>
                            <code class="ls-mono" data-ls="primary-address">...</code>
                            <details class="ls-addr-details">
                                <summary class="ls-muted">All addresses</summary>
                                <div class="ls-chips" data-ls="addresses"></div>
                            </details>
                        </div>
                        <p class="ls-line is-warning" data-ls="listen-warning" hidden>This Σ only listens on this machine. Set host to 0.0.0.0 in data/server.yaml and restart it so a phone can reach it.</p>
                    </section>

                    <div data-ls-region="requests" class="ls-requests-banner" hidden></div>

                    <section class="ls-section">
                        <div class="ls-section-head">
                            <h3 class="ls-heading">Devices</h3>
                            <div class="ls-verbs">
                                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="connect-manual"><i class="fa-solid fa-link" aria-hidden="true"></i> Connect manually</button>
                                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ls-act="refresh-nearby" title="Refresh nearby devices"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Refresh</button>
                            </div>
                        </div>
                        <div class="ls-peers" data-ls-region="peers"><p class="ls-muted">Searching for devices...</p></div>
                    </section>

                    <details class="ls-section ls-fold"${joinLink ? ' open' : ''}>
                        <summary class="ls-fold-summary">
                            <span class="ls-heading">QR Code or Pairing Link</span>
                            <i class="fa-solid fa-chevron-down ls-fold-chevron" aria-hidden="true"></i>
                        </summary>
                        <div class="ls-fold-body" data-ls-region="pair"></div>
                    </details>

                    <details class="ls-section ls-fold">
                        <summary class="ls-fold-summary">
                            <span class="ls-heading">Sync Preferences &amp; Auto Sync</span>
                            <span class="ls-muted ls-fold-meta" data-ls="prefs-summary"></span>
                            <i class="fa-solid fa-chevron-down ls-fold-chevron" aria-hidden="true"></i>
                        </summary>
                        <div class="ls-fold-body" data-ls-region="options"></div>
                    </details>
                </div>`;
            body.addEventListener('click', (ev) => {
                const button = ev.target.closest('[data-ls-act]');
                if (button && body.contains(button)) act(button);
            });
            body.addEventListener('change', (ev) => {
                const input = ev.target.closest('[data-ls-set]');
                if (input) { setOption(input); return; }
                const autoInput = ev.target.closest('[data-ls-auto]');
                if (autoInput) setAutoOption(autoInput);
            });
            body.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' && ev.target.matches('[data-ls="paste"]')) act({ dataset: { lsAct: 'pair-pasted' } });
            });
            paintPair();
            clearInterval(poll);
            poll = setInterval(tick, POLL_MS);
            await refresh();
            paintOptions();
            if (joinLink) beginJoin(joinLink);
        },

        renderSettings(el) {
            el.innerHTML = `
                <div class="settings-row">
                    <span class="settings-hint">Pair this Σ with another (a phone and a desktop, say) via automatic LAN discovery, manual IP, or QR code, and sync characters, chats and lorebooks between them. Also in the More Options menu.</span>
                </div>
                <div><button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-ls-open><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Open LAN Sync</button></div>`;
            el.querySelector('[data-ls-open]').addEventListener('click', () => this.open());
        },
    };
}
