import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_BATTLE_SNAPSHOT_VERSION,
  UnsupportedLocalBattleSnapshotVersionError,
  createLocalBattleSnapshot,
  createLocalBattleSnapshotStore,
  parseLocalBattleSnapshot,
} from "../src/core/local-battle-snapshot.js";
import {
  createGameFromBoards,
  fireAt,
  randomlyPlaceSetup,
} from "../src/core/game.js";
import { getGamePreset } from "../src/core/presets.js";
import {
  applyTrainingShot,
  createTrainingSession,
} from "../src/core/training.js";

const NOW = "2026-07-13T12:00:00.000Z";
const NESTED_SECRET = "secret-nested-value";
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

function completeBoard(presetId = "classic", rngValue = 0) {
  return randomlyPlaceSetup(getGamePreset(presetId), () => rngValue);
}

function liveBattle(presetId = "classic", { withShot = true } = {}) {
  const preset = getGamePreset(presetId);
  const p1Board = completeBoard(presetId, 0);
  const p2Board = completeBoard(presetId, 0.75);
  const started = createGameFromBoards(p1Board, p2Board, "p1", {
    presetId,
    rules: preset.rules,
  });
  const target = started.players.p2.board.ships[0].cells[0];
  const game = withShot ? fireAt(started, "p1", target).game : started;

  return {
    boards: { p1: p1Board, p2: p2Board },
    game,
  };
}

function firstWaterCoordinate(board) {
  for (let row = 0; row < board.size; row += 1) {
    for (let col = 0; col < board.size; col += 1) {
      const occupied =
        board.ships.some((ship) =>
          ship.cells.some((cell) => cell.row === row && cell.col === col),
        ) ||
        board.markers.some(
          (marker) => marker.cell.row === row && marker.cell.col === col,
        );
      if (!occupied) {
        return { row, col };
      }
    }
  }
  throw new Error("Expected an unoccupied board coordinate");
}

function battleAfterHumanMiss() {
  const battle = liveBattle("classic", { withShot: false });
  const coordinate = firstWaterCoordinate(battle.game.players.p2.board);
  return {
    boards: battle.boards,
    game: fireAt(battle.game, "p1", coordinate).game,
  };
}

function firstUnshotCoordinate(game, playerId) {
  const targetPlayerId = playerId === "p1" ? "p2" : "p1";
  const board = game.players[targetPlayerId].board;
  for (let row = 0; row < board.size; row += 1) {
    for (let col = 0; col < board.size; col += 1) {
      if (!board.shots.some((shot) => shot.row === row && shot.col === col)) {
        return { row, col };
      }
    }
  }
  throw new Error("Expected an unshot board coordinate");
}

function localStateForOutcome(result) {
  const presetId = result === "mine" || result === "sweeper" ? "perelman" : "classic";
  const preset = getGamePreset(presetId);
  const p1Board = completeBoard(presetId, 0);
  const p2Board = completeBoard(presetId, 0.75);
  const started = createGameFromBoards(p1Board, p2Board, "p1", {
    presetId,
    rules: preset.rules,
  });
  const targetBoard = started.players.p2.board;
  let coordinate;
  if (result === "miss") {
    coordinate = firstWaterCoordinate(targetBoard);
  } else if (result === "hit") {
    coordinate = targetBoard.ships.find((ship) => ship.length > 1).cells[0];
  } else if (result === "sunk") {
    coordinate = targetBoard.ships.find((ship) => ship.length === 1).cells[0];
  } else {
    coordinate = targetBoard.markers.find((marker) => marker.type === result).cell;
  }
  const game = fireAt(started, "p1", coordinate).game;
  if (game.log.at(-1).result !== result) {
    throw new Error(`Expected ${result} outcome`);
  }
  return localState({
    mode: "hotseat",
    presetId,
    boards: { p1: p1Board, p2: p2Board },
    game,
  });
}

function outcomeShot(value, result) {
  return value.game.players.p2.board.shots.find(
    (shot) => shot.result === result,
  );
}

function addOutcomeInapplicableIds(value, result) {
  const shot = outcomeShot(value, result);
  if (result === "miss") {
    shot.shipId = NESTED_SECRET;
    shot.markerId = NESTED_SECRET;
  } else if (result === "hit" || result === "sunk") {
    shot.markerId = NESTED_SECRET;
  } else {
    shot.shipId = NESTED_SECRET;
  }
  value.game.log.at(-1).markerId = NESTED_SECRET;
  value.game.log.at(-1).privateToken = NESTED_SECRET;
}

function assertNormalizedOutcomeIds(value, result) {
  const shot = outcomeShot(value, result);
  const logEntry = value.game.log.at(-1);
  assert.equal(hasNestedSecret(value), false, result);
  if (result === "miss") {
    assert.equal(Object.hasOwn(shot, "shipId"), false, result);
    assert.equal(Object.hasOwn(shot, "markerId"), false, result);
  } else if (result === "hit" || result === "sunk") {
    assert.equal(typeof shot.shipId, "string", result);
    assert.equal(Object.hasOwn(shot, "markerId"), false, result);
  } else {
    assert.equal(typeof shot.markerId, "string", result);
    assert.equal(Object.hasOwn(shot, "shipId"), false, result);
  }
  assert.equal(
    logEntry.shipId,
    result === "hit" || result === "sunk" ? shot.shipId : null,
    result,
  );
  assert.equal(Object.hasOwn(logEntry, "markerId"), false, result);
  assert.equal(Object.hasOwn(logEntry, "privateToken"), false, result);
}

function trainingProgress() {
  return {
    checkerboard: {
      completions: 2,
      bestScore: 8,
      bestAccuracy: 75,
      bestRatingId: "steady",
      lastPlayedAt: "2026-07-12T12:00:00.000Z",
    },
    daily: {
      date: "2026-07-13",
      completions: 2,
      completedScenarioIds: ["checkerboard", "lineFinish"],
      goalCompletedDate: "",
      streak: 1,
      bestStreak: 2,
      awards: ["firstWatch"],
    },
  };
}

