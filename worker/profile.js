import { achievementsForBattleStats, battleAchievementDefinitions } from "../src/core/stats.js";

const profileModes = new Set(["agent", "online", "hotseat"]);
const matchResults = new Set(["win", "loss"]);
const ratingBase = 1000;
const ratingWinDelta = 24;
const ratingLossDelta = -16;

export async function getPlayerProfile(db, user, { now = new Date() } = {}) {
  assertProfileDb(db);
  await upsertUser(db, user);
  const userKey = userSubject(user);
  const [summaryRow, modeRows, streakRows, recentRows, onlineRows, achievementRows] = await Promise.all([
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
    db
      .prepare(
        `SELECT result, played_at
        FROM matches
        WHERE user_key = ? AND mode = 'online'
        ORDER BY played_at ASC`,
      )
      .bind(userKey)
      .all(),
    db
      .prepare(
        `SELECT result, player_shots, player_hits, player_misses, player_sunk, accuracy, played_at
        FROM matches
        WHERE user_key = ?
        ORDER BY played_at ASC`,
      )
      .bind(userKey)
      .all(),
  ]);

  return {
    summary: summarizeProfile(summaryRow ?? {}, modeRows.results ?? [], streakRows.results ?? []),
    rating: summarizeOnlineRating(onlineRows.results ?? [], now),
    season: summarizeSeason(onlineRows.results ?? [], now),
    achievements: summarizeAchievements(achievementRows.results ?? []),
    recentMatches: (recentRows.results ?? []).map(publicMatch),
  };
}

export async function getLeaderboard(db, { now = new Date(), limit = 20 } = {}) {
  assertProfileDb(db);
  const rows = await db
    .prepare(
      `SELECT u.user_key, u.name, u.username, u.photo_url, m.result, m.played_at
      FROM matches m
      JOIN users u ON u.user_key = m.user_key
      WHERE m.mode = 'online'
      ORDER BY u.user_key ASC, m.played_at ASC`,
    )
    .all();
  const players = new Map();
  for (const row of rows.results ?? []) {
    if (!players.has(row.user_key)) {
      players.set(row.user_key, {
        userKey: row.user_key,
        name: row.name || row.username || row.user_key,
        username: row.username || "",
        photoUrl: row.photo_url || "",
        matches: [],
      });
    }
    players.get(row.user_key).matches.push({
      result: row.result,
      played_at: row.played_at,
    });
  }

  const entries = [...players.values()]
    .map((player) => {
      const rating = summarizeOnlineRating(player.matches, now);
      const season = summarizeSeason(player.matches, now);
      return {
        name: player.name,
        username: player.username,
        photoUrl: player.photoUrl,
        rating: rating.mmr,
        label: rating.label,
        onlineMatches: rating.onlineMatches,
        onlineWins: rating.onlineWins,
        onlineLosses: rating.onlineLosses,
        onlineWinRate: rating.onlineWinRate,
        seasonMatches: season.matches,
        seasonWins: season.wins,
      };
    })
    .sort(
      (first, second) =>
        second.rating - first.rating ||
        second.onlineWins - first.onlineWins ||
        first.onlineMatches - second.onlineMatches ||
        first.name.localeCompare(second.name),
    )
    .slice(0, limit)
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  return {
    season: seasonKey(now),
    entries,
  };
}

export async function recordCompletedMatch(db, user, payload, { source = "client" } = {}) {
  assertProfileDb(db);
  const match = normalizeMatch(payload, { source });
  const userKey = userSubject(user);
  await upsertUser(db, user);
  const beforeRating =
    match.mode === "online" ? summarizeOnlineRating(await onlineRatingRows(db, userKey), new Date(match.playedAt)) : null;
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
      userKey,
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

  const recordedMatch = withAchievements(match);

  if (match.mode === "online") {
    const afterRating = summarizeOnlineRating(await onlineRatingRows(db, userKey), new Date(match.playedAt));
    return {
      ...recordedMatch,
      rating: ratingMovement(beforeRating, afterRating),
    };
  }

  return recordedMatch;
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

function normalizeMatch(payload, { source }) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Match result is required");
  }
  if (!profileModes.has(payload.mode)) {
    throw new Error("Match mode is invalid");
  }
  if (payload.mode === "online" && source !== "server") {
    throw new Error("Online results are recorded by the game server");
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
  return withAchievements({
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
  });
}

function withAchievements(match) {
  return {
    ...match,
    achievements: achievementsForBattleStats(match),
  };
}

function summarizeAchievements(rows) {
  const achievements = new Map();
  for (const row of rows) {
    const playedAt = row.played_at || row.playedAt || "";
    for (const achievement of achievementsForBattleStats(row)) {
      const current = achievements.get(achievement.id) ?? {
        id: achievement.id,
        count: 0,
        lastEarnedAt: "",
      };
      current.count += 1;
      current.lastEarnedAt =
        !current.lastEarnedAt || String(playedAt).localeCompare(current.lastEarnedAt) > 0
          ? playedAt
          : current.lastEarnedAt;
      achievements.set(achievement.id, current);
    }
  }

  return battleAchievementDefinitions
    .map((definition) => achievements.get(definition.id))
    .filter(Boolean);
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

function summarizeOnlineRating(rows, now) {
  const onlineWins = rows.filter((row) => row.result === "win").length;
  const onlineLosses = rows.filter((row) => row.result === "loss").length;
  const onlineMatches = onlineWins + onlineLosses;
  const mmr = Math.max(0, ratingBase + onlineWins * ratingWinDelta + onlineLosses * ratingLossDelta);
  return {
    mmr,
    label: ratingLabel(mmr, onlineMatches),
    onlineMatches,
    onlineWins,
    onlineLosses,
    onlineWinRate: onlineMatches === 0 ? 0 : Math.round((onlineWins / onlineMatches) * 100),
    currentOnlineWinStreak: currentWinStreak([...rows].reverse()),
  };
}

async function onlineRatingRows(db, userKey) {
  const rows = await db
    .prepare(
      `SELECT result, played_at
      FROM matches
      WHERE user_key = ? AND mode = 'online'
      ORDER BY played_at ASC`,
    )
    .bind(userKey)
    .all();
  return rows.results ?? [];
}

function ratingMovement(before, after) {
  return {
    before: before.mmr,
    after: after.mmr,
    delta: after.mmr - before.mmr,
    label: after.label,
    onlineMatches: after.onlineMatches,
    onlineWins: after.onlineWins,
    onlineLosses: after.onlineLosses,
    onlineWinRate: after.onlineWinRate,
    currentOnlineWinStreak: after.currentOnlineWinStreak,
  };
}

function summarizeSeason(rows, now) {
  const id = seasonKey(now);
  const seasonRows = rows.filter((row) => seasonKey(new Date(row.played_at)) === id);
  const wins = seasonRows.filter((row) => row.result === "win").length;
  const losses = seasonRows.filter((row) => row.result === "loss").length;
  const matches = wins + losses;
  return {
    id,
    matches,
    wins,
    losses,
    winRate: matches === 0 ? 0 : Math.round((wins / matches) * 100),
  };
}

function ratingLabel(mmr, matches) {
  if (matches === 0) {
    return "unrated";
  }
  if (mmr >= 1200) {
    return "admiral";
  }
  if (mmr >= 1100) {
    return "commander";
  }
  if (mmr >= 1020) {
    return "lieutenant";
  }
  return "cadet";
}

function seasonKey(date) {
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getUTCFullYear();
  const quarter = Math.floor(safeDate.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
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
