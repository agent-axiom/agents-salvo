# Mobile Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce installable, unsigned iOS and Android Salvo applications that load the bundled game, preserve all web behavior, run local modes offline, restore interrupted local battles, and expose native lifecycle, sharing, haptics, network, status-bar, and back-navigation behavior through one tested adapter.

**Architecture:** Keep rules and rendering in the existing ES modules, add esbuild only as the packaging boundary required by Capacitor plugins, and route platform-specific work through `src/platform/`. A small runtime coordinator owns subscriptions and snapshots; `src/app.js` remains the UI/state owner and supplies explicit callbacks. Capacitor-generated Android and iOS projects consume the same `dist/` output as GitHub Pages and contain no remote start URL.

**Tech Stack:** Node.js 24.14.1, TypeScript 5.9.3 for Capacitor configuration loading, vanilla JavaScript ES modules, esbuild 0.28.1, Capacitor 8.4.1, official Capacitor plugins, Android Gradle, Swift Package Manager, Xcode 26, Node test runner, GitHub Actions.

---

## Scope Boundary

This is the first of three implementation plans derived from the approved mobile design. It ends with unsigned simulator/debug builds and a fully functional local/offline application. The next plan adds opaque sessions, secure native token storage, Telegram OIDC, account deletion, and canonical app links. The final plan adds signed-release configuration, association credentials, localized store material, TestFlight, and Play closed-testing preparation.

## File Map

- Create `.nvmrc`: pin the local and CI Node major required by Capacitor 8.
- Create `package-lock.json`: lock all JavaScript and Capacitor dependencies.
- Modify `package.json`: engines, exact dependencies, build/sync/native scripts.
- Modify `scripts/build.mjs`: copy static content and bundle the app entry with esbuild.
- Create `capacitor.config.ts`: shared app ID, bundled `dist` directory, splash/status configuration.
- Create `src/platform/web.js`: browser implementations and fallbacks.
- Create `src/platform/native.js`: official Capacitor plugin implementations.
- Create `src/platform/index.js`: platform selection and the exported singleton.
- Create `src/core/local-battle-snapshot.js`: versioned snapshot validation and persistence.
- Create `src/mobile.js`: lifecycle/network/deep-link/back coordinator.
- Modify `src/app.js`: adapter usage, restore flow, offline state, native sharing, haptics, and back behavior.
- Modify `src/audio.js`: explicit lifecycle pause/resume behavior.
- Modify `src/i18n.js`: localized offline, restore, haptics, and navigation copy.
- Modify `src/index.html`: `viewport-fit=cover` and bundled-app metadata.
- Modify `src/styles.css`: safe areas, offline banner, mobile touch targets, restored-battle notice.
- Create `resources/icon.png` and `resources/splash.png`: native assets derived from the existing Salvo anchor identity.
- Create `android/`: generated Capacitor Android project with localized app names.
- Create `ios/`: generated Capacitor iOS SPM project with localized app names.
- Modify `.github/workflows/pages.yml`: use the pinned Node release and lockfile install.
- Create `.github/workflows/mobile.yml`: web, Android, and unsigned iOS build gates.
- Create `tests/mobile-build.test.mjs`: build/config/static native contracts.
- Create `tests/platform.test.mjs`: adapter behavior and graceful fallbacks.
- Create `tests/local-battle-snapshot.test.mjs`: snapshot round trips and corruption handling.
- Create `tests/mobile-runtime.test.mjs`: lifecycle, network, back, and cleanup behavior.
- Modify `tests/audio.test.mjs`, `tests/i18n.test.mjs`, and `tests/ux-redesign.test.mjs`: integration contracts.
- Modify `README.md`, `README.ru.md`, and `README.zh-CN.md`: mobile developer commands and supported baselines.

### Task 1: Pin The Toolchain And Bundle Capacitor Imports

**Files:**
- Create: `.nvmrc`
- Create: `package-lock.json`
- Modify: `package.json`
- Modify: `scripts/build.mjs`
- Create: `capacitor.config.ts`
- Create: `tests/mobile-build.test.mjs`

- [ ] **Step 1: Write the failing toolchain and build-contract test**