function localState(overrides = {}) {
  const battle = liveBattle();

  return {
    language: "en",
    theme: "dark",
    settingsOpen: true,
    screen: "playing",
    mode: "agent",
    presetId: "classic",
    setupPlayerId: "p1",
    setupBoard: completeBoard(),
    setupOrientation: "horizontal",
    setupSelectedShipId: "",
    setupHover: { row: 3, col: 4 },
    setupError: "unrelated-ui-state",
    boards: battle.boards,
    game: battle.game,
    battleTab: "target",
    agentDifficulty: "hard",
    passPlayerId: null,
    training: {
      scenarioId: "checkerboard",
      session: null,
      progress: trainingProgress(),
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
  const session = applyTrainingShot(
    createTrainingSession("checkerboard"),
    { row: 0, col: 0 },
  );
  return localState({
    mode: "training",
    screen: "training",
    game: null,
    training: {
      scenarioId: "checkerboard",
      session,
      progress: trainingProgress(),
    },
    ...overrides,
  });
}

function setupState(mode = "agent", overrides = {}) {
  return localState({
    mode,
    screen: "setup",
    boards: { p1: null, p2: null },
    game: null,
    passPlayerId: null,
    ...overrides,
  });
}

function handoffPassState(overrides = {}) {
  return setupState("hotseat", {
    screen: "pass",
    setupPlayerId: "p2",
    boards: { p1: completeBoard(), p2: null },
    passPlayerId: "p2",
    ...overrides,
  });
}

function gamePassState(overrides = {}) {
  const battle = liveBattle("classic", { withShot: false });
  const state = localState({
    mode: "hotseat",
    screen: "pass",
    boards: battle.boards,
    game: battle.game,
  });
  return {
    ...state,
    passPlayerId: state.game.currentPlayerId,
    ...overrides,
  };
}

function validSnapshot(overrides = {}) {
  return {
    ...createLocalBattleSnapshot(localState(), () => NOW),
    ...overrides,
  };
}

async function withObjectPrototypeDescriptors(fields, callback) {
  const previousDescriptors = new Map(
    fields.map(([field]) => [
      field,
      Object.getOwnPropertyDescriptor(Object.prototype, field),
    ]),
  );

  try {
    for (const [field, descriptor] of fields) {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        ...descriptor,
      });
    }
    return await callback();
  } finally {
    for (const [field] of [...fields].reverse()) {
      const previousDescriptor = previousDescriptors.get(field);
      if (previousDescriptor) {
        Object.defineProperty(Object.prototype, field, previousDescriptor);
      } else {
        delete Object.prototype[field];
      }
    }
  }
}

function withObjectPrototypeFields(fields, callback) {
  return withObjectPrototypeDescriptors(
    fields.map(([field, value]) => [field, { value, writable: true }]),
    callback,
  );
}

function withObjectPrototypeField(field, value, callback) {
  return withObjectPrototypeFields([[field, value]], callback);
}

function inheritedRequiredFieldCases() {
  const perelmanSetup = () =>
    setupState("agent", {
      presetId: "perelman",
      setupBoard: completeBoard("perelman"),
      setupSelectedShipId: "",
    });
  const topLevel = (value) => value;
  const setupBoard = (value) => value.setupBoard;
  const firstShip = (value) => value.setupBoard.ships[0];
  const firstMarker = (value) => value.setupBoard.markers[0];
  const firstShipCell = (value) => value.setupBoard.ships[0].cells[0];
  const trainingSession = (value) => value.training.session;

  return [
    ["top-level mode", "mode", localState, topLevel],
    ["top-level screen", "screen", localState, topLevel],
    ["top-level preset id", "presetId", localState, topLevel],
    ["top-level agent difficulty", "agentDifficulty", localState, topLevel],
    ["top-level boards", "boards", localState, topLevel],
    ["top-level game", "game", localState, topLevel],
    ["V1 saved timestamp", "savedAt", localState, topLevel, true],
    ["setup payload", "setupBoard", setupState, topLevel],
    ["pass payload", "passPlayerId", gamePassState, topLevel],
    ["training payload", "training", trainingState, topLevel],
    ["board ships array", "ships", setupState, setupBoard],
    ["ship length", "length", setupState, firstShip],
    ["marker type", "type", perelmanSetup, firstMarker],
    ["coordinate row", "row", setupState, firstShipCell],
    ["coordinate column", "col", setupState, firstShipCell],
    ["game log", "log", localState, (value) => value.game],
    ["training session", "session", trainingState, (value) => value.training],
    ["session phase", "phase", trainingState, trainingSession],
    ["session log", "log", trainingState, trainingSession],
    [
      "training log coordinate",
      "coordinate",
      trainingState,
      (value) => value.training.session.log[0],
    ],
  ].map(([name, field, makeState, target, parseOnly = false]) => ({
    name,
    field,
    makeState,
    target,
    parseOnly,
  }));
}

function addBoardExtras(board) {
  board.privateToken = NESTED_SECRET;
  board.ships[0].privateToken = NESTED_SECRET;
  board.ships[0].cells[0].privateToken = NESTED_SECRET;
  if (board.ships[0].hits[0]) {
    board.ships[0].hits[0].privateToken = NESTED_SECRET;
  }
  if (board.markers[0]) {
    board.markers[0].privateToken = NESTED_SECRET;
    board.markers[0].cell.privateToken = NESTED_SECRET;
  }
  if (board.shots[0]) {
    board.shots[0].privateToken = NESTED_SECRET;
  }
}

