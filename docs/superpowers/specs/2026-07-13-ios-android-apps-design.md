# iOS and Android Applications Design

**Date:** 2026-07-13
**Status:** Approved for implementation planning

## Goal

Ship the complete Salvo game as free iOS and Android applications while retaining
one shared game implementation, the existing GitHub Pages version, and the
Cloudflare backend.

The applications must feel like installed games rather than remote website
wrappers. Local play must start from bundled assets and remain available without
a network connection. Online rooms, Telegram profiles, leaderboards, and private
replays continue to use the existing Worker and D1 database.

## Product Decisions

- Release iOS and Android together from one shared codebase.
- Publish from personal Apple and Google developer accounts.
- Include all current modes and profile features in the first mobile release.
- Keep the game permanently free, with no advertising, purchases, donations,
  paid advantages, or external payment links.
- Use the immersive mobile layout: the battle board owns the viewport and
  context-specific Target, Fleet, and Log controls replace a permanent app-wide
  tab bar during battle.
- Support English, Russian, and Simplified Chinese at launch.
- Use `io.github.agentaxiom.salvo` as the stable iOS bundle identifier and Android
  application ID.

## Scope

The first mobile release includes:

- agent battles, training, same-device PvP, and authenticated online PvP;
- all current presets, including large boards and special markers;
- profiles, leaderboard, achievements, battle archive, and private replays;
- bundled web assets and offline access to local modes;
- Telegram OIDC login through the system browser;
- secure native session storage;
- app/universal links for rooms, replay links, and authentication callbacks;
- native share sheet, haptics, lifecycle handling, status bar, and splash screen;
- local unfinished-battle restoration;
- in-app and web account deletion;
- store metadata and screenshots in all three languages;
- CI validation for web, Android, and iOS;
- TestFlight, Google internal testing, Google closed testing, and production
  release preparation.

This release does not include push notifications, widgets, achievements from
Game Center or Google Play Games, cloud synchronization of unfinished local
battles, chat, advertising, payments, donations, or remote JavaScript updates.

## Chosen Architecture

Use Capacitor 8 as a thin native runtime around the existing standards-based web
application. The web build is copied into each application bundle; the native
applications never load their primary UI from GitHub Pages.

Capacitor was selected because the current project is already a static ES-module
application with responsive UI, local media assets, a separate HTTPS/WebSocket
backend, and extensive tests. A Swift/Kotlin rewrite would duplicate game logic
and create two new regression surfaces. Separate hand-written WebView shells
would reproduce Capacitor's lifecycle and plugin work without a product benefit.

Repository additions:

```text
capacitor.config.ts
android/
ios/
src/platform/
  index.js
  web.js
  native.js
src/mobile.js
```

`scripts/build.mjs` remains the source of the bundled `dist/` directory.
Capacitor uses `dist` as `webDir`. The regular Pages deployment continues to use
the same output.

The selected Capacitor 8 release is pinned in `package-lock.json`. Its supported
iOS and Android baselines define the minimum OS versions for the first release;
the exact pinned versions and generated project values are recorded during the
implementation plan and are not widened to unsupported legacy systems.

## Platform Boundary

Game and rendering modules remain platform-neutral. UI code talks only to a
small platform adapter with explicit capabilities:

```js
platform.isNative()
platform.getPlatform()
platform.getNetworkStatus()
platform.onNetworkChange(listener)
platform.share(payload)
platform.haptic(event)
platform.openExternalUrl(url)
platform.onDeepLink(listener)
platform.onBack(listener)
platform.onLifecycleChange(listener)
platform.secureSession.get()
platform.secureSession.set(token)
platform.secureSession.clear()
platform.settings.get(key)
platform.settings.set(key, value)
```

The web implementation maps these operations to existing browser APIs and
`localStorage`. The native implementation uses official Capacitor plugins where
available. Session tokens use a minimal first-party Capacitor plugin backed by
iOS Keychain and Android Keystore/EncryptedSharedPreferences; they never enter
WebView `localStorage`.

No platform module may import game rules or mutate board state. Unsupported
native capability calls degrade to documented no-ops rather than blocking play.

## Mobile Information Architecture

### Home

The home screen retains the existing game-first hierarchy:

1. Against agent;
2. Online battle;
3. Training;
4. Same-device battle.

Captain profile, leaderboard, and settings remain compact commands in the header
and do not become a persistent bottom tab bar.

### Setup

Fleet setup keeps the large board and sticky action controls. Random placement is
the fastest path, while manual placement remains fully available. The primary
command remains **Battle!**. Safe-area padding prevents controls from colliding
with the home indicator or Android navigation area.

### Battle

