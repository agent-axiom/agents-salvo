import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const scenarioName = process.env.SALVO_APP_BEHAVIOR_SCENARIO;
const childCoverageMode = process.env.SALVO_APP_CHILD_COVERAGE;
assert.ok(["isolated", "inherit"].includes(childCoverageMode));
assert.equal(Boolean(process.env.NODE_V8_COVERAGE), childCoverageMode === "inherit");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./remote.js" && context.parentURL?.endsWith("/src/app.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export class RemoteClient {}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const scenarios = {
  startup: runDeferredStartupScenario,
  navigation: runNavigationScenario,
  "deep-link-guard": runDeepLinkGuardScenario,
  logout: runLogoutScenario,
};
const scenario = scenarios[scenarioName];
assert.ok(scenario, `Unknown app behavior scenario: ${scenarioName}`);
await scenario();
hooks.deregister();
process.stdout.write(`scenario:${scenarioName}:ok\n`);

async function runDeferredStartupScenario() {
  const network = deferred();
  const snapshot = deferred();
  const preferences = deferred();
  const secureSession = deferred();
  const authResponse = deferred();
  const harness = createAppHarness({
    network,
    snapshot,
    preferences,
    secureSession,
    fetchResponse(url) {
      if (url.endsWith("/auth/me")) return authResponse.promise;
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const { bootSalvoApp } = await import("../src/app.js");
  assert.equal(typeof bootSalvoApp, "function");

  const app = bootSalvoApp(harness.dependencies);

  assert.match(harness.root.innerHTML, /data-action="start-agent"/);
  assert.deepEqual(app.getState().network, {
    connected: false,
    connectionType: "unknown",
    confirmed: false,
  });
  await flushMicrotasks();
  assert.equal(harness.calls.networkSamples, 1);
  assert.equal(harness.calls.secureReads, 1);
  assert.equal(harness.calls.preferenceReads.length, 6);
  assert.equal(harness.calls.snapshotReads, 0);
  assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/me")), false);

  secureSession.resolve("deferred-token");
  await flushMicrotasks();
  assert.equal(app.getState().auth.token, "deferred-token");
  assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/me")), false);

  network.resolve({ connected: true, connectionType: "wifi" });
  await waitFor(() => app.getState().network.confirmed);
  assert.equal(app.getState().network.connected, true);
  assert.equal(harness.calls.snapshotReads, 1);
  assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/me")), false);

  snapshot.resolve(null);
  await waitFor(() => harness.fetchCalls.some(({ url }) => url.endsWith("/auth/me")));
  assert.equal(harness.calls.preferencesSettled, false);

  authResponse.resolve(response({
    user: { id: "player-1", name: "Deferred Player", username: "deferred" },
  }));
  await app.startup.authReady;
  assert.equal(app.getState().auth.user.name, "Deferred Player");

  preferences.resolve(null);
  await app.startup.done;
  assert.equal(harness.calls.preferencesSettled, true);
  await app.stop();
}

async function runNavigationScenario() {
  const clearSnapshot = deferred();
  let delaySnapshotClear = false;
  const clients = [];
  const harness = createAppHarness({
    secureSession: resolvedDeferred("session-token"),
    onSettingWrite(key, value) {
      if (delaySnapshotClear && key === "localBattle" && value === null) {
        return clearSnapshot.promise;
      }
      return Promise.resolve();
    },
    createRemoteClient(handlers) {
      const client = {
        closed: false,
        sent: [],
        close() {
          this.closed = true;
        },
        async createRoom() {
          return { roomCode: "ABCD", playerId: "p1", playerToken: "private-room-token" };
        },
        async send(type, payload) {
          this.sent.push({ type, payload });
        },
      };
      clients.push({ client, handlers });
      return client;
    },
    fetchResponse(url) {
      if (url.endsWith("/auth/me")) {
        return response({ user: { id: "player-1", name: "Player One", username: "one" } });
      }
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.includes("/profile/replays")) {
        assert.equal(clients.at(-1)?.client.closed, true, "online client must close before archive fetch");
        return response({ archive: { items: [], nextCursor: "" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const { bootSalvoApp } = await import("../src/app.js");
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;

  await harness.root.click("show-online");
  await harness.root.click("online-create");
  assert.equal(app.getState().online.session.roomCode, "ABCD");
  assert.equal(clients[0].client.closed, false);

  await harness.root.click("open-archive");
  assert.equal(app.getState().screen, "archive");
  assert.equal(clients[0].client.closed, true);
  assert.equal(app.getState().online.client, null);

  await harness.root.click("menu");
  await harness.root.click("start-agent");
  await harness.root.click("toggle-leaderboard");
  assert.equal(app.getState().screen, "setup");
  assert.equal(app.getState().leaderboardOpen, true);

  await harness.root.click("menu", { focus: true });
  assert.equal(app.getState().leaveBattleDialog, true);
  assert.equal(app.getState().screen, "setup");
  assert.equal(harness.document.activeElement?.dataset.action, "cancel-leave-battle");
  assert.notEqual(harness.document.activeElement, harness.root.competingDialogControl);
  assert.equal(harness.root.background.inert, true);

  harness.document.keydown("Escape");
  assert.equal(app.getState().leaveBattleDialog, false);
  assert.equal(app.getState().screen, "setup");
  assert.equal(harness.document.activeElement?.dataset.action, "menu");

  await harness.root.click("menu", { focus: true });
  delaySnapshotClear = true;
  const confirm = harness.root.click("confirm-leave-battle", { focus: true });
  await flushMicrotasks();
  assert.equal(app.getState().screen, "setup");
  assert.equal(app.getState().leaveBattleDialog, true);
  assert.deepEqual(harness.calls.settingWrites.at(-1), ["localBattle", null]);

  const lifecycleSave = harness.emitLifecycle({ active: false });
  await flushMicrotasks();
  assert.deepEqual(
    harness.calls.settingWrites.filter(([key]) => key === "localBattle"),
    [["localBattle", null]],
  );

  clearSnapshot.resolve();
  await Promise.all([confirm, lifecycleSave]);
  assert.equal(app.getState().screen, "menu");
  assert.equal(app.getState().mode, null);
  assert.equal(app.getState().leaveBattleDialog, false);
  assert.equal(harness.root.background.inert, false);
  assert.deepEqual(
    harness.calls.settingWrites.filter(([key]) => key === "localBattle"),
    [["localBattle", null]],
  );
  await app.stop();
}

async function runDeepLinkGuardScenario() {
  const harness = createAppHarness();
  const { bootSalvoApp } = await import("../src/app.js");
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;

  await harness.root.click("start-agent");
  assert.equal(app.getState().screen, "setup");

  await harness.emitDeepLink("salvo://open/room/abcd");
  assert.equal(app.getState().screen, "setup");
  assert.equal(app.getState().leaveBattleDialog, true);
  assert.equal(app.getState().online.roomCodeInput, "");
  assert.deepEqual(
    harness.calls.settingWrites.filter(([key]) => key === "localBattle"),
    [],
  );

  await harness.root.click("cancel-leave-battle");
  assert.equal(app.getState().screen, "setup");
  assert.equal(app.getState().leaveBattleDialog, false);

  await harness.root.click("menu");
  assert.equal(app.getState().leaveBattleDialog, true);
  assert.equal(await harness.emitDeepLink("salvo://open/room/repl"), false);
  await harness.root.click("confirm-leave-battle");
  assert.equal(app.getState().screen, "menu");
  assert.equal(app.getState().online.roomCodeInput, "");

  await harness.root.click("start-agent");
  await harness.emitDeepLink("salvo://open/room/abcd");
  await harness.root.click("confirm-leave-battle");
  assert.equal(app.getState().screen, "online");
  assert.equal(app.getState().leaveBattleDialog, false);
  assert.equal(harness.root.background.inert, false);
  assert.equal(app.getState().online.roomCodeInput, "ABCD");
  assert.deepEqual(
    harness.calls.settingWrites.filter(([key]) => key === "localBattle"),
    [["localBattle", null], ["localBattle", null]],
  );
  await app.stop();
}

async function runLogoutScenario() {
  const secureClear = deferred();
  const profileResponse = deferred();
  let profileRequests = 0;
  let onlineClientStarts = 0;
  const harness = createAppHarness({
    secureSession: resolvedDeferred("session-token"),
    onSecureClear: () => secureClear.promise,
    createRemoteClient() {
      onlineClientStarts += 1;
      throw new Error("Online client must not start during logout");
    },
    fetchResponse(url, init) {
      if (url.endsWith("/auth/me")) {
        return response({ user: { id: "player-1", name: "Player One", username: "one" } });
      }
      if (url.endsWith("/profile/me")) {
        profileRequests += 1;
        if (profileRequests === 1) return response({ profile: { leaderboard: [] } });
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          profileResponse.reject(error);
        }, { once: true });
        return profileResponse.promise;
      }
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const { bootSalvoApp } = await import("../src/app.js");
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;

  const profile = harness.root.click("toggle-profile");
  await waitFor(() => profileRequests === 2);
  const activeProfileRequest = harness.fetchCalls.filter(({ url }) => url.endsWith("/profile/me")).at(-1);
  assert.equal(activeProfileRequest.init.signal.aborted, false);

  const logout = harness.root.click("auth-logout");
  await flushMicrotasks();
  assert.equal(activeProfileRequest.init.signal.aborted, true);
  assert.equal(app.getState().auth.user.name, "Player One");
  assert.equal(app.getState().auth.loading, true);
  assert.equal(harness.calls.secureClears, 1);
  assert.match(harness.root.innerHTML, /data-action="toggle-profile"[^>]*disabled/);
  await harness.root.click("show-online");
  await harness.root.click("online-create");
  assert.equal(onlineClientStarts, 0);

  secureClear.reject(new Error("secure clear failed"));
  await Promise.all([profile, logout]);
  assert.equal(app.getState().auth.user.name, "Player One");
  assert.equal(app.getState().auth.loading, false);
  assert.notEqual(app.getState().auth.error, "");
  assert.match(harness.root.innerHTML, /auth-error/);
  await app.stop();
}

function createAppHarness({
  network = resolvedDeferred({ connected: true, connectionType: "wifi" }),
  snapshot = resolvedDeferred(null),
  preferences = resolvedDeferred(null),
  secureSession = resolvedDeferred(""),
  onSecureClear = () => Promise.resolve(),
  onSettingWrite = () => Promise.resolve(),
  createRemoteClient = () => {
    throw new Error("Remote client was not expected");
  },
  fetchResponse = (url) => {
    if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  },
} = {}) {
  const document = createDocumentHarness();
  const root = createRootHarness(document);
  document.root = root;
  const calls = {
    networkSamples: 0,
    preferenceReads: [],
    preferencesSettled: false,
    secureReads: 0,
    snapshotReads: 0,
    secureClears: 0,
    settingWrites: [],
  };
  void preferences.promise.then(() => {
    calls.preferencesSettled = true;
  });
  const fetchCalls = [];
  let firstNetworkSample = true;
  let lifecycleHandler = null;
  let deepLinkHandler = null;
  const platform = {
    isNative: () => false,
    settings: {
      get(key) {
        if (key === "localBattle") {
          calls.snapshotReads += 1;
          return snapshot.promise;
        }
        calls.preferenceReads.push(key);
        return preferences.promise;
      },
      set(key, value) {
        calls.settingWrites.push([key, value]);
        return onSettingWrite(key, value);
      },
    },
    secureSession: {
      get() {
        calls.secureReads += 1;
        return secureSession.promise;
      },
      async set() {},
      clear() {
        calls.secureClears += 1;
        return onSecureClear();
      },
    },
    getNetworkStatus() {
      calls.networkSamples += 1;
      if (firstNetworkSample) {
        firstNetworkSample = false;
        return network.promise;
      }
      return Promise.resolve({ connected: true, connectionType: "wifi" });
    },
    async configureSystemBars() {},
    async hideSplash() {},
    async onNetworkChange() {
      return async () => {};
    },
    async onDeepLink(handler) {
      deepLinkHandler = handler;
      return async () => {
        if (deepLinkHandler === handler) deepLinkHandler = null;
      };
    },
    async onBack() {
      return async () => {};
    },
    async onLifecycleChange(handler) {
      lifecycleHandler = handler;
      return async () => {
        if (lifecycleHandler === handler) lifecycleHandler = null;
      };
    },
    async haptic() {},
    async share() {
      return { shared: false };
    },
    async openExternalUrl() {},
  };
  const window = createWindowHarness();
  const navigator = {
    onLine: true,
    clipboard: { async writeText() {} },
  };
  const audio = {
    async startMusic() {},
    stopMusic() {},
    async play() {},
    async pauseForLifecycle() {},
    async resumeForLifecycle() {},
  };

  return {
    calls,
    document,
    emitLifecycle(event) {
      assert.ok(lifecycleHandler, "Lifecycle handler is not registered");
      return lifecycleHandler(event);
    },
    emitDeepLink(url) {
      assert.ok(deepLinkHandler, "Deep-link handler is not registered");
      return deepLinkHandler(url);
    },
    fetchCalls,
    root,
    dependencies: {
      document,
      window,
      navigator,
      platform,
      audio,
      createRemoteClient,
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        return fetchResponse(url, init);
      },
    },
  };
}

function createDocumentHarness() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    documentElement: { lang: "", dataset: {} },
    readyState: "complete",
    root: null,
    querySelector(selector) {
      if (selector === "#app") return this.root;
      return null;
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      listeners.set(type, entries.filter((entry) => entry !== listener));
    },
    keydown(key, options = {}) {
      const event = {
        key,
        shiftKey: Boolean(options.shiftKey),
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of listeners.get("keydown") ?? []) listener(event);
      return event;
    },
  };
  return document;
}

function createRootHarness(document) {
  const listeners = new Map();
  const actionElements = new Map();
  const attributes = new Map();
  const background = {
    inert: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  let html = "";
  let cancelControl = null;
  let confirmControl = null;
  let competingDialogControl = null;

  const makeActionElement = (action, extraDataset = {}) => {
    const element = {
      dataset: { action, ...extraDataset },
      id: "",
      isConnected: true,
      focus() {
        document.activeElement = element;
      },
      closest(selector) {
        return selector === "[data-action]" ? element : null;
      },
    };
    return element;
  };

  const root = {
    background,
    get competingDialogControl() {
      return competingDialogControl;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      cancelControl = html.includes('data-action="cancel-leave-battle"')
        ? makeActionElement("cancel-leave-battle")
        : null;
      confirmControl = html.includes('data-action="confirm-leave-battle"')
        ? makeActionElement("confirm-leave-battle")
        : null;
      competingDialogControl = html.includes("leaderboard-popover")
        ? makeActionElement("close-leaderboard")
        : null;
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    querySelector(selector) {
      if (selector === "[data-dialog-background]") return background;
      if (selector === '[data-dialog="leave-battle"]' && cancelControl && confirmControl) {
        return {
          contains(element) {
            return element === cancelControl || element === confirmControl;
          },
          querySelectorAll() {
            return [cancelControl, confirmControl];
          },
        };
      }
      if (selector === '[role="dialog"]' && competingDialogControl) {
        return {
          contains: (element) => element === competingDialogControl,
          querySelectorAll: () => [competingDialogControl],
        };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-action]") return [...actionElements.values()];
      if (selector === "[id]") return [];
      return [];
    },
    async click(action, { focus = false, ...dataset } = {}) {
      const target = makeActionElement(action, dataset);
      actionElements.set(action, target);
      if (focus) target.focus();
      const event = { target };
      await Promise.all((listeners.get("click") ?? []).map((listener) => listener(event)));
    },
  };
  return root;
}

function createWindowHarness() {
  const listeners = new Map();
  const location = {
    href: "https://agent-axiom.github.io/agents-salvo/",
    origin: "https://agent-axiom.github.io",
    pathname: "/agents-salvo/",
    search: "",
    hash: "",
  };
  const updateLocation = (url) => {
    const parsed = new URL(url, location.href);
    location.href = parsed.href;
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  return {
    SALVO_CONFIG: {
      workerUrl: "https://worker.example.test",
      telegramBotUsername: "salvo_test_bot",
    },
    location,
    history: {
      pushState(_state, _title, url) {
        updateLocation(url);
      },
      replaceState(_state, _title, url) {
        updateLocation(url);
      },
    },
    matchMedia: () => ({ matches: false }),
    setInterval,
    clearInterval,
    setTimeout,
    requestAnimationFrame(callback) {
      return setTimeout(callback, 0);
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
  };
}

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function resolvedDeferred(value) {
  return { promise: Promise.resolve(value) };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate, message = "Timed out waiting for app state") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}
