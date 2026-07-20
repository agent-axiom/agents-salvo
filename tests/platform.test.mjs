import test from "node:test";
import assert from "node:assert/strict";
import { createNativePlatform } from "../src/platform/native.js";
import { platform, selectPlatform } from "../src/platform/index.js";
import { createWebPlatform } from "../src/platform/web.js";

function storageHarness() {
  const calls = [];
  const values = new Map();

  return {
    calls,
    values,
    storage: {
      getItem(key) {
        calls.push(["get", key]);
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        calls.push(["set", key, value]);
        values.set(key, value);
      },
      removeItem(key) {
        calls.push(["remove", key]);
        values.delete(key);
      },
    },
  };
}

function listenerHarness({ onRegister } = {}) {
  const calls = [];
  const listeners = new Map();

  return {
    calls,
    plugin: {
      async addListener(name, listener) {
        calls.push(["add", name]);
        const registered = listeners.get(name) ?? new Set();
        registered.add(listener);
        listeners.set(name, registered);
        await onRegister?.(name, listener);
        return {
          async remove() {
            calls.push(["remove", name]);
            registered.delete(listener);
          },
        };
      },
    },
    async emit(name, event) {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        await listener(event);
      }
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}

function nativePlugins(overrides = {}) {
  return {
    Capacitor: { getPlatform: () => "ios" },
    App: {
      addListener: async () => ({ remove: async () => {} }),
      getLaunchUrl: async () => undefined,
      exitApp: async () => {},
    },
    Browser: { open: async () => {}, close: async () => {} },
    Haptics: {
      impact: async () => {},
      notification: async () => {},
    },
    Network: {
      getStatus: async () => ({ connected: true, connectionType: "wifi" }),
      addListener: async () => ({ remove: async () => {} }),
    },
    Preferences: {
      get: async () => ({ value: null }),
      set: async () => {},
      remove: async () => {},
    },
    Share: { share: async () => {} },
    SplashScreen: { hide: async () => {} },
    SystemBars: { show: async () => {} },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("web settings use prefixed string values and remove null", async () => {
  const harness = storageHarness();
  const adapter = createWebPlatform({ storage: harness.storage });

  assert.equal(adapter.isNative(), false);
  assert.equal(adapter.getPlatform(), "web");

  await adapter.settings.set("theme", "dark");
  assert.equal(await adapter.settings.get("theme"), "dark");
  await adapter.settings.set("volume", 3);
  assert.equal(harness.values.get("salvo.volume"), "3");
  await adapter.settings.set("theme", null);
  assert.equal(await adapter.settings.get("theme"), null);
  assert.deepEqual(harness.calls, [
    ["set", "salvo.theme", "dark"],
    ["get", "salvo.theme"],
    ["set", "salvo.volume", "3"],
    ["remove", "salvo.theme"],
    ["get", "salvo.theme"],
  ]);
});

test("web secure sessions use only the exact legacy auth key", async () => {
  const harness = storageHarness();
  const adapter = createWebPlatform({ storage: harness.storage });

  await adapter.secureSession.set("web-token");
  assert.equal(await adapter.secureSession.get(), "web-token");
  await adapter.secureSession.clear();
  assert.equal(await adapter.secureSession.get(), "");
  assert.deepEqual(harness.calls, [
    ["set", "salvo.authToken", "web-token"],
    ["get", "salvo.authToken"],
    ["remove", "salvo.authToken"],
    ["get", "salvo.authToken"],
  ]);
});

test("web network status and events map online state and clean up", async () => {
  const listeners = new Map();
  const host = {
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  const navigator = { onLine: false };
  const adapter = createWebPlatform({ window: host, navigator });
  const changes = [];

  assert.deepEqual(await adapter.getNetworkStatus(), {
    connected: false,
    connectionType: "none",
  });
  navigator.onLine = true;
  assert.deepEqual(await adapter.getNetworkStatus(), {
    connected: true,
    connectionType: "unknown",
  });

  const remove = await adapter.onNetworkChange((status) => changes.push(status));
  listeners.get("online")();
  listeners.get("offline")();
  assert.deepEqual(changes, [
    { connected: true, connectionType: "unknown" },
    { connected: false, connectionType: "none" },
  ]);

  remove();
  assert.equal(listeners.size, 0);
});

test("web share reports success, unsupported, and rejection", async () => {
  const payload = { title: "Salvo", text: "Battle", url: "https://salvo.test" };
  const calls = [];
  const supported = createWebPlatform({
    navigator: {
      async share(value) {
        calls.push(value);
      },
    },
  });
  const unsupported = createWebPlatform({ navigator: {} });
  const rejected = createWebPlatform({
    navigator: { share: async () => Promise.reject(new Error("cancelled")) },
  });

  assert.deepEqual(await supported.share(payload), { shared: true });
  assert.deepEqual(calls, [payload]);
  assert.deepEqual(await unsupported.share(payload), { shared: false });
  assert.deepEqual(await rejected.share(payload), { shared: false });
});

test("web external URLs and unsupported platform hooks are safe no-ops", async () => {
  const calls = [];
  const adapter = createWebPlatform({
    window: { open: (...args) => calls.push(args) },
  });

  await adapter.openExternalUrl("https://salvo.test/rules");
  await adapter.closeExternalUrl();
  assert.deepEqual(calls, [
    ["https://salvo.test/rules", "_blank", "noopener,noreferrer"],
  ]);

  const deepLinkRemove = await adapter.onDeepLink(() => {});
  const backRemove = await adapter.onBack(() => {});
  const lifecycleRemove = await adapter.onLifecycleChange(() => {});
  await adapter.haptic("hit");
  await adapter.hideSplash();
  await adapter.configureSystemBars();
  await createWebPlatform({ window: undefined }).openExternalUrl("https://salvo.test");
  await createWebPlatform({ window: undefined }).closeExternalUrl();
  deepLinkRemove();
  backRemove();
  lifecycleRemove();
});

test("native delegates platform, network, and prefixed settings", async () => {
  const network = listenerHarness();
  const networkStatus = { connected: true, connectionType: "cellular" };
  const values = new Map();
  const preferenceCalls = [];
  const Preferences = {
    async get({ key }) {
      preferenceCalls.push(["get", key]);
      return { value: values.get(key) ?? null };
    },
    async set({ key, value }) {
      preferenceCalls.push(["set", key, value]);
      values.set(key, value);
    },
    async remove({ key }) {
      preferenceCalls.push(["remove", key]);
      values.delete(key);
    },
  };
  const adapter = createNativePlatform(nativePlugins({
    Capacitor: { getPlatform: () => "android" },
    Network: {
      ...network.plugin,
      getStatus: async () => networkStatus,
    },
    Preferences,
  }));

  assert.equal(adapter.isNative(), true);
  assert.equal(adapter.getPlatform(), "android");
  assert.equal(await adapter.getNetworkStatus(), networkStatus);

  const changes = [];
  const removeNetwork = await adapter.onNetworkChange((status) => changes.push(status));
  await network.emit("networkStatusChange", networkStatus);
  assert.deepEqual(changes, [networkStatus]);
  assert.equal(network.listenerCount("networkStatusChange"), 1);
  await removeNetwork();
  assert.equal(network.listenerCount("networkStatusChange"), 0);

  await adapter.settings.set("theme", "dark");
  assert.equal(await adapter.settings.get("theme"), "dark");
  await adapter.settings.set("volume", 4);
  assert.equal(values.get("salvo.volume"), "4");
  await adapter.settings.set("theme", null);
  assert.equal(await adapter.settings.get("theme"), null);
  assert.deepEqual(preferenceCalls, [
    ["set", "salvo.theme", "dark"],
    ["get", "salvo.theme"],
    ["set", "salvo.volume", "4"],
    ["remove", "salvo.theme"],
    ["get", "salvo.theme"],
  ]);
});

test("native maps semantic haptics and swallows plugin failures", async () => {
  const calls = [];
  const adapter = createNativePlatform(nativePlugins({
    Haptics: {
      impact: async ({ style }) => calls.push(["impact", style]),
      notification: async ({ type }) => calls.push(["notification", type]),
    },
  }));

  for (const event of [
    "placement",
    "hit",
    "sunk",
    "invalid",
    "victory",
    "defeat",
    "unknown",
  ]) {
    await adapter.haptic(event);
  }
  assert.deepEqual(calls, [
    ["impact", "LIGHT"],
    ["impact", "MEDIUM"],
    ["impact", "HEAVY"],
    ["notification", "WARNING"],
    ["notification", "SUCCESS"],
    ["notification", "ERROR"],
  ]);

  const unavailable = createNativePlatform(nativePlugins({
    Haptics: {
      impact: async () => Promise.reject(new Error("unsupported")),
      notification: async () => Promise.reject(new Error("unsupported")),
    },
  }));
  await assert.doesNotReject(() => unavailable.haptic("placement"));
  await assert.doesNotReject(() => unavailable.haptic("invalid"));
});

test("native delegates sharing, browser open and close, splash, and system bars safely", async () => {
  const calls = [];
  const payload = { title: "Salvo", text: "Battle", url: "salvo://battle" };
  const adapter = createNativePlatform(nativePlugins({
    Browser: {
      open: async (options) => calls.push(["browser", options]),
      close: async () => calls.push(["browser-close"]),
    },
    Share: { share: async (options) => calls.push(["share", options]) },
    SplashScreen: { hide: async () => calls.push(["splash"]) },
    SystemBars: { show: async () => calls.push(["bars"]) },
  }));

  assert.deepEqual(await adapter.share(payload), { shared: true });
  await adapter.openExternalUrl("https://salvo.test");
  await adapter.closeExternalUrl();
  await adapter.hideSplash();
  await adapter.configureSystemBars();
  assert.deepEqual(calls, [
    ["share", payload],
    ["browser", { url: "https://salvo.test" }],
    ["browser-close"],
    ["splash"],
    ["bars"],
  ]);

  const unavailable = createNativePlatform(nativePlugins({
    Share: { share: async () => Promise.reject(new Error("cancelled")) },
    SplashScreen: { hide: async () => Promise.reject(new Error("unsupported")) },
    SystemBars: { show: async () => Promise.reject(new Error("unsupported")) },
  }));
  assert.deepEqual(await unavailable.share(payload), { shared: false });
  await assert.doesNotReject(() => unavailable.hideSplash());
  await assert.doesNotReject(() => unavailable.configureSystemBars());
});

test("native lifecycle normalizes active state and removes its listener", async () => {
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => undefined,
      exitApp: async () => {},
    },
  }));
  const states = [];

  const remove = await adapter.onLifecycleChange((state) => states.push(state));
  await appEvents.emit("appStateChange", { isActive: 1 });
  await appEvents.emit("appStateChange", { isActive: 0 });
  assert.deepEqual(states, [{ active: true }, { active: false }]);
  assert.equal(appEvents.listenerCount("appStateChange"), 1);

  await remove();
  await appEvents.emit("appStateChange", { isActive: true });
  assert.equal(appEvents.listenerCount("appStateChange"), 0);
  assert.deepEqual(states, [{ active: true }, { active: false }]);
});

