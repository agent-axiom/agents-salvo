import test from "node:test";
import assert from "node:assert/strict";

import { createSessionToken } from "../worker/auth.js";
import worker from "../worker/index.js";

const sessionSecret = "profile-session-secret";
const profileUser = {
  provider: "telegram",
  id: "42",
  name: "Captain Test",
  username: "captain",
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

    if (this.sql.startsWith("SELECT id, mode")) {
      return this.matchesForUser()
        .sort((first, second) => second.played_at.localeCompare(first.played_at))
        .slice(0, this.params[1] ?? 12)
        .map((match) => ({ ...match }));
    }

    throw new Error(`Unsupported query SQL: ${this.sql}`);
  }

  matchesForUser() {
    return this.db.matches.filter((match) => match.user_key === this.params[0]);
  }
}
