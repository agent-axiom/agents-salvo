# Salvo

English | [Русский](README.ru.md) | [中文](README.zh-CN.md)

Salvo is a browser Battleship game for GitHub Pages with three localizations, same-device PvP, online PvP, and play against an agent.

Live build: https://agent-axiom.github.io/agents-salvo/

Telegram Mini App: https://agent-axiom.github.io/agents-salvo/telegram/

MAX Mini App: https://agent-axiom.github.io/agents-salvo/max/

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
- Telegram login and signed Telegram/MAX Mini App identity.
- Cloudflare Worker backend with Durable Objects for online rooms and D1 for player profiles.
- GitHub Pages workflow in `.github/workflows/pages.yml`.

## Local Development

```bash
npm test
npm run build
npm start
```

After `npm start`, open `http://localhost:5173`.

## Telegram Mini App

In [@BotFather](https://t.me/BotFather), select the Salvo bot, open the Main Mini App setup, and set its URL to `https://agent-axiom.github.io/agents-salvo/telegram/`.

When opened inside Telegram, the Mini App automatically sends Telegram's signed `initData` to the Cloudflare Worker. The Worker verifies the signature and freshness before creating the existing Salvo session, so players do not complete a separate login flow.

## MAX Mini App

Configure the Salvo bot's Mini App URL as `https://agent-axiom.github.io/agents-salvo/max/`. The public launch link is `https://max.ru/se13661945_bot?startapp`.

When opened inside MAX, the Mini App sends signed MAX launch data to the Cloudflare Worker. The Worker validates its HMAC signature and freshness with the private `MAX_BOT_TOKEN`, then creates the same kind of opaque Salvo session used by other clients. The raw launch data and bot token are not persisted. Telegram and MAX identities remain separate profiles unless an explicit account-linking feature is added later.

Store the MAX bot token only as a Worker secret, then redeploy the Worker:

```bash
npx wrangler secret put MAX_BOT_TOKEN
npx wrangler deploy
```

The browser, Telegram Mini App, MAX Mini App, iOS app, and Android app use one source tree and one `npm run build`. The build emits three HTML shells with one shared hashed JavaScript bundle and stylesheet. Only the matching Mini App shell loads its provider SDK.

Pages and both Mini Apps update immediately when the Pages artifact is published. Native apps do not load Pages at startup: each APK or iOS app packages the build from a selected commit and changes only when that commit is packaged and released.

## iOS And Android Development

The mobile apps bundle the same `dist/` build as GitHub Pages; they do not load the public site at startup. Agent, training, and same-device battles therefore work offline. Online rooms, account login, profiles, and leaderboards require access to the Cloudflare Worker.

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

The workflow runs the test and coverage gates, builds `dist`, verifies all three HTML shells and their shared hashed assets, and publishes the result as a Pages artifact.

## Online Backend

The backend is required for the “Online room” mode, Telegram/MAX auth, and saved player profiles.

```bash
npx wrangler deploy
```

The current Worker URL is configured in the frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Players do not see this URL. To change the backend, update `window.SALVO_CONFIG.workerUrl` in every source shell and redeploy Pages.

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

### Telegram Stars webhook operations

Telegram permits only one webhook per bot, so registration is an explicit
production operation. It is not part of tests, builds, Pages deployment, native
packaging, or Worker deployment. Before running the sequence below, inject
`TELEGRAM_BOT_TOKEN` and the same high-entropy `TELEGRAM_WEBHOOK_SECRET` into an
ephemeral operator shell using the team secret manager. The ellipses below are
placeholders, not values to commit or paste into shared logs. Keep the bot token
exported in that shell for the final read-only check.

Run the production operations in this exact order:

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:stars:webhook:set
npm run telegram:stars:webhook:check
```

`telegram:stars:webhook:set` registers
`https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook` for only
`message` and `pre_checkout_query` updates, preserves pending updates, and then
checks the exact registered URL. `telegram:stars:webhook:check` is read-only.
Both commands print only the public webhook URL and redact Telegram responses.
Do not run either command against a second environment that uses the same bot.

The real 8-Star smoke test is manual and requires explicit operator action. It
must never run in CI or as part of deployment.

For a legitimate manual refund, ask the requester to send `/paysupport` in a
private chat with `@agents_salvo_bot` and put only the returned safe support
reference in the GitHub issue. The bot derives that reference from the
requester's Telegram identity; it never sends a charge ID, payload, user ID, or
session token. Inspect the payment privately in the D1 console. Query
`star_support_payments` by that support reference (the opaque `invoice_id`) and
verify that `status = 'paid'`, `currency = 'XTR'`, and
that `telegram_user_id` and `telegram_payment_charge_id` are present. Keep the
following query and its result in the private operator session:

```sql
SELECT invoice_id, telegram_user_id, telegram_payment_charge_id,
       amount, currency, status, paid_at
  FROM star_support_payments
 WHERE invoice_id = ? AND status = 'paid';
```

From an approved private Telegram Bot API client, call
`refundStarPayment` with exactly the stored `telegram_user_id` as `user_id` and
the stored `telegram_payment_charge_id` as `telegram_payment_charge_id`. Supply
the bot token from the secret manager; never place it, the charge ID, or the
Telegram user ID in source control, shell history, screenshots, issues, or
shared logs. Only after Telegram returns `ok: true`, mark that same row
`refunded` and set `refunded_at` in D1 using a parameterized private query. Never
change D1 first, and never refund from user-supplied identifiers.
The public support reference is a lookup key, not authority to redirect a
refund: Telegram can return Stars only to the original stored Telegram payer.

```sql
UPDATE star_support_payments
   SET status = 'refunded', refunded_at = ?
 WHERE invoice_id = ? AND status = 'paid'
   AND telegram_user_id = ? AND telegram_payment_charge_id = ?;
```

Use the current Unix timestamp in seconds for `refunded_at` and only values read
from the verified receipt for the remaining parameters.

## Online Protocol

- `POST /rooms` creates a room and returns `roomCode`, `playerId`, and `playerToken`.
- `POST /rooms/:roomCode/join` connects the second player.
- If `Authorization: Bearer ...` is present on create/join, the room stores that authenticated identity for server-side history.
- `GET /rooms/:roomCode/socket?playerId=...&token=...` opens a WebSocket.
- The client sends `placeFleet` and `fire`.
- The Durable Object validates turn order, never exposes opponent ships in snapshots, and records completed authenticated online matches in D1.

## Profile API

- `POST /auth/telegram` verifies Telegram Login Widget payloads and returns a signed session token.
- `POST /auth/telegram/miniapp` verifies signed Telegram Mini App launch data and creates an opaque D1-backed session.
- `POST /auth/max/miniapp` verifies signed MAX Mini App launch data and creates an opaque D1-backed session.
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
