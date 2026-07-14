import {
  createBoard, createGameFromBoards, fireAt, hasCompleteSetup, placeMarker, placeShip,
} from "./game.js";
import { gamePresets } from "./presets.js";
import {
  applyTrainingShot, createTrainingSession, trainingProgramAwardIds, trainingScenarios,
} from "./training.js";

export const LOCAL_BATTLE_SNAPSHOT_VERSION = 1;

export class UnsupportedLocalBattleSnapshotVersionError extends Error {
  constructor(foundVersion) {
    super(`Unsupported local battle snapshot version: ${String(foundVersion)}`);
    this.name = "UnsupportedLocalBattleSnapshotVersionError";
    this.foundVersion = foundVersion;
  }
}

const LOCAL_BATTLE_KEY = "localBattle";
const LOCAL_BATTLE_QUARANTINE_KEY = "localBattleQuarantine";
const LOCAL_SCREENS_BY_MODE = new Map([
  ["agent", new Set(["setup", "playing"])],
  ["hotseat", new Set(["setup", "playing", "pass"])],
  ["training", new Set(["training"])],
]);
const PLAYER_IDS = new Set(["p1", "p2"]);
const BATTLE_TABS = new Set(["target", "own", "log"]);
const AGENT_DIFFICULTIES = new Set(["easy", "normal", "hard"]);
const SETUP_ORIENTATIONS = new Set(["horizontal", "vertical"]);
const TRAINING_RATING_IDS = new Set(["needsWork", "steady", "excellent"]);
const TRAINING_SCENARIO_IDS = new Set(trainingScenarios.map(({ id }) => id));
const TRAINING_AWARD_IDS = new Set(trainingProgramAwardIds);
const DEFAULT_TRAINING_SCENARIO_ID = trainingScenarios[0].id;
const LOCAL_BATTLE_STATE_REQUIRED_FIELDS = [
  "screen",
  "mode",
  "presetId",
  "setupPlayerId",
  "setupBoard",
  "setupOrientation",
  "setupSelectedShipId",
  "boards",
  "game",
  "agentDifficulty",
  "passPlayerId",
  "training",
];
const LOCAL_BATTLE_V1_REQUIRED_FIELDS = [
  "version",
  "savedAt",
  ...LOCAL_BATTLE_STATE_REQUIRED_FIELDS,
];