function addGameExtras(snapshot) {
  snapshot.game.privateToken = NESTED_SECRET;
  snapshot.game.rules.privateToken = NESTED_SECRET;
  snapshot.game.players.p1.privateToken = NESTED_SECRET;
  snapshot.game.players.p2.privateToken = NESTED_SECRET;
  addBoardExtras(snapshot.game.players.p1.board);
  addBoardExtras(snapshot.game.players.p2.board);
  snapshot.game.log[0].privateToken = NESTED_SECRET;
  snapshot.game.log[0].coordinate.privateToken = NESTED_SECRET;
  addBoardExtras(snapshot.boards.p1);
  addBoardExtras(snapshot.boards.p2);
}

function addTrainingExtras(snapshot) {
  snapshot.training.privateToken = NESTED_SECRET;
  snapshot.training.session.privateToken = NESTED_SECRET;
  addBoardExtras(snapshot.training.session.board);
  snapshot.training.session.log[0].privateToken = NESTED_SECRET;
  snapshot.training.session.log[0].coordinate.privateToken = NESTED_SECRET;
  snapshot.training.progress.privateToken = NESTED_SECRET;
  snapshot.training.progress.checkerboard.privateToken = NESTED_SECRET;
  snapshot.training.progress.daily.privateToken = NESTED_SECRET;
  snapshot.training.progress.unknownScenario = { privateToken: NESTED_SECRET };
}

function hasNestedSecret(value) {
  return JSON.stringify(value).includes(NESTED_SECRET);
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
  ["agent setup", () => setupState()],
  ["agent battle", () => localState()],
  ["hotseat setup", () => setupState("hotseat")],
  [
    "hotseat second-player setup",
    () =>
      setupState("hotseat", {
        setupPlayerId: "p2",
        boards: { p1: completeBoard(), p2: null },
      }),
  ],
  ["hotseat battle", () => localState({ mode: "hotseat" })],
  ["hotseat setup handoff", () => handoffPassState()],
  ["hotseat game pass", () => gamePassState()],
  ["training session", () => trainingState()],
];

for (const [name, makeState] of roundTripStates) {
  test(`${name} round-trips through a versioned snapshot`, () => {
    const state = makeState();
    const snapshot = createLocalBattleSnapshot(state, () => NOW);

    assert.equal(LOCAL_BATTLE_SNAPSHOT_VERSION, 1);
    assert.notEqual(snapshot, null);
    assert.equal(snapshot.savedAt, NOW);
    assert.deepEqual(parseLocalBattleSnapshot(JSON.stringify(snapshot)), snapshot);

    if (snapshot.game) {
      assert.equal(snapshot.game.players.p1.id, "p1");
      assert.equal(snapshot.game.players.p2.id, "p2");
    }
    if (snapshot.screen === "training") {
      assert.equal(snapshot.training.session.scenarioId, "checkerboard");
    }
  });
}

test("playing snapshots require a real game with p1 and p2 players", () => {
  assert.equal(
    createLocalBattleSnapshot(localState({ game: null }), () => NOW),
    null,
  );
  assert.throws(() =>
    parseLocalBattleSnapshot(
      JSON.stringify({ ...validSnapshot(), game: null }),
    ),
  );
});

test("snapshot preset ids must be own known game presets", () => {
  const state = setupState("agent", { presetId: "__proto__" });
  assert.equal(createLocalBattleSnapshot(state, () => NOW), null);
  assert.throws(() =>
    parseLocalBattleSnapshot(
      JSON.stringify({
        ...createLocalBattleSnapshot(setupState(), () => NOW),
        presetId: "__proto__",
      }),
    ),
  );
});

test("inherited preset ids cannot validate a V1 snapshot", async () => {
  const snapshot = validSnapshot();
  delete snapshot.presetId;
  const raw = JSON.stringify(snapshot);
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "presetId",
  );

  try {
    Object.defineProperty(Object.prototype, "presetId", {
      configurable: true,
      value: "classic",
    });

    assert.throws(() => parseLocalBattleSnapshot(raw));

    const settings = memorySettings({ localBattle: raw });
    const snapshots = createLocalBattleSnapshotStore(settings);
    assert.equal(await snapshots.load(), null);
    assert.equal(settings.values.get("localBattleQuarantine"), raw);
    assert.equal(settings.values.has("localBattle"), false);
    assert.deepEqual(settings.calls, [
      ["get", "localBattle"],
      ["set", "localBattleQuarantine", raw],
      ["set", "localBattle", null],
    ]);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(
        Object.prototype,
        "presetId",
        previousDescriptor,
      );
    } else {
      delete Object.prototype.presetId;
    }
  }
});

test("snapshot creation rejects inherited required DTO fields", async () => {
  for (const invalidCase of inheritedRequiredFieldCases()) {
    if (invalidCase.parseOnly) continue;
    const state = invalidCase.makeState();
    const target = invalidCase.target(state);
    const inheritedValue = target[invalidCase.field];
    delete target[invalidCase.field];

    await withObjectPrototypeField(
      invalidCase.field,
      inheritedValue,
      () => {
        assert.equal(
          createLocalBattleSnapshot(state, () => NOW),
          null,
          invalidCase.name,
        );
      },
    );
  }
});

