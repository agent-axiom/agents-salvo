import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import capacitorCliConfig from "@capacitor/cli/dist/config.js";
import plist from "plist";
import { parse } from "yaml";

const { loadConfig } = capacitorCliConfig;
const { parse: parsePlist } = plist;

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const buildScript = readFileSync("scripts/build.mjs", "utf8");
const capacitorConfig = readFileSync("capacitor.config.ts", "utf8");

function readPng(path) {
  const png = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(png.subarray(0, signature.length), signature);

  const chunkTypes = [];
  const imageData = [];
  let offset = signature.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunkTypes.push(type);
    if (type === "IDAT") {
      imageData.push(png.subarray(dataStart, dataEnd));
    }
    offset = dataEnd + 4;
  }

  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
    interlace: png[28],
    chunkTypes,
    imageData,
  };
}

function readPngMetadata(path) {
  const { imageData: _imageData, ...metadata } = readPng(path);
  return metadata;
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function readPngPixels(path) {
  const png = readPng(path);
  assert.equal(png.bitDepth, 8, `${path} must use 8-bit channels`);
  assert.equal(png.interlace, 0, `${path} must not be interlaced`);
  assert.equal(
    [2, 6].includes(png.colorType),
    true,
    `${path} must be RGB or RGBA truecolor`,
  );

  const channels = png.colorType === 2 ? 3 : 4;
  const stride = png.width * channels;
  const filtered = inflateSync(Buffer.concat(png.imageData));
  assert.equal(filtered.length, png.height * (stride + 1));

  const pixels = Buffer.alloc(png.height * stride);
  for (let y = 0; y < png.height; y += 1) {
    const filteredRow = y * (stride + 1);
    const filter = filtered[filteredRow];
    const row = y * stride;
    const previousRow = row - stride;

    for (let x = 0; x < stride; x += 1) {
      const value = filtered[filteredRow + x + 1];
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[previousRow + x] : 0;
      const upperLeft =
        y > 0 && x >= channels
          ? pixels[previousRow + x - channels]
          : 0;

      let predictor;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = Math.floor((left + up) / 2);
          break;
        case 4:
          predictor = paethPredictor(left, up, upperLeft);
          break;
        default:
          assert.fail(`${path} uses unsupported PNG filter ${filter}`);
      }
      pixels[row + x] = (value + predictor) & 0xff;
    }
  }

  return { ...png, channels, pixels };
}

function assertPngBorderColor(path, expected) {
  const png = readPngPixels(path);
  const rgbAt = (x, y) => {
    const offset = (y * png.width + x) * png.channels;
    return [...png.pixels.subarray(offset, offset + 3)];
  };

  for (let x = 0; x < png.width; x += 1) {
    const top = rgbAt(x, 0);
    const bottom = rgbAt(x, png.height - 1);
    if (
      top.some((channel, index) => channel !== expected[index]) ||
      bottom.some((channel, index) => channel !== expected[index])
    ) {
      assert.fail(`${path} has a non-brand horizontal border pixel at x=${x}`);
    }
  }
  for (let y = 1; y < png.height - 1; y += 1) {
    const left = rgbAt(0, y);
    const right = rgbAt(png.width - 1, y);
    if (
      left.some((channel, index) => channel !== expected[index]) ||
      right.some((channel, index) => channel !== expected[index])
    ) {
      assert.fail(`${path} has a non-brand vertical border pixel at y=${y}`);
    }
  }

  let templateDarkOffset = -1;
  for (let offset = 0; offset < png.pixels.length; offset += png.channels) {
    const isTemplateDark =
      png.pixels[offset] === 17 &&
      png.pixels[offset + 1] === 17 &&
      png.pixels[offset + 2] === 17;
    if (isTemplateDark) {
      templateDarkOffset = offset;
      break;
    }
  }
  assert.equal(templateDarkOffset, -1, `${path} contains template #111111`);
}

