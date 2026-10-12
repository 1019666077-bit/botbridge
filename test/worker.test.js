import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker, {
  handleWebhook,
  handleClaim,
  handleLookup,
  handleActivate,
  handleValidate,
  handleDeactivate,
} from '../worker.js';
import { mintCode } from '../lib/cch-code.js';
import {
  PROD,
  OTHER_PROD,
  TEST_PROD,
  EMAIL,
  publicKey,
  privateKey,
  FakeKV,
  makeEnv,
  signedRequest,
  event,
  claimUrl,
  jsonReq,
  seedLicense,
} from './helpers.js';

test('activated webhook mints a code that claim and lookup both return', async () => {
  const env = makeEnv();
  const res = await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  assert.equal(res.status, 200);

  const claim = await handleClaim(claimUrl(), env);
  assert.equal(claim.status, 200);
  const body = await claim.json();
  assert.match(body.code, /^CCH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(body.expiresAt, '2027-10-12T23:59:59.999Z');
  assert.deepEqual(body.licenseJson, {
    pro: true,
    activated: true,
    key: body.code,
    activatedAt: body.licenseJson.activatedAt,
    expiresAt: '2027-10-12T23:59:59.999Z',
    email: EMAIL,
    orderId: 'ord_1',
  });

  const lookup = await handleLookup(new Request(`https://botbridge.dev/api/license/lookup?code=${body.code}`), env);
  assert.deepEqual(await lookup.json(), { valid: true, status: 'active', expiresAt: '2027-10-12T23:59:59.999Z' });
});

test('webhook rejects a bad signature and stores nothing', async () => {
  const env = makeEnv();
  const res = await handleWebhook(signedRequest(event('subscription.activated'), { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), env);
  assert.equal(res.status, 401);
  assert.equal(env.LICENSES.map.size, 0);
});

test('webhook rejects an unsigned request', async () => {
  const env = makeEnv();
  const req = new Request('https://botbridge.dev/api/waffo/webhook', { method: 'POST', body: '{}' });
  assert.equal((await handleWebhook(req, env)).status, 401);
});

test('a replayed delivery id is idempotent and keeps the same code', async () => {
  const env = makeEnv();
  const ev = event('subscription.activated', { currentPeriodEnd: '2027-10-12' }, { id: 'delivery-1' });
  await handleWebhook(signedRequest(ev), env);
  const second = await handleWebhook(signedRequest(ev), env);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });

  const first = await (await handleClaim(claimUrl(), env)).json();
  const record = await env.LICENSES.get('order:ord_1', 'json');
  assert.equal(record.code, first.code);
});

test('events for another product are ignored and store nothing', async () => {
  const env = makeEnv();
  const res = await handleWebhook(
    signedRequest(event('subscription.activated', { productMetadata: { productId: OTHER_PROD } })),
    env,
  );
  assert.deepEqual(await res.json(), { ok: true, action: 'activate', ignored: 'product' });
  // Only the replay-guard key may exist; no license record is written.
  const licenseKeys = [...env.LICENSES.map.keys()].filter((k) => k.startsWith('order:') || k.startsWith('code:'));
  assert.deepEqual(licenseKeys, []);
});

test('an unrelated event type is ignored', async () => {
  const env = makeEnv();
  const res = await handleWebhook(signedRequest(event('subscription.past_due')), env);
  assert.deepEqual(await res.json(), { ok: true, action: 'ignore', ignored: 'event_type' });
});

