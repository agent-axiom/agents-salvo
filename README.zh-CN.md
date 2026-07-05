# 齐射

[English](README.md) | [Русский](README.ru.md) | 中文

齐射是一个部署在 GitHub Pages 上的浏览器海战棋游戏，支持三种语言、同机双人、在线双人和智能体对战。

在线版本：https://agent-axiom.github.io/agents-salvo/

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

## GitHub Pages

1. 将仓库推送到 GitHub。
2. 在 Settings -> Pages 中选择 GitHub Actions。
3. 运行 `Deploy GitHub Pages` workflow，或推送到 `main`。

Workflow 会运行 `npm test`，构建 `dist`，并发布为 Pages artifact。

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
