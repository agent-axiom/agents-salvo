import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.js";
import { createSession } from "../worker/session.js";
import * as starsSupportModule from "../worker/stars-support.js";

const [profileSchema, sessionSchema, paymentSchema] = await Promise.all([
  readFile(new URL("../migrations/0001_player_profiles.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/0003_mobile_oidc_sessions.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/0004_star_support_payments.sql", import.meta.url), "utf8"),
]);

const pendingInvoice = {
  invoiceId: "inv_AAAAAAAAAAAAAAAAAAAAAA",
  invoicePayload: "pay_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  userKey: "telegram:8710001168",
  telegramUserId: "8710001168",
  amount: 88,
  createdAt: 1_784_332_800,
  expiresAt: 1_784_333_700,
};
const authenticatedUser = Object.freeze({
  provider: "telegram",
  id: "8710001168",
  name: "Salvo Supporter",
  username: "supporter",
  photoUrl: "https://t.me/i/userpic/320/example.jpg",
});
const serviceNow = 1_784_332_800;
const botToken = "123456:test-bot-token";
const webhookSecret = "stars_webhook_secret_1234567890AB";

test("Worker exposes only the exact Stars payment and Telegram webhook routes", async () => {
  let durableObjectReads = 0;
  const env = {
    get BATTLE_ROOM() {
      durableObjectReads += 1;
      throw new Error("payment routes must not access Durable Objects");
    },
  };

  const create = await worker.fetch(
    new Request("https://worker.test/payments/stars/invoices", { method: "POST" }),
    env,
  );
  assert.equal(create.status, 401);
  assert.equal(create.headers.get("Access-Control-Allow-Origin"), "*");

  const status = await worker.fetch(
    new Request(`https://worker.test/payments/stars/invoices/${pendingInvoice.invoiceId}`),
    env,
  );
  assert.equal(status.status, 401);
  assert.equal(status.headers.get("Access-Control-Allow-Origin"), "*");

  for (const path of [
    "/payments/stars/invoices/",
    "/Payments/stars/invoices",
    "/payments/stars/invoices/extra/path",
    "/payments/stars/invoices?next=1",
    `/payments/stars/invoices/${pendingInvoice.invoiceId}/`,
    `/payments/stars/invoices/${pendingInvoice.invoiceId}?next=1`,
    "/payments/stars/invoices/inv_short",
    `/payments/stars/invoices/inv_${"A".repeat(21)}!`,
  ]) {
    const response = await worker.fetch(
      new Request(`https://worker.test${path}`, { method: path.includes(pendingInvoice.invoiceId) ? "GET" : "POST" }),
      env,
    );
    assert.equal(response.status, 404, path);
  }

  for (const [method, path] of [
    ["GET", "/payments/stars/invoices"],
    ["PUT", "/payments/stars/invoices"],
    ["POST", `/payments/stars/invoices/${pendingInvoice.invoiceId}`],
    ["PUT", `/payments/stars/invoices/${pendingInvoice.invoiceId}`],
  ]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, { method }), env);
    assert.equal(response.status, 404, `${method} ${path}`);
  }

  for (const path of [
    "/payments/stars/invoices",
    `/payments/stars/invoices/${pendingInvoice.invoiceId}`,
  ]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, { method: "OPTIONS" }), env);
    assert.equal(response.status, 200, `OPTIONS ${path}`);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }

  const webhook = await worker.fetch(
    new Request("https://worker.test/telegram/webhook", { method: "POST" }),
    env,
  );
  assert.equal(webhook.status, 503);
  assertWebhookHeaders(webhook);

  for (const method of ["GET", "PUT", "OPTIONS"]) {
    const response = await worker.fetch(
      new Request("https://worker.test/telegram/webhook", { method }),
      env,
    );
    assert.equal(response.status, 404, `${method} /telegram/webhook`);
    assert.deepEqual(await response.json(), { error: "Not found" });
    assertWebhookHeaders(response);
  }

  for (const path of [
    "/telegram/webhook/",
    "/Telegram/webhook",
    "/telegram/webhook/extra",
    "/telegram/webhook?update=1",
  ]) {
    const response = await worker.fetch(
      new Request(`https://worker.test${path}`, { method: "POST" }),
      env,
    );
    assert.equal(response.status, 404, path);
    assertWebhookHeaders(response);
  }

  assert.equal(durableObjectReads, 0);
});

test("Worker creates an owner-bound Stars invoice before calling Telegram", async (t) => {
  const db = memoryD1(t);
  const token = await createWorkerSession(db);
  const providerCalls = [];
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    async TELEGRAM_FETCH(url, init) {
      providerCalls.push({ url, init, body: JSON.parse(init.body) });
      const row = db.queryOne("SELECT * FROM star_support_payments");
      assert.ok(row, "invoice must be persisted before the Bot API call");
      assert.equal(row.status, "pending");
      return telegramResponse(`https://t.me/$${"I".repeat(22)}`);
    },
  };

  const response = await postStarsInvoice({ amount: 88, locale: "ru" }, env, token);

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ["invoiceId", "invoiceUrl", "amount", "currency", "expiresAt"]);
  assert.match(payload.invoiceId, /^inv_[A-Za-z0-9_-]{22}$/u);
  assert.equal(payload.invoiceUrl, `https://t.me/$${"I".repeat(22)}`);
  assert.equal(payload.amount, 88);
  assert.equal(payload.currency, "XTR");
  assert.equal(typeof payload.expiresAt, "string");

  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, `https://api.telegram.org/bot${botToken}/createInvoiceLink`);
  assert.deepEqual(providerCalls[0].body, {
    title: "Поддержать Salvo",
    description: "Добровольная поддержка Salvo. Она не дает преимуществ в игре.",
    payload: providerCalls[0].body.payload,
    currency: "XTR",
    prices: [{ label: "Добровольная поддержка", amount: 88 }],
  });
  assert.match(providerCalls[0].body.payload, /^pay_[A-Za-z0-9_-]{43}$/u);

  const row = db.queryOne("SELECT * FROM star_support_payments");
  assert.equal(row.invoice_id, payload.invoiceId);
  assert.equal(row.invoice_payload, providerCalls[0].body.payload);
  assert.equal(row.user_key, pendingInvoice.userKey);
  assert.equal(row.telegram_user_id, pendingInvoice.telegramUserId);
  assert.equal(row.amount, 88);
  assert.equal(row.currency, "XTR");
  assert.equal(row.status, "pending");
  assert.equal(new Date(row.expires_at * 1_000).toISOString(), payload.expiresAt);
});

test("Worker returns only owner-scoped public Stars invoice statuses", async (t) => {
  const db = memoryD1(t);
  const ownerToken = await createWorkerSession(db);
  const outsiderToken = await createWorkerSession(db, {
    ...authenticatedUser,
    id: "8710001169",
    username: "outsider",
  });
  const now = Math.floor(Date.now() / 1_000);
  const statuses = [
    {
      invoiceId: `inv_${"P".repeat(22)}`,
      invoicePayload: `pay_${"P".repeat(43)}`,
      status: "pending",
      createdAt: now - 30,
      expiresAt: now + 870,
      expected: "pending",
    },
    {
      invoiceId: `inv_${"A".repeat(22)}`,
      invoicePayload: `pay_${"A".repeat(43)}`,
      status: "pending",
      createdAt: now - 1_000,
      expiresAt: now - 100,
      expected: "expired",
    },
    {
      invoiceId: `inv_${"D".repeat(22)}`,
      invoicePayload: `pay_${"D".repeat(43)}`,
      status: "paid",
      createdAt: now - 100,
      expiresAt: now + 800,
      paidAt: now - 10,
      telegramPaymentChargeId: "charge_public_projection_test",
      expected: "paid",
    },
    {
      invoiceId: `inv_${"F".repeat(22)}`,
      invoicePayload: `pay_${"F".repeat(43)}`,
      status: "failed",
      createdAt: now - 100,
      expiresAt: now + 800,
      failedAt: now - 20,
      expected: "failed",
    },
  ];
  for (const invoice of statuses) {
    insertPayment(db, invoice);
  }
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_FETCH: async () => {
      throw new Error("status reads must not call Telegram");
    },
  };

  for (const invoice of statuses) {
    const response = await worker.fetch(
      new Request(`https://worker.test/payments/stars/invoices/${invoice.invoiceId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }),
      env,
    );
    assert.equal(response.status, 200, invoice.expected);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload), [
      "invoiceId",
      "amount",
      "currency",
      "status",
      "createdAt",
      "expiresAt",
      "paidAt",
    ]);
    assert.equal(payload.invoiceId, invoice.invoiceId);
    assert.equal(payload.status, invoice.expected);
    assert.equal(payload.amount, pendingInvoice.amount);
    assert.equal(payload.currency, "XTR");
    assert.equal(payload.paidAt, invoice.paidAt ? new Date(invoice.paidAt * 1_000).toISOString() : null);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(invoice.invoicePayload), false);
    assert.equal(serialized.includes(invoice.telegramPaymentChargeId ?? "never-present"), false);
  }

  for (const [name, invoiceId, bearer] of [
    ["wrong owner", statuses[0].invoiceId, outsiderToken],
    ["unknown", `inv_${"U".repeat(22)}`, ownerToken],
  ]) {
    const response = await worker.fetch(
      new Request(`https://worker.test/payments/stars/invoices/${invoiceId}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      }),
      env,
    );
    assert.equal(response.status, 404, name);
    assert.deepEqual(await response.json(), { error: "Stars invoice not found" });
  }
});

test("Worker rejects unauthorized Stars requests before body or provider access", async (t) => {
  const db = memoryD1(t);
  const now = Math.floor(Date.now() / 1_000);
  const expiredToken = (
    await createSession(db, authenticatedUser, {
      now: now - 10,
      ttlSeconds: 1,
    })
  ).token;
  let providerCalls = 0;
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    async TELEGRAM_FETCH() {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  };

  const cases = [
    ["missing", undefined, "Authentication required"],
    ["malformed", "invalid", "Authentication failed"],
    ["expired", expiredToken, "Authentication failed"],
  ];
  for (const [name, token, message] of cases) {
    const create = await rawStarsInvoiceRequest("{not-json", env, token);
    assert.equal(create.status, 401, name);
    assert.deepEqual(await create.json(), { error: message });

    const status = await worker.fetch(
      new Request(`https://worker.test/payments/stars/invoices/${pendingInvoice.invoiceId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
      env,
    );
    assert.equal(status.status, 401, name);
    assert.deepEqual(await status.json(), { error: message });
  }

  assert.equal(providerCalls, 0);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM star_support_payments").count, 0);
});

test("Worker accepts only the exact bounded Stars create JSON schema", async (t) => {
  const db = memoryD1(t);
  const token = await createWorkerSession(db);
  let providerCalls = 0;
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    async TELEGRAM_FETCH() {
      providerCalls += 1;
      return telegramResponse(`https://t.me/$${"V".repeat(22)}`);
    },
  };
  const invalidBodies = [
    ["malformed JSON", "{not-json"],
    ["null", "null"],
    ["array", '[88,"en"]'],
    ["empty object", "{}"],
    ["missing amount", '{"locale":"en"}'],
    ["missing locale", '{"amount":88}'],
    ["unknown field", '{"amount":88,"locale":"en","currency":"XTR"}'],
    ["identity field", '{"amount":88,"locale":"en","user":{"id":"8710001168"}}'],
    ["title field", '{"amount":88,"locale":"en","title":"Owned by client"}'],
    ["duplicate amount", '{"amount":1,"amount":88,"locale":"en"}'],
    ["escaped duplicate amount", '{"amount":1,"am\\u006funt":88,"locale":"en"}'],
    ["duplicate locale", '{"amount":88,"locale":"en","locale":"ru"}'],
    ["string amount", '{"amount":"88","locale":"en"}'],
    ["fractional amount", '{"amount":8.8,"locale":"en"}'],
    ["zero amount", '{"amount":0,"locale":"en"}'],
    ["negative amount", '{"amount":-1,"locale":"en"}'],
    ["large amount", '{"amount":10001,"locale":"en"}'],
    ["boolean amount", '{"amount":true,"locale":"en"}'],
    ["array locale", '{"amount":88,"locale":["en"]}'],
    ["coercive locale", '{"amount":88,"locale":{"toString":"en"}}'],
    ["unsupported locale", '{"amount":88,"locale":"EN"}'],
  ];

  for (const [name, body] of invalidBodies) {
    const response = await rawStarsInvoiceRequest(body, env, token);
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { error: "Invalid Stars support request" }, name);
  }

  for (const contentType of [
    null,
    "text/plain",
    "application/problem+json",
    "application/json; charset=utf-8",
    "Application/JSON",
  ]) {
    const response = await rawStarsInvoiceRequest(
      '{"amount":88,"locale":"en"}',
      env,
      token,
      contentType,
    );
    assert.equal(response.status, 400, String(contentType));
    assert.deepEqual(await response.json(), { error: "Invalid Stars support request" });
  }

  for (const contentLength of ["1025", "-1", "1.5", "not-a-number", "999999999999999999999999"]) {
    const response = await rawStarsInvoiceRequest(
      '{"amount":88,"locale":"en"}',
      env,
      token,
      "application/json",
      { "Content-Length": contentLength },
    );
    assert.equal(response.status, 400, contentLength);
  }

  const oversizedBody = `${'{"amount":88,"locale":"en"}'}${" ".repeat(1025)}`;
  const oversized = await rawStarsInvoiceRequest(oversizedBody, env, token);
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "Invalid Stars support request" });

  assert.equal(providerCalls, 0);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM star_support_payments").count, 0);

  const compactBody = '{"amount":88,"locale":"en"}';
  const exactBoundary = `${compactBody}${" ".repeat(1024 - textByteLength(compactBody))}`;
  assert.equal(textByteLength(exactBoundary), 1024);
  const accepted = await rawStarsInvoiceRequest(exactBoundary, env, token);
  assert.equal(accepted.status, 201);
  assert.equal(providerCalls, 1);
});