test("inherited V1 DTO fields are quarantined and cleared", async () => {
  for (const invalidCase of inheritedRequiredFieldCases()) {
    const snapshot = createLocalBattleSnapshot(invalidCase.makeState(), () => NOW);
    assert.notEqual(snapshot, null, invalidCase.name);
    const target = invalidCase.target(snapshot);
    const inheritedValue = target[invalidCase.field];
    delete target[invalidCase.field];
    const raw = JSON.stringify(snapshot);

    await withObjectPrototypeField(
      invalidCase.field,
      inheritedValue,
      async () => {
        assert.throws(
          () => parseLocalBattleSnapshot(raw),
          invalidCase.name,
        );

        const settings = memorySettings({ localBattle: raw });
        const snapshots = createLocalBattleSnapshotStore(settings);
        assert.equal(await snapshots.load(), null, invalidCase.name);
        assert.equal(
          settings.values.get("localBattleQuarantine"),
          raw,
          invalidCase.name,
        );
        assert.equal(
          settings.values.has("localBattle"),
          false,
          invalidCase.name,
        );
        assert.deepEqual(settings.calls, [
          ["get", "localBattle"],
          ["set", "localBattleQuarantine", raw],
          ["set", "localBattle", null],
        ], invalidCase.name);
      },
    );
  }
});

test("marker battle shots retain only renderable marker outcome fields", () => {
  const preset = getGamePreset("perelman");
  const p1Board = completeBoard("perelman", 0);
  const p2Board = completeBoard("perelman", 0.75);
  const marker = p2Board.markers[0];
  const started = createGameFromBoards(p1Board, p2Board, "p1", {
    presetId: preset.id,
    rules: preset.rules,
  });
  const game = fireAt(started, "p1", marker.cell).game;
  const snapshot = createLocalBattleSnapshot(
    localState({
      mode: "hotseat",
      presetId: preset.id,
      boards: { p1: p1Board, p2: p2Board },
      game,
    }),
    () => NOW,
  );

  assert.equal(snapshot.game.log.at(-1).result, marker.type);
  assert.equal(
    snapshot.game.players.p2.board.shots.at(-1).markerId,
    marker.id,
  );
  assert.deepEqual(parseLocalBattleSnapshot(JSON.stringify(snapshot)), snapshot);
});

test("creation and parsing strip outcome-inapplicable board and log ids", () => {
  for (const result of ["miss", "hit", "sunk", "mine", "sweeper"]) {
    const state = localStateForOutcome(result);
    addOutcomeInapplicableIds(state, result);
    const created = createLocalBattleSnapshot(state, () => NOW);

    assert.notEqual(created, null, result);
    assertNormalizedOutcomeIds(created, result);

    const rawSnapshot = createLocalBattleSnapshot(
      localStateForOutcome(result),
      () => NOW,
    );
    addOutcomeInapplicableIds(rawSnapshot, result);
    const parsed = parseLocalBattleSnapshot(JSON.stringify(rawSnapshot));

    assertNormalizedOutcomeIds(parsed, result);
  }
});

test("creation and parsing reject malformed game-log ship ids", () => {
  const cases = [
    {
      name: "hit log with null shipId",
      result: "hit",
      mutate(value) {
        value.game.log.at(-1).shipId = null;
      },
    },
    {
      name: "sunk log with unknown shipId",
      result: "sunk",
      mutate(value) {
        value.game.log.at(-1).shipId = "unknown-ship";
      },
    },
    ...["miss", "mine", "sweeper"].map((result) => ({
      name: `${result} log with non-null shipId`,
      result,
      mutate(value) {
        value.game.log.at(-1).shipId = NESTED_SECRET;
      },
    })),
  ];

  for (const invalidCase of cases) {
    const state = localStateForOutcome(invalidCase.result);
    invalidCase.mutate(state);
    assert.equal(
      createLocalBattleSnapshot(state, () => NOW),
      null,
      invalidCase.name,
    );

    const snapshot = createLocalBattleSnapshot(
      localStateForOutcome(invalidCase.result),
      () => NOW,
    );
    invalidCase.mutate(snapshot);
    assert.throws(
      () => parseLocalBattleSnapshot(JSON.stringify(snapshot)),
      invalidCase.name,
    );
  }
});

test("game replay repairs derived state and remains playable", () => {
  const battle = liveBattle("salvo");
  const state = localState({
    presetId: "salvo",
    boards: battle.boards,
    game: battle.game,
  });
  const expected = createLocalBattleSnapshot(state, () => NOW);
  state.game.currentPlayerId = "p2";
  state.game.salvoRemaining = 999;
  state.game.players.p2.board.shots[0].result = "miss";
  delete state.game.players.p2.board.shots[0].shipId;

  const created = createLocalBattleSnapshot(state, () => NOW);
  assert.deepEqual(created, expected);
  assert.notEqual(created.game.salvoRemaining, 999);

  const corruptedSnapshot = structuredClone(expected);
  corruptedSnapshot.game.currentPlayerId = "p2";
  corruptedSnapshot.game.salvoRemaining = 999;
  corruptedSnapshot.game.players.p2.board.shots[0].result = "miss";
  delete corruptedSnapshot.game.players.p2.board.shots[0].shipId;
  const parsed = parseLocalBattleSnapshot(JSON.stringify(corruptedSnapshot));

  assert.deepEqual(parsed, expected);
  assert.doesNotThrow(() =>
    fireAt(
      parsed.game,
      parsed.game.currentPlayerId,
      firstUnshotCoordinate(parsed.game, parsed.game.currentPlayerId),
    ),
  );
});

test("agent snapshots reject a replay waiting on the synchronous agent turn", () => {
  const battle = battleAfterHumanMiss();
  assert.equal(battle.game.log.at(-1).result, "miss");
  assert.equal(battle.game.currentPlayerId, "p2");

  assert.equal(
    createLocalBattleSnapshot(localState({ ...battle }), () => NOW),
    null,
  );

  const hotseat = createLocalBattleSnapshot(
    localState({ ...battle, mode: "hotseat" }),
    () => NOW,
  );
  assert.notEqual(hotseat, null);
  assert.equal(hotseat.game.currentPlayerId, "p2");
  assert.deepEqual(parseLocalBattleSnapshot(JSON.stringify(hotseat)), hotseat);
});