test('a one-time order.completed for the configured test product mints a capped test license', async () => {
  const env = makeEnv({ CC_HELPER_TEST_PRODUCT_ID: TEST_PROD });
  const buyer = 'moying.studio@outlook.com';
  const ev = event(
    'order.completed',
    {
      orderId: 'ORD_test_1',
      buyerEmail: buyer,
      productMetadata: { productId: TEST_PROD },
      currentPeriodEnd: '2099-01-01',
    },
    { id: 'evt_test_order_1' },
  );
  const res = await handleWebhook(signedRequest(ev, { id: 'evt_test_order_1' }), env);
  assert.deepEqual(await res.json(), { ok: true, action: 'activate', ignored: null, orderId: 'ORD_test_1' });

  const claim = await handleClaim(claimUrl(buyer, 'ORD_test_1'), env);
  assert.equal(claim.status, 200);
  const body = await claim.json();
  assert.equal(body.isTest, true);
  const ms = Date.parse(body.expiresAt);
  assert.ok(ms > Date.now(), 'test license is still valid now');
  assert.ok(ms <= Date.now() + 7 * 86400000 + 5000, 'test license is capped at 7 days');
  assert.equal(body.licenseJson.isTest, true);
});

test('an explicit test-mode event marks the license isTest even for the live product', async () => {
  const env = makeEnv({ CC_HELPER_TEST_PRODUCT_ID: '' });
  const ev = event('subscription.activated', { orderId: 'ord_mode_test', currentPeriodEnd: '2027-10-12' }, { id: 'evt_mode_test', mode: 'test' });
  const res = await handleWebhook(signedRequest(ev, { id: 'evt_mode_test' }), env);
  assert.equal(res.status, 200);
  const body = await (await handleClaim(claimUrl(EMAIL, 'ord_mode_test'), env)).json();
  assert.equal(body.isTest, true);
  assert.ok(Date.parse(body.expiresAt) <= Date.now() + 7 * 86400000 + 5000);
});

test('activate binds a machine and returns a license bound to it', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  const res = await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'machine-a' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, code);
  assert.equal(body.machines.length, 1);
  assert.equal(body.machines[0].machineId, 'machine-a');
  assert.equal(body.licenseJson.key, code);
  assert.equal(body.licenseJson.machineId, 'machine-a');
  assert.equal(body.licenseJson.expiresAt, '2027-10-12T23:59:59.999Z');

  // Bindings live under their own key so activation never rewrites the license.
  const machines = await env.LICENSES.get('machines:ord_1', 'json');
  assert.equal(machines.length, 1);
});

test('activate accepts two machines, rejects a third, but re-binds an existing one', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  assert.equal((await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env)).status, 200);
  assert.equal((await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm2' }), env)).status, 200);

  const third = await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm3' }), env);
  assert.equal(third.status, 409);
  const thirdBody = await third.json();
  assert.equal(thirdBody.error, 'machine_limit');
  assert.equal(thirdBody.max, 2);

  const repeat = await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);
  assert.equal(repeat.status, 200);
  const machines = await env.LICENSES.get('machines:ord_1', 'json');
  assert.equal(machines.length, 2);
});

test('activate rejects a revoked license, an unknown code and a missing machine id', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  await handleWebhook(signedRequest(event('refund.succeeded', { orderId: 'ord_1' }, { id: 'evt_refund_1' })), env);
  assert.equal((await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env)).status, 403);

  const unknown = await handleActivate(jsonReq('/api/pro/activate', { code: mintCode(), machineId: 'm1' }), env);
  assert.equal(unknown.status, 404);

  const noMachine = await handleActivate(jsonReq('/api/pro/activate', { code }), env);
  assert.equal(noMachine.status, 400);
  assert.equal((await noMachine.json()).error, 'missing_machine_id');
});

test('validate accepts a bound active machine and rejects unbound or expired ones', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);

  const ok = await handleValidate(jsonReq('/api/pro/validate', { code, machineId: 'm1' }), env);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.valid, true);
  assert.equal(okBody.expiresAt, '2027-10-12T23:59:59.999Z');

  const unbound = await handleValidate(jsonReq('/api/pro/validate', { code, machineId: 'never-seen' }), env);
  const unboundBody = await unbound.json();
  assert.equal(unboundBody.valid, false);
  assert.equal(unboundBody.reason, 'machine_not_bound');

  const expiredEnv = makeEnv();
  const expiredCode = await seedLicense(expiredEnv, { orderId: 'ord_exp', periodEnd: '2020-01-01' });
  const expired = await handleValidate(jsonReq('/api/pro/validate', { code: expiredCode, machineId: 'm1' }), expiredEnv);
  const expiredBody = await expired.json();
  assert.equal(expiredBody.valid, false);
  assert.equal(expiredBody.reason, 'expired');
});

