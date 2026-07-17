import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const buildId = resolveBuildId();
const destination = await resolveBuildOutput();

const shellReplacements = [
  {
    path: "index.html",
    assetPrefix: "./",
    styleReference: '<link rel="stylesheet" href="./styles.css" />',
    appReference: '<script type="module" src="./app.js"></script>',
  },
  {
    path: "telegram/index.html",
    assetPrefix: "../",
    styleReference: '<link rel="stylesheet" href="../styles.css" />',
    appReference: '<script type="module" src="../app.js"></script>',
  },
];

async function resolveBuildOutput() {
  if (!process.env.SALVO_BUILD_DIR) {
    return resolve(root, "dist");
  }
  const candidate = await canonicalizePath(resolve(process.env.SALVO_BUILD_DIR));
  const temporaryRoot = await realpath(resolve(tmpdir()));
  const temporaryPath = relative(temporaryRoot, candidate);
  if (
    !temporaryPath
    || temporaryPath === ".."
    || temporaryPath.startsWith(`..${sep}`)
    || isAbsolute(temporaryPath)
  ) {
    throw new Error("SALVO_BUILD_DIR must be a child of the operating system temporary directory.");
  }
  return candidate;
}

async function canonicalizePath(candidate) {
  const missing = [];
  let ancestor = candidate;
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function resolveBuildId() {
  if (!Object.hasOwn(process.env, "SALVO_BUILD_ID")) {
    return "dev";
  }
  const candidate = process.env.SALVO_BUILD_ID;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(candidate)) {
    throw new Error(
      "SALVO_BUILD_ID must match /^[A-Za-z0-9._-]{1,64}$/.",
    );
  }
  return candidate;
}

function hashName(prefix, extension, contents) {
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 10);
  return `${prefix}.${hash}.${extension}`;
}

function replaceExactly(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  const second =
    first === -1 ? -1 : source.indexOf(expected, first + expected.length);
  if (first === -1 || second !== -1) {
    throw new Error(`${label} must have exactly one occurrence.`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(
    first + expected.length,
  )}`;
}

async function acquireBuildLock(output) {
  const lockPath = resolve(dirname(output), `.${basename(output)}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath);
      return lockPath;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for build lock ${lockPath}.`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function buildInto(dist) {
  await cp(src, dist, { recursive: true });
  await build({
    entryPoints: [resolve(src, "app.js")],
    outfile: resolve(dist, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    sourcemap: true,
    legalComments: "none",
  });

  const appPath = resolve(dist, "app.js");
  const sourceMapPath = resolve(dist, "app.js.map");
  const stylePath = resolve(dist, "styles.css");
  const appSource = await readFile(appPath, "utf8");
  const sourceMapSource = await readFile(sourceMapPath);
  const styleSource = await readFile(stylePath);
  const sourceMapName = hashName("app", "js.map", sourceMapSource);
  const rewrittenApp = replaceExactly(
    appSource,
    "//# sourceMappingURL=app.js.map",
    `//# sourceMappingURL=${sourceMapName}`,
    "Application sourcemap reference",
  );
  const appName = hashName("app", "js", rewrittenApp);
  const styleName = hashName("styles", "css", styleSource);

  const rewrittenShells = [];
  for (const shell of shellReplacements) {
    const shellPath = resolve(dist, shell.path);
    let html = await readFile(shellPath, "utf8");
    html = replaceExactly(
      html,
      shell.styleReference,
      `<link rel="stylesheet" href="${shell.assetPrefix}${styleName}" />`,
      `${shellPath} stylesheet reference`,
    );
    html = replaceExactly(
      html,
      shell.appReference,
      `<script type="module" src="${shell.assetPrefix}${appName}"></script>`,
      `${shellPath} application reference`,
    );
    html = replaceExactly(
      html,
      'buildId: "dev"',
      `buildId: "${buildId}"`,
      `${shellPath} build ID marker`,
    );
    rewrittenShells.push([shellPath, html]);
  }

  await writeFile(appPath, rewrittenApp);
  await rename(appPath, resolve(dist, appName));
  await rename(sourceMapPath, resolve(dist, sourceMapName));
  await rename(stylePath, resolve(dist, styleName));
  for (const [path, html] of rewrittenShells) {
    await writeFile(path, html);
  }
  await writeFile(resolve(dist, ".nojekyll"), "");
}

async function publishBuild(stage, output) {
  const backup = resolve(
    dirname(output),
    `.${basename(output)}.backup-${randomUUID()}`,
  );
  let hasPrevious = false;
  try {
    await rename(output, backup);
    hasPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await rename(stage, output);
  } catch (publishError) {
    if (hasPrevious) {
      try {
        await rename(backup, output);
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          `Build publication failed; previous output remains at ${backup}.`,
        );
      }
    }
    throw publishError;
  }

  if (hasPrevious) {
    await rm(backup, { recursive: true, force: true });
  }
}

await mkdir(dirname(destination), { recursive: true });
const lockPath = await acquireBuildLock(destination);
let stage = null;
try {
  stage = await mkdtemp(
    resolve(dirname(destination), `.${basename(destination)}.stage-`),
  );
  await buildInto(stage);
  await publishBuild(stage, destination);
  stage = null;
} finally {
  if (stage) {
    await rm(stage, { recursive: true, force: true });
  }
  await rm(lockPath, { recursive: true, force: true });
}

console.log(`Built ${destination}`);
