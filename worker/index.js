import {
  cloneBoard,
  createBoard,
  createGameFromBoards,
  fireAt,
  hasCompleteSetup,
  publicBoardView,
} from "../src/core/game.js";
import { getGamePreset } from "../src/core/presets.js";
import { summarizeBattleLog } from "../src/core/stats.js";
import {
  createSessionToken,
  parseBearerToken,
  publicUser,
  verifySessionToken,
  verifyTelegramLoginPayload,
} from "./auth.js";
import { getLeaderboard, getPlayerProfile, recordCompletedMatch, recordOnlineReplayBatch } from "./profile.js";
import {
  HttpError,
  createOnlineReplayRecord,
  getAuthorizedReplay,
  listPlayerReplays,
} from "./replay.js";

const archiveOutboxPrefix = "replayArchiveOutbox:";
const archiveDeadLetterPrefix = "replayArchiveDeadLetter:";
const archiveSchedulePrefix = "replayArchiveSchedule:";
const archiveMaxAttempts = 12;
const archiveAlarmBatchSize = 10;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    let route;
    try {
      route = routeRequest(url);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    if (!route) {
      return json({ error: "Not found" }, 404);
    }

    if (route.kind === "authTelegram" && request.method === "POST") {
      return authenticateTelegram(request, env);
    }
    if (route.kind === "authMe" && request.method === "GET") {
      return currentUser(request, env);
    }
    if (route.kind === "authLogout" && request.method === "POST") {
      return json({ ok: true });
    }
    if (route.kind === "profileMe" && request.method === "GET") {
      return playerProfile(request, env);
    }
    if (route.kind === "profileMatches" && request.method === "POST") {
      return saveProfileMatch(request, env);
    }
    if (route.kind === "profileReplays" && request.method === "GET") {
      return playerReplays(request, env, url);
    }
    if (route.kind === "replay" && request.method === "GET") {
      return archivedReplay(request, env, route.replayId);
    }
    if (route.kind === "leaderboard" && request.method === "GET") {
      return leaderboard(env);
    }

    if (route.kind === "create" && request.method === "POST") {
      return createRoom(request, env);
    }

    const id = env.BATTLE_ROOM.idFromName(route.roomCode);
    const room = env.BATTLE_ROOM.get(id);
    return room.fetch(request);
  },
};

