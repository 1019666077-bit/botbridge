import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvent,
  normalizeExpiry,
  extractOrder,
  productMatches,
  isActive,
  buildLicenseJson,
  isTestEvent,
  capTestExpiry,
  bindMachine,
  unbindMachine,
} from '../lib/license-logic.js';

const PROD = 'PROD_4rpv1XspFZwARrTFDfvlmY';
const TEST_PROD = 'PROD_4H2br9vXCUBpKU7kKBFtBF';

test('classifyEvent maps subscription lifecycle events', () => {
  assert.equal(classifyEvent('subscription.activated'), 'activate');
  assert.equal(classifyEvent('SubscriptionActivated'), 'activate');
  assert.equal(classifyEvent('subscription.renewed'), 'extend');
  assert.equal(classifyEvent('subscription.recovered'), 'extend');
  assert.equal(classifyEvent('subscription.canceled'), 'revoke');
  assert.equal(classifyEvent('refund.succeeded'), 'revoke');
});

test('classifyEvent treats a one-time order completion as an activation', () => {
  assert.equal(classifyEvent('order.completed'), 'activate');
  assert.equal(classifyEvent('OrderCompleted'), 'activate');
});

test('classifyEvent ignores unrelated events', () => {
  for (const t of ['subscription.past_due', 'refund.failed', 'subscription.canceling', '']) {
    assert.equal(classifyEvent(t), 'ignore', t);
  }
});

test('normalizeExpiry expands a date-only value to end of that UTC day', () => {
  assert.equal(normalizeExpiry('2026-05-18'), '2026-05-18T23:59:59.999Z');
});

test('normalizeExpiry passes through a full ISO timestamp', () => {
  assert.equal(normalizeExpiry('2026-05-18T12:00:00Z'), '2026-05-18T12:00:00.000Z');
});

test('normalizeExpiry tolerates Unix seconds and milliseconds', () => {
  assert.equal(normalizeExpiry(1770000000), new Date(1770000000 * 1000).toISOString());
  assert.equal(normalizeExpiry(1770000000000), new Date(1770000000000).toISOString());
});

test('normalizeExpiry returns null for unusable input', () => {
  for (const bad of [undefined, null, '', 'not-a-date', {}, NaN]) {
    assert.equal(normalizeExpiry(bad), null, String(bad));
  }
});

test('extractOrder pulls buyer, order, product and period fields', () => {
  const order = extractOrder({
    orderId: 'ord_123',
    buyerEmail: 'Buyer@Example.com',
    productName: 'CC Helper Pro',
    currentPeriodEnd: '2027-10-12',
    productMetadata: { productId: PROD },
  });
  assert.equal(order.orderId, 'ord_123');
  assert.equal(order.email, 'buyer@example.com');
  assert.equal(order.productName, 'CC Helper Pro');
  assert.equal(order.productId, PROD);
  assert.equal(order.expiresAt, '2027-10-12T23:59:59.999Z');
});

test('extractOrder reads productId from several plausible locations', () => {
  assert.equal(extractOrder({ productId: PROD }).productId, PROD);
  assert.equal(extractOrder({ product: { id: PROD } }).productId, PROD);
  assert.equal(extractOrder({ orderMetadata: { productId: PROD } }).productId, PROD);
  assert.equal(extractOrder({ productName: 'x' }).productId, null);
});

test('productMatches accepts a matching productId', () => {
  assert.equal(productMatches({ productId: PROD, productName: '' }, { productId: PROD }), true);
});

test('productMatches rejects a different productId when one is advertised', () => {
  assert.equal(productMatches({ productId: 'PROD_other', productName: '' }, { productId: PROD }), false);
});

test('productMatches accepts a missing productId but honours a name filter', () => {
  assert.equal(productMatches({ productId: null, productName: 'CC Helper Pro' }, { productId: PROD }), true);
  assert.equal(
    productMatches({ productId: null, productName: 'Calligraphy' }, { productId: PROD, productName: 'CC Helper Pro' }),
    false,
  );
});

test('productMatches honours an exact productId requirement in strict mode', () => {
  assert.equal(productMatches({ productId: null, productName: 'CC Helper Pro' }, { productId: PROD, requireProductId: true }), false);
  assert.equal(productMatches({ productId: PROD, productName: '' }, { productId: PROD, requireProductId: true }), true);
});

