import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvent,
  normalizeExpiry,
  extractOrder,
  productMatches,
  isActive,
  buildLicenseJson,
} from '../lib/license-logic.js';

const PROD = 'PROD_4rpv1XspFZwARrTFDfvlmY';

test('classifyEvent maps subscription lifecycle events', () => {
  assert.equal(classifyEvent('subscription.activated'), 'activate');
  assert.equal(classifyEvent('SubscriptionActivated'), 'activate');
  assert.equal(classifyEvent('subscription.renewed'), 'extend');
  assert.equal(classifyEvent('subscription.recovered'), 'extend');
  assert.equal(classifyEvent('subscription.canceled'), 'revoke');
  assert.equal(classifyEvent('refund.succeeded'), 'revoke');
});

test('classifyEvent ignores unrelated events', () => {
  for (const t of ['order.completed', 'subscription.past_due', 'refund.failed', 'subscription.canceling', '']) {
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
