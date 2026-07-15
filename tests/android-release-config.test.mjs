import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ANDROID_RELEASE_CERTIFICATE_SHA256,
  ANDROID_RELEASE_PERMISSIONS,
  verifyAndroidRelease,
} from "../scripts/verify-android-release.mjs";

const gradle = readFileSync("android/app/build.gradle", "utf8");
const manifest = readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const rootGitignore = readFileSync(".gitignore", "utf8");
const androidGitignore = readFileSync("android/.gitignore", "utf8");

const RELEASE_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIFOzCCAyOgAwIBAgIILrwnTPILFZ4wDQYJKoZIhvcNAQELBQAwSzELMAkGA1UE
BhMCUlUxFDASBgNVBAoTC0FnZW50IEF4aW9tMQ8wDQYDVQQLEwZNb2JpbGUxFTAT
BgNVBAMTDEFnZW50cyBTYWx2bzAgFw0yNjA3MTUxNDI0NTVaGA8yMDUzMTEzMDE0
MjQ1NVowSzELMAkGA1UEBhMCUlUxFDASBgNVBAoTC0FnZW50IEF4aW9tMQ8wDQYD
VQQLEwZNb2JpbGUxFTATBgNVBAMTDEFnZW50cyBTYWx2bzCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAO5G36ml2cf+y6+pLzhjRrmPr/2D3t2Aq5LtUlaG
N546YVT9Mw3qLR8BOkskR4aIaSt5/AkMOucvJ/vqONATf4N8UoiEnKy2Zkyc+4Qk
g2aI8qvE2QsKhjWrX2wY+mSfbPQAZ2Nt2J8Lr3UsHCtHyL3FfuE+ZP+RAHLYVisd
+NYcWceEJ3ZRCw/myj5i8gwi0dhEhu4vNV4V8yhNr/CONo038CaGCUJF9Dbcex4s
0OyDmBueplLiFRYUWtDjkKdzUJjdk2vwpF0UkNMZ9EclxbZoqVmHthKhOVEbrXNF
girMWLf2m03OJk3Cqxgc5pXS7FnjmWnJLmr+1tmoIurGv9LTAzsa4oCYYz0oE3J7
pl2rtCDm7oG90KPhAPxZCM4X0V2Ag5jzV7tM/8MIBd20HATeYppHZ9XFvmUwpl+o
6zGabEGT+JbLiotw21IiY90c/T8ntks4sbtuahXMkbr83xoxP+j0sDQmurV1coWX
ykm1LQ7y3qjkE4sHPjJLyl2lKyFekmtXwfb+kQgjC3xi2l9Fbx6AcGzITt+LpcCD
/XvgkkE1+7UrM9qhkGoD7jBAYgnS/VHcke6GKwtyU4EZ77+isRCKdA/ujwv5Y6Lm
/zUCg25bKpjxBJfbmdbaBHZ/uiG1DQYqOSosEX9jIe1Jujv0SDyfO6/7vQmEOsIY
+csLAgMBAAGjITAfMB0GA1UdDgQWBBQPdQcC3ckAOqO15bu5/ElXG2VHYDANBgkq
hkiG9w0BAQsFAAOCAgEA1JfX5XZmWn020Z9wQ3zgoIIDZKeIQnJqtoj0ikKU4oy5
rC6XlX3UJfOqt//EjPHozesWdqth3FnvLni0QCrjjB2LvioVwYMPBUqS6T5MRtu1
o8veBkJf1mqgTwJpF6E12yTehZWkS3fOFHLqYiB0sTeaVfNDuW7dizquD7UpAMXw
lPJS6AFM9bOgYzuQHkrzBFbbRrDv4d9M+Zh9WhHMH5wCkzLvk0yU6m56gGABK8++
QmsekW5BQNsPazcoEm7KPojGJCtNiipCbycD71cyQOPDaWn2czpG7W1xa1TgeZSy
nP1qUsziIlZYXnh4WtXcY1q+CJrXNVMXot8rjzMRNN3Bs2DaePUrKC6l6EG3x9Ro
SE3975AcU9c4bTdhrvuwPVC2c//zyb8upjXXPkPyy3Nnsy83OY6yyT/A+tKUdPzl
JZlazfcBIOQ0tzxETtHfS+UNnS1gB1hNtpb1E+eUrq8BvJxallHzM3Uf48WN+YLU
2+5KXkcdV0AX73w+U/kR9M9zZHiDxR2903sZXpZENAgQRF+/39lu0Vi1HcQQo5/z
U9vndhmNNqcmed0+J1LACdf1s9y9SiKfkJJkoe+6u6IN6aiJE1iauwaxWpJEoxUe
WUskno5UURd+Angkl20YU1QPlAnNk/WGwPcaQ9OJvxDwMcH/w1TCKQIClmsgkIM=
-----END CERTIFICATE-----`;

const OTHER_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIICtDCCAZwCCQDSDnxflGPRUTANBgkqhkiG9w0BAQsFADAcMRowGAYDVQQDDBFP
dGhlci1UZXN0LVNpZ25lcjAeFw0yNjA3MTUyMDIyNTNaFw0yNjA3MTYyMDIyNTNa
MBwxGjAYBgNVBAMMEU90aGVyLVRlc3QtU2lnbmVyMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2GW3FaNG+Ld9N71A2bFIGZefSjxS5gCqY/zt9iYxMAmh
dNw0IVvIRD0wHAccYw73y6JnmyAY2eTnSDCthjZMDlcZTNHJwRbGmSrHoDGgeklU
nsuLHoIIKHR5k8la+vUR2M79pUjgqEA1zGvNaQrkrl3768s3E09+tlNV2YE/DGzL
W+O614zWIGZlwqZQ3+HEUl/hFy9KgiaV4XpAWvU+w32cvqtLrFNu5rx9V/2hgvef
H+28ki+DJeKceWddXf6+YDNxew/CB1zUJmkMC5KSjHIMeHRJc6CCgrwO/S9mmxu8
9WQD3tRih4W+6vnQGLyjVH6JOgTshRWuR+8hmswfkQIDAQABMA0GCSqGSIb3DQEB
CwUAA4IBAQCLvnbySXuk9X/HRogqITM7GAfZhpIG9Gkvdh3YrSw7XePw5xo8y2ng
pZeGOFhlPG1gP+wVtssDvAJIYxcNfoDv8VTVCmu3ZVsj7thKKAC2zoKwbc2GVymo
tiIptvnADnHoZn3ypRA0LG1WDvrbgyzCGjQerCPoZIomsFU37RURdMN64YNQKXLE
qWar4V3Rz7Ar76EeuNPw9yo7lilfEzfFbmiwPXwqjhOsGOf+suFQ0ZaXuihl9ddA
dIF/QVvOZUiBT9cCa/bmrMUp2qbsoAi7cFHvjphFhKjQz1AuJdD37LYpiePulUVd
Bj6dbwAjER2yP65JPM8iZq4nOpwzQQBc
-----END CERTIFICATE-----`;

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
    if (invocation.includes("manifest permissions")) {
      return {
        status: 0,
        stdout: `${(overrides.permissions ?? ANDROID_RELEASE_PERMISSIONS).join("\n")}\n`,
        stderr: "",
      };
    }
    if (invocation.includes("application-id")) {
      return { status: 0, stdout: `${overrides.packageId ?? "io.github.agentaxiom.salvo"}\n`, stderr: "" };
    }
    if (invocation.includes("version-name")) {
      return { status: 0, stdout: `${overrides.versionName ?? "1.0.0"}\n`, stderr: "" };
    }
    if (command === "apksigner") {
      if (overrides.legacySigner && args.includes("--print-certs-pem")) {
        return { status: 1, stdout: "", stderr: "Unsupported option: --print-certs-pem" };
      }
      return {
        status: overrides.signatureStatus ?? 0,
        stdout: overrides.signatureOutput ?? `Verifies\n${RELEASE_CERTIFICATE_PEM}\n`,
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
    /permission inspection failed: command returned no diagnostics/i,
  );
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: (command, args) => args.includes("permissions")
        ? validCommandRunner()(command, args)
        : { status: 1, stdout: "manifest unavailable", stderr: "" },
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
    /signer certificate/i,
  );
  assert.throws(
    () => verifyAndroidRelease({ artifactPath: releaseFixture(), runCommand: validCommandRunner({
      legacySigner: true,
      signatureOutput: "Signer #1 certificate SHA-256 digest: DE:AD:BE:EF",
    }) }),
    /unexpected Android signing certificate/i,
  );
});

