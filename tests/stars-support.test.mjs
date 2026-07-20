import assert from "node:assert/strict";
import test from "node:test";

import { createStarsSupportClient } from "../src/stars-support.js";

const genericErrorMessage = "Stars support request failed";
const sessionToken = "s".repeat(43);
const invoiceId = `inv_${"A".repeat(22)}`;
const invoiceUrl = `https://t.me/$${"T".repeat(22)}`;
const createdAt = "2026-07-17T20:00:00.000Z";
const expiresAt = "2026-07-17T20:15:00.000Z";
const paidAt = "2026-07-17T20:01:00.000Z";

const createdInvoice = Object.freeze({
  invoiceId,
  invoiceUrl,
  amount: 88,
  currency: "XTR",
  expiresAt,
});

const pendingInvoice = Object.freeze({
  invoiceId,
  amount: 88,
  currency: "XTR",
  status: "pending",
  createdAt,
  expiresAt,
  paidAt: null,
});

test("createInvoice sends the exact authenticated JSON request and validates its response", async () => {
  const requests = [];
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test/api///",
    getToken: () => sessionToken,
    async fetcher(input, init) {
      requests.push([input, init]);
      return jsonResponse(createdInvoice, { status: 201 });
    },
  });

  assert.deepEqual(await client.createInvoice({ amount: 88, locale: "ru" }), createdInvoice);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "https://worker.test/api/payments/stars/invoices");
  const { signal, ...requestInit } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(requestInit, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: '{"amount":88,"locale":"ru"}',
  });
});

test("getInvoice awaits the token and requests only a validated opaque invoice ID", async () => {
  const requests = [];
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: async () => sessionToken,
    async fetcher(input, init) {
      requests.push([input, init]);
      return jsonResponse(pendingInvoice);
    },
  });

  assert.deepEqual(await client.getInvoice(invoiceId), pendingInvoice);
  assert.equal(requests[0][0], `https://worker.test/payments/stars/invoices/${invoiceId}`);
  const { signal, ...requestInit } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(requestInit, {
    method: "GET",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
});

test("constructor rejects unsafe URLs and invalid bounded dependencies", () => {
  const valid = { workerUrl: "https://worker.test", getToken: () => sessionToken };
  for (const workerUrl of [
    undefined,
    null,
    "",
    " https://worker.test",
    "https://worker.test ",
    "worker.test",
    "http://worker.test",
    "https://user@worker.test",
    "https://@worker.test",
    "https://worker.test:443",
    "https://worker.test:8443",
    "https://worker.test/?debug=1",
    "https://worker.test/?",
    "https://worker.test/#debug",
    "https://worker.test/#",
  ]) {
    assert.throws(() => createStarsSupportClient({ ...valid, workerUrl }), { name: "TypeError" });
  }
  for (const fetcher of [null, false, {}, "fetch"]) {
    assert.throws(() => createStarsSupportClient({ ...valid, fetcher }), { name: "TypeError" });
  }
  for (const getToken of [undefined, null, false, {}, "token"]) {
    assert.throws(() => createStarsSupportClient({ ...valid, getToken }), { name: "TypeError" });
  }
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
    assert.throws(() => createStarsSupportClient({ ...valid, timeoutMs }), { name: "TypeError" });
  }
  for (const pollAttempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 61]) {
    assert.throws(() => createStarsSupportClient({ ...valid, pollAttempts }), { name: "TypeError" });
  }
  for (const pollDelayMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60_001]) {
    assert.throws(() => createStarsSupportClient({ ...valid, pollDelayMs }), { name: "TypeError" });
  }
  for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_048_577]) {
    assert.throws(() => createStarsSupportClient({ ...valid, maxResponseBytes }), { name: "TypeError" });
  }
  for (const delay of [null, false, {}, "delay"]) {
    assert.throws(() => createStarsSupportClient({ ...valid, delay }), { name: "TypeError" });
  }
  assert.throws(() => createStarsSupportClient(null), { name: "TypeError" });
});

