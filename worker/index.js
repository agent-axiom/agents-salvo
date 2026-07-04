import {
  cloneBoard,
  createBoard,
  createGameFromBoards,
  fireAt,
  hasCompleteSetup,
  publicBoardView,
} from "../src/core/game.js";
import { getGamePreset } from "../src/core/presets.js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

    if (route.kind === "create" && request.method === "POST") {
      return createRoom(request, env);
    }

    const id = env.BATTLE_ROOM.idFromName(route.roomCode);
    const room = env.BATTLE_ROOM.get(id);
    return room.fetch(request);
  },
};

export class BattleRoom {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = routeRequest(url);

    try {
      if (route?.kind === "create" && request.method === "POST") {
        return this.create(route.roomCode);
      }
      if (route?.kind === "join" && request.method === "POST") {
        return this.join(route.roomCode);
      }
      if (route?.kind === "socket" && request.method === "GET") {
        return this.connect(request, url);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
  }

  async create(roomCode) {
    const existing = await this.getRoom();
    if (existing) {
      return json({ error: "Room already exists" }, 409);
    }

    const room = {
      code: roomCode,
      players: {
        p1: { token: createToken(), board: null },
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

  async join(roomCode) {
    const room = await this.requireRoom();
    if (room.players.p2) {
      return json({ error: "Room is full" }, 409);
    }

    room.players.p2 = { token: createToken(), board: null };
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
        const result = fireAt(room.game, session.playerId, message.coordinate);
        room.game = result.game;
        await this.saveRoom(room);
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
      you: { board: ownRoomPlayer?.board ? cloneBoard(ownRoomPlayer.board) : createBoard(preset.size) },
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
    you: { board: ownBoard },
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

async function createRoom(request, env) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = createRoomCode();
    const id = env.BATTLE_ROOM.idFromName(roomCode);
    const room = env.BATTLE_ROOM.get(id);
    const response = await room.fetch(
      new Request(new URL(`/rooms?code=${roomCode}`, request.url), { method: "POST" }),
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
