// Shared fixtures for the Worker test suites. Not a test file itself — `npm test`
// only collects test/*.test.js — so this stays a plain module.

import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { handleWebhook, handleActivate, __resetRateLimitsForTests } from '../worker.js';

export const PROD = 'PROD_4rpv1XspFZwARrTFDfvlmY';
export const OTHER_PROD = 'PROD_somethingelse';
export const TEST_PROD = 'PROD_4H2br9vXCUBpKU7kKBFtBF';
export const EMAIL = 'buyer@example.com';

export const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

export function makeEnv(overrides = {}) {
  // Rate-limit counters are process-local now (no KV writes). Reset them so
  // one test's deliberate hammering cannot throttle the next test.
  __resetRateLimitsForTests();
  return {
    LICENSES: new FakeKV(),
    WAFFO_WEBHOOK_PUBLIC_KEY: publicKey,
    CC_HELPER_PRODUCT_ID: PROD,
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ...overrides,
  };
}

export function signedRequest(event, { key = privateKey, id } = {}) {
  const body = JSON.stringify({ id: id ?? event.id, ...event });
  const t = Math.floor(Date.now() / 1000);
  const sig = createSign('RSA-SHA256').update(`${t}.${body}`).sign(key, 'base64');
  return new Request('https://botbridge.dev/api/waffo/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waffo-signature': `t=${t},v1=${sig}` },
    body,
  });
}

export function event(eventType, data = {}, extra = {}) {
  return {
    id: extra.id ?? crypto.randomUUID(),
    eventType,
    data: {
      orderId: 'ord_1',
      buyerEmail: EMAIL,
      productName: 'CC Helper Pro',
      productMetadata: { productId: PROD },
      ...data,
    },
    ...extra,
  };
}

export function claimUrl(email = EMAIL, orderId = 'ord_1') {
  return new Request(`https://botbridge.dev/api/license/claim?email=${encodeURIComponent(email)}&orderId=${orderId}`);
}

export function jsonReq(path, body) {
  return new Request(`https://botbridge.dev${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Mint an active license through the real webhook path and return its code.
export async function seedLicense(env, { orderId = 'ord_1', email = EMAIL, periodEnd = '2027-10-12' } = {}) {
  const ev = event('subscription.activated', { orderId, buyerEmail: email, currentPeriodEnd: periodEnd }, { id: `evt_${orderId}` });
  const res = await handleWebhook(signedRequest(ev, { id: `evt_${orderId}` }), env);
  assert.equal(res.status, 200);
  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  assert.ok(record && record.code, 'webhook should have minted a code');
  return record.code;
}

// A license that is minted *and* bound to a machine — the precondition the Pro
// approval API demands.
export async function seedBoundLicense(env, { orderId = 'ord_1', email = EMAIL, periodEnd = '2027-10-12', machineId = 'm1' } = {}) {
  const code = await seedLicense(env, { orderId, email, periodEnd });
  const res = await handleActivate(jsonReq('/api/pro/activate', { code, machineId }), env);
  assert.equal(res.status, 200);
  return code;
}