export class BattleRoom {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    try {
      const route = routeRequest(url);
      if (route?.kind === "create" && request.method === "POST") {
        return await this.create(request, route.roomCode);
      }
      if (route?.kind === "join" && request.method === "POST") {
        return await this.join(request, route.roomCode);
      }
      if (route?.kind === "socket" && request.method === "GET") {
        return await this.connect(request, url);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message }, authErrorStatus(error));
    }
  }

  async create(request, roomCode) {
    const existing = await this.getRoom();
    if (existing) {
      return json({ error: "Room already exists" }, 409);
    }
    const user = publicUser(await requireUser(request, this.env));

    const room = {
      code: roomCode,
      players: {
        p1: { token: createToken(), board: null, user },
        p2: null,
      },
      presetId: null,
      game: null,
    };
    await this.saveRoom(room);

    return json({
      roomCode,
      playerId: "p1",
      playerToken: room.players.p1.token,
    });
  }

  async join(request, roomCode) {
    const room = await this.requireRoom();
    if (room.players.p2) {
      return json({ error: "Room is full" }, 409);
    }

    room.players.p2 = { token: createToken(), board: null, user: publicUser(await requireUser(request, this.env)) };
    await this.saveRoom(room);
    await this.broadcast(room);

    return json({
      roomCode,
      playerId: "p2",
      playerToken: room.players.p2.token,
      presetId: room.presetId,
    });
  }

  async connect(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const room = await this.requireRoom();
    const playerId = url.searchParams.get("playerId");
    const token = url.searchParams.get("token");
    this.assertPlayer(room, playerId, token);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { playerId, socket: server });

    server.addEventListener("message", (event) => {
      this.handleMessage(sessionId, event.data);
    });
    server.addEventListener("close", () => {
      this.sessions.delete(sessionId);
    });
    server.addEventListener("error", () => {
      this.sessions.delete(sessionId);
    });

    this.sendSnapshot(server, room, playerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    try {
      const message = JSON.parse(data);
      let room = await this.requireRoom();

      if (message.type === "placeFleet") {
        const preset = roomPreset(room, message.presetId);
        room.presetId = preset.id;
        room.players[session.playerId].board = sanitizeBoard(message.board, preset);
        room = maybeStartGame(room);
        await this.saveRoom(room);
        await this.broadcast(room);
        return;
      }

      if (message.type === "requestRematch") {
        if (room.game?.phase !== "finished") {
          throw new Error("Rematch is available after a finished game");
        }
        const preset = roomPreset(room, message.presetId || room.game.presetId || room.presetId);
        room.rematch = {
          requests: {
            ...(room.rematch?.requests ?? {}),
            [session.playerId]: {
              board: sanitizeBoard(message.board, preset),
              requestedAt: new Date().toISOString(),
            },
          },
        };
        if (room.rematch.requests.p1?.board && room.rematch.requests.p2?.board) {
          room = startRematch(room, preset);
        }
        await this.saveRoom(room);
        await this.broadcast(room);
        return;
      }

      if (message.type === "fire") {
        if (!room.game) {
          throw new Error("Game has not started");
        }
        const wasFinished = room.game.phase === "finished";
        const result = fireAt(room.game, session.playerId, message.coordinate);
        room.game = result.game;
        const finishedNow = !wasFinished && room.game.phase === "finished";
        if (finishedNow) {
          room.finishedAt = new Date().toISOString();
          room.replayId ||= crypto.randomUUID();
        }
        if (finishedNow) {
          await this.recordFinishedOnlineBattle(room);
        } else {
          await this.saveRoom(room);
        }
        await this.broadcast(await this.requireRoom());
        return;
      }

      throw new Error(`Unknown message type: ${message.type}`);
    } catch (error) {
      this.send(session.socket, { type: "error", message: error.message });
    }
  }

  async broadcast(room) {
    for (const session of this.sessions.values()) {
      this.sendSnapshot(session.socket, room, session.playerId);
    }
  }

  sendSnapshot(socket, room, playerId) {
    this.send(socket, {
      type: "snapshot",
      snapshot: createPlayerSnapshot(room, playerId),
    });
  }

  send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  assertPlayer(room, playerId, token) {
    if ((playerId !== "p1" && playerId !== "p2") || !room.players[playerId]) {
      throw new Error("Unknown player");
    }
    if (room.players[playerId].token !== token) {
      throw new Error("Invalid player token");
    }
  }

  async getRoom() {
    return this.state.storage.get("room");
  }

  async requireRoom() {
    const room = await this.getRoom();
    if (!room) {
      throw new Error("Room not found");
    }
    return room;
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
  }

  async recordFinishedOnlineBattle(room) {
    if (!room.game || room.game.phase !== "finished" || recordingComplete(room)) {
      return;
    }
    const players = Object.entries(room.players).filter(([, player]) => player?.user);
    room.replayId ||= crypto.randomUUID();
    room.finishedAt ||= new Date().toISOString();
    let envelope;
    try {
      if (players.length !== 2) {
        throw new Error("Two online replay participants are required");
      }
      envelope = {
        replay: createOnlineReplayRecord(room, room.replayId),
        playerMatches: players.map(([playerId, player]) => ({
          playerId,
          user: publicUser(player.user),
          payload: onlineMatchPayload(room, playerId),
        })),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      await this.persistTerminalPayloadFailure(room, error);
      return false;
    }

    const dueAt = Date.now();
    const job = {
      envelope,
      retry: {
        attempts: 0,
        errorMessage: "",
        errorAt: null,
        nextAttemptAt: dueAt,
      },
    };
    const jobKey = archiveOutboxKey(room.replayId);
    const dueKey = archiveScheduleKey(dueAt, room.replayId);
    let persistedJob = job;
    let persistedScheduleKey = dueKey;
    await this.state.storage.setAlarm(dueAt);
    await this.state.storage.transaction(async (transaction) => {
      const existing = await transaction.get(jobKey);
      if (existing) {
        persistedJob = existing;
        const existingDueAt = existing.retry.nextAttemptAt;
        persistedScheduleKey = archiveScheduleKey(existingDueAt, room.replayId);
        return;
      }
      await transaction.put("room", room);
      await transaction.put(jobKey, job);
      await transaction.put(dueKey, { replayId: room.replayId, dueAt });
    });
    return this.processArchiveOutbox(persistedJob, persistedScheduleKey);
  }

  async persistTerminalPayloadFailure(room, error) {
    const failedAt = new Date().toISOString();
    const errorMessage = error?.message || "Replay payload is invalid";
    console.error("Replay archive payload is invalid", {
      replayId: room.replayId,
      classification: "invalid_payload",
      error: errorMessage,
    });
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put("room", room);
      await transaction.put(archiveDeadLetterKey(room.replayId), {
        replayId: room.replayId,
        classification: "invalid_payload",
        attempts: 0,
        errorMessage,
        failedAt,
        envelope: null,
        terminalData: {
          finishedAt: room.finishedAt,
          presetId: room.game?.presetId || "",
          winnerId: room.game?.winnerId || null,
          players: {
            p1: { user: publicUser(room.players?.p1?.user) },
            p2: { user: publicUser(room.players?.p2?.user) },
          },
          game: room.game
            ? structuredClone({
                presetId: room.game.presetId,
                winnerId: room.game.winnerId,
                players: room.game.players,
                log: room.game.log,
              })
            : null,
        },
      });
    });
  }

  async processArchiveOutbox(job, scheduleKey, { schedule = true } = {}) {
    if (!this.env?.DB) {
      await this.failArchiveOutbox(job, scheduleKey, new Error("Replay storage is not configured"), {
        classification: "configuration",
        terminal: true,
        schedule,
      });
      return false;
    }
    try {
      const recorded = await recordOnlineReplayBatch(
        this.env.DB,
        job.envelope.replay,
        job.envelope.playerMatches,
      );
      await this.markArchiveRecorded(job, scheduleKey, recorded);
      if (schedule) {
        await this.scheduleArchiveAlarm();
      }
      return true;
    } catch (error) {
      await this.failArchiveOutbox(job, scheduleKey, error, { classification: "transient", schedule });
      return false;
    }
  }

  async failArchiveOutbox(job, scheduleKey, error, { classification, terminal = false, schedule = true }) {
    const attempts = job.retry.attempts + 1;
    const exhausted = attempts >= archiveMaxAttempts;
    const finalClassification = exhausted ? "retry_exhausted" : classification;
    const errorMessage = error?.message || "Replay archive persistence failed";
    const failedAt = new Date().toISOString();
    console.error("Replay archive persistence failed", {
      replayId: job.envelope.replay.id,
      classification: finalClassification,
      attempts,
      error: errorMessage,
    });
    if (terminal || exhausted) {
      await this.state.storage.transaction(async (transaction) => {
        await transaction.put(archiveDeadLetterKey(job.envelope.replay.id), {
          replayId: job.envelope.replay.id,
          classification: finalClassification,
          attempts,
          errorMessage,
          failedAt,
          envelope: job.envelope,
          retry: {
            ...job.retry,
            attempts,
            errorMessage,
            errorAt: failedAt,
            nextAttemptAt: null,
          },
        });
        await transaction.delete(archiveOutboxKey(job.envelope.replay.id));
        await transaction.delete(scheduleKey);
      });
    } else {
      const delay = archiveRetryDelay(attempts);
      const nextAttemptAt = Date.now() + delay;
      const nextScheduleKey = archiveScheduleKey(nextAttemptAt, job.envelope.replay.id);
      const updatedJob = {
        ...job,
        retry: {
          ...job.retry,
          attempts,
          errorMessage,
          errorAt: failedAt,
          nextAttemptAt,
        },
      };
      await this.state.storage.setAlarm(nextAttemptAt);
      await this.state.storage.transaction(async (transaction) => {
        await transaction.put(archiveOutboxKey(job.envelope.replay.id), updatedJob);
        await transaction.put(nextScheduleKey, { replayId: job.envelope.replay.id, dueAt: nextAttemptAt });
        await transaction.delete(scheduleKey);
      });
    }
    if (schedule) {
      await this.scheduleArchiveAlarm();
    }
  }

  async markArchiveRecorded(job, scheduleKey, recorded) {
    await this.state.storage.transaction(async (transaction) => {
      const latest = await transaction.get("room");
      if (latest?.replayId === job.envelope.replay.id) {
        latest.ratingChanges = Object.fromEntries(
          recorded.filter(({ match }) => match.rating).map(({ playerId, match }) => [playerId, match.rating]),
        );
        latest.replayRecordedAt = job.envelope.replay.finishedAt;
        latest.profileRecordedAt = job.envelope.replay.finishedAt;
        delete latest.recordRetryCount;
        delete latest.profileRecordErrorAt;
        delete latest.profileRecordError;
        await transaction.put("room", latest);
      }
      await transaction.delete(archiveOutboxKey(job.envelope.replay.id));
      await transaction.delete(scheduleKey);
    });
  }

  async scheduleArchiveAlarm() {
    const scheduled = await this.state.storage.list({ prefix: archiveSchedulePrefix, limit: 1 });
    const first = scheduled.values().next().value;
    if (!first) {
      await this.state.storage.deleteAlarm?.();
      return;
    }
    await this.state.storage.setAlarm(first.dueAt);
  }

  async alarm() {
    const now = Date.now();
    const end = archiveScheduleEnd(now);
    const due = await this.state.storage.list({
      prefix: archiveSchedulePrefix,
      end,
      limit: archiveAlarmBatchSize,
    });
    for (const [scheduleKey, item] of due) {
      const job = await this.state.storage.get(archiveOutboxKey(item.replayId));
      if (job) {
        await this.processArchiveOutbox(job, scheduleKey, { schedule: false });
      } else {
        await this.state.storage.delete(scheduleKey);
      }
    }
    const moreDue = await this.state.storage.list({ prefix: archiveSchedulePrefix, end, limit: 1 });
    if (moreDue.size > 0) {
      await this.state.storage.setAlarm(now);
    } else {
      const scheduled = await this.state.storage.list({ prefix: archiveSchedulePrefix, limit: 1 });
      if (scheduled.size === 0) {
        await this.recoverFinishedArchive();
      }
      await this.scheduleArchiveAlarm();
    }
  }

  async recoverFinishedArchive() {
    const room = await this.state.storage.get("room");
    if (room?.game?.phase !== "finished" || recordingComplete(room)) {
      return false;
    }
    if (room.replayId) {
      const pending = await this.state.storage.get(archiveOutboxKey(room.replayId));
      const deadLetter = await this.state.storage.get(archiveDeadLetterKey(room.replayId));
      if (pending || deadLetter) {
        return false;
      }
    }
    await this.recordFinishedOnlineBattle(room);
    return true;
  }

  async requeueArchiveDeadLetter(replayId) {
    const deadLetterKey = archiveDeadLetterKey(replayId);
    const deadLetter = await this.state.storage.get(deadLetterKey);
    if (!deadLetter?.envelope) {
      return false;
    }
    const dueAt = Date.now();
    const job = {
      envelope: deadLetter.envelope,
      retry: {
        attempts: 0,
        errorMessage: "",
        errorAt: null,
        nextAttemptAt: dueAt,
        requeuedAt: new Date().toISOString(),
      },
    };
    await this.state.storage.setAlarm(dueAt);
    await this.state.storage.transaction(async (transaction) => {
      await transaction.put(archiveOutboxKey(replayId), job);
      await transaction.put(archiveScheduleKey(dueAt, replayId), { replayId, dueAt });
      await transaction.delete(deadLetterKey);
    });
    return true;
  }

  async drainArchiveOutbox() {
    await this.alarm();
  }
}