test("agent snapshots waiting on p2 are quarantined and cleared", async () => {
  const battle = battleAfterHumanMiss();
  const hotseat = createLocalBattleSnapshot(
    localState({ ...battle, mode: "hotseat" }),
    () => NOW,
  );
  assert.notEqual(hotseat, null);
  assert.equal(hotseat.game.currentPlayerId, "p2");
  const raw = JSON.stringify({ ...hotseat, mode: "agent" });

  assert.throws(() => parseLocalBattleSnapshot(raw));

  const settings = memorySettings({ localBattle: raw });
  const snapshots = createLocalBattleSnapshotStore(settings);
  assert.equal(await snapshots.load(), null);
  assert.equal(settings.values.get("localBattleQuarantine"), raw);
  assert.equal(settings.values.has("localBattle"), false);
  assert.deepEqual(settings.calls, [
    ["get", "localBattle"],
    ["set", "localBattleQuarantine", raw],
    ["set", "localBattle", null],
  ]);
});

test("game replay rejects impossible claimed outcomes", () => {
  const state = localState();
  state.game.log.at(-1).result = "miss";
  state.game.log.at(-1).shipId = null;
  assert.equal(createLocalBattleSnapshot(state, () => NOW), null);

  const snapshot = validSnapshot();
  snapshot.game.log.at(-1).result = "miss";
  snapshot.game.log.at(-1).shipId = null;
  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(snapshot)));
});

test("setup reconstruction rejects placements that domain rules disallow", () => {
  const makeTouching = (value) => {
    value.setupBoard.ships[1].cells = [
      { row: 1, col: 4 },
      { row: 1, col: 5 },
      { row: 1, col: 6 },
    ];
  };
  const state = setupState();
  makeTouching(state);
  assert.equal(createLocalBattleSnapshot(state, () => NOW), null);

  const snapshot = createLocalBattleSnapshot(setupState(), () => NOW);
  makeTouching(snapshot);
  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(snapshot)));
});

test("game and training replay reject repeated coordinates", () => {
  const gameState = localState();
  gameState.game.log.push(structuredClone(gameState.game.log[0]));
  assert.equal(createLocalBattleSnapshot(gameState, () => NOW), null);

  const gameSnapshot = validSnapshot();
  gameSnapshot.game.log.push(structuredClone(gameSnapshot.game.log[0]));
  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(gameSnapshot)));

  const drillState = trainingState();
  drillState.training.session.log.push(
    structuredClone(drillState.training.session.log[0]),
  );
  assert.equal(createLocalBattleSnapshot(drillState, () => NOW), null);

  const drillSnapshot = createLocalBattleSnapshot(trainingState(), () => NOW);
  drillSnapshot.training.session.log.push(
    structuredClone(drillSnapshot.training.session.log[0]),
  );
  assert.throws(() => parseLocalBattleSnapshot(JSON.stringify(drillSnapshot)));
});

test("training replay repairs persisted derived internals", () => {
  const state = trainingState();
  const expected = createLocalBattleSnapshot(state, () => NOW);
  state.training.session.board = createTrainingSession("endgame").board;
  state.training.session.score = 999;
  state.training.session.shotLimit = 999;

  assert.deepEqual(
    createLocalBattleSnapshot(state, () => NOW),
    expected,
  );

  const corruptedSnapshot = structuredClone(expected);
  corruptedSnapshot.training.session.board = createTrainingSession("endgame").board;
  corruptedSnapshot.training.session.score = 999;
  corruptedSnapshot.training.session.shotLimit = 999;
  assert.deepEqual(
    parseLocalBattleSnapshot(JSON.stringify(corruptedSnapshot)),
    expected,
  );
});

test("training replay derives optional claims and rejects false claims", () => {
  const expected = createLocalBattleSnapshot(trainingState(), () => NOW);
  const sparse = structuredClone(expected);
  delete sparse.training.session.log[0].result;
  delete sparse.training.session.log[0].quality;
  delete sparse.training.session.log[0].feedbackId;
  assert.deepEqual(parseLocalBattleSnapshot(JSON.stringify(sparse)), expected);

  const invalidState = trainingState();
  invalidState.training.session.log[0].quality = "weak";
  assert.equal(createLocalBattleSnapshot(invalidState, () => NOW), null);

  const invalidSnapshot = structuredClone(expected);
  invalidSnapshot.training.session.log[0].feedbackId = "hit";
  assert.throws(() =>
    parseLocalBattleSnapshot(JSON.stringify(invalidSnapshot)),
  );
});

test("mode and screen validation rejects unrenderable V1 structures", () => {
  const unknownPiece = setupState();
  unknownPiece.setupBoard.ships[0].id = "unknown-ship";
  const incompleteGameBoards = localState();
  incompleteGameBoards.boards.p2.ships.pop();

  const invalidStates = [
    setupState("agent", { setupBoard: null }),
    setupState("agent", { setupOrientation: "diagonal" }),
    setupState("agent", { setupSelectedShipId: null }),
    unknownPiece,
    incompleteGameBoards,
    handoffPassState({ passPlayerId: "p1" }),
    handoffPassState({ passPlayerId: "p3" }),
    handoffPassState({ setupOrientation: "diagonal" }),
    handoffPassState({ boards: { p1: null, p2: null } }),
    trainingState({
      training: {
        scenarioId: "checkerboard",
        session: createTrainingSession("checkerboard"),
        progress: null,
      },
    }),
    trainingState({
      training: {
        scenarioId: "unknown",
        session: createTrainingSession("checkerboard"),
        progress: trainingProgress(),
      },
    }),
    trainingState({
      training: {
        scenarioId: "checkerboard",
        session: null,
        progress: trainingProgress(),
      },
    }),
  ];

  for (const state of invalidStates) {
    assert.equal(
      createLocalBattleSnapshot(state, () => NOW),
      null,
      `${state.mode}/${state.screen}`,
    );
  }

  const invalidSnapshots = [
    {
      ...createLocalBattleSnapshot(setupState(), () => NOW),
      setupBoard: null,
    },
    {
      ...createLocalBattleSnapshot(handoffPassState(), () => NOW),
      passPlayerId: "p1",
    },
    {
      ...createLocalBattleSnapshot(trainingState(), () => NOW),
      training: {
        scenarioId: "checkerboard",
        session: null,
        progress: trainingProgress(),
      },
    },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(() =>
      parseLocalBattleSnapshot(JSON.stringify(snapshot)),
    );
  }
});

