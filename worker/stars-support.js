export const starsAmountLimits = Object.freeze({ min: 1, max: 10_000 });
export const starsInvoiceTtlSeconds = 15 * 60;

const telegramMaximumUserId = 2 ** 52 - 1;
const telegramInvoiceUrlPattern = /^https:\/\/t\.me\/\$[A-Za-z0-9_-]{1,128}$/u;
const internalInvoiceStatuses = new Set(["pending", "paid", "failed", "refunded"]);
const invoiceText = Object.freeze({
  en: Object.freeze({
    title: "Support Salvo",
    description: "Voluntary support for Salvo. It grants no gameplay advantage.",
    label: "Voluntary support",
  }),
  ru: Object.freeze({
    title: "Поддержать Salvo",
    description: "Добровольная поддержка Salvo. Она не дает преимуществ в игре.",
    label: "Добровольная поддержка",
  }),
  zh: Object.freeze({
    title: "支持 Salvo",
    description: "自愿支持 Salvo，不会带来任何游戏优势。",
    label: "自愿支持",
  }),
});

class StarsSupportError extends Error {
  constructor(message, category, status) {
    super(message);
    this.name = "StarsSupportError";
    this.category = category;
    this.status = status;
  }
}

export function createStarsSupportService(options) {
  let db;
  let botApi;
  let prepare;
  let createInvoiceLink;
  let now;
  let randomBytes;
  try {
    if (!isRecord(options)) {
      throw serviceUnavailableError();
    }
    db = options.db;
    botApi = options.botApi;
    prepare = db?.prepare;
    createInvoiceLink = botApi?.createInvoiceLink;
    now = options.now === undefined ? currentEpochSeconds : options.now;
    randomBytes = options.randomBytes === undefined ? secureRandomBytes : options.randomBytes;
    if (
      typeof prepare !== "function" ||
      typeof createInvoiceLink !== "function" ||
      typeof now !== "function" ||
      typeof randomBytes !== "function"
    ) {
      throw serviceUnavailableError();
    }
  } catch {
    throw serviceUnavailableError();
  }

  return {
    async createInvoice(request) {
      const { userId, userKey, amount, text } = normalizeCreateRequest(request);
      const { createdAt, expiresAt, expiresAtIso } = readClock(now);
      const invoiceId = `inv_${base64Url(readRandomBytes(randomBytes, 16))}`;
      const payload = `pay_${base64Url(readRandomBytes(randomBytes, 32))}`;

      try {
        const result = await prepare
          .call(
            db,
            `INSERT INTO star_support_payments (
              invoice_id, invoice_payload, user_key, telegram_user_id,
              amount, currency, status, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, 'XTR', 'pending', ?, ?)`,
          )
          .bind(invoiceId, payload, userKey, userId, amount, createdAt, expiresAt)
          .run();
        if (result?.success === false) {
          throw serviceUnavailableError();
        }
      } catch {
        throw serviceUnavailableError();
      }

      let invoiceUrl;
      try {
        invoiceUrl = await createInvoiceLink.call(botApi, {
          title: text.title,
          description: text.description,
          payload,
          amount,
          label: text.label,
        });
        if (!isTelegramInvoiceUrl(invoiceUrl)) {
          throw serviceUnavailableError();
        }
      } catch {
        await markInvoiceFailed({
          db,
          prepare,
          invoiceId,
          userKey,
          failedAt: createdAt,
        });
        throw serviceUnavailableError();
      }

      return {
        invoiceId,
        invoiceUrl,
        amount,
        currency: "XTR",
        expiresAt: expiresAtIso,
      };
    },
    async getInvoice(request) {
      const { invoiceId, userKey } = normalizeGetRequest(request);
      const currentTime = readCurrentTime(now);
      let row;
      try {
        row = await prepare
          .call(
            db,
            `SELECT invoice_id, amount, currency, status, created_at, expires_at, paid_at
               FROM star_support_payments
              WHERE invoice_id = ? AND user_key = ?`,
          )
          .bind(invoiceId, userKey)
          .first();
      } catch {
        throw serviceUnavailableError();
      }
      if (row === null || row === undefined) {
        throw invoiceNotFoundError();
      }
      const invoice = normalizeStoredInvoice(row, invoiceId);

      return {
        invoiceId: invoice.invoiceId,
        amount: invoice.amount,
        currency: invoice.currency,
        status: publicInvoiceStatus(invoice, currentTime),
        createdAt: invoice.createdAt,
        expiresAt: invoice.expiresAt,
        paidAt: invoice.paidAt,
      };
    },
  };
}

function normalizeCreateRequest(request) {
  try {
    if (!isRecord(request)) {
      throw invalidRequestError();
    }
    const { user, amount, locale } = request;
    const userId = validatedTelegramUserId(user);
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount < starsAmountLimits.min ||
      amount > starsAmountLimits.max ||
      typeof locale !== "string" ||
      !Object.hasOwn(invoiceText, locale)
    ) {
      throw invalidRequestError();
    }
    return {
      userId,
      userKey: `telegram:${userId}`,
      amount,
      text: invoiceText[locale],
    };
  } catch (error) {
    if (error instanceof StarsSupportError) {
      throw error;
    }
    throw invalidRequestError();
  }
}