test("native deep links deliver cold starts and foreground URLs then clean up", async () => {
  const appEvents = listenerHarness();
  const appCalls = [];
  const App = {
    ...appEvents.plugin,
    async getLaunchUrl() {
      appCalls.push("launch");
      return { url: "salvo://open/room/COLD" };
    },
    exitApp: async () => {},
  };
  const originalAddListener = App.addListener;
  App.addListener = async (...args) => {
    appCalls.push(`add:${args[0]}`);
    return originalAddListener(...args);
  };
  const adapter = createNativePlatform(nativePlugins({ App }));
  const urls = [];

  const remove = await adapter.onDeepLink((url) => urls.push(url));
  assert.deepEqual(appCalls, ["add:appUrlOpen", "launch"]);
  assert.deepEqual(urls, ["salvo://open/room/COLD"]);

  await appEvents.emit("appUrlOpen", { url: "salvo://open/room/LIVE" });
  await appEvents.emit("appUrlOpen", { url: 1234 });
  assert.deepEqual(urls, [
    "salvo://open/room/COLD",
    "salvo://open/room/LIVE",
  ]);

  await remove();
  await appEvents.emit("appUrlOpen", { url: "salvo://open/room/LATE" });
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
  assert.deepEqual(urls, [
    "salvo://open/room/COLD",
    "salvo://open/room/LIVE",
  ]);
});

