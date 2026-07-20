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
import { registerHooks } from "node:module";
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

const publicationFsFault = { current: null };
let publicationModulePromise;

async function loadPublicationModule() {
  const path = join(root, "scripts/build-publication.mjs");
  assert.equal(
    existsSync(path),
    true,
    "build publication recovery module is missing",
  );
  publicationModulePromise ??= importWithFsFault(path, publicationFsFault);
  return publicationModulePromise;
}

let faultingImportSequence = 0;

async function importWithFsFault(path, fault) {
  faultingImportSequence += 1;
  const faultKey = `__salvoBuildFsFault${faultingImportSequence}`;
  const targetUrl = new URL(pathToFileURL(path));
  globalThis[faultKey] = fault;

  const wrapperSource = `
    import * as real from "node:fs/promises";
    const fault = globalThis[${JSON.stringify(faultKey)}];
    const call = (name, args) => typeof (fault.current ?? fault)[name] === "function"
      ? (fault.current ?? fault)[name](real, ...args)
      : real[name](...args);
    export const cp = (...args) => call("cp", args);
    export const lstat = (...args) => call("lstat", args);
    export const mkdir = (...args) => call("mkdir", args);
    export const mkdtemp = (...args) => call("mkdtemp", args);
    export const open = (...args) => call("open", args);
    export const readFile = (...args) => call("readFile", args);
    export const readdir = (...args) => call("readdir", args);
    export const realpath = (...args) => call("realpath", args);
    export const rename = (...args) => call("rename", args);
    export const rm = (...args) => call("rm", args);
    export const writeFile = (...args) => call("writeFile", args);
  `;
  const wrapperUrl = `data:text/javascript;base64,${Buffer.from(wrapperSource).toString("base64")}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "node:fs/promises"
        && context.parentURL === targetUrl.href
      ) {
        return { shortCircuit: true, url: wrapperUrl };
      }
      return nextResolve(specifier, context);
    },
  });

  try {
    return await import(targetUrl.href);
  } finally {
    hooks.deregister();
    delete globalThis[faultKey];
  }
}

async function withPublicationFsFault(fault, callback) {
  const publication = await loadPublicationModule();
  assert.equal(publicationFsFault.current, null);
  publicationFsFault.current = fault;
  try {
    return await callback(publication);
  } finally {
    publicationFsFault.current = null;
  }
}

function filesystemError(code, message = `injected ${code} filesystem failure`) {
  return Object.assign(new Error(message), { code });
}

function writeOwner(path, owner) {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, "utf8");
}

function deadOwner(token) {
  return {
    pid: 2_147_483_647,
    timestamp: Date.now(),
    token,
  };
}

function liveOwner(token) {
  return {
    pid: process.pid,
    timestamp: Date.now(),
    token,
  };
}

function createDeadLock(paths, token) {
  mkdirSync(paths.lockPath);
  const owner = deadOwner(token);
  writeOwner(paths.lockOwnerPath, owner);
  return owner;
}

function createDeadRecoveryClaim(paths, token) {
  mkdirSync(paths.lockRecoveryPath);
  const owner = deadOwner(token);
  writeOwner(join(paths.lockRecoveryPath, "owner.json"), owner);
  return owner;
}

test("build emits web and Telegram shells with one shared hashed app and stylesheet", async () => {
  const { output, result } = build();
  try {
    assertBuildSucceeded(result);
    assert.equal(existsSync(join(output, "index.html")), true);
    assert.equal(existsSync(join(output, "telegram/index.html")), true);
    assert.equal(existsSync(join(output, "support.html")), true);
    const supportTerms = readFileSync(join(output, "support.html"), "utf8");
    assert.match(supportTerms, /rel="canonical" href="https:\/\/agent-axiom\.github\.io\/agents-salvo\/support\.html"/u);
    assert.match(supportTerms, /<section id="ru"[\s\S]*<section id="en"[\s\S]*<section id="zh-CN"/u);

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
    const { default: capacitorConfig } = await import(`${pathToFileURL(join(root, "capacitor.config.ts")).href}?build=${Date.now()}`);
    assert.equal(capacitorConfig.webDir, "dist", "Android and iOS must consume the shared dist assets");
    assert.equal(typeof capacitorConfig.android, "object");
    assert.equal(typeof capacitorConfig.ios, "object");
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

test("build rejects a cyclic destination symlink without creating state", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "salvo-cyclic-build-"));
  const output = join(temporaryRoot, "loop");
  symlinkSync("loop", output);

  try {
    const { result } = build({ output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ELOOP|too many symbolic links/i);
    assert.deepEqual(readdirSync(temporaryRoot), ["loop"]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("a shell validation failure removes its stage and preserves prior output", async () => {
  const output = join(root, "dist");
  const outputExisted = existsSync(output);
  if (!outputExisted) {
    mkdirSync(output);
    writeFileSync(join(output, "prior.txt"), "prior", "utf8");
  }
  const before = snapshotDirectory(output);
  const previousBuildDir = process.env.SALVO_BUILD_DIR;
  delete process.env.SALVO_BUILD_DIR;

  try {
    await loadPublicationModule();
    await assert.rejects(
      importWithFsFault(join(root, "scripts/build.mjs"), {
        async readFile(real, path, options) {
          const source = await real.readFile(path, options);
          if (
            basename(path) === "index.html"
            && basename(dirname(path)).startsWith(".dist.stage-")
          ) {
            return source.replace(
              '<script type="module" src="./app.js"></script>',
              '<script type="module" src="./missing.js"></script>',
            );
          }
          return source;
        },
      }),
      /application reference must have exactly one occurrence/i,
    );
    assert.deepEqual(snapshotDirectory(output), before);
    assertNoBuildDebris(output);
  } finally {
    if (previousBuildDir === undefined) {
      delete process.env.SALVO_BUILD_DIR;
    } else {
      process.env.SALVO_BUILD_DIR = previousBuildDir;
    }
    if (!outputExisted) {
      rmSync(output, { recursive: true, force: true });
    }
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

test("a durable lock owner write failure removes its candidate", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-owner-write-failure-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EACCES", "injected owner write denial");
  let candidatePath;

  try {
    await withPublicationFsFault(
      {
        open(real, path, ...args) {
          if (basename(dirname(path)).startsWith(".dist.lock.candidate-")) {
            candidatePath = dirname(path);
            throw failure;
          }
          return real.open(path, ...args);
        },
      },
      async ({ acquireBuildLock }) => {
        await assert.rejects(
          acquireBuildLock(output),
          (error) => error === failure,
        );
      },
    );
    assert.equal(existsSync(candidatePath), false);
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a vanished durable-owner candidate preserves the write failure", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-owner-candidate-vanished-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EACCES", "injected owner write denial");
  let candidatePath;

  try {
    await withPublicationFsFault(
      {
        async open(real, path, ...args) {
          if (basename(dirname(path)).startsWith(".dist.lock.candidate-")) {
            candidatePath = dirname(path);
            await real.rm(candidatePath, { recursive: true, force: true });
            throw failure;
          }
          return real.open(path, ...args);
        },
      },
      async ({ acquireBuildLock }) => {
        await assert.rejects(
          acquireBuildLock(output),
          (error) => error === failure,
        );
      },
    );
    assert.equal(existsSync(candidatePath), false);
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("durable-owner cleanup refuses a replacement candidate inode", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-owner-candidate-replaced-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EACCES", "injected owner write denial");
  let candidatePath;
  let retiredPath;

  try {
    await withPublicationFsFault(
      {
        async open(real, path, ...args) {
          if (basename(dirname(path)).startsWith(".dist.lock.candidate-")) {
            candidatePath = dirname(path);
            retiredPath = `${candidatePath}.retired`;
            await real.rename(candidatePath, retiredPath);
            await real.mkdir(candidatePath);
            throw failure;
          }
          return real.open(path, ...args);
        },
      },
      async ({ acquireBuildLock }) => {
        await assert.rejects(
          acquireBuildLock(output),
          /Build lock candidate ownership changed before cleanup/,
        );
      },
    );
    assert.equal(existsSync(candidatePath), true);
    assert.equal(existsSync(retiredPath), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale recovery yields when the inspected lock disappears", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-disappears-"));
  const output = join(parent, "dist");
  let lock;

  try {
    await withPublicationFsFault(
      {
        removed: false,
        async readFile(real, path, ...args) {
          const source = await real.readFile(path, ...args);
          if (!this.removed && path === this.ownerPath) {
            this.removed = true;
            await real.rm(this.lockPath, { recursive: true, force: true });
          }
          return source;
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-disappearance");
        publicationFsFault.current.lockPath = paths.lockPath;
        publicationFsFault.current.ownerPath = paths.lockOwnerPath;
        lock = await publication.acquireBuildLock(output, {
          retryMs: 5,
          timeoutMs: 250,
        });
        assert.notEqual(lock.owner.token, "dead-lock-before-disappearance");
        await publication.releaseBuildLock(lock);
        lock = null;
      },
    );
    assertNoBuildDebris(output);
  } finally {
    if (lock) {
      const { releaseBuildLock } = await loadPublicationModule();
      await releaseBuildLock(lock).catch(() => {});
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale recovery preserves a replacement lock found after inspection", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-replaced-after-read-"));
  const output = join(parent, "dist");
  const replacement = liveOwner("replacement-after-stale-inspection");

  try {
    await withPublicationFsFault(
      {
        replaced: false,
        async readFile(real, path, ...args) {
          const source = await real.readFile(path, ...args);
          if (!this.replaced && path === this.ownerPath) {
            this.replaced = true;
            await real.rename(this.lockPath, this.retiredPath);
            await real.mkdir(this.lockPath);
            await real.writeFile(this.ownerPath, JSON.stringify(replacement));
          }
          return source;
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-replacement");
        publicationFsFault.current.lockPath = paths.lockPath;
        publicationFsFault.current.ownerPath = paths.lockOwnerPath;
        publicationFsFault.current.retiredPath = `${paths.lockPath}.retired`;
        await assert.rejects(
          publication.acquireBuildLock(output, {
            retryMs: 5,
            timeoutMs: 75,
          }),
          /Timed out waiting for build lock/,
        );
        assert.deepEqual(
          JSON.parse(readFileSync(paths.lockOwnerPath, "utf8")),
          replacement,
        );
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery retries when its prepared candidate disappears", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-recovery-candidate-missing-"));
  const output = join(parent, "dist");
  let lock;

  try {
    await withPublicationFsFault(
      {
        injected: false,
        async rename(real, from, to) {
          if (!this.injected && from.startsWith(this.candidatePrefix)) {
            this.injected = true;
            await real.rm(from, { recursive: true, force: true });
            throw filesystemError("ENOENT");
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-candidate-loss");
        publicationFsFault.current.candidatePrefix =
          paths.lockRecoveryCandidatePrefix;
        lock = await publication.acquireBuildLock(output, {
          retryMs: 5,
          timeoutMs: 250,
        });
        await publication.releaseBuildLock(lock);
        lock = null;
      },
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery propagates a non-contention candidate publication failure", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-recovery-publish-denied-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EACCES", "injected recovery publication denial");

  try {
    await withPublicationFsFault(
      {
        rename(real, from, to) {
          if (from.startsWith(this.candidatePrefix)) {
            throw failure;
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-recovery-denial");
        publicationFsFault.current.candidatePrefix =
          paths.lockRecoveryCandidatePrefix;
        await assert.rejects(
          publication.acquireBuildLock(output),
          (error) => error === failure,
        );
        assert.equal(existsSync(paths.lockRecoveryPath), false);
        assert.equal(
          readdirSync(parent).some((entry) =>
            entry.startsWith(".dist.lock.recovery-candidate-")),
          false,
        );
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery yields to a winner after candidate rename contention", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-recovery-rename-winner-"));
  const output = join(parent, "dist");
  const winner = liveOwner("recovery-rename-winner");

  try {
    await withPublicationFsFault(
      {
        injected: false,
        async rename(real, from, to) {
          if (!this.injected && from.startsWith(this.candidatePrefix)) {
            this.injected = true;
            await real.mkdir(to);
            await real.writeFile(join(to, "owner.json"), JSON.stringify(winner));
            throw filesystemError("EEXIST");
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-recovery-winner");
        publicationFsFault.current.candidatePrefix =
          paths.lockRecoveryCandidatePrefix;
        await assert.rejects(
          publication.acquireBuildLock(output, {
            retryMs: 5,
            timeoutMs: 75,
          }),
          /Timed out waiting for build lock/,
        );
        assert.deepEqual(
          JSON.parse(
            readFileSync(join(paths.lockRecoveryPath, "owner.json"), "utf8"),
          ),
          winner,
        );
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("abandoned recovery quarantine retries a generated-name collision", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-quarantine-collision-"));
  const output = join(parent, "dist");
  let lock;

  try {
    await withPublicationFsFault(
      {
        injected: false,
        rename(real, from, to) {
          if (
            !this.injected
            && from === this.recoveryPath
            && to.startsWith(this.quarantinePrefix)
          ) {
            this.injected = true;
            throw filesystemError("EEXIST");
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-with-colliding-quarantine");
        createDeadRecoveryClaim(paths, "dead-recovery-with-name-collision");
        publicationFsFault.current.recoveryPath = paths.lockRecoveryPath;
        publicationFsFault.current.quarantinePrefix =
          paths.lockRecoveryQuarantinePrefix;
        lock = await publication.acquireBuildLock(output, {
          retryMs: 5,
          timeoutMs: 250,
        });
        await publication.releaseBuildLock(lock);
        lock = null;
      },
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("abandoned recovery quarantine propagates an unexpected rename failure", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-quarantine-denied-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EACCES", "injected quarantine rename denial");

  try {
    await withPublicationFsFault(
      {
        rename(real, from, to) {
          if (
            from === this.recoveryPath
            && to.startsWith(this.quarantinePrefix)
          ) {
            throw failure;
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-quarantine-denial");
        createDeadRecoveryClaim(paths, "dead-recovery-before-quarantine-denial");
        publicationFsFault.current.recoveryPath = paths.lockRecoveryPath;
        publicationFsFault.current.quarantinePrefix =
          paths.lockRecoveryQuarantinePrefix;
        await assert.rejects(
          publication.acquireBuildLock(output),
          (error) => error === failure,
        );
        assert.equal(existsSync(paths.lockRecoveryPath), true);
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a recovery claim refreshed during quarantine is restored", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-quarantine-refresh-"));
  const output = join(parent, "dist");
  const refreshed = liveOwner("refreshed-during-quarantine");

  try {
    await withPublicationFsFault(
      {
        async rename(real, from, to) {
          await real.rename(from, to);
          if (
            from === this.recoveryPath
            && to.startsWith(this.quarantinePrefix)
          ) {
            await real.writeFile(join(to, "owner.json"), JSON.stringify(refreshed));
          }
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-claim-refresh");
        createDeadRecoveryClaim(paths, "dead-recovery-before-refresh");
        publicationFsFault.current.recoveryPath = paths.lockRecoveryPath;
        publicationFsFault.current.quarantinePrefix =
          paths.lockRecoveryQuarantinePrefix;
        await assert.rejects(
          publication.acquireBuildLock(output, {
            retryMs: 5,
            timeoutMs: 75,
          }),
          /Timed out waiting for build lock/,
        );
        assert.deepEqual(
          JSON.parse(
            readFileSync(join(paths.lockRecoveryPath, "owner.json"), "utf8"),
          ),
          refreshed,
        );
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery continues when a refreshed quarantine disappears before restore", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-quarantine-restore-missing-"));
  const output = join(parent, "dist");
  let lock;

  try {
    await withPublicationFsFault(
      {
        async rename(real, from, to) {
          if (
            from === this.recoveryPath
            && to.startsWith(this.quarantinePrefix)
          ) {
            await real.rename(from, to);
            await real.writeFile(
              join(to, "owner.json"),
              JSON.stringify(liveOwner("refresh-before-disappearance")),
            );
            return;
          }
          if (
            from.startsWith(this.quarantinePrefix)
            && to === this.recoveryPath
          ) {
            await real.rm(from, { recursive: true, force: true });
            throw filesystemError("ENOENT");
          }
          return real.rename(from, to);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-missing-restore");
        createDeadRecoveryClaim(paths, "dead-recovery-before-missing-restore");
        publicationFsFault.current.recoveryPath = paths.lockRecoveryPath;
        publicationFsFault.current.quarantinePrefix =
          paths.lockRecoveryQuarantinePrefix;
        lock = await publication.acquireBuildLock(output, {
          retryMs: 5,
          timeoutMs: 250,
        });
        await publication.releaseBuildLock(lock);
        lock = null;
      },
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale recovery preserves a replacement lock installed after its claim", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-replaced-after-claim-"));
  const output = join(parent, "dist");
  const replacement = liveOwner("replacement-after-recovery-claim");

  try {
    await withPublicationFsFault(
      {
        claimPublished: false,
        replaced: false,
        async lstat(real, path, ...args) {
          const stats = await real.lstat(path, ...args);
          if (this.claimPublished && !this.replaced && path === this.lockPath) {
            this.replaced = true;
            await real.rename(this.lockPath, this.retiredPath);
            await real.mkdir(this.lockPath);
            await real.writeFile(this.ownerPath, JSON.stringify(replacement));
          }
          return stats;
        },
        async rename(real, from, to) {
          await real.rename(from, to);
          if (from.startsWith(this.candidatePrefix) && to === this.recoveryPath) {
            this.claimPublished = true;
          }
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-post-claim-replacement");
        Object.assign(publicationFsFault.current, {
          candidatePrefix: paths.lockRecoveryCandidatePrefix,
          lockPath: paths.lockPath,
          ownerPath: paths.lockOwnerPath,
          recoveryPath: paths.lockRecoveryPath,
          retiredPath: `${paths.lockPath}.retired`,
        });
        await assert.rejects(
          publication.acquireBuildLock(output, {
            retryMs: 5,
            timeoutMs: 75,
          }),
          /Timed out waiting for build lock/,
        );
        assert.deepEqual(
          JSON.parse(readFileSync(paths.lockOwnerPath, "utf8")),
          replacement,
        );
        assert.equal(existsSync(paths.lockRecoveryPath), false);
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale recovery tolerates a lock removed after its claim", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-removed-after-claim-"));
  const output = join(parent, "dist");
  let lock;

  try {
    await withPublicationFsFault(
      {
        claimPublished: false,
        removed: false,
        async lstat(real, path, ...args) {
          const stats = await real.lstat(path, ...args);
          if (this.claimPublished && !this.removed && path === this.lockPath) {
            this.removed = true;
            await real.rm(this.lockPath, { recursive: true, force: true });
          }
          return stats;
        },
        async rename(real, from, to) {
          await real.rename(from, to);
          if (from.startsWith(this.candidatePrefix) && to === this.recoveryPath) {
            this.claimPublished = true;
          }
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "dead-lock-before-post-claim-removal");
        Object.assign(publicationFsFault.current, {
          candidatePrefix: paths.lockRecoveryCandidatePrefix,
          lockPath: paths.lockPath,
          recoveryPath: paths.lockRecoveryPath,
        });
        lock = await publication.acquireBuildLock(output, {
          retryMs: 5,
          timeoutMs: 250,
        });
        await publication.releaseBuildLock(lock);
        lock = null;
      },
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock inspection fails closed when owner metadata cannot be read", async () => {
  const parent = mkdtempSync(join(tmpdir(), "salvo-owner-read-failure-"));
  const output = join(parent, "dist");
  const failure = filesystemError("EIO", "injected owner metadata read failure");

  try {
    await withPublicationFsFault(
      {
        readFile(real, path, ...args) {
          if (path === this.ownerPath) {
            throw failure;
          }
          return real.readFile(path, ...args);
        },
      },
      async (publication) => {
        const paths = publication.buildStatePaths(output);
        createDeadLock(paths, "unreadable-dead-lock-owner");
        publicationFsFault.current.ownerPath = paths.lockOwnerPath;
        await assert.rejects(
          publication.acquireBuildLock(output),
          (error) => error === failure,
        );
        assert.equal(existsSync(paths.lockPath), true);
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
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

test("publication reports both the publish failure and failed rollback", async () => {
  const { buildStatePaths, publishBuild } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-publish-rollback-failure-"));
  const output = join(parent, "dist");
  const stage = mkdtempSync(join(parent, ".dist.stage-"));
  const publishFailure = new Error("injected publication failure");
  const rollbackFailure = new Error("injected rollback failure");
  mkdirSync(output);
  writeFileSync(join(output, "prior.txt"), "prior", "utf8");
  writeFileSync(join(stage, "next.txt"), "next", "utf8");
  let renameCount = 0;

  try {
    await assert.rejects(
      publishBuild(stage, output, {
        async renamePath(from, to) {
          renameCount += 1;
          if (renameCount === 1) {
            renameSync(from, to);
            return;
          }
          throw renameCount === 2 ? publishFailure : rollbackFailure;
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.deepEqual(error.errors, [publishFailure, rollbackFailure]);
        assert.match(error.message, /previous output remains/);
        return true;
      },
    );

    const { backupPath } = buildStatePaths(output);
    assert.equal(existsSync(output), false);
    assert.equal(readFileSync(join(backupPath, "prior.txt"), "utf8"), "prior");
    assert.equal(readFileSync(join(stage, "next.txt"), "utf8"), "next");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("publication leaves output and stage untouched when backup creation fails", async () => {
  const { buildStatePaths, publishBuild } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-backup-rename-failure-"));
  const output = join(parent, "dist");
  const stage = mkdtempSync(join(parent, ".dist.stage-"));
  const failure = Object.assign(new Error("injected backup rename failure"), {
    code: "EACCES",
  });
  mkdirSync(output);
  writeFileSync(join(output, "prior.txt"), "prior", "utf8");
  writeFileSync(join(stage, "next.txt"), "next", "utf8");

  try {
    await assert.rejects(
      publishBuild(stage, output, {
        async renamePath() {
          throw failure;
        },
      }),
      (error) => error === failure,
    );

    assert.equal(readFileSync(join(output, "prior.txt"), "utf8"), "prior");
    assert.equal(readFileSync(join(stage, "next.txt"), "utf8"), "next");
    assert.equal(existsSync(buildStatePaths(output).backupPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("recovery restores a backup when publication stopped in the rename gap", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    reconcileBuildState,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-direct-backup-recovery-"));
  const output = join(parent, "dist");
  const { backupPath } = buildStatePaths(output);
  mkdirSync(backupPath);
  writeFileSync(join(backupPath, "prior.txt"), "prior", "utf8");
  let lock;

  try {
    lock = await acquireBuildLock(output);
    await reconcileBuildState(output, lock);

    assert.equal(readFileSync(join(output, "prior.txt"), "utf8"), "prior");
    assert.equal(existsSync(backupPath), false);
  } finally {
    if (lock) {
      await releaseBuildLock(lock);
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("one destination lock cannot authorize recovery for another destination", async () => {
  const {
    acquireBuildLock,
    reconcileBuildState,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-cross-destination-lock-"));
  const firstOutput = join(parent, "first-dist");
  const secondOutput = join(parent, "second-dist");
  const lock = await acquireBuildLock(firstOutput);

  try {
    await assert.rejects(
      reconcileBuildState(secondOutput, lock),
      /Build lock is not owned by this process/,
    );
    assert.equal(existsSync(secondOutput), false);
  } finally {
    await releaseBuildLock(lock);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("publication accepts only generated stage siblings under the destination parent", async () => {
  const { publishBuild } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-stage-boundary-"));
  const externalParent = mkdtempSync(join(tmpdir(), "salvo-external-stage-boundary-"));
  const output = join(parent, "dist");
  const ordinarySibling = join(parent, "ordinary-stage");
  const externalStage = join(externalParent, ".dist.stage-external");
  mkdirSync(ordinarySibling);
  mkdirSync(externalStage);

  try {
    await assert.rejects(
      publishBuild(externalStage, output),
      /must remain under the canonical build destination parent/,
    );
    await assert.rejects(
      publishBuild(ordinarySibling, output),
      /must be a generated sibling of the destination/,
    );
    assert.equal(existsSync(ordinarySibling), true);
    assert.equal(existsSync(externalStage), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(externalParent, { recursive: true, force: true });
  }
});

test("lock acquisition validates lifecycle hooks before creating state", async () => {
  const { acquireBuildLock } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-hook-validation-"));
  const output = join(parent, "dist");
  const cases = [
    ["onCandidateReady", /onCandidateReady must be a function/],
    ["onRecoveryCandidateReady", /onRecoveryCandidateReady must be a function/],
    ["onRecoveryClaimPublished", /onRecoveryClaimPublished must be a function/],
  ];

  try {
    for (const [name, message] of cases) {
      await assert.rejects(
        acquireBuildLock(output, { [name]: true }),
        (error) => error instanceof TypeError && message.test(error.message),
      );
    }
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock acquisition fails cleanly when the destination parent is missing", async () => {
  const { acquireBuildLock } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-missing-lock-parent-"));
  const missingParent = join(parent, "missing");
  const output = join(missingParent, "dist");

  try {
    await assert.rejects(
      acquireBuildLock(output),
      (error) => error?.code === "ENOENT",
    );
    assert.equal(existsSync(missingParent), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock acquisition rejects a candidate removed before publication", async () => {
  const { acquireBuildLock } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-missing-lock-candidate-"));
  const output = join(parent, "dist");

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onCandidateReady({ candidatePath }) {
          rmSync(candidatePath, { recursive: true, force: true });
        },
      }),
      (error) => error?.code === "ENOENT",
    );
    assertNoBuildDebris(output);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock acquisition refuses to clean a replaced candidate directory", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-replaced-lock-candidate-"));
  const output = join(parent, "dist");
  const { lockPath } = buildStatePaths(output);
  let candidatePath;
  let retiredPath;

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onCandidateReady(candidate) {
          candidatePath = candidate.candidatePath;
          retiredPath = `${candidatePath}.retired`;
          renameSync(candidatePath, retiredPath);
          mkdirSync(candidatePath);
          writeFileSync(candidate.ownerPath, JSON.stringify(candidate.owner), "utf8");
          mkdirSync(lockPath);
        },
      }),
      /Build lock candidate ownership changed before cleanup/,
    );
    assert.equal(existsSync(candidatePath), true);
    assert.equal(existsSync(retiredPath), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock acquisition refuses to clean a candidate with replaced owner metadata", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-replaced-candidate-owner-"));
  const output = join(parent, "dist");
  const { lockPath } = buildStatePaths(output);
  let candidatePath;

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onCandidateReady(candidate) {
          candidatePath = candidate.candidatePath;
          writeFileSync(
            candidate.ownerPath,
            JSON.stringify({ ...candidate.owner, token: "replacement-owner" }),
            "utf8",
          );
          mkdirSync(lockPath);
        },
      }),
      /Build lock candidate ownership changed before cleanup/,
    );
    assert.equal(existsSync(candidatePath), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale lock recovery preserves an owner installed after the claim", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-recovery-owner-race-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  const deadOwner = {
    pid: 2_147_483_647,
    timestamp: Date.now(),
    token: "dead-owner-before-recovery-claim",
  };
  const replacementOwner = {
    pid: process.pid,
    timestamp: Date.now(),
    token: "live-owner-after-recovery-claim",
  };
  mkdirSync(lockPath);
  writeFileSync(lockOwnerPath, JSON.stringify(deadOwner), "utf8");
  let publishedClaims = 0;

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onRecoveryClaimPublished() {
          publishedClaims += 1;
          writeFileSync(lockOwnerPath, JSON.stringify(replacementOwner), "utf8");
        },
        retryMs: 5,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.equal(publishedClaims, 1);
    assert.deepEqual(JSON.parse(readFileSync(lockOwnerPath, "utf8")), replacementOwner);
    assert.equal(existsSync(lockRecoveryPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale lock recovery yields to a competing live recovery claim", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-competing-recovery-claim-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  const competingOwner = {
    pid: process.pid,
    timestamp: Date.now(),
    token: "competing-live-recovery-owner",
  };
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-owner-before-competing-claim",
    }),
    "utf8",
  );
  let candidateNotifications = 0;

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onRecoveryCandidateReady() {
          candidateNotifications += 1;
          mkdirSync(lockRecoveryPath);
          writeFileSync(
            join(lockRecoveryPath, "owner.json"),
            JSON.stringify(competingOwner),
            "utf8",
          );
        },
        retryMs: 5,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.equal(candidateNotifications, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(lockRecoveryPath, "owner.json"), "utf8")),
      competingOwner,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale lock recovery does not remove a replacement lock inode", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-replaced-lock-after-claim-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  const replacementOwner = {
    pid: process.pid,
    timestamp: Date.now(),
    token: "replacement-lock-inode-owner",
  };
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-owner-before-lock-replacement",
    }),
    "utf8",
  );

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onRecoveryClaimPublished() {
          const detachedClaim = join(parent, "detached-recovery-claim");
          renameSync(lockRecoveryPath, detachedClaim);
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath);
          writeFileSync(lockOwnerPath, JSON.stringify(replacementOwner), "utf8");
          renameSync(detachedClaim, lockRecoveryPath);
        },
        retryMs: 5,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.deepEqual(JSON.parse(readFileSync(lockOwnerPath, "utf8")), replacementOwner);
    assert.equal(existsSync(lockRecoveryPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ownerless stale lock recovery preserves an owner installed after the claim", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-ownerless-recovery-race-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  const replacementOwner = {
    pid: process.pid,
    timestamp: Date.now(),
    token: "owner-installed-after-ownerless-claim",
  };
  mkdirSync(lockPath);
  const staleTime = new Date(Date.now() - 120_000);
  utimesSync(lockPath, staleTime, staleTime);

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onRecoveryClaimPublished() {
          writeFileSync(lockOwnerPath, JSON.stringify(replacementOwner), "utf8");
        },
        retryMs: 5,
        staleMs: 60_000,
        timeoutMs: 75,
      }),
      /Timed out waiting for build lock/,
    );
    assert.deepEqual(JSON.parse(readFileSync(lockOwnerPath, "utf8")), replacementOwner);
    assert.equal(existsSync(lockRecoveryPath), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale lock recovery refuses to release a claim with replaced metadata", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-replaced-recovery-owner-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath, lockRecoveryPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  writeFileSync(
    lockOwnerPath,
    JSON.stringify({
      pid: 2_147_483_647,
      timestamp: Date.now(),
      token: "dead-owner-before-claim-tampering",
    }),
    "utf8",
  );

  try {
    await assert.rejects(
      acquireBuildLock(output, {
        onRecoveryClaimPublished({ owner, ownerPath }) {
          writeFileSync(
            lockOwnerPath,
            JSON.stringify({
              pid: process.pid,
              timestamp: Date.now(),
              token: "replacement-lock-owner",
            }),
            "utf8",
          );
          writeFileSync(
            ownerPath,
            JSON.stringify({ ...owner, token: "replacement-claim-owner" }),
            "utf8",
          );
        },
        retryMs: 5,
        timeoutMs: 75,
      }),
      /Build recovery claim ownership changed before release/,
    );
    assert.equal(existsSync(lockRecoveryPath), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stale lock recovery tolerates malformed dead-owner metadata", async () => {
  const {
    acquireBuildLock,
    buildStatePaths,
    releaseBuildLock,
  } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-malformed-lock-owner-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  writeFileSync(lockOwnerPath, "{not-json", "utf8");
  const staleTime = new Date(Date.now() - 120_000);
  utimesSync(lockPath, staleTime, staleTime);
  let lock;

  try {
    lock = await acquireBuildLock(output, {
      retryMs: 5,
      staleMs: 60_000,
      timeoutMs: 250,
    });
    assert.notEqual(lock.owner.token, undefined);
    await releaseBuildLock(lock);
    lock = null;
    assert.equal(existsSync(lockPath), false);
  } finally {
    if (lock) {
      await releaseBuildLock(lock).catch(() => {});
    }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("lock acquisition rejects non-file owner metadata without deleting it", async () => {
  const { acquireBuildLock, buildStatePaths } = await loadPublicationModule();
  const parent = mkdtempSync(join(tmpdir(), "salvo-lock-owner-directory-"));
  const output = join(parent, "dist");
  const { lockOwnerPath, lockPath } = buildStatePaths(output);
  mkdirSync(lockPath);
  mkdirSync(lockOwnerPath);

  try {
    await assert.rejects(
      acquireBuildLock(output),
      /Build lock owner path must be a regular file/,
    );
    assert.equal(existsSync(lockOwnerPath), true);
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
