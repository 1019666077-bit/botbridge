// Cloudflare Worker for botbridge.dev.
//
// Serves the static site from the ASSETS binding and adds the paid-plugin
// license endpoints (see lib/products.js for the per-product configuration):
//
//   POST /api/waffo/webhook           Waffo Pancake webhook -> mint/extend/revoke
//   GET  /api/license/claim           buyer self-serve code + license.json
//   GET  /api/license/lookup          code -> {valid, status, expiresAt} (Helper)
//   POST /api/pro/activate            bind a machine to a code (per-product cap)
//   POST /api/pro/validate            code + machineId -> valid? (Helper poll)
//   POST /api/pro/deactivate          unbind a machine from a code
//   POST /api/license/admin/reissue   operator recovery for a missed webhook
//
// Secrets / vars:
//   WAFFO_WEBHOOK_PUBLIC_KEY        PEM RSA public key (Live / Production)
//   WAFFO_WEBHOOK_TEST_PUBLIC_KEY   optional PEM for Waffo Test Mode (tried after Live)
//   LICENSE_ADMIN_SECRET            optional; enables /api/license/admin/reissue
//   CC_HELPER_PRODUCT_ID / CC_HELPER_TEST_PRODUCT_ID / CC_HELPER_PRODUCT_NAME /
//   CC_HELPER_REQUIRE_PRODUCT_MATCH / CC_HELPER_MAX_MACHINES   per-product overrides
//   LICENSES                        KV namespace binding
//
// See docs/WAFFO-LICENSE-FULFILLMENT.md and docs/LICENSE-TEMPLATE.md.

import { mintCode, verifyCode } from './lib/cch-code.js';
import {
  classifyEvent,
  extractOrder,
  isActive,
  isTestEvent,
  normalizeExpiry,
  buildLicenseJson,
  bindMachine,
  unbindMachine,
  isMachineBound,
  applyEvent,
  isRefundEvent,
  normalizeEmail,
  normalizeOrderId,
} from './lib/license-logic.js';
import { resolveProducts, productForOrder, productForCode } from './lib/products.js';
import { verifyWebhookSignature } from './lib/waffo-signature.js';

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLAIM_LIMIT_PER_MINUTE = 20;
const CLAIM_ORDER_LIMIT_PER_MINUTE = 8;
const MACHINE_LIMIT_PER_MINUTE = 30;
const VALIDATE_CODE_LIMIT_PER_MINUTE = 60;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_ORDER_ID_LEN = 100;
const MAX_EMAIL_LEN = 254;
const SUPPORT_EMAIL = 'moying.studio@outlook.com';
const BIND_ATTEMPTS = 5;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Buyer-facing error: a stable code, a human sentence and how to get help. */
function apiError(status, error, message) {
  return json({ error, message, support: SUPPORT_EMAIL }, status);
}

/**
 * One JSON line per handled request. Never include a full license code — only
 * its last 4 characters — so log access cannot become key access.
 */
function logEvent(fields) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  } catch {
    console.log('{"event":"log_error"}');
  }
}

function codeHint(code) {
  return typeof code === 'string' && code.length >= 4 ? code.slice(-4) : null;
}

function config(env) {
  return {
    products: resolveProducts(env),
    publicKey: env.WAFFO_WEBHOOK_PUBLIC_KEY || '',
    testPublicKey: env.WAFFO_WEBHOOK_TEST_PUBLIC_KEY || '',
  };
}

/** Accept Live or Test Mode signatures; Live key is tried first. */
async function signatureAccepted(cfg, header, rawBody) {
  const keys = [cfg.publicKey, cfg.testPublicKey].filter((k) => typeof k === 'string' && k.trim());
  for (const publicKeyPem of keys) {
    if (await verifyWebhookSignature({ publicKeyPem, header, rawBody })) return true;
  }
  return false;
}

function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