test('validate never fails open when machineId is missing', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);

  const missing = await handleValidate(jsonReq('/api/pro/validate', { code }), env);
  assert.equal(missing.status, 400);
  const missingBody = await missing.json();
  assert.equal(missingBody.valid, false);
  assert.equal(missingBody.reason, 'missing_machine_id');
});

test('deactivate unbinds a machine and is idempotent', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);
  await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm2' }), env);

  const res = await handleDeactivate(jsonReq('/api/pro/deactivate', { code, machineId: 'm1' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.machines.length, 1);
  assert.equal(body.machines[0].machineId, 'm2');

  // A freed slot can be taken by a new machine.
  assert.equal((await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm3' }), env)).status, 200);

  const ghost = await handleDeactivate(jsonReq('/api/pro/deactivate', { code, machineId: 'never' }), env);
  assert.equal(ghost.status, 200);
  assert.equal((await ghost.json()).removed, false);
});

test('claim lists bound machines for the success page', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);
  await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);
  const body = await (await handleClaim(claimUrl(), env)).json();
  assert.equal(body.machines.length, 1);
  assert.equal(body.machines[0].machineId, 'm1');
});

test('subscription.renewed extends the stored expiry', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  await handleWebhook(signedRequest(event('subscription.renewed', { currentPeriodEnd: '2028-10-12' })), env);
  const body = await (await handleClaim(claimUrl(), env)).json();
  assert.equal(body.expiresAt, '2028-10-12T23:59:59.999Z');
});

test('refund.succeeded revokes the license', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  await handleWebhook(signedRequest(event('refund.succeeded')), env);

  const claim = await handleClaim(claimUrl(), env);
  assert.equal(claim.status, 403);
  assert.equal((await claim.json()).status, 'revoked');

  const lookup = await handleLookup(new Request('https://botbridge.dev/api/license/lookup?code=' + (await env.LICENSES.get('order:ord_1', 'json')).code), env);
  assert.equal((await lookup.json()).valid, false);
});

test('claim returns 404 for a wrong email and for an unknown order', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  assert.equal((await handleClaim(claimUrl('someone@else.com'), env)).status, 404);
  assert.equal((await handleClaim(claimUrl(EMAIL, 'ord_missing'), env)).status, 404);
});

test('claim requires both parameters', async () => {
  const env = makeEnv();
  const req = new Request('https://botbridge.dev/api/license/claim?email=' + EMAIL);
  assert.equal((await handleClaim(req, env)).status, 400);
});

test('lookup reports invalid for a malformed code', async () => {
  const env = makeEnv();
  const res = await handleLookup(new Request('https://botbridge.dev/api/license/lookup?code=not-a-code'), env);
  assert.deepEqual(await res.json(), { valid: false, status: 'invalid', expiresAt: null });
});

test('router: wrong method on the webhook is 405, unknown paths fall through to assets', async () => {
  const env = makeEnv();
  const get = new Request('https://botbridge.dev/api/waffo/webhook');
  assert.equal((await worker.fetch(get, env)).status, 405);

  const page = await worker.fetch(new Request('https://botbridge.dev/cc-helper/'), env);
  assert.equal(await page.text(), 'asset');
});

test('router: /api/pro/activate dispatches on POST and rejects GET', async () => {
  const env = makeEnv();
  const code = await seedLicense(env);

  const ok = await worker.fetch(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).licenseJson.machineId, 'm1');

  const get = await worker.fetch(new Request('https://botbridge.dev/api/pro/activate'), env);
  assert.equal(get.status, 405);
});

