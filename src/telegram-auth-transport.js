const responseByteLimit = 16 * 1024;
const defaultTimeoutMs = 10_000;
const maximumTimeoutMs = 2_147_483_647;
const genericErrorMessage = "Telegram authentication unavailable";

export function createTelegramAuthTransport({
  workerUrl,
  fetcher = globalThis.fetch,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const baseUrl = normalizeWorkerUrl(workerUrl);
  const requestTimeoutMs = normalizeTimeout(timeoutMs);
  if (typeof fetcher !== "function") {
    throw new TypeError("A fetch function is required");
  }

  return async function request(path, init, validate, callerSignal) {
    const requestAbort = createRequestAbort(callerSignal, requestTimeoutMs);
    let responseStatus = 0;
    try {
      if (requestAbort.signal.aborted) throw new Error();
      const response = await waitForAbort(
        fetcher(`${baseUrl}${path}`, { ...init, signal: requestAbort.signal }),
        requestAbort.signal,
      );
      responseStatus = httpStatus(response?.status);
      return await parseBoundedResponse(response, validate, requestAbort.signal);
    } catch (error) {
      throw clientError(responseStatus || httpStatus(error?.status));
    } finally {
      requestAbort.dispose();
    }
  };
}

export function telegramJsonPost(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function validateTelegramPublicSession(value, validToken) {
  if (
    !hasExactKeys(value, ["token", "user"])
    || typeof value.token !== "string"
    || !validToken(value.token)
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

export function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expectedKeys].sort().join(",");
}

export function hasExplicitUrlPort(rawUrl) {
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  const host = authority.split("@").at(-1);
  return host.startsWith("[") ? /^\[[^\]]+\]:/.test(host) : host.includes(":");
}

export function hasUrlCredentials(rawUrl) {
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)?.[1] ?? "";
  return authority.includes("@");
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
      || hasUrlCredentials(workerUrl)
      || url.port
      || hasExplicitUrlPort(workerUrl)
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

async function parseBoundedResponse(response, validate, signal) {
  const status = httpStatus(response?.status);
  let readerOwnsBody = false;
  try {
    if (!response || response.ok !== true || typeof response.headers?.get !== "function") {
      throw new Error();
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new Error();

    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > responseByteLimit) throw new Error();

    if (!response.body || typeof response.body.getReader !== "function") throw new Error();
    readerOwnsBody = true;
    const text = await readBoundedText(response.body, signal);
    const value = validate(JSON.parse(text));
    if (value === null) throw new Error();
    return value;
  } catch {
    if (!readerOwnsBody) await cancelResponseBody(response, signal);
    throw clientError(status);
  }
}

async function cancelResponseBody(response, signal) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation) await waitForAbort(cancellation, signal);
  } catch {}
}

async function readBoundedText(body, signal) {
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
      if (byteCount > responseByteLimit) throw new Error();
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

function httpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function clientError(status) {
  return Object.assign(new Error(genericErrorMessage), { status });
}