On phones, one large board is visible at a time. A context-specific bottom
selector switches between Target, My fleet, and Log. Turn status remains sticky
at the top. Profile and leaderboard are not exposed in the battle selector.

On tablets and useful landscape widths, the existing two-column tactical layout
shows the target board alongside the player's fleet and log. The large 16x16
board retains controlled pan/scroll behavior and never shrinks below usable touch
targets.

### Results And Replays

Results remain scrollable full-screen content. Tactical coaching stays
collapsible. Replay controls respect safe areas, reduced motion, and the same
mobile board selector used by live battle.

## Native Behavior

### Startup

The native splash screen uses the Salvo identity and hands off to bundled content
as soon as the root UI is ready. Startup does not wait for GitHub Pages, Telegram,
or the Worker. Profile refresh and network detection happen after local UI is
interactive.

### Orientation And Form Factors

Phones open in portrait and support landscape where it provides a usable board.
Tablets support portrait, landscape, and a two-column layout. Layout decisions are
based on available CSS dimensions, not device model detection.

### Back Navigation

Android system back and the iOS in-app back affordance follow the same order:

1. close the active dialog, popover, settings sheet, or coaching section;
2. return from detail to archive/profile;
3. return from setup or completed battle to the previous screen;
4. ask for confirmation before abandoning an unfinished battle;
5. on the home screen, Android back exits normally.

The browser history remains valid on the web but is not the only source of native
navigation truth.

### Lifecycle And Audio

Before background suspension, the app persists any unfinished local agent,
training, or same-device battle as a versioned local snapshot. Online rooms remain
server-authoritative and reconnect through the existing room protocol.

Menu music pauses when the app becomes inactive or another audio session takes
priority. It resumes only when audio is enabled and the app returns to the
appropriate screen. System interruption behavior takes precedence over game
audio.

### Haptics

Subtle haptics are allowed for valid ship placement, hit, sinking, and victory.
Invalid placement uses a distinct warning pattern. Settings expose a separate
Haptics toggle, defaulting to enabled on supported native devices. Reduced-motion
mode suppresses decorative pulses but does not silently change the user's haptic
preference. No gameplay result may depend on haptic availability.

### Sharing

Room invitations, battle summaries, and replay links use the native share sheet.
Clipboard copy remains a secondary explicit action. The app never sends a message
without the user confirming it in the destination share UI.

## Offline And Connectivity Model

The application shell, rules, agent, training content, local fleet placement,
audio, and imagery are bundled. These modes remain usable in airplane mode:

- agent;
- training;
- same-device PvP;
- previously started local battles.

Online rooms, Telegram login, profiles, leaderboard, and private archive require
the Worker. They remain visible when offline and show one recoverable offline
state with a retry command. Loss of connectivity never clears fleet placement,
local progress, credentials, or a loaded replay.

The Worker API maintains compatibility with at least the previous public mobile
version. Native binaries and bundled JavaScript update only through their stores;
GitHub Pages deployment cannot silently replace application code.

## Canonical Links

The Worker domain becomes the canonical mobile-link host because it can serve
both association files and web fallbacks:

```text
https://agents-salvo-room.if-ab6.workers.dev/open/room/<room-code>
https://agents-salvo-room.if-ab6.workers.dev/open/replay/<replay-id>
https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/mobile/callback
```

The Worker serves:

- `/.well-known/apple-app-site-association`;
- `/.well-known/assetlinks.json`;
- associated-link routes without intermediate tracking redirects.

When the app is installed, the OS opens the matching screen. Without the app, the
Worker redirects to the equivalent GitHub Pages screen. Apple Team ID and Android
release-certificate fingerprints are generated from the enrolled developer
accounts before store distribution. Development builds additionally use a
Salvo-specific custom scheme for simulator and local-device testing.

## Telegram Mobile Authentication

The existing legacy Telegram widget cannot be treated as the mobile login flow
because it depends on a website origin and popup communication. Mobile uses
Telegram OIDC in the system browser.

### Flow

1. The app calls `POST /auth/telegram/mobile/start` with its platform and return
   context.
2. The Worker creates a random state, nonce, and PKCE verifier, stores only the
   short-lived flow record, and returns the Telegram authorization URL.
3. The app opens that URL in the system browser.
4. Telegram redirects to the registered HTTPS Worker callback.
5. The Worker validates state, expiry, and nonce, exchanges the code using the
   server-side Telegram client secret, normalizes the Telegram profile, and marks
   the flow consumed.
6. The Worker creates a cryptographically random, single-use login ticket and
   redirects to the associated application link. No bearer session appears in
   the URL.
