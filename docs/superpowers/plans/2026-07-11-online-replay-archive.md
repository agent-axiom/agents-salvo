# Online Replay Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every authenticated online battle and let either participant browse a private archive or reopen a permanent interactive replay.

**Architecture:** Add a versioned JSON replay record to D1 and link both server-authored match rows to it. A dedicated Worker module owns serialization, authorization, pagination, and D1 queries; the Durable Object owns idempotent completion and alarm retries. The static frontend adds authenticated archive/replay screens and reuses the existing timeline controls with two-board reconstruction.

**Tech Stack:** Vanilla JavaScript, Cloudflare Workers, Durable Objects, D1 SQLite, Node test runner, HTML templates, CSS, GitHub Pages.

---

## File Map

- Create `migrations/0002_online_replays.sql`: replay table, `matches.replay_id`, and participant archive pagination index.
- Create `worker/replay.js`: snapshot serialization, D1 persistence, ACL, and cursor pagination.
- Modify `worker/index.js`: routes, completion recording, alarm retries, and replay IDs.
- Modify `worker/profile.js`: persist and expose nullable `replayId` on match rows.
- Modify `src/core/replay.js`: archived two-board frame reconstruction.
- Modify `src/app.js`: archive/replay state, query routing, authenticated fetches, rendering, and actions.
- Modify `src/i18n.js`: EN/RU/ZH archive, replay, and error labels.
- Modify `src/styles.css`: archive list, two-board replay, mobile tabs, and loading/error states.
- Create `tests/replay-archive.test.mjs`: replay storage and pagination unit tests.
- Modify `tests/worker.test.mjs`: Worker routes, recording, idempotency, and alarm retries.
- Modify `tests/profile.test.mjs`: linked match compatibility.
- Modify `tests/replay.test.mjs`: archived frame reconstruction.
- Modify `tests/auth-ui.test.mjs`, `tests/i18n.test.mjs`, and `tests/ux-redesign.test.mjs`: frontend contracts and localization.

### Task 1: Add Replay Persistence And Versioning

**Files:**
- Create: `migrations/0002_online_replays.sql`
- Create: `worker/replay.js`
- Create: `tests/replay-archive.test.mjs`

- [x] **Step 1: Write failing replay serialization tests**

Import the new functions and assert a trusted room becomes a private version-one record without tokens:

```js
import {
  createOnlineReplayRecord,
  parseReplayPayload,
  replayParticipantId,
} from "../worker/replay.js";

test("online replay records contain trusted boards and no credentials", () => {
  const record = createOnlineReplayRecord(finishedRoomFixture(), "replay-1");
  assert.equal(record.id, "replay-1");
  assert.equal(record.payload.version, 1);
  assert.equal(record.payload.log.at(-1).result, "sunk");
  assert.equal("token" in record.payload.players.p1, false);
  assert.equal(replayParticipantId(record, "telegram:101"), "p1");
  assert.deepEqual(parseReplayPayload(JSON.stringify(record.payload)), record.payload);
});

test("unsupported and corrupt replay payloads fail closed", () => {
  assert.throws(() => parseReplayPayload("not-json"), /Replay is unavailable/);
  assert.throws(() => parseReplayPayload('{"version":2}'), /Replay is unavailable/);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/replay-archive.test.mjs`

Expected: FAIL because `worker/replay.js` does not exist.

- [x] **Step 3: Add the D1 migration**

Create this schema:

```sql
CREATE TABLE IF NOT EXISTS battle_replays (
  id TEXT PRIMARY KEY,
  p1_user_key TEXT NOT NULL,
  p2_user_key TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  winner_id TEXT NOT NULL CHECK (winner_id IN ('p1', 'p2')),
  finished_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE matches ADD COLUMN replay_id TEXT;
CREATE INDEX IF NOT EXISTS matches_replay_id_idx ON matches (replay_id);
CREATE INDEX IF NOT EXISTS matches_user_online_replay_idx
  ON matches (user_key, mode, played_at DESC, id DESC);
```

- [x] **Step 4: Implement trusted replay serialization**

Export a record builder with a strict payload parser:

```js
export function createOnlineReplayRecord(room, replayId) {
  const payload = {
    version: 1,
    presetId: room.game.presetId,
    winnerId: room.game.winnerId,
    finishedAt: room.finishedAt,
    players: publicReplayPlayers(room.players),
    boards: {
      p1: cloneBoard(room.game.players.p1.board),
      p2: cloneBoard(room.game.players.p2.board),
    },
    log: room.game.log.map(publicReplayLogEntry),
  };
  return {
    id: replayId,
    p1UserKey: userSubject(room.players.p1.user),
    p2UserKey: userSubject(room.players.p2.user),
    presetId: payload.presetId,
    winnerId: payload.winnerId,
    finishedAt: payload.finishedAt,
    payload,
  };
}
```

`parseReplayPayload()` must validate version, players, both boards, log, preset, winner, and completion date before returning data.

- [x] **Step 5: Run serialization tests and verify GREEN**

Run: `node --test tests/replay-archive.test.mjs`

Expected: serialization tests PASS.

### Task 2: Add D1 Storage, ACL, And Pagination

**Files:**
- Modify: `worker/replay.js`
- Modify: `tests/replay-archive.test.mjs`

- [x] **Step 1: Write failing persistence and ACL tests**

Use a focused fake D1 and cover idempotency, participant reads, forbidden reads, and missing rows:

```js
test("replay storage is idempotent and participant-only", async () => {
  const db = new ReplayD1();
  const record = createOnlineReplayRecord(finishedRoomFixture(), "replay-1");
  await saveOnlineReplay(db, record);
  await saveOnlineReplay(db, record);
  assert.equal(db.replays.length, 1);
  assert.equal((await getAuthorizedReplay(db, "replay-1", telegramUser("101"))).viewerPlayerId, "p1");
  await assert.rejects(
    () => getAuthorizedReplay(db, "replay-1", telegramUser("999")),
    (error) => error.status === 403,
  );
});
```

- [x] **Step 2: Write failing cursor tests**

```js
test("archive pagination uses a stable finished-at and id cursor", async () => {
  const db = replayArchiveD1(25);
  const first = await listPlayerReplays(db, telegramUser("101"), { limit: 20 });
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  const second = await listPlayerReplays(db, telegramUser("101"), {
    limit: 20,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 5);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 25);
});
```

- [x] **Step 3: Run tests and verify RED**

Run: `node --test tests/replay-archive.test.mjs`

Expected: FAIL because D1 operations and cursor helpers are missing.

- [x] **Step 4: Implement persistence and authorization**

Add:

```js
export async function saveOnlineReplay(db, record) {
  assertReplayDb(db);
  await db.prepare(
    `INSERT OR IGNORE INTO battle_replays
      (id, p1_user_key, p2_user_key, preset_id, winner_id, finished_at, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    record.id,
    record.p1UserKey,
    record.p2UserKey,
    record.presetId,
    record.winnerId,
    record.finishedAt,
    JSON.stringify(record.payload),
  ).run();
  return record.id;
}
```

`getAuthorizedReplay()` must query by ID, return `404` when absent/corrupt, compare `userSubject(user)` to both participant keys, return `403` on mismatch, and project `viewerPlayerId` without returning internal keys.

- [x] **Step 5: Implement cursor pagination**

Encode `{ finishedAt, id }` as base64url JSON. Reject malformed cursors with
status `400`. Use separate first-page and cursor SQL statements, both starting
from the caller's own indexed match rows so archive metadata comes from the
participant-specific result. The cursor form adds:

```sql
FROM matches m
LEFT JOIN battle_replays r ON r.id = m.replay_id
WHERE m.user_key = ? AND m.mode = 'online'
  AND (m.replay_id IS NULL OR r.p1_user_key = ? OR r.p2_user_key = ?)
  AND (m.played_at, m.id) < (?, ?)
