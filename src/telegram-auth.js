import {
  createTelegramAuthTransport,
  hasExactKeys,
  hasExplicitUrlPort,
  hasUrlCredentials,
  telegramJsonPost,
  validateTelegramPublicSession,
} from "./telegram-auth-transport.js";

const platforms = new Set(["web", "android", "ios"]);
const ticketPattern = /^[A-Za-z0-9_-]{32,256}$/;
const tokenPattern = /^[A-Za-z0-9_-]+$/;

export function createTelegramAuthClient(options) {
  const request = createTelegramAuthTransport(options);

  return {
    capability({ signal } = {}) {
      return request("/auth/telegram/config", { method: "GET" }, validateCapability, signal);
    },
    start(platform, { signal } = {}) {
      if (!platforms.has(platform)) {
        return Promise.reject(new TypeError("Unsupported Telegram auth platform"));
      }
      return request(
        "/auth/telegram/mobile/start",
        telegramJsonPost({ platform }),
        validateStart,
        signal,
      );
    },
    redeem(ticket, { signal } = {}) {
      if (typeof ticket !== "string" || !ticketPattern.test(ticket)) {
        return Promise.reject(new TypeError("Invalid Telegram auth ticket"));
      }
      return request(
        "/auth/telegram/mobile/redeem",
        telegramJsonPost({ ticket }),
        validateRedeem,
        signal,
      );
    },
  };
}

function validateCapability(value) {
  if (!hasExactKeys(value, ["method"])) return null;
  return value.method === "legacy" || value.method === "oidc"
    ? { method: value.method }
    : null;
}

function validateStart(value) {
  if (!hasExactKeys(value, ["authorizationUrl"]) || typeof value.authorizationUrl !== "string") {
    return null;
  }
  try {
    const url = new URL(value.authorizationUrl);
    if (
      value.authorizationUrl.trim() !== value.authorizationUrl
      || url.origin !== "https://oauth.telegram.org"
      || url.pathname !== "/auth"
      || url.username
      || url.password
      || url.hash
      || value.authorizationUrl.includes("#")
      || hasUrlCredentials(value.authorizationUrl)
      || hasExplicitUrlPort(value.authorizationUrl)
    ) {
      return null;
    }
    return { authorizationUrl: value.authorizationUrl };
  } catch {
    return null;
  }
}

function validateRedeem(value) {
  return validateTelegramPublicSession(value, (token) => tokenPattern.test(token));
}
