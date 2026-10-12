# 桌面 Helper：`license.json` 到期字段补丁说明

> 桌面 Helper 源码**不在任何公开仓**（在离线的 Windows 笔记本上），本仓无法直接改。
> 本文件给出精确契约与补丁草图，供在笔记本上手动落地。
> 目标路径：`C:\Users\MOON\cc-helper\daemon.js`（按本机实际路径调整）。

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
  "email": "buyer@example.com",
  "orderId": "ord_123"
}
```

- `expiresAt`：ISO 8601 UTC，来自 Worker（Waffo 的 `currentPeriodEnd`，日期型会被推到当天 `23:59:59.999Z`）。
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

### 2.2 激活时写入 `expiresAt`

`POST /api/pro/activate` 目前只接 `{code}`。改成同时也接受 `{expiresAt, email, orderId}`，
并在缺 `expiresAt` 时回源查询 Worker：

```js
async function activate(code, extra = {}) {
  const key = String(code || '').trim().toUpperCase();
  if (!verifyCch(key) && !whitelisted(key)) throw new Error('invalid_code');

  let { expiresAt = null, email = null, orderId = null } = extra;

  if (!expiresAt) {
    try {
      const res = await fetch(
        'https://botbridge.dev/api/license/lookup?code=' + encodeURIComponent(key),
        { headers: { accept: 'application/json' } }
      );
      const info = await res.json();
      if (info && info.valid === false && info.status === 'revoked') throw new Error('revoked');
      if (info && info.expiresAt) expiresAt = info.expiresAt;
    } catch (err) {
      // 离线/网络失败：先存码，下次联网再补 expiresAt（见 2.3）
    }
  }

  writeLicense({
    pro: true,
    activated: true,
    key,
    activatedAt: new Date().toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    ...(email ? { email } : {}),
    ...(orderId ? { orderId } : {}),
  });
}
```

自助领码页 `/cc-helper/success/` 下载的 `license.json` 已经带 `expiresAt`，
用户直接覆盖文件即可，无需走这条接口。

### 2.3 （可选）启动/每日回源刷新

```js
async function refreshLicense() {
  const lic = readLicense();
  if (!lic || !lic.key) return;
  try {
    const res = await fetch('https://botbridge.dev/api/license/lookup?code=' + encodeURIComponent(lic.key));
    const info = await res.json();
    if (info && info.status === 'revoked') { writeLicense({ ...lic, pro: false, activated: false }); return; }
    if (info && info.expiresAt && info.expiresAt !== lic.expiresAt) writeLicense({ ...lic, expiresAt: info.expiresAt });
  } catch { /* 静默：离线不影响本地判定 */ }
}
// 启动时跑一次，之后每 24h 一次
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
