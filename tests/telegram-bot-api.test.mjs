import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramBotApiClient } from "../worker/telegram-bot-api.js";

const botToken = "123456789:telegram_bot-token";
const genericError = "Telegram Bot API request failed";

test("createInvoiceLink sends the exact Telegram Stars invoice request", async () => {
  const calls = [];
  const invoiceUrl = "https://t.me/$sample-invoice";
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: invoiceUrl });
    },
  });

  assert.equal(
    await client.createInvoiceLink({
      title: "Premium battle pass",
      description: "Unlock the premium campaign.",
      payload: "order_42",
      amount: 250,
    }),
    invoiceUrl,
  );

  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, `https://api.telegram.org/bot${botToken}/createInvoiceLink`);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.ok(init.signal instanceof AbortSignal);

  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    title: "Premium battle pass",
    description: "Unlock the premium campaign.",
    payload: "order_42",
    currency: "XTR",
    prices: [{ label: "Premium battle pass", amount: 250 }],
  });
  for (const field of [
    "provider_token",
    "provider_data",
    "max_tip_amount",
    "suggested_tip_amounts",
    "subscription_period",
    "need_name",
    "need_phone_number",
    "need_email",
    "need_shipping_address",
    "send_phone_number_to_provider",
    "send_email_to_provider",
    "is_flexible",
  ]) {
    assert.equal(Object.hasOwn(body, field), false, `${field} must be absent`);
  }
});

test("client rejects missing, blank, and oversized tokens and unsafe configuration", () => {
  const invalidConfigurations = [
    null,
    [],
    "configuration",
    {},
    { botToken: null },
    { botToken: "" },
    { botToken: " \t " },
    { botToken: "x".repeat(257) },
    { botToken, fetcher: 42 },
    { botToken, timeoutMs: 0 },
    { botToken, timeoutMs: -1 },
    { botToken, timeoutMs: 1.5 },
    { botToken, timeoutMs: Number.POSITIVE_INFINITY },
    { botToken, timeoutMs: 60_001 },
    { botToken, maxResponseBytes: 0 },
    { botToken, maxResponseBytes: -1 },
    { botToken, maxResponseBytes: 1.5 },
    { botToken, maxResponseBytes: Number.NaN },
    { botToken, maxResponseBytes: 1024 * 1024 + 1 },
  ];

  for (const configuration of invalidConfigurations) {
    assertGenericThrow(() => createTelegramBotApiClient(configuration));
  }
});

test("client rejects malformed or URL-altering bot tokens", () => {
  const unsafeTokens = [
    " 123456789:secret",
    "123456789:secret ",
    "123456789:sec ret",
    "123456789:sec\tret",
    "123456789:sec\nret",
    "123456789:sec/ret",
    "123456789:sec?ret",
    "123456789:sec#ret",
    "0:secret",
    "-123:secret",
    "0123:secret",
    "123:",
    ":secret",
    "123:secret:extra",
    `${"9".repeat(17)}:secret`,
    `123:${"a".repeat(129)}`,
  ];

  for (const unsafeToken of unsafeTokens) {
    assertGenericThrow(
      () => createTelegramBotApiClient({ botToken: unsafeToken }),
      [unsafeToken],
    );
  }
});

test("client redacts configuration getter failures", () => {
  const configurationSecret = "configuration-getter-secret";
  const configuration = {
    get botToken() {
      throw new Error(configurationSecret);
    },
  };

  assertGenericThrow(() => createTelegramBotApiClient(configuration), [configurationSecret]);
});

