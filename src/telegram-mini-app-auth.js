import {
  createTelegramAuthTransport,
  telegramJsonPost,
  validateTelegramPublicSession,
} from "./telegram-auth-transport.js";

const maxInitDataBytes = 16 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

export function createTelegramMiniAppAuthClient(options) {
  const request = createTelegramAuthTransport(options);

  return {
    authenticate(initData, { signal } = {}) {
      if (!validInitData(initData)) {
        return Promise.reject(new TypeError("Invalid Telegram Mini App initData"));
      }
      return request(
        "/auth/telegram/miniapp",
        telegramJsonPost({ initData }),
        validateSession,
        signal,
      );
    },
  };
}

function validInitData(initData) {
  return typeof initData === "string"
    && initData.length > 0
    && textEncoder.encode(initData).byteLength <= maxInitDataBytes;
}

function validateSession(value) {
  return validateTelegramPublicSession(value, (token) => tokenPattern.test(token));
}