test("Worker classifies Stars configuration, D1, and provider failures as redacted 503s", async (t) => {
  const db = memoryD1(t);
  const token = await createWorkerSession(db);
  const secrets = [
    botToken,
    "private-config-getter-value",
    "private-session-sql-value",
    "private-payment-sql-value",
    "private-provider-response-value",
  ];
  const baseEnv = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_FETCH: async () => telegramResponse(`https://t.me/$${"S".repeat(22)}`),
  };
  const paymentFailureDb = {
    prepare(sql) {
      if (sql.includes("star_support_payments")) {
        throw new Error("private-payment-sql-value");
      }
      return db.prepare(sql);
    },
  };
  const sessionFailureDb = {
    prepare(sql) {
      if (sql.includes("auth_sessions")) {
        throw new Error("private-session-sql-value");
      }
      return db.prepare(sql);
    },
  };
  const throwingConfig = { DB: db };
  Object.defineProperty(throwingConfig, "TELEGRAM_BOT_TOKEN", {
    get() {
      throw new Error("private-config-getter-value");
    },
  });
  const createCases = [
    ["missing token", { DB: db }],
    ["malformed token", { ...baseEnv, TELEGRAM_BOT_TOKEN: "malformed-private-token" }],
    ["malformed fetcher", { ...baseEnv, TELEGRAM_FETCH: "not-a-function" }],
    ["throwing config", throwingConfig],
    ["payment D1 failure", { ...baseEnv, DB: paymentFailureDb }],
    [
      "provider failure",
      {
        ...baseEnv,
        async TELEGRAM_FETCH() {
          throw new Error("private-provider-response-value");
        },
      },
    ],
  ];

  for (const [name, env] of createCases) {
    const response = await postStarsInvoice({ amount: 88, locale: "en" }, env, token);
    const text = await response.text();
    assert.equal(response.status, 503, name);
    assert.equal(text, JSON.stringify({ error: "Stars support is unavailable" }), name);
    assert.equal(textByteLength(text) < 256, true);
    assertRedacted(text, secrets);
  }

  const sessionFailure = await postStarsInvoice(
    { amount: 88, locale: "en" },
    { ...baseEnv, DB: sessionFailureDb },
    token,
  );
  const sessionFailureText = await sessionFailure.text();
  assert.equal(sessionFailure.status, 503);
  assert.equal(sessionFailureText, JSON.stringify({ error: "Stars support is unavailable" }));
  assertRedacted(sessionFailureText, secrets);

  for (const [name, env] of [
    ["missing status config", { DB: db }],
    ["status D1 failure", { ...baseEnv, DB: paymentFailureDb }],
  ]) {
    const response = await worker.fetch(
      new Request(`https://worker.test/payments/stars/invoices/${pendingInvoice.invoiceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    const text = await response.text();
    assert.equal(response.status, 503, name);
    assert.equal(text, JSON.stringify({ error: "Stars support is unavailable" }));
    assertRedacted(text, secrets);
  }
});

test("Worker strictly validates the bounded Stars invoice creation body", async (t) => {
  const db = memoryD1(t);
  const token = await createWorkerSession(db);
  let telegramCalls = 0;
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_FETCH: async () => {
      telegramCalls += 1;
      return telegramResponse(`https://t.me/$${"V".repeat(22)}`);
    },
  };
  const invalidBodies = [
    { name: "unknown key", body: '{"amount":88,"locale":"en","private":"pay_secret"}' },
    { name: "missing amount", body: '{"locale":"en"}' },
    { name: "missing locale", body: '{"amount":88}' },
    { name: "duplicate amount", body: '{"amount":88,"amount":89,"locale":"en"}' },
    { name: "duplicate locale", body: '{"amount":88,"locale":"en","locale":"ru"}' },
    { name: "malformed JSON", body: '{"amount":88,"locale":"en"' },
    { name: "array", body: '[88,"en"]' },
    { name: "string amount", body: '{"amount":"88","locale":"en"}' },
    { name: "boolean amount", body: '{"amount":true,"locale":"en"}' },
    { name: "fractional amount", body: '{"amount":1.5,"locale":"en"}' },
    { name: "amount below range", body: '{"amount":0,"locale":"en"}' },
    { name: "amount above range", body: '{"amount":10001,"locale":"en"}' },
    { name: "coerced locale", body: '{"amount":88,"locale":["en"]}' },
    { name: "unknown locale", body: '{"amount":88,"locale":"EN"}' },
    {
      name: "oversized body",
      body: `{"amount":88,"locale":"en"${" ".repeat(1_024)}}`,
    },
  ];

  for (const { name, body } of invalidBodies) {
    const response = await postStarsInvoice(body, env, token);
    const text = await response.text();
    assert.equal(response.status, 400, name);
    assert.deepEqual(JSON.parse(text), { error: "Invalid Stars support request" }, name);
    assert.doesNotMatch(text, /pay_secret|private|stack|syntax|position/i, name);
  }

  const wrongContentType = await postStarsInvoice(
    { amount: 88, locale: "en" },
    env,
    token,
    "text/plain",
  );
  assert.equal(wrongContentType.status, 400);
  assert.deepEqual(await wrongContentType.json(), { error: "Invalid Stars support request" });

  assert.equal(telegramCalls, 0);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM star_support_payments").count, 0);
});

test("Telegram webhook requires valid configuration and an exact secret", async (t) => {
  const db = memoryD1(t);
  const baseEnv = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_FETCH: async () => {
      throw new Error("ignored updates must not call Telegram");
    },
  };

  for (const suppliedSecret of [
    undefined,
    "wrong_webhook_secret_1234567890AB",
    `${webhookSecret}x`,
    `x${webhookSecret}`,
    webhookSecret.toUpperCase(),
  ]) {
    const response = await postTelegramWebhook(
      { update_id: 101 },
      baseEnv,
      suppliedSecret,
    );
    assert.equal(response.status, 403, String(suppliedSecret));
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assertWebhookHeaders(response);
  }

  const valid = await postTelegramWebhook({ update_id: 102 }, baseEnv, webhookSecret);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { ok: true });
  assertWebhookHeaders(valid);

  const invalidConfigurations = [
    { TELEGRAM_WEBHOOK_SECRET: undefined },
    { TELEGRAM_WEBHOOK_SECRET: "A".repeat(31) },
    { TELEGRAM_WEBHOOK_SECRET: "A".repeat(257) },
    { TELEGRAM_WEBHOOK_SECRET: "A".repeat(31) + ":" },
    { TELEGRAM_WEBHOOK_SECRET: new String(webhookSecret) },
    { TELEGRAM_BOT_TOKEN: "token_private_malformed" },
    { DB: null },
    { DB: {} },
    { TELEGRAM_FETCH: "not-a-fetch-function" },
  ];
  for (const override of invalidConfigurations) {
    const response = await postTelegramWebhook(
      { update_id: 103 },
      { ...baseEnv, ...override },
      webhookSecret,
    );
    const text = await response.text();
    assert.equal(response.status, 503, JSON.stringify(override));
    assert.deepEqual(JSON.parse(text), { error: "Stars support is unavailable" });
    assert.doesNotMatch(text, /token_private|webhook_secret|stack|prepare|fetch/i);
    assertWebhookHeaders(response);
  }
});

test("Telegram webhook accepts only an exact bounded JSON object body", async (t) => {
  const db = memoryD1(t);
  let telegramCalls = 0;
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    async TELEGRAM_FETCH() {
      telegramCalls += 1;
      throw new Error("ignored updates must not call Telegram");
    },
  };
  const invalidBodies = [
    ["empty", ""],
    ["malformed", "{not-json"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"update"'],
    ["number", "42"],
  ];
  for (const [name, body] of invalidBodies) {
    const response = await rawTelegramWebhookRequest(body, env, webhookSecret);
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { error: "Invalid Telegram update" });
    assertWebhookHeaders(response);
  }

  for (const contentType of [null, "text/plain", "application/problem+json", "application/json; charset=utf-8", "Application/JSON"]) {
    const response = await rawTelegramWebhookRequest("{}", env, webhookSecret, contentType);
    assert.equal(response.status, 400, String(contentType));
    assert.deepEqual(await response.json(), { error: "Invalid Telegram update" });
    assertWebhookHeaders(response);
  }

  for (const contentLength of ["65537", "-1", "1.5", "not-a-number", "999999999999999999999999"]) {
    const response = await rawTelegramWebhookRequest(
      "{}",
      env,
      webhookSecret,
      "application/json",
      { "Content-Length": contentLength },
    );
    assert.equal(response.status, 400, contentLength);
    assertWebhookHeaders(response);
  }

  const compactUpdate = '{"update_id":500}';
  const boundaryUpdate = `${compactUpdate}${" ".repeat(64 * 1024 - textByteLength(compactUpdate))}`;
  assert.equal(textByteLength(boundaryUpdate), 64 * 1024);
  const boundary = await rawTelegramWebhookRequest(boundaryUpdate, env, webhookSecret);
  assert.equal(boundary.status, 200);
  assert.deepEqual(await boundary.json(), { ok: true });

  const oversized = await rawTelegramWebhookRequest(`${boundaryUpdate} `, env, webhookSecret);
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "Invalid Telegram update" });

  const forbiddenBeforeBody = await rawTelegramWebhookRequest(
    `${boundaryUpdate} `,
    env,
    "wrong_webhook_secret_1234567890AB",
  );
  assert.equal(forbiddenBeforeBody.status, 403);
  assert.deepEqual(await forbiddenBeforeBody.json(), { error: "Forbidden" });
  assertWebhookHeaders(forbiddenBeforeBody);
  assert.equal(telegramCalls, 0);
});

test("Telegram webhook reads only bounded application/json streams", async (t) => {
  const db = memoryD1(t);
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_FETCH: async () => {
      throw new Error("invalid updates must not call Telegram");
    },
  };

  for (const [name, body, contentType] of [
    ["missing media type", '{"update_id":301}', null],
    ["wrong media type", '{"update_id":302}', "text/plain"],
    ["media type parameter", '{"update_id":303}', "application/json; charset=utf-8"],
    ["malformed JSON", '{"update_id":304', "application/json"],
    ["null JSON", "null", "application/json"],
    ["array JSON", "[]", "application/json"],
  ]) {
    const response = await rawTelegramWebhookRequest(body, env, {
      contentType,
      secret: webhookSecret,
    });
    assert.equal(response.status, 400, name);
    assert.deepEqual(await response.json(), { error: "Invalid Telegram update" }, name);
    assertWebhookHeaders(response);
  }

  for (const contentLength of ["65537", "-1", "1.5", "unknown", "9".repeat(128)]) {
    const response = await rawTelegramWebhookRequest('{"update_id":305}', env, {
      contentLength,
      secret: webhookSecret,
    });
    assert.equal(response.status, 400, contentLength);
    assert.deepEqual(await response.json(), { error: "Invalid Telegram update" });
  }

  const oversized = `{"update_id":306,"padding":"${"x".repeat(64 * 1024)}"}`;
  const oversizedResponse = await rawTelegramWebhookRequest(oversized, env, {
    secret: webhookSecret,
  });
  assert.equal(oversizedResponse.status, 400);
  assert.deepEqual(await oversizedResponse.json(), { error: "Invalid Telegram update" });

  const compact = '{"update_id":307,"padding":""}';
  const exactBoundary = compact.replace(
    '""',
    `"${"x".repeat(64 * 1024 - textByteLength(compact))}"`,
  );
  assert.equal(textByteLength(exactBoundary), 64 * 1024);
  let textCalls = 0;
  let jsonCalls = 0;
  const streamedRequest = streamTelegramWebhookRequest(exactBoundary, {
    onText() {
      textCalls += 1;
    },
    onJson() {
      jsonCalls += 1;
    },
  });
  const accepted = await worker.fetch(streamedRequest, env);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.equal(textCalls, 0);
  assert.equal(jsonCalls, 0);
});

test("Telegram webhook processes pre-checkout and successful payment with a private response", async (t) => {
  const db = memoryD1(t);
  const now = Math.floor(Date.now() / 1_000);
  const invoice = {
    ...pendingInvoice,
    createdAt: now - 30,
    expiresAt: now + 870,
  };
  insertPendingInvoice(db, invoice);
  const answers = [];
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    async TELEGRAM_FETCH(url, init) {
      assert.equal(url, `https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`);
      answers.push(JSON.parse(init.body));
      return telegramResponse(true);
    },
  };
  const preCheckout = {
    update_id: 600,
    pre_checkout_query: {
      id: "pre-checkout-worker-valid",
      from: { id: Number(invoice.telegramUserId), language_code: "en" },
      currency: "XTR",
      total_amount: invoice.amount,
      invoice_payload: invoice.invoicePayload,
    },
  };

  const approved = await postTelegramWebhook(preCheckout, env, webhookSecret);
  const approvedText = await approved.text();
  assert.equal(approved.status, 200);
  assert.equal(approvedText, JSON.stringify({ ok: true }));
  assertWebhookHeaders(approved);
  assert.deepEqual(answers, [{ pre_checkout_query_id: "pre-checkout-worker-valid", ok: true }]);
  assert.equal(db.queryOne("SELECT status FROM star_support_payments").status, "pending");

  const successfulPayment = {
    update_id: 601,
    message: {
      message_id: 602,
      date: now,
      from: { id: Number(invoice.telegramUserId), language_code: "en" },
      chat: { id: Number(invoice.telegramUserId), type: "private" },
      text: "/support",
      successful_payment: {
        currency: "XTR",
        total_amount: invoice.amount,
        invoice_payload: invoice.invoicePayload,
        telegram_payment_charge_id: "charge_worker_success_600",
        provider_payment_charge_id: "must-not-be-returned",
      },
    },
  };
  const paid = await postTelegramWebhook(successfulPayment, env, webhookSecret);
  const paidText = await paid.text();
  assert.equal(paid.status, 200);
  assert.equal(paidText, JSON.stringify({ ok: true }));
  assertWebhookHeaders(paid);
  assertRedacted(paidText, [
    invoice.invoicePayload,
    "charge_worker_success_600",
    "must-not-be-returned",
    invoice.userKey,
  ]);
  const paidRow = db.queryOne("SELECT * FROM star_support_payments");
  assert.equal(paidRow.status, "paid");
  assert.equal(paidRow.telegram_payment_charge_id, "charge_worker_success_600");

  const duplicate = await postTelegramWebhook(successfulPayment, env, webhookSecret);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true });
  assert.equal(answers.length, 1, "successful payments must not be treated as commands");
});

test("Telegram webhook retries transient payment failures but acknowledges permanent conflicts", async (t) => {
  const db = memoryD1(t);
  const now = Math.floor(Date.now() / 1_000);
  const invoice = { ...pendingInvoice, createdAt: now - 30, expiresAt: now + 870 };
  insertPendingInvoice(db, invoice);
  const d1Secret = "private-webhook-d1-failure";
  const providerSecret = "private-webhook-provider-failure";
  const failingPaymentDb = {
    prepare(sql) {
      if (sql.includes("star_support_payments")) {
        throw new Error(d1Secret);
      }
      return db.prepare(sql);
    },
  };
  const preCheckout = {
    pre_checkout_query: {
      id: "pre-checkout-worker-retry",
      from: { id: Number(invoice.telegramUserId), language_code: "en" },
      currency: "XTR",
      total_amount: invoice.amount,
      invoice_payload: invoice.invoicePayload,
    },
  };
  const successfulPayment = {
    message: {
      from: { id: Number(invoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: invoice.amount,
        invoice_payload: invoice.invoicePayload,
        telegram_payment_charge_id: "charge_worker_retry_601",
      },
    },
  };
  const answerSuccess = async () => telegramResponse(true);
  const baseEnv = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    TELEGRAM_FETCH: answerSuccess,
  };

  const d1PreCheckout = await postTelegramWebhook(
    preCheckout,
    { ...baseEnv, DB: failingPaymentDb },
    webhookSecret,
  );
  const d1PreCheckoutText = await d1PreCheckout.text();
  assert.equal(d1PreCheckout.status, 503);
  assert.equal(d1PreCheckoutText, JSON.stringify({ error: "Stars support is unavailable" }));
  assertRedacted(d1PreCheckoutText, [d1Secret, invoice.invoicePayload]);

  const d1Payment = await postTelegramWebhook(
    successfulPayment,
    { ...baseEnv, DB: failingPaymentDb },
    webhookSecret,
  );
  const d1PaymentText = await d1Payment.text();
  assert.equal(d1Payment.status, 503);
  assert.equal(d1PaymentText, JSON.stringify({ error: "Stars support is unavailable" }));
  assertRedacted(d1PaymentText, [d1Secret, invoice.invoicePayload, "charge_worker_retry_601"]);

  const providerFailure = await postTelegramWebhook(
    preCheckout,
    {
      ...baseEnv,
      async TELEGRAM_FETCH() {
        throw new Error(providerSecret);
      },
    },
    webhookSecret,
  );
  const providerFailureText = await providerFailure.text();
  assert.equal(providerFailure.status, 503);
  assert.equal(providerFailureText, JSON.stringify({ error: "Stars support is unavailable" }));
  assertRedacted(providerFailureText, [providerSecret, invoice.invoicePayload]);

  const conflictDb = memoryD1(t);
  insertPendingInvoice(conflictDb, invoice);
  insertPayment(conflictDb, {
    invoiceId: `inv_${"C".repeat(22)}`,
    invoicePayload: `pay_${"C".repeat(43)}`,
    status: "paid",
    createdAt: now - 100,
    expiresAt: now + 800,
    paidAt: now - 20,
    telegramPaymentChargeId: "charge_worker_retry_601",
  });
  const permanentConflict = await postTelegramWebhook(
    successfulPayment,
    { ...baseEnv, DB: conflictDb },
    webhookSecret,
  );
  assert.equal(permanentConflict.status, 200);
  assert.deepEqual(await permanentConflict.json(), { ok: true });
  assert.equal(
    conflictDb.queryOne("SELECT status FROM star_support_payments WHERE invoice_id = ?", invoice.invoiceId).status,
    "pending",
  );
});