ORDER BY m.played_at DESC, m.id DESC
LIMIT 21
```

Return 20 projected items plus a cursor from the twentieth item when a twenty-first row exists.
Verify the migration and query with real SQLite `EXPLAIN QUERY PLAN` so the
composite participant index is selected.

- [x] **Step 6: Run tests and verify GREEN**

Run: `node --test tests/replay-archive.test.mjs`

Expected: all replay archive tests PASS.

### Task 3: Link Server Match Rows And Add Retry Alarms

**Files:**
- Modify: `worker/profile.js`
- Modify: `worker/index.js`
- Modify: `tests/profile.test.mjs`
- Modify: `tests/worker.test.mjs`

- [x] **Step 1: Write failing linked-match tests**

Extend profile payload tests:

```js
const match = await recordCompletedMatch(
  db,
  profileUser,
  { ...completedMatchPayload(), mode: "online", replayId: "replay-1" },
  { source: "server" },
);
assert.equal(match.replayId, "replay-1");
assert.equal((await getPlayerProfile(db, profileUser)).recentMatches[0].replayId, "replay-1");
```

Existing match payloads without `replayId` must continue returning `replayId: null`.

- [x] **Step 2: Write failing completion and retry tests**

Extend `MemoryStorage` with `setAlarm()` and an immutable recording outbox. Assert
that a deferred D1 write cannot replace a concurrent rematch update:

```js
assert.equal(savedRoom.replayId.length, 36);
assert.equal(db.replays.length, 1);
assert.deepEqual(new Set(db.matches.map((match) => match.replay_id)), new Set([savedRoom.replayId]));