// Light per-identity throttle. KV is eventually consistent, so this is a speed
// bump, not a hard guarantee — good enough for a low-traffic self-serve flow.
async function allowKey(env, bucket, identity, limit, windowSeconds) {
  if (!env.LICENSES) return true;
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${identity}:${window}`;
  const current = parseInt((await env.LICENSES.get(key)) || '0', 10) || 0;
  if (current >= limit) return false;
  await env.LICENSES.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return true;
}

async function allowRequest(env, request, bucket, limit, windowSeconds) {
  return allowKey(env, bucket, clientIp(request), limit, windowSeconds);
}

/**
 * Idempotency key for a delivery. Waffo retries reuse `event.id`; when an event
 * arrives without one, derive a stable key from its type + order + period so a
 * plain retry still cannot mint a second code.
 */
function dedupeKeyFor(event, order) {
  if (event && typeof event.id === 'string' && event.id) return `event:${event.id}`;
  if (!order.orderId) return null;
  const type = typeof event?.eventType === 'string' ? event.eventType : '';
  return `event:d:${type}:${order.orderId}:${order.expiresAt || ''}`;
}

async function upsertOrder(env, product, order, action, nowIso, { isTest = false, isRefund = false } = {}) {
  const key = `order:${order.orderId}`;
  const existing = await env.LICENSES.get(key, 'json');
  const { record } = applyEvent(existing, {
    order,
    action,
    isTest,
    isRefund,
    nowIso,
    newCode: (existing && existing.code) || mintCode({ prefix: product.codePrefix }),
  });

  await env.LICENSES.put(key, JSON.stringify(record));
  await env.LICENSES.put(`code:${record.code}`, order.orderId);
  if (record.email) await env.LICENSES.put(`email:${record.email}:${order.orderId}`, order.orderId);
  return record;
}

export async function handleWebhook(request, env) {
  const cfg = config(env);
  const rawBody = await request.text();

  const signatureOk = await signatureAccepted(cfg, request.headers.get('x-waffo-signature'), rawBody);
  if (!signatureOk) {
    logEvent({ event: 'waffo.webhook', outcome: 'invalid_signature' });
    return json({ error: 'invalid_signature' }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const order = extractOrder(event.data || {});

  // Idempotency: Waffo retries reuse the delivery id, so dedupe on it first.
  const dedupeKey = dedupeKeyFor(event, order);
  if (dedupeKey && (await env.LICENSES.get(dedupeKey))) {
    logEvent({ event: 'waffo.webhook', outcome: 'duplicate', orderId: order.orderId || null });
    return json({ ok: true, duplicate: true });
  }

  const action = classifyEvent(event.eventType);
  const product = productForOrder(order, cfg.products);
  const isTest =
    isTestEvent(event) || (!!order.productId && !!product && product.testProductIds.includes(order.productId));

  let result = { ok: true, action, ignored: null };
  let record = null;
  if (action === 'ignore') {
    result.ignored = 'event_type';
  } else if (!product) {
    result.ignored = 'product';
  } else if (!order.orderId) {
    result.ignored = 'missing_order_id';
  } else {
    record = await upsertOrder(env, product, order, action, new Date().toISOString(), {
      isTest,
      isRefund: isRefundEvent(event.eventType),
    });
    result.orderId = record.orderId;
  }

  if (dedupeKey && result.ignored !== 'event_type') {
    await env.LICENSES.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  }

  logEvent({
    event: 'waffo.webhook',
    action,
    ignored: result.ignored,
    product: product ? product.key : null,
    orderId: order.orderId || null,
    status: record ? record.status : null,
    isTest: record ? !!record.isTest : isTest,
    deliveryId: typeof event.id === 'string' ? event.id : null,
  });
  return json(result);
}

export async function handleClaim(request, env) {
  const url = new URL(request.url);
  const email = normalizeEmail(url.searchParams.get('email'));
  const orderId = normalizeOrderId(url.searchParams.get('orderId'));
  if (!email || !orderId) {
    return apiError(400, 'missing_params', 'Enter both the email and the order id from your Waffo receipt.');
  }
  // Bound the values before they become KV keys: an oversized order id would
  // otherwise exceed KV's key limit and turn a probe into a 500.
  if (orderId.length > MAX_ORDER_ID_LEN || email.length > MAX_EMAIL_LEN) {
    return apiError(400, 'invalid_params', 'That email or order id does not look right — copy both from your Waffo receipt.');
  }

  if (!(await allowRequest(env, request, 'claim', CLAIM_LIMIT_PER_MINUTE, 60))) {
    return apiError(429, 'rate_limited', 'Too many attempts just now — please wait a minute and try again.');
  }
  // Second, tighter bucket per order id, so one buyer's order cannot be brute
  // forced through many guessed emails from a single connection.
  if (!(await allowKey(env, 'claim-order', orderId, CLAIM_ORDER_LIMIT_PER_MINUTE, 60))) {
    return apiError(429, 'rate_limited', 'Too many attempts for this order — please wait a minute and try again.');
  }

  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  // Same 404 for "no such order" and "wrong email" so the endpoint cannot be
  // used to probe which order ids exist for an email.
  if (!record || !record.email || record.email !== email) {
    logEvent({ event: 'license.claim', outcome: 'not_found', orderId });
    return apiError(404, 'not_found', 'We could not match that email and order id to a purchase. Double-check both against your Waffo receipt.');
  }

  const now = Date.now();
  if (!isActive(record, now)) {
    logEvent({ event: 'license.claim', outcome: 'inactive', orderId, status: record.status || 'unknown' });
    return json(
      {
        error: 'inactive',
        message: 'This license is no longer active — it was refunded, cancelled or has expired.',
        support: SUPPORT_EMAIL,
        status: record.status || 'unknown',
        expiresAt: record.expiresAt || null,
      },
      403,
    );
  }

  logEvent({ event: 'license.claim', outcome: 'ok', orderId, isTest: !!record.isTest, code: codeHint(record.code) });
  return json({
    code: record.code,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    machines: await readMachines(env, orderId, record),
    licenseJson: buildLicenseJson(record, new Date(now).toISOString()),
  });
}

// ---------------------------------------------------------------------------
// Online activation: bind a license code to at most product.maxMachines
// machines. The first call from a machine binds it; one more than the cap is
// refused until a machine is unbound. State lives on the order record in KV.
// ---------------------------------------------------------------------------

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function machineIdFrom(body) {
  return typeof body?.machineId === 'string' ? body.machineId.trim() : '';
}

/** Resolve a code -> order record, or a {status, error} to return verbatim. */
async function loadCodeRecord(env, rawCode) {
  const products = resolveProducts(env);
  const product = productForCode(rawCode, products);
  if (!product) return { status: 400, error: 'invalid_code' };
  const check = verifyCode(rawCode || '', { prefix: product.codePrefix });
  if (!check.valid) return { status: 400, error: 'invalid_code' };
  const orderId = await env.LICENSES.get(`code:${check.code}`);
  if (!orderId) return { status: 404, error: 'unknown_code' };
  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  if (!record) return { status: 404, error: 'unknown_code' };
  return { code: check.code, orderId, record, product };
}

/**
 * Machine bindings live under their own `machines:<orderId>` key, separate from
 * the license record. That separation is deliberate: activation/deactivation
 * then never rewrite `order:<orderId>`, so a concurrent refund or cancellation
 * webhook can never be clobbered by a stale activation snapshot. Legacy records
 * that still store `machines` inline are read as a fallback.
 */
async function readMachines(env, orderId, record) {
  const stored = await env.LICENSES.get(`machines:${orderId}`, 'json');
  if (Array.isArray(stored)) return stored;
  return Array.isArray(record?.machines) ? record.machines : [];
}

const machinesToRecord = (machines) => ({ machines });

/**
 * Read-modify-write the machine list with an optimistic check: after writing we
 * re-read and confirm our machine is still bound, and re-check the license is
 * still active. A concurrent activation that clobbered us is retried against
 * the fresh state, so the cap is never breached and a machine that was told
 * "ok" stays bound.
 */
async function bindMachineRaceSafe(env, orderId, machineId, nowIso, max) {
  const orderKey = `order:${orderId}`;
  const machinesKey = `machines:${orderId}`;
  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt++) {
    const record = await env.LICENSES.get(orderKey, 'json');
    if (!record) return { status: 404, error: 'unknown_code' };
    if (!isActive(record, Date.now())) return { status: 403, error: 'inactive', record };

    const bound = bindMachine(machinesToRecord(await readMachines(env, orderId, record)), machineId, nowIso, max);
    if (!bound.ok) return { status: 409, error: bound.reason, machines: bound.machines };

    await env.LICENSES.put(machinesKey, JSON.stringify(bound.machines));

    const after = await env.LICENSES.get(machinesKey, 'json');
    if (Array.isArray(after) && after.some((m) => m.machineId === machineId) && after.length <= max) {
      // The license itself may have been refunded/cancelled while we bound.
      const fresh = await env.LICENSES.get(orderKey, 'json');
      if (!fresh || !isActive(fresh, Date.now())) return { status: 403, error: 'inactive', record: fresh };
      return { status: 200, record: fresh, machines: after };
    }
  }
  return { status: 409, error: 'machine_limit', machines: [] };
}

export async function handleActivate(request, env) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const machineId = machineIdFrom(body);
  if (!machineId) return json({ error: 'missing_machine_id' }, 400);
  if (!MACHINE_ID_RE.test(machineId)) return json({ error: 'invalid_machine_id' }, 400);

  if (!(await allowRequest(env, request, 'activate', MACHINE_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const found = await loadCodeRecord(env, body.code);
  if (found.error) return json({ error: found.error }, found.status);

  const now = Date.now();
  if (!isActive(found.record, now)) {
    logEvent({ event: 'license.activate', outcome: 'inactive', orderId: found.orderId, status: found.record.status });
    return json(
      { error: 'inactive', status: found.record.status || 'unknown', expiresAt: found.record.expiresAt || null },
      403,
    );
  }

  const nowIso = new Date(now).toISOString();
  const bound = await bindMachineRaceSafe(env, found.orderId, machineId, nowIso, found.product.maxMachines);
  if (bound.error) {
    logEvent({ event: 'license.activate', outcome: bound.error, orderId: found.orderId, machine: machineId });
    if (bound.status === 403) {
      const rec = bound.record || {};
      return json({ error: 'inactive', status: rec.status || 'unknown', expiresAt: rec.expiresAt || null }, 403);
    }
    return json({ error: bound.error, max: found.product.maxMachines }, bound.status);
  }

  const record = bound.record;
  const machines = bound.machines || [];
  logEvent({ event: 'license.activate', outcome: 'ok', orderId: found.orderId, product: found.product.key, machines: machines.length });
  return json({
    ok: true,
    code: found.code,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    machines,
    licenseJson: buildLicenseJson({ ...record, machineId }, nowIso),
  });
}

export async function handleValidate(request, env) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  // Validate is the enforcement gate for the machine cap, so it must never
  // fail open. A machine-less content check is /api/license/lookup's job.
  const machineId = machineIdFrom(body);
  if (!machineId) return json({ valid: false, status: 'invalid', reason: 'missing_machine_id', expiresAt: null }, 400);
  if (!MACHINE_ID_RE.test(machineId)) return json({ valid: false, status: 'invalid', reason: 'invalid_machine_id', expiresAt: null }, 400);

  if (!(await allowRequest(env, request, 'validate', MACHINE_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const product = productForCode(body.code || '', resolveProducts(env));
  const check = product ? verifyCode(body.code || '', { prefix: product.codePrefix }) : { valid: false };
  if (!check.valid) return json({ valid: false, status: 'invalid', reason: 'invalid_code', expiresAt: null });

  // Slow repeated probes of one specific code without penalising other buyers.
  if (!(await allowKey(env, 'validate-code', check.code, VALIDATE_CODE_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const orderId = await env.LICENSES.get(`code:${check.code}`);
  const record = orderId ? await env.LICENSES.get(`order:${orderId}`, 'json') : null;
  if (!record) return json({ valid: false, status: 'unknown', reason: 'unknown_code', expiresAt: null });

  const now = Date.now();
  if (!isActive(record, now)) {
    const reason = record.status && record.status !== 'active' ? record.status : 'expired';
    return json({
      valid: false,
      status: record.status || 'unknown',
      reason,
      expiresAt: record.expiresAt || null,
      isTest: !!record.isTest,
    });
  }

  const machines = await readMachines(env, orderId, record);
  if (!isMachineBound(machinesToRecord(machines), machineId)) {
    return json({
      valid: false,
      status: 'active',
      reason: 'machine_not_bound',
      expiresAt: record.expiresAt || null,
      isTest: !!record.isTest,
    });
  }

  // Refresh lastSeenAt on the machines key only; never touch the order record,
  // so a revalidation cannot race a refund webhook.
  const nowIso = new Date(now).toISOString();
  const refreshed = bindMachine(machinesToRecord(machines), machineId, nowIso).machines;
  await env.LICENSES.put(`machines:${orderId}`, JSON.stringify(refreshed));

  return json({
    valid: true,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    machines: refreshed.length,
  });
}

export async function handleDeactivate(request, env) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const machineId = machineIdFrom(body);
  if (!machineId) return json({ error: 'missing_machine_id' }, 400);
  if (!MACHINE_ID_RE.test(machineId)) return json({ error: 'invalid_machine_id' }, 400);

  if (!(await allowRequest(env, request, 'deactivate', MACHINE_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const found = await loadCodeRecord(env, body.code);
  if (found.error) return json({ error: found.error }, found.status);

  const machines = await readMachines(env, found.orderId, found.record);
  const unbound = unbindMachine(machinesToRecord(machines), machineId);
  await env.LICENSES.put(`machines:${found.orderId}`, JSON.stringify(unbound.machines));

  logEvent({ event: 'license.deactivate', outcome: 'ok', orderId: found.orderId, removed: unbound.removed });
  return json({ ok: true, removed: unbound.removed, machines: unbound.machines });
}

export async function handleLookup(request, env) {
  const url = new URL(request.url);
  const rawCode = url.searchParams.get('code') || '';
  const product = productForCode(rawCode, resolveProducts(env));
  const check = product ? verifyCode(rawCode, { prefix: product.codePrefix }) : { valid: false };
  if (!check.valid) return json({ valid: false, status: 'invalid', expiresAt: null });

  if (!(await allowRequest(env, request, 'lookup', CLAIM_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const orderId = await env.LICENSES.get(`code:${check.code}`);
  if (!orderId) return json({ valid: false, status: 'unknown', expiresAt: null });

  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  return json({
    valid: isActive(record, Date.now()),
    status: record?.status || 'unknown',
    expiresAt: record?.expiresAt || null,
  });
}

// ---------------------------------------------------------------------------
// Operator recovery: POST /api/license/admin/reissue
// ---------------------------------------------------------------------------
// For a webhook that never arrived. Authenticated with LICENSE_ADMIN_SECRET
// (header `x-admin-secret` or `Authorization: Bearer <secret>`); disabled while
// that secret is unset. Actions: reissue (default) | extend | revoke.

const ADMIN_ACTIONS = new Set(['reissue', 'extend', 'revoke']);

/** Length-independent, constant-time-ish string compare for the admin secret. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function adminSecretFrom(request) {
  const header = request.headers.get('x-admin-secret');
  if (header) return header;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return match ? match[1].trim() : '';
}

export async function handleAdminReissue(request, env) {
  const secret = env.LICENSE_ADMIN_SECRET || '';
  if (!secret) return json({ error: 'admin_disabled' }, 404);
  if (!safeEqual(adminSecretFrom(request), secret)) {
    logEvent({ event: 'license.admin', outcome: 'unauthorized' });
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await readJsonBody(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const orderId = normalizeOrderId(body.orderId);
  if (!orderId) return json({ error: 'missing_order_id' }, 400);

  const action = body.action || 'reissue';
  if (!ADMIN_ACTIONS.has(action)) return json({ error: 'unknown_action' }, 400);

  const products = resolveProducts(env);
  const key = `order:${orderId}`;
  const existing = await env.LICENSES.get(key, 'json');
  if ((action === 'revoke' || action === 'extend') && !existing) {
    return json({ error: 'unknown_order' }, 404);
  }

  if (body.product && !products.some((p) => p.key === body.product)) {
    return json({ error: 'unknown_product' }, 400);
  }
  const product = (body.product && products.find((p) => p.key === body.product)) || products[0];
  if (!product) return json({ error: 'no_product' }, 500);

  const nowIso = new Date().toISOString();
  const email = normalizeEmail(body.email) || (existing && existing.email) || null;
  const requestedExpiry = normalizeExpiry(body.expiresAt);

  const { record } = applyEvent(existing, {
    order: {
      orderId,
      email,
      productId: (existing && existing.productId) || product.productIds[0],
      productName: (existing && existing.productName) || product.displayName,
      expiresAt: requestedExpiry,
    },
    action: action === 'revoke' ? 'revoke' : 'activate',
    isRefund: action === 'revoke', // an operator revoke is terminal
    nowIso,
    newCode: (existing && existing.code) || mintCode({ prefix: product.codePrefix }),
  });

  await env.LICENSES.put(key, JSON.stringify(record));
  await env.LICENSES.put(`code:${record.code}`, orderId);
  if (record.email) await env.LICENSES.put(`email:${record.email}:${orderId}`, orderId);

  logEvent({ event: 'license.admin', outcome: action, orderId, product: product.key, code: codeHint(record.code) });
  return json({
    ok: true,
    orderId,
    code: record.code,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    email: record.email || null,
    created: !existing,
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/waffo/webhook') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return await handleWebhook(request, env);
      }
      if (pathname === '/api/license/claim') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await handleClaim(request, env);
      }
      if (pathname === '/api/license/lookup') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await handleLookup(request, env);
      }
      if (pathname === '/api/license/admin/reissue') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return await handleAdminReissue(request, env);
      }
      if (pathname === '/api/pro/activate' || pathname === '/api/pro/validate' || pathname === '/api/pro/deactivate') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const handler =
          pathname === '/api/pro/activate'
            ? handleActivate
            : pathname === '/api/pro/validate'
              ? handleValidate
              : handleDeactivate;
        return await handler(request, env);
      }
    } catch (err) {
      logEvent({ event: 'license.api', outcome: 'server_error', path: pathname, error: err && err.message ? err.message : String(err) });
      return json({ error: 'server_error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
