const impactByEvent = {
  placement: "light",
  hit: "medium",
  sunk: "heavy",
};

const notificationByEvent = {
  invalid: "warning",
  victory: "success",
  defeat: "error",
};

const colorsByTheme = {
  light: "#f4ecdc",
  dark: "#07111f",
};

const insetSides = ["top", "right", "bottom", "left"];
const settingsStorageErrorMessage = "Settings storage unavailable";
const resolvedCleanup = Promise.resolve();

function noOp() {}

function noOpCleanup() {
  return resolvedCleanup;
}

function readOr(getValue, fallback) {
  try {
    return getValue();
  } catch {
    return fallback;
  }
}

function callOptional(target, name, ...args) {
  try {
    const method = target?.[name];
    if (typeof method !== "function") return false;
    const result = method.apply(target, args);
    if (result && typeof result.catch === "function") result.catch(noOp);
    return true;
  } catch {
    return false;
  }
}

async function callOptionalAsync(target, name, ...args) {
  try {
    const method = target?.[name];
    if (typeof method !== "function") return false;
    await method.apply(target, args);
    return true;
  } catch {
    return false;
  }
}

function invokeListener(listener, value) {
  try {
    void Promise.resolve(listener(value)).catch(noOp);
  } catch {
    // Runtime callbacks must not escape into the Telegram provider.
  }
}

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readInsets(webApp, name) {
  const source = readOr(() => webApp?.[name], null);
  return Object.fromEntries(insetSides.map((side) => [
    side,
    numericValue(readOr(() => source?.[side], 0)),
  ]));
}

function normalizeTelegramUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "telegram.me") url.hostname = "t.me";
    if (url.hostname !== "t.me") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function createRetryableCleanup(entries, remove) {
  let active = [...entries];
  let inFlight = null;
  let completed = null;

  return () => {
    if (completed) return completed;
    if (inFlight) return inFlight;

    const attempt = (async () => {
      const failed = [];
      for (const entry of active) {
        if (!(await remove(entry))) failed.push(entry);
      }
      active = failed;
    })();
    let tracked;
    tracked = attempt.finally(() => {
      inFlight = null;
      if (active.length === 0) completed = tracked;
    });
    inFlight = tracked;
    return tracked;
  };
}

async function subscribeEvents(webApp, registrations) {
  const active = [];
  const remove = ([name, listener]) => (
    callOptionalAsync(webApp, "offEvent", name, listener)
  );
  for (const [name, listener] of registrations) {
    if (!(await callOptionalAsync(webApp, "onEvent", name, listener))) {
      if (active.length === 0) return noOpCleanup;
      const cleanup = createRetryableCleanup(active, remove);
      await cleanup();
      return cleanup;
    }
    active.push([name, listener]);
  }
  if (active.length === 0) return noOpCleanup;

  return createRetryableCleanup(active, remove);
}

function createButtonSubscriptions(getButton) {
  let button = null;
  let activeCount = 0;
  let visible = false;
  let showInFlight = null;

  const resolveButton = () => {
    if (button) return button;
    button = readOr(getButton, null);
    return button;
  };

  const ensureShown = async () => {
    if (visible) return;
    if (!showInFlight) {
      showInFlight = callOptionalAsync(button, "show").then((shown) => {
        if (shown) visible = true;
      }).finally(() => {
        showInFlight = null;
      });
    }
    await showInFlight;
  };

  return async (listener) => {
    const providerButton = resolveButton();
    const callback = () => invokeListener(listener);
    if (!(await callOptionalAsync(providerButton, "onClick", callback))) {
      return noOpCleanup;
    }

    activeCount += 1;
    await ensureShown();
    let active = true;
    let inFlight = null;
    let completed = null;

    return () => {
      if (completed) return completed;
      if (inFlight) return inFlight;

      const attempt = (async () => {
        if (!(await callOptionalAsync(providerButton, "offClick", callback))) return;
        active = false;
        activeCount -= 1;
        if (activeCount === 0 && visible) {
          if (await callOptionalAsync(providerButton, "hide")) visible = false;
        }
      })();
      let tracked;
      tracked = attempt.finally(() => {
        inFlight = null;
        if (!active) completed = tracked;
      });
      inFlight = tracked;
      return tracked;
    };
  };
}

