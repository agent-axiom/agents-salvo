import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");
const css = readFileSync("src/styles.css", "utf8");

test("classic style uses notebook paper colors from the reference", () => {
  const vars = themeVariables("light");

  assert.equal(vars["battle-purple"], "#6f00ff");
  assert.equal(vars["battle-red"], "#e54862");
  assert.equal(vars["notebook-grid"], "rgba(219, 105, 255, 0.52)");
  assert.match(cssRule(".board-grid"), /var\(--notebook-grid\)/);
  assert.match(cssRule(".board-grid"), /var\(--battle-purple\)/);
});

test("classic ships are outlined instead of filled with hatch shading", () => {
  assert.match(app, /shipEdgeClasses\(board, coordinate\)/);
  assert.match(app, /function shipEdgeClasses/);

  const shipRule = cssRule(".cell.has-ship");
  assert.doesNotMatch(shipRule, /repeating-linear-gradient/);
  assert.match(css, /\.cell\.ship-edge-top/);
  assert.match(css, /\.cell\.ship-edge-right/);
  assert.match(css, /var\(--ship-outline\)/);
});

test("classic shot marks use red dots and crosses without glow cards", () => {
  assert.match(cssRule(".cell.miss"), /var\(--battle-red\)/);
  assert.match(cssRule(".cell.hit"), /var\(--battle-red\)/);
  assert.doesNotMatch(cssRule(".cell.hit"), /box-shadow/);
  assert.match(cssRule(".target .cell:not(:disabled):hover"), /rgba\(111,\s*0,\s*255,\s*0\.12\)/);
});

function themeVariables(theme) {
  const pattern =
    theme === "dark"
      ? /:root\[data-theme="dark"\] \{([\s\S]*?)\}/
      : /:root \{([\s\S]*?)\}/;
  const match = css.match(pattern);
  assert.ok(match, `Missing ${theme} theme variables`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [
      key,
      value.trim(),
    ]),
  );
}

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}
