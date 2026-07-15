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
  "auth-capability": runAuthCapabilityScenario,
  "auth-start": runAuthStartScenario,
  "auth-native-callback": runAuthNativeCallbackScenario,
  "auth-races": runAuthRacesScenario,
  "auth-bootstrap": runAuthBootstrapScenario,
  "auth-recovery": runAuthRecoveryScenario,
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

async function runAuthCapabilityScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const cases = [
    {
      name: "web legacy",
      options: { capability: { method: "legacy" } },
      method: "legacy",
      oidc: false,
      widget: true,
      unavailable: false,
    },
    {
      name: "web oidc",
      options: { capability: { method: "oidc" } },
      method: "oidc",
      oidc: true,
      widget: false,
      unavailable: false,
    },
    {
      name: "android oidc",
      options: { native: true, platformName: "android", capability: { method: "oidc" } },
      method: "oidc",
      oidc: true,
      widget: false,
      unavailable: false,
    },
    {
      name: "ios oidc",
      options: { native: true, platformName: "ios", capability: { method: "oidc" } },
      method: "oidc",
      oidc: false,
      widget: false,
      unavailable: true,
    },
    {
      name: "android legacy",
      options: { native: true, platformName: "android", capability: { method: "legacy" } },
      method: "legacy",
      oidc: false,
      widget: false,
      unavailable: true,
    },
    {
      name: "malformed capability",
      options: { capability: { method: "future" } },
      method: "unavailable",
      oidc: false,
      widget: false,
      unavailable: true,
    },
    {
      name: "capability failure",
      options: { capability: new Error("network detail must stay private") },
      method: "unavailable",
      oidc: false,
      widget: false,
      unavailable: true,
    },
    {
      name: "missing worker",
      options: { workerUrl: "" },
      method: "unavailable",
      oidc: false,
      widget: false,
      unavailable: true,
    },
  ];

  for (const authCase of cases) {
    const harness = createAppHarness(authCase.options);
    const app = bootSalvoApp(harness.dependencies);
    assert.equal(app.getState().auth.method, "unknown", `${authCase.name} starts unknown`);
    assert.ok(app.startup.capabilityReady instanceof Promise, `${authCase.name} exposes capabilityReady`);
    assert.ok(app.startup.bootstrapReady instanceof Promise, `${authCase.name} exposes bootstrapReady`);
    await app.startup.done;

    assert.equal(app.getState().auth.method, authCase.method, authCase.name);
    assert.equal(harness.root.innerHTML.includes('data-action="auth-telegram-oidc"'), authCase.oidc, authCase.name);
    assert.equal(harness.root.innerHTML.includes('id="telegram-login-slot"'), authCase.widget, authCase.name);
    assert.equal(harness.document.createdScripts.length > 0, authCase.widget, authCase.name);
    assert.equal(harness.root.innerHTML.includes("Telegram login is unavailable"), authCase.unavailable, authCase.name);
    assert.doesNotMatch(harness.root.innerHTML, /worker\.example|network detail|future/);
    if (authCase.options.workerUrl === "") {
      assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/config")), false);
    }
    await app.stop();
  }
}

async function runAuthStartScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  for (const [native, platformName, expectedPlatform] of [
    [false, "web", "web"],
    [true, "android", "android"],
  ]) {
    const harness = createAppHarness({
      native,
      platformName,
      capability: { method: "oidc" },
      startResponse: { authorizationUrl: "https://oauth.telegram.org/auth?bot_id=123&state=safe" },
    });
    const app = bootSalvoApp(harness.dependencies);
    await app.startup.done;

    await harness.root.click("auth-telegram-oidc");
    const request = harness.fetchCalls.find(({ url }) => url.endsWith("/auth/telegram/mobile/start"));
    assert.deepEqual(JSON.parse(request.init.body), { platform: expectedPlatform });
    assert.deepEqual(harness.calls.openedUrls, ["https://oauth.telegram.org/auth?bot_id=123&state=safe"]);
    assert.equal(app.getState().auth.loading, true);
    assert.match(harness.root.innerHTML, /Opening Telegram/);
    assert.match(harness.root.innerHTML, /data-action="auth-telegram-oidc"[^>]*disabled/);
    assert.match(harness.root.innerHTML, /href="\/agents-salvo\/privacy\.html"/);
    assert.match(harness.root.innerHTML, /Save your profile and online progress/);
    await app.stop();
  }
}

