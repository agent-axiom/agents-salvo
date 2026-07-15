import { publicUser } from "./auth.js";
import { upsertUser, userSubject } from "./profile.js";

const defaultTtlSeconds = 60 * 60 * 24 * 30;
const defaultCleanupLimit = 100;
const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const textEncoder = new TextEncoder();

export async function createSession(db, user, options = {}) {
  const now = epochSeconds(options.now);
  const ttlSeconds = options.ttlSeconds ?? defaultTtlSeconds;
  const bytes = options.randomBytes ? await options.randomBytes(32) : secureRandomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("Session randomness must contain 32 bytes");
  }

  const token = base64UrlEncode(bytes);
  const tokenHash = await hashToken(token);
  const normalizedUser = publicUser(user);
  await upsertUser(db, normalizedUser, { now: new Date(now * 1000) });
  await db
    .prepare(
      `INSERT INTO auth_sessions
        (token_hash, user_key, created_at, expires_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenHash, userSubject(normalizedUser), now, now + ttlSeconds, now)
    .run();

  return { token };
}

export async function resolveSession(db, token, options = {}) {
  if (!sessionTokenPattern.test(token ?? "")) {
    throw sessionInvalidError();
  }

  const now = epochSeconds(options.now);
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT s.expires_at, u.provider, u.provider_id, u.name, u.username, u.photo_url
      FROM auth_sessions s
      JOIN users u ON u.user_key = s.user_key
      WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first();
  if (!row || row.expires_at <= now) {
    throw sessionInvalidError();
  }

  await db.prepare("UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  return publicUser({
    provider: row.provider,
    id: row.provider_id,
    name: row.name,
    username: row.username,
    photoUrl: row.photo_url,
  });
}

export async function revokeSession(db, token) {
  if (!sessionTokenPattern.test(token ?? "")) {
    return;
  }

  const tokenHash = await hashToken(token);
  await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function cleanupExpiredAuthRecords(db, options = {}) {
  const now = epochSeconds(options.now);
  const limit = cleanupLimit(options.limit);
  const targets = [
    ["auth_sessions", "token_hash"],
    ["telegram_oidc_flows", "state_hash"],
    ["telegram_login_tickets", "ticket_hash"],
  ];

  for (const [table, primaryKey] of targets) {
    await db
      .prepare(
        `DELETE FROM ${table}
        WHERE ${primaryKey} IN (
          SELECT ${primaryKey}
          FROM ${table}
          WHERE expires_at <= ?
          ORDER BY expires_at ASC, ${primaryKey} ASC
          LIMIT ?
        )`,
      )
      .bind(now, limit)
      .run();
  }
}

function epochSeconds(value) {
  return value ?? Math.floor(Date.now() / 1000);
}

function cleanupLimit(value) {
  if (value === undefined) {
    return defaultCleanupLimit;
  }
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function secureRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function sessionInvalidError() {
  return new Error("Session invalid");
}
