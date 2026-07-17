import { Capacitor } from "@capacitor/core";
import { createNativePlatform } from "./native.js";
import { createTelegramPlatform } from "./telegram.js";
import { createWebPlatform } from "./web.js";

export function selectPlatform(
  isNative = Capacitor.isNativePlatform(),
  {
    runtime = globalThis.document?.documentElement?.dataset?.runtime,
    telegramWebApp = globalThis.window?.Telegram?.WebApp,
  } = {},
) {
  if (isNative) return createNativePlatform();
  if (runtime === "telegram") {
    return createTelegramPlatform({ webApp: telegramWebApp });
  }
  return createWebPlatform();
}

export const platform = selectPlatform();
