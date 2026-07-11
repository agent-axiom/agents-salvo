import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { createBoard, createGameFromBoards, fireAt, placeShip, randomlyPlaceSetup } from "../src/core/game.js";
import { gamePresets } from "../src/core/presets.js";
import { createSessionToken } from "../worker/auth.js";
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

test("createPlayerSnapshot reveals sunk opponent ship ids without exposing ships", () => {
  const p1Board = placeShip(createBoard(), { id: "p1-patrol", length: 1 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(), { id: "p2-patrol", length: 1 }, { row: 5, col: 5 }, "horizontal");
  const started = createGameFromBoards(p1Board, p2Board, "p1");
  const { game } = fireAt(started, "p1", { row: 5, col: 5 });

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

  const sunkShot = snapshot.opponentShots.find(
    (shot) => shot.row === 5 && shot.col === 5 && shot.result === "sunk",
  );

  assert.deepEqual(sunkShot, { row: 5, col: 5, result: "sunk", shipId: "p2-patrol" });
  assert.equal(
    snapshot.opponentShots.every((shot) => shot.result === "sunk" || !("shipId" in shot)),
    true,
  );
  assert.equal("opponentBoard" in snapshot, false);
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

test("worker handles CORS, not found, logout, and room routing", async () => {
  const optionsResponse = await worker.fetch(new Request("https://worker.test/rooms", { method: "OPTIONS" }), {});
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.headers.get("Access-Control-Allow-Origin"), "*");

  const notFoundResponse = await worker.fetch(new Request("https://worker.test/nope"), {});
  assert.equal(notFoundResponse.status, 404);
  assert.deepEqual(await notFoundResponse.json(), { error: "Not found" });

  const logoutResponse = await worker.fetch(new Request("https://worker.test/auth/logout", { method: "POST" }), {});
  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(await logoutResponse.json(), { ok: true });

  const namespace = new FakeBattleRoomNamespace();
  const joinResponse = await worker.fetch(
    new Request("https://worker.test/rooms/ab12/join", { method: "POST" }),
    { BATTLE_ROOM: namespace },
  );
  assert.equal(joinResponse.status, 200);
  assert.equal(namespace.lastId, "AB12");
  assert.equal(namespace.requests.at(-1).url, "https://worker.test/rooms/ab12/join");
});

test("worker replay routes require auth and enforce replay statuses", async () => {
  const db = new RecordingD1();
  db.replays.push({
    id: "replay-route",
    p1_user_key: "telegram:1",
    p2_user_key: "telegram:2",
    preset_id: "classic",
    winner_id: "p1",
    finished_at: "2026-07-11T12:00:00.000Z",
    data_json: JSON.stringify(replayPayload()),
  });
  db.matches.push({
    id: "online:replay-route:p1",
    replay_id: "replay-route",
    user_key: "telegram:1",
    mode: "online",
    played_at: "2026-07-11T12:00:00.000Z",
    preset_id: "classic",
    result: "win",
    opponent: "Two",
    player_shots: 1,
    player_hits: 1,
    accuracy: 100,
  });
  const env = { DB: db, SESSION_SECRET: "session-secret" };
  const participantHeaders = await authHeaders(
    { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
    env,
  );
  const outsiderHeaders = await authHeaders(
    { provider: "telegram", id: "9", name: "Nine", username: "nine", photoUrl: "" },
    env,
  );

  assert.equal((await worker.fetch(new Request("https://worker.test/replays/replay-route"), env)).status, 401);
  const replayResponse = await worker.fetch(
    new Request("https://worker.test/replays/replay-route", { headers: participantHeaders }),
    env,
  );
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).replay.viewerPlayerId, "p1");
  assert.equal(
    (await worker.fetch(new Request("https://worker.test/replays/replay-route", { headers: outsiderHeaders }), env)).status,
    403,
  );
  assert.equal(
    (await worker.fetch(new Request("https://worker.test/replays/missing", { headers: participantHeaders }), env)).status,
    404,
  );

  const archive = await worker.fetch(
    new Request("https://worker.test/profile/replays?limit=20", { headers: participantHeaders }),
    env,
  );
  assert.equal(archive.status, 200);
  assert.equal((await archive.json()).archive.items[0].id, "replay-route");
  assert.equal(
    (await worker.fetch(new Request("https://worker.test/profile/replays?cursor=bad", { headers: participantHeaders }), env))
      .status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(new Request("https://worker.test/profile/replays", { headers: participantHeaders }), {
        SESSION_SECRET: env.SESSION_SECRET,
      })
    ).status,
    503,
  );

  db.replays[0].data_json = "corrupt";
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(
      (await worker.fetch(new Request("https://worker.test/replays/replay-route", { headers: participantHeaders }), env))
        .status,
      503,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(
    (
      await worker.fetch(new Request("https://worker.test/replays/replay-route", { headers: participantHeaders }), {
        SESSION_SECRET: env.SESSION_SECRET,
      })
    ).status,
    503,
  );
});

test("worker create room retries collisions and reports allocation failure", async () => {
  const namespace = new FakeBattleRoomNamespace({ statuses: [409, 409, 200] });

  const response = await worker.fetch(new Request("https://worker.test/rooms", { method: "POST" }), {
    BATTLE_ROOM: namespace,
  });
  assert.equal(response.status, 200);
  assert.equal(namespace.requests.length, 3);
  assert.ok(namespace.requests.every((request) => request.headers instanceof Headers));

  const failedNamespace = new FakeBattleRoomNamespace({ statuses: [409, 409, 409, 409, 409] });
  const failed = await worker.fetch(new Request("https://worker.test/rooms", { method: "POST" }), {
    BATTLE_ROOM: failedNamespace,
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "Could not allocate room code" });
});

test("worker returns auth errors for invalid Telegram login payloads", async () => {
  const response = await worker.fetch(
    new Request("https://worker.test/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "42" }),
    }),
    { TELEGRAM_BOT_TOKEN: "bot-token", SESSION_SECRET: "session-secret" },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Telegram payload is incomplete" });
});

test("BattleRoom rejects invalid room auth tokens as unauthorized responses", async () => {
  const room = new BattleRoom({ storage: new MemoryStorage() }, { SESSION_SECRET: "session-secret" });
  const response = await room.fetch(
    new Request("https://worker.test/rooms?code=BADTOK", {
      method: "POST",
      headers: { Authorization: "Bearer invalid" },
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Session token is invalid" });
});

test("BattleRoom requires Telegram sessions to create and join rooms", async () => {
  const env = { SESSION_SECRET: "session-secret" };
  const room = new BattleRoom({ storage: new MemoryStorage() }, env);

  const anonymousCreate = await room.fetch(new Request("https://worker.test/rooms?code=ROOM01", { method: "POST" }));
  assert.equal(anonymousCreate.status, 401);
  assert.deepEqual(await anonymousCreate.json(), { error: "Authentication required" });

  const p1Headers = await authHeaders(
    { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
    env,
  );
  const created = await room.fetch(
    new Request("https://worker.test/rooms?code=ROOM01", { method: "POST", headers: p1Headers }),
  );
  assert.equal(created.status, 200);

  const anonymousJoin = await room.fetch(new Request("https://worker.test/rooms/ROOM01/join", { method: "POST" }));
  assert.equal(anonymousJoin.status, 401);
  assert.deepEqual(await anonymousJoin.json(), { error: "Authentication required" });

  const p2Headers = await authHeaders(
    { provider: "telegram", id: "2", name: "Two", username: "two", photoUrl: "" },
    env,
  );
  const joined = await room.fetch(
    new Request("https://worker.test/rooms/ROOM01/join", { method: "POST", headers: p2Headers }),
  );
  assert.equal(joined.status, 200);

  const savedRoom = await room.state.storage.get("room");
  assert.equal(savedRoom.players.p1.user.id, "1");
  assert.equal(savedRoom.players.p2.user.id, "2");
});

test("BattleRoom creates, joins, and rejects duplicate or full rooms", async () => {
  const storage = new MemoryStorage();
  const env = { SESSION_SECRET: "session-secret" };
  const room = new BattleRoom({ storage }, env);
  const p1Headers = await authHeaders(
    { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
    env,
  );
  const p2Headers = await authHeaders(
    { provider: "telegram", id: "2", name: "Two", username: "two", photoUrl: "" },
    env,
  );

  const created = await room.fetch(
    new Request("https://worker.test/rooms?code=ROOM01", { method: "POST", headers: p1Headers }),
  );
  assert.equal(created.status, 200);
  const createdPayload = await created.json();
  assert.deepEqual(
    Object.keys(createdPayload).sort(),
    ["playerId", "playerToken", "roomCode"].sort(),
  );

  const duplicate = await room.fetch(
    new Request("https://worker.test/rooms?code=ROOM01", { method: "POST", headers: p1Headers }),
  );
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "Room already exists" });

  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    room.sessions.set("p1-session", {
      playerId: "p1",
      socket: {
        readyState: 1,
        send(payload) {
          sent.push(JSON.parse(payload));
        },
      },
    });
    const joined = await room.fetch(
      new Request("https://worker.test/rooms/ROOM01/join", { method: "POST", headers: p2Headers }),
    );
    assert.equal(joined.status, 200);
    assert.equal((await joined.json()).playerId, "p2");
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  assert.equal(sent.at(-1)?.type, "snapshot");
  const full = await room.fetch(
    new Request("https://worker.test/rooms/ROOM01/join", { method: "POST", headers: p2Headers }),
  );
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: "Room is full" });
});

test("BattleRoom handles fetch-level room and socket errors", async () => {
  const empty = new BattleRoom({ storage: new MemoryStorage() });
  const missingJoin = await empty.fetch(new Request("https://worker.test/rooms/MISS/join", { method: "POST" }));
  assert.equal(missingJoin.status, 400);
  assert.deepEqual(await missingJoin.json(), { error: "Room not found" });

  const options = await empty.fetch(new Request("https://worker.test/rooms/MISS/socket", { method: "OPTIONS" }));
  assert.equal(options.status, 200);

  const notFound = await empty.fetch(new Request("https://worker.test/elsewhere"));
  assert.equal(notFound.status, 404);

  const invalidCode = await empty.fetch(new Request("https://worker.test/rooms/x/join", { method: "POST" }));
  assert.equal(invalidCode.status, 400);
  assert.deepEqual(await invalidCode.json(), { error: "Invalid room code" });

  const room = new BattleRoom({
    storage: new MemoryStorage({
      room: {
        code: "SOCKET",
        players: { p1: { token: "p1-token", board: null, user: null }, p2: null },
        presetId: null,
        game: null,
      },
    }),
  });
  const noUpgrade = await room.fetch(new Request("https://worker.test/rooms/SOCKET/socket?playerId=p1&token=p1-token"));
  assert.equal(noUpgrade.status, 426);
  assert.deepEqual(await noUpgrade.json(), { error: "Expected WebSocket upgrade" });

  const badPlayer = await room.fetch(
    new Request("https://worker.test/rooms/SOCKET/socket?playerId=p2&token=p2-token", {
      headers: { Upgrade: "websocket" },
    }),
  );
  assert.equal(badPlayer.status, 400);
  assert.deepEqual(await badPlayer.json(), { error: "Unknown player" });

  const badToken = await room.fetch(
    new Request("https://worker.test/rooms/SOCKET/socket?playerId=p1&token=bad", {
      headers: { Upgrade: "websocket" },
    }),
  );
  assert.equal(badToken.status, 400);
  assert.deepEqual(await badToken.json(), { error: "Invalid player token" });
});

test("BattleRoom accepts WebSocket connections and removes closed sessions", async () => {
  const room = new BattleRoom({
    storage: new MemoryStorage({
      room: {
        code: "SOCKET",
        players: { p1: { token: "p1-token", board: null, user: null }, p2: null },
        presetId: "quick",
        game: null,
      },
    }),
  });
  const restore = installSocketGlobals();

  try {
    const response = await room.fetch(
      new Request("https://worker.test/rooms/SOCKET/socket?playerId=p1&token=p1-token", {
        headers: { Upgrade: "websocket" },
      }),
    );
    assert.equal(response.status, 101);
    assert.equal(FakeSocketPair.last.server.accepted, true);
    assert.equal(FakeSocketPair.last.server.sent.at(-1).type, "snapshot");
    assert.equal(room.sessions.size, 1);

    FakeSocketPair.last.server.dispatch("message", { data: JSON.stringify({ type: "unknown" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(FakeSocketPair.last.server.sent.at(-1).type, "error");

    FakeSocketPair.last.server.dispatch("close", {});
    assert.equal(room.sessions.size, 0);
  } finally {
    restore();
  }
});

test("BattleRoom places fleets, starts games, and reports setup message errors", async () => {
  const p1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.12);
  const p2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.72);
  const storage = new MemoryStorage({
    room: {
      code: "SETUP",
      players: {
        p1: { token: "p1-token", board: null, user: null },
        p2: { token: "p2-token", board: null, user: null },
      },
      presetId: null,
      game: null,
    },
  });
  const room = new BattleRoom({ storage });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  const originalError = console.error;
  globalThis.WebSocket = { OPEN: 1 };
  console.error = () => {};

  try {
    room.sessions.set("p1-session", { playerId: "p1", socket: recordingSocket(sent) });
    room.sessions.set("p2-session", { playerId: "p2", socket: recordingSocket(sent) });
    await room.handleMessage("missing-session", JSON.stringify({ type: "placeFleet", board: p1Board, presetId: "quick" }));
    await room.handleMessage("p1-session", JSON.stringify({ type: "placeFleet", board: p1Board, presetId: "quick" }));
    assert.equal((await storage.get("room")).game, null);

    await room.handleMessage("p2-session", JSON.stringify({ type: "placeFleet", board: p2Board, presetId: "quick" }));
  } finally {
    globalThis.WebSocket = previousWebSocket;
    console.error = originalError;
  }

  const savedRoom = await storage.get("room");
  assert.equal(savedRoom.presetId, "quick");
  assert.equal(savedRoom.game.phase, "playing");
  assert.equal(sent.some((message) => message.type === "snapshot" && message.snapshot.phase === "playing"), true);

  const errorSent = [];
  const errorRoom = new BattleRoom({
    storage: new MemoryStorage({
      room: {
        code: "ERR",
        players: { p1: { token: "p1-token", board: null, user: null }, p2: null },
        presetId: "classic",
        game: null,
      },
    }),
  });
  const previousErrorWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    errorRoom.sessions.set("session", { playerId: "p1", socket: recordingSocket(errorSent) });
    await errorRoom.handleMessage("session", JSON.stringify({ type: "placeFleet", board: p1Board, presetId: "quick" }));
    await errorRoom.handleMessage("session", "{bad-json");
    await errorRoom.handleMessage("session", JSON.stringify({ type: "fire", coordinate: { row: 0, col: 0 } }));
  } finally {
    globalThis.WebSocket = previousErrorWebSocket;
  }

  assert.equal(errorSent[0].message, "Room uses a different battle format");
  assert.match(errorSent[1].message, /Expected property name or '\}' in JSON at position 1/);
  assert.equal(errorSent[2].message, "Game has not started");
});

test("BattleRoom restarts a finished online room when both players request a rematch", async () => {
  const firstP1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.12);
  const firstP2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.72);
  const nextP1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.21);
  const nextP2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.64);
  const firstGame = createGameFromBoards(firstP1Board, firstP2Board, "p1", {
    presetId: "quick",
    rules: gamePresets.quick.rules,
  });
  const storage = new MemoryStorage({
    room: {
      code: "REMATCH",
      players: {
        p1: { token: "p1-token", board: firstP1Board, user: null },
        p2: { token: "p2-token", board: firstP2Board, user: null },
      },
      presetId: "quick",
      game: { ...firstGame, phase: "finished", winnerId: "p1" },
      finishedAt: "2026-07-09T10:00:00.000Z",
      replayId: "old-replay",
      replayRecordedAt: "2026-07-09T10:00:00.000Z",
      profileRecordedAt: "2026-07-09T10:00:00.000Z",
      profileRecordErrorAt: "2026-07-09T10:01:00.000Z",
      recordRetryCount: 3,
      ratingChanges: { p1: { delta: 24 }, p2: { delta: -16 } },
    },
  });
  const room = new BattleRoom({ storage });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };

  try {
    room.sessions.set("p1-session", { playerId: "p1", socket: recordingSocket(sent) });
    room.sessions.set("p2-session", { playerId: "p2", socket: recordingSocket(sent) });
    await room.handleMessage(
      "p1-session",
      JSON.stringify({ type: "requestRematch", board: nextP1Board, presetId: "quick" }),
    );

    const pending = await storage.get("room");
    assert.equal(pending.game.phase, "finished");
    assert.equal(pending.rematch.requests.p1.board.ships.length, gamePresets.quick.fleet.length);
    assert.deepEqual(createPlayerSnapshot(pending, "p1").rematch, {
      requestedByYou: true,
      opponentRequested: false,
      readyCount: 1,
      needed: 2,
    });
    assert.deepEqual(createPlayerSnapshot(pending, "p2").rematch, {
      requestedByYou: false,
      opponentRequested: true,
      readyCount: 1,
      needed: 2,
    });

    await room.handleMessage(
      "p2-session",
      JSON.stringify({ type: "requestRematch", board: nextP2Board, presetId: "quick" }),
    );
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  const restarted = await storage.get("room");
  assert.equal(restarted.code, "REMATCH");
  assert.equal(restarted.players.p1.token, "p1-token");
  assert.equal(restarted.players.p2.token, "p2-token");
  assert.equal(restarted.players.p1.board.ships.length, gamePresets.quick.fleet.length);
  assert.equal(restarted.players.p2.board.ships.length, gamePresets.quick.fleet.length);
  assert.equal(restarted.game.phase, "playing");
  assert.equal(restarted.game.log.length, 0);
  assert.equal(restarted.finishedAt, undefined);
  assert.equal(restarted.replayId, undefined);
  assert.equal(restarted.profileRecordedAt, undefined);
  assert.equal(restarted.profileRecordErrorAt, undefined);
  assert.equal(restarted.recordRetryCount, undefined);
  assert.equal(restarted.ratingChanges, undefined);
  assert.equal(restarted.rematch, undefined);
  assert.equal(restarted.rematchRound, 1);
  assert.equal(createPlayerSnapshot(restarted, "p1").rematchRound, 1);
  assert.equal(createPlayerSnapshot(restarted, "p1").rematch, null);
  assert.equal(sent.some((message) => message.type === "snapshot" && message.snapshot.phase === "playing"), true);
});

