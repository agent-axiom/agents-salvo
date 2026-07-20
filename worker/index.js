import {
  cloneBoard,
  createBoard,
  createGameFromBoards,
  fireAt,
  hasCompleteSetup,
  placeMarker,
  placeShip,
  publicBoardView,
} from "../src/core/game.js";
import { getGamePreset } from "../src/core/presets.js";
import { summarizeBattleLog } from "../src/core/stats.js";
import { parseBearerToken, publicUser, verifyTelegramLoginPayload } from "./auth.js";
import { cleanupExpiredAuthRecords, createSession, resolveSession, revokeSession } from "./session.js";
import {
  createTelegramAuthorization,
  exchangeTelegramCode,
  loadTelegramJwks,
  oidcConfigured,
  verifyTelegramIdToken,
} from "./telegram-oidc.js";
import { verifyTelegramMiniAppInitData } from "./telegram-mini-app-auth.js";
import {
  getLeaderboard,
  getPlayerProfile,
  recordCompletedMatch,
  recordOnlineReplayBatch,
  userSubject,
} from "./profile.js";
import {
  HttpError,
  createOnlineReplayRecord,
  getAuthorizedReplay,
  listPlayerReplays,
  parseReplayPayload,
} from "./replay.js";
import { createStarsSupportService, starsAmountLimits } from "./stars-support.js";
import { createTelegramBotApiClient } from "./telegram-bot-api.js";

const archiveOutboxPrefix = "replayArchiveOutbox:";
const archiveDeadLetterPrefix = "replayArchiveDeadLetter:";
const archiveSchedulePrefix = "replayArchiveSchedule:";
const archiveMaxAttempts = 12;
const archiveAlarmBatchSize = 10;
const telegramCallbackUri = "https://agents-salvo-room.if-ab6.workers.dev/auth/telegram/mobile/callback";
const telegramWebTarget = "https://agent-axiom.github.io/agents-salvo/";
const telegramFlowTtlSeconds = 5 * 60;
const telegramTicketTtlSeconds = 5 * 60;
const maxTelegramJsonBytes = 1024;
const telegramMiniAppJsonEnvelopeBytes = 15;
const maxTelegramMiniAppJsonBytes = 16 * 1024 + telegramMiniAppJsonEnvelopeBytes;
const maxTelegramCodeLength = 4096;
const maxStarsInvoiceJsonBytes = 1024;
const telegramSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const telegramPlatforms = new Set(["web", "android", "ios"]);
const starsLocales = new Set(["en", "ru", "zh"]);
const telegramTextEncoder = new TextEncoder();
const telegramWebhookJsonMaxBytes = 64 * 1024;
const telegramWebhookSecretPattern = /^[A-Za-z0-9_-]{32,256}$/u;