test("createInvoiceLink validates every field before making a request", async () => {
  let requests = 0;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => {
      requests += 1;
      throw new Error("invalid input reached Telegram");
    },
  });
  const validInvoice = {
    title: "Stars pack",
    description: "One pack of Telegram Stars.",
    payload: "stars_pack_1",
    amount: 100,
  };
  const invalidInvoices = [
    null,
    [],
    "invoice",
    { ...validInvoice, title: undefined },
    { ...validInvoice, title: null },
    { ...validInvoice, title: "" },
    { ...validInvoice, title: " \t " },
    { ...validInvoice, title: "x".repeat(33) },
    { ...validInvoice, description: undefined },
    { ...validInvoice, description: "" },
    { ...validInvoice, description: " \n " },
    { ...validInvoice, description: "x".repeat(256) },
    { ...validInvoice, payload: undefined },
    { ...validInvoice, payload: "" },
    { ...validInvoice, payload: 42 },
    { ...validInvoice, payload: "x".repeat(129) },
    { ...validInvoice, payload: "🚀".repeat(33) },
    { ...validInvoice, amount: undefined },
    { ...validInvoice, amount: 0 },
    { ...validInvoice, amount: -1 },
    { ...validInvoice, amount: 1.5 },
    { ...validInvoice, amount: 10_001 },
    { ...validInvoice, amount: Number.NaN },
    { ...validInvoice, amount: Number.MAX_SAFE_INTEGER + 1 },
    { ...validInvoice, label: null },
    { ...validInvoice, label: "" },
    { ...validInvoice, label: " \t " },
    { ...validInvoice, label: 42 },
    { ...validInvoice, label: "x".repeat(33) },
  ];

  for (const invoice of invalidInvoices) {
    await assertGenericReject(() => client.createInvoiceLink(invoice));
  }
  assert.equal(requests, 0);
});

test("createInvoiceLink accepts exact upper bounds and an explicit price label", async () => {
  const requestBodies = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: "https://t.me/$boundary-invoice" });
    },
  });
  const invoice = {
    title: "T".repeat(32),
    description: "D".repeat(255),
    payload: "🚀".repeat(32),
    amount: 10_000,
    label: "L".repeat(32),
  };

  await client.createInvoiceLink(invoice);

  assert.equal(requestBodies.length, 1);
  assert.deepEqual(requestBodies[0], {
    title: invoice.title,
    description: invoice.description,
    payload: invoice.payload,
    currency: "XTR",
    prices: [{ label: invoice.label, amount: invoice.amount }],
  });
});

test("requests use the injected timeout signal and redact timeout failures", async () => {
  const timeoutSecret = "provider-timeout-secret";
  let requestSignal;
  const client = createTelegramBotApiClient({
    botToken,
    timeoutMs: 15,
    fetcher: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error(`${timeoutSecret} ${botToken}`)),
          { once: true },
        );
      });
    },
  });

  await assertGenericReject(
    () => client.createInvoiceLink(validInvoice()),
    [timeoutSecret, botToken, validInvoice().payload],
  );

  assert.ok(requestSignal instanceof AbortSignal);
  assert.equal(requestSignal.aborted, true);
});

test("requests redact AbortError and secret-bearing network rejections", async () => {
  const providerSecret = "network-provider-secret";
  const abortError = new Error(`${providerSecret} ${botToken}`);
  abortError.name = "AbortError";

  for (const failure of [abortError, new Error(`${providerSecret} ${validInvoice().payload}`)]) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => {
        throw failure;
      },
    });
    await assertGenericReject(
      () => client.createInvoiceLink(validInvoice()),
      [providerSecret, botToken, validInvoice().payload, failure.message],
    );
  }
});

test("requests reject non-2xx responses without reading or exposing the provider body", async () => {
  const providerBody = "provider-body-with-charge-id charge_secret_42";
  let bodyRead = false;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => ({
      ok: false,
      status: 500,
      headers: { get: () => String(providerBody.length) },
      body: null,
      async json() {
        bodyRead = true;
        return { ok: false, description: providerBody };
      },
    }),
  });

  await assertGenericReject(
    () => client.createInvoiceLink(validInvoice()),
    [providerBody, "charge_secret_42", botToken],
  );
  assert.equal(bodyRead, false);
});

test("requests finish canceling unread non-2xx bodies before rejecting", async () => {
  let cancellations = 0;
  let cancellationFinished = false;
  let bodyReads = 0;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      body: {
        async cancel() {
          cancellations += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          cancellationFinished = true;
        },
        getReader() {
          bodyReads += 1;
          throw new Error("non-2xx body must remain unread");
        },
      },
    }),
  });

  await assertGenericReject(() => client.createInvoiceLink(validInvoice()), [botToken]);

  assert.equal(cancellations, 1);
  assert.equal(cancellationFinished, true);
  assert.equal(bodyReads, 0);
});

