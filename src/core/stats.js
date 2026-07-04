export function summarizeBattleLog(log, winnerId) {
  const players = new Map();

  for (const entry of log) {
    const stats = players.get(entry.playerId) ?? createPlayerStats(entry.playerId);
    stats.shots += 1;
    if (entry.result === "miss") {
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

function createPlayerStats(playerId) {
  return {
    playerId,
    shots: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
  };
}

function withAccuracy(stats) {
  return {
    ...stats,
    accuracy: stats.shots === 0 ? 0 : Math.round((stats.hits / stats.shots) * 100),
  };
}