const telegramTermsUrl = "https://agent-axiom.github.io/agents-salvo/support.html";
const telegramSupportUrl = "https://github.com/agent-axiom/agents-salvo/issues";
const telegramSupportCommandPattern = /^\/(terms|support|paysupport)(?:@agents_salvo_bot)?$/u;
const telegramSupportCommandText = Object.freeze({
  en: Object.freeze({
    terms: `Terms of Support: ${telegramTermsUrl}`,
    support: `Purchase support: ${telegramSupportUrl}. Telegram Support cannot resolve this purchase. Do not publish session tokens, invoice payloads, or payment charge IDs.`,
  }),
  ru: Object.freeze({
    terms: `Условия поддержки: ${telegramTermsUrl}`,
    support: `Поддержка покупок: ${telegramSupportUrl}. Поддержка Telegram не может решить проблему с этой покупкой. Не публикуйте токены сессий, содержимое счетов или идентификаторы платежных списаний.`,
  }),
  zh: Object.freeze({
    terms: `支持条款：${telegramTermsUrl}`,
    support: `购买支持：${telegramSupportUrl}。Telegram 支持无法解决此购买问题。请勿发布会话令牌、账单载荷或付款扣款 ID。`,
  }),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isWebhookPath = isTelegramWebhookPath(url.pathname);
    let route;
    try {
      route = routeRequest(url);
    } catch (error) {
      if (isWebhookPath) {
        return webhookJson({ error: "Not found" }, 404);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }
      return json({ error: error.message }, 400);
    }
    if (isWebhookPath) {
      if (route?.kind === "telegramWebhook" && request.method === "POST") {
        return telegramWebhook(request, env);
      }
      return webhookJson({ error: "Not found" }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (!route) {
      return json({ error: "Not found" }, 404);
    }

    if (route.kind === "starsInvoiceCreate" && request.method === "POST") {
      return createStarsInvoice(request, env);
    }
    if (route.kind === "starsInvoiceStatus" && request.method === "GET") {
      return getStarsInvoice(request, env, route.invoiceId);
    }
    if (route.kind === "starsInvoiceCreate" || route.kind === "starsInvoiceStatus") {
      return json({ error: "Not found" }, 404);
    }

    if (route.kind === "authTelegramConfig" && request.method === "GET") {
      return json({ method: oidcConfigured(env) ? "oidc" : "legacy" });
    }
    if (route.kind === "authTelegramMobileStart" && request.method === "POST") {
      return startTelegramMobileAuth(request, env, ctx);
    }
    if (route.kind === "authTelegramMobileCallback" && request.method === "GET") {
      return completeTelegramMobileAuth(url, env);
    }
    if (route.kind === "authTelegramMobileRedeem" && request.method === "POST") {
      return redeemTelegramMobileTicket(request, env, ctx);
    }
    if (route.kind.startsWith("authTelegramMobile") || route.kind === "authTelegramConfig") {
      return json({ error: "Not found" }, 404);
    }
    if (route.kind === "authTelegramMiniApp") {
      if (request.method === "POST") {
        return authenticateTelegramMiniApp(request, env);
      }
      return json({ error: "Not found" }, 404);
    }
    if (route.kind === "authTelegram" && request.method === "POST") {
      return authenticateTelegram(request, env);
    }
    if (route.kind === "authMe" && request.method === "GET") {
      return currentUser(request, env);
    }
    if (route.kind === "authLogout" && request.method === "POST") {
      return logout(request, env);
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
    const { user: authorizedUser } = await authorizeRequest(request, this.env);
    const user = publicUser(authorizedUser);
    const existing = await this.getRoom();
    if (existing) {
      return json({ error: "Room already exists" }, 409);
    }

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
    const { user } = await authorizeRequest(request, this.env);
    const room = await this.requireRoom();
    if (room.players.p2 || userSubject(room.players.p1.user) === userSubject(user)) {
      return json({ error: "Room is full" }, 409);
    }

    room.players.p2 = { token: createToken(), board: null, user: publicUser(user) };
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
        const result = fireAt(room.game, session.playerId, sanitizeCoordinate(message.coordinate));
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
          game: terminalRecoveryGame(room.game),
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

  async requeueArchiveDeadLetter(replayId, repairedEnvelope) {
    const deadLetterKey = archiveDeadLetterKey(replayId);
    const deadLetter = await this.state.storage.get(deadLetterKey);
    if (!deadLetter) {
      return false;
    }
    let envelope = deadLetter.envelope;
    if (deadLetter.classification === "invalid_payload") {
      if (!repairedEnvelope) {
        return false;
      }
      envelope = normalizeRepairedEnvelope(replayId, repairedEnvelope);
    } else if (repairedEnvelope) {
      throw new Error("A repaired envelope is only valid for invalid payload dead letters");
    }
    if (!envelope) {
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
  if (url.search === "" && url.pathname === "/payments/stars/invoices") {
    return { kind: "starsInvoiceCreate" };
  }
  if (url.search === "") {
    const starsInvoiceMatch = /^\/payments\/stars\/invoices\/(inv_[A-Za-z0-9_-]{22})$/u.exec(url.pathname);
    if (starsInvoiceMatch) {
      return { kind: "starsInvoiceStatus", invoiceId: starsInvoiceMatch[1] };
    }
  }
  if (url.search === "" && url.pathname === "/telegram/webhook") {
    return { kind: "telegramWebhook" };
  }
  if (url.pathname === "/auth/telegram/config") {
    return { kind: "authTelegramConfig" };
  }
  if (url.pathname === "/auth/telegram/mobile/start") {
    return { kind: "authTelegramMobileStart" };
  }
  if (url.pathname === "/auth/telegram/mobile/callback") {
    return { kind: "authTelegramMobileCallback" };
  }
  if (url.pathname === "/auth/telegram/mobile/redeem") {
    return { kind: "authTelegramMobileRedeem" };
  }
  if (url.pathname === "/auth/telegram/miniapp") {
    return { kind: "authTelegramMiniApp" };
  }
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

function isTelegramWebhookPath(pathname) {
  const normalized = pathname.toLowerCase();
  return normalized === "/telegram/webhook" || normalized.startsWith("/telegram/webhook/");
}

async function createStarsInvoice(request, env) {
  let user;
  try {
    ({ user } = await authorizeStarsRequest(request, env));
  } catch (error) {
    if (error?.category === "service_unavailable") {
      return starsErrorJson("service_unavailable");
    }
    return json({ error: authenticationErrorMessage(error) }, 401);
  }

  let payload;
  try {
    payload = await readStrictStarsInvoiceJson(request);
  } catch {
    return starsErrorJson("invalid_request");
  }

  try {
    const invoice = await createWorkerStarsService(env).createInvoice({ user, ...payload });
    return json(invoice, 201);
  } catch (error) {
    return starsErrorJson(starsErrorCategory(error));
  }
}

async function getStarsInvoice(request, env, invoiceId) {
  let user;
  try {
    ({ user } = await authorizeStarsRequest(request, env));
  } catch (error) {
    if (error?.category === "service_unavailable") {
      return starsErrorJson("service_unavailable");
    }
    return json({ error: authenticationErrorMessage(error) }, 401);
  }
  try {
    const invoice = await createWorkerStarsService(env).getInvoice({ user, invoiceId });
    return json(invoice);
  } catch (error) {
    return starsErrorJson(starsErrorCategory(error));
  }
}

async function telegramWebhook(request, env) {
  let service;
  let botApi;
  let d1Failed;
  let expectedSecret;
  try {
    expectedSecret = env?.TELEGRAM_WEBHOOK_SECRET;
    if (
      typeof expectedSecret !== "string" ||
      !telegramWebhookSecretPattern.test(expectedSecret)
    ) {
      throw new Error("Invalid webhook configuration");
    }
    ({ botApi, d1Failed, service } = createWorkerStarsDependencies(env, { observeD1: true }));
  } catch {
    return webhookJson({ error: "Stars support is unavailable" }, 503);
  }

  try {
    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!(await telegramSecretsEqual(expectedSecret, suppliedSecret))) {
      return webhookJson({ error: "Forbidden" }, 403);
    }
  } catch {
    return webhookJson({ error: "Stars support is unavailable" }, 503);
  }

  let update;
  try {
    ({ payload: update } = await readBoundedJsonBody(request, telegramWebhookJsonMaxBytes));
    if (update === null || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("Invalid Telegram update");
    }
  } catch {
    return webhookJson({ error: "Invalid Telegram update" }, 400);
  }

  try {
    const serviceResult = await service.handleUpdate(update);
    if (serviceResult.kind === "pre_checkout" && d1Failed()) {
      return webhookJson({ error: "Stars support is unavailable" }, 503);
    }
    if (serviceResult.kind !== "ignored") {
      return webhookJson({ ok: true });
    }
    const command = snapshotTelegramSupportCommand(update);
    if (command === null) {
      return webhookJson({ ok: true });
    }
    await botApi.sendMessage({ chatId: command.chatId, text: command.text });
    return webhookJson({ ok: true });
  } catch {
    return webhookJson({ error: "Stars support is unavailable" }, 503);
  }
}

function createWorkerStarsService(env) {
  return createWorkerStarsDependencies(env).service;
}

function createWorkerStarsDependencies(env, { observeD1 = false } = {}) {
  try {
    const configuredDb = env.DB;
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const configuredFetcher = env.TELEGRAM_FETCH;
    let observedFailure = false;
    const db = observeD1
      ? observedD1Binding(configuredDb, () => {
          observedFailure = true;
        })
      : configuredDb;
    const botApi = createTelegramBotApiClient({
      botToken,
      fetcher: configuredFetcher ?? globalThis.fetch,
    });
    return {
      botApi,
      d1Failed: () => observedFailure,
      service: createStarsSupportService({ db, botApi }),
    };
  } catch {
    throw new Error("Stars support unavailable");
  }
}

function observedD1Binding(db, onFailure) {
  const prepare = db?.prepare;
  if (typeof prepare !== "function") {
    throw new Error("Invalid D1 binding");
  }
  return {
    prepare(sql) {
      try {
        return observedD1Statement(prepare.call(db, sql), onFailure);
      } catch (error) {
        onFailure();
        throw error;
      }
    },
  };
}

function observedD1Statement(statement, onFailure) {
  return {
    bind(...values) {
      try {
        const bind = statement?.bind;
        if (typeof bind !== "function") {
          throw new Error("Invalid D1 statement");
        }
        return observedD1Statement(bind.call(statement, ...values), onFailure);
      } catch (error) {
        onFailure();
        throw error;
      }
    },
    async first(...values) {
      return observedD1StatementCall(statement, "first", values, onFailure);
    },
    async run(...values) {
      return observedD1StatementCall(statement, "run", values, onFailure);
    },
    async all(...values) {
      return observedD1StatementCall(statement, "all", values, onFailure);
    },
  };
}

async function observedD1StatementCall(statement, methodName, values, onFailure) {
  try {
    const method = statement?.[methodName];
    if (typeof method !== "function") {
      throw new Error("Invalid D1 statement");
    }
    return await method.call(statement, ...values);
  } catch (error) {
    onFailure();
    throw error;
  }
}

function starsErrorCategory(error) {
  try {
    const category = error?.category;
    const status = error?.status;
    if (
      (category === "invalid_request" && status === 400) ||
      (category === "not_found" && status === 404) ||
      (category === "service_unavailable" && status === 503)
    ) {
      return category;
    }
  } catch {
    // Unowned failures collapse to one unavailable category.
  }
  return "service_unavailable";
}

function starsErrorJson(category) {
  if (category === "invalid_request") {
    return json({ error: "Invalid Stars support request" }, 400);
  }
  if (category === "not_found") {
    return json({ error: "Stars invoice not found" }, 404);
  }
  return json({ error: "Stars support is unavailable" }, 503);
}

async function authorizeStarsRequest(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  try {
    return { token, user: await resolveSession(env.DB, token) };
  } catch (error) {
    if (error instanceof Error && error.message === "Session invalid") {
      throw new Error("Authentication failed");
    }
    const unavailable = new Error("Stars support unavailable");
    unavailable.category = "service_unavailable";
    throw unavailable;
  }
}

async function telegramSecretsEqual(expected, supplied) {
  const expectedBytes = telegramTextEncoder.encode(expected);
  const suppliedBytes = telegramTextEncoder.encode(supplied);
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", expectedBytes),
    crypto.subtle.digest("SHA-256", suppliedBytes),
  ]);
  const expectedHash = new Uint8Array(expectedDigest);
  const suppliedHash = new Uint8Array(suppliedDigest);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= expectedHash[index] ^ suppliedHash[index];
  }
  return difference === 0;
}

function snapshotTelegramSupportCommand(update) {
  const messageRead = readWorkerProperty(update, "message");
  if (!messageRead.ok || !isWorkerRecord(messageRead.value)) {
    return null;
  }
  const message = messageRead.value;
  const paymentRead = readWorkerProperty(message, "successful_payment");
  const chatRead = readWorkerProperty(message, "chat");
  const textRead = readWorkerProperty(message, "text");
  const fromRead = readWorkerProperty(message, "from");
  if (
    !paymentRead.ok ||
    paymentRead.value !== undefined ||
    !chatRead.ok ||
    !isWorkerRecord(chatRead.value) ||
    !textRead.ok ||
    typeof textRead.value !== "string" ||
    !fromRead.ok ||
    !isWorkerRecord(fromRead.value)
  ) {
    return null;
  }
  const chatIdRead = readWorkerProperty(chatRead.value, "id");
  const chatTypeRead = readWorkerProperty(chatRead.value, "type");
  if (
    !chatIdRead.ok ||
    !isSafeTelegramChatId(chatIdRead.value) ||
    !chatTypeRead.ok ||
    chatTypeRead.value !== "private"
  ) {
    return null;
  }
  const match = telegramSupportCommandPattern.exec(textRead.value);
  if (match === null) {
    return null;
  }
  let languageCode;
  const languageRead = readWorkerProperty(fromRead.value, "language_code");
  if (!languageRead.ok) {
    return null;
  }
  languageCode = languageRead.value;
  const locale = telegramSupportLocale(languageCode);
  const name = match[1];
  return Object.freeze({
    chatId: chatIdRead.value,
    name,
    text: name === "terms"
      ? telegramSupportCommandText[locale].terms
      : telegramSupportCommandText[locale].support,
  });
}

function telegramSupportLocale(languageCode) {
  if (typeof languageCode === "string") {
    const normalized = languageCode.toLowerCase();
    if (normalized.startsWith("ru")) {
      return "ru";
    }
    if (normalized.startsWith("zh")) {
      return "zh";
    }
  }
  return "en";
}

function isSafeTelegramChatId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value !== 0;
  }
  return (
    typeof value === "string" &&
    /^-?[1-9]\d{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function readWorkerProperty(record, key) {
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function isWorkerRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readStrictStarsInvoiceJson(request) {
  const { payload, text } = await readBoundedJsonBody(request, maxStarsInvoiceJsonBytes);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid JSON object");
  }
  const keys = topLevelJsonObjectKeys(text);
  const amount = Object.getOwnPropertyDescriptor(payload, "amount");
  const locale = Object.getOwnPropertyDescriptor(payload, "locale");
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("amount") ||
    !keys.includes("locale") ||
    !amount ||
    !Object.hasOwn(amount, "value") ||
    !locale ||
    !Object.hasOwn(locale, "value") ||
    typeof amount.value !== "number" ||
    !Number.isInteger(amount.value) ||
    amount.value < starsAmountLimits.min ||
    amount.value > starsAmountLimits.max ||
    typeof locale.value !== "string" ||
    !starsLocales.has(locale.value)
  ) {
    throw new Error("Invalid Stars values");
  }
  return { amount: amount.value, locale: locale.value };
}

async function readBoundedJsonBody(request, maxBytes) {
  if (request.headers.get("Content-Type") !== "application/json") {
    await cancelUnreadRequestBody(request);
    throw new Error("Invalid content type");
  }
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !/^(?:0|[1-9]\d*)$/u.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength > maxBytes
    ) {
      await cancelUnreadRequestBody(request);
      throw new Error("Request too large");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Request body required");
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk || typeof chunk.done !== "boolean") {
        throw new Error("Invalid request stream");
      }
      if (chunk.done) {
        break;
      }
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > maxBytes - length) {
        try {
          await reader.cancel();
        } catch {
          // The fixed public validation failure remains authoritative.
        }
        throw new Error("Request too large");
      }
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { payload: JSON.parse(text), text };
}

async function cancelUnreadRequestBody(request) {
  try {
    await request.body?.cancel();
  } catch {
    // The caller still returns its fixed validation failure.
  }
}

function topLevelJsonObjectKeys(text) {
  const keys = [];
  const containers = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{" || character === "[") {
      containers.push(character);
      continue;
    }
    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }
    if (character !== '"') {
      continue;
    }
    const start = index;
    for (index += 1; index < text.length; index += 1) {
      if (text[index] === "\\") {
        index += 1;
      } else if (text[index] === '"') {
        break;
      }
    }
    let next = index + 1;
    while (/\s/u.test(text[next] ?? "")) {
      next += 1;
    }
    if (containers.length === 1 && containers[0] === "{" && text[next] === ":") {
      keys.push(JSON.parse(text.slice(start, index + 1)));
    }
  }
  return keys;
}