Create `tests/mobile-build.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const buildScript = readFileSync("scripts/build.mjs", "utf8");
const capacitorConfig = readFileSync("capacitor.config.ts", "utf8");

test("mobile toolchain is pinned and uses bundled local web assets", () => {
  assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24.14.1");
  assert.equal(packageJson.engines.node, ">=24.14.1 <25");
  assert.equal(packageJson.dependencies["@capacitor/core"], "8.4.1");
  assert.equal(packageJson.devDependencies["@capacitor/cli"], "8.4.1");
  assert.equal(packageJson.devDependencies.esbuild, "0.28.1");
  assert.equal(packageJson.devDependencies.typescript, "5.9.3");
  assert.match(buildScript, /from "esbuild"/);
  assert.match(buildScript, /entryPoints:\s*\[resolve\(src, "app\.js"\)\]/);
  assert.match(capacitorConfig, /appId:\s*"io\.github\.agentaxiom\.salvo"/);
  assert.match(capacitorConfig, /appName:\s*"Salvo"/);
  assert.match(capacitorConfig, /webDir:\s*"dist"/);
  assert.match(capacitorConfig, /android:[\s\S]*backgroundColor:\s*"#071224"/);
  assert.match(capacitorConfig, /ios:[\s\S]*backgroundColor:\s*"#071224"[\s\S]*contentInset:\s*"never"/);
  assert.match(capacitorConfig, /SplashScreen:[\s\S]*launchAutoHide:\s*false[\s\S]*backgroundColor:\s*"#071224"[\s\S]*showSpinner:\s*false/);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*insetsHandling:\s*"css"/);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*style:\s*"DEFAULT"[\s\S]*hidden:\s*false[\s\S]*animation:\s*"NONE"/);
  assert.doesNotMatch(capacitorConfig, /server:\s*\{[^}]*url:/s);
});

test("build emits copied static assets and a resolved browser bundle", () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "pipe" });
  assert.equal(existsSync("dist/index.html"), true);
  assert.equal(existsSync("dist/assets"), true);
  const bundle = readFileSync("dist/app.js", "utf8");
  assert.doesNotMatch(bundle, /(?:from\s*|import\s*\()["']@capacitor\//);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/mobile-build.test.mjs`

Expected: FAIL because `.nvmrc` and `capacitor.config.ts` do not exist.

- [ ] **Step 3: Pin Node and install exact packages**

Create `.nvmrc` with:

```text
24.14.1
```

Update `package.json` with `"engines": { "node": ">=24.14.1 <25" }` and these scripts:

```json
{
  "mobile:sync": "npm run build && cap sync",
  "mobile:android": "npm run mobile:sync && cap open android",
  "mobile:ios": "npm run mobile:sync && cap open ios",
  "mobile:verify": "npm run build && cap sync --inline"
}
```

Install runtime packages:

```bash
npm install --save-exact @capacitor/app@8.1.0 @capacitor/browser@8.0.3 @capacitor/core@8.4.1 @capacitor/haptics@8.0.2 @capacitor/network@8.0.1 @capacitor/preferences@8.0.1 @capacitor/share@8.0.1 @capacitor/splash-screen@8.0.1
```

Install build packages:

```bash
npm install --save-dev --save-exact @capacitor/android@8.4.1 @capacitor/cli@8.4.1 @capacitor/ios@8.4.1 esbuild@0.28.1 typescript@5.9.3
```

Expected: `package-lock.json` is created and `npm audit` reports zero vulnerabilities.

- [ ] **Step 4: Add the Capacitor configuration**

Create `capacitor.config.ts`:

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.agentaxiom.salvo",
  appName: "Salvo",
  webDir: "dist",
  android: {
    backgroundColor: "#071224",
  },
  ios: {
    backgroundColor: "#071224",
    contentInset: "never",
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#071224",
      showSpinner: false,
    },
    SystemBars: {
      insetsHandling: "css",
      style: "DEFAULT",
      hidden: false,
      animation: "NONE",
    },
  },
};

