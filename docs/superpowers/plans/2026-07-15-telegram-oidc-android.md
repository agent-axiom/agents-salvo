# Telegram OIDC And Android Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unavailable native Telegram login with a Worker-mediated OAuth 2.0/OIDC flow while preserving legacy web login until BotFather cutover and storing Android sessions in Keystore-backed encryption.

**Architecture:** Focused Worker modules own opaque Salvo sessions and Telegram OIDC cryptography/storage. A small browser client starts and redeems login tickets; `app.js` only coordinates UI state. Android exposes a three-method Capacitor plugin backed by AES-GCM in Android Keystore.

**Tech Stack:** Cloudflare Workers, D1 SQLite, Web Crypto, Node test runner, Capacitor 8, Java/Android Keystore, AndroidX instrumentation.

---

## File Map

- Create `migrations/0003_mobile_oidc_sessions.sql`: D1 session, flow, and ticket schema.
- Create `worker/session.js`: opaque token creation, resolution, revocation, and cleanup.
- Create `worker/telegram-oidc.js`: PKCE, Telegram token exchange, JWKS verification, flow/ticket persistence.
- Modify `worker/auth.js`: export Telegram user normalization and remove signed-session ownership.
- Modify `worker/index.js`: OIDC routes, capability route, opaque authorization, real logout.
- Create `src/telegram-auth.js`: frontend capability/start/redeem and bootstrap-ticket parsing.
- Modify `src/mobile-app-support.js`: strict authentication deep-link parsing.
- Modify `src/platform/native.js`: browser close and secure-session plugin adapter.
- Modify `src/app.js`: OIDC UI, flow lifecycle, web callback, and legacy fallback.
- Modify `src/i18n.js`: English, Russian, and Chinese authentication states.
- Create `android/app/src/main/java/io/github/agentaxiom/salvo/SalvoSecureSessionPlugin.java`: Keystore storage.
- Modify `android/app/src/main/java/io/github/agentaxiom/salvo/MainActivity.java`: register plugin.
- Modify `android/app/src/main/AndroidManifest.xml`: disable backup and cleartext traffic.
- Create focused Node and Android tests listed below.

### Task 1: Add Revocable Session Storage

**Files:**
- Create: `migrations/0003_mobile_oidc_sessions.sql`
- Create: `worker/session.js`
- Create: `tests/session.test.mjs`
- Modify: `worker/profile.js`

- [ ] **Step 1: Write failing session tests**

Cover raw-token secrecy, successful lookup, expiry, revocation, unknown tokens, and
bounded cleanup. The public API under test is:

```js
const { token } = await createSession(db, telegramUser, { now: 1_752_576_000 });
assert.equal(token.split(".").length, 1);
assert.deepEqual(await resolveSession(db, token, { now: 1_752_576_001 }), telegramUser);
assert.equal(db.serializedRows().includes(token), false);
await revokeSession(db, token);
await assert.rejects(resolveSession(db, token), /Session invalid/);
```

- [ ] **Step 2: Run the session test and verify RED**

Run: `node --test tests/session.test.mjs`

Expected: FAIL because `worker/session.js` does not exist.

- [ ] **Step 3: Add the D1 migration**

Create tables with concrete columns and indexes:

```sql
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_key) REFERENCES users(user_key) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE telegram_oidc_flows (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'android', 'ios')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX telegram_oidc_flows_expiry_idx ON telegram_oidc_flows(expires_at);

CREATE TABLE telegram_login_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX telegram_login_tickets_expiry_idx ON telegram_login_tickets(expires_at);
```

- [ ] **Step 4: Implement the minimal session service**

Export these functions from `worker/session.js`:

```js
export async function createSession(db, user, options = {}) {}
export async function resolveSession(db, token, options = {}) {}
export async function revokeSession(db, token) {}
export async function cleanupExpiredAuthRecords(db, options = {}) {}
```

Generate 32 random bytes, expose only base64url, persist `SHA-256(token)`, use a
30-day default TTL, and upsert the normalized user before inserting the session.
Move or export the existing user upsert helper from `worker/profile.js` instead of
duplicating user normalization SQL.

