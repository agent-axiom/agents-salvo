import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appReference = /src="\.\/(app\.[a-f0-9]{10}\.js)"/g;
const telegramAppReference = /src="\.\.\/(app\.[a-f0-9]{10}\.js)"/g;
const styleReference = /href="\.\/(styles\.[a-f0-9]{10}\.css)"/g;
const telegramStyleReference = /href="\.\.\/(styles\.[a-f0-9]{10}\.css)"/g;

function build({ buildId, cwd = root, output } = {}) {
  const buildOutput =
    output ?? mkdtempSync(join(tmpdir(), "salvo-telegram-build-"));
  const env = { ...process.env, SALVO_BUILD_DIR: buildOutput };
  delete env.SALVO_BUILD_ID;
  if (buildId !== undefined) {
    env.SALVO_BUILD_ID = buildId;
  }

  const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { output: buildOutput, result };
}

function assertBuildSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function onlyMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `${label} must occur exactly once`);
  return matches[0][1];
}

function sha256Prefix(source) {
  return createHash("sha256").update(source).digest("hex").slice(0, 10);
}

function extractConfig(source) {
  const config = source.match(/window\.SALVO_CONFIG = \{[\s\S]*?\n\s*\};/)?.[0];
  assert.notEqual(config, undefined, "SALVO_CONFIG is missing");
  return config;
}

function count(source, exact) {
  return source.split(exact).length - 1;
}

function makeIsolatedProject() {
  const isolatedRoot = mkdtempSync(join(tmpdir(), "salvo-build-fixture-"));
  mkdirSync(join(isolatedRoot, "scripts"));
  cpSync(join(root, "src"), join(isolatedRoot, "src"), { recursive: true });
  copyFileSync(
    join(root, "scripts/build.mjs"),
    join(isolatedRoot, "scripts/build.mjs"),
  );
  symlinkSync(
    join(root, "node_modules"),
    join(isolatedRoot, "node_modules"),
    "dir",
  );
  return isolatedRoot;
}

