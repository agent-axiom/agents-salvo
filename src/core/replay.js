export const replaySpeeds = Object.freeze([
  { label: "1x", delay: 1000 },
  { label: "1.5x", delay: 667 },
  { label: "2x", delay: 500 },
]);

const replayPlayerIds = new Set(["p1", "p2"]);
const archivedShotResults = new Set(["miss", "hit", "sunk", "mine", "sweeper"]);
const replayIdPattern = /^[A-Za-z0-9-]{1,128}$/;

export function archivedReplayFrame(replay, selectedTurn) {
  try {
    if (!validArchivedReplay(replay)) {
      return emptyArchivedReplayFrame();
    }

    const totalTurns = replay.log.length;
    const turn = totalTurns > 0 ? normalizeReplayTurn(selectedTurn, totalTurns) : 0;
    const boards = {
      p1: cloneArchivedBoard(replay.boards.p1),
      p2: cloneArchivedBoard(replay.boards.p2),
    };

    for (const entry of replay.log.slice(0, turn)) {
      applyArchivedShot(boards[entry.targetPlayerId], entry);
    }

    const activeEntry = turn > 0 ? cloneArchivedEntry(replay.log[turn - 1]) : null;
    return {
      turn,
      totalTurns,
      boards,
      activeEntry,
      activeTargetPlayerId: activeEntry?.targetPlayerId ?? null,
      activeCoordinate: activeEntry ? { ...activeEntry.coordinate } : null,
    };
  } catch {
    return emptyArchivedReplayFrame();
  }
}

export function replayIdFromSearch(search) {
  try {
    const replayId = new URLSearchParams(search).get("replay")?.trim() ?? "";
    return replayIdPattern.test(replayId) ? replayId : "";
  } catch {
    return "";
  }
}

export function replayUrlForId(currentUrl, replayId) {
  const id = typeof replayId === "string" ? replayId.trim() : "";
  if (!replayIdPattern.test(id)) {
    return "";
  }
  const url = new URL(currentUrl);
  url.search = "";
  url.searchParams.set("replay", id);
  url.hash = "";
  return url.toString();
}

export function replayRequestIsCurrent(request, current) {
  return Boolean(
    request?.token &&
      request.token === current?.token &&
      request.requestId === current?.requestId &&
      (request.replayId ?? "") === (current?.replayId ?? ""),
  );
}

export function authRequestIsCurrent(request, current) {
  return Boolean(
    Number.isInteger(request?.epoch) &&
      request.epoch === current?.epoch &&
      (request.token ?? "") === (current?.token ?? "") &&
      (request.identity ?? "") === (current?.identity ?? ""),
  );
}

export function archiveReplayId(item) {
  const replayId = typeof item?.replayId === "string" ? item.replayId.trim() : "";
  return replayIdPattern.test(replayId) ? replayId : "";
}

export function archiveRetryOptions(retry) {
  const cursor = typeof retry?.cursor === "string" ? retry.cursor.trim() : "";
  return retry?.append && cursor ? { append: true, cursor } : { append: false, cursor: "" };
}

export function archivedReplayBoardMinWidth(size) {
  if (!Number.isInteger(size) || size <= 10) {
    return 0;
  }
  return size * 36 + 52;
}

export function normalizeReplayTurn(selectedTurn, totalTurns) {
  if (!Number.isInteger(totalTurns) || totalTurns <= 0) {
    return 0;
  }
  const turn = Number.isInteger(selectedTurn) ? selectedTurn : totalTurns;
  return Math.min(Math.max(turn, 1), totalTurns);
}

export function replayMomentTurn(moment, totalTurns) {
  if (!moment || typeof moment !== "object" || !Number.isInteger(totalTurns) || totalTurns <= 0) {
    return 0;
  }
  const selectedTurn = [moment.turn, moment.endTurn, moment.startTurn].find(Number.isInteger);
  return Number.isInteger(selectedTurn) ? normalizeReplayTurn(selectedTurn, totalTurns) : 0;
}

export function startReplayTurn(selectedTurn, totalTurns) {
  const currentTurn = normalizeReplayTurn(selectedTurn, totalTurns);
  return currentTurn >= totalTurns ? 1 : currentTurn;
}

export function advanceReplayTurn(selectedTurn, totalTurns) {
  const currentTurn = normalizeReplayTurn(selectedTurn, totalTurns);
  const turn = Math.min(currentTurn + 1, totalTurns);
  return { turn, complete: turn >= totalTurns };
}

export function nextReplaySpeedIndex(index) {
  const currentIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return (currentIndex + 1) % replaySpeeds.length;
}

export function createReplayClock({ setInterval: schedule, clearInterval: cancel }) {
  let intervalHandle = null;

  return {
    get running() {
      return intervalHandle !== null;
    },
    start(callback, delay) {
      if (intervalHandle !== null) {
        cancel(intervalHandle);
      }
      intervalHandle = schedule(callback, delay);
    },
    stop() {
      if (intervalHandle === null) {
        return;
      }
      cancel(intervalHandle);
      intervalHandle = null;
    },
  };
}

