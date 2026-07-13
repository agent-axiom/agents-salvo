import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
    typescript: "5.9.3",
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
  assert.match(capacitorConfig, /appName:\s*"Salvo"/);
  assert.match(capacitorConfig, /webDir:\s*"dist"/);
  assert.match(
    capacitorConfig,
    /android:\s*\{\s*backgroundColor:\s*"#071224"\s*\}/,
  );
  assert.match(
    capacitorConfig,
    /ios:\s*\{\s*backgroundColor:\s*"#071224",\s*contentInset:\s*"never"\s*\}/,
  );
  assert.match(
    capacitorConfig,
    /SplashScreen:\s*\{[\s\S]*?launchAutoHide:\s*false/,
  );
  assert.match(
    capacitorConfig,
    /SplashScreen:\s*\{[\s\S]*?backgroundColor:\s*"#071224"/,
  );
  assert.match(
    capacitorConfig,
    /SplashScreen:\s*\{[\s\S]*?showSpinner:\s*false/,
  );
  assert.doesNotMatch(capacitorConfig, /server:\s*\{[^}]*url:/s);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*insetsHandling:\s*"css"/);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*style:\s*"DEFAULT"/);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*hidden:\s*false/);
  assert.match(capacitorConfig, /SystemBars:[\s\S]*animation:\s*"NONE"/);
});

test("mobile build emits bundled local web artifacts", () => {
  execFileSync(process.execPath, ["scripts/build.mjs"]);

  assert.equal(existsSync("dist/index.html"), true);
  assert.equal(existsSync("dist/assets"), true);
  const bundledApp = readFileSync("dist/app.js", "utf8");
  assert.doesNotMatch(
    bundledApp,
    /(?:from\s*|import\s*\()["']@capacitor\//,
  );
});