test("native deep links suppress only a duplicate startup appUrlOpen", async () => {
  const coldUrl = "salvo://open/room/DUPLICATE";
  const appEvents = listenerHarness({
    async onRegister(name, listener) {
      if (name === "appUrlOpen") await listener({ url: coldUrl });
    },
  });
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => ({ url: coldUrl }),
      exitApp: async () => {},
    },
  }));
  const urls = [];

  const remove = await adapter.onDeepLink((url) => urls.push(url));
  assert.deepEqual(urls, [coldUrl]);

  await appEvents.emit("appUrlOpen", { url: coldUrl });
  assert.deepEqual(urls, [coldUrl, coldUrl]);
  await remove();
});

test("native deep links observe rejected foreground listener promises", async (t) => {
  const failure = new Error("foreground delivery failed");
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => undefined,
      exitApp: async () => {},
    },
  }));
  const remove = await adapter.onDeepLink(() => Promise.reject(failure));

  await appEvents.emit("appUrlOpen", { url: "salvo://open/room/LIVE" });
  await new Promise((resolve) => setImmediate(resolve));
  await remove();

  assert.deepEqual(unhandled, []);
});

test("native deep-link setup removes its listener when launch lookup fails", async () => {
  const failure = new Error("launch lookup failed");
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => Promise.reject(failure),
      exitApp: async () => {},
    },
  }));

  await assert.rejects(
    adapter.onDeepLink(() => {}),
    (error) => error === failure,
  );
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
  assert.deepEqual(appEvents.calls, [
    ["add", "appUrlOpen"],
    ["remove", "appUrlOpen"],
  ]);
});

