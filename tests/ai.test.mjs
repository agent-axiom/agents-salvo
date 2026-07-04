import test from "node:test";
import assert from "node:assert/strict";

import { chooseAgentShot } from "../src/core/ai.js";

test("easy agent chooses an unknown cell", () => {
  const view = [
    { row: 0, col: 0, result: "miss" },
    { row: 0, col: 1, result: "hit" },
    { row: 0, col: 2, result: "miss" },
  ];

  const shot = chooseAgentShot({ size: 3, shots: view, difficulty: "easy", rng: () => 0 });

  assert.deepEqual(shot, { row: 1, col: 0 });
});

test("normal agent targets an unknown neighbor after a hit", () => {
  const shot = chooseAgentShot({
    size: 5,
    shots: [{ row: 2, col: 2, result: "hit" }],
    difficulty: "normal",
    rng: () => 0,
  });

  assert.deepEqual(shot, { row: 1, col: 2 });
});

test("normal agent follows a known hit line", () => {
  const shot = chooseAgentShot({
    size: 5,
    shots: [
      { row: 2, col: 2, result: "hit" },
      { row: 2, col: 3, result: "hit" },
    ],
    difficulty: "normal",
    rng: () => 0,
  });

  assert.deepEqual(shot, { row: 2, col: 1 });
});