- [ ] **Step 5: Run session tests and the existing profile tests**

Run: `node --test tests/session.test.mjs tests/profile.test.mjs`

Expected: PASS with zero failed tests.

- [ ] **Step 6: Commit the session storage slice**

```bash
git add migrations/0003_mobile_oidc_sessions.sql worker/session.js worker/profile.js tests/session.test.mjs
git commit -m "feat: add revocable auth sessions"
```

### Task 2: Implement Telegram OIDC Cryptography

**Files:**
- Create: `worker/telegram-oidc.js`
- Create: `tests/telegram-oidc.test.mjs`
- Modify: `worker/auth.js`

- [ ] **Step 1: Write failing PKCE and ID-token tests**

Generate an RSA key pair in the test with Web Crypto, sign a JWT, and assert:

```js
const request = await createTelegramAuthorization({
  clientId: "123456",
  redirectUri: CALLBACK_URL,
  platform: "android",
  randomBytes: deterministicRandomBytes,
});
assert.equal(request.url.searchParams.get("code_challenge_method"), "S256");
assert.equal(request.flow.platform, "android");

const user = await verifyTelegramIdToken(idToken, {
  clientId: "123456",
  nonce: request.flow.nonce,
  now: 1_752_576_000,
  loadJwks: async () => ({ keys: [publicJwk] }),
});
assert.equal(user.provider, "telegram");
```

Add independent failures for bad signature, wrong `kid`, `alg`, issuer, audience,
nonce, expiry, future `iat`, and missing subject.

- [ ] **Step 2: Run the crypto tests and verify RED**

Run: `node --test tests/telegram-oidc.test.mjs`

Expected: FAIL because the OIDC module is absent.

- [ ] **Step 3: Implement PKCE and JWT verification**

The module exports:

```js
export function oidcConfigured(env) {}
export async function createTelegramAuthorization(options) {}
export async function exchangeTelegramCode(options) {}
export async function verifyTelegramIdToken(idToken, options) {}
export function normalizeTelegramOidcUser(claims) {}
```

Use `crypto.subtle.importKey("jwk", ..., { name: "RSASSA-PKCS1-v1_5", hash:
"SHA-256" })`, strict base64url decoding, and an injectable JWKS loader/fetcher. Do
not add a JWT dependency.

- [ ] **Step 4: Export one Telegram user normalizer**

Update `worker/auth.js` so legacy and OIDC claims both produce the existing public
shape `{ provider, id, name, username, photoUrl }`. Keep legacy payload verification
unchanged at this step.

- [ ] **Step 5: Run crypto and legacy auth tests**

Run: `node --test tests/telegram-oidc.test.mjs tests/auth.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the OIDC crypto slice**

```bash
git add worker/telegram-oidc.js worker/auth.js tests/telegram-oidc.test.mjs tests/auth.test.mjs
git commit -m "feat: verify Telegram OIDC tokens"
```

### Task 3: Add OIDC Flow And Ticket Endpoints

**Files:**
- Modify: `worker/telegram-oidc.js`
- Modify: `worker/index.js`
- Create: `tests/telegram-oidc-worker.test.mjs`

- [ ] **Step 1: Write failing endpoint tests**

Test these exact behaviors through `worker.fetch`:

```js
assert.deepEqual(await jsonOf(fetchWorker("/auth/telegram/config")), { method: "legacy" });