export default config;
```

- [ ] **Step 5: Bundle JavaScript while preserving copied static assets**

Replace `scripts/build.mjs` with:

```js
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });
await build({
  entryPoints: [resolve(src, "app.js")],
  outfile: resolve(dist, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  legalComments: "none",
});
await writeFile(resolve(dist, ".nojekyll"), "");

console.log(`Built ${dist}`);
```

- [ ] **Step 6: Verify the test, build, and browser output**

Run: `node --test tests/mobile-build.test.mjs`

Expected: PASS.

Run: `npm run build`

Expected: `Built .../dist`, `dist/app.js` contains no unresolved `@capacitor/` import, and `dist/assets/` remains present.

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 7: Commit the toolchain boundary**

```bash
git add .nvmrc package.json package-lock.json scripts/build.mjs capacitor.config.ts tests/mobile-build.test.mjs
git commit -m "build: add Capacitor mobile toolchain"
```

### Task 2: Add The Tested Platform Adapter

**Files:**
- Create: `src/platform/web.js`
- Create: `src/platform/native.js`
- Create: `src/platform/index.js`
- Create: `tests/platform.test.mjs`

- [ ] **Step 1: Write failing web and native adapter tests**

Create `tests/platform.test.mjs` with injected fakes:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createWebPlatform } from "../src/platform/web.js";
import { createNativePlatform } from "../src/platform/native.js";

test("web settings, share, network, and subscriptions use browser APIs", async () => {
  const values = new Map();
  const listeners = new Map();
  const platform = createWebPlatform({
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name), open() {} },
    navigator: { onLine: false, language: "en", share: async (payload) => payload },
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
  });
  await platform.settings.set("theme", "dark");
  assert.equal(await platform.settings.get("theme"), "dark");
  await platform.secureSession.set("web-token");
  assert.equal(await platform.secureSession.get(), "web-token");
  assert.deepEqual(await platform.getNetworkStatus(), { connected: false, connectionType: "none" });
  assert.equal((await platform.share({ title: "Salvo", text: "Battle" })).shared, true);
  const remove = await platform.onNetworkChange(() => {});
  assert.equal(listeners.has("online"), true);
  remove();
  assert.equal(listeners.size, 0);
});

test("native adapter maps semantic haptics and plugin listener cleanup", async () => {
  const calls = [];
  const platform = createNativePlatform({
    Capacitor: { getPlatform: () => "ios" },
    App: { addListener: async (name) => ({ remove: async () => calls.push(`remove:${name}`) }) },
    Browser: { open: async ({ url }) => calls.push(url) },
    Haptics: { impact: async ({ style }) => calls.push(style), notification: async ({ type }) => calls.push(type) },
    Network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }), addListener: async () => ({ remove: async () => {} }) },
    Preferences: { get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
    Share: { share: async () => ({ activityType: "test" }) },
    SplashScreen: { hide: async () => calls.push("splash") },
    SystemBars: { show: async () => calls.push("status") },
  });
  await platform.haptic("hit");
  await assert.rejects(() => platform.secureSession.set("native-token"), /Secure session storage unavailable/);
  const remove = await platform.onLifecycleChange(() => {});
  await remove();
  assert.equal(platform.getPlatform(), "ios");
  assert.deepEqual(calls, ["MEDIUM", "remove:appStateChange"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/platform.test.mjs`

Expected: FAIL because the platform modules do not exist.

- [ ] **Step 3: Implement browser fallbacks**

Create `src/platform/web.js` exporting `createWebPlatform()` with this stable contract:

```js
export function createWebPlatform({ window: host = window, navigator: nav = navigator, storage = localStorage } = {}) {
  return {
    isNative: () => false,
    getPlatform: () => "web",
    getNetworkStatus: async () => ({ connected: nav.onLine !== false, connectionType: nav.onLine === false ? "none" : "unknown" }),
    async onNetworkChange(listener) {
      const online = () => listener({ connected: true, connectionType: "unknown" });
      const offline = () => listener({ connected: false, connectionType: "none" });
      host.addEventListener("online", online);
      host.addEventListener("offline", offline);
      return () => {
        host.removeEventListener("online", online);
        host.removeEventListener("offline", offline);
      };
    },
    async share(payload) {
      if (!nav.share) return { shared: false };
      await nav.share(payload);
      return { shared: true };
    },
    haptic: async () => {},
    openExternalUrl: async (url) => host.open(url, "_blank", "noopener,noreferrer"),
    onDeepLink: async () => () => {},
    onBack: async () => () => {},
    onLifecycleChange: async () => () => {},
    hideSplash: async () => {},
    configureSystemBars: async () => {},
    settings: {
      get: async (key) => storage.getItem(`salvo.${key}`),
      set: async (key, value) => value === null ? storage.removeItem(`salvo.${key}`) : storage.setItem(`salvo.${key}`, String(value)),
    },
    secureSession: {
      get: async () => storage.getItem("salvo.authToken") ?? "",
      set: async (token) => storage.setItem("salvo.authToken", token),
      clear: async () => storage.removeItem("salvo.authToken"),
    },
  };
}
```

- [ ] **Step 4: Implement official native plugin mappings**

Create `src/platform/native.js`. Export `createNativePlatform(plugins)` and map semantic events exactly:

```js
const impactByEvent = { placement: "LIGHT", hit: "MEDIUM", sunk: "HEAVY" };
const notificationByEvent = { invalid: "WARNING", victory: "SUCCESS", defeat: "ERROR" };

async function subscribe(registration) {
  const handle = await registration;
  return () => handle.remove();
}
```

`onDeepLink`, `onBack`, and `onLifecycleChange` must return cleanup functions backed by `App.addListener`. `settings.get/set` must use `Preferences`, removing keys when `value === null`. `share` must return `{ shared: true }` after `Share.share()`. `openExternalUrl` must use `Browser.open()`. `configureSystemBars()` uses the Capacitor 8 `SystemBars` API exported by `@capacitor/core`; its CSS inset injection remains configured in `capacitor.config.ts`. Plugin errors in haptics, splash, and system-bar setup are caught and converted to no-ops. Native `secureSession.get/set/clear` must reject with `Secure session storage unavailable` and must never call `Preferences`; the identity plan replaces only this fail-closed implementation with Keychain/Keystore.

- [ ] **Step 5: Export one selected platform**

Create `src/platform/index.js`:

```js
import { Capacitor } from "@capacitor/core";
import { createNativePlatform } from "./native.js";
import { createWebPlatform } from "./web.js";

export function selectPlatform(isNative = Capacitor.isNativePlatform()) {
  return isNative ? createNativePlatform() : createWebPlatform();
}

export const platform = selectPlatform();
```

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/platform.test.mjs`

Expected: all platform tests PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 7: Commit the adapter**

```bash
git add src/platform tests/platform.test.mjs
git commit -m "feat: add web and native platform adapters"
```

### Task 3: Add Versioned Local Battle Snapshots

**Files:**
- Create: `src/core/local-battle-snapshot.js`
- Create: `tests/local-battle-snapshot.test.mjs`

- [ ] **Step 1: Write failing round-trip, exclusion, and corruption tests**

Create fixtures for agent, hotseat, training, online, and finished battles, then assert:

```js
test("unfinished local battles round-trip through a versioned snapshot", async () => {
  const store = memorySettings();
  const snapshots = createLocalBattleSnapshotStore(store, { now: () => "2026-07-13T12:00:00.000Z" });
  await snapshots.save(agentBattleState());
  const restored = await snapshots.load();
  assert.equal(restored.version, 1);
  assert.equal(restored.savedAt, "2026-07-13T12:00:00.000Z");
  assert.equal(restored.mode, "agent");
  assert.deepEqual(restored.game, agentBattleState().game);
});

test("online and completed battles are never persisted", async () => {
  assert.equal(createLocalBattleSnapshot(onlineBattleState()), null);
  assert.equal(createLocalBattleSnapshot(finishedAgentState()), null);
});

test("corrupt snapshots are quarantined and removed", async () => {
  const store = memorySettings({ "localBattle": "{bad" });
  const snapshots = createLocalBattleSnapshotStore(store, { now: () => "2026-07-13T12:00:00.000Z" });
  assert.equal(await snapshots.load(), null);
  assert.equal(await store.get("localBattle"), null);
  assert.match(await store.get("localBattleQuarantine"), /\{bad/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/local-battle-snapshot.test.mjs`

Expected: FAIL because `src/core/local-battle-snapshot.js` does not exist.

- [ ] **Step 3: Implement strict version-one serialization**

Create `src/core/local-battle-snapshot.js` with:

```js
export const LOCAL_BATTLE_SNAPSHOT_VERSION = 1;
const LOCAL_MODES = new Set(["agent", "hotseat", "training"]);
const ACTIVE_SCREENS = new Set(["setup", "game", "training"]);

export function createLocalBattleSnapshot(state, now = () => new Date().toISOString()) {
  if (!LOCAL_MODES.has(state.mode) || !ACTIVE_SCREENS.has(state.screen) || state.game?.phase === "finished") return null;
  return structuredClone({
    version: LOCAL_BATTLE_SNAPSHOT_VERSION,
    savedAt: now(),
    screen: state.screen,
    mode: state.mode,
    presetId: state.presetId,
    setupPlayerId: state.setupPlayerId,
    setupBoard: state.setupBoard,
    setupOrientation: state.setupOrientation,
    setupSelectedShipId: state.setupSelectedShipId,
    boards: state.boards,
    game: state.game,
    battleTab: state.battleTab,
    agentDifficulty: state.agentDifficulty,
    passPlayerId: state.passPlayerId,
    training: state.training,
  });
}
```

`parseLocalBattleSnapshot(raw)` must reject non-JSON, non-object values, versions other than `1`, unsupported mode/screen pairs, missing `presetId`, and invalid `savedAt`. `createLocalBattleSnapshotStore(settings)` uses the keys `localBattle` and `localBattleQuarantine`; `save()` clears the active key when serialization returns `null`.

- [ ] **Step 4: Run snapshot and coverage tests**

Run: `node --test tests/local-battle-snapshot.test.mjs`

Expected: snapshot tests PASS.

Run: `npm run coverage`

Expected: all tests PASS and line coverage remains at least 98%.

- [ ] **Step 5: Commit snapshot persistence**

```bash
git add src/core/local-battle-snapshot.js tests/local-battle-snapshot.test.mjs
git commit -m "feat: persist unfinished local battles"
```

### Task 4: Coordinate Lifecycle, Network, Audio, Restore, And Back

**Files:**
- Create: `src/mobile.js`
- Create: `tests/mobile-runtime.test.mjs`
- Modify: `src/audio.js`
- Modify: `tests/audio.test.mjs`

- [ ] **Step 1: Write failing runtime orchestration tests**

Use a fake platform whose listeners are captured. Cover startup ordering, inactive persistence, active audio resume, network delivery, back/deep-link forwarding, and idempotent cleanup:

```js
test("runtime restores before hiding splash and snapshots on suspension", async () => {
  const events = [];
  const harness = runtimeHarness(events);
  const runtime = createMobileRuntime(harness.options);
  await runtime.start();
  assert.deepEqual(events.slice(0, 4), ["network", "restore", "bars", "splash"]);
  await harness.emitLifecycle(false);
  assert.deepEqual(events.slice(-2), ["pause-audio", "save"]);
  await harness.emitLifecycle(true);
  assert.equal(events.at(-1), "resume-audio");
  await runtime.stop();
  assert.equal(harness.activeListenerCount(), 0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/mobile-runtime.test.mjs`

Expected: FAIL because `src/mobile.js` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create `src/mobile.js` exporting `createMobileRuntime()`:

```js
export function createMobileRuntime({ platform, snapshots, getState, applySnapshot, onNetwork, onDeepLink, onBack, pauseAudio, resumeAudio }) {
  const removers = [];
  return {
    async start() {
      onNetwork(await platform.getNetworkStatus());
      const snapshot = await snapshots.load();
      if (snapshot) applySnapshot(snapshot);
      await platform.configureSystemBars();
      await platform.hideSplash();
      removers.push(...await Promise.all([
        platform.onNetworkChange(onNetwork),
        platform.onDeepLink(onDeepLink),
        platform.onBack(onBack),
        platform.onLifecycleChange(async ({ active }) => {
          if (active) return resumeAudio();
          pauseAudio();
          await snapshots.save(getState());
        }),
      ]));
    },
    async persist() {
      await snapshots.save(getState());
    },
    async stop() {
      await Promise.all(removers.splice(0).map((remove) => remove()));
    },
  };
}
```

Normalize web synchronous remover functions with `await`; native removers are asynchronous.

- [ ] **Step 4: Give audio an explicit lifecycle boundary**

Add `pauseForLifecycle()` and `resumeForLifecycle(enabled, isMenu)` to `createAudioController()`. Pause must stop menu music and suspend an existing `AudioContext` without creating one. Resume may resume an existing context and restart music only when both arguments are true. Extend `tests/audio.test.mjs` to prove inactive lifecycle never creates an audio context and does not restart disabled music.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/mobile-runtime.test.mjs tests/audio.test.mjs`

Expected: runtime and audio tests PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit runtime orchestration**

```bash
git add src/mobile.js src/audio.js tests/mobile-runtime.test.mjs tests/audio.test.mjs
git commit -m "feat: coordinate native app lifecycle"
```

### Task 5: Integrate Native UX Into The Game

**Files:**
- Modify: `src/app.js`
- Modify: `src/i18n.js`
- Modify: `src/index.html`
- Modify: `src/styles.css`
- Modify: `tests/i18n.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`

- [ ] **Step 1: Write failing frontend contract tests**

Extend `tests/ux-redesign.test.mjs` to require `platform`, `createMobileRuntime`, a haptics setting, an offline banner, native share calls, local restore, and safe-area CSS:

```js
test("installed app integrates safe areas, offline state, restore, share, and haptics", () => {
  assert.match(app, /import \{ platform \} from "\.\/platform\/index\.js"/);
  assert.match(app, /createMobileRuntime/);
  assert.match(app, /hapticsEnabled/);
  assert.match(app, /class="offline-banner"/);
  assert.match(app, /platform\.share/);
  assert.match(app, /function applyLocalBattleSnapshot/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(html, /viewport-fit=cover/);
});
```

Extend `tests/i18n.test.mjs` to require these keys in EN/RU/ZH: `settings.haptics`, `network.offline`, `network.retry`, `restore.resumed`, `nav.leaveBattleTitle`, `nav.leaveBattleBody`, `share.failed`, and `auth.mobileSecureLoginPending`.

- [ ] **Step 2: Run the frontend tests and verify RED**

Run: `node --test tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: FAIL on missing runtime and localization contracts.

- [ ] **Step 3: Boot the runtime without delaying first paint**

Import `platform`, `createMobileRuntime`, and `createLocalBattleSnapshotStore`. Add `network`, `hapticsEnabled`, and `restoredBattle` state. Keep the initial synchronous `render()` so bundled content appears immediately, then call `void runtime.start()`.

Implement `applyLocalBattleSnapshot(snapshot)` by assigning only the whitelisted snapshot fields from Task 3, clearing online clients and result UI, setting `state.restoredBattle = true`, and rendering. Implement `onNetwork` as an immutable `{ connected, connectionType }` update. Online/profile/archive actions must return the localized offline error before making a request; local modes remain enabled.

Hydrate non-sensitive preferences after the first paint through `platform.settings`: `language`, `theme`, `visualStyle`, `audio`, `haptics`, and JSON-encoded `trainingProgress`. Apply only known enum values and object-shaped training data, then render once. Replace direct writes for those keys with awaited `platform.settings.set()` calls. On web this keeps the existing `salvo.*` localStorage keys; on native it uses Capacitor Preferences. Authentication token migration is intentionally reserved for the secure-storage identity plan and must not be copied into Preferences.

Hydrate the existing web bearer through `platform.secureSession.get()` after first paint instead of reading `localStorage` directly. Fail closed for authentication on native until the identity plan lands: a rejected secure-session read leaves the token empty, the Telegram widget action displays `auth.mobileSecureLoginPending`, and token set/remove functions call only `platform.secureSession`. Local modes and the public leaderboard remain available; online rooms, private profiles, and archives remain visibly gated. Add a frontend contract assertion that `src/app.js` no longer calls `localStorage.setItem(authTokenStorageKey, token)` or `localStorage.removeItem(authTokenStorageKey)`.

- [ ] **Step 4: Add deterministic native back behavior**

Implement `handlePlatformBack()` in this order:

```js
if (state.settingsOpen) return closeSettings();
if (state.profileOpen) return closeProfile();
if (state.leaderboardOpen) return closeLeaderboard();
if (state.screen === "archive" || state.screen === "replay") return showMenu();
if (state.screen === "setup" || state.screen === "game" || state.screen === "training" || state.screen === "online") return requestLeaveBattle();
return false;
```

`requestLeaveBattle()` opens the existing dialog layer with localized Cancel and Main menu commands when an unfinished battle exists; completed/detail screens return immediately. Android exits normally only when `handlePlatformBack()` returns `false` on home.

- [ ] **Step 5: Replace share windows with the platform share sheet**

Room and battle-summary actions call:

```js
const result = await platform.share({ title: translate("app.title"), text, url });
if (!result.shared) await platform.openExternalUrl(telegramShareUrl(text, url));
```

Keep explicit clipboard actions. Never place credentials or private replay payloads in share data.

- [ ] **Step 6: Add semantic haptics and the independent setting**

Default haptics to enabled on native and disabled on web unless previously set. Persist `haptics` through `platform.settings`. Call `platform.haptic()` for valid placement, invalid placement, hit, sunk, victory, and defeat only when enabled. Do not haptically signal misses. Add a standard settings toggle in all three localizations.

- [ ] **Step 7: Add safe-area and offline UI styling**

Change the viewport meta to:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

Define root variables:

```css
--safe-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));
--safe-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px));
--safe-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px));
--safe-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px));
```

Apply top/side padding to `.shell`, bottom padding to sticky setup, battle tabs, result actions, and dialogs, and retain at least 44px touch targets below `720px`. The offline banner is compact, high-contrast in both themes, and does not cover the board.

- [ ] **Step 8: Run tests, coverage, build, and responsive browser verification**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run coverage`

