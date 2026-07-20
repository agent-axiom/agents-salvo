import test from "node:test";
import assert from "node:assert/strict";
import { createLocalBattleSnapshotStore } from "../src/core/local-battle-snapshot.js";
import { createMobileRuntime } from "../src/mobile.js";
import { createTelegramPlatform } from "../src/platform/telegram.js";

const buttonCleanupError = {
  name: "Error",
  message: "Telegram button cleanup failed",
};

const buttonVisibilityError = {
  name: "Error",
  message: "Telegram button visibility update failed",
};

const closingConfirmationError = {
  name: "Error",
  message: "Telegram closing confirmation update failed",
};

const eventCleanupError = {
  name: "Error",
  message: "Telegram event cleanup failed",
};

const settingsStorageError = {
  name: "Error",
  message: "Settings storage unavailable",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function timerHarness() {
  let nextId = 1;
  const pending = new Map();
  const scheduled = [];
  const cleared = [];

  return {
    cleared,
    pending,
    scheduled,
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      scheduled.push([id, delay]);
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      pending.delete(id);
    },
    fire(id = pending.keys().next().value) {
      const callback = pending.get(id);
      pending.delete(id);
      callback?.();
    },
  };
}

function storageHarness() {
  const calls = [];
  const values = new Map();

  return {
    calls,
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

function fakeTelegram({ versionAtLeast = true } = {}) {
  const calls = [];
  const events = new Map();
  const windowEvents = new Map();
  const css = new Map();

  function addEvent(name, listener) {
    const listeners = events.get(name) ?? new Set();
    listeners.add(listener);
    events.set(name, listeners);
  }

  function removeEvent(name, listener) {
    events.get(name)?.delete(listener);
  }

  function button(name) {
    const listeners = new Set();
    return {
      listeners,
      api: {
        onClick(listener) {
          calls.push([name, "onClick"]);
          listeners.add(listener);
        },
        offClick(listener) {
          calls.push([name, "offClick"]);
          listeners.delete(listener);
        },
        show() {
          calls.push([name, "show"]);
        },
        hide() {
          calls.push([name, "hide"]);
        },
      },
    };
  }

  const back = button("back");
  const settings = button("settings");
  const webApp = {
    initData: "signed-init-data",
    initDataUnsafe: { start_param: "room_ABCD" },
    colorScheme: "dark",
    viewportHeight: 640,
    viewportStableHeight: 620,
    isExpanded: true,
    safeAreaInset: { top: 10, right: 11, bottom: 12, left: 13 },
    contentSafeAreaInset: { top: 20, right: 21, bottom: 22, left: 23 },
    BackButton: back.api,
    SettingsButton: settings.api,
    HapticFeedback: {
      impactOccurred(style) {
        calls.push(["impact", style]);
      },
      notificationOccurred(type) {
        calls.push(["notification", type]);
      },
    },
    isVersionAtLeast(version) {
      calls.push(["version", version]);
      return versionAtLeast;
    },
    ready() {
      calls.push(["ready"]);
    },
    expand() {
      calls.push(["expand"]);
    },
    requestFullscreen() {
      calls.push(["fullscreen"]);
    },
    setHeaderColor(color) {
      calls.push(["header", color]);
    },
    setBackgroundColor(color) {
      calls.push(["background", color]);
    },
    enableClosingConfirmation() {
      calls.push(["closing", true]);
    },
    disableClosingConfirmation() {
      calls.push(["closing", false]);
    },
    openTelegramLink(url) {
      calls.push(["telegram-link", url]);
    },
    openLink(url) {
      calls.push(["link", url]);
    },
    onEvent(name, listener) {
      calls.push(["onEvent", name]);
      addEvent(name, listener);
    },
    offEvent(name, listener) {
      calls.push(["offEvent", name]);
      removeEvent(name, listener);
    },
  };
  const window = {
    document: {
      documentElement: {
        style: {
          setProperty(name, value) {
            css.set(name, value);
          },
        },
      },
    },
    addEventListener(name, listener) {
      windowEvents.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (windowEvents.get(name) === listener) windowEvents.delete(name);
    },
    open(...args) {
      calls.push(["window-open", ...args]);
    },
  };

  return {
    back,
    calls,
    css,
    events,
    settings,
    webApp,
    window,
    windowEvents,
    emit(name, event) {
      for (const listener of [...(events.get(name) ?? [])]) listener(event);
    },
  };
}

test("Telegram adapter exposes launch and network contract", async () => {
  const fake = fakeTelegram();
  const navigator = { onLine: true };
  const adapter = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    navigator,
    storage: storageHarness().storage,
  });

  assert.equal(adapter.isNative(), false);
  assert.equal(adapter.getPlatform(), "telegram");
  assert.equal(adapter.isAvailable(), true);
  assert.equal(adapter.getLaunchData(), "signed-init-data");
  assert.equal(adapter.getStartParam(), "room_ABCD");
  assert.deepEqual(await adapter.getNetworkStatus(), {
    connected: true,
    connectionType: "unknown",
  });

  const changes = [];
  const remove = await adapter.onNetworkChange((status) => changes.push(status));
  navigator.onLine = false;
  fake.windowEvents.get("offline")();
  navigator.onLine = true;
  fake.windowEvents.get("online")();
  assert.deepEqual(changes, [
    { connected: false, connectionType: "none" },
    { connected: true, connectionType: "unknown" },
  ]);
  remove();
  assert.equal(fake.windowEvents.size, 0);
});