class LocalBattleSnapshotValidationError extends TypeError {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwnFields(value, fields) {
  return isObject(value) && fields.every((field) => Object.hasOwn(value, field));
}

function ownField(value, field) {
  return isObject(value) && Object.hasOwn(value, field) ? value[field] : undefined;
}

function defineOwnField(target, field, value) {
  Object.defineProperty(target, field, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isSupportedModeScreen(value) {
  return hasOwnFields(value, ["mode", "screen"]) &&
    LOCAL_SCREENS_BY_MODE.get(value.mode)?.has(value.screen) === true;
}

function isFinished(value) {
  if (!hasOwnFields(value, ["mode"])) return false;
  if (value.mode === "training") {
    return hasOwnFields(value, ["training"]) &&
      hasOwnFields(value.training, ["session"]) &&
      hasOwnFields(value.training.session, ["phase"]) &&
      value.training.session.phase === "finished";
  }
  return (value.mode === "agent" || value.mode === "hotseat") &&
    hasOwnFields(value, ["game"]) && hasOwnFields(value.game, ["phase"]) &&
    value.game.phase === "finished";
}

function presetForSnapshot(value) {
  if (!Object.hasOwn(value, "presetId")) return null;
  return typeof value.presetId === "string" && Object.hasOwn(gamePresets, value.presetId)
    ? gamePresets[value.presetId]
    : null;
}

function isValidSavedAt(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function coordinateDto(value) {
  if (!hasOwnFields(value, ["row", "col"]) ||
      !Number.isInteger(value.row) || !Number.isInteger(value.col)) {
    return null;
  }
  return { row: value.row, col: value.col };
}

function sameCoordinate(first, second) {
  return first.row === second.row && first.col === second.col;
}

function sameCoordinateSet(first, second) {
  return first.length === second.length &&
    first.every((coordinate) => second.some((other) => sameCoordinate(coordinate, other)));
}

function placementFromCells(rawCells, length) {
  if (!Array.isArray(rawCells) || rawCells.length !== length) return null;
  const cells = rawCells.map(coordinateDto);
  if (cells.some((cell) => cell === null)) return null;
  if (length === 1) return { cells, start: cells[0], orientation: "horizontal" };

  const horizontal = cells.every((cell) => cell.row === cells[0].row);
  const vertical = cells.every((cell) => cell.col === cells[0].col);
  if (!horizontal && !vertical) return null;
  const axis = horizontal ? "col" : "row";
  const ordered = [...cells].sort((first, second) => first[axis] - second[axis]);
  if (ordered.some((cell, index) => index > 0 && cell[axis] !== ordered[index - 1][axis] + 1)) {
    return null;
  }
  return { cells, start: ordered[0], orientation: horizontal ? "horizontal" : "vertical" };
}

function rebuildPristineBoard(rawBoard, preset, { complete = false } = {}) {
  if (!hasOwnFields(rawBoard, ["size", "ships", "markers", "shots"]) ||
      rawBoard.size !== preset.size ||
      !Array.isArray(rawBoard.ships) || !Array.isArray(rawBoard.markers) ||
      !Array.isArray(rawBoard.shots) || rawBoard.shots.length !== 0) {
    return null;
  }

  const knownShips = new Map(preset.fleet.map((ship) => [ship.id, ship]));
  const shipsById = new Map();
  for (const ship of rawBoard.ships) {
    if (!hasOwnFields(ship, ["id", "length", "cells", "hits"])) return null;
    const known = knownShips.get(ship.id);
    if (!known || shipsById.has(ship.id) || ship.length !== known.length ||
        !Array.isArray(ship.hits) || ship.hits.length !== 0) {
      return null;
    }
    shipsById.set(ship.id, ship);
  }

  const knownMarkers = new Map((preset.markers ?? []).map((marker) => [marker.id, marker]));
  const markersById = new Map();
  for (const marker of rawBoard.markers) {
    if (!hasOwnFields(marker, ["id", "type", "cell"])) return null;
    const known = knownMarkers.get(marker.id);
    if (!known || markersById.has(marker.id) || marker.type !== known.type) return null;
    markersById.set(marker.id, marker);
  }

  try {
    let board = createBoard(preset.size);
    for (const ship of preset.fleet) {
      const dto = shipsById.get(ship.id);
      if (!dto) continue;
      const placement = placementFromCells(dto.cells, ship.length);
      if (!placement) return null;
      board = placeShip(board, ship, placement.start, placement.orientation);
      if (!sameCoordinateSet(board.ships.at(-1).cells, placement.cells)) return null;
    }
    for (const marker of preset.markers ?? []) {
      const dto = markersById.get(marker.id);
      if (!dto) continue;
      const coordinate = coordinateDto(dto.cell);
      if (!coordinate) return null;
      board = placeMarker(board, marker, coordinate);
    }
    return !complete || hasCompleteSetup(board, preset) ? board : null;
  } catch {
    return null;
  }
}

function hasValidSetupSelection(selectedId, board, preset) {
  if (typeof selectedId !== "string") return false;
  const pieces = [...preset.fleet, ...(preset.markers ?? [])];
  const placedIds = new Set([
    ...board.ships.map(({ id }) => id), ...board.markers.map(({ id }) => id),
  ]);
  if (selectedId === "") return hasCompleteSetup(board, preset);
  return pieces.some(({ id }) => id === selectedId) && !placedIds.has(selectedId);
}

function rebuildCompleteBoards(rawBoards, preset) {
  if (!hasOwnFields(rawBoards, ["p1", "p2"])) return null;
  const p1 = rebuildPristineBoard(rawBoards.p1, preset, { complete: true });
  const p2 = rebuildPristineBoard(rawBoards.p2, preset, { complete: true });
  return p1 && p2 ? { p1, p2 } : null;
}

function replayGame(rawGame, boards, preset) {
  if (!hasOwnFields(rawGame, ["phase", "log"]) || rawGame.phase !== "playing" ||
      !Array.isArray(rawGame.log)) {
    return null;
  }
  try {
    let game = createGameFromBoards(boards.p1, boards.p2, "p1", {
      presetId: preset.id, rules: preset.rules,
    });
    for (const entry of rawGame.log) {
      if (!hasOwnFields(
        entry,
        ["playerId", "targetPlayerId", "coordinate", "result", "shipId"],
      ) ||
          !PLAYER_IDS.has(entry.playerId) || !PLAYER_IDS.has(entry.targetPlayerId)) {
        return null;
      }
      const coordinate = coordinateDto(entry.coordinate);
      if (!coordinate) return null;
      game = fireAt(game, entry.playerId, coordinate).game;
      const canonical = game.log.at(-1);
      if (canonical.targetPlayerId !== entry.targetPlayerId || canonical.result !== entry.result ||
          canonical.shipId !== entry.shipId || !sameCoordinate(canonical.coordinate, coordinate)) {
        return null;
      }
    }
    return game.phase === "playing" ? game : null;
  } catch {
    return null;
  }
}

function replayTraining(rawTraining) {
  if (!hasOwnFields(rawTraining, ["scenarioId", "session", "progress"]) ||
      !TRAINING_SCENARIO_IDS.has(rawTraining.scenarioId) ||
      !hasOwnFields(rawTraining.session, ["scenarioId", "phase", "log"]) ||
      rawTraining.session.scenarioId !== rawTraining.scenarioId ||
      rawTraining.session.phase !== "playing" || !Array.isArray(rawTraining.session.log) ||
      !isObject(rawTraining.progress)) {
    return null;
  }
  try {
    let session = createTrainingSession(rawTraining.scenarioId);
    for (const entry of rawTraining.session.log) {
      const coordinate = hasOwnFields(entry, ["coordinate"])
        ? coordinateDto(entry.coordinate)
        : null;
      if (!coordinate) return null;
      session = applyTrainingShot(session, coordinate);
      const canonical = session.log.at(-1);
      for (const key of ["result", "quality", "feedbackId"]) {
        if (Object.hasOwn(entry, key) && entry[key] !== canonical[key]) return null;
      }
    }
    return session.phase === "playing"
      ? {
          scenarioId: rawTraining.scenarioId,
          session,
          progress: normalizeTrainingProgress(rawTraining.progress),
        }
      : null;
  } catch {
    return null;
  }
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : "";
}

function uniqueKnownValues(values, knownValues) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => knownValues.has(value)))]
    : [];
}