test("release verifier accepts range-qualified apksigner certificate labels", () => {
  const artifactPath = releaseFixture();
  const invocations = [];
  const commandRunner = validCommandRunner({
    legacySigner: true,
    signatureOutput:
      "Verifies\n" +
      `Signer (minSdkVersion=24, maxSdkVersion=35) certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}\n`,
  });
  const result = verifyAndroidRelease({
    artifactPath,
    runCommand: (command, args) => {
      invocations.push({ command, args });
      return commandRunner(command, args);
    },
  });

  assert.equal(result.certificateSha256, ANDROID_RELEASE_CERTIFICATE_SHA256);
  assert.deepEqual(
    invocations.filter(({ command }) => command === "apksigner").map(({ args }) => args[2]),
    ["--print-certs-pem", "--print-certs"],
  );
});

test("release verifier derives the signer fingerprint from an X.509 certificate", () => {
  const invocations = [];
  const commandRunner = validCommandRunner({
    signatureOutput: `Verifies\n${RELEASE_CERTIFICATE_PEM}\n`,
  });
  const result = verifyAndroidRelease({
    artifactPath: releaseFixture(),
    runCommand: (command, args) => {
      invocations.push({ command, args });
      return commandRunner(command, args);
    },
  });

  assert.equal(result.certificateSha256, ANDROID_RELEASE_CERTIFICATE_SHA256);
  assert.ok(
    invocations.some(({ command, args }) => command === "apksigner" && args.includes("--print-certs-pem")),
  );
});

