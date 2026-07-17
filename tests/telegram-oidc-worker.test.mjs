import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../worker/index.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const profileSchema = await readFile(new URL("../migrations/0001_player_profiles.sql", import.meta.url), "utf8");
const sessionSchema = await readFile(new URL("../migrations/0003_mobile_oidc_sessions.sql", import.meta.url), "utf8");
const callbackUri = "https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/mobile/callback";
const canonicalWebTarget = "https://agent-axiom.github.io/agents-salvo/";
const jwksUri = "https://oauth.telegram.org/.well-known/jwks.json";
const clientId = "telegram-client-id";
const clientSecret = "telegram-client-secret";
const keyId = "telegram-worker-test-key";

const signingKeys = await cryptoApi.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = {
  ...(await cryptoApi.subtle.exportKey("jwk", signingKeys.publicKey)),
  kid: keyId,
  alg: "RS256",
  use: "sig",
};

test("Telegram OIDC config reports only the available method", async () => {
  for (const env of [
    {},
    { TELEGRAM_CLIENT_ID: clientId },
    { TELEGRAM_CLIENT_SECRET: clientSecret },
    { TELEGRAM_CLIENT_ID: " ", TELEGRAM_CLIENT_SECRET: clientSecret },
  ]) {
    const response = await worker.fetch(new Request("https://worker.test/auth/telegram/config"), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { method: "legacy" });
  }

  const response = await worker.fetch(new Request("https://worker.test/auth/telegram/config"), {
    TELEGRAM_CLIENT_ID: clientId,
    TELEGRAM_CLIENT_SECRET: clientSecret,
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { method: "oidc" });
  assert.doesNotMatch(body, new RegExp(`${clientId}|${clientSecret}`));
});

test("Telegram OIDC routes match exact paths and methods", async () => {
  const cases = [
    ["POST", "/auth/telegram/config"],
    ["GET", "/auth/telegram/mobile/start"],
    ["POST", "/auth/telegram/mobile/callback"],
    ["GET", "/auth/telegram/mobile/redeem"],
    ["GET", "/auth/telegram/config/"],
    ["GET", "/AUTH/telegram/config"],
    ["GET", "/auth/telegram/mobile/callback/extra"],
  ];

  for (const [method, path] of cases) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`, { method }), {});
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("Telegram OIDC start requires configuration and strict platform JSON", async (t) => {
  const db = memoryD1(t);
  const missing = await postJson("/auth/telegram/mobile/start", { platform: "web" }, { DB: db });
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: "Telegram OIDC unavailable" });

  const env = oidcEnv(db);
  const invalidBodies = [
    {},
    { platform: "desktop" },
    { platform: "Android" },
    { platform: "web", callback: "https://attacker.test/callback" },
    { platform: "ios", returnUrl: "https://attacker.test/return" },
  ];
  for (const body of invalidBodies) {
    const response = await postJson("/auth/telegram/mobile/start", body, env);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  }

  const malformed = await worker.fetch(
    new Request("https://worker.test/auth/telegram/mobile/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }),
    env,
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request" });

  const oversized = await worker.fetch(
    new Request("https://worker.test/auth/telegram/mobile/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "web", padding: "x".repeat(2_000) }),
    }),
    env,
  );
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "Invalid request" });

  const strictBodyCases = [
    new Request("https://worker.test/auth/telegram/mobile/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2048" },
      body: JSON.stringify({ platform: "web" }),
    }),
    new Request("https://worker.test/auth/telegram/mobile/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
    new Request("https://worker.test/auth/telegram/mobile/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    }),
  ];
  for (const request of strictBodyCases) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  }
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_oidc_flows").count, 0);
});

test("Telegram OIDC start and callback redact unavailable service state", async () => {
  const storageSecret = "sensitive-d1-failure";
  const start = await postJson(
    "/auth/telegram/mobile/start",
    { platform: "web" },
    oidcEnv({
      prepare() {
        throw new Error(storageSecret);
      },
    }),
  );
  const startBody = await start.text();
  assert.equal(start.status, 503);
  assert.deepEqual(JSON.parse(startBody), { error: "Telegram OIDC unavailable" });
  assertRedacted(startBody, [storageSecret, clientSecret]);

  const state = "s".repeat(43);
  const code = "sensitive-callback-code";
  const callback = await worker.fetch(
    new Request(`https://worker.test/auth/telegram/mobile/callback?state=${state}&code=${code}`),
    {},
  );
  const location = callback.headers.get("Location");
  assert.equal(callback.status, 302);
  assert.equal(location, `${canonicalWebTarget}?auth_error=telegram`);
  assertRedacted(location, [state, code]);
});