function normalizeTrainingProgress(progress) {
  const normalized = {};
  for (const scenario of trainingScenarios) {
    const entry = ownField(progress, scenario.id);
    if (!isObject(entry)) continue;
    const bestRatingId = ownField(entry, "bestRatingId");
    const lastPlayedAt = ownField(entry, "lastPlayedAt");
    defineOwnField(normalized, scenario.id, {
      completions: nonnegativeInteger(ownField(entry, "completions")),
      bestScore: nonnegativeNumber(ownField(entry, "bestScore")),
      bestAccuracy: Math.min(100, nonnegativeNumber(ownField(entry, "bestAccuracy"))),
      bestRatingId: TRAINING_RATING_IDS.has(bestRatingId) ? bestRatingId : "needsWork",
      lastPlayedAt: isValidSavedAt(lastPlayedAt) ? lastPlayedAt : "",
    });
  }
  const daily = ownField(progress, "daily");
  if (isObject(daily)) {
    defineOwnField(normalized, "daily", {
      date: validDateKey(ownField(daily, "date")),
      completions: nonnegativeInteger(ownField(daily, "completions")),
      completedScenarioIds: uniqueKnownValues(
        ownField(daily, "completedScenarioIds"),
        TRAINING_SCENARIO_IDS,
      ),
      goalCompletedDate: validDateKey(ownField(daily, "goalCompletedDate")),
      streak: nonnegativeInteger(ownField(daily, "streak")),
      bestStreak: nonnegativeInteger(ownField(daily, "bestStreak")),
      awards: uniqueKnownValues(ownField(daily, "awards"), TRAINING_AWARD_IDS),
    });
  }
  return normalized;
}

function normalizeInactiveTraining(training) {
  const scenarioId = hasOwnFields(training, ["scenarioId"])
    ? training.scenarioId
    : undefined;
  const progress = hasOwnFields(training, ["progress"])
    ? training.progress
    : undefined;
  return {
    scenarioId: TRAINING_SCENARIO_IDS.has(scenarioId)
      ? scenarioId
      : DEFAULT_TRAINING_SCENARIO_ID,
    session: null,
    progress: normalizeTrainingProgress(progress),
  };
}

