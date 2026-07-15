#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const ANDROID_RELEASE_APPLICATION_ID = "io.github.agentaxiom.salvo";
export const ANDROID_RELEASE_VERSION_NAME = "1.0.0";
export const ANDROID_RELEASE_CERTIFICATE_SHA256 = "ec4972020b0b437f83bd29315c5260e2c75c834ed5c4e3650121cd878cd71436";
export const ANDROID_RELEASE_PERMISSIONS = Object.freeze([
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.INTERNET",
  "android.permission.VIBRATE",
  "io.github.agentaxiom.salvo.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
]);

function resolveAndroidCommand(command) {
  const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!androidHome) return command;

  const executable = process.platform === "win32" ? `${command}.bat` : command;
  if (command === "apkanalyzer") {
    const analyzer = join(androidHome, "cmdline-tools", "latest", "bin", executable);
    return existsSync(analyzer) ? analyzer : command;
  }
  if (command === "apksigner") {
    const buildToolsRoot = join(androidHome, "build-tools");
    if (!existsSync(buildToolsRoot)) return command;
    const versions = readdirSync(buildToolsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    const signer = versions
      .map((version) => join(buildToolsRoot, version, executable))
      .find((candidate) => existsSync(candidate));
    return signer || command;
  }
  return command;
}

function defaultCommandRunner(command, args) {
  const options = { encoding: "utf8" };
  const pathResult = spawnSync(command, args, options);
  if (pathResult.error?.code !== "ENOENT") return pathResult;

  const sdkCommand = resolveAndroidCommand(command);
  return sdkCommand === command ? pathResult : spawnSync(sdkCommand, args, options);
}

function runChecked(runCommand, command, args, description) {
  const result = runCommand(command, args);
  if (!result || result.status !== 0) {
    const details = String(result?.stderr || result?.stdout || "command returned no diagnostics").trim();
    throw new Error(`${description} failed: ${details}`);
  }
  return String(result.stdout ?? "").trim();
}

export function verifyAndroidRelease({
  artifactPath,
  expectedApplicationId = ANDROID_RELEASE_APPLICATION_ID,
  expectedVersionName = ANDROID_RELEASE_VERSION_NAME,
  expectedCertificateSha256 = ANDROID_RELEASE_CERTIFICATE_SHA256,
  expectedPermissions = ANDROID_RELEASE_PERMISSIONS,
  runCommand = defaultCommandRunner,
} = {}) {
  if (!artifactPath) {
    throw new Error("Android release artifact path is required.");
  }

  const absolutePath = resolve(artifactPath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Android release artifact does not exist: ${absolutePath}`);
  }
  if (extname(absolutePath).toLowerCase() !== ".apk") {
    throw new Error(`Android release verifier requires an APK: ${absolutePath}`);
  }
  if (/debug/i.test(basename(absolutePath))) {
    throw new Error(`Debug APKs cannot be published: ${absolutePath}`);
  }

  const permissions = runChecked(
    runCommand,
    "apkanalyzer",
    ["manifest", "permissions", absolutePath],
    "Android permission inspection",
  )
    .split(/\r?\n/)
    .map((permission) => permission.trim())
    .filter(Boolean)
    .sort();
  const expectedPermissionSet = [...expectedPermissions].sort();
  if (
    permissions.length !== expectedPermissionSet.length
    || permissions.some((permission, index) => permission !== expectedPermissionSet[index])
  ) {
    const missing = expectedPermissionSet.filter((permission) => !permissions.includes(permission));
    const unexpected = permissions.filter((permission) => !expectedPermissionSet.includes(permission));
    throw new Error(
      `Unexpected Android permissions: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
    );
  }

  const applicationId = runChecked(
    runCommand,
    "apkanalyzer",
    ["manifest", "application-id", absolutePath],
    "Android application ID inspection",
  );
  if (applicationId !== expectedApplicationId) {
    throw new Error(`Unexpected Android application ID: expected ${expectedApplicationId}, received ${applicationId}`);
  }

  const versionName = runChecked(
    runCommand,
    "apkanalyzer",
    ["manifest", "version-name", absolutePath],
    "Android version name inspection",
  );
  if (versionName !== expectedVersionName) {
    throw new Error(`Unexpected Android version name: expected ${expectedVersionName}, received ${versionName}`);
  }

  const signatureReport = runChecked(
    runCommand,
    "apksigner",
    ["verify", "--verbose", "--print-certs", absolutePath],
    "Android signature verification",
  );
  const certificateMatch = signatureReport.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i);
  if (!certificateMatch) {
    throw new Error("Android signature verification did not report a signer certificate digest.");
  }
  const certificateSha256 = certificateMatch[1].replaceAll(":", "").toLowerCase();
  const normalizedExpectedCertificate = expectedCertificateSha256.replaceAll(":", "").toLowerCase();
  if (certificateSha256 !== normalizedExpectedCertificate) {
    throw new Error(
      `Unexpected Android signing certificate: expected ${normalizedExpectedCertificate}, received ${certificateSha256}`,
    );
  }

  const sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  const checksumPath = `${absolutePath}.sha256`;
  writeFileSync(checksumPath, `${sha256}  ${basename(absolutePath)}\n`, "utf8");

  return {
    artifactPath: absolutePath,
    checksumPath,
    applicationId,
    versionName,
    certificateSha256,
    permissions,
    sha256,
    signatureReport,
  };
}

function runCli() {
  try {
    const result = verifyAndroidRelease({ artifactPath: process.argv[2] });
    process.stdout.write(
      `Verified ${basename(result.artifactPath)} (${result.applicationId} ${result.versionName})\n` +
        `SHA-256 ${result.sha256}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
