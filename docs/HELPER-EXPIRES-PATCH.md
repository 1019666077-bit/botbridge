# 桌面 Helper：`license.json` 到期字段补丁说明

> 桌面 Helper 源码**不在任何公开仓**（在离线的 Windows 笔记本上），本仓无法直接改。
> 本文件给出精确契约与补丁草图，供在笔记本上手动落地。
> 目标路径：`C:\Users\MOON\cc-helper\daemon.js`（按本机实际路径调整）。
>
> 本次补丁三件事：① `license.json` 增加 `expiresAt`（到期即失效）；
> ② 激活码进入时**在线激活**，把本机绑定到服务端（一码最多 2 台机器）；
> ③ 每 3 天在线复验，离线最多宽限 7 天；并支持解绑换机。

## 1. `license.json` 契约

现状（Helper 写出、Helper 读回）：

```json
{ "pro": true, "activated": true, "key": "CCH-XXXX-XXXX-CSUM", "activatedAt": "2026-10-12T00:00:00.000Z" }
```

**没有 `expiresAt`** ⇒ 订阅年费到期后 Helper 仍认为是 Pro。这是本次要补的洞。

新增（向后兼容，字段只增不改）：

```json
{
  "pro": true,
  "activated": true,
  "key": "CCH-XXXX-XXXX-CSUM",
  "activatedAt": "2026-10-12T00:00:00.000Z",
  "expiresAt": "2027-10-12T23:59:59.999Z",
  "isTest": false,
  "machineId": "…32-hex…",
  "lastValidatedAt": "2026-10-12T00:00:00.000Z",
  "email": "buyer@example.com",
  "orderId": "ord_123"
}
```

- `expiresAt`：ISO 8601 UTC，来自 Worker（Waffo 的 `currentPeriodEnd`，日期型会被推到当天 `23:59:59.999Z`）。
- `isTest`：来自 Waffo Test Mode 的订单/测试商品，**只给 7 天**，Helper 可在 UI 上标注“测试授权”。
- `machineId`：本机匿名标识，服务端激活时绑定。
- `lastValidatedAt`：最近一次在线复验成功的时间，用于 7 天离线宽限。
- `email` / `orderId`：便于对账，可选；Helper 逻辑不必依赖。
- **老 `license.json` 没有 `expiresAt` 时必须仍然判为 Pro**（兼容历史用户与演示码）。

## 2. `daemon.js` 补丁草图

### 2.1 `isPro` 加到期判断

```js
// 旧：只看 pro/activated
// function isPro() { const l = readLicense(); return !!(l && l.pro && l.activated); }

function isPro(now = Date.now()) {
  const lic = readLicense();               // 读 license.json
  if (!lic || !lic.pro || !lic.activated) return false;
  if (!lic.expiresAt) return true;         // 无到期字段 ⇒ 永久（兼容旧码/演示码）
  const ms = Date.parse(lic.expiresAt);
  if (Number.isNaN(ms)) return true;       // 解析不了就按永久，宁可放行
  return now < ms;
}
```

调用点（托盘菜单项、预算硬顶、stall kill、推送）凡是用到 `isPro()` 的地方都不用改签名，
默认参数已带 `now`。

### 2.2 在线激活（用户输入激活码时）

Worker 新增机器绑定接口，一个码最多绑 **2** 台机器（服务端强制，见 `worker.js`
的 `bindMachine` / `MAX_MACHINES`）。Helper 进入激活码时要**联网激活**，而不是只做本地校验。

先算一个**稳定匿名 machineId**（同一台机器重启后不变，别用随机数）：

```js
const crypto = require('crypto');
function machineId() {
  // 只取本机可复现的信息，不回传任何个人数据
  const seed = [require('os').hostname(), require('os').userInfo().username, require('os').platform()].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
```

激活：

```js
async function activate(code, machineName = '') {
  const key = String(code || '').trim().toUpperCase();
  if (!verifyCch(key) && !whitelisted(key)) throw new Error('invalid_code'); // 见第 3 节校验和

  const res = await fetch('https://botbridge.dev/api/pro/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code: key, machineId: machineId(), machineName }),
  });
  const info = await res.json().catch(() => ({}));

  if (res.status === 409) throw new Error('machine_limit'); // 已绑 2 台，去领取页解绑
  if (res.status === 403) throw new Error('inactive');      // 已退款/过期
  if (res.status === 404) throw new Error('unknown_code');
  if (!res.ok) throw new Error('activate_failed');

  // 服务端返回的 licenseJson 已含 expiresAt / isTest / machineId
  writeLicense({ ...info.licenseJson, lastValidatedAt: new Date().toISOString() });
}
```