function normalizeSetupSnapshot(value, preset) {
  if (!hasOwnFields(value, [
    "mode",
    "game",
    "setupPlayerId",
    "setupBoard",
    "setupOrientation",
    "setupSelectedShipId",
    "boards",
  ]) || value.game !== null || !SETUP_ORIENTATIONS.has(value.setupOrientation) ||
      !hasOwnFields(value.boards, ["p1", "p2"])) {
    return null;
  }
  const setupBoard = rebuildPristineBoard(value.setupBoard, preset);
  if (!setupBoard || !hasValidSetupSelection(value.setupSelectedShipId, setupBoard, preset)) return null;

  const emptyBoards = value.boards.p1 === null && value.boards.p2 === null;
  if (value.mode === "agent") {
    return value.setupPlayerId === "p1" && emptyBoards
      ? { setupBoard, boards: { p1: null, p2: null } }
      : null;
  }
  if (value.setupPlayerId === "p1") {
    return emptyBoards ? { setupBoard, boards: { p1: null, p2: null } } : null;
  }
  if (value.setupPlayerId !== "p2" || value.boards.p2 !== null) return null;
  const p1 = rebuildPristineBoard(value.boards.p1, preset, { complete: true });
  return p1 ? { setupBoard, boards: { p1, p2: null } } : null;
}

function normalizePlayingSnapshot(value, preset) {
  if (!hasOwnFields(value, ["mode", "boards", "game"])) return null;
  const boards = rebuildCompleteBoards(value.boards, preset);
  if (!boards) return null;
  const game = replayGame(value.game, boards, preset);
  if (!game || (value.mode === "agent" && game.currentPlayerId !== "p1")) return null;
  return { boards, game };
}

function normalizePassSnapshot(value, preset) {
  if (!hasOwnFields(value, ["mode", "boards", "game", "passPlayerId"]) ||
      value.mode !== "hotseat" || !PLAYER_IDS.has(value.passPlayerId)) {
    return null;
  }
  if (value.game !== null) {
    const playing = normalizePlayingSnapshot(value, preset);
    return playing && value.passPlayerId === playing.game.currentPlayerId
      ? { ...playing, passPlayerId: value.passPlayerId }
      : null;
  }
  if (!hasOwnFields(value, [
    "setupPlayerId",
    "setupBoard",
    "setupOrientation",
    "setupSelectedShipId",
  ]) || value.passPlayerId !== "p2" || value.setupPlayerId !== "p2" ||
      !SETUP_ORIENTATIONS.has(value.setupOrientation) || value.setupSelectedShipId !== "" ||
      !hasOwnFields(value.boards, ["p1", "p2"]) || value.boards.p2 !== null) {
    return null;
  }
  const setupBoard = rebuildPristineBoard(value.setupBoard, preset, { complete: true });
  const p1 = rebuildPristineBoard(value.boards.p1, preset, { complete: true });
  return setupBoard && p1
    ? {
        setupPlayerId: value.setupPlayerId,
        setupBoard,
        setupOrientation: value.setupOrientation,
        setupSelectedShipId: value.setupSelectedShipId,
        boards: { p1, p2: null },
        game: null,
        passPlayerId: value.passPlayerId,
      }
    : null;
}

function normalizeActivePayload(value, preset) {
  if (!hasOwnFields(value, ["screen"])) return null;
  if (value.screen === "setup") {
    const setup = normalizeSetupSnapshot(value, preset);
    return setup && {
      setupPlayerId: value.setupPlayerId,
      setupBoard: setup.setupBoard,
      setupOrientation: value.setupOrientation,
      setupSelectedShipId: value.setupSelectedShipId,
      boards: setup.boards,
    };
  }
  if (value.screen === "playing") return normalizePlayingSnapshot(value, preset);
  if (value.screen === "pass") return normalizePassSnapshot(value, preset);
  if (!hasOwnFields(value, ["training"])) return null;
  const training = replayTraining(value.training);
  return training ? { training } : null;
}

