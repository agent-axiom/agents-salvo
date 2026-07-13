import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_BATTLE_SNAPSHOT_VERSION,
  createLocalBattleSnapshot,
  createLocalBattleSnapshotStore,
  parseLocalBattleSnapshot,
} from "../src/core/local-battle-snapshot.js";

const NOW = "2026-07-13T12:00:00.000Z";
const SNAPSHOT_KEYS = [
  "version",
  "savedAt",
  "screen",
  "mode",
  "presetId",
  "setupPlayerId",
  "setupBoard",
  "setupOrientation",
  "setupSelectedShipId",
  "boards",
  "game",
  "battleTab",
  "agentDifficulty",
  "passPlayerId",
  "training",
];

function board(id) {
  return {
    size: 10,
    ships: [
      {
        id,
        length: 1,
        cells: [{ row: 1, col: 2 }],
        hits: [],
      },
    ],
    shots: [],
    markers: [],
  };
}

function localState(overrides = {}) {
  const p1Board = board("p1-submarine");
  const p2Board = board("p2-submarine");

  return {
    language: "en",
    theme: "dark",
    settingsOpen: true,
    screen: "playing",
    mode: "agent",
    presetId: "classic",
    setupPlayerId: "p1",
    setupBoard: board("setup-submarine"),
    setupOrientation: "horizontal",
    setupSelectedShipId: "setup-submarine",
    setupHover: { row: 3, col: 4 },
    setupError: "unrelated-ui-state",
    boards: { p1: p1Board, p2: p2Board },
    game: {
      phase: "playing",
      currentPlayerId: "p1",
      winnerId: null,
      presetId: "classic",
      boards: { p1: p1Board, p2: p2Board },
      log: [
        {
          playerId: "p1",
          coordinate: { row: 5, col: 6 },
          result: "hit",
        },
      ],
    },
    battleTab: "target",
    agentDifficulty: "hard",
    passPlayerId: null,
    training: {
      scenarioId: "checkerboard",
      session: null,
      progress: { checkerboard: { completed: 2 } },
    },
    auth: { token: "secret-auth-token", user: { id: "private-user" } },
    profile: { data: { private: true } },
    online: { session: { token: "secret-room-token" } },
    sessionToken: "secret-top-level-token",
    unrelatedCallback() {},
    ...overrides,
  };
}

function trainingState(overrides = {}) {
  return localState({
    mode: "training",
    screen: "training",
    game: null,
    training: {
      scenarioId: "checkerboard",
      session: {
        phase: "playing",
        shots: 3,
        board: board("training-submarine"),
      },
      progress: { checkerboard: { completed: 2 } },
    },
    ...overrides,
  });
}

function expectedSnapshot(state) {
  return {
    version: LOCAL_BATTLE_SNAPSHOT_VERSION,
    savedAt: NOW,
    screen: state.screen,
    mode: state.mode,
    presetId: state.presetId,
    setupPlayerId: state.setupPlayerId,
    setupBoard: state.setupBoard,
    setupOrientation: state.setupOrientation,
    setupSelectedShipId: state.setupSelectedShipId,
    boards: state.boards,
    game: state.game,
    battleTab: state.battleTab,
    agentDifficulty: state.agentDifficulty,
    passPlayerId: state.passPlayerId,
    training: state.training,
  };
}

function validSnapshot(overrides = {}) {
  return {
    ...createLocalBattleSnapshot(localState(), () => NOW),
    ...overrides,
  };
}

