const profileModes = new Set(["agent", "online", "hotseat"]);
const matchResults = new Set(["win", "loss"]);

export async function getPlayerProfile(db, user) {
  assertProfileDb(db);
  await upsertUser(db, user);
  const userKey = userSubject(user);
  const [summaryRow, modeRows, streakRows, recentRows] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS total_matches,
          COALESCE(SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END), 0) AS wins,
          COALESCE(SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END), 0) AS losses,
          COALESCE(SUM(total_shots), 0) AS total_shots,
          COALESCE(SUM(player_shots), 0) AS player_shots,
          COALESCE(SUM(player_hits), 0) AS player_hits,
          COALESCE(SUM(player_misses), 0) AS player_misses,
          COALESCE(SUM(player_sunk), 0) AS player_sunk,
          COALESCE(MAX(accuracy), 0) AS best_accuracy,
          AVG(CASE WHEN result = 'win' THEN player_shots ELSE NULL END) AS avg_shots_to_win
        FROM matches
        WHERE user_key = ?`,
      )
      .bind(userKey)
      .first(),
    db
      .prepare(
        `SELECT mode, COUNT(*) AS matches
        FROM matches
        WHERE user_key = ?
        GROUP BY mode
        ORDER BY matches DESC, mode ASC`,
      )
      .bind(userKey)
      .all(),
    db
      .prepare(
        `SELECT result FROM matches
        WHERE user_key = ?
        ORDER BY played_at DESC`,
      )
      .bind(userKey)
      .all(),
    db
      .prepare(
        `SELECT id, mode, preset_id, result, opponent, total_shots, player_shots,
          player_hits, player_misses, player_sunk, accuracy, turns, winner_id, played_at
        FROM matches
        WHERE user_key = ?
        ORDER BY played_at DESC
        LIMIT ?`,
      )
      .bind(userKey, 12)
      .all(),
  ]);

  return {
    summary: summarizeProfile(summaryRow ?? {}, modeRows.results ?? [], streakRows.results ?? []),
    recentMatches: (recentRows.results ?? []).map(publicMatch),
  };
}

export async function recordCompletedMatch(db, user, payload) {
  assertProfileDb(db);
  const match = normalizeMatch(payload);
  await upsertUser(db, user);
  await db
    .prepare(
      `INSERT OR IGNORE INTO matches (
        id, user_key, mode, preset_id, result, opponent, total_shots, player_shots,
        player_hits, player_misses, player_sunk, accuracy, turns, winner_id, played_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      match.id,
      userSubject(user),
      match.mode,
      match.presetId,
      match.result,
      match.opponent,
      match.totalShots,
      match.playerShots,
      match.playerHits,
      match.playerMisses,
      match.playerSunk,
      match.accuracy,
      match.turns,
      match.winnerId,
      match.playedAt,
    )
    .run();

  return match;
}

export function userSubject(user) {
  return `${user.provider}:${user.id}`;
}

async function upsertUser(db, user) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (
        user_key, provider, provider_id, name, username, photo_url, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_key) DO UPDATE SET
        name = excluded.name,
        username = excluded.username,
        photo_url = excluded.photo_url,
        updated_at = excluded.updated_at`,
    )
    .bind(
      userSubject(user),
      user.provider,
      String(user.id),
      user.name || "",
      user.username || "",
      user.photoUrl || "",
      now,
      now,
    )
    .run();
}

function summarizeProfile(row, modeRows, streakRows) {
  const totalMatches = number(row.total_matches);
  const wins = number(row.wins);
  const losses = number(row.losses);
  const playerHits = number(row.player_hits);
  const playerShots = number(row.player_shots);
  return {
    totalMatches,
    wins,
    losses,
    winRate: totalMatches === 0 ? 0 : Math.round((wins / totalMatches) * 100),
    totalShots: number(row.total_shots),
    playerShots,
    playerHits,
    playerMisses: number(row.player_misses),
    playerSunk: number(row.player_sunk),
    accuracy: playerShots === 0 ? 0 : Math.round((playerHits / playerShots) * 100),
    bestAccuracy: number(row.best_accuracy),
    currentWinStreak: currentWinStreak(streakRows),
    bestMode: modeRows[0]?.mode ?? "",
    avgShotsToWin: Math.round(number(row.avg_shots_to_win)),
  };
}

function normalizeMatch(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Match result is required");
  }
  if (!profileModes.has(payload.mode)) {
    throw new Error("Match mode is invalid");
  }
  if (!matchResults.has(payload.result)) {
    throw new Error("Match result is invalid");
  }

  const match = {
    id: cleanText(payload.id) || crypto.randomUUID(),
    mode: payload.mode,
    presetId: cleanText(payload.presetId),
    result: payload.result,
    opponent: cleanText(payload.opponent) || "unknown",
    totalShots: nonNegativeInteger(payload.totalShots, "Total shots"),
    playerShots: nonNegativeInteger(payload.playerShots, "Player shots"),
    playerHits: nonNegativeInteger(payload.playerHits, "Player hits"),
    playerMisses: nonNegativeInteger(payload.playerMisses, "Player misses"),
    playerSunk: nonNegativeInteger(payload.playerSunk, "Player sunk count"),
    accuracy: boundedInteger(payload.accuracy, "Accuracy", 0, 100),
    turns: nonNegativeInteger(payload.turns, "Turns"),
    winnerId: cleanText(payload.winnerId),
    playedAt: normalizePlayedAt(payload.playedAt),
  };

  if (!match.presetId) {
    throw new Error("Battle format is required");
  }
  if (!match.winnerId) {
    throw new Error("Winner is required");
  }
  return match;
}

function publicMatch(row) {
  return {
    id: row.id,
    mode: row.mode,
    presetId: row.preset_id,
    result: row.result,
    opponent: row.opponent,
    totalShots: number(row.total_shots),
    playerShots: number(row.player_shots),
    playerHits: number(row.player_hits),
    playerMisses: number(row.player_misses),
    playerSunk: number(row.player_sunk),
    accuracy: number(row.accuracy),
    turns: number(row.turns),
    winnerId: row.winner_id,
    playedAt: row.played_at,
  };
}

function currentWinStreak(rows) {
  let streak = 0;
  for (const row of rows) {
    if (row.result !== "win") {
      break;
    }
    streak += 1;
  }
  return streak;
}

function normalizePlayedAt(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error("Played date is invalid");
  }
  return date.toISOString();
}

function nonNegativeInteger(value, label) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return numberValue;
}

function boundedInteger(value, label, min, max) {
  const numberValue = nonNegativeInteger(value, label);
  if (numberValue < min || numberValue > max) {
    throw new Error(`${label} is out of range`);
  }
  return numberValue;
}

function cleanText(value) {
  return String(value || "").trim();
}

function number(value) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function assertProfileDb(db) {
  if (!db) {
    throw new Error("Profile storage is not configured");
  }
}
