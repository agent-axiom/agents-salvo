import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/styles.css", "utf8");

test("dark theme keeps board grid and water readable against the board surface", () => {
  const vars = themeVariables("dark");
  const paper = parseColor(vars.paper).rgb;
  const surface = blend(parseColor(vars.surface), paper);
  const line = blend(parseColor(vars.line), surface);
  const water = blend(parseColor(vars.water), surface);
  const shipStroke = blend(parseColor(vars["ship-stroke"]), water);
  const primaryInk = parseColor(vars["primary-ink"]).rgb;
  const accent = parseColor(vars.accent).rgb;

  assert.ok(
    contrast(line, surface) >= 3,
    `dark grid line contrast is ${contrast(line, surface).toFixed(2)}`,
  );
  assert.ok(
    contrast(water, surface) >= 1.4,
    `dark water contrast is ${contrast(water, surface).toFixed(2)}`,
  );
  assert.ok(
    contrast(shipStroke, water) >= 2,
    `dark ship stroke contrast is ${contrast(shipStroke, water).toFixed(2)}`,
  );
  assert.ok(
    contrast(primaryInk, accent) >= 4.5,
    `dark primary button contrast is ${contrast(primaryInk, accent).toFixed(2)}`,
  );
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

function parseColor(value) {
  if (value.startsWith("#")) {
    return { rgb: hexToRgb(value), alpha: 1 };
  }

  const match = value.match(/rgba?\(([^)]+)\)/);
  assert.ok(match, `Unsupported color: ${value}`);
  const [red, green, blue, alpha = "1"] = match[1].split(",").map((part) => part.trim());
  return {
    rgb: [Number(red), Number(green), Number(blue)],
    alpha: Number(alpha),
  };
}

function hexToRgb(value) {
  const hex = value.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function blend(foreground, background) {
  return foreground.rgb.map((channel, index) =>
    Math.round(channel * foreground.alpha + background[index] * (1 - foreground.alpha)),
  );
}

function contrast(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function relativeLuminance(rgb) {
  return rgb
    .map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
