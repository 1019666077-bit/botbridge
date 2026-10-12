// Per-product configuration for every paid Bot Bridge plugin that fulfills
// through the Waffo → Worker → Helper chain.
//
// Adding a new paid plugin (see docs/LICENSE-TEMPLATE.md) means adding one entry
// to PRODUCTS — no worker logic changes. Each entry declares, at minimum:
//
//   key            stable slug used in logs
//   displayName    human name for docs/support
//   codePrefix     leading group of minted codes (routes code -> product)
//   productIds     Waffo live product id(s) that belong to this plugin
//   testProductIds Waffo Test Mode product id(s); honored but marked isTest
//   maxMachines    machine cap enforced by /api/pro/activate
//   successPath    buyer-facing claim page (used in the docs/return URL)
//   approvalPath   phone-facing remote-approval page for this plugin
//   envPrefix      env var prefix for optional overrides (e.g. CC_HELPER)
//
// Optional per-entry fields: productName (exact-match filter), requireProductId
// (reject events that carry no product id at all).
//
// The Pro approval API (/api/pro/approval) is product-agnostic: any product
// whose license is active and bound to the calling machine can request one.
// A product's `approvalPath` is only where its buyers land to answer, so the
// page can be rebranded per plugin without touching the Worker.
//
// Env overrides applied by resolveProducts():
//   <ENV>_PRODUCT_ID              comma-separated live ids
//   <ENV>_TEST_PRODUCT_ID         comma-separated test ids
//   <ENV>_PRODUCT_NAME            exact product-name filter
//   <ENV>_REQUIRE_PRODUCT_MATCH   1/true/yes = strict
//   <ENV>_MAX_MACHINES            positive integer

import { parseProductIds } from './license-logic.js';
import { codePrefixOf } from './cch-code.js';

export const PRODUCTS = [
  {
    key: 'cc-helper',
    displayName: 'CC Helper Pro',
    codePrefix: 'CCH',
    productIds: ['PROD_4rpv1XspFZwARrTFDfvlmY'],
    testProductIds: ['PROD_4H2br9vXCUBpKU7kKBFtBF'],
    maxMachines: 2,
    successPath: '/cc-helper/success/',
    approvalPath: '/cc-helper/approve',
    envPrefix: 'CC_HELPER',
    productName: null,
    requireProductId: false,
  },
  // webcam-pro: add an entry here when its Waffo product + claim page exist.
];

const TRUTHY = /^(1|true|yes)$/i;

function applyEnvOverrides(product, env) {
  const p = product.envPrefix;
  const liveIds = parseProductIds(env[`${p}_PRODUCT_ID`]);
  const rawTestIds = env[`${p}_TEST_PRODUCT_ID`];
  const rawName = env[`${p}_PRODUCT_NAME`];
  const rawStrict = env[`${p}_REQUIRE_PRODUCT_MATCH`];
  const max = Number.parseInt(env[`${p}_MAX_MACHINES`], 10);

  return {
    ...product,
    productIds: liveIds.length ? liveIds : product.productIds,
    // A blank env var is treated as "not set" (like the live ids above) rather
    // than "clear the allowlist" — clearing it would let a test order without a
    // mode marker through as a full, uncapped Pro license.
    testProductIds: rawTestIds ? parseProductIds(rawTestIds) : product.testProductIds,
    productName: rawName ? rawName.trim() : product.productName,
    requireProductId: rawStrict === undefined ? product.requireProductId : TRUTHY.test(rawStrict),
    maxMachines: Number.isInteger(max) && max > 0 ? max : product.maxMachines,
  };
}

/** Registry with env overrides applied. Defaults to the cc-helper entry alone. */
export function resolveProducts(env = {}) {
  return PRODUCTS.map((product) => applyEnvOverrides(product, env));
}

/**
 * Find the product an order belongs to.
 * - A known productId (live or test) selects that product.
 * - A productId we do not recognise selects nothing (ignore the event).
 * - Without a productId, fall back to the name filter, then to the single
 *   default product — unless some product demands a product id (strict mode).
 */
export function productForOrder(order = {}, products = PRODUCTS) {
  const productId = order.productId;
  if (productId) {
    return (
      products.find((p) => p.productIds.includes(productId) || p.testProductIds.includes(productId)) || null
    );
  }
  const named = products.filter((p) => p.productName);
  if (named.length) {
    const hit = named.find((p) => p.productName === order.productName);
    if (hit) return hit;
    if (products.some((p) => p.requireProductId)) return null;
    return products[0] || null;
  }
  if (products.some((p) => p.requireProductId)) return null;
  return products[0] || null;
}

/** Route a raw code to its product by the leading group. */
export function productForCode(rawCode, products = PRODUCTS) {
  const prefix = codePrefixOf(rawCode);
  if (!prefix) return null;
  return products.find((p) => String(p.codePrefix).toUpperCase() === prefix) || null;
}
