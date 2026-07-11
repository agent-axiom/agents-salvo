import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  HttpError,
  createOnlineReplayRecord,
  getAuthorizedReplay,
  listPlayerReplays,
  parseReplayPayload,
  replayParticipantId,
  saveOnlineReplay,
} from "../worker/replay.js";

test("online replay records contain trusted boards and no credentials", () => {
  const room = finishedRoomFixture();
  const record = createOnlineReplayRecord(room, "replay-1");

  assert.equal(record.id, "replay-1");
  assert.equal(record.payload.version, 1);
  assert.deepEqual(record.payload.players.p1, { name: "One", username: "one" });
  assert.equal("token" in record.payload.players.p1, false);
  assert.equal("id" in record.payload.players.p1, false);
  assert.deepEqual(record.payload.log.at(-1), {
    playerId: "p1",
    targetPlayerId: "p2",
    coordinate: { row: 1, col: 1 },
    result: "sunk",
    shipId: "p2-patrol",
  });
  assert.notEqual(record.payload.boards.p1, room.game.players.p1.board);
  room.game.players.p1.board.shots.push({ row: 1, col: 0, result: "miss" });
  assert.equal(record.payload.boards.p1.shots.length, 0);
  assert.equal(replayParticipantId(record, "telegram:101"), "p1");
  assert.deepEqual(parseReplayPayload(JSON.stringify(record.payload)), record.payload);
});

test("unsupported and corrupt replay payloads fail closed", () => {
  const payload = createOnlineReplayRecord(finishedRoomFixture(), "replay-1").payload;
  const invalidPayloads = [
    "not-json",
    JSON.stringify({ ...payload, version: 2 }),
    JSON.stringify({ ...payload, players: { p1: payload.players.p1 } }),
    JSON.stringify({ ...payload, boards: { ...payload.boards, p2: null } }),
    JSON.stringify({ ...payload, winnerId: "p3" }),
    JSON.stringify({ ...payload, finishedAt: "not-a-date" }),
    JSON.stringify({ ...payload, log: [{ playerId: "p1", coordinate: { row: -1, col: 0 }, result: "hit" }] }),
    JSON.stringify({
      ...payload,
      players: { ...payload.players, p1: { ...payload.players.p1, token: "credential" } },
    }),
    JSON.stringify({
      ...payload,
      boards: { ...payload.boards, p1: { ...payload.boards.p1, userKey: "telegram:101" } },
    }),
    JSON.stringify({
      ...payload,
      log: [{ ...payload.log[0], userKey: "telegram:101" }],
    }),
  ];

  for (const invalid of invalidPayloads) {
    assert.throws(() => parseReplayPayload(invalid), (error) => error instanceof HttpError && error.status === 404);
  }
});

test("online replay records support marker preset outcomes", () => {
  const room = finishedRoomFixture();
  room.game.players.p2.board.markers = [{ id: "mine-1", type: "mine", cell: { row: 0, col: 1 } }];
  room.game.players.p2.board.shots.push({ row: 0, col: 1, result: "mine", markerId: "mine-1" });
  room.game.log.unshift({
    playerId: "p1",
    targetPlayerId: "p2",
    coordinate: { row: 0, col: 1 },
    result: "mine",
  });

  const record = createOnlineReplayRecord(room, "marker-replay");

  assert.equal(record.payload.log[0].result, "mine");
  assert.equal(record.payload.boards.p2.shots.at(-1).markerId, "mine-1");
});

test("replay storage is idempotent and participant-only", async () => {
  const db = new ReplayD1();
  const record = createOnlineReplayRecord(finishedRoomFixture(), "replay-1");
  await saveOnlineReplay(db, record);
  await saveOnlineReplay(db, record);

  assert.equal(db.replays.length, 1);
  const replay = await getAuthorizedReplay(db, "replay-1", telegramUser("101"));
  assert.equal(replay.viewerPlayerId, "p1");
  assert.equal("p1UserKey" in replay, false);
  assert.equal("p2UserKey" in replay, false);
  await assert.rejects(
    () => getAuthorizedReplay(db, "replay-1", telegramUser("999")),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => getAuthorizedReplay(db, "missing", telegramUser("101")),
    (error) => error.status === 404,
  );
  db.replays[0].data_json = "bad";
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(
      () => getAuthorizedReplay(db, "replay-1", telegramUser("101")),
      (error) => error.status === 503,
    );
  } finally {
    console.error = originalError;
  }
  assert.match(JSON.stringify(logged), /replay-1/);
  assert.doesNotMatch(JSON.stringify(logged), /bad/);
});