test("Telegram BackButton visibility is explicit while SettingsButton stays visible", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  let backs = 0;
  let settings = 0;

  const removeBack = await adapter.onBack(() => {
    backs += 1;
  });
  const removeSettings = await adapter.onSettings(() => {
    settings += 1;
  });
  assert.equal(fake.calls.some((call) => call[0] === "back" && call[1] === "show"), false);
  assert.equal(fake.calls.filter((call) => call[0] === "settings" && call[1] === "show").length, 1);
  for (const listener of fake.back.listeners) listener();
  for (const listener of fake.settings.listeners) listener();
  assert.equal(backs, 1);
  assert.equal(settings, 1);

  await adapter.setBackButtonVisible(true);
  await adapter.setBackButtonVisible(false);
  assert.equal(fake.back.listeners.size, 1, "hiding does not remove the listener");
  for (const listener of fake.back.listeners) listener();
  assert.equal(backs, 2);
  await adapter.setBackButtonVisible(true);

  await removeBack();
  await removeSettings();
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.settings.listeners.size, 0);
  assert.deepEqual(fake.calls.filter(([scope]) => scope === "back"), [
    ["back", "onClick"],
    ["back", "show"],
    ["back", "hide"],
    ["back", "show"],
    ["back", "offClick"],
    ["back", "hide"],
  ]);
  assert.deepEqual(fake.calls.filter(([scope]) => scope === "settings"), [
    ["settings", "onClick"],
    ["settings", "show"],
    ["settings", "offClick"],
    ["settings", "hide"],
  ]);
});

test("Telegram awaits rejected event and button registrations", async () => {
  const fake = fakeTelegram();
  const eventRegistration = deferred();
  const buttonRegistration = deferred();
  fake.webApp.onEvent = () => eventRegistration.promise;
  fake.back.api.onClick = () => buttonRegistration.promise;
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  let eventSettled = false;
  let buttonSettled = false;

  const eventSetup = adapter.onThemeChange(() => {});
  const buttonSetup = adapter.onBack(() => {});
  void eventSetup.then(() => {
    eventSettled = true;
  });
  void buttonSetup.then(() => {
    buttonSettled = true;
  });
  await Promise.resolve();
  assert.equal(eventSettled, false);
  assert.equal(buttonSettled, false);
  assert.equal(fake.calls.some((call) => call[0] === "back" && call[1] === "show"), false);

  eventRegistration.reject(new Error("private event registration failure"));
  buttonRegistration.reject(new Error("private button registration failure"));
  const removeEvent = await eventSetup;
  const removeButton = await buttonSetup;
  await assert.doesNotReject(() => removeEvent());
  await assert.doesNotReject(() => removeButton());
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.calls.some((call) => call[0] === "back" && call[1] === "show"), false);
  assert.equal(fake.calls.some((call) => call[0] === "offEvent"), false);
});

test("Telegram rolls back a partial multi-event registration failure", async () => {
  const fake = fakeTelegram();
  const originalOnEvent = fake.webApp.onEvent;
  fake.webApp.onEvent = function onEvent(name, listener) {
    if (name === "deactivated") {
      return Promise.reject(new Error("private second registration failure"));
    }
    return originalOnEvent.call(this, name, listener);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const lifecycle = [];

  const remove = await adapter.onLifecycleChange((state) => lifecycle.push(state));
  assert.equal(fake.events.get("activated").size, 0);
  assert.equal(fake.events.has("deactivated"), false);
  fake.emit("activated");
  assert.deepEqual(lifecycle, []);
  await assert.doesNotReject(() => remove());
  assert.equal(fake.calls.filter((call) => (
    call[0] === "offEvent" && call[1] === "activated"
  )).length, 1);
});

test("Telegram button subscriptions are reference-counted in both removal orders", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  await adapter.setBackButtonVisible(true);
  const removeBackFirst = await adapter.onBack(() => {});
  const removeBackSecond = await adapter.onBack(() => {});
  const removeSettingsFirst = await adapter.onSettings(() => {});
  const removeSettingsSecond = await adapter.onSettings(() => {});

  assert.equal(fake.back.listeners.size, 2);
  assert.equal(fake.settings.listeners.size, 2);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "show").length, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "settings" && call[1] === "show").length, 1);

  const backFirst = removeBackFirst();
  assert.equal(removeBackFirst(), backFirst);
  await backFirst;
  assert.equal(fake.back.listeners.size, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 0);
  const backSecond = removeBackSecond();
  assert.equal(removeBackSecond(), backSecond);
  await backSecond;
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 1);
  assert.equal(removeBackFirst(), backFirst);
  assert.equal(removeBackSecond(), backSecond);

  const settingsSecond = removeSettingsSecond();
  assert.equal(removeSettingsSecond(), settingsSecond);
  await settingsSecond;
  assert.equal(fake.settings.listeners.size, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "settings" && call[1] === "hide").length, 0);
  const settingsFirst = removeSettingsFirst();
  assert.equal(removeSettingsFirst(), settingsFirst);
  await settingsFirst;
  assert.equal(fake.settings.listeners.size, 0);
  assert.equal(fake.calls.filter((call) => call[0] === "settings" && call[1] === "hide").length, 1);
});

