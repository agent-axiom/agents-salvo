# Cinematic Procedural Battle Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace electronic combat beeps with layered procedural naval shots, impacts, splashes, and ship-destruction effects without adding media files.

**Architecture:** Keep existing sequential `steps` for UI and notification sounds, while allowing combat presets to define parallel `layers`. Extend the shared audio controller with a lazily-created protected output bus, reusable white-noise buffer, tone sweeps, filtered noise, and bounded envelopes.

**Tech Stack:** JavaScript ES modules, Web Audio API, Node.js test runner, fake Web Audio nodes in `tests/audio.test.mjs`.

---

## File Structure

- Modify `src/core/audio.js`: own the declarative cinematic combat preset data and timing bounds.
- Modify `src/audio.js`: render legacy steps and new layered presets through one protected Web Audio output bus.
- Modify `tests/audio.test.mjs`: validate preset semantics and record the generated Web Audio graph.

### Task 1: Define Cinematic Combat Presets

**Files:**
- Modify: `tests/audio.test.mjs`
- Modify: `src/core/audio.js`

- [ ] **Step 1: Write failing preset-contract tests**

Add tests that distinguish legacy sequential presets from layered combat presets and enforce the approved timing:

```js
const combatSoundNames = ["shot", "miss", "hit", "sunk"];

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
      assert.ok(layer.delay + layer.duration <= preset.duration);
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
```

Update the existing generic preset test so it accepts either non-empty `steps` or non-empty `layers`, while retaining all legacy oscillator assertions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test tests/audio.test.mjs
```

Expected: FAIL because combat presets do not yet expose `layers` and still use short sequential oscillator steps.

- [ ] **Step 3: Replace the four combat presets with layered definitions**

In `src/core/audio.js`, keep `ui`, `turn`, `roomReady`, `victory`, and `defeat` unchanged. Replace `shot`, `miss`, `hit`, and `sunk` with bounded layer objects using this schema:

```js
{
  duration: 0.58,
  layers: [
    {
      kind: "noise",
      delay: 0,
      duration: 0.075,
      attack: 0.003,
      release: 0.07,
      gain: 0.55,
      filter: { type: "highpass", frequency: 850, q: 0.7 },
    },
    {
      kind: "tone",
      type: "sawtooth",
      frequency: 210,
      endFrequency: 95,
      delay: 0,
      duration: 0.24,
      attack: 0.005,
      release: 0.2,
      gain: 0.22,
    },
    {
      kind: "tone",
      type: "sine",
      frequency: 92,
      endFrequency: 48,
      delay: 0,
      duration: 0.46,
      attack: 0.008,
      release: 0.4,
      gain: 0.45,
    },
    {
      kind: "noise",
      delay: 0.025,
      duration: 0.555,
      attack: 0.012,
      release: 0.48,
      gain: 0.18,
      filter: { type: "lowpass", frequency: 420, q: 0.6 },
    },
  ],
}
```

Use these complete layer sets for the other outcomes:

```js
miss: {
  duration: 0.55,
  layers: [
    {
      kind: "noise",
      delay: 0.1,
      duration: 0.45,
      attack: 0.008,
      release: 0.38,
      gain: 0.2,
      filter: { type: "bandpass", frequency: 900, q: 0.8 },
    },
    {
      kind: "tone",
      type: "sine",
      frequency: 280,
      endFrequency: 120,
      delay: 0.13,
      duration: 0.34,
      attack: 0.015,
      release: 0.28,
      gain: 0.09,
    },
  ],
},
hit: {
  duration: 0.7,
  layers: [
    {
      kind: "noise",
      delay: 0.1,
      duration: 0.12,
      attack: 0.003,
      release: 0.1,
      gain: 0.36,
      filter: { type: "highpass", frequency: 600, q: 0.9 },
    },
    {
      kind: "tone",
      type: "triangle",
      frequency: 620,
      endFrequency: 170,
      delay: 0.1,
      duration: 0.2,
      attack: 0.004,
      release: 0.17,
      gain: 0.16,
    },
    {
      kind: "noise",
      delay: 0.12,
      duration: 0.48,
      attack: 0.008,
      release: 0.4,
      gain: 0.32,
      filter: { type: "lowpass", frequency: 780, q: 0.7 },
    },
    {
      kind: "tone",
      type: "sine",
      frequency: 105,
      endFrequency: 58,
      delay: 0.12,
      duration: 0.5,
      attack: 0.01,
      release: 0.42,
      gain: 0.27,
    },
    {
      kind: "noise",
      delay: 0.2,
      duration: 0.5,
      attack: 0.01,
      release: 0.44,
      gain: 0.12,
      filter: { type: "bandpass", frequency: 1100, q: 0.6 },
    },
  ],
},
sunk: {
  duration: 1.4,
  layers: [
    {
      kind: "noise",
      delay: 0.1,
      duration: 0.48,
      attack: 0.004,
      release: 0.42,
      gain: 0.45,
      filter: { type: "lowpass", frequency: 850, q: 0.8 },
    },
    {
      kind: "tone",
      type: "sine",
      frequency: 95,
      endFrequency: 42,
      delay: 0.1,
      duration: 0.78,
      attack: 0.008,
      release: 0.68,
      gain: 0.4,
    },
    {
      kind: "tone",
      type: "triangle",
      frequency: 360,
      endFrequency: 92,
      delay: 0.1,
      duration: 0.35,
      attack: 0.004,
      release: 0.3,
      gain: 0.16,
    },
    {
      kind: "noise",
      delay: 0.32,
      duration: 0.45,
      attack: 0.004,
      release: 0.39,
      gain: 0.38,
      filter: { type: "bandpass", frequency: 520, q: 0.9 },
    },
    {
      kind: "tone",
      type: "sawtooth",
      frequency: 180,
      endFrequency: 70,
      delay: 0.32,
      duration: 0.45,
      attack: 0.006,
      release: 0.38,
      gain: 0.18,
    },
    {
      kind: "tone",
      type: "triangle",
      frequency: 150,
      endFrequency: 42,
      delay: 0.48,
      duration: 0.82,
      attack: 0.02,
      release: 0.7,
      gain: 0.17,
    },
    {
      kind: "noise",
      delay: 0.48,
      duration: 0.92,
      attack: 0.02,
      release: 0.8,
      gain: 0.17,
      filter: { type: "lowpass", frequency: 1600, q: 0.5 },
    },
    {
      kind: "tone",
      type: "sine",
      frequency: 62,
      endFrequency: 34,
      delay: 0.55,
      duration: 0.85,
      attack: 0.025,
      release: 0.74,
      gain: 0.26,
    },
  ],
},
```

All layer gains stay at or below `0.55`. Filters use `lowpass`, `highpass`, or `bandpass`; filter frequencies stay between `120` and `2400 Hz` so the effect remains audible on phone speakers.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/audio.test.mjs
```

