import test from "node:test";
import assert from "node:assert/strict";

import { gamePresets, getGamePreset } from "../src/core/presets.js";

test("game presets expose quick, classic, salvo, and extended formats", () => {
  assert.deepEqual(Object.keys(gamePresets), ["quick", "classic", "salvo", "perelman"]);

  assert.equal(gamePresets.quick.size, 8);
  assert.deepEqual(
    gamePresets.quick.fleet.map((ship) => ship.length),
    [3, 2, 2, 1, 1],
  );

  assert.equal(gamePresets.classic.size, 10);
  assert.deepEqual(
    gamePresets.classic.fleet.map((ship) => ship.length),
    [4, 3, 3, 2, 2, 2, 1, 1, 1, 1],
  );

  assert.equal(gamePresets.salvo.rules.salvo, true);
  assert.equal(gamePresets.perelman.size, 16);
  assert.deepEqual(
    gamePresets.perelman.markers.map((marker) => marker.type),
    ["mine", "mine", "mine", "sweeper"],
  );
});

test("getGamePreset falls back to classic rules", () => {
  assert.equal(getGamePreset("quick").id, "quick");
  assert.equal(getGamePreset("unknown").id, "classic");
});