function memorySettings(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];

  return {
    calls,
    values,
    async get(key) {
      calls.push(["get", key]);
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      calls.push(["set", key, value]);
      if (value === null) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

const roundTripStates = [
  ["agent setup", () => localState({ screen: "setup", game: null })],
  ["agent battle", () => localState()],
  [
    "hotseat setup",
    () => localState({ mode: "hotseat", screen: "setup", game: null }),
  ],
  ["hotseat battle", () => localState({ mode: "hotseat" })],
  [
    "hotseat pass",
    () => localState({ mode: "hotseat", screen: "pass", passPlayerId: "p2" }),
  ],
  ["training session", () => trainingState()],
];

for (const [name, makeState] of roundTripStates) {
  test(`${name} round-trips through a versioned snapshot`, () => {
    const state = makeState();
    const snapshot = createLocalBattleSnapshot(state, () => NOW);

    assert.equal(LOCAL_BATTLE_SNAPSHOT_VERSION, 1);
    assert.deepEqual(snapshot, expectedSnapshot(state));
    assert.deepEqual(parseLocalBattleSnapshot(JSON.stringify(snapshot)), snapshot);
  });
}

test("snapshot creation and parsing detach nested mutable state", () => {
  const state = trainingState();
  const snapshot = createLocalBattleSnapshot(state, () => NOW);

  snapshot.setupBoard.ships[0].id = "snapshot-only";
  state.training.session.board.ships[0].id = "state-only";

  assert.equal(state.setupBoard.ships[0].id, "setup-submarine");
  assert.equal(
    snapshot.training.session.board.ships[0].id,
    "training-submarine",
  );

  const raw = JSON.stringify(createLocalBattleSnapshot(trainingState(), () => NOW));
  const first = parseLocalBattleSnapshot(raw);
  const second = parseLocalBattleSnapshot(raw);
  first.training.session.board.ships[0].id = "first-only";

  assert.equal(second.training.session.board.ships[0].id, "training-submarine");
});

test("training snapshots ignore a stale finished local game", () => {
  const state = trainingState({
    game: { ...localState().game, phase: "finished" },
  });
  const snapshot = createLocalBattleSnapshot(state, () => NOW);

  assert.notEqual(snapshot, null);
  assert.equal(snapshot.training.session.phase, "playing");
  assert.equal(snapshot.game.phase, "finished");
});

test("parse accepts live training with a stale finished local game", () => {
  const snapshot = createLocalBattleSnapshot(trainingState(), () => NOW);
  const withStaleGame = {
    ...snapshot,
    game: { ...localState().game, phase: "finished" },
  };

  assert.deepEqual(
    parseLocalBattleSnapshot(JSON.stringify(withStaleGame)),
    withStaleGame,
  );
});

for (const mode of ["agent", "hotseat"]) {
  test(`${mode} snapshots ignore stale finished training data`, () => {
    const state = localState({
      mode,
      training: {
        ...trainingState().training,
        session: { ...trainingState().training.session, phase: "finished" },
      },
    });
    const snapshot = createLocalBattleSnapshot(state, () => NOW);

    assert.notEqual(snapshot, null);
    assert.equal(snapshot.game.phase, "playing");
    assert.equal(snapshot.training.session.phase, "finished");
  });

  test(`parse accepts a live ${mode} game with stale finished training data`, () => {
    const snapshot = createLocalBattleSnapshot(localState({ mode }), () => NOW);
    const withStaleTraining = {
      ...snapshot,
      training: {
        ...trainingState().training,
        session: { ...trainingState().training.session, phase: "finished" },
      },
    };

    assert.deepEqual(
      parseLocalBattleSnapshot(JSON.stringify(withStaleTraining)),
      withStaleTraining,
    );
  });
}

test("online and finished battles are never serialized", () => {
  assert.equal(
    createLocalBattleSnapshot(
      localState({ mode: "online", screen: "online" }),
      () => NOW,
    ),
    null,
  );
  assert.equal(
    createLocalBattleSnapshot(
      localState({ game: { ...localState().game, phase: "finished" } }),
      () => NOW,
    ),
    null,
  );
  assert.equal(
    createLocalBattleSnapshot(
      trainingState({
        training: {
          ...trainingState().training,
          session: { ...trainingState().training.session, phase: "finished" },
        },
      }),
      () => NOW,
    ),
    null,
  );
});

test("unsupported local mode and screen pairs are never serialized", () => {
  const unsupportedPairs = [
    ["agent", "pass"],
    ["agent", "training"],
    ["hotseat", "training"],
    ["training", "setup"],
    ["training", "playing"],
    ["training", "pass"],
    ["unknown", "setup"],
    [null, "setup"],
  ];

  for (const [mode, screen] of unsupportedPairs) {
    assert.equal(
      createLocalBattleSnapshot(localState({ mode, screen }), () => NOW),
      null,
      `${String(mode)}/${screen}`,
    );
  }
});

test("parse rejects malformed and non-JSON input", () => {
  for (const raw of ["{bad", "", undefined, {}, 42]) {
    assert.throws(() => parseLocalBattleSnapshot(raw));
  }
});

test("parse rejects arrays, null, and primitive JSON values", () => {
  for (const raw of ["[]", "null", "true", "42", '"snapshot"']) {
    assert.throws(() => parseLocalBattleSnapshot(raw));
  }
});

test("parse rejects unsupported snapshot versions", () => {
  for (const version of [undefined, null, 0, 2, "1"]) {
    assert.throws(() =>
      parseLocalBattleSnapshot(JSON.stringify(validSnapshot({ version }))),
    );
  }
});

test("parse rejects unsupported mode and screen pairs", () => {
  const unsupportedPairs = [
    ["online", "online"],
    ["agent", "pass"],
    ["hotseat", "training"],
    ["training", "playing"],
    ["unknown", "setup"],
  ];

  for (const [mode, screen] of unsupportedPairs) {
    assert.throws(() =>
      parseLocalBattleSnapshot(
        JSON.stringify(validSnapshot({ mode, screen })),
      ),
    );
  }
});

test("parse rejects missing or empty preset identifiers", () => {
  for (const presetId of [undefined, null, "", "   ", 10]) {
    assert.throws(() =>
      parseLocalBattleSnapshot(JSON.stringify(validSnapshot({ presetId }))),
    );
  }
});

test("parse rejects invalid saved timestamps", () => {
  for (const savedAt of [
    undefined,
    null,
    "",
    "not-a-date",
    "2026-02-30T12:00:00.000Z",
    1_752_408_000_000,
  ]) {
    assert.throws(() =>
      parseLocalBattleSnapshot(JSON.stringify(validSnapshot({ savedAt }))),
    );
  }
});

test("parse rejects finished game and training state", () => {
  const finishedGame = validSnapshot({
    game: { ...validSnapshot().game, phase: "finished" },
  });
  const training = createLocalBattleSnapshot(trainingState(), () => NOW);
  const finishedTraining = {
    ...training,
    training: {
      ...training.training,
      session: { ...training.training.session, phase: "finished" },
    },
  };

  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(finishedGame)));
  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(finishedTraining)));
});