test("Telegram serializes a subscription arriving during button hide", async () => {
  const fake = fakeTelegram();
  const hideStarted = deferred();
  const releaseHide = deferred();
  fake.back.api.hide = async () => {
    fake.calls.push(["back", "hide"]);
    hideStarted.resolve();
    await releaseHide.promise;
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  await adapter.setBackButtonVisible(true);
  const removeFirst = await adapter.onBack(() => {});

  const removingFirst = removeFirst();
  await hideStarted.promise;
  let secondSettled = false;
  const secondSetup = adapter.onBack(() => {});
  void secondSetup.then(() => {
    secondSettled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(secondSettled, false);
  assert.equal(fake.back.listeners.size, 1);
  releaseHide.resolve();
  const removeSecond = await secondSetup;
  await removingFirst;

  assert.equal(fake.back.listeners.size, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "show").length, 2);
  await removeSecond();
});

test("Telegram retries rejected button hide without repeating offClick", async () => {
  const fake = fakeTelegram();
  const originalHide = fake.back.api.hide;
  let hideAttempts = 0;
  fake.back.api.hide = function hide() {
    hideAttempts += 1;
    if (hideAttempts === 1) {
      return Promise.reject(new Error("private button hide failure"));
    }
    return originalHide.call(this);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  await adapter.setBackButtonVisible(true);
  const remove = await adapter.onBack(() => {});

  const failed = remove();
  assert.equal(remove(), failed);
  await assert.rejects(failed, buttonCleanupError);
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "offClick").length, 1);

  const retry = remove();
  assert.notEqual(retry, failed);
  assert.equal(remove(), retry);
  await retry;
  assert.equal(hideAttempts, 2);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "offClick").length, 1);
  assert.equal(remove(), retry);
});

test("Telegram button cleanup contains failures and retries removal", async () => {
  const fake = fakeTelegram();
  const originalOffClick = fake.back.api.offClick;
  let attempts = 0;
  fake.back.api.offClick = function offClick(listener) {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(new Error("private button removal failure"));
    }
    return originalOffClick.call(this, listener);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  await adapter.setBackButtonVisible(true);
  const remove = await adapter.onBack(() => {});

  const failed = remove();
  assert.equal(remove(), failed);
  await assert.rejects(failed, buttonCleanupError);
  assert.equal(fake.back.listeners.size, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 0);

  const retry = remove();
  assert.notEqual(retry, failed);
  assert.equal(remove(), retry);
  await retry;
  assert.equal(attempts, 2);
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 1);
  assert.equal(remove(), retry);
});

test("Telegram BackButton visibility failures are redacted and retryable", async () => {
  const fake = fakeTelegram();
  const originalShow = fake.back.api.show;
  let showAttempts = 0;
  fake.back.api.show = function show() {
    showAttempts += 1;
    if (showAttempts === 1) {
      return Promise.reject(new Error("private BackButton provider detail"));
    }
    return originalShow.call(this);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const remove = await adapter.onBack(() => {});

  await assert.rejects(adapter.setBackButtonVisible(true), buttonVisibilityError);
  assert.equal(showAttempts, 1);
  await assert.doesNotReject(() => adapter.setBackButtonVisible(true));
  assert.equal(showAttempts, 2);

  await remove();
});

test("Telegram retries visibility requested before BackButton subscription", async () => {
  const fake = fakeTelegram();
  const originalShow = fake.back.api.show;
  let showAttempts = 0;
  fake.back.api.show = function show() {
    showAttempts += 1;
    if (showAttempts === 1) {
      return Promise.reject(new Error("private deferred show failure"));
    }
    return originalShow.call(this);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });

  await adapter.setBackButtonVisible(true);
  const remove = await adapter.onBack(() => {});
  assert.equal(fake.back.listeners.size, 1);
  assert.equal(showAttempts, 1);
  await assert.doesNotReject(() => adapter.setBackButtonVisible(true));
  assert.equal(showAttempts, 2);

  await remove();
  assert.equal(fake.back.listeners.size, 0);
});

test("Telegram ready retries SettingsButton visibility after its first show fails", async () => {
  const fake = fakeTelegram();
  const originalShow = fake.settings.api.show;
  let showAttempts = 0;
  fake.settings.api.show = function show() {
    showAttempts += 1;
    if (showAttempts === 1) {
      return Promise.reject(new Error("private SettingsButton provider detail"));
    }
    return originalShow.call(this);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  let settings = 0;
  const remove = await adapter.onSettings(() => {
    settings += 1;
  });

  assert.equal(fake.settings.listeners.size, 1);
  assert.equal(showAttempts, 1);
  for (const listener of fake.settings.listeners) listener();
  assert.equal(settings, 1, "show failure must not discard the registered callback");

  await adapter.ready();
  assert.equal(showAttempts, 2);

  await remove();
  assert.equal(fake.settings.listeners.size, 0);
  assert.equal(
    fake.calls.filter((call) => call[0] === "settings" && call[1] === "hide").length,
    1,
  );
});

test("Telegram ready contains persistent SettingsButton visibility failures", async () => {
  const fake = fakeTelegram();
  let showAttempts = 0;
  fake.settings.api.show = function show() {
    showAttempts += 1;
    return Promise.reject(new Error("private persistent SettingsButton detail"));
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  let settings = 0;
  const remove = await adapter.onSettings(() => {
    settings += 1;
  });

  assert.equal(fake.settings.listeners.size, 1);
  assert.equal(showAttempts, 1);
  await assert.doesNotReject(() => adapter.ready());
  assert.equal(showAttempts, 2);
  for (const listener of fake.settings.listeners) listener();
  assert.equal(settings, 1);

  await remove();
  assert.equal(fake.settings.listeners.size, 0);
  assert.equal(
    fake.calls.filter((call) => call[0] === "settings" && call[1] === "hide").length,
    1,
  );
});

test("mobile runtime keeps Telegram BackButton subscribed while home is hidden", async () => {
  const fake = fakeTelegram();
  const platform = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    navigator: { onLine: true },
  });
  const runtime = createMobileRuntime({
    platform,
    snapshots: { load: async () => null, save: async () => {} },
    getState: () => ({}),
    applySnapshot: async () => {},
    onRestoreError: async () => {},
    onNetwork: async () => {},
    onDeepLink: async () => {},
    onBack: async () => true,
    pauseAudio: async () => {},
    resumeAudio: async () => {},
    onRuntimeError: async () => {},
  });

  await runtime.start();
  assert.equal(fake.back.listeners.size, 1);
  assert.equal(fake.calls.some((call) => call[0] === "back" && call[1] === "show"), false);
  await platform.setBackButtonVisible(true);
  assert.equal(fake.back.listeners.size, 1);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "show").length, 1);

  await runtime.stop();
  assert.equal(fake.back.listeners.size, 0);
  assert.equal(fake.calls.filter((call) => call[0] === "back" && call[1] === "hide").length, 1);
});