Expected: all audio tests pass.

- [ ] **Step 5: Commit the preset contract**

```bash
git add src/core/audio.js tests/audio.test.mjs
git commit -m "feat: define cinematic battle sound layers"
```

### Task 2: Render Layered Audio Through A Protected Bus

**Files:**
- Modify: `tests/audio.test.mjs`
- Modify: `src/audio.js`

- [ ] **Step 1: Extend the fake Web Audio harness**

Record oscillators, gains, buffer sources, buffers, filters, and compressors. Use a reusable fake parameter with all methods exercised by production:

```js
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
```

`FakeAudioContext` must expose `sampleRate = 48000`, `createBuffer`, `createBufferSource`, `createBiquadFilter`, and `createDynamicsCompressor`. Fake buffers expose `getChannelData(0)` as a `Float32Array`.

- [ ] **Step 2: Write failing graph tests**

Add focused tests:

```js
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
});

test("combat renderer schedules sweeps, delayed impacts, and finite stops", async () => {
  const audio = audioHarness();

  await withAudioGlobals(audio.globals, async () => {
    const controller = createAudioController();
    await controller.play("sunk", true);
  });

  assert.ok(
    audio.frequencyCalls.some(
      ([method, value, time]) => method === "exponentialRampToValueAtTime" && value === 42 && time > 0,
    ),
  );
  assert.ok(audio.sourceStarts.some((time) => time === 0.1));
  assert.ok(audio.sourceStarts.some((time) => time === 0.32));
  assert.ok(audio.sourceStops.every((time) => Number.isFinite(time) && time <= 1.42));
});
```

