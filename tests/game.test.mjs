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
  placeMarker,
  randomlyPlaceFleet,
  randomlyPlaceSetup,
  receiveShot,
  removeMarker,
  removeShip,
  hasCompleteSetup,
} from "../src/core/game.js";
import { gamePresets } from "../src/core/presets.js";

test("createBoard creates a 10 by 10 empty board", () => {
  const board = createBoard();

  assert.equal(board.size, 10);
  assert.equal(board.ships.length, 0);
  assert.equal(board.markers.length, 0);
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

test("removeShip removes one placed ship and keeps the rest of the board", () => {
  let board = createBoard();
  board = placeShip(board, { id: "battleship", length: 4 }, { row: 0, col: 0 }, "horizontal");
  board = placeShip(board, { id: "patrol", length: 1 }, { row: 3, col: 3 }, "horizontal");

  const updated = removeShip(board, "battleship");

  assert.equal(getCell(updated, { row: 0, col: 0 }).shipId, null);
  assert.equal(getCell(updated, { row: 3, col: 3 }).shipId, "patrol");
  assert.equal(board.ships.length, 2);
  assert.equal(updated.ships.length, 1);
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

test("randomlyPlaceSetup supports quick and extended presets", () => {
  const quick = randomlyPlaceSetup(gamePresets.quick, () => 0.33);
  assert.equal(quick.size, 8);
  assert.equal(quick.ships.length, gamePresets.quick.fleet.length);
  assert.equal(hasCompleteSetup(quick, gamePresets.quick), true);

  const extended = randomlyPlaceSetup(gamePresets.perelman, () => 0.48);
  assert.equal(extended.size, 16);
  assert.equal(extended.ships.length, gamePresets.perelman.fleet.length);
  assert.equal(extended.markers.length, gamePresets.perelman.markers.length);
  assert.equal(hasCompleteSetup(extended, gamePresets.perelman), true);
});

test("placeMarker places and removes mines and sweepers without touching ships", () => {
  let board = createBoard(8);
  board = placeShip(board, { id: "patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  board = placeMarker(board, { id: "mine-1", type: "mine" }, { row: 3, col: 3 });

  assert.equal(getCell(board, { row: 3, col: 3 }).markerType, "mine");
  assert.throws(
    () => placeMarker(board, { id: "sweeper-1", type: "sweeper" }, { row: 1, col: 1 }),
    /touch/i,
  );

  const updated = removeMarker(board, "mine-1");
  assert.equal(getCell(updated, { row: 3, col: 3 }).markerType, null);
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

test("receiveShot records mines and sweepers as special water outcomes", () => {
  let board = createBoard(8);
  board = placeMarker(board, { id: "mine-1", type: "mine" }, { row: 2, col: 2 });
  board = placeMarker(board, { id: "sweeper-1", type: "sweeper" }, { row: 5, col: 5 });

  let result = receiveShot(board, { row: 2, col: 2 });
  assert.equal(result.outcome.type, "mine");
  assert.equal(getCell(result.board, { row: 2, col: 2 }).shot, "mine");

  result = receiveShot(result.board, { row: 5, col: 5 });
  assert.equal(result.outcome.type, "sweeper");
  assert.equal(getCell(result.board, { row: 5, col: 5 }).shot, "sweeper");
});

test("receiveShot marks the sunk ship and surrounding cells as known water", () => {
  let board = createBoard();
  board = placeShip(board, { id: "patrol", length: 2 }, { row: 4, col: 4 }, "horizontal");

  let result = receiveShot(board, { row: 4, col: 4 });
  assert.equal(result.outcome.type, "hit");

  result = receiveShot(result.board, { row: 4, col: 5 });
  assert.equal(result.outcome.type, "sunk");
  assert.equal(getCell(result.board, { row: 4, col: 4 }).shot, "sunk");
  assert.equal(getCell(result.board, { row: 4, col: 5 }).shot, "sunk");

  for (let row = 3; row <= 5; row += 1) {
    for (let col = 3; col <= 6; col += 1) {
      if (row === 4 && (col === 4 || col === 5)) {
        continue;
      }
      assert.equal(getCell(result.board, { row, col }).shot, "miss");
    }
  }

  assert.throws(() => receiveShot(result.board, { row: 3, col: 3 }), /already/i);
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

test("fireAt in salvo mode spends one shot per living ship before switching turns", () => {
  let p1Board = createBoard(8);
  p1Board = placeShip(p1Board, { id: "p1-patrol", length: 2 }, { row: 0, col: 0 }, "horizontal");
  p1Board = placeShip(p1Board, { id: "p1-scout", length: 1 }, { row: 3, col: 3 }, "horizontal");
  const p2Board = placeShip(createBoard(8), { id: "p2-patrol", length: 2 }, { row: 2, col: 2 }, "horizontal");
  let game = createGameFromBoards(p1Board, p2Board, "p1", { rules: { salvo: true } });

  assert.equal(game.salvoRemaining, 2);
  let result = fireAt(game, "p1", { row: 7, col: 7 });
  assert.equal(result.outcome.type, "miss");
  assert.equal(result.game.currentPlayerId, "p1");
  assert.equal(result.game.salvoRemaining, 1);

  result = fireAt(result.game, "p1", { row: 7, col: 6 });
  assert.equal(result.outcome.type, "miss");
  assert.equal(result.game.currentPlayerId, "p2");
  assert.equal(result.game.salvoRemaining, 1);
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