async function runAuthNativeCallbackScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const ticket = "native_callback_ticket_12345678901234567890";
  const events = [];
  const harness = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
    onCloseExternalUrl: async () => events.push("close"),
    onSecureSet: async (token) => events.push(`secure:${token}`),
    redeemResponse: {
      token: "native-session-token",
      user: telegramUser("native-user", "Native Captain"),
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) {
        events.push("profile");
        return response({ profile: { name: "Native Captain", leaderboard: [] } });
      }
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;
  await harness.root.click("start-agent");
  assert.equal(app.getState().screen, "setup");

  await harness.emitDeepLink(`salvo://open/auth/${ticket}`);
  assert.equal(app.getState().screen, "setup");
  assert.equal(app.getState().auth.token, "native-session-token");
  assert.equal(app.getState().auth.user.name, "Native Captain");
  assert.deepEqual(events, ["close", "secure:native-session-token", "profile"]);
  assert.equal(harness.calls.secureSets, 1);
  assert.equal(harness.fetchCalls.filter(({ url }) => url.endsWith("/auth/telegram/mobile/redeem")).length, 1);

  const cancelled = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
  });
  const cancelledApp = bootSalvoApp(cancelled.dependencies);
  await cancelledApp.startup.done;
  await cancelled.root.click("start-agent");
  await cancelled.root.click("auth-telegram-oidc");
  assert.equal(cancelledApp.getState().auth.loading, true);
  await cancelled.emitDeepLink("salvo://open/auth/error");
  assert.equal(cancelledApp.getState().screen, "setup");
  assert.equal(cancelledApp.getState().auth.loading, false);
  assert.equal(cancelled.calls.closedUrls, 1);
  assert.equal(cancelled.fetchCalls.some(({ url }) => url.endsWith("/redeem")), false);
  assert.match(cancelled.root.innerHTML, /Telegram sign-in was cancelled/);

  const malformedResult = await cancelled.emitDeepLink("salvo://open/auth/short");
  assert.equal(malformedResult, false);
  assert.equal(cancelled.calls.closedUrls, 1);
  await Promise.all([app.stop(), cancelledApp.stop()]);
}

async function runAuthRacesScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const firstStart = deferred();
  const secondStart = deferred();
  let startCount = 0;
  const starts = createAppHarness({
    capability: { method: "oidc" },
    startResponse() {
      startCount += 1;
      return startCount === 1 ? firstStart.promise : secondStart.promise;
    },
  });
  const startsApp = bootSalvoApp(starts.dependencies);
  await startsApp.startup.done;
  const staleStart = starts.root.click("auth-telegram-oidc");
  await waitFor(() => startCount === 1);
  const currentStart = starts.root.click("auth-telegram-oidc");
  await waitFor(() => startCount === 2);
  firstStart.resolve({ authorizationUrl: "https://oauth.telegram.org/auth?state=stale" });
  secondStart.resolve({ authorizationUrl: "https://oauth.telegram.org/auth?state=current" });
  await Promise.all([staleStart, currentStart]);
  assert.deepEqual(starts.calls.openedUrls, ["https://oauth.telegram.org/auth?state=current"]);

  const firstRedeem = deferred();
  const secondRedeem = deferred();
  let redeemCount = 0;
  const callbacks = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
    redeemResponse() {
      redeemCount += 1;
      return redeemCount === 1 ? firstRedeem.promise : secondRedeem.promise;
    },
  });
  const callbacksApp = bootSalvoApp(callbacks.dependencies);
  await callbacksApp.startup.done;
  const staleCallback = callbacks.emitDeepLink(`salvo://open/auth/${"a".repeat(32)}`);
  await waitFor(() => redeemCount === 1);
  const currentCallback = callbacks.emitDeepLink(`salvo://open/auth/${"b".repeat(32)}`);
  await waitFor(() => redeemCount === 2);
  secondRedeem.resolve({ token: "current-token", user: telegramUser("current", "Current Captain") });
  await currentCallback;
  firstRedeem.resolve({ token: "stale-token", user: telegramUser("stale", "Stale Captain") });
  await staleCallback;
  assert.equal(callbacksApp.getState().auth.token, "current-token");
  assert.equal(callbacksApp.getState().auth.user.name, "Current Captain");

  const duplicateRedeem = deferred();
  let duplicateCount = 0;
  const duplicates = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
    redeemResponse() {
      duplicateCount += 1;
      return duplicateRedeem.promise;
    },
  });
  const duplicatesApp = bootSalvoApp(duplicates.dependencies);
  await duplicatesApp.startup.done;
  const duplicateTicket = "duplicate_callback_ticket_123456789012345";
  const firstDuplicate = duplicates.emitDeepLink(`salvo://open/auth/${duplicateTicket}`);
  await waitFor(() => duplicateCount === 1);
  const secondDuplicate = duplicates.emitDeepLink(`salvo://open/auth/${duplicateTicket}`);
  await flushMicrotasks();
  assert.equal(duplicateCount, 1);
  duplicateRedeem.resolve({ token: "duplicate-token", user: telegramUser("duplicate", "One Captain") });
  await Promise.all([firstDuplicate, secondDuplicate]);

  const logoutRedeem = deferred();
  const logoutRace = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
    redeemResponse: () => logoutRedeem.promise,
  });
  const logoutApp = bootSalvoApp(logoutRace.dependencies);
  await logoutApp.startup.done;
  const redeeming = logoutRace.emitDeepLink(`salvo://open/auth/${"c".repeat(32)}`);
  await waitFor(() => logoutRace.fetchCalls.some(({ url }) => url.endsWith("/redeem")));
  await logoutRace.root.click("auth-logout");
  logoutRedeem.resolve({ token: "late-token", user: telegramUser("late", "Late Captain") });
  await redeeming;
  assert.equal(logoutApp.getState().auth.token, "");
  assert.equal(logoutApp.getState().auth.user, null);
  assert.equal(logoutRace.calls.secureSets, 0);

  await Promise.all([startsApp.stop(), callbacksApp.stop(), duplicatesApp.stop(), logoutApp.stop()]);
}

