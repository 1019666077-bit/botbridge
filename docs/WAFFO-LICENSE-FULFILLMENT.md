# CC Helper Pro 自动发码（Waffo → botbridge.dev）

> 结论先行：付款后由 Waffo webhook 打到 `POST https://botbridge.dev/api/waffo/webhook`，
> Worker 校验签名后自动生成 `CCH-XXXX-XXXX-CSUM`，写入 KV；买家在
> `https://botbridge.dev/cc-helper/success/` 用「收据邮箱 + 订单号」自助领码，无需人工等待。
>
> Waffo **没有**内建激活码功能，必须商户自建 webhook 交付（官方文档：`order.completed` /
> `subscription.activated` → Deliver digital goods）。本仓即该交付端。

## 0. 一次性准备（必须先做，否则线上 500）

Worker 依赖一个 KV namespace 绑定 `LICENSES` 和一个 webhook 公钥 secret。

```bash
cd /workspace/botbridge-main
npx wrangler login                       # 需要有 botbridge-site 账号权限
npx wrangler kv namespace create LICENSES
# 输出形如  id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# 把它填进 wrangler.toml 的 [[kv_namespaces]] id（当前是 REPLACE_WITH_LICENSES_KV_NAMESPACE_ID）
```

`wrangler.toml` 里 `id = "REPLACE..."` 不替换的话，`wrangler deploy` 会直接报错（这是故意的，
避免误发到错误的命名空间）。

Secret（从 Waffo 后台复制，见第 1 步）——**不要写进仓库**：

```bash
npx wrangler secret put WAFFO_WEBHOOK_PUBLIC_KEY
# 粘贴 PEM（-----BEGIN PUBLIC KEY----- …），回车结束
```

**可选**：漏单人工补发接口 `/api/license/admin/reissue` 用的管理密钥。**不设置该密钥时该接口返回 404（功能关闭）**。
密钥值自行生成一串足够长的随机串，不要写进仓库：

```bash
# 生成示例（在安全终端里执行，自行保存；本仓不记录任何真实值）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put LICENSE_ADMIN_SECRET
# 粘贴上面生成的随机串，回车结束
```

