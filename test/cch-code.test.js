import test from 'node:test';
import assert from 'node:assert/strict';
import { mintCode, verifyCode, CODE_RE } from '../lib/cch-code.js';

// Deterministic RNG helper: yields the given byte sequence, cycling.
function seqRng(bytes) {
  let i = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = bytes[i++ % bytes.length];
    return out;
  };
}

test('mintCode returns the CCH-XXXX-XXXX-CSUM shape', () => {
  const code = mintCode({ rng: seqRng([0, 1, 2, 3, 4, 5, 6, 7]) });
  assert.match(code, CODE_RE);
  assert.match(code, /^CCH-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
});

test('mintCode is deterministic for a fixed RNG', () => {
  const bytes = [10, 20, 30, 40, 50, 60, 70, 80];
  assert.equal(mintCode({ rng: seqRng(bytes) }), mintCode({ rng: seqRng(bytes) }));
});

test('mintCode produces different codes for different RNG output', () => {
  const a = mintCode({ rng: seqRng([0, 0, 0, 0, 0, 0, 0, 0]) });
  const b = mintCode({ rng: seqRng([1, 2, 3, 4, 5, 6, 7, 8]) });
  assert.notEqual(a, b);
});

test('verifyCode accepts the Helper-shipped demo code', () => {
  const res = verifyCode('CCH-DEMO-7K2M-CCB9');
  assert.equal(res.valid, true);
  assert.equal(res.code, 'CCH-DEMO-7K2M-CCB9');
});

test('verifyCode checksums the body groups only (no prefix, no hyphens)', () => {
  // Same body groups, wrong trailing group: the prefix and hyphens must not
  // feed the hash, and any other checksum must be rejected.
  assert.equal(verifyCode('CCH-DEMO-7K2M-0000').valid, false);
  assert.equal(verifyCode('CCH-DEMO-7K2M-CCB8').valid, false);
});

test('verifyCode accepts a freshly minted code', () => {
  const code = mintCode({ rng: seqRng([7, 14, 21, 28, 35, 42, 49, 56]) });
  const res = verifyCode(code);
  assert.equal(res.valid, true);
  assert.equal(res.code, code);
});

test('verifyCode is case-insensitive and ignores surrounding whitespace', () => {
  const code = mintCode({ rng: seqRng([3, 6, 9, 12, 15, 18, 21, 24]) });
  assert.equal(verifyCode(`  ${code.toLowerCase()}  `).valid, true);
});

test('verifyCode rejects a tampered checksum', () => {
  const code = mintCode({ rng: seqRng([1, 1, 1, 1, 1, 1, 1, 1]) });
  const parts = code.split('-');
  const badChar = parts[3][0] === 'Z' ? 'Y' : 'Z';
  const tampered = `${parts[0]}-${parts[1]}-${parts[2]}-${badChar}${parts[3].slice(1)}`;
  assert.equal(verifyCode(tampered).valid, false);
});

test('verifyCode rejects a tampered payload group', () => {
  const code = mintCode({ rng: seqRng([2, 4, 6, 8, 10, 12, 14, 16]) });
  const parts = code.split('-');
  const badChar = parts[1][0] === 'Z' ? 'Y' : 'Z';
  const tampered = `${parts[0]}-${badChar}${parts[1].slice(1)}-${parts[2]}-${parts[3]}`;
  assert.equal(verifyCode(tampered).valid, false);
});

test('verifyCode rejects malformed codes', () => {
  for (const bad of ['', 'CCH', 'CCH-AAAA-BBBB', 'XXX-AAAA-BBBB-CCCC', 'CCH-AAA-BBBB-CCCC', 'CCH-AAAA-BBBB-CCC', 'CCH-AAAA-BBBB-CCCI']) {
    assert.equal(verifyCode(bad).valid, false, `expected invalid: ${bad}`);
  }
});

test('verifyCode reports a reason on failure', () => {
  const res = verifyCode('nope');
  assert.equal(res.valid, false);
  assert.equal(typeof res.reason, 'string');
});
