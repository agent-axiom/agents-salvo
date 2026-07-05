import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createSessionToken,
  parseBearerToken,
  publicUser,
  verifySessionToken,
  verifyTelegramLoginPayload,
} from "../worker/auth.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const textEncoder = new TextEncoder();

test("verifyTelegramLoginPayload accepts a signed Telegram payload", async () => {
  const botToken = "123456:secret-token";
  const payload = {
    id: "42",
    first_name: "Ivan",
    last_name: "Petrov",
    username: "ivan",
    photo_url: "https://t.me/i/userpic/320/ivan.jpg",
    auth_date: "1700000000",
  };
  payload.hash = await signTelegramPayload(payload, botToken);

  const user = await verifyTelegramLoginPayload(payload, botToken, {
    now: 1700000100,
    maxAgeSeconds: 86400,
  });

  assert.deepEqual(user, {
    provider: "telegram",
    id: "42",
    name: "Ivan Petrov",
    username: "ivan",
    photoUrl: "https://t.me/i/userpic/320/ivan.jpg",
  });
});

test("verifyTelegramLoginPayload rejects tampered Telegram payloads", async () => {
  const botToken = "123456:secret-token";
  const payload = {
    id: "42",
    first_name: "Ivan",
    auth_date: "1700000000",
  };
  payload.hash = await signTelegramPayload(payload, botToken);
  payload.first_name = "Mallory";

  await assert.rejects(
    () =>
      verifyTelegramLoginPayload(payload, botToken, {
        now: 1700000100,
        maxAgeSeconds: 86400,
      }),
    /Invalid Telegram signature/,
  );
});

test("verifyTelegramLoginPayload rejects stale Telegram payloads", async () => {
  const botToken = "123456:secret-token";
  const payload = {
    id: "42",
    first_name: "Ivan",
    auth_date: "1700000000",
  };
  payload.hash = await signTelegramPayload(payload, botToken);

  await assert.rejects(
    () =>
      verifyTelegramLoginPayload(payload, botToken, {
        now: 1700087000,
        maxAgeSeconds: 86400,
      }),
    /Telegram login expired/,
  );
});

test("verifyTelegramLoginPayload rejects missing and malformed payloads", async () => {
  await assert.rejects(() => verifyTelegramLoginPayload({}, "", { now: 1700000000 }), /bot token/);
  await assert.rejects(
    () => verifyTelegramLoginPayload(null, "123456:secret-token", { now: 1700000000 }),
    /payload is required/,
  );
  await assert.rejects(
    () => verifyTelegramLoginPayload({ id: "42" }, "123456:secret-token", { now: 1700000000 }),
    /payload is incomplete/,
  );
  await assert.rejects(
    () =>
      verifyTelegramLoginPayload(
        { id: "42", auth_date: "not-a-date", hash: "abc" },
        "123456:secret-token",
        { now: 1700000000 },
      ),
    /auth date is invalid/,
  );
});

test("session tokens round-trip signed user profiles and reject tampering", async () => {
  const secret = "session-secret";
  const user = {
    provider: "telegram",
    id: "42",
    name: "Ivan Petrov",
    username: "ivan",
    photoUrl: "",
  };

  const token = await createSessionToken(user, secret, { now: 1700000000, ttlSeconds: 3600 });
  assert.deepEqual(await verifySessionToken(token, secret, { now: 1700000500 }), user);

  const [encodedPayload, signature] = token.split(".");
  const sessionPayload = JSON.parse(base64UrlDecode(encodedPayload));
  sessionPayload.user.name = "Evil Petrov";
  const tampered = `${base64UrlEncode(JSON.stringify(sessionPayload))}.${signature}`;
  await assert.rejects(
    () => verifySessionToken(tampered, secret, { now: 1700000500 }),
    /Invalid session signature/,
  );
});

test("session tokens reject missing secrets, malformed payloads, and expiry", async () => {
  const secret = "session-secret";
  const user = {
    provider: "telegram",
    id: "42",
    name: "",
    username: "ivan",
    photoUrl: "",
  };

  await assert.rejects(() => createSessionToken(user, ""), /Session secret/);
  await assert.rejects(() => verifySessionToken("bad", secret), /Session token is invalid/);
  await assert.rejects(() => verifySessionToken("bad.payload", ""), /Session secret/);

  const expired = await createSessionToken(user, secret, { now: 1700000000, ttlSeconds: 1 });
  await assert.rejects(() => verifySessionToken(expired, secret, { now: 1700000002 }), /Session expired/);

  const invalidPayload = `${base64UrlEncode(JSON.stringify({ v: 999, user, exp: 1700009999 }))}.signature`;
  const signature = await signSessionPayloadForTest(invalidPayload.split(".")[0], secret);
  await assert.rejects(
    () => verifySessionToken(`${invalidPayload.split(".")[0]}.${signature}`, secret, { now: 1700000002 }),
    /Session token is invalid/,
  );
});

test("parseBearerToken and publicUser normalize optional auth data", () => {
  assert.equal(parseBearerToken(new Request("https://worker.test")), "");
  assert.equal(
    parseBearerToken(new Request("https://worker.test", { headers: { Authorization: "Bearer token-123" } })),
    "token-123",
  );
  assert.equal(publicUser(null), null);
  assert.deepEqual(publicUser({ provider: "telegram", id: 42 }), {
    provider: "telegram",
    id: "42",
    name: "",
    username: "",
    photoUrl: "",
  });
});

async function signTelegramPayload(payload, botToken) {
  const dataCheckString = Object.entries(payload)
    .filter(([key]) => key !== "hash")
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await cryptoApi.subtle.digest("SHA-256", textEncoder.encode(botToken));
  const key = await cryptoApi.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoApi.subtle.sign("HMAC", key, textEncoder.encode(dataCheckString));
  return bytesToHex(new Uint8Array(signature));
}

async function signSessionPayloadForTest(encodedPayload, secret) {
  const key = await cryptoApi.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoApi.subtle.sign("HMAC", key, textEncoder.encode(encodedPayload));
  return Buffer.from(signature).toString("base64url");
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
