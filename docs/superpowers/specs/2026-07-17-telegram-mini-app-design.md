# Telegram Mini App Design

**Date:** 2026-07-17  
**Status:** Approved for implementation planning

## Goal

Ship the complete Salvo game as a Telegram Mini App while retaining one source
of truth for game rules, UI, styles, localizations, audio, and visual assets.
The same source tree must produce the GitHub Pages site, the Telegram Mini App,
and the bundled Capacitor applications for Android and iOS.

The Mini App includes all current game modes and account features. It must feel
native inside Telegram, authenticate the Telegram user automatically, and reuse
the same player identity, profile, leaderboard, achievements, online rooms, and
private replay archive as the existing web and native clients.

## Product Decisions

- Include agent battles, authenticated online play, same-device play, training,
  every rules preset, profiles, leaderboard, achievements, and replays.
- Maintain one implementation of game behavior and one shared application UI.
- Keep the game free and do not add advertising, purchases, or paid advantages.
- Host the first Mini App release on the existing GitHub Pages deployment.
- Configure `@agents_salvo_bot` as the Main Mini App and expose a bot menu entry.
- Use Telegram launch parameters for room invitations and replay links.
- Preserve the existing Telegram OIDC flows for the website and native apps.
- Authenticate Mini App users with server-validated `Telegram.WebApp.initData`.
- Keep the primary game commands in the shared game UI. Use Telegram-native UI
  only for navigation, settings entry, confirmations, sharing, viewport control,
  lifecycle, and haptics.

## Alternatives Considered

### Separate Telegram fork

A fork would allow unrestricted Telegram-specific changes, but every game bug,
rules change, localization update, and asset improvement would need to be copied
between projects. The resulting drift and regression risk make this unsuitable.

### Target-specific application bundles

Conditional bundles could remove unused platform code, but would create several
build products with subtly different behavior and broaden the test matrix. The
current application is small enough that this optimization has no product value.

### Shared application bundle with thin runtime shells

This is the selected approach. The website and Telegram route load the same
hashed JavaScript and CSS outputs. Capacitor packages the same application build
from the root web shell. Only runtime adapters and the HTML bootstrap differ.

## Architecture

The existing core and UI remain shared:

```text
src/
  core/                         game rules, AI, statistics, training, replays
  app.js                        shared application UI and workflows
  styles.css                    shared responsive visual system
  i18n.js                       Russian, English, and Simplified Chinese
  assets/                       shared images and audio
  platform/
    index.js                    runtime selection
    web.js                      browser capabilities
    native.js                   Capacitor capabilities
    telegram.js                 Telegram Mini App capabilities
  auth/
    telegram-mini-app.js        Mini App auth client and bootstrap
  index.html                    website and Capacitor shell
  telegram/
    index.html                  Telegram SDK shell
```

The platform selection order is explicit:

1. a Capacitor native runtime selects `native`;
2. the Telegram shell with an initialized Telegram WebApp SDK selects `telegram`;
3. every other context selects `web`.

The Telegram shell opened outside Telegram does not silently fall back to the
normal website. It renders a localized explanation and an explicit command to
open the Main Mini App in Telegram.

Game modules do not import Telegram or Capacitor APIs. The Telegram adapter does
not import game rules or mutate board state. Shared UI code communicates through
the existing platform boundary, extended with runtime-neutral capabilities only
where the current interface cannot express Telegram behavior.

## Build Outputs

One `npm run build` produces:

```text
dist/
  index.html
  telegram/index.html
  app.<content-hash>.js
  styles.<content-hash>.css
  assets/
```

Both HTML shells reference the same application and stylesheet hashes. The
Telegram shell additionally loads the official `telegram-web-app.js` SDK before
the application bootstrap and marks the requested runtime as Telegram.

The deployment model is:

- GitHub Pages publishes all of `dist`;
- the website opens `dist/index.html`;
- the Mini App opens `dist/telegram/index.html`;
- Capacitor packages the root application from `dist` for Android and iOS.

Pages and the Mini App update as soon as the selected commit is deployed.
Android and iOS contain the same source revision but update only through store
releases. Every output exposes the source commit or build identifier in settings
so deployed versions can be diagnosed accurately.

## Telegram Platform Adapter

The adapter maps Telegram functionality to the shared platform contract:

- network status uses browser online/offline events;
- sharing opens Telegram-native invite or replay flows, with copy fallback;
- haptic events map to `Telegram.WebApp.HapticFeedback`;
- back navigation maps to `Telegram.WebApp.BackButton`;
- lifecycle maps to `activated` and `deactivated` events;
- settings entry maps to `Telegram.WebApp.SettingsButton`;
- viewport and safe-area events update CSS runtime variables;
- external Telegram links use `openTelegramLink`;
- ordinary external links use `openLink`;
- application preferences retain the current shared settings abstraction.

