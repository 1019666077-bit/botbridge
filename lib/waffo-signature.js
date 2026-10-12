// Waffo Pancake webhook signature verification.
//
// Contract (docs.waffo.ai + waffo-com/waffo-pancake-sdk-ts):
//   header  X-Waffo-Signature: t=<unix-seconds>,v1=<base64 signature>
//   input   `${t}.${rawBody}`      (raw body, BEFORE JSON parsing)
//   alg     RSA-SHA256, environment-specific public key (PEM)
//   window  ~45 min old, ~1 min ahead; dedupe separately on the event id.
//
// Uses WebCrypto only, so the same code runs in Workers and in Node >= 18 tests.

const PAST_WINDOW_MS = 45 * 60 * 1000;
const FUTURE_SKEW_MS = 60 * 1000;

/** @returns {{t: string, v1: string}|null} */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const parts = {};
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  if (!parts.t || !parts.v1) return null;
  return { t: parts.t, v1: parts.v1 };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function derLen(len) {
  if (len < 0x80) return [len];
  const out = [];
  let n = len;
  while (n > 0) {
    out.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | out.length, ...out];
}

function tlv(tag, content) {
  return Uint8Array.from([tag, ...derLen(content.length), ...content]);
}

// Wrap a PKCS#1 RSAPublicKey DER blob into an SPKI (SubjectPublicKeyInfo) blob,
// because WebCrypto's importKey('spki', ...) does not accept PKCS#1.
function pkcs1ToSpki(pkcs1) {
  const algId = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const bitString = tlv(0x03, [0x00, ...pkcs1]);
  const body = new Uint8Array(algId.length + bitString.length);
  body.set(algId, 0);
  body.set(bitString, algId.length);
  return tlv(0x30, body);
}

/**
 * Coerce a key from an env var (literal "\n", CRLF, raw base64, PKCS#1 or SPKI)
 * into a PEM string importable as SPKI. Returns null when unusable.
 */
export function normalizePem(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let pem = input.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
  if (!pem.includes('-----BEGIN')) {
    const b64 = pem.replace(/\s+/g, '');
    if (!b64) return null;
    return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
  }
  if (pem.includes('BEGIN RSA PUBLIC KEY')) {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    try {
      const spki = pkcs1ToSpki(b64ToBytes(b64));
      pem = `-----BEGIN PUBLIC KEY-----\n${bytesToB64(spki)}\n-----END PUBLIC KEY-----`;
    } catch {
      return null;
    }
  }
  return pem;
}

async function importPublicKey(publicKeyPem) {
  const pem = normalizePem(publicKeyPem);
  if (!pem) return null;
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  try {
    return await crypto.subtle.importKey('spki', b64ToBytes(b64), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'verify',
    ]);
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<boolean>} true only for a fresh, correctly-signed body.
 */
export async function verifyWebhookSignature({
  publicKeyPem,
  header,
  rawBody,
  nowMs = Date.now(),
  maxAgeMs = PAST_WINDOW_MS,
  maxSkewMs = FUTURE_SKEW_MS,
} = {}) {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const t = Number(parsed.t);
  if (!Number.isFinite(t)) return false;
  const signedAtMs = t * 1000;
  if (nowMs - signedAtMs > maxAgeMs) return false;
  if (signedAtMs - nowMs > maxSkewMs) return false;

  const key = await importPublicKey(publicKeyPem);
  if (!key) return false;

  let sigBytes;
  try {
    sigBytes = b64ToBytes(parsed.v1);
  } catch {
    return false;
  }

  const data = new TextEncoder().encode(`${parsed.t}.${rawBody}`);
  try {
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sigBytes, data);
  } catch {
    return false;
  }
}