async function runAuthBootstrapScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const ticket = "web_bootstrap_ticket_123456789012345678901";
  const bootstrap = createAppHarness({
    initialUrl: `https://agent-axiom.github.io/agents-salvo/?view=fleet&auth_ticket=${ticket}#scores`,
    secureSession: resolvedDeferred("old-session-token"),
    capability: { method: "oidc" },
    redeemResponse: {
      token: "bootstrap-token",
      user: telegramUser("bootstrap", "Bootstrap Captain"),
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/auth/me")) throw new Error("old stored session must not refresh");
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const app = bootSalvoApp(bootstrap.dependencies);
  assert.equal(bootstrap.dependencies.window.location.search, "?view=fleet");
  assert.equal(bootstrap.dependencies.window.location.hash, "#scores");
  assert.equal(bootstrap.calls.historyReplacements, 1);
  assert.doesNotMatch(bootstrap.root.innerHTML, /auth_ticket|web_bootstrap_ticket/);
  await app.startup.done;
  assert.equal(app.getState().auth.token, "bootstrap-token");
  assert.equal(app.getState().auth.user.name, "Bootstrap Captain");
  assert.equal(bootstrap.fetchCalls.some(({ url }) => url.endsWith("/auth/me")), false);

  const cancelled = createAppHarness({
    initialUrl: "https://agent-axiom.github.io/agents-salvo/?auth_error=telegram&view=profile#account",
    capability: { method: "oidc" },
  });
  const cancelledApp = bootSalvoApp(cancelled.dependencies);
  assert.equal(cancelled.dependencies.window.location.search, "?view=profile");
  await cancelledApp.startup.done;
  assert.match(cancelled.root.innerHTML, /Telegram sign-in was cancelled/);
  assert.equal(cancelled.fetchCalls.some(({ url }) => url.endsWith("/redeem")), false);
  await Promise.all([app.stop(), cancelledApp.stop()]);
}

async function runAuthRecoveryScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const offline = createAppHarness({
    network: resolvedDeferred({ connected: false, connectionType: "none" }),
    capability: { method: "oidc" },
  });
  const offlineApp = bootSalvoApp(offline.dependencies);
  await offlineApp.startup.done;
  assert.equal(offline.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/config")), false);
  assert.match(offline.root.innerHTML, /Telegram login is unavailable/);

  await offline.emitNetwork({ connected: true, connectionType: "wifi" });
  await offline.root.click("auth-telegram-retry");
  assert.equal(offlineApp.getState().auth.method, "oidc");
  assert.match(offline.root.innerHTML, /data-action="auth-telegram-oidc"/);

  const persistence = createAppHarness({
    native: true,
    platformName: "android",
    capability: { method: "oidc" },
    redeemResponse: {
      token: "must-not-commit",
      user: telegramUser("storage", "Storage Captain"),
    },
    onSecureSet: async () => Promise.reject(new Error("keystore unavailable")),
  });
  const persistenceApp = bootSalvoApp(persistence.dependencies);
  await persistenceApp.startup.done;
  await persistence.emitDeepLink(`salvo://open/auth/${"d".repeat(32)}`);
  assert.equal(persistenceApp.getState().auth.token, "");
  assert.equal(persistenceApp.getState().auth.user, null);
  assert.match(persistence.root.innerHTML, /Secure login could not be saved/);
  assert.doesNotMatch(persistence.root.innerHTML, /keystore|must-not-commit/);
  await Promise.all([offlineApp.stop(), persistenceApp.stop()]);
}

function createAppHarness({
  network = resolvedDeferred({ connected: true, connectionType: "wifi" }),
  snapshot = resolvedDeferred(null),
  preferences = resolvedDeferred(null),
  secureSession = resolvedDeferred(""),
  native = false,
  platformName = native ? "android" : "web",
  workerUrl = "https://worker.example.test",
  initialUrl = "https://agent-axiom.github.io/agents-salvo/",
  capability = { method: "oidc" },
  startResponse = { authorizationUrl: "https://oauth.telegram.org/auth?state=default" },
  redeemResponse = {
    token: "default-redeemed-token",
    user: telegramUser("default-user", "Default Captain"),
  },
  onSecureClear = () => Promise.resolve(),
  onSecureSet = () => Promise.resolve(),
  onOpenExternalUrl = () => Promise.resolve(),
  onCloseExternalUrl = () => Promise.resolve(),
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
    secureSets: 0,
    openedUrls: [],
    closedUrls: 0,
    historyReplacements: 0,
    settingWrites: [],
  };
  void preferences.promise.then(() => {
    calls.preferencesSettled = true;
  });
  const fetchCalls = [];
  let lifecycleHandler = null;
  let deepLinkHandler = null;
  let networkHandler = null;
  const platform = {
    isNative: () => native,
    getPlatform: () => platformName,
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
      set(token) {
        calls.secureSets += 1;
        return onSecureSet(token);
      },
      clear() {
        calls.secureClears += 1;
        return onSecureClear();
      },
    },
    getNetworkStatus() {
      calls.networkSamples += 1;
      return network.promise;
    },
    async configureSystemBars() {},
    async hideSplash() {},
    async onNetworkChange(handler) {
      networkHandler = handler;
      return async () => {
        if (networkHandler === handler) networkHandler = null;
      };
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
    async openExternalUrl(url) {
      calls.openedUrls.push(url);
      await onOpenExternalUrl(url);
    },
    async closeExternalUrl() {
      calls.closedUrls += 1;
      await onCloseExternalUrl();
    },
  };
  const window = createWindowHarness({ initialUrl, workerUrl, calls });
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
    emitNetwork(event) {
      assert.ok(networkHandler, "Network handler is not registered");
      return networkHandler(event);
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
        if (url.endsWith("/auth/telegram/config")) {
          return clientResult(capability);
        }
        if (url.endsWith("/auth/telegram/mobile/start")) {
          return clientResult(startResponse);
        }
        if (url.endsWith("/auth/telegram/mobile/redeem")) {
          return clientResult(redeemResponse);
        }
        return fetchResponse(url, init);
      },
    },
  };
}