test("Telegram event cleanup contains failures and retries removal", async () => {
  const fake = fakeTelegram();
  const originalOffEvent = fake.webApp.offEvent;
  let attempts = 0;
  fake.webApp.offEvent = function offEvent(name, listener) {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(new Error("private event removal failure"));
    }
    return originalOffEvent.call(this, name, listener);
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const remove = await adapter.onThemeChange(() => {});

  const failed = remove();
  assert.equal(remove(), failed);
  await assert.rejects(failed, eventCleanupError);
  assert.equal(fake.events.get("themeChanged").size, 1);

  const retry = remove();
  assert.notEqual(retry, failed);
  assert.equal(remove(), retry);
  await retry;
  assert.equal(attempts, 2);
  assert.equal(fake.events.get("themeChanged").size, 0);
  assert.equal(remove(), retry);
});

test("mobile runtime retries failed Telegram lifecycle cleanup before restart", async () => {
  const fake = fakeTelegram();
  const originalOffEvent = fake.webApp.offEvent;
  let activatedRemovalAttempts = 0;
  fake.webApp.offEvent = function offEvent(name, listener) {
    if (name === "activated") {
      activatedRemovalAttempts += 1;
      if (activatedRemovalAttempts === 1) {
        return Promise.reject(new Error("private lifecycle removal failure"));
      }
    }
    return originalOffEvent.call(this, name, listener);
  };
  const platform = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    navigator: { onLine: true },
  });
  let activatedDeliveries = 0;
  const runtime = createMobileRuntime({
    platform,
    snapshots: {
      load: async () => null,
      save: async () => {},
    },
    getState: () => ({}),
    applySnapshot: async () => {},
    onRestoreError: async () => {},
    onNetwork: async () => {},
    onDeepLink: async () => {},
    onBack: async () => false,
    pauseAudio: async () => {},
    resumeAudio: async () => {
      activatedDeliveries += 1;
    },
    onRuntimeError: async () => {},
  });

  await runtime.start();
  await assert.rejects(runtime.stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ name, message }) => ({ name, message })), [
      eventCleanupError,
    ]);
    return true;
  });
  assert.equal(fake.events.get("activated").size, 1);

  await runtime.start();
  assert.equal(activatedRemovalAttempts, 2);
  assert.equal(fake.events.get("activated").size, 1);
  fake.emit("activated");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(activatedDeliveries, 1);

  await runtime.stop();
  assert.equal(fake.events.get("activated").size, 0);
});

test("Telegram lifecycle and theme events map and remove listeners", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const lifecycle = [];
  const themes = [];
  const removeLifecycle = await adapter.onLifecycleChange((state) => lifecycle.push(state));
  const removeTheme = await adapter.onThemeChange((theme) => themes.push(theme));

  assert.equal(adapter.getTheme(), "dark");
  fake.emit("deactivated");
  fake.emit("activated");
  fake.webApp.colorScheme = "light";
  fake.emit("themeChanged");
  assert.deepEqual(lifecycle, [{ active: false }, { active: true }]);
  assert.deepEqual(themes, ["light"]);

  await removeLifecycle();
  await removeTheme();
  assert.equal(fake.events.get("activated").size, 0);
  assert.equal(fake.events.get("deactivated").size, 0);
  assert.equal(fake.events.get("themeChanged").size, 0);
});

test("Telegram gates lifecycle events below version 8.0", async () => {
  const fake = fakeTelegram({ versionAtLeast: false });
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const lifecycle = [];

  const remove = await adapter.onLifecycleChange((state) => lifecycle.push(state));
  assert.ok(fake.calls.some((call) => call[0] === "version" && call[1] === "8.0"));
  assert.equal(fake.events.has("activated"), false);
  assert.equal(fake.events.has("deactivated"), false);
  fake.emit("activated");
  fake.emit("deactivated");
  assert.deepEqual(lifecycle, []);
  await assert.doesNotReject(() => remove());
});

