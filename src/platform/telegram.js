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

function noOp() {}

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

function isTelegramUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "t.me" || url.hostname === "telegram.me"
    );
  } catch {
    return false;
  }
}

function subscribeEvents(webApp, registrations) {
  const active = [];
  for (const [name, listener] of registrations) {
    if (callOptional(webApp, "onEvent", name, listener)) {
      active.push([name, listener]);
    }
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const [name, listener] of active) {
      callOptional(webApp, "offEvent", name, listener);
    }
  };
}

function subscribeButton(button, listener) {
  const callback = () => invokeListener(listener);
  if (!callOptional(button, "onClick", callback)) return noOp;
  callOptional(button, "show");

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    callOptional(button, "offClick", callback);
    callOptional(button, "hide");
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
      const method = isTelegramUrl(url) ? "openTelegramLink" : "openLink";
      if (await callOptionalAsync(webApp, method, url)) return;
      await callOptionalAsync(host, "open", url, "_blank", "noopener,noreferrer");
    },
    closeExternalUrl: async () => {},
    onDeepLink: async () => noOp,
    async onBack(listener) {
      return subscribeButton(readOr(() => webApp?.BackButton, null), listener);
    },
    async onLifecycleChange(listener) {
      if (!supportsVersion8()) return noOp;
      return subscribeEvents(webApp, [
        ["activated", () => invokeListener(listener, { active: true })],
        ["deactivated", () => invokeListener(listener, { active: false })],
      ]);
    },
    async onSettings(listener) {
      return subscribeButton(readOr(() => webApp?.SettingsButton, null), listener);
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
        const value = readOr(() => settingsStorage?.getItem(`salvo.${key}`), null);
        return typeof value === "string" ? value : null;
      },
      async set(key, value) {
        const storageKey = `salvo.${key}`;
        if (value === null) {
          callOptional(settingsStorage, "removeItem", storageKey);
          return;
        }
        callOptional(settingsStorage, "setItem", storageKey, String(value));
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