test("creation and parsing whitelist snapshot fields and exclude credentials", () => {
  const state = localState();
  const snapshot = createLocalBattleSnapshot(state, () => NOW);
  const rawWithExtras = JSON.stringify({
    ...snapshot,
    auth: state.auth,
    profile: state.profile,
    online: state.online,
    sessionToken: state.sessionToken,
    settingsOpen: state.settingsOpen,
    setupHover: state.setupHover,
  });
  const parsed = parseLocalBattleSnapshot(rawWithExtras);

  assert.deepEqual(Object.keys(snapshot), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(parsed), SNAPSHOT_KEYS);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  for (const key of [
    "auth",
    "profile",
    "online",
    "sessionToken",
    "settingsOpen",
    "setupHover",
  ]) {
    assert.equal(Object.hasOwn(snapshot, key), false);
    assert.equal(Object.hasOwn(parsed, key), false);
  }
});

test("store save persists and load restores a detached snapshot", async () => {
  const settings = memorySettings();
  const snapshots = createLocalBattleSnapshotStore(settings, { now: () => NOW });
  const state = localState();

  await snapshots.save(state);
  const raw = settings.values.get("localBattle");
  state.game.log[0].result = "miss";
  const restored = await snapshots.load();

  assert.equal(typeof raw, "string");
  assert.deepEqual(restored, parseLocalBattleSnapshot(raw));
  assert.equal(restored.game.log[0].result, "hit");
  assert.deepEqual(settings.calls, [
    ["set", "localBattle", raw],
    ["get", "localBattle"],
  ]);
});

