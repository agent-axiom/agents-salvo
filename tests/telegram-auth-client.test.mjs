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
    assert.deepEqual(Object.keys(requests[0][1]).sort(), ["method", "signal"]);
    assert.equal(requests[0][1].method, "GET");
    assert.equal(requests[0][1].signal instanceof AbortSignal, true);
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
  const { signal, ...requestInit } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(requestInit, {
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
  const { signal, ...requestInit } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(requestInit, {
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
    "https://worker.test:443",
    "https://worker.test:8443",
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
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createTelegramAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => {},
      timeoutMs,
    }), { name: "TypeError" });
  }
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

test("non-success responses cancel stalled bodies before request cleanup", async () => {
  const caller = trackedAbortController();
  const stalled = stalledRejectedResponse(503);
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    fetcher: async () => stalled.response,
  });

  const pending = client.capability({ signal: caller.signal });
  const firstEvent = await Promise.race([
    stalled.cancelStarted.then(() => "cancelled"),
    pending.then(() => "settled", () => "settled"),
  ]);

  assert.equal(firstEvent, "cancelled");
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 0 });
  stalled.releaseCancel();
  const error = await rejectedWithin(pending);
  assertGenericClientError(error, 503);
  assert.equal(stalled.cancelCalls(), 1);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
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

test("request timeout aborts a stalled fetch and clears caller listeners", async () => {
  const fetchSecret = "pending-fetch-provider-secret";
  const caller = trackedAbortController();
  let requestSignal;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 20,
    fetcher: async (_input, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error(fetchSecret));
        }, { once: true });
      });
    },
  });

  const error = await rejectedWithin(client.capability({ signal: caller.signal }));
  assertGenericClientError(error, 0, fetchSecret);
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("request timeout aborts and cancels a stalled response body", async () => {
  const bodySecret = "stalled-response-body-secret";
  const stalled = stallingJsonResponse(bodySecret);
  let requestSignal;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 20,
    async fetcher(_input, init) {
      requestSignal = init.signal;
      return stalled.response;
    },
  });

  const error = await rejectedWithin(client.capability());
  assertGenericClientError(error, 200, bodySecret);
  assert.equal(requestSignal.aborted, true);
  assert.equal(stalled.cancelCalls(), 1);
});

test("an already-aborted caller signal rejects before redeem fetch", async () => {
  const callerSecret = "caller-cancel-ticket-secret";
  const caller = new AbortController();
  caller.abort(new Error(callerSecret));
  let fetchCalls = 0;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse({ token: "must-not-return", user: validUser });
    },
  });

  const error = await rejected(client.redeem(validTicket, { signal: caller.signal }));
  assertGenericClientError(error, 0, callerSecret, validTicket, "must-not-return");
  assert.equal(fetchCalls, 0);
});

test("caller cancellation during fetch aborts the request generically", async () => {
  const fetchSecret = "caller-fetch-provider-secret";
  const caller = trackedAbortController();
  const fetchStarted = deferred();
  let requestSignal;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    fetcher: async (_input, init) => {
      requestSignal = init.signal;
      fetchStarted.resolve();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error(fetchSecret)), { once: true });
      });
    },
  });

  const pending = client.start("web", { signal: caller.signal });
  await fetchStarted.promise;
  caller.controller.abort(new Error("caller-reason-secret"));
  const error = await rejectedWithin(pending);

  assertGenericClientError(error, 0, fetchSecret, "caller-reason-secret");
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("caller cancellation during body read preserves known status and cancels the body", async () => {
  const bodySecret = "caller-body-provider-secret";
  const cancelSecret = "body-cancel-secret";
  const stalled = stallingJsonResponse(bodySecret, { cancelSecret });
  const caller = trackedAbortController();
  let requestSignal;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    async fetcher(_input, init) {
      requestSignal = init.signal;
      return stalled.response;
    },
  });

  const pending = client.capability({ signal: caller.signal });
  await stalled.readStalled;
  caller.controller.abort(new Error("caller-body-reason-secret"));
  const error = await rejectedWithin(pending);

  assertGenericClientError(
    error,
    200,
    bodySecret,
    cancelSecret,
    "caller-body-reason-secret",
  );
  assert.equal(requestSignal.aborted, true);
  assert.equal(stalled.cancelCalls(), 1);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("successful requests clear their deadline and detach caller cancellation", async () => {
  const caller = trackedAbortController();
  let requestSignal;
  const client = createTelegramAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 20,
    async fetcher(_input, init) {
      requestSignal = init.signal;
      return jsonResponse({ method: "oidc" });
    },
  });

  assert.deepEqual(await client.capability({ signal: caller.signal }), { method: "oidc" });
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
  await delay(40);
  caller.controller.abort(new Error("late-caller-secret"));
  assert.equal(requestSignal.aborted, false);
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

async function rejectedWithin(promise, timeoutMs = 500) {
  let watchdog;
  try {
    return await Promise.race([
      rejected(promise),
      new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("test watchdog expired")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
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

function assertGenericClientError(error, status, ...secrets) {
  assert.equal(error.message, "Telegram authentication unavailable");
  assert.equal(error.status, status);
  for (const secret of secrets) assertRedacted(error, secret);
}

function trackedAbortController() {
  const controller = new AbortController();
  const signal = controller.signal;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  let added = 0;
  let removed = 0;
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") added += 1;
    return addEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") removed += 1;
    return removeEventListener(type, listener, options);
  };
  return {
    controller,
    signal,
    listenerCounts: () => ({ added, removed }),
  };
}

function stallingJsonResponse(secret, { cancelSecret = "" } = {}) {
  const readStalled = deferred();
  const never = new Promise(() => {});
  let reads = 0;
  let cancellations = 0;
  const reader = {
    read() {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({
          done: false,
          value: new TextEncoder().encode(`{"method":"oidc","detail":"${secret}`),
        });
      }
      readStalled.resolve();
      return never;
    },
    cancel() {
      cancellations += 1;
      if (cancelSecret) throw new Error(cancelSecret);
      return Promise.resolve();
    },
    releaseLock() {},
  };
  return {
    response: {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { getReader: () => reader },
    },
    readStalled: readStalled.promise,
    cancelCalls: () => cancellations,
  };
}

function stalledRejectedResponse(status) {
  const started = deferred();
  const cancellation = deferred();
  let cancellations = 0;
  return {
    response: {
      ok: false,
      status,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: {
        cancel() {
          cancellations += 1;
          started.resolve();
          return cancellation.promise;
        },
      },
    },
    cancelStarted: started.promise,
    releaseCancel: cancellation.resolve,
    cancelCalls: () => cancellations,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