Also assert compressor threshold, knee, ratio, attack, release, and master gain are set to fixed conservative values.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test tests/audio.test.mjs
```

Expected: FAIL because the controller only creates sequential oscillators and connects them directly to `destination`.

- [ ] **Step 4: Add a lazy protected output bus**

In `createAudioController`, add controller-scoped `effectBus` and `noiseBuffer` caches. Build the bus only after `ensureRunning()` returns a context:

```js
const getEffectBus = (audioContext) => {
  if (effectBus) return effectBus;

  const master = audioContext.createGain();
  const compressor = audioContext.createDynamicsCompressor();
  const now = audioContext.currentTime;
  master.gain.setValueAtTime(0.68, now);
  compressor.threshold.setValueAtTime(-18, now);
  compressor.knee.setValueAtTime(12, now);
  compressor.ratio.setValueAtTime(6, now);
  compressor.attack.setValueAtTime(0.003, now);
  compressor.release.setValueAtTime(0.25, now);
  master.connect(compressor);
  compressor.connect(audioContext.destination);
  effectBus = master;
  return effectBus;
};
```

Route legacy `playTone` calls through this bus as well, preserving their sequence and envelopes.

- [ ] **Step 5: Render tone layers with pitch sweeps**

Add `playToneLayer(audioContext, output, layer)` that:

- starts at `currentTime + layer.delay`;
- sets the initial positive frequency;
- exponentially ramps to `endFrequency` at the layer end;
- applies an attack, hold-until-release, and exponential release to `0.0001`;
- connects oscillator -> layer gain -> output;
- stops no later than `end + 0.02`.

Reuse a shared `applyEnvelope(gainParam, start, duration, attack, release, peak)` helper for tone and noise layers.

- [ ] **Step 6: Render filtered noise from one cached buffer**

Create a 1.5-second mono white-noise buffer once per controller/context:

```js
const getNoiseBuffer = (audioContext) => {
  if (noiseBuffer) return noiseBuffer;
  const frameCount = Math.ceil(audioContext.sampleRate * 1.5);
  noiseBuffer = audioContext.createBuffer(1, frameCount, audioContext.sampleRate);
  const samples = noiseBuffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
};
```

Add `playNoiseLayer(audioContext, output, layer, buffer)` that connects buffer source -> optional biquad filter -> gain -> output. Configure filter `type`, frequency, and Q at the layer start. Start and stop the source with the same finite timing rules as tone layers.

- [ ] **Step 7: Dispatch layered and legacy presets**

In `play(name, enabled)`, obtain the protected bus after the preset and context are valid. If `preset.layers` exists, schedule every layer in parallel without accumulating offsets. Otherwise retain the current sequential `steps` loop.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/audio.test.mjs
```

Expected: all audio tests pass, including disabled, unavailable, lifecycle, MP3 fallback, and new graph assertions.

- [ ] **Step 9: Commit the audio graph**

```bash
git add src/audio.js tests/audio.test.mjs
git commit -m "feat: synthesize cinematic naval combat audio"
```

### Task 3: Regression, Coverage, And Shared-Build Verification

**Files:**
- Verify only; modify implementation or tests only if a command exposes a regression.

- [ ] **Step 1: Run the full suite**

Run:

```bash
npm test
```

Expected: all tests pass, including headless Chrome and native-shell contracts.

- [ ] **Step 2: Run coverage gates**

Run:

```bash
npm run coverage
```

Expected: every configured line-coverage gate passes, including actual application and critical build/Worker gates.

- [ ] **Step 3: Build all shared web shells**

Run:

```bash
npm run build
```

Expected: `dist/`, `dist/telegram/`, and `dist/max/` use the same hashed application bundle.

- [ ] **Step 4: Verify native synchronization**

Run:

```bash
npm run mobile:verify
```

Expected: Capacitor synchronizes the shared bundle and all eight plugins into Android and iOS without tracked-file drift.

- [ ] **Step 5: Check repository hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only planned source, test, and plan changes are present.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required a scoped correction, stage only its exact files and commit:

```bash
git add src/audio.js src/core/audio.js tests/audio.test.mjs
git commit -m "test: harden cinematic battle audio"
```

If no correction was needed, do not create an empty commit.