test("requests redact unread-body cancellation failures on non-2xx responses", async () => {
  const cancellationSecret = "non-2xx-cancellation-secret";
  let cancellations = 0;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => ({
      status: 500,
      headers: { get: () => null },
      body: {
        async cancel() {
          cancellations += 1;
          throw new Error(cancellationSecret);
        },
      },
    }),
  });

  await assertGenericReject(
    () => client.createInvoiceLink(validInvoice()),
    [cancellationSecret, botToken],
  );
  assert.equal(cancellations, 1);
});

test("requests reject malformed JSON, ok false, and malformed response envelopes", async () => {
  const providerSecret = "secret-provider-description";
  const responses = [
    new Response(`not-json-${providerSecret}`, { status: 200 }),
    jsonResponse({ ok: false, description: providerSecret }),
    jsonResponse(null),
    jsonResponse([]),
    jsonResponse({ ok: "true", result: "https://t.me/$invoice" }),
  ];

  for (const response of responses) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => response,
    });
    await assertGenericReject(
      () => client.createInvoiceLink(validInvoice()),
      [providerSecret, botToken],
    );
  }
});

test("createInvoiceLink rejects wrong result shapes and non-Telegram invoice URLs", async () => {
  const invalidResults = [
    undefined,
    null,
    true,
    {},
    "",
    "not-a-url",
    "http://t.me/$invoice",
    "https://telegram.me/$invoice",
    "https://t.me.evil.example/$invoice",
    "https://user@t.me/$invoice",
    "https://t.me:444/$invoice",
    "https://t.me/",
    " https://t.me/$invoice",
    "https://t.me/$invoice\n",
    "https://t.\nme/$invoice",
  ];

  for (const result of invalidResults) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => jsonResponse({ ok: true, result }),
    });
    await assertGenericReject(() => client.createInvoiceLink(validInvoice()), [botToken]);
  }
});

test("requests reject oversized Content-Length before reading the response body", async () => {
  let bodyRead = false;
  const client = createTelegramBotApiClient({
    botToken,
    maxResponseBytes: 128,
    fetcher: async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          assert.equal(name, "Content-Length");
          return "129";
        },
      },
      body: {
        getReader() {
          bodyRead = true;
          throw new Error("oversized body must not be read");
        },
      },
      async json() {
        bodyRead = true;
        return { ok: true, result: "https://t.me/$oversized" };
      },
    }),
  });

  await assertGenericReject(() => client.createInvoiceLink(validInvoice()), [botToken]);
  assert.equal(bodyRead, false);
});

test("requests cancel unread bodies for invalid and oversized Content-Length", async () => {
  const cancellationSecret = "content-length-cancellation-secret";

  for (const contentLength of ["invalid", "129"]) {
    let cancellations = 0;
    let cancellationFinished = false;
    let bodyReads = 0;
    const client = createTelegramBotApiClient({
      botToken,
      maxResponseBytes: 128,
      fetcher: async () => ({
        status: 200,
        headers: { get: () => contentLength },
        body: {
          async cancel() {
            cancellations += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            cancellationFinished = true;
            if (contentLength === "invalid") {
              throw new Error(cancellationSecret);
            }
          },
          getReader() {
            bodyReads += 1;
            throw new Error("rejected Content-Length body must remain unread");
          },
        },
      }),
    });

    await assertGenericReject(
      () => client.createInvoiceLink(validInvoice()),
      [cancellationSecret, botToken],
    );
    assert.equal(cancellations, 1);
    assert.equal(cancellationFinished, true);
    assert.equal(bodyReads, 0);
  }
});

test("requests bound streamed response bytes and cancel an oversized body", async () => {
  const providerSecret = "streamed-charge-id-secret";
  let cancellations = 0;
  let releasedLocks = 0;
  const response = streamedResponse(
    [textBytes(`{"ok":true,"result":"https://t.me/$${providerSecret}"}`)],
    {
      onCancel: () => {
        cancellations += 1;
      },
      onRelease: () => {
        releasedLocks += 1;
      },
    },
  );
  const client = createTelegramBotApiClient({
    botToken,
    maxResponseBytes: 32,
    fetcher: async () => response,
  });

  await assertGenericReject(
    () => client.createInvoiceLink(validInvoice()),
    [providerSecret, botToken],
  );
  assert.equal(cancellations, 1);
  assert.equal(releasedLocks, 1);
});

