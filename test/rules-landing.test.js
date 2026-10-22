import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../rules/index.html', import.meta.url), 'utf8');
const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('rules landing sells detailed rules, and does not invent panel buttons', () => {
  const lead = page.match(/<p class="lead">([\s\S]*?)<\/p>/)[1];
  assert.match(lead, /The panel adds, edits, and deletes standing rules\./);
  assert.match(lead, /layout check can pass/);
  assert.match(lead, /APA 7/);
  assert.doesNotMatch(lead, /does not open Word/);
  assert.match(page, /The panel only stores and manages your rules\./);
  assert.match(page, /Check only lists gaps/);
  assert.match(page, /The panel has no Check or Execute button/);
  assert.match(page, /does not open Word/);
  assert.match(page, /does not accept a <code>\.docx<\/code>/);
  assert.match(page, /chat command/i);
  assert.match(page, /Execute/);
  assert.match(page, /Check/);
  assert.match(page, /never receive your <code>\.docx<\/code>/);
  assert.match(page, /add, edit, and delete rules/i);
  assert.match(page, /school's or advisor's house style/i);
  assert.match(page, /CC Helper/);
  assert.match(page, /Webcam/);
  assert.match(page, /APA 7/);
  assert.match(page, /\$79\/year/);
  assert.match(page, /\$149\/year/);
  assert.doesNotMatch(page, /8 layout checks failed/);
  assert.doesNotMatch(page, /0 gaps after/i);
  assert.doesNotMatch(page, /<td>✗<\/td>/);
  assert.doesNotMatch(page, /RFP/i);
  assert.doesNotMatch(page, /proposal/i);
  assert.doesNotMatch(page, /\$29/);
  assert.doesNotMatch(page, /<button[^>]*>\s*(Check|Execute)/i);
});

test('rules demo embeds the YouTube video responsively and links to youtu.be', () => {
  assert.match(page, /id="demo"/);
  assert.match(page, /<div class="demo-embed">/);
  assert.match(page, /<iframe[\s\S]*src="https:\/\/www\.youtube\.com\/embed\/eC34tcHyzcY"/);
  assert.match(page, /allowfullscreen/);
  assert.match(page, /https:\/\/youtu\.be\/eC34tcHyzcY/);
  assert.doesNotMatch(page, /<video/);
  assert.doesNotMatch(page, /rules-demo\.mp4/);
});

test('rules page metadata and social cards point at the APA 7 landing', () => {
  assert.match(page, /<title>Bot Bridge Rules · Standing rules your assistant can follow<\/title>/);
  assert.match(page, /<link rel="canonical" href="https:\/\/botbridge\.dev\/rules\/" \/>/);
  assert.match(page, /<meta property="og:type" content="website" \/>/);
  assert.match(page, /<meta property="og:url" content="https:\/\/botbridge\.dev\/rules\/" \/>/);
  assert.match(page, /<meta property="og:title" content="Bot Bridge Rules · Standing rules your assistant can follow" \/>/);
  assert.match(page, /<meta property="og:image" content="https:\/\/i\.ytimg\.com\/vi\/eC34tcHyzcY\/hqdefault\.jpg" \/>/);
  assert.match(page, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(page, /<meta name="description" content="[^"]*APA 7[^"]*"/);
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

test('pricing keeps the early-bird Waffo checkout and the claim flow', () => {
  assert.match(page, /\$79\/year/);
  assert.match(page, /\$149\/year/);
  assert.match(page, /early bird/i);
  assert.match(page, /list price/i);
  const checkout =
    'https://pancake.waffo.ai/store/moying-e3keic1t/product/PROD_5qCcU0xjnJGxadJbWNXk0h?type=subscription&amp;currency=USD';
  assert.ok(page.includes(checkout), 'checkout link is escaped and unchanged');
  assert.match(page, /href="\/rules\/success\/"/);
  assert.match(page, /One key binds up to 3 machines/);
});

test('homepage Rules card leads with editing rules, not a Word caveat', () => {
  const start = home.indexOf('Bot Bridge Rules');
  const end = home.indexOf('Webcam Bridge');
  assert.ok(start > 0 && end > start);
  const card = home.slice(start, end);
  assert.match(card, /Add, edit, and delete/);
  assert.match(card, /APA 7/);
  assert.match(card, /\$79\/year/);
  assert.match(card, /layout check/);
  assert.doesNotMatch(card, /does not open Word/);
  assert.doesNotMatch(card, /RFP/i);
  assert.doesNotMatch(card, /\$29/);
  assert.match(home, /CC Helper/);
  assert.match(home, /Bark/);
  assert.match(home, /Obsidian Bridge/);
  assert.match(home, /App Bridge/);
  assert.match(home, /个体工商户/);
});
