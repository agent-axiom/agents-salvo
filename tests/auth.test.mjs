import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createSessionToken,
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

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}