Expected: line coverage remains at least 98%.

Run: `npm run build`

Expected: build succeeds.

Start the local server and inspect 390x844, 844x390, 768x1024, and 1440x900 in light/dark themes. Expected: no page-level horizontal overflow, no covered sticky controls, boards remain usable, and offline state does not move the active board unexpectedly.

- [ ] **Step 9: Commit native UX integration**

```bash
git add src/app.js src/i18n.js src/index.html src/styles.css tests/i18n.test.mjs tests/ux-redesign.test.mjs
git commit -m "feat: adapt Salvo UX for installed apps"
```

### Task 6: Generate Android And iOS Projects

**Files:**
- Create: `resources/icon.png`
- Create: `resources/splash.png`
- Create: `android/`
- Create: `ios/`
- Create: `ios/App/PrivacyInfo.xcprivacy`
- Modify: `tests/mobile-build.test.mjs`

- [ ] **Step 1: Extend the failing native-project contract test**

Add assertions that Android uses namespace/application ID `io.github.agentaxiom.salvo`, min SDK 24, compile/target SDK 36, and localized names; iOS uses deployment target 15.0, the same bundle identifier, SPM, and localized display names. Assert neither native project contains the GitHub Pages URL as a WebView start URL.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/mobile-build.test.mjs`

Expected: FAIL because `android/` and `ios/` do not exist.

- [ ] **Step 3: Generate deterministic app artwork from the existing identity**

```bash
mkdir -p resources
magick src/favicon.svg -resize 1024x1024 resources/icon.png
magick -size 2732x2732 xc:#071224 \( src/favicon.svg -resize 720x720 \) -gravity center -composite resources/splash.png
```

Expected: `icon.png` is 1024x1024 and `splash.png` is 2732x2732, both opaque and centered.

- [ ] **Step 4: Generate both native projects and assets**

```bash
npm run build
npx cap add android
npx cap add ios
npx --yes --package @capacitor/assets@3.0.5 capacitor-assets generate
npx cap sync
```

Expected: Android and iOS projects are generated from Capacitor 8.4.1, `android/app/src/main/assets/public/` and `ios/App/App/public/` contain bundled Salvo assets, and no CocoaPods project is introduced.

- [ ] **Step 5: Localize application display names**

Add Android resource values:

```xml
<!-- android/app/src/main/res/values/strings.xml -->
<string name="app_name">Salvo</string>
<string name="title_activity_main">Salvo</string>
<string name="package_name">io.github.agentaxiom.salvo</string>
<string name="custom_url_scheme">io.github.agentaxiom.salvo</string>
```

Create `values-ru/strings.xml` with `Залп` and `values-zh-rCN/strings.xml` with `齐射` for `app_name` and `title_activity_main`; package and scheme strings remain unchanged.

Create iOS files:

```text
ios/App/App/en.lproj/InfoPlist.strings: CFBundleDisplayName = "Salvo";
ios/App/App/ru.lproj/InfoPlist.strings: CFBundleDisplayName = "Залп";
ios/App/App/zh-Hans.lproj/InfoPlist.strings: CFBundleDisplayName = "齐射";
```

Register all three localizations in the Xcode project and set `CFBundleDisplayName` to `$(PRODUCT_NAME)` as the fallback.

- [ ] **Step 6: Declare the required iOS Preferences privacy reason**

Create `ios/App/PrivacyInfo.xcprivacy` with `NSPrivacyAccessedAPICategoryUserDefaults` and reason `CA92.1`, matching the official `@capacitor/preferences` requirement. Extend `tests/mobile-build.test.mjs` to parse the file and assert both values are present. Do not declare tracking domains or unrelated data categories.

- [ ] **Step 7: Verify native project contracts and sync cleanliness**

Run: `node --test tests/mobile-build.test.mjs`

Expected: PASS.

Run: `npm run mobile:verify`

Expected: Capacitor reports successful copy/update for both platforms and a second run produces no Git diff.

- [ ] **Step 8: Commit generated shells and assets**

```bash
git add resources android ios tests/mobile-build.test.mjs
git commit -m "feat: add iOS and Android application shells"
```

### Task 7: Add Continuous Native Build Gates

**Files:**
- Modify: `.github/workflows/pages.yml`
- Create: `.github/workflows/mobile.yml`
- Modify: `tests/mobile-build.test.mjs`

- [ ] **Step 1: Write the failing CI contract test**

Require Pages and mobile workflows to use Node 24, `npm ci`, tests, 98% coverage, production build, Capacitor sync, Android lint/tests/debug build, and unsigned iOS Simulator build. Assert no signing secret is referenced in pull-request jobs.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/mobile-build.test.mjs`