test("BattleRoom skips profile recording when online match data is not recordable", async () => {
  const room = new BattleRoom({ storage: new MemoryStorage() });
  await room.recordFinishedOnlineBattle({ game: null });
  await room.recordFinishedOnlineBattle({ game: { log: [] }, profileRecordedAt: "done" });
  await room.recordFinishedOnlineBattle({
    players: { p1: { user: null }, p2: null },
    game: { log: [], winnerId: "p1" },
  });
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
  assert.equal(savedRoom.replayRecordedAt, savedRoom.finishedAt);
  assert.deepEqual(savedRoom.ratingChanges.p1, {
    before: 1000,
    after: 1024,
    delta: 24,
    label: "lieutenant",
    onlineMatches: 1,
    onlineWins: 1,
    onlineLosses: 0,
    onlineWinRate: 100,
    currentOnlineWinStreak: 1,
  });
  assert.deepEqual(savedRoom.ratingChanges.p2, {
    before: 1000,
    after: 984,
    delta: -16,
    label: "cadet",
    onlineMatches: 1,
    onlineWins: 0,
    onlineLosses: 1,
    onlineWinRate: 0,
    currentOnlineWinStreak: 0,
  });
  assert.equal(createPlayerSnapshot(savedRoom, "p1").ratingChange.delta, 24);
  assert.equal(createPlayerSnapshot(savedRoom, "p2").ratingChange.delta, -16);
  assert.equal(db.matches.length, 2);
  assert.equal(db.replays.length, 1);
  assert.equal(savedRoom.replayId.length, 36);
  assert.ok(db.matches.every((match) => match.replay_id === savedRoom.replayId));
  assert.deepEqual(
    db.matches.map((match) => [match.user_key, match.result, match.player_shots, match.player_hits]),
    [
      ["telegram:1", "win", 1, 1],
      ["telegram:2", "loss", 0, 0],
    ],
  );
  assert.ok(db.matches.every((match) => match.mode === "online"));
  assert.ok(db.matches.every((match) => match.id.startsWith(`online:${savedRoom.replayId}:`)));
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
  const originalError = console.error;
  globalThis.WebSocket = { OPEN: 1 };
  console.error = () => {};

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
    console.error = originalError;
  }

  const savedRoom = await storage.get("room");
  assert.equal(savedRoom.game.phase, "finished");
  assert.equal(savedRoom.profileRecordedAt, undefined);
  const [pending] = await archiveOutboxEntries(storage);
  assert.equal(pending.attempts, 1);
  assert.equal(pending.errorMessage, "D1 unavailable");
  assert.ok(storage.alarmAt >= Date.now() + 29_000);
  assert.equal(sent.some((message) => message.type === "error"), false);
  assert.equal(sent.at(-1)?.type, "snapshot");
  assert.equal(sent.at(-1)?.snapshot.phase, "finished");

  await fireArchiveAlarm(room, storage);
  const [failedRetry] = await archiveOutboxEntries(storage);
  assert.equal(failedRetry.attempts, 2);
  assert.ok(storage.alarmAt >= Date.now() + 59_000);

  room.env.DB = new RecordingD1();
  await fireArchiveAlarm(room, storage);
  await room.alarm();
  const retriedRoom = await storage.get("room");
  assert.equal(retriedRoom.profileRecordedAt, retriedRoom.finishedAt);
  assert.equal(retriedRoom.replayRecordedAt, retriedRoom.finishedAt);
  assert.deepEqual(await archiveOutboxEntries(storage), []);
  assert.equal(room.env.DB.replays.length, 1);
  assert.equal(room.env.DB.matches.length, 2);
});

