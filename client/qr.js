// QR codes in and out: an SVG drawn from the vendored generator, and a camera scanner that uses the
// browser's own BarcodeDetector where it has one (Chrome on Android) and the vendored jsQR elsewhere.
import qrcode from './vendor/qrcode.js';

/** An SVG of text as a QR code: always dark on light, with its quiet zone, so any camera reads it. */
export function qrSvg(text, { label = 'Pairing code' } = {}) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let path = '';
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
    const size = n + quiet * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

let jsQRLoading = null;
function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    // jsQR ships as a classic script that defines window.jsQR
    jsQRLoading ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = new URL('./vendor/jsQR.js', import.meta.url).href;
        s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('the QR reader did not load')));
        s.onerror = () => { jsQRLoading = null; reject(new Error('the QR reader did not load')); };
        document.head.appendChild(s);
    });
    return jsQRLoading;
}

/** Why the camera cannot scan on this page, or null when it can. */
export function cameraBlocker() {
    if (!window.isSecureContext) return 'The camera works only when this Σ is opened at localhost or over https. Paste the link instead.';
    if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot use a camera here. Paste the link instead.';
    return null;
}

async function makeDetector(video) {
    if ('BarcodeDetector' in window) {
        try {
            const formats = await window.BarcodeDetector.getSupportedFormats();
            if (formats.includes('qr_code')) {
                const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
                return async () => (await detector.detect(video))[0]?.rawValue || null;
            }
        } catch { /* fall back to jsQR */ }
    }
    const jsQR = await loadJsQR();
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    return () => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return null;
        const scale = Math.min(1, 720 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        g.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = g.getImageData(0, 0, canvas.width, canvas.height);
        return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data || null;
    };
}

/**
 * Scan with the camera into a video element until a code reads; answers a stop function.
 * @param {HTMLVideoElement} video
 * @param {(text: string) => void} onCode called once, with the camera already stopped
 */
export async function startScanner(video, onCode) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    let stopped = false;
    let timer = null;
    const stop = () => {
        stopped = true;
        clearTimeout(timer);
        for (const t of stream.getTracks()) t.stop();
        video.srcObject = null;
    };
    try {
        video.srcObject = stream;
        video.setAttribute('playsinline', '');
        video.muted = true;
        await video.play();
        const detect = await makeDetector(video);
        const tick = async () => {
            if (stopped) return;
            let text = null;
            try { text = await detect(); } catch { /* a frame that would not read */ }
            if (stopped) return;
            if (text) { stop(); onCode(text); return; }
            timer = setTimeout(tick, 160);
        };
        tick();
    } catch (e) {
        stop();
        throw e;
    }
    return stop;
}
