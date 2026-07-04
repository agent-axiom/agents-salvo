import test from "node:test";
import assert from "node:assert/strict";

import { summarizeBattleLog } from "../src/core/stats.js";

test("summarizeBattleLog counts winner shots, hits, misses, sunk ships, and accuracy", () => {
  const summary = summarizeBattleLog(
    [
      { playerId: "p1", result: "miss" },
      { playerId: "p2", result: "hit" },
      { playerId: "p1", result: "hit" },
      { playerId: "p1", result: "sunk" },
      { playerId: "p2", result: "miss" },
      { playerId: "p1", result: "sunk" },
      { playerId: "p1", result: "mine" },
      { playerId: "p2", result: "sweeper" },
    ],
    "p1",
  );

  assert.equal(summary.totalShots, 8);
  assert.deepEqual(summary.winner, {
    playerId: "p1",
    shots: 5,
    hits: 3,
    misses: 2,
    sunk: 2,
    accuracy: 60,
  });
});