test("Telegram viewport events expose state and update safe-area CSS variables", async () => {
  const fake = fakeTelegram();
  const providerReads = [];
  const webApp = new Proxy(fake.webApp, {
    get(target, property, receiver) {
      providerReads.push(property);
      return Reflect.get(target, property, receiver);
    },
  });
  const adapter = createTelegramPlatform({ webApp, window: fake.window });
  const viewports = [];
  const remove = await adapter.onViewportChange((viewport) => viewports.push(viewport));

  assert.equal(fake.events.get("viewportChanged").size, 1);
  assert.equal(fake.events.get("safeAreaChanged").size, 1);
  assert.equal(fake.events.get("contentSafeAreaChanged").size, 1);
  assert.equal(fake.css.get("--tg-viewport-height"), "640px");
  assert.equal(fake.css.get("--tg-viewport-stable-height"), "620px");
  assert.equal(fake.css.get("--tg-safe-area-inset-top"), "10px");
  assert.equal(fake.css.get("--tg-safe-area-inset-right"), "11px");
  assert.equal(fake.css.get("--tg-safe-area-inset-bottom"), "12px");
  assert.equal(fake.css.get("--tg-safe-area-inset-left"), "13px");
  assert.equal(fake.css.get("--tg-content-safe-area-inset-top"), "20px");
  assert.equal(fake.css.get("--tg-content-safe-area-inset-bottom"), "22px");
  assert.equal(providerReads.includes("isViewportStable"), false);

  fake.emit("safeAreaChanged");
  assert.equal(viewports.at(-1).isStateStable, false);

  fake.webApp.viewportHeight = 600;
  fake.webApp.viewportStableHeight = 590;
  fake.webApp.contentSafeAreaInset = { top: 30, right: 31, bottom: 32, left: 33 };
  fake.emit("viewportChanged", { isStateStable: true });
  fake.emit("contentSafeAreaChanged");
  assert.equal(fake.css.get("--tg-viewport-height"), "600px");
  assert.equal(fake.css.get("--tg-content-safe-area-inset-bottom"), "32px");
  assert.deepEqual(viewports.at(-1), {
    height: 600,
    stableHeight: 590,
    isExpanded: true,
    isStateStable: true,
    safeAreaInset: { top: 10, right: 11, bottom: 12, left: 13 },
    contentSafeAreaInset: { top: 30, right: 31, bottom: 32, left: 33 },
  });

  await remove();
  for (const name of [
    "viewportChanged",
    "safeAreaChanged",
    "contentSafeAreaChanged",
  ]) {
    assert.equal(fake.events.get(name).size, 0);
  }
});

test("Telegram ready expands, colors, and requests gated fullscreen", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });

  await adapter.ready();
  await adapter.setClosingConfirmation(true);
  await adapter.setClosingConfirmation(false);

  assert.deepEqual(fake.calls.filter(([name]) => [
    "ready",
    "expand",
    "header",
    "background",
    "fullscreen",
    "closing",
  ].includes(name)), [
    ["ready"],
    ["expand"],
    ["header", "#07111f"],
    ["background", "#07111f"],
    ["fullscreen"],
    ["closing", true],
    ["closing", false],
  ]);
  assert.ok(fake.calls.some((call) => call[0] === "version" && call[1] === "8.0"));
});

test("Telegram closing confirmation failures are redacted and reject", async () => {
  const fake = fakeTelegram();
  fake.webApp.enableClosingConfirmation = () => (
    Promise.reject(new Error("private closing-confirmation provider detail"))
  );
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });

  await assert.rejects(
    adapter.setClosingConfirmation(true),
    closingConfirmationError,
  );
  await assert.doesNotReject(() => adapter.setClosingConfirmation(false));
});

test("Telegram gates fullscreen and safe-area APIs below version 8.0", async () => {
  const fake = fakeTelegram({ versionAtLeast: false });
  let safeAreaReads = 0;
  Object.defineProperties(fake.webApp, {
    safeAreaInset: {
      configurable: true,
      get() {
        safeAreaReads += 1;
        return { top: 1, right: 1, bottom: 1, left: 1 };
      },
    },
    contentSafeAreaInset: {
      configurable: true,
      get() {
        safeAreaReads += 1;
        return { top: 1, right: 1, bottom: 1, left: 1 };
      },
    },
  });
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });

  await adapter.ready();
  const remove = await adapter.onViewportChange(() => {});
  assert.equal(fake.calls.some(([name]) => name === "fullscreen"), false);
  assert.equal(fake.events.has("safeAreaChanged"), false);
  assert.equal(fake.events.has("contentSafeAreaChanged"), false);
  assert.equal(safeAreaReads, 0);
  assert.equal(fake.css.has("--tg-safe-area-inset-top"), false);
  assert.equal(fake.css.get("--tg-viewport-height"), "640px");
  await remove();
});

test("Telegram maps semantic haptics and ignores unsupported feedback", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });

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
  assert.deepEqual(fake.calls.filter(([name]) => ["impact", "notification"].includes(name)), [
    ["impact", "light"],
    ["impact", "medium"],
    ["impact", "heavy"],
    ["notification", "warning"],
    ["notification", "success"],
    ["notification", "error"],
  ]);

  fake.webApp.HapticFeedback.impactOccurred = () => {
    throw new Error("unsupported");
  };
  await assert.doesNotReject(() => adapter.haptic("placement"));
});

test("Telegram shares natively, copies on failure, and routes external links", async () => {
  const fake = fakeTelegram();
  const clipboard = [];
  const navigator = {
    clipboard: { writeText: async (value) => clipboard.push(value) },
  };
  const adapter = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    navigator,
  });
  const payload = {
    title: "Salvo",
    text: "Join my battle",
    url: "https://t.me/agents_salvo_bot?startapp=room_ABCD",
  };

  assert.deepEqual(await adapter.share(payload), { shared: true, copied: false });
  const shareCall = fake.calls.find(([name, url]) => (
    name === "telegram-link" && new URL(url).pathname === "/share/url"
  ));
  const shareUrl = new URL(shareCall[1]);
  assert.equal(shareUrl.searchParams.get("url"), payload.url);
  assert.equal(shareUrl.searchParams.get("text"), payload.text);

  await adapter.openExternalUrl("https://t.me/agents_salvo_bot");
  await adapter.openExternalUrl("https://telegram.me/agents_salvo_bot?startapp=room_ABCD");
  await adapter.openExternalUrl("https://salvo.test/privacy");
  assert.ok(fake.calls.some((call) => (
    call[0] === "telegram-link" && call[1] === "https://t.me/agents_salvo_bot"
  )));
  assert.ok(fake.calls.some((call) => (
    call[0] === "link" && call[1] === "https://salvo.test/privacy"
  )));
  assert.ok(fake.calls.some((call) => (
    call[0] === "telegram-link"
    && call[1] === "https://t.me/agents_salvo_bot?startapp=room_ABCD"
  )));

  fake.webApp.openTelegramLink = () => {
    throw new Error("unsupported");
  };
  assert.deepEqual(await adapter.share(payload), { shared: false, copied: true });
  assert.deepEqual(clipboard, [payload.url]);
  navigator.clipboard.writeText = async () => Promise.reject(new Error("denied"));
  assert.deepEqual(await adapter.share(payload), { shared: false, copied: false });
});

