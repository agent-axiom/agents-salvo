import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceReplayTurn,
  archiveReplayId,
  archiveRetryOptions,
  archivedReplayFrame,
  archivedReplayBoardMinWidth,
  authRequestIsCurrent,
  createReplayClock,
  nextReplaySpeedIndex,
  normalizeReplayTurn,
  replayIdFromSearch,
  replayMomentTurn,
  replayRequestIsCurrent,
  replaySpeeds,
  replayUrlForId,
  startReplayTurn,
} from "../src/core/replay.js";

function archivedReplayFixture() {
  return {
    id: "replay-1",
    version: 1,
    viewerPlayerId: "p1",
    boards: {
      p1: {
        size: 4,
        ships: [
          {
            id: "p1-patrol",
            length: 1,
            cells: [{ row: 1, col: 1 }],
            hits: [{ row: 1, col: 1 }],
          },
        ],
        markers: [{ id: "p1-mine", type: "mine", cell: { row: 3, col: 3 } }],
        shots: [{ row: 1, col: 1, result: "sunk", shipId: "p1-patrol" }],
      },
      p2: {
        size: 4,
        ships: [
          {
            id: "p2-patrol",
            length: 1,
            cells: [{ row: 2, col: 3 }],
            hits: [{ row: 2, col: 3 }],
          },
        ],
        markers: [],
        shots: [
          { row: 0, col: 0, result: "miss" },
          { row: 2, col: 3, result: "sunk", shipId: "p2-patrol" },
        ],
      },
    },
    log: [
      {
        playerId: "p1",
        targetPlayerId: "p2",
        coordinate: { row: 0, col: 0 },
        result: "miss",
      },
      {
        playerId: "p2",
        targetPlayerId: "p1",
        coordinate: { row: 1, col: 1 },
        result: "sunk",
        shipId: "p1-patrol",
      },
      {
        playerId: "p1",
        targetPlayerId: "p2",
        coordinate: { row: 2, col: 3 },
        result: "sunk",
        shipId: "p2-patrol",
      },
    ],
  };
}

test("archived replay frames accumulate shots on both target boards", () => {
  const replay = archivedReplayFixture();
  const original = structuredClone(replay);
  const frame = archivedReplayFrame(replay, 3);

  assert.equal(frame.turn, 3);
  assert.equal(frame.totalTurns, 3);
  assert.equal(frame.activeEntry.playerId, "p1");
  assert.equal(frame.activeTargetPlayerId, "p2");
  assert.equal(frame.boards.p2.shots.length, 2);
  assert.equal(frame.boards.p1.shots.length, 1);
  assert.deepEqual(frame.activeCoordinate, { row: 2, col: 3 });
  assert.equal(frame.boards.p1.ships.length, 1);
  assert.equal(frame.boards.p2.ships.length, 1);
  assert.deepEqual(frame.boards.p1.markers, replay.boards.p1.markers);
  assert.notEqual(frame.boards.p1.markers[0], replay.boards.p1.markers[0]);
  assert.notEqual(frame.boards.p1, replay.boards.p1);
  assert.deepEqual(replay, original);
});

test("archived replay frames reveal every cell of a sunk ship", () => {
  const replay = archivedReplayFixture();
  replay.boards.p2.ships = [
    {
      id: "p2-destroyer",
      length: 2,
      cells: [
        { row: 2, col: 2 },
        { row: 2, col: 3 },
      ],
      hits: [
        { row: 2, col: 2 },
        { row: 2, col: 3 },
      ],
    },
  ];
  replay.log = [
    {
      playerId: "p1",
      targetPlayerId: "p2",
      coordinate: { row: 2, col: 2 },
      result: "hit",
      shipId: "p2-destroyer",
    },
    {
      playerId: "p1",
      targetPlayerId: "p2",
      coordinate: { row: 2, col: 3 },
      result: "sunk",
      shipId: "p2-destroyer",
    },
  ];

  const beforeSunk = archivedReplayFrame(replay, 1);
  const afterSunk = archivedReplayFrame(replay, 2);

  assert.deepEqual(beforeSunk.boards.p2.shots, [
    { row: 2, col: 2, result: "hit", shipId: "p2-destroyer" },
  ]);
  assert.deepEqual(beforeSunk.boards.p2.ships[0].hits, [{ row: 2, col: 2 }]);
  assert.deepEqual(afterSunk.boards.p2.shots, [
    { row: 2, col: 2, result: "sunk", shipId: "p2-destroyer" },
    { row: 2, col: 3, result: "sunk", shipId: "p2-destroyer" },
  ]);
  assert.deepEqual(afterSunk.boards.p2.ships[0].hits, replay.boards.p2.ships[0].cells);
});

