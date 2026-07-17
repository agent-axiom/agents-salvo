const byteLimit = 16 * 1024;
const defaultTimeoutMs = 10_000;
const maximumTimeoutMs = 2_147_483_647;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const genericErrorMessage = "Telegram authentication unavailable";
const textEncoder = new TextEncoder();

export function createTelegramMiniAppAuthClient({
  workerUrl,
  fetcher = globalThis.fetch,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const baseUrl = normalizeWorkerUrl(workerUrl);
  const requestTimeoutMs = normalizeTimeout(timeoutMs);
  if (typeof fetcher !== "function") {
    throw new TypeError("A fetch function is required");
  }

  const request = async (initData, callerSignal) => {
    const requestAbort = createRequestAbort(callerSignal, requestTimeoutMs);
    let responseStatus = 0;
    try {
      if (requestAbort.signal.aborted) throw new Error();
      const response = await waitForAbort(
        fetcher(`${baseUrl}/auth/telegram/miniapp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
          signal: requestAbort.signal,
        }),
        requestAbort.signal,
      );
      responseStatus = httpStatus(response?.status);
      return await parseBoundedResponse(response, requestAbort.signal);
    } catch (error) {
      throw clientError(responseStatus || httpStatus(error?.status));
    } finally {
      requestAbort.dispose();
    }
  };

  return {
    authenticate(initData, { signal } = {}) {
      if (!validInitData(initData)) {
        return Promise.reject(new TypeError("Invalid Telegram Mini App initData"));
      }
      return request(initData, signal);
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
      || url.port
      || hasExplicitPort(workerUrl)
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

function normalizeTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimeoutMs) {
    throw new TypeError("Invalid Telegram auth timeout");
  }
  return timeoutMs;
}

function validInitData(initData) {
  return typeof initData === "string"
    && initData.length > 0
    && textEncoder.encode(initData).byteLength <= byteLimit;
}

async function parseBoundedResponse(response, signal) {
  const status = httpStatus(response?.status);
  try {
    if (!response || response.ok !== true || typeof response.headers?.get !== "function") {
      throw new Error();
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new Error();
    }

    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > byteLimit) throw new Error();

    const text = await readBoundedText(response.body, signal);
    const value = validateSession(JSON.parse(text));
    if (value === null) throw new Error();
    return value;
  } catch {
    throw clientError(status);
  }
}

async function readBoundedText(body, signal) {
  if (!body || typeof body.getReader !== "function") throw new Error();
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const { done, value } = await waitForAbort(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function createRequestAbort(callerSignal, timeoutMs) {
  if (callerSignal != null && !isAbortSignal(callerSignal)) {
    throw new TypeError("Invalid caller abort signal");
  }

  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  let listening = false;
  if (callerSignal?.aborted) {
    relayAbort();
  } else if (callerSignal) {
    callerSignal.addEventListener("abort", relayAbort, { once: true });
    listening = true;
    if (callerSignal.aborted) relayAbort();
  }

  const timer = controller.signal.aborted ? null : setTimeout(relayAbort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      if (listening) callerSignal.removeEventListener("abort", relayAbort);
    },
  };
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function waitForAbort(value, signal) {
  return new Promise((resolve, reject) => {
    let listening = false;
    let settled = false;
    const finish = (settle, result) => {
      if (settled) return;
      settled = true;
      if (listening) signal.removeEventListener("abort", onAbort);
      settle(result);
    };
    const onAbort = () => finish(reject, new Error());

    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      listening = true;
      if (signal.aborted) onAbort();
    }
  });
}

function cancelReader(reader) {
  try {
    const cancellation = reader.cancel();
    cancellation?.catch?.(() => {});
  } catch {}
}

function validateSession(value) {
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
  const host = authority.split("@").at(-1);
  return host.startsWith("[") ? /^\[[^\]]+\]:/.test(host) : host.includes(":");
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