test("training progress normalization bounds values and drops unknown lists", () => {
  const state = trainingState();
  state.training.progress = {
    checkerboard: {
      completions: -1,
      bestScore: Number.POSITIVE_INFINITY,
      bestAccuracy: 125,
      bestRatingId: "unknown",
      lastPlayedAt: "not-a-date",
    },
    daily: {
      date: "not-a-date",
      completions: -1,
      completedScenarioIds: null,
      goalCompletedDate: "not-a-date",
      streak: -1,
      bestStreak: -1,
      awards: null,
    },
  };

  const snapshot = createLocalBattleSnapshot(state, () => NOW);

  assert.deepEqual(snapshot.training.progress, {
    checkerboard: {
      completions: 0,
      bestScore: 0,
      bestAccuracy: 100,
      bestRatingId: "needsWork",
      lastPlayedAt: "",
    },
    daily: {
      date: "",
      completions: 0,
      completedScenarioIds: [],
      goalCompletedDate: "",
      streak: 0,
      bestStreak: 0,
      awards: [],
    },
  });
});

test("training progress ignores inherited containers and nested fields", async () => {
  const emptyProgress = {
    checkerboard: {
      completions: 0,
      bestScore: 0,
      bestAccuracy: 0,
      bestRatingId: "needsWork",
      lastPlayedAt: "",
    },
    daily: {
      date: "",
      completions: 0,
      completedScenarioIds: [],
      goalCompletedDate: "",
      streak: 0,
      bestStreak: 0,
      awards: [],
    },
  };
  const cases = [
    {
      name: "progress containers",
      progress: {},
      inherited: [
        ["checkerboard", trainingProgress().checkerboard],
        ["daily", trainingProgress().daily],
      ],
      expected: {},
    },
    {
      name: "nested progress fields",
      progress: { checkerboard: {}, daily: {} },
      inherited: [
        ["completions", 9],
        ["bestScore", 99],
        ["bestAccuracy", 88],
        ["bestRatingId", "excellent"],
        ["lastPlayedAt", NOW],
        ["date", "2026-07-13"],
        ["completedScenarioIds", ["checkerboard"]],
        ["goalCompletedDate", "2026-07-13"],
        ["streak", 9],
        ["bestStreak", 9],
        ["awards", ["firstWatch"]],
      ],
      expected: emptyProgress,
    },
  ];

  for (const invalidCase of cases) {
    const state = trainingState();
    state.training.progress = structuredClone(invalidCase.progress);
    const rawSnapshot = createLocalBattleSnapshot(trainingState(), () => NOW);
    rawSnapshot.training.progress = structuredClone(invalidCase.progress);
    const raw = JSON.stringify(rawSnapshot);

    await withObjectPrototypeFields(invalidCase.inherited, () => {
      assert.deepEqual(
        createLocalBattleSnapshot(state, () => NOW).training.progress,
        invalidCase.expected,
        invalidCase.name,
      );
      assert.deepEqual(
        parseLocalBattleSnapshot(raw).training.progress,
        invalidCase.expected,
        invalidCase.name,
      );
    });
  }
});

test("training progress output ignores inherited scenario and daily setters", async () => {
  const setterCalls = { checkerboard: 0, daily: 0 };
  const state = trainingState();
  const raw = JSON.stringify(createLocalBattleSnapshot(state, () => NOW));

  await withObjectPrototypeDescriptors(
    [
      ["checkerboard", { set() { setterCalls.checkerboard += 1; } }],
      ["daily", { set() { setterCalls.daily += 1; } }],
    ],
    () => {
      const snapshots = [
        createLocalBattleSnapshot(state, () => NOW),
        parseLocalBattleSnapshot(raw),
      ];

      assert.deepEqual(setterCalls, { checkerboard: 0, daily: 0 });
      for (const snapshot of snapshots) {
        const progress = snapshot.training.progress;
        assert.equal(Object.getPrototypeOf(progress), Object.prototype);
        assert.deepEqual(progress, trainingProgress());
        for (const field of ["checkerboard", "daily"]) {
          const descriptor = Object.getOwnPropertyDescriptor(progress, field);
          assert.equal(descriptor?.enumerable, true, field);
          assert.equal(descriptor?.writable, true, field);
          assert.equal(descriptor?.configurable, true, field);
        }
      }
    },
  );
});

test("training progress output overrides inherited non-writable data", async () => {
  const state = trainingState();
  const raw = JSON.stringify(createLocalBattleSnapshot(state, () => NOW));

  await withObjectPrototypeDescriptors(
    [
      ["checkerboard", { value: "blocked", writable: false }],
      ["daily", { value: "blocked", writable: false }],
    ],
    () => {
      const snapshots = [
        createLocalBattleSnapshot(state, () => NOW),
        parseLocalBattleSnapshot(raw),
      ];

      for (const snapshot of snapshots) {
        const progress = snapshot.training.progress;
        assert.equal(Object.getPrototypeOf(progress), Object.prototype);
        assert.deepEqual(progress, trainingProgress());
        assert.deepEqual(JSON.parse(JSON.stringify(progress)), trainingProgress());
      }
    },
  );
});

