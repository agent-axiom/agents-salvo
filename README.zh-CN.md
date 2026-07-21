# 齐射

[English](README.md) | [Русский](README.ru.md) | 中文

齐射是一个部署在 GitHub Pages 上的浏览器海战棋游戏，支持三种语言、同机双人、在线双人和智能体对战。

在线版本：https://agent-axiom.github.io/agents-salvo/

Telegram Mini App：https://agent-axiom.github.io/agents-salvo/telegram/

MAX Mini App：https://agent-axiom.github.io/agents-salvo/max/

![纸上海战棋棋盘插图](src/assets/salvo-board-action.png)

## 功能

- 无框架静态前端：`src/index.html`、`src/app.js`、`src/styles.css`。
- 规则核心：`src/core/game.js`。
- 纸面蓝色圆珠笔风格，更接近经典手绘海战棋棋盘。
- 经典俄式舰队：1x4、2x3、3x2、4x1。
- 舰船不能边角相邻。
- 被击沉的舰船会被描边，周围格子自动标记为水域。
- 同机 PvP、在线 PvP、智能体模式。
- English、Русский、中文 三种本地化。
- 浅色和深色主题。
- 当前使用 Web Audio 合成音效和首页音乐，暂不需要 MP3 文件。
- 使用 Telegram 登录以及 Telegram/MAX Mini App 签名启动数据提供固定玩家身份。
- 在线房间使用 Cloudflare Worker 和 Durable Objects，玩家档案使用 D1。
- GitHub Pages workflow：`.github/workflows/pages.yml`。

## 本地开发

```bash
npm test
npm run build
npm start
```

运行 `npm start` 后打开 `http://localhost:5173`。

## Telegram Mini App