test("native deep-link setup observes rejected cold-start delivery", async () => {
  const failure = new Error("cold-start delivery failed");
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => ({ url: "salvo://open/room/FAIL" }),
      exitApp: async () => {},
    },
  }));

  const remove = await adapter.onDeepLink(() => Promise.reject(failure));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appEvents.listenerCount("appUrlOpen"), 1);
  await remove();
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
});

test("native deep-link setup cleans up synchronous cold-start failure", async () => {
  const failure = new Error("cold-start delivery failed");
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => ({ url: "salvo://open/room/FAIL" }),
      exitApp: async () => {},
    },
  }));

  await assert.rejects(
    adapter.onDeepLink(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
});

test("native deep-link setup observes rejected startup event delivery", async () => {
  const failure = new Error("startup delivery failed");
  const launch = deferred();
  const launchStarted = deferred();
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl() {
        launchStarted.resolve();
        return launch.promise;
      },
      exitApp: async () => {},
    },
  }));
  const setup = adapter.onDeepLink(() => Promise.reject(failure));

  await launchStarted.promise;
  await appEvents.emit("appUrlOpen", { url: "salvo://open/room/STARTUP" });
  launch.resolve(undefined);

  const remove = await setup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appEvents.listenerCount("appUrlOpen"), 1);
  await remove();
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
});

test("native deep-link setup does not await startup event callbacks", async () => {
  const pendingDelivery = deferred();
  const launch = deferred();
  const launchStarted = deferred();
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl() {
        launchStarted.resolve();
        return launch.promise;
      },
      exitApp: async () => {},
    },
  }));
  const setup = adapter.onDeepLink(() => pendingDelivery.promise);
  let returnedRemove;
  void setup.then((remove) => {
    returnedRemove = remove;
  });

  await launchStarted.promise;
  await appEvents.emit("appUrlOpen", { url: "salvo://open/room/PENDING" });
  launch.resolve(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const removeBeforeDeliverySettles = returnedRemove;

  pendingDelivery.resolve();
  const remove = await setup;
  await remove();
  assert.equal(removeBeforeDeliverySettles, remove);
});

test("native deep-link setup does not await cold-start callbacks", async () => {
  const pendingDelivery = deferred();
  const appEvents = listenerHarness();
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => ({ url: "salvo://open/room/PENDING" }),
      exitApp: async () => {},
    },
  }));
  const setup = adapter.onDeepLink(() => pendingDelivery.promise);
  let returnedRemove;
  void setup.then((remove) => {
    returnedRemove = remove;
  });

  await new Promise((resolve) => setImmediate(resolve));
  const removeBeforeDeliverySettles = returnedRemove;

  pendingDelivery.resolve();
  const remove = await setup;
  await remove();
  assert.equal(removeBeforeDeliverySettles, remove);
});

