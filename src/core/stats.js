export const battleAchievementDefinitions = [
  { id: "victory" },
  { id: "flawlessAim" },
  { id: "sharpshooter" },
  { id: "fleetHunter" },
  { id: "finalBlow" },
];

export function summarizeBattleLog(log, winnerId) {
  const players = new Map();

  for (const entry of log) {
    const stats = players.get(entry.playerId) ?? createPlayerStats(entry.playerId);
    stats.shots += 1;
    if (entry.result === "miss" || entry.result === "mine" || entry.result === "sweeper") {
      stats.misses += 1;
    }
    if (entry.result === "hit" || entry.result === "sunk") {
      stats.hits += 1;
    }
    if (entry.result === "sunk") {
      stats.sunk += 1;
    }
    players.set(entry.playerId, stats);
  }

  const winner = players.get(winnerId) ?? createPlayerStats(winnerId);
  return {
    totalShots: log.length,
    winner: withAccuracy(winner),
    players: Array.from(players.values()).map(withAccuracy),
  };
}

export function buildBattleReport(log, winnerId, playerId = winnerId) {
  const summary = summarizeBattleLog(log, winnerId);
  const player = statsForPlayer(summary.players, playerId);
  const opponentId = summary.players.find((stats) => stats.playerId !== playerId)?.playerId ?? "";
  const opponent = opponentId ? statsForPlayer(summary.players, opponentId) : withAccuracy(createPlayerStats("opponent"));
  const result = winnerId === playerId ? "win" : "loss";
  const finalShot = log.at(-1);

  return {
    result,
    summary,
    player,
    opponent,
    achievements: achievementsForBattleStats({
      result,
      playerShots: player.shots,
      playerHits: player.hits,
      playerMisses: player.misses,
      playerSunk: player.sunk,
      accuracy: player.accuracy,
      finalShotByPlayer: finalShot?.playerId === playerId && finalShot?.result === "sunk",
    }),
    coaching: coachingForBattle(result, player),
  };
}

export function achievementsForBattleStats(stats) {
  const result = stats.result;
  const playerShots = numberValue(stats.playerShots ?? stats.shots ?? stats.player_shots);
  const playerHits = numberValue(stats.playerHits ?? stats.hits ?? stats.player_hits);
  const playerMisses = numberValue(stats.playerMisses ?? stats.misses ?? stats.player_misses);
  const playerSunk = numberValue(stats.playerSunk ?? stats.sunk ?? stats.player_sunk);
  const accuracy =
    stats.accuracy === undefined && playerShots > 0
      ? Math.round((playerHits / playerShots) * 100)
      : numberValue(stats.accuracy);
  const finalShotByPlayer = Boolean(stats.finalShotByPlayer);
  const achievements = [];

  if (result === "win") {
    achievements.push(achievement("victory"));
  }
  if (playerShots >= 3 && playerMisses === 0) {
    achievements.push(achievement("flawlessAim"));
  }
  if (playerShots >= 5 && accuracy >= 70) {
    achievements.push(achievement("sharpshooter"));
  }
  if (playerSunk >= 5) {
    achievements.push(achievement("fleetHunter"));
  }
  if (finalShotByPlayer) {
    achievements.push(achievement("finalBlow"));
  }

  return achievements;
}

function createPlayerStats(playerId) {
  return {
    playerId,
    shots: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
  };
}

function statsForPlayer(players, playerId) {
  return players.find((stats) => stats.playerId === playerId) ?? withAccuracy(createPlayerStats(playerId));
}

function withAccuracy(stats) {
  return {
    ...stats,
    accuracy: stats.shots === 0 ? 0 : Math.round((stats.hits / stats.shots) * 100),
  };
}

function achievement(id) {
  return battleAchievementDefinitions.find((definition) => definition.id === id) ?? { id };
}

function coachingForBattle(result, player) {
  if (player.shots === 0) {
    return {
      diagnosisId: "steady",
      focusId: "endgame",
      drillId: "openingMap",
    };
  }

  if (player.accuracy < 35 || player.misses >= Math.max(3, player.hits * 2 + 1)) {
    return {
      diagnosisId: "lowAccuracy",
      focusId: "searchPattern",
      drillId: "checkerboard",
    };
  }

  if (result === "loss" && player.sunk < 2) {
    return {
      diagnosisId: "finishShips",
      focusId: "targetDiscipline",
      drillId: "lineFinish",
    };
  }

  if (result === "win" && player.accuracy >= 70) {
    return {
      diagnosisId: "precision",
      focusId: "pressure",
      drillId: "salvoControl",
    };
  }

  return {
    diagnosisId: "steady",
    focusId: "endgame",
    drillId: "openingMap",
  };
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
