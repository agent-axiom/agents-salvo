import {
  createTelegramAuthTransport,
  telegramJsonPost,
  validatePublicSession,
} from "./telegram-auth-transport.js";

const maxInitDataBytes = 16 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

export function createMaxMiniAppAuthClient(options) {
  const request = createTelegramAuthTransport(options);

  return {
    authenticate(initData, { signal } = {}) {
      if (!validInitData(initData)) {
        return Promise.reject(new TypeError("Invalid MAX Mini App initData"));
      }
      return request(
        "/auth/max/miniapp",
        telegramJsonPost({ initData }),
        (value) => validatePublicSession(value, (token) => tokenPattern.test(token), "max"),
        signal,
      ).catch((error) => {
        throw Object.assign(new Error("MAX authentication unavailable"), {
          status: Number.isInteger(error?.status) ? error.status : 0,
        });
      });
    },
  };
}

function validInitData(initData) {
  return typeof initData === "string"
    && initData.length > 0
    && textEncoder.encode(initData).byteLength <= maxInitDataBytes;
}
