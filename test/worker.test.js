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

const PROD = 'PROD_4rpv1XspFZwARrTFDfvlmY';
const OTHER_PROD = 'PROD_somethingelse';
const TEST_PROD = 'PROD_4H2br9vXCUBpKU7kKBFtBF';
const EMAIL = 'buyer@example.com';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

class FakeKV {
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

function makeEnv(overrides = {}) {
  return {
    LICENSES: new FakeKV(),
    WAFFO_WEBHOOK_PUBLIC_KEY: publicKey,
    CC_HELPER_PRODUCT_ID: PROD,
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    ...overrides,
  };
}

function signedRequest(event, { key = privateKey, id } = {}) {
  const body = JSON.stringify({ id: id ?? event.id, ...event });
  const t = Math.floor(Date.now() / 1000);
  const sig = createSign('RSA-SHA256').update(`${t}.${body}`).sign(key, 'base64');
  return new Request('https://botbridge.dev/api/waffo/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-waffo-signature': `t=${t},v1=${sig}` },
    body,
  });
}

function event(eventType, data = {}, extra = {}) {
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

function claimUrl(email = EMAIL, orderId = 'ord_1') {
  return new Request(`https://botbridge.dev/api/license/claim?email=${encodeURIComponent(email)}&orderId=${orderId}`);
}

function jsonReq(path, body) {
  return new Request(`https://botbridge.dev${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Mint an active license through the real webhook path and return its code.
async function seedLicense(env, { orderId = 'ord_1', email = EMAIL, periodEnd = '2027-10-12' } = {}) {
  const ev = event('subscription.activated', { orderId, buyerEmail: email, currentPeriodEnd: periodEnd }, { id: `evt_${orderId}` });
  const res = await handleWebhook(signedRequest(ev, { id: `evt_${orderId}` }), env);
  assert.equal(res.status, 200);
  const record = await env.LICENSES.get(`order:${orderId}`, 'json');
  assert.ok(record && record.code, 'webhook should have minted a code');
  return record.code;
}

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

  const record = await env.LICENSES.get('order:ord_1', 'json');
  assert.equal(record.machines.length, 1);
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
  const record = await env.LICENSES.get('order:ord_1', 'json');
  assert.equal(record.machines.length, 2);
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