function readAndroidString(path, name) {
  const strings = readFileSync(path, "utf8");
  const value = strings.match(
    new RegExp(`<string\\s+name=["']${name}["'][^>]*>([^<]+)</string>`),
  )?.[1];
  assert.notEqual(value, undefined, `${name} is missing from ${path}`);
  return value;
}

function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function readWorkflow(path) {
  assert.equal(existsSync(path), true, `${path} is missing`);
  const source = readFileSync(path, "utf8");
  parseWorkflowSource(source, path);
  return source;
}

function parseWorkflowSource(source, path) {
  try {
    return parse(source, { strict: true, uniqueKeys: true, version: "1.2" });
  } catch (error) {
    throw new Error(`${path} contains invalid YAML`, { cause: error });
  }
}

function assertWorkflowStructure(workflow, { triggers, jobs }) {
  assert.equal(
    workflow !== null && typeof workflow === "object" && !Array.isArray(workflow),
    true,
    "workflow must be a mapping",
  );
  assert.deepEqual(
    Object.keys(workflow).sort(),
    ["concurrency", "jobs", "name", "on", "permissions"],
    "workflow top-level keys do not match expected structure",
  );
  assert.deepEqual(
    Object.keys(workflow.on ?? {}).sort(),
    [...triggers].sort(),
    "workflow triggers do not match expected structure",
  );
  assert.deepEqual(
    Object.keys(workflow.jobs ?? {}).sort(),
    [...jobs].sort(),
    "workflow jobs do not match expected structure",
  );

  for (const jobName of jobs) {
    const job = workflow.jobs[jobName];
    assert.equal(
      typeof job["runs-on"],
      "string",
      `${jobName} job must select a runner`,
    );
    assert.equal(
      Array.isArray(job.steps),
      true,
      `${jobName} job steps must be a sequence`,
    );
  }
}

function workflowJob(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `${name} job is missing`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-zA-Z0-9_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function actionVersions(workflow, action) {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...workflow.matchAll(new RegExp(`uses: ${escapedAction}@([^\\s]+)`, "g")),
  ].map((match) => match[1]);
}

function scalarRunCommands(workflow) {
  return [...workflow.matchAll(/^\s+run: (?!\|)(.+)$/gm)].map(
    (match) => match[1],
  );
}

