import assert from "node:assert/strict";
import test from "node:test";

import {
  captureTelegramAuthBootstrap,
  createAppNavigationCoordinator,
  createDiscardableSnapshotStore,
  createDialogFocusController,
  createLatestClientCoordinator,
  createOrderedSnapshotStore,
  createPreferenceCoordinator,
  createSecureSessionCoordinator,
  createUnknownNetworkState,
  hasConfirmedNetworkConnection,
  networkStateFromSample,
  parseSalvoDeepLink,
  startMobileAppServices,
} from "../src/mobile-app-support.js";

test("startup begins runtime while preferences remain pending and gates network work", async () => {
  const runtime = deferred();
  const preferences = deferred();
  const secureSession = deferred();
  const calls = [];
  let network = createUnknownNetworkState();

  const startup = startMobileAppServices({
    startRuntime() {
      calls.push("runtime");
      return runtime.promise.then((status) => {
        network = networkStateFromSample(status);
      });
    },
    hydratePreferences() {
      calls.push("preferences");
      return preferences.promise;
    },
    hydrateSecureSession() {
      calls.push("secure-session");
      return secureSession.promise;
    },
    async refreshAuth() {
      assert.equal(hasConfirmedNetworkConnection(network), true);
      calls.push("auth");
    },
    async refreshLeaderboard() {
      assert.equal(hasConfirmedNetworkConnection(network), true);
      calls.push("leaderboard");
    },
    onError(error) {
      assert.fail(error);
    },
  });

  await flushMicrotasks();
  assert.deepEqual(calls, ["runtime", "preferences", "secure-session"]);
  assert.equal(hasConfirmedNetworkConnection(network), false);

  secureSession.resolve();
  await flushMicrotasks();
  assert.equal(calls.includes("auth"), false);

  runtime.resolve({ connected: true, connectionType: "wifi" });
  await startup.leaderboardReady;
  assert.equal(calls.includes("leaderboard"), true);
  await startup.authReady;
  assert.equal(calls.includes("auth"), true);

  let preferencesFinished = false;
  startup.preferencesReady.then(() => {
    preferencesFinished = true;
  });
  await flushMicrotasks();
  assert.equal(preferencesFinished, false);
  preferences.resolve();
  await startup.done;
});