export function createPlayerSnapshot(room, playerId) {
  const opponentId = playerId === "p1" ? "p2" : "p1";
  const ownRoomPlayer = room.players[playerId];
  const opponentJoined = Boolean(room.players[opponentId]);

  if (!room.game) {
    const preset = getGamePreset(room.presetId);
    return {
      roomCode: room.code,
      playerId,
      phase: opponentJoined ? "setup" : "lobby",
      presetId: preset.id,
      rules: preset.rules,
      size: preset.size,
      salvoRemaining: 1,
      isYourTurn: false,
      opponentJoined,
      winnerId: null,
      you: {
        board: ownRoomPlayer?.board ? cloneBoard(ownRoomPlayer.board) : createBoard(preset.size),
        user: ownRoomPlayer?.user ?? null,
      },
      opponentUser: room.players[opponentId]?.user ?? null,
      opponentShots: [],
      log: [],
      ratingChange: null,
      rematch: null,
      rematchRound: room.rematchRound ?? 0,
    };
  }

  const ownBoard = cloneBoard(room.game.players[playerId].board);
  const opponentView = publicBoardView(room.game.players[opponentId].board);

  return {
    roomCode: room.code,
    playerId,
    phase: room.game.phase,
    presetId: room.game.presetId,
    rules: room.game.rules,
    size: ownBoard.size,
    salvoRemaining: room.game.salvoRemaining,
    isYourTurn: room.game.phase === "playing" && room.game.currentPlayerId === playerId,
    opponentJoined,
    winnerId: room.game.winnerId,
    you: { board: ownBoard, user: ownRoomPlayer?.user ?? null },
    opponentUser: room.players[opponentId]?.user ?? null,
    opponentShots: opponentView.shots.map(({ row, col, result, shipId }) => ({
      row,
      col,
      result,
      ...(result === "sunk" && shipId ? { shipId } : {}),
    })),
    log: room.game.log.map(({ playerId: shooterId, targetPlayerId, coordinate, result }) => ({
      playerId: shooterId,
      targetPlayerId,
      coordinate,
      result,
    })),
    ratingChange: room.ratingChanges?.[playerId] ?? null,
    rematch: rematchSnapshot(room, playerId),
    rematchRound: room.rematchRound ?? 0,
  };
}