const start = await postJson("/auth/telegram/mobile/start", { platform: "android" }, oidcEnv);
assert.equal(start.status, 200);
assert.match((await start.json()).authorizationUrl, /^https:\/\/oauth\.telegram\.org\/auth\?/);
```

Also assert invalid platform `400`, missing config `503`, state hash persistence,
callback denial redirect, callback exchange, one-use flow, one-use ticket, expiry,
generic errors, and no secret/token in redirect or JSON errors.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run: `node --test tests/telegram-oidc-worker.test.mjs`

Expected: FAIL with `404` for the new routes.

- [ ] **Step 3: Add strict route parsing and handlers**

Extend `routeRequest()` and the top-level dispatch for:

```js
{ kind: "authTelegramConfig" }
{ kind: "authTelegramMobileStart" }
{ kind: "authTelegramMobileCallback" }
{ kind: "authTelegramMobileRedeem" }
```

Store state and tickets by hash. Consume with:

```sql
UPDATE telegram_oidc_flows
SET consumed_at = ?
WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
RETURNING nonce, code_verifier, platform
```

Use the equivalent statement for tickets. Android success redirects to
`salvo://open/auth/<ticket>`; web success redirects to
`https://agent-axiom.github.io/agents-salvo/?auth_ticket=<ticket>`.

- [ ] **Step 4: Add bounded cleanup without blocking login**

After successful start/redeem, schedule cleanup through `ctx.waitUntil` when an
execution context exists; otherwise observe the promise. Delete at most 100 expired
rows per table.

- [ ] **Step 5: Run Worker OIDC tests**

Run: `node --test tests/telegram-oidc-worker.test.mjs tests/worker.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the endpoint slice**

```bash
git add worker/index.js worker/telegram-oidc.js tests/telegram-oidc-worker.test.mjs
git commit -m "feat: add Telegram OIDC ticket flow"
```

### Task 4: Cut Authentication Routes Over To Opaque Sessions

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/auth.js`
- Modify: `tests/worker.test.mjs`
- Modify: `tests/profile.test.mjs`
- Modify: `tests/replay-archive.test.mjs`

- [ ] **Step 1: Write failing logout and authorization tests**

Assert that both legacy `/auth/telegram` and OIDC redeem return opaque tokens, private
routes resolve them through D1, logout revokes only the current token, and the old
signed token is rejected after cutover.

- [ ] **Step 2: Run focused Worker tests and verify RED**

Run: `node --test tests/worker.test.mjs tests/profile.test.mjs tests/replay-archive.test.mjs`

Expected: FAIL because handlers still use `SESSION_SECRET` signatures and logout is a
no-op.

- [ ] **Step 3: Replace the shared authorization helper**

Change `requireUser(request, env)` to parse the bearer token and call
`resolveSession(env.DB, token)`. Legacy Telegram login calls `createSession`; OIDC
redeem does the same. `/auth/me` resolves the opaque session and `/auth/logout`
requires then revokes it.

- [ ] **Step 4: Update test authorization fixtures**

Replace direct `createSessionToken` headers with a helper that inserts an opaque
session in each test D1 fake. Do not add a production compatibility fallback for
signed tokens.

- [ ] **Step 5: Run all Worker/profile/replay tests**

Run: `node --test tests/auth.test.mjs tests/session.test.mjs tests/telegram-oidc*.test.mjs tests/worker.test.mjs tests/profile.test.mjs tests/replay-archive.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the hard cutover**

```bash
git add worker/index.js worker/auth.js tests/worker.test.mjs tests/profile.test.mjs tests/replay-archive.test.mjs
git commit -m "feat: authorize with revocable sessions"
```

### Task 5: Add A Strict Frontend OIDC Client

**Files:**
- Create: `src/telegram-auth.js`
- Create: `tests/telegram-auth-client.test.mjs`
- Modify: `src/mobile-app-support.js`
- Modify: `tests/mobile-app-support.test.mjs`

- [ ] **Step 1: Write failing client and deep-link tests**

Desired API:

```js
const client = createTelegramAuthClient({ workerUrl, fetcher });
assert.deepEqual(await client.capability(), { method: "oidc" });
assert.equal((await client.start("android")).authorizationUrl, "https://oauth.telegram.org/auth?...");
assert.deepEqual(await client.redeem("safe_ticket-1"), { token: "opaque", user });

