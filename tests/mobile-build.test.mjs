import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import capacitorCliConfig from "@capacitor/cli/dist/config.js";
import plist from "plist";

const { loadConfig } = capacitorCliConfig;
const { parse: parsePlist } = plist;

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const buildScript = readFileSync("scripts/build.mjs", "utf8");
const capacitorConfig = readFileSync("capacitor.config.ts", "utf8");

function readPngMetadata(path) {
  const png = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(png.subarray(0, signature.length), signature);

  const chunkTypes = [];
  let offset = signature.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    chunkTypes.push(type);
    offset += 12 + length;
  }

  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png[25],
    chunkTypes,
  };
}

function readAndroidString(path, name) {
  const strings = readFileSync(path, "utf8");
  const value = strings.match(
    new RegExp(`<string\\s+name=["']${name}["']>([^<]+)</string>`),
  )?.[1];
  assert.notEqual(value, undefined, `${name} is missing from ${path}`);
  return value;
}

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

test("Capacitor CLI loads the local TypeScript config", async () => {
  const config = await loadConfig();

  assert.equal(config.app.appId, "io.github.agentaxiom.salvo");
  assert.equal(config.app.appName, "Salvo");
  assert.equal(config.app.webDir, "dist");
  assert.equal(config.app.extConfig.server?.url, undefined);
});

test("mobile build emits bundled local web artifacts", () => {
  execFileSync(process.execPath, ["scripts/build.mjs"]);

  assert.equal(existsSync("dist/index.html"), true);
  assert.equal(existsSync("dist/assets"), true);
  assert.equal(
    readFileSync("dist/index.html", "utf8"),
    readFileSync("src/index.html", "utf8"),
  );
  assert.deepEqual(
    readFileSync(
      "dist/assets/images/backgrounds/paper-texture-512.png",
    ),
    readFileSync(
      "src/assets/images/backgrounds/paper-texture-512.png",
    ),
  );
  const bundledApp = readFileSync("dist/app.js", "utf8");
  assert.doesNotMatch(
    bundledApp,
    /(?:from\s*|import\s*(?:\(\s*)?)["']@capacitor\//,
  );
  assert.doesNotMatch(
    bundledApp,
    /(?:from\s*|import\s*(?:\(\s*)?)["']\.\.?\//,
  );
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
