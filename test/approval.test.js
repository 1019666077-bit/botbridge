import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleApprovalCreate, handleApprovalPoll, handleApprovalAnswer } from '../worker.js';
import { mintCode } from '../lib/cch-code.js';
import { normalizeScreenshot, MAX_SCREENSHOT_BYTES } from '../lib/approval-logic.js';
import { makeEnv, jsonReq, seedBoundLicense, signedRequest, event } from './helpers.js';

const APPROVE_PAGE = 'https://botbridge.dev/cc-helper/approve';
const ANSWER_PATH = '/api/pro/approval/answer';

function approvalReq(body, headers = {}) {
  return new Request('https://botbridge.dev/api/pro/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function pageReq(token) {
  return new Request(`${APPROVE_PAGE}?t=${encodeURIComponent(token)}`);
}

function answerReq(token, action) {
  return new Request(`https://botbridge.dev${ANSWER_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: token, action }).toString(),
  });
}

function pollReq(token, code, machineId) {
  return new Request(
    `https://botbridge.dev/api/pro/approval?t=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}&machineId=${encodeURIComponent(machineId)}`,
  );
}

/** Create an approval through the real handler and return its body. */
async function createApproval(env, { code, machineId = 'm1', taskId = 'task_1', title = 'Approve the quarterly report', ...rest } = {}) {
  const res = await handleApprovalCreate(approvalReq({ code, machineId, taskId, title, ...rest }), env);
  assert.equal(res.status, 200, 'approval creation should succeed');
  return res.json();
}

// ---------------------------------------------------------------------------
// POST /api/pro/approval — create
// ---------------------------------------------------------------------------

test('approval mints an opaque token and stores a 24h pending record', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const before = Date.now();

  // Through the router, so this also covers dispatch of POST /api/pro/approval.
  const res = await worker.fetch(
    approvalReq({ code, machineId: 'm1', taskId: 'task_1', title: 'Approve the quarterly report' }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.match(body.token, /^[A-Za-z0-9_-]{20,}$/, 'token is opaque and URL-safe');
  assert.equal(body.approveUrl, `${APPROVE_PAGE}?t=${body.token}`);
  assert.equal(
    body.pollUrl,
    `https://botbridge.dev/api/pro/approval?t=${encodeURIComponent(body.token)}&code=${encodeURIComponent(code)}&machineId=m1`,
  );

  const record = await env.LICENSES.get(`approval:${body.token}`, 'json');
  assert.equal(record.status, 'pending');
  assert.equal(record.code, code);
  assert.equal(record.machineId, 'm1');
  assert.equal(record.taskId, 'task_1');
  assert.equal(record.title, 'Approve the quarterly report');
  assert.equal(record.answeredAt, null);

  const ttlMs = Date.parse(record.expiresAt) - before;
  assert.ok(ttlMs > 23.5 * 3600 * 1000 && ttlMs <= 24 * 3600 * 1000 + 5000, `24h ttl, got ${ttlMs}`);
});

test('approval is refused unless the license is active and bound to the calling machine', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const body = { machineId: 'm1', taskId: 'task_1', title: 'Do the thing' };

  const unbound = await handleApprovalCreate(approvalReq({ ...body, code, machineId: 'never-seen' }), env);
  assert.equal(unbound.status, 403);
  assert.equal((await unbound.json()).error, 'machine_not_bound');

  const unknown = await handleApprovalCreate(approvalReq({ ...body, code: mintCode() }), env);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'unknown_code');

  const malformed = await handleApprovalCreate(approvalReq({ ...body, code: 'not-a-code' }), env);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_code');

  await handleApprovalCreate(approvalReq({ ...body, code }), env); // sanity: valid before refund
  const refund = signedRequest(event('refund.succeeded', { orderId: 'ord_1' }, { id: 'evt_refund_approval' }));
  assert.equal((await worker.fetch(refund, env)).status, 200);

  const revoked = await handleApprovalCreate(approvalReq({ ...body, code }), env);
  assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).error, 'inactive');
});

test('approval requires a task id, a title and a machine id', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const base = { code, machineId: 'm1', taskId: 'task_1', title: 'Do the thing' };

  assert.equal((await (await handleApprovalCreate(approvalReq({ ...base, taskId: '' }), env)).json()).error, 'missing_task_id');
  assert.equal((await (await handleApprovalCreate(approvalReq({ ...base, title: '   ' }), env)).json()).error, 'missing_title');
  assert.equal((await (await handleApprovalCreate(approvalReq({ ...base, machineId: '' }), env)).json()).error, 'missing_machine_id');
  assert.equal(
    (await (await handleApprovalCreate(approvalReq({ ...base, title: 'x'.repeat(300) }), env)).json()).error,
    'invalid_title',
  );
  assert.equal(
    (await (await handleApprovalCreate(approvalReq({ ...base, taskId: 'x'.repeat(300) }), env)).json()).error,
    'invalid_task_id',
  );
});

