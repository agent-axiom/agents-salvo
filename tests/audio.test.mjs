import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import * as audioCore from "../src/core/audio.js";
import { createAudioController } from "../src/audio.js";

const { soundPresets, musicPreset, isKnownSound } = audioCore;

test("soundPresets include all gameplay and interface events", () => {
  assert.deepEqual(
    Object.keys(soundPresets).sort(),
    [
      "defeat",
      "hit",
      "miss",
      "roomReady",
      "shot",
      "sunk",
      "turn",
      "ui",
      "victory",
    ],
  );
});

test("menuMusicTracks include both mp3 menu loops", () => {
  assert.deepEqual(audioCore.menuMusicTracks, [
    "./assets/audio/menu-loop.mp3",
    "./assets/audio/menu-loop-v2.mp3",
  ]);
});

test("configured menu mp3 audio assets exist in source tree", async () => {
  for (const source of audioCore.menuMusicTracks) {
    assert.match(source, /^\.\/assets\/audio\/.+\.mp3$/);
    await access(resolve("src", source.slice(2)));
  }
});

test("source tree keeps mp3 assets limited to the two menu loops", async () => {
  const files = await readdir(resolve("src/assets/audio"));
  assert.deepEqual(files.filter((file) => file.endsWith(".mp3")).sort(), [
    "menu-loop-v2.mp3",
    "menu-loop.mp3",
  ]);
});

test("each synthetic sound preset has playable oscillator steps", () => {
  for (const [name, preset] of Object.entries(soundPresets)) {
    assert.equal(isKnownSound(name), true);
    assert.ok(preset.duration > 0, `${name} duration should be positive`);
    assert.ok(preset.steps.length > 0, `${name} should have steps`);
    for (const step of preset.steps) {
      assert.ok(step.frequency > 0, `${name} step frequency should be positive`);
      assert.ok(step.duration > 0, `${name} step duration should be positive`);
      assert.match(step.type, /^(sine|square|sawtooth|triangle)$/);
    }
  }
});

test("musicPreset is a looping menu melody", () => {
  assert.equal(musicPreset.loop, true);
  assert.ok(musicPreset.notes.length >= 4);
});

test("lifecycle pause does not instantiate an audio context", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await controller.pauseForLifecycle();

    assert.equal(audio.contexts.length, 0);
  });
});

test("lifecycle pause suspends and enabled menu resume resumes existing context", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("ui", true);
    assert.equal(audio.contexts.length, 1);

    await controller.pauseForLifecycle();
    assert.deepEqual(audio.contextCalls, ["suspend"]);
    assert.equal(audio.contexts[0].state, "suspended");

    await controller.resumeForLifecycle(true, true);
    assert.deepEqual(audio.contextCalls, ["suspend", "resume"]);
    assert.equal(audio.contexts[0].state, "running");
  });
});

test("disabled and non-menu lifecycle resumes do not restart music", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.startMusic(true);
    await controller.pauseForLifecycle();

    await controller.resumeForLifecycle(false, true);
    await controller.resumeForLifecycle(true, false);

    assert.equal(audio.elements.length, 1);
    assert.equal(audio.elementCalls.filter((call) => call === "play").length, 1);
    assert.equal(audio.elementCalls.filter((call) => call === "pause").length, 1);
  });
});

test("enabled menu lifecycle resume restarts music without duplicates", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.startMusic(true);
    await controller.pauseForLifecycle();

    await controller.resumeForLifecycle(true, true);
    await controller.resumeForLifecycle(true, true);

    assert.equal(audio.elements.length, 2);
    assert.equal(audio.elementCalls.filter((call) => call === "play").length, 2);
    assert.equal(audio.elements[0].currentTime, 0);
  });
});

test("lifecycle resume does not duplicate a synthetic music timer with id zero", async () => {
  const audio = audioHarness();
  const timers = [];
  const clearedTimers = [];
  audio.globals.Audio = undefined;
  audio.globals.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return 0;
  };
  audio.globals.window.clearTimeout = (timer) => clearedTimers.push(timer);

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.startMusic(true);

    await controller.resumeForLifecycle(true, true);
    assert.equal(timers.length, 1);

    await controller.pauseForLifecycle();
    assert.deepEqual(clearedTimers, [0]);
  });
});

