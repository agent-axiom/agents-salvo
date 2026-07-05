import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { createBoard, createGameFromBoards, placeShip } from "../src/core/game.js";
import worker, { createPlayerSnapshot } from "../worker/index.js";

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