`409 machine_limit` 时提示用户到 `https://botbridge.dev/cc-helper/success/`
输入邮箱+订单号，在「Activated on」里解绑一台旧机器再试。

自助领码页下载的 `license.json`（`GET /api/license/claim`）同样带 `expiresAt`，
用户直接覆盖文件也可用；那种情况下 Helper 首次 `validate` 返回
`machine_not_bound`，于是调用一次 `activate` 补绑即可（见 2.3）。

### 2.3 定期在线复验 + 7 天离线宽限

- **复验节奏**：启动时一次，之后每 **3 天**（或 72h）一次。
- **离线宽限**：网络失败时，只要距上次成功复验不超过 **7 天**，仍按 Pro 放行；
  超过 7 天必须联网复验成功，否则降级为免费。

`license.json` 增加 `lastValidatedAt`（每次复验成功写当前时间）。

```js
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REVALIDATE_MS = 3 * 24 * 60 * 60 * 1000;

async function revalidate() {
  const lic = readLicense();
  if (!lic || !lic.key) return;
  try {
    const res = await fetch('https://botbridge.dev/api/pro/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: lic.key, machineId: machineId() }),
    });
    const info = await res.json().catch(() => ({}));

    if (info.valid) {
      writeLicense({ ...lic, pro: true, activated: true, expiresAt: info.expiresAt || lic.expiresAt,
                     isTest: !!info.isTest, lastValidatedAt: new Date().toISOString() });
      return;
    }
    if (info.reason === 'machine_not_bound') { await activate(lic.key).catch(() => {}); return; }
    // revoked / expired / unknown_code：立即降级
    writeLicense({ ...lic, pro: false, activated: false });
  } catch {
    /* 离线：不改写 license.json，由 isPro() 的 7 天宽限兜底 */
  }
}
// 启动时跑一次，之后 setInterval(revalidate, REVALIDATE_MS)
```

`isPro()` 因此要同时看 **到期** 与 **离线宽限**：

```js
function isPro(now = Date.now()) {
  const lic = readLicense();
  if (!lic || !lic.pro || !lic.activated) return false;
  if (lic.expiresAt) {
    const exp = Date.parse(lic.expiresAt);
    if (!Number.isNaN(exp) && now >= exp) return false;
  }
  if (lic.lastValidatedAt) {
    const last = Date.parse(lic.lastValidatedAt);
    if (!Number.isNaN(last) && now >= last + OFFLINE_GRACE_MS) return false; // 宽限用尽，需联网
  }
  return true; // 无 expiresAt 且从未联网复验 ⇒ 兼容旧码/演示码
}
```

### 2.4 解绑（换机）

Helper 设置页放一个「解除本机绑定」，或在领码页操作：

```js
async function deactivate() {
  const lic = readLicense();
  if (!lic || !lic.key) return;
  await fetch('https://botbridge.dev/api/pro/deactivate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: lic.key, machineId: machineId() }),
  });
  writeLicense({ ...lic, pro: false, activated: false });
}
```

## 3. 两个必须对齐的点

1. **到期语义**：Worker 侧 `isActive` 与 Helper 侧 `isPro` 规则一致——
   `status==='active'` 且（无 `expiresAt` 或 `now < expiresAt`）。
2. **校验和算法**：Helper 既有的 `CCH-XXXX-XXXX-CSUM` 具体校验算法未公开，Worker 侧
   (`lib/cch-code.js`) 用的是自洽的 FNV-1a/32 → Crockford base32 四位校验。
   若 Helper 用**自己的算法**校验 CSUM，会拒绝 Worker 发的码。二选一：
   - 在 Helper 里放宽：服务端发的码只要格式对就接受（推荐，最省事）；或
   - 把 Worker 的 `checksumFor()` 逐字符对齐到 Helper 的实现（需要笔记本上的源码）。

   在本机无法验证 Helper 的算法，**这一步必须等能碰到笔记本源码的人来做**。
   未来的强防伪方案（Ed25519 签名码，参考 CullGrid 的 `license:issue`）另行设计，
   本次**不**往仓库里塞任何私钥。
