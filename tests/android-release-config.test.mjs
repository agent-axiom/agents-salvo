import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ANDROID_RELEASE_CERTIFICATE_SHA256,
  verifyAndroidRelease,
} from "../scripts/verify-android-release.mjs";

const gradle = readFileSync("android/app/build.gradle", "utf8");
const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const rootGitignore = readFileSync(".gitignore", "utf8");
const androidGitignore = readFileSync("android/.gitignore", "utf8");

test("Android release identity is stable and production signed", () => {
  assert.match(gradle, /applicationId\s+["']io\.github\.agentaxiom\.salvo["']/);
  assert.match(gradle, /versionCode\s+1\b/);
  assert.match(gradle, /versionName\s+["']1\.0\.0["']/);

  for (const variable of [
    "SALVO_RELEASE_KEYSTORE",
    "SALVO_RELEASE_STORE_PASSWORD",
    "SALVO_RELEASE_KEY_ALIAS",
    "SALVO_RELEASE_KEY_PASSWORD",
  ]) {
    assert.match(gradle, new RegExp(variable));
  }

  assert.match(gradle, /signingConfigs\s*\{[\s\S]*release\s*\{/);
  assert.match(gradle, /release\s*\{[\s\S]*signingConfig\s+signingConfigs\.release/);
  assert.doesNotMatch(gradle, /signingConfig\s+signingConfigs\.debug/);
});

test("release credentials and generated Android artifacts stay out of Git", () => {
  for (const pattern of [
    /^\.env$/m,
    /^\*\.jks$/m,
    /^\*\.keystore$/m,
    /^android\/release\.properties$/m,
    /^android\/app\/build\/outputs\/$/m,
  ]) {
    assert.match(rootGitignore, pattern);
  }

  assert.match(androidGitignore, /^\*\.jks$/m);
  assert.match(androidGitignore, /^\*\.keystore$/m);
  assert.doesNotMatch(rootGitignore, /^android\/$/m);
});

test("Android release manifest exposes only required network access", () => {
  assert.match(manifest, /android:allowBackup=["']false["']/);
  assert.match(manifest, /android:usesCleartextTraffic=["']false["']/);
  assert.deepEqual(
    [...manifest.matchAll(/<uses-permission\s+android:name=["']([^"']+)["']/g)].map((match) => match[1]),
    ["android.permission.INTERNET"],
  );
});

function validCommandRunner(overrides = {}) {
  return (command, args) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation.includes("application-id")) {
      return { status: 0, stdout: `${overrides.packageId ?? "io.github.agentaxiom.salvo"}\n`, stderr: "" };
    }
    if (invocation.includes("version-name")) {
      return { status: 0, stdout: `${overrides.versionName ?? "1.0.0"}\n`, stderr: "" };
    }
    if (command === "apksigner") {
      return {
        status: overrides.signatureStatus ?? 0,
        stdout: overrides.signatureOutput ?? `Verifies\nSigner #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}\n`,
        stderr: overrides.signatureError ?? "",
      };
    }
    throw new Error(`Unexpected command: ${invocation}`);
  };
}

function releaseFixture(filename = "app-release.apk") {
  const directory = mkdtempSync(join(tmpdir(), "salvo-android-release-"));
  const artifactPath = join(directory, filename);
  writeFileSync(artifactPath, "signed-apk-fixture");
  return artifactPath;
}

test("release verifier rejects missing and debug APKs", () => {
  assert.throws(() => verifyAndroidRelease(), /path is required/i);
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: join(tmpdir(), "missing-release.apk"), runCommand: validCommandRunner() }),
    /does not exist/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture("app-release.aab"), runCommand: validCommandRunner() }),
    /requires an APK/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture("app-debug.apk"), runCommand: validCommandRunner() }),
    /debug/i,
  );
});

test("release verifier reports inspection failures without leaking assumptions", () => {
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: () => null }),
    /application ID inspection failed: command returned no diagnostics/i,
  );
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: () => ({ status: 1, stdout: "manifest unavailable", stderr: "" }),
    }),
    /application ID inspection failed: manifest unavailable/i,
  );
});

test("release verifier rejects unexpected identity and failed signatures", () => {
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: validCommandRunner({ packageId: "example.invalid" }) }),
    /application id/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: validCommandRunner({ versionName: "0.9.0" }) }),
    /version name/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: validCommandRunner({ signatureStatus: 1, signatureError: "DOES NOT VERIFY" }) }),
    /signature verification failed/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: validCommandRunner({ signatureOutput: "Verifies\n" }) }),
    /certificate digest/i,
  );
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({ signatureOutput: "Signer #1 certificate SHA-256 digest: DE:AD:BE:EF" }),
    }),
    /unexpected Android signing certificate/i,
  );
});

test("release verifier writes a reproducible SHA-256 sidecar", () => {
  const artifactPath = releaseFixture();
  const result = verifyAndroidRelease({ artifactPath, runCommand: validCommandRunner() });

  assert.equal(result.applicationId, "io.github.agentaxiom.salvo");
  assert.equal(result.versionName, "1.0.0");
  assert.equal(result.certificateSha256, ANDROID_RELEASE_CERTIFICATE_SHA256);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    readFileSync(`${artifactPath}.sha256`, "utf8"),
    `${result.sha256}  app-release.apk\n`,
  );
});

test("release verifier CLI reports success and failure with stable exit codes", () => {
  const toolsDirectory = mkdtempSync(join(tmpdir(), "salvo-android-tools-"));
  const apkAnalyzer = join(toolsDirectory, "apkanalyzer");
  const apkSigner = join(toolsDirectory, "apksigner");
  writeFileSync(
    apkAnalyzer,
    "#!/bin/sh\nif [ \"$2\" = application-id ]; then echo io.github.agentaxiom.salvo; else echo 1.0.0; fi\n",
  );
  writeFileSync(
    apkSigner,
    `#!/bin/sh\necho 'Signer #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}'\n`,
  );
  chmodSync(apkAnalyzer, 0o700);
  chmodSync(apkSigner, 0o700);

  const success = spawnSync(
    process.execPath,
    [resolve("scripts/verify-android-release.mjs"), releaseFixture()],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${toolsDirectory}:${process.env.PATH}` },
    },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Verified app-release\.apk \(io\.github\.agentaxiom\.salvo 1\.0\.0\)/);
  assert.match(success.stdout, /SHA-256 [a-f0-9]{64}/);

  const failure = spawnSync(process.execPath, [resolve("scripts/verify-android-release.mjs")], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /artifact path is required/i);
});
