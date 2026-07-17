import { Capacitor, SystemBars } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Haptics } from "@capacitor/haptics";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

const secureSessionKey = "salvo.authToken";

const defaultPlugins = {
  Capacitor,
  App,
  Browser,
  Haptics,
  Network,
  Preferences,
  Share,
  SplashScreen,
  SecureStorage,
  SystemBars,
};

const impactByEvent = {
  placement: "LIGHT",
  hit: "MEDIUM",
  sunk: "HEAVY",
};

const notificationByEvent = {
  invalid: "WARNING",
  victory: "SUCCESS",
  defeat: "ERROR",
};

async function subscribe(registration) {
  const handle = await registration;
  return () => handle.remove();
}

async function unavailableSecureSession() {
  throw new Error("Secure session storage unavailable");
}

function createSecureSession(secureStorage) {
  if (
    typeof secureStorage?.getItem !== "function"
    || typeof secureStorage?.setItem !== "function"
    || typeof secureStorage?.removeItem !== "function"
  ) {
    return {
      get: unavailableSecureSession,
      set: unavailableSecureSession,
      clear: unavailableSecureSession,
    };
  }

  return {
    async get() {
      const value = await secureStorage.getItem(secureSessionKey);
      return typeof value === "string" ? value : "";
    },
    set: (token) => secureStorage.setItem(secureSessionKey, token),
    clear: () => secureStorage.removeItem(secureSessionKey),
  };
}

function invokeObserved(listener, value) {
  try {
    void Promise.resolve(listener(value)).catch(() => {});
    return null;
  } catch (error) {
    return { error };
  }
}

export function createNativePlatform(plugins = defaultPlugins) {
  const {
    Capacitor: capacitor,
    App: app,
    Browser: browser,
    Haptics: haptics,
    Network: network,
    Preferences: preferences,
    Share: sharePlugin,
    SplashScreen: splashScreen,
    SecureStorage: secureStorage,
    SystemBars: systemBars,
  } = plugins;

  return {
    isNative: () => true,
    getPlatform: () => capacitor.getPlatform(),
    isAvailable: () => true,
    getLaunchData: () => "",
    getStartParam: () => "",
    getNetworkStatus: () => network.getStatus(),
    onNetworkChange: (listener) => subscribe(
      network.addListener("networkStatusChange", listener),
    ),
    async share(payload) {
      try {
        await sharePlugin.share(payload);
        return { shared: true };
      } catch {
        return { shared: false };
      }
    },
    async haptic(event) {
      try {
        const style = impactByEvent[event];
        if (style) {
          await haptics.impact({ style });
          return;
        }

        const type = notificationByEvent[event];
        if (type) await haptics.notification({ type });
      } catch {
        // Haptics are optional on unsupported devices.
      }
    },
    openExternalUrl: (url) => browser.open({ url }),
    closeExternalUrl: () => browser.close(),
    async onDeepLink(listener) {
      const startupUrls = new Set();
      let state = "startup";
      let startupFailure = null;
      const handle = await app.addListener("appUrlOpen", (event) => {
        if (state === "closed") return;
        const url = event?.url;
        if (typeof url !== "string") return;
        if (state === "startup") startupUrls.add(url);

        const failure = invokeObserved(listener, url);
        if (state === "startup" && failure && startupFailure === null) {
          startupFailure = failure;
        }
      });

      let cleanupPromise = null;
      const cleanup = () => {
        if (cleanupPromise) return cleanupPromise;
        state = "closed";
        cleanupPromise = Promise.resolve().then(() => handle.remove());
        return cleanupPromise;
      };

      try {
        if (startupFailure) throw startupFailure.error;
        const launchEvent = await app.getLaunchUrl();
        if (startupFailure) throw startupFailure.error;

        const launchUrl = launchEvent?.url;
        if (typeof launchUrl === "string" && !startupUrls.has(launchUrl)) {
          const failure = invokeObserved(listener, launchUrl);
          if (failure) throw failure.error;
        }
        if (startupFailure) throw startupFailure.error;

        state = "active";
        return cleanup;
      } catch (error) {
        try {
          await cleanup();
        } catch {
          // Preserve the initialization failure if cleanup also fails.
        }
        throw error;
      }
    },
    onBack: (listener) => subscribe(app.addListener(
      "backButton",
      async (event) => {
        let handled;
        try {
          handled = await listener(event);
        } catch {
          return;
        }
        if (handled === false) await app.exitApp();
      },
    )),
    onLifecycleChange: (listener) => subscribe(app.addListener(
      "appStateChange",
      (event) => listener({ active: Boolean(event?.isActive) }),
    )),
    onSettings: async () => () => {},
    ready: async () => {},
    setBackButtonVisible: async () => {},
    setClosingConfirmation: async () => {},
    getTheme: () => null,
    onThemeChange: async () => () => {},
    onViewportChange: async () => () => {},
    async hideSplash() {
      try {
        await splashScreen.hide();
      } catch {
        // Splash setup is best-effort on unsupported platforms.
      }
    },
    async configureSystemBars() {
      try {
        await systemBars.show();
      } catch {
        // System bars are best-effort on unsupported platforms.
      }
    },
    settings: {
      async get(key) {
        const result = await preferences.get({ key: `salvo.${key}` });
        return result.value;
      },
      async set(key, value) {
        const storageKey = `salvo.${key}`;
        if (value === null) {
          await preferences.remove({ key: storageKey });
          return;
        }
        await preferences.set({ key: storageKey, value: String(value) });
      },
    },
    secureSession: createSecureSession(secureStorage),
  };
}
