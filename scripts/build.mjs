import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true });
await writeFile(resolve(dist, ".nojekyll"), "");

console.log(`Built ${dist}`);