test("requests parse a valid bounded streamed JSON response", async () => {
  const invoiceUrl = "https://t.me/$streamed-invoice";
  const responseBytes = textBytes(JSON.stringify({ ok: true, result: invoiceUrl }));
  const splitAt = Math.floor(responseBytes.byteLength / 2);
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () =>
      streamedResponse([responseBytes.slice(0, splitAt), responseBytes.slice(splitAt)]),
  });

  assert.equal(await client.createInvoiceLink(validInvoice()), invoiceUrl);
});

test("answerPreCheckoutQuery sends the exact success body and requires a true result", async () => {
  const calls = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: true });
    },
  });

  assert.equal(
    await client.answerPreCheckoutQuery({
      id: "pre_checkout_success_42",
      ok: true,
      errorMessage: "this must not be sent",
    }),
    undefined,
  );

  assert.equal(calls.length, 1);
  assertExactJsonPost(calls[0], "answerPreCheckoutQuery", {
    pre_checkout_query_id: "pre_checkout_success_42",
    ok: true,
  });
});

test("answerPreCheckoutQuery sends the exact failure body", async () => {
  const calls = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: true });
    },
  });

  assert.equal(
    await client.answerPreCheckoutQuery({
      id: "pre_checkout_failure_42",
      ok: false,
      errorMessage: "The selected Stars pack is no longer available.",
    }),
    undefined,
  );

  assert.equal(calls.length, 1);
  assertExactJsonPost(calls[0], "answerPreCheckoutQuery", {
    pre_checkout_query_id: "pre_checkout_failure_42",
    ok: false,
    error_message: "The selected Stars pack is no longer available.",
  });
});

test("answerPreCheckoutQuery validates its id, boolean, and failure message before fetching", async () => {
  let requests = 0;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => {
      requests += 1;
      throw new Error("invalid pre-checkout input reached Telegram");
    },
  });
  const validAnswer = { id: "pre_checkout_42", ok: true };
  const invalidAnswers = [
    null,
    [],
    "answer",
    { ...validAnswer, id: undefined },
    { ...validAnswer, id: null },
    { ...validAnswer, id: "" },
    { ...validAnswer, id: " \t " },
    { ...validAnswer, id: 42 },
    { ...validAnswer, id: "x".repeat(257) },
    { ...validAnswer, ok: undefined },
    { ...validAnswer, ok: null },
    { ...validAnswer, ok: 1 },
    { ...validAnswer, ok: "true" },
    { id: "pre_checkout_42", ok: false },
    { id: "pre_checkout_42", ok: false, errorMessage: null },
    { id: "pre_checkout_42", ok: false, errorMessage: "" },
    { id: "pre_checkout_42", ok: false, errorMessage: " \n " },
    { id: "pre_checkout_42", ok: false, errorMessage: 42 },
    { id: "pre_checkout_42", ok: false, errorMessage: "x".repeat(201) },
  ];

  for (const answer of invalidAnswers) {
    await assertGenericReject(() => client.answerPreCheckoutQuery(answer));
  }
  assert.equal(requests, 0);
});

test("answerPreCheckoutQuery accepts bounded values and rejects any result other than true", async () => {
  const requestBodies = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: true });
    },
  });
  await client.answerPreCheckoutQuery({
    id: "i".repeat(256),
    ok: false,
    errorMessage: "e".repeat(200),
  });
  assert.deepEqual(requestBodies, [
    {
      pre_checkout_query_id: "i".repeat(256),
      ok: false,
      error_message: "e".repeat(200),
    },
  ]);

  for (const result of [false, null, 1, "true", {}]) {
    const rejectingClient = createTelegramBotApiClient({
      botToken,
      fetcher: async () => jsonResponse({ ok: true, result }),
    });
    await assertGenericReject(() =>
      rejectingClient.answerPreCheckoutQuery({ id: "pre_checkout_42", ok: true }),
    );
  }
});