test("native deep-link setup captures synchronous startup delivery failure", async () => {
  const failure = new Error("synchronous startup delivery failed");
  const appEvents = listenerHarness({
    onRegister(name, listener) {
      if (name === "appUrlOpen") {
        listener({ url: "salvo://open/room/SYNC-FAIL" });
      }
    },
  });
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => undefined,
      exitApp: async () => {},
    },
  }));

  await assert.rejects(
    adapter.onDeepLink(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(appEvents.listenerCount("appUrlOpen"), 0);
});

test("native deep-link setup preserves failure when cleanup rejects", async () => {
  const failure = new Error("launch lookup failed");
  let removeCalls = 0;
  const adapter = createNativePlatform(nativePlugins({
    App: {
      async addListener() {
        return {
          async remove() {
            removeCalls += 1;
            throw new Error("cleanup failed");
          },
        };
      },
      getLaunchUrl: async () => Promise.reject(failure),
      exitApp: async () => {},
    },
  }));

  await assert.rejects(
    adapter.onDeepLink(() => {}),
    (error) => error === failure,
  );
  assert.equal(removeCalls, 1);
});

test("native deep-link cleanup closes before an idempotent remove", async () => {
  const removeFailure = new Error("cleanup failed");
  let appUrlListener;
  let removeCalls = 0;
  const adapter = createNativePlatform(nativePlugins({
    App: {
      async addListener(name, listener) {
        assert.equal(name, "appUrlOpen");
        appUrlListener = listener;
        return {
          async remove() {
            removeCalls += 1;
            throw removeFailure;
          },
        };
      },
      getLaunchUrl: async () => undefined,
      exitApp: async () => {},
    },
  }));
  const urls = [];
  const remove = await adapter.onDeepLink((url) => urls.push(url));

  const firstRemoval = remove();
  const secondRemoval = remove();
  await assert.rejects(firstRemoval, (error) => error === removeFailure);
  await assert.rejects(secondRemoval, (error) => error === removeFailure);
  appUrlListener({ url: "salvo://open/room/LATE" });

  assert.equal(firstRemoval, secondRemoval);
  assert.equal(removeCalls, 1);
  assert.deepEqual(urls, []);
});

test("native back exits only when the handler returns exactly false", async () => {
  const appEvents = listenerHarness();
  let exits = 0;
  let behavior = "handled";
  const received = [];
  const adapter = createNativePlatform(nativePlugins({
    App: {
      ...appEvents.plugin,
      getLaunchUrl: async () => undefined,
      exitApp: async () => {
        exits += 1;
      },
    },
  }));
  const remove = await adapter.onBack(async (event) => {
    received.push(event);
    if (behavior === "throw") throw new Error("handler failed");
    return behavior === "exit" ? false : true;
  });

  const event = { canGoBack: false };
  await appEvents.emit("backButton", event);
  assert.equal(exits, 0);

  behavior = "exit";
  await appEvents.emit("backButton", event);
  assert.equal(exits, 1);

  behavior = "throw";
  await appEvents.emit("backButton", event);
  assert.equal(exits, 1);
  assert.deepEqual(received, [event, event, event]);

  await remove();
  assert.equal(appEvents.listenerCount("backButton"), 0);
});

test("native secure sessions fail closed without touching Preferences", async () => {
  const preferenceCalls = [];
  const Preferences = {
    get: async (...args) => preferenceCalls.push(["get", ...args]),
    set: async (...args) => preferenceCalls.push(["set", ...args]),
    remove: async (...args) => preferenceCalls.push(["remove", ...args]),
  };
  const adapter = createNativePlatform(nativePlugins({ Preferences }));
  const expected = { name: "Error", message: "Secure session storage unavailable" };

  await assert.rejects(adapter.secureSession.get(), expected);
  await assert.rejects(adapter.secureSession.set("native-token"), expected);
  await assert.rejects(adapter.secureSession.clear(), expected);
  assert.deepEqual(preferenceCalls, []);
});