function rematchSnapshot(room, playerId) {
  const requests = room.rematch?.requests;
  if (!requests) {
    return null;
  }
  const opponentId = playerId === "p1" ? "p2" : "p1";
  const readyCount = ["p1", "p2"].filter((id) => requests[id]?.board).length;
  return {
    requestedByYou: Boolean(requests[playerId]?.board),
    opponentRequested: Boolean(requests[opponentId]?.board),
    readyCount,
    needed: 2,
  };
}

function startRematch(room, preset) {
  const next = { ...room };
  const p1Board = cloneBoard(room.rematch.requests.p1.board);
  const p2Board = cloneBoard(room.rematch.requests.p2.board);
  next.players = {
    p1: { ...room.players.p1, board: p1Board },
    p2: { ...room.players.p2, board: p2Board },
  };
  next.presetId = preset.id;
  next.game = createGameFromBoards(p1Board, p2Board, "p1", {
    presetId: preset.id,
    rules: preset.rules,
  });
  next.rematchRound = (room.rematchRound ?? 0) + 1;
  delete next.finishedAt;
  delete next.replayId;
  delete next.replayRecordedAt;
  delete next.profileRecordedAt;
  delete next.profileRecordErrorAt;
  delete next.profileRecordError;
  delete next.recordRetryCount;
  delete next.ratingChanges;
  delete next.rematch;
  return next;
}