async function authenticateTelegram(request, env) {
  let user;
  try {
    const payload = await request.json();
    user = await verifyTelegramLoginPayload(payload, env.TELEGRAM_BOT_TOKEN);
  } catch (error) {
    return json({ error: error.message }, 401);
  }

  try {
    const { token } = await createSession(env.DB, user);
    return json({ token, user });
  } catch {
    return json({ error: "Telegram authentication failed" }, 401);
  }
}

async function authenticateTelegramMiniApp(request, env) {
  const config = telegramMiniAppServiceConfig(env);
  if (!config) {
    return telegramMiniAppAuthFailure(503);
  }

  let initData;
  try {
    ({ initData } = await readStrictTelegramJson(request, "initData", maxTelegramMiniAppJsonBytes));
  } catch {
    return telegramMiniAppAuthFailure(401);
  }

  let user;
  try {
    ({ user } = await verifyTelegramMiniAppInitData(initData, config.botToken));
  } catch {
    return telegramMiniAppAuthFailure(401);
  }

  try {
    const { token } = await createSession(config.db, user);
    return json({ token, user });
  } catch {
    return telegramMiniAppAuthFailure(503);
  }
}

function telegramMiniAppServiceConfig(env) {
  try {
    const db = env?.DB;
    const botToken = env?.TELEGRAM_BOT_TOKEN;
    if (!db || typeof botToken !== "string" || botToken.trim() === "") return null;
    return { db, botToken };
  } catch {
    return null;
  }
}

