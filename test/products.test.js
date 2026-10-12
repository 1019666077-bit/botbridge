import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, resolveProducts, productForOrder, productForCode } from '../lib/products.js';
import { mintCode, verifyCode, codePrefixOf } from '../lib/cch-code.js';

const CC_PROD = 'PROD_4rpv1XspFZwARrTFDfvlmY';
const CC_TEST = 'PROD_4H2br9vXCUBpKU7kKBFtBF';

test('the registry ships CC Helper as the first, fully-specified product', () => {
  const cc = PRODUCTS[0];
  assert.equal(cc.key, 'cc-helper');
  assert.equal(cc.codePrefix, 'CCH');
  assert.equal(cc.maxMachines, 2);
  assert.deepEqual(cc.productIds, [CC_PROD]);
  assert.deepEqual(cc.testProductIds, [CC_TEST]);
  assert.equal(cc.successPath, '/cc-helper/success/');
  assert.ok(cc.envPrefix);
});

test('every product entry carries the fields a new plugin needs', () => {
  for (const p of PRODUCTS) {
    for (const field of ['key', 'displayName', 'codePrefix', 'productIds', 'testProductIds', 'maxMachines', 'successPath', 'envPrefix']) {
      assert.ok(p[field] !== undefined, `${p.key} is missing ${field}`);
    }
    assert.ok(Array.isArray(p.productIds) && p.productIds.length > 0, `${p.key} needs a product id`);
    assert.ok(Number.isInteger(p.maxMachines) && p.maxMachines > 0, `${p.key} needs a machine cap`);
  }
});

test('resolveProducts falls back to the registry defaults', () => {
  const [cc] = resolveProducts({});
  assert.deepEqual(cc.productIds, [CC_PROD]);
  assert.deepEqual(cc.testProductIds, [CC_TEST]);
  assert.equal(cc.maxMachines, 2);
});

test('resolveProducts lets env vars override the registry without code changes', () => {
  const [cc] = resolveProducts({
    CC_HELPER_PRODUCT_ID: 'PROD_live_override',
    CC_HELPER_TEST_PRODUCT_ID: 'PROD_test_a, PROD_test_b',
    CC_HELPER_PRODUCT_NAME: 'CC Helper Pro',
    CC_HELPER_REQUIRE_PRODUCT_MATCH: '1',
    CC_HELPER_MAX_MACHINES: '3',
  });
  assert.deepEqual(cc.productIds, ['PROD_live_override']);
  assert.deepEqual(cc.testProductIds, ['PROD_test_a', 'PROD_test_b']);
  assert.equal(cc.productName, 'CC Helper Pro');
  assert.equal(cc.requireProductId, true);
  assert.equal(cc.maxMachines, 3);
});

test('resolveProducts ignores an unusable machine cap and keeps the default', () => {
  const [cc] = resolveProducts({ CC_HELPER_MAX_MACHINES: 'lots' });
  assert.equal(cc.maxMachines, 2);
});

test('productForOrder matches live and test ids, and rejects a foreign product', () => {
  const products = resolveProducts({});
  assert.equal(productForOrder({ productId: CC_PROD }, products).key, 'cc-helper');
  assert.equal(productForOrder({ productId: CC_TEST }, products).key, 'cc-helper');
  assert.equal(productForOrder({ productId: 'PROD_foreign' }, products), null);
});

test('productForOrder keeps the legacy single-product fallback when no id is sent', () => {
  const products = resolveProducts({});
  assert.equal(productForOrder({ productId: null }, products).key, 'cc-helper');
  assert.equal(productForOrder({}, products).key, 'cc-helper');
});

test('productForOrder honours a configured name filter', () => {
  const products = resolveProducts({ CC_HELPER_PRODUCT_NAME: 'CC Helper Pro' });
  assert.equal(productForOrder({ productId: null, productName: 'CC Helper Pro' }, products).key, 'cc-helper');
});

test('productForOrder honours strict mode when the product id is absent', () => {
  const products = resolveProducts({ CC_HELPER_REQUIRE_PRODUCT_MATCH: '1' });
  assert.equal(productForOrder({ productId: null }, products), null);
});

test('productForCode routes a code to its product by prefix', () => {
  const products = resolveProducts({});
  assert.equal(productForCode('CCH-7K2M-DEMO-1F4A', products).key, 'cc-helper');
  assert.equal(productForCode('WEB-AAAA-BBBB-CCCC', products), null);
  assert.equal(productForCode('', products), null);
  assert.equal(productForCode(null, products), null);
});

test('a second product can be appended to a registry without touching the worker', () => {
  const webcam = {
    key: 'webcam-pro',
    displayName: 'Webcam Pro',
    codePrefix: 'WCP',
    productIds: ['PROD_webcam'],
    testProductIds: [],
    maxMachines: 1,
    successPath: '/webcam/success/',
    envPrefix: 'WEBCAM',
  };
  const products = [PRODUCTS[0], webcam];
  assert.equal(productForOrder({ productId: 'PROD_webcam' }, products).key, 'webcam-pro');
  assert.equal(productForCode('WCP-AAAA-BBBB-CCCC', products).key, 'webcam-pro');
  assert.equal(products[0].codePrefix, 'CCH');
});

test('codes carry the product prefix and verify against it', () => {
  const code = mintCode({ prefix: 'WCP', rng: (n) => new Uint8Array(n).fill(7) });
  assert.match(code, /^WCP-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(codePrefixOf(code), 'WCP');
  assert.equal(verifyCode(code, { prefix: 'WCP' }).valid, true);
  assert.equal(verifyCode(code, { prefix: 'CCH' }).valid, false);
});

test('codes keep the CCH default when no prefix is given', () => {
  const code = mintCode({ rng: (n) => new Uint8Array(n).fill(1) });
  assert.match(code, /^CCH-/);
  assert.equal(verifyCode(code).valid, true);
  assert.equal(codePrefixOf(code), 'CCH');
});

test('an empty test-product env falls back to the registry default rather than widening to full Pro', () => {
  const [cc] = resolveProducts({ CC_HELPER_TEST_PRODUCT_ID: '' });
  assert.deepEqual(cc.testProductIds, [CC_TEST], 'a blank var must not clear the test allowlist');
});