test("createInvoice accepts only an exact amount and locale object before side effects", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken() {
      tokenCalls += 1;
      return sessionToken;
    },
    async fetcher(_input, init) {
      fetchCalls += 1;
      return jsonResponse({
        ...createdInvoice,
        amount: JSON.parse(init.body).amount,
      }, { status: 201 });
    },
  });
  const invalid = [
    undefined,
    null,
    [],
    {},
    { amount: 0, locale: "ru" },
    { amount: 10_001, locale: "ru" },
    { amount: 1.5, locale: "ru" },
    { amount: "88", locale: "ru" },
    { amount: 88, locale: "RU" },
    { amount: 88, locale: "de" },
    { amount: 88, locale: "ru", recurring: true },
  ];

  for (const value of invalid) {
    await assert.rejects(client.createInvoice(value), { name: "TypeError" });
  }
  for (const locale of ["en", "ru", "zh"]) {
    await client.createInvoice({ amount: 1, locale });
  }
  await client.createInvoice({ amount: 10_000, locale: "en" });
  assert.equal(tokenCalls, 4);
  assert.equal(fetchCalls, 4);
});

test("public methods reject invalid IDs and exact signal options before side effects", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken() {
      tokenCalls += 1;
      return sessionToken;
    },
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse(pendingInvoice);
    },
  });
  const invalidIds = [
    undefined,
    null,
    "",
    "inv_short",
    ` inv_${"A".repeat(22)}`,
    `inv_${"A".repeat(21)}!`,
    `inv_${"A".repeat(23)}`,
    42,
  ];
  for (const value of invalidIds) {
    await assert.rejects(client.getInvoice(value), { name: "TypeError" });
    await assert.rejects(client.waitForPaid(value), { name: "TypeError" });
  }
  for (const signal of [false, {}, { aborted: false }, new EventTarget()]) {
    await assert.rejects(client.createInvoice({ amount: 88, locale: "en" }, { signal }), {
      name: "TypeError",
    });
    await assert.rejects(client.getInvoice(invoiceId, { signal }), { name: "TypeError" });
    await assert.rejects(client.waitForPaid(invoiceId, { signal }), { name: "TypeError" });
  }
  await assert.rejects(client.createInvoice({ amount: 88, locale: "en" }, {
    singal: new AbortController().signal,
  }), { name: "TypeError" });
  await assert.rejects(client.getInvoice(invoiceId, {
    signal: new AbortController().signal,
    extra: true,
  }), { name: "TypeError" });
  await assert.rejects(client.waitForPaid(invoiceId, null), { name: "TypeError" });
  await assert.rejects(client.waitForPaid(invoiceId, {
    signal: new AbortController().signal,
    extra: true,
  }), { name: "TypeError" });
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("createInvoice rejects non-exact or malformed public invoice responses", async () => {
  const malformed = [
    null,
    [],
    { ...createdInvoice, privatePayload: "provider-secret" },
    { ...createdInvoice, invoiceId: "inv_short" },
    { ...createdInvoice, invoiceUrl: "http://t.me/$invoice" },
    { ...createdInvoice, invoiceUrl: "https://telegram.me/$invoice" },
    { ...createdInvoice, invoiceUrl: "https://t.me.evil.test/$invoice" },
    { ...createdInvoice, invoiceUrl: "https://t.me/$invoice?secret=1" },
    { ...createdInvoice, invoiceUrl: "https://t.me/$invoice#secret" },
    { ...createdInvoice, invoiceUrl: "https://t.me/$" },
    { ...createdInvoice, invoiceUrl: "https://t.me/invoice/" },
    { ...createdInvoice, invoiceUrl: `https://t.me/$${"a".repeat(2048)}` },
    { ...createdInvoice, amount: 89 },
    { ...createdInvoice, amount: 0 },
    { ...createdInvoice, currency: "USD" },
    { ...createdInvoice, expiresAt: "2026-07-17 20:15:00Z" },
    { ...createdInvoice, expiresAt: "not-a-date" },
  ];

  for (const payload of malformed) {
    const error = await requestRejection({ method: "create", payload });
    assertGenericError(error, 201, "provider-secret");
  }
});