test("store save clears the active key when state is not persistable", async () => {
  const settings = memorySettings({ localBattle: "stale" });
  const snapshots = createLocalBattleSnapshotStore(settings, { now: () => NOW });

  await snapshots.save(localState({ mode: "online", screen: "online" }));

  assert.equal(settings.values.has("localBattle"), false);
  assert.deepEqual(settings.calls, [["set", "localBattle", null]]);
});

test("store load returns null without writes when no snapshot is present", async () => {
  for (const absent of [null, undefined]) {
    const calls = [];
    const settings = {
      async get(key) {
        calls.push(["get", key]);
        return absent;
      },
      async set(key, value) {
        calls.push(["set", key, value]);
      },
    };
    const snapshots = createLocalBattleSnapshotStore(settings);

    assert.equal(await snapshots.load(), null);
    assert.deepEqual(calls, [["get", "localBattle"]]);
  }
});

test("store clear removes only the active snapshot key", async () => {
  const settings = memorySettings({
    localBattle: "saved",
    localBattleQuarantine: "older-corrupt-value",
  });
  const snapshots = createLocalBattleSnapshotStore(settings);

  await snapshots.clear();

  assert.equal(settings.values.has("localBattle"), false);
  assert.equal(
    settings.values.get("localBattleQuarantine"),
    "older-corrupt-value",
  );
  assert.deepEqual(settings.calls, [["set", "localBattle", null]]);
});

test("corrupt snapshots are quarantined under the exact key before removal", async () => {
  const raw = "{bad";
  const settings = memorySettings({ localBattle: raw });
  const snapshots = createLocalBattleSnapshotStore(settings);

  assert.equal(await snapshots.load(), null);
  assert.equal(settings.values.has("localBattle"), false);
  assert.equal(settings.values.get("localBattleQuarantine"), raw);
  assert.deepEqual(settings.calls, [
    ["get", "localBattle"],
    ["set", "localBattleQuarantine", raw],
    ["set", "localBattle", null],
  ]);
});

test("unsupported snapshots are quarantined without rewriting the raw value", async () => {
  const raw = JSON.stringify(
    validSnapshot({ mode: "online", screen: "online" }),
  );
  const settings = memorySettings({ localBattle: raw });
  const snapshots = createLocalBattleSnapshotStore(settings);

  assert.equal(await snapshots.load(), null);
  assert.equal(settings.values.get("localBattleQuarantine"), raw);
  assert.equal(settings.values.has("localBattle"), false);
});

test("settings read failures reject without being quarantined", async () => {
  const failure = new Error("settings read failed");
  const writes = [];
  const snapshots = createLocalBattleSnapshotStore({
    async get() {
      throw failure;
    },
    async set(key, value) {
      writes.push([key, value]);
    },
  });

  await assert.rejects(snapshots.load(), (error) => error === failure);
  assert.deepEqual(writes, []);
});

test("settings write failures from save and clear propagate without quarantine", async () => {
  for (const operation of ["save", "clear"]) {
    const failure = new Error(`${operation} write failed`);
    const writes = [];
    const snapshots = createLocalBattleSnapshotStore({
      async get() {
        return null;
      },
      async set(key, value) {
        writes.push([key, value]);
        throw failure;
      },
    }, { now: () => NOW });

    await assert.rejects(
      operation === "save" ? snapshots.save(localState()) : snapshots.clear(),
      (error) => error === failure,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], "localBattle");
  }
});

test("quarantine write failures reject before the corrupt active value is cleared", async () => {
  const raw = "{bad";
  const failure = new Error("quarantine write failed");
  const writes = [];
  const snapshots = createLocalBattleSnapshotStore({
    async get() {
      return raw;
    },
    async set(key, value) {
      writes.push([key, value]);
      throw failure;
    },
  });

  await assert.rejects(snapshots.load(), (error) => error === failure);
  assert.deepEqual(writes, [["localBattleQuarantine", raw]]);
});
