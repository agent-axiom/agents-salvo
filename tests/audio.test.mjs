import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as audioCore from "../src/core/audio.js";
import { createAudioController } from "../src/audio.js";

const { soundPresets, musicPreset, isKnownSound } = audioCore;
const combatSoundNames = ["shot", "miss", "hit", "sunk"];

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
  for (const source of audioCore.menuMusicTracks) {
    assert.match(source, /^file:/);
  }
  assert.deepEqual(
    audioCore.menuMusicTracks.map((source) => fileURLToPath(source)),
    [
      resolve("src/assets/audio/menu-loop.mp3"),
      resolve("src/assets/audio/menu-loop-v2.mp3"),
    ],
  );
});

test("configured menu mp3 audio assets exist in source tree", async () => {
  for (const source of audioCore.menuMusicTracks) {
    assert.match(source, /^file:.+\/assets\/audio\/.+\.mp3$/);
    await access(fileURLToPath(source));
  }
});

test("source tree keeps mp3 assets limited to the two menu loops", async () => {
  const files = await readdir(resolve("src/assets/audio"));
  assert.deepEqual(files.filter((file) => file.endsWith(".mp3")).sort(), [
    "menu-loop-v2.mp3",
    "menu-loop.mp3",
  ]);
});

test("each synthetic sound preset has playable sources", () => {
  for (const [name, preset] of Object.entries(soundPresets)) {
    assert.equal(isKnownSound(name), true);
    assert.ok(preset.duration > 0, `${name} duration should be positive`);
    const sources = preset.steps ?? preset.layers;
    assert.ok(sources?.length > 0, `${name} should have sound sources`);
    for (const source of sources) {
      assert.ok(source.duration > 0, `${name} source duration should be positive`);
      if (preset.steps || source.kind === "tone") {
        assert.ok(source.frequency > 0, `${name} tone frequency should be positive`);
        assert.match(source.type, /^(sine|square|sawtooth|triangle)$/);
      }
    }
  }
});

test("combat presets use bounded cinematic layers", () => {
  for (const name of combatSoundNames) {
    const preset = soundPresets[name];
    assert.ok(preset.duration > 0);
    assert.ok(preset.duration <= 1.5);
    assert.ok(preset.layers.length >= 2);

    for (const layer of preset.layers) {
      assert.match(layer.kind, /^(tone|noise)$/);
      assert.ok(layer.delay >= 0);
      assert.ok(layer.duration > 0);
      assert.ok(layer.delay + layer.duration <= preset.duration + 1e-9);
      assert.ok(layer.attack > 0 && layer.attack < layer.duration);
      assert.ok(layer.release > 0 && layer.release <= layer.duration);
      assert.ok(layer.gain > 0 && layer.gain <= 1);
    }
  }
});

test("combat presets encode a cannon, delayed outcomes, and staged destruction", () => {
  const shot = soundPresets.shot;
  const sunk = soundPresets.sunk;

  assert.equal(shot.duration, 0.58);
  assert.ok(shot.layers.some((layer) => layer.kind === "noise"));
  assert.ok(
    shot.layers.some(
      (layer) => layer.kind === "tone" && Math.min(layer.frequency, layer.endFrequency) < 100,
    ),
  );

  for (const name of ["miss", "hit", "sunk"]) {
    assert.equal(Math.min(...soundPresets[name].layers.map((layer) => layer.delay)), 0.1);
  }

  assert.equal(sunk.duration, 1.4);
  assert.ok(sunk.layers.some((layer) => layer.delay === 0.32));
  assert.ok(sunk.layers.filter((layer) => layer.kind === "noise").length >= 3);
});

test("musicPreset is a looping menu melody", () => {
  assert.equal(musicPreset.loop, true);
  assert.ok(musicPreset.notes.length >= 4);
});

test("play ignores disabled sounds without creating an audio context", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await controller.play("ui", false);

    assert.equal(audio.contexts.length, 0);
  });
});

test("play ignores sounds when no audio context implementation is available", async () => {
  const audio = audioHarness();
  audio.globals.window.AudioContext = undefined;
  audio.globals.window.webkitAudioContext = undefined;

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await controller.play("ui", true);
    await controller.play("unknown", true);

    assert.equal(audio.contexts.length, 0);
  });
});

