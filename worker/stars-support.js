export const starsAmountLimits = Object.freeze({ min: 1, max: 10_000 });
export const starsInvoiceTtlSeconds = 15 * 60;

const starsInvoiceRateWindowSeconds = 60;
const starsInvoiceRateLimit = 5;
const starsPendingInvoiceLimit = 5;
const starsUnpaidRetentionSeconds = 30 * 24 * 60 * 60;
const starsCleanupBatchSize = 25;
const telegramMaximumUserId = 2 ** 52 - 1;
const textEncoder = new TextEncoder();
const telegramInvoiceUrlPattern = /^https:\/\/t\.me\/\$[A-Za-z0-9_-]{1,128}$/u;
const internalInvoiceStatuses = new Set(["pending", "paid", "failed", "refunded"]);
const preCheckoutRejectionText = Object.freeze({
  en: "Payment unavailable. Please create a new invoice.",
  ru: "Платеж недоступен. Создайте новый счет.",
  zh: "付款不可用，请创建新账单。",
});
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
  let answerPreCheckoutQuery;
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
    answerPreCheckoutQuery = botApi?.answerPreCheckoutQuery;
    now = options.now === undefined ? currentEpochSeconds : options.now;
    randomBytes = options.randomBytes === undefined ? secureRandomBytes : options.randomBytes;
    if (
      typeof prepare !== "function" ||
      typeof createInvoiceLink !== "function" ||
      typeof answerPreCheckoutQuery !== "function" ||
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
            )
            SELECT ?, ?, ?, ?, ?, 'XTR', 'pending', ?, ?
             WHERE (
               SELECT COUNT(*)
                 FROM star_support_payments
                WHERE user_key = ? AND created_at >= ?
             ) < ?
               AND (
                 SELECT COUNT(*)
                   FROM star_support_payments
                  WHERE user_key = ?
                    AND status = 'pending'
                    AND expires_at > ?
               ) < ?`,
          )
          .bind(
            invoiceId,
            payload,
            userKey,
            userId,
            amount,
            createdAt,
            expiresAt,
            userKey,
            createdAt - starsInvoiceRateWindowSeconds,
            starsInvoiceRateLimit,
            userKey,
            createdAt,
            starsPendingInvoiceLimit,
          )
          .run();
        if (!isSuccessfulD1Update(result)) {
          throw serviceUnavailableError();
        }
      } catch {
        throw serviceUnavailableError();
      }

      await cleanupOldUnpaidInvoices({ db, prepare, now: createdAt });

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
    async handleUpdate(update) {
      return handleTelegramUpdate({
        update,
        db,
        botApi,
        prepare,
        answerPreCheckoutQuery,
        now,
      });
    },
  };
}

async function cleanupOldUnpaidInvoices({ db, prepare, now }) {
  const cutoff = now - starsUnpaidRetentionSeconds;
  try {
    await prepare
      .call(
        db,
        `DELETE FROM star_support_payments
          WHERE invoice_id IN (
            SELECT invoice_id
              FROM star_support_payments
             WHERE (status = 'pending' AND expires_at < ?)
                OR (status = 'failed' AND failed_at IS NOT NULL AND failed_at < ?)
             ORDER BY created_at ASC, invoice_id ASC
             LIMIT ?
          )`,
      )
      .bind(cutoff, cutoff, starsCleanupBatchSize)
      .run();
  } catch {
    // Invoice creation remains authoritative; a later request retries bounded cleanup.
  }
}

async function handleTelegramUpdate({
  update,
  db,
  botApi,
  prepare,
  answerPreCheckoutQuery,
  now,
}) {
  const snapshot = snapshotTelegramUpdate(update);
  const hasAnswerablePreCheckout = isBoundedOpaqueId(snapshot.preCheckout.id);
  if (
    hasAnswerablePreCheckout &&
    (snapshot.uncertain || snapshot.hasSuccessfulPayment)
  ) {
    await answerPreCheckout({
      botApi,
      answerPreCheckoutQuery,
      id: snapshot.preCheckout.id,
      approved: false,
      languageCode: snapshot.preCheckout.languageCode,
    });
    return { kind: "pre_checkout", approved: false };
  }
  if (hasAnswerablePreCheckout) {
    return handlePreCheckout({
      query: snapshot.preCheckout,
      db,
      botApi,
      prepare,
      answerPreCheckoutQuery,
      now,
    });
  }
  if (snapshot.uncertain || snapshot.hasPreCheckout) {
    return { kind: "ignored" };
  }
  if (snapshot.hasSuccessfulPayment && snapshot.successfulPayment.valid) {
    return handleSuccessfulPayment({
      payment: snapshot.successfulPayment,
      db,
      prepare,
      now,
    });
  }
  return { kind: "ignored" };
}

async function handlePreCheckout({
  query,
  db,
  botApi,
  prepare,
  answerPreCheckoutQuery,
  now,
}) {
  let approved = false;
  if (query.valid) {
    let currentTime;
    let row;
    try {
      currentTime = readCurrentTime(now);
      row = await prepare
        .call(
          db,
          `SELECT invoice_id, invoice_payload, user_key, telegram_user_id,
                  amount, currency, status, created_at, expires_at,
                  paid_at, failed_at, refunded_at, telegram_payment_charge_id
             FROM star_support_payments
            WHERE invoice_payload = ?`,
        )
        .bind(query.payload)
        .first();
    } catch {
      row = null;
    }
    const pendingRow = normalizePendingPaymentRow(snapshotPaymentRow(row), query.payload);
    approved =
      pendingRow !== null &&
      pendingRow.telegramUserId === String(query.payerId) &&
      pendingRow.amount === query.amount &&
      pendingRow.currency === query.currency &&
      pendingRow.createdAt <= currentTime &&
      currentTime < pendingRow.expiresAt;
  }

  await answerPreCheckout({
    botApi,
    answerPreCheckoutQuery,
    id: query.id,
    approved,
    languageCode: query.languageCode,
  });
  return { kind: "pre_checkout", approved };
}

async function handleSuccessfulPayment({ payment, db, prepare, now }) {
  let row;
  try {
    row = await readPaymentByPayload({
      db,
      prepare,
      payload: payment.payload,
    });
  } catch {
    throw serviceUnavailableError();
  }
  const storedRow = snapshotPaymentRow(row);
  const paidRow = normalizePaidPaymentRow(storedRow, payment.payload);
  if (paidRowMatchesPayment(paidRow, payment)) {
    return paidRow.chargeId === payment.chargeId
      ? { kind: "successful_payment", paid: true, duplicate: true }
      : { kind: "ignored" };
  }
  const pendingRow = normalizePendingPaymentRow(storedRow, payment.payload);
  if (
    pendingRow === null ||
    pendingRow.telegramUserId !== String(payment.payerId) ||
    pendingRow.amount !== payment.amount ||
    pendingRow.currency !== payment.currency
  ) {
    return { kind: "ignored" };
  }

  const paidAt = readCurrentTime(now);
  if (paidAt < pendingRow.createdAt) {
    throw serviceUnavailableError();
  }
  let result;
  try {
    result = await prepare
      .call(
        db,
        `UPDATE star_support_payments
            SET status = 'paid', paid_at = ?, telegram_payment_charge_id = ?
          WHERE invoice_payload = ?
            AND status = 'pending'
            AND user_key = ?
            AND telegram_user_id = ?
            AND currency = ?
            AND amount = ?`,
      )
      .bind(
        paidAt,
        payment.chargeId,
        payment.payload,
        `telegram:${payment.payerId}`,
        String(payment.payerId),
        payment.currency,
        payment.amount,
      )
      .run();
  } catch {
    return recoverSuccessfulPayment({ payment, db, prepare });
  }
  if (!isSuccessfulD1Update(result)) {
    return recoverSuccessfulPayment({ payment, db, prepare });
  }
  return { kind: "successful_payment", paid: true, duplicate: false };
}

async function recoverSuccessfulPayment({ payment, db, prepare }) {
  let row;
  try {
    row = await readPaymentByPayload({ db, prepare, payload: payment.payload });
  } catch {
    throw serviceUnavailableError();
  }
  const paidRow = normalizePaidPaymentRow(snapshotPaymentRow(row), payment.payload);
  if (paidRowMatchesPayment(paidRow, payment)) {
    return paidRow.chargeId === payment.chargeId
      ? { kind: "successful_payment", paid: true, duplicate: true }
      : { kind: "ignored" };
  }
  let chargeOwner;
  try {
    chargeOwner = await readPaymentByChargeId({
      db,
      prepare,
      chargeId: payment.chargeId,
    });
  } catch {
    throw serviceUnavailableError();
  }
  const chargeOwnerSnapshot = snapshotChargeOwner(chargeOwner);
  if (
    chargeOwnerSnapshot !== null &&
    chargeOwnerSnapshot.telegram_payment_charge_id === payment.chargeId &&
    isPrivateInvoicePayload(chargeOwnerSnapshot.invoice_payload) &&
    chargeOwnerSnapshot.invoice_payload !== payment.payload
  ) {
    return { kind: "ignored" };
  }
  throw serviceUnavailableError();
}

function paidRowMatchesPayment(row, payment) {
  return (
    row !== null &&
    row.telegramUserId === String(payment.payerId) &&
    row.amount === payment.amount &&
    row.currency === payment.currency
  );
}

async function readPaymentByPayload({ db, prepare, payload }) {
  return prepare
    .call(
      db,
      `SELECT invoice_id, invoice_payload, user_key, telegram_user_id,
              amount, currency, status, created_at, expires_at,
              paid_at, failed_at, refunded_at, telegram_payment_charge_id
         FROM star_support_payments
        WHERE invoice_payload = ?`,
    )
    .bind(payload)
    .first();
}

async function readPaymentByChargeId({ db, prepare, chargeId }) {
  return prepare
    .call(
      db,
      `SELECT invoice_payload, telegram_payment_charge_id
         FROM star_support_payments
        WHERE telegram_payment_charge_id = ?`,
    )
    .bind(chargeId)
    .first();
}

function isSuccessfulD1Update(result) {
  try {
    if (!isRecord(result)) {
      return false;
    }
    const success = result.success;
    const meta = result.meta;
    if (success !== true || !isRecord(meta)) {
      return false;
    }
    const changes = meta.changes;
    return changes === 1;
  } catch {
    return false;
  }
}

function snapshotPaymentRow(row) {
  return snapshotRecord(row, [
    "invoice_id",
    "invoice_payload",
    "user_key",
    "telegram_user_id",
    "amount",
    "currency",
    "status",
    "created_at",
    "expires_at",
    "paid_at",
    "failed_at",
    "refunded_at",
    "telegram_payment_charge_id",
  ]);
}

function snapshotChargeOwner(row) {
  return snapshotRecord(row, ["invoice_payload", "telegram_payment_charge_id"]);
}

function snapshotRecord(record, fields) {
  try {
    if (!isRecord(record)) {
      return null;
    }
    const snapshot = {};
    for (const field of fields) {
      snapshot[field] = record[field];
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotTelegramUpdate(update) {
  if (!isRecord(update)) {
    return {
      uncertain: true,
      hasPreCheckout: false,
      hasSuccessfulPayment: false,
      preCheckout: { id: undefined, valid: false },
      successfulPayment: { valid: false },
    };
  }
  const queryRead = readProperty(update, "pre_checkout_query");
  const messageRead = readProperty(update, "message");
  const preCheckout = snapshotPreCheckoutQuery(queryRead);
  const successfulMessage = snapshotSuccessfulPaymentMessage(messageRead);
  return {
    uncertain: !queryRead.ok || !messageRead.ok || successfulMessage.uncertain,
    hasPreCheckout: !queryRead.ok || queryRead.value !== undefined,
    hasSuccessfulPayment: successfulMessage.present,
    preCheckout,
    successfulPayment: successfulMessage.payment,
  };
}

function snapshotPreCheckoutQuery(queryRead) {
  if (!queryRead.ok || !isRecord(queryRead.value)) {
    return { id: undefined, valid: false };
  }
  const query = queryRead.value;
  const id = readProperty(query, "id");
  const from = readProperty(query, "from");
  const currency = readProperty(query, "currency");
  const amount = readProperty(query, "total_amount");
  const payload = readProperty(query, "invoice_payload");
  let payerId = { ok: false, value: undefined };
  let languageCode = { ok: false, value: undefined };
  if (from.ok && isRecord(from.value)) {
    payerId = readProperty(from.value, "id");
    languageCode = readProperty(from.value, "language_code");
  }
  const valid =
    id.ok &&
    isBoundedOpaqueId(id.value) &&
    from.ok &&
    isRecord(from.value) &&
    payerId.ok &&
    isTelegramNumericId(payerId.value) &&
    languageCode.ok &&
    isOptionalLanguageCode(languageCode.value) &&
    currency.ok &&
    currency.value === "XTR" &&
    amount.ok &&
    isStarsAmount(amount.value) &&
    payload.ok &&
    isPrivateInvoicePayload(payload.value);

  return {
    id: id.value,
    payerId: payerId.value,
    languageCode: languageCode.value,
    currency: currency.value,
    amount: amount.value,
    payload: payload.value,
    valid,
  };
}

function snapshotSuccessfulPaymentMessage(messageRead) {
  if (!messageRead.ok) {
    return { uncertain: true, present: false, payment: { valid: false } };
  }
  if (!isRecord(messageRead.value)) {
    return { uncertain: false, present: false, payment: { valid: false } };
  }
  const message = messageRead.value;
  const from = readProperty(message, "from");
  const successfulPayment = readProperty(message, "successful_payment");
  if (!successfulPayment.ok) {
    return { uncertain: true, present: true, payment: { valid: false } };
  }
  const present = successfulPayment.value !== undefined;
  if (!isRecord(successfulPayment.value)) {
    return { uncertain: false, present, payment: { valid: false } };
  }
  const payment = successfulPayment.value;
  const currency = readProperty(payment, "currency");
  const amount = readProperty(payment, "total_amount");
  const payload = readProperty(payment, "invoice_payload");
  const chargeId = readProperty(payment, "telegram_payment_charge_id");
  let payerId = { ok: false, value: undefined };
  if (from.ok && isRecord(from.value)) {
    payerId = readProperty(from.value, "id");
  }
  const valid =
    from.ok &&
    isRecord(from.value) &&
    payerId.ok &&
    isTelegramNumericId(payerId.value) &&
    currency.ok &&
    currency.value === "XTR" &&
    amount.ok &&
    isStarsAmount(amount.value) &&
    payload.ok &&
    isPrivateInvoicePayload(payload.value) &&
    chargeId.ok &&
    isBoundedOpaqueId(chargeId.value);

  return {
    uncertain: false,
    present,
    payment: {
      payerId: payerId.value,
      currency: currency.value,
      amount: amount.value,
      payload: payload.value,
      chargeId: chargeId.value,
      valid,
    },
  };
}

function readProperty(record, key) {
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function isBoundedOpaqueId(value) {
  return (
    typeof value === "string" &&
    textEncoder.encode(value).byteLength <= 256 &&
    /\S/u.test(value) &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function isTelegramNumericId(value) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= telegramMaximumUserId
  );
}

function isOptionalLanguageCode(value) {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length >= 2 &&
      value.length <= 35 &&
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value))
  );
}

function isStarsAmount(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= starsAmountLimits.min &&
    value <= starsAmountLimits.max
  );
}

function isPrivateInvoicePayload(value) {
  return typeof value === "string" && /^pay_[A-Za-z0-9_-]{43}$/u.test(value);
}

async function answerPreCheckout({
  botApi,
  answerPreCheckoutQuery,
  id,
  approved,
  languageCode,
}) {
  const answer = approved
    ? { id, ok: true }
    : {
        id,
        ok: false,
        errorMessage: preCheckoutRejectionText[localeFromLanguageCode(languageCode)],
      };
  try {
    await answerPreCheckoutQuery.call(botApi, answer);
  } catch {
    throw serviceUnavailableError();
  }
}

function normalizePendingPaymentRow(row, expectedPayload) {
  try {
    if (
      !isRecord(row) ||
      typeof row.invoice_id !== "string" ||
      !/^inv_[A-Za-z0-9_-]{22}$/u.test(row.invoice_id) ||
      row.invoice_payload !== expectedPayload ||
      !/^pay_[A-Za-z0-9_-]{43}$/u.test(row.invoice_payload) ||
      typeof row.telegram_user_id !== "string" ||
      !/^[1-9]\d*$/u.test(row.telegram_user_id) ||
      !Number.isSafeInteger(Number(row.telegram_user_id)) ||
      Number(row.telegram_user_id) > telegramMaximumUserId ||
      row.user_key !== `telegram:${row.telegram_user_id}` ||
      typeof row.amount !== "number" ||
      !Number.isInteger(row.amount) ||
      row.amount < starsAmountLimits.min ||
      row.amount > starsAmountLimits.max ||
      row.currency !== "XTR" ||
      row.status !== "pending" ||
      row.paid_at !== null ||
      row.failed_at !== null ||
      row.refunded_at !== null ||
      row.telegram_payment_charge_id !== null
    ) {
      return null;
    }
    validatedTimestamp(row.created_at);
    validatedTimestamp(row.expires_at);
    if (row.expires_at <= row.created_at) {
      return null;
    }
    return {
      telegramUserId: row.telegram_user_id,
      amount: row.amount,
      currency: row.currency,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

function normalizePaidPaymentRow(row, expectedPayload) {
  try {
    if (
      !hasValidPaymentIdentity(row, expectedPayload) ||
      row.status !== "paid" ||
      row.failed_at !== null ||
      row.refunded_at !== null ||
      !isBoundedOpaqueId(row.telegram_payment_charge_id)
    ) {
      return null;
    }
    validatedTimestamp(row.created_at);
    validatedTimestamp(row.expires_at);
    validatedTimestamp(row.paid_at);
    if (
      row.expires_at <= row.created_at ||
      row.paid_at < row.created_at
    ) {
      return null;
    }
    return {
      telegramUserId: row.telegram_user_id,
      amount: row.amount,
      currency: row.currency,
      chargeId: row.telegram_payment_charge_id,
    };
  } catch {
    return null;
  }
}

function hasValidPaymentIdentity(row, expectedPayload) {
  return (
    isRecord(row) &&
    typeof row.invoice_id === "string" &&
    /^inv_[A-Za-z0-9_-]{22}$/u.test(row.invoice_id) &&
    row.invoice_payload === expectedPayload &&
    isPrivateInvoicePayload(row.invoice_payload) &&
    typeof row.telegram_user_id === "string" &&
    /^[1-9]\d*$/u.test(row.telegram_user_id) &&
    Number.isSafeInteger(Number(row.telegram_user_id)) &&
    Number(row.telegram_user_id) <= telegramMaximumUserId &&
    row.user_key === `telegram:${row.telegram_user_id}` &&
    isStarsAmount(row.amount) &&
    row.currency === "XTR"
  );
}

function localeFromLanguageCode(languageCode) {
  if (typeof languageCode === "string") {
    const normalized = languageCode.toLowerCase();
    if (normalized.startsWith("ru")) {
      return "ru";
    }
    if (normalized.startsWith("zh")) {
      return "zh";
    }
  }
  return "en";
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
