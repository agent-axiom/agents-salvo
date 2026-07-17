import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export function buildStatePaths(output) {
  // build.mjs canonicalizes the destination before state siblings are derived.
  const destinationPath = resolve(output);
  const parentPath = dirname(destinationPath);
  const name = basename(destinationPath);
  const lockPath = anchoredStatePath(
    parentPath,
    resolve(parentPath, `.${name}.lock`),
    "Build lock path",
  );
  return {
    backupPath: anchoredStatePath(
      parentPath,
      resolve(parentPath, `.${name}.backup`),
      "Build backup path",
    ),
    destinationPath,
    lockOwnerPath: anchoredStatePath(
      parentPath,
      join(lockPath, "owner.json"),
      "Build lock owner path",
    ),
    lockPath,
    lockRecoveryPath: anchoredStatePath(
      parentPath,
      join(lockPath, ".recovery"),
      "Build lock recovery path",
    ),
    parentPath,
    stagePrefix: anchoredStatePath(
      parentPath,
      resolve(parentPath, `.${name}.stage-`),
      "Build stage path",
    ),
    staleLockPrefix: anchoredStatePath(
      parentPath,
      resolve(parentPath, `.${name}.lock.stale-`),
      "Build stale lock path",
    ),
  };
}

export async function acquireBuildLock(
  output,
  {
    retryMs = DEFAULT_LOCK_RETRY_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  } = {},
) {
  const paths = buildStatePaths(output);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let created = false;
    try {
      await mkdir(paths.lockPath);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    if (created) {
      const owner = {
        pid: process.pid,
        timestamp: Date.now(),
        token: randomUUID(),
      };
      try {
        await writeLockOwner(paths, owner);
        return { owner, path: paths.lockPath };
      } catch (error) {
        await rm(paths.lockPath, { recursive: true, force: true });
        throw error;
      }
    }

    const inspection = await inspectLock(paths.lockPath, staleMs);
    if (inspection.recoverable) {
      const recovered = await recoverStaleLock(paths, inspection);
      if (recovered) {
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for build lock ${paths.lockPath}.`);
    }
    await delay(retryMs);
  }
}

export async function releaseBuildLock(lock) {
  const owner = await readLockOwner(lock.path);
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`Build lock ownership changed before release: ${lock.path}.`);
  }
  await rm(lock.path, { recursive: true, force: true });
}

export async function reconcileBuildState(output, lock) {
  const paths = buildStatePaths(output);
  await assertLockOwnership(lock, paths.lockPath);
  const destinationExists = await pathExists(paths.destinationPath);
  const backup = await inspectRealDirectory(
    paths.backupPath,
    "Build backup path",
    { allowMissing: true },
  );

  if (!destinationExists && backup) {
    await rename(paths.backupPath, paths.destinationPath);
  } else if (destinationExists && backup) {
    await rm(paths.backupPath, { recursive: true, force: true });
  }

  const entries = await readdir(paths.parentPath);
  const stageNamePrefix = basename(paths.stagePrefix);
  const staleLockNamePrefix = basename(paths.staleLockPrefix);
  for (const entry of entries) {
    if (
      entry.startsWith(stageNamePrefix)
      || entry.startsWith(staleLockNamePrefix)
    ) {
      const statePath = anchoredStatePath(
        paths.parentPath,
        resolve(paths.parentPath, entry),
        entry.startsWith(stageNamePrefix)
          ? "Build stage path"
          : "Build stale lock path",
      );
      await inspectRealDirectory(
        statePath,
        entry.startsWith(stageNamePrefix)
          ? "Build stage path"
          : "Build stale lock path",
      );
      await rm(statePath, { recursive: true, force: true });
    }
  }
}

export async function publishBuild(
  stage,
  output,
  { renamePath = rename, removePath = rm } = {},
) {
  const paths = buildStatePaths(output);
  const stagePath = assertStagePath(paths, stage);
  await inspectRealDirectory(stagePath, "Build stage path");
  await inspectRealDirectory(paths.backupPath, "Build backup path", {
    allowMissing: true,
  });
  let hasPrevious = false;
  try {
    await renamePath(paths.destinationPath, paths.backupPath);
    hasPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await renamePath(stagePath, paths.destinationPath);
  } catch (publishError) {
    if (hasPrevious) {
      try {
        await renamePath(paths.backupPath, paths.destinationPath);
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          `Build publication failed; previous output remains at ${paths.backupPath}.`,
        );
      }
    }
    throw publishError;
  }

  if (hasPrevious) {
    await removePath(paths.backupPath, { recursive: true, force: true });
  }
}

async function writeLockOwner(paths, owner) {
  await inspectRealDirectory(paths.lockPath, "Build lock path");
  const temporaryPath = anchoredStatePath(
    paths.parentPath,
    join(paths.lockPath, `.owner-${owner.token}.tmp`),
    "Build lock owner path",
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await inspectRealDirectory(paths.lockPath, "Build lock path");
    await rename(temporaryPath, paths.lockOwnerPath);
  } catch (error) {
    const lock = await inspectRealDirectory(paths.lockPath, "Build lock path", {
      allowMissing: true,
    });
    if (lock) {
      await rm(temporaryPath, { force: true });
    }
    throw error;
  }
}

async function assertLockOwnership(lock, expectedPath = lock.path) {
  if (resolve(lock.path) !== resolve(expectedPath)) {
    throw new Error(`Build lock is not owned by this process: ${lock.path}.`);
  }
  const owner = await readLockOwner(lock.path);
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`Build lock is not owned by this process: ${lock.path}.`);
  }
}

async function inspectLock(lockPath, staleMs) {
  const lockStats = await inspectRealDirectory(lockPath, "Build lock path", {
    allowMissing: true,
  });
  if (!lockStats) {
    return { recoverable: false };
  }

  const owner = await readLockOwner(lockPath);
  if (owner) {
    return {
      device: lockStats.dev,
      inode: lockStats.ino,
      owner,
      recoverable: !processIsAlive(owner.pid),
    };
  }
  return {
    device: lockStats.dev,
    inode: lockStats.ino,
    owner: null,
    recoverable: Date.now() - lockStats.mtimeMs >= staleMs,
  };
}

async function recoverStaleLock(paths, inspection) {
  const lockStats = await inspectRealDirectory(
    paths.lockPath,
    "Build lock path",
    { allowMissing: true },
  );
  if (!lockStats) {
    return false;
  }
  if (
    lockStats.dev !== inspection.device
    || lockStats.ino !== inspection.inode
  ) {
    return false;
  }
  const existingRecovery = await inspectRealDirectory(
    paths.lockRecoveryPath,
    "Build lock recovery path",
    { allowMissing: true },
  );
  if (existingRecovery) {
    return false;
  }
  try {
    await mkdir(paths.lockRecoveryPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      await inspectRealDirectory(
        paths.lockRecoveryPath,
        "Build lock recovery path",
        { allowMissing: true },
      );
      return false;
    }
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  let quarantined = false;
  try {
    const currentStats = await inspectRealDirectory(
      paths.lockPath,
      "Build lock path",
    );
    if (
      currentStats.dev !== inspection.device
      || currentStats.ino !== inspection.inode
    ) {
      return false;
    }
    const currentOwner = await readLockOwner(paths.lockPath);
    if (inspection.owner) {
      if (
        !sameOwner(currentOwner, inspection.owner)
        || processIsAlive(currentOwner.pid)
      ) {
        return false;
      }
    } else if (currentOwner) {
      return false;
    }

    const quarantinePath = anchoredStatePath(
      paths.parentPath,
      `${paths.staleLockPrefix}${randomUUID()}`,
      "Build stale lock path",
    );
    await rename(paths.lockPath, quarantinePath);
    quarantined = true;
    await inspectRealDirectory(quarantinePath, "Build stale lock path");
    await rm(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    if (!quarantined) {
      const currentLock = await inspectRealDirectory(
        paths.lockPath,
        "Build lock path",
        { allowMissing: true },
      );
      if (currentLock) {
        const currentRecovery = await inspectRealDirectory(
          paths.lockRecoveryPath,
          "Build lock recovery path",
          { allowMissing: true },
        );
        if (currentRecovery) {
          await rm(paths.lockRecoveryPath, { recursive: true, force: true });
        }
      }
    }
  }
}

async function readLockOwner(lockPath) {
  const parentPath = dirname(resolve(lockPath));
  const ownerPath = anchoredStatePath(
    parentPath,
    join(lockPath, "owner.json"),
    "Build lock owner path",
  );
  const lock = await inspectRealDirectory(lockPath, "Build lock path", {
    allowMissing: true,
  });
  if (!lock) {
    return null;
  }
  const ownerStats = await inspectRegularFile(
    ownerPath,
    "Build lock owner path",
    { allowMissing: true },
  );
  if (!ownerStats) {
    return null;
  }
  await inspectRealDirectory(lockPath, "Build lock path");
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    if (
      Number.isInteger(owner.pid)
      && owner.pid > 0
      && Number.isFinite(owner.timestamp)
      && typeof owner.token === "string"
      && owner.token.length > 0
    ) {
      return owner;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return null;
}

function anchoredStatePath(parentPath, candidate, label) {
  const canonicalParent = resolve(parentPath);
  const statePath = resolve(candidate);
  const childPath = relative(canonicalParent, statePath);
  if (
    !childPath
    || childPath === ".."
    || childPath.startsWith(`..${sep}`)
    || isAbsolute(childPath)
  ) {
    throw new Error(
      `${label} must remain under the canonical build destination parent.`,
    );
  }
  return statePath;
}

function assertStagePath(paths, stage) {
  const stagePath = anchoredStatePath(
    paths.parentPath,
    stage,
    "Build stage path",
  );
  const stageNamePrefix = basename(paths.stagePrefix);
  if (
    dirname(stagePath) !== paths.parentPath
    || !basename(stagePath).startsWith(stageNamePrefix)
    || basename(stagePath) === stageNamePrefix
  ) {
    throw new Error(
      "Build stage path must be a generated sibling of the destination.",
    );
  }
  return stagePath;
}

async function inspectRealDirectory(
  path,
  label,
  { allowMissing = false } = {},
) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}.`);
  }
  return stats;
}

async function inspectRegularFile(
  path,
  label,
  { allowMissing = false } = {},
) {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}.`);
  }
  return stats;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function sameOwner(first, second) {
  return Boolean(
    first
    && second
    && first.pid === second.pid
    && first.timestamp === second.timestamp
    && first.token === second.token,
  );
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