test("BattleRoom does not schedule replay retries without D1", async () => {
  const storage = new MemoryStorage({ room: finishedOnlineRoom() });
  const room = new BattleRoom({ storage });

  const originalError = console.error;
  console.error = () => {};
  try {
    await room.recordFinishedOnlineBattle(await storage.get("room"));
  } finally {
    console.error = originalError;
  }

  assert.equal(storage.alarmAt, undefined);
  assert.deepEqual(await archiveOutboxEntries(storage), []);
  const [deadLetter] = await archiveDeadLetterEntries(storage);
  assert.equal(deadLetter.classification, "configuration");
  assert.equal(deadLetter.errorMessage, "Replay storage is not configured");
  assert.ok(deadLetter.failedAt);
});

test("BattleRoom caps retries at fifteen minutes and dead-letters after twelve attempts", async () => {
  const storage = new MemoryStorage({ room: finishedOnlineRoom() });
  const room = new BattleRoom({ storage }, { DB: new FailingD1() });
  const originalNow = Date.now;
  const originalError = console.error;
  let now = 1_000_000;
  Date.now = () => now;
  console.error = () => {};
  try {
    await room.recordFinishedOnlineBattle(await storage.get("room"));
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      now = storage.alarmAt;
      await room.alarm();
    }
    assert.equal(storage.alarmAt - now, 900_000);
    for (let attempt = 7; attempt <= 12; attempt += 1) {
      now = storage.alarmAt;
      await room.alarm();
    }
  } finally {
    Date.now = originalNow;
    console.error = originalError;
  }

  assert.equal(storage.alarmAt, undefined);
  assert.deepEqual(await archiveOutboxEntries(storage), []);
  const [deadLetter] = await archiveDeadLetterEntries(storage);
  assert.equal(deadLetter.attempts, 12);
  assert.equal(deadLetter.classification, "retry_exhausted");
});