test("build emits web and Telegram shells with one shared hashed app and stylesheet", () => {
  const { output, result } = build();
  try {
    assertBuildSucceeded(result);
    assert.equal(existsSync(join(output, "index.html")), true);
    assert.equal(existsSync(join(output, "telegram/index.html")), true);

    const web = readFileSync(join(output, "index.html"), "utf8");
    const telegram = readFileSync(join(output, "telegram/index.html"), "utf8");
    const webApp = onlyMatch(web, appReference, "web application reference");
    const telegramApp = onlyMatch(
      telegram,
      telegramAppReference,
      "Telegram application reference",
    );
    const webStyle = onlyMatch(web, styleReference, "web stylesheet reference");
    const telegramStyle = onlyMatch(
      telegram,
      telegramStyleReference,
      "Telegram stylesheet reference",
    );

    assert.equal(webApp, telegramApp);
    assert.equal(webStyle, telegramStyle);
    assert.match(web, /<html\b[^>]*\bdata-runtime="web"[^>]*>/);
    assert.match(telegram, /<html\b[^>]*\bdata-runtime="telegram"[^>]*>/);
    assert.doesNotMatch(web, /telegram-web-app\.js/);
    assert.equal(
      count(telegram, "https://telegram.org/js/telegram-web-app.js?63"),
      1,
    );
    assert.equal(
      telegram.indexOf("https://telegram.org/js/telegram-web-app.js?63")
        < telegram.indexOf(`../${telegramApp}`),
      true,
      "Telegram SDK must load before the shared application module",
    );

    const webMetadata = [...web.matchAll(/<meta\b[^>]*>/g)].map(
      (match) => match[0],
    );
    const telegramMetadata = [...telegram.matchAll(/<meta\b[^>]*>/g)].map(
      (match) => match[0],
    );
    assert.deepEqual(telegramMetadata, webMetadata);
    assert.equal(extractConfig(telegram), extractConfig(web));
    assert.match(web, /href="\.\/favicon\.svg"/);
    assert.match(web, /href="\.\/manifest\.webmanifest"/);
    assert.match(telegram, /href="\.\.\/favicon\.svg"/);
    assert.match(telegram, /href="\.\.\/manifest\.webmanifest"/);

    const rootFiles = readdirSync(output);
    assert.deepEqual(rootFiles.filter((file) => /^app\..+\.js$/.test(file)), [
      webApp,
    ]);
    assert.deepEqual(
      rootFiles.filter((file) => /^styles\..+\.css$/.test(file)),
      [webStyle],
    );
    assert.equal(existsSync(join(output, "app.js")), false);
    assert.equal(existsSync(join(output, "styles.css")), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("hashed bundle and stylesheet names match SHA-256 content and the renamed sourcemap", () => {
  const { output, result } = build();
  try {
    assertBuildSucceeded(result);
    const web = readFileSync(join(output, "index.html"), "utf8");
    const app = onlyMatch(web, appReference, "web application reference");
    const stylesheet = onlyMatch(web, styleReference, "web stylesheet reference");
    const appHash = app.match(/^app\.([a-f0-9]{10})\.js$/)?.[1];
    const styleHash = stylesheet.match(/^styles\.([a-f0-9]{10})\.css$/)?.[1];
    const map = `${app}.map`;
    const bundle = readFileSync(join(output, app), "utf8");
    const unhashedMapReference = bundle.replace(
      `sourceMappingURL=${map}`,
      "sourceMappingURL=app.js.map",
    );

    assert.equal(sha256Prefix(unhashedMapReference), appHash);
    assert.equal(sha256Prefix(readFileSync(join(output, stylesheet))), styleHash);
    assert.equal(existsSync(join(output, map)), true);
    assert.equal(existsSync(join(output, "app.js.map")), false);
    assert.equal(count(bundle, `sourceMappingURL=${map}`), 1);
    assert.doesNotMatch(bundle, /sourceMappingURL=app\.js\.map/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("build hashes are deterministic and independent of the shell build ID", () => {
  const first = build();
  const second = build({ buildId: "release_2026.07-17" });
  try {
    assertBuildSucceeded(first.result);
    assertBuildSucceeded(second.result);
    const firstWeb = readFileSync(join(first.output, "index.html"), "utf8");
    const secondWeb = readFileSync(join(second.output, "index.html"), "utf8");
    const firstApp = onlyMatch(firstWeb, appReference, "first application reference");
    const secondApp = onlyMatch(
      secondWeb,
      appReference,
      "second application reference",
    );
    const firstStyle = onlyMatch(
      firstWeb,
      styleReference,
      "first stylesheet reference",
    );
    const secondStyle = onlyMatch(
      secondWeb,
      styleReference,
      "second stylesheet reference",
    );

    assert.equal(secondApp, firstApp);
    assert.equal(secondStyle, firstStyle);
    assert.deepEqual(
      readFileSync(join(second.output, secondApp)),
      readFileSync(join(first.output, firstApp)),
    );
    assert.deepEqual(
      readFileSync(join(second.output, secondStyle)),
      readFileSync(join(first.output, firstStyle)),
    );
  } finally {
    rmSync(first.output, { recursive: true, force: true });
    rmSync(second.output, { recursive: true, force: true });
  }
});

test("build ID defaults to dev and replaces the exact marker once in both shells", () => {
  for (const buildId of [undefined, "release_2026.07-17"]) {
    const expected = buildId ?? "dev";
    const { output, result } = build({ buildId });
    try {
      assertBuildSucceeded(result);
      for (const shell of ["index.html", "telegram/index.html"]) {
        const html = readFileSync(join(output, shell), "utf8");
        assert.equal(count(html, `buildId: "${expected}"`), 1, shell);
        if (buildId !== undefined) {
          assert.equal(count(html, 'buildId: "dev"'), 0, shell);
        }
      }

      const appBundles = readdirSync(output).filter((file) =>
        /^app\.[a-f0-9]{10}\.js$/u.test(file),
      );
      assert.equal(appBundles.length, 1);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});

test("build rejects supplied invalid build IDs", () => {
  for (const buildId of [
    "",
    "contains spaces",
    "a".repeat(65),
    "release/1",
    "r\u00e9lease",
  ]) {
    const { output, result } = build({ buildId });
    try {
      assert.notEqual(
        result.status,
        0,
        `build ID ${JSON.stringify(buildId)} was accepted`,
      );
      assert.match(result.stderr, /SALVO_BUILD_ID/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});

test("build rejects missing or duplicate exact shell replacement markers", () => {
  const cases = [
    {
      file: "src/index.html",
      marker: '<script type="module" src="./app.js"></script>',
      replacement: '<script type="module" src="./missing.js"></script>',
    },
    {
      file: "src/telegram/index.html",
      marker: '<link rel="stylesheet" href="../styles.css" />',
      replacement:
        '<link rel="stylesheet" href="../styles.css" />\n<link rel="stylesheet" href="../styles.css" />',
    },
    {
      file: "src/index.html",
      marker: 'buildId: "dev"',
      replacement: 'buildId: "dev"\n        buildId: "dev"',
    },
  ];

  for (const fixture of cases) {
    const isolatedRoot = makeIsolatedProject();
    const path = join(isolatedRoot, fixture.file);
    try {
      const source = readFileSync(path, "utf8");
      assert.equal(
        count(source, fixture.marker),
        1,
        `${basename(path)} fixture marker`,
      );
      writeFileSync(path, source.replace(fixture.marker, fixture.replacement));

      const { result } = build({
        cwd: isolatedRoot,
        output: join(isolatedRoot, "dist"),
      });
      assert.notEqual(
        result.status,
        0,
        `${fixture.file} malformed template was accepted`,
      );
      assert.match(result.stderr, /exactly one occurrence/i);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }
});