function createDocumentHarness() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    createdScripts: [],
    documentElement: { lang: "", dataset: {} },
    readyState: "complete",
    root: null,
    querySelector(selector) {
      if (selector === "#app") return this.root;
      return this.root?.querySelector(selector) ?? null;
    },
    createElement(tagName) {
      const attributes = new Map();
      const element = {
        tagName: String(tagName).toUpperCase(),
        async: false,
        src: "",
        setAttribute(name, value) {
          attributes.set(name, value);
        },
        getAttribute(name) {
          return attributes.get(name) ?? null;
        },
      };
      if (tagName === "script") this.createdScripts.push(element);
      return element;
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
  let telegramSlot = null;

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
      telegramSlot = html.includes('id="telegram-login-slot"')
        ? {
            innerHTML: "",
            textContent: "",
            append(element) {
              this.innerHTML = `<script src="${element.src}"></script>`;
            },
          }
        : null;
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
      if (selector === "#telegram-login-slot") return telegramSlot;
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

function createWindowHarness({
  initialUrl = "https://agent-axiom.github.io/agents-salvo/",
  workerUrl = "https://worker.example.test",
  calls,
} = {}) {
  const listeners = new Map();
  const initialLocation = new URL(initialUrl);
  const location = {
    href: initialLocation.href,
    origin: initialLocation.origin,
    hostname: initialLocation.hostname,
    pathname: initialLocation.pathname,
    search: initialLocation.search,
    hash: initialLocation.hash,
  };
  const updateLocation = (url) => {
    const parsed = new URL(url, location.href);
    location.href = parsed.href;
    location.origin = parsed.origin;
    location.hostname = parsed.hostname;
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  return {
    SALVO_CONFIG: {
      workerUrl,
      telegramBotUsername: "salvo_test_bot",
    },
    location,
    history: {
      state: null,
      pushState(_state, _title, url) {
        updateLocation(url);
      },
      replaceState(state, _title, url) {
        this.state = state;
        if (calls) calls.historyReplacements += 1;
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

async function clientResult(result) {
  const pending = typeof result === "function" ? result() : result;
  const value = await pending;
  if (value instanceof Error) throw value;
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function telegramUser(id, name) {
  return {
    provider: "telegram",
    id,
    name,
    username: id,
    photoUrl: "",
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
