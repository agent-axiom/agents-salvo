import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { createBoard, createGameFromBoards, placeShip } from "../src/core/game.js";
import worker, { BattleRoom, createPlayerSnapshot } from "../worker/index.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const textEncoder = new TextEncoder();

test("createPlayerSnapshot hides opponent ships", () => {
  const p1Board = placeShip(createBoard(), { id: "p1-patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(), { id: "p2-patrol", length: 2 }, { row: 5, col: 5 }, "horizontal");
  const game = createGameFromBoards(p1Board, p2Board, "p1");

  const snapshot = createPlayerSnapshot(
    {
      code: "ABC123",
      players: {
        p1: { board: p1Board },
        p2: { board: p2Board },
      },
      game,
    },
    "p1",
  );

  assert.equal(snapshot.you.board.ships.length, 1);
  assert.deepEqual(snapshot.opponentShots, []);
  assert.equal("opponentBoard" in snapshot, false);
});

test("createPlayerSnapshot exposes preset rules and salvo state", () => {
  let p1Board = createBoard(8);
  p1Board = placeShip(p1Board, { id: "p1-patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  p1Board = placeShip(p1Board, { id: "p1-scout", length: 1 }, { row: 3, col: 3 }, "horizontal");
  const p2Board = placeShip(createBoard(8), { id: "p2-patrol", length: 2 }, { row: 5, col: 5 }, "horizontal");
  const game = createGameFromBoards(p1Board, p2Board, "p1", {
    presetId: "quick",
    rules: { salvo: true },
  });

  const snapshot = createPlayerSnapshot(
    {
      code: "ABC123",
      presetId: "quick",
      players: {
        p1: { board: p1Board },
        p2: { board: p2Board },
      },
      game,
    },
    "p1",
  );

  assert.equal(snapshot.presetId, "quick");
  assert.equal(snapshot.rules.salvo, true);
  assert.equal(snapshot.salvoRemaining, 2);
  assert.equal(snapshot.size, 8);
});

test("createPlayerSnapshot uses room preset before game start", () => {
  const snapshot = createPlayerSnapshot(
    {
      code: "ABC123",
      presetId: "perelman",
      players: {
        p1: { board: null },
        p2: null,
      },
      game: null,
    },
    "p1",
  );

  assert.equal(snapshot.presetId, "perelman");
  assert.equal(snapshot.size, 16);
  assert.equal(snapshot.you.board.size, 16);
});

test("worker authenticates Telegram login payloads and returns the current user", async () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "123456:secret-token",
    SESSION_SECRET: "session-secret",
  };
  const payload = {
    id: "42",
    first_name: "Ivan",
    username: "ivan",
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  payload.hash = await signTelegramPayload(payload, env.TELEGRAM_BOT_TOKEN);

  const loginResponse = await worker.fetch(
    new Request("https://worker.test/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env,
  );
  assert.equal(loginResponse.status, 200);
  const loginPayload = await loginResponse.json();
  assert.equal(loginPayload.user.id, "42");
  assert.equal(loginPayload.user.name, "Ivan");
  assert.ok(loginPayload.token);

  const meResponse = await worker.fetch(
    new Request("https://worker.test/auth/me", {
      headers: { Authorization: `Bearer ${loginPayload.token}` },
    }),
    env,
  );
  assert.equal(meResponse.status, 200);
  assert.deepEqual(await meResponse.json(), { user: loginPayload.user });
});

test("worker returns anonymous auth state without a session token", async () => {
  const response = await worker.fetch(new Request("https://worker.test/auth/me"), {
    SESSION_SECRET: "session-secret",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("BattleRoom records completed authenticated online matches in profile storage", async () => {
  const p1Board = placeShip(createBoard(2), { id: "p1-patrol", length: 1 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(2), { id: "p2-patrol", length: 1 }, { row: 1, col: 1 }, "horizontal");
  const game = createGameFromBoards(p1Board, p2Board, "p1", { presetId: "classic" });
  const storage = new MemoryStorage({
    room: {
      code: "AUTH01",
      players: {
        p1: {
          token: "p1-token",
          board: p1Board,
          user: { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
        },
        p2: {
          token: "p2-token",
          board: p2Board,
          user: { provider: "telegram", id: "2", name: "Two", username: "two", photoUrl: "" },
        },
      },
      presetId: "classic",
      game,
    },
  });
  const db = new RecordingD1();
  const room = new BattleRoom({ storage }, { DB: db });
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };

  try {
    room.sessions.set("session-1", {
      playerId: "p1",
      socket: { readyState: 0, send() {} },
    });
    await room.handleMessage("session-1", JSON.stringify({ type: "fire", coordinate: { row: 1, col: 1 } }));
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  const savedRoom = await storage.get("room");
  assert.equal(savedRoom.game.phase, "finished");
  assert.equal(savedRoom.profileRecordedAt, savedRoom.finishedAt);
  assert.equal(db.matches.length, 2);
  assert.deepEqual(
    db.matches.map((match) => [match.user_key, match.result, match.player_shots, match.player_hits]),
    [
      ["telegram:1", "win", 1, 1],
      ["telegram:2", "loss", 0, 0],
    ],
  );
  assert.ok(db.matches.every((match) => match.mode === "online"));
  assert.ok(db.matches.every((match) => match.id.startsWith("online:AUTH01:")));
});

test("BattleRoom still broadcasts finished games when profile storage fails", async () => {
  const p1Board = placeShip(createBoard(2), { id: "p1-patrol", length: 1 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(2), { id: "p2-patrol", length: 1 }, { row: 1, col: 1 }, "horizontal");
  const game = createGameFromBoards(p1Board, p2Board, "p1", { presetId: "classic" });
  const storage = new MemoryStorage({
    room: {
      code: "AUTH02",
      players: {
        p1: {
          token: "p1-token",
          board: p1Board,
          user: { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
        },
        p2: {
          token: "p2-token",
          board: p2Board,
          user: { provider: "telegram", id: "2", name: "Two", username: "two", photoUrl: "" },
        },
      },
      presetId: "classic",
      game,
    },
  });
  const room = new BattleRoom({ storage }, { DB: new FailingD1() });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };

  try {
    room.sessions.set("session-1", {
      playerId: "p1",
      socket: {
        readyState: 1,
        send(payload) {
          sent.push(JSON.parse(payload));
        },
      },
    });
    await room.handleMessage("session-1", JSON.stringify({ type: "fire", coordinate: { row: 1, col: 1 } }));
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  const savedRoom = await storage.get("room");
  assert.equal(savedRoom.game.phase, "finished");
  assert.equal(savedRoom.profileRecordedAt, undefined);
  assert.equal(sent.some((message) => message.type === "error"), false);
  assert.equal(sent.at(-1)?.type, "snapshot");
  assert.equal(sent.at(-1)?.snapshot.phase, "finished");
});

async function signTelegramPayload(payload, botToken) {
  const dataCheckString = Object.entries(payload)
    .filter(([key]) => key !== "hash")
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await cryptoApi.subtle.digest("SHA-256", textEncoder.encode(botToken));
  const key = await cryptoApi.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoApi.subtle.sign("HMAC", key, textEncoder.encode(dataCheckString));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

class RecordingD1 {
  constructor() {
    this.users = [];
    this.matches = [];
  }

  prepare(sql) {
    return new RecordingStatement(this, sql);
  }
}

class FailingD1 {
  prepare() {
    throw new Error("D1 unavailable");
  }
}

class RecordingStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    const statement = new RecordingStatement(this.db, this.sql);
    statement.params = params;
    return statement;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO users")) {
      const [userKey, provider, providerId, name, username, photoUrl] = this.params;
      this.db.users.push({ user_key: userKey, provider, provider_id: providerId, name, username, photo_url: photoUrl });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO matches")) {
      const [
        id,
        userKey,
        mode,
        presetId,
        result,
        opponent,
        totalShots,
        playerShots,
        playerHits,
        playerMisses,
        playerSunk,
        accuracy,
        turns,
        winnerId,
        playedAt,
      ] = this.params;
      this.db.matches.push({
        id,
        user_key: userKey,
        mode,
        preset_id: presetId,
        result,
        opponent,
        total_shots: totalShots,
        player_shots: playerShots,
        player_hits: playerHits,
        player_misses: playerMisses,
        player_sunk: playerSunk,
        accuracy,
        turns,
        winner_id: winnerId,
        played_at: playedAt,
      });
      return { success: true };
    }
    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }
}