assert.deepEqual(parseSalvoDeepLink("salvo://open/auth/safe_ticket-1"), {
  type: "auth",
  ticket: "safe_ticket-1",
});
```

Reject tickets outside `^[A-Za-z0-9_-]{32,256}$`, query strings, fragments,
credentials, alternate hosts, and nested paths. Test web bootstrap-ticket removal with
`history.replaceState` through an injected URL/history pair.

- [ ] **Step 2: Run frontend client tests and verify RED**

Run: `node --test tests/telegram-auth-client.test.mjs tests/mobile-app-support.test.mjs`

Expected: FAIL because the module and auth deep-link route are absent.

- [ ] **Step 3: Implement capability/start/redeem functions**

Every response must be parsed through one helper that throws a status-bearing error.
`start` sends only `{ platform }`; `redeem` sends only `{ ticket }`.

- [ ] **Step 4: Extend strict deep-link parsing**

Add only `open/auth/<ticket>` to `parseDeepLinkRoute`. Room and replay behavior stays
unchanged.

- [ ] **Step 5: Run frontend client/platform tests**

Run: `node --test tests/telegram-auth-client.test.mjs tests/mobile-app-support.test.mjs tests/platform.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the frontend client**

```bash
git add src/telegram-auth.js src/mobile-app-support.js tests/telegram-auth-client.test.mjs tests/mobile-app-support.test.mjs
git commit -m "feat: add Telegram OIDC browser client"
```

### Task 6: Integrate OIDC Into The Web And Native UI

**Files:**
- Modify: `src/app.js`
- Modify: `src/i18n.js`
- Modify: `src/platform/native.js`
- Modify: `src/platform/web.js`
- Modify: `tests/auth-ui.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`
- Modify: `tests/app-behavior-harness.mjs`
- Modify: `tests/app-behavior.test.mjs`
- Modify: `tests/i18n.test.mjs`

- [ ] **Step 1: Write failing UI and race tests**

Assert legacy widget rendering for capability `legacy`, OIDC button rendering for
`oidc`, native loading/disabled/error states, browser open, callback redemption,
browser close, profile refresh, web ticket URL cleanup, stale callback suppression,
offline retry, and secure persistence failure.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --test tests/auth-ui.test.mjs tests/app-behavior.test.mjs tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: FAIL because native still renders `auth.mobileSecureLoginPending`.

- [ ] **Step 3: Add authentication capability state**

Add `method: "unknown"` to `state.auth`. Load capability during startup. Web mounts
the legacy widget only for `legacy`; web and Android render a first-party Telegram
button for `oidc`. iOS keeps a translated unavailable state in this Android-first
release because its Keychain plugin is outside scope. Native `legacy` also shows a
translated unavailable message without pretending login is working.

- [ ] **Step 4: Wire start, callback, and redemption**

Add `data-action="auth-telegram-oidc"`. Capture the auth request generation before
opening Browser. `handlePlatformDeepLink` recognizes `type === "auth"`, closes the
Browser, redeems, calls `establishAuthSession`, refreshes the profile, and resumes the
requested screen. On web startup, capture and remove `auth_ticket` before redeeming.

- [ ] **Step 5: Add complete translations**

Add matching EN/RU/ZH keys for sign in, opening Telegram, cancelled, expired,
unavailable, retry, privacy notice, and secure-storage errors. Update i18n parity
tests.

- [ ] **Step 6: Run UI and application behavior tests**

Run: `node --test tests/auth-ui.test.mjs tests/app-behavior.test.mjs tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit UI integration**

```bash
git add src/app.js src/i18n.js src/platform/native.js src/platform/web.js tests/auth-ui.test.mjs tests/ux-redesign.test.mjs tests/app-behavior-harness.mjs tests/app-behavior.test.mjs tests/i18n.test.mjs
git commit -m "feat: enable Telegram login on Android"
```

### Task 7: Store Android Sessions With Keystore

**Files:**
- Create: `android/app/src/main/java/io/github/agentaxiom/salvo/SalvoSecureSessionPlugin.java`
- Create: `android/app/src/androidTest/java/io/github/agentaxiom/salvo/SecureSessionPluginTest.java`
- Modify: `android/app/src/main/java/io/github/agentaxiom/salvo/MainActivity.java`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `src/platform/native.js`
- Modify: `tests/platform.test.mjs`

- [ ] **Step 1: Write failing Java instrumentation tests**

Test set/get, overwrite, clear, empty initial state, and inspect the plugin preference
file to prove it does not contain `plain-session-token`.

- [ ] **Step 2: Write failing JS adapter tests**

Inject a `SecureSession` plugin fake and assert exact `get`, `set({ token })`, and
`clear` calls plus browser `close()` behavior.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/platform.test.mjs`