test("Telegram OIDC start persists only the state hash and schedules bounded cleanup", async (t) => {
  const db = memoryD1(t);
  seedExpiredFlowsAndTickets(db, 102);
  const ctx = waitUntilContext();
  const before = epochSeconds();

  const response = await postJson("/auth/telegram/mobile/start", { platform: "android" }, oidcEnv(db), ctx);

  const after = epochSeconds();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.clone().json()), ["authorizationUrl"]);
  const { authorizationUrl } = await response.json();
  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.origin, "https://oauth.telegram.org");
  assert.equal(authorization.pathname, "/auth");
  assert.equal(authorization.searchParams.get("client_id"), clientId);
  assert.equal(authorization.searchParams.get("redirect_uri"), callbackUri);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("client_secret"), false);

  const state = authorization.searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const flow = db.queryOne("SELECT * FROM telegram_oidc_flows WHERE state_hash = ?", await sha256Base64Url(state));
  assert.equal(flow.platform, "android");
  assert.match(flow.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(flow.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(flow.created_at >= before && flow.created_at <= after);
  assert.equal(flow.expires_at, flow.created_at + 300);
  assert.equal(flow.consumed_at, null);
  assert.equal(db.serializedRows().includes(state), false);
  assert.equal(ctx.promises.length, 1);

  await Promise.all(ctx.promises);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_oidc_flows WHERE expires_at <= ?", after).count, 2);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets WHERE expires_at <= ?", after).count, 2);
});

test("Telegram OIDC callback verifies a real RSA token and stores a hashed one-use ticket", async (t) => {
  const db = memoryD1(t);
  const flow = await startFlow(db, "android");
  const code = "sensitive-telegram-auth-code";
  const idToken = await signedIdToken(flow.row.nonce);
  const telegramFetch = successfulTelegramFetch(idToken);

  const response = await worker.fetch(
    new Request(`https://worker.test/auth/telegram/mobile/callback?state=${flow.state}&code=${code}`),
    oidcEnv(db, { TELEGRAM_FETCH: telegramFetch.fetcher }),
  );

  assert.equal(response.status, 302);
  const location = response.headers.get("Location");
  assert.match(location, /^salvo:\/\/open\/auth\/[A-Za-z0-9_-]{43}$/);
  const ticket = location.split("/").at(-1);
  const stored = db.queryOne("SELECT * FROM telegram_login_tickets WHERE ticket_hash = ?", await sha256Base64Url(ticket));
  assert.deepEqual(JSON.parse(stored.user_json), telegramUser());
  assert.equal(stored.expires_at, stored.created_at + 300);
  assert.equal(stored.consumed_at, null);
  assert.equal(db.serializedRows().includes(ticket), false);
  assert.notEqual(db.queryOne("SELECT consumed_at FROM telegram_oidc_flows").consumed_at, null);
  assert.deepEqual(telegramFetch.urls, ["https://oauth.telegram.org/token", jwksUri]);
  assert.equal(telegramFetch.requests[0].body.includes(code), true);
  assert.equal(telegramFetch.requests[0].headers.get("Authorization").includes(clientSecret), false);
});

test("Telegram OIDC callback atomically consumes a flow exactly once", async (t) => {
  const db = memoryD1(t);
  const flow = await startFlow(db, "web");
  const idToken = await signedIdToken(flow.row.nonce);
  const telegramFetch = successfulTelegramFetch(idToken);
  const url = `https://worker.test/auth/telegram/mobile/callback?state=${flow.state}&code=one-use-code`;

  const responses = await Promise.all([
    worker.fetch(new Request(url), oidcEnv(db, { TELEGRAM_FETCH: telegramFetch.fetcher })),
    worker.fetch(new Request(url), oidcEnv(db, { TELEGRAM_FETCH: telegramFetch.fetcher })),
  ]);
  const locations = responses.map((response) => response.headers.get("Location"));

  assert.equal(locations.filter((location) => location.startsWith(`${canonicalWebTarget}?auth_ticket=`)).length, 1);
  assert.equal(locations.filter((location) => location === `${canonicalWebTarget}?auth_error=telegram`).length, 1);
  assert.equal(telegramFetch.urls.filter((urlValue) => urlValue === "https://oauth.telegram.org/token").length, 1);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets").count, 1);
});

