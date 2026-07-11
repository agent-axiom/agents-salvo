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

export function battleMomentum(log, playerId) {
  const summary = summarizeBattleLog(log, playerId);
  const player = statsForPlayer(summary.players, playerId);
  const opponent =
    summary.players.find((stats) => stats.playerId !== playerId) ?? withAccuracy(createPlayerStats("opponent"));
  const playerScore = pressureScore(player);
  const opponentScore = pressureScore(opponent);
  const lead = playerScore - opponentScore;
  const totalScore = playerScore + opponentScore;

  return {
    playerScore,
    opponentScore,
    lead,
    playerShare: totalScore === 0 ? 50 : Math.round((playerScore / totalScore) * 100),
    state: lead >= 3 ? "ahead" : lead <= -3 ? "behind" : "even",
  };
}

export function fleetIntel(log, playerId, ownBoard) {
  const summary = summarizeBattleLog(log, playerId);
  const player = statsForPlayer(summary.players, playerId);
  const ownShips = Array.isArray(ownBoard?.ships) ? ownBoard.ships : [];
  const ownSunk = ownShips.filter(shipIsSunk).length;

  return {
    enemySunk: player.sunk,
    ownAfloat: Math.max(0, ownShips.length - ownSunk),
    ownTotal: ownShips.length,
  };
}

export function targetIntel(targetBoard) {
  const size = Number.isInteger(targetBoard?.size) && targetBoard.size > 0 ? targetBoard.size : 0;
  const total = size * size;
  const explored = new Set((targetBoard?.shots ?? []).map((shot) => `${shot.row}:${shot.col}`)).size;

  return {
    explored,
    total,
    coverage: total === 0 ? 0 : Math.round((explored / total) * 100),
    remaining: Math.max(0, total - explored),
  };
}