test("startup processes a launch exactly once after authentication settles", async () => {
  const authentication = deferred();
  const calls = [];
  const startup = startMobileAppServices({
    async startRuntime() {
      calls.push("runtime");
    },
    async hydratePreferences() {},
    async hydrateSecureSession() {},
    async refreshAuth() {
      calls.push("auth-start");
      await authentication.promise;
      calls.push("auth-settled");
    },
    async processLaunch() {
      calls.push("launch");
    },
    async refreshLeaderboard() {},
    onError(error) {
      assert.fail(error);
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["runtime", "auth-start"]);

  authentication.resolve();
  await Promise.all([startup.launchReady, startup.done]);
  assert.deepEqual(calls, ["runtime", "auth-start", "auth-settled", "launch"]);

  await startup.launchReady;
  assert.equal(calls.filter((call) => call === "launch").length, 1);
});

test("network requests stay fail closed until a connected platform sample", () => {
  const initial = createUnknownNetworkState();
  assert.deepEqual(initial, {
    connected: false,
    connectionType: "unknown",
    confirmed: false,
  });
  assert.equal(hasConfirmedNetworkConnection(initial), false);
  assert.equal(
    hasConfirmedNetworkConnection(networkStateFromSample({ connected: false, connectionType: "none" })),
    false,
  );
  assert.equal(
    hasConfirmedNetworkConnection(networkStateFromSample({ connected: "yes", connectionType: "wifi" })),
    false,
  );
  assert.equal(
    hasConfirmedNetworkConnection(networkStateFromSample({ connected: true, connectionType: "wifi" })),
    true,
  );
});

test("a visible viewport anchor compensates layout growth above the battle board", async () => {
  const support = await import("../src/mobile-app-support.js");
  assert.equal(typeof support.captureVisibleViewportAnchor, "function");
  assert.equal(typeof support.restoreViewportAnchor, "function");

  let rect = { top: 120, bottom: 480 };
  const board = {
    getBoundingClientRect: () => rect,
  };
  const anchor = support.captureVisibleViewportAnchor(board, 800);
  assert.deepEqual(anchor, { top: 120 });

  rect = { top: 198, bottom: 558 };
  const scrolls = [];
  assert.equal(
    support.restoreViewportAnchor(anchor, board, (...args) => scrolls.push(args)),
    true,
  );
  assert.deepEqual(scrolls, [[0, 78]]);

  assert.equal(
    support.captureVisibleViewportAnchor({ getBoundingClientRect: () => ({ top: 801, bottom: 900 }) }, 800),
    null,
  );
  assert.equal(support.restoreViewportAnchor(anchor, null, () => assert.fail()), false);
});

test("late preference hydration cannot overwrite a newer user action", async () => {
  const read = deferred();
  const writes = [];
  const preferences = createPreferenceCoordinator({
    settings: {
      get: () => read.promise,
      set: async (key, value) => {
        writes.push([key, value]);
      },
    },
    onError(error) {
      assert.fail(error);
    },
  });
  let theme = "light";

  const hydration = preferences.hydrate("theme", (value) => {
    theme = value;
  });
  await preferences.write("theme", "dark");
  theme = "dark";
  read.resolve("light");

  assert.equal(await hydration, false);
  assert.equal(theme, "dark");
  assert.deepEqual(writes, [["theme", "dark"]]);
});

test("preference writes stay ordered per key and continue after an observed failure", async () => {
  const first = deferred();
  const second = deferred();
  const started = [];
  const errors = [];
  const preferences = createPreferenceCoordinator({
    settings: {
      async get() {
        return null;
      },
      set(key, value) {
        started.push([key, value]);
        return started.length === 1 ? first.promise : second.promise;
      },
    },
    onError(error) {
      errors.push(error.message);
    },
  });

  const firstWrite = preferences.write("theme", "dark");
  const secondWrite = preferences.write("theme", "light");
  await flushMicrotasks();
  assert.deepEqual(started, [["theme", "dark"]]);

  first.reject(new Error("blocked"));
  assert.equal(await firstWrite, false);
  await flushMicrotasks();
  assert.deepEqual(started, [["theme", "dark"], ["theme", "light"]]);
  second.resolve();
  assert.equal(await secondWrite, true);
  assert.deepEqual(errors, ["blocked"]);
});

test("secure hydration cannot overwrite a later persisted login", async () => {
  const read = deferred();
  const set = deferred();
  const applied = [];
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      get: () => read.promise,
      set: () => set.promise,
      clear: async () => {},
    },
  });

  const hydration = sessions.hydrate((token) => applied.push(["hydrate", token]));
  const login = sessions.establish("new-token", () => applied.push(["login", "new-token"]));
  read.resolve("old-token");
  assert.equal(await hydration, false);
  set.resolve();
  assert.equal(await login, true);
  assert.deepEqual(applied, [["login", "new-token"]]);
});

test("secure persistence fails closed and logout clear follows an earlier set", async () => {
  const failedSet = deferred();
  const failedCoordinator = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        return "";
      },
      set: () => failedSet.promise,
      async clear() {},
    },
  });
  let exposed = false;
  const failedLogin = failedCoordinator.establish("token", () => {
    exposed = true;
  });
  failedSet.reject(new Error("secure storage unavailable"));
  await assert.rejects(failedLogin, /secure storage unavailable/);
  assert.equal(exposed, false);

  const set = deferred();
  const clear = deferred();
  const calls = [];
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        return "";
      },
      set() {
        calls.push("set");
        return set.promise;
      },
      clear() {
        calls.push("clear");
        return clear.promise;
      },
    },
  });
  let authenticated = true;
  const login = sessions.establish("token", () => {
    authenticated = true;
  });
  const logout = sessions.invalidate(() => {
    authenticated = false;
  });
  await flushMicrotasks();
  assert.deepEqual(calls, ["set"]);
  assert.equal(authenticated, true);

  set.resolve();
  assert.equal(await login, false);
  await flushMicrotasks();
  assert.deepEqual(calls, ["set", "clear"]);
  assert.equal(authenticated, true);
  clear.resolve();
  assert.equal(await logout, true);
  assert.equal(authenticated, false);
});