test("BattleRoom keeps archival retries independent from a ready rematch", async () => {
  const firstP1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.19);
  const firstP2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.79);
  const nextP1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.31);
  const nextP2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.67);
  const storage = new MemoryStorage({
    room: finishedOnlineRoom({ p1Board: firstP1Board, p2Board: firstP2Board, presetId: "quick" }),
  });
  const room = new BattleRoom({ storage }, { DB: new FailingD1() });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const originalError = console.error;
  console.error = () => {};
  try {
    await room.recordFinishedOnlineBattle(await storage.get("room"));
    room.sessions.set("p1-session", { playerId: "p1", socket: recordingSocket(sent) });
    room.sessions.set("p2-session", { playerId: "p2", socket: recordingSocket(sent) });
    await room.handleMessage(
      "p1-session",
      JSON.stringify({ type: "requestRematch", board: nextP1Board, presetId: "quick" }),
    );
    await room.handleMessage(
      "p2-session",
      JSON.stringify({ type: "requestRematch", board: nextP2Board, presetId: "quick" }),
    );

    const restarted = await storage.get("room");
    assert.equal(restarted.game.phase, "playing");
    assert.equal(restarted.rematchRound, 1);
    assert.equal(restarted.rematch, undefined);
    assert.equal((await archiveOutboxEntries(storage)).length, 1);
    assert.ok(storage.alarmAt);

    room.env.DB = new RecordingD1();
    await fireArchiveAlarm(room, storage);
  } finally {
    globalThis.WebSocket = previousWebSocket;
    console.error = originalError;
  }

  const restarted = await storage.get("room");
  assert.equal(restarted.game.phase, "playing");
  assert.equal(restarted.rematchRound, 1);
  assert.equal(restarted.rematch, undefined);
  assert.equal(restarted.replayRecordedAt, undefined);
  assert.deepEqual(await archiveOutboxEntries(storage), []);
  assert.equal(room.env.DB.replays.length, 1);
  assert.equal(room.env.DB.matches.length, 2);
});

