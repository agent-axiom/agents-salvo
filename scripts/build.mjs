import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolveBuildOutput();
const buildId = resolveBuildId();

const shellReplacements = [
  {
    path: resolve(dist, "index.html"),
    assetPrefix: "./",
    styleReference: '<link rel="stylesheet" href="./styles.css" />',
    appReference: '<script type="module" src="./app.js"></script>',
  },
  {
    path: resolve(dist, "telegram/index.html"),
    assetPrefix: "../",
    styleReference: '<link rel="stylesheet" href="../styles.css" />',
    appReference: '<script type="module" src="../app.js"></script>',
  },
];

function resolveBuildOutput() {
  if (!process.env.SALVO_BUILD_DIR) {
    return resolve(root, "dist");
  }
  const candidate = resolve(process.env.SALVO_BUILD_DIR);
  const temporaryRoot = resolve(tmpdir());
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

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
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
const styleSource = await readFile(stylePath);
const appName = hashName("app", "js", appSource);
const sourceMapName = `${appName}.map`;
const styleName = hashName("styles", "css", styleSource);
const rewrittenApp = replaceExactly(
  appSource,
  "//# sourceMappingURL=app.js.map",
  `//# sourceMappingURL=${sourceMapName}`,
  "Application sourcemap reference",
);

const rewrittenShells = [];
for (const shell of shellReplacements) {
  let html = await readFile(shell.path, "utf8");
  html = replaceExactly(
    html,
    shell.styleReference,
    `<link rel="stylesheet" href="${shell.assetPrefix}${styleName}" />`,
    `${shell.path} stylesheet reference`,
  );
  html = replaceExactly(
    html,
    shell.appReference,
    `<script type="module" src="${shell.assetPrefix}${appName}"></script>`,
    `${shell.path} application reference`,
  );
  html = replaceExactly(
    html,
    'buildId: "dev"',
    `buildId: "${buildId}"`,
    `${shell.path} build ID marker`,
  );
  rewrittenShells.push([shell.path, html]);
}

await writeFile(appPath, rewrittenApp);
await rename(appPath, resolve(dist, appName));
await rename(sourceMapPath, resolve(dist, sourceMapName));
await rename(stylePath, resolve(dist, styleName));
for (const [path, html] of rewrittenShells) {
  await writeFile(path, html);
}
await writeFile(resolve(dist, ".nojekyll"), "");

console.log(`Built ${dist}`);