function emptyArchivedReplayFrame() {
  return {
    turn: 0,
    totalTurns: 0,
    boards: {
      p1: emptyArchivedBoard(),
      p2: emptyArchivedBoard(),
    },
    activeEntry: null,
    activeTargetPlayerId: null,
    activeCoordinate: null,
  };
}

function emptyArchivedBoard() {
  return { size: 0, ships: [], markers: [], shots: [] };
}

function validArchivedReplay(replay) {
  if (!replay || typeof replay !== "object" || !replay.boards || !Array.isArray(replay.log)) {
    return false;
  }
  if (!validArchivedBoard(replay.boards.p1) || !validArchivedBoard(replay.boards.p2)) {
    return false;
  }
  return replay.log.every((entry) => validArchivedEntry(entry, replay.boards));
}

function validArchivedBoard(board) {
  return (
    board &&
    Number.isInteger(board.size) &&
    board.size > 0 &&
    Array.isArray(board.ships) &&
    board.ships.every((ship) => validArchivedShip(ship, board.size)) &&
    Array.isArray(board.markers) &&
    board.markers.every((marker) => validArchivedMarker(marker, board.size)) &&
    Array.isArray(board.shots)
  );
}

function validArchivedShip(ship, size) {
  return (
    ship &&
    typeof ship.id === "string" &&
    Number.isInteger(ship.length) &&
    ship.length > 0 &&
    Array.isArray(ship.cells) &&
    ship.cells.length === ship.length &&
    ship.cells.every((coordinate) => validArchivedCoordinate(coordinate, size)) &&
    Array.isArray(ship.hits)
  );
}

function validArchivedMarker(marker, size) {
  return (
    marker &&
    typeof marker.id === "string" &&
    (marker.type === "mine" || marker.type === "sweeper") &&
    validArchivedCoordinate(marker.cell, size)
  );
}

function validArchivedEntry(entry, boards) {
  return (
    entry &&
    replayPlayerIds.has(entry.playerId) &&
    replayPlayerIds.has(entry.targetPlayerId) &&
    entry.playerId !== entry.targetPlayerId &&
    archivedShotResults.has(entry.result) &&
    validArchivedCoordinate(entry.coordinate, boards[entry.targetPlayerId].size) &&
    (entry.shipId == null || typeof entry.shipId === "string")
  );
}

function validArchivedCoordinate(coordinate, size) {
  return (
    coordinate &&
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.col) &&
    coordinate.row >= 0 &&
    coordinate.col >= 0 &&
    coordinate.row < size &&
    coordinate.col < size
  );
}

function cloneArchivedBoard(board) {
  return {
    size: board.size,
    ships: board.ships.map((ship) => ({
      id: ship.id,
      length: ship.length,
      cells: ship.cells.map((cell) => ({ ...cell })),
      hits: [],
    })),
    markers: board.markers.map((marker) => ({
      id: marker.id,
      type: marker.type,
      cell: { ...marker.cell },
    })),
    shots: [],
  };
}

function cloneArchivedEntry(entry) {
  return {
    playerId: entry.playerId,
    targetPlayerId: entry.targetPlayerId,
    coordinate: { ...entry.coordinate },
    result: entry.result,
    ...(entry.shipId ? { shipId: entry.shipId } : {}),
  };
}

function applyArchivedShot(board, entry) {
  const shot = {
    ...entry.coordinate,
    result: entry.result,
    ...(entry.shipId ? { shipId: entry.shipId } : {}),
  };
  const targetShip = board.ships.find(
    (ship) =>
      (entry.shipId && ship.id === entry.shipId) ||
      ship.cells.some((cell) => sameArchivedCoordinate(cell, entry.coordinate)),
  );

  if (entry.result === "sunk" && targetShip) {
    targetShip.hits = targetShip.cells.map((cell) => ({ ...cell }));
    for (const cell of targetShip.cells) {
      replaceArchivedShot(board, { ...cell, result: "sunk", shipId: targetShip.id });
    }
    return;
  }

  if (entry.result === "hit" && targetShip) {
    if (!targetShip.hits.some((hit) => sameArchivedCoordinate(hit, entry.coordinate))) {
      targetShip.hits.push({ ...entry.coordinate });
    }
  }
  replaceArchivedShot(board, shot);
}

function replaceArchivedShot(board, shot) {
  const existingIndex = board.shots.findIndex((entry) => sameArchivedCoordinate(entry, shot));
  if (existingIndex >= 0) {
    board.shots[existingIndex] = shot;
    return;
  }
  board.shots.push(shot);
}

function sameArchivedCoordinate(first, second) {
  return first.row === second.row && first.col === second.col;
}
