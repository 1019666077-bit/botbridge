import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../cc-helper/index.html', import.meta.url), 'utf8');

test('CC Helper landing leads with dispatch, phone approve, and Bark screenshots', () => {
  const lead = page.match(/<p class="lead">([\s\S]*?)<\/p>/)[1];
  assert.match(lead, /inbox/);
  assert.match(lead, /DeepSeek/);
  assert.match(lead, /approve or cancel/);
  assert.match(lead, /Bark/);
  assert.match(page, /\$29\/year/);
  assert.match(page, /screenshot/);
  assert.match(page, /Hard budget caps|hard token budget/);
  assert.match(page, /Up to 3 in parallel \+ auto-retry/);
  assert.match(page, /One-tap phone approve \/ cancel/);
  assert.match(page, /not Anthropic Remote Control/);
  assert.doesNotMatch(page, /Check or Execute button/);
});
