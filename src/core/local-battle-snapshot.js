import { allShipsSunk } from "./game.js";
import { gamePresets } from "./presets.js";
import {
  createTrainingSession,
  trainingProgramAwardIds,
  trainingScenarios,
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
const SHOT_RESULTS = new Set(["miss", "hit", "sunk", "mine", "sweeper"]);
const TRAINING_RESULTS = new Set(["miss", "hit", "sunk"]);
const TRAINING_QUALITIES = new Set(["strong", "weak", "neutral"]);
const TRAINING_FEEDBACK_IDS = new Set([
  "sunk",
  "hit",
  "pattern",
  "randomWater",
  "finishLine",
  "offLine",
  "miss",
]);
const BATTLE_TABS = new Set(["target", "own"]);
const AGENT_DIFFICULTIES = new Set(["easy", "normal", "hard"]);

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

function presetForId(value) {
  return typeof value === "string" && Object.hasOwn(gamePresets, value)
    ? gamePresets[value]
    : null;
}

function isValidSavedAt(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isCoordinate(value, size) {
  return (
    isObject(value) &&
    Number.isInteger(value.row) &&
    Number.isInteger(value.col) &&
    value.row >= 0 &&
    value.col >= 0 &&
    value.row < size &&
    value.col < size
  );
}

function coordinateKey(value) {
  return `${value.row}:${value.col}`;
}

function hasUniqueCoordinates(values) {
  return new Set(values.map(coordinateKey)).size === values.length;
}

function sameCoordinate(first, second) {
  return first.row === second.row && first.col === second.col;
}

function cellsTouch(first, second) {
  return (
    Math.abs(first.row - second.row) <= 1 &&
    Math.abs(first.col - second.col) <= 1
  );
}

function isStraightShip(cells) {
  if (cells.length === 1) {
    return true;
  }
  const rows = new Set(cells.map((cell) => cell.row));
  const cols = new Set(cells.map((cell) => cell.col));
  const values = [...cells]
    .map((cell) => (rows.size === 1 ? cell.col : cell.row))
    .sort((first, second) => first - second);
  return (
    (rows.size === 1 || cols.size === 1) &&
    values.every((value, index) => index === 0 || value === values[index - 1] + 1)
  );
}

function isValidShip(ship, size) {
  return (
    isObject(ship) &&
    typeof ship.id === "string" &&
    ship.id.length > 0 &&
    Number.isInteger(ship.length) &&
    ship.length > 0 &&
    Array.isArray(ship.cells) &&
    ship.cells.length === ship.length &&
    ship.cells.every((cell) => isCoordinate(cell, size)) &&
    hasUniqueCoordinates(ship.cells) &&
    isStraightShip(ship.cells) &&
    Array.isArray(ship.hits) &&
    ship.hits.every((hit) => isCoordinate(hit, size)) &&
    hasUniqueCoordinates(ship.hits) &&
    ship.hits.every((hit) => ship.cells.some((cell) => sameCoordinate(cell, hit)))
  );
}

function isValidMarker(marker, size) {
  return (
    isObject(marker) &&
    typeof marker.id === "string" &&
    marker.id.length > 0 &&
    (marker.type === "mine" || marker.type === "sweeper") &&
    isCoordinate(marker.cell, size)
  );
}

function isValidShot(shot, board) {
  if (
    !isObject(shot) ||
    !isCoordinate(shot, board.size) ||
    !SHOT_RESULTS.has(shot.result)
  ) {
    return false;
  }
  if (shot.result === "hit" || shot.result === "sunk") {
    return board.ships.some(
      (ship) =>
        ship.id === shot.shipId &&
        ship.cells.some((cell) => sameCoordinate(cell, shot)),
    );
  }
  if (shot.result === "mine" || shot.result === "sweeper") {
    return board.markers.some(
      (marker) =>
        marker.id === shot.markerId &&
        marker.type === shot.result &&
        sameCoordinate(marker.cell, shot),
    );
  }
  return true;
}

function piecesDoNotTouch(board) {
  for (let index = 0; index < board.ships.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < board.ships.length; otherIndex += 1) {
      if (
        board.ships[index].cells.some((cell) =>
          board.ships[otherIndex].cells.some((otherCell) => cellsTouch(cell, otherCell)),
        )
      ) {
        return false;
      }
    }
  }
  for (let index = 0; index < board.markers.length; index += 1) {
    const marker = board.markers[index];
    if (
      board.ships.some((ship) =>
        ship.cells.some((cell) => cellsTouch(cell, marker.cell)),
      ) ||
      board.markers.some(
        (otherMarker, otherIndex) =>
          otherIndex !== index && cellsTouch(otherMarker.cell, marker.cell),
      )
    ) {
      return false;
    }
  }
  return true;
}

function isValidBoardShape(board, size) {
  return (
    isObject(board) &&
    board.size === size &&
    Array.isArray(board.ships) &&
    Array.isArray(board.markers) &&
    Array.isArray(board.shots) &&
    board.ships.every((ship) => isValidShip(ship, size)) &&
    new Set(board.ships.map((ship) => ship.id)).size === board.ships.length &&
    board.markers.every((marker) => isValidMarker(marker, size)) &&
    new Set(board.markers.map((marker) => marker.id)).size === board.markers.length &&
    board.shots.every((shot) => isValidShot(shot, board)) &&
    hasUniqueCoordinates(board.shots) &&
    piecesDoNotTouch(board)
  );
}

function isValidPresetBoard(
  board,
  preset,
  { complete = false, pristine = false } = {},
) {
  if (!isValidBoardShape(board, preset.size)) {
    return false;
  }
  const fleetById = new Map(preset.fleet.map((ship) => [ship.id, ship]));
  const markersById = new Map((preset.markers ?? []).map((marker) => [marker.id, marker]));
  if (
    !board.ships.every(
      (ship) => fleetById.get(ship.id)?.length === ship.length,
    ) ||
    !board.markers.every(
      (marker) => markersById.get(marker.id)?.type === marker.type,
    )
  ) {
    return false;
  }
  if (
    complete &&
    (board.ships.length !== preset.fleet.length ||
      board.markers.length !== (preset.markers ?? []).length)
  ) {
    return false;
  }
  return (
    !pristine ||
    (board.shots.length === 0 && board.ships.every((ship) => ship.hits.length === 0))
  );
}

function isBoardsContainer(value) {
  return (
    isObject(value) &&
    Object.hasOwn(value, "p1") &&
    Object.hasOwn(value, "p2")
  );
}

function hasCompleteBoards(value, preset) {
  return (
    isBoardsContainer(value) &&
    isValidPresetBoard(value.p1, preset, { complete: true, pristine: true }) &&
    isValidPresetBoard(value.p2, preset, { complete: true, pristine: true })
  );
}

function isValidGameLogEntry(entry, size) {
  return (
    isObject(entry) &&
    PLAYER_IDS.has(entry.playerId) &&
    PLAYER_IDS.has(entry.targetPlayerId) &&
    entry.playerId !== entry.targetPlayerId &&
    isCoordinate(entry.coordinate, size) &&
    SHOT_RESULTS.has(entry.result) &&
    (entry.shipId === null || typeof entry.shipId === "string")
  );
}

function isValidGame(game, preset) {
  return (
    isObject(game) &&
    game.phase === "playing" &&
    PLAYER_IDS.has(game.currentPlayerId) &&
    game.winnerId === null &&
    game.presetId === preset.id &&
    isObject(game.rules) &&
    typeof game.rules.salvo === "boolean" &&
    game.rules.salvo === Boolean(preset.rules.salvo) &&
    Number.isInteger(game.salvoRemaining) &&
    game.salvoRemaining > 0 &&
    isObject(game.players) &&
    Object.hasOwn(game.players, "p1") &&
    Object.hasOwn(game.players, "p2") &&
    game.players.p1?.id === "p1" &&
    game.players.p2?.id === "p2" &&
    isValidPresetBoard(game.players.p1.board, preset, { complete: true }) &&
    isValidPresetBoard(game.players.p2.board, preset, { complete: true }) &&
    Array.isArray(game.log) &&
    game.log.every((entry) => isValidGameLogEntry(entry, preset.size))
  );
}

function isValidSetupSelection(value, board, preset) {
  if (typeof value !== "string") {
    return false;
  }
  const pieces = [...preset.fleet, ...(preset.markers ?? [])];
  const placedIds = new Set([
    ...board.ships.map((ship) => ship.id),
    ...board.markers.map((marker) => marker.id),
  ]);
  if (value === "") {
    return placedIds.size === pieces.length;
  }
  return pieces.some((piece) => piece.id === value) && !placedIds.has(value);
}

function isValidSetupSnapshot(value, preset) {
  if (
    value.game !== null ||
    (value.setupOrientation !== "horizontal" && value.setupOrientation !== "vertical") ||
    !isValidPresetBoard(value.setupBoard, preset, { pristine: true }) ||
    !isValidSetupSelection(value.setupSelectedShipId, value.setupBoard, preset) ||
    !isBoardsContainer(value.boards)
  ) {
    return false;
  }
  if (value.mode === "agent") {
    return value.setupPlayerId === "p1" && value.boards.p1 === null && value.boards.p2 === null;
  }
  if (value.setupPlayerId === "p1") {
    return value.boards.p1 === null && value.boards.p2 === null;
  }
  return (
    value.setupPlayerId === "p2" &&
    isValidPresetBoard(value.boards.p1, preset, { complete: true, pristine: true }) &&
    value.boards.p2 === null
  );
}

function isValidPlayingSnapshot(value, preset) {
  return hasCompleteBoards(value.boards, preset) && isValidGame(value.game, preset);
}

function isValidPassSnapshot(value, preset) {
  if (value.mode !== "hotseat" || !PLAYER_IDS.has(value.passPlayerId)) {
    return false;
  }
  if (value.game === null) {
    return (
      value.passPlayerId === "p2" &&
      value.setupPlayerId === "p2" &&
      (value.setupOrientation === "horizontal" || value.setupOrientation === "vertical") &&
      isValidPresetBoard(value.setupBoard, preset, { complete: true, pristine: true }) &&
      value.setupSelectedShipId === "" &&
      isBoardsContainer(value.boards) &&
      isValidPresetBoard(value.boards.p1, preset, { complete: true, pristine: true }) &&
      value.boards.p2 === null
    );
  }
  return (
    hasCompleteBoards(value.boards, preset) &&
    isValidGame(value.game, preset) &&
    value.passPlayerId === value.game.currentPlayerId
  );
}

function sameCoordinateSet(first, second) {
  return (
    first.length === second.length &&
    first.every((coordinate) =>
      second.some((otherCoordinate) => sameCoordinate(coordinate, otherCoordinate)),
    )
  );
}

function isValidTrainingBoard(board, referenceBoard) {
  if (
    !isValidBoardShape(board, referenceBoard.size) ||
    board.ships.length !== referenceBoard.ships.length ||
    board.markers.length !== referenceBoard.markers.length
  ) {
    return false;
  }
  return referenceBoard.ships.every((referenceShip) => {
    const ship = board.ships.find((candidate) => candidate.id === referenceShip.id);
    return (
      ship?.length === referenceShip.length &&
      sameCoordinateSet(ship.cells, referenceShip.cells)
    );
  });
}

function isValidTrainingLogEntry(entry, size) {
  return (
    isObject(entry) &&
    isCoordinate(entry.coordinate, size) &&
    TRAINING_RESULTS.has(entry.result) &&
    TRAINING_QUALITIES.has(entry.quality) &&
    TRAINING_FEEDBACK_IDS.has(entry.feedbackId)
  );
}

function isValidTrainingSnapshot(value) {
  if (!isObject(value.training) || !isObject(value.training.progress)) {
    return false;
  }
  const scenario = trainingScenarios.find(
    (candidate) => candidate.id === value.training.scenarioId,
  );
  const session = value.training.session;
  if (!scenario || !isObject(session)) {
    return false;
  }
  const reference = createTrainingSession(scenario.id);
  return (
    session.scenarioId === scenario.id &&
    session.phase === "playing" &&
    session.shotLimit === scenario.shotLimit &&
    Number.isInteger(session.score) &&
    session.score >= 0 &&
    Array.isArray(session.log) &&
    session.log.length < session.shotLimit &&
    session.log.every((entry) => isValidTrainingLogEntry(entry, scenario.size)) &&
    isValidTrainingBoard(session.board, reference.board) &&
    !allShipsSunk(session.board)
  );
}

function isValidSnapshot(value) {
  if (
    !isObject(value) ||
    value.version !== LOCAL_BATTLE_SNAPSHOT_VERSION ||
    !isSupportedModeScreen(value) ||
    !isValidSavedAt(value.savedAt) ||
    !BATTLE_TABS.has(value.battleTab) ||
    !AGENT_DIFFICULTIES.has(value.agentDifficulty) ||
    isFinished(value)
  ) {
    return false;
  }
  const preset = presetForId(value.presetId);
  if (!preset) {
    return false;
  }
  if (value.screen === "setup") {
    return isValidSetupSnapshot(value, preset);
  }
  if (value.screen === "playing") {
    return isValidPlayingSnapshot(value, preset);
  }
  if (value.screen === "pass") {
    return isValidPassSnapshot(value, preset);
  }
  return isValidTrainingSnapshot(value);
}

function normalizeCoordinate(value) {
  return { row: value.row, col: value.col };
}

function normalizeShip(ship) {
  return {
    id: ship.id,
    length: ship.length,
    cells: ship.cells.map(normalizeCoordinate),
    hits: ship.hits.map(normalizeCoordinate),
  };
}

function normalizeMarker(marker) {
  return {
    id: marker.id,
    type: marker.type,
    cell: normalizeCoordinate(marker.cell),
  };
}

function normalizeShot(shot) {
  const normalized = {
    ...normalizeCoordinate(shot),
    result: shot.result,
  };
  if (typeof shot.shipId === "string") {
    normalized.shipId = shot.shipId;
  }
  if (typeof shot.markerId === "string") {
    normalized.markerId = shot.markerId;
  }
  return normalized;
}

function normalizeBoard(board) {
  return {
    size: board.size,
    ships: board.ships.map(normalizeShip),
    markers: board.markers.map(normalizeMarker),
    shots: board.shots.map(normalizeShot),
  };
}

function normalizeBoards(boards) {
  return {
    p1: boards.p1 === null ? null : normalizeBoard(boards.p1),
    p2: boards.p2 === null ? null : normalizeBoard(boards.p2),
  };
}

function normalizeGameLogEntry(entry) {
  return {
    playerId: entry.playerId,
    targetPlayerId: entry.targetPlayerId,
    coordinate: normalizeCoordinate(entry.coordinate),
    result: entry.result,
    shipId: entry.shipId,
  };
}

function normalizeGame(game) {
  return {
    phase: game.phase,
    currentPlayerId: game.currentPlayerId,
    winnerId: game.winnerId,
    presetId: game.presetId,
    rules: { salvo: game.rules.salvo },
    salvoRemaining: game.salvoRemaining,
    players: {
      p1: { id: "p1", board: normalizeBoard(game.players.p1.board) },
      p2: { id: "p2", board: normalizeBoard(game.players.p2.board) },
    },
    log: game.log.map(normalizeGameLogEntry),
  };
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function nonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function validDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "";
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    ? value
    : "";
}

function uniqueKnownValues(values, knownValues) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter((value) => knownValues.includes(value)))];
}