test("Telegram preferences are prefixed while secure sessions stay in memory", async () => {
  const fake = fakeTelegram();
  const storage = storageHarness();
  const adapter = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    storage: storage.storage,
  });

  await adapter.settings.set("theme", "dark");
  assert.equal(await adapter.settings.get("theme"), "dark");
  await adapter.settings.set("theme", null);
  assert.equal(await adapter.settings.get("theme"), null);
  await adapter.secureSession.set("telegram-token");
  assert.equal(await adapter.secureSession.get(), "telegram-token");
  await adapter.secureSession.clear();
  assert.equal(await adapter.secureSession.get(), "");
  assert.deepEqual(storage.calls, [
    ["set", "salvo.theme", "dark"],
    ["get", "salvo.theme"],
    ["remove", "salvo.theme"],
    ["get", "salvo.theme"],
  ]);

  const nextLaunch = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    storage: storage.storage,
  });
  assert.equal(await nextLaunch.secureSession.get(), "");
});

test("Telegram settings reject blocked and quota storage with a stable error", async () => {
  const fake = fakeTelegram();
  const adapter = createTelegramPlatform({
    webApp: fake.webApp,
    window: fake.window,
    storage: {
      getItem() {
        throw new Error("private blocked-storage detail");
      },
      setItem() {
        return Promise.reject(new DOMException(
          "private quota detail",
          "QuotaExceededError",
        ));
      },
      removeItem() {
        throw new Error("private removal detail");
      },
    },
  });

  await assert.rejects(adapter.settings.get("theme"), settingsStorageError);
  await assert.rejects(adapter.settings.set("theme", "dark"), settingsStorageError);
  await assert.rejects(adapter.settings.set("theme", null), settingsStorageError);

  const snapshots = createLocalBattleSnapshotStore(adapter.settings);
  await assert.rejects(snapshots.load(), settingsStorageError);
  await assert.rejects(snapshots.clear(), settingsStorageError);
});

test("Telegram creation tolerates inaccessible global localStorage", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      delete globalThis.localStorage;
    }
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage blocked");
    },
  });

  let adapter;
  assert.doesNotThrow(() => {
    adapter = createTelegramPlatform({ webApp: {} });
  });
  await assert.rejects(adapter.settings.get("theme"), settingsStorageError);
  await assert.rejects(adapter.settings.set("theme", "dark"), settingsStorageError);
  await assert.rejects(adapter.settings.set("theme", null), settingsStorageError);
});

test("Telegram unavailable and throwing provider APIs remain safe", async () => {
  const unavailable = createTelegramPlatform({
    webApp: undefined,
    window: undefined,
    navigator: undefined,
    storage: undefined,
  });
  assert.equal(unavailable.isAvailable(), false);
  assert.equal(unavailable.getLaunchData(), "");
  assert.equal(unavailable.getStartParam(), "");
  assert.equal(unavailable.getTheme(), null);
  assert.deepEqual(await unavailable.getNetworkStatus(), {
    connected: true,
    connectionType: "unknown",
  });

  const failure = () => {
    throw new Error("provider failure");
  };
  const throwing = createTelegramPlatform({
    webApp: {
      get initData() { return failure(); },
      get initDataUnsafe() { return failure(); },
      get colorScheme() { return failure(); },
      get BackButton() { return failure(); },
      get SettingsButton() { return failure(); },
      get HapticFeedback() { return failure(); },
      isVersionAtLeast: failure,
      ready: failure,
      expand: failure,
      requestFullscreen: failure,
      setHeaderColor: failure,
      setBackgroundColor: failure,
      enableClosingConfirmation: failure,
      disableClosingConfirmation: failure,
      openTelegramLink: failure,
      openLink: failure,
      onEvent: failure,
      offEvent: failure,
    },
    window: {
      addEventListener: failure,
      removeEventListener: failure,
      open: failure,
      document: { documentElement: { style: { setProperty: failure } } },
    },
    navigator: {
      get onLine() { return failure(); },
      get clipboard() { return failure(); },
    },
    storage: {
      getItem: failure,
      setItem: failure,
      removeItem: failure,
    },
  });

  assert.equal(throwing.isAvailable(), false);
  assert.equal(throwing.getLaunchData(), "");
  assert.equal(throwing.getStartParam(), "");
  assert.equal(throwing.getTheme(), null);
  assert.doesNotThrow(() => throwing.getNetworkStatus());
  await assert.doesNotReject(() => throwing.ready());
  await assert.doesNotReject(() => throwing.setBackButtonVisible(true));
  await assert.doesNotReject(() => throwing.setBackButtonVisible(false));
  await assert.rejects(
    throwing.setClosingConfirmation(true),
    closingConfirmationError,
  );
  await assert.rejects(
    throwing.setClosingConfirmation(false),
    closingConfirmationError,
  );
  await assert.doesNotReject(() => throwing.haptic("hit"));
  await assert.doesNotReject(() => throwing.openExternalUrl("https://t.me/test"));
  await assert.doesNotReject(() => throwing.openExternalUrl("https://example.com"));
  assert.deepEqual(await throwing.share({ text: "x", url: "https://t.me/test" }), {
    shared: false,
    copied: false,
  });
  await assert.rejects(throwing.settings.get("theme"), settingsStorageError);
  await assert.rejects(throwing.settings.set("theme", "dark"), settingsStorageError);
  await assert.rejects(throwing.settings.set("theme", null), settingsStorageError);

  for (const subscribe of [
    throwing.onNetworkChange,
    throwing.onDeepLink,
    throwing.onBack,
    throwing.onSettings,
    throwing.onLifecycleChange,
    throwing.onThemeChange,
    throwing.onViewportChange,
  ]) {
    const remove = await subscribe(() => {});
    await assert.doesNotReject(async () => remove());
  }
});