test("BattleRoom archive completion never overwrites concurrent rematch state", async () => {
  const storage = new MemoryStorage({ room: finishedOnlineRoom() });
  const db = new DeferredRecordingD1();
  const room = new BattleRoom({ storage }, { DB: db });
  const initialRoom = await storage.get("room");

  const recording = room.recordFinishedOnlineBattle(initialRoom);
  await db.writeStarted;
  const concurrentRoom = {
    ...(await storage.get("room")),
    rematch: { requests: { p1: { board: initialRoom.players.p1.board, requestedAt: "later" } } },
  };
  await storage.put("room", concurrentRoom);
  db.releaseWrite();
  await recording;

  const savedRoom = await storage.get("room");
  assert.equal(savedRoom.rematch.requests.p1.requestedAt, "later");
  assert.equal(savedRoom.replayRecordedAt, savedRoom.finishedAt);
});

test("BattleRoom retries an atomic batch without partial profiles or rating drift", async () => {
  const storage = new MemoryStorage({ room: finishedOnlineRoom() });
  const db = new AtomicFailOnceD1();
  const room = new BattleRoom({ storage }, { DB: db });
  const originalError = console.error;
  console.error = () => {};
  try {
    await room.recordFinishedOnlineBattle(await storage.get("room"));
    assert.equal(db.replays.length, 0);
    assert.equal(db.matches.length, 0);
    assert.equal((await archiveOutboxEntries(storage))[0].attempts, 1);

    await fireArchiveAlarm(room, storage);
    const recordedRoom = await storage.get("room");
    const ratingChanges = structuredClone(recordedRoom.ratingChanges);
    assert.equal(db.replays.length, 1);
    assert.equal(db.matches.length, 2);
    assert.deepEqual(db.matches.map((match) => match.result).sort(), ["loss", "win"]);

    delete recordedRoom.replayRecordedAt;
    delete recordedRoom.profileRecordedAt;
    await storage.put("room", recordedRoom);
    await room.recordFinishedOnlineBattle(recordedRoom);
    assert.equal(db.replays.length, 1);
    assert.equal(db.matches.length, 2);
    assert.deepEqual((await storage.get("room")).ratingChanges, ratingChanges);
  } finally {
    console.error = originalError;
  }
});