await failingRoom.handleMessage(sessionId, finalShotMessage);
assert.ok(storage.alarmAt > Date.now());
await failingRoom.alarm();
assert.equal((await storage.get("recording-outbox")).at(0).retryCount, 2);
```

Also call the successful alarm twice and assert one replay and two participant
rows remain. Simulate a batch failure and prove no partial replay/profile rows are
visible before a successful retry.

- [x] **Step 3: Run focused tests and verify RED**

Run: `node --test tests/profile.test.mjs tests/worker.test.mjs`

Expected: FAIL because replay links and alarm handling are absent.

- [x] **Step 4: Persist `replay_id` in profile matches**

Update match normalization, insert bindings, recent match SQL, and `publicMatch()`:

```js
replayId: cleanText(payload.replayId) || null,
```

Only `source === "server" && mode === "online"` may persist a non-null replay ID. Client-authored agent/hotseat rows remain compatible and cannot attach arbitrary replays.

- [x] **Step 5: Make online completion idempotent**

Before accepting either setup or fire input, reconstruct setup boards from the
exact preset fleet/marker identities with empty `hits` and `shots`, and allocate a
new `{ row, col }` fire coordinate. Never clone unknown client fields into trusted
room state.

When the game first finishes:

```js
room.replayId ||= crypto.randomUUID();
room.finishedAt ||= new Date().toISOString();
```

Build match IDs as `online:${room.replayId}:${playerId}` and pass `replayId` in
`onlineMatchPayload()`. Persist the replay and both match rows through one D1
`batch()` transaction. Store the immutable recording payload under a dedicated
Durable Object outbox key; awaited persistence must never save a captured room
snapshot.

- [x] **Step 6: Add bounded alarm retries**

On transient D1 failure, persist retry metadata on the outbox entry and schedule:

```js
const delay = Math.min(30_000 * 2 ** Math.max(retryCount - 1, 0), 15 * 60_000);
await this.state.storage.setAlarm(Date.now() + delay);
```

Store immutable jobs by replay ID and separate schedule keys ordered by a
zero-padded due timestamp. Establish the alarm before making the finished room,
job, and schedule durable together. `alarm()` reads only a fixed due batch with
`prefix`, `end`, and `limit`, processes it independently from the active room,
and immediately schedules the next key. Success removes the job and schedule.
Retries cap at 12 attempts; an exhausted or terminal persistence entry becomes a
retained dead letter containing the complete envelope, supports internal requeue,
and emits telemetry without blocking room actions or rematches. A malformed
payload keeps only an allowlisted recovery snapshot and requires an explicitly
repaired envelope when requeued. Missing `env.DB` and malformed recording data
are terminal configuration/data failures and do not schedule an alarm loop.

- [x] **Step 7: Run focused tests and verify GREEN**

Run: `node --test tests/profile.test.mjs tests/worker.test.mjs tests/replay-archive.test.mjs`

Expected: all focused Worker and storage tests PASS.

### Task 4: Add Authenticated Replay And Archive APIs

**Files:**
- Modify: `worker/index.js`
- Modify: `tests/worker.test.mjs`

- [x] **Step 1: Write failing route and status tests**

Cover:

```js
assert.equal(routeRequest(new URL("https://worker/replays/replay-1")).kind, "replay");
assert.equal(routeRequest(new URL("https://worker/profile/replays?limit=20")).kind, "profileReplays");
```

Exercise `GET /replays/:id` and `GET /profile/replays` for participant success, `401`, `403`, `404`, invalid cursor `400`, and missing DB `503`.

- [x] **Step 2: Run Worker tests and verify RED**

Run: `node --test tests/worker.test.mjs`

Expected: FAIL because the routes are not registered.

- [x] **Step 3: Add route parsing**

Return `{ kind: "replay", replayId }` for exactly two path segments and `{ kind: "profileReplays" }` for `/profile/replays`. Replay IDs accept UUID-safe `[A-Za-z0-9-]` characters and reject empty or oversized values.

- [x] **Step 4: Add authenticated handlers**

Handlers call `requireUser()`, `getAuthorizedReplay()`, and `listPlayerReplays()`. Map typed replay errors to their explicit statuses and unknown D1 failures to `503`; do not reuse the broad profile `400` mapping.

- [x] **Step 5: Run Worker tests and verify GREEN**

Run: `node --test tests/worker.test.mjs tests/replay-archive.test.mjs`

Expected: all API and storage tests PASS.

### Task 5: Reconstruct Two Archived Boards

**Files:**
- Modify: `src/core/replay.js`
- Modify: `tests/replay.test.mjs`

- [x] **Step 1: Write failing archived frame tests**

```js
test("archived replay frames accumulate shots on both target boards", () => {
  const frame = archivedReplayFrame(replayFixture(), 3);
  assert.equal(frame.activeEntry.playerId, "p1");
  assert.equal(frame.activeTargetPlayerId, "p2");
  assert.equal(frame.boards.p2.shots.length, 2);
  assert.equal(frame.boards.p1.shots.length, 1);
  assert.deepEqual(frame.activeCoordinate, { row: 2, col: 3 });
});
```

Verify bounds, immutable source boards, and ship visibility.

- [x] **Step 2: Run replay tests and verify RED**

Run: `node --test tests/replay.test.mjs`

Expected: FAIL because `archivedReplayFrame` is not exported.

- [x] **Step 3: Implement frame reconstruction**

Clone both archived boards, replace their shot arrays with log entries through the normalized turn, and map every entry to its `targetPlayerId`. Return the active entry, target, and coordinate. Reject malformed replays by returning an empty deterministic frame rather than mutating input.

- [x] **Step 4: Run replay tests and verify GREEN**

Run: `node --test tests/replay.test.mjs`

Expected: all replay tests PASS with `src/core/replay.js` at 100% line coverage.

### Task 6: Add Archive And Deep-Link State

**Files:**
- Modify: `src/app.js`
- Modify: `tests/auth-ui.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`

- [x] **Step 1: Write failing state and routing tests**

Require:

```js
archive: { items: [], nextCursor: "", loading: false, error: "" }
replayArchive: { requestedId: "", data: null, loading: false, error: "" }
```

Assert source contracts for startup query parsing, post-auth resume, authenticated archive/replay fetches, `history.pushState`, `popstate`, Retry, Load more, and autoplay cleanup.

- [x] **Step 2: Run focused UI tests and verify RED**

Run: `node --test tests/auth-ui.test.mjs tests/ux-redesign.test.mjs`

Expected: FAIL because archive/replay state and actions are absent.

- [x] **Step 3: Add deterministic query navigation**

Parse `new URLSearchParams(window.location.search).get("replay")` during initialization. Add helpers that use `history.pushState()` for archive/replay navigation and `history.replaceState()` when clearing stale parameters. A `popstate` listener reloads the matching screen state.

- [x] **Step 4: Add authenticated fetch flows**

`loadReplayArchive({ append })` calls `/profile/replays` with the stored cursor. `loadArchivedReplay(id)` calls `/replays/:id`. Both send the bearer token, preserve requested replay IDs across `401`, and project `403`, `404`, and network failures into localized screen state.

After `refreshAuth()` or Telegram login succeeds, automatically resume the pending deep link.

- [x] **Step 5: Add actions and cleanup**

Add archive, replay, Retry, Load more, Copy link, Back, tab, and timeline actions. Leaving the replay calls `resetResultReplayPlayback()` and clears replay-only state. Copying uses the canonical GitHub Pages URL plus `?replay=<encoded id>`.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/auth-ui.test.mjs tests/ux-redesign.test.mjs`

Expected: frontend state and navigation contracts PASS.

### Task 7: Render And Localize The Archive And Replay

