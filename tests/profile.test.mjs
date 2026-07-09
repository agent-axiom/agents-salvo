import test from "node:test";
import assert from "node:assert/strict";

import { createSessionToken } from "../worker/auth.js";
import worker from "../worker/index.js";
import { getPlayerProfile, recordCompletedMatch } from "../worker/profile.js";

const sessionSecret = "profile-session-secret";
const profileUser = {
  provider: "telegram",
  id: "42",
  name: "Captain Test",
  username: "captain",
  photoUrl: "",
};
const rivalUser = {
  provider: "telegram",
  id: "99",
  name: "Rival Captain",
  username: "rival",
  photoUrl: "",
};

test("profile endpoints save completed matches and return player statistics", async () => {
  const env = { SESSION_SECRET: sessionSecret, DB: new MemoryD1() };
  const token = await createSessionToken(profileUser, sessionSecret);
  const match = {
    id: "match-1",
    mode: "agent",
    presetId: "classic",
    result: "win",
    opponent: "agent",
    totalShots: 43,
    playerShots: 24,
    playerHits: 17,
    playerMisses: 7,
    playerSunk: 10,
    accuracy: 71,
    turns: 43,
    winnerId: "p1",
    playedAt: "2026-07-06T12:00:00.000Z",
  };

  const saveResponse = await worker.fetch(
    new Request("https://worker.test/profile/matches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(match),
    }),
    env,
  );

  assert.equal(saveResponse.status, 201);
  const savePayload = await saveResponse.json();
  assert.equal(savePayload.match.id, "match-1");
  assert.equal(savePayload.profile.summary.totalMatches, 1);
  assert.equal(savePayload.profile.summary.wins, 1);

  const profileResponse = await worker.fetch(
    new Request("https://worker.test/profile/me", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  );

  assert.equal(profileResponse.status, 200);
  const profilePayload = await profileResponse.json();
  assert.equal(profilePayload.user.id, "42");
  assert.deepEqual(profilePayload.profile.summary, {
    totalMatches: 1,
    wins: 1,
    losses: 0,
    winRate: 100,
    totalShots: 43,
    playerShots: 24,
    playerHits: 17,
    playerMisses: 7,
    playerSunk: 10,
    accuracy: 71,
    bestAccuracy: 71,
    currentWinStreak: 1,
    bestMode: "agent",
    avgShotsToWin: 24,
  });
  assert.equal(profilePayload.profile.recentMatches.length, 1);
  assert.equal(profilePayload.profile.recentMatches[0].opponent, "agent");
});

test("player profiles derive achievement totals from saved match statistics", async () => {
  const db = new MemoryD1();

  const firstMatch = await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "achievement-win",
    result: "win",
    playerShots: 18,
    playerHits: 13,
    playerMisses: 5,
    playerSunk: 10,
    accuracy: 72,
    playedAt: "2026-07-06T12:00:00.000Z",
  });
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "achievement-loss",
    result: "loss",
    playerShots: 6,
    playerHits: 1,
    playerMisses: 5,
    playerSunk: 0,
    accuracy: 17,
    playedAt: "2026-07-07T12:00:00.000Z",
  });

  const profile = await getPlayerProfile(db, profileUser, { now: new Date("2026-07-08T00:00:00.000Z") });

  assert.deepEqual(
    firstMatch.achievements.map((achievement) => achievement.id),
    ["victory", "sharpshooter", "fleetHunter"],
  );
  assert.deepEqual(profile.achievements, [
    { id: "victory", count: 1, lastEarnedAt: "2026-07-06T12:00:00.000Z" },
    { id: "sharpshooter", count: 1, lastEarnedAt: "2026-07-06T12:00:00.000Z" },
    { id: "fleetHunter", count: 1, lastEarnedAt: "2026-07-06T12:00:00.000Z" },
  ]);
  assert.deepEqual(profile.recentMatches[1].achievements.map((achievement) => achievement.id), [
    "victory",
    "sharpshooter",
    "fleetHunter",
  ]);
});

