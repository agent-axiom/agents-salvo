import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  TELEGRAM_STARS_WEBHOOK_URL,
  runTelegramStarsWebhookCli,
} from "../scripts/configure-telegram-stars-webhook.mjs";

const botToken = "123456789:telegram_test_token";
const webhookSecret = "webhook_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function captureOutput() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
        return true;
      },
    },
    read() {
      return value;
    },
  };
}

function webhookInfo(url = TELEGRAM_STARS_WEBHOOK_URL) {
  return {
    ok: true,
    result: {
      url,
      has_custom_certificate: false,
      pending_update_count: 0,
    },
  };
}

test("set registers the exact Stars webhook contract and verifies it", async () => {
  const calls = [];
  const stdout = captureOutput();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? jsonResponse({ ok: true, result: true })
      : jsonResponse(webhookInfo());
  };

  await runTelegramStarsWebhookCli({
    argv: ["set"],
    env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
    fetchImpl,
    stdout: stdout.stream,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${botToken}/setWebhook`);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    url: TELEGRAM_STARS_WEBHOOK_URL,
    secret_token: webhookSecret,
    allowed_updates: ["message", "pre_checkout_query"],
    drop_pending_updates: false,
  });
  assert.equal(calls[1].url, `https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body, undefined);
  assert.match(stdout.read(), new RegExp(TELEGRAM_STARS_WEBHOOK_URL.replaceAll(".", "\\.")));
  assert.equal(stdout.read().includes(botToken), false);
  assert.equal(stdout.read().includes(webhookSecret), false);
});

test("check only reads webhook info and verifies the exact public URL", async () => {
  const calls = [];
  const stdout = captureOutput();
  await runTelegramStarsWebhookCli({
    argv: ["check"],
    env: { TELEGRAM_BOT_TOKEN: botToken },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(webhookInfo());
    },
    stdout: stdout.stream,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.equal(calls[0].options.body, undefined);
  assert.equal(stdout.read(), `Telegram Stars webhook verified: ${TELEGRAM_STARS_WEBHOOK_URL}\n`);
});

test("set and check reject unknown commands and extra arguments before network access", async () => {
  let calls = 0;
  const options = {
    env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(webhookInfo());
    },
  };
  for (const argv of [[], ["unknown"], ["set", "extra"], ["check", "extra"]]) {
    await assert.rejects(() => runTelegramStarsWebhookCli({ ...options, argv }), /command failed/i);
  }
  assert.equal(calls, 0);
});

test("commands strictly validate required environment values", async () => {
  const fetchImpl = async () => {
    throw new Error("network must not be reached");
  };
  const invalidTokens = [undefined, "", "  ", "0:token", "123:token with spaces", new String(botToken)];
  for (const TELEGRAM_BOT_TOKEN of invalidTokens) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({ argv: ["check"], env: { TELEGRAM_BOT_TOKEN }, fetchImpl }),
      /command failed/i,
    );
  }

  const invalidSecrets = [
    undefined,
    "",
    "A".repeat(31),
    "A".repeat(257),
    `${"A".repeat(31)}:`,
    new String(webhookSecret),
  ];
  for (const TELEGRAM_WEBHOOK_SECRET of invalidSecrets) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["set"],
        env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET },
        fetchImpl,
      }),
      /command failed/i,
    );
  }
});

test("the webhook URL must be the canonical public HTTPS Worker endpoint", async () => {
  const invalidUrls = [
    "://not-a-url",
    "http://agents-salvo-room.if-ab6.workers.dev/telegram/webhook",
    "https://localhost/telegram/webhook",
    "https://127.0.0.1/telegram/webhook",
    "https://user:pass@agents-salvo-room.if-ab6.workers.dev/telegram/webhook",
    "https://agents-salvo-room.if-ab6.workers.dev:8443/telegram/webhook",
    "https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook?debug=1",
    "https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook#fragment",
    "https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook/",
    "https://example.com/telegram/webhook",
  ];
  for (const webhookUrl of invalidUrls) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["check"],
        env: { TELEGRAM_BOT_TOKEN: botToken },
        webhookUrl,
        fetchImpl: async () => jsonResponse(webhookInfo()),
      }),
      /command failed/i,
    );
  }
});

test("invalid top-level options and bounded limits fail before network access", async () => {
  for (const options of [
    null,
    { argv: "check" },
    { argv: ["check"], env: null },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, fetchImpl: null },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, stdout: null },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, timeoutMs: 0 },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, timeoutMs: 60_001 },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, maxResponseBytes: 0 },
    { argv: ["check"], env: { TELEGRAM_BOT_TOKEN: botToken }, maxResponseBytes: 1024 * 1024 + 1 },
  ]) {
    await assert.rejects(() => runTelegramStarsWebhookCli(options), /command failed/i);
  }
});

