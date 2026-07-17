import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const appReference = /src="\.\/(app\.[a-f0-9]{10}\.js)"/g;
const telegramAppReference = /src="\.\.\/(app\.[a-f0-9]{10}\.js)"/g;
const styleReference = /href="\.\/(styles\.[a-f0-9]{10}\.css)"/g;
const telegramStyleReference = /href="\.\.\/(styles\.[a-f0-9]{10}\.css)"/g;

function build({ buildId, cwd = root, output } = {}) {
  const buildOutput =
    output ?? mkdtempSync(join(tmpdir(), "salvo-telegram-build-"));
  const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
    cwd,
    encoding: "utf8",
    env: buildEnvironment(buildOutput, buildId),
  });
  return { output: buildOutput, result };
}

function buildAsync({ buildId, cwd = root, output }) {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, ["scripts/build.mjs"], {
      cwd,
      env: buildEnvironment(output, buildId),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectBuild);
    child.on("close", (status) => {
      resolveBuild({ output, result: { status, stderr, stdout } });
    });
  });
}

function buildEnvironment(output, buildId) {
  const env = { ...process.env, SALVO_BUILD_DIR: output };
  delete env.SALVO_BUILD_ID;
  if (buildId !== undefined) {
    env.SALVO_BUILD_ID = buildId;
  }
  return env;
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

function readArtifacts(output) {
  const web = readFileSync(join(output, "index.html"), "utf8");
  const app = onlyMatch(web, appReference, "web application reference");
  const stylesheet = onlyMatch(web, styleReference, "web stylesheet reference");
  const bundle = readFileSync(join(output, app));
  const map = onlyMatch(
    bundle.toString("utf8"),
    /sourceMappingURL=(app\.[a-f0-9]{10}\.js\.map)/g,
    "application sourcemap reference",
  );
  return { app, bundle, map, stylesheet, web };
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
  const publicationModule = join(root, "scripts/build-publication.mjs");
  if (existsSync(publicationModule)) {
    copyFileSync(
      publicationModule,
      join(isolatedRoot, "scripts/build-publication.mjs"),
    );
  }
  symlinkSync(
    join(root, "node_modules"),
    join(isolatedRoot, "node_modules"),
    "dir",
  );
  return isolatedRoot;
}

function snapshotDirectory(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        files.push([
          relative(directory, path),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]);
      }
    }
  };
  visit(directory);
  return files.sort(([first], [second]) => first.localeCompare(second));
}

function assertNoBuildDebris(output) {
  const name = basename(output);
  const debris = readdirSync(dirname(output)).filter(
    (entry) =>
      entry === `.${name}.lock`
      || entry.startsWith(`.${name}.lock.`)
      || entry.startsWith(`.${name}.stage-`)
      || entry === `.${name}.backup`
      || entry.startsWith(`.${name}.backup-`),
  );
  assert.deepEqual(debris, []);
}