test("Telegram invoice capability requires Bot API 6.1 and the native method", async () => {
  const supported = fakeTelegram();
  supported.webApp.openInvoice = () => {};
  const adapter = createTelegramPlatform({
    webApp: supported.webApp,
    window: supported.window,
  });

  assert.equal(adapter.supportsInvoice(), true);
  assert.ok(supported.calls.some(([name, version]) => (
    name === "version" && version === "6.1"
  )));

  const unavailable = fakeTelegram();
  const unavailableAdapter = createTelegramPlatform({
    webApp: unavailable.webApp,
    window: unavailable.window,
  });
  assert.equal(unavailableAdapter.supportsInvoice(), false);
  assert.deepEqual(
    await unavailableAdapter.openInvoice("https://t.me/$invoice"),
    { status: "unsupported" },
  );

  const oldVersion = fakeTelegram({ versionAtLeast: false });
  oldVersion.webApp.openInvoice = () => {
    oldVersion.calls.push(["invoice-opened"]);
  };
  const oldAdapter = createTelegramPlatform({
    webApp: oldVersion.webApp,
    window: oldVersion.window,
  });
  assert.equal(oldAdapter.supportsInvoice(), false);
  assert.deepEqual(
    await oldAdapter.openInvoice("https://t.me/$invoice"),
    { status: "unsupported" },
  );
  assert.equal(oldVersion.calls.some(([name]) => name === "invoice-opened"), false);
  assert.equal(oldVersion.calls.some(([name]) => name === "window-open"), false);
});

test("Telegram normalizes every documented invoice callback and settles once", async () => {
  for (const status of ["paid", "pending", "cancelled", "failed"]) {
    const fake = fakeTelegram();
    const timer = timerHarness();
    let callback;
    fake.webApp.openInvoice = (url, next) => {
      fake.calls.push(["invoice", url]);
      callback = next;
    };
    const adapter = createTelegramPlatform({
      webApp: fake.webApp,
      window: fake.window,
      invoiceTimeoutMs: 1234,
      setTimeoutFn: timer.setTimeout,
      clearTimeoutFn: timer.clearTimeout,
    });

    const resultPromise = adapter.openInvoice("https://t.me/$invoice_A-1");
    callback(status);
    callback(status === "paid" ? "failed" : "paid");
    assert.deepEqual(await resultPromise, { status });
    assert.deepEqual(fake.calls.filter(([name]) => name === "invoice"), [
      ["invoice", "https://t.me/$invoice_A-1"],
    ]);
    assert.deepEqual(timer.scheduled, [[1, 1234]]);
    assert.deepEqual(timer.cleared, [1]);
    assert.equal(timer.pending.size, 0);
    assert.equal(fake.calls.some(([name]) => name === "window-open"), false);
  }
});

test("Telegram accepts only exact primitive t.me invoice URLs", async () => {
  const fake = fakeTelegram();
  const opened = [];
  fake.webApp.openInvoice = (url, callback) => {
    opened.push(url);
    callback("paid");
  };
  const adapter = createTelegramPlatform({ webApp: fake.webApp, window: fake.window });
  const longToken = `${"a".repeat(512)}=`;
  const validUrls = [
    "https://t.me/$a",
    "https://t.me/$invoice_A-1=",
    "https://t.me/invoice/invoice_A-1=",
    `https://t.me/invoice/${longToken}`,
  ];
  for (const value of validUrls) {
    assert.deepEqual(await adapter.openInvoice(value), { status: "paid" });
  }
  for (const value of [
    new String("https://t.me/$invoice"),
    "http://t.me/$invoice",
    "https://telegram.me/$invoice",
    "https://T.ME/$invoice",
    "https://t.me:443/$invoice",
    "https://user@t.me/$invoice",
    "https://t.me/$invoice/",
    "https://t.me/$invoice?start=1",
    "https://t.me/$invoice#fragment",
    "https://t.me/$invoice.dot",
    "https://t.me/$invoice%20token",
    "https://t.me/$",
    "https://t.me/invoice/",
    `https://t.me/$${"a".repeat(2048)}`,
    null,
  ]) {
    assert.deepEqual(await adapter.openInvoice(value), { status: "unsupported" });
  }
  assert.deepEqual(opened, validUrls);
  assert.equal(fake.calls.some(([name]) => name === "window-open"), false);
});

test("Telegram fails closed for inaccessible invoice capabilities", async () => {
  const failure = () => {
    throw new Error("private provider secret");
  };
  for (const webApp of [
    {
      get isVersionAtLeast() { return failure(); },
      openInvoice() {},
    },
    {
      isVersionAtLeast: () => true,
      get openInvoice() { return failure(); },
    },
  ]) {
    const calls = [];
    const adapter = createTelegramPlatform({
      webApp,
      window: { open: (...args) => calls.push(args) },
    });
    assert.equal(adapter.supportsInvoice(), false);
    assert.deepEqual(
      await adapter.openInvoice("https://t.me/$invoice"),
      { status: "unsupported" },
    );
    assert.deepEqual(calls, []);
  }
});