test('approval rejects an oversized screenshot but accepts a small one', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const base = { code, machineId: 'm1', taskId: 'task_1', title: 'Do the thing' };

  const oversized = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString('base64');
  const tooBig = await handleApprovalCreate(approvalReq({ ...base, screenshotBase64: oversized }), env);
  assert.equal(tooBig.status, 400);
  assert.equal((await tooBig.json()).error, 'screenshot_too_large');

  const small = Buffer.from('PNG-ish bytes').toString('base64');
  const { token } = await createApproval(env, { ...base, screenshotBase64: small });
  const shot = await env.LICENSES.get(`approval:${token}:shot`);
  assert.ok(shot && shot.startsWith('data:image/'), 'the small screenshot is stored as a data URL');
});

test('approval prefers a screenshot URL over base64 and rejects a non-http one', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const base = { code, machineId: 'm1', taskId: 'task_1', title: 'Do the thing' };
  const small = Buffer.from('bytes').toString('base64');

  const { token } = await createApproval(env, {
    ...base,
    screenshotUrl: 'https://cdn.example.com/shot.png',
    screenshotBase64: small,
  });
  const record = await env.LICENSES.get(`approval:${token}`, 'json');
  assert.equal(record.screenshotUrl, 'https://cdn.example.com/shot.png');
  assert.equal(record.hasScreenshot, false, 'base64 is ignored when a URL is given');
  assert.equal(await env.LICENSES.get(`approval:${token}:shot`), null);

  const bad = await handleApprovalCreate(approvalReq({ ...base, screenshotUrl: 'javascript:alert(1)' }), env);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_screenshot_url');
});

test('normalizeScreenshot accepts exactly the byte cap and rejects one byte over', () => {
  const atCap = Buffer.alloc(MAX_SCREENSHOT_BYTES).toString('base64');
  const overCap = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1).toString('base64');
  assert.equal(normalizeScreenshot({ screenshotBase64: atCap }).ok, true);
  assert.equal(normalizeScreenshot({ screenshotBase64: overCap }).ok, false);
  assert.equal(normalizeScreenshot({ screenshotBase64: overCap }).error, 'screenshot_too_large');
  assert.deepEqual(normalizeScreenshot({}), { ok: true, screenshotUrl: null, dataUrl: null });
});

test('approval throttles repeated requests from one IP', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const res = await handleApprovalCreate(
      approvalReq({ code, machineId: 'm1', taskId: `task_${i}`, title: 'x' }, { 'cf-connecting-ip': '203.0.113.7' }),
      env,
    );
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'one IP cannot mint approvals without bound');
});

test('approval throttles repeated requests for one license code across IPs', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const res = await handleApprovalCreate(
      approvalReq({ code, machineId: 'm1', taskId: `task_${i}`, title: 'x' }, { 'cf-connecting-ip': `198.51.100.${i}` }),
      env,
    );
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'a single code cannot be hammered from many IPs');
});

test('approval logs the order and a code hint but never the full code or title', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await createApproval(env, { code, title: 'Transfer the savings' });
  } finally {
    console.log = original;
  }
  const joined = lines.join('\n');
  assert.ok(joined.includes('license.approval'), 'logs a structured approval event');
  assert.ok(joined.includes('ord_1'), 'logs the order id for support');
  assert.ok(joined.includes(code.slice(-4)), 'logs the code hint');
  assert.ok(!joined.includes(code), 'never logs the full license code');
  assert.ok(!joined.includes('Transfer the savings'), 'never logs the task title');
});

// ---------------------------------------------------------------------------
// GET /api/pro/approval — Helper poll
// ---------------------------------------------------------------------------

test('poll reports pending until the owner answers, then approved', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  const pending = await handleApprovalPoll(new Request(created.pollUrl), env);
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).status, 'pending');

  const answered = await handleApprovalAnswer(answerReq(created.token, 'approve'), env);
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /approved/i);

  const after = await handleApprovalPoll(new Request(created.pollUrl), env);
  assert.equal((await after.json()).status, 'approved');
});

test('an approval answer is single-use: the first answer stands', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  assert.equal((await handleApprovalAnswer(answerReq(created.token, 'approve'), env)).status, 200);
  const second = await handleApprovalAnswer(answerReq(created.token, 'cancel'), env);
  assert.equal(second.status, 200);
  assert.match(await second.text(), /already/i, 'a second answer is told it lost the race');

  assert.equal((await (await handleApprovalPoll(new Request(created.pollUrl), env)).json()).status, 'approved');
});

test('cancelling an approval reports cancelled to the Helper', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  const res = await handleApprovalAnswer(answerReq(created.token, 'cancel'), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /cancel/i);
  assert.equal((await (await handleApprovalPoll(new Request(created.pollUrl), env)).json()).status, 'cancelled');
});