可选普通变量（写在 `wrangler.toml` 的 `[vars]`，已注释出模板）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CC_HELPER_PRODUCT_ID` | `PROD_4rpv1XspFZwARrTFDfvlmY` | 正式商品；发码按 `currentPeriodEnd` 到期 |
| `CC_HELPER_TEST_PRODUCT_ID` | `PROD_4H2br9vXCUBpKU7kKBFtBF` | Waffo Test Mode 测试商品（逗号分隔可多个）；命中即标 `isTest`，到期被压到 7 天内，**绝不永久 Pro** |
| `CC_HELPER_PRODUCT_NAME` | 空 | 可选的商品名兜底过滤 |
| `CC_HELPER_REQUIRE_PRODUCT_MATCH` | `0` | `1` = 事件里没有 productId 时也拒绝 |

## 1. Waffo Dashboard 配置

1. 登录 Waffo Pancake，进入店铺 **moying-e3keic1t**。
2. 打开 **Settings → Webhooks**（左侧「开发者 / Developer」区域；若界面不同，找 “Webhooks” 卡片
   → **Add webhook**）。
3. 渠道选 **HTTP**（默认渠道；Feishu/Discord/Telegram/Slack 不签名，这里不适用）。
4. **URL** 填：

   ```
   https://botbridge.dev/api/waffo/webhook
   ```

5. **Events** 勾选（名称以 Waffo 实际显示为准，点选下限这 5 个）：

   - `subscription.activated`
   - `subscription.renewed`
   - `subscription.recovered`
   - `subscription.canceled`
   - `refund.succeeded`

6. 保存。列表里能看到该 webhook 的 **secret / public key**；选 **Production** 环境的公钥，
   复制其 PEM → 执行第 0 步的 `wrangler secret put WAFFO_WEBHOOK_PUBLIC_KEY`。
   （Waffo 用 RSA-SHA256，签名头 `X-Waffo-Signature: t=<秒>,v1=<base64>`，签名内容是
   `t + "." + 原始 body`。）
7. 商品成功回跳（若该商品的 UI 支持 “Success URL / Return URL”）：填

   ```
   https://botbridge.dev/cc-helper/success/
   ```

   不填也不影响：落地页上已有 “Already bought? Claim your Pro key” 与 `/cc-helper/success/` 入口。

## 2. 事件 → 行为

Worker（`worker.js` → `lib/license-logic.js`）按下表处理；无关 `eventType` 与无关商品直接忽略。

| eventType | 动作 | KV 记录变化 |
| --- | --- | --- |
| `subscription.activated` | 首次发码 | 新建 `order:<orderId>`，`status=active`，`expiresAt=currentPeriodEnd`，生成 `code` |
| `order.completed` | 一次性购买发码 | 同 activate（CC Helper Pro 测试结账走的是这条） |
| `subscription.renewed` / `subscription.recovered` | 续期 | 同 `orderId` 记录 `expiresAt` 推进到新的 `currentPeriodEnd`，`status=active`（无记录则补发） |
| `subscription.canceled` | 吊销（可恢复） | `status=revoked`；之后 `subscription.recovered`/`renewed` 会把状态改回 `active` 并顺延 |
| `refund.succeeded` | 吊销（终局） | `status=revoked` + `refunded=true`；此后任何事件都不能把这个订单复活 |

**测试订单**：商品命中 `CC_HELPER_TEST_PRODUCT_ID`（或事件带 `mode/test/livemode:false`
测试标记）时，记录标 `isTest=true`，且 `expiresAt` 被压到 **最多 7 天**（事件没有周期就正好给 7 天）。
测试授权因此不会变成永久 Pro。`isTest` 一旦写入即“粘住”，后续续期事件也不会把它变成正式授权。

幂等：按 Waffo 投递 id（`event.id`）去重，重复投递直接返回 `{ok:true,duplicate:true}`，
不会重复发码或覆盖已发码。事件没带 id 时，用「事件类型 + 订单号 + 周期」派生一个稳定的去重键，
所以普通重投同样安全。去重键在**成功处理之后**才写入：处理中抛错则不会记账，Waffo 重试可正常重放。

签名时间窗：`X-Waffo-Signature` 的 `t` 超过 45 分钟（或超前 1 分钟以上）的请求一律 401，
**过期重放被拒**；窗口内的重复投递再由上面的幂等拦截。

续期是**单调**的：`currentPeriodEnd` 只会往前推，乱序/迟到的旧周期事件不会把到期日改早。
退款对该订单**终局**（`refunded=true`），取消则可被 `recovered` 救回。

### 商品过滤的一个坑（重要）

官方 payload 文档里**只有 `productName`，没有 `productId`**。Worker 因此按以下顺序找商品标识：
`data.productId` → `data.product.id` → `data.productMetadata.productId` / `data.orderMetadata.productId`。

- 找得到 ≠ 本商品 → **丢弃**（返回 `ignored:"product"`）。
- 找不到 → **放行**（单商品店铺更怕漏发）；若该店以后会上多个商品，把
  `CC_HELPER_REQUIRE_PRODUCT_MATCH=1`，或配 `CC_HELPER_PRODUCT_NAME` 精确匹配商品名。

## 3. 对外接口

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/waffo/webhook` | Waffo 专用。签名不通过 401；其余见上表 |
| `GET /api/license/claim?email=&orderId=` | 买家自助领码，返回 `{code,status,expiresAt,isTest,machines,licenseJson}`；邮箱+订单号不匹配统一 404；已吊销/过期 403；限流 429。邮箱大小写/首尾空格、订单号里的空格都会被规整后在比对。错误响应带 `{error,message,support}`，`message` 是可直接展示给买家的中文/英文说明 |
| `GET /api/license/lookup?code=` | 只读内容校验，返回 `{valid,status,expiresAt}`（无机器绑定判断） |
| `POST /api/pro/activate` | `{code,machineId,machineName?}` 绑定本机；首绑即绑定，第 3 台机器 409 `machine_limit`；已吊销/过期 403；码不存在 404；成功返回 `{ok,code,status,expiresAt,isTest,machines,licenseJson}` |
| `POST /api/pro/validate` | `{code,machineId}` 在线复验（`machineId` **必填**，漏传 400，避免绕过机器绑定）；返回 `{valid,status,reason?,expiresAt,isTest,machines?}`；未绑本机 `reason:"machine_not_bound"`，过期 `reason:"expired"`，吊销 `revoked` |
| `POST /api/pro/deactivate` | `{code,machineId}` 解绑一台机器，返回 `{ok,removed,machines}`；幂等 |
| `POST /api/license/admin/reissue` | 运维补发（见下）；未配置 `LICENSE_ADMIN_SECRET` 时 404 |
| 其余路径 | `env.ASSETS.fetch()` 走静态站点 |

