// Cloudflare Worker for botbridge.dev.
//
// Serves the static site from the ASSETS binding and adds the CC Helper Pro
// license endpoints:
//
//   POST /api/waffo/webhook      Waffo Pancake webhook -> mint/extend/revoke
//   GET  /api/license/claim      buyer self-serve code + license.json
//   GET  /api/license/lookup     code -> {valid, status, expiresAt} (Helper)
//   POST /api/pro/activate       bind a machine to a code (max 2)
//   POST /api/pro/validate       code + machineId -> valid? (Helper poll)
//   POST /api/pro/deactivate     unbind a machine from a code
//
// Secrets / vars (see docs/WAFFO-LICENSE-FULFILLMENT.md):
//   WAFFO_WEBHOOK_PUBLIC_KEY        PEM RSA public key (Live / Production)
//   WAFFO_WEBHOOK_TEST_PUBLIC_KEY   optional PEM for Waffo Test Mode (tried after Live)
//   CC_HELPER_PRODUCT_ID       defaults to PROD_4rpv1XspFZwARrTFDfvlmY
//   CC_HELPER_TEST_PRODUCT_ID  comma-separated test-mode product ids (marked isTest)
//   CC_HELPER_PRODUCT_NAME     optional extra filter
//   CC_HELPER_REQUIRE_PRODUCT_MATCH  "1" to reject events without a productId
//   LICENSES                   KV namespace binding

import { mintCode, verifyCode } from './lib/cch-code.js';
import {
  classifyEvent,
  extractOrder,
  productMatches,
  isActive,
  isTestEvent,
  capTestExpiry,
  parseProductIds,
  buildLicenseJson,
  bindMachine,
  unbindMachine,
  isMachineBound,
  machineCount,
  MAX_MACHINES,
} from './lib/license-logic.js';
import { verifyWebhookSignature } from './lib/waffo-signature.js';

