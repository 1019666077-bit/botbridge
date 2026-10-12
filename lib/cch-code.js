// CC Helper Pro license codes: CCH-XXXX-XXXX-CSUM
//
// The desktop Helper (not in any public repo) documents this shape for its
// activation codes and ships a demo code `CCH-DEMO-7K2M-CCB9`. The checksum
// below follows the Helper's reported algorithm: FNV-1a 32-bit over the two
// body groups with the prefix and hyphens stripped ("DEMO7K2M"), rendered as
// the last 4 hex digits, uppercase. See docs/HELPER-EXPIRES-PATCH.md for the
// remaining Helper-side follow-ups.

// Kept exported (and CCH-shaped) for back-compat; prefix-aware callers use
// codeReFor()/verifyCode(input, { prefix }).
export const CODE_RE = /^CCH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

// Crockford-style base32: no I, L, O, U — avoids the usual transcription traps.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP_LEN = 4;
const GROUPS = 2;
const DEFAULT_PREFIX = 'CCH';
const BODY_GROUP = '[0-9A-Z]{4}';
const CHECKSUM_LEN = 4;

/** Build the full-code regex for a product's prefix (default CCH). */
function codeReFor(prefix) {
  const p = String(prefix || DEFAULT_PREFIX).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${p}-${BODY_GROUP}-${BODY_GROUP}-${BODY_GROUP}$`);
}

/**
 * The leading group of a code (e.g. "CCH" / "WCP"), used to route a code to its
 * product before the checksum is verified. Returns null when there is none.
 */
export function codePrefixOf(input) {
  if (typeof input !== 'string') return null;
  const match = /^([A-Z0-9]{2,8})-/.exec(input.trim().toUpperCase());
  return match ? match[1] : null;
}

// FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The Helper hashes the two body groups concatenated — no "CCH" prefix and no
// hyphens — then keeps the low 4 hex digits. Body groups only ever use the
// base32 alphabet above, so the checksum stays inside CODE_RE's [0-9A-Z].
function checksumFor(groups) {
  const hex = fnv1a32(groups.join('')).toString(16).toUpperCase().padStart(8, '0');
  return hex.slice(-CHECKSUM_LEN);
}

function randomGroup(rng) {
  const bytes = rng(GROUP_LEN);
  let out = '';
  for (let i = 0; i < GROUP_LEN; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

function defaultRng(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Mint a new license code. `rng` is injectable so tests stay deterministic and
 * `prefix` selects the product (see lib/products.js).
 * @returns {string} e.g. "CCH-7K2M-DEMO-1F4A"
 */
export function mintCode({ rng = defaultRng, prefix = DEFAULT_PREFIX } = {}) {
  const groups = [];
  for (let i = 0; i < GROUPS; i++) groups.push(randomGroup(rng));
  return `${String(prefix).toUpperCase()}-${groups.join('-')}-${checksumFor(groups)}`;
}

/**
 * Verify a code's shape and checksum. Never throws.
 * @param {string} input
 * @param {{prefix?: string}} [options] product prefix; defaults to CCH
 * @returns {{valid: boolean, reason?: string, code?: string}}
 */
export function verifyCode(input, { prefix = DEFAULT_PREFIX } = {}) {
  if (typeof input !== 'string') return { valid: false, reason: 'not_a_string' };
  const code = input.trim().toUpperCase();
  if (!codeReFor(prefix).test(code)) return { valid: false, reason: 'bad_format' };
  const parts = code.split('-');
  const groups = parts.slice(1, 1 + GROUPS);
  if (checksumFor(groups) !== parts[parts.length - 1]) return { valid: false, reason: 'bad_checksum' };
  return { valid: true, code };
}
