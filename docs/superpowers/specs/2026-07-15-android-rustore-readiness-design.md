# Android RuStore Release Readiness Design

**Date:** 2026-07-15
**Status:** Approved for implementation
**Scope:** Telegram authentication for web and Android, mobile board sizing, and the first RuStore release

## Goal

Ship a production-signed Android build of Salvo that can pass RuStore moderation:
Telegram login works without embedding secrets, normal battle boards fit the phone
screen without a horizontal scrollbar, extended boards remain usable, and the release
is reproducible with a stable signing identity.

This design is an Android-first extension of
`docs/superpowers/specs/2026-07-13-ios-android-apps-design.md`. The existing iOS
project remains buildable, but iOS OIDC storage and App Store publication are not part
of this release.

## Release Boundary

The release contains three coordinated workstreams:

1. a shared Telegram OAuth 2.0 / OIDC backend and web migration plus an Android
   system-browser login client;
2. responsive 8x8 and 10x10 boards plus an explicit zoom viewport for 16x16;
3. a signed Android release, CI validation, privacy information, and RuStore listing
   assets.

The package name remains `io.github.agentaxiom.salvo`. Version code `1` and version
name `1.0.0` identify the first public release. The application remains free, has no
advertising, analytics, purchases, or donations inside the release build.

## Telegram Migration Strategy

Telegram's current BotFather Mini App calls the feature **Login Widget** and warns
that switching from the legacy widget to OAuth 2.0 is permanent. The switch must not
happen until compatible Worker and frontend code is already deployed.

The Worker exposes a public authentication-capability response. Before OAuth secrets
exist it reports `legacy`, so the deployed web app continues mounting the existing
Telegram widget. Once the bot is switched and both OAuth secrets are configured, it
reports `oidc`; web and Android then use the same OIDC start and redeem service. This
removes the need for a second frontend deployment during the cutover.

Cutover order:

1. deploy the dual-capable Worker and frontend while BotFather remains in legacy mode;
2. verify that legacy web login still works;
3. switch Login Widget to OAuth 2.0 in BotFather;
4. register the Worker callback and Pages origin;
5. store `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET` as Worker secrets;
6. deploy the Worker and verify its capability response is `oidc`;
7. verify web and Android login, logout, restart restoration, cancellation, and replay
   rejection.

No Telegram client secret, bot token, authorization code, ID token, login ticket, or
session token is placed in the web bundle, Android resources, logs, URLs after ticket
redemption, CI artifacts, or Git history.

## OIDC Architecture

### Worker endpoints

```text
GET  /auth/telegram/config
POST /auth/telegram/mobile/start
GET  /auth/telegram/mobile/callback
POST /auth/telegram/mobile/redeem
```

`GET /auth/telegram/config` returns only the active method and never returns client
credentials.

`POST /auth/telegram/mobile/start` accepts `platform` (`web`, `android`, or `ios`). It
creates random state, nonce, and a PKCE verifier, stores a five-minute flow record in
D1 under a SHA-256 state hash, and returns Telegram's authorization URL. The callback
URI is fixed server-side to:

```text
https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/mobile/callback
```

The callback atomically consumes the flow, exchanges the code server-side, verifies
the Telegram ID token signature and claims, and creates a random single-use login
ticket. Successful Android callbacks redirect to `salvo://open/auth/<ticket>`.
Successful web callbacks redirect to the canonical GitHub Pages URL with a temporary
ticket query parameter. Errors return a small localized-safe error code, not provider
payloads.

`POST /auth/telegram/mobile/redeem` atomically consumes the ticket and returns a Salvo
session and public user. A ticket expires after five minutes and a second redemption
always fails.

### Token verification

The Worker validates all of the following before trusting Telegram user data:

- JWT structure, `alg=RS256`, `kid`, and signature against Telegram JWKS;
- issuer `https://oauth.telegram.org`;
- audience equal to `TELEGRAM_CLIENT_ID`;
- expiry, issued-at bounds, and the flow nonce;
- a non-empty Telegram subject/user identifier.

JWKS responses may be cached using normal HTTP caching. A missing key triggers one
fresh fetch; invalid tokens fail closed.

### Revocable Salvo sessions

OIDC and legacy login both begin issuing opaque random Salvo session tokens. D1 stores
only SHA-256 token hashes, user keys, creation time, expiry, and last-used time. Every
private HTTP route and room creation/join resolves the bearer token through the same
session service. Logout deletes the current session.

The release performs the previously approved hard cutover from signed self-contained
tokens. Existing sessions are invalidated once and users sign in again. This makes
logout and later account deletion enforceable server-side.

### D1 records

A new migration adds:

- `auth_sessions` for revocable bearer sessions;
- `telegram_oidc_flows` for short-lived state, nonce, PKCE verifier, platform, and
  expiry;
- `telegram_login_tickets` for hashed one-time tickets and normalized public user
  data;
- indexes for token lookup and bounded expiry cleanup.

Flow and ticket consumption uses one atomic `UPDATE ... RETURNING` operation. Cleanup
deletes a bounded number of expired rows opportunistically and never blocks a valid
login response.

## Android Authentication Client

The settings authentication control becomes an explicit **Sign in with Telegram**
button. It remains optional for local modes and required for online rooms, profiles,
leaderboards tied to identity, and cloud replays.

On tap, Android requests a start URL and opens it with Capacitor Browser. The existing
single-task activity receives `salvo://open/auth/<ticket>`, closes the browser, redeems
the ticket, commits the authenticated UI state, refreshes the profile, and returns to
the screen from which login started. Cancellation, timeout, offline state, malformed
links, and replayed tickets show a retryable translated message.