const DEFAULT_PRODUCT_ID = 'PROD_4rpv1XspFZwARrTFDfvlmY';
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLAIM_LIMIT_PER_MINUTE = 20;
const MACHINE_LIMIT_PER_MINUTE = 30;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function config(env) {
  return {
    productId: env.CC_HELPER_PRODUCT_ID || DEFAULT_PRODUCT_ID,
    productName: env.CC_HELPER_PRODUCT_NAME || null,
    requireProductId: /^(1|true|yes)$/i.test(env.CC_HELPER_REQUIRE_PRODUCT_MATCH || ''),
    testProductIds: parseProductIds(env.CC_HELPER_TEST_PRODUCT_ID),
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

// Light per-IP throttle. KV is eventually consistent, so this is a speed bump,
// not a hard guarantee — good enough for a low-traffic self-serve claim page.
async function allowRequest(env, request, bucket, limit, windowSeconds) {
  if (!env.LICENSES) return true;
  const ip =
    request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${bucket}:${ip}:${window}`;
  const current = parseInt((await env.LICENSES.get(key)) || '0', 10) || 0;
  if (current >= limit) return false;
  await env.LICENSES.put(key, String(current + 1), { expirationTtl: Math.max(60, windowSeconds * 2) });
  return true;
}

async function upsertOrder(env, order, action, nowIso, isTest = false) {
  const key = `order:${order.orderId}`;
  const existing = await env.LICENSES.get(key, 'json');
  const record = existing || {
    orderId: order.orderId,
    email: order.email,
    productId: order.productId,
    productName: order.productName,
    code: mintCode(),
    status: 'active',
    createdAt: nowIso,
  };

  if (existing) {
    if (order.email) record.email = order.email;
    if (order.productId) record.productId = order.productId;
    if (order.productName) record.productName = order.productName;
  }

  // Sticky: once an order is known to be a test order, every later event for it
  // stays marked so a renewal can never promote it to a perpetual Pro license.
  if (isTest || record.isTest) record.isTest = true;

  if (action === 'revoke') {
    record.status = 'revoked';
  } else if (record.isTest) {
    // activate / extend on a test order: never perpetual, always capped.
    record.status = 'active';
    record.expiresAt = capTestExpiry(order.expiresAt || record.expiresAt, Date.parse(nowIso));
  } else {
    // activate / extend: currentPeriodEnd is authoritative for the paid period.
    record.status = 'active';
    if (order.expiresAt) record.expiresAt = order.expiresAt;
  }
  record.updatedAt = nowIso;

  await env.LICENSES.put(key, JSON.stringify(record));
  await env.LICENSES.put(`code:${record.code}`, order.orderId);
  if (record.email) await env.LICENSES.put(`email:${record.email}:${order.orderId}`, order.orderId);
  return record;
}

export async function handleWebhook(request, env) {
  const cfg = config(env);
  const rawBody = await request.text();

  const signatureOk = await signatureAccepted(
    cfg,
    request.headers.get('x-waffo-signature'),
    rawBody,
  );
  if (!signatureOk) return json({ error: 'invalid_signature' }, 401);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // Idempotency: Waffo retries reuse the delivery id, so dedupe on it first.
  const deliveryId = typeof event.id === 'string' && event.id ? event.id : null;
  const dedupeKey = deliveryId ? `event:${deliveryId}` : null;
  if (dedupeKey && (await env.LICENSES.get(dedupeKey))) {
    return json({ ok: true, duplicate: true });
  }

  const action = classifyEvent(event.eventType);
  const order = extractOrder(event.data || {});
  const isTest = isTestEvent(event) || (!!order.productId && cfg.testProductIds.includes(order.productId));

  let result = { ok: true, action, ignored: null };
  if (action === 'ignore') {
    result.ignored = 'event_type';
  } else if (!productMatches(order, cfg)) {
    result.ignored = 'product';
  } else if (!order.orderId) {
    result.ignored = 'missing_order_id';
  } else {
    const record = await upsertOrder(env, order, action, new Date().toISOString(), isTest);
    result.orderId = record.orderId;
  }

  if (dedupeKey && result.ignored !== 'event_type') {
    await env.LICENSES.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  }
  return json(result);
}

export async function handleClaim(request, env) {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const orderId = (url.searchParams.get('orderId') || '').trim();
  if (!email || !orderId) return json({ error: 'missing_params' }, 400);

  if (!(await allowRequest(env, request, 'claim', CLAIM_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  // Same 404 for "no such order" and "wrong email" so the endpoint cannot be
  // used to probe which order ids exist for an email.
  if (!record || !record.email || record.email !== email) return json({ error: 'not_found' }, 404);

  const now = Date.now();
  if (!isActive(record, now)) {
    return json({ error: 'inactive', status: record.status || 'unknown', expiresAt: record.expiresAt || null }, 403);
  }

  return json({
    code: record.code,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    machines: Array.isArray(record.machines) ? record.machines : [],
    licenseJson: buildLicenseJson(record, new Date(now).toISOString()),
  });
}

// ---------------------------------------------------------------------------
// Online activation: bind a license code to at most MAX_MACHINES machines.
// The first call from a machine binds it; a third distinct machine is refused
// until one is unbound. State lives on the order record in KV.
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
  const check = verifyCode(rawCode || '');
  if (!check.valid) return { status: 400, error: 'invalid_code' };
  const orderId = await env.LICENSES.get(`code:${check.code}`);
  if (!orderId) return { status: 404, error: 'unknown_code' };
  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  if (!record) return { status: 404, error: 'unknown_code' };
  return { code: check.code, orderId, record };
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
    return json(
      { error: 'inactive', status: found.record.status || 'unknown', expiresAt: found.record.expiresAt || null },
      403,
    );
  }

  const nowIso = new Date(now).toISOString();
  const bound = bindMachine(found.record, machineId, nowIso);
  if (!bound.ok) return json({ error: bound.reason, max: MAX_MACHINES }, 409);

  found.record.machines = bound.machines;
  found.record.updatedAt = nowIso;
  await env.LICENSES.put(`order:${found.orderId}`, JSON.stringify(found.record));

  return json({
    ok: true,
    code: found.code,
    status: found.record.status,
    expiresAt: found.record.expiresAt || null,
    isTest: !!found.record.isTest,
    machines: bound.machines,
    licenseJson: buildLicenseJson({ ...found.record, machineId }, nowIso),
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

  const check = verifyCode(body.code || '');
  if (!check.valid) return json({ valid: false, status: 'invalid', reason: 'invalid_code', expiresAt: null });

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

  if (!isMachineBound(record, machineId)) {
    return json({
      valid: false,
      status: 'active',
      reason: 'machine_not_bound',
      expiresAt: record.expiresAt || null,
      isTest: !!record.isTest,
    });
  }

  const nowIso = new Date(now).toISOString();
  record.machines = bindMachine(record, machineId, nowIso).machines; // refresh lastSeenAt
  record.updatedAt = nowIso;
  await env.LICENSES.put(`order:${orderId}`, JSON.stringify(record));

  return json({
    valid: true,
    status: record.status,
    expiresAt: record.expiresAt || null,
    isTest: !!record.isTest,
    machines: machineCount(record),
  });
}

export async function handleDeactivate(request, env) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'invalid_json' }, 400);

  const machineId = machineIdFrom(body);
  if (!machineId) return json({ error: 'missing_machine_id' }, 400);

  if (!(await allowRequest(env, request, 'deactivate', MACHINE_LIMIT_PER_MINUTE, 60))) {
    return json({ error: 'rate_limited' }, 429);
  }

  const found = await loadCodeRecord(env, body.code);
  if (found.error) return json({ error: found.error }, found.status);

  const nowIso = new Date().toISOString();
  const unbound = unbindMachine(found.record, machineId);
  found.record.machines = unbound.machines;
  found.record.updatedAt = nowIso;
  await env.LICENSES.put(`order:${found.orderId}`, JSON.stringify(found.record));

  return json({ ok: true, removed: unbound.removed, machines: unbound.machines });
}

export async function handleLookup(request, env) {
  const url = new URL(request.url);
  const check = verifyCode(url.searchParams.get('code') || '');
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
      console.error('license api error', pathname, err && err.stack ? err.stack : err);
      return json({ error: 'server_error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