test("Telegram webhook sends localized private support command replies", async (t) => {
  const db = memoryD1(t);
  const sent = [];
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    async TELEGRAM_FETCH(url, init) {
      sent.push({ url, body: JSON.parse(init.body) });
      const body = sent.at(-1).body;
      return telegramResponse({
        message_id: sent.length,
        date: 1_784_332_800,
        chat: { id: Number(body.chat_id), type: "private" },
      });
    },
  };
  const cases = [
    {
      text: "/terms",
      languageCode: "en",
      command: "terms",
      expectedText: "Terms of Support: https://agent-axiom.github.io/agents-salvo/support.html",
    },
    {
      text: "/support@agents_salvo_bot",
      languageCode: "ru-RU",
      command: "support",
      expectedText:
        "Поддержка покупок: https://github.com/agent-axiom/agents-salvo/issues. Поддержка Telegram не может решить проблему с этой покупкой. Не публикуйте токены сессий, содержимое счетов или идентификаторы платежных списаний.",
    },
    {
      text: "/paysupport",
      languageCode: "zh-CN",
      command: "paysupport",
      expectedText:
        "购买支持：https://github.com/agent-axiom/agents-salvo/issues。Telegram 支持无法解决此购买问题。请勿发布会话令牌、账单载荷或付款扣款 ID。",
    },
  ];

  for (const [index, commandCase] of cases.entries()) {
    const chatId = 8710001168 + index;
    const response = await postTelegramWebhook(
      {
        update_id: 200 + index,
        message: {
          message_id: 300 + index,
          date: 1_784_332_800,
          from: { id: chatId, language_code: commandCase.languageCode },
          chat: { id: chatId, type: "private" },
          text: commandCase.text,
        },
      },
      env,
      webhookSecret,
    );
    assert.equal(response.status, 200, commandCase.command);
    assert.deepEqual(await response.json(), { ok: true });
    assertWebhookHeaders(response);
    assert.equal(sent.at(-1).url, `https://api.telegram.org/bot${botToken}/sendMessage`);
    assert.deepEqual(sent.at(-1).body, {
      chat_id: chatId,
      text: commandCase.expectedText,
      disable_web_page_preview: true,
    });
  }
});

test("Telegram webhook ignores unsupported and malformed command updates without side effects", async (t) => {
  const db = memoryD1(t);
  let telegramCalls = 0;
  const env = {
    DB: db,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: webhookSecret,
    async TELEGRAM_FETCH() {
      telegramCalls += 1;
      throw new Error("unsupported updates must not call Telegram");
    },
  };
  const privateMessage = {
    message_id: 900,
    date: Math.floor(Date.now() / 1_000),
    from: { id: 8710001168, language_code: "en" },
    chat: { id: 8710001168, type: "private" },
    text: "/terms",
  };
  const updates = [
    {},
    { update_id: 900, edited_message: privateMessage },
    { message: { ...privateMessage, text: "/Terms" } },
    { message: { ...privateMessage, text: "/terms " } },
    { message: { ...privateMessage, text: "/terms@other_bot" } },
    { message: { ...privateMessage, text: "/unknown" } },
    { message: { ...privateMessage, chat: { id: 8710001168, type: "group" } } },
    { message: { ...privateMessage, chat: { id: 0, type: "private" } } },
    { message: { ...privateMessage, chat: { id: Number.MAX_SAFE_INTEGER + 1, type: "private" } } },
    { message: { ...privateMessage, chat: { id: "01", type: "private" } } },
    { message: { ...privateMessage, chat: null } },
    { message: { ...privateMessage, from: null } },
    { message: { ...privateMessage, text: null } },
    { message: { ...privateMessage, successful_payment: {}, text: "/paysupport" } },
  ];

  for (const [index, update] of updates.entries()) {
    const response = await postTelegramWebhook(
      { update_id: 910 + index, ...update },
      env,
      webhookSecret,
    );
    assert.equal(response.status, 200, String(index));
    assert.deepEqual(await response.json(), { ok: true }, String(index));
    assertWebhookHeaders(response);
  }
  assert.equal(telegramCalls, 0);
});

test("Telegram webhook redacts support command provider failures", async (t) => {
  const db = memoryD1(t);
  const providerSecret = "private-command-provider-response";
  const response = await postTelegramWebhook(
    {
      message: {
        from: { id: 8710001168, language_code: "en" },
        chat: { id: 8710001168, type: "private" },
        text: "/support",
      },
    },
    {
      DB: db,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      async TELEGRAM_FETCH() {
        throw new Error(providerSecret);
      },
    },
    webhookSecret,
  );
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(text, JSON.stringify({ error: "Stars support is unavailable" }));
  assertRedacted(text, [providerSecret, botToken, webhookSecret]);
  assertWebhookHeaders(response);
});

test("Stars support service exports its public limits and factory", () => {
  assert.ok(starsSupportModule, "Stars support module should exist");
  assert.deepEqual(starsSupportModule.starsAmountLimits, { min: 1, max: 10_000 });
  assert.equal(Object.isFrozen(starsSupportModule.starsAmountLimits), true);
  assert.equal(starsSupportModule.starsInvoiceTtlSeconds, 15 * 60);
  assert.equal(typeof starsSupportModule.createStarsSupportService, "function");
});

test("Stars support factory exposes create, lookup, and Telegram update operations", () => {
  const service = starsSupportModule.createStarsSupportService({
    db: { prepare() {} },
    botApi: fakeBotApi(),
  });

  assert.deepEqual(Object.keys(service).sort(), ["createInvoice", "getInvoice", "handleUpdate"]);
  assert.equal(typeof service.createInvoice, "function");
  assert.equal(typeof service.getInvoice, "function");
  assert.equal(typeof service.handleUpdate, "function");
});

test("handleUpdate approves an exact pending Stars pre-checkout without mutating it", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const queries = [];
  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          queries.push({ sql, params });
          return statement.bind(...params);
        },
      };
    },
  };
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });
  const before = database.queryOne(
    "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
    pendingInvoice.invoicePayload,
  );

  const result = await service.handleUpdate({
    update_id: 123,
    pre_checkout_query: {
      id: "pre-checkout-valid-1",
      from: {
        id: Number(pendingInvoice.telegramUserId),
        is_bot: false,
        first_name: "Supporter",
        language_code: "en-US",
      },
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: pendingInvoice.invoicePayload,
      shipping_option_id: "ignored",
      order_info: { email: "ignored@example.test" },
    },
  });

  assert.deepEqual(answers, [{ id: "pre-checkout-valid-1", ok: true }]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WHERE invoice_payload = \?/u);
  assert.deepEqual(queries[0].params, [pendingInvoice.invoicePayload]);
  assert.deepEqual(
    database.queryOne(
      "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
      pendingInvoice.invoicePayload,
    ),
    before,
  );
  assert.deepEqual(result, { kind: "pre_checkout", approved: true });
  assert.deepEqual(Object.keys(result), ["kind", "approved"]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(pendingInvoice.invoicePayload), false);
  assert.equal(serialized.includes(pendingInvoice.telegramUserId), false);
});

test("handleUpdate rejects an unknown valid pre-checkout payload with owned text", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const unknownPayload = `pay_${"C".repeat(43)}`;
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: database,
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });
  const before = database.queryAll("SELECT * FROM star_support_payments");

  const result = await service.handleUpdate({
    pre_checkout_query: {
      id: "pre-checkout-unknown",
      from: { id: Number(pendingInvoice.telegramUserId), language_code: "en" },
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: unknownPayload,
    },
  });

  assert.deepEqual(answers, [
    {
      id: "pre-checkout-unknown",
      ok: false,
      errorMessage: "Payment unavailable. Please create a new invoice.",
    },
  ]);
  assert.deepEqual(database.queryAll("SELECT * FROM star_support_payments"), before);
  assert.deepEqual(result, { kind: "pre_checkout", approved: false });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(unknownPayload), false);
  assert.equal(serialized.includes(pendingInvoice.telegramUserId), false);
});

test("handleUpdate rejects non-payable pre-checkout rows without rewriting them", async (t) => {
  const cases = [
    {
      name: "expired",
      payment: { createdAt: serviceNow - 10, expiresAt: serviceNow },
    },
    {
      name: "created in the future",
      payment: { createdAt: serviceNow + 1, expiresAt: serviceNow + 901 },
    },
    {
      name: "wrong payer",
      payment: { telegramUserId: "8710001169", userKey: "telegram:8710001169" },
    },
    {
      name: "wrong amount",
      query: { total_amount: pendingInvoice.amount + 1 },
    },
    {
      name: "failed",
      payment: { status: "failed", failedAt: serviceNow - 1 },
    },
    {
      name: "paid",
      payment: {
        status: "paid",
        paidAt: serviceNow - 1,
        telegramPaymentChargeId: "charge_already_paid",
      },
    },
    {
      name: "refunded",
      payment: {
        status: "refunded",
        paidAt: serviceNow - 2,
        refundedAt: serviceNow - 1,
        telegramPaymentChargeId: "charge_already_refunded",
      },
    },
    {
      name: "inconsistent owner key",
      payment: { userKey: "telegram:8710001169" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const database = memoryD1(t);
      insertPayment(database, {
        invoiceId: pendingInvoice.invoiceId,
        invoicePayload: pendingInvoice.invoicePayload,
        ...scenario.payment,
      });
      const before = database.queryOne(
        "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
        pendingInvoice.invoicePayload,
      );
      const answers = [];
      const service = starsSupportModule.createStarsSupportService({
        db: database,
        botApi: {
          createInvoiceLink() {},
          async answerPreCheckoutQuery(answer) {
            answers.push(answer);
          },
        },
        now: () => serviceNow,
      });

      const result = await service.handleUpdate({
        pre_checkout_query: {
          id: `pre-checkout-${scenario.name}`,
          from: { id: Number(pendingInvoice.telegramUserId), language_code: "en" },
          currency: "XTR",
          total_amount: pendingInvoice.amount,
          invoice_payload: pendingInvoice.invoicePayload,
          ...scenario.query,
        },
      });

      assert.equal(answers.length, 1);
      assert.deepEqual(answers[0], {
        id: `pre-checkout-${scenario.name}`,
        ok: false,
        errorMessage: "Payment unavailable. Please create a new invoice.",
      });
      assert.deepEqual(result, { kind: "pre_checkout", approved: false });
      assert.deepEqual(
        database.queryOne(
          "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
          pendingInvoice.invoicePayload,
        ),
        before,
      );
    });
  }
});

test("handleUpdate answers a valid pre-checkout ID when the private payload is malformed", async () => {
  let databaseCalls = 0;
  let nowCalls = 0;
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
        throw new Error("D1 must not receive malformed payloads");
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow;
    },
  });

  const result = await service.handleUpdate({
    pre_checkout_query: {
      id: "pre-checkout-malformed-payload",
      from: { id: Number(pendingInvoice.telegramUserId), language_code: "en" },
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: "pay_client_supplied",
    },
  });

  assert.equal(databaseCalls, 0);
  assert.equal(nowCalls, 0);
  assert.deepEqual(answers, [
    {
      id: "pre-checkout-malformed-payload",
      ok: false,
      errorMessage: "Payment unavailable. Please create a new invoice.",
    },
  ]);
  assert.deepEqual(result, { kind: "pre_checkout", approved: false });
});

test("handleUpdate ignores a pre-checkout ID over the 256-byte Bot API bound", async () => {
  let databaseCalls = 0;
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
        throw new Error("invalid IDs must not reach D1");
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });

  const result = await service.handleUpdate({
    pre_checkout_query: {
      id: "💫".repeat(65),
      from: { id: Number(pendingInvoice.telegramUserId) },
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: pendingInvoice.invoicePayload,
    },
  });

  assert.equal(databaseCalls, 0);
  assert.deepEqual(answers, []);
  assert.deepEqual(result, { kind: "ignored" });
});

test("handleUpdate structurally rejects malformed pre-checkout fields before D1", async () => {
  const cases = [
    { name: "null from", query: { from: null } },
    { name: "array from", query: { from: [] } },
    { name: "zero payer", query: { from: { id: 0, language_code: "en" } } },
    {
      name: "unsafe payer",
      query: { from: { id: 2 ** 52, language_code: "en" } },
    },
    { name: "string payer", query: { from: { id: "8710001168", language_code: "en" } } },
    { name: "invalid language type", query: { from: { id: 8710001168, language_code: 42 } } },
    {
      name: "oversize language",
      query: { from: { id: 8710001168, language_code: "x".repeat(36) } },
    },
    { name: "wrong currency", query: { currency: "USD" } },
    { name: "boxed currency", query: { currency: new String("XTR") } },
    { name: "zero amount", query: { total_amount: 0 } },
    { name: "large amount", query: { total_amount: 10_001 } },
    { name: "fractional amount", query: { total_amount: 1.5 } },
    { name: "string amount", query: { total_amount: "88" } },
    { name: "NaN amount", query: { total_amount: Number.NaN } },
    { name: "short payload", query: { invoice_payload: `pay_${"A".repeat(42)}` } },
    { name: "long payload", query: { invoice_payload: `pay_${"A".repeat(44)}` } },
    { name: "public invoice ID", query: { invoice_payload: pendingInvoice.invoiceId } },
    { name: "coercible payload", query: { invoice_payload: { toString: () => pendingInvoice.invoicePayload } } },
  ];
  let databaseCalls = 0;
  let nowCalls = 0;
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
        throw new Error("malformed queries must not reach D1");
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow;
    },
  });

  for (const [index, scenario] of cases.entries()) {
    const id = `pre-checkout-malformed-${index}`;
    const result = await service.handleUpdate({
      pre_checkout_query: {
        id,
        from: { id: Number(pendingInvoice.telegramUserId), language_code: "en" },
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        ...scenario.query,
      },
    });
    assert.deepEqual(result, { kind: "pre_checkout", approved: false }, scenario.name);
    assert.deepEqual(
      answers.at(-1),
      {
        id,
        ok: false,
        errorMessage: "Payment unavailable. Please create a new invoice.",
      },
      scenario.name,
    );
  }

  assert.equal(answers.length, cases.length);
  assert.equal(databaseCalls, 0);
  assert.equal(nowCalls, 0);
});

test("handleUpdate ignores malformed pre-checkout IDs it cannot safely answer", async () => {
  const invalidIds = [
    null,
    undefined,
    "",
    " \t ",
    "query\ncontrol",
    "i".repeat(257),
    "💫".repeat(65),
    42,
    new String("pre-checkout-boxed"),
  ];
  let databaseCalls = 0;
  let nowCalls = 0;
  let botApiCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
      },
    },
    botApi: {
      createInvoiceLink() {},
      answerPreCheckoutQuery() {
        botApiCalls += 1;
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow;
    },
  });

  for (const id of invalidIds) {
    assert.deepEqual(
      await service.handleUpdate({
        pre_checkout_query: {
          id,
          from: { id: Number(pendingInvoice.telegramUserId) },
          currency: "XTR",
          total_amount: pendingInvoice.amount,
          invoice_payload: pendingInvoice.invoicePayload,
        },
      }),
      { kind: "ignored" },
    );
  }
  for (const update of [null, [], {}, { pre_checkout_query: null }, { pre_checkout_query: [] }]) {
    assert.deepEqual(await service.handleUpdate(update), { kind: "ignored" });
  }

  assert.equal(databaseCalls, 0);
  assert.equal(nowCalls, 0);
  assert.equal(botApiCalls, 0);
});

test("handleUpdate localizes bounded pre-checkout rejection text from Telegram language", async () => {
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });
  const cases = [
    ["ru-RU", "Платеж недоступен. Создайте новый счет."],
    ["RU", "Платеж недоступен. Создайте новый счет."],
    ["zh-Hans", "付款不可用，请创建新账单。"],
    ["ZH", "付款不可用，请创建新账单。"],
    ["fr", "Payment unavailable. Please create a new invoice."],
    [undefined, "Payment unavailable. Please create a new invoice."],
  ];

  for (const [index, [languageCode, expectedMessage]] of cases.entries()) {
    const result = await service.handleUpdate({
      pre_checkout_query: {
        id: `pre-checkout-locale-${index}`,
        from: {
          id: Number(pendingInvoice.telegramUserId),
          ...(languageCode === undefined ? {} : { language_code: languageCode }),
        },
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: `pay_${String(index).repeat(43)}`,
      },
    });
    assert.deepEqual(result, { kind: "pre_checkout", approved: false });
    assert.equal(answers.at(-1).errorMessage, expectedMessage);
    assert.ok(Array.from(answers.at(-1).errorMessage).length <= 200);
    assert.equal(answers.at(-1).errorMessage.includes(pendingInvoice.invoicePayload), false);
  }
});

