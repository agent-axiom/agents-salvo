import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import * as audioCore from "../src/core/audio.js";

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