test("failed secure-session clearing keeps the authenticated UI state", async () => {
  const failure = new Error("secure clear failed");
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        return "token";
      },
      async set() {},
      async clear() {
        throw failure;
      },
    },
  });
  let authenticated = true;

  await assert.rejects(
    sessions.invalidate(() => {
      authenticated = false;
    }),
    (error) => error === failure,
  );
  assert.equal(authenticated, true);
});

test("secure persistence clears an auth result superseded by its request generation", async () => {
  const set = deferred();
  const clear = deferred();
  const calls = [];
  let requestGeneration = 1;
  let authenticatedUser = "";
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        return "";
      },
      set(token) {
        calls.push(["set", token]);
        return set.promise;
      },
      clear() {
        calls.push(["clear"]);
        return clear.promise;
      },
    },
  });

  const login = sessions.establish(
    "stale-token",
    () => {
      authenticatedUser = "stale-user";
    },
    { isCurrent: () => requestGeneration === 1 },
  );
  await flushMicrotasks();
  requestGeneration = 2;
  set.resolve();
  await flushMicrotasks();

  assert.deepEqual(calls, [["set", "stale-token"], ["clear"]]);
  assert.equal(authenticatedUser, "");
  clear.resolve();
  assert.equal(await login, false);
});

test("a newer secure login overwrites a superseded pending token without a late clear", async () => {
  const firstSet = deferred();
  const secondSet = deferred();
  const calls = [];
  let requestGeneration = 1;
  let authenticatedUser = "";
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        return "";
      },
      set(token) {
        calls.push(["set", token]);
        return token === "first-token" ? firstSet.promise : secondSet.promise;
      },
      async clear() {
        calls.push(["clear"]);
      },
    },
  });

  const firstLogin = sessions.establish(
    "first-token",
    () => {
      authenticatedUser = "first-user";
    },
    { isCurrent: () => requestGeneration === 1 },
  );
  await flushMicrotasks();
  requestGeneration = 2;
  const secondLogin = sessions.establish(
    "second-token",
    () => {
      authenticatedUser = "second-user";
    },
    { isCurrent: () => requestGeneration === 2 },
  );

  firstSet.resolve();
  assert.equal(await firstLogin, false);
  await flushMicrotasks();
  assert.deepEqual(calls, [["set", "first-token"], ["set", "second-token"]]);
  secondSet.resolve();
  assert.equal(await secondLogin, true);
  assert.equal(authenticatedUser, "second-user");
  assert.equal(calls.some(([operation]) => operation === "clear"), false);
});

test("snapshot clear is ordered after a pending lifecycle save", async () => {
  const pendingSave = deferred();
  let stored = null;
  let clearCalls = 0;
  const snapshots = createOrderedSnapshotStore({
    async load() {
      return stored;
    },
    async save(value) {
      await pendingSave.promise;
      stored = value;
    },
    async clear() {
      clearCalls += 1;
      stored = null;
    },
  });

  const save = snapshots.save({ screen: "playing" });
  await flushMicrotasks();
  const clear = snapshots.clear();
  await flushMicrotasks();
  assert.equal(clearCalls, 0);

  pendingSave.resolve();
  await save;
  await clear;
  assert.equal(clearCalls, 1);
  assert.equal(await snapshots.load(), null);
});