test('productMatches accepts an explicitly configured test product id', () => {
  const cfg = { productId: PROD, testProductIds: [TEST_PROD] };
  assert.equal(productMatches({ productId: TEST_PROD }, cfg), true);
  assert.equal(productMatches({ productId: PROD }, cfg), true);
  assert.equal(productMatches({ productId: 'PROD_other' }, cfg), false);
  // The test id is only accepted when it is configured.
  assert.equal(productMatches({ productId: TEST_PROD }, { productId: PROD }), false);
});

test('isTestEvent detects Waffo test-mode markers on the event or its data', () => {
  assert.equal(isTestEvent({ mode: 'test' }), true);
  assert.equal(isTestEvent({ test: true }), true);
  assert.equal(isTestEvent({ livemode: false }), true);
  assert.equal(isTestEvent({ data: { mode: 'test', livemode: false } }), true);
  assert.equal(isTestEvent({ mode: 'live', livemode: true, data: { test: false } }), false);
  assert.equal(isTestEvent({}), false);
  assert.equal(isTestEvent(), false);
});

test('capTestExpiry bounds a test license to the TTL when no period is given', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(capTestExpiry(null, now), new Date(now + 7 * 86400000).toISOString());
  assert.equal(capTestExpiry(undefined, now), new Date(now + 7 * 86400000).toISOString());
});

test('capTestExpiry never lets a test license outlive the TTL', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  // A period far in the future is pulled back to now + 7d.
  assert.equal(capTestExpiry('2099-01-01T00:00:00.000Z', now), new Date(now + 7 * 86400000).toISOString());
  // A shorter period is left untouched.
  assert.equal(capTestExpiry('2026-10-13T00:00:00.000Z', now), '2026-10-13T00:00:00.000Z');
});

test('bindMachine binds up to two distinct machines and refreshes a repeat', () => {
  const t1 = '2026-10-12T00:00:00.000Z';
  const t2 = '2026-10-13T00:00:00.000Z';
  const first = bindMachine({}, 'm1', t1);
  assert.equal(first.ok, true);
  assert.equal(first.machines.length, 1);

  const second = bindMachine({ machines: first.machines }, 'm2', t1);
  assert.equal(second.ok, true);
  assert.equal(second.machines.length, 2);

  const repeat = bindMachine({ machines: second.machines }, 'm1', t2);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.machines.length, 2);
  assert.equal(repeat.machines[0].lastSeenAt, t2);

  const third = bindMachine({ machines: second.machines }, 'm3', t1);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'machine_limit');
  assert.equal(third.machines.length, 2);
});

test('unbindMachine removes a machine and reports when nothing matched', () => {
  const record = { machines: [{ machineId: 'm1' }, { machineId: 'm2' }] };
  const removed = unbindMachine(record, 'm1');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.machines, [{ machineId: 'm2' }]);
  assert.equal(unbindMachine(record, 'ghost').removed, false);
});

test('buildLicenseJson marks a test license and records the activating machine', () => {
  const json = buildLicenseJson(
    { code: 'CCH-AAAA-BBBB-CCCC', expiresAt: '2026-10-19T00:00:00.000Z', isTest: true, machineId: 'machine-abc' },
    '2026-10-12T00:00:00.000Z',
  );
  assert.equal(json.isTest, true);
  assert.equal(json.machineId, 'machine-abc');
});

test('isActive honours status and expiry', () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(isActive({ status: 'active', expiresAt: '2027-01-01T00:00:00.000Z' }, now), true);
  assert.equal(isActive({ status: 'active', expiresAt: '2026-01-01T00:00:00.000Z' }, now), false);
  assert.equal(isActive({ status: 'active' }, now), true);
  assert.equal(isActive({ status: 'revoked', expiresAt: '2027-01-01T00:00:00.000Z' }, now), false);
  assert.equal(isActive(null, now), false);
});

test('buildLicenseJson emits the Helper contract with expiresAt', () => {
  const json = buildLicenseJson(
    { code: 'CCH-AAAA-BBBB-CCCC', email: 'a@b.com', orderId: 'ord_1', expiresAt: '2027-10-12T23:59:59.999Z' },
    '2026-10-12T00:00:00.000Z',
  );
  assert.deepEqual(json, {
    pro: true,
    activated: true,
    key: 'CCH-AAAA-BBBB-CCCC',
    activatedAt: '2026-10-12T00:00:00.000Z',
    expiresAt: '2027-10-12T23:59:59.999Z',
    email: 'a@b.com',
    orderId: 'ord_1',
  });
});
