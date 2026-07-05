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
import { getPlayerProfile, recordCompletedMatch } from "./profile.js";

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
    const route = routeRequest(url);
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
    const route = routeRequest(url);

    try {
      if (route?.kind === "create" && request.method === "POST") {
        return this.create(request, route.roomCode);
      }
      if (route?.kind === "join" && request.method === "POST") {
        return this.join(request, route.roomCode);
      }
      if (route?.kind === "socket" && request.method === "GET") {
        return this.connect(request, url);
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
    const user = await optionalUser(request, this.env);

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

    room.players.p2 = { token: createToken(), board: null, user: await optionalUser(request, this.env) };
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
        }
        await this.saveRoom(room);
        if (finishedNow) {
          try {
            await this.recordFinishedOnlineBattle(room);
          } catch {
            room.profileRecordErrorAt = new Date().toISOString();
            await this.saveRoom(room);
          }
        }
        await this.broadcast(room);
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
    if (!this.env?.DB || !room.game || room.profileRecordedAt) {
      return;
    }

    const players = Object.entries(room.players).filter(([, player]) => player?.user);
    if (players.length === 0) {
      return;
    }

    await Promise.all(
      players.map(([playerId, player]) =>
        recordCompletedMatch(this.env.DB, player.user, onlineMatchPayload(room, playerId), {
          source: "server",
        }),
      ),
    );
    room.profileRecordedAt = room.finishedAt;
    await this.saveRoom(room);
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
    opponentShots: opponentView.shots.map(({ row, col, result }) => ({ row, col, result })),
    log: room.game.log.map(({ playerId: shooterId, targetPlayerId, coordinate, result }) => ({
      playerId: shooterId,
      targetPlayerId,
      coordinate,
      result,
    })),
  };
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
    return json({ user: publicUser(user), profile: await getPlayerProfile(env.DB, user) });
  } catch (error) {
    return json({ error: error.message }, authErrorStatus(error));
  }
}

async function saveProfileMatch(request, env) {
  try {
    const user = await requireUser(request, env);
    const match = await recordCompletedMatch(env.DB, user, await request.json(), { source: "client" });
    return json(
      {
        match,
        profile: await getPlayerProfile(env.DB, user),
      },
      201,
    );
  } catch (error) {
    return json({ error: error.message }, authErrorStatus(error));
  }
}

async function requireUser(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    throw new Error("Authentication required");
  }
  return verifySessionToken(token, env.SESSION_SECRET);
}

async function optionalUser(request, env) {
  const token = parseBearerToken(request);
  if (!token) {
    return null;
  }
  return publicUser(await verifySessionToken(token, env.SESSION_SECRET));
}

function authErrorStatus(error) {
  const message = error.message.toLowerCase();
  return message.includes("authentication") || message.includes("session") ? 401 : 400;
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
    id: `online:${room.code}:${playerId}:${game.winnerId}:${game.log.length}`,
    mode: "online",
    presetId: game.presetId,
    result: game.winnerId === playerId ? "win" : "loss",
    opponent: opponent?.name || opponent?.username || (opponent ? `${opponent.provider}:${opponent.id}` : "online"),
    totalShots: summary.totalShots,
    playerShots: playerStats.shots,
    playerHits: playerStats.hits,
    playerMisses: playerStats.misses,
    playerSunk: playerStats.sunk,
    accuracy: playerStats.accuracy,
    turns: game.log.length,
    winnerId: game.winnerId,
    playedAt: room.finishedAt,
  };
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