test("archive pagination joins the viewer match and uses a stable cursor", async () => {
  const db = replayArchiveD1(25);
  const first = await listPlayerReplays(db, telegramUser("101"), { limit: 20 });
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  assert.equal(first.items[0].result, "win");
  assert.equal(first.items[0].opponent, "Opponent 24");
  assert.equal("p1UserKey" in first.items[0], false);

  const second = await listPlayerReplays(db, telegramUser("101"), {
    limit: 20,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 25);
});

test("archive page size is fixed at twenty", async () => {
  const page = await listPlayerReplays(replayArchiveD1(25), telegramUser("101"), { limit: 5 });

  assert.equal(page.items.length, 20);
  assert.ok(page.nextCursor);
});

test("archive SQL excludes replays belonging only to another user", async () => {
  const db = replayArchiveD1(1);
  db.replays.push({
    id: "outsider-replay",
    p1_user_key: "telegram:303",
    p2_user_key: "telegram:404",
    preset_id: "classic",
    winner_id: "p1",
    finished_at: "2026-07-12T12:00:00.000Z",
    data_json: JSON.stringify(createOnlineReplayRecord(finishedRoomFixture(), "outsider-replay").payload),
  });
  db.matches.push({
    id: "online:outsider-replay:p1",
    replay_id: "outsider-replay",
    user_key: "telegram:101",
    mode: "online",
    played_at: "2026-07-12T12:00:00.000Z",
    result: "win",
    opponent: "Should Not Leak",
  });

  const page = await listPlayerReplays(db, telegramUser("101"));

  assert.deepEqual(page.items.map((item) => item.id), ["replay-00"]);
});

test("archive output sanitizes legacy provider id opponents", async () => {
  const db = replayArchiveD1(1);
  db.matches[0].opponent = "telegram:202";

  const page = await listPlayerReplays(db, telegramUser("101"));

  assert.equal(page.items[0].opponent, "online");
});

test("archive pagination rejects malformed cursors", async () => {
  const db = replayArchiveD1(1);
  for (const cursor of ["bad", Buffer.from("{}").toString("base64url"), Buffer.from('{"finishedAt":"bad","id":"x"}').toString("base64url")]) {
    await assert.rejects(
      () => listPlayerReplays(db, telegramUser("101"), { cursor }),
      (error) => error.status === 400,
    );
  }
});

test("archive pagination starts from indexed player match rows", () => {
  const migration = readFileSync(new URL("../migrations/0002_online_replays.sql", import.meta.url), "utf8");
  const replaySource = readFileSync(new URL("../worker/replay.js", import.meta.url), "utf8");

  assert.match(
    migration,
    /matches\s*\(user_key, mode, played_at DESC, replay_id DESC\)/,
  );
  assert.match(replaySource, /FROM matches m\s+JOIN battle_replays r ON r\.id = m\.replay_id/);
  assert.match(replaySource, /m\.user_key = \? AND m\.mode = 'online'/);
  assert.match(replaySource, /ORDER BY m\.played_at DESC, m\.replay_id DESC/);
});

test("real SQLite plans use the archive index and cursor tuple range", () => {
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { replayArchiveQueries } from ${JSON.stringify(new URL("../worker/replay.js", import.meta.url).href)};

    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync(new URL(${JSON.stringify(new URL("../migrations/0001_player_profiles.sql", import.meta.url).href)}), "utf8"));
      db.exec(readFileSync(new URL(${JSON.stringify(new URL("../migrations/0002_online_replays.sql", import.meta.url).href)}), "utf8"));
      const firstPlan = db.prepare(\`EXPLAIN QUERY PLAN \${replayArchiveQueries.firstPage}\`)
        .all("telegram:101", "telegram:101", "telegram:101", 21);
      const cursorPlan = db.prepare(\`EXPLAIN QUERY PLAN \${replayArchiveQueries.afterCursor}\`)
        .all("telegram:101", "telegram:101", "telegram:101", "2026-07-11T12:00:00.000Z", "replay-1", 21);
      const firstDetails = firstPlan.map((row) => row.detail).join("\\n");
      const cursorDetails = cursorPlan.map((row) => row.detail).join("\\n");
      assert.match(firstDetails, /matches_user_mode_played_replay_idx/);
      assert.match(cursorDetails, /matches_user_mode_played_replay_idx/);
      assert.match(cursorDetails, /\\(played_at,replay_id\\)<\\(\\?,\\?\\)/);
      assert.doesNotMatch(replayArchiveQueries.afterCursor, /\\? IS NULL/);
      assert.match(replayArchiveQueries.afterCursor, /\\(m\\.played_at, m\\.replay_id\\) < \\(\\?, \\?\\)/);
    } finally {
      db.close();
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
});

function telegramUser(id) {
  return { provider: "telegram", id, name: `User ${id}`, username: `user${id}` };
}

function finishedRoomFixture() {
  const p1Board = {
    size: 2,
    ships: [{ id: "p1-patrol", length: 1, cells: [{ row: 0, col: 0 }], hits: [] }],
    shots: [],
  };
  const p2Board = {
    size: 2,
    ships: [{ id: "p2-patrol", length: 1, cells: [{ row: 1, col: 1 }], hits: [{ row: 1, col: 1 }] }],
    shots: [{ row: 1, col: 1, result: "sunk", shipId: "p2-patrol" }],
  };
  return {
    code: "ROOM01",
    finishedAt: "2026-07-11T12:00:00.000Z",
    players: {
      p1: { token: "secret-1", user: { ...telegramUser("101"), name: "One", username: "one" } },
      p2: { token: "secret-2", user: { ...telegramUser("202"), name: "Two", username: "two" } },
    },
    game: {
      phase: "finished",
      presetId: "classic",
      winnerId: "p1",
      players: { p1: { board: p1Board }, p2: { board: p2Board } },
      log: [
        {
          playerId: "p1",
          targetPlayerId: "p2",
          coordinate: { row: 1, col: 1 },
          result: "sunk",
          shipId: "p2-patrol",
          privateField: "drop-me",
        },
      ],
    },
  };
}

function replayArchiveD1(count) {
  const db = new ReplayD1();
  for (let index = 0; index < count; index += 1) {
    const id = `replay-${String(index).padStart(2, "0")}`;
    const finishedAt = new Date(Date.UTC(2026, 6, 11, 12, index)).toISOString();
    db.replays.push({
      id,
      p1_user_key: "telegram:101",
      p2_user_key: "telegram:202",
      preset_id: "classic",
      winner_id: "p1",
      finished_at: finishedAt,
      data_json: JSON.stringify(createOnlineReplayRecord(finishedRoomFixture(), id).payload),
    });
    db.matches.push({
      id: `online:${id}:p1`,
      replay_id: id,
      user_key: "telegram:101",
      mode: "online",
      played_at: finishedAt,
      result: "win",
      opponent: `Opponent ${index}`,
      player_shots: index + 1,
      player_hits: index,
      accuracy: index,
    });
  }
  return db;
}

class ReplayD1 {
  constructor() {
    this.replays = [];
    this.matches = [];
  }

  prepare(sql) {
    return new ReplayStatement(this, sql);
  }
}

class ReplayStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    const statement = new ReplayStatement(this.db, this.sql);
    statement.params = params;
    return statement;
  }

  async run() {
    if (!this.sql.startsWith("INSERT OR IGNORE INTO battle_replays")) {
      throw new Error(`Unsupported run SQL: ${this.sql}`);
    }
    const [id, p1UserKey, p2UserKey, presetId, winnerId, finishedAt, dataJson] = this.params;
    if (!this.db.replays.some((row) => row.id === id)) {
      this.db.replays.push({
        id,
        p1_user_key: p1UserKey,
        p2_user_key: p2UserKey,
        preset_id: presetId,
        winner_id: winnerId,
        finished_at: finishedAt,
        data_json: dataJson,
      });
    }
    return { success: true };
  }

  async first() {
    if (!this.sql.includes("FROM battle_replays") || !this.sql.includes("WHERE id = ?")) {
      throw new Error(`Unsupported first SQL: ${this.sql}`);
    }
    return this.db.replays.find((row) => row.id === this.params[0]) ?? null;
  }

  async all() {
    if (!this.sql.includes("FROM matches m JOIN battle_replays r ON r.id = m.replay_id")) {
      throw new Error(`Unsupported all SQL: ${this.sql}`);
    }
    const [userKey, p1UserKey, p2UserKey] = this.params;
    const cursorFinishedAt = this.params.length === 6 ? this.params[3] : null;
    const cursorId = this.params.length === 6 ? this.params[4] : null;
    const limit = this.params.at(-1);
    let rows = this.db.matches
      .filter((match) => match.user_key === userKey && match.mode === "online" && match.replay_id)
      .map((match) => ({
        ...this.db.replays.find((replay) => replay.id === match.replay_id),
        ...match,
        finished_at: match.played_at,
      }))
      .filter((row) => row.p1_user_key === p1UserKey || row.p2_user_key === p2UserKey);
    if (cursorFinishedAt) {
      rows = rows.filter(
        (row) =>
          row.finished_at < cursorFinishedAt ||
          (row.finished_at === cursorFinishedAt && row.replay_id < cursorId),
      );
    }
    rows.sort(
      (first, second) =>
        second.finished_at.localeCompare(first.finished_at) || second.replay_id.localeCompare(first.replay_id),
    );
    return { success: true, results: rows.slice(0, limit) };
  }
}
