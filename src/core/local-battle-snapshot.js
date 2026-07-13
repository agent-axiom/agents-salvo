export const LOCAL_BATTLE_SNAPSHOT_VERSION = 1;

const LOCAL_BATTLE_KEY = "localBattle";
const LOCAL_BATTLE_QUARANTINE_KEY = "localBattleQuarantine";
const LOCAL_SCREENS_BY_MODE = new Map([
  ["agent", new Set(["setup", "playing"])],
  ["hotseat", new Set(["setup", "playing", "pass"])],
  ["training", new Set(["training"])],
]);

class LocalBattleSnapshotValidationError extends TypeError {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSupportedModeScreen(value) {
  return LOCAL_SCREENS_BY_MODE.get(value?.mode)?.has(value?.screen) === true;
}

function isFinished(value) {
  if (value?.mode === "training") {
    return value?.training?.session?.phase === "finished";
  }
  if (value?.mode === "agent" || value?.mode === "hotseat") {
    return value?.game?.phase === "finished";
  }
  return false;
}

function isValidPresetId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSavedAt(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isValidSnapshot(value) {
  return (
    isObject(value) &&
    value.version === LOCAL_BATTLE_SNAPSHOT_VERSION &&
    isSupportedModeScreen(value) &&
    isValidPresetId(value.presetId) &&
    isValidSavedAt(value.savedAt) &&
    !isFinished(value)
  );
}

function cloneSnapshot(value) {
  return structuredClone({
    version: value.version,
    savedAt: value.savedAt,
    screen: value.screen,
    mode: value.mode,
    presetId: value.presetId,
    setupPlayerId: value.setupPlayerId,
    setupBoard: value.setupBoard,
    setupOrientation: value.setupOrientation,
    setupSelectedShipId: value.setupSelectedShipId,
    boards: value.boards,
    game: value.game,
    battleTab: value.battleTab,
    agentDifficulty: value.agentDifficulty,
    passPlayerId: value.passPlayerId,
    training: value.training,
  });
}

export function createLocalBattleSnapshot(
  state,
  now = () => new Date().toISOString(),
) {
  if (!isObject(state) || !isSupportedModeScreen(state) || isFinished(state)) {
    return null;
  }

  const snapshot = {
    version: LOCAL_BATTLE_SNAPSHOT_VERSION,
    savedAt: now(),
    screen: state.screen,
    mode: state.mode,
    presetId: state.presetId,
    setupPlayerId: state.setupPlayerId,
    setupBoard: state.setupBoard,
    setupOrientation: state.setupOrientation,
    setupSelectedShipId: state.setupSelectedShipId,
    boards: state.boards,
    game: state.game,
    battleTab: state.battleTab,
    agentDifficulty: state.agentDifficulty,
    passPlayerId: state.passPlayerId,
    training: state.training,
  };

  return isValidSnapshot(snapshot) ? cloneSnapshot(snapshot) : null;
}

export function parseLocalBattleSnapshot(raw) {
  if (typeof raw !== "string") {
    throw new LocalBattleSnapshotValidationError("Snapshot must be JSON");
  }

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new LocalBattleSnapshotValidationError("Snapshot must be valid JSON");
  }

  if (!isValidSnapshot(snapshot)) {
    throw new LocalBattleSnapshotValidationError("Snapshot is unsupported");
  }

  return cloneSnapshot(snapshot);
}

export function createLocalBattleSnapshotStore(settings, { now } = {}) {
  return {
    async save(state) {
      const snapshot = createLocalBattleSnapshot(state, now);
      await settings.set(
        LOCAL_BATTLE_KEY,
        snapshot === null ? null : JSON.stringify(snapshot),
      );
    },

    async load() {
      const raw = await settings.get(LOCAL_BATTLE_KEY);
      if (raw === null || raw === undefined) {
        return null;
      }

      try {
        return parseLocalBattleSnapshot(raw);
      } catch (error) {
        if (!(error instanceof LocalBattleSnapshotValidationError)) {
          throw error;
        }
        await settings.set(LOCAL_BATTLE_QUARANTINE_KEY, raw);
        await settings.set(LOCAL_BATTLE_KEY, null);
        return null;
      }
    },

    async clear() {
      await settings.set(LOCAL_BATTLE_KEY, null);
    },
  };
}