test("handleUpdate snapshots every pre-checkout update getter exactly once", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const reads = new Map();
  const stateful = (object, key, first, later, label = key) =>
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        const count = (reads.get(label) ?? 0) + 1;
        reads.set(label, count);
        return count === 1 ? first : later;
      },
    });
  const from = {};
  stateful(from, "id", Number(pendingInvoice.telegramUserId), 1, "payer_id");
  stateful(from, "language_code", "en", "ru", "language");
  const query = {};
  stateful(query, "id", "pre-checkout-getters", "");
  stateful(query, "from", from, null);
  stateful(query, "currency", "XTR", "USD");
  stateful(query, "total_amount", pendingInvoice.amount, 1);
  stateful(query, "invoice_payload", pendingInvoice.invoicePayload, "pay_attacker");
  let preCheckoutReads = 0;
  let messageReads = 0;
  const update = Object.defineProperties({}, {
    pre_checkout_query: {
      enumerable: true,
      get() {
        preCheckoutReads += 1;
        return preCheckoutReads === 1 ? query : null;
      },
    },
    message: {
      enumerable: true,
      get() {
        messageReads += 1;
        return undefined;
      },
    },
  });
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: database,
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });

  const result = await service.handleUpdate(update);

  assert.deepEqual(result, { kind: "pre_checkout", approved: true });
  assert.deepEqual(answers, [{ id: "pre-checkout-getters", ok: true }]);
  assert.equal(preCheckoutReads, 1);
  assert.equal(messageReads, 1);
  for (const key of ["id", "from", "currency", "total_amount", "invoice_payload", "payer_id", "language"]) {
    assert.equal(reads.get(key), 1, key);
  }
});

test("handleUpdate rejects throwing pre-checkout getters once without leaking them", async () => {
  let databaseCalls = 0;
  const answers = [];
  let currencyReads = 0;
  const query = Object.defineProperty(
    {
      id: "pre-checkout-throwing-getter",
      from: { id: Number(pendingInvoice.telegramUserId), language_code: "ru" },
      total_amount: pendingInvoice.amount,
      invoice_payload: pendingInvoice.invoicePayload,
    },
    "currency",
    {
      enumerable: true,
      get() {
        currencyReads += 1;
        throw new Error("pay_private charge_private SELECT user_key");
      },
    },
  );
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now: () => serviceNow,
  });

  const result = await service.handleUpdate({ pre_checkout_query: query });

  assert.equal(currencyReads, 1);
  assert.equal(databaseCalls, 0);
  assert.deepEqual(result, { kind: "pre_checkout", approved: false });
  assert.deepEqual(answers, [
    {
      id: "pre-checkout-throwing-getter",
      ok: false,
      errorMessage: "Платеж недоступен. Создайте новый счет.",
    },
  ]);
  assert.equal(JSON.stringify(answers).includes("pay_private"), false);
});

test("handleUpdate rejects pre-checkout D1 and clock uncertainty after one answer", async (t) => {
  const cases = [
    {
      name: "D1 read failure",
      db: {
        prepare() {
          return {
            bind() {
              return {
                async first() {
                  throw new Error("SELECT invoice_payload charge_secret");
                },
              };
            },
          };
        },
      },
      now: () => serviceNow,
    },
    {
      name: "clock failure",
      db: {
        prepare() {
          throw new Error("D1 should not be reached after clock failure");
        },
      },
      now() {
        throw new Error("clock user_key secret");
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const answers = [];
      const service = starsSupportModule.createStarsSupportService({
        db: scenario.db,
        botApi: {
          createInvoiceLink() {},
          async answerPreCheckoutQuery(answer) {
            answers.push(answer);
          },
        },
        now: scenario.now,
      });
      const result = await service.handleUpdate({
        pre_checkout_query: {
          id: `pre-checkout-${scenario.name}`,
          from: { id: Number(pendingInvoice.telegramUserId) },
          currency: "XTR",
          total_amount: pendingInvoice.amount,
          invoice_payload: pendingInvoice.invoicePayload,
        },
      });

      assert.deepEqual(result, { kind: "pre_checkout", approved: false });
      assert.equal(answers.length, 1);
      assert.equal(answers[0].ok, false);
    });
  }
});

test("handleUpdate redacts a failed pre-checkout Bot API answer", async () => {
  let answerCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        return {
          bind() {
            return { first: async () => null };
          },
        };
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery() {
        answerCalls += 1;
        throw new Error("timeout bot-token pay_private charge_private");
      },
    },
    now: () => serviceNow,
  });

  await assertRejectsWithPublicError(
    service.handleUpdate({
      pre_checkout_query: {
        id: "pre-checkout-timeout",
        from: { id: Number(pendingInvoice.telegramUserId) },
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
      },
    }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );
  assert.equal(answerCalls, 1);
});

test("handleUpdate conditionally records an exact authoritative successful payment", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          statements.push({ sql, params });
          return statement.bind(...params);
        },
      };
    },
  };
  let providerChargeReads = 0;
  const successfulPayment = Object.defineProperty(
    {
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: pendingInvoice.invoicePayload,
      telegram_payment_charge_id: "tg:charge/exact_-123",
    },
    "provider_payment_charge_id",
    {
      enumerable: true,
      get() {
        providerChargeReads += 1;
        throw new Error("provider charge must be ignored");
      },
    },
  );
  let nowCalls = 0;
  let botApiCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: {
      createInvoiceLink() {},
      answerPreCheckoutQuery() {
        botApiCalls += 1;
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow + 30;
    },
  });

  const result = await service.handleUpdate({
    update_id: 456,
    message: {
      message_id: 789,
      from: { id: Number(pendingInvoice.telegramUserId), language_code: "en" },
      successful_payment: successfulPayment,
      text: "ignored",
    },
  });

  assert.equal(providerChargeReads, 0);
  assert.equal(nowCalls, 1);
  assert.equal(botApiCalls, 0);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /WHERE invoice_payload = \?/u);
  assert.deepEqual(statements[0].params, [pendingInvoice.invoicePayload]);
  assert.match(statements[1].sql, /SET status = 'paid'/u);
  assert.match(statements[1].sql, /status = 'pending'/u);
  assert.match(statements[1].sql, /telegram_user_id = \?/u);
  assert.match(statements[1].sql, /currency = \?/u);
  assert.match(statements[1].sql, /amount = \?/u);
  assert.deepEqual(
    database.queryOne(
      `SELECT status, paid_at, telegram_payment_charge_id
         FROM star_support_payments
        WHERE invoice_payload = ?`,
      pendingInvoice.invoicePayload,
    ),
    {
      status: "paid",
      paid_at: serviceNow + 30,
      telegram_payment_charge_id: "tg:charge/exact_-123",
    },
  );
  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: false,
  });
  assert.deepEqual(Object.keys(result), ["kind", "paid", "duplicate"]);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    pendingInvoice.invoicePayload,
    pendingInvoice.telegramUserId,
    "tg:charge/exact_-123",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("handleUpdate snapshots a successful D1 mutation result field once", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const reads = new Map();
  const changesMeta = Object.defineProperty({}, "changes", {
    get() {
      reads.set("changes", (reads.get("changes") ?? 0) + 1);
      return reads.get("changes") === 1 ? 1 : 0;
    },
  });
  const updateResult = Object.defineProperties({}, {
    success: {
      get() {
        reads.set("success", (reads.get("success") ?? 0) + 1);
        return reads.get("success") === 1;
      },
    },
    meta: {
      get() {
        reads.set("meta", (reads.get("meta") ?? 0) + 1);
        return reads.get("meta") === 1 ? changesMeta : { changes: 0 };
      },
    },
  });
  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      if (!/^\s*UPDATE\s/u.test(sql)) {
        return statement;
      }
      return {
        bind(...params) {
          const bound = statement.bind(...params);
          return {
            async run() {
              await bound.run();
              return updateResult;
            },
          };
        },
      };
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: "tg_charge_stateful_result",
      },
    },
  });

  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: false,
  });
  assert.deepEqual(Object.fromEntries(reads), { success: 1, meta: 1, changes: 1 });
});

test("handleUpdate accepts exact successful-payment redelivery without another mutation", async (t) => {
  const database = memoryD1(t);
  const chargeId = "tg_charge_duplicate_exact";
  insertPayment(database, {
    invoiceId: pendingInvoice.invoiceId,
    invoicePayload: pendingInvoice.invoicePayload,
    status: "paid",
    paidAt: serviceNow + 10,
    telegramPaymentChargeId: chargeId,
  });
  let updateStatements = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        updateStatements += 1;
      }
      return database.prepare(sql);
    },
  };
  let nowCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now() {
      nowCalls += 1;
      return serviceNow + 30;
    },
  });
  const before = database.queryOne(
    "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
    pendingInvoice.invoicePayload,
  );

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  });

  assert.equal(updateStatements, 0);
  assert.equal(nowCalls, 0);
  assert.deepEqual(
    database.queryOne(
      "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
      pendingInvoice.invoicePayload,
    ),
    before,
  );
  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: true,
  });
  assert.deepEqual(Object.keys(result), ["kind", "paid", "duplicate"]);
});

test("handleUpdate verifies exact paid state after a zero-change conditional update race", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const chargeId = "tg_charge_race_exact";
  let updateAttempts = 0;
  let reads = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                updateAttempts += 1;
                database.execute(
                  `UPDATE star_support_payments
                      SET status = 'paid', paid_at = ?, telegram_payment_charge_id = ?
                    WHERE invoice_payload = ? AND status = 'pending'`,
                  serviceNow + 30,
                  chargeId,
                  pendingInvoice.invoicePayload,
                );
                return { success: true, meta: { changes: 0 } };
              },
            };
          },
        };
      }
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          const bound = statement.bind(...params);
          return {
            async first() {
              reads += 1;
              return bound.first();
            },
          };
        },
      };
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  });

  assert.equal(updateAttempts, 1);
  assert.equal(reads, 2);
  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: true,
  });
  assert.deepEqual(
    database.queryOne(
      `SELECT status, paid_at, telegram_payment_charge_id
         FROM star_support_payments
        WHERE invoice_payload = ?`,
      pendingInvoice.invoicePayload,
    ),
    {
      status: "paid",
      paid_at: serviceNow + 30,
      telegram_payment_charge_id: chargeId,
    },
  );
});

test("handleUpdate detects a Telegram charge already used by another invoice", async (t) => {
  const database = memoryD1(t);
  const chargeId = "tg_charge_unique_conflict";
  insertPendingInvoice(database, pendingInvoice);
  insertPayment(database, {
    invoiceId: `inv_${"D".repeat(22)}`,
    invoicePayload: `pay_${"E".repeat(43)}`,
    userKey: "telegram:8710001169",
    telegramUserId: "8710001169",
    status: "paid",
    paidAt: serviceNow + 10,
    telegramPaymentChargeId: chargeId,
  });
  const before = database.queryOne(
    "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
    pendingInvoice.invoicePayload,
  );
  const service = starsSupportModule.createStarsSupportService({
    db: database,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  });

  assert.deepEqual(result, { kind: "ignored" });
  assert.deepEqual(Object.keys(result), ["kind"]);
  assert.deepEqual(
    database.queryOne(
      "SELECT * FROM star_support_payments WHERE invoice_payload = ?",
      pendingInvoice.invoicePayload,
    ),
    before,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(chargeId), false);
  assert.equal(serialized.includes(pendingInvoice.invoicePayload), false);
});

test("handleUpdate snapshots charge-owner recovery rows once inside the redaction boundary", async (t) => {
  const chargeId = "tg_charge_owner_getters";
  const update = {
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  };

  for (const field of ["invoice_payload", "telegram_payment_charge_id"]) {
    await t.test(`throwing ${field}`, async (t) => {
      const database = memoryD1(t);
      insertPendingInvoice(database, pendingInvoice);
      let getterReads = 0;
      const chargeOwner = Object.defineProperty(
        {
          invoice_payload: `pay_${"O".repeat(43)}`,
          telegram_payment_charge_id: chargeId,
        },
        field,
        {
          enumerable: true,
          get() {
            getterReads += 1;
            throw new Error(`${field} pay_private charge_private`);
          },
        },
      );
      const db = recoveryDb(database, chargeOwner);
      const service = starsSupportModule.createStarsSupportService({
        db,
        botApi: fakeBotApi(),
        now: () => serviceNow + 30,
      });

      await assertRejectsWithPublicError(service.handleUpdate(update), {
        category: "service_unavailable",
        status: 503,
        message: "Stars support is unavailable",
      });
      assert.equal(getterReads, 1);
    });
  }

  await t.test("stateful permanent conflict", async (t) => {
    const database = memoryD1(t);
    insertPendingInvoice(database, pendingInvoice);
    const otherPayload = `pay_${"O".repeat(43)}`;
    let payloadReads = 0;
    let chargeReads = 0;
    const chargeOwner = Object.defineProperties({}, {
      invoice_payload: {
        enumerable: true,
        get() {
          payloadReads += 1;
          return payloadReads === 1 ? otherPayload : pendingInvoice.invoicePayload;
        },
      },
      telegram_payment_charge_id: {
        enumerable: true,
        get() {
          chargeReads += 1;
          return chargeReads === 1 ? chargeId : "changed_charge";
        },
      },
    });
    const service = starsSupportModule.createStarsSupportService({
      db: recoveryDb(database, chargeOwner),
      botApi: fakeBotApi(),
      now: () => serviceNow + 30,
    });

    assert.deepEqual(await service.handleUpdate(update), { kind: "ignored" });
    assert.equal(payloadReads, 1);
    assert.equal(chargeReads, 1);
  });
});