7. The app calls `POST /auth/telegram/mobile/redeem` with the ticket.
8. The Worker atomically consumes the ticket and returns a normal Salvo session.
9. The native adapter stores the session in Keychain or Keystore and restores the
   screen that requested authentication.

Cancel, denial, expired flow, mismatched state, replayed callback, or replayed
ticket returns the user to the requesting screen with a localized retry state.
The Worker never logs authorization codes, ID tokens, tickets, or bearer tokens.

BotFather Allowed URLs include the production Pages origin, the Worker callback,
and any release callback paths used by the final OIDC registration. Telegram
client secret and bot token remain Worker secrets.

## Revocable Sessions

The current self-contained signed bearer token cannot satisfy reliable account
deletion because a deleted user's unexpired token could recreate or access data.
All clients therefore migrate to opaque, server-revocable sessions.

Migration adds `auth_sessions` with:

- a SHA-256 hash of a random 256-bit bearer token;
- `user_key`;
- creation and expiry timestamps;
- optional last-used timestamp;
- a foreign key that deletes sessions with the user.

Raw session tokens exist only on the client and in the immediate login response.
Every authenticated route resolves the token hash and active user. Logout deletes
the current session. Account deletion deletes every session for that user.

The migration intentionally invalidates version-one stateless sessions once and
requires existing web users to sign in again. A hard cutover is safer and simpler
than a 30-day compatibility path that would weaken account deletion guarantees.

## Account Deletion And Privacy

Telegram login creates a Salvo account, so deletion is available both in the app
and on a public web route.

### In-App Deletion

Profile settings expose **Delete account**. The user sees exactly what will be
removed and must complete a separate destructive confirmation. The request uses
the current authenticated session and executes one D1 transaction.

Deletion:

- removes all sessions;
- removes the `users` row;
- cascades the user's own match history;
- removes the user from leaderboard calculations;
- uses an explicit nullable `opponent_user_key` on match rows to replace their
  name and username in the opponent's rows with a localized deleted-captain label
  and then clears that identity link;
- replaces their participant key in shared replay ACL data with a random
  non-reversible tombstone;
- rewrites the replay payload participant to a generic deleted captain without
  username or photo;
- removes that user's access to every previous replay;
- leaves the opponent's anonymized battle record and replay intact.

Signing in again later creates a new empty Salvo profile and does not reconnect
the new account to anonymized history.

The migration backfills `opponent_user_key` from replay participants where a
trusted replay relationship exists. Legacy online match rows without a replay
cannot be mapped safely, so their free-text opponent names are proactively
replaced with a generic historical-opponent label during migration. This avoids
retaining names that cannot later be attributed and deleted reliably.

### Web Deletion

GitHub Pages exposes a direct `/delete-account` experience linked from the public
privacy page and supplied to Google Play Console. It supports Telegram login,
shows the same disclosure, and calls the same deletion endpoint. It does not
require the mobile app to be installed.

### Privacy Disclosure

The privacy policy lists Telegram identifier, display name, username, optional
photo URL, match statistics, rating, online replay data, session metadata, and
short-lived OIDC flow records. It documents purpose, retention, processors,
deletion, and contact details.

No advertising, analytics, fingerprinting, contact, location, camera, microphone,
photo-library, or tracking SDK is included. Store privacy declarations must match
the production network behavior exactly.

## Backend Changes

Add a D1 migration for:

- opaque auth sessions;
- short-lived Telegram mobile OIDC flows;
- single-use login tickets;
- nullable match `opponent_user_key` linkage and legacy-name anonymization;
- indexes for token hash and expiry cleanup.

Add endpoints:

```text
POST   /auth/telegram/mobile/start
GET    /auth/telegram/mobile/callback
POST   /auth/telegram/mobile/redeem
DELETE /profile/me
GET    /open/room/:code
GET    /open/replay/:id
GET    /.well-known/apple-app-site-association
GET    /.well-known/assetlinks.json
```

Existing web Telegram login begins issuing opaque sessions through the same
session service. All authenticated profile, room, archive, and replay paths use
one authorization helper. The leaderboard remains intentionally public and never
exposes internal user keys or session data.

Expired flows, tickets, and sessions are deleted opportunistically in bounded
batches and by scheduled maintenance. Cleanup failure does not block login or
gameplay.

## Error Handling

- Bundled-content startup failure shows a native recovery screen rather than a
  blank WebView.
- Worker unavailability leaves local modes functional and online data unchanged.
- Network interruption during setup preserves the current fleet.
- Network interruption during an online battle reconnects to authoritative room
  state and never fabricates a turn locally.
- Invalid or expired deep links open a localized safe screen with Main menu.
- Authentication cancellation restores the requesting screen without creating a
  partial session.
- Secure-storage failure fails closed for authenticated features and never falls
  back to plaintext token storage.
