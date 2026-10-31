// The pairing link a QR code carries, one grammar for both halves (the server imports ../client/pair-link.js).
// The link opens the scanning device's own Σ at localhost, so a phone's camera app hands it straight to the
// phone's install; the in-app scanner and the paste box read the same link.

export const PAIR_PARAM = 'lan-sync-pair';
const VERSION = 1;

function toBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * The link for a pairing offer.
 * @param {{id: string, name: string, addresses: string[], code: string, expiresAt: number, key: string}} offer
 *   addresses are host:port pairs the other device may reach; key is the offering device's X25519 public key (base64url)
 * @param {number} port the port the scanning device's own Σ most likely listens on
 */
export function buildPairLink(offer, port = 7788) {
    const payload = {
        v: VERSION,
        id: offer.id,
        n: offer.name,
        a: offer.addresses,
        c: offer.code,
        e: offer.expiresAt,
        k: offer.key,
    };
    const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    return `http://localhost:${port}/?${PAIR_PARAM}=${encoded}`;
}

/**
 * Read a pairing link (or the bare payload after its parameter); null when the text is not one.
 * @returns {{id: string, name: string, addresses: string[], code: string, expiresAt: number, key: string}|null}
 */
export function parsePairLink(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    let encoded = raw;
    const at = raw.indexOf(`${PAIR_PARAM}=`);
    if (at >= 0) encoded = raw.slice(at + PAIR_PARAM.length + 1).split(/[&#\s]/)[0];
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    let p;
    try {
        p = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
    } catch {
        return null;
    }
    if (!p || p.v !== VERSION) return null;
    const addresses = Array.isArray(p.a) ? p.a.filter(a => typeof a === 'string' && /^[^\s/]+:\d{1,5}$/.test(a)) : [];
    if (typeof p.id !== 'string' || typeof p.c !== 'string' || typeof p.k !== 'string' || !addresses.length) return null;
    return {
        id: p.id,
        name: typeof p.n === 'string' && p.n.trim() ? p.n.trim().slice(0, 60) : 'Project Σ',
        addresses,
        code: p.c,
        expiresAt: Number(p.e) || 0,
        key: p.k,
    };
}