function routeRequest(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "auth" && parts[1] === "telegram") {
    return { kind: "authTelegram" };
  }
  if (parts.length === 2 && parts[0] === "auth" && parts[1] === "me") {
    return { kind: "authMe" };
  }
  if (parts.length === 2 && parts[0] === "auth" && parts[1] === "logout") {
    return { kind: "authLogout" };
  }
  if (parts.length === 2 && parts[0] === "profile" && parts[1] === "me") {
    return { kind: "profileMe" };
  }
  if (parts.length === 2 && parts[0] === "profile" && parts[1] === "matches") {
    return { kind: "profileMatches" };
  }
  if (parts.length === 2 && parts[0] === "profile" && parts[1] === "replays") {
    return { kind: "profileReplays" };
  }
  if (parts.length === 2 && parts[0] === "replays" && /^[A-Za-z0-9-]{1,128}$/.test(parts[1])) {
    return { kind: "replay", replayId: parts[1] };
  }
  if (parts.length === 1 && parts[0] === "leaderboard") {
    return { kind: "leaderboard" };
  }
  if (parts.length === 1 && parts[0] === "rooms") {
    return { kind: "create", roomCode: url.searchParams.get("code") || createRoomCode() };
  }
  if (parts.length === 3 && parts[0] === "rooms" && parts[2] === "join") {
    return { kind: "join", roomCode: sanitizeRoomCode(parts[1]) };
  }
  if (parts.length === 3 && parts[0] === "rooms" && parts[2] === "socket") {
    return { kind: "socket", roomCode: sanitizeRoomCode(parts[1]) };
  }
  return null;
}

