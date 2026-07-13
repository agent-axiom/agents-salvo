import { Capacitor } from "@capacitor/core";
import { createNativePlatform } from "./native.js";
import { createWebPlatform } from "./web.js";

export function selectPlatform(isNative = Capacitor.isNativePlatform()) {
  return isNative ? createNativePlatform() : createWebPlatform();
}

export const platform = selectPlatform();
