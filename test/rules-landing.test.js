import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
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
  assert.match(page, /PROD_5qCcU0xjnJGxadJbWNXk0h/);
  assert.match(page, /id="demo"/);
  assert.match(page, /<video[^>]*class="demo-video"/);
  assert.match(page, /src="\/rules\/demo\.mp4"/);
  assert.match(page, /type="video\/mp4"/);
  assert.doesNotMatch(page, /not published yet/i);
  assert.doesNotMatch(page, /Placeholder/);
});

test('rules demo file is a playable mp4', () => {
  const file = new URL('../rules/demo.mp4', import.meta.url);
  const st = statSync(file);
  assert.ok(st.size > 100_000 && st.size < 8_000_000);
  const head = readFileSync(file).subarray(4, 8).toString('ascii');
  assert.equal(head, 'ftyp');
});

test('rules download CTAs use the public dist release', () => {
  const exe = 'https://github.com/1019666077-bit/botbridge-rules-dist/releases/download/v1.0.1/BotBridgeRules-Setup-1.0.1.exe';
  const zip = 'https://github.com/1019666077-bit/botbridge-rules-dist/releases/download/v1.0.1/BotBridgeRules-1.0.1-win-x64.zip';
  assert.ok(page.includes(`class="ghost" href="${exe}"`));
  assert.ok(page.includes(`class="cta" href="${exe}"`));
  assert.ok(page.includes(`class="pill" href="${exe}"`));
  assert.ok(page.includes(`class="pill" href="${zip}"`));
  assert.doesNotMatch(page, /github\.com\/1019666077-bit\/botbridge-rules\/releases/);
  assert.doesNotMatch(page, /botbridge\.dev\/downloads\/rules\//);
  assert.match(page, /Unsigned build/);
  assert.match(page, /SmartScreen/);
  assert.match(page, /More info → Run anyway/);
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
