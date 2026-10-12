// Cloudflare Worker for botbridge.dev.
//
// Serves the static site from the ASSETS binding and adds the CC Helper Pro
// license endpoints:
//
//   POST /api/waffo/webhook      Waffo Pancake webhook -> mint/extend/revoke
//   GET  /api/license/claim      buyer self-serve code + license.json
//   GET  /api/license/lookup     code -> {valid, status, expiresAt} (Helper)
//
// Secrets / vars (see docs/WAFFO-LICENSE-FULFILLMENT.md):
//   WAFFO_WEBHOOK_PUBLIC_KEY   PEM RSA public key from the Waffo dashboard
//   CC_HELPER_PRODUCT_ID       defaults to PROD_4rpv1XspFZwARrTFDfvlmY
//   CC_HELPER_PRODUCT_NAME     optional extra filter
//   CC_HELPER_REQUIRE_PRODUCT_MATCH  "1" to reject events without a productId
//   LICENSES                   KV namespace binding

import { mintCode, verifyCode } from './lib/cch-code.js';
import {
  classifyEvent,
  extractOrder,
  productMatches,
  isActive,
  buildLicenseJson,
} from './lib/license-logic.js';
import { verifyWebhookSignature } from './lib/waffo-signature.js';

const DEFAULT_PRODUCT_ID = 'PROD_4rpv1XspFZwARrTFDfvlmY';
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CLAIM_LIMIT_PER_MINUTE = 20;

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
    publicKey: env.WAFFO_WEBHOOK_PUBLIC_KEY || '',
  };
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

async function upsertOrder(env, order, action, nowIso) {
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

  if (action === 'revoke') {
    record.status = 'revoked';
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

  const signatureOk = await verifyWebhookSignature({
    publicKeyPem: cfg.publicKey,
    header: request.headers.get('x-waffo-signature'),
    rawBody,
  });
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

  let result = { ok: true, action, ignored: null };
  if (action === 'ignore') {
    result.ignored = 'event_type';
  } else if (!productMatches(order, cfg)) {
    result.ignored = 'product';
  } else if (!order.orderId) {
    result.ignored = 'missing_order_id';
  } else {
    const record = await upsertOrder(env, order, action, new Date().toISOString());
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
    licenseJson: buildLicenseJson(record, new Date(now).toISOString()),
  });
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
    } catch (err) {
      console.error('license api error', pathname, err && err.stack ? err.stack : err);
      return json({ error: 'server_error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