test("a mismatched, absent, or non-string webhook URL fails closed", async () => {
  for (const result of [
    { url: "https://example.com/telegram/webhook" },
    { url: "" },
    {},
    { url: { value: TELEGRAM_STARS_WEBHOOK_URL } },
  ]) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["check"],
        env: { TELEGRAM_BOT_TOKEN: botToken },
        fetchImpl: async () => jsonResponse({ ok: true, result }),
        stdout: captureOutput().stream,
      }),
      /command failed/i,
    );
  }
});

test("webhook checks fail closed when Telegram reports a delivery error", async () => {
  const providerSecret = "private delivery failure";
  for (const result of [
    {
      url: TELEGRAM_STARS_WEBHOOK_URL,
      last_error_date: 1_784_500_000,
      last_error_message: providerSecret,
    },
    { url: TELEGRAM_STARS_WEBHOOK_URL, last_error_message: providerSecret },
  ]) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["check"],
        env: { TELEGRAM_BOT_TOKEN: botToken },
        fetchImpl: async () => jsonResponse({ ok: true, result }),
      }),
      (error) => {
        assert.equal(error.message, "Telegram Stars webhook command failed");
        assert.equal(String(error).includes(providerSecret), false);
        return true;
      },
    );
  }
});

test("Telegram failures are generic and never expose credentials or provider bodies", async () => {
  const providerBody = `provider says ${botToken} ${webhookSecret}`;
  const stdout = captureOutput();
  for (const response of [
    jsonResponse({ ok: false, description: providerBody }, { status: 401 }),
    new Response(providerBody, { status: 502 }),
    new Response("{", { status: 200 }),
    jsonResponse({ ok: false, result: true }),
  ]) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["set"],
        env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
        fetchImpl: async () => response,
        stdout: stdout.stream,
      }),
      (error) => {
        assert.equal(error.message, "Telegram Stars webhook command failed");
        assert.equal(error.message.includes(botToken), false);
        assert.equal(error.message.includes(webhookSecret), false);
        assert.equal(error.message.includes(providerBody), false);
        return true;
      },
    );
  }
  assert.equal(stdout.read(), "");
});

test("transport errors and timeout failures are redacted", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error(`${botToken} ${webhookSecret}`);
    },
    async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["set"],
        env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
        fetchImpl,
        timeoutMs: 1,
      }),
      (error) => {
        assert.equal(error.message, "Telegram Stars webhook command failed");
        assert.equal(error.message.includes(botToken), false);
        assert.equal(error.message.includes(webhookSecret), false);
        return true;
      },
    );
  }
});

test("request watchdog settles even when an injected fetch ignores abort", async () => {
  const result = await Promise.race([
    runTelegramStarsWebhookCli({
      argv: ["check"],
      env: { TELEGRAM_BOT_TOKEN: botToken },
      fetchImpl: async () => new Promise(() => {}),
      timeoutMs: 1,
    }).then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "hung" }), 50)),
  ]);

  assert.equal(result.kind, "rejected");
  assert.equal(result.error.message, "Telegram Stars webhook command failed");
});

test("response reads are bounded by Content-Length and streaming bytes", async () => {
  let cancelled = 0;
  const oversizedStream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(65));
    },
    cancel() {
      cancelled += 1;
    },
  });
  const responses = [
    new Response("{}", { status: 200, headers: { "Content-Length": "65" } }),
    new Response("{}", { status: 200, headers: { "Content-Length": "invalid" } }),
    new Response(oversizedStream, { status: 200 }),
  ];

  for (const response of responses) {
    await assert.rejects(
      () => runTelegramStarsWebhookCli({
        argv: ["check"],
        env: { TELEGRAM_BOT_TOKEN: botToken },
        fetchImpl: async () => response,
        maxResponseBytes: 64,
      }),
      /command failed/i,
    );
  }
  assert.equal(cancelled, 1);
});