test("snapshot discard drops lifecycle saves until its route transition completes", async () => {
  const clear = deferred();
  const transition = deferred();
  const writes = [];
  const snapshots = createDiscardableSnapshotStore({
    async load() {
      return null;
    },
    async save(value) {
      writes.push(["save", value.screen]);
    },
    async clear() {
      writes.push(["clear"]);
      await clear.promise;
    },
  });

  const discard = snapshots.discard(async () => {
    writes.push(["route-start"]);
    await transition.promise;
    writes.push(["route-complete"]);
  });
  await flushMicrotasks();
  assert.deepEqual(writes, [["clear"]]);

  const lifecycleSave = snapshots.save({ screen: "playing" });
  assert.equal(await lifecycleSave, false);
  clear.resolve();
  await flushMicrotasks();
  assert.deepEqual(writes, [["clear"], ["route-start"]]);

  assert.equal(await snapshots.save({ screen: "playing" }), false);
  transition.resolve();
  assert.equal(await discard, true);
  assert.deepEqual(writes, [["clear"], ["route-start"], ["route-complete"]]);

  assert.equal(await snapshots.save({ screen: "menu" }), true);
  assert.deepEqual(writes.at(-1), ["save", "menu"]);
});

test("app navigation clears a local snapshot before changing route and closing online state", async () => {
  const clear = deferred();
  const state = { mode: "agent", screen: "playing" };
  const calls = [];
  const navigation = createAppNavigationCoordinator({
    shouldDiscardLocalBattle: () => state.mode === "agent" && state.screen === "playing",
    discardLocalBattle: async (transition) => {
      calls.push("clear");
      await clear.promise;
      await transition();
    },
    resetOnline: () => calls.push("close-online"),
    onError(error) {
      assert.fail(error);
    },
  });

  const route = navigation.run(() => {
    calls.push("route");
    state.screen = "archive";
  });
  await flushMicrotasks();
  assert.equal(state.screen, "playing");
  assert.deepEqual(calls, ["clear"]);

  clear.resolve();
  assert.equal(await route, true);
  assert.equal(state.screen, "archive");
  assert.deepEqual(calls, ["clear", "close-online", "route"]);
});

test("failed local snapshot disposal blocks route completion", async () => {
  const failure = new Error("snapshot storage failed");
  const errors = [];
  let screen = "training";
  let onlineClosed = false;
  const navigation = createAppNavigationCoordinator({
    shouldDiscardLocalBattle: () => true,
    discardLocalBattle: async () => {
      throw failure;
    },
    resetOnline: () => {
      onlineClosed = true;
    },
    onError(error) {
      errors.push(error);
    },
  });

  const completed = await navigation.run(() => {
    screen = "replay";
  });

  assert.equal(completed, false);
  assert.equal(screen, "training");
  assert.equal(onlineClosed, false);
  assert.deepEqual(errors, [failure]);
});

test("archive and replay navigation close an active online client before routing", async () => {
  const calls = [];
  const navigation = createAppNavigationCoordinator({
    shouldDiscardLocalBattle: () => false,
    discardLocalBattle: async () => assert.fail("online routes must not clear local snapshots"),
    resetOnline: () => calls.push("close-online"),
  });

  const completed = await navigation.run(() => calls.push("replay-route"));

  assert.equal(completed, true);
  assert.deepEqual(calls, ["close-online", "replay-route"]);
});

test("latest online create closes and supersedes an earlier create", async () => {
  const harness = createClientHarness();
  const coordinator = createLatestClientCoordinator({ createClient: harness.createClient });
  const committed = [];
  const errors = [];

  const first = coordinator.run({
    handlers: { onMessage: () => committed.push("stale-message") },
    operation: (client) => client.createRoom(),
    onSuccess: (session) => committed.push(session.roomCode),
    onError: (error) => errors.push(error.message),
  });
  const second = coordinator.run({
    handlers: { onMessage: () => committed.push("current-message") },
    operation: (client) => client.createRoom(),
    onSuccess: (session) => committed.push(session.roomCode),
    onError: (error) => errors.push(error.message),
  });

  assert.equal(harness.clients[0].closed, true);
  harness.clients[1].create.resolve({ roomCode: "BBBB" });
  assert.equal((await second).status, "active");
  harness.clients[0].create.resolve({ roomCode: "AAAA" });
  assert.equal((await first).status, "stale");
  assert.deepEqual(committed, ["BBBB"]);
  assert.deepEqual(errors, []);
});

