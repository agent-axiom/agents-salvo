import test from "node:test";
import assert from "node:assert/strict";

import { soundPresets, musicPreset, isKnownSound } from "../src/core/audio.js";

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
