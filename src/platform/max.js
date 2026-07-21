import { createWebPlatform } from "./web.js";

const secureSessionKey = "salvo.authToken";

export function createMaxPlatform({
  webApp = globalThis.window?.WebApp,
  window: host = globalThis.window,
  navigator: nav = globalThis.navigator,
  storage = globalThis.localStorage,
} = {}) {
  const web = createWebPlatform({ window: host, navigator: nav, storage });
  let sessionToken = "";
  const launchData = () => {
    try {
      return typeof webApp?.initData === "string" ? webApp.initData : "";
    } catch {
      return "";
    }
  };
  const networkStatus = () => {
    // MAX WebView can report navigator.onLine=false while its bridge and API remain reachable.
    const connected = launchData().length > 0 || nav?.onLine !== false;
    return {
      connected,
      connectionType: connected ? "unknown" : "none",
    };
  };

  return {
    ...web,
    getPlatform: () => "max",
    isAvailable: () => launchData().length > 0,
    getLaunchData: launchData,
    getStartParam: () => typeof webApp?.initDataUnsafe?.start_param === "string"
      ? webApp.initDataUnsafe.start_param
      : "",
    getNetworkStatus: async () => networkStatus(),
    async onNetworkChange(listener) {
      const update = () => listener(networkStatus());
      host?.addEventListener?.("online", update);
      host?.addEventListener?.("offline", update);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        host?.removeEventListener?.("online", update);
        host?.removeEventListener?.("offline", update);
      };
    },
    async share({ text = "", url = "" } = {}) {
      const payload = {
        ...(text ? { text } : {}),
        ...(url ? { link: url } : {}),
      };
      if (Object.keys(payload).length === 0) return { shared: false };
      try {
        if (typeof webApp?.shareMaxContent === "function") {
          await webApp.shareMaxContent(payload);
          return { shared: true };
        }
        const message = [text, url].filter(Boolean).join("\n");
        const shareUrl = `https://max.ru/:share?${new URLSearchParams({ text: message })}`;
        if (typeof webApp?.openMaxLink === "function") {
          await webApp.openMaxLink(shareUrl);
          return { shared: true };
        }
      } catch {}
      return web.share({ text, url });
    },
    async haptic(kind) {
      try {
        if (["victory", "success"].includes(kind)) {
          await webApp?.HapticFeedback?.notificationOccurred?.("success");
        } else if (["defeat", "error"].includes(kind)) {
          await webApp?.HapticFeedback?.notificationOccurred?.("error");
        } else if (["sunk", "warning"].includes(kind)) {
          await webApp?.HapticFeedback?.notificationOccurred?.("warning");
        } else {
          const style = kind === "shot" || kind === "click" ? "light" : "medium";
          await webApp?.HapticFeedback?.impactOccurred?.(style);
        }
      } catch {}
    },
    async openExternalUrl(url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" && parsed.hostname === "max.ru"
          && typeof webApp?.openMaxLink === "function") {
          await webApp.openMaxLink(url);
          return;
        }
        if (typeof webApp?.openLink === "function") {
          await webApp.openLink(url);
          return;
        }
      } catch {}
      await web.openExternalUrl(url);
    },
    async onBack(listener) {
      if (typeof webApp?.BackButton?.onClick !== "function") return () => {};
      await webApp.BackButton.onClick(listener);
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        await webApp.BackButton.offClick?.(listener);
        await webApp.BackButton.hide?.();
      };
    },
    async setBackButtonVisible(visible) {
      try {
        await webApp?.BackButton?.[visible ? "show" : "hide"]?.();
      } catch {}
    },
    async setClosingConfirmation(enabled) {
      try {
        await webApp?.[enabled
          ? "enableClosingConfirmation"
          : "disableClosingConfirmation"]?.();
      } catch {}
    },
    secureSession: {
      async get() {
        const secure = secureStorage(webApp);
        if (!secure) return sessionToken;
        try {
          const result = await secure.getItem(secureSessionKey);
          sessionToken = typeof result === "string" ? result : result?.value ?? "";
        } catch {}
        return sessionToken;
      },
      async set(token) {
        sessionToken = typeof token === "string" ? token : String(token ?? "");
        try {
          await secureStorage(webApp)?.setItem(secureSessionKey, sessionToken);
        } catch {}
      },
      async clear() {
        sessionToken = "";
        try {
          await secureStorage(webApp)?.removeItem(secureSessionKey);
        } catch {}
      },
    },
  };
}

function secureStorage(webApp) {
  const secure = webApp?.SecureStorage;
  if (
    typeof secure?.getItem !== "function"
    || typeof secure?.setItem !== "function"
    || typeof secure?.removeItem !== "function"
  ) {
    return null;
  }
  return secure;
}