test("latest online join supersedes create and stale handlers do nothing", async () => {
  const harness = createClientHarness();
  const coordinator = createLatestClientCoordinator({ createClient: harness.createClient });
  const committed = [];

  const create = coordinator.run({
    handlers: { onMessage: (message) => committed.push(message.value) },
    operation: (client) => client.createRoom(),
    onSuccess: (session) => committed.push(session.roomCode),
  });
  const join = coordinator.run({
    handlers: { onMessage: (message) => committed.push(message.value) },
    operation: (client) => client.joinRoom("JOIN"),
    onSuccess: (session) => committed.push(session.roomCode),
  });

  harness.clients[0].handlers.onMessage({ value: "stale-callback" });
  harness.clients[1].handlers.onMessage({ value: "live-callback" });
  harness.clients[1].join.resolve({ roomCode: "JOIN" });
  assert.equal((await join).status, "active");
  harness.clients[0].create.reject(new Error("stale failure"));
  assert.equal((await create).status, "stale");
  assert.deepEqual(committed, ["live-callback", "JOIN"]);
});

test("a superseded pending client cannot reconnect after it was closed", async () => {
  const pendingRequest = deferred();
  const clients = [];
  const coordinator = createLatestClientCoordinator({
    createClient() {
      const client = {
        closeCalls: 0,
        connectCalls: 0,
        close() {
          this.closeCalls += 1;
        },
        connect() {
          this.connectCalls += 1;
        },
        async createRoom() {
          await pendingRequest.promise;
          await this.connect();
          return { roomCode: "LATE" };
        },
      };
      clients.push(client);
      return client;
    },
  });

  const first = coordinator.run({
    operation: (client) => client.createRoom(),
  });
  const second = coordinator.run({
    operation: async () => ({ roomCode: "NEXT" }),
  });
  assert.equal((await second).status, "active");
  pendingRequest.resolve();

  assert.equal((await first).status, "stale");
  assert.equal(clients[0].closeCalls > 0, true);
  assert.equal(clients[0].connectCalls, 0);
});

test("deep-link parser accepts only Salvo and canonical HTTPS routes", () => {
  assert.deepEqual(parseSalvoDeepLink("salvo://open/room/ab12"), {
    type: "room",
    roomCode: "AB12",
  });
  assert.deepEqual(parseSalvoDeepLink("salvo://open/replay/replay-1"), {
    type: "replay",
    replayId: "replay-1",
  });
  assert.deepEqual(
    parseSalvoDeepLink("https://agent-axiom.github.io/agents-salvo/open/room/ROOM9"),
    { type: "room", roomCode: "ROOM9" },
  );
  assert.deepEqual(
    parseSalvoDeepLink("https://agent-axiom.github.io/agents-salvo/?replay=battle-7"),
    { type: "replay", replayId: "battle-7" },
  );
  assert.deepEqual(
    parseSalvoDeepLink("https://agent-axiom.github.io/agents-salvo/open/replay/battle-8"),
    { type: "replay", replayId: "battle-8" },
  );
});

test("deep-link parser accepts strict auth success and fixed failure routes", () => {
  const ticket = "Ab3_-".repeat(7);
  assert.deepEqual(parseSalvoDeepLink(`salvo://open/auth/${ticket}`), {
    type: "auth",
    ticket,
  });
  assert.deepEqual(parseSalvoDeepLink("salvo://open/auth/error"), {
    type: "authError",
    code: "telegram",
  });
});

