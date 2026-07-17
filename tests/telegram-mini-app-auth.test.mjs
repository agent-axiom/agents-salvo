import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { verifyTelegramMiniAppInitData } from "../worker/telegram-mini-app-auth.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const textEncoder = new TextEncoder();
const authErrorMessage = "Telegram Mini App authentication failed";
const botToken = "123456:test-bot-token";
const now = 1784232120;

function telegramUser(overrides = {}) {
  return {
    id: 8710001168,
    first_name: "Dima",
    last_name: "Kosarevsky",
    username: "agent_axiom",
    language_code: "ru",
    photo_url: "https://t.me/i/userpic/320/avatar.jpg",
    ...overrides,
  };
}

function launchFields(overrides = {}) {
  return {
    auth_date: "1784232000",
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    start_param: "room_ABCD",
    user: JSON.stringify(telegramUser()),
    ...overrides,
  };
}

test("Mini App initData verifies and normalizes the Telegram user", async () => {
  const initData = await signInitData(launchFields(), botToken);

  assert.deepEqual(
    await verifyTelegramMiniAppInitData(initData, botToken, {
      now: 1784232120,
      maxAgeSeconds: 300,
      maxFutureSeconds: 60,
    }),
    {
      user: {
        provider: "telegram",
        id: "8710001168",
        name: "Dima Kosarevsky",
        username: "agent_axiom",
        photoUrl: "https://t.me/i/userpic/320/avatar.jpg",
      },
      languageCode: "ru",
      startParam: "room_ABCD",
    },
  );
});

test("Mini App initData verifies decoded query values", async () => {
  const initData = await signInitData(
    launchFields({
      start_param: "room A+B",
      user: JSON.stringify(telegramUser({ first_name: "Dima Ivan" })),
    }),
    botToken,
  );

  const result = await verifyTelegramMiniAppInitData(initData, botToken, { now });

  assert.equal(result.user.name, "Dima Ivan Kosarevsky");
  assert.equal(result.startParam, "room A+B");
});

test("Mini App initData includes the optional signature in the bot-token HMAC", async () => {
  const initData = await signInitData(
    launchFields({ signature: "telegram-third-party-signature" }),
    botToken,
  );

  const result = await verifyTelegramMiniAppInitData(initData, botToken, { now });

  assert.equal(result.user.id, "8710001168");
});

test("Mini App initData rejects tampering", async () => {
  const initData = await signInitData(launchFields(), botToken);

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData.replace("Dima", "Mallory"), botToken, { now }));
});

test("Mini App initData rejects duplicate fields even when they are signed", async () => {
  const initData = await signInitDataEntries(
    [...Object.entries(launchFields()), ["auth_date", "1784232000"]],
    botToken,
  );

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
});

test("Mini App initData rejects unknown top-level fields even when they are signed", async () => {
  const initData = await signInitData({ ...launchFields(), unexpected: "value" }, botToken);

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
});

test("Mini App initData rejects malformed percent encoding before parsing", async () => {
  const entries = Object.entries(launchFields({ user: "%ZZ" }));
  const initData = await signInitDataEntries(entries, botToken, { user: "%ZZ" });

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
});

test("Mini App initData rejects missing configuration and required fields", async () => {
  const valid = await signInitData(launchFields(), botToken);
  await assertAuthFailure(() => verifyTelegramMiniAppInitData(valid, "", { now }));

  for (const requiredField of ["auth_date", "user"]) {
    const fields = launchFields();
    delete fields[requiredField];
    const initData = await signInitData(fields, botToken);
    await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
  }

  await assertAuthFailure(() =>
    verifyTelegramMiniAppInitData(valid.replace(/&hash=[a-f0-9]+$/, ""), botToken, { now }),
  );
});

test("Mini App initData rejects empty and oversized input", async () => {
  await assertAuthFailure(() => verifyTelegramMiniAppInitData("", botToken, { now }));

  const initData = await signInitData(launchFields({ start_param: "x".repeat(16 * 1024) }), botToken);
  assert.ok(textEncoder.encode(initData).byteLength > 16 * 1024);
  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
});