test("release verifier rejects truncated PEM instead of trusting its text digest", () => {
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({
        signatureOutput:
          `Signer #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}\n` +
          "-----BEGIN CERTIFICATE-----\ntruncated\n",
      }),
    }),
    /invalid signer certificate/i,
  );
});

test("release verifier rejects another signer in PEM output", () => {
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({
        signatureOutput: `Verifies\n${RELEASE_CERTIFICATE_PEM}\n${OTHER_CERTIFICATE_PEM}\n`,
      }),
    }),
    /unexpected Android signing certificate/i,
  );
});

test("release verifier rejects reports containing another signer certificate", () => {
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({
        legacySigner: true,
        signatureOutput:
          `Signer #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}\n` +
          "Signer (minSdkVersion=36, maxSdkVersion=37) certificate SHA-256 digest: DEADBEEF\n",
      }),
    }),
    /unexpected Android signing certificate/i,
  );
});

test("release verifier rejects missing or unexpected merged APK permissions", () => {
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({
        permissions: ANDROID_RELEASE_PERMISSIONS.filter(
          (permission) => permission !== "android.permission.VIBRATE",
        ),
      }),
    }),
    /unexpected Android permissions.*VIBRATE/i,
  );
  assert.throws(
    () => verifyAndroidRelease({
      artifactPath: releaseFixture(),
      runCommand: validCommandRunner({
        permissions: [...ANDROID_RELEASE_PERMISSIONS, "android.permission.CAMERA"],
      }),
    }),
    /unexpected Android permissions.*CAMERA/i,
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
  const androidHome = mkdtempSync(join(tmpdir(), "salvo-shadowed-android-sdk-"));
  const apkAnalyzer = join(toolsDirectory, "apkanalyzer");
  const apkSigner = join(toolsDirectory, "apksigner");
  const sdkAnalyzer = join(androidHome, "cmdline-tools", "latest", "bin", "apkanalyzer");
  const sdkSigner = join(androidHome, "build-tools", "99.0.0", "apksigner");
  mkdirSync(join(androidHome, "cmdline-tools", "latest", "bin"), { recursive: true });
  mkdirSync(join(androidHome, "build-tools", "99.0.0"), { recursive: true });
  writeFileSync(
    apkAnalyzer,
    `#!/bin/sh
if [ "$2" = permissions ]; then
  printf '%s\\n' ${ANDROID_RELEASE_PERMISSIONS.map((permission) => `'${permission}'`).join(" ")}
elif [ "$2" = application-id ]; then
  echo io.github.agentaxiom.salvo
else
  echo 1.0.0
fi
`,
  );
  writeFileSync(
    apkSigner,
    `#!/bin/sh
if [ "$3" = "--print-certs-pem" ]; then
  echo 'Unsupported option: --print-certs-pem' >&2
  exit 1
fi
echo 'Signer #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}'
`,
  );
  writeFileSync(sdkAnalyzer, "#!/bin/sh\nexit 99\n");
  writeFileSync(sdkSigner, "#!/bin/sh\nexit 99\n");
  chmodSync(apkAnalyzer, 0o700);
  chmodSync(apkSigner, 0o700);
  chmodSync(sdkAnalyzer, 0o700);
  chmodSync(sdkSigner, 0o700);

  const success = spawnSync(
    process.execPath,
    [resolve("scripts/verify-android-release.mjs"), releaseFixture()],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: "",
        PATH: `${toolsDirectory}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Verified app-release\.apk \(io\.github\.agentaxiom\.salvo 1\.0\.0\)/);
  assert.match(success.stdout, /SHA-256 [a-f0-9]{64}/);

  const failure = spawnSync(process.execPath, [resolve("scripts/verify-android-release.mjs")], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /artifact path is required/i);
});

test("release verifier CLI resolves tools directly from the Android SDK", () => {
  const androidHome = mkdtempSync(join(tmpdir(), "salvo-android-sdk-"));
  const analyzerDirectory = join(androidHome, "cmdline-tools", "latest", "bin");
  const buildToolsDirectory = join(androidHome, "build-tools", "35.0.0");
  mkdirSync(analyzerDirectory, { recursive: true });
  mkdirSync(buildToolsDirectory, { recursive: true });

  const apkAnalyzer = join(analyzerDirectory, "apkanalyzer");
  const apkSigner = join(buildToolsDirectory, "apksigner");
  writeFileSync(
    apkAnalyzer,
    `#!/bin/sh
if [ "$2" = permissions ]; then
  printf '%s\\n' ${ANDROID_RELEASE_PERMISSIONS.map((permission) => `'${permission}'`).join(" ")}
elif [ "$2" = application-id ]; then
  echo io.github.agentaxiom.salvo
else
  echo 1.0.0
fi
`,
  );
  writeFileSync(
    apkSigner,
    `#!/bin/sh
if [ "$3" = "--print-certs-pem" ]; then
  echo 'Unsupported option: --print-certs-pem' >&2
  exit 1
fi
echo 'Signer #1 certificate SHA-256 digest: ${ANDROID_RELEASE_CERTIFICATE_SHA256}'
`,
  );
  chmodSync(apkAnalyzer, 0o700);
  chmodSync(apkSigner, 0o700);

  const result = spawnSync(
    process.execPath,
    [resolve("scripts/verify-android-release.mjs"), releaseFixture()],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: "",
        PATH: "/usr/bin:/bin",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified app-release\.apk/);
});