test("Telegram OIDC callback denial and provider failures use fixed redacted redirects", async (t) => {
  const db = memoryD1(t);
  const denied = await startFlow(db, "ios");
  const providerPayload = "provider_denied_sensitive_payload";
  const denial = await worker.fetch(
    new Request(
      `https://worker.test/auth/telegram/mobile/callback?state=${denied.state}&error=access_denied&error_description=${providerPayload}`,
    ),
    oidcEnv(db, {
      TELEGRAM_FETCH: async () => {
        throw new Error("provider must not be called for denial");
      },
    }),
  );
  assert.equal(denial.status, 302);
  assert.equal(denial.headers.get("Location"), "salvo://open/auth/error");
  assertRedacted(denial.headers.get("Location"), [providerPayload, denied.state, clientSecret]);

  const failed = await startFlow(db, "web");
  const code = "failed-sensitive-code";
  const leakedIdToken = "sensitive.id.token";
  const failure = await worker.fetch(
    new Request(`https://worker.test/auth/telegram/mobile/callback?state=${failed.state}&code=${code}`),
    oidcEnv(db, {
      TELEGRAM_FETCH: async () =>
        new Response(JSON.stringify({ error: providerPayload, id_token: leakedIdToken }), { status: 401 }),
    }),
  );
  assert.equal(failure.status, 302);
  assert.equal(failure.headers.get("Location"), `${canonicalWebTarget}?auth_error=telegram`);
  assertRedacted(failure.headers.get("Location"), [providerPayload, failed.state, code, leakedIdToken, clientSecret]);
});

test("Telegram OIDC callback rejects expired, missing, and malformed flow inputs generically", async (t) => {
  const db = memoryD1(t);
  const expired = await startFlow(db, "android");
  db.execute("UPDATE telegram_oidc_flows SET expires_at = ?", epochSeconds() - 1);
  const sensitiveCode = "callback-secret-code";

  const missingCode = await startFlow(db, "web");
  const missingCodeResponse = await worker.fetch(
    new Request(`https://worker.test/auth/telegram/mobile/callback?state=${missingCode.state}`),
    oidcEnv(db),
  );
  assert.equal(missingCodeResponse.status, 302);
  assert.equal(missingCodeResponse.headers.get("Location"), `${canonicalWebTarget}?auth_error=telegram`);
  assertRedacted(missingCodeResponse.headers.get("Location"), [missingCode.state, clientSecret]);

  const oversizedCode = await startFlow(db, "ios");
  const oversizedCodeValue = "x".repeat(4_097);
  const oversizedCodeResponse = await worker.fetch(
    new Request(
      `https://worker.test/auth/telegram/mobile/callback?state=${oversizedCode.state}&code=${oversizedCodeValue}`,
    ),
    oidcEnv(db),
  );
  assert.equal(oversizedCodeResponse.status, 302);
  assert.equal(oversizedCodeResponse.headers.get("Location"), "salvo://open/auth/error");
  assertRedacted(oversizedCodeResponse.headers.get("Location"), [oversizedCode.state, oversizedCodeValue, clientSecret]);

  const cases = [
    `/auth/telegram/mobile/callback?state=${expired.state}&code=${sensitiveCode}`,
    `/auth/telegram/mobile/callback?state=malformed.state&code=${sensitiveCode}`,
    `/auth/telegram/mobile/callback?code=${sensitiveCode}`,
    `/auth/telegram/mobile/callback?state=${"a".repeat(43)}`,
  ];

  for (const path of cases) {
    const response = await worker.fetch(new Request(`https://worker.test${path}`), oidcEnv(db));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), `${canonicalWebTarget}?auth_error=telegram`);
    assertRedacted(response.headers.get("Location"), [expired.state, sensitiveCode, clientSecret]);
  }
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets").count, 0);
});

