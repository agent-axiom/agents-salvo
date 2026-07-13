import { Capacitor, SystemBars } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Haptics } from "@capacitor/haptics";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";

const defaultPlugins = {
  Capacitor,
  App,
  Browser,
  Haptics,
  Network,
  Preferences,
  Share,
  SplashScreen,
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
    SystemBars: systemBars,
  } = plugins;

  return {
    isNative: () => true,
    getPlatform: () => capacitor.getPlatform(),
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
    async onDeepLink(listener) {
      const startupUrls = new Set();
      let startup = true;
      const handle = await app.addListener("appUrlOpen", (event) => {
        const url = event?.url;
        if (typeof url !== "string") return;
        if (startup) startupUrls.add(url);
        listener(url);
      });

      const launchEvent = await app.getLaunchUrl();
      startup = false;
      const launchUrl = launchEvent?.url;
      if (typeof launchUrl === "string" && !startupUrls.has(launchUrl)) {
        listener(launchUrl);
      }

      return () => handle.remove();
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
    secureSession: {
      get: unavailableSecureSession,
      set: unavailableSecureSession,
      clear: unavailableSecureSession,
    },
  };
}