Expected: FAIL because `.github/workflows/mobile.yml` is absent and Pages still uses Node 22.

- [ ] **Step 3: Make Pages reproducible**

Update `.github/workflows/pages.yml` to `actions/setup-node@v5` with `node-version-file: .nvmrc`, add `cache: npm`, and insert `npm ci` before tests. Keep the existing 98% coverage and Pages deployment behavior.

- [ ] **Step 4: Add Android and iOS jobs**

Create `.github/workflows/mobile.yml` with pull-request, push-to-main, and manual triggers. The shared web job runs `npm ci`, `npm test`, `npm run coverage`, and `npm run build` on Ubuntu. Android uses Temurin 21 and runs:

```bash
npm run mobile:sync
cd android
./gradlew test lint assembleDebug
```

iOS runs on `macos-26`, selects Xcode 26, runs `npm ci`, `npm run mobile:sync`, then:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Set workflow concurrency to cancel stale branch builds. Upload the Android debug APK and iOS build log on failure; do not use signing credentials.

- [ ] **Step 5: Verify workflow contracts and local native builds**

Run: `node --test tests/mobile-build.test.mjs`

Expected: PASS.

Run: `android/gradlew -p android test lint assembleDebug`

Expected: BUILD SUCCESSFUL.

Run: `xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build`

