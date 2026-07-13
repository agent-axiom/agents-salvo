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
    Browser: { open: async () => {} },
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

test("native delegates sharing, browser, splash, and system bars safely", async () => {
  const calls = [];
  const payload = { title: "Salvo", text: "Battle", url: "salvo://battle" };
  const adapter = createNativePlatform(nativePlugins({
    Browser: { open: async (options) => calls.push(["browser", options]) },
    Share: { share: async (options) => calls.push(["share", options]) },
    SplashScreen: { hide: async () => calls.push(["splash"]) },
    SystemBars: { show: async () => calls.push(["bars"]) },
  }));

  assert.deepEqual(await adapter.share(payload), { shared: true });
  await adapter.openExternalUrl("https://salvo.test");
  await adapter.hideSplash();
  await adapter.configureSystemBars();
  assert.deepEqual(calls, [
    ["share", payload],
    ["browser", { url: "https://salvo.test" }],
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

test("platform selection is explicit and safe during Node import", () => {
  const web = selectPlatform(false);
  const native = selectPlatform(true);

  assert.equal(web.isNative(), false);
  assert.equal(web.getPlatform(), "web");
  assert.equal(native.isNative(), true);
  assert.equal(platform.isNative(), false);

  for (const adapter of [web, native]) {
    for (const method of [
      "isNative",
      "getPlatform",
      "getNetworkStatus",
      "onNetworkChange",
      "share",
      "haptic",
      "openExternalUrl",
      "onDeepLink",
      "onBack",
      "onLifecycleChange",
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