async function loadPublicationModule() {
  const path = join(root, "scripts/build-publication.mjs");
  assert.equal(
    existsSync(path),
    true,
    "build publication recovery module is missing",
  );
  return import(pathToFileURL(path).href);
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

test("bundle, sourcemap, and stylesheet names hash their final emitted bytes", () => {
  const { output, result } = build();
  try {
    assertBuildSucceeded(result);
    const { app, bundle, map, stylesheet } = readArtifacts(output);
    const appHash = app.match(/^app\.([a-f0-9]{10})\.js$/)?.[1];
    const mapHash = map.match(/^app\.([a-f0-9]{10})\.js\.map$/)?.[1];
    const styleHash = stylesheet.match(/^styles\.([a-f0-9]{10})\.css$/)?.[1];

    assert.equal(sha256Prefix(bundle), appHash);
    assert.equal(sha256Prefix(readFileSync(join(output, map))), mapHash);
    assert.equal(sha256Prefix(readFileSync(join(output, stylesheet))), styleHash);
    assert.equal(existsSync(join(output, map)), true);
    assert.equal(existsSync(join(output, "app.js.map")), false);
    assert.equal(count(bundle.toString("utf8"), `sourceMappingURL=${map}`), 1);
    assert.doesNotMatch(bundle.toString("utf8"), /sourceMappingURL=app\.js\.map/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a sourcemap-only source change changes the map URL and final bundle hash", () => {
  const isolatedRoot = makeIsolatedProject();
  const firstOutput = join(isolatedRoot, "first-dist");
  const secondOutput = join(isolatedRoot, "second-dist");
  try {
    const first = build({ cwd: isolatedRoot, output: firstOutput });
    assertBuildSucceeded(first.result);
    const appPath = join(isolatedRoot, "src/app.js");
    writeFileSync(
      appPath,
      `${readFileSync(appPath, "utf8")}\n// Sourcemap-only fixture change.\n`,
    );
    const second = build({ cwd: isolatedRoot, output: secondOutput });
    assertBuildSucceeded(second.result);

    const firstArtifacts = readArtifacts(firstOutput);
    const secondArtifacts = readArtifacts(secondOutput);
    assert.notEqual(secondArtifacts.map, firstArtifacts.map);
    assert.notEqual(secondArtifacts.app, firstArtifacts.app);
    assert.equal(
      sha256Prefix(secondArtifacts.bundle),
      secondArtifacts.app.match(/^app\.([a-f0-9]{10})\.js$/)?.[1],
    );
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("Telegram runtime resolves visual and audio assets beside the shared bundle", async () => {
  const { output, result } = build();
  try {
    assertBuildSucceeded(result);
    const telegram = readFileSync(join(output, "telegram/index.html"), "utf8");
    const app = onlyMatch(
      telegram,
      telegramAppReference,
      "Telegram application reference",
    );
    const telegramDocumentUrl = new URL("https://salvo.example/telegram/index.html");
    const sharedBundleUrl = new URL(`../${app}`, telegramDocumentUrl);
    assert.equal(sharedBundleUrl.pathname, `/${app}`);

    const builtApp = await import(
      `${pathToFileURL(join(output, app)).href}?asset-resolution=${Date.now()}`
    );
    assert.equal(typeof builtApp.assetUrl, "function");
    const visualAssets = [
      "./assets/salvo-board-action.png",
      "./assets/images/backgrounds/main-menu-hero-dark-no-ui.png",
      "./assets/images/ships/ship-4-h-normal.png",
      "./assets/images/effects/hit-explosion-smoke.png",
    ];
    for (const source of visualAssets) {
      assert.equal(new URL(source, sharedBundleUrl).pathname, `/${source.slice(2)}`);
      assert.equal(
        fileURLToPath(builtApp.assetUrl(source)),
        join(realpathSync(output), source.slice(2)),
      );
    }
    assert.deepEqual(
      builtApp.menuMusicTracks.map((source) => fileURLToPath(source)),
      [
        join(realpathSync(output), "assets/audio/menu-loop.mp3"),
        join(realpathSync(output), "assets/audio/menu-loop-v2.mp3"),
      ],
    );

    const appSource = readFileSync(join(root, "src/app.js"), "utf8");
    const audioSource = readFileSync(join(root, "src/core/audio.js"), "utf8");
    assert.match(appSource, /assetUrl\("\.\/assets\/salvo-board-action\.png"\)/);
    assert.match(appSource, /assetUrl\(\s*`\.\/assets\/images\/ships\//);
    assert.match(appSource, /assetUrl\("\.\/assets\/images\/effects\//);
    assert.match(audioSource, /assetUrl\("\.\/assets\/audio\/menu-loop\.mp3"\)/);
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
    assert.deepEqual(
      readFileSync(join(second.output, readArtifacts(second.output).map)),
      readFileSync(join(first.output, readArtifacts(first.output).map)),
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

test("build rejects a temporary symlink destination that resolves outside temp", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-symlink-build-"));
  const externalRoot = mkdtempSync(join(root, ".salvo-external-build-"));
  const externalOutput = join(externalRoot, "published");
  const sentinel = join(externalOutput, "keep.txt");
  mkdirSync(externalOutput);
  writeFileSync(sentinel, "do not delete", "utf8");
  symlinkSync(externalRoot, join(temporaryRoot, "redirect"), "dir");
  try {
    const { result } = build({
      output: join(temporaryRoot, "redirect", "published"),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /temporary directory/i);
    assert.equal(readFileSync(sentinel, "utf8"), "do not delete");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("build rejects a symlinked lock without touching its external target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-lock-symlink-"));
  const externalRoot = mkdtempSync(join(root, ".salvo-external-lock-"));
  const output = join(temporaryRoot, "dist");
  const lockPath = join(temporaryRoot, ".dist.lock");
  writeFileSync(join(externalRoot, "keep.txt"), "do not modify", "utf8");
  writeFileSync(
    join(externalRoot, "owner.json"),
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "external-dead-owner",
    }),
    "utf8",
  );
  const before = snapshotDirectory(externalRoot);
  symlinkSync(externalRoot, lockPath, "dir");
  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build lock path must be a real directory/);
    assert.equal(existsSync(join(externalRoot, ".recovery")), false);
    assert.deepEqual(snapshotDirectory(externalRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("build rejects a non-directory lock with a stable error", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-lock-file-"));
  const output = join(temporaryRoot, "dist");
  const lockPath = join(temporaryRoot, ".dist.lock");
  writeFileSync(lockPath, "unexpected lock node", "utf8");
  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build lock path must be a real directory/);
    assert.equal(readFileSync(lockPath, "utf8"), "unexpected lock node");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("build rejects a symlinked backup without touching its target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-backup-symlink-"));
  const externalRoot = mkdtempSync(join(root, ".salvo-external-backup-"));
  const output = join(temporaryRoot, "dist");
  writeFileSync(join(externalRoot, "keep.txt"), "do not modify", "utf8");
  const before = snapshotDirectory(externalRoot);
  symlinkSync(externalRoot, join(temporaryRoot, ".dist.backup"), "dir");
  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build backup path must be a real directory/);
    assert.deepEqual(snapshotDirectory(externalRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("build rejects a symlinked abandoned stage without touching its target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-stage-symlink-"));
  const externalRoot = mkdtempSync(join(root, ".salvo-external-stage-"));
  const output = join(temporaryRoot, "dist");
  writeFileSync(join(externalRoot, "keep.txt"), "do not modify", "utf8");
  const before = snapshotDirectory(externalRoot);
  symlinkSync(
    externalRoot,
    join(temporaryRoot, ".dist.stage-untrusted"),
    "dir",
  );
  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Build stage path must be a real directory/);
    assert.deepEqual(snapshotDirectory(externalRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("build rejects a symlinked recovery quarantine without touching its target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-quarantine-symlink-"));
  const externalRoot = mkdtempSync(join(root, ".salvo-external-quarantine-"));
  const output = join(temporaryRoot, "dist");
  writeFileSync(join(externalRoot, "keep.txt"), "do not modify", "utf8");
  const before = snapshotDirectory(externalRoot);
  symlinkSync(
    externalRoot,
    join(temporaryRoot, ".dist.lock.recovery-quarantine-untrusted"),
    "dir",
  );
  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Build recovery quarantine path must be a real directory/,
    );
    assert.deepEqual(snapshotDirectory(externalRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("a failed staged build preserves the previously published output", () => {
  const isolatedRoot = makeIsolatedProject();
  const output = join(isolatedRoot, "dist");
  try {
    const first = build({ cwd: isolatedRoot, output });
    assertBuildSucceeded(first.result);
    const before = snapshotDirectory(output);
    const indexPath = join(isolatedRoot, "src/index.html");
    writeFileSync(
      indexPath,
      readFileSync(indexPath, "utf8").replace(
        '<script type="module" src="./app.js"></script>',
        '<script type="module" src="./missing.js"></script>',
      ),
    );

    const failed = build({ cwd: isolatedRoot, output });
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /exactly one occurrence/i);
    assert.deepEqual(snapshotDirectory(output), before);
    assertNoBuildDebris(output);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("an interrupted rename gap restores prior output before replacement", () => {
  const isolatedRoot = makeIsolatedProject();
  const output = join(isolatedRoot, "dist");
  const backup = join(isolatedRoot, ".dist.backup");
  const lock = join(isolatedRoot, ".dist.lock");
  const indexPath = join(isolatedRoot, "src/index.html");
  try {
    const first = build({
      buildId: "before-interruption",
      cwd: isolatedRoot,
      output,
    });
    assertBuildSucceeded(first.result);
    const before = snapshotDirectory(output);

    const publicationModule = pathToFileURL(
      join(isolatedRoot, "scripts/build-publication.mjs"),
    ).href;
    const interrupted = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { mkdir, rename, writeFile } from "node:fs/promises";
          import { join } from "node:path";
          import {
            acquireBuildLock,
            buildStatePaths,
            publishBuild,
            reconcileBuildState,
          } from ${JSON.stringify(publicationModule)};

          const output = ${JSON.stringify(output)};
          const stage = ${JSON.stringify(join(isolatedRoot, ".dist.stage-interrupted"))};
          const lock = await acquireBuildLock(output);
          await reconcileBuildState(output, lock);
          await mkdir(stage);
          await writeFile(join(stage, "partial.txt"), "partial");
          const { backupPath } = buildStatePaths(output);
          await publishBuild(stage, output, {
            async renamePath(from, to) {
              await rename(from, to);
              if (from === output && to === backupPath) {
                process.exit(73);
              }
            },
          });
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(interrupted.status, 73, interrupted.stderr);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(backup), true);
    assert.equal(existsSync(lock), true);

    const validIndex = readFileSync(indexPath, "utf8");
    writeFileSync(
      indexPath,
      validIndex.replace(
        '<script type="module" src="./app.js"></script>',
        '<script type="module" src="./missing.js"></script>',
      ),
    );

    // Consumers wait for the command result; a failed recovery build must leave
    // the previous complete output restored and observable.
    const recoveryBuild = build({ cwd: isolatedRoot, output });
    assert.notEqual(recoveryBuild.result.status, 0);
    assert.match(recoveryBuild.result.stderr, /exactly one occurrence/i);
    assert.equal(
      existsSync(output),
      true,
      "prior output must be restored before new build validation",
    );
    assert.deepEqual(snapshotDirectory(output), before);
    assertNoBuildDebris(output);

    writeFileSync(indexPath, validIndex);
    const replacement = build({
      buildId: "after-recovery",
      cwd: isolatedRoot,
      output,
    });
    assertBuildSucceeded(replacement.result);
    assert.match(
      readFileSync(join(output, "index.html"), "utf8"),
      /buildId: "after-recovery"/,
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("a caught second publication rename failure restores previous output", async () => {
  const { buildStatePaths, publishBuild } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-publish-failure-"));
  const output = join(parent, "dist");
  const stage = mkdtempSync(join(parent, ".dist.stage-"));
  const failure = new Error("injected stage publication failure");
  mkdirSync(output);
  writeFileSync(join(output, "prior.txt"), "prior", "utf8");
  writeFileSync(join(stage, "next.txt"), "next", "utf8");
  try {
    await assert.rejects(
      publishBuild(stage, output, {
        async renamePath(from, to) {
          if (from === stage && to === output) {
            throw failure;
          }
          renameSync(from, to);
        },
      }),
      (error) => error === failure,
    );

    assert.equal(readFileSync(join(output, "prior.txt"), "utf8"), "prior");
    assert.equal(existsSync(stage), true);
    assert.equal(existsSync(buildStatePaths(output).backupPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a dead lock owner is recovered and replaced with owner metadata", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-stale-lock-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-owner",
    }),
    "utf8",
  );
  try {
    const lock = await acquireBuildLock(output, {
      retryMs: 5,
      timeoutMs: 250,
    });
    const owner = JSON.parse(readFileSync(lockOwnerPath, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(typeof owner.timestamp, "number");
    assert.notEqual(owner.token, "dead-owner");
    await releaseBuildLock(lock);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a paused lock candidate cannot overlap another published lock", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-candidate-lock-"));
  const output = join(parent, "dist");
  const { lockPath } = buildStatePaths(output);
  let resumeCandidate;
  const candidateGate = new Promise((resolveGate) => {
    resumeCandidate = resolveGate;
  });
  let reportCandidateReady;
  const candidateReady = new Promise((resolveReady) => {
    reportCandidateReady = resolveReady;
  });
  let firstLock = null;
  let secondLock = null;
  const firstLockPromise = acquireBuildLock(output, {
    async onCandidateReady({ candidatePath, owner, ownerPath }) {
      assert.equal(existsSync(lockPath), false);
      assert.equal(candidatePath.startsWith(`${lockPath}.candidate-`), true);
      assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), owner);
      reportCandidateReady();
      await candidateGate;
    },
    retryMs: 5,
    timeoutMs: 500,
  }).then((lock) => {
    firstLock = lock;
    return lock;
  });

  try {
    await Promise.race([
      candidateReady,
      firstLockPromise.then(() => {
        throw new Error("first lock published before its candidate resumed");
      }),
      delay(250).then(() => {
        throw new Error("lock candidate was not reported ready");
      }),
    ]);

    secondLock = await acquireBuildLock(output, {
      retryMs: 5,
      timeoutMs: 500,
    });
    resumeCandidate();
    await delay(40);
    assert.equal(firstLock, null, "both lock owners became active");

    await releaseBuildLock(secondLock);
    secondLock = null;
    firstLock = await firstLockPromise;
    await releaseBuildLock(firstLock);
    firstLock = null;
    assertNoBuildDebris(output);
  } finally {
    resumeCandidate();
    if (secondLock) {
      await releaseBuildLock(secondLock).catch(() => {});
    }
    if (!firstLock) {
      firstLock = await Promise.race([
        firstLockPromise.catch(() => null),
        delay(300).then(() => null),
      ]);
    }
    if (firstLock) {
      await releaseBuildLock(firstLock).catch(() => {});
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a paused recovery candidate cannot claim a replacement lock", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-recovery-candidate-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-recovery-owner",
    }),
    "utf8",
  );
  let resumeCandidate;
  const candidateGate = new Promise((resolveGate) => {
    resumeCandidate = resolveGate;
  });
  let reportCandidateReady;
  const candidateReady = new Promise((resolveReady) => {
    reportCandidateReady = resolveReady;
  });
  let firstLock = null;
  let secondLock = null;
  const firstLockPromise = acquireBuildLock(output, {
    async onRecoveryCandidateReady({ candidatePath, owner, ownerPath }) {
      assert.equal(existsSync(lockRecoveryPath), false);
      assert.equal(
        candidatePath.startsWith(`${lockPath}.recovery-candidate-`),
        true,
      );
      assert.deepEqual(JSON.parse(readFileSync(ownerPath, "utf8")), owner);
      reportCandidateReady();
      await candidateGate;
    },
    retryMs: 5,
    timeoutMs: 500,
  }).then((lock) => {
    firstLock = lock;
    return lock;
  });

  try {
    await Promise.race([
      candidateReady,
      firstLockPromise.then(() => {
        throw new Error("stale lock recovered before its candidate resumed");
      }),
      delay(250).then(() => {
        throw new Error("recovery candidate was not reported ready");
      }),
    ]);

    secondLock = await acquireBuildLock(output, {
      retryMs: 5,
      timeoutMs: 500,
    });
    resumeCandidate();
    await delay(40);
    assert.equal(firstLock, null, "both recovery owners became active");

    await releaseBuildLock(secondLock);
    secondLock = null;
    firstLock = await firstLockPromise;
    await releaseBuildLock(firstLock);
    firstLock = null;
    assertNoBuildDebris(output);
  } finally {
    resumeCandidate();
    if (secondLock) {
      await releaseBuildLock(secondLock).catch(() => {});
    }
    if (!firstLock) {
      firstLock = await Promise.race([
        firstLockPromise.catch(() => null),
        delay(300).then(() => null),
      ]);
    }
    if (firstLock) {
      await releaseBuildLock(firstLock).catch(() => {});
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a build recovers a claim abandoned immediately after publication", () => {
  const isolatedRoot = makeIsolatedProject();
  const output = join(isolatedRoot, "dist");
  const lockPath = join(isolatedRoot, ".dist.lock");
  const lockOwnerPath = join(lockPath, "owner.json");
  const recoveryPath = join(lockPath, ".recovery");
  const publicationModule = pathToFileURL(
    join(isolatedRoot, "scripts/build-publication.mjs"),
  ).href;
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-lock-before-claim-crash",
    }),
    "utf8",
  );

  try {
    const interrupted = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { acquireBuildLock } from ${JSON.stringify(publicationModule)};

          await acquireBuildLock(${JSON.stringify(output)}, {
            onRecoveryClaimPublished() {
              process.exit(73);
            },
            retryMs: 5,
            timeoutMs: 500,
          });
          process.exit(74);
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(interrupted.status, 73, interrupted.stderr);
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(recoveryPath), true);
    const abandonedOwner = JSON.parse(
      readFileSync(join(recoveryPath, "owner.json"), "utf8"),
    );
    assert.equal(abandonedOwner.pid, interrupted.pid);

    const recovered = build({
      buildId: "after-abandoned-claim",
      cwd: isolatedRoot,
      output,
    });
    assertBuildSucceeded(recovered.result);
    assert.match(
      readFileSync(join(output, "index.html"), "utf8"),
      /buildId: "after-abandoned-claim"/,
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("a live recovery claim is never stolen even after its stale threshold", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-live-recovery-claim-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  const liveClaimOwner = {
    pid: process.pid,
    timestamp: Date.now() - 60 * 60 * 1000,
    token: "live-recovery-claim",
  };
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-lock-with-live-claim",
    }),
    "utf8",
  );
  mkdirSync(lockRecoveryPath);
  writeFileSync(
    join(lockRecoveryPath, "owner.json"),
    JSON.stringify(liveClaimOwner),
    "utf8",
  );

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        retryMs: 5,
        staleMs: 1,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(lockRecoveryPath, "owner.json"), "utf8")),
      liveClaimOwner,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an ownerless recovery claim is recovered only after the stale threshold", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-ownerless-recovery-claim-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-lock-with-ownerless-claim",
    }),
    "utf8",
  );
  mkdirSync(lockRecoveryPath);

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        retryMs: 5,
        staleMs: 60_000,
        timeoutMs: 50,
      }),
      /Timed out waiting for build lock/,
    );
    assert.equal(existsSync(lockRecoveryPath), true);

    const staleTime = new Date(Date.now() - 120_000);
    utimesSync(lockRecoveryPath, staleTime, staleTime);
    const lock = await acquireBuildLock(output, {
      retryMs: 5,
      staleMs: 60_000,
      timeoutMs: 250,
    });
    await releaseBuildLock(lock);
    assert.equal(existsSync(lockPath), false);
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a symlinked recovery claim is rejected without touching its target", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-symlink-recovery-claim-"));
  const external = mkdtempSync(join(tmpdir(), "salvo-external-recovery-claim-"));
  const output = join(parent, "dist");
  const sentinel = join(external, "sentinel.txt");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  writeFileSync(sentinel, "external sentinel", "utf8");
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-lock-with-symlinked-claim",
    }),
    "utf8",
  );
  symlinkSync(external, lockRecoveryPath, "dir");

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        retryMs: 5,
        timeoutMs: 75,
      }),
      /Build lock recovery path must be a real directory/,
    );
    assert.equal(readFileSync(sentinel, "utf8"), "external sentinel");
    assert.deepEqual(readdirSync(external), ["sentinel.txt"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("an old owner cannot release a replacement lock", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-replaced-lock-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath } = buildStatePaths(output);
  const oldLock = await acquireBuildLock(output);
  const retiredPath = `${lockPath}.retired-${oldLock.owner.token}`;
  renameSync(lockPath, retiredPath);
  let replacementLock = null;
  try {
    replacementLock = await acquireBuildLock(output);
    await assert.rejects(
      releaseBuildLock(oldLock),
      /Build lock ownership changed before release/,
    );
    const currentOwner = JSON.parse(readFileSync(lockOwnerPath, "utf8"));
    assert.equal(currentOwner.token, replacementLock.owner.token);
  } finally {
    if (replacementLock) {
      await releaseBuildLock(replacementLock);
    }
    rmSync(retiredPath, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an old lock owned by a live process is never stolen", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-live-lock-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath } = buildStatePaths(output);
  const liveOwner = {
    pid: process.pid,
    timestamp: Date.now() - 60 * 60 * 1000,
    token: "live-owner",
  };
  mkdirSync(lockPath);
  writeFileSync(lockOwnerPath, JSON.stringify(liveOwner), "utf8");
  try {
    await assert.rejects(
      acquireBuildLock(output, {
        retryMs: 5,
        staleMs: 1,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.deepEqual(JSON.parse(readFileSync(lockOwnerPath, "utf8")), liveOwner);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an ownerless lock is recovered only after the stale threshold", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-ownerless-lock-"));
  const output = join(parent, "dist");
  const { lockPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  try {
    await assert.rejects(
      acquireBuildLock(output, {
        retryMs: 5,
        staleMs: 60_000,
        timeoutMs: 50,
      }),
      /Timed out waiting for build lock/,
    );
    assert.equal(existsSync(lockPath), true);

    const staleTime = new Date(Date.now() - 120_000);
    utimesSync(lockPath, staleTime, staleTime);
    const lock = await acquireBuildLock(output, {
      retryMs: 5,
      staleMs: 60_000,
      timeoutMs: 250,
    });
    await releaseBuildLock(lock);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery keeps a completed destination and cleans debris only under lock", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    reconcileBuildState,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-completed-publish-"));
  const output = join(parent, "dist");
  const { backupPath, lockPath } = buildStatePaths(output);
  const stage = join(parent, ".dist.stage-abandoned");
  mkdirSync(output);
  mkdirSync(backupPath);
  mkdirSync(stage);
  writeFileSync(join(output, "current.txt"), "current", "utf8");
  writeFileSync(join(backupPath, "prior.txt"), "prior", "utf8");
  try {
    await assert.rejects(
      reconcileBuildState(output, {
        owner: { pid: process.pid, timestamp: Date.now(), token: "not-owner" },
        path: lockPath,
      }),
      /not owned by this process/,
    );
    assert.equal(existsSync(backupPath), true);
    assert.equal(existsSync(stage), true);

    const lock = await acquireBuildLock(output);
    try {
      await reconcileBuildState(output, lock);
    } finally {
      await releaseBuildLock(lock);
    }
    assert.equal(readFileSync(join(output, "current.txt"), "utf8"), "current");
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(stage), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery removes an abandoned real recovery quarantine under lock", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    reconcileBuildState,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-abandoned-quarantine-"));
  const output = join(parent, "dist");
  const { lockRecoveryQuarantinePrefix } = buildStatePaths(output);
  const quarantine = `${lockRecoveryQuarantinePrefix}abandoned`;
  mkdirSync(quarantine);
  writeFileSync(join(quarantine, "owner.json"), "abandoned", "utf8");

  try {
    const lock = await acquireBuildLock(output);
    try {
      await reconcileBuildState(output, lock);
    } finally {
      await releaseBuildLock(lock);
    }
    assert.equal(existsSync(quarantine), false);
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("concurrent builds to one destination serialize and publish one complete result", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-concurrent-build-"));
  const output = join(parent, "dist");
  try {
    const builds = await Promise.all([
      buildAsync({ buildId: "concurrent-a", output }),
      buildAsync({ buildId: "concurrent-b", output }),
    ]);
    for (const { result } of builds) {
      assertBuildSucceeded(result);
    }

    const web = readFileSync(join(output, "index.html"), "utf8");
    const telegram = readFileSync(join(output, "telegram/index.html"), "utf8");
    const webBuildId = web.match(/buildId: "([^"]+)"/)?.[1];
    const telegramBuildId = telegram.match(/buildId: "([^"]+)"/)?.[1];
    assert.equal(telegramBuildId, webBuildId);
    assert.equal(["concurrent-a", "concurrent-b"].includes(webBuildId), true);
    const { app, map, stylesheet } = readArtifacts(output);
    for (const artifact of [app, map, stylesheet]) {
      assert.equal(existsSync(join(output, artifact)), true, artifact);
    }
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
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