test("Telegram normalizes provider failures, unknown callbacks, and timeouts", async () => {
  const thrown = fakeTelegram();
  thrown.webApp.openInvoice = () => {
    throw new Error("private invoice provider detail");
  };
  const thrownAdapter = createTelegramPlatform({
    webApp: thrown.webApp,
    window: thrown.window,
  });
  assert.deepEqual(
    await thrownAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );

  const unknown = fakeTelegram();
  unknown.webApp.openInvoice = (_url, callback) => callback("PAID");
  const unknownAdapter = createTelegramPlatform({
    webApp: unknown.webApp,
    window: unknown.window,
  });
  assert.deepEqual(
    await unknownAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );

  const omitted = fakeTelegram();
  const timer = timerHarness();
  let lateCallback;
  omitted.webApp.openInvoice = (_url, callback) => {
    lateCallback = callback;
  };
  const omittedAdapter = createTelegramPlatform({
    webApp: omitted.webApp,
    window: omitted.window,
    invoiceTimeoutMs: 25,
    setTimeoutFn: timer.setTimeout,
    clearTimeoutFn: timer.clearTimeout,
  });
  const timedOut = omittedAdapter.openInvoice("https://t.me/$invoice");
  timer.fire();
  assert.deepEqual(await timedOut, { status: "failed" });
  lateCallback("paid");
  assert.deepEqual(timer.scheduled, [[1, 25]]);
  assert.deepEqual(timer.cleared, [1]);
  assert.equal(timer.pending.size, 0);
  assert.equal(omitted.calls.some(([name]) => name === "window-open"), false);
});

test("Telegram bounds invoice timers and contains timer plumbing failures", async () => {
  const bounded = fakeTelegram();
  const boundedTimer = timerHarness();
  bounded.webApp.openInvoice = () => {};
  const boundedAdapter = createTelegramPlatform({
    webApp: bounded.webApp,
    invoiceTimeoutMs: Number.POSITIVE_INFINITY,
    setTimeoutFn: boundedTimer.setTimeout,
    clearTimeoutFn: boundedTimer.clearTimeout,
  });
  const boundedResult = boundedAdapter.openInvoice("https://t.me/$invoice");
  assert.deepEqual(boundedTimer.scheduled, [[1, 5 * 60 * 1000]]);
  boundedTimer.fire();
  assert.deepEqual(await boundedResult, { status: "failed" });

  const missingTimer = fakeTelegram();
  let missingTimerOpened = false;
  missingTimer.webApp.openInvoice = () => {
    missingTimerOpened = true;
  };
  const missingTimerAdapter = createTelegramPlatform({
    webApp: missingTimer.webApp,
    setTimeoutFn: null,
  });
  assert.deepEqual(
    await missingTimerAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );
  assert.equal(missingTimerOpened, false);

  const throwingTimer = fakeTelegram();
  throwingTimer.webApp.openInvoice = () => {
    throw new Error("provider must not be reached");
  };
  const throwingTimerAdapter = createTelegramPlatform({
    webApp: throwingTimer.webApp,
    setTimeoutFn() {
      throw new Error("private timer detail");
    },
    clearTimeoutFn() {},
  });
  assert.deepEqual(
    await throwingTimerAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );

  const throwingClear = fakeTelegram();
  throwingClear.webApp.openInvoice = (_url, callback) => callback("paid");
  const throwingClearAdapter = createTelegramPlatform({
    webApp: throwingClear.webApp,
    setTimeoutFn: () => 7,
    clearTimeoutFn() {
      throw new Error("private clear detail");
    },
  });
  assert.deepEqual(
    await throwingClearAdapter.openInvoice("https://t.me/$invoice"),
    { status: "paid" },
  );

  const synchronousTimer = fakeTelegram();
  let synchronousTimerOpened = false;
  let synchronousTimerCleared = false;
  synchronousTimer.webApp.openInvoice = () => {
    synchronousTimerOpened = true;
  };
  const synchronousTimerAdapter = createTelegramPlatform({
    webApp: synchronousTimer.webApp,
    setTimeoutFn(callback) {
      callback();
      return 9;
    },
    clearTimeoutFn(id) {
      synchronousTimerCleared = id === 9;
    },
  });
  assert.deepEqual(
    await synchronousTimerAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );
  assert.equal(synchronousTimerOpened, false);
  assert.equal(synchronousTimerCleared, true);

  const rejectedProvider = fakeTelegram();
  const rejectedTimer = timerHarness();
  rejectedProvider.webApp.openInvoice = () => Promise.reject(
    new Error("private asynchronous provider detail"),
  );
  const rejectedProviderAdapter = createTelegramPlatform({
    webApp: rejectedProvider.webApp,
    setTimeoutFn: rejectedTimer.setTimeout,
    clearTimeoutFn: rejectedTimer.clearTimeout,
  });
  assert.deepEqual(
    await rejectedProviderAdapter.openInvoice("https://t.me/$invoice"),
    { status: "failed" },
  );
  assert.equal(rejectedTimer.pending.size, 0);

  const customCatch = fakeTelegram();
  const customCatchTimer = timerHarness();
  let customCatchCalls = 0;
  customCatch.webApp.openInvoice = () => ({
    catch() {
      customCatchCalls += 1;
      return Promise.reject(new Error("private provider catch detail"));
    },
  });
  const customCatchAdapter = createTelegramPlatform({
    webApp: customCatch.webApp,
    setTimeoutFn: customCatchTimer.setTimeout,
    clearTimeoutFn: customCatchTimer.clearTimeout,
  });
  const customCatchResult = customCatchAdapter.openInvoice("https://t.me/$invoice");
  assert.equal(customCatchCalls, 0, "provider return values are assimilated without invoking .catch directly");
  customCatchTimer.fire();
  assert.deepEqual(await customCatchResult, { status: "failed" });
});