Expected: BUILD SUCCEEDED.

- [ ] **Step 6: Commit CI**

```bash
git add .github/workflows/pages.yml .github/workflows/mobile.yml tests/mobile-build.test.mjs
git commit -m "ci: validate web and native builds"
```

### Task 8: Document And Verify The Foundation End To End

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/superpowers/plans/2026-07-13-mobile-runtime-foundation.md`

- [ ] **Step 1: Document exact mobile prerequisites and commands**

Add equivalent EN/RU/ZH sections covering Node 24.14.1, Xcode 26+, iOS 15+, Android Studio Otter 2025.2.1+, Android API 24 minimum/API 36 target, `npm ci`, `npm run mobile:sync`, `npm run mobile:ios`, `npm run mobile:android`, and unsigned build commands. State that local modes work offline while online/profile features need the Worker. State that simulator/debug builds do not require store accounts; physical iOS signing and store distribution do.

- [ ] **Step 2: Run the complete automated gate**

Run: `npm ci`

Expected: clean install from `package-lock.json` with zero audit vulnerabilities.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run coverage`

Expected: line coverage is at least 98%.

Run: `npm run build`

Expected: bundled web build succeeds.

Run: `npm run mobile:verify`

Expected: both native projects sync without a diff.

Run: `android/gradlew -p android test lint assembleDebug`