async function authenticateTelegram(request, env) {
  try {
    const payload = await request.json();
    const user = await verifyTelegramLoginPayload(payload, env.TELEGRAM_BOT_TOKEN);
    const token = await createSessionToken(user, env.SESSION_SECRET);
    return json({ token, user });
  } catch (error) {
    return json({ error: error.message }, 401);
  }
}

async function currentUser(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    return json({ user: null });
  }
  try {
    return json({ user: publicUser(await verifySessionToken(token, env.SESSION_SECRET)) });
  } catch (error) {
    return json({ error: error.message }, 401);
  }
}

async function playerProfile(request, env) {
  try {
    const user = await requireUser(request, env);
    const [profile, leaderboardPayload] = await Promise.all([
      getPlayerProfile(env.DB, user),
      getLeaderboard(env.DB),
    ]);
    return json({ user: publicUser(user), profile: { ...profile, leaderboard: leaderboardPayload } });
  } catch (error) {
    return json({ error: error.message }, authErrorStatus(error));
  }
}

async function saveProfileMatch(request, env) {
  try {
    const user = await requireUser(request, env);
    const match = await recordCompletedMatch(env.DB, user, await request.json(), { source: "client" });
    const [profile, leaderboardPayload] = await Promise.all([
      getPlayerProfile(env.DB, user),
      getLeaderboard(env.DB),
    ]);
    return json(
      {
        match,
        profile: { ...profile, leaderboard: leaderboardPayload },
      },
      201,
    );
  } catch (error) {
    return json({ error: error.message }, authErrorStatus(error));
  }
}

async function leaderboard(env) {
  try {
    return json({ leaderboard: await getLeaderboard(env.DB) });
  } catch (error) {
    return json({ error: error.message }, authErrorStatus(error));
  }
}

async function archivedReplay(request, env, replayId) {
  try {
    const user = await requireUser(request, env);
    return json({ replay: await getAuthorizedReplay(env.DB, replayId, user) });
  } catch (error) {
    return json({ error: error.message }, replayErrorStatus(error));
  }
}

