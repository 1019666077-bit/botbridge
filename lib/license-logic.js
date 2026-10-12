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

/**
 * Decide whether an event belongs to our product.
 * - Explicit mismatch on a known productId/name -> reject.
 * - Unknown productId -> accept unless strict mode demands one (dropping a real
 *   paid order is worse than over-fulfilling a single-product store).
 */
export function productMatches(order = {}, { productId, productName, requireProductId = false } = {}) {
  if (productId && order.productId) return order.productId === productId;
  if (productId && !order.productId && requireProductId) return false;
  if (productName) {
    if (!order.productName) return !requireProductId;
    return order.productName === productName;
  }
  return true;
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
export function buildLicenseJson({ code, email, orderId, expiresAt }, activatedAt) {
  const json = {
    pro: true,
    activated: true,
    key: code,
    activatedAt,
    expiresAt: expiresAt || null,
  };
  if (email) json.email = email;
  if (orderId) json.orderId = orderId;
  return json;
}