test('poll requires a token and rejects a license/machine that does not own the approval', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  const noToken = await handleApprovalPoll(new Request('https://botbridge.dev/api/pro/approval'), env);
  assert.equal(noToken.status, 400);
  assert.equal((await noToken.json()).error, 'missing_token');

  const wrongCode = await handleApprovalPoll(pollReq(created.token, mintCode(), 'm1'), env);
  assert.equal(wrongCode.status, 404);

  const wrongMachine = await handleApprovalPoll(pollReq(created.token, code, 'another-machine'), env);
  assert.equal(wrongMachine.status, 404);

  const owner = await handleApprovalPoll(pollReq(created.token, code, 'm1'), env);
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).status, 'pending');
});

test('poll reports expired for an unknown token and for one past its 24h window', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  const unknown = await handleApprovalPoll(pollReq('no-such-token', code, 'm1'), env);
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).status, 'expired');

  const record = await env.LICENSES.get(`approval:${created.token}`, 'json');
  await env.LICENSES.put(
    `approval:${created.token}`,
    JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }),
  );
  const aged = await handleApprovalPoll(pollReq(created.token, code, 'm1'), env);
  assert.equal((await aged.json()).status, 'expired');
});

test('poll is rate-limited lightly rather than not at all', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });
  let limited = false;
  for (let i = 0; i < 400; i++) {
    const res = await handleApprovalPoll(pollReq(created.token, code, 'm1'), env);
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'unbounded polling must eventually be throttled');
});

// ---------------------------------------------------------------------------
// GET /cc-helper/approve — the phone-facing page
// ---------------------------------------------------------------------------

test('the approve page shows the task, both actions and a mobile viewport', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code, title: 'Approve the $20 refund' });

  const res = await worker.fetch(pageReq(created.token), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Approve the \$20 refund/);
  assert.match(html, /viewport/);
  assert.match(html, /Continue/);
  assert.match(html, /Cancel/);
  assert.match(html, new RegExp(created.token));
  assert.match(html, /\/api\/pro\/approval\/answer/);
});

test('the approve page shows the screenshot it was given', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code, screenshotUrl: 'https://cdn.example.com/shot.png' });
  const html = await (await worker.fetch(pageReq(created.token), env)).text();
  assert.match(html, /<img[^>]+src="https:\/\/cdn\.example\.com\/shot\.png"/);
});

test('the approve page escapes a hostile task title', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code, title: '<script>alert(1)</script>' });
  const html = await (await worker.fetch(pageReq(created.token), env)).text();
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw title must never reach the page');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the approve page explains an expired or unknown link and offers support', async () => {
  const env = makeEnv();
  const unknown = await worker.fetch(pageReq('no-such-token'), env);
  assert.equal(unknown.status, 404);
  const unknownHtml = await unknown.text();
  assert.match(unknownHtml, /expired|not valid/i);
  assert.match(unknownHtml, /moying\.studio@outlook\.com/);

  const missing = await worker.fetch(new Request(APPROVE_PAGE), env);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /moying\.studio@outlook\.com/);
});

test('the approve page shows a done state once the task has been answered', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });
  await handleApprovalAnswer(answerReq(created.token, 'approve'), env);

  const res = await worker.fetch(pageReq(created.token), env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /approved/i);
  assert.ok(!html.includes('Continue'), 'an answered link must not offer the buttons again');
});

// ---------------------------------------------------------------------------
// POST /api/pro/approval/answer — the button action
// ---------------------------------------------------------------------------

test('answering refuses an unknown action, a missing token and an expired link', async () => {
  const env = makeEnv();
  const code = await seedBoundLicense(env);
  const created = await createApproval(env, { code });

  const badAction = await handleApprovalAnswer(answerReq(created.token, 'delete-everything'), env);
  assert.equal(badAction.status, 400);

  const noToken = await handleApprovalAnswer(answerReq('', 'approve'), env);
  assert.equal(noToken.status, 400);

  const record = await env.LICENSES.get(`approval:${created.token}`, 'json');
  await env.LICENSES.put(
    `approval:${created.token}`,
    JSON.stringify({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }),
  );
  const expired = await handleApprovalAnswer(answerReq(created.token, 'approve'), env);
  assert.equal(expired.status, 404);
  assert.match(await expired.text(), /moying\.studio@outlook\.com/);
});

test('router: approval endpoints are method-checked and the page is served by the worker', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request(APPROVE_PAGE, { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request(`https://botbridge.dev${ANSWER_PATH}`), env)).status, 405);
  assert.equal(
    (await worker.fetch(new Request('https://botbridge.dev/api/pro/approval', { method: 'PUT' }), env)).status,
    405,
  );
  // The page path must not fall through to the ASSETS binding (which answers "asset").
  const page = await worker.fetch(pageReq('no-such-token'), env);
  assert.notEqual(await page.text(), 'asset');
});
