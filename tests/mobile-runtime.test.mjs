import test from "node:test";
import assert from "node:assert/strict";

import { UnsupportedLocalBattleSnapshotVersionError } from "../src/core/local-battle-snapshot.js";
import { createMobileRuntime } from "../src/mobile.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runtimeHarness() {
  const events = [];
  const subscriptions = [];
  const deliveries = {
    network: [],
    deepLink: [],
    back: [],
    restoreErrors: [],
    runtimeErrors: [],
    snapshots: [],
  };
  const networkStatus = { connected: true, connectionType: "wifi" };
  const snapshot = { screen: "playing" };
  const state = { screen: "menu" };
  const registrationFailures = new Map();
  const removalFailures = new Map();

  const register = async (name, listener) => {
    events.push(`subscribe:${name}`);
    const registrationFailure = registrationFailures.get(name);
    if (registrationFailure) throw registrationFailure;

    const subscription = {
      active: true,
      listener,
      name,
      removalAttempts: 0,
    };
    subscriptions.push(subscription);
    return async () => {
      subscription.removalAttempts += 1;
      events.push(`remove:${name}`);
      const removalFailure = removalFailures.get(name);
      if (removalFailure) throw removalFailure;
      subscription.active = false;
    };
  };

  const platform = {
    async getNetworkStatus() {
      return networkStatus;
    },
    async configureSystemBars() {
      events.push("bars");
    },
    async hideSplash() {
      events.push("splash");
    },
    onNetworkChange: (listener) => register("network", listener),
    onDeepLink: (listener) => register("deep-link", listener),
    onBack: (listener) => register("back", listener),
    onLifecycleChange: (listener) => register("lifecycle", listener),
  };
  const snapshots = {
    async load() {
      return snapshot;
    },
    async save(value) {
      events.push("save");
      deliveries.snapshots.push(value);
    },
  };
  const options = {
    platform,
    snapshots,
    getState: () => state,
    applySnapshot(value) {
      events.push("restore");
      deliveries.snapshots.push(value);
    },
    onRestoreError(error) {
      events.push("restore-error");
      deliveries.restoreErrors.push(error);
    },
    onNetwork(value) {
      events.push("network");
      deliveries.network.push(value);
    },
    onDeepLink(value) {
      deliveries.deepLink.push(value);
    },
    onBack(value) {
      deliveries.back.push(value);
      return false;
    },
    pauseAudio() {
      events.push("pause-audio");
    },
    resumeAudio() {
      events.push("resume-audio");
    },
    onRuntimeError(error) {
      deliveries.runtimeErrors.push(error);
    },
  };

  return {
    deliveries,
    events,
    networkStatus,
    options,
    platform,
    registrationFailures,
    removalFailures,
    snapshot,
    snapshots,
    state,
    subscriptions,
    activeListenerCount() {
      return subscriptions.filter(({ active }) => active).length;
    },
    async emit(name, value) {
      const active = subscriptions.filter(
        (subscription) => subscription.active && subscription.name === name,
      );
      return Promise.all(active.map(({ listener }) => listener(value)));
    },
  };
}

test("start obtains network, restores, configures bars, then hides splash", async () => {
  const harness = runtimeHarness();
  const runtime = createMobileRuntime(harness.options);

  await runtime.start();

  assert.deepEqual(harness.events, [
    "network",
    "restore",
    "bars",
    "splash",
    "subscribe:network",
    "subscribe:deep-link",
    "subscribe:back",
    "subscribe:lifecycle",
  ]);
  assert.equal(harness.deliveries.network[0], harness.networkStatus);
  assert.equal(harness.deliveries.snapshots[0], harness.snapshot);
  await runtime.stop();
});

test("start reports unsupported snapshot load failures and remains usable", async () => {
  const harness = runtimeHarness();
  const failure = new UnsupportedLocalBattleSnapshotVersionError(2);
  harness.snapshots.load = async () => {
    throw failure;
  };
  const runtime = createMobileRuntime(harness.options);

  await runtime.start();

  assert.deepEqual(harness.deliveries.restoreErrors, [failure]);
  assert.deepEqual(harness.events.slice(0, 4), [
    "network",
    "restore-error",
    "bars",
    "splash",
  ]);
  assert.equal(harness.activeListenerCount(), 4);
  await runtime.stop();
});

test("start reports apply failures and still installs subscriptions", async () => {
  const harness = runtimeHarness();
  const failure = new Error("snapshot cannot be applied");
  harness.options.applySnapshot = () => {
    throw failure;
  };
  const runtime = createMobileRuntime(harness.options);

  await runtime.start();

  assert.deepEqual(harness.deliveries.restoreErrors, [failure]);
  assert.deepEqual(harness.events.slice(0, 4), [
    "network",
    "restore-error",
    "bars",
    "splash",
  ]);
  assert.equal(harness.activeListenerCount(), 4);
  await runtime.stop();
});