test("Telegram OIDC redeem rejects unavailable storage and corrupt stored identities generically", async (t) => {
  const ticket = base64Url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const unavailable = await postJson("/auth/telegram/mobile/redeem", { ticket }, {});
  const unavailableBody = await unavailable.text();
  assert.equal(unavailable.status, 401);
  assert.deepEqual(JSON.parse(unavailableBody), { error: "Telegram authentication failed" });
  assertRedacted(unavailableBody, [ticket]);

  const db = memoryD1(t);
  const identitySecret = "corrupt-stored-identity";
  const now = epochSeconds();
  db.execute(
    `INSERT INTO telegram_login_tickets
      (ticket_hash, user_json, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, NULL)`,
    await sha256Base64Url(ticket),
    JSON.stringify({ ...telegramUser(), id: "", identitySecret }),
    now,
    now + 300,
  );

  const corrupt = await postJson("/auth/telegram/mobile/redeem", { ticket }, oidcEnv(db));
  const corruptBody = await corrupt.text();
  assert.equal(corrupt.status, 401);
  assert.deepEqual(JSON.parse(corruptBody), { error: "Telegram authentication failed" });
  assertRedacted(corruptBody, [ticket, identitySecret, clientSecret]);
  assert.notEqual(
    db.queryOne("SELECT consumed_at FROM telegram_login_tickets WHERE ticket_hash = ?", await sha256Base64Url(ticket))
      .consumed_at,
    null,
  );
});

test("Telegram OIDC redeem returns a hashed opaque session and consumes the ticket once", async (t) => {
  const db = memoryD1(t);
  const ticket = await successfulCallbackTicket(db, "web");
  const ctx = waitUntilContext();
  seedExpiredFlowsAndTickets(db, 102, "redeem-cleanup");

  const response = await postJson("/auth/telegram/mobile/redeem", { ticket }, oidcEnv(db), ctx);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.user, telegramUser());
  assert.match(payload.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(payload.token.includes(ticket), false);
  const storedSession = db.queryOne("SELECT * FROM auth_sessions WHERE token_hash = ?", await sha256Base64Url(payload.token));
  assert.equal(storedSession.user_key, "telegram:42");
  assert.equal(db.serializedRows().includes(payload.token), false);

  const me = await worker.fetch(
    new Request("https://worker.test/auth/me", { headers: { Authorization: `Bearer ${payload.token}` } }),
    oidcEnv(db),
  );
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { user: telegramUser() });
  assert.notEqual(
    db.queryOne("SELECT consumed_at FROM telegram_login_tickets WHERE ticket_hash = ?", await sha256Base64Url(ticket))
      .consumed_at,
    null,
  );
  assert.equal(ctx.promises.length, 1);
  await Promise.all(ctx.promises);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_oidc_flows WHERE expires_at <= ?", epochSeconds()).count, 2);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets WHERE expires_at <= ?", epochSeconds()).count, 2);

  const replay = await postJson("/auth/telegram/mobile/redeem", { ticket }, oidcEnv(db));
  assert.equal(replay.status, 401);
  const replayBody = await replay.text();
  assert.deepEqual(JSON.parse(replayBody), { error: "Telegram authentication failed" });
  assertRedacted(replayBody, [ticket, clientSecret]);
});

test("Telegram OIDC redeem atomically consumes concurrent requests", async (t) => {
  const db = memoryD1(t);
  const ticket = await successfulCallbackTicket(db, "android");

  const responses = await Promise.all([
    postJson("/auth/telegram/mobile/redeem", { ticket }, oidcEnv(db)),
    postJson("/auth/telegram/mobile/redeem", { ticket }, oidcEnv(db)),
  ]);

  assert.deepEqual(
    responses.map(({ status }) => status).sort((first, second) => first - second),
    [200, 401],
  );
});