test("BattleRoom finishing a rematch assigns a new replay id", async () => {
  const p1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.13);
  const p2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.83);
  const nextP1Board = randomlyPlaceSetup(gamePresets.quick, () => 0.27);
  const nextP2Board = randomlyPlaceSetup(gamePresets.quick, () => 0.71);
  const oldReplayId = "11111111-1111-4111-8111-111111111111";
  const oldFinishedAt = "2026-07-09T10:00:00.000Z";
  const storage = new MemoryStorage({
    room: {
      ...finishedOnlineRoom({ p1Board, p2Board, presetId: "quick" }),
      replayId: oldReplayId,
      replayRecordedAt: oldFinishedAt,
      profileRecordedAt: oldFinishedAt,
      finishedAt: oldFinishedAt,
    },
  });
  const db = new RecordingD1();
  const room = new BattleRoom({ storage }, { DB: db });
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    room.sessions.set("p1-session", { playerId: "p1", socket: recordingSocket([]) });
    room.sessions.set("p2-session", { playerId: "p2", socket: recordingSocket([]) });
    await room.handleMessage(
      "p1-session",
      JSON.stringify({ type: "requestRematch", board: nextP1Board, presetId: "quick" }),
    );
    await room.handleMessage(
      "p2-session",
      JSON.stringify({ type: "requestRematch", board: nextP2Board, presetId: "quick" }),
    );
    for (const ship of nextP2Board.ships) {
      for (const coordinate of ship.cells) {
        await room.handleMessage("p1-session", JSON.stringify({ type: "fire", coordinate }));
      }
    }
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  const finished = await storage.get("room");
  assert.equal(finished.game.phase, "finished");
  assert.notEqual(finished.replayId, oldReplayId);
  assert.equal(finished.replayRecordedAt, finished.finishedAt);
  assert.equal(db.replays.length, 1);
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