test("network, deep-link, and back events are forwarded unchanged", async () => {
  const harness = runtimeHarness();
  const runtime = createMobileRuntime(harness.options);
  const network = { connected: false, connectionType: "none" };
  const deepLink = { url: "salvo://battle/ABC123" };
  const back = { canGoBack: false };
  await runtime.start();

  await harness.emit("network", network);
  await harness.emit("deep-link", deepLink);
  const backResults = await harness.emit("back", back);

  assert.equal(harness.deliveries.network.at(-1), network);
  assert.equal(harness.deliveries.deepLink.at(-1), deepLink);
  assert.equal(harness.deliveries.back.at(-1), back);
  assert.deepEqual(backResults, [false]);
  await runtime.stop();
});

test("inactive lifecycle pauses audio before saving current state", async () => {
  const harness = runtimeHarness();
  const paused = deferred();
  harness.options.pauseAudio = () => {
    harness.events.push("pause-audio");
    return paused.promise;
  };
  const runtime = createMobileRuntime(harness.options);
  await runtime.start();

  const lifecycle = harness.emit("lifecycle", { active: false });
  await Promise.resolve();
  assert.equal(harness.events.at(-1), "pause-audio");
  assert.equal(harness.deliveries.snapshots.includes(harness.state), false);

  paused.resolve();
  await lifecycle;
  assert.deepEqual(harness.events.slice(-2), ["pause-audio", "save"]);
  assert.equal(harness.deliveries.snapshots.at(-1), harness.state);
  await runtime.stop();
});

test("active lifecycle resumes audio", async () => {
  const harness = runtimeHarness();
  const runtime = createMobileRuntime(harness.options);
  await runtime.start();

  await harness.emit("lifecycle", { active: true });

  assert.equal(harness.events.at(-1), "resume-audio");
  await runtime.stop();
});

test("async lifecycle failures are observed without rejecting the platform callback", async () => {
  const harness = runtimeHarness();
  const failure = new Error("background save failed");
  const observerFailure = new Error("observer failed");
  harness.snapshots.save = async () => {
    throw failure;
  };
  harness.options.onRuntimeError = async (error) => {
    harness.deliveries.runtimeErrors.push(error);
    throw observerFailure;
  };
  const runtime = createMobileRuntime(harness.options);
  await runtime.start();

  await assert.doesNotReject(
    harness.emit("lifecycle", { active: false }),
  );
  assert.deepEqual(harness.deliveries.runtimeErrors, [failure]);
  await runtime.stop();
});

test("persist saves current state and preserves save failures", async () => {
  const harness = runtimeHarness();
  const runtime = createMobileRuntime(harness.options);

  await runtime.persist();
  assert.equal(harness.deliveries.snapshots.at(-1), harness.state);

  const failure = new Error("explicit save failed");
  harness.snapshots.save = async () => {
    throw failure;
  };
  await assert.rejects(runtime.persist(), (error) => error === failure);
});

test("start and stop are idempotent and start can restart after stop", async () => {
  const harness = runtimeHarness();
  const runtime = createMobileRuntime(harness.options);

  await Promise.all([runtime.start(), runtime.start()]);
  await runtime.start();
  assert.equal(harness.activeListenerCount(), 4);
  assert.equal(
    harness.events.filter((event) => event.startsWith("subscribe:")).length,
    4,
  );
  assert.equal(harness.events.filter((event) => event === "network").length, 1);

  await Promise.all([runtime.stop(), runtime.stop()]);
  await runtime.stop();
  assert.equal(harness.activeListenerCount(), 0);
  assert.equal(
    harness.events.filter((event) => event.startsWith("remove:")).length,
    4,
  );

  await runtime.start();
  assert.equal(harness.activeListenerCount(), 4);
  assert.equal(harness.events.filter((event) => event === "network").length, 2);
  assert.equal(
    harness.events.filter((event) => event.startsWith("subscribe:")).length,
    8,
  );
  await runtime.stop();
});

test("failed subscription setup removes earlier listeners and permits retry", async () => {
  const harness = runtimeHarness();
  const failure = new Error("back registration failed");
  harness.registrationFailures.set("back", failure);
  const runtime = createMobileRuntime(harness.options);

  await assert.rejects(runtime.start(), (error) => error === failure);

  assert.equal(harness.activeListenerCount(), 0);
  assert.deepEqual(
    harness.events.filter(
      (event) => event.startsWith("subscribe:") || event.startsWith("remove:"),
    ),
    [
      "subscribe:network",
      "subscribe:deep-link",
      "subscribe:back",
      "remove:network",
      "remove:deep-link",
    ],
  );

  harness.registrationFailures.delete("back");
  await runtime.start();
  assert.equal(harness.activeListenerCount(), 4);
  await runtime.stop();
});

test("stop attempts every remover and reports all cleanup failures", async () => {
  const harness = runtimeHarness();
  const networkFailure = new Error("network remove failed");
  const backFailure = new Error("back remove failed");
  harness.removalFailures.set("network", networkFailure);
  harness.removalFailures.set("back", backFailure);
  const runtime = createMobileRuntime(harness.options);
  await runtime.start();

  await assert.rejects(runtime.stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /mobile runtime subscriptions/i);
    assert.deepEqual(error.errors, [networkFailure, backFailure]);
    return true;
  });

  assert.deepEqual(
    harness.subscriptions.map(({ name, removalAttempts }) => [
      name,
      removalAttempts,
    ]),
    [
      ["network", 1],
      ["deep-link", 1],
      ["back", 1],
      ["lifecycle", 1],
    ],
  );
});