test("handleUpdate treats a contradictory D1 update result as retryable uncertainty", async (t) => {
  const getterReads = new Map();
  const throwingGetter = (key, target, property) =>
    Object.defineProperty(target, property, {
      get() {
        getterReads.set(key, (getterReads.get(key) ?? 0) + 1);
        throw new Error(`${key} pay_private charge_private`);
      },
    });
  const throwingSuccess = throwingGetter("success", {}, "success");
  const throwingMeta = throwingGetter("meta", { success: true }, "meta");
  const throwingChanges = throwingGetter("changes", {}, "changes");
  let statefulMetaReads = 0;
  let statefulChangesReads = 0;
  const statefulChanges = Object.defineProperty({}, "changes", {
    get() {
      statefulChangesReads += 1;
      return statefulChangesReads === 1 ? 0 : 1;
    },
  });
  const statefulMeta = Object.defineProperty({ success: true }, "meta", {
    get() {
      statefulMetaReads += 1;
      return statefulMetaReads === 1 ? statefulChanges : { changes: 1 };
    },
  });
  const scenarios = [
    { name: "success false", result: { success: false, meta: { changes: 1 } } },
    { name: "missing success", result: { meta: { changes: 1 } } },
    { name: "throwing success getter", result: throwingSuccess, verify: () => assert.equal(getterReads.get("success"), 1) },
    { name: "throwing meta getter", result: throwingMeta, verify: () => assert.equal(getterReads.get("meta"), 1) },
    {
      name: "throwing changes getter",
      result: { success: true, meta: throwingChanges },
      verify: () => assert.equal(getterReads.get("changes"), 1),
    },
    {
      name: "stateful meta and changes getters",
      result: statefulMeta,
      verify() {
        assert.equal(statefulMetaReads, 1);
        assert.equal(statefulChangesReads, 1);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const database = memoryD1(t);
      insertPendingInvoice(database, pendingInvoice);
      let reads = 0;
      const db = {
        prepare(sql) {
          if (/^\s*UPDATE\s/u.test(sql)) {
            return {
              bind() {
                return { run: async () => scenario.result };
              },
            };
          }
          const statement = database.prepare(sql);
          return {
            bind(...params) {
              const bound = statement.bind(...params);
              return {
                async first() {
                  reads += 1;
                  return bound.first();
                },
              };
            },
          };
        },
      };
      const service = starsSupportModule.createStarsSupportService({
        db,
        botApi: fakeBotApi(),
        now: () => serviceNow + 30,
      });

      await assertRejectsWithPublicError(
        service.handleUpdate({
          message: {
            from: { id: Number(pendingInvoice.telegramUserId) },
            successful_payment: {
              currency: "XTR",
              total_amount: pendingInvoice.amount,
              invoice_payload: pendingInvoice.invoicePayload,
              telegram_payment_charge_id: "tg_charge_contradictory_result",
            },
          },
        }),
        { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
      );

      assert.equal(reads, 3);
      assert.deepEqual(
        database.queryOne(
          `SELECT status, paid_at, telegram_payment_charge_id
             FROM star_support_payments
            WHERE invoice_payload = ?`,
          pendingInvoice.invoicePayload,
        ),
        { status: "pending", paid_at: null, telegram_payment_charge_id: null },
      );
      scenario.verify?.();
    });
  }
});

test("handleUpdate ignores malformed successful-payment structures before D1", async () => {
  const validPayment = {
    currency: "XTR",
    total_amount: pendingInvoice.amount,
    invoice_payload: pendingInvoice.invoicePayload,
    telegram_payment_charge_id: "tg_charge_structural",
  };
  const cases = [
    { name: "null message", update: { message: null } },
    { name: "array message", update: { message: [] } },
    { name: "top-level payment", update: { successful_payment: validPayment } },
    { name: "null payment", update: { message: { from: { id: 8710001168 }, successful_payment: null } } },
    { name: "array payment", update: { message: { from: { id: 8710001168 }, successful_payment: [] } } },
    { name: "null from", update: { message: { from: null, successful_payment: validPayment } } },
    { name: "array from", update: { message: { from: [], successful_payment: validPayment } } },
    { name: "zero payer", update: { message: { from: { id: 0 }, successful_payment: validPayment } } },
    { name: "unsafe payer", update: { message: { from: { id: 2 ** 52 }, successful_payment: validPayment } } },
    { name: "string payer", update: { message: { from: { id: "8710001168" }, successful_payment: validPayment } } },
    {
      name: "wrong currency",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, currency: "USD" } } },
    },
    {
      name: "boxed currency",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, currency: new String("XTR") } } },
    },
    {
      name: "zero amount",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, total_amount: 0 } } },
    },
    {
      name: "large amount",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, total_amount: 10_001 } } },
    },
    {
      name: "fractional amount",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, total_amount: 1.5 } } },
    },
    {
      name: "string amount",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, total_amount: "88" } } },
    },
    {
      name: "malformed payload",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, invoice_payload: "pay_client" } } },
    },
    {
      name: "coercible payload",
      update: {
        message: {
          from: { id: 8710001168 },
          successful_payment: { ...validPayment, invoice_payload: { toString: () => pendingInvoice.invoicePayload } },
        },
      },
    },
    {
      name: "empty charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: "" } } },
    },
    {
      name: "blank charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: "   " } } },
    },
    {
      name: "control charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: "charge\nsecret" } } },
    },
    {
      name: "oversize charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: "c".repeat(257) } } },
    },
    {
      name: "multibyte oversize charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: "星".repeat(86) } } },
    },
    {
      name: "numeric charge",
      update: { message: { from: { id: 8710001168 }, successful_payment: { ...validPayment, telegram_payment_charge_id: 42 } } },
    },
    {
      name: "coercible charge",
      update: {
        message: {
          from: { id: 8710001168 },
          successful_payment: { ...validPayment, telegram_payment_charge_id: { toString: () => "charge" } },
        },
      },
    },
  ];
  let databaseCalls = 0;
  let nowCalls = 0;
  let botApiCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
      },
    },
    botApi: {
      createInvoiceLink() {},
      answerPreCheckoutQuery() {
        botApiCalls += 1;
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow;
    },
  });

  for (const scenario of cases) {
    assert.deepEqual(await service.handleUpdate(scenario.update), { kind: "ignored" }, scenario.name);
  }

  assert.equal(databaseCalls, 0);
  assert.equal(nowCalls, 0);
  assert.equal(botApiCalls, 0);
});

test("handleUpdate snapshots successful-payment getters once and ignores provider charge", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const reads = new Map();
  const stateful = (object, key, first, later, label = key) =>
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        const count = (reads.get(label) ?? 0) + 1;
        reads.set(label, count);
        return count === 1 ? first : later;
      },
    });
  const from = {};
  stateful(from, "id", Number(pendingInvoice.telegramUserId), 1, "payer_id");
  const payment = {};
  stateful(payment, "currency", "XTR", "USD");
  stateful(payment, "total_amount", pendingInvoice.amount, 1);
  stateful(payment, "invoice_payload", pendingInvoice.invoicePayload, `pay_${"Z".repeat(43)}`);
  stateful(payment, "telegram_payment_charge_id", "tg_charge_getters", "tg_charge_changed");
  let providerChargeReads = 0;
  Object.defineProperty(payment, "provider_payment_charge_id", {
    enumerable: true,
    get() {
      providerChargeReads += 1;
      throw new Error("must remain unread");
    },
  });
  const message = {};
  stateful(message, "from", from, null, "message_from");
  stateful(message, "successful_payment", payment, null);
  const update = {};
  stateful(update, "pre_checkout_query", undefined, { id: "ambiguous" });
  stateful(update, "message", message, null, "update_message");
  const service = starsSupportModule.createStarsSupportService({
    db: database,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate(update);

  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: false,
  });
  for (const key of [
    "pre_checkout_query",
    "update_message",
    "message_from",
    "successful_payment",
    "payer_id",
    "currency",
    "total_amount",
    "invoice_payload",
    "telegram_payment_charge_id",
  ]) {
    assert.equal(reads.get(key), 1, key);
  }
  assert.equal(providerChargeReads, 0);
  assert.deepEqual(
    database.queryOne(
      "SELECT status, telegram_payment_charge_id FROM star_support_payments",
    ),
    { status: "paid", telegram_payment_charge_id: "tg_charge_getters" },
  );
});

test("handleUpdate fails closed for payment mismatches and terminal rows without writes", async (t) => {
  const cases = [
    { name: "wrong payer", update: { payerId: 8710001169 } },
    { name: "wrong amount", update: { amount: pendingInvoice.amount + 1 } },
    { name: "unknown payload", update: { payload: `pay_${"U".repeat(43)}` } },
    { name: "failed row", payment: { status: "failed", failedAt: serviceNow + 1 } },
    {
      name: "refunded row",
      payment: {
        status: "refunded",
        paidAt: serviceNow + 1,
        refundedAt: serviceNow + 2,
        telegramPaymentChargeId: "tg_charge_refunded",
      },
    },
    {
      name: "paid with different charge",
      payment: {
        status: "paid",
        paidAt: serviceNow + 1,
        telegramPaymentChargeId: "tg_charge_original",
      },
      update: { chargeId: "tg_charge_conflicting" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const database = memoryD1(t);
      insertPayment(database, {
        invoiceId: pendingInvoice.invoiceId,
        invoicePayload: pendingInvoice.invoicePayload,
        ...scenario.payment,
      });
      const before = database.queryAll("SELECT * FROM star_support_payments");
      let updates = 0;
      let nowCalls = 0;
      const db = {
        prepare(sql) {
          if (/^\s*UPDATE\s/u.test(sql)) {
            updates += 1;
          }
          return database.prepare(sql);
        },
      };
      const service = starsSupportModule.createStarsSupportService({
        db,
        botApi: fakeBotApi(),
        now() {
          nowCalls += 1;
          return serviceNow + 30;
        },
      });

      const result = await service.handleUpdate({
        message: {
          from: { id: scenario.update?.payerId ?? Number(pendingInvoice.telegramUserId) },
          successful_payment: {
            currency: "XTR",
            total_amount: scenario.update?.amount ?? pendingInvoice.amount,
            invoice_payload: scenario.update?.payload ?? pendingInvoice.invoicePayload,
            telegram_payment_charge_id: scenario.update?.chargeId ?? "tg_charge_mismatch_matrix",
          },
        },
      });

      assert.deepEqual(result, { kind: "ignored" });
      assert.equal(updates, 0);
      assert.equal(nowCalls, 0);
      assert.deepEqual(database.queryAll("SELECT * FROM star_support_payments"), before);
    });
  }
});

test("handleUpdate rejects malformed stored payment rows without rewriting them", async () => {
  const validRow = {
    invoice_id: pendingInvoice.invoiceId,
    invoice_payload: pendingInvoice.invoicePayload,
    user_key: pendingInvoice.userKey,
    telegram_user_id: pendingInvoice.telegramUserId,
    amount: pendingInvoice.amount,
    currency: "XTR",
    status: "pending",
    created_at: pendingInvoice.createdAt,
    expires_at: pendingInvoice.expiresAt,
    paid_at: null,
    failed_at: null,
    refunded_at: null,
    telegram_payment_charge_id: null,
  };
  const rows = [
    null,
    [],
    {},
    { ...validRow, invoice_id: "inv_bad" },
    { ...validRow, invoice_payload: `pay_${"W".repeat(43)}` },
    { ...validRow, user_key: "telegram:8710001169" },
    { ...validRow, telegram_user_id: 8710001168 },
    { ...validRow, telegram_user_id: "01" },
    { ...validRow, amount: "88" },
    { ...validRow, amount: 0 },
    { ...validRow, currency: "USD" },
    { ...validRow, status: "new" },
    { ...validRow, created_at: String(serviceNow) },
    { ...validRow, expires_at: validRow.created_at },
    { ...validRow, paid_at: serviceNow },
    { ...validRow, failed_at: serviceNow },
    { ...validRow, refunded_at: serviceNow },
    { ...validRow, telegram_payment_charge_id: "tg_charge_existing" },
  ];

  for (const row of rows) {
    let updates = 0;
    let nowCalls = 0;
    const service = starsSupportModule.createStarsSupportService({
      db: {
        prepare(sql) {
          if (/^\s*UPDATE\s/u.test(sql)) {
            updates += 1;
          }
          return {
            bind() {
              return { first: async () => row };
            },
          };
        },
      },
      botApi: fakeBotApi(),
      now() {
        nowCalls += 1;
        return serviceNow + 30;
      },
    });

    assert.deepEqual(
      await service.handleUpdate({
        message: {
          from: { id: Number(pendingInvoice.telegramUserId) },
          successful_payment: {
            currency: "XTR",
            total_amount: pendingInvoice.amount,
            invoice_payload: pendingInvoice.invoicePayload,
            telegram_payment_charge_id: "tg_charge_malformed_row",
          },
        },
      }),
      { kind: "ignored" },
    );
    assert.equal(updates, 0);
    assert.equal(nowCalls, 0);
  }
});

test("handleUpdate redacts transient successful-payment D1 failures", async (t) => {
  const initialReadService = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("SELECT invoice_payload charge_private user_key");
              },
            };
          },
        };
      },
    },
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });
  const validUpdate = {
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: "tg_charge_transient",
      },
    },
  };
  await assertRejectsWithPublicError(initialReadService.handleUpdate(validUpdate), {
    category: "service_unavailable",
    status: 503,
    message: "Stars support is unavailable",
  });

  await t.test("failed update remains pending", async (t) => {
    const database = memoryD1(t);
    insertPendingInvoice(database, pendingInvoice);
    const db = {
      prepare(sql) {
        if (/^\s*UPDATE\s/u.test(sql)) {
          return {
            bind() {
              return {
                async run() {
                  throw new Error("D1 timeout charge_private");
                },
              };
            },
          };
        }
        return database.prepare(sql);
      },
    };
    const service = starsSupportModule.createStarsSupportService({
      db,
      botApi: fakeBotApi(),
      now: () => serviceNow + 30,
    });

    await assertRejectsWithPublicError(service.handleUpdate(validUpdate), {
      category: "service_unavailable",
      status: 503,
      message: "Stars support is unavailable",
    });
    assert.deepEqual(
      database.queryOne("SELECT status, telegram_payment_charge_id FROM star_support_payments"),
      { status: "pending", telegram_payment_charge_id: null },
    );
  });
});

test("handleUpdate accepts an ambiguous D1 failure only after exact paid re-read", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  const chargeId = "tg_charge_ambiguous_commit";
  let updateAttempts = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                updateAttempts += 1;
                database.execute(
                  `UPDATE star_support_payments
                      SET status = 'paid', paid_at = ?, telegram_payment_charge_id = ?
                    WHERE invoice_payload = ? AND status = 'pending'`,
                  serviceNow + 30,
                  chargeId,
                  pendingInvoice.invoicePayload,
                );
                throw new Error("connection closed after commit charge_private");
              },
            };
          },
        };
      }
      return database.prepare(sql);
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  });

  assert.equal(updateAttempts, 1);
  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: true,
  });
});

test("handleUpdate snapshots every ambiguous-recovery payment row field once", async () => {
  const chargeId = "tg_charge_stateful_recovery";
  const reads = new Map();
  const statefulRow = {};
  const field = (key, value, later = Symbol("changed")) => {
    Object.defineProperty(statefulRow, key, {
      enumerable: true,
      get() {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? value : later;
      },
    });
  };
  field("invoice_id", pendingInvoice.invoiceId, "inv_bad");
  field("invoice_payload", pendingInvoice.invoicePayload, "pay_bad");
  field("user_key", pendingInvoice.userKey, "telegram:1");
  field("telegram_user_id", pendingInvoice.telegramUserId, "1");
  field("amount", pendingInvoice.amount, 1);
  field("currency", "XTR", "USD");
  field("status", "paid", "pending");
  field("created_at", pendingInvoice.createdAt, -1);
  field("expires_at", pendingInvoice.expiresAt, -1);
  field("paid_at", serviceNow + 30, null);
  field("failed_at", null, serviceNow);
  field("refunded_at", null, serviceNow);
  field("telegram_payment_charge_id", chargeId, "different_charge");
  const pendingRow = {
    invoice_id: pendingInvoice.invoiceId,
    invoice_payload: pendingInvoice.invoicePayload,
    user_key: pendingInvoice.userKey,
    telegram_user_id: pendingInvoice.telegramUserId,
    amount: pendingInvoice.amount,
    currency: "XTR",
    status: "pending",
    created_at: pendingInvoice.createdAt,
    expires_at: pendingInvoice.expiresAt,
    paid_at: null,
    failed_at: null,
    refunded_at: null,
    telegram_payment_charge_id: null,
  };
  let payloadReads = 0;
  let chargeOwnerReads = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return { run: async () => ({ success: false, meta: { changes: 1 } }) };
          },
        };
      }
      if (/WHERE telegram_payment_charge_id = \?/u.test(sql)) {
        chargeOwnerReads += 1;
        throw new Error("exact paid recovery must not query charge ownership");
      }
      return {
        bind() {
          return {
            async first() {
              payloadReads += 1;
              return payloadReads === 1 ? pendingRow : statefulRow;
            },
          };
        },
      };
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: chargeId,
      },
    },
  });

  assert.deepEqual(result, {
    kind: "successful_payment",
    paid: true,
    duplicate: true,
  });
  assert.equal(chargeOwnerReads, 0);
  for (const key of Object.keys(statefulRow)) {
    assert.equal(reads.get(key), 1, key);
  }
});

test("handleUpdate treats a different charge on the recovered paid invoice as permanent", async () => {
  const incomingChargeId = "tg_charge_recovery_incoming";
  const paidRow = {
    invoice_id: pendingInvoice.invoiceId,
    invoice_payload: pendingInvoice.invoicePayload,
    user_key: pendingInvoice.userKey,
    telegram_user_id: pendingInvoice.telegramUserId,
    amount: pendingInvoice.amount,
    currency: "XTR",
    status: "paid",
    created_at: pendingInvoice.createdAt,
    expires_at: pendingInvoice.expiresAt,
    paid_at: serviceNow + 30,
    failed_at: null,
    refunded_at: null,
    telegram_payment_charge_id: "tg_charge_recovery_existing",
  };
  const pendingRow = {
    ...paidRow,
    status: "pending",
    paid_at: null,
    telegram_payment_charge_id: null,
  };
  let payloadReads = 0;
  let chargeOwnerReads = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return { run: async () => ({ success: false, meta: { changes: 1 } }) };
          },
        };
      }
      if (/WHERE telegram_payment_charge_id = \?/u.test(sql)) {
        chargeOwnerReads += 1;
        throw new Error("permanent same-invoice conflict must not retry charge lookup");
      }
      return {
        bind() {
          return {
            async first() {
              payloadReads += 1;
              return payloadReads === 1 ? pendingRow : paidRow;
            },
          };
        },
      };
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow + 30,
  });

  const result = await service.handleUpdate({
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: incomingChargeId,
      },
    },
  });

  assert.deepEqual(result, { kind: "ignored" });
  assert.equal(payloadReads, 2);
  assert.equal(chargeOwnerReads, 0);
});

