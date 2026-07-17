import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const chromeCandidates = [
  process.env.CHROME_BIN,
  "google-chrome",
  "chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function chromeBinary() {
  for (const candidate of chromeCandidates) {
    if (candidate.includes("/") ? existsSync(candidate) : canRun(candidate)) return candidate;
  }
  assert.fail(`Chrome is required for layout verification; checked ${chromeCandidates.join(", ")}`);
}

function canRun(candidate) {
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

class FakeSocket {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send() {}

  close() {}
}

test("Chrome harness bounds stalled operations", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), "stalled operation", 5),
    /stalled operation timed out after 5ms/,
  );
});

test("Chrome harness retries target discovery and rejects all pending CDP work on socket faults", async () => {
  let targetRequests = 0;
  const socket = new FakeSocket();
  const sessionPromise = openCdp(9222, {
    fetcher: async () => {
      targetRequests += 1;
      if (targetRequests === 1) throw new Error("connection refused");
      return {
        ok: true,
        json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://fake" }],
      };
    },
    webSocketFactory: () => {
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
    retryDelay: () => Promise.resolve(),
    timeoutMs: 50,
  });
  const cdp = await sessionPromise;
  assert.equal(targetRequests, 2);

  const call = cdp.call("Runtime.evaluate");
  const event = cdp.waitFor("Page.loadEventFired");
  socket.emit("close");
  await assert.rejects(call, /Chrome DevTools socket closed/);
  await assert.rejects(event, /Chrome DevTools socket closed/);

  const errorSocket = new FakeSocket();
  const errorCdp = createCdpSession(errorSocket, { timeoutMs: 50 });
  const errorCall = errorCdp.call("Runtime.evaluate");
  const errorEvent = errorCdp.waitFor("Page.loadEventFired");
  errorSocket.emit("error");
  await assert.rejects(errorCall, /Chrome DevTools socket error/);
  await assert.rejects(errorEvent, /Chrome DevTools socket error/);
});

test("Chrome harness waits for graceful exit before using SIGKILL fallback", async () => {
  const listeners = new Map();
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    once(type, listener) {
      listeners.set(type, listener);
    },
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          child.signalCode = "SIGKILL";
          listeners.get("close")?.();
        });
      }
      return true;
    },
  };

  await terminateChrome(child, { gracefulTimeoutMs: 5, killTimeoutMs: 50 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("Chrome harness observes navigation and load failures before cleanup", async () => {
  const unhandled = [];
  const onUnhandledRejection = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  let cleaned = false;
  try {
    await assert.rejects(
      async () => {
        try {
          await navigateAndWait({
            waitFor: () => Promise.reject(new Error("load event failed")),
            call: () => Promise.reject(new Error("navigation failed")),
          }, "file:///layout.html");
        } finally {
          cleaned = true;
        }
      },
      /navigation failed/,
    );
    await delay(0);
    assert.equal(cleaned, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

function board(size, id) {
  const cells = "<button class=\"cell\"></button>".repeat(size * size);
  const labels = "<span>A</span>".repeat(size);
  return `
    <section id="${id}" class="board-panel">
      <div class="board-scroll">
        <div class="coordinate-board" style="--board-size:${size}">
          <span class="grid-corner"></span>
          <div class="column-headers" style="--board-size:${size}">${labels}</div>
          <div class="row-headers" style="--board-size:${size}">${labels}</div>
          <div class="board-grid" style="--board-size:${size}">${cells}</div>
        </div>
      </div>
    </section>`;
}

function layoutHtml() {
  const stylesheet = pathToFileURL(join(process.cwd(), "src/styles.css")).href;
  return `<!doctype html>
    <html data-runtime="telegram" data-theme="light" data-visual-style="render" style="--tg-viewport-stable-height:800px;--tg-content-safe-area-inset-top:40px;--tg-content-safe-area-inset-bottom:40px">
      <head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${stylesheet}"></head>
      <body>
        <main class="shell">
          ${board(10, "setup-10")}
          <div class="replay-board-view" id="replay-16" style="--replay-board-min-width:546px">${board(16, "inside-replay-16")}</div>
        </main>
        <div class="modal-backdrop"><section class="result-modal" id="result-modal"><div style="height:1500px">Result</div></section></div>
        <script>
          const rect = (selector) => { const node = document.querySelector(selector); const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX }; };
          const measure = () => ({
            document: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
            },
            setup: rect("#setup-10 .board-scroll"),
            replay: rect("#replay-16"),
            board: rect("#inside-replay-16 .board-scroll"),
            modal: rect("#result-modal"),
          });
          const payload = Object.fromEntries(["telegram", "web", "android"].map((runtime) => {
            document.documentElement.dataset.runtime = runtime;
            return [runtime, measure()];
          }));
          document.documentElement.dataset.layout = btoa(JSON.stringify(payload));
        </script>
      </body>
    </html>`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(operation, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function observeChrome(child) {
  let failure = null;
  let stderr = "";
  const listeners = new Set();
  const fail = (error) => {
    if (failure) return;
    failure = error;
    listeners.forEach((listener) => listener(error));
    listeners.clear();
  };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  child.once("error", (error) => fail(new Error(`Chrome process error: ${error.message}`)));
  child.once("close", (code, signal) => {
    fail(new Error(`Chrome exited before layout measurement (code ${code}, signal ${signal ?? "none"})`));
  });
  return {
    assertRunning() {
      if (failure) throw failure;
    },
    onFailure(listener) {
      if (failure) listener(failure);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    diagnose(error) {
      const details = stderr.trim();
      return details ? new Error(`${error.message}\nChrome stderr:\n${details}`) : error;
    },
  };
}

async function waitForDevToolsPort(profile, chrome, { timeoutMs = 20_000 } = {}) {
  const activePortFile = join(profile, "DevToolsActivePort");
  return withTimeout((async () => {
    while (true) {
      chrome.assertRunning();
      if (existsSync(activePortFile)) {
        const [port] = readFileSync(activePortFile, "utf8").trim().split("\n");
        if (/^\d+$/.test(port)) return Number(port);
      }
      await delay(50);
    }
  })(), "Chrome startup", timeoutMs);
}

function createCdpSession(socket, { timeoutMs = 10_000 } = {}) {
  let closeError = null;
  const failPending = (error) => {
    if (closeError) return;
    closeError = error;
    for (const { reject, timer } of requests.values()) {
      clearTimeout(timer);
      reject(error);
    }
    requests.clear();
    for (const listeners of events.values()) {
      for (const { reject, timer } of listeners) {
        clearTimeout(timer);
        reject(error);
      }
    }
    events.clear();
  };

  let nextId = 1;
  const requests = new Map();
  const events = new Map();
  socket.addEventListener("message", ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      failPending(new Error("Chrome DevTools returned malformed JSON"));
      return;
    }
    if (message.id) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${message.error.message} (${request.method})`));
      else request.resolve(message.result);
      return;
    }
    const listeners = events.get(message.method) ?? [];
    events.delete(message.method);
    listeners.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve(message.params);
    });
  });
  socket.addEventListener("close", () => failPending(new Error("Chrome DevTools socket closed")));
  socket.addEventListener("error", () => failPending(new Error("Chrome DevTools socket error")));

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error(`Chrome DevTools ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        requests.set(id, { method, resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    },
    waitFor(method) {
      return new Promise((resolve, reject) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        const timer = setTimeout(() => {
          const listeners = events.get(method) ?? [];
          events.set(method, listeners.filter((listener) => listener.timer !== timer));
          reject(new Error(`Chrome DevTools ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        events.set(method, [...(events.get(method) ?? []), { resolve, reject, timer }]);
      });
    },
    close(error = new Error("Chrome DevTools session closed")) {
      failPending(error);
      socket.close();
    },
  };
}

async function openCdp(port, {
  chrome = null,
  fetcher = fetch,
  webSocketFactory = (url) => new WebSocket(url),
  retryDelay = delay,
  timeoutMs = 10_000,
} = {}) {
  const target = await withTimeout((async () => {
    while (true) {
      chrome?.assertRunning();
      try {
        const response = await withTimeout(
          fetcher(`http://127.0.0.1:${port}/json/list`),
          "Chrome DevTools target request",
          Math.min(timeoutMs, 2_000),
        );
        if (!response.ok) throw new Error(`Chrome DevTools target request returned HTTP ${response.status}`);
        const targets = await withTimeout(
          response.json(),
          "Chrome DevTools target response",
          Math.min(timeoutMs, 2_000),
        );
        const page = targets.find((candidate) => candidate.type === "page");
        if (page?.webSocketDebuggerUrl) return page;
      } catch {
        // Chrome may expose the port before it has registered a page target.
      }
      await retryDelay(100);
    }
  })(), "Chrome DevTools target discovery", timeoutMs);

  const socket = webSocketFactory(target.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("close", () => reject(new Error("Chrome DevTools socket closed before opening")), { once: true });
    socket.addEventListener("error", () => reject(new Error("Chrome DevTools socket error before opening")), { once: true });
  }), "Chrome DevTools WebSocket connection", timeoutMs);
  return createCdpSession(socket, { timeoutMs });
}

async function navigateAndWait(cdp, url) {
  const loaded = cdp.waitFor("Page.loadEventFired");
  await Promise.all([
    cdp.call("Page.navigate", { url }),
    loaded,
  ]);
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child) {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
}

async function terminateChrome(child, { gracefulTimeoutMs = 5_000, killTimeoutMs = 2_000 } = {}) {
  if (!child || childHasExited(child)) return;
  child.kill("SIGTERM");
  try {
    await withTimeout(waitForChildExit(child), "Chrome graceful shutdown", gracefulTimeoutMs);
  } catch {
    if (childHasExited(child)) return;
    child.kill("SIGKILL");
    await withTimeout(waitForChildExit(child), "Chrome forced shutdown", killTimeoutMs);
  }
}

async function measure() {
  const directory = mkdtempSync(join(tmpdir(), "salvo-layout-"));
  const file = join(directory, "layout.html");
  const profile = join(directory, "chrome-profile");
  let child = null;
  let cdp = null;
  let chrome = null;
  let stopObserving = null;
  try {
    writeFileSync(file, layoutHtml());
    child = spawn(chromeBinary(), [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--no-service-autorun",
      "--password-store=basic",
      "--use-mock-keychain",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    chrome = observeChrome(child);
    const cdpPort = await waitForDevToolsPort(profile, chrome);
    cdp = await openCdp(cdpPort, { chrome });
    stopObserving = chrome.onFailure((error) => cdp?.close(error));
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 360,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 360,
      screenHeight: 800,
    });
    await navigateAndWait(cdp, pathToFileURL(file).href);
    const { result } = await cdp.call("Runtime.evaluate", {
      expression: "document.documentElement.dataset.layout",
      returnByValue: true,
    });
    assert.equal(typeof result.value, "string", "Chrome did not return layout data");
    return JSON.parse(Buffer.from(result.value, "base64").toString("utf8"));
  } catch (error) {
    throw chrome?.diagnose(error) ?? error;
  } finally {
    stopObserving?.();
    cdp?.close();
    let teardownError = null;
    try {
      await terminateChrome(child);
    } catch (error) {
      teardownError = error;
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (teardownError) throw teardownError;
  }
}

test("phone layout uses computed Telegram board and safe-modal geometry without changing web or native replay overflow", async () => {
  const { telegram, web, android: native } = await measure();

  for (const layout of [telegram, web, native]) {
    assert.equal(layout.document.width, 360, "layout test must use a 360px CSS viewport");
    assert.equal(layout.document.height, 800, "layout test must use an 800px CSS viewport");
    assert.ok(layout.setup.scrollWidth <= layout.setup.clientWidth, "10x10 setup board must fit its phone container");
  }
  assert.ok(telegram.document.scrollWidth <= telegram.document.clientWidth, "Telegram page must not overflow horizontally");
  assert.ok(telegram.replay.scrollWidth <= telegram.replay.clientWidth, "Telegram 16x16 replay must not overflow horizontally");
  assert.ok(telegram.board.scrollWidth <= telegram.board.clientWidth, "Telegram 16x16 replay board must fit its container");
  assert.equal(telegram.replay.overflowX, "hidden", "Telegram replay must clip horizontal board overflow");
  assert.ok(telegram.modal.top >= 40, "Telegram result modal must stay below the top safe inset");
  assert.ok(telegram.modal.bottom <= 760, "Telegram result modal must stay above the bottom safe inset");

  for (const layout of [web, native]) {
    assert.equal(layout.replay.overflowX, "auto", "web and native retain the 16x16 replay scroller");
  }
});