test('router: an internal failure returns 500 rather than crashing', async () => {
  const env = makeEnv({ LICENSES: { get: async () => { throw new Error('kv down'); }, put: async () => {} } });
  const res = await worker.fetch(claimUrl(), env);
  assert.equal(res.status, 500);
});

test('accepts a signature from the test public key when live key fails', async () => {
  const live = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const testPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = makeEnv({
    WAFFO_WEBHOOK_PUBLIC_KEY: live.publicKey,
    WAFFO_WEBHOOK_TEST_PUBLIC_KEY: testPair.publicKey,
  });
  const ev = event('subscription.activated', {
    orderId: 'ord_dual_1',
    buyerEmail: 'dual@example.com',
    currentPeriodEnd: '2027-10-12',
  }, { id: 'evt_test_dual_1' });
  // event() hardcodes orderId in data then spreads data — ensure orderId wins
  ev.data.orderId = 'ord_dual_1';
  ev.data.buyerEmail = 'dual@example.com';
  const res = await handleWebhook(signedRequest(ev, { key: testPair.privateKey, id: 'evt_test_dual_1' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.orderId, 'ord_dual_1');

  const claim = await handleClaim(claimUrl('dual@example.com', 'ord_dual_1'), env);
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  assert.match(claimed.code, /^CCH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

// ---------------------------------------------------------------------------
// Hardening: replay/idempotency, claim normalization + brute force, race-safe
// machine binding, admin reissue, structured logging.
// ---------------------------------------------------------------------------

import { handleAdminReissue } from '../worker.js';

/** KV that yields between operations so concurrent handlers really interleave. */
class AsyncKV {
  constructor(delayMs = 1) {
    this.inner = new FakeKV();
    this.delay = delayMs;
  }
  async get(key, type) {
    await new Promise((r) => setTimeout(r, this.delay));
    return this.inner.get(key, type);
  }
  async put(key, value, opts) {
    await new Promise((r) => setTimeout(r, this.delay));
    return this.inner.put(key, value, opts);
  }
  async delete(key) {
    return this.inner.delete(key);
  }
}

function signedRequestAt(event, t, { key = privateKey } = {}) {
  const body = JSON.stringify({ id: event.id, ...event });
  const sig = createSign('RSA-SHA256').update(`${t}.${body}`).sign(key, 'base64');
  return new Request('https://botbridge.dev/api/waffo/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waffo-signature': `t=${t},v1=${sig}` },
    body,
  });
}

test('webhook rejects a correctly-signed but stale replay', async () => {
  const env = makeEnv();
  const ev = event('subscription.activated', { currentPeriodEnd: '2027-10-12' }, { id: 'evt_stale' });
  const stale = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
  const res = await handleWebhook(signedRequestAt(ev, stale), env);
  assert.equal(res.status, 401);
  assert.equal(env.LICENSES.map.size, 0, 'a stale replay must not write anything');
});

test('webhook retries without an event id are deduped on a derived key', async () => {
  const env = makeEnv();
  const ev = event('subscription.activated', { currentPeriodEnd: '2027-10-12' }, { id: undefined });
  delete ev.id;
  const first = await handleWebhook(signedRequest(ev), env);
  assert.equal(first.status, 200);
  const second = await handleWebhook(signedRequest(ev), env);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  const record = await env.LICENSES.get('order:ord_1', 'json');
  assert.ok(record.code, 'the original license is kept');
});

test('a late renewal never shortens an existing paid period', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2028-10-12' })), env);
  await handleWebhook(signedRequest(event('subscription.renewed', { currentPeriodEnd: '2027-10-12' })), env);
  const body = await (await handleClaim(claimUrl(), env)).json();
  assert.equal(body.expiresAt, '2028-10-12T23:59:59.999Z');
});

test('a refund is terminal even if a later activation event arrives', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  await handleWebhook(signedRequest(event('refund.succeeded')), env);
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2029-10-12' })), env);
  const claim = await handleClaim(claimUrl(), env);
  assert.equal(claim.status, 403);
  assert.equal((await claim.json()).status, 'revoked');
});

test('a cancellation can still be recovered by a subscription.recovered event', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  await handleWebhook(signedRequest(event('subscription.canceled')), env);
  assert.equal((await handleClaim(claimUrl(), env)).status, 403);
  await handleWebhook(signedRequest(event('subscription.recovered', { currentPeriodEnd: '2028-10-12' })), env);
  const claim = await handleClaim(claimUrl(), env);
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).expiresAt, '2028-10-12T23:59:59.999Z');
});