test("handleUpdate never records paid_at before the stored invoice creation time", async (t) => {
  const database = memoryD1(t);
  insertPendingInvoice(database, pendingInvoice);
  let updateStatements = 0;
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        updateStatements += 1;
      }
      return database.prepare(sql);
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => pendingInvoice.createdAt - 1,
  });

  await assertRejectsWithPublicError(
    service.handleUpdate({
      message: {
        from: { id: Number(pendingInvoice.telegramUserId) },
        successful_payment: {
          currency: "XTR",
          total_amount: pendingInvoice.amount,
          invoice_payload: pendingInvoice.invoicePayload,
          telegram_payment_charge_id: "tg_charge_clock_regression",
        },
      },
    }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );

  assert.equal(updateStatements, 0);
  assert.deepEqual(
    database.queryOne(
      "SELECT status, paid_at, telegram_payment_charge_id FROM star_support_payments",
    ),
    { status: "pending", paid_at: null, telegram_payment_charge_id: null },
  );
});

test("handleUpdate ignores unknown updates and fails ambiguous payment updates closed", async () => {
  let databaseCalls = 0;
  let nowCalls = 0;
  const answers = [];
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        databaseCalls += 1;
        throw new Error("ignored updates must not reach D1");
      },
    },
    botApi: {
      createInvoiceLink() {},
      async answerPreCheckoutQuery(answer) {
        answers.push(answer);
      },
    },
    now() {
      nowCalls += 1;
      return serviceNow;
    },
  });
  for (const update of [
    { update_id: 1 },
    { message: { text: "ordinary message", from: { id: 8710001168 } } },
    { callback_query: { id: "callback", data: pendingInvoice.invoicePayload } },
    { shipping_query: { id: "shipping" } },
  ]) {
    assert.deepEqual(await service.handleUpdate(update), { kind: "ignored" });
  }

  const ambiguousResult = await service.handleUpdate({
    pre_checkout_query: {
      id: "pre-checkout-ambiguous",
      from: { id: Number(pendingInvoice.telegramUserId), language_code: "zh" },
      currency: "XTR",
      total_amount: pendingInvoice.amount,
      invoice_payload: pendingInvoice.invoicePayload,
    },
    message: {
      from: { id: Number(pendingInvoice.telegramUserId) },
      successful_payment: {
        currency: "XTR",
        total_amount: pendingInvoice.amount,
        invoice_payload: pendingInvoice.invoicePayload,
        telegram_payment_charge_id: "tg_charge_ambiguous_update",
      },
    },
  });
  assert.deepEqual(ambiguousResult, { kind: "pre_checkout", approved: false });
  assert.deepEqual(answers, [
    {
      id: "pre-checkout-ambiguous",
      ok: false,
      errorMessage: "付款不可用，请创建新账单。",
    },
  ]);

  let preCheckoutReads = 0;
  const uncertainUpdate = Object.defineProperty(
    {
      message: {
        from: { id: Number(pendingInvoice.telegramUserId) },
        successful_payment: {
          currency: "XTR",
          total_amount: pendingInvoice.amount,
          invoice_payload: pendingInvoice.invoicePayload,
          telegram_payment_charge_id: "tg_charge_uncertain_update",
        },
      },
    },
    "pre_checkout_query",
    {
      get() {
        preCheckoutReads += 1;
        throw new Error("ambiguous private payload");
      },
    },
  );
  assert.deepEqual(await service.handleUpdate(uncertainUpdate), { kind: "ignored" });
  assert.equal(preCheckoutReads, 1);
  assert.equal(databaseCalls, 0);
  assert.equal(nowCalls, 0);

  for (const result of [
    { kind: "ignored" },
    ambiguousResult,
    { kind: "successful_payment", paid: true, duplicate: false },
    { kind: "successful_payment", paid: true, duplicate: true },
  ]) {
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      pendingInvoice.invoicePayload,
      pendingInvoice.telegramUserId,
      "tg_charge_ambiguous_update",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }
});

test("createInvoice persists an owner-bound pending row before requesting the link", async (t) => {
  const db = memoryD1(t);
  const invoiceBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const payloadBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 16);
  const expectedInvoiceId = `inv_${Buffer.from(invoiceBytes).toString("base64url")}`;
  const expectedPayload = `pay_${Buffer.from(payloadBytes).toString("base64url")}`;
  const randomSizes = [];
  const providerCalls = [];
  let nowCalls = 0;
  const botApi = fakeBotApi({
    async createInvoiceLink(invoice) {
      providerCalls.push(invoice);
      assert.deepEqual(
        db.queryOne(
          "SELECT * FROM star_support_payments WHERE invoice_id = ?",
          expectedInvoiceId,
        ),
        {
          invoice_id: expectedInvoiceId,
          invoice_payload: expectedPayload,
          user_key: `telegram:${authenticatedUser.id}`,
          telegram_user_id: authenticatedUser.id,
          amount: 88,
          currency: "XTR",
          status: "pending",
          created_at: serviceNow,
          expires_at: serviceNow + 900,
          paid_at: null,
          failed_at: null,
          refunded_at: null,
          telegram_payment_charge_id: null,
        },
      );
      return "https://t.me/$salvo-support-test";
    },
  });
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi,
    now() {
      nowCalls += 1;
      return serviceNow;
    },
    randomBytes(size) {
      randomSizes.push(size);
      return size === 16 ? invoiceBytes : payloadBytes;
    },
  });

  const result = await service.createInvoice({
    user: { ...authenticatedUser, userKey: "telegram:1" },
    amount: 88,
    locale: "en",
    title: "Client title",
    description: "Client description",
    label: "Client label",
    currency: "USD",
    payload: "client-payload",
  });

  assert.deepEqual(randomSizes, [16, 32]);
  assert.equal(nowCalls, 1);
  assert.deepEqual(providerCalls, [
    {
      title: "Support Salvo",
      description: "Voluntary support for Salvo. It grants no gameplay advantage.",
      payload: expectedPayload,
      amount: 88,
      label: "Voluntary support",
    },
  ]);
  assert.deepEqual(result, {
    invoiceId: expectedInvoiceId,
    invoiceUrl: "https://t.me/$salvo-support-test",
    amount: 88,
    currency: "XTR",
    expiresAt: new Date((serviceNow + 900) * 1000).toISOString(),
  });
  assert.deepEqual(Object.keys(result), [
    "invoiceId",
    "invoiceUrl",
    "amount",
    "currency",
    "expiresAt",
  ]);
  assert.equal(JSON.stringify(result).includes(expectedPayload), false);
  assert.equal(JSON.stringify(result).includes(`telegram:${authenticatedUser.id}`), false);
});

test("createInvoice snapshots stateful Telegram identity getters exactly once", async (t) => {
  const db = memoryD1(t);
  let providerReads = 0;
  let idReads = 0;
  const user = Object.defineProperties(
    { name: authenticatedUser.name },
    {
      provider: {
        enumerable: true,
        get() {
          providerReads += 1;
          return providerReads === 1 ? "telegram" : "other";
        },
      },
      id: {
        enumerable: true,
        get() {
          idReads += 1;
          return idReads <= 3 ? authenticatedUser.id : "1";
        },
      },
    },
  );
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink() {
        return "https://t.me/$snapshot-user";
      },
    }),
    now: () => serviceNow,
    randomBytes: (size) => new Uint8Array(size).fill(21),
  });

  await service.createInvoice({ user, amount: 8, locale: "en" });

  assert.equal(providerReads, 1);
  assert.equal(idReads, 1);
  assert.deepEqual(
    db.queryOne("SELECT user_key, telegram_user_id FROM star_support_payments"),
    {
      user_key: `telegram:${authenticatedUser.id}`,
      telegram_user_id: authenticatedUser.id,
    },
  );
});

test("createInvoice accepts support presets and custom amount bounds", async (t) => {
  const db = memoryD1(t);
  let randomCall = 0;
  const providerAmounts = [];
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink({ amount }) {
        providerAmounts.push(amount);
        return `https://t.me/$amount-${amount}`;
      },
    }),
    now: () => serviceNow,
    randomBytes(size) {
      randomCall += 1;
      return Uint8Array.from({ length: size }, (_, index) => (randomCall * 31 + index) % 256);
    },
  });

  for (const amount of [8, 88, 360, 1, 10_000]) {
    const result = await service.createInvoice({ user: authenticatedUser, amount, locale: "en" });
    assert.equal(result.amount, amount);
  }

  assert.deepEqual(providerAmounts, [8, 88, 360, 1, 10_000]);
  assert.deepEqual(
    db.queryAll("SELECT amount FROM star_support_payments ORDER BY created_at, rowid"),
    [8, 88, 360, 1, 10_000].map((amount) => ({ amount })),
  );
});

test("createInvoice owns localized Telegram invoice text", async (t) => {
  const db = memoryD1(t);
  let randomCall = 0;
  const providerCalls = [];
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink(invoice) {
        providerCalls.push(invoice);
        return `https://t.me/$localized-${providerCalls.length}`;
      },
    }),
    now: () => serviceNow,
    randomBytes(size) {
      randomCall += 1;
      return new Uint8Array(size).fill(randomCall);
    },
  });

  for (const locale of ["en", "ru", "zh"]) {
    await service.createInvoice({ user: authenticatedUser, amount: 8, locale });
  }

  assert.deepEqual(
    providerCalls.map(({ title, description, label, amount }) => ({
      title,
      description,
      label,
      amount,
    })),
    [
      {
        title: "Support Salvo",
        description: "Voluntary support for Salvo. It grants no gameplay advantage.",
        label: "Voluntary support",
        amount: 8,
      },
      {
        title: "Поддержать Salvo",
        description: "Добровольная поддержка Salvo. Она не дает преимуществ в игре.",
        label: "Добровольная поддержка",
        amount: 8,
      },
      {
        title: "支持 Salvo",
        description: "自愿支持 Salvo，不会带来任何游戏优势。",
        label: "自愿支持",
        amount: 8,
      },
    ],
  );
  for (const { title, description, label } of providerCalls) {
    assert.ok(Array.from(title).length <= 32);
    assert.ok(Array.from(description).length <= 255);
    assert.ok(Array.from(label).length <= 32);
  }
});

test("createInvoice rejects malformed users, amounts, and locales before side effects", async () => {
  let sideEffects = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        sideEffects += 1;
      },
    },
    botApi: fakeBotApi({
      createInvoiceLink() {
        sideEffects += 1;
      },
    }),
    now() {
      sideEffects += 1;
      return serviceNow;
    },
    randomBytes(size) {
      sideEffects += 1;
      return new Uint8Array(size);
    },
  });
  const invalidUsers = [
    null,
    {},
    { ...authenticatedUser, provider: "Telegram" },
    { ...authenticatedUser, provider: "google" },
    { ...authenticatedUser, id: 1 },
    { ...authenticatedUser, id: "" },
    { ...authenticatedUser, id: "0" },
    { ...authenticatedUser, id: "01" },
    { ...authenticatedUser, id: "+1" },
    { ...authenticatedUser, id: "-1" },
    { ...authenticatedUser, id: "1.0" },
    { ...authenticatedUser, id: "1 " },
    { ...authenticatedUser, id: "4503599627370496" },
    { ...authenticatedUser, id: "9007199254740991" },
  ];
  const invalidAmounts = [
    "8",
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    10_001,
    null,
    undefined,
  ];
  const invalidLocales = [undefined, null, "EN", "en-US", "ru ", "", 1, {}];

  for (const user of invalidUsers) {
    await assertRejectsWithPublicError(
      service.createInvoice({ user, amount: 8, locale: "en" }),
      { category: "invalid_request", status: 400, message: "Invalid Stars support request" },
    );
  }
  for (const amount of invalidAmounts) {
    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount, locale: "en" }),
      { category: "invalid_request", status: 400, message: "Invalid Stars support request" },
    );
  }
  for (const locale of invalidLocales) {
    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount: 8, locale }),
      { category: "invalid_request", status: 400, message: "Invalid Stars support request" },
    );
  }
  await assertRejectsWithPublicError(service.createInvoice(null), {
    category: "invalid_request",
    status: 400,
    message: "Invalid Stars support request",
  });
  assert.equal(sideEffects, 0);
});

test("createInvoice rejects boxed and coercible locales before side effects", async () => {
  let sideEffects = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        sideEffects += 1;
      },
    },
    botApi: fakeBotApi({
      createInvoiceLink() {
        sideEffects += 1;
      },
    }),
    now() {
      sideEffects += 1;
      return serviceNow;
    },
    randomBytes(size) {
      sideEffects += 1;
      return new Uint8Array(size);
    },
  });

  for (const locale of [new String("en"), { toString: () => "ru" }]) {
    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount: 8, locale }),
      { category: "invalid_request", status: 400, message: "Invalid Stars support request" },
    );
  }
  assert.equal(sideEffects, 0);
});

test("Stars support factory validates dependencies with a redacted error", () => {
  const validDb = { prepare() {} };
  const validBotApi = fakeBotApi();
  const invalidOptions = [
    undefined,
    null,
    [],
    {},
    { db: {}, botApi: validBotApi },
    { db: validDb, botApi: {} },
    { db: validDb, botApi: { createInvoiceLink() {} } },
    { db: validDb, botApi: validBotApi, now: 42 },
    { db: validDb, botApi: validBotApi, now: null },
    { db: validDb, botApi: validBotApi, randomBytes: 42 },
    { db: validDb, botApi: validBotApi, randomBytes: null },
  ];

  for (const options of invalidOptions) {
    assertThrowsWithPublicError(
      () => starsSupportModule.createStarsSupportService(options),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
  }

  for (const options of [
    {
      get db() {
        throw new Error("secret database binding");
      },
      botApi: validBotApi,
    },
    {
      db: Object.defineProperty({}, "prepare", {
        get() {
          throw new Error("SELECT invoice_payload FROM secret_table");
        },
      }),
      botApi: validBotApi,
    },
    {
      db: validDb,
      botApi: Object.defineProperty({}, "createInvoiceLink", {
        get() {
          throw new Error("123456:secret-bot-token");
        },
      }),
    },
    {
      db: validDb,
      botApi: Object.defineProperties({}, {
        createInvoiceLink: { value() {} },
        answerPreCheckoutQuery: {
          get() {
            throw new Error("123456:secret-bot-token pre-checkout");
          },
        },
      }),
    },
  ]) {
    assertThrowsWithPublicError(
      () => starsSupportModule.createStarsSupportService(options),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
  }
});

test("createInvoice rejects unsafe clock and randomness results before persistence", async () => {
  const invalidNowValues = [
    serviceNow + 0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    Number.MAX_SAFE_INTEGER,
    String(serviceNow),
    Promise.resolve(serviceNow),
  ];

  for (const value of invalidNowValues) {
    let databaseCalls = 0;
    let providerCalls = 0;
    let nowCalls = 0;
    const service = starsSupportModule.createStarsSupportService({
      db: {
        prepare() {
          databaseCalls += 1;
        },
      },
      botApi: fakeBotApi({
        createInvoiceLink() {
          providerCalls += 1;
        },
      }),
      now() {
        nowCalls += 1;
        return value;
      },
      randomBytes: (size) => new Uint8Array(size),
    });

    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
    assert.equal(nowCalls, 1);
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  }

  for (const makeRandomBytes of [
    () => () => [],
    () => () => new Uint8Array(15),
    () => () => new Uint8Array(17),
    () => {
      let call = 0;
      return (size) => (++call === 1 ? new Uint8Array(size) : new Uint8Array(31));
    },
    () => {
      let call = 0;
      return (size) => (++call === 1 ? new Uint8Array(size) : new Uint8Array(33));
    },
    () => () => Promise.resolve(new Uint8Array(16)),
    () => () => {
      throw new Error("pay_private-provider-payload");
    },
  ]) {
    let databaseCalls = 0;
    let providerCalls = 0;
    const service = starsSupportModule.createStarsSupportService({
      db: {
        prepare() {
          databaseCalls += 1;
        },
      },
      botApi: fakeBotApi({
        createInvoiceLink() {
          providerCalls += 1;
        },
      }),
      now: () => serviceNow,
      randomBytes: makeRandomBytes(),
    });

    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
    assert.equal(databaseCalls, 0);
    assert.equal(providerCalls, 0);
  }
});

test("createInvoice uses secure clock and randomness defaults", async (t) => {
  const db = memoryD1(t);
  let providerPayload;
  const before = Math.floor(Date.now() / 1000);
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink({ payload }) {
        providerPayload = payload;
        return "https://t.me/$default-dependencies";
      },
    }),
  });

  const result = await service.createInvoice({
    user: authenticatedUser,
    amount: 8,
    locale: "en",
  });
  const after = Math.floor(Date.now() / 1000);
  const row = db.queryOne(
    `SELECT invoice_id, invoice_payload, created_at, expires_at
       FROM star_support_payments`,
  );

  assert.match(result.invoiceId, /^inv_[A-Za-z0-9_-]{22}$/u);
  assert.match(providerPayload, /^pay_[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(result.invoiceId.slice(4), "base64url").byteLength, 16);
  assert.equal(Buffer.from(providerPayload.slice(4), "base64url").byteLength, 32);
  assert.equal(row.invoice_id, result.invoiceId);
  assert.equal(row.invoice_payload, providerPayload);
  assert.ok(row.created_at >= before && row.created_at <= after);
  assert.equal(row.expires_at, row.created_at + 900);
  assert.equal(result.expiresAt, new Date(row.expires_at * 1000).toISOString());
});