function normalizeGetRequest(request) {
  try {
    if (!isRecord(request)) {
      throw invalidRequestError();
    }
    const user = request.user;
    const invoiceId = request.invoiceId;
    const userId = validatedTelegramUserId(user);
    if (
      typeof invoiceId !== "string" ||
      !/^inv_[A-Za-z0-9_-]{22}$/.test(invoiceId)
    ) {
      throw invalidRequestError();
    }
    return {
      invoiceId,
      userKey: `telegram:${userId}`,
    };
  } catch (error) {
    if (error instanceof StarsSupportError) {
      throw error;
    }
    throw invalidRequestError();
  }
}

function validatedTelegramUserId(user) {
  if (!isRecord(user)) {
    throw invalidRequestError();
  }
  const provider = user.provider;
  const id = user.id;
  if (
    provider !== "telegram" ||
    typeof id !== "string" ||
    !/^[1-9]\d*$/.test(id)
  ) {
    throw invalidRequestError();
  }
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId > telegramMaximumUserId) {
    throw invalidRequestError();
  }
  return id;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequestError() {
  return new StarsSupportError("Invalid Stars support request", "invalid_request", 400);
}

function serviceUnavailableError() {
  return new StarsSupportError("Stars support is unavailable", "service_unavailable", 503);
}

function invoiceNotFoundError() {
  return new StarsSupportError("Stars invoice not found", "not_found", 404);
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function readClock(now) {
  try {
    const createdAt = now();
    const expiresAt = createdAt + starsInvoiceTtlSeconds;
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !Number.isSafeInteger(expiresAt)
    ) {
      throw serviceUnavailableError();
    }
    return {
      createdAt,
      expiresAt,
      expiresAtIso: new Date(expiresAt * 1000).toISOString(),
    };
  } catch {
    throw serviceUnavailableError();
  }
}

function readCurrentTime(now) {
  try {
    const currentTime = now();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
      throw serviceUnavailableError();
    }
    validatedTimestamp(currentTime);
    return currentTime;
  } catch {
    throw serviceUnavailableError();
  }
}

function readRandomBytes(randomBytes, size) {
  try {
    const bytes = randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw serviceUnavailableError();
    }
    return bytes;
  } catch {
    throw serviceUnavailableError();
  }
}

async function markInvoiceFailed({ db, prepare, invoiceId, userKey, failedAt }) {
  try {
    await prepare
      .call(
        db,
        `UPDATE star_support_payments
            SET status = 'failed', failed_at = ?
          WHERE invoice_id = ? AND user_key = ? AND status = 'pending'`,
      )
      .bind(failedAt, invoiceId, userKey)
      .run();
  } catch {
    // The fixed provider error remains the only outward failure.
  }
}

function isTelegramInvoiceUrl(value) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    !/[\u0000-\u001F\u007F]/.test(value) &&
    telegramInvoiceUrlPattern.test(value)
  );
}

function normalizeStoredInvoice(row, expectedInvoiceId) {
  try {
    if (
      !isRecord(row) ||
      row.invoice_id !== expectedInvoiceId ||
      typeof row.amount !== "number" ||
      !Number.isInteger(row.amount) ||
      row.amount < starsAmountLimits.min ||
      row.amount > starsAmountLimits.max ||
      row.currency !== "XTR" ||
      !internalInvoiceStatuses.has(row.status)
    ) {
      throw serviceUnavailableError();
    }
    const createdAt = validatedTimestamp(row.created_at);
    const expiresAt = validatedTimestamp(row.expires_at);
    if (row.expires_at <= row.created_at) {
      throw serviceUnavailableError();
    }
    const wasPaid = row.status === "paid" || row.status === "refunded";
    if ((wasPaid && row.paid_at === null) || (!wasPaid && row.paid_at !== null)) {
      throw serviceUnavailableError();
    }
    let paidAt = null;
    if (wasPaid) {
      paidAt = validatedTimestamp(row.paid_at);
      if (row.paid_at < row.created_at) {
        throw serviceUnavailableError();
      }
    }
    return {
      invoiceId: row.invoice_id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      expiresAtEpoch: row.expires_at,
      createdAt,
      expiresAt,
      paidAt,
    };
  } catch {
    throw serviceUnavailableError();
  }
}

function publicInvoiceStatus(invoice, currentTime) {
  if (invoice.status === "refunded") {
    return "failed";
  }
  if (invoice.status === "pending" && currentTime >= invoice.expiresAtEpoch) {
    return "expired";
  }
  return invoice.status;
}

function validatedTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw serviceUnavailableError();
  }
  return new Date(value * 1000).toISOString();
}

function secureRandomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