async function playerReplays(request, env, url) {
  try {
    const user = await requireUser(request, env);
    const archive = await listPlayerReplays(env.DB, user, {
      cursor: url.searchParams.get("cursor") || undefined,
    });
    return json({ archive });
  } catch (error) {
    return json({ error: error.message }, replayErrorStatus(error));
  }
}

async function requireUser(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  return verifySessionToken(token, env.SESSION_SECRET);
}

function authErrorStatus(error) {
  const message = error.message.toLowerCase();
  return message.includes("authentication") || message.includes("session") ? 401 : 400;
}

function replayErrorStatus(error) {
  if (error instanceof HttpError) {
    return error.status;
  }
  const authStatus = authErrorStatus(error);
  return authStatus === 401 ? 401 : 503;
}

async function createRoom(request, env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = createRoomCode();
    const id = env.BATTLE_ROOM.idFromName(roomCode);
    const room = env.BATTLE_ROOM.get(id);
    const response = await room.fetch(
      new Request(new URL(`/rooms?code=${roomCode}`, request.url), {
        method: "POST",
        headers: request.headers,
      }),
    );
    if (response.status !== 409) {
      return response;
    }
  }
  return json({ error: "Could not allocate room code" }, 503);
}

function maybeStartGame(room) {
  if (room.game || !room.players.p1?.board || !room.players.p2?.board) {
    return room;
  }
  const preset = getGamePreset(room.presetId);
  return {
    ...room,
    game: createGameFromBoards(room.players.p1.board, room.players.p2.board, "p1", {
      presetId: preset.id,
      rules: preset.rules,
    }),
  };
}

function sanitizeBoard(board, preset) {
  const clean = cloneBoard(board);
  if (clean.size !== preset.size) {
    throw new Error("Invalid board size");
  }
  if (!hasCompleteSetup(clean, preset)) {
    throw new Error("A complete legal setup is required");
  }
  return clean;
}

function roomPreset(room, presetId) {
  const preset = getGamePreset(presetId);
  if (room.presetId && room.presetId !== preset.id) {
    throw new Error("Room uses a different battle format");
  }
  return preset;
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function sanitizeRoomCode(value) {
  const code = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 4 || code.length > 12) {
    throw new Error("Invalid room code");
  }
  return code;
}

function createToken() {
  return crypto.randomUUID();
}

function onlineMatchPayload(room, playerId) {
  const opponentId = playerId === "p1" ? "p2" : "p1";
  const game = room.game;
  const summary = summarizeBattleLog(game.log, game.winnerId);
  const playerStats = summary.players.find((stats) => stats.playerId === playerId) ?? {
    shots: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
    accuracy: 0,
  };
  const opponent = room.players[opponentId]?.user;
  return {
    id: `online:${room.replayId}:${playerId}`,
    mode: "online",
    presetId: game.presetId,
    result: game.winnerId === playerId ? "win" : "loss",
    opponent: opponent?.name || opponent?.username || "online",
    totalShots: summary.totalShots,
    playerShots: playerStats.shots,
    playerHits: playerStats.hits,
    playerMisses: playerStats.misses,
    playerSunk: playerStats.sunk,
    accuracy: playerStats.accuracy,
    turns: game.log.length,
    winnerId: game.winnerId,
    playedAt: room.finishedAt,
    replayId: room.replayId,
  };
}

function recordingComplete(room) {
  return Boolean(room.replayRecordedAt && room.profileRecordedAt);
}

function archiveOutboxKey(replayId) {
  return `${archiveOutboxPrefix}${replayId}`;
}

function archiveDeadLetterKey(replayId) {
  return `${archiveDeadLetterPrefix}${replayId}`;
}

function archiveScheduleKey(dueAt, replayId) {
  return `${archiveSchedulePrefix}${String(dueAt).padStart(13, "0")}:${replayId}`;
}

function archiveScheduleEnd(dueAt) {
  return `${archiveSchedulePrefix}${String(dueAt).padStart(13, "0")}:\uffff`;
}

function archiveRetryDelay(attempts) {
  return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