function normalizeV1Snapshot(value) {
  if (!hasOwnFields(value, LOCAL_BATTLE_V1_REQUIRED_FIELDS) ||
      value.version !== LOCAL_BATTLE_SNAPSHOT_VERSION || !isSupportedModeScreen(value) ||
      !isValidSavedAt(value.savedAt) || !AGENT_DIFFICULTIES.has(value.agentDifficulty)) {
    return null;
  }
  const preset = presetForSnapshot(value);
  if (!preset) return null;
  const active = normalizeActivePayload(value, preset);
  if (!active || isFinished(value)) return null;
  const payload = {
    setupPlayerId: "p1",
    setupBoard: null,
    setupOrientation: "horizontal",
    setupSelectedShipId: "",
    boards: { p1: null, p2: null },
    game: null,
    passPlayerId: null,
    training: normalizeInactiveTraining(value.training),
    ...active,
  };

  return structuredClone({
    version: LOCAL_BATTLE_SNAPSHOT_VERSION,
    savedAt: value.savedAt,
    screen: value.screen,
    mode: value.mode,
    presetId: preset.id,
    setupPlayerId: payload.setupPlayerId,
    setupBoard: payload.setupBoard,
    setupOrientation: payload.setupOrientation,
    setupSelectedShipId: payload.setupSelectedShipId,
    boards: payload.boards,
    game: payload.game,
    battleTab: Object.hasOwn(value, "battleTab") && BATTLE_TABS.has(value.battleTab)
      ? value.battleTab
      : "target",
    agentDifficulty: value.agentDifficulty,
    passPlayerId: payload.passPlayerId,
    training: payload.training,
  });
}

export function createLocalBattleSnapshot(state, now = () => new Date().toISOString()) {
  if (!hasOwnFields(state, LOCAL_BATTLE_STATE_REQUIRED_FIELDS) ||
      !isSupportedModeScreen(state)) {
    return null;
  }
  return normalizeV1Snapshot({
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
    battleTab: Object.hasOwn(state, "battleTab") ? state.battleTab : undefined,
    agentDifficulty: state.agentDifficulty,
    passPlayerId: state.passPlayerId,
    training: state.training,
  });
}

export function parseLocalBattleSnapshot(raw) {
  if (typeof raw !== "string") throw new LocalBattleSnapshotValidationError("Snapshot must be JSON");
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch {
    throw new LocalBattleSnapshotValidationError("Snapshot must be valid JSON");
  }
  if (!isObject(snapshot)) {
    throw new LocalBattleSnapshotValidationError("Snapshot must be a JSON object");
  }
  if (!Object.hasOwn(snapshot, "version") || !Number.isInteger(snapshot.version) || snapshot.version <= 0) {
    throw new LocalBattleSnapshotValidationError("Snapshot version must be a positive integer");
  }
  if (snapshot.version !== LOCAL_BATTLE_SNAPSHOT_VERSION) {
    throw new UnsupportedLocalBattleSnapshotVersionError(snapshot.version);
  }
  const normalized = normalizeV1Snapshot(snapshot);
  if (!normalized) throw new LocalBattleSnapshotValidationError("Snapshot is unsupported");
  return normalized;
}

export function createLocalBattleSnapshotStore(settings, { now } = {}) {
  let preservesUnsupportedSnapshot = false;

  return {
    async save(state) {
      const snapshot = createLocalBattleSnapshot(state, now);
      if (snapshot === null && preservesUnsupportedSnapshot) return;
      await settings.set(LOCAL_BATTLE_KEY, snapshot === null ? null : JSON.stringify(snapshot));
      preservesUnsupportedSnapshot = false;
    },
    async load() {
      const raw = await settings.get(LOCAL_BATTLE_KEY);
      if (raw === null || raw === undefined) {
        preservesUnsupportedSnapshot = false;
        return null;
      }
      try {
        const snapshot = parseLocalBattleSnapshot(raw);
        preservesUnsupportedSnapshot = false;
        return snapshot;
      } catch (error) {
        if (error instanceof UnsupportedLocalBattleSnapshotVersionError) {
          preservesUnsupportedSnapshot = true;
          throw error;
        }
        if (!(error instanceof LocalBattleSnapshotValidationError)) throw error;
        await settings.set(LOCAL_BATTLE_QUARANTINE_KEY, raw);
        await settings.set(LOCAL_BATTLE_KEY, null);
        preservesUnsupportedSnapshot = false;
        return null;
      }
    },
    async clear() {
      await settings.set(LOCAL_BATTLE_KEY, null);
      preservesUnsupportedSnapshot = false;
    },
  };
}
