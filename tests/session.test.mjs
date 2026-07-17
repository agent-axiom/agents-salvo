import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  cleanupExpiredAuthRecords,
  createSession,
  resolveSession,
  revokeSession,
} from "../worker/session.js";

const profileSchema = await readFile(new URL("../migrations/0001_player_profiles.sql", import.meta.url), "utf8");
const sessionSchema = await readFile(new URL("../migrations/0003_mobile_oidc_sessions.sql", import.meta.url), "utf8");

const now = 1_752_576_000;
const defaultTtlSeconds = 60 * 60 * 24 * 30;
const telegramUser = {
  provider: "telegram",
  id: "42",
  name: "Captain Test",
  username: "captain",
  photoUrl: "https://example.test/captain.jpg",
};

test("session migration creates constrained auth storage and expiry indexes", (t) => {
  const db = memoryD1(t);
  const tables = db.queryAll(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name",
    "auth_sessions",
    "telegram_login_tickets",
    "telegram_oidc_flows",
  );
  const indexes = db.queryAll(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_expiry_idx' ORDER BY name",
  );

  assert.deepEqual(
    tables.map(({ name }) => name),
    ["auth_sessions", "telegram_login_tickets", "telegram_oidc_flows"],
  );
  assert.deepEqual(
    indexes.map(({ name }) => name),
    ["auth_sessions_expiry_idx", "telegram_login_tickets_expiry_idx", "telegram_oidc_flows_expiry_idx"],
  );
  assert.throws(
    () =>
      db.execute(
        `INSERT INTO telegram_oidc_flows
          (state_hash, nonce, code_verifier, platform, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "invalid-platform",
        "nonce",
        "verifier",
        "desktop",
        now,
        now + 60,
        null,
      ),
    /CHECK constraint failed/,
  );

  seedUser(db);
  db.execute(
    `INSERT INTO auth_sessions
      (token_hash, user_key, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)`,
    "cascade-check",
    "telegram:42",
    now,
    now + 60,
    now,
  );
  db.execute("DELETE FROM users WHERE user_key = ?", "telegram:42");
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count, 0);
});

test("createSession uses deterministic 32-byte randomness and stores only the token hash", async (t) => {
  const db = memoryD1(t);
  let requestedBytes = 0;

  const { token } = await createSession(db, telegramUser, {
    now,
    randomBytes(length) {
      requestedBytes = length;
      return sequentialBytes(0);
    },
  });

  assert.equal(requestedBytes, 32);
  assert.equal(token, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token.includes("."), false);
  assert.equal(token.includes("="), false);

  const storedSession = db.queryOne("SELECT * FROM auth_sessions");
  assert.equal(storedSession.token_hash, await sha256Base64Url(token));
  assert.equal(storedSession.user_key, "telegram:42");
  assert.equal(storedSession.created_at, now);
  assert.equal(storedSession.expires_at, now + defaultTtlSeconds);
  assert.equal(db.serializedRows().includes(token), false);
});

test("createSession rejects invalid entropy before writing auth state", async (t) => {
  const db = memoryD1(t);

  for (const randomBytes of [
    () => new Uint8Array(31),
    () => "not bytes",
  ]) {
    await assert.rejects(
      createSession(db, telegramUser, { now, randomBytes }),
      /Session randomness must contain 32 bytes/,
    );
  }
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count, 0);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM users").count, 0);
});

test("resolveSession returns a normalized public user for an active session", async (t) => {
  const db = memoryD1(t);
  const { token } = await createSession(db, { ...telegramUser, id: 42 }, {
    now,
    randomBytes: () => sequentialBytes(12),
  });

  const resolved = await resolveSession(db, token, { now: now + 1 });

  assert.deepEqual(resolved, telegramUser);
  assert.equal(db.queryOne("SELECT last_used_at FROM auth_sessions").last_used_at, now + 1);
});

test("createSession upserts normalized user data before adding another session", async (t) => {
  const db = memoryD1(t);
  await createSession(db, telegramUser, {
    now,
    randomBytes: () => sequentialBytes(24),
  });
  await createSession(
    db,
    {
      provider: "telegram",
      id: 42,
      name: "Updated Captain",
      username: undefined,
      photoUrl: undefined,
      privateClaim: "must not persist",
    },
    {
      now: now + 10,
      randomBytes: () => sequentialBytes(48),
    },
  );

  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM users").count, 1);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count, 2);
  assert.deepEqual({ ...db.queryOne("SELECT * FROM users") }, {
    user_key: "telegram:42",
    provider: "telegram",
    provider_id: "42",
    name: "Updated Captain",
    username: "",
    photo_url: "",
    created_at: "2025-07-15T10:40:00.000Z",
    updated_at: "2025-07-15T10:40:10.000Z",
  });
});

test("resolveSession rejects expired sessions at the expiry boundary", async (t) => {
  const db = memoryD1(t);
  const { token } = await createSession(db, telegramUser, {
    now,
    ttlSeconds: 5,
    randomBytes: () => sequentialBytes(36),
  });

  assert.deepEqual(await resolveSession(db, token, { now: now + 4 }), telegramUser);
  await assert.rejects(() => resolveSession(db, token, { now: now + 5 }), {
    message: "Session invalid",
  });
});

test("revokeSession removes only the matching hashed token", async (t) => {
  const db = memoryD1(t);
  const first = await createSession(db, telegramUser, {
    now,
    randomBytes: () => sequentialBytes(60),
  });
  const second = await createSession(db, telegramUser, {
    now,
    randomBytes: () => sequentialBytes(96),
  });

  await revokeSession(db, first.token);

  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count, 1);
  assert.equal(db.serializedRows().includes(first.token), false);
  await assert.rejects(() => resolveSession(db, first.token, { now: now + 1 }), {
    message: "Session invalid",
  });
  assert.deepEqual(await resolveSession(db, second.token, { now: now + 1 }), telegramUser);
});

test("revokeSession ignores malformed tokens without accessing storage", async () => {
  const inaccessibleDb = {
    prepare() {
      assert.fail("malformed tokens must not reach auth storage");
    },
  };

  await revokeSession(inaccessibleDb, undefined);
  await revokeSession(inaccessibleDb, "malformed.token");
});

test("resolveSession gives the same error for unknown and malformed tokens", async (t) => {
  const db = memoryD1(t);
  const invalidTokens = [
    "",
    undefined,
    "short",
    "contains.a.dot",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    base64Url(sequentialBytes(128)),
  ];

  for (const token of invalidTokens) {
    await assert.rejects(() => resolveSession(db, token, { now }), {
      message: "Session invalid",
    });
  }
});

test("cleanupExpiredAuthRecords deletes each record type in bounded batches", async (t) => {
  const db = memoryD1(t);
  seedUser(db);
  for (let index = 0; index < 102; index += 1) {
    seedExpiredAuthRecords(db, index);
  }
  seedLiveAuthRecords(db);

  await cleanupExpiredAuthRecords(db, { now });

  assert.deepEqual(authRecordCounts(db), {
    sessions: 3,
    flows: 3,
    tickets: 3,
  });
  await cleanupExpiredAuthRecords(db, { now, limit: 1 });
  assert.deepEqual(authRecordCounts(db), {
    sessions: 2,
    flows: 2,
    tickets: 2,
  });
  await cleanupExpiredAuthRecords(db, { now, limit: 10 });
  assert.deepEqual(authRecordCounts(db), {
    sessions: 1,
    flows: 1,
    tickets: 1,
  });
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions WHERE expires_at > ?", now).count, 1);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_oidc_flows WHERE expires_at > ?", now).count, 1);
  assert.equal(db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets WHERE expires_at > ?", now).count, 1);
});

test("cleanupExpiredAuthRecords is safe when auth tables are empty", async (t) => {
  const db = memoryD1(t);

  await cleanupExpiredAuthRecords(db, { now });

  assert.deepEqual(authRecordCounts(db), {
    sessions: 0,
    flows: 0,
    tickets: 0,
  });
});

function memoryD1(t) {
  const db = new MemoryD1();
  t.after(() => db.close());
  return db;
}

class MemoryD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(profileSchema);
    this.database.exec(sessionSchema);
  }

  prepare(sql) {
    return new MemoryStatement(this.database, sql);
  }

  execute(sql, ...params) {
    return this.database.prepare(sql).run(...params);
  }

  queryOne(sql, ...params) {
    return this.database.prepare(sql).get(...params) ?? null;
  }

  queryAll(sql, ...params) {
    return this.database.prepare(sql).all(...params);
  }

  serializedRows() {
    return JSON.stringify({
      users: this.queryAll("SELECT * FROM users ORDER BY user_key"),
      sessions: this.queryAll("SELECT * FROM auth_sessions ORDER BY token_hash"),
      flows: this.queryAll("SELECT * FROM telegram_oidc_flows ORDER BY state_hash"),
      tickets: this.queryAll("SELECT * FROM telegram_login_tickets ORDER BY ticket_hash"),
    });
  }

  close() {
    this.database.close();
  }
}

class MemoryStatement {
  constructor(database, sql, params = []) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new MemoryStatement(this.database, this.sql, params);
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }

  async first(columnName) {
    const row = this.database.prepare(this.sql).get(...this.params) ?? null;
    return columnName ? (row?.[columnName] ?? null) : row;
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.params),
      success: true,
    };
  }
}

function seedUser(db) {
  db.execute(
    `INSERT INTO users
      (user_key, provider, provider_id, name, username, photo_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    "telegram:42",
    "telegram",
    "42",
    "Captain Test",
    "captain",
    "",
    "2025-07-15T13:20:00.000Z",
    "2025-07-15T13:20:00.000Z",
  );
}

function seedExpiredAuthRecords(db, index) {
  const expiresAt = now - index - 1;
  db.execute(
    `INSERT INTO auth_sessions
      (token_hash, user_key, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)`,
    `expired-session-${index}`,
    "telegram:42",
    now - 1000,
    expiresAt,
    null,
  );
  db.execute(
    `INSERT INTO telegram_oidc_flows
      (state_hash, nonce, code_verifier, platform, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `expired-flow-${index}`,
    `nonce-${index}`,
    `verifier-${index}`,
    "android",
    now - 1000,
    expiresAt,
    null,
  );
  db.execute(
    `INSERT INTO telegram_login_tickets
      (ticket_hash, user_json, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?)`,
    `expired-ticket-${index}`,
    JSON.stringify(telegramUser),
    now - 1000,
    expiresAt,
    null,
  );
}

function seedLiveAuthRecords(db) {
  db.execute(
    `INSERT INTO auth_sessions
      (token_hash, user_key, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)`,
    "live-session",
    "telegram:42",
    now,
    now + 1,
    null,
  );
  db.execute(
    `INSERT INTO telegram_oidc_flows
      (state_hash, nonce, code_verifier, platform, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    "live-flow",
    "nonce",
    "verifier",
    "ios",
    now,
    now + 1,
    null,
  );
  db.execute(
    `INSERT INTO telegram_login_tickets
      (ticket_hash, user_json, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?)`,
    "live-ticket",
    JSON.stringify(telegramUser),
    now,
    now + 1,
    null,
  );
}

function authRecordCounts(db) {
  return {
    sessions: db.queryOne("SELECT COUNT(*) AS count FROM auth_sessions").count,
    flows: db.queryOne("SELECT COUNT(*) AS count FROM telegram_oidc_flows").count,
    tickets: db.queryOne("SELECT COUNT(*) AS count FROM telegram_login_tickets").count,
  };
}

function sequentialBytes(offset) {
  return Uint8Array.from({ length: 32 }, (_, index) => (offset + index) % 256);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