**运维补发 / 吊销**（webhook 漏单时的兜底）：请求头带 `x-admin-secret: <LICENSE_ADMIN_SECRET>`
（或 `Authorization: Bearer <secret>`），body：

```jsonc
{ "orderId": "ord_…", "email": "buyer@example.com", "expiresAt": "2027-10-12" }
// action 可选：reissue（默认，补发/顺延）| extend（仅对已有订单顺延）| revoke（终局吊销）
// product 可选：商品 key（默认第一条配置，如 cc-helper）
```

返回 `{ok,orderId,code,status,expiresAt,isTest,email,created}`。密钥缺失/错误 401，未配置 404。
该接口会写 `order:` / `code:` / `email:` 索引，补发后买家即可在领码页正常领码、Helper 可正常激活。

**机器绑定**：一台机器一个码最多绑 **N** 台（每个商品配置的 `maxMachines`，CC Helper 是 2）。
绑定走 KV 上的读-改-写并带**并发校验**（写完回读确认本机仍在 `machines[]`，被并发覆盖就重试），
因此两台机器同时激活也不会超上限、不会把已确认的绑定丢掉。`machineId` 由 Helper 用
本机可复现信息哈希得到（匿名、稳定），只存于 `order:<orderId>` 的 `machines[]` 里。

轻量限流（KV 计数，最终一致，是**减速带不是硬闸门**）：

| 桶 | 上限 | 作用 |
| --- | --- | --- |
| `claim`（按 IP） | 20/分 | 防单连接刷领码 |
| `claim-order`（按订单号） | 8/分 | 防同一订单号暴力枚举邮箱 |
| `lookup`（按 IP） | 20/分 | 只读校验 |
| `activate`/`validate`/`deactivate`（按 IP） | 30/分 | 防激活接口滥用 |
| `validate-code`（按激活码） | 60/分 | 防针对单个码的高频探测，不误伤其他买家 |

`claim` 还会在参数进入 KV 之前校验长度（订单号 ≤100、邮箱 ≤254），避免超长 key 把探测打成 500。

## 4. 上线前自检

```bash
npm test        # 106 个用例：发码/校验和、事件分类、过期归一/单调顺延、测试授权、退款终局、
                # 机器绑定并发安全、RSA 验签与时间窗、商品配置、领码规整/限流、admin 补发、worker 全链路
```

- **伪造签名应被拒**：对线上地址 POST 一个 body 不带/乱写 `X-Waffo-Signature`，应返回
  `401 {"error":"invalid_signature"}`。
- **真实链路**：用 Waffo **Test mode** 触发一次 `subscription.activated`，确认日志 200，再在
  `/cc-helper/success/` 用测试邮箱+订单号领码，`license.json` 里应有 `expiresAt`。
- KV 里可直接核对：`order:<orderId>`、`code:<CODE>`、`event:<deliveryId>`。

## 5. 安全与运维注意

- **私钥不入库**：本仓只有公钥用途，公钥也只走 secret。CCH 生成用的是校验和，不是 Ed25519；
  将来要强防伪再单独设计（见 `HELPER-EXPIRES-PATCH.md` 末尾）。
- **静态资源目录是仓库根目录**（`assets.directory = "."`），所以 `worker.js`、`wrangler.toml`、
  `lib/` 等源码也会作为静态文件可被访问。当前 `worker.js` 只有路由逻辑、公钥在 secret，风险低；
  若要收口，后续把静态站挪到 `public/` 并改 `assets.directory`。
- **手动补偿**：webhook 漏单时优先用 `POST /api/license/admin/reissue`（见第 3 节，需
  `LICENSE_ADMIN_SECRET`）；实在要动数据再直接改 KV（`wrangler kv key put --binding=LICENSES ...`）——
  不要为此去改代码里的判定。
- **日志**：Worker 每个请求打一行 JSON（`waffo.webhook` / `license.claim` / `license.activate` /
  `license.admin` / `license.api`），含 `orderId`、`product`、`outcome`、`deliveryId` 等排障字段；
  **激活码只记后 4 位**，日志权限不会变成发码权限。
- **多商品**：新增付费插件的完整清单见 `docs/LICENSE-TEMPLATE.md`；配置在 `lib/products.js`，
  webhook / 领码 / 激活逻辑无需改动。
