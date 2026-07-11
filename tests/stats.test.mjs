import test from "node:test";
import assert from "node:assert/strict";

import {
  achievementsForBattleStats,
  battleMomentum,
  buildBattleReport,
  fleetIntel,
  summarizeBattleLog,
  targetIntel,
} from "../src/core/stats.js";

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

test("battleMomentum scores live pressure from hits and sunk ships", () => {
  const log = [
    { playerId: "p1", result: "hit" },
    { playerId: "p2", result: "miss" },
    { playerId: "p1", result: "sunk" },
    { playerId: "p2", result: "hit" },
    { playerId: "p1", result: "hit" },
  ];

  assert.deepEqual(battleMomentum(log, "p1"), {
    playerScore: 5,
    opponentScore: 1,
    lead: 4,
    playerShare: 83,
    state: "ahead",
  });
  assert.deepEqual(battleMomentum(log, "p2"), {
    playerScore: 1,
    opponentScore: 5,
    lead: -4,
    playerShare: 17,
    state: "behind",
  });
  assert.deepEqual(battleMomentum([], "p1"), {
    playerScore: 0,
    opponentScore: 0,
    lead: 0,
    playerShare: 50,
    state: "even",
  });
});

test("fleetIntel reports visible enemy sunk ships and own fleet afloat", () => {
  const ownBoard = {
    ships: [
      {
        id: "destroyer",
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
        hits: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
        ],
      },
      {
        id: "cruiser",
        cells: [
          { row: 3, col: 3 },
          { row: 4, col: 3 },
          { row: 5, col: 3 },
        ],
        hits: [{ row: 3, col: 3 }],
      },
      {
        id: "boat",
        cells: [{ row: 7, col: 7 }],
        hits: [],
      },
    ],
  };
  const log = [
    { playerId: "p1", result: "sunk" },
    { playerId: "p2", result: "hit" },
    { playerId: "p1", result: "miss" },
    { playerId: "p1", result: "sunk" },
  ];

  assert.deepEqual(fleetIntel(log, "p1", ownBoard), {
    enemySunk: 2,
    ownAfloat: 2,
    ownTotal: 3,
  });
});

test("targetIntel reports explored coverage from visible target shots", () => {
  const board = {
    size: 8,
    shots: [
      { row: 0, col: 0, result: "miss" },
      { row: 0, col: 1, result: "hit" },
      { row: 0, col: 1, result: "hit" },
      { row: 7, col: 7, result: "sunk" },
    ],
  };

  assert.deepEqual(targetIntel(board), {
    explored: 3,
    total: 64,
    coverage: 5,
    remaining: 61,
  });
  assert.deepEqual(targetIntel({ size: 0, shots: [] }), {
    explored: 0,
    total: 0,
    coverage: 0,
    remaining: 0,
  });
});

test("buildBattleReport returns player-focused result, opponent stats, and earned achievements", () => {
  const log = [
    { playerId: "p1", result: "hit" },
    { playerId: "p2", result: "miss" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "sunk" },
    { playerId: "p2", result: "hit" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "sunk" },
  ];

  const report = buildBattleReport(log, "p1", "p1");

  assert.equal(report.result, "win");
  assert.equal(report.player.playerId, "p1");
  assert.equal(report.player.shots, 6);
  assert.equal(report.player.accuracy, 100);
  assert.equal(report.opponent.playerId, "p2");
  assert.equal(report.opponent.shots, 2);
  assert.deepEqual(
    report.achievements.map((achievement) => achievement.id),
    ["victory", "flawlessAim", "sharpshooter", "finalBlow"],
  );
  assert.equal(report.coaching.diagnosisId, "precision");
  assert.equal(report.coaching.drillId, "salvoControl");
});

test("buildBattleReport recommends a training drill after low-accuracy losses", () => {
  const log = [
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "hit" },
    { playerId: "p2", result: "sunk" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "hit" },
    { playerId: "p2", result: "sunk" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "sunk" },
  ];

  const report = buildBattleReport(log, "p2", "p1");

  assert.equal(report.result, "loss");
  assert.deepEqual(report.coaching, {
    diagnosisId: "lowAccuracy",
    focusId: "searchPattern",
    drillId: "checkerboard",
  });
});