test("play uses the webkit audio context fallback", async () => {
  const audio = audioHarness();
  audio.globals.window.webkitAudioContext = audio.globals.window.AudioContext;
  audio.globals.window.AudioContext = undefined;

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await controller.play("ui", true);

    assert.equal(audio.contexts.length, 1);
  });
});

test("combat sounds share one protected output bus and one noise buffer", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("shot", true);
    await controller.play("sunk", true);
  });

  assert.equal(audio.compressors.length, 1);
  assert.equal(audio.buffers.length, 1);
  assert.ok(audio.bufferSources.length >= 4);
  assert.ok(audio.filters.length >= 4);
  assert.ok(audio.oscillators.length >= 5);

  const [compressor] = audio.compressors;
  assert.deepEqual(compressor.parameterCalls.threshold, [
    ["setValueAtTime", -18, 0],
  ]);
  assert.deepEqual(compressor.parameterCalls.knee, [["setValueAtTime", 12, 0]]);
  assert.deepEqual(compressor.parameterCalls.ratio, [["setValueAtTime", 6, 0]]);
  assert.deepEqual(compressor.parameterCalls.attack, [
    ["setValueAtTime", 0.003, 0],
  ]);
  assert.deepEqual(compressor.parameterCalls.release, [
    ["setValueAtTime", 0.25, 0],
  ]);
  assert.ok(
    audio.gains.some(({ parameterCalls }) =>
      parameterCalls.some(
        ([method, value, time]) => method === "setValueAtTime" && value === 0.68 && time === 0,
      ),
    ),
  );
});

test("combat renderer schedules sweeps, delayed impacts, and finite stops", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("sunk", true);
  });

  assert.ok(
    audio.frequencyCalls.some(
      ([method, value, time]) =>
        method === "exponentialRampToValueAtTime" && value === 42 && time > 0,
    ),
  );
  assert.ok(audio.sourceStarts.some((time) => time === 0.1));
  assert.ok(audio.sourceStarts.some((time) => time === 0.32));
  assert.ok(audio.sourceStops.length > 0);
  assert.ok(audio.sourceStops.every((time) => Number.isFinite(time) && time <= 1.42));
});

test("menu music exits cleanly when no audio implementation is available", async () => {
  const audio = audioHarness();
  audio.globals.Audio = undefined;
  audio.globals.window.AudioContext = undefined;
  audio.globals.window.webkitAudioContext = undefined;

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await controller.startMusic(true);

    assert.equal(audio.elements.length, 0);
    assert.equal(audio.contexts.length, 0);
  });
});

test("rejected MP3 playback falls back to synthetic menu music", async () => {
  const audio = audioHarness();
  const failure = new Error("MP3 playback rejected");
  const timers = [];
  audio.globals.Audio.prototype.play = async function play() {
    audio.elementCalls.push("play");
    throw failure;
  };
  audio.globals.window.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();

    await assert.doesNotReject(controller.startMusic(true));

    assert.equal(audio.elements.length, 1);
    assert.equal(audio.contexts.length, 1);
    assert.equal(timers.length, 1);
    assert.deepEqual(audio.elementCalls, ["play"]);
    controller.stopMusic();
  });
});

test("stopping a pending MP3 start cleans up after playback resolves", async () => {
  const audio = audioHarness();
  const playStarted = deferred();
  const playPending = deferred();
  audio.globals.Audio.prototype.play = function play() {
    audio.elementCalls.push("play");
    playStarted.resolve();
    return playPending.promise;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    const starting = controller.startMusic(true);
    await playStarted.promise;

    controller.stopMusic();
    playPending.resolve();
    await starting;

    assert.equal(audio.contexts.length, 0);
    assert.equal(audio.elements[0].currentTime, 0);
    assert.deepEqual(audio.elementCalls, ["play", "pause", "pause"]);
  });
});

test("stopping a rejected pending MP3 start prevents synthetic fallback", async () => {
  const audio = audioHarness();
  const failure = new Error("pending MP3 playback rejected");
  const playStarted = deferred();
  const playPending = deferred();
  audio.globals.Audio.prototype.play = function play() {
    audio.elementCalls.push("play");
    playStarted.resolve();
    return playPending.promise;
  };

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    const starting = controller.startMusic(true);
    await playStarted.promise;

    controller.stopMusic();
    const completion = assert.doesNotReject(starting);
    playPending.reject(failure);
    await completion;

    assert.equal(audio.contexts.length, 0);
    assert.deepEqual(audio.elementCalls, ["play", "pause"]);
  });
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