test("Mini App initData rejects stale and future auth dates", async () => {
  for (const authDate of [String(now - 301), String(now + 61)]) {
    const initData = await signInitData(launchFields({ auth_date: authDate }), botToken);
    await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
  }
});

test("Mini App initData rejects malformed auth dates and hashes", async () => {
  for (const authDate of ["", "1e9", "1784232000.5", "-1784232000"]) {
    const initData = await signInitData(launchFields({ auth_date: authDate }), botToken);
    await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
  }

  const valid = await signInitData(launchFields(), botToken);
  for (const hash of ["not-hex", "A".repeat(64), "g".repeat(64)]) {
    await assertAuthFailure(() =>
      verifyTelegramMiniAppInitData(valid.replace(/hash=[a-f0-9]+/, `hash=${hash}`), botToken, { now }),
    );
  }
});

test("Mini App initData rejects malformed user JSON without leaking launch data", async () => {
  const rawUser = "TOP_SECRET_INIT_DATA";
  const initData = await signInitData(launchFields({ user: rawUser }), botToken);

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }), rawUser);
});

test("Mini App initData rejects invalid, unsafe, and bot users", async () => {
  const invalidUsers = [
    telegramUser({ id: 0 }),
    telegramUser({ id: -1 }),
    telegramUser({ id: 1.5 }),
    telegramUser({ id: "8710001168" }),
    telegramUser({ id: 2 ** 52 }),
    telegramUser({ is_bot: true }),
    telegramUser({ is_bot: "false" }),
    null,
    [],
  ];

  for (const user of invalidUsers) {
    const initData = await signInitData(launchFields({ user: JSON.stringify(user) }), botToken);
    await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
  }
});

test("Mini App initData accepts the inclusive 52-bit Telegram ID ceiling", async () => {
  const initData = await signInitData(
    launchFields({ user: JSON.stringify(telegramUser({ id: 2 ** 52 - 1 })) }),
    botToken,
  );

  const result = await verifyTelegramMiniAppInitData(initData, botToken, { now });

  assert.equal(result.user.id, "4503599627370495");
});

test("Mini App initData rejects invalid and overlong user strings", async () => {
  const invalidUsers = [
    telegramUser({ first_name: "x".repeat(129) }),
    telegramUser({ username: "x".repeat(65) }),
    telegramUser({ language_code: "x".repeat(36) }),
    telegramUser({ photo_url: `https://example.com/${"x".repeat(2030)}` }),
    telegramUser({ photo_url: "http://example.com/avatar.jpg" }),
    telegramUser({ photo_url: "javascript:alert(1)" }),
    telegramUser({ first_name: 42 }),
    telegramUser({ username: { value: "agent_axiom" } }),
    telegramUser({ language_code: ["ru"] }),
    telegramUser({ photo_url: null }),
  ];

  for (const user of invalidUsers) {
    const initData = await signInitData(launchFields({ user: JSON.stringify(user) }), botToken);
    await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
  }
});

test("Mini App initData rejects an overlong start parameter", async () => {
  const initData = await signInitData(launchFields({ start_param: "x".repeat(513) }), botToken);

  await assertAuthFailure(() => verifyTelegramMiniAppInitData(initData, botToken, { now }));
});

async function signInitData(fields, botToken) {
  return signInitDataEntries(Object.entries(fields), botToken);
}

async function signInitDataEntries(entries, botToken, rawValues = {}) {
  const dataCheckString = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(textEncoder.encode("WebAppData"), botToken);
  const hash = bytesToHex(await hmac(secret, dataCheckString));
  const encodedFields = entries.map(([key, value]) => {
    const encodedValue = Object.hasOwn(rawValues, key) ? rawValues[key] : encodeURIComponent(value);
    return `${encodeURIComponent(key)}=${encodedValue}`;
  });
  return [...encodedFields, `hash=${hash}`].join("&");
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

async function assertAuthFailure(operation, forbiddenText = "") {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.message, authErrorMessage);
    if (forbiddenText) {
      assert.equal(error.message.includes(forbiddenText), false);
    }
    return true;
  });
}