test("buildBattleReport adds a tactical debrief for low-accuracy losses", () => {
  const log = [
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "hit" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "sunk" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "sunk" },
  ];

  const report = buildBattleReport(log, "p2", "p1");

  assert.deepEqual(report.debrief.insights, [
    { id: "search", tone: "warning", messageId: "weakSearch" },
    { id: "finish", tone: "warning", messageId: "noContact" },
    { id: "pressure", tone: "warning", messageId: "lowPressure" },
    { id: "focus", tone: "neutral", messageId: "searchPattern" },
  ]);
});

test("buildBattleReport adds a positive tactical debrief for controlled wins", () => {
  const log = [
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "sunk" },
    { playerId: "p2", result: "miss" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "sunk" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "sunk" },
    { playerId: "p2", result: "hit" },
  ];

  const report = buildBattleReport(log, "p1", "p1");

  assert.deepEqual(report.debrief.insights, [
    { id: "search", tone: "positive", messageId: "strongSearch" },
    { id: "finish", tone: "positive", messageId: "cleanFinish" },
    { id: "pressure", tone: "positive", messageId: "highPressure" },
    { id: "focus", tone: "neutral", messageId: "pressure" },
  ]);
});

test("buildBattleReport adds player-focused key battle moments", () => {
  const log = [
    { playerId: "p1", result: "miss", coordinate: { row: 0, col: 0 } },
    { playerId: "p2", result: "miss", coordinate: { row: 9, col: 9 } },
    { playerId: "p1", result: "hit", coordinate: { row: 2, col: 3 } },
    { playerId: "p1", result: "sunk", coordinate: { row: 2, col: 4 } },
    { playerId: "p1", result: "miss", coordinate: { row: 4, col: 4 } },
    { playerId: "p1", result: "miss", coordinate: { row: 4, col: 6 } },
    { playerId: "p2", result: "hit", coordinate: { row: 1, col: 1 } },
    { playerId: "p1", result: "sunk", coordinate: { row: 7, col: 1 } },
  ];

  const report = buildBattleReport(log, "p1", "p1");

  assert.deepEqual(report.moments.items, [
    { id: "firstContact", turn: 3, playerId: "p1", coordinate: { row: 2, col: 3 }, result: "hit" },
    { id: "firstSunk", turn: 4, playerId: "p1", coordinate: { row: 2, col: 4 }, result: "sunk" },
    { id: "missStreak", playerId: "p1", length: 2, startTurn: 5, endTurn: 6 },
    { id: "finalShot", turn: 8, playerId: "p1", coordinate: { row: 7, col: 1 }, result: "sunk" },
  ]);
});

test("buildBattleReport creates a personalized multi-step training plan", () => {
  const log = [
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "hit" },
    { playerId: "p1", result: "hit" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "sunk" },
    { playerId: "p1", result: "miss" },
    { playerId: "p2", result: "sunk" },
  ];

  const report = buildBattleReport(log, "p2", "p1");

  assert.deepEqual(report.trainingPlan.steps, [
    { drillId: "checkerboard", focusId: "searchPattern", reasonId: "lowAccuracy" },
    { drillId: "lineFinish", focusId: "targetDiscipline", reasonId: "finishShips" },
    { drillId: "salvoControl", focusId: "endgame", reasonId: "steady" },
  ]);
});

test("achievementsForBattleStats derives durable medals from saved match statistics", () => {
  assert.deepEqual(
    achievementsForBattleStats({
      result: "win",
      playerShots: 18,
      playerHits: 13,
      playerMisses: 5,
      playerSunk: 10,
      accuracy: 72,
    }).map((achievement) => achievement.id),
    ["victory", "sharpshooter", "fleetHunter"],
  );

  assert.deepEqual(
    achievementsForBattleStats({
      result: "loss",
      playerShots: 0,
      playerHits: 0,
      playerMisses: 0,
      playerSunk: 0,
      accuracy: 0,
    }),
    [],
  );
});
