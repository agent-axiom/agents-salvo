# Online Replay Archive Design

**Date:** 2026-07-11
**Status:** Approved for implementation planning

## Goal

Store every completed authenticated online battle permanently and let either participant reopen an interactive replay from their private match archive or a direct authenticated link.

## Scope

This release includes:

- server-authored replay snapshots for completed online battles;
- permanent D1 storage and participant-only access;
- resilient, idempotent recording with Durable Object alarm retries;
- a paginated archive for the signed-in player;
- a dedicated desktop and mobile replay screen;
- deep links that resume after Telegram authentication;
- English, Russian, and Simplified Chinese UI;
- migrations, automated tests, CI coverage, Worker deployment, and GitHub Pages deployment.

This release does not include public replays, replay discovery, spectator access, downloadable replay files, comments, or replays for agent and same-device matches.

## Chosen Architecture

Use one versioned JSON replay snapshot in D1. The Durable Object remains the authoritative source because it owns both legal boards and the server-generated shot log. The browser never uploads an online replay or chooses its winner, participants, or moves.

Online setup boards and fire coordinates remain untrusted input. Before they enter
room state, the Worker reconstructs a pristine board from the exact preset fleet
and marker identities, rejects pre-existing hits or shots, and allocates every
coordinate from integer `row` and `col` values only. Unknown nested fields are
never cloned into game, outbox, replay, or recovery data.

Normalized per-move SQL storage was rejected because it creates many writes and joins without a current analytics requirement. Durable Object-only storage was rejected because rooms are coordination objects, not a convenient permanent, searchable profile archive.

## Data Model

Add migration `0002_online_replays.sql`.

### `battle_replays`

| Column | Type | Purpose |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Stable replay identifier generated once by the room |
| `p1_user_key` | `TEXT NOT NULL` | Internal participant authorization key |
| `p2_user_key` | `TEXT NOT NULL` | Internal participant authorization key |
| `preset_id` | `TEXT NOT NULL` | Ruleset used by the battle |
| `winner_id` | `TEXT NOT NULL` | `p1` or `p2` |
| `finished_at` | `TEXT NOT NULL` | Battle completion timestamp |
| `data_json` | `TEXT NOT NULL` | Versioned replay payload |
| `created_at` | `TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP` | Storage timestamp |

The replay primary key supports direct ACL reads. Archive pagination starts from the
signed-in participant's match rows, so the supporting composite index is
`(user_key, mode, played_at DESC, id DESC)`.

Add nullable `replay_id TEXT` to `matches` and index it both directly and through
the participant archive index. Existing rows remain valid and simply have no
replay action.

## Replay Payload

`data_json` uses this stable version-one shape:

```json
{
  "version": 1,
  "presetId": "classic",
  "winnerId": "p1",
  "finishedAt": "2026-07-11T12:00:00.000Z",
  "players": {
    "p1": { "name": "Captain One", "username": "captain_one" },
    "p2": { "name": "Captain Two", "username": "captain_two" }
  },
  "boards": {
    "p1": { "size": 10, "ships": [], "markers": [], "shots": [] },
    "p2": { "size": 10, "ships": [], "markers": [], "shots": [] }
  },
  "log": []
}
```

Boards are trusted final board clones from the server game state. Log entries retain the shooter, target, coordinate, result, and ship identifier when present. The API response never exposes Telegram numeric IDs, D1 `user_key` values, bearer tokens, or room player tokens.

## Recording Flow

1. When a fire action finishes a battle, the Durable Object generates a stable
   `replayId` and creates an immutable recording payload before broadcasting the
   result.
2. That payload is stored in a separate Durable Object outbox. The finished room,
   immutable job, and its due-time schedule become durable together with an alarm
   already established. The job is not embedded in the mutable room snapshot and
   cannot overwrite later rematch state after an awaited D1 call.
3. One D1 `batch()` transaction inserts the replay and both participant match
   rows. Both rows use IDs derived from `replayId` and `playerId` and receive the
   same `replay_id`.
4. Duplicate completion and alarm delivery are idempotent. Rating movement for a
   replay is derived from the stored match position, so retrying the transaction
   cannot change or erase the displayed delta.
5. A D1 failure does not block the finished snapshot, result broadcast, room
   actions, or a prepared rematch. The outbox entry records retry metadata and a
   Durable Object alarm processes it independently from the active room.
6. Retries start after 30 seconds, double after each failure, cap at 15 minutes,
   and stop after 12 failed attempts. Schedule keys sort by due time, and each
   alarm handles a bounded batch before scheduling the next due item.
7. A terminal persistence entry retains the complete immutable envelope as a
   dead-letter record, supports an internal requeue operation, and emits Worker
   telemetry without preventing subsequent games. A payload-construction failure
   retains an allowlisted recovery snapshot without room tokens and can be
   requeued only with an explicitly supplied repaired envelope.
8. Missing `DB` configuration and malformed immutable recording payloads are
   terminal configuration/data errors. They do not create an alarm loop.

## Authorization And Privacy

All replay and archive endpoints require a valid Telegram session bearer token.

`GET /replays/:id` loads the row, derives the current `userSubject()`, and returns data only when it matches `p1_user_key` or `p2_user_key`. The response includes `viewerPlayerId` so the client can label its perspective without receiving internal keys.

Status behavior:

- `401`: no or invalid session;
- `403`: authenticated user was not a participant;
- `404`: replay does not exist;
- `503`: D1 is unavailable or the stored replay payload is unsupported/corrupt.

