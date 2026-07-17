# Telegram Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete Salvo game as a Telegram Main Mini App from the same source and build used by GitHub Pages and the Capacitor Android/iOS applications.

**Architecture:** Add a dedicated Telegram runtime adapter and HTML shell around the existing shared game bundle. Authenticate Mini App launches through a new Cloudflare Worker endpoint that validates raw `initData` and creates the existing D1-backed Salvo session, preserving the same `telegram:<id>` player identity across every client.

**Tech Stack:** ES modules, esbuild, Node.js test runner and coverage, Telegram Mini Apps JavaScript API, Cloudflare Workers, Durable Objects, D1, Capacitor 8, GitHub Actions.

---

## File Map

**Create**

- `worker/telegram-mini-app-auth.js`: strict parsing, signature verification,
  freshness checks, and Telegram user normalization for Mini App launch data.
- `tests/telegram-mini-app-auth.test.mjs`: cryptographic verifier tests.
- `tests/telegram-mini-app-worker.test.mjs`: endpoint and D1 session tests.
- `src/telegram-mini-app-auth.js`: bounded frontend exchange client.
- `tests/telegram-mini-app-client.test.mjs`: frontend auth client tests.
- `src/platform/telegram.js`: Telegram runtime adapter.
- `tests/telegram-platform.test.mjs`: deterministic WebApp adapter tests.
- `src/telegram/index.html`: Telegram-only bootstrap shell loading the shared app.
- `tests/telegram-build.test.mjs`: build-output and shared-artifact tests.
- `src/telegram-launch.js`: strict `startapp` parsing and link construction.
- `tests/telegram-launch.test.mjs`: room and replay launch tests.

**Modify**

- `worker/index.js`: route and handle `/auth/telegram/miniapp`.
- `src/platform/index.js`: select Telegram between native and web runtimes.
- `src/platform/web.js`: expose runtime-compatible no-op capabilities.
- `src/platform/native.js`: expose runtime-compatible no-op capabilities.
- `src/app.js`: automatic Mini App auth, fallback UI, Telegram launch routing,
  settings/back state, lifecycle-ready notification, and Telegram sharing.
- `src/mobile.js`: invoke runtime-ready after the shared UI is usable.
- `src/mobile-app-support.js`: parse Telegram launch actions independently from
  web and native deep links.
- `src/index.html`: declare the regular runtime explicitly.
- `src/styles.css`: Telegram safe areas, fallback screen, and full-width boards.
- `src/i18n.js`: Mini App auth, fallback, room, and reopen messages in RU/EN/ZH.
- `src/privacy.html`: disclose server validation of Mini App launch data.
- `scripts/build.mjs`: emit two HTML shells referencing one hashed JS/CSS pair.
- `tests/mobile-build.test.mjs`: accept and verify hashed shared artifacts.
- `tests/platform.test.mjs`: cover runtime selection compatibility.
- `tests/app-behavior.test.mjs`: register Mini App scenarios.
- `tests/app-behavior-harness.mjs`: exercise automatic auth and launch routing.
- `tests/auth-ui.test.mjs`: assert Mini App login UI and privacy behavior.
- `.github/workflows/pages.yml`: assert Telegram build output before deployment.
- `.github/workflows/mobile.yml`: assert the same output before native sync.
- `README.md`, `README.ru.md`, `README.zh-CN.md`: document Mini App launch and
  the one-source build model.

## Task 1: Verify Telegram Mini App Launch Data

**Files:**
- Create: `worker/telegram-mini-app-auth.js`
- Create: `tests/telegram-mini-app-auth.test.mjs`

- [ ] **Step 1: Write the cryptographic happy-path test**

Create a test that signs the exact raw values Telegram sends and checks the
normalized public user:

```js
test("Mini App initData verifies and normalizes the Telegram user", async () => {
  const botToken = "123456:test-bot-token";
  const user = JSON.stringify({
    id: 8710001168,
    first_name: "Dima",
    last_name: "Kosarevsky",
    username: "agent_axiom",
    language_code: "ru",
    photo_url: "https://t.me/i/userpic/320/avatar.jpg",
  });
  const initData = await signInitData({
    auth_date: "1784232000",
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    start_param: "room_ABCD",
    user,
  }, botToken);

  assert.deepEqual(
    await verifyTelegramMiniAppInitData(initData, botToken, {
      now: 1784232120,
      maxAgeSeconds: 300,
      maxFutureSeconds: 60,
    }),
    {
      user: {
        provider: "telegram",
        id: "8710001168",
        name: "Dima Kosarevsky",
        username: "agent_axiom",
        photoUrl: "https://t.me/i/userpic/320/avatar.jpg",
      },
      languageCode: "ru",
      startParam: "room_ABCD",
    },
  );
});
```

The test helper must derive the Mini App key by signing the bot token with
`WebAppData`, then sign the alphabetical data-check string with that key.

- [ ] **Step 2: Run the focused test and confirm the missing module failure**

Run:

```sh
node --test tests/telegram-mini-app-auth.test.mjs
```

Expected: FAIL because `worker/telegram-mini-app-auth.js` does not exist.

- [ ] **Step 3: Implement strict parsing and HMAC verification**

Create an exported verifier with these defaults and boundaries:

```js
export async function verifyTelegramMiniAppInitData(
  rawInitData,
  botToken,
  {
    now = Math.floor(Date.now() / 1000),
    maxAgeSeconds = 300,
    maxFutureSeconds = 60,
  } = {},
) {
  const fields = parseInitData(rawInitData);
  const suppliedHash = requireHexHash(fields.get("hash"));
  const dataCheckString = [...fields]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(textEncoder.encode("WebAppData"), botToken);
  const expectedHash = bytesToHex(await hmac(secret, dataCheckString));
  if (!timingSafeEqualHex(expectedHash, suppliedHash)) throw authError();

  const authDate = strictEpoch(fields.get("auth_date"));
  if (now - authDate > maxAgeSeconds || authDate - now > maxFutureSeconds) {
    throw authError();
  }
  return normalizeResult(fields);
}
```

`parseInitData` must reject empty input, input over 16 KiB, duplicate keys,
missing `hash`, `auth_date`, or `user`, malformed percent encoding, and keys
outside this current WebAppInitData allowlist:

```js
const allowedFields = new Set([
  "auth_date", "can_send_after", "chat", "chat_instance", "chat_type",
  "hash", "query_id", "receiver", "signature", "start_param", "user",
]);
```

The HMAC data-check string includes every supplied field except `hash`, including
the optional Telegram `signature` field. `normalizeResult` must require a
non-bot integer ID representable within Telegram's documented 52-bit range,
bound all strings, allow only `https:` photo URLs, and return `publicUser` shape.

- [ ] **Step 4: Add adversarial verifier tests**

Cover all of these cases with explicit `assert.rejects` calls:

```js
for (const mutate of [
  (value) => value.replace("Dima", "Mallory"),
  (value) => `${value}&auth_date=1784232000`,
  (value) => value.replace("auth_date=1784232000", "auth_date=1784231000"),
  (value) => value.replace("auth_date=1784232000", "auth_date=1784232200"),
  (value) => value.replace(/hash=[^&]+/, "hash=not-hex"),
]) {
  await assert.rejects(
    () => verifyTelegramMiniAppInitData(mutate(valid), botToken, { now: 1784232120 }),
    /Telegram Mini App authentication failed/,
  );
}
```

Also test missing bot token, malformed JSON user, unknown top-level keys,
unsupported URL schemes, overlong names, and a raw string over 16 KiB. Error
messages must remain generic and must not contain raw launch data.

- [ ] **Step 5: Run verifier tests and the existing auth tests**

Run:

```sh
node --test tests/telegram-mini-app-auth.test.mjs tests/auth.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the verifier**

```sh
git add worker/telegram-mini-app-auth.js tests/telegram-mini-app-auth.test.mjs
git commit -m "feat: verify Telegram Mini App launches"
```

## Task 2: Exchange Mini App Launches for Existing Salvo Sessions

**Files:**
- Create: `tests/telegram-mini-app-worker.test.mjs`
- Modify: `worker/index.js`

- [ ] **Step 1: Write endpoint success and identity-continuity tests**

Use the existing in-memory D1 harness and session schema. Post signed data to
the new route and verify the opaque session resolves through `/auth/me`:

```js
const response = await worker.fetch(
  new Request("https://worker.test/auth/telegram/miniapp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  }),
  { DB: db, TELEGRAM_BOT_TOKEN: botToken },
);
assert.equal(response.status, 200);
const payload = await response.json();
assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
assert.equal(db.queryOne("SELECT user_key FROM auth_sessions").user_key, "telegram:8710001168");

const me = await worker.fetch(new Request("https://worker.test/auth/me", {
  headers: { Authorization: `Bearer ${payload.token}` },
}), { DB: db });
assert.deepEqual(await me.json(), { user: payload.user });
```

- [ ] **Step 2: Run the endpoint test and confirm a 404**

Run:

```sh
node --test tests/telegram-mini-app-worker.test.mjs
```

Expected: FAIL because `/auth/telegram/miniapp` is not routed.

- [ ] **Step 3: Add an exact route and handler**

Add the route before the generic `/auth/telegram` route:

```js
if (url.pathname === "/auth/telegram/miniapp") {
  return { kind: "authTelegramMiniApp" };
}
```

Handle only `POST`, extend the existing strict JSON reader to accept an explicit
maximum and call it as `readStrictTelegramJson(request, "initData", 16 * 1024)`.
Keep the existing OIDC calls on their current 1024-byte default. Call
`verifyTelegramMiniAppInitData`, pass the returned user to
`createSession(env.DB, user)`, and return the existing `{ token, user }` shape.
Every verification, parsing, database, or configuration failure returns:

```js
json({ error: "Telegram Mini App authentication failed" }, 401)
```

- [ ] **Step 4: Add endpoint rejection and redaction tests**

Test GET, wrong content type, extra JSON keys, missing DB/token, malformed and
oversized bodies, stale launch data, tampered launch data, and a D1 failure.
Assert response bodies never contain the bot token, initData, hash, query ID, or
Telegram user JSON.

- [ ] **Step 5: Run Worker auth suites**

Run:

```sh
node --test tests/telegram-mini-app-worker.test.mjs tests/telegram-oidc-worker.test.mjs tests/auth.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the endpoint**

```sh
git add worker/index.js tests/telegram-mini-app-worker.test.mjs
git commit -m "feat: authenticate Telegram Mini App users"
```

## Task 3: Add the Bounded Mini App Auth Client and Launch Parser

**Files:**
- Create: `src/telegram-mini-app-auth.js`
- Create: `tests/telegram-mini-app-client.test.mjs`
- Create: `src/telegram-launch.js`
- Create: `tests/telegram-launch.test.mjs`

- [ ] **Step 1: Write client request and response validation tests**

Test one exact POST and the normalized response:

```js
const client = createTelegramMiniAppAuthClient({
  workerUrl: "https://worker.test",
  fetcher: async (url, init) => {
    assert.equal(url, "https://worker.test/auth/telegram/miniapp");
    assert.deepEqual(JSON.parse(init.body), { initData: "signed-launch-data" });
    return jsonResponse({ token: "a".repeat(43), user: telegramUser });
  },
});
assert.deepEqual(await client.authenticate("signed-launch-data"), {
  token: "a".repeat(43),
  user: telegramUser,
});
```

Also test a 10-second timeout, caller abort, non-JSON response, response larger
than 16 KiB, invalid token, invalid user, and generic redacted errors. Reuse the
bounded-reader style from `src/telegram-auth.js` without exporting or coupling
to its OIDC-specific URL validation.

- [ ] **Step 2: Run the client test and confirm the missing module failure**

```sh
node --test tests/telegram-mini-app-client.test.mjs
```

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Implement `createTelegramMiniAppAuthClient`**

Expose only:

```js
export function createTelegramMiniAppAuthClient({ workerUrl, fetcher, timeoutMs = 10_000 }) {
  return {
    authenticate(initData, { signal } = {}) {
      return requestJson(
        `${normalizeWorkerUrl(workerUrl)}/auth/telegram/miniapp`,
        { initData: requireInitData(initData) },
        { fetcher, timeoutMs, signal },
      );
    },
  };
}
```

Require non-empty initData no larger than 16 KiB. Keep the returned token and
user validation equivalent to the existing Telegram auth client.

- [ ] **Step 4: Write strict launch parser tests**

```js
assert.deepEqual(parseTelegramStartParam("room_ABCD"), {
  type: "room", roomCode: "ABCD",
});
assert.deepEqual(parseTelegramStartParam("replay_replay-123"), {
  type: "replay", replayId: "replay-123",
});
for (const value of ["room_abcd", "room_ABC", "room_ABCD?x", "replay_", "menu", ""]) {
  assert.equal(parseTelegramStartParam(value), null);
}
assert.equal(
  telegramRoomInviteUrl("agents_salvo_bot", "ABCD"),
  "https://t.me/agents_salvo_bot?startapp=room_ABCD",
);
```

- [ ] **Step 5: Implement launch parsing and canonical link construction**

Create pure functions with exact regular expressions:

```js
const roomStartPattern = /^room_([A-Z0-9]{4,12})$/;
const replayStartPattern = /^replay_([A-Za-z0-9-]{1,128})$/;
```

Validate the bot username with `/^[A-Za-z][A-Za-z0-9_]{4,31}$/` and construct
links through `URL` and `URLSearchParams`, never string concatenation with user
input.

- [ ] **Step 6: Run client and launch tests**

```sh
node --test tests/telegram-mini-app-client.test.mjs tests/telegram-launch.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit the client and launch module**

```sh
git add src/telegram-mini-app-auth.js src/telegram-launch.js tests/telegram-mini-app-client.test.mjs tests/telegram-launch.test.mjs
git commit -m "feat: add Telegram Mini App bootstrap clients"
```

## Task 4: Implement the Telegram Runtime Adapter

**Files:**
- Create: `src/platform/telegram.js`
- Create: `tests/telegram-platform.test.mjs`
- Modify: `src/platform/index.js`
- Modify: `src/platform/web.js`
- Modify: `src/platform/native.js`
- Modify: `tests/platform.test.mjs`

- [ ] **Step 1: Write adapter contract tests using a fake WebApp**

The fake records `ready`, `expand`, fullscreen, colors, BackButton,
SettingsButton, events, links, and haptics. Assert the public contract:

```js
const adapter = createTelegramPlatform({
  webApp: fake.webApp,
  window: fake.window,
  navigator: { onLine: true },
  storage: fake.storage,
});
assert.equal(adapter.isNative(), false);
assert.equal(adapter.getPlatform(), "telegram");
assert.equal(adapter.isAvailable(), true);
assert.equal(adapter.getLaunchData(), "signed-init-data");
assert.equal(adapter.getStartParam(), "room_ABCD");
```

Test listener registration and cleanup for BackButton, SettingsButton,
`activated`, `deactivated`, `themeChanged`, `viewportChanged`,
`safeAreaChanged`, and `contentSafeAreaChanged`.

- [ ] **Step 2: Run the adapter test and confirm the missing module failure**

```sh
node --test tests/telegram-platform.test.mjs
```

Expected: FAIL because `src/platform/telegram.js` does not exist.

- [ ] **Step 3: Implement the adapter without game imports**

Return the shared platform methods plus these runtime-neutral additions:

```js
isAvailable()
getLaunchData()
getStartParam()
onSettings(listener)
ready()
setClosingConfirmation(enabled)
getTheme()
onThemeChange(listener)
onViewportChange(listener)
```

Use an in-memory `secureSession` so Mini App session tokens are not persisted.
Use prefixed localStorage for non-sensitive settings. Map semantic haptics to
Telegram impact and notification methods. Check `isVersionAtLeast("8.0")`
before fullscreen and safe-area-specific operations. All optional methods must
catch provider failures and preserve gameplay.

- [ ] **Step 4: Add Telegram runtime selection while preserving old calls**

Keep `selectPlatform(false)` and `selectPlatform(true)` working for existing
tests. Add injectable runtime context as a second argument:

```js
export function selectPlatform(
  isNative = Capacitor.isNativePlatform(),
  {
    runtime = globalThis.document?.documentElement?.dataset?.runtime,
    telegramWebApp = globalThis.window?.Telegram?.WebApp,
  } = {},
) {
  if (isNative) return createNativePlatform();
  if (runtime === "telegram") return createTelegramPlatform({ webApp: telegramWebApp });
  return createWebPlatform();
}
```

Add safe no-op implementations of the new optional capabilities to web and
native adapters so shared code never branches on method existence.

- [ ] **Step 5: Run platform suites**

```sh
node --test tests/telegram-platform.test.mjs tests/platform.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the runtime adapter**

```sh
git add src/platform tests/platform.test.mjs tests/telegram-platform.test.mjs
git commit -m "feat: add Telegram Mini App runtime"
```

## Task 5: Produce One Shared Build with Two HTML Shells

**Files:**
- Create: `src/telegram/index.html`
- Create: `tests/telegram-build.test.mjs`
- Modify: `src/index.html`
- Modify: `scripts/build.mjs`
- Modify: `tests/mobile-build.test.mjs`

- [ ] **Step 1: Write build assertions before changing the build**

Build into a temporary directory and assert:

```js
assert.equal(existsSync(join(output, "index.html")), true);
assert.equal(existsSync(join(output, "telegram/index.html")), true);
const web = readFileSync(join(output, "index.html"), "utf8");
const telegram = readFileSync(join(output, "telegram/index.html"), "utf8");
const webApp = web.match(/src="\.\/(app\.[a-f0-9]{10}\.js)"/)?.[1];
const telegramApp = telegram.match(/src="\.\.\/(app\.[a-f0-9]{10}\.js)"/)?.[1];
assert.equal(webApp, telegramApp);
assert.match(telegram, /https:\/\/telegram\.org\/js\/telegram-web-app\.js\?63/);
assert.match(telegram, /data-runtime="telegram"/);
assert.doesNotMatch(web, /telegram-web-app\.js/);
```

Make the equivalent assertion for `styles.<hash>.css` and verify Capacitor's
root shell does not reference the Telegram SDK.

- [ ] **Step 2: Run the build test and confirm the missing shell failure**

```sh
node --test tests/telegram-build.test.mjs
```

Expected: FAIL because the Telegram shell and hashed references are absent.

- [ ] **Step 3: Add the Telegram shell**

Create a full HTML document with the same metadata and `SALVO_CONFIG` values as
the regular shell. Set `<html data-runtime="telegram">`, use `../` paths, and
load the official Telegram SDK before `../app.js`:

```html
<script src="https://telegram.org/js/telegram-web-app.js?63"></script>
<script type="module" src="../app.js"></script>
```

Set `<html data-runtime="web">` on the regular shell.

- [ ] **Step 4: Hash the shared JS and CSS outputs and rewrite both shells**

After bundling `app.js`, calculate the first ten lowercase hex characters of
SHA-256 for the bundle and stylesheet. Rename them to `app.<hash>.js` and
`styles.<hash>.css`, rename the sourcemap consistently, update the bundle's
source map comment, and rewrite only the exact shell references. Use Node
`crypto.createHash`, `fs.rename`, and exact string replacement; reject a shell
when the expected original reference appears zero or multiple times.

Read `SALVO_BUILD_ID`, require `/^[A-Za-z0-9._-]{1,64}$/`, and use `dev` when it
is absent. Replace the exact `buildId: "dev"` marker in both shells so every
runtime reports the source revision without producing a second application
bundle.

- [ ] **Step 5: Update existing mobile build assertions**

Replace assumptions about exact source HTML and `dist/app.js` with discovery of
the hashed root references. Continue asserting that the bundle contains no
unresolved Capacitor or relative JavaScript imports and that all native assets
remain local.

- [ ] **Step 6: Run build suites and Capacitor sync**

```sh
node --test tests/telegram-build.test.mjs tests/mobile-build.test.mjs
npm run mobile:verify
```

Expected: PASS and successful Capacitor sync for both native projects.

- [ ] **Step 7: Commit the shared build**

```sh
git add src/index.html src/telegram/index.html scripts/build.mjs tests/telegram-build.test.mjs tests/mobile-build.test.mjs
git commit -m "feat: build shared Telegram Mini App shell"
```

## Task 6: Integrate Automatic Authentication and Telegram Navigation

**Files:**
- Modify: `src/app.js`
- Modify: `src/mobile.js`
- Modify: `tests/app-behavior.test.mjs`
- Modify: `tests/app-behavior-harness.mjs`
- Modify: `tests/auth-ui.test.mjs`

- [ ] **Step 1: Add a Mini App behavior scenario that fails first**

Register `telegram-bootstrap` in the child harness. Inject a Telegram platform
with launch data and assert:

```js
const app = bootSalvoApp(harness.dependencies);
await waitFor(() => harness.fetchCalls.some(({ url }) =>
  url.endsWith("/auth/telegram/miniapp")));
assert.deepEqual(JSON.parse(authRequest.init.body), { initData: "signed-init-data" });
authResponse.resolve(response({ token: sessionToken, user: telegramUser }));
await app.startup.authReady;
assert.equal(app.getState().auth.user.id, telegramUser.id);
assert.equal(app.getState().auth.token, sessionToken);
assert.equal(harness.calls.secureWrites, 1);
assert.doesNotMatch(harness.root.innerHTML, /auth-telegram-oidc|telegram-login-slot/);
```

Because Telegram secureSession is in memory, the write assertion confirms only
runtime memory storage and no browser localStorage call.

- [ ] **Step 2: Run the behavior scenario and verify failure**

```sh
SALVO_APP_BEHAVIOR_SCENARIO=telegram-bootstrap SALVO_APP_CHILD_COVERAGE=isolated node tests/app-behavior-harness.mjs
```

Expected: FAIL because Mini App automatic authentication is not wired.

- [ ] **Step 3: Add Mini App auth bootstrap to `bootSalvoApp`**

Create the Mini App client only when `platform.getPlatform() === "telegram"`.
Replace the normal capability/OIDC startup branch with:

```js
async function authenticateTelegramMiniApp() {
  if (!platform.isAvailable() || !platform.getLaunchData()) {
    state.auth.method = "miniapp-unavailable";
    state.auth.error = translate("auth.miniAppOpenInTelegram");
    render();
    return false;
  }
  state.auth.method = "miniapp";
  const result = await telegramMiniAppClient.authenticate(platform.getLaunchData());
  return secureSessionCoordinator.establish(result.token, () => {
    state.auth.token = result.token;
    state.auth.user = result.user;
    state.auth.error = "";
  });
}
```

The Telegram branch runs after the runtime network sample and before profile or
private launch routing. Web/native OIDC capability loading remains unchanged.
Logout clears the in-memory token and immediately re-authenticates only after an
explicit retry or Mini App reopen, avoiding a logout loop.

Use `platform.getTheme()` as the initial light/dark value in Telegram. Track
whether a stored or user-selected Salvo theme exists. Telegram `themeChanged`
events update the game only while that flag is false; an explicit Salvo theme
selection remains authoritative.

- [ ] **Step 4: Connect Telegram BackButton, SettingsButton, lifecycle, and ready**

Use the existing `handlePlatformBack` callback for BackButton. SettingsButton
sets `state.settingsOpen = true` and renders. Toggle closing confirmation from
the same predicate that guards unfinished local battles. Call `platform.ready()`
after the first usable render and ensure it is idempotent. Lifecycle continues
through `createMobileRuntime`, so Telegram `activated/deactivated` pauses and
resumes audio without a second code path.

Render the validated `SALVO_CONFIG.buildId` in the settings metadata for web,
native, and Telegram, using `dev` when the source shell is served directly.

- [ ] **Step 5: Add fallback and race tests**

Cover missing SDK/initData, rejected auth, auth retry, stale auth completion
after logout, platform stop cleanup, and a failed in-memory session write.
Assert local mode buttons remain enabled while online/profile remain gated.

- [ ] **Step 6: Run application behavior and auth UI suites**

```sh
node --test tests/app-behavior.test.mjs tests/auth-ui.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit automatic auth and navigation**

```sh
git add src/app.js src/mobile.js tests/app-behavior.test.mjs tests/app-behavior-harness.mjs tests/auth-ui.test.mjs
git commit -m "feat: bootstrap Salvo inside Telegram"
```

## Task 7: Route Invites and Replays Through Telegram

**Files:**
- Modify: `src/app.js`
- Modify: `src/mobile-app-support.js`
- Modify: `tests/mobile-app-support.test.mjs`
- Modify: `tests/app-behavior.test.mjs`
- Modify: `tests/app-behavior-harness.mjs`

- [ ] **Step 1: Write a launch-routing scenario**

Inject `getStartParam() === "room_ABCD"`, complete automatic auth, and assert the
app opens online with `roomCodeInput === "ABCD"` and calls the existing join
workflow. Add a replay case asserting the private replay request occurs only
after authentication.

- [ ] **Step 2: Run the new scenarios and verify failure**

```sh
node --test tests/app-behavior.test.mjs
```

Expected: FAIL because Telegram start parameters are not applied.

- [ ] **Step 3: Add guarded launch coordination**

Convert a valid parsed Telegram start parameter to the existing internal room
or replay navigation action. Route it through `createAppNavigationCoordinator`
so an unfinished battle receives the existing leave confirmation. Process the
launch exactly once after Mini App auth settles; invalid values open the menu.

- [ ] **Step 4: Generate Telegram-native share links**

In Mini App mode, room share uses `telegramRoomInviteUrl` instead of the Pages
URL and passes this URL to the platform adapter. The adapter opens:

```text
https://t.me/share/url?url=<encoded invite>&text=<encoded localized text>
```

Replay share uses the equivalent `startapp=replay_<id>` link. Web and native
sharing retain their current canonical Pages/deep-link behavior.

- [ ] **Step 5: Add invalid, full-room, and share fallback tests**

Assert lower-case/oversized room params and malformed replay IDs never navigate.
Assert join failure remains visible in the online lobby. Assert failed Telegram
sharing returns `{ shared: false }`, allowing the existing fallback status.

- [ ] **Step 6: Run navigation, launch, and behavior tests**

```sh
node --test tests/telegram-launch.test.mjs tests/mobile-app-support.test.mjs tests/app-behavior.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit launch routing and sharing**

```sh
git add src/app.js src/mobile-app-support.js tests/mobile-app-support.test.mjs tests/app-behavior.test.mjs tests/app-behavior-harness.mjs
git commit -m "feat: open Telegram rooms and replays"
```

## Task 8: Add Telegram-Safe Layout, Localization, and Privacy Text

**Files:**
- Modify: `src/styles.css`
- Modify: `src/i18n.js`
- Modify: `src/privacy.html`
- Modify: `tests/privacy.test.mjs`
- Modify: `tests/auth-ui.test.mjs`

- [ ] **Step 1: Write static assertions for three-language copy and safe areas**

Add tests that require translation keys for open-in-Telegram, expired launch,
auth retry, room failure, and Mini App account status in `ru`, `en`, and `zh-CN`.
Assert CSS consumes Telegram variables with fallbacks:

```css
--salvo-safe-top: var(--tg-content-safe-area-inset-top, env(safe-area-inset-top, 0px));
--salvo-safe-right: var(--tg-content-safe-area-inset-right, env(safe-area-inset-right, 0px));
--salvo-safe-bottom: var(--tg-content-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
--salvo-safe-left: var(--tg-content-safe-area-inset-left, env(safe-area-inset-left, 0px));
```

- [ ] **Step 2: Run static UI/privacy tests and verify failure**

```sh
node --test tests/auth-ui.test.mjs tests/privacy.test.mjs
```

Expected: FAIL because Mini App copy and disclosure are absent.

- [ ] **Step 3: Implement responsive Telegram styling**

Use runtime-scoped selectors under `html[data-runtime="telegram"]`. Apply safe
padding to the app shell and dialogs, use `--tg-viewport-stable-height` as a
minimum available-height input, and preserve the existing phone rule that makes
boards width-constrained with `overflow-x: clip`. Do not duplicate board styles
or reduce cell labels below the current mobile values.

- [ ] **Step 4: Add localized copy and privacy disclosure**

Add complete RU/EN/ZH strings. Update each privacy section to state that the
Mini App sends signed Telegram launch data to the Worker for identity validation,
does not persist raw launch data, and reuses the same profile records.

- [ ] **Step 5: Run UI/privacy tests**

```sh
node --test tests/auth-ui.test.mjs tests/privacy.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit UI and privacy changes**

```sh
git add src/styles.css src/i18n.js src/privacy.html tests/auth-ui.test.mjs tests/privacy.test.mjs
git commit -m "feat: polish Telegram Mini App experience"
```

## Task 9: CI, Documentation, Full Verification, and Deployment

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify: `.github/workflows/mobile.yml`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`
- Modify: `tests/mobile-build.test.mjs`

- [ ] **Step 1: Add workflow and documentation assertions**

Extend existing build tests to require `dist/telegram/index.html`, the shared
hashed assets, and the official Telegram SDK only in the Telegram shell. Add
README assertions or direct content checks for the public launch URL and the
single-source build explanation.

- [ ] **Step 2: Run the focused build tests and verify failure**

```sh
node --test tests/telegram-build.test.mjs tests/mobile-build.test.mjs
```

Expected: FAIL until workflow/documentation expectations are updated.

- [ ] **Step 3: Update CI and documentation**

Keep the existing test and coverage gates. Add a named `Verify Telegram Mini
App artifacts` step after `npm run build` in Pages and mobile web jobs:

```sh
test -f dist/telegram/index.html
grep -q 'telegram-web-app.js' dist/telegram/index.html
```

Set `SALVO_BUILD_ID: ${{ github.sha }}` on CI build steps and assert the emitted
shells contain that exact value. Local builds continue to emit `dev`.

Document the Mini App URL, BotFather Main Mini App setup, automatic auth model,
and that Pages/Mini App update immediately while native stores package a chosen
commit.

- [ ] **Step 4: Run all automated verification**

```sh
npm test
npm run coverage
npm run build
npm run mobile:verify
android/gradlew -p android test lint assembleDebug
```

Expected: every command exits zero; coverage retains the existing 98% core line
gate and the app behavior gate; Android debug assembly succeeds.

- [ ] **Step 5: Inspect the built shells and repository diff**

```sh
git diff --check
git status --short
```

Expected: no whitespace errors and only planned files changed.

- [ ] **Step 6: Commit CI and documentation**

```sh
git add .github/workflows/pages.yml .github/workflows/mobile.yml README.md README.ru.md README.zh-CN.md tests/mobile-build.test.mjs
git commit -m "docs: document Telegram Mini App delivery"
```

- [ ] **Step 7: Deploy the Worker and smoke-test the endpoint**

Run:

```sh
npx wrangler deploy
curl -i -X POST https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/miniapp \
  -H 'Content-Type: application/json' \
  --data '{"initData":"invalid"}'
```

Expected: deploy succeeds and the invalid smoke request returns `401` with the
generic Mini App authentication error and no sensitive data.

- [ ] **Step 8: Publish the branch and verify GitHub Actions**

Push the implementation branch, create a pull request, and wait for Pages,
mobile, and coverage checks. After merge, verify:

```text
https://agent-axiom.github.io/agents-salvo/telegram/
```

Expected: the route loads the Telegram fallback outside Telegram and the normal
Pages route remains unchanged.

- [ ] **Step 9: Configure BotFather after the deployed route is verified**

In `@BotFather`, configure `@agents_salvo_bot` as the Main Mini App with URL
`https://agent-axiom.github.io/agents-salvo/telegram/`, request short name
`salvo` with `agents_salvo` as fallback, set the menu action to Play, and upload
localized RU/EN/ZH metadata. Then perform the approved Android, iOS, and Desktop
manual matrix before announcing availability.
