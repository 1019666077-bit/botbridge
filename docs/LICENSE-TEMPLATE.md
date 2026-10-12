# 新增一个付费插件：发码链路模板

> 结论先行：本仓的 Waffo → Worker → 领码页 → Helper 发码链路是**多商品**的。
> 接入一个新付费插件（如 Webcam Pro）只需要 **4 步**，其中只有 1 步碰代码：
> 在 `lib/products.js` 的 `PRODUCTS` 数组里追加一条配置。
> Webhook 路由、签名校验、幂等、限流、机器绑定上限全部按商品配置自动生效。

CC Helper Pro 是第 1 条商品配置，可作为抄写范本。

## 0. 商品配置字段（`lib/products.js`）

| 字段 | 必填 | 作用 |
| --- | --- | --- |
| `key` | ✅ | 稳定 slug，日志与 admin 接口里用它标识商品（如 `webcam-pro`） |
| `displayName` | ✅ | 人类可读名，出现在客服/文档 |
| `codePrefix` | ✅ | 发码前缀（如 `WCP`），**同时用于把激活码路由回该商品**，不可与别人重复 |
| `productIds` | ✅ | 该插件的 Waffo **正式**商品 id（可多个） |
| `testProductIds` | ✅ | Waffo **Test Mode** 商品 id；命中即发测试码（7 天封顶），可为空数组 |
| `maxMachines` | ✅ | `/api/pro/activate` 强制的一码机器上限 |
| `successPath` | ✅ | 买家领码页路径（同时用作 Waffo 的 Success / Return URL） |
| `approvalPath` | ➖ | 手机端远程批准页路径（默认回退 `/cc-helper/approve`）；见第 4 节 |
| `envPrefix` | ✅ | 可选覆盖用的环境变量前缀（如 `WEBCAM`） |
| `productName` | ➖ | 精确商品名兜底过滤（Waffo payload 有时只有名字没有 id） |
| `requireProductId` | ➖ | `true` 时，事件里没有 productId 也拒绝（多商品店铺建议开启） |

可选环境变量覆盖（写在 `wrangler.toml` 的 `[vars]`，无需改代码）：

```
<ENV>_PRODUCT_ID             逗号分隔的正式商品 id
<ENV>_TEST_PRODUCT_ID        逗号分隔的测试商品 id
<ENV>_PRODUCT_NAME           精确商品名过滤
<ENV>_REQUIRE_PRODUCT_MATCH  1/true/yes = 严格模式
<ENV>_MAX_MACHINES           正整数，覆盖机器上限
```

`resolveProducts(env)` 会在启动时把上面的覆盖合并进注册表。

## 1. 上线清单（Add a new paid plugin）

- [ ] **Waffo 后台**：建商品（Live + Test 各一个），记下两个 `productId`。
- [ ] **Return URL**：在该商品的成功回跳里填 `https://botbridge.dev/<successPath>`。
      多个商品可以共用同一个 webhook endpoint，**不需要**新建 webhook。
- [ ] **（可选）`wrangler.toml`**：把测试商品 id 写进 `<ENV>_TEST_PRODUCT_ID`，
      多商品店铺再加 `<ENV>_REQUIRE_PRODUCT_MATCH = "1"`。
- [ ] **`lib/products.js`**：在 `PRODUCTS` 追加一条（见下方片段）。
- [ ] **领码页**：若 `successPath` 是新路径，复制 `cc-helper/success/index.html`
      改标题/文案/support 邮箱；机器上限文案里的数字与 `maxMachines` 保持一致。
- [ ] **客户端激活片段**：在插件里调用 `/api/pro/activate` 并落盘 `license.json`
      （见第 3 节）。
- [ ] **测试**：`npm test` 全绿；再按 `WAFFO-LICENSE-FULFILLMENT.md` 第 4 节做一次
      Test Mode 真链路自检（webhook 200 → 领码 → license.json 带 `expiresAt`）。
- [ ] **部署**：`wrangler deploy`（只是新配置，无 schema 变更）。

## 2. 配置片段（照抄改值）

在 `lib/products.js` 的 `PRODUCTS` 里追加：

```js
  {
    key: 'webcam-pro',
    displayName: 'Webcam Pro',
    codePrefix: 'WCP',
    productIds: ['PROD_xxxxxxxxxxxxxxxxxxxxxx'],   // Waffo Live
    testProductIds: ['PROD_yyyyyyyyyyyyyyyyyyyyyy'], // Waffo Test（可为 []）
    maxMachines: 1,
    successPath: '/webcam/success/',
    approvalPath: '/webcam/approve',   // 远程批准页；不填则用 /cc-helper/approve
    envPrefix: 'WEBCAM',
    productName: null,
    requireProductId: false,
  },
```

