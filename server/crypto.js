// Pairing and request signing. Σ serves plain HTTP, so the pairing never sends its secret: both devices
// derive it from an X25519 exchange whose offering key the QR code pins, and both screens show a short code
// derived from both keys so the person approving can see no one stood in between.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (text) => Buffer.from(String(text), 'base64url');

export const randomId = (bytes = 16) => b64u(crypto.randomBytes(bytes));
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** JSON with every object's keys in order, so the same content always digests the same. */
export function canon(value) {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/** An X25519 key pair: the private KeyObject and the raw public key as base64url. */
export function keyPair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const raw = publicKey.export({ format: 'jwk' }).x;
    return { privateKey, publicKey: raw };
}

function publicKeyOf(raw) {
    if (unb64u(raw).length !== 32) throw new Error('a pairing key is 32 bytes');
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

/**
 * The pair's shared secret: X25519 of one side's private key and the other's public key, stretched with HKDF
 * over the pairing code and both device ids (offering device first), so both sides arrive at the same 32 bytes.
 */
export function deriveSecret(privateKey, peerPublicRaw, { code, offerId, joinId }) {
    const shared = crypto.diffieHellman({ privateKey, publicKey: publicKeyOf(peerPublicRaw) });
    const info = Buffer.from(`sigma-lan-sync v1|${offerId}|${joinId}`);
    return b64u(Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(code), info, 32)));
}

/** Six digits both screens show while pairing: the same only when both saw the same two keys. */
export function shortCode(offerKey, joinKey, code) {
    const digest = crypto.createHash('sha256').update(`${offerKey}|${joinKey}|${code}`).digest();
    const n = digest.readUInt32BE(0) % 1_000_000;
    return String(n).padStart(6, '0');
}

export function hmac(secret, text) {
    return b64u(crypto.createHmac('sha256', unb64u(secret)).update(text).digest());
}

export function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// what a signed request commits to: its method, its path with query, its time and its body
const signedText = (method, path, time, bodyText) => `${method.toUpperCase()}\n${path}\n${time}\n${sha256(bodyText || '')}`;

/** The headers a request to a paired device carries. */
export function signHeaders({ deviceId, secret }, method, path, bodyText) {
    const time = String(Date.now());
    return {
        'x-lan-sync-device': deviceId,
        'x-lan-sync-time': time,
        'x-lan-sync-sig': hmac(secret, signedText(method, path, time, bodyText)),
    };
}

export const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

/** Whether a request's signature holds for this secret (its time inside the window). */
export function verifySignature(secret, { method, path, time, signature, bodyText }) {
    const at = Number(time);
    if (!Number.isFinite(at) || Math.abs(Date.now() - at) > SIGNATURE_WINDOW_MS) return false;
    return safeEqual(signature, hmac(secret, signedText(method, path, time, bodyText)));
}