test("deep-link parser rejects unsafe auth route variants", () => {
  const ticket = "a".repeat(32);
  for (const value of [
    `salvo://foreign/auth/${ticket}`,
    `salvo:///open/auth/${ticket}`,
    `salvo:/open/auth/${ticket}`,
    `salvo://user@open/auth/${ticket}`,
    `salvo://@open/auth/${ticket}`,
    `salvo://open:444/auth/${ticket}`,
    `salvo://open/auth/${ticket}?next=room`,
    `salvo://open/auth/${ticket}?`,
    `salvo://open/auth/${ticket}#secret`,
    `salvo://open/auth/${ticket}#`,
    `salvo://open/auth/${ticket}/extra`,
    `salvo://open/open/auth/${ticket}`,
    `salvo://open/auth%2F${ticket}`,
    `salvo://open/auth/${ticket}%2Fextra`,
    `salvo://open/auth/${ticket}%5Cextra`,
    `salvo://open/auth/${"a".repeat(31)}`,
    `salvo://open/auth/${"a".repeat(257)}`,
    `salvo://open/auth/${"a".repeat(31)}!`,
    `https://agent-axiom.github.io/agents-salvo/open/auth/${ticket}`,
    "salvo://open/auth/Error",
    "salvo://open/auth/error/extra",
    "salvo://open/auth/error?code=telegram",
    "salvo://open/auth/telegram",
    "salvo://open/auth-error",
  ]) {
    assert.equal(parseSalvoDeepLink(value), null, value);
  }
});

test("web bootstrap captures a valid ticket and cleans auth parameters", () => {
  const ticket = "xY9_-".repeat(7);
  const history = historyHarness();
  const result = captureTelegramAuthBootstrap({
    rawUrl: `https://agent-axiom.github.io/agents-salvo/?view=fleet&auth_ticket=${ticket}#scores`,
    history,
  });

  assert.deepEqual(result, { type: "ticket", ticket });
  assert.deepEqual(history.calls, [[
    "replaceState",
    null,
    "",
    "https://agent-axiom.github.io/agents-salvo/?view=fleet#scores",
  ]]);
});

test("web bootstrap rejects conflicting auth parameters and cleans both", () => {
  const ticket = "xY9_-".repeat(7);
  const history = historyHarness();
  const result = captureTelegramAuthBootstrap({
    rawUrl: `https://agent-axiom.github.io/agents-salvo/?view=fleet&auth_ticket=${ticket}&auth_error=telegram#scores`,
    history,
  });

  assert.deepEqual(result, { type: "none" });
  assert.deepEqual(history.calls, [[
    "replaceState",
    null,
    "",
    "https://agent-axiom.github.io/agents-salvo/?view=fleet#scores",
  ]]);
});

test("web bootstrap returns only the fixed Telegram auth error and cleans it", () => {
  const history = historyHarness();
  const result = captureTelegramAuthBootstrap({
    rawUrl: "https://agent-axiom.github.io/agents-salvo/?auth_error=telegram&view=profile#account",
    history,
  });

  assert.deepEqual(result, { type: "authError", code: "telegram" });
  assert.deepEqual(history.calls[0], [
    "replaceState",
    null,
    "",
    "https://agent-axiom.github.io/agents-salvo/?view=profile#account",
  ]);
});

test("web bootstrap removes malformed or repeated auth values without returning them", () => {
  const malformedValues = [
    `auth_ticket=${"a".repeat(31)}`,
    `auth_ticket=${"a".repeat(32)}!`,
    `auth_ticket=${"a".repeat(32)}&auth_ticket=${"b".repeat(32)}`,
    "auth_error=denied-by-provider",
    "auth_error=telegram&auth_error=telegram",
  ];

  for (const query of malformedValues) {
    const history = historyHarness();
    const result = captureTelegramAuthBootstrap({
      rawUrl: `https://agent-axiom.github.io/agents-salvo/?keep=1&${query}#safe-hash`,
      history,
    });
    assert.deepEqual(result, { type: "none" }, query);
    assert.deepEqual(history.calls, [[
      "replaceState",
      null,
      "",
      "https://agent-axiom.github.io/agents-salvo/?keep=1#safe-hash",
    ]], query);
  }
});

