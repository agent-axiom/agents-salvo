import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.agentaxiom.salvo",
  appName: "Salvo",
  webDir: "dist",
  android: { backgroundColor: "#071224" },
  ios: { backgroundColor: "#071224", contentInset: "never" },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#071224",
      showSpinner: false,
    },
    SystemBars: {
      insetsHandling: "css",
      style: "DEFAULT",
      hidden: false,
      animation: "NONE",
    },
  },
};
export default config;
