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
