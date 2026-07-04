import test from "node:test";
import assert from "node:assert/strict";

import { createBoard, createGameFromBoards, placeShip } from "../src/core/game.js";
import { createPlayerSnapshot } from "../worker/index.js";

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
