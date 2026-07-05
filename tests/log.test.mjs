import test from "node:test";
import assert from "node:assert/strict";

import { visibleBattleLog } from "../src/core/log.js";

test("visibleBattleLog returns every move with the newest first", () => {
  const log = Array.from({ length: 12 }, (_, index) => ({
    playerId: index % 2 === 0 ? "p1" : "p2",
    result: "miss",
    coordinate: { row: index, col: 0 },
  }));

  const visible = visibleBattleLog(log);

  assert.equal(visible.length, 12);
  assert.deepEqual(
    visible.map((entry) => entry.coordinate.row),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  );
});

test("visibleBattleLog does not mutate the original log", () => {
  const log = [
    { playerId: "p1", result: "miss", coordinate: { row: 0, col: 0 } },
    { playerId: "p2", result: "hit", coordinate: { row: 1, col: 1 } },
  ];

  visibleBattleLog(log);

  assert.deepEqual(
    log.map((entry) => entry.coordinate.row),
    [0, 1],
  );
});