test("web bootstrap ignores noncanonical URLs and never navigates or reloads", () => {
  const ticket = "z".repeat(32);
  for (const rawUrl of [
    `http://agent-axiom.github.io/agents-salvo/?auth_ticket=${ticket}`,
    `https://example.com/agents-salvo/?auth_ticket=${ticket}`,
    `https://user@agent-axiom.github.io/agents-salvo/?auth_ticket=${ticket}`,
    `https://@agent-axiom.github.io/agents-salvo/?auth_ticket=${ticket}`,
    `https://agent-axiom.github.io:443/agents-salvo/?auth_ticket=${ticket}`,
    `https://agent-axiom.github.io/agents-salvo/open/room/ABCD?auth_ticket=${ticket}`,
    `https://agent-axiom.github.io/agents-salvo/extra?auth_ticket=${ticket}`,
    "not a url",
  ]) {
    const history = historyHarness();
    assert.deepEqual(captureTelegramAuthBootstrap({ rawUrl, history }), { type: "none" }, rawUrl);
    assert.deepEqual(history.calls, [], rawUrl);
  }
});

test("deep-link parser rejects unsafe origins, schemes, credentials, ports, and paths", () => {
  for (const value of [
    "http://agent-axiom.github.io/agents-salvo/?replay=battle-1",
    "javascript:alert(1)",
    "https://example.com/agents-salvo/?replay=battle-1",
    "https://agent-axiom.github.io.evil.test/agents-salvo/?replay=battle-1",
    "https://user@agent-axiom.github.io/agents-salvo/?replay=battle-1",
    "https://agent-axiom.github.io:444/agents-salvo/?replay=battle-1",
    "https://agent-axiom.github.io:443/agents-salvo/?replay=battle-1",
    "https://agent-axiom.github.io/outside/?replay=battle-1",
    "salvo://open/room/AB!D",
    "salvo://open/room/ABCD/extra",
    "salvo://foreign/room/ABCD",
    "not a url",
  ]) {
    assert.equal(parseSalvoDeepLink(value), null, value);
  }
});

test("leave dialog controller targets the destructive dialog when another dialog comes first", () => {
  const harness = createDialogHarness({ withCompetingDialog: true });
  let cancellations = 0;
  const controller = createDialogFocusController({
    root: harness.root,
    document: harness.document,
    dialogSelector: '[data-dialog="leave-battle"]',
    onCancel() {
      cancellations += 1;
    },
  });

  harness.trigger.focus();
  const returnFocus = controller.captureReturnFocus();
  controller.activate(returnFocus);
  assert.equal(harness.background.inert, true);
  assert.equal(harness.background.attributes.get("aria-hidden"), "true");
  assert.equal(harness.document.activeElement, harness.cancel);
  assert.notEqual(harness.document.activeElement, harness.competingClose);

  harness.dispatchKey("Tab", { shiftKey: true });
  assert.equal(harness.document.activeElement, harness.confirm);
  harness.dispatchKey("Tab");
  assert.equal(harness.document.activeElement, harness.cancel);
  harness.dispatchKey("Escape");
  assert.equal(cancellations, 1);

  controller.deactivate();
  assert.equal(harness.background.inert, false);
  assert.equal(harness.background.attributes.has("aria-hidden"), false);
  controller.restoreFocus(returnFocus);
  assert.equal(harness.document.activeElement, harness.trigger);
});

test("preference hydration observes read and observer failures without escaping", async () => {
  const preferences = createPreferenceCoordinator({
    settings: {
      async get() {
        throw new Error("settings unavailable");
      },
      async set() {},
    },
    async onError() {
      throw new Error("observer unavailable");
    },
  });

  assert.equal(await preferences.hydrate("theme", () => assert.fail("must not apply")), false);
});

test("secure session treats read and current-request failures as unauthenticated", async () => {
  const clears = [];
  const sessions = createSecureSessionCoordinator({
    secureSession: {
      async get() {
        throw new Error("secure read failed");
      },
      async set() {},
      async clear() {
        clears.push("clear");
      },
    },
  });
  const hydrated = [];

  assert.equal(await sessions.hydrate((token) => hydrated.push(token)), false);
  assert.deepEqual(hydrated, [""]);
  assert.equal(await sessions.establish("token", () => assert.fail("must not commit"), {
    isCurrent() {
      throw new Error("request check failed");
    },
  }), false);
  assert.deepEqual(clears, ["clear"]);
});