Unsupported Telegram features degrade without blocking local play. Capability
checks use the reported Telegram WebApp version before invoking newer APIs.

The adapter calls `ready()` when the essential first screen is rendered,
expands the Mini App, and requests fullscreen on supported clients. A rejected
or unsupported fullscreen request keeps the responsive non-fullscreen layout.

## Authentication

The Mini App does not show a Telegram login button. It sends the raw string from
`Telegram.WebApp.initData` to a dedicated Worker endpoint:

```http
POST /auth/telegram/miniapp
Content-Type: application/json

{"initData":"query_id=...&user=...&auth_date=...&hash=..."}
```

The Worker performs these steps:

1. enforce method, content type, request size, and an exact JSON shape;
2. parse the query string without collapsing duplicate fields;
3. reject missing, duplicated, malformed, or unsupported fields;
4. construct the alphabetical data-check string defined by Telegram;
5. derive the `WebAppData` HMAC key from `TELEGRAM_BOT_TOKEN`;
6. compare the supplied and expected hashes in constant time;
7. reject an `auth_date` older than five minutes or more than sixty seconds in
   the future;
8. validate and normalize the Telegram user object;
9. create a regular Salvo session through the existing session service;
10. return the existing `{ token, user }` response shape.

Raw `initData` is never logged or persisted. The returned Salvo session token is
held in memory by the Mini App and is replaced by a fresh automatic exchange on
the next launch. A page reload can exchange the still-fresh launch data again;
expired launch data requires reopening the Mini App.

The normalized user key remains `telegram:<id>`. A player therefore sees the
same account whether authentication originated from web OIDC, native OIDC, the
legacy login flow, or Mini App launch data. No account migration or duplicate
profile is created.

`initDataUnsafe` may be used only for non-authoritative presentation before the
server response. It never grants access to a profile, room, leaderboard action,
or replay.

## Mini App Information Architecture

### Startup and home

The Mini App opens at full available height and shows the shared game hub. After
authentication, the header displays the verified Telegram name and avatar. The
login command is absent. A failed online bootstrap leaves agent, training, and
same-device play available.

The verified Telegram language is used as the initial language when the player
has not already selected one. A user preference continues to override the
Telegram language.

### Setup and battle

Fleet setup and battle use the same mobile-first layouts as the web and native
clients. On phones, a single board occupies the available width and the Target,
Fleet, and Log controls switch context. Horizontal page or board scrolling is
not permitted. On sufficiently wide Telegram Desktop windows, the shared
two-column tactical layout is used.

The 16x16 preset also fits the available width. Its target interaction provides
a prominent focus marker and coordinate feedback so smaller cells remain
selectable without horizontal scrolling.

Telegram safe-area and content-safe-area values are reflected in CSS custom
properties. Stable viewport height is used for bottom positioning; the animated
viewport height is not used to pin controls during resize gestures.

### Navigation and closing

Telegram BackButton follows the shared navigation hierarchy:

1. close the active dialog;
2. close settings, profile, leaderboard, coaching, or another overlay;
3. leave replay or setup for its parent screen;
4. request confirmation before abandoning an unfinished battle;
5. hide the BackButton on the home screen.

Telegram closing confirmation is enabled only while an unfinished battle can be
lost. It is disabled after a battle ends or the user returns to the home screen.

### Lifecycle, theme, audio, and haptics

`deactivated` pauses music and transient visual effects. `activated` resumes
only the audio appropriate for the current screen and the user's sound setting.

Telegram's light or dark scheme supplies the initial theme. The existing game
theme remains user-selectable and readable in both schemes. Theme and viewport
changes are processed without reloading the game.

Shared haptic events map to Telegram feedback:

- placement: light impact;
- hit: medium impact;
- sunk: heavy impact;
- invalid placement: warning notification;
- victory: success notification;
- defeat: error notification.

Gameplay never depends on haptic availability.

## Rooms, Replays, and Sharing

The bot is configured as a Main Mini App. The canonical Telegram launch forms
are:

```text
https://t.me/agents_salvo_bot?startapp
https://t.me/agents_salvo_bot?startapp=room_ABCD
https://t.me/agents_salvo_bot?startapp=replay_<replay-id>
```

Launch parameters are parsed by a strict shared module. Room values match
`room_[A-Z0-9]{4,12}`. Replay values consist of the `replay_` prefix followed by
the existing `[A-Za-z0-9-]{1,128}` replay identifier. An invalid value opens the
home screen and does not become a general-purpose internal route.

A room invitation follows this flow:

1. an authenticated captain creates an online room;
2. the Mini App builds the canonical `startapp=room_<code>` link;
3. the player chooses a Telegram chat through a native share flow;
4. the recipient opens the Main Mini App and authenticates automatically;
5. the app opens the online lobby and joins the referenced room;
6. normal server-authoritative room behavior continues unchanged.

