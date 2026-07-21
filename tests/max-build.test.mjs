import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("build emits a MAX shell using the one shared app bundle", () => {
  const output = mkdtempSync(join(tmpdir(), "salvo-max-build-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SALVO_BUILD_DIR: output,
        SALVO_BUILD_ID: "max-test",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const web = readFileSync(join(output, "index.html"), "utf8");
    const telegram = readFileSync(join(output, "telegram/index.html"), "utf8");
    const max = readFileSync(join(output, "max/index.html"), "utf8");
    const bundle = web.match(/app\.[a-f0-9]{10}\.js/u)?.[0];
    const stylesheet = web.match(/styles\.[a-f0-9]{10}\.css/u)?.[0];

    assert.ok(bundle);
    assert.ok(stylesheet);
    assert.match(max, /<html\b[^>]*\bdata-runtime="max"[^>]*>/u);
    assert.equal(max.split("https://st.max.ru/js/max-web-app.js").length - 1, 1);
    assert.doesNotMatch(web, /max-web-app\.js/u);
    assert.doesNotMatch(telegram, /max-web-app\.js/u);
    assert.match(max, new RegExp(`src="\\.\\.\/${bundle}"`, "u"));
    assert.match(max, new RegExp(`href="\\.\\.\/${stylesheet}"`, "u"));
    assert.equal(
      max.indexOf("https://st.max.ru/js/max-web-app.js")
        < max.indexOf(`../${bundle}`),
      true,
    );
    assert.match(max, /maxBotUsername:\s*"se13661945_bot"/u);
    assert.match(max, /buildId:\s*"max-test"/u);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