test("latest client coordinator contains close and operation failures", async () => {
  const errors = [];
  const coordinator = createLatestClientCoordinator({
    createClient() {
      return {
        close() {
          throw new Error("close failed");
        },
      };
    },
  });

  const result = await coordinator.run({
    async operation() {
      throw new Error("request failed");
    },
    onError(error) {
      errors.push(error.message);
    },
  });
  assert.equal(result.status, "error");
  assert.deepEqual(errors, ["request failed"]);
  coordinator.close();
});

test("web auth bootstrap fails closed when URL cleanup is blocked", () => {
  const ticket = "a".repeat(32);
  const result = captureTelegramAuthBootstrap({
    rawUrl: `https://agent-axiom.github.io/agents-salvo/?auth_ticket=${ticket}`,
    history: {
      replaceState() {
        throw new Error("history blocked");
      },
    },
  });
  assert.deepEqual(result, { type: "none" });
});

test("dialog focus controller contains focus when no controls are available", () => {
  let keydown;
  let prevented = false;
  const document = {
    activeElement: null,
    addEventListener(_type, listener) {
      keydown = listener;
    },
    removeEventListener() {},
  };
  const dialog = { contains: () => false, querySelectorAll: () => [] };
  const root = {
    querySelector: (selector) => selector === '[role="dialog"]' ? dialog : null,
    querySelectorAll: () => [],
  };
  const controller = createDialogFocusController({ root, document, onCancel() {} });

  assert.equal(controller.captureReturnFocus(), null);
  controller.activate();
  keydown({ key: "Tab", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  controller.restoreFocus(null);
  controller.deactivate();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function historyHarness() {
  const calls = [];
  return {
    calls,
    replaceState(...args) {
      calls.push(["replaceState", ...args]);
    },
    reload() {
      assert.fail("bootstrap helper must not reload");
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createClientHarness() {
  const clients = [];
  return {
    clients,
    createClient(handlers) {
      const client = {
        handlers,
        create: deferred(),
        join: deferred(),
        closed: false,
        createRoom() {
          return this.create.promise;
        },
        joinRoom() {
          return this.join.promise;
        },
        close() {
          this.closed = true;
        },
      };
      clients.push(client);
      return client;
    },
  };
}

function createDialogHarness({ withCompetingDialog = false } = {}) {
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const makeElement = ({ id = "", action = "" } = {}) => ({
    id,
    dataset: action ? { action } : {},
    attributes: new Map(),
    inert: false,
    isConnected: true,
    focus() {
      document.activeElement = this;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  });
  const trigger = makeElement({ action: "menu" });
  const competingClose = makeElement({ action: "close-profile" });
  const cancel = makeElement({ action: "cancel-leave-battle" });
  const confirm = makeElement({ action: "confirm-leave-battle" });
  const background = makeElement();
  const dialog = {
    contains(element) {
      return element === cancel || element === confirm;
    },
    querySelectorAll() {
      return [cancel, confirm];
    },
  };
  const competingDialog = {
    contains(element) {
      return element === competingClose;
    },
    querySelectorAll() {
      return [competingClose];
    },
  };
  const root = {
    querySelector(selector) {
      if (selector === "[data-dialog-background]") return background;
      if (selector === '[data-dialog="leave-battle"]') return dialog;
      if (selector === '[role="dialog"]') return withCompetingDialog ? competingDialog : dialog;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-action]" ? [trigger, cancel, confirm] : [];
    },
  };

  return {
    background,
    cancel,
    competingClose,
    confirm,
    document,
    root,
    trigger,
    dispatchKey(key, { shiftKey = false } = {}) {
      let prevented = false;
      listeners.get("keydown")?.({
        key,
        shiftKey,
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
    },
  };
}