test("profile endpoints require a signed session token", async () => {
  const response = await worker.fetch(new Request("https://worker.test/profile/me"), {
    SESSION_SECRET: sessionSecret,
    DB: new MemoryD1(),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("profile endpoints reject invalid session tokens as unauthorized", async () => {
  const response = await worker.fetch(
    new Request("https://worker.test/profile/me", {
      headers: { Authorization: "Bearer invalid.token" },
    }),
    {
      SESSION_SECRET: sessionSecret,
      DB: new MemoryD1(),
    },
  );

  assert.equal(response.status, 401);
});

test("profile match recording validates result payloads", async () => {
  const env = { SESSION_SECRET: sessionSecret, DB: new MemoryD1() };
  const token = await createSessionToken(profileUser, sessionSecret);

  const response = await worker.fetch(
    new Request("https://worker.test/profile/matches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "agent", result: "draw" }),
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Match result is invalid" });
});

test("profile match endpoint rejects client-submitted online results", async () => {
  const env = { SESSION_SECRET: sessionSecret, DB: new MemoryD1() };
  const token = await createSessionToken(profileUser, sessionSecret);

  const response = await worker.fetch(
    new Request("https://worker.test/profile/matches", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "client-online",
        mode: "online",
        presetId: "classic",
        result: "win",
        opponent: "online",
        totalShots: 1,
        playerShots: 1,
        playerHits: 1,
        playerMisses: 0,
        playerSunk: 1,
        accuracy: 100,
        turns: 1,
        winnerId: "p1",
        playedAt: "2026-07-06T12:00:00.000Z",
      }),
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Online results are recorded by the game server" });
});

test("profile storage is required before reading or writing matches", async () => {
  const token = await createSessionToken(profileUser, sessionSecret);

  const profileResponse = await worker.fetch(
    new Request("https://worker.test/profile/me", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { SESSION_SECRET: sessionSecret },
  );
  assert.equal(profileResponse.status, 400);
  assert.deepEqual(await profileResponse.json(), { error: "Profile storage is not configured" });

  await assert.rejects(
    () => recordCompletedMatch(null, profileUser, completedMatchPayload()),
    /Profile storage is not configured/,
  );
});

test("profile match recording validates required fields and numeric bounds", async () => {
  const db = new MemoryD1();

  await assert.rejects(() => recordCompletedMatch(db, profileUser, null), /Match result is required/);
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), mode: "campaign" }),
    /Match mode is invalid/,
  );
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), presetId: " " }),
    /Battle format is required/,
  );
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), winnerId: "" }),
    /Winner is required/,
  );
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), playedAt: "not-a-date" }),
    /Played date is invalid/,
  );
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), playerShots: -1 }),
    /Player shots must be a non-negative integer/,
  );
  await assert.rejects(
    () => recordCompletedMatch(db, profileUser, { ...completedMatchPayload(), accuracy: 101 }),
    /Accuracy is out of range/,
  );
});