The deep-link parser accepts only the canonical Salvo custom scheme and a strict
base64url-style ticket. It never accepts arbitrary callback origins, credentials,
fragments, or return URLs.

### Android secure storage

A focused Capacitor Android plugin stores the Salvo session using an AES-GCM key held
in Android Keystore. SharedPreferences contains only IV and ciphertext. The plugin
supports `get`, `set`, and `clear`; corrupt or undecryptable values are removed and
reported as unavailable rather than returned.

Android backup is disabled for this release so encrypted session material cannot be
restored without its Keystore key. Cleartext network traffic is disabled. The only
requested Android permission remains `INTERNET`.

## Board Sizing

### 8x8 and 10x10

On viewports up to 720 CSS pixels, boards of size 10 or smaller use the full available
panel width. Coordinate labels reserve a small fixed gutter and every grid track uses
an equal fraction of the remaining width. Cells have no fixed `44px` minimum, and the
wrapper has no horizontal overflow. This applies to setup, battle, training, replay,
and both visual styles.

The complete board, border, and coordinate labels must fit at 320, 360, 390, 412, and
480 CSS-pixel viewport widths. The board remains square and no page-level horizontal
overflow is introduced.

### 16x16

The extended board keeps a minimum readable cell size inside a dedicated horizontal
viewport. A compact toolbar provides zoom out, reset, and zoom in controls with a
visible percentage. Zoom is clamped to documented minimum and maximum values, shared
between the currently visible extended boards, and reset when a new game starts.
Touch panning uses native scrolling; there is no custom gesture recognizer.

Normal 8x8 and 10x10 boards never show this toolbar or scrollbar.

## RuStore Release

### Artifact and signing

The first submission uses a universal, production-signed APK because it avoids the
additional RuStore App Bundle signing setup. CI also produces a signed AAB for future
distribution. Both artifacts use the same permanent upload key.

The keystore is generated once outside Git, backed up by the owner, and represented in
CI as base64 plus alias/store/key password secrets. Gradle reads signing data only from
environment variables. A missing release secret fails the release task instead of
silently signing with the debug key. Debug CI builds remain unchanged.

A manually dispatched release workflow runs tests, coverage, web build, Capacitor
sync, Android unit tests, lint, instrumentation smoke tests, `assembleRelease`, and
`bundleRelease`. It verifies the APK signature and uploads checksum-labelled artifacts.

### Store materials

The repository contains a RuStore release folder with:

- Russian application name, short description, full description, and release notes;
- support URL `https://github.com/agent-axiom/agents-salvo/issues` and privacy-policy
  URL `https://agent-axiom.github.io/agents-salvo/privacy.html`;
- data-safety answers matching actual behavior;
- a 512x512 opaque store icon;
- at least five Russian phone screenshots in 9:16 format showing menu, setup, battle,
  online lobby, and profile/leaderboard;
- a moderation checklist and Telegram login instructions.

The public privacy page explains Telegram profile fields, match/profile storage,
retention, processors, deletion contact, and that local gameplay works without an
account. The app links to this page beside the login action.

### Moderation readiness

Before submission, all declared functionality must be reachable. The moderator notes
explain that local play requires no account and provide a repeatable Telegram login
path for online features. The APK must contain no prohibited permissions, external
store links, advertising, analytics, payment SDKs, or web-only redirect shell.

Actual RuStore Console registration, legal declarations about personal-data operator
status, developer contact details, and the final **Submit for moderation** action are
owner-controlled steps and cannot be inferred or committed to source control.

## Error Handling

- Missing OAuth configuration preserves legacy web login and disables Android login
  with a clear retry state.
- Telegram denial or cancellation returns to Salvo without creating a ticket/session.
- Expired, consumed, malformed, or mismatched state and tickets return generic errors
  and never disclose whether another identity completed the flow.
- D1 or Telegram outage leaves all local modes available.
- Keystore failure prevents authenticated state from being committed and does not
  fall back to plaintext Preferences.
- A failed RuStore release build produces no unsigned or debug-labelled publishable
  artifact.

## Testing And Acceptance

### Automated

- Worker tests cover start validation, state/PKCE generation, callback errors, token
  exchange, RS256/JWKS and claim validation, ticket atomicity, replay rejection,
  cleanup, opaque sessions, logout, and CORS.
- Browser/application tests cover legacy capability fallback, OIDC button states,
  web ticket capture/removal, Android start/redeem flow, cancellation, stale requests,
  secure-storage failure, and translated errors.
- Platform tests cover strict auth deep links and secure plugin calls.
- Android instrumentation tests prove session round-trip, clear, overwrite, and that
  plaintext tokens are absent from SharedPreferences.
- Responsive tests prove 8x8/10x10 fit rules and 16x16-only zoom controls.
- Existing test and coverage thresholds remain enforced.

### Visual and device verification

- Capture light and dark screenshots at 360x800 and 412x915 for setup and active
  battle; no 8x8/10x10 horizontal scrollbar or clipped coordinate is allowed.
- Exercise 16x16 zoom at minimum, reset, and maximum on an Android emulator.
- Complete Telegram login, app restart, logout, and second login on an Android device
  using production Worker endpoints.
- Install the signed release APK on a clean emulator/device and run one local and one
  authenticated online match before RuStore upload.

## Definition Of Done

The work is complete when the production Worker supports the guarded OIDC cutover,
web login survives migration, Android login persists securely, 8x8/10x10 battles fit
the phone width, 16x16 zoom is usable, all automated and device checks pass, a stable
signed APK and checksums exist, and the RuStore draft contains complete technical and
visual materials. Publication is complete only after the owner submits that draft and
RuStore accepts it.
