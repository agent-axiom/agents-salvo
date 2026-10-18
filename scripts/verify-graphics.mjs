import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";

// Run after npm run build. All gameplay uses the actual production web bundle.
const buildRoot = resolve(import.meta.dirname, "../dist");
const output = resolve(process.env.SALVO_GRAPHICS_OUTPUT || "/tmp/salvo-graphics");
const contentTypes = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
  ".jpg": "image/jpeg", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg", ".wav": "audio/wav", ".woff2": "font/woff2",
};
const reports = [];
let browser;
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(buildRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${buildRoot}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

await mkdir(output, { recursive: true });
try {
  const shell = await readFile(resolve(buildRoot, "index.html"), "utf8");
  assert.match(shell, /app\.[a-f0-9]{10}\.js/, "Build the production web bundle first");
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const sizes = {
    desktop: { width: 1440, height: 1000 },
    mobile: { width: 390, height: 844 },
    small: { width: 360, height: 800 },
  };
  for (const [size, viewport] of Object.entries(sizes)) {
    for (const theme of ["light", "dark"]) {
      await verifyScenario({ name: `${size}-${theme}`, viewport, theme, origin });
    }
  }
} catch (error) {
  reports.push({ failure: error.stack || String(error) });
  console.error(error.stack || String(error));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(reports, null, 2)}\n`);
  console.log(`Graphics verification ${process.exitCode ? "failed" : "passed"}. Evidence: ${output}`);
}

async function verifyScenario({ name, viewport, theme, origin }) {
  const reducedMotion = name.startsWith("small") ? "reduce" : "no-preference";
  const context = await browser.newContext({ viewport, locale: "ru-RU", colorScheme: theme, reducedMotion });
  const report = { name, viewport, theme, reducedMotion, checks: [], pageErrors: [], localFailures: [], blockedExternalRequests: [] };
  reports.push(report);
  // Exercise local gameplay without contacting production auth, analytics, or rooms.
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.blockedExternalRequests.push(route.request().url());
    return route.abort("internetdisconnected");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().startsWith(`${origin}/`) && response.status() >= 400) {
      report.localFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  try {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator('[data-action="start-agent"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    await capture("menu");

    await page.locator('[data-action="start-agent"]').click();
    await page.locator('[data-action="randomize"]').click();
    assert.equal(await page.locator('[data-action="ready"]').isEnabled(), true, "Random fleet should be playable");
    await assertTextContrast(page, '[data-action="ready"]');
    await capture("setup");

    await page.locator('[data-action="ready"]').click();
    const firstCell = page.locator('.board-grid.target .cell[data-row="0"][data-col="0"]');
    await firstCell.focus();
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await page.evaluate(() => ({ row: document.activeElement.dataset.row, col: document.activeElement.dataset.col })), { row: "0", col: "1" }, "Arrow key should move target focus");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.board-grid.target .cell.miss, .board-grid.target .cell.hit, .board-grid.target .cell.sunk'));
    report.checks.push("keyboard target navigation and firing");
    await capture("battle");

    await page.locator('.settings-button[data-action="toggle-settings"]').click();
    await page.locator(".settings-panel").waitFor({ state: "visible" });
    await assertTextContrast(page, ".auth-privacy a");
    await capture("settings");
    await page.locator('[data-action="theme-toggle"]').click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme === "light" ? "dark" : "light");
    await page.locator('[data-action="theme-toggle"]').click();
    await page.locator('[data-action="visual-style-toggle"]').click();
    assert.equal(await page.locator("html").getAttribute("data-visual-style"), "classic");
    await page.locator('.settings-panel-header [data-action="toggle-settings"]').click();
    await capture("classic-battle");
    report.checks.push("theme and simplified graphics controls");

    assert.deepEqual(report.pageErrors, [], "Application should have no uncaught exceptions");
    assert.deepEqual(report.localFailures, [], "Built scripts, styles and artwork should load");
    console.log(`PASS ${name}: ${report.checks.join("; ")}`);
  } catch (error) {
    report.failure = error.stack || String(error);
    console.error(`FAIL ${name}: ${report.failure}`);
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
  }

  async function capture(screen) {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(output, `${name}-${screen}.png`), fullPage: true, animations: "disabled" });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(dimensions.content <= dimensions.viewport + 1, `${screen} overflows: ${JSON.stringify(dimensions)}`);
    for (const tab of await page.locator('html[data-visual-style="render"] .battle-tabs button:visible').all()) {
      const fits = await tab.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      assert.ok(fits, `${screen}: battle tab text should fit its button`);
    }
    if (reducedMotion === "reduce") {
      const activeAnimations = await page.evaluate(() => document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === "running" && timing?.duration > 1;
      }).length);
      assert.equal(activeAnimations, 0, `${screen} should respect reduced motion`);
    }
    report.checks.push(`${screen}: screenshot and viewport fit`);
  }
}

async function assertTextContrast(page, selector) {
  const ratio = await page.locator(selector).evaluate((element) => {
    const rgb = (color) => color.match(/[\d.]+/g).map(Number);
    const luminance = (channels) => channels.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(rgb(getComputedStyle(element).color));
    let surface = element;
    while (surface) {
      const color = rgb(getComputedStyle(surface).backgroundColor);
      if (color.length === 3 || color[3] === 1) {
        const background = luminance(color);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      }
      surface = surface.parentElement;
    }
    return 0;
  });
  assert.ok(ratio >= 4.5, `${selector} text contrast ${ratio.toFixed(2)} should be at least 4.5:1`);
}