Expected: BUILD SUCCESSFUL.

Run: `xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build`

Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Perform visual and behavior smoke tests**

Verify web and iOS/Android simulator builds in EN/RU/ZH, light/dark, portrait/landscape, agent/training/hotseat, background/foreground restore, audio interruption, haptic toggle, native share cancellation, offline startup, offline online-mode error, Android back order, and 10x10/16x16 board usability. Capture screenshots at 390x844, 844x390, and a tablet viewport and inspect for blank canvas, overlap, clipped text, and horizontal page overflow.

- [ ] **Step 4: Mark plan checkboxes and inspect the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the three README files and this checked plan remain before the documentation commit.

- [ ] **Step 5: Commit verified documentation**

```bash
git add README.md README.ru.md README.zh-CN.md docs/superpowers/plans/2026-07-13-mobile-runtime-foundation.md
git commit -m "docs: explain native development workflow"
```

## Completion Criteria

- `dist/` is built once and is the source for Pages, iOS, and Android.
- iOS and Android open bundled Salvo content with no startup network dependency.
- Agent, training, and same-device games work in airplane mode.
- An unfinished local game survives app suspension and restart; corrupt snapshots fail closed.
- Native back, lifecycle audio, network state, share sheet, haptics, splash, status bar, and safe areas are adapter-driven and tested.
- Web behavior and the 98% line-coverage gate remain intact.
- Android debug and unsigned iOS Simulator builds pass locally and in CI.
- No analytics, advertising, payments, remote start URL, signing secret, or plaintext native auth storage is introduced.
