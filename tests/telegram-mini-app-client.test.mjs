import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramMiniAppAuthClient } from "../src/telegram-mini-app-auth.js";

const responseByteLimit = 16 * 1024;
const validToken = "a".repeat(43);
const validUser = Object.freeze({
  provider: "telegram",
  id: "42",
  name: "Captain Test",
  username: "captain",
  photoUrl: "https://example.test/captain.jpg",
});

test("authenticate sends the exact Mini App request and returns the public session", async () => {
  const requests = [];
  const payload = { token: validToken, user: validUser };
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test/api///",
    async fetcher(input, init) {
      requests.push([input, init]);
      return jsonResponse(payload);
    },
  });

  assert.deepEqual(await client.authenticate("signed-launch-data"), payload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "https://worker.test/api/auth/telegram/miniapp");
  const { signal, ...requestInit } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(requestInit, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"initData":"signed-launch-data"}',
  });
});

test("constructor rejects unsafe worker URLs, fetchers, and timeouts", () => {
  for (const workerUrl of [
    undefined,
    null,
    "",
    " https://worker.test",
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
    assert.throws(() => createTelegramMiniAppAuthClient({
      workerUrl,
      fetcher: async () => {},
    }), { name: "TypeError" }, String(workerUrl));
  }

  for (const fetcher of [null, false, {}, "fetch"]) {
    assert.throws(() => createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher,
    }), { name: "TypeError" });
  }

  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => {},
      timeoutMs,
    }), { name: "TypeError" }, String(timeoutMs));
  }
});

test("authenticate uses a 10-second default deadline", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timerHandle = {};
  let scheduledDelay;
  let clearedHandle;
  globalThis.setTimeout = (_callback, delay) => {
    scheduledDelay = delay;
    return timerHandle;
  };
  globalThis.clearTimeout = (handle) => {
    clearedHandle = handle;
  };

  try {
    const client = createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => jsonResponse({ token: validToken, user: validUser }),
    });

    await client.authenticate("signed-launch-data");
    assert.equal(scheduledDelay, 10_000);
    assert.equal(clearedHandle, timerHandle);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("initData must be a non-empty string no larger than 16 KiB by UTF-8 bytes", async () => {
  let fetchCalls = 0;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse({ token: validToken, user: validUser });
    },
  });

  for (const initData of [undefined, null, "", 42, {}, [], "a".repeat(responseByteLimit + 1)]) {
    await assert.rejects(client.authenticate(initData), { name: "TypeError" }, String(initData));
  }
  await assert.rejects(client.authenticate(`${"a".repeat(responseByteLimit - 1)}é`), {
    name: "TypeError",
  });

  await client.authenticate("é".repeat(responseByteLimit / 2));
  assert.equal(fetchCalls, 1);
});

test("authenticate rejects malformed caller abort signals before fetching", async () => {
  let fetchCalls = 0;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse({ token: validToken, user: validUser });
    },
  });

  for (const signal of [false, {}, { aborted: false }, new EventTarget()]) {
    await assert.rejects(client.authenticate("signed", { signal }), { name: "TypeError" });
  }
  assert.equal(fetchCalls, 0);
});

test("responses require successful JSON with a body no larger than 16 KiB", async () => {
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
    new Response(JSON.stringify({ token: validToken, user: validUser }), {
      status: 200,
      headers: { "Content-Type": "application/problem+json" },
    }),
    new Response(providerSecret, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({
      token: validToken,
      user: validUser,
      padding: `${providerSecret}${"x".repeat(responseByteLimit)}`,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ];

  for (const response of cases) {
    const client = createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => response,
    });
    const error = await rejected(client.authenticate("signed-launch-data"));
    assertGenericClientError(error, response.status, providerSecret);
  }
});

test("non-success responses cancel stalled bodies before request cleanup", async () => {
  const caller = trackedAbortController();
  const stalled = stalledRejectedResponse(503);
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    fetcher: async () => stalled.response,
  });

  const pending = client.authenticate("signed-launch-data", { signal: caller.signal });
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

test("response validation accepts only exact tokens and public Telegram users", async () => {
  const malformed = [
    null,
    [],
    { token: validToken },
    { token: validToken, user: validUser, refreshToken: "refresh-secret" },
    { token: "a".repeat(42), user: validUser },
    { token: "a".repeat(44), user: validUser },
    { token: `${"a".repeat(42)}=`, user: validUser },
    { token: `${"a".repeat(42)}.`, user: validUser },
    { token: validToken, user: null },
    { token: validToken, user: { ...validUser, provider: "evil" } },
    { token: validToken, user: { ...validUser, id: "" } },
    { token: validToken, user: { ...validUser, id: "x".repeat(129) } },
    { token: validToken, user: { ...validUser, name: 42 } },
    { token: validToken, user: { ...validUser, name: "x".repeat(257) } },
    { token: validToken, user: { ...validUser, username: "x".repeat(129) } },
    { token: validToken, user: { ...validUser, photoUrl: "x".repeat(2049) } },
    { token: validToken, user: { ...validUser, privateClaim: "provider-secret" } },
  ];

  for (const payload of malformed) {
    const client = createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => jsonResponse(payload),
    });
    const error = await rejected(client.authenticate("signed-launch-data"));
    assertGenericClientError(error, 200, "refresh-secret", "provider-secret");
  }
});

