import assert from "node:assert/strict";
import test from "node:test";

import { createMaxPlatform } from "../src/platform/max.js";

function fakeMax() {
  const calls = [];
  const backListeners = new Set();
  const secureValues = new Map();
  const webApp = {
    initData: "signed-max-init-data",
    initDataUnsafe: { start_param: "room_ABCD" },
    platform: "android",
    BackButton: {
      onClick(listener) {
        calls.push(["back", "on"]);
        backListeners.add(listener);
      },
      offClick(listener) {
        calls.push(["back", "off"]);
        backListeners.delete(listener);
      },
      show() {
        calls.push(["back", "show"]);
      },
      hide() {
        calls.push(["back", "hide"]);
      },
    },
    HapticFeedback: {
      impactOccurred(style) {
        calls.push(["impact", style]);
      },
      notificationOccurred(type) {
        calls.push(["notification", type]);
      },
    },
    SecureStorage: {
      async getItem(key) {
        calls.push(["secure-get", key]);
        return secureValues.get(key) ?? null;
      },
      async setItem(key, value) {
        calls.push(["secure-set", key, value]);
        secureValues.set(key, value);
      },
      async removeItem(key) {
        calls.push(["secure-remove", key]);
        secureValues.delete(key);
      },
    },
    enableClosingConfirmation() {
      calls.push(["closing", true]);
    },
    disableClosingConfirmation() {
      calls.push(["closing", false]);
    },
    openLink(url) {
      calls.push(["link", url]);
    },
    openMaxLink(url) {
      calls.push(["max-link", url]);
    },
    shareMaxContent(payload) {
      calls.push(["share", payload]);
    },
  };
  return { backListeners, calls, webApp };
}

test("MAX adapter exposes signed launch data and shared platform contract", async () => {
  const fake = fakeMax();
  const adapter = createMaxPlatform({ webApp: fake.webApp });

  assert.equal(adapter.isNative(), false);
  assert.equal(adapter.getPlatform(), "max");
  assert.equal(adapter.isAvailable(), true);
  assert.equal(adapter.getLaunchData(), "signed-max-init-data");
  assert.equal(adapter.getStartParam(), "room_ABCD");
  assert.equal(adapter.supportsInvoice(), false);

  let backs = 0;
  const removeBack = await adapter.onBack(() => {
    backs += 1;
  });
  await adapter.setBackButtonVisible(true);
  for (const listener of fake.backListeners) listener();
  await adapter.setBackButtonVisible(false);
  await removeBack();
  assert.equal(backs, 1);

  await adapter.setClosingConfirmation(true);
  await adapter.setClosingConfirmation(false);
  await adapter.haptic("hit");
  await adapter.haptic("victory");
  assert.deepEqual(fake.calls.filter(([scope]) => scope === "closing"), [
    ["closing", true],
    ["closing", false],
  ]);
  assert.deepEqual(fake.calls.filter(([scope]) => scope === "impact"), [
    ["impact", "medium"],
  ]);
  assert.deepEqual(fake.calls.filter(([scope]) => scope === "notification"), [
    ["notification", "success"],
  ]);
});

test("MAX adapter keeps authenticated Mini App sessions online when WebView reports offline", async () => {
  const fake = fakeMax();
  const listeners = new Map();
  const host = {
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  const adapter = createMaxPlatform({
    webApp: fake.webApp,
    window: host,
    navigator: { onLine: false },
  });

  assert.deepEqual(await adapter.getNetworkStatus(), {
    connected: true,
    connectionType: "unknown",
  });

  const changes = [];
  const remove = await adapter.onNetworkChange((status) => changes.push(status));
  listeners.get("offline")();
  assert.deepEqual(changes, [{ connected: true, connectionType: "unknown" }]);

  remove();
  assert.equal(listeners.size, 0);
});

test("MAX adapter shares in MAX and keeps external URLs on the right bridge method", async () => {
  const fake = fakeMax();
  const adapter = createMaxPlatform({ webApp: fake.webApp });

  assert.deepEqual(await adapter.share({
    title: "Salvo",
    text: "Join my room",
    url: "https://max.ru/se13661945_bot?startapp=room_ABCD",
  }), { shared: true });
  await adapter.openExternalUrl("https://max.ru/se13661945_bot?startapp");
  await adapter.openExternalUrl("https://example.test/rules");

  assert.deepEqual(fake.calls.filter(([scope]) => scope === "share"), [[
    "share",
    {
      text: "Join my room",
      link: "https://max.ru/se13661945_bot?startapp=room_ABCD",
    },
  ]]);
  assert.deepEqual(fake.calls.filter(([scope]) => scope.endsWith("link")), [
    ["max-link", "https://max.ru/se13661945_bot?startapp"],
    ["link", "https://example.test/rules"],
  ]);
});

test("MAX secure session uses SecureStorage and falls back to current-launch memory", async () => {
  const fake = fakeMax();
  const adapter = createMaxPlatform({ webApp: fake.webApp });

  assert.equal(await adapter.secureSession.get(), "");
  await adapter.secureSession.set("max-token");
  assert.equal(await adapter.secureSession.get(), "max-token");
  await adapter.secureSession.clear();
  assert.equal(await adapter.secureSession.get(), "");

  const unsupported = createMaxPlatform({ webApp: { initData: "signed" } });
  assert.equal(await unsupported.secureSession.get(), "");
  await unsupported.secureSession.set("memory-token");
  assert.equal(await unsupported.secureSession.get(), "memory-token");
  await unsupported.secureSession.clear();
  assert.equal(await unsupported.secureSession.get(), "");
});
