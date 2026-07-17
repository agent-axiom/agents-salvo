import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
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
    lockCandidatePrefix: anchoredStatePath(
      parentPath,
      `${lockPath}.candidate-`,
      "Build lock candidate path",
    ),
    lockRecoveryPath: anchoredStatePath(
      parentPath,
      join(lockPath, ".recovery"),
      "Build lock recovery path",
    ),
    lockRecoveryCandidatePrefix: anchoredStatePath(
      parentPath,
      `${lockPath}.recovery-candidate-`,
      "Build recovery candidate path",
    ),
    lockRecoveryQuarantinePrefix: anchoredStatePath(
      parentPath,
      `${lockPath}.recovery-quarantine-`,
      "Build recovery quarantine path",
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
    onCandidateReady,
    onRecoveryCandidateReady,
    onRecoveryClaimPublished,
  } = {},
) {
  if (onCandidateReady !== undefined && typeof onCandidateReady !== "function") {
    throw new TypeError("onCandidateReady must be a function when provided.");
  }
  if (
    onRecoveryCandidateReady !== undefined
    && typeof onRecoveryCandidateReady !== "function"
  ) {
    throw new TypeError(
      "onRecoveryCandidateReady must be a function when provided.",
    );
  }
  if (
    onRecoveryClaimPublished !== undefined
    && typeof onRecoveryClaimPublished !== "function"
  ) {
    throw new TypeError(
      "onRecoveryClaimPublished must be a function when provided.",
    );
  }
  const paths = buildStatePaths(output);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspection = await inspectLock(paths.lockPath, staleMs);
    if (inspection.exists) {
      await waitForExistingLock(paths, inspection, {
        deadline,
        onRecoveryCandidateReady,
        onRecoveryClaimPublished,
        retryMs,
        staleMs,
      });
      continue;
    }

    const candidate = await prepareLockCandidate(paths);
    let candidateOwned = true;
    const removeCandidate = async () => {
      if (candidateOwned) {
        await removeOwnedCandidate(candidate);
        candidateOwned = false;
      }
    };
    try {
      await onCandidateReady?.({
        candidatePath: candidate.path,
        owner: candidate.owner,
        ownerPath: candidate.ownerPath,
      });

      const current = await inspectLock(paths.lockPath, staleMs);
      if (current.exists) {
        await removeCandidate();
        await waitForExistingLock(paths, current, {
          deadline,
          onRecoveryCandidateReady,
          onRecoveryClaimPublished,
          retryMs,
          staleMs,
        });
        continue;
      }

      try {
        await rename(candidate.path, paths.lockPath);
        candidateOwned = false;
        return { owner: candidate.owner, path: paths.lockPath };
      } catch (error) {
        await removeCandidate();
        if (!isLockContentionError(error)) {
          throw error;
        }
        const winner = await inspectLock(paths.lockPath, staleMs);
        if (!winner.exists) {
          throw error;
        }
        await waitForExistingLock(paths, winner, {
          deadline,
          onRecoveryCandidateReady,
          onRecoveryClaimPublished,
          retryMs,
          staleMs,
        });
      }
    } finally {
      await removeCandidate();
    }
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

async function prepareLockCandidate(paths) {
  return prepareOwnedCandidate(paths, {
    candidatePrefix: paths.lockCandidatePrefix,
    directoryLabel: "Build lock candidate path",
    ownerLabel: "Build lock candidate owner path",
  });
}

async function prepareRecoveryCandidate(paths) {
  return prepareOwnedCandidate(paths, {
    candidatePrefix: paths.lockRecoveryCandidatePrefix,
    directoryLabel: "Build recovery candidate path",
    ownerLabel: "Build recovery candidate owner path",
  });
}

async function prepareOwnedCandidate(
  paths,
  { candidatePrefix, directoryLabel, ownerLabel },
) {
  while (true) {
    const owner = {
      pid: process.pid,
      timestamp: Date.now(),
      token: randomUUID(),
    };
    const candidatePath = anchoredStatePath(
      paths.parentPath,
      `${candidatePrefix}${owner.token}`,
      directoryLabel,
    );
    try {
      await mkdir(candidatePath);
    } catch (error) {
      if (error.code === "EEXIST") {
        continue;
      }
      throw error;
    }

    const stats = await inspectRealDirectory(
      candidatePath,
      directoryLabel,
    );
    const ownerPath = anchoredStatePath(
      paths.parentPath,
      join(candidatePath, "owner.json"),
      ownerLabel,
    );
    const candidate = {
      device: stats.dev,
      directoryLabel,
      inode: stats.ino,
      owner,
      ownerLabel,
      ownerPath,
      path: candidatePath,
    };
    try {
      await writeDurableOwner(candidate);
      return candidate;
    } catch (error) {
      await removeCandidateByIdentity(candidate);
      throw error;
    }
  }
}

async function writeDurableOwner(candidate) {
  await inspectRealDirectory(candidate.path, candidate.directoryLabel);
  let handle;
  try {
    handle = await open(candidate.ownerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(candidate.owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    if (handle) {
      await handle.close();
    }
  }
  await inspectRealDirectory(candidate.path, candidate.directoryLabel);
  await inspectRegularFile(candidate.ownerPath, candidate.ownerLabel);
}

async function removeOwnedCandidate(candidate) {
  const stats = await inspectRealDirectory(
    candidate.path,
    candidate.directoryLabel,
    { allowMissing: true },
  );
  if (!stats) {
    return;
  }
  if (stats.dev !== candidate.device || stats.ino !== candidate.inode) {
    throw new Error(
      `Build lock candidate ownership changed before cleanup: ${candidate.path}.`,
    );
  }
  const owner = await readLockOwner(candidate.path, {
    directoryLabel: candidate.directoryLabel,
    ownerLabel: candidate.ownerLabel,
  });
  if (!sameOwner(owner, candidate.owner)) {
    throw new Error(
      `Build lock candidate ownership changed before cleanup: ${candidate.path}.`,
    );
  }
  await rm(candidate.path, { recursive: true, force: true });
}

async function removeCandidateByIdentity(candidate) {
  const stats = await inspectRealDirectory(
    candidate.path,
    candidate.directoryLabel,
    { allowMissing: true },
  );
  if (!stats) {
    return;
  }
  if (stats.dev !== candidate.device || stats.ino !== candidate.inode) {
    throw new Error(
      `Build lock candidate ownership changed before cleanup: ${candidate.path}.`,
    );
  }
  await rm(candidate.path, { recursive: true, force: true });
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
    return { exists: false, recoverable: false };
  }

  const owner = await readLockOwner(lockPath);
  if (owner) {
    return {
      device: lockStats.dev,
      exists: true,
      inode: lockStats.ino,
      owner,
      recoverable: !processIsAlive(owner.pid),
    };
  }
  return {
    device: lockStats.dev,
    exists: true,
    inode: lockStats.ino,
    owner: null,
    recoverable: Date.now() - lockStats.mtimeMs >= staleMs,
  };
}

async function waitForExistingLock(
  paths,
  inspection,
  {
    deadline,
    onRecoveryCandidateReady,
    onRecoveryClaimPublished,
    retryMs,
    staleMs,
  },
) {
  if (inspection.recoverable) {
    const recovered = await recoverStaleLock(paths, inspection, {
      onRecoveryCandidateReady,
      onRecoveryClaimPublished,
      staleMs,
    });
    if (recovered) {
      return;
    }
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for build lock ${paths.lockPath}.`);
  }
  await delay(retryMs);
}

function isLockContentionError(error) {
  return ["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code);
}

async function acquireRecoveryClaim(
  paths,
  inspection,
  {
    onRecoveryCandidateReady,
    onRecoveryClaimPublished,
    staleMs,
  },
) {
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
  const existingRecovery = await inspectRecoveryClaim(paths, staleMs);
  if (existingRecovery.exists) {
    if (!existingRecovery.recoverable) {
      return null;
    }
    const removed = await removeAbandonedRecoveryClaim(
      paths,
      existingRecovery,
      staleMs,
    );
    if (!removed) {
      return null;
    }
  }

  const candidate = await prepareRecoveryCandidate(paths);
  let candidateOwned = true;
  const removeCandidate = async () => {
    if (candidateOwned) {
      await removeOwnedCandidate(candidate);
      candidateOwned = false;
    }
  };
  try {
    await onRecoveryCandidateReady?.({
      candidatePath: candidate.path,
      owner: candidate.owner,
      ownerPath: candidate.ownerPath,
    });

    const currentStats = await inspectRealDirectory(
      paths.lockPath,
      "Build lock path",
      { allowMissing: true },
    );
    if (
      !currentStats
      || currentStats.dev !== inspection.device
      || currentStats.ino !== inspection.inode
    ) {
      return null;
    }
    const currentRecovery = await inspectRecoveryClaim(paths, staleMs);
    if (currentRecovery.exists) {
      return null;
    }

    try {
      await rename(candidate.path, paths.lockRecoveryPath);
      candidateOwned = false;
    } catch (error) {
      await removeCandidate();
      if (error.code === "ENOENT") {
        return null;
      }
      if (!isLockContentionError(error)) {
        throw error;
      }
      const winner = await inspectRecoveryClaim(paths, staleMs);
      if (!winner.exists) {
        throw error;
      }
      return null;
    }

    const claim = {
      ...candidate,
      ownerPath: anchoredStatePath(
        paths.parentPath,
        join(paths.lockRecoveryPath, "owner.json"),
        "Build recovery claim owner path",
      ),
      path: paths.lockRecoveryPath,
    };
    await onRecoveryClaimPublished?.({
      claimPath: claim.path,
      owner: claim.owner,
      ownerPath: claim.ownerPath,
    });
    const publishedLock = await inspectRealDirectory(
      paths.lockPath,
      "Build lock path",
      { allowMissing: true },
    );
    if (
      !publishedLock
      || publishedLock.dev !== inspection.device
      || publishedLock.ino !== inspection.inode
    ) {
      await releaseRecoveryClaim(claim);
      return null;
    }
    return claim;
  } finally {
    await removeCandidate();
  }
}

async function inspectRecoveryClaim(
  paths,
  staleMs,
  {
    directoryLabel = "Build lock recovery path",
    ownerLabel = "Build recovery claim owner path",
    path = paths.lockRecoveryPath,
  } = {},
) {
  const stats = await inspectRealDirectory(path, directoryLabel, {
    allowMissing: true,
  });
  if (!stats) {
    return { exists: false, recoverable: false };
  }
  const owner = await readLockOwner(path, {
    directoryLabel,
    ownerLabel,
  });
  return {
    device: stats.dev,
    exists: true,
    inode: stats.ino,
    mtimeMs: stats.mtimeMs,
    owner,
    recoverable: owner
      ? !processIsAlive(owner.pid)
      : Date.now() - stats.mtimeMs >= staleMs,
  };
}

async function removeAbandonedRecoveryClaim(paths, inspection, staleMs) {
  let quarantinePath;
  while (true) {
    quarantinePath = anchoredStatePath(
      paths.parentPath,
      `${paths.lockRecoveryQuarantinePrefix}${randomUUID()}`,
      "Build recovery quarantine path",
    );
    try {
      await rename(paths.lockRecoveryPath, quarantinePath);
      break;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      if (error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  const quarantined = await inspectRecoveryClaim(paths, staleMs, {
    directoryLabel: "Build recovery quarantine path",
    ownerLabel: "Build recovery quarantine owner path",
    path: quarantinePath,
  });
  if (
    !sameDirectoryIdentity(quarantined, inspection)
    || !sameInspectedOwner(quarantined.owner, inspection.owner)
    || !quarantined.recoverable
  ) {
    await restoreRecoveryClaim(paths, quarantinePath);
    return false;
  }

  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function restoreRecoveryClaim(paths, quarantinePath) {
  const current = await inspectRealDirectory(
    paths.lockRecoveryPath,
    "Build lock recovery path",
    { allowMissing: true },
  );
  if (current) {
    return false;
  }
  try {
    await rename(quarantinePath, paths.lockRecoveryPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || isLockContentionError(error)) {
      return false;
    }
    throw error;
  }
}

function sameDirectoryIdentity(first, second) {
  return (
    (first.device === undefined
      || second.device === undefined
      || first.device === second.device)
    && (first.inode === undefined
      || second.inode === undefined
      || first.inode === second.inode)
  );
}

function sameInspectedOwner(first, second) {
  return second ? sameOwner(first, second) : first === null;
}

async function releaseRecoveryClaim(claim) {
  const stats = await inspectRealDirectory(
    claim.path,
    "Build recovery claim path",
  );
  const owner = await readLockOwner(claim.path, {
    directoryLabel: "Build recovery claim path",
    ownerLabel: "Build recovery claim owner path",
  });
  if (
    stats.dev !== claim.device
    || stats.ino !== claim.inode
    || !sameOwner(owner, claim.owner)
  ) {
    throw new Error(
      `Build recovery claim ownership changed before release: ${claim.path}.`,
    );
  }
  await rm(claim.path, { recursive: true, force: true });
}

async function recoverStaleLock(
  paths,
  inspection,
  {
    onRecoveryCandidateReady,
    onRecoveryClaimPublished,
    staleMs,
  },
) {
  const claim = await acquireRecoveryClaim(paths, inspection, {
    onRecoveryCandidateReady,
    onRecoveryClaimPublished,
    staleMs,
  });
  if (!claim) {
    return false;
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
      await releaseRecoveryClaim(claim);
    }
  }
}

async function readLockOwner(
  lockPath,
  {
    directoryLabel = "Build lock path",
    ownerLabel = "Build lock owner path",
  } = {},
) {
  const parentPath = dirname(resolve(lockPath));
  const ownerPath = anchoredStatePath(
    parentPath,
    join(lockPath, "owner.json"),
    ownerLabel,
  );
  const lock = await inspectRealDirectory(lockPath, directoryLabel, {
    allowMissing: true,
  });
  if (!lock) {
    return null;
  }
  const ownerStats = await inspectRegularFile(
    ownerPath,
    ownerLabel,
    { allowMissing: true },
  );
  if (!ownerStats) {
    return null;
  }
  await inspectRealDirectory(lockPath, directoryLabel);
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
