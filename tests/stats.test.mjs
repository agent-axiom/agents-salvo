import test from "node:test";
import assert from "node:assert/strict";

import { achievementsForBattleStats, buildBattleReport, summarizeBattleLog } from "../src/core/stats.js";

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