Expected: FAIL because native secure-session calls still throw unavailable.

- [ ] **Step 4: Implement the Android plugin**

Register `SalvoSecureSession` in `MainActivity`. Use AndroidKeyStore alias
`salvo_auth_session_v1`, AES/GCM/NoPadding, a fresh 12-byte IV, and one private
SharedPreferences entry. Encode `version || iv || ciphertext` with Android Base64
`NO_WRAP`. Reject invalid input and clear corrupt ciphertext.

- [ ] **Step 5: Harden the manifest**

Set:

```xml
android:allowBackup="false"
android:usesCleartextTraffic="false"
```

Keep only the existing `INTERNET` permission.

- [ ] **Step 6: Implement the native JS adapter**

Register the plugin through `registerPlugin("SalvoSecureSession")` on Android and map
response `{ token }` to the coordinator's string API. Keep the fail-closed unavailable
adapter on iOS. Do not fall back to Preferences.

- [ ] **Step 7: Run Node and Android tests**

Run: `node --test tests/platform.test.mjs`

Run: `npm run mobile:sync && android/gradlew -p android test connectedDebugAndroidTest`

Expected: PASS; instrumentation reports both application-id and secure-session tests.

- [ ] **Step 8: Commit secure storage**

```bash
git add android/app/src/main src/platform/native.js tests/platform.test.mjs android/app/src/androidTest
git commit -m "feat: protect Android sessions with Keystore"
```

### Task 8: Verify And Deploy The Dual-Capable Authentication Build

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Document exact BotFather and secret commands**

Document the callback and these commands without secret values:

```bash
npx wrangler secret put TELEGRAM_CLIENT_ID
npx wrangler secret put TELEGRAM_CLIENT_SECRET
```

- [ ] **Step 2: Run the complete pre-deploy verification**

Run: `npm test && npm run coverage && npm run build && npm run mobile:sync && android/gradlew -p android test lint assembleDebug`

Expected: all commands exit `0`, coverage thresholds pass, and lint has no errors.

- [ ] **Step 3: Apply the D1 migration remotely**

Run: `npx wrangler d1 migrations apply agents-salvo-profile --remote`

Expected: migration `0003_mobile_oidc_sessions.sql` reports applied.

- [ ] **Step 4: Commit operational documentation**

```bash
git add README.md README.ru.md README.zh-CN.md
git commit -m "docs: document Telegram OIDC operations"
```

- [ ] **Step 5: Validate the branch in GitHub Actions**

Run: `git push origin codex/mobile-apps`

Run: `gh workflow run mobile.yml --ref codex/mobile-apps`

Run: `gh run watch --exit-status`

Expected: mobile CI passes. Do not switch BotFather yet.

- [ ] **Step 6: Integrate and deploy dual-capable Worker and Pages**

Fast-forward the reviewed branch to `main`, push `main`, wait for Pages CI, then run:

```bash
npx wrangler deploy
```

Expected: Pages and Worker deployment succeed. BotFather still remains in legacy
mode.

- [ ] **Step 7: Verify legacy fallback in production**

Run: `curl -fsS https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/config`

Expected: `{"method":"legacy"}` and existing web login succeeds.

- [ ] **Step 8: Pause for owner-controlled BotFather cutover**

The owner switches **Login Widget → OAuth 2.0 Login**, registers:

```text
https://agent-axiom.github.io
https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/mobile/callback
```

Then the owner runs both secret commands and `npx wrangler deploy`.

- [ ] **Step 9: Verify production OIDC**

Expected config becomes `{"method":"oidc"}`. Complete web login, Android login,
restart restoration, logout, second login, cancellation, and replayed-ticket
rejection. Confirm no token appears in browser history or Worker logs.
