import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
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

test("Stars support service exports its public limits and factory", () => {
  assert.ok(starsSupportModule, "Stars support module should exist");
  assert.deepEqual(starsSupportModule.starsAmountLimits, { min: 1, max: 10_000 });
  assert.equal(Object.isFrozen(starsSupportModule.starsAmountLimits), true);
  assert.equal(starsSupportModule.starsInvoiceTtlSeconds, 15 * 60);
  assert.equal(typeof starsSupportModule.createStarsSupportService, "function");
});

test("Stars support factory exposes create and lookup operations", () => {
  const service = starsSupportModule.createStarsSupportService({
    db: { prepare() {} },
    botApi: { createInvoiceLink() {} },
  });

  assert.deepEqual(Object.keys(service).sort(), ["createInvoice", "getInvoice"]);
  assert.equal(typeof service.createInvoice, "function");
  assert.equal(typeof service.getInvoice, "function");
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
  const botApi = {
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
  };
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
    botApi: {
      async createInvoiceLink() {
        return "https://t.me/$snapshot-user";
      },
    },
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
    botApi: {
      async createInvoiceLink({ amount }) {
        providerAmounts.push(amount);
        return `https://t.me/$amount-${amount}`;
      },
    },
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
    botApi: {
      async createInvoiceLink(invoice) {
        providerCalls.push(invoice);
        return `https://t.me/$localized-${providerCalls.length}`;
      },
    },
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
    botApi: {
      createInvoiceLink() {
        sideEffects += 1;
      },
    },
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
    botApi: {
      createInvoiceLink() {
        sideEffects += 1;
      },
    },
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
  const validBotApi = { createInvoiceLink() {} };
  const invalidOptions = [
    undefined,
    null,
    [],
    {},
    { db: {}, botApi: validBotApi },
    { db: validDb, botApi: {} },
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
      botApi: {
        createInvoiceLink() {
          providerCalls += 1;
        },
      },
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
      botApi: {
        createInvoiceLink() {
          providerCalls += 1;
        },
      },
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
    botApi: {
      async createInvoiceLink({ payload }) {
        providerPayload = payload;
        return "https://t.me/$default-dependencies";
      },
    },
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
    botApi: { createInvoiceLink() {} },
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
      botApi: {
        createInvoiceLink() {
          providerCalls += 1;
        },
      },
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
    botApi: {
      async createInvoiceLink() {
        throw new Error(`bot token 123456:secret ${privatePayload} telegram:${authenticatedUser.id}`);
      },
    },
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
        botApi: { createInvoiceLink: async () => invalidUrl },
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
    botApi: {
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
    },
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
    botApi: {
      async createInvoiceLink() {
        throw new Error("123456:secret-token pay_private");
      },
    },
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
    botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
      botApi: { createInvoiceLink() {} },
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
    botApi: { createInvoiceLink() {} },
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
      botApi: { createInvoiceLink() {} },
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