test("concurrent lifecycle resumes share one synthetic music start", async () => {
  const audio = audioHarness();
  const timers = [];
  audio.globals.Audio = undefined;
  audio.globals.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await Promise.all([
      controller.resumeForLifecycle(true, true),
      controller.resumeForLifecycle(true, true),
    ]);

    assert.equal(audio.contexts.length, 1);
    assert.equal(timers.length, 1);
    await controller.pauseForLifecycle();
  });
});

test("concurrent lifecycle resumes share one pending mp3 start", async () => {
  const audio = audioHarness();
  let releasePlay;
  let markPlayStarted;
  const playStarted = new Promise((resolvePromise) => {
    markPlayStarted = resolvePromise;
  });
  const playPending = new Promise((resolvePromise) => {
    releasePlay = resolvePromise;
  });
  audio.globals.Audio.prototype.play = function play() {
    audio.elementCalls.push("play");
    markPlayStarted();
    return playPending;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    const firstResume = controller.resumeForLifecycle(true, true);
    let secondSettled = false;
    const secondResume = controller.resumeForLifecycle(true, true).then(() => {
      secondSettled = true;
    });
    await playStarted;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    assert.equal(audio.elements.length, 1);
    assert.equal(audio.elementCalls.filter((call) => call === "play").length, 1);
    assert.equal(secondSettled, false);
    releasePlay();
    await Promise.all([firstResume, secondResume]);
    await controller.pauseForLifecycle();
  });
});

test("lifecycle pause invalidates a pending synthetic resume", async () => {
  const audio = audioHarness();
  const timers = [];
  audio.globals.Audio = undefined;
  audio.globals.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("ui", true);
    await controller.pauseForLifecycle();

    const context = audio.contexts[0];
    let releaseResume;
    let markResumeStarted;
    const resumeStarted = new Promise((resolvePromise) => {
      markResumeStarted = resolvePromise;
    });
    const resumePending = new Promise((resolvePromise) => {
      releaseResume = resolvePromise;
    });
    context.resume = async () => {
      audio.contextCalls.push("resume");
      markResumeStarted();
      await resumePending;
      context.state = "running";
    };

    const resuming = controller.resumeForLifecycle(true, true);
    await resumeStarted;
    const pausing = controller.pauseForLifecycle();
    releaseResume();
    await Promise.all([resuming, pausing]);

    assert.equal(timers.length, 0);
    assert.equal(context.state, "suspended");
  });
});

function audioHarness() {
  const contexts = [];
  const contextCalls = [];
  const elements = [];
  const elementCalls = [];

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.state = "running";
      contexts.push(this);
    }

    createOscillator() {
      return {
        connect() {},
        frequency: { setValueAtTime() {} },
        start() {},
        stop() {},
        type: "sine",
      };
    }

    createGain() {
      return {
        connect() {},
        gain: {
          exponentialRampToValueAtTime() {},
          setValueAtTime() {},
        },
      };
    }

    async suspend() {
      contextCalls.push("suspend");
      this.state = "suspended";
    }

    async resume() {
      contextCalls.push("resume");
      this.state = "running";
    }
  }

  class FakeAudio {
    constructor(source) {
      this.currentTime = 0;
      this.loop = false;
      this.preload = "";
      this.source = source;
      this.volume = 1;
      elements.push(this);
    }

    async play() {
      elementCalls.push("play");
    }

    pause() {
      elementCalls.push("pause");
    }
  }

  return {
    contexts,
    contextCalls,
    elements,
    elementCalls,
    globals: {
      Audio: FakeAudio,
      window: {
        AudioContext: FakeAudioContext,
        clearTimeout() {},
        setTimeout() {
          throw new Error("synthetic music timer should not be used");
        },
      },
    },
  };
}

async function withAudioGlobals(globals, action) {
  const originals = new Map();
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }

  try {
    await action();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }
}
