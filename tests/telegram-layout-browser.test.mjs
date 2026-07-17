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
            document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
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

async function dumpDom(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Chrome did not dump layout DOM within 30 seconds: ${stderr}`));
      }
    }, 30_000);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("data-layout=")) {
        settle(() => {
          child.kill("SIGTERM");
          resolve(stdout);
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) => {
      if (!settled) {
        settle(() => reject(new Error(`Chrome exited before dumping layout DOM (code ${code}, signal ${signal}): ${stderr}`)));
      }
    });
  });
}

async function measure() {
  const directory = mkdtempSync(join(tmpdir(), "salvo-layout-"));
  const file = join(directory, "layout.html");
  const profile = join(directory, "chrome-profile");
  try {
    writeFileSync(file, layoutHtml());
    const output = await dumpDom(chromeBinary(), [
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
      "--window-size=360,800",
      "--virtual-time-budget=100",
      "--dump-dom",
      pathToFileURL(file).href,
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    const match = output.match(/data-layout="([^"]+)"/);
    assert.ok(match, "Chrome did not return layout data");
    return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("phone layout uses computed Telegram board and safe-modal geometry without changing web or native replay overflow", async () => {
  const { telegram, web, android: native } = await measure();

  for (const layout of [telegram, web, native]) {
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
