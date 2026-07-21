import { Capacitor } from "@capacitor/core";
import { createNativePlatform } from "./native.js";
import { createMaxPlatform } from "./max.js";
import { createTelegramPlatform } from "./telegram.js";
import { createWebPlatform } from "./web.js";

export function selectPlatform(
  isNative = Capacitor.isNativePlatform(),
  {
    runtime = globalThis.document?.documentElement?.dataset?.runtime,
    telegramWebApp = globalThis.window?.Telegram?.WebApp,
    maxWebApp = globalThis.window?.WebApp,
  } = {},
) {
  if (isNative) return createNativePlatform();
  if (runtime === "telegram") {
    return createTelegramPlatform({ webApp: telegramWebApp });
  }
  if (runtime === "max") {
    return createMaxPlatform({ webApp: maxWebApp });
  }
  return createWebPlatform();
}

export const platform = selectPlatform();