Replay URLs are not security credentials. Knowing an ID never bypasses participant authorization.

## API

### `GET /profile/replays`

Returns the signed-in player's online replay metadata in reverse chronological
order, 20 items per request, including legacy online rows without a replay.
Cursor pagination uses a base64url-encoded JSON pair of `finishedAt` and the
stable match-row `id`; it does not use mutable offsets. The first page and
cursor pages use separate SQL statements, and cursor pages apply tuple keyset
range `(played_at, id) < (?, ?)`. Invalid cursors return `400`.

Each item includes a stable archive-row ID, nullable replay ID,
participant-facing opponent name, result, preset, winner, turn count, accuracy,
and completion time. The response includes `nextCursor` when more items exist.

### `GET /replays/:id`

Returns:

```json
{
  "replay": {
    "id": "...",
    "viewerPlayerId": "p1",
    "version": 1,
    "presetId": "classic",
    "winnerId": "p1",
    "finishedAt": "...",
    "players": {},
    "boards": {},
    "log": []
  }
}
```

The profile response also exposes nullable `replayId` on recent online matches so the compact profile can open a replay directly.

## Frontend Navigation

GitHub Pages continues to serve one static entry point. Replay deep links use a query parameter:

```text
https://agent-axiom.github.io/agents-salvo/?replay=<id>
```

On startup:

1. parse the replay parameter;
2. restore the saved Telegram session;
3. show a localized sign-in gate when authentication is missing;
4. automatically fetch the requested replay after successful authentication;
5. show a dedicated replay error state for `403`, `404`, or network failure.

Opening a replay or archive updates browser history. Returning to the archive or main menu removes the replay query parameter so reloads are deterministic.

## Archive UX

The authenticated profile exposes an **Archive** command. It opens a dedicated screen rather than expanding the profile popover.

The archive lists 20 battles per page with:

- result;
- opponent;
- localized battle format;
- completion date;
- accuracy and shot count;
- a replay command when `replayId` exists.

“Load more” appends the next cursor page without discarding existing entries. Empty, loading, retry, and error states are explicit. Existing historical matches without `replayId` remain visible but have no replay command.

## Replay UX

The replay is a full screen, not a result modal.

Desktop displays both final boards side by side. Mobile uses **Opponent field** and **My fleet** tabs. Both boards reveal their ships because the battle is complete, while shots accumulate according to the selected turn. The active shot pulses on the correct target board.

The screen reuses the existing replay behavior:

- Play/Pause;
- 1x, 1.5x, and 2x speed;
- Previous and Next;
- a 44-pixel range seek control;
- jumps to first contact, first sinking, longest miss streak, and final shot;
- focus, scroll, live announcements, and reduced-motion behavior.

The header identifies both captains, winner, ruleset, and completion date. Commands include **Copy link**, **Back to archive**, and **Main menu**. A copied link remains useful only to the other authenticated participant.

## Error Handling

- Invalid JSON or unsupported stored replay versions fail closed with a generic
  `503`; the Worker logs only the replay ID and never renders a partial board.
- Network failures preserve the requested replay ID and expose Retry.
- Authentication expiry returns to the sign-in gate and retries after a new login.
- Autoplay stops when leaving the replay screen, opening another replay, or changing identity.
- An archive request cannot expose another player's rows because participant filtering occurs in SQL and is repeated by the replay endpoint ACL.

## Testing

### Core and storage

- replay snapshot serialization and version validation;
- participant projection without private identifiers;
- deterministic/idempotent D1 inserts;
- rematch IDs cannot collide;
- cursor encode/decode and stable pagination;
- existing rows with null `replay_id` remain valid.

### Worker

- room completion writes one replay and two linked match rows;
- duplicate completion/retry does not duplicate rows;
- replay and both match rows commit atomically, including a partial-failure retry;
- a deferred D1 completion cannot overwrite a concurrently prepared rematch;
- alarm retries after transient D1 failure and dead-letters terminal/exhausted work
  without blocking gameplay;
- dead letters preserve and can requeue the complete immutable recording envelope;
- setup and fire payloads cannot inject unknown fields, prior damage, or room
  credentials into room/replay/recovery state;
- due-time schedules and alarm processing remain bounded as a backlog grows;
- authenticated participant reads succeed;
- unauthenticated, non-participant, missing, corrupt, and unavailable-DB cases return the specified status;
- archive queries return only the signed-in participant's battles.
- the participant archive query includes legacy null-replay rows and uses the composite pagination index under real
  SQLite `EXPLAIN QUERY PLAN`.

### Frontend

- boot-time replay query handling;
- post-login replay resume;
- archive pagination and empty/error states;
- replay buttons appear only for rows with `replayId`;
- two-board turn reconstruction and active-shot placement;
- autoplay cleanup, focus restoration, live announcements, and URL cleanup;
- EN/RU/ZH labels;
- desktop and 390x844 browser verification with no overlap or horizontal overflow.

The existing CI line-coverage floor remains 98%.

## Deployment

Deployment order prevents the frontend from referencing unavailable APIs:

1. apply D1 migration `0002_online_replays.sql` remotely;
2. deploy the Worker;
3. deploy GitHub Pages through the existing workflow;
4. complete an authenticated online battle;
5. verify both participant archive access and a `403` response for a third account where available;
6. verify the permanent deep link after a fresh browser load.