export function createTelegramPlatform({
  webApp,
  window: host = globalThis.window,
  navigator: nav = globalThis.navigator,
  storage,
} = {}) {
  let sessionToken = "";
  const settingsStorage = storage === undefined
    ? readOr(() => globalThis.localStorage, null)
    : storage;

  const launchData = () => {
    const value = readOr(() => webApp?.initData, "");
    return typeof value === "string" ? value : "";
  };

  const getTheme = () => {
    const value = readOr(() => webApp?.colorScheme, null);
    return value === "light" || value === "dark" ? value : null;
  };

  const supportsVersion8 = () => readOr(
    () => webApp?.isVersionAtLeast?.("8.0") === true,
    false,
  );

  const getStyle = () => readOr(
    () => host?.document?.documentElement?.style,
    null,
  );

  const setCssPixelValue = (name, value) => {
    callOptional(getStyle(), "setProperty", name, `${numericValue(value)}px`);
  };

  const viewportSnapshot = (safeAreaSupported, isStateStable) => ({
    height: numericValue(readOr(() => webApp?.viewportHeight, 0)),
    stableHeight: numericValue(readOr(() => webApp?.viewportStableHeight, 0)),
    isExpanded: readOr(() => webApp?.isExpanded === true, false),
    isStateStable,
    safeAreaInset: safeAreaSupported ? readInsets(webApp, "safeAreaInset") : null,
    contentSafeAreaInset: safeAreaSupported
      ? readInsets(webApp, "contentSafeAreaInset")
      : null,
  });

  const updateViewportCss = (safeAreaSupported) => {
    setCssPixelValue(
      "--tg-viewport-height",
      readOr(() => webApp?.viewportHeight, 0),
    );
    setCssPixelValue(
      "--tg-viewport-stable-height",
      readOr(() => webApp?.viewportStableHeight, 0),
    );
    if (!safeAreaSupported) return;

    for (const [property, value] of [
      ["safe-area-inset", readInsets(webApp, "safeAreaInset")],
      ["content-safe-area-inset", readInsets(webApp, "contentSafeAreaInset")],
    ]) {
      for (const side of insetSides) {
        setCssPixelValue(`--tg-${property}-${side}`, value[side]);
      }
    }
  };

  const networkStatus = () => {
    const connected = readOr(() => nav?.onLine, true) !== false;
    return {
      connected,
      connectionType: connected ? "unknown" : "none",
    };
  };

  const useSettingsStorage = async (operation) => {
    try {
      return await operation(settingsStorage);
    } catch {
      throw new Error(settingsStorageErrorMessage);
    }
  };

  const backButtonSubscriptions = createButtonSubscriptions(
    () => webApp?.BackButton,
  );
  const settingsButtonSubscriptions = createButtonSubscriptions(
    () => webApp?.SettingsButton,
  );

  return {
    isNative: () => false,
    getPlatform: () => "telegram",
    isAvailable: () => launchData().length > 0,
    getLaunchData: launchData,
    getStartParam() {
      const value = readOr(() => webApp?.initDataUnsafe?.start_param, "");
      return typeof value === "string" ? value : "";
    },
    getNetworkStatus: async () => networkStatus(),
    async onNetworkChange(listener) {
      const online = () => invokeListener(listener, {
        connected: true,
        connectionType: "unknown",
      });
      const offline = () => invokeListener(listener, {
        connected: false,
        connectionType: "none",
      });
      const onlineRegistered = callOptional(host, "addEventListener", "online", online);
      const offlineRegistered = callOptional(host, "addEventListener", "offline", offline);
      let removed = false;

      return () => {
        if (removed) return;
        removed = true;
        if (onlineRegistered) {
          callOptional(host, "removeEventListener", "online", online);
        }
        if (offlineRegistered) {
          callOptional(host, "removeEventListener", "offline", offline);
        }
      };
    },
    async share(payload) {
      if (typeof payload?.url !== "string" || payload.url.length === 0) {
        return { shared: false };
      }

      const shareUrl = new URL("https://t.me/share/url");
      shareUrl.searchParams.set("url", payload.url);
      if (typeof payload.text === "string" && payload.text.length > 0) {
        shareUrl.searchParams.set("text", payload.text);
      }
      if (await callOptionalAsync(webApp, "openTelegramLink", shareUrl.toString())) {
        return { shared: true };
      }

      const clipboard = readOr(() => nav?.clipboard, null);
      if (await callOptionalAsync(clipboard, "writeText", payload.url)) {
        return { shared: true };
      }
      return { shared: false };
    },
    async haptic(event) {
      const feedback = readOr(() => webApp?.HapticFeedback, null);
      const impact = impactByEvent[event];
      if (impact) {
        await callOptionalAsync(feedback, "impactOccurred", impact);
        return;
      }

      const notification = notificationByEvent[event];
      if (notification) {
        await callOptionalAsync(feedback, "notificationOccurred", notification);
      }
    },
    async openExternalUrl(url) {
      const telegramUrl = normalizeTelegramUrl(url);
      const method = telegramUrl ? "openTelegramLink" : "openLink";
      if (await callOptionalAsync(webApp, method, telegramUrl ?? url)) return;
      await callOptionalAsync(host, "open", url, "_blank", "noopener,noreferrer");
    },
    closeExternalUrl: async () => {},
    onDeepLink: async () => noOpCleanup,
    async onBack(listener) {
      return backButtonSubscriptions(listener);
    },
    async onLifecycleChange(listener) {
      if (!supportsVersion8()) return noOpCleanup;
      return subscribeEvents(webApp, [
        ["activated", () => invokeListener(listener, { active: true })],
        ["deactivated", () => invokeListener(listener, { active: false })],
      ]);
    },
    async onSettings(listener) {
      return settingsButtonSubscriptions(listener);
    },
    async ready() {
      await callOptionalAsync(webApp, "ready");
      await callOptionalAsync(webApp, "expand");
      const color = colorsByTheme[getTheme()] ?? colorsByTheme.light;
      await callOptionalAsync(webApp, "setHeaderColor", color);
      await callOptionalAsync(webApp, "setBackgroundColor", color);
      const safeAreaSupported = supportsVersion8();
      updateViewportCss(safeAreaSupported);
      if (safeAreaSupported) await callOptionalAsync(webApp, "requestFullscreen");
    },
    async setClosingConfirmation(enabled) {
      await callOptionalAsync(
        webApp,
        enabled ? "enableClosingConfirmation" : "disableClosingConfirmation",
      );
    },
    getTheme,
    async onThemeChange(listener) {
      return subscribeEvents(webApp, [[
        "themeChanged",
        () => invokeListener(listener, getTheme()),
      ]]);
    },
    async onViewportChange(listener) {
      const safeAreaSupported = supportsVersion8();
      let isStateStable = false;
      const notify = (event) => {
        const eventState = readOr(() => event?.isStateStable, undefined);
        if (typeof eventState === "boolean") isStateStable = eventState;
        updateViewportCss(safeAreaSupported);
        invokeListener(listener, viewportSnapshot(safeAreaSupported, isStateStable));
      };
      updateViewportCss(safeAreaSupported);
      const registrations = [["viewportChanged", notify]];
      if (safeAreaSupported) {
        registrations.push(
          ["safeAreaChanged", notify],
          ["contentSafeAreaChanged", notify],
        );
      }
      return subscribeEvents(webApp, registrations);
    },
    hideSplash: async () => {},
    configureSystemBars: async () => {},
    settings: {
      async get(key) {
        return useSettingsStorage(async (provider) => {
          if (typeof provider?.getItem !== "function") {
            throw new Error(settingsStorageErrorMessage);
          }
          const value = await provider.getItem(`salvo.${key}`);
          return typeof value === "string" ? value : null;
        });
      },
      async set(key, value) {
        return useSettingsStorage(async (provider) => {
          const storageKey = `salvo.${key}`;
          if (value === null) {
            if (typeof provider?.removeItem !== "function") {
              throw new Error(settingsStorageErrorMessage);
            }
            await provider.removeItem(storageKey);
            return;
          }
          if (typeof provider?.setItem !== "function") {
            throw new Error(settingsStorageErrorMessage);
          }
          await provider.setItem(storageKey, String(value));
        });
      },
    },
    secureSession: {
      get: async () => sessionToken,
      async set(token) {
        sessionToken = typeof token === "string" ? token : String(token ?? "");
      },
      async clear() {
        sessionToken = "";
      },
    },
  };
}