test("createInvoice redacts throwing request getters as invalid input", async () => {
  let sideEffects = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        sideEffects += 1;
      },
    },
    botApi: fakeBotApi(),
    now() {
      sideEffects += 1;
      return serviceNow;
    },
  });
  const request = Object.defineProperty({}, "user", {
    get() {
      throw new Error("telegram:8710001168 pay_private");
    },
  });

  await assertRejectsWithPublicError(service.createInvoice(request), {
    category: "invalid_request",
    status: 400,
    message: "Invalid Stars support request",
  });
  assert.equal(sideEffects, 0);
});

test("createInvoice redacts D1 insert failures and never calls the provider", async () => {
  const secretSqlError =
    "UNIQUE invoice_payload pay_private user_key telegram:8710001168 SELECT star_support_payments";
  for (const run of [
    async () => {
      throw new Error(secretSqlError);
    },
    async () => ({ success: false, error: secretSqlError }),
  ]) {
    let providerCalls = 0;
    const db = {
      prepare() {
        return {
          bind() {
            return { run };
          },
        };
      },
    };
    const service = starsSupportModule.createStarsSupportService({
      db,
      botApi: fakeBotApi({
        createInvoiceLink() {
          providerCalls += 1;
        },
      }),
      now: () => serviceNow,
      randomBytes: (size) => new Uint8Array(size),
    });

    await assertRejectsWithPublicError(
      service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
    assert.equal(providerCalls, 0);
  }
});

test("createInvoice marks provider failures failed without leaking provider details", async (t) => {
  const db = memoryD1(t);
  const invoiceBytes = new Uint8Array(16).fill(7);
  const expectedInvoiceId = `inv_${Buffer.from(invoiceBytes).toString("base64url")}`;
  const privatePayload = `pay_${Buffer.from(new Uint8Array(32).fill(9)).toString("base64url")}`;
  let nowCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink() {
        throw new Error(`bot token 123456:secret ${privatePayload} telegram:${authenticatedUser.id}`);
      },
    }),
    now() {
      nowCalls += 1;
      return serviceNow;
    },
    randomBytes(size) {
      return size === 16 ? invoiceBytes : new Uint8Array(32).fill(9);
    },
  });

  await assertRejectsWithPublicError(
    service.createInvoice({ user: authenticatedUser, amount: 88, locale: "en" }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );

  assert.equal(nowCalls, 1);
  assert.deepEqual(
    db.queryOne(
      `SELECT invoice_id, status, created_at, expires_at, failed_at
         FROM star_support_payments
        WHERE invoice_id = ?`,
      expectedInvoiceId,
    ),
    {
      invoice_id: expectedInvoiceId,
      status: "failed",
      created_at: serviceNow,
      expires_at: serviceNow + 900,
      failed_at: serviceNow,
    },
  );
});

test("createInvoice rejects invalid provider URLs and marks each row failed", async (t) => {
  const invalidUrls = [
    "http://t.me/$invoice",
    "https://telegram.me/$invoice",
    "https://t.me/",
    "https://t.me/salvo",
    "https://t.me/$invoice?ref=salvo",
    "https://t.me/$invoice#support",
    "https://t.me/$bad.slug",
    "https://t.me/$bad/slug",
    "https://t.me/$",
    `https://t.me/$${"A".repeat(129)}`,
    "https://t.me:443/$invoice",
    "https://t.me.evil.example/$invoice",
    "https://evil.example/t.me/$invoice",
    " https://t.me/$invoice",
    "https://user@t.me/$invoice",
    "https://t.me/$invoice\n",
    "not a Telegram URL",
    42,
    new URL("https://t.me/$invoice"),
  ];

  for (const [index, invalidUrl] of invalidUrls.entries()) {
    await t.test(String(invalidUrl), async (t) => {
      const db = memoryD1(t);
      const invoiceBytes = new Uint8Array(16).fill(index + 1);
      const invoiceId = `inv_${Buffer.from(invoiceBytes).toString("base64url")}`;
      const service = starsSupportModule.createStarsSupportService({
        db,
        botApi: fakeBotApi({ createInvoiceLink: async () => invalidUrl }),
        now: () => serviceNow,
        randomBytes: (size) =>
          size === 16 ? invoiceBytes : new Uint8Array(32).fill(index + 33),
      });

      await assertRejectsWithPublicError(
        service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
        { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
      );
      assert.deepEqual(
        db.queryOne(
          "SELECT status, failed_at FROM star_support_payments WHERE invoice_id = ?",
          invoiceId,
        ),
        { status: "failed", failed_at: serviceNow },
      );
    });
  }
});

test("createInvoice cleanup is conditional and does not overwrite a paid row", async (t) => {
  const db = memoryD1(t);
  const invoiceBytes = new Uint8Array(16).fill(12);
  const invoiceId = `inv_${Buffer.from(invoiceBytes).toString("base64url")}`;
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink() {
        db.execute(
          `UPDATE star_support_payments
              SET status = 'paid', paid_at = ?, telegram_payment_charge_id = ?
            WHERE invoice_id = ?`,
          serviceNow + 1,
          "charge_concurrent",
          invoiceId,
        );
        throw new Error("provider response lost after payment");
      },
    }),
    now: () => serviceNow,
    randomBytes: (size) => (size === 16 ? invoiceBytes : new Uint8Array(32).fill(13)),
  });

  await assertRejectsWithPublicError(
    service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );
  assert.deepEqual(
    db.queryOne(
      "SELECT status, paid_at, failed_at FROM star_support_payments WHERE invoice_id = ?",
      invoiceId,
    ),
    { status: "paid", paid_at: serviceNow + 1, failed_at: null },
  );
});

test("createInvoice keeps provider errors generic when failed-row cleanup also fails", async (t) => {
  const database = memoryD1(t);
  const db = {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                throw new Error("cleanup SELECT invoice_payload secret");
              },
            };
          },
        };
      }
      return database.prepare(sql);
    },
  };
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi({
      async createInvoiceLink() {
        throw new Error("123456:secret-token pay_private");
      },
    }),
    now: () => serviceNow,
    randomBytes: (size) => new Uint8Array(size).fill(14),
  });

  await assertRejectsWithPublicError(
    service.createInvoice({ user: authenticatedUser, amount: 8, locale: "en" }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );
  assert.deepEqual(database.queryOne("SELECT status, failed_at FROM star_support_payments"), {
    status: "pending",
    failed_at: null,
  });
});

test("getInvoice selects by invoice and derived owner in one query", async (t) => {
  const database = memoryD1(t);
  const invoiceId = "inv_ABCDEFGHIJKLMNOPQRSTUV";
  insertPayment(database, {
    invoiceId,
    invoicePayload: "pay_owner-private-payload",
    amount: 360,
    createdAt: serviceNow,
    expiresAt: serviceNow + 900,
  });
  const queries = [];
  const db = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          queries.push({ sql, params });
          return statement.bind(...params);
        },
      };
    },
  };
  let nowCalls = 0;
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now() {
      nowCalls += 1;
      return serviceNow + 30;
    },
  });

  const result = await service.getInvoice({
    user: { ...authenticatedUser, userKey: "telegram:1" },
    invoiceId,
  });

  assert.equal(nowCalls, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WHERE invoice_id = \? AND user_key = \?/u);
  assert.deepEqual(queries[0].params, [invoiceId, `telegram:${authenticatedUser.id}`]);
  assert.deepEqual(result, {
    invoiceId,
    amount: 360,
    currency: "XTR",
    status: "pending",
    createdAt: new Date(serviceNow * 1000).toISOString(),
    expiresAt: new Date((serviceNow + 900) * 1000).toISOString(),
    paidAt: null,
  });
  assert.deepEqual(Object.keys(result), [
    "invoiceId",
    "amount",
    "currency",
    "status",
    "createdAt",
    "expiresAt",
    "paidAt",
  ]);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "pay_owner-private-payload",
    `telegram:${authenticatedUser.id}`,
    authenticatedUser.id,
    "telegram_payment_charge_id",
    "failed_at",
    "refunded_at",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("getInvoice snapshots a stateful request invoice ID exactly once", async (t) => {
  const db = memoryD1(t);
  const requestedInvoiceId = "inv_SSSSSSSSSSSSSSSSSSSSSS";
  const switchedInvoiceId = "inv_TTTTTTTTTTTTTTTTTTTTTT";
  insertPayment(db, {
    invoiceId: requestedInvoiceId,
    invoicePayload: "pay_snapshot_requested",
    amount: 8,
  });
  insertPayment(db, {
    invoiceId: switchedInvoiceId,
    invoicePayload: "pay_snapshot_switched",
    amount: 360,
  });
  let invoiceIdReads = 0;
  const request = Object.defineProperty({ user: authenticatedUser }, "invoiceId", {
    enumerable: true,
    get() {
      invoiceIdReads += 1;
      return invoiceIdReads <= 2 ? requestedInvoiceId : switchedInvoiceId;
    },
  });
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow,
  });

  const result = await service.getInvoice(request);

  assert.equal(invoiceIdReads, 1);
  assert.equal(result.invoiceId, requestedInvoiceId);
  assert.equal(result.amount, 8);
});

test("getInvoice projects pending, expired, failed, paid, and refunded rows", async (t) => {
  const db = memoryD1(t);
  const records = [
    {
      invoiceId: "inv_PPPPPPPPPPPPPPPPPPPPPP",
      invoicePayload: "pay_status_pending",
      status: "pending",
      expiresAt: serviceNow + 1,
      expectedStatus: "pending",
      expectedPaidAt: null,
    },
    {
      invoiceId: "inv_EEEEEEEEEEEEEEEEEEEEEE",
      invoicePayload: "pay_status_expired",
      status: "pending",
      expiresAt: serviceNow,
      expectedStatus: "expired",
      expectedPaidAt: null,
    },
    {
      invoiceId: "inv_FFFFFFFFFFFFFFFFFFFFFF",
      invoicePayload: "pay_status_failed",
      status: "failed",
      failedAt: serviceNow - 1,
      expectedStatus: "failed",
      expectedPaidAt: null,
    },
    {
      invoiceId: "inv_DDDDDDDDDDDDDDDDDDDDDD",
      invoicePayload: "pay_status_paid",
      status: "paid",
      paidAt: serviceNow - 2,
      telegramPaymentChargeId: "charge_paid",
      expectedStatus: "paid",
      expectedPaidAt: new Date((serviceNow - 2) * 1000).toISOString(),
    },
    {
      invoiceId: "inv_RRRRRRRRRRRRRRRRRRRRRR",
      invoicePayload: "pay_status_refunded",
      status: "refunded",
      paidAt: serviceNow - 3,
      refundedAt: serviceNow - 1,
      telegramPaymentChargeId: "charge_refunded",
      expectedStatus: "failed",
      expectedPaidAt: new Date((serviceNow - 3) * 1000).toISOString(),
    },
  ];
  for (const record of records) {
    const { expectedStatus, expectedPaidAt, ...payment } = record;
    insertPayment(db, {
      createdAt: serviceNow - 10,
      expiresAt: serviceNow + 900,
      ...payment,
    });
    record.expectedStatus = expectedStatus;
    record.expectedPaidAt = expectedPaidAt;
  }
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow,
  });

  for (const record of records) {
    const result = await service.getInvoice({
      user: authenticatedUser,
      invoiceId: record.invoiceId,
    });
    assert.equal(result.status, record.expectedStatus);
    assert.equal(result.paidAt, record.expectedPaidAt);
  }
  assert.deepEqual(
    db.queryOne(
      "SELECT status, expires_at FROM star_support_payments WHERE invoice_id = ?",
      "inv_EEEEEEEEEEEEEEEEEEEEEE",
    ),
    { status: "pending", expires_at: serviceNow },
  );
});

test("getInvoice makes wrong-owner and unknown invoices indistinguishable", async (t) => {
  const db = memoryD1(t);
  const invoiceId = "inv_OOOOOOOOOOOOOOOOOOOOOO";
  insertPayment(db, {
    invoiceId,
    invoicePayload: "pay_owner_hidden",
  });
  const service = starsSupportModule.createStarsSupportService({
    db,
    botApi: fakeBotApi(),
    now: () => serviceNow,
  });
  const expected = {
    category: "not_found",
    status: 404,
    message: "Stars invoice not found",
  };

  await assertRejectsWithPublicError(
    service.getInvoice({
      user: { ...authenticatedUser, id: "8710001169" },
      invoiceId,
    }),
    expected,
  );
  await assertRejectsWithPublicError(
    service.getInvoice({
      user: authenticatedUser,
      invoiceId: "inv_UUUUUUUUUUUUUUUUUUUUUU",
    }),
    expected,
  );
});

test("getInvoice validates the user and exact public invoice ID before side effects", async () => {
  let sideEffects = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        sideEffects += 1;
      },
    },
    botApi: fakeBotApi(),
    now() {
      sideEffects += 1;
      return serviceNow;
    },
  });
  const invalidInvoiceIds = [
    null,
    undefined,
    "",
    "inv_",
    `inv_${"A".repeat(21)}`,
    `inv_${"A".repeat(23)}`,
    `INV_${"A".repeat(22)}`,
    `inv_${"A".repeat(21)}+`,
    ` inv_${"A".repeat(22)}`,
    42,
  ];
  const invalidUsers = [
    null,
    { ...authenticatedUser, provider: "Telegram" },
    { ...authenticatedUser, id: "01" },
    { ...authenticatedUser, id: "4503599627370496" },
  ];
  const expected = {
    category: "invalid_request",
    status: 400,
    message: "Invalid Stars support request",
  };

  for (const invoiceId of invalidInvoiceIds) {
    await assertRejectsWithPublicError(
      service.getInvoice({ user: authenticatedUser, invoiceId }),
      expected,
    );
  }
  for (const user of invalidUsers) {
    await assertRejectsWithPublicError(
      service.getInvoice({ user, invoiceId: "inv_VVVVVVVVVVVVVVVVVVVVVV" }),
      expected,
    );
  }
  await assertRejectsWithPublicError(service.getInvoice(null), expected);
  assert.equal(sideEffects, 0);
});

test("getInvoice redacts throwing request getters as invalid input", async () => {
  let sideEffects = 0;
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        sideEffects += 1;
      },
    },
    botApi: fakeBotApi(),
    now() {
      sideEffects += 1;
      return serviceNow;
    },
  });
  const request = Object.defineProperty({ user: authenticatedUser }, "invoiceId", {
    get() {
      throw new Error("pay_private user_key telegram:8710001168");
    },
  });

  await assertRejectsWithPublicError(service.getInvoice(request), {
    category: "invalid_request",
    status: 400,
    message: "Invalid Stars support request",
  });
  assert.equal(sideEffects, 0);
});

