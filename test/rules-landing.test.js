import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../rules/index.html', import.meta.url), 'utf8');
const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('rules landing states the RFP panel, workflow, and prices in English', () => {
  assert.match(page, /standing rules panel for RFP and proposal experts/i);
  assert.match(page, /Sample → Rules/);
  assert.match(page, /Execute drafts/);
  assert.match(page, /Check = gaps only/);
  assert.match(page, /The panel does not edit Word/);
  assert.match(page, /reusable across bids/i);
  assert.match(page, /\$79\/year/);
  assert.match(page, /\$149\/year/);
  assert.match(page, /early bird/i);
  assert.match(page, /list price/i);
  assert.doesNotMatch(page, /\$29/);
  assert.match(page, /https:\/\/github\.com\/1019666077-bit\/botbridge-rules\/releases/);
  assert.match(page, /PROD_5qCcU0xjnJGxadJbWNXk0h/);
  assert.match(page, /id="demo"/);
  assert.match(page, /Demo video/);
  assert.match(page, /not published yet/i);
});

test('homepage Rules card uses the early-bird price and drops $29', () => {
  const start = home.indexOf('Bot Bridge Rules');
  const end = home.indexOf('Webcam Bridge');
  assert.ok(start > 0 && end > start);
  const card = home.slice(start, end);
  assert.match(card, /RFP and proposal experts/);
  assert.match(card, /\$79\/year/);
  assert.doesNotMatch(card, /\$29/);
});
