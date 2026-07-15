import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import { verifyRustoreAssets } from "../scripts/verify-rustore-assets.mjs";

function writePng(path, width, height, { alpha = 255, compression = 9, varied = false } = {}) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    const pixel = index / 4;
    png.data[index] = varied ? (pixel * 17) % 256 : 20;
    png.data[index + 1] = varied ? (pixel * 31) % 256 : 20;
    png.data[index + 2] = varied ? (pixel * 47) % 256 : 20;
    png.data[index + 3] = alpha;
  }
  writeFileSync(path, PNG.sync.write(png, { deflateLevel: compression }));
  return path;
}

test("RuStore icon and screenshots satisfy store media constraints", () => {
  const report = verifyRustoreAssets();
  assert.deepEqual(report.errors, []);
  assert.equal(report.icon.width, 512);
  assert.equal(report.icon.height, 512);
  assert.equal(report.icon.opaque, true);
  assert.equal(report.screenshots.length, 5);
  assert.ok(report.screenshots.every(({ width, height, nonblank }) => width === 1080 && height === 1920 && nonblank));
  assert.equal(new Set(report.screenshots.map(({ sha256 }) => sha256)).size, 5);
});

test("RuStore asset verifier reports missing and invalid files", () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-invalid-"));
  const invalid = join(directory, "invalid.png");
  writeFileSync(invalid, "not a png");

  const report = verifyRustoreAssets({
    icon: join(directory, "missing.png"),
    screenshots: [invalid],
  });

  assert.ok(report.errors.some((error) => error.includes("Missing asset")));
  assert.ok(report.errors.some((error) => error.includes("Invalid PNG")));
  assert.ok(report.errors.some((error) => error.includes("Expected 1 screenshots, found 0")));
});

test("RuStore asset verifier rejects unsafe dimensions, opacity, blankness, and duplicates", () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-constraints-"));
  const icon = writePng(join(directory, "icon.png"), 2, 2, { alpha: 100 });
  const screenshot = writePng(join(directory, "screenshot.png"), 2, 2);

  const report = verifyRustoreAssets({
    icon,
    screenshots: [screenshot, screenshot],
  });

  assert.ok(report.errors.includes("RuStore icon must be exactly 512x512 pixels."));
  assert.ok(report.errors.includes("RuStore icon must be fully opaque."));
  assert.ok(report.errors.includes("RuStore icon appears blank."));
  assert.ok(report.errors.some((error) => error.includes("must be exactly 1080x1920")));
  assert.ok(report.errors.some((error) => error.includes("appears blank")));
  assert.ok(report.errors.includes("RuStore screenshots must not contain duplicate files."));
});

test("RuStore asset verifier enforces encoded file-size limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-size-"));
  const icon = writePng(join(directory, "icon.png"), 512, 512, { compression: 0, varied: true });
  const screenshot = writePng(join(directory, "screenshot.png"), 1080, 1920, { compression: 0, varied: true });

  const report = verifyRustoreAssets({ icon, screenshots: [screenshot] });

  assert.ok(report.errors.includes("RuStore icon must be no larger than 1 MB."));
  assert.ok(report.errors.some((error) => error.includes("must be no larger than 3 MB")));
});

test("RuStore asset verifier CLI reports success and missing packages", () => {
  const script = resolve("scripts/verify-rustore-assets.mjs");
  const success = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Verified RuStore icon and 5 screenshots/);

  const emptyDirectory = mkdtempSync(join(tmpdir(), "salvo-rustore-cli-"));
  const failure = spawnSync(process.execPath, [script], { cwd: emptyDirectory, encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Missing asset/);
});