**Files:**
- Modify: `src/app.js`
- Modify: `src/i18n.js`
- Modify: `src/styles.css`
- Modify: `tests/i18n.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`

- [x] **Step 1: Write failing localization and responsive tests**

Require all `archive.*` and `replayArchive.*` keys in EN/RU/ZH. Require archive rows, replay error/sign-in gates, two replay boards, mobile tabs, a 44-pixel range, and no fixed viewport-sized widths.

- [x] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/i18n.test.mjs tests/ux-redesign.test.mjs`

Expected: FAIL because screens and labels are absent.

- [x] **Step 3: Render the archive screen**

Render a full-width work-focused list with result, opponent, localized preset,
date, accuracy, shots, and a replay icon command only when `replayId` exists.
Legacy rows remain visible and non-interactive. Keep 20-item pages unframed; use
row separators rather than card nesting. Render explicit empty, loading, retry,
and Load more states.

- [x] **Step 4: Render the replay screen**

Render metadata, both accumulated boards, active target pulse, timeline, moment jumps, playback controls, Copy link, Back to archive, and Main menu. Use `viewerPlayerId` to label and order Own/Opponent perspectives. Desktop uses two columns; mobile renders one board selected by tabs.

- [x] **Step 5: Add all three localizations**

Add natural labels and errors, including distinct forbidden, missing, unavailable, copied-link, archive-empty, and sign-in-required messages.

- [x] **Step 6: Add responsive styles**

Use existing surface, line, accent, button, and notebook tokens. Keep all controls at least 44 pixels high, let long captain names wrap safely, and verify archive/replay containers have `max-width: 100%` and no horizontal overflow at 390 pixels.

- [x] **Step 7: Run focused tests and verify GREEN**

Run: `node --test tests/i18n.test.mjs tests/auth-ui.test.mjs tests/replay.test.mjs tests/ux-redesign.test.mjs`

Expected: all frontend and localization tests PASS.

### Task 8: Verify, Migrate, And Deploy

**Files:**
- Verify: all modified files

- [x] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: zero failures.

- [x] **Step 2: Run enforced coverage**

Run: `npm run coverage`

Expected: line coverage remains at or above 98%.

- [x] **Step 3: Build and inspect the patch**

Run: `npm run build`

Expected: `dist` builds successfully.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Verify the browser flows locally**

Partial verification completed on desktop and 390x844: the unauthenticated deep
link gate, URL cleanup, 44-pixel controls, console, and page overflow are clean.
The in-app browser blocked the isolated authenticated mock origin, so the real
archive/replay content remains a post-deployment authenticated smoke check.

Run `npm start`, then use the in-app browser to verify:

- archive empty/loading/error/list/Load more states;
- a direct replay query before and after auth restoration;
- desktop dual boards;
- 390x844 tabs, complete labels, 44-pixel controls, and no overflow;
- timeline seek, autoplay interruption, key moments, Copy link, Back, and Main menu;
- no console errors.

- [x] **Step 5: Review the diff**

Request a focused code review for privacy, ACL, idempotency, alarm lifecycle, migration safety, replay reconstruction, and mobile usability. Fix all Critical and Important findings and rerun verification.

- [ ] **Step 6: Commit application changes**

```bash
git add migrations/0002_online_replays.sql worker/replay.js worker/index.js worker/profile.js \
  src/core/replay.js src/app.js src/i18n.js src/styles.css \
  tests/replay-archive.test.mjs tests/worker.test.mjs tests/profile.test.mjs \
  tests/replay.test.mjs tests/auth-ui.test.mjs tests/i18n.test.mjs tests/ux-redesign.test.mjs \
  docs/superpowers/plans/2026-07-11-online-replay-archive.md
git commit -m "feat: add private online replays"
```

- [ ] **Step 7: Apply migration and deploy the Worker**

Run: `npx wrangler d1 migrations apply agents-salvo-profile --remote`

Expected: migration `0002_online_replays.sql` applies successfully.

Run: `npx wrangler deploy`

Expected: Worker deployment succeeds and reports the `agents-salvo-room` URL.

- [ ] **Step 8: Push Pages and verify production**

Run: `git push`

Wait for the GitHub Pages workflow with `gh run watch --exit-status`. Verify the public root returns HTTP 200 and the deployed bundle contains archive/replay actions. Verify the Worker replay endpoint rejects an unauthenticated request with `401`.