test("malformed response objects and stream chunks fail closed", async () => {
  const validPayload = JSON.stringify(webhookInfo());
  const fakeResponse = (overrides = {}) => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: null,
    text: async () => validPayload,
    ...overrides,
  });
  const run = (response) => runTelegramStarsWebhookCli({
    argv: ["check"],
    env: { TELEGRAM_BOT_TOKEN: botToken },
    fetchImpl: async () => response,
    stdout: captureOutput().stream,
    maxResponseBytes: 1024,
  });

  await assert.rejects(() => run(null), /command failed/i);
  await assert.doesNotReject(() => run(fakeResponse({ ok: undefined })));
  await assert.rejects(() => run(fakeResponse({ status: undefined, ok: undefined })), /command failed/i);
  await assert.rejects(() => run(fakeResponse({ text: undefined })), /command failed/i);
  await assert.rejects(() => run(fakeResponse({ text: async () => 123 })), /command failed/i);
  await assert.rejects(
    () => run(fakeResponse({ text: async () => "x".repeat(1025) })),
    /command failed/i,
  );

  for (const chunk of [null, { done: "no" }, { done: false, value: "not-bytes" }]) {
    const reader = {
      async read() {
        return chunk;
      },
      releaseLock() {},
    };
    await assert.rejects(
      () => run(fakeResponse({ body: { getReader: () => reader } })),
      /command failed/i,
    );
  }

  const overflowReader = {
    async read() {
      return { done: false, value: new Uint8Array(1025) };
    },
    async cancel() {
      throw new Error("cancel failure must be redacted");
    },
    releaseLock() {},
  };
  await assert.rejects(
    () => run(fakeResponse({ body: { getReader: () => overflowReader } })),
    /command failed/i,
  );

  await assert.rejects(
    () => run(fakeResponse({
      status: 500,
      ok: false,
      body: { async cancel() { throw new Error("cancel failure must be redacted"); } },
    })),
    /command failed/i,
  );
});

test("set rejects a non-true Telegram result", async () => {
  await assert.rejects(
    () => runTelegramStarsWebhookCli({
      argv: ["set"],
      env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
      fetchImpl: async () => jsonResponse({ ok: true, result: false }),
    }),
    /command failed/i,
  );
});

test("CLI main fails with one generic line and no credentials", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/configure-telegram-stars-webhook.mjs"), "set"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: botToken,
        TELEGRAM_WEBHOOK_SECRET: "invalid secret",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Telegram Stars webhook command failed\n");
  assert.equal(result.stderr.includes(botToken), false);
});

test("success output contains only the public URL", async () => {
  const stdout = captureOutput();
  await runTelegramStarsWebhookCli({
    argv: ["set"],
    env: { TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_WEBHOOK_SECRET: webhookSecret },
    fetchImpl: async (url) => url.endsWith("/setWebhook")
      ? jsonResponse({ ok: true, result: true })
      : jsonResponse(webhookInfo()),
    stdout: stdout.stream,
  });
  assert.equal(stdout.read(), `Telegram Stars webhook verified: ${TELEGRAM_STARS_WEBHOOK_URL}\n`);
});

test("webhook commands remain explicit and are not coupled to build, test, or deploy", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const scriptNames = ["telegram:stars:webhook:set", "telegram:stars:webhook:check"];
  for (const name of scriptNames) {
    assert.equal(typeof packageJson.scripts[name], "string");
  }
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (scriptNames.includes(name)) continue;
    assert.equal(command.includes("configure-telegram-stars-webhook"), false, `${name} must stay offline`);
    assert.equal(command.includes("telegram:stars:webhook"), false, `${name} must stay explicit`);
  }
});

test("all READMEs document ordered deployment, private refunds, and manual smoke testing", async () => {
  const orderedSteps = [
    "npx wrangler d1 migrations apply agents-salvo-profile --remote",
    "npx wrangler secret put TELEGRAM_WEBHOOK_SECRET",
    "npx wrangler deploy",
    "TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:stars:webhook:set",
    "npm run telegram:stars:webhook:check",
  ];
  for (const path of ["README.md", "README.ru.md", "README.zh-CN.md"]) {
    const readme = await readFile(path, "utf8");
    let previousIndex = -1;
    for (const step of orderedSteps) {
      const index = readme.indexOf(step, previousIndex + 1);
      assert.ok(index > previousIndex, `${path} must document ${step} in order`);
      previousIndex = index;
    }
    for (const required of [
      "refundStarPayment",
      "telegram_user_id",
      "telegram_payment_charge_id",
      "Stars",
    ]) {
      assert.ok(readme.includes(required), `${path} must document ${required}`);
    }
    assert.match(readme, /\b8\b/u, `${path} must document the 8-Star smoke test`);
  }

  const wrangler = await readFile("wrangler.toml", "utf8");
  assert.match(wrangler, /^# .*TELEGRAM_WEBHOOK_SECRET$/mu);
  assert.doesNotMatch(wrangler, /^\s*TELEGRAM_WEBHOOK_SECRET\s*=/mu);
});
