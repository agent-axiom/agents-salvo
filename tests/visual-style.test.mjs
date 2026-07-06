import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const readText = (path) => readFileSync(join(projectRoot, path), "utf8");

test("visual style defaults to render and moves the simplified toggle into settings", () => {
  const app = readText("src/app.js");

  assert.match(app, /visualStyle:\s*getInitialVisualStyle\(\)/);
  assert.match(app, /localStorage\.getItem\("salvo\.visualStyle"\)/);
  assert.match(app, /return "render";/);
  assert.match(app, /renderSettingsPanel/);
  assert.match(app, /class="settings-panel/);
  assert.match(app, /data-action="visual-style-toggle"/);
  assert.match(app, /dataset\.visualStyle = state\.visualStyle/);
});

test("render visual style has the required image assets", () => {
  const required = [
    "src/assets/images/backgrounds/main-menu-hero-no-ui.png",
    "src/assets/images/backgrounds/main-menu-hero-dark-no-ui.png",
    "src/assets/images/backgrounds/paper-texture-512.png",
    "src/assets/images/backgrounds/paper-texture-dark-512.png",
    "src/assets/images/ships/ship-5-h-normal.png",
    "src/assets/images/ships/ship-5-v-sunk.png",
    "src/assets/images/effects/water-splash.png",
    "src/assets/images/effects/hit-explosion-smoke.png",
    "src/assets/images/effects/sunk-destruction-smoke.png",
    "src/assets/images/markers/cell-target-crosshair.png",
    "src/assets/images/markers/place-ok.png",
    "src/assets/images/markers/place-bad.png",
    "src/assets/images/special/mine.png",
    "src/assets/images/special/minesweeper-2-h-normal.png",
    "src/assets/images/ui/icons/icon-anchor.png",
  ];

  for (const path of required) {
    assert.equal(existsSync(join(projectRoot, path)), true, `Missing ${path}`);
  }
});

test("render visual style uses render-pack assets in css", () => {
  const css = readText("src/styles.css");

  assert.match(css, /data-visual-style="render"/);
  assert.match(css, /paper-texture-512\.png/);
  assert.match(css, /cell-target-crosshair\.png/);
  assert.match(css, /hit-explosion-smoke\.png/);
  assert.match(css, /sunk-destruction-smoke\.png/);
  assert.match(css, /mine\.png/);
});

test("render ship sprites crop stray transparent-margin artifacts", () => {
  const css = readText("src/styles.css");

  assert.match(css, /data-visual-style="render"\] \.ship-sprite-h/);
  assert.match(css, /clip-path:\s*inset\(20% 0 0 0\)/);
  assert.match(css, /background-position:\s*center bottom/);
});

test("render target sunk ships reveal one destroyed ship instead of per-cell craters", () => {
  const app = readText("src/app.js");
  const css = readText("src/styles.css");

  assert.match(app, /function visibleShipForCell/);
  assert.match(app, /kind === "target" \|\| kind === "online-target"/);
  assert.match(app, /cell\.shot === "sunk"/);
  assert.match(app, /shot-sprite-ship-sunk/);
  assert.match(app, /shipId:\s*shot\?\.result === "sunk" \? shot\.shipId \?\? null : null/);
  assert.match(css, /\.shot-sprite-ship-sunk/);
  assert.match(css, /\.shot-sprite-ship-h/);
  assert.match(css, /\.shot-sprite-ship-v/);
});

test("muted audio icon uses a dedicated slash instead of warping the sound arc", () => {
  const css = readText("src/styles.css");

  assert.match(css, /\.audio-toggle:not\(\.is-on\) \.audio-toggle-icon::before/);
  assert.match(css, /\.audio-toggle:not\(\.is-on\) \.audio-toggle-icon \.audio-toggle-slash/);
  assert.doesNotMatch(css, /\.audio-toggle:not\(\.is-on\) \.audio-toggle-icon::after\s*\{[^}]*background:\s*var\(--sunk\)/s);
});