test("snapshot creation and parsing detach nested mutable state", () => {
  const state = trainingState();
  const snapshot = createLocalBattleSnapshot(state, () => NOW);
  const firstShipId = state.training.session.board.ships[0].id;
  const secondShipId = state.training.session.board.ships[1].id;

  snapshot.training.session.board.ships[0].id = "snapshot-only";
  state.training.session.board.ships[1].id = "state-only";

  assert.equal(state.training.session.board.ships[0].id, firstShipId);
  assert.equal(snapshot.training.session.board.ships[1].id, secondShipId);

  const raw = JSON.stringify(createLocalBattleSnapshot(trainingState(), () => NOW));
  const first = parseLocalBattleSnapshot(raw);
  const second = parseLocalBattleSnapshot(raw);
  first.training.session.board.ships[0].id = "first-only";

  assert.equal(second.training.session.board.ships[0].id, "search-cruiser");
});

test("creation and parsing recursively strip game, player, board, ship, shot, and log extras", () => {
  const state = localState();
  addGameExtras(state);
  const created = createLocalBattleSnapshot(state, () => NOW);

  assert.notEqual(created, null);
  assert.equal(hasNestedSecret(created), false);

  const rawSnapshot = createLocalBattleSnapshot(localState(), () => NOW);
  addGameExtras(rawSnapshot);
  const parsed = parseLocalBattleSnapshot(JSON.stringify(rawSnapshot));

  assert.equal(hasNestedSecret(parsed), false);
});

test("creation and parsing recursively strip training session and progress extras", () => {
  const state = trainingState();
  addTrainingExtras(state);
  const created = createLocalBattleSnapshot(state, () => NOW);

  assert.notEqual(created, null);
  assert.equal(hasNestedSecret(created), false);

  const rawSnapshot = createLocalBattleSnapshot(trainingState(), () => NOW);
  addTrainingExtras(rawSnapshot);
  const parsed = parseLocalBattleSnapshot(JSON.stringify(rawSnapshot));

  assert.equal(hasNestedSecret(parsed), false);
});

test("creation and parsing recursively strip marker and marker-coordinate extras", () => {
  const makeState = () =>
    setupState("agent", {
      presetId: "perelman",
      setupBoard: completeBoard("perelman"),
      setupSelectedShipId: "",
    });
  const state = makeState();
  addBoardExtras(state.setupBoard);
  const created = createLocalBattleSnapshot(state, () => NOW);

  assert.notEqual(created, null);
  assert.equal(hasNestedSecret(created), false);

  const rawSnapshot = createLocalBattleSnapshot(makeState(), () => NOW);
  addBoardExtras(rawSnapshot.setupBoard);
  const parsed = parseLocalBattleSnapshot(JSON.stringify(rawSnapshot));

  assert.equal(hasNestedSecret(parsed), false);
});

test("setup snapshots strip extras from empty board containers", () => {
  for (const mode of ["agent", "hotseat"]) {
    const state = setupState(mode);
    state.boards.privateToken = NESTED_SECRET;
    const created = createLocalBattleSnapshot(state, () => NOW);

    assert.deepEqual(created.boards, { p1: null, p2: null }, mode);
    assert.equal(hasNestedSecret(created), false, mode);

    const rawSnapshot = createLocalBattleSnapshot(setupState(mode), () => NOW);
    rawSnapshot.boards.privateToken = NESTED_SECRET;
    const parsed = parseLocalBattleSnapshot(JSON.stringify(rawSnapshot));

    assert.deepEqual(parsed.boards, { p1: null, p2: null }, mode);
    assert.equal(hasNestedSecret(parsed), false, mode);
  }
});

test("training snapshots neutralize a stale finished local game", () => {
  const state = trainingState({
    game: { ...localState().game, phase: "finished" },
  });
  const snapshot = createLocalBattleSnapshot(state, () => NOW);

  assert.notEqual(snapshot, null);
  assert.equal(snapshot.training.session.phase, "playing");
  assert.equal(snapshot.game, null);
  assert.deepEqual(snapshot.boards, { p1: null, p2: null });
});

test("parse neutralizes a stale finished local game in live training", () => {
  const snapshot = createLocalBattleSnapshot(trainingState(), () => NOW);
  const withStaleGame = {
    ...snapshot,
    game: { ...localState().game, phase: "finished" },
  };

  const parsed = parseLocalBattleSnapshot(JSON.stringify(withStaleGame));
  assert.equal(parsed.game, null);
  assert.deepEqual(parsed.boards, { p1: null, p2: null });
});

