import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const readText = (path) => readFileSync(join(projectRoot, path), "utf8");

test("visual style defaults to classic and exposes a render toggle", () => {
  const app = readText("src/app.js");

  assert.match(app, /visualStyle:\s*getInitialVisualStyle\(\)/);
  assert.match(app, /localStorage\.getItem\("salvo\.visualStyle"\)/);
  assert.match(app, /return "classic";/);
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
