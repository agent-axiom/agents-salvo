import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceReplayTurn,
  createReplayClock,
  nextReplaySpeedIndex,
  normalizeReplayTurn,
  replaySpeeds,
  startReplayTurn,
} from "../src/core/replay.js";

test("replay turn helpers normalize, restart, and finish deterministically", () => {
  assert.equal(normalizeReplayTurn(null, 8), 8);
  assert.equal(normalizeReplayTurn(-4, 8), 1);
  assert.equal(normalizeReplayTurn(12, 8), 8);
  assert.equal(normalizeReplayTurn(3, 0), 0);

  assert.equal(startReplayTurn(null, 8), 1);
  assert.equal(startReplayTurn(8, 8), 1);
  assert.equal(startReplayTurn(3, 8), 3);

  assert.deepEqual(advanceReplayTurn(3, 8), { turn: 4, complete: false });
  assert.deepEqual(advanceReplayTurn(7, 8), { turn: 8, complete: true });
  assert.deepEqual(advanceReplayTurn(8, 8), { turn: 8, complete: true });
});

test("replay speeds cycle through 1x, 1.5x, and 2x", () => {
  assert.deepEqual(
    replaySpeeds.map((speed) => speed.label),
    ["1x", "1.5x", "2x"],
  );
  assert.equal(nextReplaySpeedIndex(0), 1);
  assert.equal(nextReplaySpeedIndex(1), 2);
  assert.equal(nextReplaySpeedIndex(2), 0);
  assert.equal(nextReplaySpeedIndex(-1), 1);
});

test("replay clock owns one interval and clears it on restart and stop", () => {
  const scheduled = [];
  const cleared = [];
  let nextHandle = 1;
  const clock = createReplayClock({
    setInterval(callback, delay) {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.push({ handle, callback, delay });
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
  });

  let ticks = 0;
  clock.start(() => {
    ticks += 1;
  }, 1000);
  assert.equal(clock.running, true);
  assert.equal(scheduled.length, 1);

  clock.start(() => {
    ticks += 2;
  }, 500);
  assert.deepEqual(cleared, [1]);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 500);

  scheduled[1].callback();
  assert.equal(ticks, 2);

  clock.stop();
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(clock.running, false);

  clock.stop();
  assert.deepEqual(cleared, [1, 2]);
});
