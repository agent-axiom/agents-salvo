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