test('claim normalizes email case/whitespace and an order id with a space typo', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { orderId: 'ORDtest1', currentPeriodEnd: '2027-10-12' })), env);
  const url =
    'https://botbridge.dev/api/license/claim?email=' +
    encodeURIComponent(' Buyer@Example.COM ') +
    '&orderId=' +
    encodeURIComponent('ORD test 1');
  const res = await handleClaim(new Request(url), env);
  assert.equal(res.status, 200);
  assert.match((await res.json()).code, /^CCH-/);
});

test('claim errors carry a human message and the support address', async () => {
  const env = makeEnv();
  const res = await handleClaim(claimUrl(EMAIL, 'ord_missing'), env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
  assert.ok(body.message, 'a clear buyer-facing message');
  assert.equal(body.support, 'moying.studio@outlook.com');
});

test('claim throttles repeated guesses against the same order id', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const res = await handleClaim(claimUrl(`guess${i}@example.com`, 'ord_1'), env);
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'guessing emails against one order id must be throttled');
});

test('concurrent activations never exceed the machine cap or drop a bound machine', async () => {
  const env = makeEnv({ LICENSES: new AsyncKV(1) });
  const code = await seedLicense(env);
  const results = await Promise.all([
    handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'c1' }), env),
    handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'c2' }), env),
    handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'c3' }), env),
  ]);
  const machines = await env.LICENSES.get('machines:ord_1', 'json');
  const successes = results.filter((r) => r.status === 200).length;
  assert.ok(machines.length <= 2, `cap respected, got ${machines.length}`);
  assert.equal(successes, 2, 'exactly the two machines that fit are told they succeeded');
  assert.equal(machines.length, successes, 'every successful activation is actually bound');
});

test('admin reissue is disabled until a secret is configured', async () => {
  const env = makeEnv();
  const res = await handleAdminReissue(jsonReq('/api/license/admin/reissue', { orderId: 'ord_x' }), env);
  assert.equal(res.status, 404);
});

test('admin reissue rejects a missing or wrong secret', async () => {
  const env = makeEnv({ LICENSE_ADMIN_SECRET: 'admin-secret' });
  assert.equal((await handleAdminReissue(jsonReq('/api/license/admin/reissue', { orderId: 'ord_x' }), env)).status, 401);
  const wrong = new Request('https://botbridge.dev/api/license/admin/reissue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'nope' },
    body: JSON.stringify({ orderId: 'ord_x' }),
  });
  assert.equal((await handleAdminReissue(wrong, env)).status, 401);
});

test('admin reissue recovers a missed webhook and the buyer can claim', async () => {
  const env = makeEnv({ LICENSE_ADMIN_SECRET: 'admin-secret' });
  const req = new Request('https://botbridge.dev/api/license/admin/reissue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'admin-secret' },
    body: JSON.stringify({ orderId: 'ord_missed', email: 'Buyer@Example.com', expiresAt: '2027-10-12' }),
  });
  const res = await handleAdminReissue(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.code, /^CCH-/);
  assert.equal(body.created, true);
  assert.equal(body.email, 'buyer@example.com', 'email is normalized like a webhook event');

  const claim = await handleClaim(claimUrl('buyer@example.com', 'ord_missed'), env);
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).code, body.code);
});

