// Pure licensing decisions, kept free of Worker/KV/WebCrypto so they can be
// unit-tested directly. The Worker applies these; the Helper mirrors isActive().

// Wire values come from Waffo Pancake (dot.lowercase, e.g. "subscription.activated").
// The TS SDK exposes PascalCase enum names, so we normalize both spellings.
function normalizeEventType(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2') // SubscriptionActivated -> Subscription.Activated
    .replace(/[_\s]+/g, '.')
    .toLowerCase()
    .replace(/[^a-z.]/g, '');
}

const EVENT_ACTIONS = {
  'subscription.activated': 'activate',
  'subscription.renewed': 'extend',
  'subscription.recovered': 'extend',
  'subscription.canceled': 'revoke',
  'subscription.cancelled': 'revoke',
  // One-time purchases (the CC Helper Pro test checkout uses this) deliver as
  // an order completion rather than a subscription event. Treat it as an
  // activation; the product filter still drops orders for other products.
  'order.completed': 'activate',
  'refund.succeeded': 'revoke',
};

/** @returns {'activate'|'extend'|'revoke'|'ignore'} */
export function classifyEvent(rawEventType) {
  return EVENT_ACTIONS[normalizeEventType(rawEventType)] || 'ignore';
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a period end into an ISO instant. Date-only values are pushed to the
 * end of that UTC day so a customer is not cut off hours early on renewal day.
 * @returns {string|null}
 */
export function normalizeExpiry(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const ms = value < 1e12 ? value * 1000 : value; // seconds vs milliseconds
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (DATE_ONLY_RE.test(trimmed)) return `${trimmed}T23:59:59.999Z`;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Pull the fulfillment-relevant fields out of a Waffo `data` object.
 * Waffo documents `buyerEmail`/`productName` (not `email`/`productId`), but we
 * read several plausible locations for the product id since it is not
 * documented and may live in metadata.
 */
export function extractOrder(data = {}) {
  const meta = data.productMetadata || data.orderMetadata || {};
  return {
    orderId: firstString(data.orderId, data.order_id, data.id),
    email: (firstString(data.buyerEmail, data.email, data.customerEmail) || '').toLowerCase() || null,
    productName: firstString(data.productName, data.product?.name, meta.productName),
    productId: firstString(data.productId, data.product?.id, meta.productId, data.orderMetadata?.productId),
    expiresAt: normalizeExpiry(data.currentPeriodEnd ?? data.current_period_end),
    currency: firstString(data.currency),
  };
}

/** Split a comma-separated env var into a trimmed, de-duplicated id list. */
export function parseProductIds(value) {
  return [...new Set((value || '').split(',').map((s) => s.trim()).filter(Boolean))];
}

/**
 * Decide whether an event belongs to our product.
 * - Explicit mismatch on a known productId/name -> reject.
 * - Unknown productId -> accept unless strict mode demands one (dropping a real
 *   paid order is worse than over-fulfilling a single-product store).
 * - `testProductIds` is an allowlist of Waffo test-mode product ids; they count
 *   as "ours" too, but the fulfillment marks them `isTest` (see capTestExpiry).
 */
export function productMatches(order = {}, { productId, productName, requireProductId = false, testProductIds = [] } = {}) {
  const allowed = [productId, ...(Array.isArray(testProductIds) ? testProductIds : [])].filter(Boolean);
  if (allowed.length && order.productId) return allowed.includes(order.productId);
  if (allowed.length && !order.productId && requireProductId) return false;
  if (productName) {
    if (!order.productName) return !requireProductId;
    return order.productName === productName;
  }
  return true;
}

/**
 * Detect Waffo Test Mode on an event. Waffo's exact marker is not documented,
 * so accept the several plausible shapes; only an explicit false/`test` counts
 * so a normal live event (fields absent) is never misread as a test.
 */
export function isTestEvent(event = {}) {
  const data = event && typeof event === 'object' ? event.data || {} : {};
  const looksTest = (o) => o && (o.test === true || o.mode === 'test' || o.livemode === false);
  return Boolean(looksTest(event) || looksTest(data));
}

export const MAX_MACHINES = 2;
export const TEST_LICENSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Test licenses must never be perpetual Pro. Cap the paid period at the test
 * TTL and, when the event carries no period at all, grant exactly the TTL.
 * @returns {string} ISO instant
 */
export function capTestExpiry(expiresAt, nowMs = Date.now(), ttlMs = TEST_LICENSE_TTL_MS) {
  const cap = new Date(nowMs + ttlMs).toISOString();
  if (!expiresAt) return cap;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return cap;
  return ms <= Date.parse(cap) ? expiresAt : cap;
}

export function machineCount(record) {
  return Array.isArray(record?.machines) ? record.machines.length : 0;
}

/**
 * Bind a machine id to a license record, enforcing the machine cap. Re-binding
 * a known machine just refreshes it; a new machine is rejected at capacity.
 * Pure: returns a fresh array, never mutates the input record.
 * @returns {{ok: boolean, reason?: string, machines: Array}}
 */
export function bindMachine(record = {}, machineId, nowIso, max = MAX_MACHINES) {
  const machines = Array.isArray(record.machines)
    ? record.machines.map((m) => ({ ...m }))
    : [];
  const existing = machines.find((m) => m.machineId === machineId);
  if (existing) {
    existing.lastSeenAt = nowIso;
    return { ok: true, alreadyBound: true, machines };
  }
  if (machines.length >= max) return { ok: false, reason: 'machine_limit', machines };
  machines.push({ machineId, boundAt: nowIso, lastSeenAt: nowIso });
  return { ok: true, added: true, machines };
}

/** Remove a machine from a license record. Pure; idempotent. */
export function unbindMachine(record = {}, machineId) {
  const all = Array.isArray(record.machines) ? record.machines : [];
  const machines = all.filter((m) => m.machineId !== machineId);
  return { ok: true, removed: machines.length !== all.length, machines };
}

export function isMachineBound(record, machineId) {
  return Array.isArray(record?.machines) && record.machines.some((m) => m.machineId === machineId);
}

/** Active = not revoked and not past its expiry. Missing expiry means perpetual. */
export function isActive(record, nowMs = Date.now()) {
  if (!record || record.status !== 'active') return false;
  if (!record.expiresAt) return true;
  const ms = Date.parse(record.expiresAt);
  if (Number.isNaN(ms)) return true; // unparseable -> fail open, same as no expiry
  return nowMs < ms;
}

/** The on-disk license.json contract the desktop Helper reads. */
export function buildLicenseJson({ code, email, orderId, expiresAt, isTest, machineId }, activatedAt) {
  const json = {
    pro: true,
    activated: true,
    key: code,
    activatedAt,
    expiresAt: expiresAt || null,
  };
  if (isTest) json.isTest = true;
  if (machineId) json.machineId = machineId;
  if (email) json.email = email;
  if (orderId) json.orderId = orderId;
  return json;
}
