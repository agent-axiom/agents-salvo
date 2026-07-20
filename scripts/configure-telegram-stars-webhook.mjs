import { pathToFileURL } from "node:url";

export const TELEGRAM_STARS_WEBHOOK_URL =
  "https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook";

const telegramApiOrigin = "https://api.telegram.org";
const commandErrorMessage = "Telegram Stars webhook command failed";
const botTokenPattern = /^([1-9]\d{0,15}):[A-Za-z0-9_-]{1,128}$/u;
const webhookSecretPattern = /^[A-Za-z0-9_-]{32,256}$/u;
const maximumTimeoutMs = 60_000;
const maximumConfiguredResponseBytes = 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function commandError() {
  return new Error(commandErrorMessage);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveIntegerAtMost(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function requireBotToken(value) {
  if (typeof value !== "string") {
    throw commandError();
  }
  const match = botTokenPattern.exec(value);
  if (match === null || !Number.isSafeInteger(Number(match[1]))) {
    throw commandError();
  }
  return value;
}

function requireWebhookSecret(value) {
  if (typeof value !== "string" || !webhookSecretPattern.test(value)) {
    throw commandError();
  }
  return value;
}

function requireCanonicalWebhookUrl(value) {
  if (typeof value !== "string") {
    throw commandError();
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw commandError();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname !== "agents-salvo-room.if-ab6.workers.dev" ||
    url.pathname !== "/telegram/webhook" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== TELEGRAM_STARS_WEBHOOK_URL ||
    value !== url.href
  ) {
    throw commandError();
  }
  return value;
}

async function cancelUnreadResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The outward error remains generic if response cancellation also fails.
  }
}

async function readBoundedResponseText(response, maximumBytes) {
  const contentLength = response.headers?.get?.("Content-Length");
  if (contentLength !== null && contentLength !== undefined) {
    if (typeof contentLength !== "string" || !/^\d+$/u.test(contentLength)) {
      await cancelUnreadResponseBody(response);
      throw commandError();
    }
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      await cancelUnreadResponseBody(response);
      throw commandError();
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (!isRecord(chunk) || typeof chunk.done !== "boolean") {
          throw commandError();
        }
        if (chunk.done) {
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw commandError();
        }
        if (chunk.value.byteLength > maximumBytes - totalBytes) {
          try {
            await reader.cancel();
          } catch {
            // The outward error remains generic if reader cancellation fails.
          }
          throw commandError();
        }
        chunks.push(chunk.value);
        totalBytes += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock?.();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return textDecoder.decode(bytes);
  }

  if (typeof response.text !== "function") {
    throw commandError();
  }
  const responseText = await response.text();
  if (
    typeof responseText !== "string" ||
    textEncoder.encode(responseText).byteLength > maximumBytes
  ) {
    throw commandError();
  }
  return responseText;
}

function isSuccessfulResponse(response) {
  if (!isRecord(response)) {
    return false;
  }
  const hasStatus = Number.isInteger(response.status);
  if (hasStatus && (response.status < 200 || response.status >= 300)) {
    return false;
  }
  if (typeof response.ok === "boolean") {
    return response.ok;
  }
  return hasStatus;
}

async function telegramRequest({
  botToken,
  method,
  body,
  fetchImpl,
  timeoutMs,
  maxResponseBytes,
}) {
  const endpoint = `${telegramApiOrigin}/bot${botToken}/${method}`;
  const controller = new AbortController();
  const options = {
    method: "POST",
    headers: body === undefined
      ? { Accept: "application/json" }
      : { "Content-Type": "application/json" },
    redirect: "error",
    signal: controller.signal,
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let response;
  let timeoutHandle;
  const operation = (async () => {
    response = await fetchImpl(endpoint, options);
    if (!isSuccessfulResponse(response)) {
      await cancelUnreadResponseBody(response);
      throw commandError();
    }
    const payload = JSON.parse(await readBoundedResponseText(response, maxResponseBytes));
    if (!isRecord(payload) || payload.ok !== true) {
      throw commandError();
    }
    return payload.result;
  })();
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      void cancelUnreadResponseBody(response);
      reject(commandError());
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function verifyWebhookInfo(result, webhookUrl) {
  if (
    !isRecord(result)
    || typeof result.url !== "string"
    || result.url !== webhookUrl
    || Object.hasOwn(result, "last_error_date")
    || Object.hasOwn(result, "last_error_message")
  ) {
    throw commandError();
  }
}

async function runCommand(options) {
  if (!isRecord(options)) {
    throw commandError();
  }
  const {
    argv = process.argv.slice(2),
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = process.stdout,
    webhookUrl = TELEGRAM_STARS_WEBHOOK_URL,
    timeoutMs = 5_000,
    maxResponseBytes = 64 * 1024,
  } = options;
  if (
    !Array.isArray(argv) ||
    argv.length !== 1 ||
    !isRecord(env) ||
    typeof fetchImpl !== "function" ||
    !isRecord(stdout) ||
    typeof stdout.write !== "function" ||
    !isPositiveIntegerAtMost(timeoutMs, maximumTimeoutMs) ||
    !isPositiveIntegerAtMost(maxResponseBytes, maximumConfiguredResponseBytes)
  ) {
    throw commandError();
  }

  const command = argv[0];
  if (command !== "set" && command !== "check") {
    throw commandError();
  }
  const canonicalWebhookUrl = requireCanonicalWebhookUrl(webhookUrl);
  const botToken = requireBotToken(env.TELEGRAM_BOT_TOKEN);

  if (command === "set") {
    const webhookSecret = requireWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
    const result = await telegramRequest({
      botToken,
      method: "setWebhook",
      body: {
        url: canonicalWebhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message", "pre_checkout_query"],
        drop_pending_updates: false,
      },
      fetchImpl,
      timeoutMs,
      maxResponseBytes,
    });
    if (result !== true) {
      throw commandError();
    }
  }

  const webhookInfo = await telegramRequest({
    botToken,
    method: "getWebhookInfo",
    fetchImpl,
    timeoutMs,
    maxResponseBytes,
  });
  verifyWebhookInfo(webhookInfo, canonicalWebhookUrl);
  stdout.write(`Telegram Stars webhook verified: ${canonicalWebhookUrl}\n`);
  return Object.freeze({ url: canonicalWebhookUrl });
}

export async function runTelegramStarsWebhookCli(options = {}) {
  try {
    return await runCommand(options);
  } catch {
    throw commandError();
  }
}

/* node:coverage ignore next 11 */
const isMain = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  try {
    await runTelegramStarsWebhookCli();
  } catch {
    process.stderr.write(`${commandErrorMessage}\n`);
    process.exitCode = 1;
  }
}