test("createInvoice accepts both official canonical Telegram invoice link forms", async () => {
  const validUrls = [
    "https://t.me/$invoice_A-1=",
    "https://t.me/invoice/invoice_A-1=",
    `https://t.me/invoice/${"a".repeat(512)}=`,
  ];

  for (const value of validUrls) {
    const expected = { ...createdInvoice, invoiceUrl: value };
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      fetcher: async () => jsonResponse(expected, { status: 201 }),
    });
    assert.deepEqual(
      await client.createInvoice({ amount: 88, locale: "en" }),
      expected,
    );
  }
});

test("getInvoice accepts exact public terminal states and rejects malformed projections", async () => {
  const valid = [
    pendingInvoice,
    { ...pendingInvoice, status: "expired" },
    { ...pendingInvoice, status: "paid", paidAt },
    { ...pendingInvoice, status: "failed" },
    { ...pendingInvoice, status: "failed", paidAt },
  ];
  for (const payload of valid) {
    const client = clientReturning(payload);
    assert.deepEqual(await client.getInvoice(invoiceId), payload);
  }

  const malformed = [
    null,
    [],
    { ...pendingInvoice, invoicePayload: "provider-secret" },
    { ...pendingInvoice, invoiceId: `inv_${"B".repeat(22)}` },
    { ...pendingInvoice, amount: 0 },
    { ...pendingInvoice, amount: 10_001 },
    { ...pendingInvoice, currency: "USD" },
    { ...pendingInvoice, status: "refunded" },
    { ...pendingInvoice, createdAt: "not-a-date" },
    { ...pendingInvoice, expiresAt: createdAt },
    { ...pendingInvoice, paidAt },
    { ...pendingInvoice, status: "expired", paidAt },
    { ...pendingInvoice, status: "paid", paidAt: null },
    { ...pendingInvoice, status: "paid", paidAt: "2026-07-17T19:59:00.000Z" },
    { ...pendingInvoice, status: "failed", paidAt: 42 },
  ];
  for (const payload of malformed) {
    const error = await requestRejection({ method: "get", payload });
    assertGenericError(error, 200, "provider-secret");
  }
});

test("requests reject invalid tokens and redact synchronous or asynchronous token failures", async () => {
  const providerSecret = "token-provider-secret";
  const tokenProviders = [
    () => "",
    () => "a".repeat(42),
    () => "a".repeat(44),
    () => `${"a".repeat(42)}=`,
    () => 42,
    () => { throw new Error(providerSecret); },
    async () => { throw new Error(providerSecret); },
  ];
  for (const getToken of tokenProviders) {
    let fetchCalls = 0;
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken,
      async fetcher() {
        fetchCalls += 1;
        return jsonResponse(createdInvoice, { status: 201 });
      },
    });
    const error = await rejected(client.createInvoice({ amount: 88, locale: "en" }));
    assertGenericError(error, 0, providerSecret);
    assert.equal(fetchCalls, 0);
  }
});

