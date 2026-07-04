# Salvo

English | [Русский](README.ru.md) | [中文](README.zh-CN.md)

Salvo is a browser Battleship game for GitHub Pages with three localizations, same-device PvP, online PvP, and play against an agent.

Live build: https://agent-axiom.github.io/agents-salvo/

## Features

- Static frontend without a framework: `src/index.html`, `src/app.js`, `src/styles.css`.
- Rule engine in `src/core/game.js`.
- Classic Russian fleet: 1x4, 2x3, 3x2, 4x1.
- Ships cannot touch by sides or corners.
- Sunk ships are outlined and surrounding cells are marked as water.
- Same-device PvP, online PvP, and agent mode.
- English, Russian, and Chinese localizations.
- Light and dark themes.
- Synthetic Web Audio sound effects and menu music; no MP3 assets are required yet.
- Cloudflare Worker backend with Durable Objects for online rooms.
- GitHub Pages workflow in `.github/workflows/pages.yml`.

## Local Development

```bash
npm test
npm run build
npm start
```

After `npm start`, open `http://localhost:5173`.

## GitHub Pages

1. Push the repository to GitHub.
2. In Settings -> Pages, select GitHub Actions.
3. Run the `Deploy GitHub Pages` workflow or push to `main`.

The workflow runs `npm test`, builds `dist`, and publishes it as a Pages artifact.

## Online Backend

The backend is only required for the “Online room” mode.

```bash
npx wrangler deploy
```

The current Worker URL is configured in the frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Players do not see this URL. To change the backend, update `window.SALVO_CONFIG.workerUrl` in `src/index.html` and redeploy Pages.

`wrangler.toml` uses Durable Objects with SQLite storage:

```toml
[[durable_objects.bindings]]
name = "BATTLE_ROOM"
class_name = "BattleRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BattleRoom"]
```

## Online Protocol

- `POST /rooms` creates a room and returns `roomCode`, `playerId`, and `playerToken`.
- `POST /rooms/:roomCode/join` connects the second player.
- `GET /rooms/:roomCode/socket?playerId=...&token=...` opens a WebSocket.
- The client sends `placeFleet` and `fire`.
- The Durable Object validates turn order and never exposes opponent ships in snapshots.

## Audio

The current build uses synthetic Web Audio presets from `src/core/audio.js` and `src/audio.js`.

Future MP3 replacements can use these file names:

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

## Historical Note

The English main-screen historical source links to “Battleship (game)”: https://en.wikipedia.org/wiki/Battleship_(game)