test("native secure sessions persist only through protected device storage", async () => {
  const preferenceCalls = [];
  const secureCalls = [];
  const secureValues = new Map();
  const adapter = createNativePlatform(nativePlugins({
    Preferences: {
      get: async (...args) => preferenceCalls.push(["get", ...args]),
      set: async (...args) => preferenceCalls.push(["set", ...args]),
      remove: async (...args) => preferenceCalls.push(["remove", ...args]),
    },
    SecureStorage: {
      async getItem(key) {
        secureCalls.push(["get", key]);
        return secureValues.get(key) ?? null;
      },
      async setItem(key, value) {
        secureCalls.push(["set", key, value]);
        secureValues.set(key, value);
      },
      async removeItem(key) {
        secureCalls.push(["remove", key]);
        secureValues.delete(key);
      },
    },
  }));

  assert.equal(await adapter.secureSession.get(), "");
  await adapter.secureSession.set("native-token");
  assert.equal(await adapter.secureSession.get(), "native-token");
  await adapter.secureSession.clear();
  assert.equal(await adapter.secureSession.get(), "");

  assert.deepEqual(secureCalls, [
    ["get", "salvo.authToken"],
    ["set", "salvo.authToken", "native-token"],
    ["get", "salvo.authToken"],
    ["remove", "salvo.authToken"],
    ["get", "salvo.authToken"],
  ]);
  assert.deepEqual(preferenceCalls, []);
});

test("platform selection is explicit and safe during Node import", () => {
  const web = selectPlatform(false);
  const native = selectPlatform(true);
  const telegram = selectPlatform(false, {
    runtime: "telegram",
    telegramWebApp: {
      initData: "signed-init-data",
      initDataUnsafe: { start_param: "room_ABCD" },
    },
  });
  const nativeWins = selectPlatform(true, {
    runtime: "telegram",
    telegramWebApp: { initData: "signed-init-data" },
  });

  assert.equal(web.isNative(), false);
  assert.equal(web.getPlatform(), "web");
  assert.equal(native.isNative(), true);
  assert.equal(telegram.getPlatform(), "telegram");
  assert.equal(telegram.getLaunchData(), "signed-init-data");
  assert.equal(nativeWins.isNative(), true);
  assert.notEqual(nativeWins.getPlatform(), "telegram");
  assert.equal(platform.isNative(), false);

  for (const adapter of [web, native, telegram]) {
    for (const method of [
      "isNative",
      "getPlatform",
      "isAvailable",
      "getLaunchData",
      "getStartParam",
      "getNetworkStatus",
      "onNetworkChange",
      "share",
      "haptic",
      "openExternalUrl",
      "supportsInvoice",
      "openInvoice",
      "onDeepLink",
      "onBack",
      "onLifecycleChange",
      "onSettings",
      "ready",
      "setBackButtonVisible",
      "setClosingConfirmation",
      "getTheme",
      "onThemeChange",
      "onViewportChange",
      "hideSplash",
      "configureSystemBars",
    ]) {
      assert.equal(typeof adapter[method], "function");
    }
    assert.equal(typeof adapter.settings.get, "function");
    assert.equal(typeof adapter.settings.set, "function");
    assert.equal(typeof adapter.secureSession.get, "function");
    assert.equal(typeof adapter.secureSession.set, "function");
    assert.equal(typeof adapter.secureSession.clear, "function");
  }
});

test("web and native expose safe no-op Telegram capabilities", async () => {
  const adapters = [
    createWebPlatform({ window: undefined, navigator: undefined, storage: undefined }),
    createNativePlatform(nativePlugins()),
  ];

  for (const adapter of adapters) {
    assert.equal(adapter.isAvailable(), true);
    assert.equal(adapter.getLaunchData(), "");
    assert.equal(adapter.getStartParam(), "");
    assert.equal(adapter.getTheme(), null);
    const removeSettings = await adapter.onSettings(() => {});
    const removeTheme = await adapter.onThemeChange(() => {});
    const removeViewport = await adapter.onViewportChange(() => {});
    await adapter.ready();
    await adapter.setBackButtonVisible(true);
    await adapter.setBackButtonVisible(false);
    await adapter.setClosingConfirmation(true);
    removeSettings();
    removeTheme();
    removeViewport();
  }
});

test("web and native reject Telegram invoices without opening a browser", async () => {
  const calls = [];
  const web = createWebPlatform({
    window: { open: (...args) => calls.push(["window", ...args]) },
  });
  const native = createNativePlatform(nativePlugins({
    Browser: {
      open: async (...args) => calls.push(["browser", ...args]),
      close: async () => {},
    },
  }));

  for (const adapter of [web, native]) {
    assert.equal(adapter.supportsInvoice(), false);
    assert.deepEqual(
      await adapter.openInvoice("https://t.me/$invoice_token"),
      { status: "unsupported" },
    );
  }
  assert.deepEqual(calls, []);
});
