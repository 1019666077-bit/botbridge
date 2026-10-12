// Pure logic for the Pro remote-approval flow: token minting, screenshot
// validation, status derivation and the phone-facing page. Kept free of
// Worker/KV so it can be unit-tested directly; worker.js owns the KV I/O.
//
// Flow: the desktop Helper (holding a Pro license bound to this machine) asks
// the Worker for an approval token and shows `approveUrl` — usually as a QR
// code — to the buyer's phone. The phone page answers once (approved or
// cancelled) and the Helper polls the token until it is answered or expires.

import { SUPPORT_EMAIL } from './license-logic.js';

/** Approval links (and the tasks behind them) are valid for 24 hours. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// The KV record intentionally outlives the logical 24h window by an hour so a
// late poll can be told "expired" instead of "never heard of it"; after that
// the key is gone and an unknown token reads as expired anyway.
export const APPROVAL_KV_TTL_SECONDS = 25 * 60 * 60;

/** Screenshots must be small — a phone screenshot, not a photo library. */
export const MAX_SCREENSHOT_BYTES = 200 * 1024;
export const MAX_SCREENSHOT_URL_LEN = 2048;
export const MAX_TITLE_LEN = 200;
export const MAX_TASK_ID_LEN = 200;

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,(.*)$/is;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function defaultRng(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Mint an opaque, URL-safe approval token (192 bits). Opaque on purpose: the
 * token must not reveal the order, the code or the machine behind it.
 * @returns {string}
 */
export function mintApprovalToken(rng = defaultRng) {
  const bytes = rng(24);
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Best-effort image type from the leading bytes, so a raw base64 blob renders. */
function sniffImageMime(base64) {
  let head;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const at = (i) => head.charCodeAt(i);
  if (head.startsWith('\x89PNG')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Decide what screenshot (if any) an approval carries. A URL is preferred over
 * an inline blob because it keeps the page and the KV record small.
 *
 * @returns {{ok: true, screenshotUrl: string|null, dataUrl: string|null}
 *          |{ok: false, error: 'invalid_screenshot_url'|'invalid_screenshot'|'screenshot_too_large'}}
 */
export function normalizeScreenshot({ screenshotUrl, screenshotBase64 } = {}) {
  const url = typeof screenshotUrl === 'string' ? screenshotUrl.trim() : '';
  if (url) {
    if (url.length > MAX_SCREENSHOT_URL_LEN) return { ok: false, error: 'invalid_screenshot_url' };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'invalid_screenshot_url' };
    }
    // Only http(s): a data:/javascript: URL here would be script injection.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: 'invalid_screenshot_url' };
    }
    return { ok: true, screenshotUrl: url, dataUrl: null };
  }

  const raw = typeof screenshotBase64 === 'string' ? screenshotBase64.trim() : '';
  if (!raw) return { ok: true, screenshotUrl: null, dataUrl: null };

  const match = DATA_URL_RE.exec(raw);
  const mime = match ? match[1].toLowerCase() : null;
  const b64 = (match ? match[2] : raw).replace(/\s+/g, '');
  if (!b64 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { ok: false, error: 'invalid_screenshot' };

  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - padding;
  if (bytes > MAX_SCREENSHOT_BYTES) return { ok: false, error: 'screenshot_too_large' };

  return { ok: true, screenshotUrl: null, dataUrl: `data:${mime || sniffImageMime(b64) || 'image/png'};base64,${b64}` };
}

/** The status a poller should see: 'pending'|'approved'|'cancelled'|'expired'. */
export function approvalStatus(record, nowMs = Date.now()) {
  if (!record || !record.status) return 'expired';
  const ms = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
  if (!Number.isNaN(ms) && nowMs >= ms) return 'expired';
  return record.status;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f1115; color: #e8eaed; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; }
  .card { width: 100%; max-width: 460px; background: #191c22; border: 1px solid #2a2f3a; border-radius: 16px; padding: 24px; }
  .label { margin: 0 0 4px; color: #9aa4b2; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; }
  h1 { margin: 0 0 16px; font-size: 22px; line-height: 1.3; word-break: break-word; }
  .lead { margin: 0 0 12px; color: #c7ccd4; }
  .shot { display: block; width: 100%; height: auto; max-height: 55vh; object-fit: contain;
          border-radius: 10px; border: 1px solid #2a2f3a; background: #0b0d11; margin: 0 0 20px; }
  .btn { display: block; width: 100%; padding: 16px; margin: 0 0 12px; font-size: 17px; font-weight: 600;
         border-radius: 10px; border: 1px solid transparent; cursor: pointer; }
  .primary { background: #3b82f6; color: #fff; }
  .danger { background: transparent; color: #f0a6a6; border-color: #4a3030; }
  .hint { margin: 16px 0 0; color: #8b94a3; font-size: 13px; }
  .hint a { color: #9fc3ff; }
`;

/**
 * Render the phone-facing approval page. Pure string building; every
 * caller-supplied value is escaped before it reaches the markup.
 *
 * @param {{state: 'pending'|'approved'|'cancelled'|'expired'|'missing',
 *          title?: string, screenshotSrc?: string|null, token?: string,
 *          actionPath?: string, supportEmail?: string, alreadyAnswered?: boolean}} view
 * @returns {string} a complete HTML document
 */
export function renderApprovalPage({
  state = 'missing',
  title = '',
  screenshotSrc = null,
  token = '',
  actionPath = '/api/pro/approval/answer',
  supportEmail = SUPPORT_EMAIL,
  alreadyAnswered = false,
} = {}) {
  const support = `<a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>`;
  let body;

  if (state === 'pending') {
    const shot = screenshotSrc
      ? `<img class="shot" src="${escapeHtml(screenshotSrc)}" alt="Task screenshot">`
      : '';
    body = `
      <p class="label">Approval requested</p>
      <h1>${escapeHtml(title)}</h1>
      ${shot}
      <form method="POST" action="${escapeHtml(actionPath)}">
        <input type="hidden" name="t" value="${escapeHtml(token)}">
        <button class="btn primary" type="submit" name="action" value="approve">Continue</button>
        <button class="btn danger" type="submit" name="action" value="cancel">Cancel</button>
      </form>
      <p class="hint">Continuing approves this task once. This link is valid for 24 hours.</p>`;
  } else if (state === 'approved' || state === 'cancelled') {
    const verb = state === 'approved' ? 'approved' : 'cancelled';
    body = `
      <h1>${verb === 'approved' ? 'Approved' : 'Cancelled'}</h1>
      <p class="lead">This task was ${verb}. Nothing else is needed on this device.</p>
      ${alreadyAnswered ? '<p class="hint">This link was already used — the first answer stands.</p>' : ''}
      <p class="hint">Questions? Contact ${support}.</p>`;
  } else if (state === 'expired') {
    body = `
      <h1>This link has expired</h1>
      <p class="lead">Approval links are valid for 24 hours and can only be answered once. Ask the app for a new approval request.</p>
      <p class="hint">Need help? Contact ${support}.</p>`;
  } else {
    body = `
      <h1>This link is not valid</h1>
      <p class="lead">This approval link is missing or no longer works.</p>
      <p class="hint">Need help? Contact ${support}.</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Remote approval</title>
<style>${STYLES}</style>
</head>
<body>
<main class="card">${body}
</main>
</body>
</html>`;
}