function normalizeTrainingProgress(progress) {
  const normalized = {};
  for (const scenario of trainingScenarios) {
    const entry = progress?.[scenario.id];
    if (!isObject(entry)) {
      continue;
    }
    normalized[scenario.id] = {
      completions: nonnegativeInteger(entry.completions),
      bestScore: nonnegativeNumber(entry.bestScore),
      bestAccuracy: Math.min(100, nonnegativeNumber(entry.bestAccuracy)),
      bestRatingId: ["needsWork", "steady", "excellent"].includes(entry.bestRatingId)
        ? entry.bestRatingId
        : "needsWork",
      lastPlayedAt: isValidSavedAt(entry.lastPlayedAt) ? entry.lastPlayedAt : "",
    };
  }

  if (isObject(progress?.daily)) {
    normalized.daily = {
      date: validDateKey(progress.daily.date),
      completions: nonnegativeInteger(progress.daily.completions),
      completedScenarioIds: uniqueKnownValues(
        progress.daily.completedScenarioIds,
        trainingScenarios.map((scenario) => scenario.id),
      ),
      goalCompletedDate: validDateKey(progress.daily.goalCompletedDate),
      streak: nonnegativeInteger(progress.daily.streak),
      bestStreak: nonnegativeInteger(progress.daily.bestStreak),
      awards: uniqueKnownValues(progress.daily.awards, trainingProgramAwardIds),
    };
  }
  return normalized;
}