test("Telegram OIDC redeem rejects expiry and malformed bodies with generic redacted errors", async (t) => {
  const db = memoryD1(t);
  const expiredTicket = await successfulCallbackTicket(db, "web");
  db.execute(
    "UPDATE telegram_login_tickets SET expires_at = ? WHERE ticket_hash = ?",
    epochSeconds() - 1,
    await sha256Base64Url(expiredTicket),
  );
  const unknownTicket = base64Url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
  const cases = [
    { ticket: expiredTicket },
    { ticket: unknownTicket },
    { ticket: "malformed.ticket" },
    { ticket: "short" },
    {},
    { ticket: unknownTicket, returnUrl: "https://attacker.test" },
  ];

  for (const body of cases) {
    const response = await postJson("/auth/telegram/mobile/redeem", body, oidcEnv(db));
    assert.equal(response.status, 401, JSON.stringify(body));
    const responseBody = await response.text();
    assert.deepEqual(JSON.parse(responseBody), { error: "Telegram authentication failed" });
    assertRedacted(responseBody, [expiredTicket, unknownTicket, clientSecret]);
  }
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

  execute(sql, ...params) {
    return this.database.prepare(sql).run(...params);
  }

  queryOne(sql, ...params) {
    return this.database.prepare(sql).get(...params) ?? null;
  }

  serializedRows() {
    return JSON.stringify({
      flows: this.database.prepare("SELECT * FROM telegram_oidc_flows ORDER BY state_hash").all(),
      tickets: this.database.prepare("SELECT * FROM telegram_login_tickets ORDER BY ticket_hash").all(),
      sessions: this.database.prepare("SELECT * FROM auth_sessions ORDER BY token_hash").all(),
    });
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

function oidcEnv(db, overrides = {}) {
  return {
    DB: db,
    TELEGRAM_CLIENT_ID: clientId,
    TELEGRAM_CLIENT_SECRET: clientSecret,
    ...overrides,
  };
}

async function postJson(path, body, env, ctx) {
  return worker.fetch(
    new Request(`https://worker.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

function waitUntilContext() {
  return {
    promises: [],
    waitUntil(promise) {
      this.promises.push(promise);
    },
  };
}

async function startFlow(db, platform) {
  const response = await postJson("/auth/telegram/mobile/start", { platform }, oidcEnv(db));
  assert.equal(response.status, 200);
  const authorization = new URL((await response.json()).authorizationUrl);
  const state = authorization.searchParams.get("state");
  return {
    state,
    row: db.queryOne("SELECT * FROM telegram_oidc_flows WHERE state_hash = ?", await sha256Base64Url(state)),
  };
}

async function successfulCallbackTicket(db, platform) {
  const flow = await startFlow(db, platform);
  const idToken = await signedIdToken(flow.row.nonce);
  const telegramFetch = successfulTelegramFetch(idToken);
  const response = await worker.fetch(
    new Request(`https://worker.test/auth/telegram/mobile/callback?state=${flow.state}&code=valid-callback-code`),
    oidcEnv(db, { TELEGRAM_FETCH: telegramFetch.fetcher }),
  );
  assert.equal(response.status, 302);
  const location = response.headers.get("Location");
  return platform === "web" ? new URL(location).searchParams.get("auth_ticket") : location.split("/").at(-1);
}

function successfulTelegramFetch(idToken) {
  const urls = [];
  const requests = [];
  return {
    urls,
    requests,
    fetcher: async (input, init = {}) => {
      const url = String(input);
      urls.push(url);
      requests.push({ url, ...init, headers: new Headers(init.headers) });
      if (url === "https://oauth.telegram.org/token") {
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === jwksUri) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
        });
      }
      throw new Error(`Unexpected Telegram URL: ${url}`);
    },
  };
}

async function signedIdToken(nonce, overrides = {}) {
  const now = epochSeconds();
  const header = base64UrlJson({ alg: "RS256", typ: "JWT", kid: keyId });
  const claims = base64UrlJson({
    iss: "https://oauth.telegram.org",
    aud: clientId,
    sub: "telegram-oidc-subject-42",
    id: "42",
    name: "Captain Test",
    preferred_username: "captain",
    picture: "https://example.test/captain.jpg",
    nonce,
    iat: now,
    exp: now + 120,
    ...overrides,
  });
  const signature = await cryptoApi.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    signingKeys.privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
}

function telegramUser() {
  return {
    provider: "telegram",
    id: "42",
    name: "Captain Test",
    username: "captain",
    photoUrl: "https://example.test/captain.jpg",
  };
}

function seedExpiredFlowsAndTickets(db, count, prefix = "start-cleanup") {
  const now = epochSeconds();
  for (let index = 0; index < count; index += 1) {
    db.execute(
      `INSERT INTO telegram_oidc_flows
        (state_hash, nonce, code_verifier, platform, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `${prefix}-flow-${index}`,
      `nonce-${index}`,
      `verifier-${index}`,
      "web",
      now - 1_000,
      now - index - 1,
      now - 500,
    );
    db.execute(
      `INSERT INTO telegram_login_tickets
        (ticket_hash, user_json, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?)`,
      `${prefix}-ticket-${index}`,
      JSON.stringify(telegramUser()),
      now - 1_000,
      now - index - 1,
      now - 500,
    );
  }
}

async function sha256Base64Url(value) {
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64UrlJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function epochSeconds() {
  return Math.floor(Date.now() / 1_000);
}

function assertRedacted(value, secrets) {
  for (const secret of secrets) {
    assert.equal(value.includes(secret), false, `response leaked ${secret}`);
  }
}
