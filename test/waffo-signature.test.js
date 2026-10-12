import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { parseSignatureHeader, normalizePem, verifyWebhookSignature } from '../lib/waffo-signature.js';

const NOW = Date.parse('2026-10-12T00:00:00Z');

function makeRsa(spki = true) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: spki ? 'spki' : 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function signHeader(privateKey, rawBody, t = Math.floor(NOW / 1000)) {
  const sig = createSign('RSA-SHA256').update(`${t}.${rawBody}`).sign(privateKey, 'base64');
  return `t=${t},v1=${sig}`;
}

test('parseSignatureHeader splits the t and v1 components', () => {
  assert.deepEqual(parseSignatureHeader('t=123,v1=abc'), { t: '123', v1: 'abc' });
});

test('parseSignatureHeader tolerates spacing and extra fields', () => {
  assert.deepEqual(parseSignatureHeader('t=123, v1=abc, extra=x'), { t: '123', v1: 'abc' });
});

test('parseSignatureHeader returns null on garbage', () => {
  for (const bad of ['', null, undefined, 'v1=only', 't=only', 'nonsense']) {
    assert.equal(parseSignatureHeader(bad), null, String(bad));
  }
});

test('normalizePem restores literal newlines from an env var', () => {
  const pem = normalizePem('-----BEGIN PUBLIC KEY-----\\nAAAA\\n-----END PUBLIC KEY-----');
  assert.ok(pem.includes('\n'));
  assert.ok(!pem.includes('\\n'));
});

test('normalizePem handles CRLF', () => {
  assert.ok(!normalizePem('-----BEGIN PUBLIC KEY-----\r\nAAAA\r\n-----END PUBLIC KEY-----').includes('\r'));
});

test('verifyWebhookSignature accepts a valid SPKI key signature', async () => {
  const { publicKey, privateKey } = makeRsa(true);
  const body = JSON.stringify({ eventType: 'subscription.activated' });
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(privateKey, body),
    rawBody: body,
    nowMs: NOW,
  });
  assert.equal(ok, true);
});

test('verifyWebhookSignature accepts a valid PKCS#1 key signature', async () => {
  const { publicKey, privateKey } = makeRsa(false);
  const body = JSON.stringify({ eventType: 'subscription.renewed' });
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(privateKey, body),
    rawBody: body,
    nowMs: NOW,
  });
  assert.equal(ok, true);
});

test('verifyWebhookSignature rejects a tampered body', async () => {
  const { publicKey, privateKey } = makeRsa(true);
  const body = JSON.stringify({ amount: 29 });
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(privateKey, body),
    rawBody: JSON.stringify({ amount: 0 }),
    nowMs: NOW,
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature rejects a signature from another key', async () => {
  const { publicKey } = makeRsa(true);
  const { privateKey: otherKey } = makeRsa(true);
  const body = '{}';
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(otherKey, body),
    rawBody: body,
    nowMs: NOW,
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature rejects a stale timestamp', async () => {
  const { publicKey, privateKey } = makeRsa(true);
  const body = '{}';
  const stale = Math.floor((NOW - 60 * 60 * 1000) / 1000);
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(privateKey, body, stale),
    rawBody: body,
    nowMs: NOW,
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature rejects a timestamp too far in the future', async () => {
  const { publicKey, privateKey } = makeRsa(true);
  const body = '{}';
  const future = Math.floor((NOW + 10 * 60 * 1000) / 1000);
  const ok = await verifyWebhookSignature({
    publicKeyPem: publicKey,
    header: signHeader(privateKey, body, future),
    rawBody: body,
    nowMs: NOW,
  });
  assert.equal(ok, false);
});

test('verifyWebhookSignature returns false on malformed input instead of throwing', async () => {
  const { publicKey } = makeRsa(true);
  for (const header of ['', 'nonsense', 't=123']) {
    assert.equal(
      await verifyWebhookSignature({ publicKeyPem: publicKey, header, rawBody: '{}', nowMs: NOW }),
      false,
      header,
    );
  }
  assert.equal(await verifyWebhookSignature({ publicKeyPem: 'not a key', header: 't=1,v1=x', rawBody: '{}', nowMs: NOW }), false);
});
