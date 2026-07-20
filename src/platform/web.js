export function createWebPlatform({
  window: host = globalThis.window,
  navigator: nav = globalThis.navigator,
  storage = globalThis.localStorage,
} = {}) {
  return {
    isNative: () => false,
    getPlatform: () => "web",
    isAvailable: () => true,
    getLaunchData: () => "",
    getStartParam: () => "",
    getNetworkStatus: async () => ({
      connected: nav?.onLine !== false,
      connectionType: nav?.onLine === false ? "none" : "unknown",
    }),
    async onNetworkChange(listener) {
      const online = () => listener({
        connected: true,
        connectionType: "unknown",
      });
      const offline = () => listener({
        connected: false,
        connectionType: "none",
      });
      host.addEventListener("online", online);
      host.addEventListener("offline", offline);

      return () => {
        host.removeEventListener("online", online);
        host.removeEventListener("offline", offline);
      };
    },
    async share(payload) {
      if (typeof nav?.share !== "function") return { shared: false };

      try {
        await nav.share(payload);
        return { shared: true };
      } catch {
        return { shared: false };
      }
    },
    haptic: async () => {},
    async openExternalUrl(url) {
      host?.open?.(url, "_blank", "noopener,noreferrer");
    },
    supportsInvoice: () => false,
    openInvoice: async () => ({ status: "unsupported" }),
    closeExternalUrl: async () => {},
    onDeepLink: async () => () => {},
    onBack: async () => () => {},
    onLifecycleChange: async () => () => {},
    onSettings: async () => () => {},
    ready: async () => {},
    setBackButtonVisible: async () => {},
    setClosingConfirmation: async () => {},
    getTheme: () => null,
    onThemeChange: async () => () => {},
    onViewportChange: async () => () => {},
    hideSplash: async () => {},
    configureSystemBars: async () => {},
    settings: {
      get: async (key) => storage.getItem(`salvo.${key}`),
      async set(key, value) {
        const storageKey = `salvo.${key}`;
        if (value === null) {
          storage.removeItem(storageKey);
          return;
        }
        storage.setItem(storageKey, String(value));
      },
    },
    secureSession: {
      get: async () => storage.getItem("salvo.authToken") ?? "",
      set: async (token) => storage.setItem("salvo.authToken", token),
      clear: async () => storage.removeItem("salvo.authToken"),
    },
  };
}