- Corrupt local battle snapshots are quarantined and replaced by a clean setup;
  settings remain intact.
- Unsupported persisted-data versions show a recoverable migration error and do
  not partially render a board.
- Share failure leaves a copy-link fallback.

## Accessibility

- Interactive controls remain at least 44 CSS pixels on mobile.
- VoiceOver and TalkBack labels include coordinate and cell state.
- Keyboard support remains available for tablets with hardware keyboards.
- Text enlargement must not cover boards or commands.
- Reduced motion disables tracer, pulse, and transition movement.
- Haptics and audio have independent settings controls.
- Light and dark themes retain the existing distinct miss, hit, and sunk states.

## Testing Strategy

### Shared Tests

Keep the existing Node test suite and the 98% line-coverage gate. Add unit tests
for the platform adapter, local snapshot versioning, deep-link parsing, lifecycle
transitions, and offline state reduction.

### Worker Tests

Add deterministic tests for:

- OIDC start, state, nonce, PKCE, callback, and ticket redemption;
- expiry and replay rejection;
- redaction of secrets and tokens from responses and logs;
- opaque session issuance, validation, logout, expiry, and hard cutover;
- transactional account deletion and replay anonymization;
- account recreation without history recovery;
- association files and fallback links;
- failure and retry behavior for D1 operations.

### Native Build Checks

CI runs:

1. `npm test`;
2. `npm run coverage`;
3. `npm run build`;
4. Capacitor sync verification;
5. Android lint, unit tests, and debug bundle build;
6. iOS unit tests and unsigned Simulator build on a macOS runner.

Release signing is enabled only after developer enrollment and secrets are stored
in GitHub encrypted environments. Pull-request CI never receives production
signing credentials.

### Device Matrix

Manual and automated smoke testing covers:

- a compact phone viewport;
- a current standard iPhone viewport;
- a narrow and a wide Android viewport;
- iPad/tablet portrait and landscape;
- light/dark theme;
- all three languages;
- offline startup and reconnection;
- interrupted audio and background restoration;
- room and replay associated links;
- Telegram login and account deletion on physical iOS and Android devices.

App Store Connect and Google Play Console system crash reports are used after
distribution. No third-party crash SDK is added.

## Distribution

### Accounts

The owner enrolls as an individual in Apple Developer Program and Google Play
Console. The first release remains buildable in simulators before enrollment, but
device signing, associated-domain identifiers, TestFlight, closed Play testing,
and production submission require the enrolled accounts.

The new personal Google account requires device verification and a closed test
with at least 12 opted-in testers for 14 continuous days before production access.
This waiting period is part of the release schedule, not engineering time.

### Store Assets

Prepare:

- app icon and adaptive Android icon;
- native splash artwork;
- localized app name: Salvo, Залп, 齐射;
- English, Russian, and Simplified Chinese descriptions;
- phone and tablet screenshots from real application builds;
- support URL, privacy URL, and deletion URL;
- Apple privacy answers and Google Data safety answers;
- reviewer notes explaining optional Telegram login and unrestricted local modes.

Apple review receives a fully functional agent/local mode without credentials and
clear instructions for testing authenticated online features. Google testers use
the same production-like Worker environment with isolated test accounts.

### Rollout

1. Local simulator and physical-device development builds.
2. TestFlight internal testing and Google internal testing.
3. TestFlight external beta where useful and mandatory Google closed testing.
4. Store review with phased/staged rollout.
5. Production monitoring through store-native crash and performance reports.

The GitHub Pages release remains live throughout and continues to share the same
backend and user accounts.

## Store Compliance References

- Capacitor documentation: https://capacitorjs.com/docs
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple account deletion guidance: https://developer.apple.com/support/offering-account-deletion-in-your-app
- Google Play account deletion requirements: https://support.google.com/googleplay/android-developer/answer/13327111
- Google Play personal-account testing: https://support.google.com/googleplay/android-developer/answer/14151465
- Telegram Login and OIDC: https://core.telegram.org/bots/telegram-login

## Success Criteria

The design is complete when:

- the same rules and visible game state produce equivalent behavior on web, iOS,
  and Android;
- local modes start and remain playable without a network connection;
- online rooms, profiles, leaderboard, and replay archive work with the existing
  production backend;
- Telegram login returns safely to the requesting app screen;
- room and replay links open the installed app with a correct web fallback;
- session tokens are never stored in WebView plaintext storage on native devices;
- account deletion invalidates all sessions and removes or anonymizes every
  associated record as specified;
- mobile layouts have no incoherent overlap or page-level horizontal overflow;
- all automated gates pass and both stores accept the production binaries.
