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

可选普通变量（写在 `wrangler.toml` 的 `[vars]`，已注释出模板）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CC_HELPER_PRODUCT_ID` | `PROD_4rpv1XspFZwARrTFDfvlmY` | 只处理该商品的订阅事件 |
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
| `subscription.renewed` / `subscription.recovered` | 续期 | 同 `orderId` 记录 `expiresAt` 推进到新的 `currentPeriodEnd`，`status=active`（无记录则补发） |
| `subscription.canceled` / `refund.succeeded` | 吊销 | `status=revoked`（保留 `expiresAt` 以便对账） |

幂等：按 Waffo 投递 id（`event.id`）去重，重复投递直接返回 `{ok:true,duplicate:true}`，
不会重复发码或覆盖已发码。

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
| `GET /api/license/claim?email=&orderId=` | 买家自助领码，返回 `{code,status,expiresAt,licenseJson}`；邮箱+订单号不匹配统一 404；已吊销 403；限流 429 |
| `GET /api/license/lookup?code=` | 给桌面 Helper 后续校验用，返回 `{valid,status,expiresAt}` |
| 其余路径 | `env.ASSETS.fetch()` 走静态站点 |

轻量限流：按 `cf-connecting-ip` 对 `claim` / `lookup` 各 20 次/分钟（KV 计数，最终一致，
是减速带不是硬闸门）。

## 4. 上线前自检

```bash
npm test        # 48 个用例：发码/校验和、事件分类、过期归一、RSA 验签、worker 全链路
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
- **手动补偿**：如需手工发码/吊销，直接改 KV（`wrangler kv key put --binding=LICENSES ...`），
  或临时重放一条已签名的 webhook——不要为此去改代码里的判定。