for (const mode of ["agent", "hotseat"]) {
  test(`${mode} snapshots neutralize stale finished training data`, () => {
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
    assert.equal(snapshot.training.session, null);
  });

  test(`parse neutralizes stale finished training data in a live ${mode} game`, () => {
    const snapshot = createLocalBattleSnapshot(localState({ mode }), () => NOW);
    const withStaleTraining = {
      ...snapshot,
      training: {
        ...trainingState().training,
        session: { ...trainingState().training.session, phase: "finished" },
      },
    };

    const parsed = parseLocalBattleSnapshot(JSON.stringify(withStaleTraining));
    assert.equal(parsed.game.phase, "playing");
    assert.equal(parsed.training.session, null);
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

test("parse reserves unsupported-version errors for positive future integers", () => {
  for (const version of [2, 3, 100]) {
    assert.throws(
      () => parseLocalBattleSnapshot(JSON.stringify({ version })),
      (error) => {
        assert.ok(error instanceof UnsupportedLocalBattleSnapshotVersionError);
        assert.equal(error.foundVersion, version);
        return true;
      },
    );
  }
});

test("parse classifies malformed version envelopes as invalid current data", () => {
  for (const version of [undefined, null, 0, -1, 1.5, "1"]) {
    assert.throws(
      () => parseLocalBattleSnapshot(JSON.stringify({ version })),
      (error) => {
        assert.equal(
          error instanceof UnsupportedLocalBattleSnapshotVersionError,
          false,
        );
        return true;
      },
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

for (const battleTab of ["target", "own", "log"]) {
  test(`store preserves the ${battleTab} battle tab`, async () => {
    const settings = memorySettings();
    const snapshots = createLocalBattleSnapshotStore(settings, { now: () => NOW });

    await snapshots.save(localState({ battleTab }));
    const raw = settings.values.get("localBattle");

    assert.equal(typeof raw, "string");
    assert.equal(JSON.parse(raw).battleTab, battleTab);
    assert.equal((await snapshots.load()).battleTab, battleTab);
    assert.deepEqual(settings.calls, [
      ["set", "localBattle", raw],
      ["get", "localBattle"],
    ]);
  });
}

test("inherited battle tabs normalize to target", () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "battleTab",
  );

  try {
    Object.defineProperty(Object.prototype, "battleTab", {
      configurable: true,
      value: "log",
    });

    const state = localState();
    delete state.battleTab;
    assert.equal(createLocalBattleSnapshot(state, () => NOW).battleTab, "target");

    const snapshot = validSnapshot();
    delete snapshot.battleTab;
    assert.equal(
      parseLocalBattleSnapshot(JSON.stringify(snapshot)).battleTab,
      "target",
    );
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(
        Object.prototype,
        "battleTab",
        previousDescriptor,
      );
    } else {
      delete Object.prototype.battleTab;
    }
  }
});

test("store normalizes unknown and missing battle tabs without clearing gameplay", async () => {
  for (const battleTab of ["unknown", undefined]) {
    const state = localState({ battleTab });
    if (battleTab === undefined) {
      delete state.battleTab;
    }
    const settings = memorySettings();
    const snapshots = createLocalBattleSnapshotStore(settings, { now: () => NOW });

    await snapshots.save(state);
    const raw = settings.values.get("localBattle");

    assert.equal(typeof raw, "string", String(battleTab));
    assert.equal(JSON.parse(raw).battleTab, "target", String(battleTab));
    assert.equal((await snapshots.load()).battleTab, "target", String(battleTab));
    assert.equal(
      settings.calls.some(
        ([operation, key, value]) =>
          operation === "set" && key === "localBattle" && value === null,
      ),
      false,
      String(battleTab),
    );
  }
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

test("malformed versions are quarantined and cleared", async () => {
  for (const version of [undefined, null, 0, -1, 1.5, "1"]) {
    const raw = JSON.stringify(validSnapshot({ version }));
    const settings = memorySettings({ localBattle: raw });
    const snapshots = createLocalBattleSnapshotStore(settings);

    assert.equal(await snapshots.load(), null, String(version));
    assert.equal(settings.values.get("localBattleQuarantine"), raw);
    assert.equal(settings.values.has("localBattle"), false);
  }
});

test("inherited versions are quarantined and cleared", async () => {
  const snapshot = validSnapshot();
  delete snapshot.version;
  const raw = JSON.stringify(snapshot);
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "version",
  );

  try {
    Object.defineProperty(Object.prototype, "version", {
      configurable: true,
      value: 1,
    });
    assert.throws(
      () => parseLocalBattleSnapshot(raw),
      (error) =>
        !(error instanceof UnsupportedLocalBattleSnapshotVersionError),
    );

    const settings = memorySettings({ localBattle: raw });
    const snapshots = createLocalBattleSnapshotStore(settings);
    assert.equal(await snapshots.load(), null);
    assert.equal(settings.values.get("localBattleQuarantine"), raw);
    assert.equal(settings.values.has("localBattle"), false);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(Object.prototype, "version", previousDescriptor);
    } else {
      delete Object.prototype.version;
    }
  }
});

test("unsupported future versions are preserved and rethrown unchanged", async () => {
  const raw = JSON.stringify({ version: 2, futurePayload: true });
  const oldQuarantine = "older-corrupt-value";
  const settings = memorySettings({
    localBattle: raw,
    localBattleQuarantine: oldQuarantine,
  });
  const snapshots = createLocalBattleSnapshotStore(settings);

  let foundError;
  await assert.rejects(snapshots.load(), (error) => {
    foundError = error;
    return error instanceof UnsupportedLocalBattleSnapshotVersionError;
  });

  assert.equal(foundError.foundVersion, 2);
  assert.equal(settings.values.get("localBattle"), raw);
  assert.equal(
    settings.values.get("localBattleQuarantine"),
    oldQuarantine,
  );
  assert.deepEqual(settings.calls, [["get", "localBattle"]]);
});

test("structured clone failures propagate without quarantining valid data", async () => {
  const raw = JSON.stringify(validSnapshot());
  const settings = memorySettings({ localBattle: raw });
  const snapshots = createLocalBattleSnapshotStore(settings);
  const failure = new Error("structured clone failed");
  const originalStructuredClone = globalThis.structuredClone;

  try {
    globalThis.structuredClone = () => {
      throw failure;
    };
    await assert.rejects(snapshots.load(), (error) => error === failure);
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(settings.values.get("localBattle"), raw);
  assert.equal(settings.values.has("localBattleQuarantine"), false);
  assert.deepEqual(settings.calls, [["get", "localBattle"]]);
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

test("active-key clear failures propagate after quarantine succeeds", async () => {
  const raw = "{bad";
  const failure = new Error("active snapshot clear failed");
  const writes = [];
  const snapshots = createLocalBattleSnapshotStore({
    async get() {
      return raw;
    },
    async set(key, value) {
      writes.push([key, value]);
      if (key === "localBattle") {
        throw failure;
      }
    },
  });

  await assert.rejects(snapshots.load(), (error) => error === failure);
  assert.deepEqual(writes, [
    ["localBattleQuarantine", raw],
    ["localBattle", null],
  ]);
});