test("server-side online match recording can generate ids and timestamps", async () => {
  const db = new MemoryD1();
  const match = await recordCompletedMatch(
    db,
    profileUser,
    {
      ...completedMatchPayload(),
      id: "",
      mode: "online",
      opponent: "",
      playedAt: "",
    },
    { source: "server" },
  );

  assert.ok(match.id);
  assert.equal(match.mode, "online");
  assert.equal(match.opponent, "unknown");
  assert.match(match.playedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(db.matches.length, 1);
});

test("server-side online match recording returns rating movement", async () => {
  const db = new MemoryD1();
  await recordCompletedMatch(
    db,
    profileUser,
    {
      ...completedMatchPayload(),
      id: "rating-before-win",
      mode: "online",
      result: "win",
      playedAt: "2026-07-02T12:00:00.000Z",
    },
    { source: "server" },
  );

  const match = await recordCompletedMatch(
    db,
    profileUser,
    {
      ...completedMatchPayload(),
      id: "rating-loss",
      mode: "online",
      result: "loss",
      playedAt: "2026-07-03T12:00:00.000Z",
    },
    { source: "server" },
  );

  assert.deepEqual(match.rating, {
    before: 1024,
    after: 1008,
    delta: -16,
    label: "cadet",
    onlineMatches: 2,
    onlineWins: 1,
    onlineLosses: 1,
    onlineWinRate: 50,
    currentOnlineWinStreak: 0,
  });
});

test("player profiles include online rating and season stats", async () => {
  const db = new MemoryD1();
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "online-win",
    mode: "online",
    result: "win",
    opponent: "Rival Captain",
    playedAt: "2026-07-02T12:00:00.000Z",
  }, { source: "server" });
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "online-loss",
    mode: "online",
    result: "loss",
    opponent: "Rival Captain",
    playedAt: "2026-07-03T12:00:00.000Z",
  }, { source: "server" });
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "agent-win",
    mode: "agent",
    result: "win",
    playedAt: "2026-07-04T12:00:00.000Z",
  });

  const profile = await getPlayerProfile(db, profileUser, { now: new Date("2026-07-06T00:00:00.000Z") });

  assert.deepEqual(profile.rating, {
    mmr: 1008,
    label: "cadet",
    onlineMatches: 2,
    onlineWins: 1,
    onlineLosses: 1,
    onlineWinRate: 50,
    currentOnlineWinStreak: 0,
  });
  assert.deepEqual(profile.season, {
    id: "2026-Q3",
    matches: 2,
    wins: 1,
    losses: 1,
    winRate: 50,
  });
});

test("leaderboard endpoint ranks online players by rating", async () => {
  const db = new MemoryD1();
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "captain-win",
    mode: "online",
    result: "win",
    playedAt: "2026-07-02T12:00:00.000Z",
  }, { source: "server" });
  await recordCompletedMatch(db, profileUser, {
    ...completedMatchPayload(),
    id: "captain-loss",
    mode: "online",
    result: "loss",
    playedAt: "2026-07-03T12:00:00.000Z",
  }, { source: "server" });
  await recordCompletedMatch(db, rivalUser, {
    ...completedMatchPayload(),
    id: "rival-win",
    mode: "online",
    result: "win",
    playedAt: "2026-07-03T13:00:00.000Z",
  }, { source: "server" });

  const response = await worker.fetch(new Request("https://worker.test/leaderboard"), { DB: db });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.leaderboard.season, "2026-Q3");
  assert.deepEqual(
    payload.leaderboard.entries.map((entry) => [entry.rank, entry.name, entry.rating, entry.onlineMatches]),
    [
      [1, "Rival Captain", 1024, 1],
      [2, "Captain Test", 1008, 2],
    ],
  );
});

function completedMatchPayload() {
  return {
    id: "match-validation",
    mode: "agent",
    presetId: "classic",
    result: "win",
    opponent: "agent",
    totalShots: 10,
    playerShots: 6,
    playerHits: 4,
    playerMisses: 2,
    playerSunk: 3,
    accuracy: 67,
    turns: 10,
    winnerId: "p1",
    playedAt: "2026-07-06T12:00:00.000Z",
  };
}

class MemoryD1 {
  constructor() {
    this.users = new Map();
    this.matches = [];
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }
}

class MemoryStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    const statement = new MemoryStatement(this.db, this.sql);
    statement.params = params;
    return statement;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO users")) {
      const [userKey, provider, providerId, name, username, photoUrl, now] = this.params;
      const existing = this.db.users.get(userKey);
      this.db.users.set(userKey, {
        user_key: userKey,
        provider,
        provider_id: providerId,
        name,
        username,
        photo_url: photoUrl,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      });
      return { success: true };
    }

    if (this.sql.startsWith("INSERT OR IGNORE INTO matches")) {
      const [
        id,
        userKey,
        mode,
        presetId,
        result,
        opponent,
        totalShots,
        playerShots,
        playerHits,
        playerMisses,
        playerSunk,
        accuracy,
        turns,
        winnerId,
        playedAt,
      ] = this.params;
      if (!this.db.matches.some((match) => match.id === id && match.user_key === userKey)) {
        this.db.matches.push({
          id,
          user_key: userKey,
          mode,
          preset_id: presetId,
          result,
          opponent,
          total_shots: totalShots,
          player_shots: playerShots,
          player_hits: playerHits,
          player_misses: playerMisses,
          player_sunk: playerSunk,
          accuracy,
          turns,
          winner_id: winnerId,
          played_at: playedAt,
        });
      }
      return { success: true };
    }

    throw new Error(`Unsupported run SQL: ${this.sql}`);
  }

  async first() {
    const rows = await this.rows();
    return rows[0] ?? null;
  }

  async all() {
    return { results: await this.rows(), success: true };
  }

  async rows() {
    if (this.sql.startsWith("SELECT COUNT(*) AS total_matches")) {
      const rows = this.matchesForUser();
      const wins = rows.filter((match) => match.result === "win");
      const sums = rows.reduce(
        (total, match) => ({
          total_shots: total.total_shots + match.total_shots,
          player_shots: total.player_shots + match.player_shots,
          player_hits: total.player_hits + match.player_hits,
          player_misses: total.player_misses + match.player_misses,
          player_sunk: total.player_sunk + match.player_sunk,
          best_accuracy: Math.max(total.best_accuracy, match.accuracy),
        }),
        {
          total_shots: 0,
          player_shots: 0,
          player_hits: 0,
          player_misses: 0,
          player_sunk: 0,
          best_accuracy: 0,
        },
      );
      return [
        {
          total_matches: rows.length,
          wins: wins.length,
          losses: rows.length - wins.length,
          ...sums,
          avg_shots_to_win:
            wins.length === 0
              ? null
              : wins.reduce((total, match) => total + match.player_shots, 0) / wins.length,
        },
      ];
    }

    if (this.sql.startsWith("SELECT mode, COUNT(*) AS matches")) {
      const counts = new Map();
      for (const match of this.matchesForUser()) {
        counts.set(match.mode, (counts.get(match.mode) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([mode, matches]) => ({ mode, matches }))
        .sort((first, second) => second.matches - first.matches || first.mode.localeCompare(second.mode));
    }

    if (this.sql.startsWith("SELECT result FROM matches")) {
      return this.matchesForUser()
        .sort((first, second) => second.played_at.localeCompare(first.played_at))
        .map((match) => ({ result: match.result }));
    }

    if (this.sql.startsWith("SELECT result, played_at")) {
      return this.matchesForUser()
        .filter((match) => match.mode === "online")
        .sort((first, second) => first.played_at.localeCompare(second.played_at))
        .map((match) => ({ result: match.result, played_at: match.played_at }));
    }

    if (this.sql.startsWith("SELECT result, player_shots")) {
      return this.matchesForUser()
        .sort((first, second) => first.played_at.localeCompare(second.played_at))
        .map((match) => ({
          result: match.result,
          player_shots: match.player_shots,
          player_hits: match.player_hits,
          player_misses: match.player_misses,
          player_sunk: match.player_sunk,
          accuracy: match.accuracy,
          played_at: match.played_at,
        }));
    }

    if (this.sql.startsWith("SELECT id, mode")) {
      return this.matchesForUser()
        .sort((first, second) => second.played_at.localeCompare(first.played_at))
        .slice(0, this.params[1] ?? 12)
        .map((match) => ({ ...match }));
    }

    if (this.sql.startsWith("SELECT u.user_key")) {
      return this.db.matches
        .filter((match) => match.mode === "online")
        .sort(
          (first, second) =>
            first.user_key.localeCompare(second.user_key) ||
            first.played_at.localeCompare(second.played_at),
        )
        .map((match) => {
          const user = this.db.users.get(match.user_key);
          return {
            user_key: match.user_key,
            name: user?.name ?? "",
            username: user?.username ?? "",
            photo_url: user?.photo_url ?? "",
            result: match.result,
            played_at: match.played_at,
          };
        });
    }

    throw new Error(`Unsupported query SQL: ${this.sql}`);
  }

  matchesForUser() {
    return this.db.matches.filter((match) => match.user_key === this.params[0]);
  }
}