test("lifecycle pause continues when a pending context resume rejects", async () => {
  const audio = audioHarness();
  const failure = new Error("audio context resume rejected");
  const resumeStarted = deferred();
  const resumePending = deferred();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("ui", true);
    await controller.pauseForLifecycle();
    const context = audio.contexts[0];
    context.resume = () => {
      audio.contextCalls.push("resume");
      resumeStarted.resolve();
      return resumePending.promise;
    };

    const rejectedResume = assert.rejects(
      controller.resumeForLifecycle(true, true),
      (error) => error === failure,
    );
    await resumeStarted.promise;
    const pausing = controller.pauseForLifecycle();
    resumePending.reject(failure);
    await Promise.all([rejectedResume, pausing]);

    assert.equal(context.state, "suspended");
    assert.deepEqual(audio.contextCalls, ["suspend", "resume"]);
  });
});

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function fakeAudioParam(calls) {
  return {
    exponentialRampToValueAtTime(value, time) {
      calls.push(["exponentialRampToValueAtTime", value, time]);
    },
    linearRampToValueAtTime(value, time) {
      calls.push(["linearRampToValueAtTime", value, time]);
    },
    setValueAtTime(value, time) {
      calls.push(["setValueAtTime", value, time]);
    },
  };
}

function audioHarness() {
  const buffers = [];
  const bufferSources = [];
  const compressors = [];
  const contexts = [];
  const contextCalls = [];
  const elements = [];
  const elementCalls = [];
  const filters = [];
  const frequencyCalls = [];
  const gains = [];
  const oscillators = [];
  const sourceStarts = [];
  const sourceStops = [];

  class FakeAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.sampleRate = 48000;
      this.state = "running";
      contexts.push(this);
    }

    createOscillator() {
      const oscillator = {
        connect() {},
        frequency: fakeAudioParam(frequencyCalls),
        start(time) {
          sourceStarts.push(time);
        },
        stop(time) {
          sourceStops.push(time);
        },
        type: "sine",
      };
      oscillators.push(oscillator);
      return oscillator;
    }

    createGain() {
      const parameterCalls = [];
      const gain = {
        connect() {},
        gain: fakeAudioParam(parameterCalls),
        parameterCalls,
      };
      gains.push(gain);
      return gain;
    }

    createBuffer(channels, frameCount, sampleRate) {
      const channelData = new Float32Array(frameCount);
      const buffer = {
        channels,
        frameCount,
        getChannelData(channel) {
          assert.equal(channel, 0);
          return channelData;
        },
        sampleRate,
      };
      buffers.push(buffer);
      return buffer;
    }

    createBufferSource() {
      const source = {
        buffer: null,
        connect() {},
        start(time) {
          sourceStarts.push(time);
        },
        stop(time) {
          sourceStops.push(time);
        },
      };
      bufferSources.push(source);
      return source;
    }

    createBiquadFilter() {
      const frequencyParameterCalls = [];
      const qParameterCalls = [];
      const filter = {
        connect() {},
        frequency: fakeAudioParam(frequencyParameterCalls),
        frequencyParameterCalls,
        Q: fakeAudioParam(qParameterCalls),
        qParameterCalls,
        type: "lowpass",
      };
      filters.push(filter);
      return filter;
    }

    createDynamicsCompressor() {
      const parameterCalls = {
        attack: [],
        knee: [],
        ratio: [],
        release: [],
        threshold: [],
      };
      const compressor = {
        attack: fakeAudioParam(parameterCalls.attack),
        connect() {},
        knee: fakeAudioParam(parameterCalls.knee),
        parameterCalls,
        ratio: fakeAudioParam(parameterCalls.ratio),
        release: fakeAudioParam(parameterCalls.release),
        threshold: fakeAudioParam(parameterCalls.threshold),
      };
      compressors.push(compressor);
      return compressor;
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
    buffers,
    bufferSources,
    compressors,
    contexts,
    contextCalls,
    elements,
    elementCalls,
    filters,
    frequencyCalls,
    gains,
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
    oscillators,
    sourceStarts,
    sourceStops,
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