function telegramMiniAppAuthFailure(status) {
  return json({ error: "Telegram Mini App authentication failed" }, status);
}

async function startTelegramMobileAuth(request, env, ctx) {
  if (!oidcConfigured(env) || !env.DB) {
    return json({ error: "Telegram OIDC unavailable" }, 503);
  }

  let payload;
  try {
    payload = await readStrictTelegramJson(request, "platform");
    if (!telegramPlatforms.has(payload.platform)) {
      throw new Error("Invalid platform");
    }
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  try {
    const now = currentEpochSeconds();
    const authorization = await createTelegramAuthorization({
      clientId: env.TELEGRAM_CLIENT_ID.trim(),
      redirectUri: telegramCallbackUri,
      platform: payload.platform,
    });
    await env.DB
      .prepare(
        `INSERT INTO telegram_oidc_flows
          (state_hash, nonce, code_verifier, platform, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        await hashTelegramSecret(authorization.flow.state),
        authorization.flow.nonce,
        authorization.flow.codeVerifier,
        authorization.flow.platform,
        now,
        now + telegramFlowTtlSeconds,
      )
      .run();
    scheduleTelegramCleanup(env.DB, ctx);
    return json({ authorizationUrl: authorization.url.toString() });
  } catch {
    return json({ error: "Telegram OIDC unavailable" }, 503);
  }
}

async function completeTelegramMobileAuth(url, env) {
  let platform;
  try {
    if (!oidcConfigured(env) || !env.DB) {
      throw new Error("Unavailable");
    }
    const state = url.searchParams.get("state");
    if (!telegramSecretPattern.test(state ?? "")) {
      throw new Error("Invalid state");
    }

    const now = currentEpochSeconds();
    const flow = await env.DB
      .prepare(
        `UPDATE telegram_oidc_flows
        SET consumed_at = ?
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING nonce, code_verifier, platform`,
      )
      .bind(now, await hashTelegramSecret(state), now)
      .first();
    if (!validTelegramFlow(flow)) {
      throw new Error("Invalid flow");
    }
    platform = flow.platform;
    if (url.searchParams.has("error")) {
      throw new Error("Provider denied");
    }

    const code = url.searchParams.get("code");
    if (typeof code !== "string" || code.trim() === "" || code.length > maxTelegramCodeLength) {
      throw new Error("Invalid code");
    }
    const fetcher = env.TELEGRAM_FETCH ?? globalThis.fetch;
    const tokenPayload = await exchangeTelegramCode({
      code,
      redirectUri: telegramCallbackUri,
      clientId: env.TELEGRAM_CLIENT_ID.trim(),
      clientSecret: env.TELEGRAM_CLIENT_SECRET.trim(),
      codeVerifier: flow.code_verifier,
      fetcher,
    });
    const user = await verifyTelegramIdToken(tokenPayload.id_token, {
      clientId: env.TELEGRAM_CLIENT_ID.trim(),
      nonce: flow.nonce,
      loadJwks: () => loadTelegramJwks({ fetcher }),
    });

    const ticketCreatedAt = currentEpochSeconds();
    const ticket = createTelegramTicket();
    await env.DB
      .prepare(
        `INSERT INTO telegram_login_tickets
          (ticket_hash, user_json, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, NULL)`,
      )
      .bind(
        await hashTelegramSecret(ticket),
        JSON.stringify(publicUser(user)),
        ticketCreatedAt,
        ticketCreatedAt + telegramTicketTtlSeconds,
      )
      .run();
    return Response.redirect(telegramSuccessRedirect(platform, ticket), 302);
  } catch {
    return Response.redirect(telegramFailureRedirect(platform), 302);
  }
}

async function redeemTelegramMobileTicket(request, env, ctx) {
  try {
    if (!env.DB) {
      throw new Error("Unavailable");
    }
    const payload = await readStrictTelegramJson(request, "ticket");
    if (!telegramSecretPattern.test(payload.ticket ?? "")) {
      throw new Error("Invalid ticket");
    }
    const now = currentEpochSeconds();
    const ticket = await env.DB
      .prepare(
        `UPDATE telegram_login_tickets
        SET consumed_at = ?
        WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING user_json`,
      )
      .bind(now, await hashTelegramSecret(payload.ticket), now)
      .first();
    const user = parseTelegramTicketUser(ticket?.user_json);
    const { token } = await createSession(env.DB, user);
    scheduleTelegramCleanup(env.DB, ctx);
    return json({ token, user });
  } catch {
    return json({ error: "Telegram authentication failed" }, 401);
  }
}

async function readStrictTelegramJson(request, requiredKey, maxBytes = maxTelegramJsonBytes) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error("Invalid content type");
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Request too large");
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Request body required");
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Request too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid JSON object");
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== requiredKey) {
    throw new Error("Unexpected JSON fields");
  }
  return payload;
}

function validTelegramFlow(flow) {
  return (
    flow &&
    telegramSecretPattern.test(flow.nonce ?? "") &&
    telegramSecretPattern.test(flow.code_verifier ?? "") &&
    telegramPlatforms.has(flow.platform)
  );
}

function parseTelegramTicketUser(userJson) {
  if (typeof userJson !== "string" || userJson.length > 4096) {
    throw new Error("Invalid user");
  }
  const value = JSON.parse(userJson);
  const expectedKeys = ["id", "name", "photoUrl", "provider", "username"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expectedKeys.join(",") ||
    value.provider !== "telegram" ||
    typeof value.id !== "string" ||
    value.id.trim() === "" ||
    value.id.length > 128 ||
    typeof value.name !== "string" ||
    value.name.length > 256 ||
    typeof value.username !== "string" ||
    value.username.length > 128 ||
    typeof value.photoUrl !== "string" ||
    value.photoUrl.length > 2048
  ) {
    throw new Error("Invalid user");
  }
  return publicUser(value);
}

function telegramSuccessRedirect(platform, ticket) {
  if (platform === "web") {
    const target = new URL(telegramWebTarget);
    target.searchParams.set("auth_ticket", ticket);
    return target.toString();
  }
  return `salvo://open/auth/${ticket}`;
}

function telegramFailureRedirect(platform) {
  if (platform === "android" || platform === "ios") {
    return "salvo://open/auth/error";
  }
  const target = new URL(telegramWebTarget);
  target.searchParams.set("auth_error", "telegram");
  return target.toString();
}

function scheduleTelegramCleanup(db, ctx) {
  const cleanup = cleanupExpiredAuthRecords(db, { limit: 100 });
  const observed = cleanup.catch(() => {});
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(observed);
  }
}

function createTelegramTicket() {
  return telegramBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashTelegramSecret(value) {
  const digest = await crypto.subtle.digest("SHA-256", telegramTextEncoder.encode(value));
  return telegramBase64Url(new Uint8Array(digest));
}

function telegramBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function currentUser(request, env) {
  if (!request.headers.has("Authorization")) {
    return json({ user: null });
  }
  try {
    const { user } = await authorizeRequest(request, env);
    return json({ user: publicUser(user) });
  } catch {
    return json({ error: "Authentication failed" }, 401);
  }
}

async function logout(request, env) {
  try {
    const { token } = await authorizeRequest(request, env);
    await revokeSession(env.DB, token);
    return json({ ok: true });
  } catch (error) {
    return json({ error: authenticationErrorMessage(error) }, 401);
  }
}

async function playerProfile(request, env) {
  try {
    const { user } = await authorizeRequest(request, env);
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
    const { user } = await authorizeRequest(request, env);
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
    const { user } = await authorizeRequest(request, env);
    return json({ replay: await getAuthorizedReplay(env.DB, replayId, user) });
  } catch (error) {
    return json({ error: error.message }, replayErrorStatus(error));
  }
}

async function playerReplays(request, env, url) {
  try {
    const { user } = await authorizeRequest(request, env);
    const archive = await listPlayerReplays(env.DB, user, {
      cursor: url.searchParams.get("cursor") || undefined,
    });
    return json({ archive });
  } catch (error) {
    return json({ error: error.message }, replayErrorStatus(error));
  }
}

async function authorizeRequest(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  try {
    return { token, user: await resolveSession(env.DB, token) };
  } catch {
    throw new Error("Authentication failed");
  }
}

function authenticationErrorMessage(error) {
  return error?.message === "Authentication required" ? "Authentication required" : "Authentication failed";
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
  if (!board || typeof board !== "object" || board.size !== preset.size) {
    throw new Error("Invalid board size");
  }
  if (!Array.isArray(board.ships) || !Array.isArray(board.markers) || !Array.isArray(board.shots)) {
    throw new Error("Invalid board setup");
  }
  if (board.shots.length !== 0 || board.ships.some((ship) => !Array.isArray(ship?.hits) || ship.hits.length !== 0)) {
    throw new Error("Setup board cannot contain combat history");
  }
  if (board.ships.length !== preset.fleet.length || board.markers.length !== (preset.markers ?? []).length) {
    throw new Error("A complete legal setup is required");
  }

  let clean = createBoard(preset.size);
  for (const expectedShip of preset.fleet) {
    const matches = board.ships.filter((ship) => ship?.id === expectedShip.id);
    if (matches.length !== 1 || matches[0].length !== expectedShip.length) {
      throw new Error("A complete legal setup is required");
    }
    const placement = canonicalShipPlacement(matches[0], expectedShip.length);
    clean = placeShip(clean, expectedShip, placement.start, placement.orientation);
  }
  for (const expectedMarker of preset.markers ?? []) {
    const matches = board.markers.filter((marker) => marker?.id === expectedMarker.id);
    if (matches.length !== 1 || matches[0].type !== expectedMarker.type) {
      throw new Error("A complete legal setup is required");
    }
    clean = placeMarker(clean, expectedMarker, sanitizeCoordinate(matches[0].cell));
  }
  if (!hasCompleteSetup(clean, preset)) {
    throw new Error("A complete legal setup is required");
  }
  return clean;
}

function canonicalShipPlacement(ship, length) {
  if (!Array.isArray(ship.cells) || ship.cells.length !== length) {
    throw new Error("Ship cells are invalid");
  }
  const cells = ship.cells.map(sanitizeCoordinate);
  const start = cells[0];
  const horizontal = cells.every((cell, index) => cell.row === start.row && cell.col === start.col + index);
  const vertical = cells.every((cell, index) => cell.col === start.col && cell.row === start.row + index);
  if (!horizontal && !vertical) {
    throw new Error("Ship cells must be contiguous and canonical");
  }
  return { start, orientation: vertical && length > 1 ? "vertical" : "horizontal" };
}

function sanitizeCoordinate(coordinate) {
  if (!coordinate || !Number.isInteger(coordinate.row) || !Number.isInteger(coordinate.col)) {
    throw new Error("Invalid coordinate");
  }
  return { row: coordinate.row, col: coordinate.col };
}

function terminalRecoveryGame(game) {
  if (!game || typeof game !== "object") {
    return null;
  }
  return {
    presetId: game.presetId,
    winnerId: game.winnerId,
    players: {
      p1: terminalRecoveryPlayer(game.players?.p1, "p1"),
      p2: terminalRecoveryPlayer(game.players?.p2, "p2"),
    },
    log: Array.isArray(game.log) ? game.log.map(terminalRecoveryLogEntry) : [],
  };
}

function terminalRecoveryPlayer(player, playerId) {
  return {
    id: playerId,
    board: terminalRecoveryBoard(player?.board),
  };
}

function terminalRecoveryBoard(board) {
  return {
    size: board?.size,
    ships: Array.isArray(board?.ships)
      ? board.ships.map((ship) => ({
          id: ship?.id,
          length: ship?.length,
          cells: Array.isArray(ship?.cells) ? ship.cells.map(terminalRecoveryCoordinate) : [],
          hits: Array.isArray(ship?.hits) ? ship.hits.map(terminalRecoveryCoordinate) : [],
        }))
      : [],
    markers: Array.isArray(board?.markers)
      ? board.markers.map((marker) => ({
          id: marker?.id,
          type: marker?.type,
          cell: terminalRecoveryCoordinate(marker?.cell),
        }))
      : [],
    shots: Array.isArray(board?.shots)
      ? board.shots.map((shot) => compactDefined({
          ...terminalRecoveryCoordinate(shot),
          result: shot?.result,
          shipId: shot?.shipId,
          markerId: shot?.markerId,
        }))
      : [],
  };
}

function terminalRecoveryLogEntry(entry) {
  return compactDefined({
    playerId: entry?.playerId,
    targetPlayerId: entry?.targetPlayerId,
    coordinate: terminalRecoveryCoordinate(entry?.coordinate),
    result: entry?.result,
    shipId: entry?.shipId,
  });
}

function terminalRecoveryCoordinate(coordinate) {
  return { row: coordinate?.row, col: coordinate?.col };
}

function compactDefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeRepairedEnvelope(replayId, envelope) {
  try {
    if (!envelope || typeof envelope !== "object" || !envelope.replay || !Array.isArray(envelope.playerMatches)) {
      throw new Error();
    }
    const replayPayload = parseReplayPayload(JSON.stringify(envelope.replay.payload));
    if (
      envelope.replay.id !== replayId ||
      envelope.replay.presetId !== replayPayload.presetId ||
      envelope.replay.winnerId !== replayPayload.winnerId ||
      envelope.replay.finishedAt !== replayPayload.finishedAt ||
      envelope.playerMatches.length !== 2
    ) {
      throw new Error();
    }
    const playerMatches = ["p1", "p2"].map((playerId) => {
      const matches = envelope.playerMatches.filter((entry) => entry?.playerId === playerId);
      if (matches.length !== 1) {
        throw new Error();
      }
      const user = publicUser(matches[0].user);
      const expectedUserKey = user ? `${user.provider}:${user.id}` : "";
      const replayUserKey = playerId === "p1" ? envelope.replay.p1UserKey : envelope.replay.p2UserKey;
      if (!user?.provider || !user.id || replayUserKey !== expectedUserKey) {
        throw new Error();
      }
      return {
        playerId,
        user,
        payload: normalizeRepairedMatch(matches[0].payload, replayId, playerId, replayPayload),
      };
    });
    return {
      replay: {
        id: replayId,
        p1UserKey: envelope.replay.p1UserKey,
        p2UserKey: envelope.replay.p2UserKey,
        presetId: replayPayload.presetId,
        winnerId: replayPayload.winnerId,
        finishedAt: replayPayload.finishedAt,
        payload: replayPayload,
      },
      playerMatches,
      createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt : new Date().toISOString(),
    };
  } catch {
    throw new Error("Repaired replay envelope is invalid");
  }
}

function normalizeRepairedMatch(payload, replayId, playerId, replay) {
  const expectedResult = replay.winnerId === playerId ? "win" : "loss";
  if (
    !payload ||
    payload.id !== `online:${replayId}:${playerId}` ||
    payload.mode !== "online" ||
    payload.replayId !== replayId ||
    payload.presetId !== replay.presetId ||
    payload.winnerId !== replay.winnerId ||
    payload.playedAt !== replay.finishedAt ||
    payload.result !== expectedResult ||
    typeof payload.opponent !== "string"
  ) {
    throw new Error();
  }
  const numericFields = ["totalShots", "playerShots", "playerHits", "playerMisses", "playerSunk", "accuracy", "turns"];
  if (numericFields.some((field) => !Number.isInteger(payload[field]) || payload[field] < 0)) {
    throw new Error();
  }
  if (payload.accuracy > 100) {
    throw new Error();
  }
  return Object.fromEntries(
    [
      "id", "mode", "presetId", "result", "opponent", "totalShots", "playerShots", "playerHits",
      "playerMisses", "playerSunk", "accuracy", "turns", "winnerId", "playedAt", "replayId",
    ].map((field) => [field, payload[field]]),
  );
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

function webhookJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
