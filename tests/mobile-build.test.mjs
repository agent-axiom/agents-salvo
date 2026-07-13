import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const buildScript = readFileSync("scripts/build.mjs", "utf8");
const capacitorConfig = readFileSync("capacitor.config.ts", "utf8");

test("mobile toolchain is pinned and uses bundled local web assets", () => {
  assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24.14.1");
  assert.equal(packageJson.engines.node, ">=24.14.1 <25");
  assert.deepEqual(packageJson.dependencies, {
    "@capacitor/app": "8.1.0",
    "@capacitor/browser": "8.0.3",
    "@capacitor/core": "8.4.1",
    "@capacitor/haptics": "8.0.2",
    "@capacitor/network": "8.0.1",
    "@capacitor/preferences": "8.0.1",
    "@capacitor/share": "8.0.1",
    "@capacitor/splash-screen": "8.0.1",
  });
  assert.deepEqual(packageJson.devDependencies, {
    "@capacitor/android": "8.4.1",
    "@capacitor/cli": "8.4.1",
    "@capacitor/ios": "8.4.1",
    esbuild: "0.28.1",
  });
  assert.equal("overrides" in packageJson, false);
  assert.equal(packageJson.dependencies["@capacitor/core"], "8.4.1");
  assert.equal(packageJson.devDependencies["@capacitor/cli"], "8.4.1");
  assert.equal(packageJson.devDependencies.esbuild, "0.28.1");
  assert.equal(packageJson.scripts["mobile:sync"], "npm run build && cap sync");
  assert.equal(
    packageJson.scripts["mobile:android"],
    "npm run mobile:sync && cap open android",
  );
  assert.equal(
    packageJson.scripts["mobile:ios"],
    "npm run mobile:sync && cap open ios",
  );
  assert.equal(
    packageJson.scripts["mobile:verify"],
    "npm run build && cap sync --inline",
  );
  assert.match(buildScript, /from "esbuild"/);
  assert.match(buildScript, /entryPoints:\s*\[resolve\(src, "app\.js"\)\]/);
  assert.match(buildScript, /outfile:\s*resolve\(dist, "app\.js"\)/);
  assert.match(buildScript, /bundle:\s*true/);
  assert.match(buildScript, /format:\s*"esm"/);
  assert.match(buildScript, /platform:\s*"browser"/);
  assert.match(buildScript, /target:\s*\["es2022"\]/);
  assert.match(buildScript, /sourcemap:\s*true/);
  assert.match(buildScript, /legalComments:\s*"none"/);
  assert.match(buildScript, /writeFile\(resolve\(dist, "\.nojekyll"\), ""\)/);
  assert.match(capacitorConfig, /appId:\s*"io\.github\.agentaxiom\.salvo"/);
  assert.match(capacitorConfig, /webDir:\s*"dist"/);
  assert.doesNotMatch(capacitorConfig, /server:\s*\{[^}]*url:/s);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*insetsHandling:\s*"css"/);
});