async function authHeaders(user, env) {
  return { Authorization: `Bearer ${await createSessionToken(user, env.SESSION_SECRET)}` };
}

async function fireArchiveAlarm(room, storage) {
  const originalNow = Date.now;
  Date.now = () => storage.alarmAt ?? originalNow();
  try {
    await room.alarm();
  } finally {
    Date.now = originalNow;
  }
}

function finishedOnlineRoom({ p1Board, p2Board, presetId = "classic" } = {}) {
  const firstBoard =
    p1Board ?? placeShip(createBoard(2), { id: "p1-patrol", length: 1 }, { row: 0, col: 0 }, "horizontal");
  const secondBoard =
    p2Board ?? placeShip(createBoard(2), { id: "p2-patrol", length: 1 }, { row: 1, col: 1 }, "horizontal");
  const game = createGameFromBoards(firstBoard, secondBoard, "p1", { presetId });
  return {
    code: "RETRY1",
    players: {
      p1: {
        token: "p1-token",
        board: firstBoard,
        user: { provider: "telegram", id: "1", name: "One", username: "one", photoUrl: "" },
      },
      p2: {
        token: "p2-token",
        board: secondBoard,
        user: { provider: "telegram", id: "2", name: "Two", username: "two", photoUrl: "" },
      },
    },
    presetId,
    game: { ...game, phase: "finished", winnerId: "p1" },
    replayId: "22222222-2222-4222-8222-222222222222",
    finishedAt: "2026-07-11T12:00:00.000Z",
  };
}

async function archiveOutboxEntries(storage) {
  return [...(await storage.list({ prefix: "replayArchiveOutbox:" })).values()];
}

async function archiveDeadLetterEntries(storage) {
  return [...(await storage.list({ prefix: "replayArchiveDeadLetter:" })).values()];
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

  async delete(key) {
    this.values.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }

  async transaction(callback) {
    return callback(this);
  }

  async setAlarm(alarmAt) {
    this.alarmAt = alarmAt;
  }

  async deleteAlarm() {
    this.alarmAt = undefined;
  }
}

class FakeBattleRoomNamespace {
  constructor({ statuses = [200] } = {}) {
    this.statuses = [...statuses];
    this.requests = [];
    this.lastId = "";
  }

  idFromName(name) {
    this.lastId = name;
    return name;
  }