function normalizeTrainingLogEntry(entry) {
  return {
    coordinate: normalizeCoordinate(entry.coordinate),
    result: entry.result,
    quality: entry.quality,
    feedbackId: entry.feedbackId,
  };
}

function normalizeTrainingSession(session) {
  return {
    scenarioId: session.scenarioId,
    phase: session.phase,
    board: normalizeBoard(session.board),
    log: session.log.map(normalizeTrainingLogEntry),
    score: session.score,
    shotLimit: session.shotLimit,
  };
}

function normalizeTraining(training, includeSession) {
  const scenarioId = trainingScenarios.some(
    (scenario) => scenario.id === training?.scenarioId,
  )
    ? training.scenarioId
    : "checkerboard";
  return {
    scenarioId,
    session: includeSession ? normalizeTrainingSession(training.session) : null,
    progress: normalizeTrainingProgress(training?.progress),
  };
}

function cloneSnapshot(value) {
  const usesSetup =
    value.screen === "setup" || (value.screen === "pass" && value.game === null);
  const usesGame =
    value.mode !== "training" && value.game !== null;
  const usesTraining = value.mode === "training";
  return structuredClone({
    version: value.version,
    savedAt: value.savedAt,
    screen: value.screen,
    mode: value.mode,
    presetId: value.presetId,
    setupPlayerId: usesSetup ? value.setupPlayerId : "p1",
    setupBoard: usesSetup ? normalizeBoard(value.setupBoard) : null,
    setupOrientation: usesSetup ? value.setupOrientation : "horizontal",
    setupSelectedShipId: usesSetup ? value.setupSelectedShipId : "",
    boards: usesTraining ? { p1: null, p2: null } : normalizeBoards(value.boards),
    game: usesGame ? normalizeGame(value.game) : null,
    battleTab: value.battleTab,
    agentDifficulty: value.agentDifficulty,
    passPlayerId: value.screen === "pass" ? value.passPlayerId : null,
    training: normalizeTraining(value.training, usesTraining),
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

  if (!isObject(snapshot)) {
    throw new LocalBattleSnapshotValidationError(
      "Snapshot must be a JSON object",
    );
  }
  if (snapshot.version !== LOCAL_BATTLE_SNAPSHOT_VERSION) {
    throw new UnsupportedLocalBattleSnapshotVersionError(snapshot.version);
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
        if (error instanceof UnsupportedLocalBattleSnapshotVersionError) {
          throw error;
        }
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