test("sendMessage sends the exact body and does not expose Telegram's message object", async () => {
  const chatId = -1_001_234_567_890;
  const text = "Your Telegram Stars purchase is complete.";
  const telegramMessage = validTelegramMessage({ chatId, text });
  const calls = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: telegramMessage });
    },
  });

  assert.equal(await client.sendMessage({ chatId, text }), undefined);

  assert.equal(calls.length, 1);
  assertExactJsonPost(calls[0], "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  assert.notEqual(await client.sendMessage({ chatId, text }), telegramMessage);
});

test("sendMessage preserves canonical integer strings and accepts the Telegram text limit", async () => {
  const chatIds = ["9007199254740991", "-1001234567890"];
  const text = "🚀".repeat(4096);
  const requestBodies = [];
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return jsonResponse({ ok: true, result: validTelegramMessage() });
    },
  });

  for (const chatId of chatIds) {
    await client.sendMessage({ chatId, text });
  }

  assert.deepEqual(
    requestBodies,
    chatIds.map((chatId) => ({ chat_id: chatId, text, disable_web_page_preview: true })),
  );
});

test("sendMessage validates chat IDs and bounded nonblank text before fetching", async () => {
  let requests = 0;
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => {
      requests += 1;
      throw new Error("invalid message reached Telegram");
    },
  });
  const validMessage = { chatId: 42, text: "Purchase complete" };
  const invalidMessages = [
    null,
    [],
    "message",
    { ...validMessage, chatId: undefined },
    { ...validMessage, chatId: null },
    { ...validMessage, chatId: true },
    { ...validMessage, chatId: 0 },
    { ...validMessage, chatId: 1.5 },
    { ...validMessage, chatId: Number.MAX_SAFE_INTEGER + 1 },
    { ...validMessage, chatId: "" },
    { ...validMessage, chatId: " \t " },
    { ...validMessage, chatId: "0" },
    { ...validMessage, chatId: "-0" },
    { ...validMessage, chatId: "00" },
    { ...validMessage, chatId: "01" },
    { ...validMessage, chatId: "-01" },
    { ...validMessage, chatId: `${"0".repeat(16)}1` },
    { ...validMessage, chatId: "+42" },
    { ...validMessage, chatId: "42.0" },
    { ...validMessage, chatId: "9007199254740992" },
    { ...validMessage, text: undefined },
    { ...validMessage, text: null },
    { ...validMessage, text: "" },
    { ...validMessage, text: " \n " },
    { ...validMessage, text: 42 },
    { ...validMessage, text: "x".repeat(4097) },
  ];

  for (const message of invalidMessages) {
    await assertGenericReject(() => client.sendMessage(message));
  }
  assert.equal(requests, 0);
});

test("sendMessage rejects malformed Telegram message results", async () => {
  const invalidResults = [
    null,
    [],
    {},
    { ...validTelegramMessage(), message_id: "1" },
    { ...validTelegramMessage(), message_id: 0 },
    { ...validTelegramMessage(), date: "1" },
    { ...validTelegramMessage(), date: -1 },
    { ...validTelegramMessage(), chat: null },
    { ...validTelegramMessage(), chat: { id: Number.MAX_SAFE_INTEGER + 1, type: "private" } },
    { ...validTelegramMessage(), chat: { id: 42, type: " " } },
  ];

  for (const result of invalidResults) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => jsonResponse({ ok: true, result }),
    });
    await assertGenericReject(() => client.sendMessage({ chatId: 42, text: "Receipt" }));
  }
});

test("requests reject null and otherwise invalid response contracts", async () => {
  const validBody = JSON.stringify({ ok: true, result: "https://t.me/$invoice" });
  const responses = [
    null,
    [],
    "response",
    { status: 200, headers: { get: () => null } },
    {
      ok: false,
      status: 200,
      headers: { get: () => null },
      body: null,
      async text() {
        return validBody;
      },
    },
  ];

  for (const response of responses) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => response,
    });
    await assertGenericReject(() => client.createInvoiceLink(validInvoice()), [botToken]);
  }
});

test("requests support a bounded status-less text response", async () => {
  const invoiceUrl = "https://t.me/$text-response";
  const client = createTelegramBotApiClient({
    botToken,
    fetcher: async () => ({
      ok: true,
      headers: { get: () => null },
      body: null,
      async text() {
        return JSON.stringify({ ok: true, result: invoiceUrl });
      },
    }),
  });

  assert.equal(await client.createInvoiceLink(validInvoice()), invoiceUrl);
});

