import test from "node:test";
import assert from "node:assert/strict";

import {
  allShipsSunk,
  createBoard,
  createGameFromBoards,
  defaultFleet,
  fireAt,
  getCell,
  placeShip,
  randomlyPlaceFleet,
  receiveShot,
} from "../src/core/game.js";

test("createBoard creates a 10 by 10 empty board", () => {
  const board = createBoard();

  assert.equal(board.size, 10);
  assert.equal(board.ships.length, 0);
  assert.equal(board.shots.length, 0);
  assert.equal(getCell(board, { row: 0, col: 0 }).shipId, null);
  assert.equal(getCell(board, { row: 9, col: 9 }).shot, null);
});

test("defaultFleet uses authentic Russian Battleship ship lengths", () => {
  assert.deepEqual(
    defaultFleet().map((ship) => ship.length),
    [4, 3, 3, 2, 2, 2, 1, 1, 1, 1],
  );
});

test("placeShip places horizontal and vertical ships", () => {
  let board = createBoard();
  board = placeShip(board, { id: "carrier", length: 5 }, { row: 0, col: 0 }, "horizontal");
  board = placeShip(board, { id: "destroyer", length: 2 }, { row: 2, col: 4 }, "vertical");

  assert.equal(getCell(board, { row: 0, col: 4 }).shipId, "carrier");
  assert.equal(getCell(board, { row: 3, col: 4 }).shipId, "destroyer");
  assert.equal(board.ships.length, 2);
});

test("placeShip rejects out of bounds and overlapping ships", () => {
  let board = createBoard();
  board = placeShip(board, { id: "carrier", length: 5 }, { row: 0, col: 0 }, "horizontal");

  assert.throws(
    () => placeShip(board, { id: "battleship", length: 4 }, { row: 0, col: 3 }, "horizontal"),
    /overlap/i,
  );
  assert.throws(
    () => placeShip(board, { id: "submarine", length: 3 }, { row: 9, col: 8 }, "horizontal"),
    /bounds/i,
  );
});

test("placeShip rejects ships touching by side or corner", () => {
  let board = createBoard();
  board = placeShip(board, { id: "battleship", length: 4 }, { row: 0, col: 0 }, "horizontal");

  assert.throws(
    () => placeShip(board, { id: "side-touch", length: 1 }, { row: 1, col: 1 }, "horizontal"),
    /touch/i,
  );
  assert.throws(
    () => placeShip(board, { id: "corner-touch", length: 1 }, { row: 1, col: 4 }, "horizontal"),
    /touch/i,
  );
});

test("randomlyPlaceFleet places every default ship without overlap or touching", () => {
  const board = randomlyPlaceFleet(defaultFleet(), 10, () => 0.42);
  const occupied = new Set();

  assert.equal(board.ships.length, 10);
  for (const ship of board.ships) {
    assert.equal(ship.cells.length, ship.length);
    for (const cell of ship.cells) {
      assert.ok(cell.row >= 0 && cell.row < 10);
      assert.ok(cell.col >= 0 && cell.col < 10);
      const key = `${cell.row}:${cell.col}`;
      assert.equal(occupied.has(key), false);
      occupied.add(key);
    }
  }

  for (const firstShip of board.ships) {
    for (const secondShip of board.ships) {
      if (firstShip.id >= secondShip.id) {
        continue;
      }
      for (const firstCell of firstShip.cells) {
        for (const secondCell of secondShip.cells) {
          assert.equal(cellsTouch(firstCell, secondCell), false);
        }
      }
    }
  }
});

test("receiveShot records misses, hits, sunk ships, and rejects repeated shots", () => {
  let board = createBoard();
  board = placeShip(board, { id: "patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");

  let result = receiveShot(board, { row: 4, col: 4 });
  assert.equal(result.outcome.type, "miss");
  assert.equal(getCell(result.board, { row: 4, col: 4 }).shot, "miss");

  result = receiveShot(result.board, { row: 0, col: 0 });
  assert.equal(result.outcome.type, "hit");
  assert.equal(result.outcome.shipId, "patrol");

  result = receiveShot(result.board, { row: 0, col: 1 });
  assert.equal(result.outcome.type, "sunk");
  assert.equal(result.outcome.shipId, "patrol");
  assert.equal(allShipsSunk(result.board), true);

  assert.throws(() => receiveShot(result.board, { row: 0, col: 1 }), /already/i);
});

test("fireAt switches turns after misses and keeps turn after hits", () => {
  const p1Board = placeShip(createBoard(), { id: "p1-patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(), { id: "p2-patrol", length: 2 }, { row: 1, col: 1 }, "horizontal");
  let game = createGameFromBoards(p1Board, p2Board, "p1");

  let result = fireAt(game, "p1", { row: 9, col: 9 });
  assert.equal(result.outcome.type, "miss");
  assert.equal(result.game.currentPlayerId, "p2");

  result = fireAt(result.game, "p2", { row: 0, col: 0 });
  assert.equal(result.outcome.type, "hit");
  assert.equal(result.game.currentPlayerId, "p2");
});

test("fireAt finishes the game when the last ship is sunk", () => {
  const p1Board = placeShip(createBoard(), { id: "p1-patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  const p2Board = placeShip(createBoard(), { id: "p2-patrol", length: 2 }, { row: 1, col: 1 }, "horizontal");
  let game = createGameFromBoards(p1Board, p2Board, "p1");

  game = fireAt(game, "p1", { row: 1, col: 1 }).game;
  const result = fireAt(game, "p1", { row: 1, col: 2 });

  assert.equal(result.outcome.type, "sunk");
  assert.equal(result.game.phase, "finished");
  assert.equal(result.game.winnerId, "p1");
});

function cellsTouch(a, b) {
  return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
}
