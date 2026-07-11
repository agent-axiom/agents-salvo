import { cloneBoard } from "../src/core/game.js";
import { userSubject } from "./profile.js";

const replayUnavailableMessage = "Replay is unavailable";
const playerIds = new Set(["p1", "p2"]);
const shotResults = new Set(["miss", "hit", "sunk", "mine", "sweeper"]);

export const replayArchiveQueries = Object.freeze({
  firstPage: `SELECT m.id AS match_id, m.replay_id, m.preset_id, m.winner_id, m.played_at AS finished_at,
    m.result, m.opponent, m.total_shots, m.player_shots, m.player_hits,
    m.player_misses, m.player_sunk, m.accuracy, m.turns
  FROM matches m
  LEFT JOIN battle_replays r ON r.id = m.replay_id
  WHERE m.user_key = ? AND m.mode = 'online'
    AND (m.replay_id IS NULL OR (r.id IS NOT NULL AND (r.p1_user_key = ? OR r.p2_user_key = ?)))
  ORDER BY m.played_at DESC, m.id DESC
  LIMIT ?`,
  afterCursor: `SELECT m.id AS match_id, m.replay_id, m.preset_id, m.winner_id, m.played_at AS finished_at,
    m.result, m.opponent, m.total_shots, m.player_shots, m.player_hits,
    m.player_misses, m.player_sunk, m.accuracy, m.turns
  FROM matches m
  LEFT JOIN battle_replays r ON r.id = m.replay_id
  WHERE m.user_key = ? AND m.mode = 'online'
    AND (m.replay_id IS NULL OR (r.id IS NOT NULL AND (r.p1_user_key = ? OR r.p2_user_key = ?)))
    AND (m.played_at, m.id) < (?, ?)
  ORDER BY m.played_at DESC, m.id DESC
  LIMIT ?`,
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function createOnlineReplayRecord(room, replayId) {
  const payload = {
    version: 1,
    presetId: room.game.presetId,
    winnerId: room.game.winnerId,
    finishedAt: room.finishedAt,
    players: {
      p1: publicReplayPlayer(room.players.p1.user),
      p2: publicReplayPlayer(room.players.p2.user),
    },
    boards: {
      p1: cloneBoard(room.game.players.p1.board),
      p2: cloneBoard(room.game.players.p2.board),
    },
    log: room.game.log.map(publicReplayLogEntry),
  };
  parseReplayPayload(JSON.stringify(payload));
  return {
    id: replayId,
    p1UserKey: userSubject(room.players.p1.user),
    p2UserKey: userSubject(room.players.p2.user),
    presetId: payload.presetId,
    winnerId: payload.winnerId,
    finishedAt: payload.finishedAt,
    payload,
  };
}

export function parseReplayPayload(value) {
  try {
    const payload = typeof value === "string" ? JSON.parse(value) : value;
    if (!hasOnlyKeys(payload, ["version", "presetId", "winnerId", "finishedAt", "players", "boards", "log"]) || payload.version !== 1) {
      throw new Error();
    }
    if (!isText(payload.presetId) || !playerIds.has(payload.winnerId) || !isIsoDate(payload.finishedAt)) {
      throw new Error();
    }
    if (!isPlainObject(payload.players) || !validPlayer(payload.players.p1) || !validPlayer(payload.players.p2)) {
      throw new Error();
    }
    if (!isPlainObject(payload.boards) || !validBoard(payload.boards.p1) || !validBoard(payload.boards.p2)) {
      throw new Error();
    }
    if (!Array.isArray(payload.log) || !payload.log.every(validLogEntry)) {
      throw new Error();
    }
    return payload;
  } catch {
    throw new HttpError(404, replayUnavailableMessage);
  }
}

export async function saveOnlineReplay(db, record) {
  assertReplayDb(db);
  await db
    .prepare(
      `INSERT OR IGNORE INTO battle_replays
        (id, p1_user_key, p2_user_key, preset_id, winner_id, finished_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.p1UserKey,
      record.p2UserKey,
      record.presetId,
      record.winnerId,
      record.finishedAt,
      JSON.stringify(record.payload),
    )
    .run();
  return record.id;
}

export function replayParticipantId(record, userKey) {
  if (record.p1UserKey === userKey || record.p1_user_key === userKey) {
    return "p1";
  }
  if (record.p2UserKey === userKey || record.p2_user_key === userKey) {
    return "p2";
  }
  return null;
}

export async function getAuthorizedReplay(db, id, user) {
  assertReplayDb(db);
  const row = await db
    .prepare(
      `SELECT id, p1_user_key, p2_user_key, data_json
      FROM battle_replays
      WHERE id = ?`,
    )
    .bind(id)
    .first();
  if (!row) {
    throw new HttpError(404, replayUnavailableMessage);
  }
  const viewerPlayerId = replayParticipantId(row, userSubject(user));
  if (!viewerPlayerId) {
    throw new HttpError(403, "Replay access is forbidden");
  }
  let payload;
  try {
    payload = parseReplayPayload(row.data_json);
  } catch {
    console.error("Stored replay payload is invalid", { replayId: row.id });
    throw new HttpError(503, "Replay storage is unavailable");
  }
  return { id: row.id, ...payload, viewerPlayerId };
}

export async function listPlayerReplays(db, user, { cursor } = {}) {
  assertReplayDb(db);
  const pageLimit = 20;
  const userKey = userSubject(user);
  const decodedCursor = cursor ? decodeCursor(cursor) : null;
  const cursorFinishedAt = decodedCursor?.finishedAt ?? null;
  const cursorId = decodedCursor?.id ?? null;
  const statement = db.prepare(
    decodedCursor ? replayArchiveQueries.afterCursor : replayArchiveQueries.firstPage,
  );
  const rows = await (decodedCursor
    ? statement.bind(userKey, userKey, userKey, cursorFinishedAt, cursorId, pageLimit + 1)
    : statement.bind(userKey, userKey, userKey, pageLimit + 1)
  ).all();
  const pageRows = (rows.results ?? []).slice(0, pageLimit);
  const items = pageRows.map(publicArchiveItem);
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor:
      (rows.results ?? []).length > pageLimit
        ? encodeCursor({ finishedAt: last.finished_at, id: last.match_id })
        : null,
  };
}

function publicReplayPlayer(user) {
  return {
    name: String(user?.name || ""),
    username: String(user?.username || ""),
  };
}

function publicReplayLogEntry(entry) {
  return {
    playerId: entry.playerId,
    targetPlayerId: entry.targetPlayerId,
    coordinate: { row: entry.coordinate.row, col: entry.coordinate.col },
    result: entry.result,
    ...(entry.shipId ? { shipId: entry.shipId } : {}),
  };
}

function publicArchiveItem(row) {
  return {
    id: row.match_id,
    replayId: row.replay_id || null,
    presetId: row.preset_id,
    winnerId: row.winner_id,
    finishedAt: row.finished_at,
    result: row.result,
    opponent: publicOpponent(row.opponent),
    totalShots: number(row.total_shots),
    playerShots: number(row.player_shots),
    playerHits: number(row.player_hits),
    playerMisses: number(row.player_misses),
    playerSunk: number(row.player_sunk),
    accuracy: number(row.accuracy),
    turns: number(row.turns),
  };
}

function validPlayer(player) {
  return hasOnlyKeys(player, ["name", "username"]) && typeof player.name === "string" && typeof player.username === "string";
}

function validBoard(board) {
  return (
    hasOnlyKeys(board, ["size", "ships", "markers", "shots"]) &&
    Number.isInteger(board.size) &&
    board.size > 0 &&
    Array.isArray(board.ships) &&
    board.ships.every((ship) => validShip(ship, board.size)) &&
    Array.isArray(board.markers) &&
    board.markers.every((marker) => validMarker(marker, board.size)) &&
    Array.isArray(board.shots) &&
    board.shots.every((shot) => validShot(shot, board.size))
  );
}

function validMarker(marker, size) {
  return (
    hasOnlyKeys(marker, ["id", "type", "cell"]) &&
    isText(marker.id) &&
    (marker.type === "mine" || marker.type === "sweeper") &&
    validCoordinate(marker.cell, size)
  );
}

function validShip(ship, size) {
  return (
    hasOnlyKeys(ship, ["id", "length", "cells", "hits"]) &&
    isText(ship.id) &&
    Number.isInteger(ship.length) &&
    ship.length > 0 &&
    Array.isArray(ship.cells) &&
    ship.cells.length === ship.length &&
    ship.cells.every((cell) => validCoordinate(cell, size)) &&
    Array.isArray(ship.hits) &&
    ship.hits.every((cell) => validCoordinate(cell, size))
  );
}

function validShot(shot, size) {
  return (
    hasOnlyKeys(shot, ["row", "col", "result", "shipId", "markerId"]) &&
    validCoordinateValues(shot, size) &&
    shotResults.has(shot.result) &&
    (shot.shipId === undefined || isText(shot.shipId)) &&
    (shot.markerId === undefined || isText(shot.markerId))
  );
}

function validLogEntry(entry) {
  return (
    hasOnlyKeys(entry, ["playerId", "targetPlayerId", "coordinate", "result", "shipId"]) &&
    playerIds.has(entry.playerId) &&
    playerIds.has(entry.targetPlayerId) &&
    entry.playerId !== entry.targetPlayerId &&
    validCoordinate(entry.coordinate) &&
    shotResults.has(entry.result) &&
    (entry.shipId === undefined || isText(entry.shipId))
  );
}

function validCoordinate(coordinate, size = Number.POSITIVE_INFINITY) {
  return hasOnlyKeys(coordinate, ["row", "col"]) && validCoordinateValues(coordinate, size);
}

function validCoordinateValues(coordinate, size) {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.col) &&
    coordinate.row >= 0 &&
    coordinate.col >= 0 &&
    coordinate.row < size &&
    coordinate.col < size
  );
}

function decodeCursor(cursor) {
  try {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const decoded = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    if (!isPlainObject(decoded) || !isIsoDate(decoded.finishedAt) || !isText(decoded.id)) {
      throw new Error();
    }
    return { finishedAt: decoded.finishedAt, id: decoded.id };
  } catch {
    throw new HttpError(400, "Replay cursor is invalid");
  }
}

function encodeCursor(cursor) {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isIsoDate(value) {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function isText(value) {
  return typeof value === "string" && value.length > 0;
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function publicOpponent(value) {
  const opponent = String(value || "online");
  return /^[a-z][a-z0-9_-]*:\d+$/i.test(opponent) ? "online" : opponent;
}

function assertReplayDb(db) {
  if (!db) {
    throw new Error("Replay storage is not configured");
  }
}
