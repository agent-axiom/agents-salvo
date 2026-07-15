const responseByteLimit = 16 * 1024;
const platforms = new Set(["web", "android", "ios"]);
const ticketPattern = /^[A-Za-z0-9_-]{32,256}$/;
const tokenPattern = /^[A-Za-z0-9_-]+$/;
const genericErrorMessage = "Telegram authentication unavailable";

export function createTelegramAuthClient({ workerUrl, fetcher = globalThis.fetch } = {}) {
  const baseUrl = normalizeWorkerUrl(workerUrl);
  if (typeof fetcher !== "function") {
    throw new TypeError("A fetch function is required");
  }

  const request = async (path, init, validate) => {
    let response;
    try {
      response = await fetcher(`${baseUrl}${path}`, init);
    } catch (error) {
      throw clientError(httpStatus(error?.status));
    }
    return parseBoundedResponse(response, validate);
  };

  return {
    capability() {
      return request("/auth/telegram/config", { method: "GET" }, validateCapability);
    },
    start(platform) {
      if (!platforms.has(platform)) {
        return Promise.reject(new TypeError("Unsupported Telegram auth platform"));
      }
      return request("/auth/telegram/mobile/start", jsonPost({ platform }), validateStart);
    },
    redeem(ticket) {
      if (typeof ticket !== "string" || !ticketPattern.test(ticket)) {
        return Promise.reject(new TypeError("Invalid Telegram auth ticket"));
      }
      return request("/auth/telegram/mobile/redeem", jsonPost({ ticket }), validateRedeem);
    },
  };
}

function normalizeWorkerUrl(workerUrl) {
  if (typeof workerUrl !== "string" || workerUrl.trim() !== workerUrl || workerUrl === "") {
    throw new TypeError("Invalid Telegram auth worker URL");
  }
  try {
    const url = new URL(workerUrl);
    if (
      url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || workerUrl.includes("?")
      || workerUrl.includes("#")
      || hasCredentials(workerUrl)
    ) {
      throw new TypeError("Invalid Telegram auth worker URL");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof TypeError && error.message === "Invalid Telegram auth worker URL") {
      throw error;
    }
    throw new TypeError("Invalid Telegram auth worker URL");
  }
}

function jsonPost(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function parseBoundedResponse(response, validate) {
  const status = httpStatus(response?.status);
  try {
    if (!response || response.ok !== true || typeof response.headers?.get !== "function") {
      throw new Error();
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new Error();

    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > responseByteLimit) throw new Error();

    const text = await readBoundedText(response.body);
    const value = validate(JSON.parse(text));
    if (value === null) throw new Error();
    return value;
  } catch {
    throw clientError(status);
  }
}

async function readBoundedText(body) {
  if (!body || typeof body.getReader !== "function") throw new Error();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > responseByteLimit) {
        await reader.cancel().catch(() => {});
        throw new Error();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
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
      || hasCredentials(value.authorizationUrl)
      || hasExplicitPort(value.authorizationUrl)
    ) {
      return null;
    }
    return { authorizationUrl: value.authorizationUrl };
  } catch {
    return null;
  }
}

function validateRedeem(value) {
  if (
    !hasExactKeys(value, ["token", "user"])
    || typeof value.token !== "string"
    || !tokenPattern.test(value.token)
    || !validPublicUser(value.user)
  ) {
    return null;
  }
  return {
    token: value.token,
    user: {
      provider: value.user.provider,
      id: value.user.id,
      name: value.user.name,
      username: value.user.username,
      photoUrl: value.user.photoUrl,
    },
  };
}

function validPublicUser(user) {
  return hasExactKeys(user, ["provider", "id", "name", "username", "photoUrl"])
    && user.provider === "telegram"
    && typeof user.id === "string"
    && user.id.trim() !== ""
    && user.id.length <= 128
    && typeof user.name === "string"
    && user.name.length <= 256
    && typeof user.username === "string"
    && user.username.length <= 128
    && typeof user.photoUrl === "string"
    && user.photoUrl.length <= 2048;
}

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expectedKeys].sort().join(",");
}

function hasExplicitPort(rawUrl) {
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  return /:\d+$/.test(authority.split("@").at(-1));
}

function hasCredentials(rawUrl) {
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1] ?? "";
  return authority.includes("@");
}

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function clientError(status) {
  return Object.assign(new Error(genericErrorMessage), { status });
}
