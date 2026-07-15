#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";

export const rustoreAssetPaths = Object.freeze({
  icon: "distribution/rustore/icon-512.png",
  screenshots: [
    "distribution/rustore/screenshots/01-menu.png",
    "distribution/rustore/screenshots/02-setup.png",
    "distribution/rustore/screenshots/03-battle.png",
    "distribution/rustore/screenshots/04-online.png",
    "distribution/rustore/screenshots/05-training.png",
  ],
});

function inspectPng(path) {
  const bytes = readFileSync(path);
  const png = PNG.sync.read(bytes);
  let opaque = true;
  let minimumLuma = 255;
  let maximumLuma = 0;
  const colors = new Set();

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const alpha = png.data[index + 3];
    if (alpha !== 255) opaque = false;
    const luma = Math.round((red * 299 + green * 587 + blue * 114) / 1000);
    minimumLuma = Math.min(minimumLuma, luma);
    maximumLuma = Math.max(maximumLuma, luma);
    if (colors.size < 256) colors.add(`${red >> 3}:${green >> 3}:${blue >> 3}:${alpha >> 5}`);
  }

  return {
    path,
    width: png.width,
    height: png.height,
    bytes: bytes.length,
    opaque,
    nonblank: maximumLuma - minimumLuma >= 24 && colors.size >= 32,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function inspect(path, errors) {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    errors.push(`Missing asset: ${path}`);
    return null;
  }
  try {
    return inspectPng(absolutePath);
  } catch (error) {
    errors.push(`Invalid PNG ${path}: ${error.message}`);
    return null;
  }
}

export function verifyRustoreAssets(paths = rustoreAssetPaths) {
  const errors = [];
  const icon = inspect(paths.icon, errors);
  const screenshots = paths.screenshots.map((path) => inspect(path, errors)).filter(Boolean);

  if (icon) {
    if (icon.width !== 512 || icon.height !== 512) errors.push("RuStore icon must be exactly 512x512 pixels.");
    if (!icon.opaque) errors.push("RuStore icon must be fully opaque.");
    if (!icon.nonblank) errors.push("RuStore icon appears blank.");
    if (icon.bytes > 1024 * 1024) errors.push("RuStore icon must be no larger than 1 MB.");
  }

  if (screenshots.length !== paths.screenshots.length) {
    errors.push(`Expected ${paths.screenshots.length} screenshots, found ${screenshots.length}.`);
  }
  for (const screenshot of screenshots) {
    if (screenshot.width !== 1080 || screenshot.height !== 1920) {
      errors.push(`${screenshot.path} must be exactly 1080x1920 pixels.`);
    }
    if (!screenshot.nonblank) errors.push(`${screenshot.path} appears blank.`);
    if (screenshot.bytes > 3 * 1024 * 1024) errors.push(`${screenshot.path} must be no larger than 3 MB.`);
  }
  if (new Set(screenshots.map(({ sha256 }) => sha256)).size !== screenshots.length) {
    errors.push("RuStore screenshots must not contain duplicate files.");
  }

  return { icon, screenshots, errors };
}

function runCli() {
  const report = verifyRustoreAssets();
  if (report.errors.length > 0) {
    process.stderr.write(`${report.errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Verified RuStore icon and ${report.screenshots.length} screenshots.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli();
