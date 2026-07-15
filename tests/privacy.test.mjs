import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = readFileSync("src/app.js", "utf8");

test("privacy notice describes account and gameplay processing in all locales", () => {
  assert.equal(existsSync("src/privacy.html"), true, "privacy notice source must exist");
  const privacy = readFileSync("src/privacy.html", "utf8");

  for (const language of ["ru", "en", "zh-CN"]) {
    assert.match(privacy, new RegExp(`id=["']${language}["']`));
  }
  for (const disclosure of [
    "Telegram ID",
    "Telegram username",
    "profile photo",
    "match statistics",
    "battle replays",
    "Cloudflare Pages",
    "Cloudflare Workers",
    "Cloudflare D1",
    "30 days",
    "without signing in",
    "no advertising",
    "no analytics",
    "session token",
    "https://github.com/agent-axiom/agents-salvo/issues",
  ]) {
    assert.match(privacy, new RegExp(disclosure, "i"));
  }
  assert.match(privacy, /15 July 2026/);
  assert.match(privacy, /until you request deletion/i);
  assert.match(privacy, /do not include.*token|never include.*token/i);
});

test("privacy notice is built and linked from Telegram authentication", () => {
  assert.match(app, /data-action=["']open-privacy["']/);
  assert.match(app, /href=["']\/agents-salvo\/privacy\.html["']/);
  assert.match(app, /canonicalPrivacyUrl/);
  assert.match(app, /platform\.isNative\(\)[\s\S]*platform\.openExternalUrl\(canonicalPrivacyUrl\)/);

  const buildOutput = mkdtempSync(join(tmpdir(), "salvo-privacy-build-"));
  const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
    encoding: "utf8",
    env: { ...process.env, SALVO_BUILD_DIR: buildOutput },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(buildOutput, "privacy.html")), true);
});
