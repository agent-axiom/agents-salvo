import { pathToFileURL } from "node:url";

import {
  checkRuStoreAccess,
  expandRuStoreRollout,
  submitRuStoreUpdate,
} from "./rustore-api-client.mjs";

const DEFAULT_OPERATIONS = Object.freeze({
  check: checkRuStoreAccess,
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
    throw new Error("RuStore command must be check, submit, or rollout.");
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
      releaseNotes: requireValue(env.RUSTORE_RELEASE_NOTES, "RuStore release notes"),
      apkPath: requireValue(env.RUSTORE_APK_PATH, "RuStore APK path"),
    });
    stdout.write(
      `Submitted ${result.packageName} version ${result.versionId} for moderation at ${result.rollout}%.\n`,
    );
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