test("getInvoice rejects unsafe clock values before querying D1", async () => {
  for (const now of [
    () => Number.NaN,
    () => -1,
    () => Number.MAX_SAFE_INTEGER,
    () => {
      throw new Error("clock secret");
    },
  ]) {
    let databaseCalls = 0;
    const service = starsSupportModule.createStarsSupportService({
      db: {
        prepare() {
          databaseCalls += 1;
        },
      },
      botApi: fakeBotApi(),
      now,
    });

    await assertRejectsWithPublicError(
      service.getInvoice({
        user: authenticatedUser,
        invoiceId: "inv_CCCCCCCCCCCCCCCCCCCCCC",
      }),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
    assert.equal(databaseCalls, 0);
  }
});

test("getInvoice redacts D1 read failures", async () => {
  const service = starsSupportModule.createStarsSupportService({
    db: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error(
                  "SELECT invoice_payload user_key telegram:8710001168 charge_private",
                );
              },
            };
          },
        };
      },
    },
    botApi: fakeBotApi(),
    now: () => serviceNow,
  });

  await assertRejectsWithPublicError(
    service.getInvoice({
      user: authenticatedUser,
      invoiceId: "inv_QQQQQQQQQQQQQQQQQQQQQQ",
    }),
    { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
  );
});

test("getInvoice rejects malformed stored rows with a redacted service error", async () => {
  const invoiceId = "inv_MMMMMMMMMMMMMMMMMMMMMM";
  const validRow = {
    invoice_id: invoiceId,
    amount: 88,
    currency: "XTR",
    status: "pending",
    created_at: serviceNow - 10,
    expires_at: serviceNow + 10,
    paid_at: null,
  };
  const malformedRows = [
    [],
    {},
    { ...validRow, invoice_id: "inv_NNNNNNNNNNNNNNNNNNNNNN" },
    { ...validRow, amount: "88" },
    { ...validRow, amount: 0 },
    { ...validRow, amount: 10_001 },
    { ...validRow, amount: 1.5 },
    { ...validRow, currency: "USD" },
    { ...validRow, status: "expired" },
    { ...validRow, status: "cancelled" },
    { ...validRow, created_at: String(serviceNow) },
    { ...validRow, created_at: -1 },
    { ...validRow, expires_at: serviceNow - 10 },
    { ...validRow, expires_at: Number.MAX_SAFE_INTEGER },
    { ...validRow, paid_at: "now" },
    { ...validRow, paid_at: serviceNow, status: "pending" },
    { ...validRow, paid_at: null, status: "paid" },
    { ...validRow, paid_at: null, status: "refunded" },
    {
      ...validRow,
      paid_at: serviceNow - 20,
      status: "paid",
    },
  ];

  for (const row of malformedRows) {
    const service = starsSupportModule.createStarsSupportService({
      db: {
        prepare() {
          return {
            bind() {
              return { first: async () => row };
            },
          };
        },
      },
      botApi: fakeBotApi(),
      now: () => serviceNow,
    });

    await assertRejectsWithPublicError(
      service.getInvoice({ user: authenticatedUser, invoiceId }),
      { category: "service_unavailable", status: 503, message: "Stars support is unavailable" },
    );
  }
});

test("payment migration accepts a valid pending invoice", (t) => {
  const db = memoryD1(t);

  const result = insertPendingInvoice(db, pendingInvoice);

  assert.equal(Number(result.changes), 1);
  assert.deepEqual(db.queryOne("SELECT * FROM star_support_payments WHERE invoice_id = ?", pendingInvoice.invoiceId), {
    invoice_id: pendingInvoice.invoiceId,
    invoice_payload: pendingInvoice.invoicePayload,
    user_key: pendingInvoice.userKey,
    telegram_user_id: pendingInvoice.telegramUserId,
    amount: pendingInvoice.amount,
    currency: "XTR",
    status: "pending",
    created_at: pendingInvoice.createdAt,
    expires_at: pendingInvoice.expiresAt,
    paid_at: null,
    failed_at: null,
    refunded_at: null,
    telegram_payment_charge_id: null,
  });
});

test("payment migration creates owner and expiry indexes", (t) => {
  const db = memoryD1(t);
  const indexes = db.queryAll(
    `SELECT name
       FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'star_support_payments'
        AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY name`,
  );

  assert.deepEqual(indexes.map(({ name }) => name), [
    "idx_star_support_expiry",
    "idx_star_support_owner_created",
  ]);
  assert.deepEqual(indexColumns(db, "idx_star_support_owner_created"), [
    { name: "user_key", desc: 0 },
    { name: "created_at", desc: 1 },
  ]);
  assert.deepEqual(indexColumns(db, "idx_star_support_expiry"), [
    { name: "status", desc: 0 },
    { name: "expires_at", desc: 0 },
  ]);
});

test("payment migration rejects duplicate invoice IDs", (t) => {
  const db = memoryD1(t);
  insertPayment(db, { invoiceId: "inv_duplicate", invoicePayload: "pay_first" });

  assert.throws(
    () => insertPayment(db, { invoiceId: "inv_duplicate", invoicePayload: "pay_second" }),
    /UNIQUE constraint failed: star_support_payments\.invoice_id/,
  );
});

test("payment migration rejects null invoice IDs", (t) => {
  const db = memoryD1(t);

  assert.throws(
    () => insertPayment(db, { invoiceId: null }),
    /NOT NULL constraint failed: star_support_payments\.invoice_id/,
  );
});

test("payment migration rejects duplicate invoice payloads", (t) => {
  const db = memoryD1(t);
  insertPayment(db, { invoiceId: "inv_first", invoicePayload: "pay_duplicate" });

  assert.throws(
    () => insertPayment(db, { invoiceId: "inv_second", invoicePayload: "pay_duplicate" }),
    /UNIQUE constraint failed: star_support_payments\.invoice_payload/,
  );
});

test("payment migration rejects duplicate non-null Telegram charge IDs", (t) => {
  const db = memoryD1(t);
  insertPayment(db, {
    invoiceId: "inv_first_paid",
    invoicePayload: "pay_first_paid",
    status: "paid",
    paidAt: pendingInvoice.createdAt + 30,
    telegramPaymentChargeId: "charge_duplicate",
  });

  assert.throws(
    () =>
      insertPayment(db, {
        invoiceId: "inv_second_paid",
        invoicePayload: "pay_second_paid",
        status: "paid",
        paidAt: pendingInvoice.createdAt + 45,
        telegramPaymentChargeId: "charge_duplicate",
      }),
    /UNIQUE constraint failed: star_support_payments\.telegram_payment_charge_id/,
  );
});

test("payment migration permits duplicate null Telegram charge IDs", (t) => {
  const db = memoryD1(t);
  insertPayment(db, { invoiceId: "inv_null_first", invoicePayload: "pay_null_first" });
  insertPayment(db, { invoiceId: "inv_null_second", invoicePayload: "pay_null_second" });

  assert.deepEqual(
    db.queryAll(
      `SELECT telegram_payment_charge_id
         FROM star_support_payments
        ORDER BY invoice_id`,
    ),
    [{ telegram_payment_charge_id: null }, { telegram_payment_charge_id: null }],
  );
});

test("payment migration rejects amounts outside the supported range", (t) => {
  const db = memoryD1(t);

  for (const amount of [0, 10_001]) {
    assert.throws(
      () => insertPayment(db, { amount }),
      /CHECK constraint failed/,
      `amount ${amount} should be rejected`,
    );
  }
});

test("payment migration uses strict typing to reject fractional amounts", (t) => {
  const db = memoryD1(t);

  assert.throws(
    () => insertPayment(db, { amount: 1.5 }),
    /cannot store REAL value in INTEGER column star_support_payments\.amount/,
  );
  assert.equal(
    db.queryOne("SELECT strict FROM pragma_table_list WHERE name = 'star_support_payments'").strict,
    1,
  );
});

test("payment migration rejects currencies other than XTR", (t) => {
  const db = memoryD1(t);

  assert.throws(() => insertPayment(db, { currency: "USD" }), /CHECK constraint failed/);
});

test("payment migration rejects unknown statuses", (t) => {
  const db = memoryD1(t);

  assert.throws(() => insertPayment(db, { status: "cancelled" }), /CHECK constraint failed/);
});

test("payment migration rejects paid rows without a paid timestamp", (t) => {
  const db = memoryD1(t);

  assert.throws(
    () => insertPayment(db, { status: "paid", telegramPaymentChargeId: "charge_without_paid_at" }),
    /CHECK constraint failed/,
  );
});

test("payment migration rejects paid rows without a Telegram charge ID", (t) => {
  const db = memoryD1(t);

  assert.throws(
    () => insertPayment(db, { status: "paid", paidAt: pendingInvoice.createdAt + 30 }),
    /CHECK constraint failed/,
  );
});

test("payment migration rejects expiry before creation", (t) => {
  const db = memoryD1(t);

  assert.throws(
    () => insertPayment(db, { expiresAt: pendingInvoice.createdAt - 1 }),
    /CHECK constraint failed/,
  );
});

test("payment records do not depend on player profile tables", (t) => {
  const db = memoryD1(t);

  assert.deepEqual(db.queryAll("PRAGMA foreign_key_list('star_support_payments')"), []);
  insertPayment(db, {
    invoiceId: "inv_without_profile",
    invoicePayload: "pay_without_profile",
    userKey: "telegram:not-in-users",
    telegramUserId: "not-in-users",
  });
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM users").count, 0);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM star_support_payments").count, 1);
});

function recoveryDb(database, chargeOwner) {
  return {
    prepare(sql) {
      if (/^\s*UPDATE\s/u.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                throw new Error("ambiguous update failure");
              },
            };
          },
        };
      }
      if (/WHERE telegram_payment_charge_id = \?/u.test(sql)) {
        return {
          bind() {
            return { first: async () => chargeOwner };
          },
        };
      }
      return database.prepare(sql);
    },
  };
}

function fakeBotApi(overrides = {}) {
  return {
    createInvoiceLink() {},
    answerPreCheckoutQuery() {},
    ...overrides,
  };
}

function memoryD1(t) {
  const db = new MemoryD1();
  t.after(() => db.close());
  return db;
}

class MemoryD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(profileSchema);
    this.database.exec(sessionSchema);
    this.database.exec(paymentSchema);
  }

  prepare(sql) {
    return new MemoryStatement(this.database, sql);
  }

  execute(sql, ...params) {
    return this.database.prepare(sql).run(...params);
  }

  queryOne(sql, ...params) {
    return plainRow(this.database.prepare(sql).get(...params) ?? null);
  }

  queryAll(sql, ...params) {
    return this.database.prepare(sql).all(...params).map(plainRow);
  }

  close() {
    this.database.close();
  }
}

class MemoryStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new MemoryStatement(this.database, this.sql, params);
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first(columnName) {
    const row = plainRow(this.database.prepare(this.sql).get(...this.params) ?? null);
    return columnName ? (row?.[columnName] ?? null) : row;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params).map(plainRow), success: true };
  }
}

function insertPendingInvoice(db, invoice) {
  return db.execute(
    `INSERT INTO star_support_payments (
      invoice_id, invoice_payload, user_key, telegram_user_id,
      amount, currency, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'XTR', 'pending', ?, ?)`,
    invoice.invoiceId,
    invoice.invoicePayload,
    invoice.userKey,
    invoice.telegramUserId,
    invoice.amount,
    invoice.createdAt,
    invoice.expiresAt,
  );
}

function insertPayment(db, overrides = {}) {
  const payment = {
    invoiceId: "inv_default",
    invoicePayload: "pay_default",
    userKey: pendingInvoice.userKey,
    telegramUserId: pendingInvoice.telegramUserId,
    amount: pendingInvoice.amount,
    currency: "XTR",
    status: "pending",
    createdAt: pendingInvoice.createdAt,
    expiresAt: pendingInvoice.expiresAt,
    paidAt: null,
    failedAt: null,
    refundedAt: null,
    telegramPaymentChargeId: null,
    ...overrides,
  };

  return db.execute(
    `INSERT INTO star_support_payments (
      invoice_id, invoice_payload, user_key, telegram_user_id,
      amount, currency, status, created_at, expires_at,
      paid_at, failed_at, refunded_at, telegram_payment_charge_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    payment.invoiceId,
    payment.invoicePayload,
    payment.userKey,
    payment.telegramUserId,
    payment.amount,
    payment.currency,
    payment.status,
    payment.createdAt,
    payment.expiresAt,
    payment.paidAt,
    payment.failedAt,
    payment.refundedAt,
    payment.telegramPaymentChargeId,
  );
}

function indexColumns(db, indexName) {
  return db
    .queryAll(`PRAGMA index_xinfo('${indexName}')`)
    .filter(({ key }) => key === 1)
    .map(({ name, desc }) => ({ name, desc }));
}

function plainRow(row) {
  return row === null ? null : { ...row };
}

async function assertRejectsWithPublicError(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.message, expected.message);
    assert.equal(error?.category, expected.category);
    assert.equal(error?.status, expected.status);
    assert.equal(Object.hasOwn(error ?? {}, "cause"), false);
    return true;
  });
}

function assertThrowsWithPublicError(callback, expected) {
  assert.throws(callback, (error) => {
    assert.equal(error?.message, expected.message);
    assert.equal(error?.category, expected.category);
    assert.equal(error?.status, expected.status);
    assert.equal(Object.hasOwn(error ?? {}, "cause"), false);
    return true;
  });
}

function assertWebhookHeaders(response) {
  assert.equal(response.headers.get("Content-Type"), "application/json");
  for (const name of response.headers.keys()) {
    assert.equal(name.toLowerCase().startsWith("access-control-allow-"), false, name);
  }
}

async function createWorkerSession(db, user = authenticatedUser) {
  return (await createSession(db, user)).token;
}

function postStarsInvoice(body, env, token, contentType = "application/json") {
  return rawStarsInvoiceRequest(
    typeof body === "string" ? body : JSON.stringify(body),
    env,
    token,
    contentType,
  );
}

function rawStarsInvoiceRequest(body, env, token, contentType = "application/json", extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  if (token !== undefined) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (typeof contentType === "string") {
    headers.set("Content-Type", contentType);
  }
  return worker.fetch(
    new Request("https://worker.test/payments/stars/invoices", {
      method: "POST",
      headers,
      body,
    }),
    env,
  );
}

function postTelegramWebhook(body, env, secret, contentType = "application/json") {
  return rawTelegramWebhookRequest(
    typeof body === "string" ? body : JSON.stringify(body),
    env,
    secret,
    contentType,
  );
}

function rawTelegramWebhookRequest(
  body,
  env,
  secretOrOptions,
  contentType = "application/json",
  extraHeaders = {},
) {
  const options =
    secretOrOptions !== null && typeof secretOrOptions === "object"
      ? secretOrOptions
      : { secret: secretOrOptions, contentType, extraHeaders };
  const {
    secret,
    contentType: resolvedContentType = "application/json",
    contentLength,
    extraHeaders: resolvedExtraHeaders = {},
  } = options;
  const headers = new Headers(resolvedExtraHeaders);
  if (typeof resolvedContentType === "string") {
    headers.set("Content-Type", resolvedContentType);
  }
  if (secret !== undefined) {
    headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  }
  if (contentLength !== undefined) {
    headers.set("Content-Length", contentLength);
  }
  return worker.fetch(
    new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers,
      body,
    }),
    env,
  );
}

function streamTelegramWebhookRequest(body, { onText, onJson } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    url: "https://worker.test/telegram/webhook",
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
    }),
    body: new ReadableStream({
      start(controller) {
        const midpoint = Math.floor(bytes.byteLength / 2);
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
        controller.close();
      },
    }),
    text() {
      onText?.();
      throw new Error("webhook must not call text()");
    },
    json() {
      onJson?.();
      throw new Error("webhook must not call json()");
    },
  };
}

function telegramResponse(result, init = {}) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function textByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function assertRedacted(value, secrets) {
  for (const secret of secrets) {
    assert.equal(value.includes(secret), false, `response leaked ${secret}`);
  }
}
