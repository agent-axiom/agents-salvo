# 齐射

[English](README.md) | [Русский](README.ru.md) | 中文

齐射是一个部署在 GitHub Pages 上的浏览器海战棋游戏，支持三种语言、同机双人、在线双人和智能体对战。

在线版本：https://agent-axiom.github.io/agents-salvo/

Telegram Mini App：https://agent-axiom.github.io/agents-salvo/telegram/

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
- 使用 Telegram 登录提供固定玩家身份。
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

浏览器、Telegram Mini App、iOS 应用和 Android 应用共享同一份源代码，并由一次 `npm run build` 生成。该构建会输出普通 HTML shell 和 Telegram HTML shell，两者引用同一组带哈希的 JavaScript bundle 和 stylesheet；只有 Telegram shell 加载 Telegram SDK。

发布 Pages artifact 后，Pages 和 Mini App 会立即更新。原生应用启动时不会加载 Pages：每个 APK 或 iOS 应用会打包所选提交的构建，只有在该提交完成打包和发布后才会更新。

## iOS 和 Android 开发

移动应用打包的 `dist/` 与 GitHub Pages 使用同一份构建产物，启动时不会加载公开网站。因此，智能体对战、训练和同机双人模式可离线运行。在线房间、Telegram 登录、玩家档案和排行榜需要连接 Cloudflare Worker。

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

切勿提交签名密钥或密码。请在仓库之外保存原始 keystore 和至少一个加密备份：`io.github.agentaxiom.salvo` 的所有后续更新必须使用同一密钥签名。运行 `npm run rustore:assets:verify` 可在本地验证商店素材。商店文案、截图、隐私声明和所有者检查清单位于 [`distribution/rustore`](distribution/rustore/)。

## GitHub Pages

1. 将仓库推送到 GitHub。
2. 在 Settings -> Pages 中选择 GitHub Actions。
3. 运行 `Deploy GitHub Pages` workflow，或推送到 `main`。

Workflow 会运行测试和 coverage gates，构建 `dist`，验证两个 HTML shell 及其共享的带哈希资源，并将结果发布为 Pages artifact。

## 在线后端

后端用于 “Online room” 模式、Telegram 登录和保存玩家档案。

```bash
npx wrangler deploy
```

当前 Worker URL 已配置在前端：

```text
https://agents-salvo-room.if-ab6.workers.dev
```

玩家不会看到这个 URL。若要更换后端，请更新 `src/index.html` 中的 `window.SALVO_CONFIG.workerUrl`，然后重新部署 Pages。

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

## Profile API

- `POST /auth/telegram` 校验 Telegram Login Widget payload 并返回签名 session。
- `GET /profile/me` 返回玩家档案、统计摘要、在线评级、赛季统计、排行榜和近期战斗。
- `POST /profile/matches` 为已登录玩家保存智能体对局结果；在线对局结果由房间服务器写入。
- `GET /leaderboard` 返回基于服务器记录在线对局生成的公开在线排行榜。

创建或加入在线房间时如果带有 `Authorization: Bearer ...`，Durable Object 会把 Telegram 档案绑定到该玩家，并在对局结束后把结果写入 D1。

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