test("mobile toolchain is pinned and uses bundled local web assets", () => {
  assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24.14.1");
  assert.equal(packageJson.engines.node, ">=24.14.1 <25");
  assert.deepEqual(packageJson.dependencies, {
    "@aparajita/capacitor-secure-storage": "8.0.0",
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
    pngjs: "7.0.0",
    typescript: "5.9.3",
    yaml: "2.9.0",
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

test("Capacitor CLI loads the local TypeScript config", async () => {
  const config = await loadConfig();

  assert.equal(config.app.appId, "io.github.agentaxiom.salvo");
  assert.equal(config.app.appName, "Salvo");
  assert.equal(config.app.webDir, "dist");
  assert.equal(config.app.extConfig.server?.url, undefined);
});

test("mobile build emits bundled local web artifacts", () => {
  const buildOutput = mkdtempSync(join(tmpdir(), "salvo-mobile-build-"));
  execFileSync(process.execPath, ["scripts/build.mjs"], {
    env: { ...process.env, SALVO_BUILD_DIR: buildOutput },
  });

  assert.equal(existsSync(join(buildOutput, "index.html")), true);
  assert.equal(existsSync(join(buildOutput, "assets")), true);
  const rootShell = readFileSync(join(buildOutput, "index.html"), "utf8");
  const appReferences = [
    ...rootShell.matchAll(/src="\.\/(app\.[a-f0-9]{10}\.js)"/g),
  ];
  const styleReferences = [
    ...rootShell.matchAll(/href="\.\/(styles\.[a-f0-9]{10}\.css)"/g),
  ];
  assert.equal(appReferences.length, 1);
  assert.equal(styleReferences.length, 1);
  assert.doesNotMatch(rootShell, /telegram-web-app\.js/);

  const localAssetReferences = [
    ...rootShell.matchAll(/(?:href|src)="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.equal(localAssetReferences.length > 0, true);
  for (const reference of localAssetReferences) {
    assert.match(
      reference,
      /^\.\//,
      `${reference} must be a local native asset`,
    );
    assert.equal(
      existsSync(join(buildOutput, reference.slice(2))),
      true,
      `${reference} is missing from the native build`,
    );
  }
  assert.deepEqual(
    readFileSync(
      join(buildOutput, "assets/images/backgrounds/paper-texture-512.png"),
    ),
    readFileSync(
      "src/assets/images/backgrounds/paper-texture-512.png",
    ),
  );
  const bundledApp = readFileSync(
    join(buildOutput, appReferences[0][1]),
    "utf8",
  );
  assert.doesNotMatch(
    bundledApp,
    /(?:from\s*|import\s*(?:\(\s*)?)["']@capacitor\//,
  );
  assert.doesNotMatch(
    bundledApp,
    /(?:from\s*|import\s*(?:\(\s*)?)["']\.\.?\//,
  );
});

test("build output override rejects non-temporary directories before deleting files", () => {
  const unsafeOutput = mkdtempSync(join(process.cwd(), ".salvo-unsafe-build-"));
  const sentinel = join(unsafeOutput, "keep.txt");
  writeFileSync(sentinel, "do not delete", "utf8");
  try {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      encoding: "utf8",
      env: { ...process.env, SALVO_BUILD_DIR: unsafeOutput },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /temporary directory/i);
    assert.equal(readFileSync(sentinel, "utf8"), "do not delete");
  } finally {
    rmSync(unsafeOutput, { recursive: true, force: true });
  }
});

test("mobile source artwork has deterministic opaque dimensions", () => {
  assert.equal(existsSync("resources/icon.png"), true, "icon is missing");
  assert.equal(existsSync("resources/splash.png"), true, "splash is missing");

  const icon = readPngMetadata("resources/icon.png");
  const splash = readPngMetadata("resources/splash.png");
  assert.deepEqual(
    { width: icon.width, height: icon.height },
    { width: 1024, height: 1024 },
  );
  assert.deepEqual(
    { width: splash.width, height: splash.height },
    { width: 2732, height: 2732 },
  );
  assert.equal(icon.colorType, 2, "icon must be opaque truecolor PNG");
  assert.equal(splash.colorType, 2, "splash must be opaque truecolor PNG");
  assert.equal(icon.chunkTypes.includes("tRNS"), false);
  assert.equal(splash.chunkTypes.includes("tRNS"), false);
});

test("iOS dark splash canvases use the Salvo brand background", () => {
  const splashSet = "ios/App/App/Assets.xcassets/Splash.imageset";
  const contents = JSON.parse(
    readFileSync(join(splashSet, "Contents.json"), "utf8"),
  );
  const darkImages = contents.images
    .filter((image) =>
      image.appearances?.some(
        ({ appearance, value }) =>
          appearance === "luminosity" && value === "dark",
      ),
    )
    .map(({ filename }) => filename);

  assert.equal(darkImages.length, 3);
  for (const filename of darkImages) {
    const path = join(splashSet, filename);
    assert.equal(existsSync(path), true, `${path} is missing`);
    const { width, height } = readPngMetadata(path);
    assert.deepEqual({ width, height }, { width: 2732, height: 2732 });
    assertPngBorderColor(path, [7, 18, 36]);
  }
});

test("native asset catalogs contain only referenced splash and launcher files", () => {
  const splashSet = "ios/App/App/Assets.xcassets/Splash.imageset";
  const contents = JSON.parse(
    readFileSync(join(splashSet, "Contents.json"), "utf8"),
  );
  const referencedIosSplashes = contents.images
    .map(({ filename }) => filename)
    .filter(Boolean)
    .sort();
  const actualIosSplashes = readdirSync(splashSet)
    .filter((filename) => filename.endsWith(".png"))
    .sort();
  assert.deepEqual(actualIosSplashes, referencedIosSplashes);

  const resRoot = "android/app/src/main/res";
  const densities = ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
  const launcherNames = [
    "ic_launcher.png",
    "ic_launcher_round.png",
    "ic_launcher_background.png",
    "ic_launcher_foreground.png",
  ];
  const expectedLauncherFiles = [
    join(resRoot, "mipmap-anydpi-v26/ic_launcher.xml"),
    join(resRoot, "mipmap-anydpi-v26/ic_launcher_round.xml"),
    ...densities.flatMap((density) =>
      launcherNames.map((name) => join(resRoot, `mipmap-${density}`, name)),
    ),
  ].sort();
  const actualLauncherFiles = listFiles(resRoot)
    .filter((path) =>
      /\/ic_launcher(?:_background|_foreground|_round)?\.(?:png|xml)$/.test(
        path,
      ),
    )
    .sort();
  assert.deepEqual(actualLauncherFiles, expectedLauncherFiles);

  const manifest = readFileSync(
    "android/app/src/main/AndroidManifest.xml",
    "utf8",
  );
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    const adaptiveIcon = readFileSync(
      join(resRoot, "mipmap-anydpi-v26", name),
      "utf8",
    );
    assert.match(adaptiveIcon, /@mipmap\/ic_launcher_background/);
    assert.match(adaptiveIcon, /@mipmap\/ic_launcher_foreground/);
  }

  const styles = readFileSync(join(resRoot, "values/styles.xml"), "utf8");
  const androidSplashes = listFiles(resRoot).filter((path) =>
    path.endsWith("/splash.png"),
  );
  assert.notEqual(androidSplashes.length, 0);
  assert.match(
    styles,
    /<item name="android:background">@drawable\/splash<\/item>/,
  );
});

test("Android shell uses the Salvo identity, SDK baseline, and names", () => {
  assert.equal(existsSync("android/app/build.gradle"), true, "Android shell is missing");

  const appGradle = readFileSync("android/app/build.gradle", "utf8");
  const variablesGradle = readFileSync("android/variables.gradle", "utf8");
  assert.match(appGradle, /namespace\s*=\s*["']io\.github\.agentaxiom\.salvo["']/);
  assert.match(appGradle, /applicationId\s+["']io\.github\.agentaxiom\.salvo["']/);
  assert.match(variablesGradle, /minSdkVersion\s*=\s*24\b/);
  assert.match(variablesGradle, /compileSdkVersion\s*=\s*36\b/);
  assert.match(variablesGradle, /targetSdkVersion\s*=\s*36\b/);

  const english = "android/app/src/main/res/values/strings.xml";
  assert.equal(readAndroidString(english, "app_name"), "Salvo");
  assert.equal(readAndroidString(english, "title_activity_main"), "Salvo");
  assert.equal(
    readAndroidString(english, "package_name"),
    "io.github.agentaxiom.salvo",
  );
  assert.equal(
    readAndroidString(english, "custom_url_scheme"),
    "io.github.agentaxiom.salvo",
  );
  const defaultStrings = readFileSync(english, "utf8");
  for (const name of ["package_name", "custom_url_scheme"]) {
    assert.match(
      defaultStrings,
      new RegExp(
        `<string\\s+name=["']${name}["']\\s+translatable=["']false["']>`,
      ),
      `${name} must be excluded from Android translation checks`,
    );
  }

  for (const [locale, name] of [
    ["values-ru", "Залп"],
    ["values-zh-rCN", "齐射"],
  ]) {
    const localized = `android/app/src/main/res/${locale}/strings.xml`;
    assert.equal(existsSync(localized), true, `${locale} strings are missing`);
    assert.equal(readAndroidString(localized, "app_name"), name);
    assert.equal(readAndroidString(localized, "title_activity_main"), name);
  }
});

test("native shells register protected session storage", () => {
  const androidSettings = readFileSync(
    "android/capacitor.settings.gradle",
    "utf8",
  );
  const androidDependencies = readFileSync(
    "android/app/capacitor.build.gradle",
    "utf8",
  );
  const iosPackage = readFileSync(
    "ios/App/CapApp-SPM/Package.swift",
    "utf8",
  );

  assert.match(
    androidSettings,
    /include ':aparajita-capacitor-secure-storage'/,
  );
  assert.match(
    androidDependencies,
    /implementation project\(':aparajita-capacitor-secure-storage'\)/,
  );
  assert.match(
    iosPackage,
    /\.product\(name: "AparajitaCapacitorSecureStorage"/,
  );
});

test("Android ignores signing keys", () => {
  const gitignore = readFileSync("android/.gitignore", "utf8");
  assert.match(gitignore, /^\*\.jks$/m);
  assert.match(gitignore, /^\*\.keystore$/m);
});

test("Android tests contain only the application ID smoke coverage", () => {
  const appGradle = readFileSync("android/app/build.gradle", "utf8");
  const variablesGradle = readFileSync("android/variables.gradle", "utf8");
  assert.doesNotMatch(appGradle, /^\s*testImplementation\b/m);
  assert.doesNotMatch(appGradle, /espresso/i);
  assert.doesNotMatch(variablesGradle, /^\s*junitVersion\s*=/m);
  assert.doesNotMatch(variablesGradle, /espresso/i);
  assert.match(
    appGradle,
    /androidTestImplementation\s+["']androidx\.test\.ext:junit:\$androidxJunitVersion["']/,
  );
  assert.match(
    appGradle,
    /testInstrumentationRunner\s+["']androidx\.test\.runner\.AndroidJUnitRunner["']/,
  );
  assert.match(
    appGradle,
    /androidTestImplementation\s+["']androidx\.test:runner:\$androidxTestRunnerVersion["']/,
  );
  assert.match(variablesGradle, /^\s*androidxJunitVersion\s*=/m);
  assert.match(
    variablesGradle,
    /^\s*androidxTestRunnerVersion\s*=\s*["']1\.7\.0["']$/m,
  );

  const unitTestSources = listFiles("android/app/src/test/java").filter(
    (path) => path.endsWith(".java"),
  );
  assert.deepEqual(unitTestSources, []);

  const packagePath = "io/github/agentaxiom/salvo";
  const instrumentedTest =
    `android/app/src/androidTest/java/${packagePath}/ApplicationIdSmokeTest.java`;
  const instrumentedTestSources = listFiles(
    "android/app/src/androidTest/java",
  )
    .filter((path) => path.endsWith(".java"))
    .sort();
  assert.deepEqual(instrumentedTestSources, [instrumentedTest]);

  const source = readFileSync(instrumentedTest, "utf8");
  assert.match(source, /^package io\.github\.agentaxiom\.salvo;/m);
  assert.match(source, /public class ApplicationIdSmokeTest\s*\{/);
  assert.match(source, /public void applicationIdMatchesConfiguredPackage\(\)/);
  assert.match(
    source,
    /assertEquals\(\s*"io\.github\.agentaxiom\.salvo",\s*appContext\.getPackageName\(\)\s*\)/s,
  );
  assert.doesNotMatch(source, /\bExample\w*/);
  assert.doesNotMatch(
    source,
    /\bcom\.getcapacitor(?:\.(?:app|myapp))?\b/,
  );
});

test("iOS shell uses the Salvo identity, SPM, deployment target, and names", () => {
  const projectPath = "ios/App/App.xcodeproj/project.pbxproj";
  assert.equal(existsSync(projectPath), true, "iOS shell is missing");

  const project = readFileSync(projectPath, "utf8");
  const info = parsePlist(readFileSync("ios/App/App/Info.plist", "utf8"));
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  assert.match(
    project,
    /PRODUCT_BUNDLE_IDENTIFIER = io\.github\.agentaxiom\.salvo;/,
  );
  assert.equal(info.CFBundleDisplayName, "$(PRODUCT_NAME)");

  assert.equal(existsSync("ios/App/CapApp-SPM/Package.swift"), true);
  assert.match(project, /isa = XCLocalSwiftPackageReference;/);
  assert.match(project, /relativePath = ["']CapApp-SPM["'];/);
  assert.equal(existsSync("ios/App/Podfile"), false);
  assert.equal(existsSync("ios/App/App.xcworkspace"), false);

  const knownRegions = project.match(/knownRegions = \(([\s\S]*?)\);/)?.[1];
  assert.notEqual(knownRegions, undefined);
  for (const [locale, name] of [
    ["en", "Salvo"],
    ["ru", "Залп"],
    ["zh-Hans", "齐射"],
  ]) {
    const localized = `ios/App/App/${locale}.lproj/InfoPlist.strings`;
    assert.equal(existsSync(localized), true, `${locale} display name is missing`);
    assert.equal(
      readFileSync(localized, "utf8").trim(),
      `CFBundleDisplayName = "${name}";`,
    );
    assert.match(
      project,
      new RegExp(`path = ["']?${locale}\\.lproj/InfoPlist\\.strings["']?;`),
    );
    assert.match(knownRegions, new RegExp(`["']?${locale}["']?,`));
  }
  assert.match(project, /InfoPlist\.strings in Resources/);
});

test("iOS privacy manifest declares only the Preferences required-reason API", () => {
  const privacyPath = "ios/App/PrivacyInfo.xcprivacy";
  assert.equal(existsSync(privacyPath), true, "privacy manifest is missing");

  const privacy = parsePlist(readFileSync(privacyPath, "utf8"));
  assert.deepEqual(privacy, {
    NSPrivacyAccessedAPITypes: [
      {
        NSPrivacyAccessedAPIType:
          "NSPrivacyAccessedAPICategoryUserDefaults",
        NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
      },
    ],
  });

  const project = readFileSync("ios/App/App.xcodeproj/project.pbxproj", "utf8");
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
});

test("native shells register Salvo custom deep links", () => {
  const manifest = readFileSync(
    "android/app/src/main/AndroidManifest.xml",
    "utf8",
  );
  assert.match(
    manifest,
    /<action android:name="android\.intent\.action\.VIEW"\s*\/>/,
  );
  assert.match(
    manifest,
    /<category android:name="android\.intent\.category\.BROWSABLE"\s*\/>/,
  );
  assert.match(
    manifest,
    /<data android:scheme="salvo" android:host="open"\s*\/>/,
  );

  const info = parsePlist(readFileSync("ios/App/App/Info.plist", "utf8"));
  assert.deepEqual(info.CFBundleURLTypes, [
    {
      CFBundleTypeRole: "Editor",
      CFBundleURLName: "io.github.agentaxiom.salvo",
      CFBundleURLSchemes: ["salvo"],
    },
  ]);
});

test("native shells do not configure a GitHub Pages WebView start URL", () => {
  const nativeProjectFiles = [
    "android/app/build.gradle",
    "android/app/src/main/AndroidManifest.xml",
    "ios/App/App.xcodeproj/project.pbxproj",
    "ios/App/App/Info.plist",
  ];
  const generatedConfigs = [
    "android/app/src/main/assets/capacitor.config.json",
    "ios/App/App/capacitor.config.json",
  ];

  assert.doesNotMatch(
    capacitorConfig,
    /https:\/\/agent-axiom\.github\.io\/agents-salvo\/?/i,
  );
  for (const path of nativeProjectFiles) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /https:\/\/agent-axiom\.github\.io\/agents-salvo\/?/i,
    );
  }

  for (const path of generatedConfigs) {
    if (!existsSync(path)) {
      continue;
    }
    const config = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(config.server?.url, undefined, `${path} has a remote start URL`);
    assert.doesNotMatch(
      JSON.stringify(config),
      /https:\/\/agent-axiom\.github\.io\/agents-salvo\/?/i,
    );
  }
});

test("workflow parser rejects malformed YAML", () => {
  assert.throws(
    () => parseWorkflowSource("jobs: [", "invalid-workflow.yml"),
    /invalid-workflow\.yml contains invalid YAML/,
  );
});

test("workflow structure validation rejects renamed jobs", () => {
  const workflow = parseWorkflowSource(
    `name: Invalid Mobile Workflow
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: invalid
  cancel-in-progress: true
jobs:
  browser:
    runs-on: ubuntu-latest
    steps: []
  android:
    runs-on: ubuntu-latest
    steps: []
  ios:
    runs-on: macos-26
    steps: []
`,
    "renamed-job.yml",
  );

  assert.throws(
    () =>
      assertWorkflowStructure(workflow, {
        triggers: ["pull_request", "push", "workflow_dispatch"],
        jobs: ["web", "android", "ios"],
      }),
    /workflow jobs do not match expected structure/,
  );
});

test("Pages CI uses the pinned Node toolchain and preserves deployment", () => {
  const workflow = readWorkflow(".github/workflows/pages.yml");
  assertWorkflowStructure(
    parseWorkflowSource(workflow, ".github/workflows/pages.yml"),
    { triggers: ["push", "workflow_dispatch"], jobs: ["build", "deploy"] },
  );
  const build = workflowJob(workflow, "build");
  const deploy = workflowJob(workflow, "deploy");

  assert.equal(readFileSync(".nvmrc", "utf8").trim(), "24.14.1");
  assert.deepEqual(actionVersions(workflow, "actions/checkout"), ["v7"]);
  assert.deepEqual(actionVersions(workflow, "actions/setup-node"), ["v7"]);
  assert.match(
    build,
    /uses: actions\/setup-node@v7\n\s+with:\n\s+node-version-file: \.nvmrc\n\s+cache: npm/,
  );
  assert.deepEqual(scalarRunCommands(build), [
    "npm ci",
    "npm test",
    "npm run coverage",
    "npm run build",
  ]);
  assert.match(build, /uses: actions\/configure-pages@v6/);
  assert.match(
    build,
    /uses: actions\/upload-pages-artifact@v5\n\s+with:\n\s+path: dist/,
  );
  assert.match(deploy, /uses: actions\/deploy-pages@v5/);
});

test("mobile CI covers branch builds without signing credentials", () => {
  const workflow = readWorkflow(".github/workflows/mobile.yml");
  assertWorkflowStructure(
    parseWorkflowSource(workflow, ".github/workflows/mobile.yml"),
    {
      triggers: ["pull_request", "push", "workflow_dispatch"],
      jobs: ["web", "android", "ios"],
    },
  );

  assert.match(workflow, /^on:\n/m);
  assert.match(workflow, /^  pull_request:\s*$/m);
  assert.match(workflow, /^  push:\n    branches:\n      - main$/m);
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(
    workflow,
    /^concurrency:\n  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
  );
  assert.deepEqual(actionVersions(workflow, "actions/checkout"), [
    "v7",
    "v7",
    "v7",
  ]);
  assert.deepEqual(actionVersions(workflow, "actions/setup-node"), [
    "v7",
    "v7",
    "v7",
  ]);
  assert.deepEqual(actionVersions(workflow, "actions/setup-java"), ["v5"]);
  assert.deepEqual(actionVersions(workflow, "actions/upload-artifact"), [
    "v7",
    "v7",
  ]);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets(?:\.|\[)/i);
  assert.doesNotMatch(
    workflow,
    /\b(?:ANDROID_KEYSTORE|KEYSTORE_PASSWORD|KEY_PASSWORD|STORE_PASSWORD|P12_PASSWORD|MATCH_PASSWORD|APPLE_CERTIFICATE|PROVISIONING_PROFILE(?:_SPECIFIER)?|CODE_SIGN_IDENTITY)\b/i,
  );
});

test("mobile CI validates the web build and coverage gate", () => {
  const workflow = readWorkflow(".github/workflows/mobile.yml");
  const web = workflowJob(workflow, "web");

  assert.match(web, /^  web:\n    runs-on: ubuntu-latest$/m);
  assert.deepEqual(actionVersions(web, "actions/checkout"), ["v7"]);
  assert.deepEqual(actionVersions(web, "actions/setup-node"), ["v7"]);
  assert.match(
    web,
    /uses: actions\/setup-node@v7\n\s+with:\n\s+node-version-file: \.nvmrc\n\s+cache: npm/,
  );
  assert.deepEqual(scalarRunCommands(web), [
    "npm ci",
    "npm test",
    "npm run coverage",
    "npm run build",
  ]);
});

test("mobile CI tests, lints, and packages the Android debug app", () => {
  const workflow = readWorkflow(".github/workflows/mobile.yml");
  const android = workflowJob(workflow, "android");

  assert.match(android, /^  android:\n    runs-on: ubuntu-latest$/m);
  assert.deepEqual(actionVersions(android, "actions/checkout"), ["v7"]);
  assert.deepEqual(actionVersions(android, "actions/setup-node"), ["v7"]);
  assert.deepEqual(actionVersions(android, "actions/setup-java"), ["v5"]);
  assert.match(
    android,
    /uses: actions\/setup-node@v7\n\s+with:\n\s+node-version-file: \.nvmrc\n\s+cache: npm/,
  );
  assert.match(
    android,
    /uses: actions\/setup-java@v5\n\s+with:\n\s+distribution: temurin\n\s+java-version: ["']21["']\n\s+cache: gradle/,
  );
  assert.deepEqual(scalarRunCommands(android), [
    "npm ci",
    "npm run mobile:sync",
    "android/gradlew -p android test lint assembleDebug",
  ]);
  assert.deepEqual(
    actionVersions(android, "ReactiveCircus/android-emulator-runner"),
    ["a421e43855164a8197daf9d8d40fe71c6996bb0d"],
  );
  assert.match(
    android,
    /uses: ReactiveCircus\/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d # v2\n\s+with:\n\s+api-level: 35\n\s+target: aosp_atd\n\s+arch: x86_64\n\s+emulator-boot-timeout: 300[\s\S]*?emulator-options: .* -no-snapshot .*\n[\s\S]*?script: android\/gradlew -p android :app:connectedDebugAndroidTest/,
  );
  assert.match(
    android,
    /uses: actions\/upload-artifact@v7\n\s+with:\n\s+name: android-debug-apk\n\s+path: android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk\n\s+if-no-files-found: error/,
  );
});

test("mobile CI builds an unsigned iOS Simulator app and retains failures", () => {
  const workflow = readWorkflow(".github/workflows/mobile.yml");
  const ios = workflowJob(workflow, "ios");

  assert.match(ios, /^  ios:\n    runs-on: macos-26$/m);
  assert.deepEqual(actionVersions(ios, "actions/checkout"), ["v7"]);
  assert.deepEqual(actionVersions(ios, "actions/setup-node"), ["v7"]);
  assert.match(
    ios,
    /uses: actions\/setup-node@v7\n\s+with:\n\s+node-version-file: \.nvmrc\n\s+cache: npm/,
  );
  assert.deepEqual(scalarRunCommands(ios), [
    "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer",
    "npm ci",
    "npm run mobile:sync",
  ]);
  assert.match(
    ios,
    /if: \$\{\{ always\(\) && steps\.ios_build\.outcome == 'failure' \}\}\n\s+uses: actions\/upload-artifact@v7\n\s+with:\n\s+name: ios-xcodebuild-log\n\s+path: xcodebuild\.log\n\s+if-no-files-found: error/,
  );
  assert.match(
    ios,
    /id: ios_build\n\s+shell: bash\n\s+run: \|\n\s+set -o pipefail\n\s+xcodebuild -project ios\/App\/App\.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build 2>&1 \| tee xcodebuild\.log/,
  );
});