test('admin reissue can revoke a license', async () => {
  const env = makeEnv({ LICENSE_ADMIN_SECRET: 'admin-secret' });
  await seedLicense(env);
  const req = new Request('https://botbridge.dev/api/license/admin/reissue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'admin-secret' },
    body: JSON.stringify({ orderId: 'ord_1', action: 'revoke' }),
  });
  const res = await handleAdminReissue(req, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'revoked');
  assert.equal((await handleClaim(claimUrl(), env)).status, 403);
});

test('webhook logs structured fields but never the full license code', async () => {
  const env = makeEnv();
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await handleWebhook(signedRequest(event('subscription.activated', { currentPeriodEnd: '2027-10-12' })), env);
  } finally {
    console.log = original;
  }
  const record = await env.LICENSES.get('order:ord_1', 'json');
  const joined = lines.join('\n');
  assert.ok(joined.includes('waffo.webhook'), 'logs the handled event');
  assert.ok(joined.includes('ord_1'), 'logs the order id for debugging');
  assert.ok(!joined.includes(record.code), 'must not log the full license code');
});

test('router: admin reissue is POST-only', async () => {
  const env = makeEnv({ LICENSE_ADMIN_SECRET: 'admin-secret' });
  const get = await worker.fetch(new Request('https://botbridge.dev/api/license/admin/reissue'), env);
  assert.equal(get.status, 405);
});

test('claim rejects an absurdly long order id without touching KV', async () => {
  const env = makeEnv();
  const res = await handleClaim(
    new Request('https://botbridge.dev/api/license/claim?email=' + EMAIL + '&orderId=' + 'x'.repeat(5000)),
    env,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_params');
  assert.equal(env.LICENSES.map.size, 0, 'a hostile key is rejected before any KV write');
});

/** KV that can simulate a webhook refund committing mid-activation. */
class RefundRaceKV extends FakeKV {
  constructor() {
    super();
    this.remaining = 0;
  }
  arm(readCount) {
    this.remaining = readCount;
  }
  async get(key, type) {
    const value = await super.get(key, type);
    if (key === 'order:ord_1' && this.remaining > 0) {
      this.remaining -= 1;
      if (this.remaining === 0) {
        const rec = JSON.parse(this.map.get(key));
        if (rec && rec.status === 'active') {
          // the refund webhook wins the race and commits just after our read
          this.map.set(key, JSON.stringify({ ...rec, status: 'revoked', refunded: true }));
        }
      }
    }
    return value;
  }
}

test('an activation racing a refund never resurrects the license', async () => {
  const kv = new RefundRaceKV();
  const env = makeEnv({ LICENSES: kv });
  const code = await seedLicense(env);
  kv.arm(2); // let the activation's read happen, then commit the refund underneath it

  const res = await handleActivate(jsonReq('/api/pro/activate', { code, machineId: 'm1' }), env);
  assert.equal(res.status, 403, 'the in-flight refund wins');

  const record = await env.LICENSES.get('order:ord_1', 'json');
  assert.equal(record.status, 'revoked');
  assert.equal(record.refunded, true);
  assert.equal((await handleClaim(claimUrl(), env)).status, 403);
});

test('a webhook order id with an interior space is stored under the claim lookup key', async () => {
  const env = makeEnv();
  await handleWebhook(signedRequest(event('subscription.activated', { orderId: 'ORD test 9', currentPeriodEnd: '2027-10-12' })), env);
  assert.ok(await env.LICENSES.get('order:ORDtest9', 'json'), 'stored under the normalized key');
  assert.equal((await handleClaim(claimUrl(EMAIL, 'ORD test 9'), env)).status, 200);
});

test('admin reissue rejects an unknown product key instead of guessing', async () => {
  const env = makeEnv({ LICENSE_ADMIN_SECRET: 'admin-secret' });
  const req = new Request('https://botbridge.dev/api/license/admin/reissue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': 'admin-secret' },
    body: JSON.stringify({ orderId: 'ord_p', email: EMAIL, product: 'webcam-pro' }),
  });
  const res = await handleAdminReissue(req, env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown_product');
  assert.equal(env.LICENSES.map.size, 0, 'nothing is minted for a mistyped product');
});
