const apiOrigin = "https://api.telegram.org";
const requestErrorMessage = "Telegram Bot API request failed";
const maxBotTokenBytes = 256;
const maxTimeoutMs = 60_000;
const maxConfiguredResponseBytes = 1024 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function createTelegramBotApiClient(options = {}) {
  try {
    return createClient(options);
  } catch {
    throw requestError();
  }
}

function createClient(options) {
  if (!isRecord(options)) {
    throw requestError();
  }
  const {
    botToken,
    fetcher = fetch,
    timeoutMs = 4_000,
    maxResponseBytes = 64 * 1024,
  } = options;
  if (
    !isBoundedNonblankString(botToken, maxBotTokenBytes, true) ||
    typeof fetcher !== "function" ||
    !isPositiveIntegerAtMost(timeoutMs, maxTimeoutMs) ||
    !isPositiveIntegerAtMost(maxResponseBytes, maxConfiguredResponseBytes)
  ) {
    throw requestError();
  }
  const endpoints = Object.freeze({
    createInvoiceLink: `${apiOrigin}/bot${botToken}/createInvoiceLink`,
    answerPreCheckoutQuery: `${apiOrigin}/bot${botToken}/answerPreCheckoutQuery`,
    sendMessage: `${apiOrigin}/bot${botToken}/sendMessage`,
  });

  async function request(endpoint, body, isValidResult) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!isSuccessfulResponse(response)) {
        throw requestError();
      }
      const payload = JSON.parse(await readBoundedResponseText(response, maxResponseBytes));
      if (!isRecord(payload) || payload.ok !== true || !isValidResult(payload.result)) {
        throw requestError();
      }
      return payload.result;
    } catch {
      throw requestError();
    }
  }

  return {
    async createInvoiceLink(invoice = {}) {
      try {
        if (!isRecord(invoice)) {
          throw requestError();
        }
        const { title, description, payload, amount, label } = invoice;
        if (
          !isBoundedNonblankString(title, 32) ||
          !isBoundedNonblankString(description, 255) ||
          !isBoundedStringBytes(payload, 1, 128) ||
          !Number.isInteger(amount) ||
          amount < 1 ||
          amount > 10_000 ||
          (label !== undefined && !isBoundedNonblankString(label, 32))
        ) {
          throw requestError();
        }
        return await request(
          endpoints.createInvoiceLink,
          {
            title,
            description,
            payload,
            currency: "XTR",
            prices: [{ label: label ?? title, amount }],
          },
          isTelegramInvoiceUrl,
        );
      } catch {
        throw requestError();
      }
    },

    async answerPreCheckoutQuery(answer = {}) {
      try {
        if (!isRecord(answer)) {
          throw requestError();
        }
        const { id, ok, errorMessage } = answer;
        if (
          !isBoundedNonblankString(id, 256, true) ||
          typeof ok !== "boolean" ||
          (!ok && !isBoundedNonblankString(errorMessage, 200))
        ) {
          throw requestError();
        }
        const body = { pre_checkout_query_id: id, ok };
        if (!ok) {
          body.error_message = errorMessage;
        }
        await request(endpoints.answerPreCheckoutQuery, body, (result) => result === true);
      } catch {
        throw requestError();
      }
    },

    async sendMessage(message = {}) {
      try {
        if (!isRecord(message)) {
          throw requestError();
        }
        const { chatId, text } = message;
        if (!isSafeChatId(chatId) || !isBoundedNonblankString(text, 4096)) {
          throw requestError();
        }
        await request(
          endpoints.sendMessage,
          { chat_id: chatId, text, disable_web_page_preview: true },
          isTelegramMessage,
        );
      } catch {
        throw requestError();
      }
    },
  };
}

function isPositiveIntegerAtMost(value, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function isBoundedNonblankString(value, maximum, countBytes = false) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  const length = countBytes ? textEncoder.encode(value).byteLength : Array.from(value).length;
  return length <= maximum;
}

function isBoundedStringBytes(value, minimum, maximum) {
  if (typeof value !== "string") {
    return false;
  }
  const length = textEncoder.encode(value).byteLength;
  return length >= minimum && length <= maximum;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestError() {
  return new Error(requestErrorMessage);
}

function isSafeChatId(value) {
  if (Number.isSafeInteger(value)) {
    return true;
  }
  return (
    typeof value === "string" &&
    /^-?\d+$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function isTelegramMessage(value) {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.message_id) &&
    value.message_id > 0 &&
    Number.isSafeInteger(value.date) &&
    value.date >= 0 &&
    isRecord(value.chat) &&
    Number.isSafeInteger(value.chat.id) &&
    isBoundedNonblankString(value.chat.type, 64)
  );
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

async function readBoundedResponseText(response, maximumBytes) {
  const contentLength = response.headers?.get?.("Content-Length");
  if (contentLength !== null && contentLength !== undefined) {
    if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength)) {
      throw requestError();
    }
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength > maximumBytes) {
      throw requestError();
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
          throw requestError();
        }
        if (chunk.done) {
          break;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw requestError();
        }
        if (chunk.value.byteLength > maximumBytes - totalBytes) {
          try {
            await reader.cancel();
          } catch {
            // The public error is already generic if cancellation also fails.
          }
          throw requestError();
        }
        chunks.push(chunk.value);
        totalBytes += chunk.value.byteLength;
      }
    } finally {
      reader.releaseLock?.();
    }

    const responseBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      responseBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return textDecoder.decode(responseBytes);
  }

  if (typeof response.text !== "function") {
    throw requestError();
  }
  const responseText = await response.text();
  if (
    typeof responseText !== "string" ||
    textEncoder.encode(responseText).byteLength > maximumBytes
  ) {
    throw requestError();
  }
  return responseText;
}

function isTelegramInvoiceUrl(value) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "t.me" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}
