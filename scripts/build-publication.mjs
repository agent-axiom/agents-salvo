import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export function buildStatePaths(output) {
  const parent = dirname(output);
  const name = basename(output);
  const lockPath = resolve(parent, `.${name}.lock`);
  return {
    backupPath: resolve(parent, `.${name}.backup`),
    lockOwnerPath: join(lockPath, "owner.json"),
    lockPath,
    stagePrefix: resolve(parent, `.${name}.stage-`),
    staleLockPrefix: resolve(parent, `.${name}.lock.stale-`),
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
      const recovered = await recoverStaleLock(paths.lockPath, inspection);
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
  const owner = await readLockOwner(join(lock.path, "owner.json"));
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`Build lock ownership changed before release: ${lock.path}.`);
  }
  await rm(lock.path, { recursive: true, force: true });
}

export async function reconcileBuildState(output, lock) {
  await assertLockOwnership(lock);
  const paths = buildStatePaths(output);
  const destinationExists = await pathExists(output);
  const backupExists = await pathExists(paths.backupPath);

  if (!destinationExists && backupExists) {
    await rename(paths.backupPath, output);
  } else if (destinationExists && backupExists) {
    await rm(paths.backupPath, { recursive: true, force: true });
  }

  const entries = await readdir(dirname(output));
  const stageNamePrefix = basename(paths.stagePrefix);
  const staleLockNamePrefix = basename(paths.staleLockPrefix);
  for (const entry of entries) {
    if (
      entry.startsWith(stageNamePrefix)
      || entry.startsWith(staleLockNamePrefix)
    ) {
      await rm(resolve(dirname(output), entry), { recursive: true, force: true });
    }
  }
}

export async function publishBuild(
  stage,
  output,
  { renamePath = rename, removePath = rm } = {},
) {
  const { backupPath } = buildStatePaths(output);
  let hasPrevious = false;
  try {
    await renamePath(output, backupPath);
    hasPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await renamePath(stage, output);
  } catch (publishError) {
    if (hasPrevious) {
      try {
        await renamePath(backupPath, output);
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          `Build publication failed; previous output remains at ${backupPath}.`,
        );
      }
    }
    throw publishError;
  }

  if (hasPrevious) {
    await removePath(backupPath, { recursive: true, force: true });
  }
}

async function writeLockOwner(paths, owner) {
  const temporaryPath = join(paths.lockPath, `.owner-${owner.token}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, paths.lockOwnerPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function assertLockOwnership(lock) {
  const owner = await readLockOwner(join(lock.path, "owner.json"));
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`Build lock is not owned by this process: ${lock.path}.`);
  }
}

async function inspectLock(lockPath, staleMs) {
  let lockStats;
  try {
    lockStats = await stat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { recoverable: false };
    }
    throw error;
  }

  const owner = await readLockOwner(join(lockPath, "owner.json"));
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

async function recoverStaleLock(lockPath, inspection) {
  const recoveryMarker = join(lockPath, ".recovery");
  try {
    await mkdir(recoveryMarker);
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  let quarantined = false;
  try {
    const currentStats = await stat(lockPath);
    if (
      currentStats.dev !== inspection.device
      || currentStats.ino !== inspection.inode
    ) {
      return false;
    }
    const currentOwner = await readLockOwner(join(lockPath, "owner.json"));
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

    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, quarantinePath);
    quarantined = true;
    await rm(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  } finally {
    if (!quarantined) {
      await rm(recoveryMarker, { recursive: true, force: true });
    }
  }
}

async function readLockOwner(ownerPath) {
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