test("HTTP and response protocol failures are status-bearing and redacted", async () => {
  const providerSecret = "sensitive-provider-description";
  const cases = [
    new Response(JSON.stringify({ error: providerSecret }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ error: providerSecret }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ error: providerSecret }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ error: providerSecret }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(`<html>${providerSecret}</html>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }),
    new Response(providerSecret, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify(createdInvoice), {
      status: 201,
      headers: { "Content-Type": "application/problem+json" },
    }),
  ];

  for (const response of cases) {
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      fetcher: async () => response,
    });
    const error = await rejected(client.createInvoice({ amount: 88, locale: "en" }));
    assertGenericError(error, response.status, providerSecret);
  }
});

test("bounded UTF-8 response reading rejects declared, streamed, and encoded overflow", async () => {
  const providerSecret = "oversized-provider-secret";
  const oversizedText = JSON.stringify({ ...createdInvoice, padding: providerSecret.repeat(100) });
  const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
  const cases = [
    new Response(JSON.stringify(createdInvoice), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "invalid",
      },
    }),
    new Response(JSON.stringify(createdInvoice), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "129",
      },
    }),
    new Response(streamFrom([new TextEncoder().encode(oversizedText)]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(streamFrom([invalidUtf8]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
  ];

  for (const response of cases) {
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      maxResponseBytes: 128,
      fetcher: async () => response,
    });
    const error = await rejected(client.createInvoice({ amount: 88, locale: "en" }));
    assertGenericError(error, 201, providerSecret);
  }
});

test("unread and partially-read response streams are cancelled on rejection", async () => {
  for (const kind of ["http", "content-type", "oversized"]) {
    let cancelCalls = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const response = new Response(body, {
      status: kind === "http" ? 503 : 200,
      headers: {
        "Content-Type": kind === "content-type" ? "text/plain" : "application/json",
      },
    });
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      maxResponseBytes: kind === "oversized" ? 16 : 128,
      fetcher: async () => response,
    });

    await assert.rejects(client.createInvoice({ amount: 88, locale: "en" }), {
      message: genericErrorMessage,
    });
    assert.equal(cancelCalls, 1, kind);
  }
});

test("request timeout and caller abort stop in-flight work without leaking failures", async () => {
  const timeoutClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    timeoutMs: 5,
    fetcher: (_input, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timeout-secret")), { once: true });
    }),
  });
  assertGenericError(
    await rejectedWithin(timeoutClient.getInvoice(invoiceId), 500),
    0,
    "timeout-secret",
  );

  let fetchCalls = 0;
  const caller = new AbortController();
  caller.abort();
  const abortedClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse(pendingInvoice);
    },
  });
  assertGenericError(await rejected(abortedClient.getInvoice(invoiceId, {
    signal: caller.signal,
  })), 0);
  assert.equal(fetchCalls, 0);

  const activeCaller = trackedAbortController();
  const fetchStarted = Promise.withResolvers();
  let requestSignal;
  const activeClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: (_input, { signal }) => {
      requestSignal = signal;
      fetchStarted.resolve();
      return new Promise(() => {});
    },
  });
  const activeRequest = activeClient.getInvoice(invoiceId, { signal: activeCaller.signal });
  await fetchStarted.promise;
  activeCaller.abort();
  assertGenericError(await rejectedWithin(activeRequest), 0);
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(activeCaller.listenerCounts(), { added: 1, removed: 1 });
});

test("request failures tolerate hostile status accessors", async () => {
  const hostile = Object.defineProperty({}, "status", {
    get() {
      throw new Error("status-getter-secret");
    },
  });
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => { throw hostile; },
  });

  assertGenericError(await rejected(client.getInvoice(invoiceId)), 0, "status-getter-secret");
});

test("aborting a response read cancels its reader", async () => {
  let cancelCalls = 0;
  const readStarted = Promise.withResolvers();
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
    body: {
      getReader() {
        return {
          read() {
            readStarted.resolve();
            return new Promise(() => {});
          },
          cancel() {
            cancelCalls += 1;
            return Promise.resolve();
          },
          releaseLock() {},
        };
      },
    },
  };
  const caller = new AbortController();
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => response,
  });

  const request = client.getInvoice(invoiceId, { signal: caller.signal });
  await readStarted.promise;
  caller.abort();
  assertGenericError(await rejectedWithin(request), 200);
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
});

test("waitForPaid returns immediately for paid, expired, and failed invoices", async () => {
  for (const invoice of [
    { ...pendingInvoice, status: "paid", paidAt },
    { ...pendingInvoice, status: "expired" },
    { ...pendingInvoice, status: "failed" },
  ]) {
    let fetchCalls = 0;
    let delayCalls = 0;
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      fetcher: async () => {
        fetchCalls += 1;
        return jsonResponse(invoice);
      },
      delay: async () => { delayCalls += 1; },
    });

    assert.deepEqual(await client.waitForPaid(invoiceId), { status: invoice.status, invoice });
    assert.equal(fetchCalls, 1);
    assert.equal(delayCalls, 0);
  }
});

test("waitForPaid polls pending invoices until paid and passes its bounded delay", async () => {
  const paidInvoice = { ...pendingInvoice, status: "paid", paidAt };
  const responses = [pendingInvoice, pendingInvoice, paidInvoice];
  const delays = [];
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    pollAttempts: 3,
    pollDelayMs: 25,
    fetcher: async () => jsonResponse(responses.shift()),
    async delay(milliseconds, signal) {
      delays.push([milliseconds, signal]);
    },
  });

  assert.deepEqual(await client.waitForPaid(invoiceId), { status: "paid", invoice: paidInvoice });
  assert.equal(responses.length, 0);
  assert.equal(delays.length, 2);
  assert.deepEqual(delays.map(([milliseconds]) => milliseconds), [25, 25]);
  assert.equal(delays.every(([, signal]) => signal instanceof AbortSignal), true);
});

test("waitForPaid returns the final pending invoice after bounded exhaustion", async () => {
  let fetchCalls = 0;
  let delayCalls = 0;
  const finalInvoice = { ...pendingInvoice, amount: 360 };
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    pollAttempts: 2,
    pollDelayMs: 0,
    fetcher: async () => {
      fetchCalls += 1;
      return jsonResponse(fetchCalls === 1 ? pendingInvoice : finalInvoice);
    },
    async delay() {
      delayCalls += 1;
    },
  });

  assert.deepEqual(await client.waitForPaid(invoiceId), {
    status: "pending",
    invoice: finalInvoice,
  });
  assert.equal(fetchCalls, 2);
  assert.equal(delayCalls, 1);
});

test("waitForPaid uses an abort-aware default delay", async () => {
  let fetchCalls = 0;
  const immediateClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    pollAttempts: 2,
    pollDelayMs: 0,
    fetcher: async () => {
      fetchCalls += 1;
      return jsonResponse(pendingInvoice);
    },
  });
  assert.deepEqual(await immediateClient.waitForPaid(invoiceId), {
    status: "pending",
    invoice: pendingInvoice,
  });
  assert.equal(fetchCalls, 2);

  const caller = new AbortController();
  const delayedClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    pollDelayMs: 10_000,
    fetcher: async () => jsonResponse(pendingInvoice),
  });
  const result = delayedClient.waitForPaid(invoiceId, { signal: caller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  caller.abort();
  assertGenericError(await rejectedWithin(result), 0);
});

test("waitForPaid aborts before polling and while its injected delay is pending", async () => {
  let fetchCalls = 0;
  const before = new AbortController();
  before.abort();
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => {
      fetchCalls += 1;
      return jsonResponse(pendingInvoice);
    },
  });
  assertGenericError(await rejected(client.waitForPaid(invoiceId, { signal: before.signal })), 0);
  assert.equal(fetchCalls, 0);

  const during = trackedAbortController();
  const delayStarted = Promise.withResolvers();
  let delaySignal;
  const delayedClient = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => jsonResponse(pendingInvoice),
    delay(_milliseconds, signal) {
      delaySignal = signal;
      delayStarted.resolve();
      return new Promise(() => {});
    },
  });
  const result = delayedClient.waitForPaid(invoiceId, { signal: during.signal });
  await delayStarted.promise;
  during.abort();
  assertGenericError(await rejectedWithin(result), 0);
  assert.notEqual(delaySignal, during.signal);
  assert.equal(delaySignal.aborted, true);
  assert.deepEqual(during.listenerCounts(), { added: 2, removed: 2 });
});

test("waitForPaid bounds a misbehaving injected delay without a caller signal", async () => {
  let fetchCalls = 0;
  let delaySignal;
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    timeoutMs: 5,
    pollAttempts: 2,
    pollDelayMs: 0,
    fetcher: async () => {
      fetchCalls += 1;
      return jsonResponse(pendingInvoice);
    },
    delay(_milliseconds, signal) {
      delaySignal = signal;
      return new Promise(() => {});
    },
  });

  assertGenericError(await rejectedWithin(client.waitForPaid(invoiceId), 200), 0);
  assert.equal(fetchCalls, 1);
  assert.equal(delaySignal.aborted, true);
});

test("waitForPaid never retries request, authorization, or response validation failures", async () => {
  const cases = [
    {
      name: "network",
      fetcher: async () => { throw new Error("network-secret"); },
      expectedStatus: 0,
    },
    {
      name: "unauthorized",
      fetcher: async () => jsonResponse({ error: "auth-secret" }, { status: 401 }),
      expectedStatus: 401,
    },
    {
      name: "forbidden",
      fetcher: async () => jsonResponse({ error: "auth-secret" }, { status: 403 }),
      expectedStatus: 403,
    },
    {
      name: "missing",
      fetcher: async () => jsonResponse({ error: "missing-secret" }, { status: 404 }),
      expectedStatus: 404,
    },
    {
      name: "unavailable",
      fetcher: async () => jsonResponse({ error: "provider-secret" }, { status: 503 }),
      expectedStatus: 503,
    },
    {
      name: "malformed",
      fetcher: async () => jsonResponse({ ...pendingInvoice, private: "provider-secret" }),
      expectedStatus: 200,
    },
    {
      name: "oversized",
      fetcher: async () => jsonResponse({ ...pendingInvoice, padding: "x".repeat(20_000) }),
      expectedStatus: 200,
    },
  ];

  for (const scenario of cases) {
    let fetchCalls = 0;
    let delayCalls = 0;
    const client = createStarsSupportClient({
      workerUrl: "https://worker.test",
      getToken: () => sessionToken,
      fetcher: async (...args) => {
        fetchCalls += 1;
        return scenario.fetcher(...args);
      },
      async delay() { delayCalls += 1; },
    });
    const error = await rejected(client.waitForPaid(invoiceId));
    assertGenericError(error, scenario.expectedStatus, "secret");
    assert.equal(fetchCalls, 1, scenario.name);
    assert.equal(delayCalls, 0, scenario.name);
  }
});

function clientReturning(payload) {
  return createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => jsonResponse(payload),
  });
}

async function requestRejection({ method, payload }) {
  const client = createStarsSupportClient({
    workerUrl: "https://worker.test",
    getToken: () => sessionToken,
    fetcher: async () => jsonResponse(payload, { status: method === "create" ? 201 : 200 }),
  });
  return rejected(method === "create"
    ? client.createInvoice({ amount: 88, locale: "en" })
    : client.getInvoice(invoiceId));
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function streamFrom(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected promise to reject");
}

async function rejectedWithin(promise, milliseconds = 250) {
  return Promise.race([
    rejected(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error("request did not settle")), milliseconds)),
  ]);
}

function assertGenericError(error, status, secret = "") {
  assert.equal(error?.constructor, Error);
  assert.equal(error?.message, genericErrorMessage);
  assert.equal(error?.status, status);
  if (secret) {
    assert.equal(String(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
  }
}

function trackedAbortController() {
  const controller = new AbortController();
  const counts = { added: 0, removed: 0 };
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    counts.added += 1;
    return add(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    counts.removed += 1;
    return remove(...args);
  };
  return Object.assign(controller, {
    listenerCounts: () => ({ ...counts }),
  });
}
