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
    execFileSync(candidate, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

async function waitForDevToolsPort(profile) {
  const activePortFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(activePortFile)) {
      const [port] = readFileSync(activePortFile, "utf8").trim().split("\n");
      if (/^\d+$/.test(port)) return Number(port);
    }
    await delay(50);
  }
  throw new Error("Chrome did not expose a DevTools port");
}

async function openCdp(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page");
  assert.ok(target?.webSocketDebuggerUrl, "Chrome did not expose a page DevTools target");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const requests = new Map();
  const events = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = requests.get(message.id);
      if (!request) return;
      requests.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.message} (${request.method})`));
      else request.resolve(message.result);
      return;
    }
    const listeners = events.get(message.method) ?? [];
    events.delete(message.method);
    listeners.forEach((listener) => listener(message.params));
  });

  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        requests.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    waitFor(method) {
      return new Promise((resolve) => {
        events.set(method, [...(events.get(method) ?? []), resolve]);
      });
    },
    close() {
      socket.close();
    },
  };
}

async function measure() {
  const directory = mkdtempSync(join(tmpdir(), "salvo-layout-"));
  const file = join(directory, "layout.html");
  const profile = join(directory, "chrome-profile");
  let child = null;
  let cdp = null;
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
    ], { stdio: "ignore" });
    const cdpPort = await waitForDevToolsPort(profile);
    cdp = await openCdp(cdpPort);
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 360,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 360,
      screenHeight: 800,
    });
    const loaded = cdp.waitFor("Page.loadEventFired");
    await cdp.call("Page.navigate", { url: pathToFileURL(file).href });
    await loaded;
    const { result } = await cdp.call("Runtime.evaluate", {
      expression: "document.documentElement.dataset.layout",
      returnByValue: true,
    });
    assert.equal(typeof result.value, "string", "Chrome did not return layout data");
    return JSON.parse(Buffer.from(result.value, "base64").toString("utf8"));
  } finally {
    cdp?.close();
    child?.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
