import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createTelegramMiniAppAuthClient } from "../src/telegram-mini-app-auth.js";
import worker from "../worker/index.js";
import { verifyTelegramMiniAppInitData } from "../worker/telegram-mini-app-auth.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const textEncoder = new TextEncoder();
const profileSchema = await readFile(new URL("../migrations/0001_player_profiles.sql", import.meta.url), "utf8");
const sessionSchema = await readFile(new URL("../migrations/0003_mobile_oidc_sessions.sql", import.meta.url), "utf8");
const botToken = "123456:test-bot-token";
const queryId = "AAHdF6IQAAAAAN0XohDhrOrc";
const telegramUserJson = JSON.stringify({
  id: 8710001168,
  first_name: "Dima",
  last_name: "Kosarevsky",
  username: "agent_axiom",
  language_code: "ru",
  photo_url: "https://t.me/i/userpic/320/avatar.jpg",
});
const expectedUser = {
  provider: "telegram",
  id: "8710001168",
  name: "Dima Kosarevsky",
  username: "agent_axiom",
  photoUrl: "https://t.me/i/userpic/320/avatar.jpg",
};
const authenticationFailure = JSON.stringify({ error: "Telegram Mini App authentication failed" });
const maxInitDataBytes = 16 * 1024;

test("Telegram Mini App auth creates an opaque session for the existing Telegram identity", async (t) => {
  const db = memoryD1(t);
  const initData = await signedInitData();

  const response = await postMiniApp({ initData }, { DB: db, TELEGRAM_BOT_TOKEN: botToken });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.user, expectedUser);
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.queryOne("SELECT user_key FROM auth_sessions").user_key, "telegram:8710001168");

  const me = await worker.fetch(
    new Request("https://worker.test/auth/me", {
      headers: { Authorization: `Bearer ${payload.token}` },
    }),
    { DB: db },
  );
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: payload.user });
});

test("Mini App client and Worker accept the exact raw initData boundary", async (t) => {
  const db = memoryD1(t);
  const initData = await signedInitDataAtByteLength(maxInitDataBytes);
  const oversizedInitData = `${initData}x`;
  let fetchCalls = 0;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    async fetcher(url, init) {
      fetchCalls += 1;
      assert.equal(textEncoder.encode(init.body).byteLength, maxInitDataBytes + 15);
      return worker.fetch(new Request(url, init), { DB: db, TELEGRAM_BOT_TOKEN: botToken });
    },
  });

  const payload = await client.authenticate(initData);
  assert.deepEqual(payload.user, expectedUser);
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fetchCalls, 1);

  await assert.rejects(client.authenticate(oversizedInitData), { name: "TypeError" });
  await assert.rejects(
    verifyTelegramMiniAppInitData(oversizedInitData, botToken),
    { message: "Telegram Mini App authentication failed" },
  );
  assert.equal(fetchCalls, 1);
});

test("Telegram Mini App auth route matches only the exact path and POST method", async () => {
  for (const [method, path] of [
    ["GET", "/auth/telegram/miniapp"],
    ["PUT", "/auth/telegram/miniapp"],
    ["POST", "/auth/telegram/miniapp/"],
    ["POST", "/AUTH/telegram/miniapp"],
  ]) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, { method }), {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("Telegram Mini App auth rejects invalid requests and failures with one redacted response", async (t) => {
  const db = memoryD1(t);
  const now = Math.floor(Date.now() / 1_000);
  const initData = await signedInitData({ auth_date: String(now) });
  const staleInitData = await signedInitData({ auth_date: String(now - 600) });
  const tamperedInitData = initData.replace(/hash=([a-f0-9])/, (_, first) => `hash=${first === "a" ? "b" : "a"}`);
  const hash = new URLSearchParams(initData).get("hash");
  const d1Failure = {
    prepare() {
      throw new Error(`D1 failure: ${telegramUserJson}`);
    },
  };
  const cases = [
    {
      name: "wrong content type",
      request: () => postMiniApp({ initData }, { DB: db, TELEGRAM_BOT_TOKEN: botToken }, "text/plain"),
    },
    {
      name: "extra JSON field",
      request: () => postMiniApp({ initData, callback: "https://attacker.test" }, { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "missing initData",
      request: () => postMiniApp({}, { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "missing D1 binding",
      request: () => postMiniApp({ initData }, { TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "missing bot token",
      request: () => postMiniApp({ initData }, { DB: db }),
    },
    {
      name: "malformed JSON",
      request: () => rawMiniAppRequest("{not-json", { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "oversized JSON",
      request: () => postMiniApp({ initData: "x".repeat(16 * 1024) }, { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "stale initData",
      request: () => postMiniApp({ initData: staleInitData }, { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "tampered initData",
      request: () => postMiniApp({ initData: tamperedInitData }, { DB: db, TELEGRAM_BOT_TOKEN: botToken }),
    },
    {
      name: "D1 failure",
      request: () => postMiniApp({ initData }, { DB: d1Failure, TELEGRAM_BOT_TOKEN: botToken }),
    },
  ];

  for (const rejection of cases) {
    const response = await rejection.request();
    const body = await response.text();
    assert.equal(response.status, 401, rejection.name);
    assert.equal(body, authenticationFailure, rejection.name);
    assertRedacted(body, [botToken, initData, staleInitData, tamperedInitData, hash, queryId, telegramUserJson]);
  }
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count, 0);
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
  }

  prepare(sql) {
    return new MemoryStatement(this.database, sql);
  }

  queryOne(sql, ...params) {
    return this.database.prepare(sql).get(...params) ?? null;
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
    const row = this.database.prepare(this.sql).get(...this.params) ?? null;
    return columnName ? (row?.[columnName] ?? null) : row;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params), success: true };
  }
}

async function postMiniApp(body, env, contentType = "application/json") {
  return rawMiniAppRequest(JSON.stringify(body), env, contentType);
}

async function rawMiniAppRequest(body, env, contentType = "application/json") {
  return worker.fetch(
    new Request("https://worker.test/auth/telegram/miniapp", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }),
    env,
  );
}

async function signedInitData(overrides = {}) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: queryId,
    start_param: "room_ABCD",
    user: telegramUserJson,
    ...overrides,
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(textEncoder.encode("WebAppData"), botToken);
  const hash = bytesToHex(await hmac(secret, dataCheckString));
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function signedInitDataAtByteLength(byteLength) {
  const empty = await signedInitData({ query_id: "" });
  const paddingLength = byteLength - textEncoder.encode(empty).byteLength;
  assert.ok(paddingLength > 0);
  const initData = await signedInitData({ query_id: "x".repeat(paddingLength) });
  assert.equal(textEncoder.encode(initData).byteLength, byteLength);
  return initData;
}

async function hmac(secret, value) {
  const key = await cryptoApi.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await cryptoApi.subtle.sign("HMAC", key, textEncoder.encode(value)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertRedacted(value, secrets) {
  for (const secret of secrets) {
    assert.equal(value.includes(secret), false, `response leaked ${secret}`);
  }
}