export function buildBattleReport(log, winnerId, playerId = winnerId) {
  const summary = summarizeBattleLog(log, winnerId);
  const player = statsForPlayer(summary.players, playerId);
  const opponentId = summary.players.find((stats) => stats.playerId !== playerId)?.playerId ?? "";
  const opponent = opponentId ? statsForPlayer(summary.players, opponentId) : withAccuracy(createPlayerStats("opponent"));
  const result = winnerId === playerId ? "win" : "loss";
  const finalShot = log.at(-1);
  const coaching = coachingForBattle(result, player);
  const debrief = battleDebriefForBattle(result, player, opponent, coaching, log);
  const moments = battleMomentsForBattle(log, playerId);

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
    coaching,
    debrief,
    moments,
    trainingPlan: trainingPlanForBattle(result, player, coaching),
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

function pressureScore(stats) {
  return stats.hits + stats.sunk * 2;
}

function shipIsSunk(ship) {
  const cells = Array.isArray(ship?.cells) ? ship.cells : [];
  const hits = Array.isArray(ship?.hits) ? ship.hits : [];
  return cells.length > 0 && cells.every((cell) => hits.some((hit) => sameCoordinate(cell, hit)));
}

function sameCoordinate(a, b) {
  return a?.row === b?.row && a?.col === b?.col;
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

function trainingPlanForBattle(result, player, primaryCoaching) {
  const steps = [];
  addTrainingPlanStep(steps, {
    drillId: primaryCoaching.drillId,
    focusId: primaryCoaching.focusId,
    reasonId: primaryCoaching.diagnosisId,
  });

  if (player.accuracy < 50 || player.misses >= Math.max(3, player.hits + 1)) {
    addTrainingPlanStep(steps, {
      drillId: "checkerboard",
      focusId: "searchPattern",
      reasonId: "lowAccuracy",
    });
  }
  if (result === "loss" || player.hits > player.sunk) {
    addTrainingPlanStep(steps, {
      drillId: "lineFinish",
      focusId: "targetDiscipline",
      reasonId: "finishShips",
    });
  }
  if (result === "win" && player.accuracy >= 70) {
    addTrainingPlanStep(steps, {
      drillId: "salvoControl",
      focusId: "pressure",
      reasonId: "precision",
    });
  }

  for (const fallbackStep of [
    { drillId: "checkerboard", focusId: "searchPattern", reasonId: "lowAccuracy" },
    { drillId: "lineFinish", focusId: "targetDiscipline", reasonId: "finishShips" },
    { drillId: "salvoControl", focusId: "endgame", reasonId: "steady" },
  ]) {
    addTrainingPlanStep(steps, fallbackStep);
  }

  return { steps: steps.slice(0, 3) };
}

function battleDebriefForBattle(result, player, opponent, coaching, log) {
  const weakSearch = player.accuracy < 35 || player.misses >= Math.max(3, player.hits * 2 + 1);
  const finishMessageId =
    player.hits === 0 ? "noContact" : hasUnresolvedPlayerHit(log, player.playerId) ? "unfinishedTargets" : "cleanFinish";
  const pressureWon = result === "win" || player.sunk > opponent.sunk;

  return {
    insights: [
      {
        id: "search",
        tone: weakSearch ? "warning" : "positive",
        messageId: weakSearch ? "weakSearch" : "strongSearch",
      },
      {
        id: "finish",
        tone: finishMessageId === "cleanFinish" ? "positive" : "warning",
        messageId: finishMessageId,
      },
      {
        id: "pressure",
        tone: pressureWon ? "positive" : "warning",
        messageId: pressureWon ? "highPressure" : "lowPressure",
      },
      {
        id: "focus",
        tone: "neutral",
        messageId: coaching.focusId,
      },
    ],
  };
}

function hasUnresolvedPlayerHit(log, playerId) {
  let hasOpenHit = false;
  for (const entry of log) {
    if (entry.playerId !== playerId) {
      continue;
    }
    if (entry.result === "hit") {
      hasOpenHit = true;
    }
    if (entry.result === "sunk") {
      hasOpenHit = false;
    }
  }
  return hasOpenHit;
}

function battleMomentsForBattle(log, playerId) {
  const items = [];
  const firstContact = log.find((entry) => entry.playerId === playerId && hitLike(entry.result));
  const firstSunk = log.find((entry) => entry.playerId === playerId && entry.result === "sunk");
  const missStreak = longestMissStreak(log, playerId);
  const finalShot = log.at(-1);

  if (firstContact) {
    items.push(momentFromEntry("firstContact", firstContact, log.indexOf(firstContact)));
  }
  if (firstSunk) {
    items.push(momentFromEntry("firstSunk", firstSunk, log.indexOf(firstSunk)));
  }
  if (missStreak.length > 0) {
    items.push({ id: "missStreak", playerId, ...missStreak });
  }
  if (finalShot) {
    items.push(momentFromEntry("finalShot", finalShot, log.length - 1));
  }

  return { items };
}

function momentFromEntry(id, entry, index) {
  return {
    id,
    turn: index + 1,
    playerId: entry.playerId,
    coordinate: cloneCoordinate(entry.coordinate),
    result: entry.result,
  };
}

function longestMissStreak(log, playerId) {
  let current = { length: 0, startTurn: 0, endTurn: 0 };
  let best = { length: 0, startTurn: 0, endTurn: 0 };

  log.forEach((entry, index) => {
    if (entry.playerId !== playerId) {
      return;
    }
    const turn = index + 1;
    if (missLike(entry.result)) {
      current = current.length
        ? { length: current.length + 1, startTurn: current.startTurn, endTurn: turn }
        : { length: 1, startTurn: turn, endTurn: turn };
      if (current.length > best.length) {
        best = { ...current };
      }
      return;
    }
    current = { length: 0, startTurn: 0, endTurn: 0 };
  });

  return best;
}

function hitLike(result) {
  return result === "hit" || result === "sunk";
}

function missLike(result) {
  return result === "miss" || result === "mine" || result === "sweeper";
}

function cloneCoordinate(coordinate) {
  if (!coordinate || !Number.isInteger(coordinate.row) || !Number.isInteger(coordinate.col)) {
    return undefined;
  }
  return { row: coordinate.row, col: coordinate.col };
}

function addTrainingPlanStep(steps, step) {
  if (steps.some((candidate) => candidate.drillId === step.drillId)) {
    return;
  }
  steps.push(step);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