test("requests reject malformed Content-Length and unsafe text-only bodies", async () => {
  const providerSecret = "text-response-provider-secret";
  let malformedLengthBodyRead = false;
  const responses = [
    {
      ok: true,
      headers: { get: () => "not-an-integer" },
      body: null,
      async text() {
        malformedLengthBodyRead = true;
        return "{}";
      },
    },
    { ok: true, headers: { get: () => null }, body: null },
    {
      ok: true,
      headers: { get: () => null },
      body: null,
      async text() {
        return 42;
      },
    },
    {
      ok: true,
      headers: { get: () => null },
      body: null,
      async text() {
        return providerSecret.repeat(4);
      },
    },
    {
      ok: true,
      headers: { get: () => null },
      body: null,
      async text() {
        throw new Error(providerSecret);
      },
    },
  ];

  for (const response of responses) {
    const client = createTelegramBotApiClient({
      botToken,
      maxResponseBytes: 32,
      fetcher: async () => response,
    });
    await assertGenericReject(
      () => client.createInvoiceLink(validInvoice()),
      [providerSecret, botToken],
    );
  }
  assert.equal(malformedLengthBodyRead, false);
});

test("requests reject malformed stream reads and non-byte chunks", async () => {
  const providerSecret = "non-byte-stream-secret";
  let releasedLocks = 0;
  const malformedStreams = [
    null,
    { done: "false", value: textBytes("{}") },
    { done: false, value: providerSecret },
  ];

  for (const readResult of malformedStreams) {
    const client = createTelegramBotApiClient({
      botToken,
      fetcher: async () => ({
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                return readResult;
              },
              releaseLock() {
                releasedLocks += 1;
              },
            };
          },
        },
      }),
    });
    await assertGenericReject(
      () => client.createInvoiceLink(validInvoice()),
      [providerSecret, botToken],
    );
  }
  assert.equal(releasedLocks, malformedStreams.length);
});

test("requests keep oversized-body errors generic when stream cancellation fails", async () => {
  const cancellationSecret = "stream-cancellation-secret";
  let releasedLocks = 0;
  const client = createTelegramBotApiClient({
    botToken,
    maxResponseBytes: 16,
    fetcher: async () =>
      streamedResponse([textBytes("x".repeat(17))], {
        onCancel() {
          throw new Error(cancellationSecret);
        },
        onRelease() {
          releasedLocks += 1;
        },
      }),
  });

  await assertGenericReject(
    () => client.createInvoiceLink(validInvoice()),
    [cancellationSecret, botToken],
  );
  assert.equal(releasedLocks, 1);
});

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function validInvoice(overrides = {}) {
  return {
    title: "Stars pack",
    description: "One pack of Telegram Stars.",
    payload: "stars_pack_1",
    amount: 100,
    ...overrides,
  };
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function streamedResponse(chunks, { onCancel = () => {}, onRelease = () => {} } = {}) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          async cancel() {
            onCancel();
          },
          releaseLock() {
            onRelease();
          },
        };
      },
    },
  };
}

function assertExactJsonPost(call, method, expectedBody) {
  const [url, init] = call;
  assert.equal(url, `https://api.telegram.org/bot${botToken}/${method}`);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), expectedBody);
}

function validTelegramMessage({ chatId = 42, text = "Receipt" } = {}) {
  return {
    message_id: 73,
    date: 1_752_576_000,
    chat: { id: chatId, type: "private" },
    text,
  };
}

function assertGenericThrow(operation, secrets = []) {
  assert.throws(operation, (error) => isGenericError(error, secrets));
}

async function assertGenericReject(operation, secrets = []) {
  await assert.rejects(operation, (error) => isGenericError(error, secrets));
}

function isGenericError(error, secrets) {
  assert.equal(error instanceof Error, true);
  assert.equal(error.message, genericError);
  const outwardError = String(error);
  for (const secret of secrets) {
    assert.equal(outwardError.includes(secret), false, `error leaked ${secret}`);
  }
  return true;
}