test("archived replay frames fail closed for malformed replay data", () => {
  const expected = {
    turn: 0,
    totalTurns: 0,
    boards: {
      p1: { size: 0, ships: [], markers: [], shots: [] },
      p2: { size: 0, ships: [], markers: [], shots: [] },
    },
    activeEntry: null,
    activeTargetPlayerId: null,
    activeCoordinate: null,
  };

  assert.deepEqual(archivedReplayFrame(null, 3), expected);
  assert.deepEqual(
    archivedReplayFrame({ boards: {}, log: [{ targetPlayerId: "p3" }] }, 1),
    expected,
  );
  assert.deepEqual(
    archivedReplayFrame(
      {
        get boards() {
          throw new Error("corrupt archive");
        },
      },
      1,
    ),
    expected,
  );
});

test("archived replay deep links parse and serialize without carrying stale URL state", () => {
  assert.equal(replayIdFromSearch("?replay=abc-123&room=OLD"), "abc-123");
  assert.equal(replayIdFromSearch("?replay=abc%2F123"), "");
  assert.equal(replayIdFromSearch("?replay=%20%20"), "");
  assert.equal(replayIdFromSearch(`?replay=${"x".repeat(129)}`), "");
  assert.equal(replayIdFromSearch("not a search"), "");
  assert.equal(replayIdFromSearch(Symbol("invalid")), "");

  assert.equal(
    replayUrlForId("https://agent-axiom.github.io/agents-salvo/?room=OLD#battle", "abc-123"),
    "https://agent-axiom.github.io/agents-salvo/?replay=abc-123",
  );
  assert.equal(replayUrlForId("https://agent-axiom.github.io/agents-salvo/", "abc/123"), "");
});

test("private replay responses are ignored after logout, identity change, or superseding navigation", () => {
  const request = { token: "token-a", requestId: 4, replayId: "abc-123" };

  assert.equal(replayRequestIsCurrent(request, { ...request }), true);
  assert.equal(replayRequestIsCurrent(request, { ...request, token: "" }), false);
  assert.equal(replayRequestIsCurrent(request, { ...request, token: "token-b" }), false);
  assert.equal(replayRequestIsCurrent(request, { ...request, requestId: 5 }), false);
  assert.equal(replayRequestIsCurrent(request, { ...request, replayId: "other-456" }), false);
});

test("authenticated responses require the same epoch, token, and identity", () => {
  const request = { epoch: 7, token: "token-a", identity: "telegram:42" };

  assert.equal(authRequestIsCurrent(request, { ...request }), true);
  assert.equal(authRequestIsCurrent(request, { ...request, epoch: 8 }), false);
  assert.equal(authRequestIsCurrent(request, { ...request, token: "token-b" }), false);
  assert.equal(authRequestIsCurrent(request, { ...request, identity: "telegram:84" }), false);
  assert.equal(authRequestIsCurrent(null, request), false);
});

test("archive helpers distinguish replay-enabled and historical rows", () => {
  assert.equal(archiveReplayId({ id: "match-1", replayId: "abc-123" }), "abc-123");
  assert.equal(archiveReplayId({ id: "match-2", replayId: null }), "");
  assert.equal(archiveReplayId({ id: "match-3", replayId: "abc/123" }), "");

  assert.deepEqual(archiveRetryOptions({ append: true, cursor: "page-2" }), {
    append: true,
    cursor: "page-2",
  });
  assert.deepEqual(archiveRetryOptions({ append: true, cursor: "" }), {
    append: false,
    cursor: "",
  });
  assert.deepEqual(archiveRetryOptions({ append: false, cursor: "page-2" }), {
    append: false,
    cursor: "",
  });
});

test("large archived boards keep a deliberate scrollable minimum width", () => {
  assert.equal(archivedReplayBoardMinWidth(10), 0);
  assert.equal(archivedReplayBoardMinWidth(16), 628);
  assert.equal(archivedReplayBoardMinWidth(0), 0);
  assert.equal(archivedReplayBoardMinWidth(Number.NaN), 0);
});

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

test("replay moments resolve to the move where they become meaningful", () => {
  assert.equal(replayMomentTurn({ turn: 3 }, 10), 3);
  assert.equal(replayMomentTurn({ startTurn: 5, endTurn: 8 }, 10), 8);
  assert.equal(replayMomentTurn({ startTurn: 4 }, 10), 4);
  assert.equal(replayMomentTurn({ turn: -4 }, 10), 1);
  assert.equal(replayMomentTurn({ turn: 40 }, 10), 10);
});

test("replay moments reject malformed data and empty replays", () => {
  assert.equal(replayMomentTurn(null, 10), 0);
  assert.equal(replayMomentTurn({}, 10), 0);
  assert.equal(replayMomentTurn({ turn: 2.5 }, 10), 0);
  assert.equal(replayMomentTurn({ turn: Number.NaN }, 10), 0);
  assert.equal(replayMomentTurn({ turn: 2 }, 0), 0);
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