test("network failures become stable redacted errors with only safe HTTP status", async () => {
  const cases = [
    [new Error("socket failure with provider-secret"), 0],
    [Object.assign(new Error("upstream unavailable with provider-secret"), { status: 503 }), 503],
    [Object.assign(new Error("invalid status with provider-secret"), { status: 999 }), 0],
    [Object.assign(new Error("string status with provider-secret"), { status: "503" }), 0],
  ];

  for (const [sourceError, status] of cases) {
    const client = createTelegramMiniAppAuthClient({
      workerUrl: "https://worker.test",
      fetcher: async () => { throw sourceError; },
    });
    const error = await rejected(client.authenticate("signed-launch-data"));
    assertGenericClientError(error, status, "provider-secret", "signed-launch-data");
    assert.deepEqual(Object.keys(error).sort(), ["status"]);
  }
});

test("request timeout aborts stalled fetches and detaches caller listeners", async () => {
  const caller = trackedAbortController();
  let requestSignal;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 20,
    fetcher: async (_input, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("pending-fetch-provider-secret"));
        }, { once: true });
      });
    },
  });

  const error = await rejectedWithin(client.authenticate("signed", { signal: caller.signal }));
  assertGenericClientError(error, 0, "pending-fetch-provider-secret", "signed");
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("an already-aborted caller rejects before fetch without leaking its reason", async () => {
  const caller = new AbortController();
  caller.abort(new Error("caller-reason-secret"));
  let fetchCalls = 0;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      return jsonResponse({ token: validToken, user: validUser });
    },
  });

  const error = await rejected(client.authenticate("signed-launch-data", { signal: caller.signal }));
  assertGenericClientError(error, 0, "caller-reason-secret", "signed-launch-data");
  assert.equal(fetchCalls, 0);
});

test("caller cancellation aborts an in-flight request and cleans up its listener", async () => {
  const caller = trackedAbortController();
  const fetchStarted = deferred();
  let requestSignal;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    fetcher: async (_input, init) => {
      requestSignal = init.signal;
      fetchStarted.resolve();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("caller-fetch-provider-secret"));
        }, { once: true });
      });
    },
  });

  const pending = client.authenticate("signed-launch-data", { signal: caller.signal });
  await fetchStarted.promise;
  caller.controller.abort(new Error("caller-reason-secret"));
  const error = await rejectedWithin(pending);

  assertGenericClientError(error, 0, "caller-fetch-provider-secret", "caller-reason-secret");
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("caller cancellation during body read cancels the reader and preserves response status", async () => {
  const caller = trackedAbortController();
  const stalled = stallingJsonResponse();
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 1_000,
    fetcher: async () => stalled.response,
  });

  const pending = client.authenticate("signed-launch-data", { signal: caller.signal });
  await stalled.readStalled;
  caller.controller.abort(new Error("caller-body-reason-secret"));
  const error = await rejectedWithin(pending);

  assertGenericClientError(error, 200, "partial-body-provider-secret", "caller-body-reason-secret");
  assert.equal(stalled.cancelCalls(), 1);
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
});

test("successful requests clear their deadline and detach caller cancellation", async () => {
  const caller = trackedAbortController();
  let requestSignal;
  const client = createTelegramMiniAppAuthClient({
    workerUrl: "https://worker.test",
    timeoutMs: 20,
    async fetcher(_input, init) {
      requestSignal = init.signal;
      return jsonResponse({ token: validToken, user: validUser });
    },
  });

  await client.authenticate("signed-launch-data", { signal: caller.signal });
  assert.deepEqual(caller.listenerCounts(), { added: 1, removed: 1 });
  await delay(40);
  caller.controller.abort(new Error("late-caller-secret"));
  assert.equal(requestSignal.aborted, false);
});

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
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function assertGenericClientError(error, status, ...secrets) {
  assert.equal(error instanceof Error, true);
  assert.equal(error.message, "Telegram authentication unavailable");
  assert.equal(error.status, status);
  for (const secret of secrets) {
    assert.equal(error.message.includes(secret), false);
    assert.equal(String(error).includes(secret), false);
  }
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

function stallingJsonResponse() {
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
          value: new TextEncoder().encode('{"token":"partial-body-provider-secret'),
        });
      }
      readStalled.resolve();
      return never;
    },
    cancel() {
      cancellations += 1;
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
