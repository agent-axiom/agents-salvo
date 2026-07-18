import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

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
