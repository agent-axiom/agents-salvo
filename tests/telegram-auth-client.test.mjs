import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramAuthClient } from "../src/telegram-auth.js";

const validTicket = "aB3_-".repeat(7);
const validUser = Object.freeze({
  provider: "telegram",
  id: "42",
  name: "Captain Test",
  username: "captain",
  photoUrl: "https://example.test/captain.jpg",
});

test("capability uses the exact config request and accepts both supported methods", async () => {
  for (const method of ["legacy", "oidc"]) {
    const requests = [];
    const client = createTelegramAuthClient({
      workerUrl: "https://worker.test/",
      async fetcher(input, init) {
        requests.push([input, init]);
        return jsonResponse({ method });
      },
    });

    assert.deepEqual(await client.capability(), { method });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "https://worker.test/auth/telegram/config");
    assert.deepEqual(requests[0][1], { method: "GET" });
  }
});

test("start posts only the selected platform as JSON", async () => {
  const requests = [];
  const authorizationUrl = "https://oauth.telegram.org/auth?client_id=123&state=safe";
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test/api/",
    async fetcher(input, init) {
      requests.push([input, init]);
      return jsonResponse({ authorizationUrl });
    },
  });

  assert.deepEqual(await client.start("android"), { authorizationUrl });
  assert.equal(requests[0][0], "https://worker.test/api/auth/telegram/mobile/start");
  assert.deepEqual(requests[0][1], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"platform":"android"}',
  });
});

test("redeem posts only the ticket and validates the public session result", async () => {
  const requests = [];
  const payload = { token: "opaque_session-token_123", user: validUser };
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    async fetcher(input, init) {
      requests.push([input, init]);
      return jsonResponse(payload);
    },
  });

  assert.deepEqual(await client.redeem(validTicket), payload);
  assert.equal(requests[0][0], "https://worker.test/auth/telegram/mobile/redeem");
  assert.deepEqual(requests[0][1], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: validTicket }),
  });
});

test("constructor rejects unsafe worker URLs and non-callable fetchers", () => {
  for (const workerUrl of [
    "",
    "worker.test",
    "http://worker.test",
    "https://user@worker.test",
    "https://@worker.test",
    "https://worker.test/?debug=1",
    "https://worker.test/?",
    "https://worker.test/#debug",
    "https://worker.test/#",
  ]) {
    assert.throws(() => createTelegramAuthClient({ workerUrl, fetcher: async () => {} }), {
      name: "TypeError",
    }, workerUrl);
  }
  assert.throws(() => createTelegramAuthClient({
    workerUrl: "https://worker.test",
    fetcher: null,
  }), { name: "TypeError" });
});

test("invalid platforms and tickets fail before fetch", async () => {
  let fetchCalls = 0;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });

  for (const platform of [undefined, null, "", "desktop", "ANDROID", 1, {}, ["web"]]) {
    await assert.rejects(client.start(platform), { name: "TypeError" });
  }
  for (const ticket of [
    undefined,
    null,
    "",
    "a".repeat(31),
    "a".repeat(257),
    `${"a".repeat(31)}!`,
    `${"a".repeat(32)}=`,
    ` ${"a".repeat(32)}`,
    42,
  ]) {
    await assert.rejects(client.redeem(ticket), { name: "TypeError" });
  }
  assert.equal(fetchCalls, 0);
});

test("capability rejects malformed methods and extra success fields", async () => {
  for (const payload of [
    { method: "OIDC" },
    { method: "unknown" },
    { method: "oidc", detail: "provider-secret" },
    null,
    [],
  ]) {
    const error = await rejectionFrom("capability", payload);
    assert.equal(error.status, 200);
    assertRedacted(error, "provider-secret");
  }
});

test("start accepts only an exact Telegram authorization endpoint", async () => {
  for (const authorizationUrl of [
    "http://oauth.telegram.org/auth?state=safe",
    "https://oauth.telegram.org.evil.test/auth?state=safe",
    "https://user@oauth.telegram.org/auth?state=safe",
    "https://@oauth.telegram.org/auth?state=safe",
    "https://oauth.telegram.org/token?state=safe",
    "https://oauth.telegram.org/auth/extra?state=safe",
    "https://oauth.telegram.org/auth?state=safe#fragment-secret",
    "https://oauth.telegram.org/auth?state=safe#",
    "not a URL",
  ]) {
    const error = await rejectionFrom("start", { authorizationUrl });
    assert.equal(error.status, 200);
    assertRedacted(error, authorizationUrl);
  }

  const extra = await rejectionFrom("start", {
    authorizationUrl: "https://oauth.telegram.org/auth?state=safe",
    providerDetail: "provider-secret",
  });
  assert.equal(extra.status, 200);
  assertRedacted(extra, "provider-secret");
});

test("redeem rejects malformed tokens, users, and extra fields", async () => {
  const malformed = [
    { token: "", user: validUser },
    { token: "token.with.dots", user: validUser },
    { token: "opaque", user: null },
    { token: "opaque", user: { ...validUser, provider: "evil" } },
    { token: "opaque", user: { ...validUser, id: "" } },
    { token: "opaque", user: { ...validUser, name: 42 } },
    { token: "opaque", user: { ...validUser, username: "u".repeat(129) } },
    { token: "opaque", user: { ...validUser, privateClaim: "provider-secret" } },
    { token: "opaque", user: validUser, refreshToken: "refresh-secret" },
  ];

  for (const payload of malformed) {
    const error = await rejectionFrom("redeem", payload);
    assert.equal(error.status, 200);
    assertRedacted(error, "provider-secret");
    assertRedacted(error, "refresh-secret");
  }
});

test("HTTP, non-JSON, and oversized responses throw redacted status-bearing errors", async () => {
  const providerSecret = "sensitive-provider-description";
  const cases = [
    new Response(JSON.stringify({ error: providerSecret }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(`<html>${providerSecret}</html>`, {
      status: 502,
      headers: { "Content-Type": "text/html" },
    }),
    new Response(providerSecret, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ method: "oidc", padding: "x".repeat(20_000), providerSecret }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ];

  for (const response of cases) {
    const client = createTelegramAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => response,
    });
    const error = await rejected(client.capability());
    assert.equal(error.status, response.status);
    assertRedacted(error, providerSecret);
  }
});

test("network failures become stable generic errors and retain useful status", async () => {
  for (const sourceError of [
    new Error("socket failure with provider-secret"),
    Object.assign(new Error("upstream unavailable with provider-secret"), { status: 503 }),
  ]) {
    const client = createTelegramAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => {
        throw sourceError;
      },
    });
    const error = await rejected(client.capability());
    assert.equal(error.status, sourceError.status ?? 0);
    assert.equal(error.message, "Telegram authentication unavailable");
    assertRedacted(error, "provider-secret");
  }
});

async function rejectionFrom(method, payload) {
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    fetcher: async () => jsonResponse(payload),
  });
  if (method === "start") return rejected(client.start("ios"));
  if (method === "redeem") return rejected(client.redeem(validTicket));
  return rejected(client.capability());
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertRedacted(error, secret) {
  assert.equal(error instanceof Error, true);
  assert.equal(error.message.includes(secret), false);
  assert.equal(String(error).includes(secret), false);
}