Replay links open the replay screen after authentication and the existing replay
authorization check. Failure to access an absent or private replay produces the
existing recoverable replay error.

The first release uses `openTelegramLink` with Telegram's `t.me/share/url` flow
and falls back to copying the canonical launch link. Prepared inline messages
and bot-authored rich result cards remain a later enhancement.

## Offline and Failure Behavior

- Missing Telegram SDK or launch data on the Telegram route shows an open-in-
  Telegram state rather than a misleading login failure.
- Invalid or expired `initData` tells the user to reopen the Mini App.
- Worker failure leaves local modes available and gives online features a retry
  action without clearing local progress.
- A full, missing, or closed room returns the user to the online lobby with a
  localized explanation.
- Invalid launch parameters are ignored safely and open the home screen.
- Fullscreen, haptics, settings button, and native sharing are optional runtime
  capabilities with documented fallbacks.
- Deactivation or viewport changes never discard fleet setup or active local
  battle state.

## BotFather Configuration

After the Worker endpoint and Pages route are deployed:

1. open `@agents_salvo_bot` in BotFather;
2. enable the Main Mini App;
3. set `https://agent-axiom.github.io/agents-salvo/telegram/` as its URL;
4. request `salvo` as the short name and use `agents_salvo` if it is unavailable;
5. configure the bot menu command as the localized equivalent of `Play`;
6. upload Russian, English, and Chinese descriptions, screenshots, and previews;
7. set loading-screen colors and icon to match the Salvo identity.

The Mini App URL remains HTTPS and contains no credentials or environment
secrets. The existing website Login Widget and OIDC configuration remain
independent of Main Mini App configuration.

## Privacy and Security

- Trust only server-validated Telegram launch data.
- Keep `TELEGRAM_BOT_TOKEN` exclusively in Worker secrets.
- Compare authentication hashes in constant time.
- Enforce a short launch-data lifetime through `auth_date`.
- Reject duplicate query keys instead of accepting ambiguous input.
- Bound request and field sizes before parsing nested JSON.
- Never put launch data, authorization codes, or Salvo session tokens in URLs.
- Never log raw launch data or session tokens.
- Continue enforcing authorization in Durable Objects and D1-backed profile and
  replay endpoints; client runtime detection grants no server permission.
- Update the privacy notice to describe Mini App launch data and its purpose.

## Testing and CI

Automated coverage includes:

- runtime selection for web, Capacitor, Telegram, and Telegram-shell fallback;
- adapter behavior with a deterministic fake `Telegram.WebApp`;
- BackButton, settings, fullscreen, lifecycle, theme, viewport, safe area,
  external links, sharing, and haptic mappings;
- automatic auth bootstrap and absence of a login command in Mini App mode;
- room and replay launch-parameter parsing;
- exact identity compatibility with existing `telegram:<id>` profiles;
- valid Mini App signature verification;
- tampered signature, wrong token, stale or future `auth_date`, duplicate keys,
  malformed user JSON, missing fields, and oversized request rejection;
- local-mode fallback when automatic authentication or the Worker fails;
- build assertions that both shells reference the same JS and CSS artifacts.

The existing test and coverage gates remain active. CI additionally verifies the
web and Telegram output before Capacitor synchronization:

```text
tests -> coverage -> shared web/telegram build -> Capacitor sync
      -> Android checks -> iOS checks
```

The pre-release manual matrix covers Telegram Android, iOS, and Desktop; all
three languages; light and dark themes; every game mode; 8x8, 10x10, and 16x16
boards; room invitations; replay links; backgrounding and returning to battle;
and fallback behavior on clients without newer fullscreen APIs.

## Rollout Order

1. Add the Worker Mini App auth endpoint and cryptographic tests.
2. Add the Telegram platform adapter and deterministic adapter tests.
3. Produce the Telegram shell from the shared build.
4. Add automatic auth bootstrap and account-state UI behavior.
5. Integrate fullscreen, BackButton, settings, safe areas, lifecycle, and haptics.
6. Add strict room and replay launch handling plus Telegram sharing.
7. Extend CI and complete the manual compatibility matrix.
8. Deploy the Worker and GitHub Pages outputs.
9. Enable and publish the Main Mini App through BotFather.

## Success Criteria

- A change to shared game rules or UI reaches web, Telegram, Android, and iOS
  from the same source revision without copying code.
- A Telegram user enters the Mini App without a separate login interaction and
  sees the same profile and history used by other Salvo clients.
- Every current mode and preset is playable inside Telegram.
- Phone battle boards fit the available width without horizontal scrolling.
- Room invite links open and join the intended authenticated online lobby.
- Invalid or expired Telegram data cannot create a Salvo session.
- Existing website and native authentication continue to work unchanged.

## References

- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [Validating Mini App data](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
