# Salvo

English | [Русский](README.ru.md) | [中文](README.zh-CN.md)

Salvo is a browser Battleship game for GitHub Pages with three localizations, same-device PvP, online PvP, and play against an agent.

Live build: https://agent-axiom.github.io/agents-salvo/

![Salvo paper board artwork](src/assets/salvo-board-action.png)

## Features

- Static frontend without a framework: `src/index.html`, `src/app.js`, `src/styles.css`.
- Rule engine in `src/core/game.js`.
- Paper-and-blue-pen board styling inspired by handwritten Battleship grids.
- Classic Russian fleet: 1x4, 2x3, 3x2, 4x1.
- Ships cannot touch by sides or corners.
- Sunk ships are outlined and surrounding cells are marked as water.
- Same-device PvP, online PvP, and agent mode.
- English, Russian, and Chinese localizations.
- Light and dark themes.
- Synthetic Web Audio sound effects and menu music; no MP3 assets are required yet.
- Telegram login for player identity.
- Cloudflare Worker backend with Durable Objects for online rooms and D1 for player profiles.
- GitHub Pages workflow in `.github/workflows/pages.yml`.

## Local Development

```bash
npm test
npm run build
npm start
```

After `npm start`, open `http://localhost:5173`.

## iOS And Android Development

The mobile apps bundle the same `dist/` build as GitHub Pages; they do not load the public site at startup. Agent, training, and same-device battles therefore work offline. Online rooms, Telegram login, profiles, and leaderboards require access to the Cloudflare Worker.

Prerequisites:

- Node.js 24.14.1 (`.nvmrc`).
- iOS: macOS with Xcode 26 or newer; deployment target iOS 15.
- Android: Android Studio Otter 2025.2.1 or newer, JDK 21, and Android SDK 36; minimum supported API is 24.

Install dependencies and synchronize the web bundle with both native projects:

```bash
npm ci
npm run mobile:sync
```

Open either native project from the command line:

```bash
npm run mobile:ios
npm run mobile:android
```

Build unsigned development artifacts without store accounts:

```bash
android/gradlew -p android test lint assembleDebug
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

The Android debug APK and iOS Simulator build require no Google Play or Apple Developer account. Running on a physical iOS device and distributing through TestFlight or a store requires the corresponding signing credentials.

### RuStore release

The manual `Build RuStore Release` workflow runs only from `main`, tests the project, verifies the published privacy notice, builds signed APK and AAB files, verifies their signatures, permissions, and identities, and uploads them as a GitHub Actions artifact. Store the following secrets in the protected `rustore-production` GitHub Environment:

- `RUSTORE_KEYSTORE_BASE64`
- `RUSTORE_STORE_PASSWORD`
- `RUSTORE_KEY_ALIAS`
- `RUSTORE_KEY_PASSWORD`
- `RUSTORE_KEY_ID`
- `RUSTORE_PRIVATE_KEY`
- `RUSTORE_DEVELOPER_EMAIL`

Never commit signing or API keys. Keep the original keystore and at least one encrypted backup outside the repository: every future update of `io.github.agentaxiom.salvo` must use the same signing key. Verify the store assets locally with `npm run rustore:assets:verify`. The listing copy, screenshots, privacy declaration, and owner checklist are in [`distribution/rustore`](distribution/rustore/).

API publishing is available after RuStore has one active version. Run `Check RuStore API Access` first; it is read-only. For an update, run `Build RuStore Release` with `submit_to_rustore` enabled and non-empty release notes. The verified APK is submitted for moderation and, after approval, automatically reaches 5% of users. Use the protected `Expand RuStore Rollout` workflow with the returned version ID to move to 25% and then 100%. Stopping or rolling back a release remains an explicit owner action in the RuStore Console.

## GitHub Pages

1. Push the repository to GitHub.
2. In Settings -> Pages, select GitHub Actions.
3. Run the `Deploy GitHub Pages` workflow or push to `main`.

The workflow runs `npm test`, builds `dist`, and publishes it as a Pages artifact.

## Online Backend

The backend is required for the “Online room” mode, Telegram auth, and saved player profiles.

```bash
npx wrangler deploy
```

The current Worker URL is configured in the frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Players do not see this URL. To change the backend, update `window.SALVO_CONFIG.workerUrl` in `src/index.html` and redeploy Pages.

`wrangler.toml` uses Durable Objects with SQLite storage for rooms and D1 for profile/history storage:

```toml
[[durable_objects.bindings]]
name = "BATTLE_ROOM"
class_name = "BattleRoom"

[[d1_databases]]
binding = "DB"
database_name = "agents-salvo-profile"
database_id = "fd744630-0b47-4432-8371-c059f5953989"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BattleRoom"]
```

Apply D1 migrations before deploying a fresh Worker:

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
```

## Online Protocol

- `POST /rooms` creates a room and returns `roomCode`, `playerId`, and `playerToken`.
- `POST /rooms/:roomCode/join` connects the second player.
- If `Authorization: Bearer ...` is present on create/join, the room stores that Telegram identity for server-side history.
- `GET /rooms/:roomCode/socket?playerId=...&token=...` opens a WebSocket.
- The client sends `placeFleet` and `fire`.
- The Durable Object validates turn order, never exposes opponent ships in snapshots, and records completed authenticated online matches in D1.

## Profile API

- `POST /auth/telegram` verifies Telegram Login Widget payloads and returns a signed session token.
- `GET /profile/me` returns the authenticated player profile, summary stats, online rating, season stats, leaderboard, and recent battles.
- `POST /profile/matches` saves completed agent battles for the authenticated player; online results are written by the room server.
- `GET /leaderboard` returns the public online leaderboard derived from server-recorded online matches.

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
