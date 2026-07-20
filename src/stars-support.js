const defaultTimeoutMs = 10_000;
const defaultPollAttempts = 10;
const defaultPollDelayMs = 500;
const defaultMaxResponseBytes = 16 * 1024;
const maximumTimeoutMs = 60_000;
const maximumPollAttempts = 60;
const maximumPollDelayMs = 60_000;
const maximumResponseBytes = 1024 * 1024;
const maximumInvoiceUrlLength = 2048;
const genericErrorMessage = "Stars support request failed";
const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const invoiceIdPattern = /^inv_[A-Za-z0-9_-]{22}$/u;
const invoiceUrlPattern = /^https:\/\/t\.me\/(?:\$|invoice\/)[A-Za-z0-9_=-]+$/u;
const locales = new Set(["en", "ru", "zh"]);
const publicStatuses = new Set(["pending", "paid", "expired", "failed"]);

export function createStarsSupportClient(options) {
  if (!isRecord(options)) {
    throw new TypeError("Invalid Stars support options");
  }
  const {
    workerUrl,
    getToken,
    fetcher = globalThis.fetch,
    timeoutMs = defaultTimeoutMs,
    pollAttempts = defaultPollAttempts,
    pollDelayMs = defaultPollDelayMs,
    maxResponseBytes = defaultMaxResponseBytes,
    delay = defaultDelay,
  } = options;
  const baseUrl = normalizeWorkerUrl(workerUrl);
  if (
    typeof getToken !== "function"
    || typeof fetcher !== "function"
    || typeof delay !== "function"
    || !boundedInteger(timeoutMs, 1, maximumTimeoutMs)
    || !boundedInteger(pollAttempts, 1, maximumPollAttempts)
    || !boundedInteger(pollDelayMs, 0, maximumPollDelayMs)
    || !boundedInteger(maxResponseBytes, 1, maximumResponseBytes)
  ) {
    throw new TypeError("Invalid Stars support options");
  }
  const pollDelayWatchdogMs = pollDelayMs + timeoutMs;

  async function request(path, init, expectedStatus, validate, callerSignal) {
    const requestAbort = createRequestAbort(callerSignal, timeoutMs);
    let responseStatus = 0;
    try {
      if (requestAbort.signal.aborted) throw new Error();
      const token = await waitForAbort(
        Promise.resolve().then(() => getToken()),
        requestAbort.signal,
      );
      if (typeof token !== "string" || !sessionTokenPattern.test(token)) throw new Error();

      const response = await waitForAbort(
        fetcher(`${baseUrl}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          signal: requestAbort.signal,
        }),
        requestAbort.signal,
      );
      responseStatus = safeHttpStatus(response);
      return await parseBoundedJsonResponse(
        response,
        expectedStatus,
        validate,
        maxResponseBytes,
        requestAbort.signal,
      );
    } catch (error) {
      throw clientError(responseStatus || safeHttpStatus(error));
    } finally {
      requestAbort.dispose();
    }
  }

  async function createInvoice(input, options = {}) {
    const signal = readCallerSignal(options);
    if (!hasExactKeys(input, ["amount", "locale"])) {
      throw new TypeError("Invalid Stars invoice request");
    }
    const { amount, locale } = input;
    if (!boundedInteger(amount, 1, 10_000) || !locales.has(locale)) {
      throw new TypeError("Invalid Stars invoice request");
    }
    return request(
      "/payments/stars/invoices",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, locale }),
      },
      201,
      (value) => validateCreatedInvoice(value, amount),
      signal,
    );
  }

  async function getInvoice(requestedInvoiceId, options = {}) {
    validateInvoiceId(requestedInvoiceId);
    const signal = readCallerSignal(options);
    return request(
      `/payments/stars/invoices/${requestedInvoiceId}`,
      { method: "GET" },
      200,
      (value) => validatePublicInvoice(value, requestedInvoiceId),
      signal,
    );
  }

  async function waitForPaid(requestedInvoiceId, options = {}) {
    validateInvoiceId(requestedInvoiceId);
    const signal = readCallerSignal(options);
    if (signal?.aborted) throw clientError();

    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const invoice = await getInvoice(
        requestedInvoiceId,
        signal === undefined ? {} : { signal },
      );
      if (invoice.status !== "pending") {
        return { status: invoice.status, invoice };
      }
      if (attempt + 1 === pollAttempts) {
        return { status: "pending", invoice };
      }
      const delayAbort = createRequestAbort(signal, pollDelayWatchdogMs);
      try {
        await waitForAbort(
          Promise.resolve().then(() => delay(pollDelayMs, delayAbort.signal)),
          delayAbort.signal,
        );
      } catch {
        throw clientError();
      } finally {
        delayAbort.dispose();
      }
    }
    throw clientError();
  }

  return Object.freeze({ createInvoice, getInvoice, waitForPaid });
}

function normalizeWorkerUrl(workerUrl) {
  if (
    typeof workerUrl !== "string"
    || workerUrl === ""
    || workerUrl.trim() !== workerUrl
  ) {
    throw new TypeError("Invalid Stars support worker URL");
  }
  try {
    const url = new URL(workerUrl);
    if (
      url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || hasUrlCredentials(workerUrl)
      || hasExplicitUrlPort(workerUrl)
      || workerUrl.includes("?")
      || workerUrl.includes("#")
    ) {
      throw new Error();
    }
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new TypeError("Invalid Stars support worker URL");
  }
}

async function parseBoundedJsonResponse(response, expectedStatus, validate, maximumBytes, signal) {
  const status = safeHttpStatus(response);
  let readerOwnsBody = false;
  try {
    if (
      !isRecord(response)
      || response.ok !== true
      || status !== expectedStatus
      || typeof response.headers?.get !== "function"
    ) {
      throw new Error();
    }
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|\s*$)/iu.test(contentType)) throw new Error();

    const contentLength = response.headers.get("Content-Length");
    if (contentLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) throw new Error();
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) throw new Error();
    }
    if (!response.body || typeof response.body.getReader !== "function") throw new Error();
    readerOwnsBody = true;
    const text = await readBoundedText(response.body, maximumBytes, signal);
    const value = validate(JSON.parse(text));
    if (value === null) throw new Error();
    return value;
  } catch {
    if (!readerOwnsBody) await cancelResponseBody(response, signal);
    throw clientError(status);
  }
}

async function readBoundedText(body, maximumBytes, signal) {
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
      if (!(value instanceof Uint8Array)) throw new Error();
      byteCount += value.byteLength;
      if (byteCount > maximumBytes) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) await cancelReader(reader, signal);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function validateCreatedInvoice(value, expectedAmount) {
  if (
    !hasExactKeys(value, ["invoiceId", "invoiceUrl", "amount", "currency", "expiresAt"])
    || !invoiceIdPattern.test(value.invoiceId ?? "")
    || typeof value.invoiceUrl !== "string"
    || value.invoiceUrl.length > maximumInvoiceUrlLength
    || !invoiceUrlPattern.test(value.invoiceUrl)
    || value.amount !== expectedAmount
    || !boundedInteger(value.amount, 1, 10_000)
    || value.currency !== "XTR"
    || canonicalTimestamp(value.expiresAt) === null
  ) {
    return null;
  }
  return {
    invoiceId: value.invoiceId,
    invoiceUrl: value.invoiceUrl,
    amount: value.amount,
    currency: value.currency,
    expiresAt: value.expiresAt,
  };
}

function validatePublicInvoice(value, expectedInvoiceId) {
  if (
    !hasExactKeys(value, [
      "invoiceId",
      "amount",
      "currency",
      "status",
      "createdAt",
      "expiresAt",
      "paidAt",
    ])
    || value.invoiceId !== expectedInvoiceId
    || !boundedInteger(value.amount, 1, 10_000)
    || value.currency !== "XTR"
    || !publicStatuses.has(value.status)
  ) {
    return null;
  }
  const created = canonicalTimestamp(value.createdAt);
  const expires = canonicalTimestamp(value.expiresAt);
  const paid = value.paidAt === null ? null : canonicalTimestamp(value.paidAt);
  if (
    created === null
    || expires === null
    || expires <= created
    || (value.paidAt !== null && paid === null)
    || ((value.status === "pending" || value.status === "expired") && value.paidAt !== null)
    || (value.status === "paid" && paid === null)
    || (paid !== null && paid < created)
  ) {
    return null;
  }
  return {
    invoiceId: value.invoiceId,
    amount: value.amount,
    currency: value.currency,
    status: value.status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    paidAt: value.paidAt,
  };
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function validateInvoiceId(value) {
  if (typeof value !== "string" || !invoiceIdPattern.test(value)) {
    throw new TypeError("Invalid Stars invoice ID");
  }
}

function readCallerSignal(options) {
  if (!isRecord(options) || !hasExactKeys(options, options.signal === undefined ? [] : ["signal"])) {
    throw new TypeError("Invalid Stars polling options");
  }
  const { signal } = options;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("Invalid caller abort signal");
  }
  return signal;
}

function createRequestAbort(callerSignal, timeoutMs) {
  if (callerSignal !== undefined && !isAbortSignal(callerSignal)) {
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

function defaultDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error());
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
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

async function cancelResponseBody(response, signal) {
  try {
    const cancellation = response?.body?.cancel?.();
    if (cancellation) await waitForAbort(cancellation, signal);
  } catch {}
}

async function cancelReader(reader, signal) {
  try {
    const cancellation = reader.cancel();
    if (cancellation) await waitForAbort(cancellation, signal);
  } catch {}
}

function safeHttpStatus(value) {
  try {
    const status = value?.status;
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  } catch {
    return 0;
  }
}

function clientError(status = 0) {
  return Object.assign(new Error(genericErrorMessage), { status });
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isAbortSignal(value) {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function hasExplicitUrlPort(rawUrl) {
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)/iu)?.[1] ?? "";
  const host = authority.split("@").at(-1);
  return host.startsWith("[") ? /^\[[^\]]+\]:/u.test(host) : host.includes(":");
}

function hasUrlCredentials(rawUrl) {
  const authority = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu)?.[1] ?? "";
  return authority.includes("@");
}
