import test from "node:test";
import assert from "node:assert/strict";

import { createBoard } from "../src/core/game.js";
import { analyzeTargetBoard } from "../src/core/tactics.js";

test("analyzeTargetBoard recommends an opening pattern on a fresh board", () => {
  const analysis = analyzeTargetBoard(createBoard());

  assert.equal(analysis.recommendationId, "openingPattern");
  assert.equal(analysis.totalCells, 100);
  assert.equal(analysis.availableTargets, 100);
  assert.equal(analysis.shotsTaken, 0);
  assert.equal(analysis.unresolvedHits, 0);
  assert.deepEqual(analysis.priorityTargets, []);
});

test("analyzeTargetBoard prioritizes legal neighbors around unresolved hits", () => {
  const board = {
    ...createBoard(),
    shots: [
      { row: 4, col: 4, result: "hit", shipId: "cruiser" },
      { row: 4, col: 3, result: "miss" },
    ],
  };

  const analysis = analyzeTargetBoard(board);

  assert.equal(analysis.recommendationId, "finishDamaged");
  assert.equal(analysis.unresolvedHits, 1);
  assert.deepEqual(analysis.priorityTargets, [
    { row: 3, col: 4 },
    { row: 4, col: 5 },
    { row: 5, col: 4 },
  ]);
});

test("analyzeTargetBoard reports salvo pressure when multiple shots remain", () => {
  const board = {
    ...createBoard(),
    shots: [
      { row: 0, col: 0, result: "miss" },
      { row: 0, col: 2, result: "miss" },
    ],
  };

  const analysis = analyzeTargetBoard(board, { salvoRemaining: 4 });

  assert.equal(analysis.recommendationId, "salvoPressure");
  assert.equal(analysis.salvoRemaining, 4);
  assert.equal(analysis.availableTargets, 98);
});

test("analyzeTargetBoard shifts to endgame when few targets remain", () => {
  const board = {
    ...createBoard(4),
    shots: Array.from({ length: 12 }, (_, index) => ({
      row: Math.floor(index / 4),
      col: index % 4,
      result: "miss",
    })),
  };

  const analysis = analyzeTargetBoard(board);

  assert.equal(analysis.recommendationId, "endgame");
  assert.equal(analysis.totalCells, 16);
  assert.equal(analysis.availableTargets, 4);
});