`codePrefix` 决定激活码形如 `WCP-XXXX-XXXX-CSUM`，Worker 用前缀把码路由回这条配置，
再按 `maxMachines` 执行机器上限。**改动仅此一处**，webhook/领码/激活逻辑无需改。

## 3. 客户端（插件/桌面端）激活片段

与 CC Helper 完全一致，只换 `successPath` 给的提示链接：

```js
// 1) 激活：把本机绑定到激活码（幂等；重复激活同一台机器 = 刷新）
const res = await fetch('https://botbridge.dev/api/pro/activate', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ code: CODE, machineId: stableMachineId() }),
});
const info = await res.json().catch(() => ({}));
if (res.status === 409) throw new Error('machine_limit'); // 到领码页解绑旧机器
if (res.status === 403) throw new Error('inactive');      // 退款/过期
if (!res.ok) throw new Error('activate_failed');
// info.licenseJson = { pro, activated, key, activatedAt, expiresAt?, isTest?, machineId, … }
writeLicense({ ...info.licenseJson, lastValidatedAt: new Date().toISOString() });

// 2) 复验（每 3 天；网络失败按 7 天离线宽限放行）
await fetch('https://botbridge.dev/api/pro/validate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: CODE, machineId: stableMachineId() }),
});

// 3) 换机解绑
await fetch('https://botbridge.dev/api/pro/deactivate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: CODE, machineId: stableMachineId() }),
});

// 4) 远程批准（可选，Pro）：把一步高风险操作交给手机确认
const started = await (await fetch('https://botbridge.dev/api/pro/approval', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    code: CODE, machineId: stableMachineId(),
    taskId: 'task-123', title: 'Run the export and email it to finance',
    screenshotUrl: 'https://…/preview.png',   // 或很小的 screenshotBase64
  }),
})).json();
// started.approveUrl → 生成二维码给手机扫；started.pollUrl → 轮询（见 HELPER-EXPIRES-PATCH.md §4）
// 轮询返回 { status: 'pending' | 'approved' | 'cancelled' | 'expired' }
```

`license.json` 的完整契约、`stableMachineId` 的算法、到期与离线宽限的实现，
见 `HELPER-EXPIRES-PATCH.md`（CC Helper 是首个落地实现，可直接复用）。

## 4. 每个插件自动获得的默认能力

新增配置后，下面这些**不用单独实现**：

- **签名校验**：Waffo `X-Waffo-Signature`，Live 公钥优先、Test 公钥兜底，时间窗 + 重放拒绝。
- **幂等**：按投递 id 去重；没有 id 时用「事件类型 + 订单号 + 周期」派生键，重投不会重复发码。
- **续期/恢复 / 退款/取消**：续期只前进不回退；退款对该订单**终局**；取消可被恢复事件救回。
- **商品隔离**：非本商品的 `productId` 直接忽略（同类事件不串码）。
- **领码限流**：按 IP + 按订单号双桶，防订单号暴力枚举。
- **机器上限**：KV 上的读-改-写带并发校验，两台机器同时激活也不会超限或丢绑定。
- **远程批准（Pro）**：Helper 用「有效 + 未过期 + 已绑本机」的激活码调
  `POST /api/pro/approval`（`{code, machineId, taskId, title, screenshotUrl?|screenshotBase64?}`，
  base64 截图 >200KB 拒绝、优先用 URL），拿到一个 **24 小时、一次性** 的不透明 token；
  手机打开 `approveUrl`（即 `<approvalPath>?t=…`）点 **Continue / Cancel**，
  Helper 轮询 `GET /api/pro/approval?t=…&code=…&machineId=…` 得到
  `pending|approved|cancelled|expired`。**所有商品自动具备**，无需在 webhook/激活逻辑里改一行；
  `approvalPath` 只决定买家在哪一页作答——新商品可复制 `/cc-helper/approve` 那页的文案，
  页面由 Worker 渲染（`lib/approval-logic.js`），会校验状态并转义标题。
- **结构化日志**：`waffo.webhook` / `license.claim` / `license.activate` / `license.approval` 等，只记激活码后 4 位。

## 5. 现有商品

| key | 商品 | 码前缀 | 上限 | 领码页 |
| --- | --- | --- | --- | --- |
| `cc-helper` | CC Helper Pro | `CCH` | 2 | `/cc-helper/success/` |

（下列商品待接入：Webcam Pro。）


