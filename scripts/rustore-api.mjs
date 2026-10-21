import { pathToFileURL } from "node:url";
import { resolveRuStoreReleaseNotes } from "./rustore-release-notes.mjs";

import {
  checkRuStoreAccess,
  expandRuStoreRollout,
  getRuStoreVersionStatus,
  submitRuStoreUpdate,
} from "./rustore-api-client.mjs";

const DEFAULT_OPERATIONS = Object.freeze({
  check: checkRuStoreAccess,
  status: getRuStoreVersionStatus,
  submit: submitRuStoreUpdate,
  rollout: expandRuStoreRollout,
});

function requireValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function credentials(env) {
  return {
    keyId: requireValue(env.RUSTORE_KEY_ID, "RuStore key ID"),
    privateKey: requireValue(env.RUSTORE_PRIVATE_KEY, "RuStore private key"),
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export async function runRuStoreCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  operations = {},
} = {}) {
  const command = argv[0];
  if (!Object.hasOwn(DEFAULT_OPERATIONS, command)) {
    throw new Error("RuStore command must be check, status, submit, or rollout.");
  }

  const operation = operations[command] ?? DEFAULT_OPERATIONS[command];
  const auth = credentials(env);

  if (command === "check") {
    const result = await operation(auth);
    const version = result.versionCode == null ? "unknown" : result.versionCode;
    stdout.write(
      `RuStore API access verified for ${result.packageName} (${result.appStatus ?? "UNKNOWN"}, code ${version}).\n`,
    );
    return result;
  }

  if (command === "submit") {
    const result = await operation({
      ...auth,
      developerEmail: requireValue(env.RUSTORE_DEVELOPER_EMAIL, "RuStore developer email"),
      releaseNotes: resolveRuStoreReleaseNotes({ override: env.RUSTORE_RELEASE_NOTES ?? "" }),
      apkPath: requireValue(env.RUSTORE_APK_PATH, "RuStore APK path"),
    });
    stdout.write(
      `RuStore accepted the moderation request for ${result.packageName} version ${result.versionId} at ${result.rollout}% rollout. Current version status has not been checked.\n`,
    );
    return result;
  }

  if (command === "status") {
    const result = await operation({
      ...auth,
      versionId: positiveInteger(env.RUSTORE_VERSION_ID, "RuStore version ID"),
    });
    const display = (value) => value == null ? "not reported" : JSON.stringify(value);
    const rollout = result.partialValue == null ? "not reported" : `${display(result.partialValue)}%`;
    stdout.write(`Application ID: ${display(result.appId)}.\n`);
    stdout.write(
      `RuStore version ${result.versionId} for ${result.packageName}: ${result.versionStatus}.\n`,
    );
    stdout.write(`Version name: ${display(result.versionName)}; code: ${display(result.versionCode)}.\n`);
    stdout.write(`Sent for moderation: ${display(result.sendDateForModer)}; rollout: ${rollout}.\n`);
    return result;
  }

  const target = Number(env.RUSTORE_ROLLOUT_TARGET);
  if (![25, 100].includes(target)) {
    throw new Error("RuStore rollout target must be 25 or 100.");
  }
  const result = await operation({
    ...auth,
    versionId: positiveInteger(env.RUSTORE_VERSION_ID, "RuStore version ID"),
    target,
  });
  stdout.write(
    `Expanded RuStore version ${result.versionId} from ${result.previous}% to ${result.target}%.\n`,
  );
  return result;
}

const isMain = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  try {
    await runRuStoreCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "RuStore command failed."}\n`);
    process.exitCode = 1;
  }
}
