import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolveBuildOutput();

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
await writeFile(resolve(dist, ".nojekyll"), "");

console.log(`Built ${dist}`);
