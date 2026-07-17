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
  "telegram-bootstrap": runTelegramBootstrapScenario,
  "telegram-launch-routing": runTelegramLaunchRoutingScenario,
  "telegram-launch-retry": runTelegramLaunchRetryScenario,
  "telegram-launch-authority": runTelegramLaunchAuthorityScenario,
  "telegram-launch-sharing": runTelegramLaunchSharingScenario,
  "telegram-share-status-race": runTelegramShareStatusRaceScenario,
  "telegram-auth-recovery": runTelegramAuthRecoveryScenario,
  "telegram-runtime": runTelegramRuntimeScenario,
  "haptic-runtime": runHapticRuntimeScenario,
  "telegram-theme-build": runTelegramThemeBuildScenario,
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
  assert.equal(harness.calls.preferenceReads.length, 7);
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
      widget: false,
      widgetAfterConsent: true,
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
    if (authCase.widgetAfterConsent) {
      await harness.root.change("auth-consent", { checked: true });
      assert.equal(app.getState().auth.consent, true);
      assert.equal(harness.root.innerHTML.includes('id="telegram-login-slot"'), true);
      assert.equal(harness.document.createdScripts.length > 0, true);
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

    assert.equal(app.getState().auth.consent, false);
    assert.match(harness.root.innerHTML, /data-action="auth-consent"/);
    assert.match(harness.root.innerHTML, /data-action="auth-telegram-oidc"[^>]*disabled/);
    await harness.root.click("auth-telegram-oidc");
    assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/mobile/start")), false);
    assert.deepEqual(harness.calls.openedUrls, []);
    assert.match(harness.root.innerHTML, /consent|соглас|同意/i);

    await harness.root.change("auth-consent", { checked: true });
    assert.equal(app.getState().auth.consent, true);
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
    preferences: resolvedDeferred("accepted"),
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
  await cancelled.root.change("auth-consent", { checked: true });
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
  await starts.root.change("auth-consent", { checked: true });
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
    preferences: resolvedDeferred("accepted"),
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
    preferences: resolvedDeferred("accepted"),
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
    preferences: resolvedDeferred("accepted"),
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
    preferences: resolvedDeferred("accepted"),
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

async function runTelegramBootstrapScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const authResponse = deferred();
  const sessionToken = "t".repeat(43);
  const user = telegramUser("mini-app-user", "Mini App Captain");
  const harness = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    miniAppResponse: () => authResponse.promise,
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });

  const app = bootSalvoApp(harness.dependencies);
  await waitFor(() => harness.fetchCalls.some(({ url }) => (
    url.endsWith("/auth/telegram/miniapp")
  )));
  assert.ok(harness.calls.networkSamples >= 1, "auth waits for the first runtime network sample");
  const authRequest = harness.fetchCalls.find(({ url }) => (
    url.endsWith("/auth/telegram/miniapp")
  ));
  assert.deepEqual(JSON.parse(authRequest.init.body), { initData: "signed-init-data" });
  assert.equal(harness.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/config")), false);

  authResponse.resolve({ token: sessionToken, user });
  await app.startup.authReady;
  assert.equal(app.getState().auth.user.id, user.id);
  assert.equal(app.getState().auth.token, sessionToken);
  assert.equal(harness.calls.secureSets, 1);
  assert.doesNotMatch(harness.root.innerHTML, /auth-telegram-oidc|telegram-login-slot/);
  await app.stop();
}

async function runTelegramLaunchRoutingScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const sessionToken = "l".repeat(43);
  const user = telegramUser("launch-user", "Launch Captain");
  const authResponse = deferred();
  const joinedRooms = [];
  const roomHarness = createAppHarness({
    platformName: "telegram",
    launchData: "signed-room-init-data",
    startParam: "room_ABCD",
    miniAppResponse: () => authResponse.promise,
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          joinedRooms.push(roomCode);
          return {
            roomCode,
            playerId: "p2",
            playerToken: "private-player-token",
            presetId: "classic",
          };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const roomApp = bootSalvoApp(roomHarness.dependencies);
  await waitFor(() => roomHarness.fetchCalls.some(({ url }) => (
    url.endsWith("/auth/telegram/miniapp")
  )));
  assert.equal(roomApp.getState().screen, "menu");
  assert.deepEqual(joinedRooms, []);

  authResponse.resolve({ token: sessionToken, user });
  await roomApp.startup.done;
  assert.equal(roomApp.getState().screen, "online");
  assert.equal(roomApp.getState().online.roomCodeInput, "ABCD");
  assert.deepEqual(joinedRooms, ["ABCD"]);
  assert.equal(roomApp.getState().online.session.roomCode, "ABCD");

  await roomHarness.root.click("auth-telegram-retry");
  assert.deepEqual(joinedRooms, ["ABCD"], "launch is not replayed after explicit authentication");

  const replayAuth = deferred();
  const replayHarness = createAppHarness({
    platformName: "telegram",
    launchData: "signed-replay-init-data",
    startParam: "replay_replay-123",
    miniAppResponse: () => replayAuth.promise,
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/replay-123")) {
        return response({ error: "Replay not found" }, { ok: false, status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const replayApp = bootSalvoApp(replayHarness.dependencies);
  await waitFor(() => replayHarness.fetchCalls.some(({ url }) => (
    url.endsWith("/auth/telegram/miniapp")
  )));
  assert.equal(
    replayHarness.fetchCalls.some(({ url }) => url.includes("/replays/")),
    false,
    "private replay must not load before authentication",
  );

  replayAuth.resolve({ token: sessionToken, user });
  await replayApp.startup.done;
  const replayRequest = replayHarness.fetchCalls.find(({ url }) => (
    url.endsWith("/replays/replay-123")
  ));
  assert.ok(replayRequest);
  assert.equal(replayRequest.init.headers.Authorization, `Bearer ${sessionToken}`);
  assert.equal(replayApp.getState().screen, "replay");
  assert.equal(replayApp.getState().replayArchive.requestedId, "replay-123");

  for (const startParam of [
    "room_abcd",
    `room_${"A".repeat(13)}`,
    "replay_bad_id",
    "replay_bad/id",
  ]) {
    let clientsCreated = 0;
    const invalid = createAppHarness({
      platformName: "telegram",
      launchData: "signed-invalid-init-data",
      startParam,
      createRemoteClient() {
        clientsCreated += 1;
        return remoteClientHarness();
      },
      fetchResponse(url) {
        if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
        if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
        throw new Error(`Unexpected fetch for ${startParam}: ${url}`);
      },
    });
    const invalidApp = bootSalvoApp(invalid.dependencies);
    await invalidApp.startup.done;
    assert.equal(invalidApp.getState().screen, "menu", startParam);
    assert.equal(clientsCreated, 0, startParam);
    assert.equal(invalid.fetchCalls.some(({ url }) => url.includes("/replays/")), false, startParam);
    await invalidApp.stop();
  }

  const roomUnavailableCopy = {
    ru: "Комната заполнена, закрыта или недоступна. Вернитесь в онлайн-лобби и выберите другую комнату.",
    "zh-CN": "此房间已满、已关闭或不可用。请返回在线大厅并尝试其他房间。",
  };
  const miniAppAccountCopy = {
    ru: "Аккаунт Telegram Mini App подтверждён. Ваш существующий профиль и онлайн-прогресс доступны.",
    "zh-CN": "Telegram Mini App 账号已确认。您可以继续使用现有档案和在线进度。",
  };
  for (const [language, failureMessage, expectedMessage] of [
    ["ru", "Room is full", roomUnavailableCopy.ru],
    ["zh-CN", "Room not found", roomUnavailableCopy["zh-CN"]],
    ["ru", "Room is closed", roomUnavailableCopy.ru],
    ["zh-CN", "Room is unavailable", roomUnavailableCopy["zh-CN"]],
    ["ru", "Room connection unavailable", "Room connection unavailable"],
  ]) {
    const failedJoin = createAppHarness({
      platformName: "telegram",
      launchData: "signed-failed-room-init-data",
      startParam: "room_ABCD",
      preferences: resolvedDeferred(language),
      createRemoteClient() {
        return remoteClientHarness({
          async joinRoom() {
            throw new Error(failureMessage);
          },
        });
      },
      fetchResponse(url) {
        if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
        if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });
    const failedJoinApp = bootSalvoApp(failedJoin.dependencies);
    await failedJoinApp.startup.done;
    assert.equal(failedJoinApp.getState().screen, "online", failureMessage);
    assert.equal(failedJoinApp.getState().language, language, failureMessage);
    assert.equal(failedJoinApp.getState().online.roomCodeInput, "ABCD", failureMessage);
    assert.equal(failedJoinApp.getState().online.session, null, failureMessage);
    assert.equal(failedJoinApp.getState().online.error, expectedMessage, failureMessage);
    assert.ok(failedJoin.root.innerHTML.includes(expectedMessage), failureMessage);
    assert.ok(failedJoin.root.innerHTML.includes(miniAppAccountCopy[language]), failureMessage);
    if (expectedMessage !== failureMessage) {
      assert.equal(failedJoin.root.innerHTML.includes(failureMessage), false, failureMessage);
    }
    await failedJoinApp.stop();
  }

  const webFailureMessage = "Room is full";
  const webFailure = createAppHarness({
    secureSession: resolvedDeferred("web-session-token"),
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom() {
          throw new Error(webFailureMessage);
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/auth/me")) {
        return response({ user: telegramUser("web-room-user", "Web Room Captain") });
      }
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const webFailureApp = bootSalvoApp(webFailure.dependencies);
  await webFailureApp.startup.done;
  await webFailure.root.click("show-online");
  await webFailure.root.change("room-code", { value: "ABCD" });
  await webFailure.root.click("online-join");
  assert.equal(webFailureApp.getState().online.error, webFailureMessage);
  assert.match(webFailure.root.innerHTML, /Telegram confirmed\. Online results are saved to your profile\./);
  assert.doesNotMatch(webFailure.root.innerHTML, /Telegram Mini App account confirmed/);
  await webFailureApp.stop();

  const guardedAuth = deferred();
  const guardedJoins = [];
  const guarded = createAppHarness({
    platformName: "telegram",
    launchData: "signed-guarded-init-data",
    startParam: "room_GUARD",
    miniAppResponse: () => guardedAuth.promise,
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          guardedJoins.push(roomCode);
          return { roomCode, playerId: "p2", playerToken: "private-token", presetId: "classic" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const guardedApp = bootSalvoApp(guarded.dependencies);
  await guarded.root.click("start-agent");
  guardedAuth.resolve({ token: sessionToken, user });
  await guardedApp.startup.done;
  assert.equal(guardedApp.getState().screen, "setup");
  assert.equal(guardedApp.getState().leaveBattleDialog, true);
  assert.deepEqual(guardedJoins, []);
  await guarded.root.click("confirm-leave-battle");
  assert.equal(guardedApp.getState().screen, "online");
  assert.deepEqual(guardedJoins, ["GUARD"]);

  await Promise.all([roomApp.stop(), replayApp.stop(), guardedApp.stop()]);
}

async function runTelegramLaunchRetryScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const sessionToken = "r".repeat(43);
  const user = telegramUser("retry-launch-user", "Retry Launch Captain");
  let roomAuthAttempts = 0;
  const joinedRooms = [];
  const room = createAppHarness({
    platformName: "telegram",
    launchData: "signed-room-retry-init-data",
    startParam: "room_RETRY",
    miniAppResponse() {
      roomAuthAttempts += 1;
      return roomAuthAttempts === 1
        ? miniAppServiceFailure()
        : { token: sessionToken, user };
    },
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          joinedRooms.push(roomCode);
          return { roomCode, playerId: "p2", playerToken: "private-token", presetId: "classic" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const roomApp = bootSalvoApp(room.dependencies);
  await roomApp.startup.done;
  assert.equal(roomApp.getState().screen, "menu");
  assert.deepEqual(joinedRooms, []);
  assert.equal(roomAuthAttempts, 1);

  await room.root.click("auth-telegram-retry");
  assert.equal(roomApp.getState().screen, "online");
  assert.equal(roomApp.getState().online.roomCodeInput, "RETRY");
  assert.deepEqual(joinedRooms, ["RETRY"]);
  assert.equal(roomAuthAttempts, 2);
  await room.root.click("theme-toggle");
  await room.root.click("auth-telegram-retry");
  assert.deepEqual(joinedRooms, ["RETRY"]);
  assert.equal(roomAuthAttempts, 2, "an authenticated retry is ignored");

  let replayAuthAttempts = 0;
  const replay = createAppHarness({
    platformName: "telegram",
    launchData: "signed-replay-retry-init-data",
    startParam: "replay_retry-replay",
    miniAppResponse() {
      replayAuthAttempts += 1;
      return replayAuthAttempts === 1
        ? miniAppServiceFailure()
        : { token: sessionToken, user };
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/retry-replay")) {
        return response({ error: "Replay not found" }, { ok: false, status: 404 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const replayApp = bootSalvoApp(replay.dependencies);
  await replayApp.startup.done;
  assert.equal(replayApp.getState().screen, "menu");
  assert.equal(replay.fetchCalls.some(({ url }) => url.includes("/replays/")), false);

  await replay.root.click("auth-telegram-retry");
  assert.equal(replayApp.getState().screen, "replay");
  assert.equal(replayApp.getState().replayArchive.requestedId, "retry-replay");
  assert.equal(replay.fetchCalls.filter(({ url }) => url.endsWith("/replays/retry-replay")).length, 1);
  await replay.root.click("theme-toggle");
  await replay.root.click("auth-telegram-retry");
  assert.equal(replayAuthAttempts, 2, "an authenticated retry is ignored");
  assert.equal(replay.fetchCalls.filter(({ url }) => url.endsWith("/replays/retry-replay")).length, 1);

  await Promise.all([roomApp.stop(), replayApp.stop()]);
}

async function runTelegramLaunchAuthorityScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const replayHarness = ({ initialReplayId, startParam, platformName = "telegram" }) => (
    createAppHarness({
      platformName,
      launchData: platformName === "telegram" ? "signed-authority-init-data" : "",
      startParam,
      initialUrl: `https://agent-axiom.github.io/agents-salvo/?replay=${initialReplayId}`,
      secureSession: platformName === "telegram" ? resolvedDeferred("") : resolvedDeferred("web-token"),
      fetchResponse(url) {
        if (url.endsWith("/auth/me")) {
          return response({ user: { id: "web-user", name: "Web Captain", username: "web" } });
        }
        if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
        if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
        if (url.includes("/replays/")) {
          return response({ error: "Replay not found" }, { ok: false, status: 404 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    })
  );
  const replayRequestIds = (harness) => harness.fetchCalls
    .filter(({ url }) => url.includes("/replays/"))
    .map(({ url }) => decodeURIComponent(url.split("/replays/")[1]));

  const same = replayHarness({
    initialReplayId: "same-replay",
    startParam: "replay_same-replay",
  });
  const sameApp = bootSalvoApp(same.dependencies);
  await sameApp.startup.done;
  assert.deepEqual(replayRequestIds(same), ["same-replay"]);
  assert.equal(sameApp.getState().replayArchive.requestedId, "same-replay");
  assert.equal(same.calls.historyPushes, 0);
  assert.equal(same.calls.historyReplacements, 0);

  const conflict = replayHarness({
    initialReplayId: "url-replay",
    startParam: "replay_start-replay",
  });
  const conflictApp = bootSalvoApp(conflict.dependencies);
  await conflictApp.startup.done;
  assert.deepEqual(replayRequestIds(conflict), ["start-replay"]);
  assert.equal(conflictApp.getState().replayArchive.requestedId, "start-replay");
  assert.equal(conflict.dependencies.window.location.search, "?replay=start-replay");
  assert.equal(conflict.calls.historyPushes, 0);
  assert.equal(conflict.calls.historyReplacements, 1);

  const invalid = replayHarness({
    initialReplayId: "url-replay",
    startParam: "replay_bad_id",
  });
  const invalidApp = bootSalvoApp(invalid.dependencies);
  await invalidApp.startup.done;
  assert.deepEqual(replayRequestIds(invalid), ["url-replay"]);
  assert.equal(invalidApp.getState().replayArchive.requestedId, "url-replay");
  assert.equal(invalid.calls.historyPushes, 0);
  assert.equal(invalid.calls.historyReplacements, 0);

  const web = replayHarness({
    initialReplayId: "web-replay",
    startParam: "replay_ignored-in-web",
    platformName: "web",
  });
  const webApp = bootSalvoApp(web.dependencies);
  await webApp.startup.done;
  assert.deepEqual(replayRequestIds(web), ["web-replay"]);
  assert.equal(webApp.getState().replayArchive.requestedId, "web-replay");

  await Promise.all([sameApp.stop(), conflictApp.stop(), invalidApp.stop(), webApp.stop()]);
}

async function runTelegramLaunchSharingScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const telegram = createAppHarness({
    platformName: "telegram",
    launchData: "signed-room-init-data",
    startParam: "room_ABCD",
    shareResult: { shared: true },
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          return { roomCode, playerId: "p2", playerToken: "private-token", presetId: "classic" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const telegramApp = bootSalvoApp(telegram.dependencies);
  await telegramApp.startup.done;
  await telegram.root.click("share-telegram");
  assert.equal(telegram.calls.sharePayloads.length, 1);
  assert.deepEqual(telegram.calls.sharePayloads[0], {
    title: "Salvo",
    text: "Join my Salvo room: ABCD",
    url: "https://t.me/salvo_test_bot?startapp=room_ABCD",
  });
  assert.equal(telegramApp.getState().online.status, "");
  assert.doesNotMatch(telegram.root.innerHTML, /invite link copied/i);

  const telegramReplay = createAppHarness({
    platformName: "telegram",
    launchData: "signed-replay-share-init-data",
    startParam: "replay_replay-123",
    shareResult: { shared: true },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/replay-123")) {
        return response({ replay: archivedReplayFixture("replay-123") });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const telegramReplayApp = bootSalvoApp(telegramReplay.dependencies);
  await telegramReplayApp.startup.done;
  assert.match(telegramReplay.root.innerHTML, />Share in Telegram<\/button>/);
  assert.doesNotMatch(telegramReplay.root.innerHTML, />Copy link<\/button>/);
  await telegramReplay.root.click("replay-copy-link");
  assert.equal(telegramReplay.calls.sharePayloads.length, 1);
  assert.equal(
    telegramReplay.calls.sharePayloads[0].url,
    "https://t.me/salvo_test_bot?startapp=replay_replay-123",
  );
  assert.equal(telegramReplay.calls.sharePayloads[0].text, "Battle replay");
  assert.equal(telegramReplayApp.getState().replayArchive.copyStatus, "");
  assert.doesNotMatch(telegramReplay.root.innerHTML, /Replay link copied/);

  const copiedTelegramReplay = createAppHarness({
    platformName: "telegram",
    launchData: "signed-copied-replay-share-init-data",
    startParam: "replay_replay-copied",
    shareResult: { shared: false, copied: true },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/replay-copied")) {
        return response({ replay: archivedReplayFixture("replay-copied") });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const copiedTelegramReplayApp = bootSalvoApp(copiedTelegramReplay.dependencies);
  await copiedTelegramReplayApp.startup.done;
  await copiedTelegramReplay.root.click("replay-copy-link");
  assert.equal(copiedTelegramReplayApp.getState().replayArchive.copyStatus, "copied");
  assert.match(copiedTelegramReplay.root.innerHTML, /Replay link copied/);
  assert.doesNotMatch(copiedTelegramReplay.root.innerHTML, /Could not share/);

  const failedTelegramReplay = createAppHarness({
    platformName: "telegram",
    launchData: "signed-failed-replay-share-init-data",
    startParam: "replay_replay-456",
    shareResult: { shared: false },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/replay-456")) {
        return response({ replay: archivedReplayFixture("replay-456") });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const failedTelegramReplayApp = bootSalvoApp(failedTelegramReplay.dependencies);
  await failedTelegramReplayApp.startup.done;
  assert.match(failedTelegramReplay.root.innerHTML, />Share in Telegram<\/button>/);
  await failedTelegramReplay.root.click("replay-copy-link");
  assert.equal(failedTelegramReplayApp.getState().replayArchive.copyStatus, "error");
  assert.match(failedTelegramReplay.root.innerHTML, /Could not share\./);
  assert.doesNotMatch(failedTelegramReplay.root.innerHTML, /Could not copy the replay link/);

  const failed = createAppHarness({
    platformName: "telegram",
    launchData: "signed-room-init-data",
    startParam: "room_ABCD",
    shareResult: { shared: false },
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          return { roomCode, playerId: "p2", playerToken: "private-token", presetId: "classic" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const failedApp = bootSalvoApp(failed.dependencies);
  await failedApp.startup.done;
  await failed.root.click("share-telegram");
  assert.equal(failedApp.getState().online.error, "");
  assert.equal(failedApp.getState().online.shareStatus, "share-failed");
  assert.match(failed.root.innerHTML, /Could not share\./);
  assert.deepEqual(failed.calls.openedUrls, [], "failed Telegram sharing must remain failed");

  const copiedRoom = createAppHarness({
    platformName: "telegram",
    launchData: "signed-copied-room-share-init-data",
    startParam: "room_COPY",
    shareResult: { shared: false, copied: true },
    createRemoteClient() {
      return remoteClientHarness({
        async joinRoom(roomCode) {
          return { roomCode, playerId: "p2", playerToken: "private-token", presetId: "classic" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const copiedRoomApp = bootSalvoApp(copiedRoom.dependencies);
  await copiedRoomApp.startup.done;
  await copiedRoom.root.click("share-telegram");
  assert.equal(copiedRoomApp.getState().online.status, "");
  assert.equal(copiedRoomApp.getState().online.shareStatus, "invite-copied");
  assert.equal(copiedRoomApp.getState().online.error, "");
  assert.match(copiedRoom.root.innerHTML, /Room invite link copied/);
  assert.doesNotMatch(copiedRoom.root.innerHTML, /Could not share/);

  const web = createAppHarness({
    secureSession: resolvedDeferred("web-session-token"),
    shareResult: { shared: true },
    createRemoteClient() {
      return remoteClientHarness({
        async createRoom() {
          return { roomCode: "WEB1", playerId: "p1", playerToken: "private-token" };
        },
      });
    },
    fetchResponse(url) {
      if (url.endsWith("/auth/me")) {
        return response({ user: { id: "web-user", name: "Web Captain", username: "web" } });
      }
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const webApp = bootSalvoApp(web.dependencies);
  await webApp.startup.done;
  await web.root.click("show-online");
  await web.root.click("online-create");
  await web.root.click("share-telegram");
  assert.equal(web.calls.sharePayloads[0].url, "https://agent-axiom.github.io/agents-salvo/");

  const webReplay = createAppHarness({
    initialUrl: "https://agent-axiom.github.io/agents-salvo/?replay=replay-789",
    secureSession: resolvedDeferred("web-session-token"),
    fetchResponse(url) {
      if (url.endsWith("/auth/me")) {
        return response({ user: { id: "web-user", name: "Web Captain", username: "web" } });
      }
      if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
      if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
      if (url.endsWith("/replays/replay-789")) {
        return response({ replay: archivedReplayFixture("replay-789") });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  });
  const webReplayApp = bootSalvoApp(webReplay.dependencies);
  await webReplayApp.startup.done;
  assert.match(webReplay.root.innerHTML, />Copy link<\/button>/);
  assert.doesNotMatch(webReplay.root.innerHTML, />Share in Telegram<\/button>/);
  await webReplay.root.click("replay-copy-link");
  assert.equal(
    webReplay.calls.clipboardWrites.at(-1),
    "https://agent-axiom.github.io/agents-salvo/?replay=replay-789",
  );
  assert.equal(webReplayApp.getState().replayArchive.copyStatus, "copied");
  assert.match(webReplay.root.innerHTML, /Replay link copied/);

  await Promise.all([
    telegramApp.stop(),
    telegramReplayApp.stop(),
    copiedTelegramReplayApp.stop(),
    failedTelegramReplayApp.stop(),
    failedApp.stop(),
    copiedRoomApp.stop(),
    webApp.stop(),
    webReplayApp.stop(),
  ]);
}

async function runTelegramShareStatusRaceScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  for (const [name, roomCode, outcome, expectedShareStatus, feedbackPattern, feedbackRole] of [
    ["copied", "COPY", { shared: false, copied: true }, "invite-copied", /Room invite link copied/, "status"],
    ["failed", "FAIL", { shared: false, copied: false }, "share-failed", /Could not share\./, "alert"],
  ]) {
    const shareResult = deferred();
    let remoteHandlers = null;
    const harness = createAppHarness({
      platformName: "telegram",
      launchData: `signed-${name}-share-race-init-data`,
      startParam: `room_${roomCode}`,
      shareResult: shareResult.promise,
      createRemoteClient(handlers) {
        remoteHandlers = handlers;
        return remoteClientHarness({
          async joinRoom(joinedRoomCode) {
            return {
              roomCode: joinedRoomCode,
              playerId: "p2",
              playerToken: "private-token",
              presetId: "classic",
            };
          },
        });
      },
      fetchResponse(url) {
        if (url.endsWith("/profile/me")) return response({ profile: { leaderboard: [] } });
        if (url.endsWith("/leaderboard")) return response({ leaderboard: [] });
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });
    const app = bootSalvoApp(harness.dependencies);
    await app.startup.done;
    assert.ok(remoteHandlers, name);

    const sharing = harness.root.click("share-telegram");
    await waitFor(() => harness.calls.sharePayloads.length === 1);
    remoteHandlers.onStatus("disconnected");
    remoteHandlers.onError(new Error("connection failed"));
    assert.equal(app.getState().online.status, "disconnected", name);
    assert.equal(app.getState().online.error, "connection failed", name);

    shareResult.resolve(outcome);
    await sharing;
    assert.equal(app.getState().online.status, "disconnected", name);
    assert.equal(app.getState().online.error, "connection failed", name);
    assert.equal(app.getState().online.shareStatus, expectedShareStatus, name);
    assert.match(harness.root.innerHTML, /Disconnected/, name);
    assert.match(harness.root.innerHTML, /connection failed/, name);
    assert.match(harness.root.innerHTML, feedbackPattern, name);
    assert.match(
      harness.root.innerHTML,
      new RegExp(`class="status-line online-share-status[^"]*" role="${feedbackRole}"`),
      name,
    );

    await app.stop();
  }
}

async function runTelegramAuthRecoveryScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  for (const [name, options] of [
    ["missing SDK", { platformAvailable: false, launchData: "signed-init-data" }],
    ["missing initData", { platformAvailable: true, launchData: "" }],
    ["missing client", { platformAvailable: true, launchData: "signed-init-data", workerUrl: "" }],
  ]) {
    const harness = createAppHarness({
      platformName: "telegram",
      ...options,
    });
    const app = bootSalvoApp(harness.dependencies);
    await app.startup.done;
    assert.equal(app.getState().auth.method, "miniapp-unavailable", name);
    assert.equal(app.getState().auth.token, "", name);
    assert.equal(app.getState().auth.user, null, name);
    assert.match(harness.root.innerHTML, /Open Salvo in Telegram to sign in/, name);
    assert.match(harness.root.innerHTML, /data-action="auth-miniapp-open"/, name);
    assert.doesNotMatch(harness.root.innerHTML, /data-action="auth-telegram-retry"/, name);
    await harness.root.click("auth-miniapp-open");
    assert.deepEqual(harness.calls.openedUrls, ["https://t.me/salvo_test_bot?startapp"], name);
    assert.equal(
      harness.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/miniapp")),
      false,
      name,
    );
    assert.doesNotMatch(harness.root.innerHTML, /data-action="start-agent"[^>]*disabled/, name);
    assert.doesNotMatch(harness.root.innerHTML, /data-action="start-hotseat"[^>]*disabled/, name);
    assert.doesNotMatch(harness.root.innerHTML, /data-action="start-training"[^>]*disabled/, name);
    assert.doesNotMatch(harness.root.innerHTML, /data-action="toggle-profile"/, name);
    await harness.root.click("show-online");
    assert.match(harness.root.innerHTML, /data-action="online-create"[^>]*disabled/, name);
    assert.match(harness.root.innerHTML, /data-action="online-join"[^>]*disabled/, name);
    await app.stop();
  }

  const invalidBot = createAppHarness({
    platformName: "telegram",
    platformAvailable: false,
    telegramBotUsername: "bad/name",
  });
  const invalidBotApp = bootSalvoApp(invalidBot.dependencies);
  await invalidBotApp.startup.done;
  assert.match(invalidBot.root.innerHTML, /Open Salvo in Telegram to sign in/);
  assert.doesNotMatch(invalidBot.root.innerHTML, /auth-miniapp-open|https:\/\/t\.me/);
  assert.deepEqual(invalidBot.calls.openedUrls, []);

  const authenticationFailure = { error: "Telegram Mini App authentication failed" };
  const expiredApps = [];
  for (const [name, launchData] of [
    ["stale initData", "stale-init-data"],
    ["tampered initData", "tampered-init-data"],
  ]) {
    const expired = createAppHarness({
      platformName: "telegram",
      launchData,
      miniAppResponse: new Response(JSON.stringify(authenticationFailure), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const expiredApp = bootSalvoApp(expired.dependencies);
    expiredApps.push(expiredApp);
    await expiredApp.startup.done;
    assert.equal(expiredApp.getState().auth.method, "miniapp-expired", name);
    assert.equal(expiredApp.getState().auth.token, "", name);
    assert.equal(expiredApp.getState().auth.user, null, name);
    assert.match(expired.root.innerHTML, /Telegram Mini App session expired/, name);
    assert.doesNotMatch(expired.root.innerHTML, /authentication failed|auth-telegram-retry/, name);
    assert.match(expired.root.innerHTML, /data-action="auth-miniapp-reopen"/, name);
    await expired.root.click("auth-miniapp-reopen");
    assert.deepEqual(expired.calls.openedUrls, ["https://t.me/salvo_test_bot?startapp"], name);
  }

  for (const [name, startParam, expectedUrl] of [
    ["room launch", "room_REOPEN", "https://t.me/salvo_test_bot?startapp=room_REOPEN"],
    ["replay launch", "replay_reopen-123", "https://t.me/salvo_test_bot?startapp=replay_reopen-123"],
    ["invalid launch", "room_reopen", "https://t.me/salvo_test_bot?startapp"],
  ]) {
    const expired = createAppHarness({
      platformName: "telegram",
      launchData: `expired-${name}`,
      startParam,
      miniAppResponse: new Response(JSON.stringify(authenticationFailure), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const expiredApp = bootSalvoApp(expired.dependencies);
    expiredApps.push(expiredApp);
    await expiredApp.startup.done;
    assert.equal(expiredApp.getState().auth.method, "miniapp-expired", name);
    await expired.root.click("auth-miniapp-reopen");
    assert.deepEqual(expired.calls.openedUrls, [expectedUrl], name);
  }

  const serviceFailureApps = [];
  for (const name of ["Worker configuration failure", "D1 session failure"]) {
    const serviceFailure = createAppHarness({
      platformName: "telegram",
      launchData: "signed-init-data",
      miniAppResponse: new Response(JSON.stringify(authenticationFailure), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const serviceFailureApp = bootSalvoApp(serviceFailure.dependencies);
    serviceFailureApps.push(serviceFailureApp);
    await serviceFailureApp.startup.done;
    assert.equal(serviceFailureApp.getState().auth.method, "miniapp", name);
    assert.equal(serviceFailureApp.getState().auth.token, "", name);
    assert.equal(serviceFailureApp.getState().auth.user, null, name);
    assert.match(serviceFailure.root.innerHTML, /Telegram login is unavailable/, name);
    assert.doesNotMatch(serviceFailure.root.innerHTML, /authentication failed|auth-miniapp-reopen/, name);
    assert.match(serviceFailure.root.innerHTML, /data-action="auth-telegram-retry"/, name);
    assert.doesNotMatch(serviceFailure.root.innerHTML, /data-action="start-agent"[^>]*disabled/, name);
    assert.doesNotMatch(serviceFailure.root.innerHTML, /data-action="start-hotseat"[^>]*disabled/, name);
    assert.doesNotMatch(serviceFailure.root.innerHTML, /data-action="start-training"[^>]*disabled/, name);
    await serviceFailure.root.click("show-online");
    assert.match(serviceFailure.root.innerHTML, /data-action="online-create"[^>]*disabled/, name);
    assert.match(serviceFailure.root.innerHTML, /data-action="online-join"[^>]*disabled/, name);
  }

  let attempts = 0;
  const retryToken = "r".repeat(43);
  const retry = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    miniAppResponse() {
      attempts += 1;
      if (attempts === 1) return new Error("private provider detail");
      return { token: retryToken, user: telegramUser("retry-user", "Retry Captain") };
    },
  });
  const retryApp = bootSalvoApp(retry.dependencies);
  await retryApp.startup.done;
  assert.equal(retryApp.getState().auth.method, "miniapp");
  assert.equal(retryApp.getState().auth.token, "");
  assert.equal(retryApp.getState().auth.user, null);
  assert.match(retry.root.innerHTML, /Telegram login is unavailable/);
  assert.doesNotMatch(retry.root.innerHTML, /private provider detail/);
  assert.match(retry.root.innerHTML, /data-action="auth-telegram-retry"/);

  await retry.root.click("auth-telegram-retry");
  assert.equal(attempts, 2);
  assert.equal(retryApp.getState().auth.token, retryToken);
  assert.equal(retryApp.getState().auth.user.id, "retry-user");
  assert.equal(retry.calls.secureSets, 1);

  await retry.root.click("auth-logout");
  await flushMicrotasks();
  assert.equal(attempts, 2, "logout must not trigger an automatic reauth loop");
  assert.equal(retryApp.getState().auth.token, "");
  assert.equal(retryApp.getState().auth.user, null);
  await retry.root.click("auth-telegram-retry");
  assert.equal(attempts, 3, "an explicit retry may authenticate after logout");
  assert.equal(retryApp.getState().auth.token, retryToken);

  const staleResponse = deferred();
  const stale = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    miniAppResponse: () => staleResponse.promise,
  });
  const staleApp = bootSalvoApp(stale.dependencies);
  await waitFor(() => stale.fetchCalls.some(({ url }) => url.endsWith("/auth/telegram/miniapp")));
  await stale.root.click("auth-logout");
  staleResponse.resolve({
    token: "s".repeat(43),
    user: telegramUser("stale-user", "Stale Captain"),
  });
  await staleApp.startup.done;
  assert.equal(staleApp.getState().auth.token, "");
  assert.equal(staleApp.getState().auth.user, null);
  assert.equal(stale.calls.secureSets, 0);

  const persistence = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    miniAppResponse: {
      token: "p".repeat(43),
      user: telegramUser("storage-user", "Storage Captain"),
    },
    onSecureSet: async () => Promise.reject(new Error("memory write failed")),
  });
  const persistenceApp = bootSalvoApp(persistence.dependencies);
  await persistenceApp.startup.done;
  assert.equal(persistenceApp.getState().auth.token, "");
  assert.equal(persistenceApp.getState().auth.user, null);
  assert.match(persistence.root.innerHTML, /Secure login could not be saved/);
  assert.doesNotMatch(persistence.root.innerHTML, /memory write failed/);

  await Promise.all([
    invalidBotApp.stop(),
    ...expiredApps.map((app) => app.stop()),
    ...serviceFailureApps.map((app) => app.stop()),
    retryApp.stop(),
    staleApp.stop(),
    persistenceApp.stop(),
  ]);
}

async function runTelegramRuntimeScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const harness = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
  });
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;

  assert.equal(harness.calls.ready, 1);
  assert.deepEqual(harness.calls.backButtonVisibility, [false]);
  assert.deepEqual(harness.activePlatformHandlers(), {
    back: true,
    deepLink: true,
    lifecycle: true,
    network: true,
    settings: true,
    theme: true,
    viewport: true,
  });
  assert.equal(harness.calls.closingConfirmations.at(-1), false);

  await harness.emitSettings();
  assert.equal(app.getState().settingsOpen, true);
  assert.equal(harness.calls.backButtonVisibility.at(-1), true);
  await harness.emitBack();
  assert.equal(app.getState().settingsOpen, false);
  assert.equal(harness.calls.backButtonVisibility.at(-1), false);

  await harness.root.click("start-agent");
  assert.equal(harness.calls.backButtonVisibility.at(-1), true);
  assert.equal(harness.calls.closingConfirmations.at(-1), true);
  await harness.root.click("toggle-leaderboard");
  await harness.root.click("menu");
  assert.equal(app.getState().leaveBattleDialog, true);
  assert.equal(app.getState().leaderboardOpen, true);

  await harness.emitBack();
  assert.equal(app.getState().leaveBattleDialog, false, "active leave dialog closes first");
  assert.equal(app.getState().leaderboardOpen, true, "overlapped leaderboard remains open");
  await harness.emitBack();
  assert.equal(app.getState().leaderboardOpen, false);

  await harness.root.click("ready");
  assert.equal(app.getState().screen, "playing");
  await harness.root.click("menu");
  assert.equal(app.getState().leaveBattleDialog, true);
  app.getState().game.phase = "finished";
  app.getState().game.winnerId = "p1";
  await harness.root.click("toggle-settings");
  assert.match(harness.root.innerHTML, /data-action="close-result"/);
  assert.equal(app.getState().settingsOpen, true);

  await harness.emitBack();
  assert.equal(app.getState().leaveBattleDialog, false, "leave dialog closes before result");
  assert.equal(app.getState().resultModalDismissed, null, "overlapped result remains open");
  assert.equal(app.getState().settingsOpen, true, "overlapped settings remain open");
  await harness.emitBack();
  assert.notEqual(app.getState().resultModalDismissed, null, "result closes before settings");
  assert.equal(app.getState().settingsOpen, true, "overlapped settings remain open");
  await harness.emitBack();
  assert.equal(app.getState().settingsOpen, false);

  assert.equal(app.getState().tacticalAdvisorOpen, true);
  await harness.emitBack();
  assert.equal(app.getState().tacticalAdvisorOpen, false, "visible tactical coaching collapses");
  assert.equal(app.getState().screen, "playing");
  await harness.emitBack();
  assert.equal(app.getState().screen, "menu");
  assert.equal(harness.calls.backButtonVisibility.at(-1), false);
  assert.equal(harness.calls.closingConfirmations.at(-1), false);

  await harness.emitLifecycle({ active: false });
  await harness.emitLifecycle({ active: true });
  assert.equal(harness.calls.audioPauses, 1);
  assert.equal(harness.calls.audioResumes, 1);

  await harness.root.click("toggle-settings");
  await harness.root.click("toggle-settings");
  assert.equal(harness.calls.ready, 1, "rerenders must not repeat platform.ready()");

  await app.stop();
  assert.deepEqual(harness.activePlatformHandlers(), {
    back: false,
    deepLink: false,
    lifecycle: false,
    network: false,
    settings: false,
    theme: false,
    viewport: false,
  });

  let visibilityAttempts = 0;
  const retryVisibility = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    onSetBackButtonVisible: async () => {
      visibilityAttempts += 1;
      if (visibilityAttempts === 1) {
        throw new Error("Telegram button visibility update failed");
      }
    },
  });
  const retryVisibilityApp = bootSalvoApp(retryVisibility.dependencies);
  await retryVisibilityApp.startup.done;
  await flushMicrotasks();
  await retryVisibility.root.click("theme-toggle");
  await flushMicrotasks();
  assert.deepEqual(retryVisibility.calls.backButtonVisibility, [false, false]);
  assert.doesNotMatch(retryVisibility.root.innerHTML, /provider|visibility update failed/);
  await retryVisibilityApp.stop();

  const releaseEnable = deferred();
  const providerClosingStates = [];
  const serializedClosing = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    onSetClosingConfirmation: async (enabled) => {
      if (enabled) await releaseEnable.promise;
      providerClosingStates.push(enabled);
    },
  });
  const serializedClosingApp = bootSalvoApp(serializedClosing.dependencies);
  await serializedClosingApp.startup.done;
  await flushMicrotasks();
  assert.deepEqual(providerClosingStates, [false]);

  await serializedClosing.root.click("start-agent");
  await serializedClosing.root.click("ready");
  await flushMicrotasks();
  assert.deepEqual(serializedClosing.calls.closingConfirmations, [false, true]);
  serializedClosingApp.getState().game.phase = "finished";
  serializedClosingApp.getState().game.winnerId = "p1";
  await serializedClosing.root.click("menu");
  assert.equal(serializedClosingApp.getState().screen, "menu");
  assert.deepEqual(
    serializedClosing.calls.closingConfirmations,
    [false, true],
    "disable waits for the in-flight enable",
  );

  releaseEnable.resolve();
  await flushMicrotasks();
  assert.deepEqual(serializedClosing.calls.closingConfirmations, [false, true, false]);
  assert.deepEqual(providerClosingStates, [false, true, false]);
  await serializedClosingApp.stop();

  const rejectStaleEnable = deferred();
  const changedDuringFailure = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    onSetClosingConfirmation: async (enabled) => {
      if (enabled) await rejectStaleEnable.promise;
    },
  });
  const changedDuringFailureApp = bootSalvoApp(changedDuringFailure.dependencies);
  await changedDuringFailureApp.startup.done;
  await changedDuringFailure.root.click("start-agent");
  await changedDuringFailure.root.click("ready");
  await flushMicrotasks();
  assert.deepEqual(changedDuringFailure.calls.closingConfirmations, [false, true]);

  changedDuringFailureApp.getState().game.phase = "finished";
  changedDuringFailureApp.getState().game.winnerId = "p1";
  await changedDuringFailure.root.click("menu");
  assert.deepEqual(changedDuringFailure.calls.closingConfirmations, [false, true]);

  rejectStaleEnable.reject(new Error("private stale closing-confirmation detail"));
  await flushMicrotasks();
  assert.deepEqual(
    changedDuringFailure.calls.closingConfirmations,
    [false, true, false],
    "a newer desired state drains after the stale operation rejects",
  );
  await changedDuringFailureApp.stop();

  let enableAttempts = 0;
  const retryClosing = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    onSetClosingConfirmation: async (enabled) => {
      if (!enabled) return;
      enableAttempts += 1;
      if (enableAttempts === 1) {
        throw new Error("private closing-confirmation provider detail");
      }
    },
  });
  const retryClosingApp = bootSalvoApp(retryClosing.dependencies);
  await retryClosingApp.startup.done;
  await retryClosing.root.click("start-agent");
  await flushMicrotasks();
  assert.equal(enableAttempts, 1);
  await flushMicrotasks();
  assert.equal(enableAttempts, 1, "rejection must not spin an immediate retry");

  await retryClosing.root.click("theme-toggle");
  await flushMicrotasks();
  assert.equal(enableAttempts, 2, "a later render retries the unapplied state");
  assert.deepEqual(retryClosing.calls.closingConfirmations, [false, true, true]);
  await retryClosingApp.stop();
}

async function runHapticRuntimeScenario() {
  const hapticFailure = new Error("private haptic provider detail");
  const runtimeErrors = [];
  const harness = createAppHarness({
    native: true,
    onHaptic: async () => {
      throw hapticFailure;
    },
  });
  const { bootSalvoApp } = await import("../src/app.js");
  const originalConsoleError = console.error;
  let app = null;
  console.error = (...args) => runtimeErrors.push(args);

  try {
    app = bootSalvoApp(harness.dependencies);
    await app.startup.done;
    assert.equal(app.getState().hapticsEnabled, true);

    await harness.root.click("start-agent");
    await harness.root.click("reset");
    assert.equal(app.getState().setupBoard.ships.length, 0);
    const rendersBeforePlacement = harness.root.renderCount;

    await assert.doesNotReject(() => (
      harness.root.click("setup-cell", { row: "0", col: "0" })
    ));
    await flushMicrotasks();

    assert.deepEqual(harness.calls.haptics, ["placement"]);
    assert.equal(app.getState().setupBoard.ships.length, 1);
    assert.equal(app.getState().setupError, "");
    assert.equal(harness.root.renderCount, rendersBeforePlacement + 1);
    assert.equal(runtimeErrors.length, 1);
    assert.equal(runtimeErrors[0][0], "Salvo mobile runtime error");
    assert.equal(runtimeErrors[0][1], hapticFailure);
    assert.doesNotMatch(harness.root.innerHTML, /private haptic provider detail/);
  } finally {
    console.error = originalConsoleError;
    if (app) await app.stop();
  }
}

async function runTelegramThemeBuildScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const inherited = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    platformTheme: "dark",
  });
  const inheritedApp = bootSalvoApp(inherited.dependencies);
  assert.equal(inheritedApp.getState().theme, "dark");
  await inheritedApp.startup.done;
  await inherited.emitTheme("light");
  assert.equal(inheritedApp.getState().theme, "light");

  const stored = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    platformTheme: "light",
    preferences: resolvedDeferred("dark"),
  });
  const storedApp = bootSalvoApp(stored.dependencies);
  await storedApp.startup.done;
  assert.equal(storedApp.getState().theme, "dark");
  await stored.emitTheme("light");
  assert.equal(storedApp.getState().theme, "dark", "stored theme overrides Telegram events");

  const selected = createAppHarness({
    platformName: "telegram",
    launchData: "signed-init-data",
    platformTheme: "dark",
  });
  const selectedApp = bootSalvoApp(selected.dependencies);
  await selectedApp.startup.done;
  await selected.root.click("theme-toggle");
  assert.equal(selectedApp.getState().theme, "light");
  await selected.emitTheme("dark");
  assert.equal(selectedApp.getState().theme, "light", "user-selected theme remains authoritative");

  for (const [platformName, native] of [
    ["web", false],
    ["android", true],
    ["telegram", false],
  ]) {
    const runtime = createAppHarness({
      native,
      platformName,
      launchData: platformName === "telegram" ? "signed-init-data" : "",
      buildId: "build_2026.07.17",
    });
    const runtimeApp = bootSalvoApp(runtime.dependencies);
    assert.match(runtime.root.innerHTML, /settings-build-id[^>]*>Build: build_2026\.07\.17</);
    await runtimeApp.startup.done;
    await runtimeApp.stop();
  }

  const unsafe = createAppHarness({ buildId: '<img src=x onerror="alert(1)">' });
  const unsafeApp = bootSalvoApp(unsafe.dependencies);
  assert.match(unsafe.root.innerHTML, /settings-build-id[^>]*>Build: dev</);
  assert.doesNotMatch(unsafe.root.innerHTML, /src=x|onerror|alert\(1\)/);
  await unsafeApp.startup.done;

  await Promise.all([
    inheritedApp.stop(),
    storedApp.stop(),
    selectedApp.stop(),
    unsafeApp.stop(),
  ]);
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
    preferences: resolvedDeferred("accepted"),
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
  launchData = "",
  startParam = "",
  platformAvailable = Boolean(launchData),
  platformTheme = null,
  workerUrl = "https://worker.example.test",
  telegramBotUsername = "salvo_test_bot",
  buildId,
  initialUrl = "https://agent-axiom.github.io/agents-salvo/",
  capability = { method: "oidc" },
  startResponse = { authorizationUrl: "https://oauth.telegram.org/auth?state=default" },
  redeemResponse = {
    token: "default-redeemed-token",
    user: telegramUser("default-user", "Default Captain"),
  },
  miniAppResponse = {
    token: "m".repeat(43),
    user: telegramUser("mini-app-default", "Mini App Captain"),
  },
  onSecureClear = () => Promise.resolve(),
  onSecureSet = () => Promise.resolve(),
  onOpenExternalUrl = () => Promise.resolve(),
  onCloseExternalUrl = () => Promise.resolve(),
  onSetBackButtonVisible = () => Promise.resolve(),
  onSetClosingConfirmation = () => Promise.resolve(),
  onHaptic = () => Promise.resolve(),
  onSettingWrite = () => Promise.resolve(),
  shareResult = { shared: false },
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
    sharePayloads: [],
    clipboardWrites: [],
    openedUrls: [],
    closedUrls: 0,
    historyPushes: 0,
    historyReplacements: 0,
    settingWrites: [],
    ready: 0,
    backButtonVisibility: [],
    closingConfirmations: [],
    haptics: [],
    audioPauses: 0,
    audioResumes: 0,
  };
  void preferences.promise.then(() => {
    calls.preferencesSettled = true;
  });
  const fetchCalls = [];
  let lifecycleHandler = null;
  let deepLinkHandler = null;
  let networkHandler = null;
  let backHandler = null;
  let settingsHandler = null;
  let themeHandler = null;
  let viewportHandler = null;
  let currentPlatformTheme = platformTheme;
  const platform = {
    isNative: () => native,
    getPlatform: () => platformName,
    isAvailable: () => platformAvailable,
    getLaunchData: () => launchData,
    getStartParam: () => startParam,
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
    async onBack(handler) {
      backHandler = handler;
      return async () => {
        if (backHandler === handler) backHandler = null;
      };
    },
    async onLifecycleChange(handler) {
      lifecycleHandler = handler;
      return async () => {
        if (lifecycleHandler === handler) lifecycleHandler = null;
      };
    },
    async onSettings(handler) {
      settingsHandler = handler;
      return async () => {
        if (settingsHandler === handler) settingsHandler = null;
      };
    },
    getTheme: () => currentPlatformTheme,
    async onThemeChange(handler) {
      themeHandler = handler;
      return async () => {
        if (themeHandler === handler) themeHandler = null;
      };
    },
    async onViewportChange(handler) {
      viewportHandler = handler;
      return async () => {
        if (viewportHandler === handler) viewportHandler = null;
      };
    },
    async ready() {
      calls.ready += 1;
    },
    async setBackButtonVisible(enabled) {
      calls.backButtonVisibility.push(Boolean(enabled));
      await onSetBackButtonVisible(Boolean(enabled));
    },
    async setClosingConfirmation(enabled) {
      calls.closingConfirmations.push(Boolean(enabled));
      await onSetClosingConfirmation(Boolean(enabled));
    },
    async haptic(event) {
      calls.haptics.push(event);
      await onHaptic(event);
    },
    async share(payload) {
      calls.sharePayloads.push(payload);
      return shareResult;
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
  const window = createWindowHarness({
    initialUrl,
    workerUrl,
    telegramBotUsername,
    buildId,
    calls,
  });
  const navigator = {
    onLine: true,
    clipboard: {
      async writeText(value) {
        calls.clipboardWrites.push(value);
      },
    },
  };
  const audio = {
    async startMusic() {},
    stopMusic() {},
    async play() {},
    async pauseForLifecycle() {
      calls.audioPauses += 1;
    },
    async resumeForLifecycle() {
      calls.audioResumes += 1;
    },
  };

  return {
    calls,
    document,
    activePlatformHandlers() {
      return {
        back: Boolean(backHandler),
        deepLink: Boolean(deepLinkHandler),
        lifecycle: Boolean(lifecycleHandler),
        network: Boolean(networkHandler),
        settings: Boolean(settingsHandler),
        theme: Boolean(themeHandler),
        viewport: Boolean(viewportHandler),
      };
    },
    emitBack() {
      assert.ok(backHandler, "Back handler is not registered");
      return backHandler();
    },
    emitSettings() {
      assert.ok(settingsHandler, "Settings handler is not registered");
      return settingsHandler();
    },
    emitTheme(theme) {
      currentPlatformTheme = theme;
      assert.ok(themeHandler, "Theme handler is not registered");
      return themeHandler(theme);
    },
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
        if (url.endsWith("/auth/telegram/miniapp")) {
          return clientResult(miniAppResponse);
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
  let renderCount = 0;
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
    get renderCount() {
      return renderCount;
    },
    get competingDialogControl() {
      return competingDialogControl;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      renderCount += 1;
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
    async change(action, values = {}) {
      const target = makeActionElement(action);
      Object.assign(target, values);
      const event = { target };
      await Promise.all((listeners.get("change") ?? []).map((listener) => listener(event)));
    },
  };
  return root;
}

function createWindowHarness({
  initialUrl = "https://agent-axiom.github.io/agents-salvo/",
  workerUrl = "https://worker.example.test",
  telegramBotUsername = "salvo_test_bot",
  buildId,
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
      telegramBotUsername,
      ...(buildId === undefined ? {} : { buildId }),
    },
    location,
    history: {
      state: null,
      pushState(_state, _title, url) {
        if (calls) calls.historyPushes += 1;
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
  if (value instanceof Response) return value;
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

function remoteClientHarness(overrides = {}) {
  return {
    close() {},
    async send() {},
    ...overrides,
  };
}

function miniAppServiceFailure() {
  return new Response(JSON.stringify({ error: "Telegram Mini App authentication failed" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}

function archivedReplayFixture(id) {
  return {
    id,
    version: 1,
    presetId: "classic",
    viewerPlayerId: "p1",
    winnerId: "p1",
    finishedAt: "2026-07-17T12:00:00.000Z",
    players: {
      p1: { name: "Viewer Captain", username: "viewer" },
      p2: { name: "Opponent Captain", username: "opponent" },
    },
    boards: {
      p1: {
        size: 4,
        ships: [{
          id: "p1-patrol",
          length: 1,
          cells: [{ row: 1, col: 1 }],
          hits: [{ row: 1, col: 1 }],
        }],
        markers: [],
        shots: [{ row: 1, col: 1, result: "sunk", shipId: "p1-patrol" }],
      },
      p2: {
        size: 4,
        ships: [{
          id: "p2-patrol",
          length: 1,
          cells: [{ row: 2, col: 3 }],
          hits: [{ row: 2, col: 3 }],
        }],
        markers: [],
        shots: [
          { row: 0, col: 0, result: "miss" },
          { row: 2, col: 3, result: "sunk", shipId: "p2-patrol" },
        ],
      },
    },
    log: [
      {
        playerId: "p1",
        targetPlayerId: "p2",
        coordinate: { row: 0, col: 0 },
        result: "miss",
      },
      {
        playerId: "p2",
        targetPlayerId: "p1",
        coordinate: { row: 1, col: 1 },
        result: "sunk",
        shipId: "p1-patrol",
      },
      {
        playerId: "p1",
        targetPlayerId: "p2",
        coordinate: { row: 2, col: 3 },
        result: "sunk",
        shipId: "p2-patrol",
      },
    ],
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