  get() {
    return {
      fetch: async (request) => {
        this.requests.push(request);
        const status = this.statuses.shift() ?? 200;
        return new Response(JSON.stringify({ ok: status < 400 }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
  }
}

function recordingSocket(sent) {
  return {
    readyState: 1,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

function installSocketGlobals() {
  const previousWebSocket = globalThis.WebSocket;
  const previousWebSocketPair = globalThis.WebSocketPair;
  const previousResponse = globalThis.Response;
  globalThis.WebSocket = { OPEN: 1 };
  globalThis.WebSocketPair = FakeSocketPair;
  globalThis.Response = FakeUpgradeResponse;
  return () => {
    globalThis.WebSocket = previousWebSocket;
    globalThis.WebSocketPair = previousWebSocketPair;
    globalThis.Response = previousResponse;
  };
}

class FakeSocketPair {
  constructor() {
    FakeSocketPair.last = {
      client: new FakeSocket(),
      server: new FakeSocket(),
    };
    return FakeSocketPair.last;
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.listeners = new Map();
    this.accepted = false;
  }

  accept() {
    this.accepted = true;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  dispatch(type, event) {
    this.listeners.get(type)?.(event);
  }
}

class FakeUpgradeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket;
  }
}

class RecordingD1 {
  constructor() {
    this.users = [];
    this.matches = [];
    this.replays = [];
  }

  prepare(sql) {
    return new RecordingStatement(this, sql);
  }

  async batch(statements) {
    const snapshot = {
      users: structuredClone(this.users),
      matches: structuredClone(this.matches),
      replays: structuredClone(this.replays),
    };
    this.batchCalls = (this.batchCalls ?? 0) + 1;
    try {
      const results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failBatchAt === index) {
          this.failBatchAt = undefined;
          throw new Error("D1 batch failed");
        }
        results.push(await statements[index].run());
      }
      return results;
    } catch (error) {
      this.users = snapshot.users;
      this.matches = snapshot.matches;
      this.replays = snapshot.replays;
      throw error;
    }
  }
}

class DeferredRecordingD1 extends RecordingD1 {
  constructor() {
    super();
    this.writeStarted = new Promise((resolve) => {
      this.markWriteStarted = resolve;
    });
    this.writeRelease = new Promise((resolve) => {
      this.releaseWrite = resolve;
    });
  }

  async waitForWrite() {
    if (this.didWait) {
      return;
    }
    this.didWait = true;
    this.markWriteStarted();
    await this.writeRelease;
  }

  async batch(statements) {
    await this.waitForWrite();
    return super.batch(statements);
  }
}

class AtomicFailOnceD1 extends RecordingD1 {
  constructor() {
    super();
    this.failBatchAt = 4;
  }
}

class FailingD1 {
  prepare() {
    return { bind() { return this; }, run() { throw new Error("D1 unavailable"); } };
  }

  async batch() {
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
        replayId,
      ] = this.params;
      if (this.db.matches.some((match) => match.id === id && match.user_key === userKey)) {
        return { success: true };
      }
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
        replay_id: replayId,
      });
      return { success: true };
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO battle_replays")) {
      await this.db.waitForWrite?.();
      const [id, p1UserKey, p2UserKey, presetId, winnerId, finishedAt, dataJson] = this.params;
      if (!this.db.replays.some((replay) => replay.id === id)) {
        this.db.replays.push({
          id,
          p1_user_key: p1UserKey,
          p2_user_key: p2UserKey,
          preset_id: presetId,
          winner_id: winnerId,
          finished_at: finishedAt,
          data_json: dataJson,
        });
      }
      return { success: true };
    }
    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes("FROM matches m JOIN battle_replays r ON r.id = m.replay_id")) {
      const [userKey, p1UserKey, p2UserKey, cursorFinishedAt, , , cursorId, limit] = this.params;
      let rows = this.db.matches
        .filter((match) => match.user_key === userKey && match.mode === "online" && match.replay_id)
        .map((match) => ({
          ...this.db.replays.find((replay) => replay.id === match.replay_id),
          ...match,
          finished_at: match.played_at,
        }))
        .filter((row) => row.p1_user_key === p1UserKey || row.p2_user_key === p2UserKey);
      if (cursorFinishedAt) {
        rows = rows.filter(
          (row) =>
            row.finished_at < cursorFinishedAt ||
            (row.finished_at === cursorFinishedAt && row.replay_id < cursorId),
        );
      }
      rows.sort(
        (first, second) =>
          second.finished_at.localeCompare(first.finished_at) || second.replay_id.localeCompare(first.replay_id),
      );
      return { success: true, results: rows.slice(0, limit) };
    }
    if (this.sql.startsWith("SELECT result, played_at")) {
      const [userKey] = this.params;
      return {
        success: true,
        results: this.db.matches
          .filter((match) => match.user_key === userKey && match.mode === "online")
          .sort((first, second) => first.played_at.localeCompare(second.played_at))
          .map((match) => ({ result: match.result, played_at: match.played_at })),
      };
    }
    if (this.sql.startsWith("SELECT id, result, played_at")) {
      const [userKey] = this.params;
      return {
        success: true,
        results: this.db.matches
          .filter((match) => match.user_key === userKey && match.mode === "online")
          .sort(
            (first, second) =>
              first.played_at.localeCompare(second.played_at) || first.id.localeCompare(second.id),
          )
          .map((match) => ({ id: match.id, result: match.result, played_at: match.played_at })),
      };
    }
    throw new Error(`Unsupported all SQL: ${this.sql}`);
  }

  async first() {
    if (this.sql.includes("FROM battle_replays") && this.sql.includes("WHERE id = ?")) {
      return this.db.replays.find((replay) => replay.id === this.params[0]) ?? null;
    }
    throw new Error(`Unsupported first SQL: ${this.sql}`);
  }
}

function replayPayload() {
  return {
    version: 1,
    presetId: "classic",
    winnerId: "p1",
    finishedAt: "2026-07-11T12:00:00.000Z",
    players: {
      p1: { name: "One", username: "one" },
      p2: { name: "Two", username: "two" },
    },
    boards: {
      p1: { size: 2, ships: [], markers: [], shots: [] },
      p2: { size: 2, ships: [], markers: [], shots: [] },
    },
    log: [],
  };
}