在 [@BotFather](https://t.me/BotFather) 中选择齐射机器人，打开 Main Mini App 设置，并将 URL 设为 `https://agent-axiom.github.io/agents-salvo/telegram/`。

从 Telegram 内打开时，Mini App 会自动将 Telegram 签名的 `initData` 发送到 Cloudflare Worker。Worker 验证签名和数据时效后创建现有的齐射会话，因此玩家无需再次登录。

## MAX Mini App

在 MAX 的齐射机器人设置中，将 Mini App URL 设为 `https://agent-axiom.github.io/agents-salvo/max/`。公开启动链接为 `https://max.ru/se13661945_bot?startapp`。

从 MAX 内打开时，MAX Mini App 会把已签名的 MAX 启动数据发送到 Cloudflare Worker。Worker 使用私密的 `MAX_BOT_TOKEN` 验证 HMAC 签名和数据时效，然后创建与其他客户端相同类型的不透明齐射会话。原始启动数据和机器人 token 不会被持久保存。Telegram 与 MAX 身份会保留为独立档案，除非以后提供明确的账号关联功能。

MAX 机器人 token 只能保存为 Worker secret，然后重新部署 Worker：

```bash
npx wrangler secret put MAX_BOT_TOKEN
npx wrangler deploy
```

浏览器、Telegram Mini App、MAX Mini App、iOS 应用和 Android 应用共享同一份源代码，并由一次 `npm run build` 生成。构建会输出三个 HTML shell，共享同一组带哈希的 JavaScript bundle 和 stylesheet；每个消息平台 SDK 只在对应 shell 中加载。

发布 Pages artifact 后，Pages 和两个 Mini App 会立即更新。原生应用启动时不会加载 Pages：每个 APK 或 iOS 应用会打包所选提交的构建，只有在该提交完成打包和发布后才会更新。

## iOS 和 Android 开发

移动应用打包的 `dist/` 与 GitHub Pages 使用同一份构建产物，启动时不会加载公开网站。因此，智能体对战、训练和同机双人模式可离线运行。在线房间、账号登录、玩家档案和排行榜需要连接 Cloudflare Worker。

环境要求：

- Node.js 24.14.1（见 `.nvmrc`）。
- iOS：安装 Xcode 26 或更高版本的 macOS；最低支持 iOS 15。
- Android：Android Studio Otter 2025.2.1 或更高版本、JDK 21 和 Android SDK 36；最低支持 API 24。

安装依赖，并将 Web 构建同步到两个原生项目：

```bash
npm ci
npm run mobile:sync
```

从命令行打开原生项目：

```bash
npm run mobile:ios
npm run mobile:android
```

无需商店账号即可构建未签名的开发产物：

```bash
android/gradlew -p android test lint assembleDebug
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Android debug APK 和 iOS Simulator 构建不需要 Google Play 或 Apple Developer 账号。在实体 iOS 设备上运行以及通过 TestFlight 或应用商店分发时，需要相应的签名凭据。

### RuStore 发布

手动 workflow `Build RuStore Release` 只能从 `main` 运行；它会执行测试、检查已发布的隐私声明、构建已签名的 APK 和 AAB、验证签名、权限与应用标识，并将文件上传为 GitHub Actions artifact。以下 secrets 必须保存在受保护的 GitHub Environment `rustore-production` 中：

- `RUSTORE_KEYSTORE_BASE64`
- `RUSTORE_STORE_PASSWORD`
- `RUSTORE_KEY_ALIAS`
- `RUSTORE_KEY_PASSWORD`
- `RUSTORE_KEY_ID`
- `RUSTORE_PRIVATE_KEY`
- `RUSTORE_DEVELOPER_EMAIL`

切勿提交签名密钥、API 密钥或密码。请在仓库之外保存原始 keystore 和至少一个加密备份：`io.github.agentaxiom.salvo` 的所有后续更新必须使用同一签名密钥。运行 `npm run rustore:assets:verify` 可在本地验证商店素材。商店文案、截图、隐私声明和所有者检查清单位于 [`distribution/rustore`](distribution/rustore/)。

RuStore 中出现首个已上线版本后，才可使用 API 发布。先运行只读的 `Check RuStore API Access` workflow。发布更新时，运行 `Build RuStore Release`，启用 `submit_to_rustore` 并填写更新说明；验证后的 APK 会提交审核，审核通过后自动向 5% 用户发布。随后使用受保护的 `Expand RuStore Rollout` workflow 和对应版本 ID，依次扩大到 25% 和 100%。停止发布或回滚仍需由所有者在 RuStore Console 中明确执行。

## GitHub Pages

1. 将仓库推送到 GitHub。
2. 在 Settings -> Pages 中选择 GitHub Actions。
3. 运行 `Deploy GitHub Pages` workflow，或推送到 `main`。

Workflow 会运行测试和 coverage gates，构建 `dist`，验证全部三个 HTML shell 及其共享的带哈希资源，并将结果发布为 Pages artifact。

## 在线后端

后端用于 “Online room” 模式、Telegram/MAX 登录和保存玩家档案。

```bash
npx wrangler deploy
```

当前 Worker URL 已配置在前端：

```text
https://agents-salvo-room.if-ab6.workers.dev
```

玩家不会看到这个 URL。若要更换后端，请更新所有源 shell 中的 `window.SALVO_CONFIG.workerUrl`，然后重新部署 Pages。

`wrangler.toml` 使用 Durable Objects 保存房间状态，使用 D1 保存玩家档案和历史：

```toml
[[durable_objects.bindings]]
name = "BATTLE_ROOM"
class_name = "BattleRoom"

[[d1_databases]]
binding = "DB"
database_name = "agents-salvo-profile"
database_id = "fd744630-0b47-4432-8371-c059f5953989"
```

部署新的 Worker 前先应用 D1 migrations：

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
```

### Telegram Stars webhook 运维

Telegram 每个机器人只允许一个 webhook，因此注册 webhook 必须由运维人员
明确执行，不能由测试、构建、Pages 部署、原生应用打包或 Worker 部署自动
触发。执行以下步骤前，请通过团队密码管理器把 `TELEGRAM_BOT_TOKEN` 和同一
个高强度 `TELEGRAM_WEBHOOK_SECRET` 注入临时运维 shell。下方省略号只是占位
符，不能提交到仓库或粘贴到共享日志。最后的只读检查仍需要该 shell 中已导出
的机器人 token。

生产操作必须严格按以下顺序执行：

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:stars:webhook:set
npm run telegram:stars:webhook:check
```

`telegram:stars:webhook:set` 只为 `message` 和 `pre_checkout_query` 更新注册
`https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook`，不会删除待处理
更新，并会随后核对完整 URL。`telegram:stars:webhook:check` 仅执行读取检查。
两条命令只输出公开 webhook URL，不输出 Telegram 响应内容。不能让使用同一
机器人的第二个环境执行这些命令。

真实的 8 Stars 冒烟测试必须由运维人员明确手动触发，不能在 CI 或部署流程
中运行。

处理合法的人工退款时，请申请者先在与 `@agents_salvo_bot` 的私聊中发送
`/paysupport`，并且只在 GitHub issue 中填写机器人返回的安全支持参考号。
机器人会根据发送者的 Telegram 身份生成该参考号，不会发送 charge ID、payload、
Telegram user ID 或 session token。然后在 D1 Console 的私有会话中检查付款。
按该参考号（不透明的 `invoice_id`）查询 `star_support_payments`，确认
`status = 'paid'`、`currency = 'XTR'`，并确认 `telegram_user_id` 和
`telegram_payment_charge_id` 均已保存。查询及结果只能保留在私有运维会话：

```sql
SELECT invoice_id, telegram_user_id, telegram_payment_charge_id,
       amount, currency, status, paid_at
  FROM star_support_payments
 WHERE invoice_id = ? AND status = 'paid';
```

在获准使用的私有 Telegram Bot API 客户端中调用 `refundStarPayment`：把已
保存的 `telegram_user_id` 作为 `user_id`，把已保存的
`telegram_payment_charge_id` 作为 `telegram_payment_charge_id`。机器人
token 必须从密码管理器提供；不得把 token、charge ID 或 Telegram user ID
写入源码、shell 历史、截图、issue 或共享日志。只有 Telegram 返回
`ok: true` 后，才用参数化的私有 D1 查询把同一记录改为 `refunded` 并设置
`refunded_at`。不得先修改 D1，也不得使用用户提交的标识符直接退款。
公开的安全参考号仅用于查找记录，不能更改退款接收者；Telegram 只会把 Stars
退回原始保存的 Telegram 付款账号。

```sql
UPDATE star_support_payments
   SET status = 'refunded', refunded_at = ?
 WHERE invoice_id = ? AND status = 'paid'
   AND telegram_user_id = ? AND telegram_payment_charge_id = ?;
```

`refunded_at` 使用当前 Unix 秒级时间戳，其余参数只能使用已验证收据中的值。

## Profile API

- `POST /auth/telegram` 校验 Telegram Login Widget payload 并返回签名 session。
- `POST /auth/telegram/miniapp` 校验 Telegram Mini App 的签名启动数据并创建不透明的 D1 session。
- `POST /auth/max/miniapp` 校验 MAX Mini App 的签名启动数据并创建不透明的 D1 session。
- `GET /profile/me` 返回玩家档案、统计摘要、在线评级、赛季统计、排行榜和近期战斗。
- `POST /profile/matches` 为已登录玩家保存智能体对局结果；在线对局结果由房间服务器写入。
- `GET /leaderboard` 返回基于服务器记录在线对局生成的公开在线排行榜。

创建或加入在线房间时如果带有 `Authorization: Bearer ...`，Durable Object 会把已验证档案绑定到该玩家，并在对局结束后把结果写入 D1。

## 音频

当前版本使用 `src/core/audio.js` 和 `src/audio.js` 中的 Web Audio 合成预设。

以后可以按这些名称准备 MP3 文件：

```text
public/audio/menu-loop.mp3
public/audio/shot.mp3
public/audio/miss.mp3
public/audio/hit.mp3
public/audio/sunk.mp3
public/audio/victory.mp3
public/audio/defeat.mp3
public/audio/ui-click.mp3
public/audio/turn.mp3
public/audio/room-ready.mp3
```

## 历史说明

中文首页历史来源链接到 “海战棋”：https://zh.wikipedia.org/wiki/海战棋
