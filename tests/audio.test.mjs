import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import * as audioCore from "../src/core/audio.js";

const { soundPresets, musicPreset, isKnownSound } = audioCore;

const expectedSoundAssets = {
  defeat: "./assets/audio/defeat.mp3",
  hit: "./assets/audio/hit.mp3",
  miss: "./assets/audio/miss.mp3",
  placeShip: "./assets/audio/place-ship.mp3",
  roomReady: "./assets/audio/room-ready.mp3",
  shot: "./assets/audio/shot.mp3",
  sunk: "./assets/audio/sunk.mp3",
  turn: "./assets/audio/turn.mp3",
  ui: "./assets/audio/ui-click.mp3",
  victory: "./assets/audio/victory.mp3",
};

test("soundPresets include all gameplay and interface events", () => {
  assert.deepEqual(
    Object.keys(soundPresets).sort(),
    [
      "defeat",
      "hit",
      "miss",
      "placeShip",
      "roomReady",
      "shot",
      "sunk",
      "turn",
      "ui",
      "victory",
    ],
  );
});

test("soundAssets map every gameplay and interface event to an mp3 file", () => {
  assert.deepEqual(audioCore.soundAssets, expectedSoundAssets);
});

test("menuMusicTracks include both mp3 menu loops", () => {
  assert.deepEqual(audioCore.menuMusicTracks, [
    "./assets/audio/menu-loop.mp3",
    "./assets/audio/menu-loop-v2.mp3",
  ]);
});

test("configured mp3 audio assets exist in source tree", async () => {
  const sources = [...Object.values(audioCore.soundAssets ?? {}), ...(audioCore.menuMusicTracks ?? [])];

  assert.equal(sources.length, 12);
  for (const source of sources) {
    assert.match(source, /^\.\/assets\/audio\/.+\.mp3$/);
    await access(resolve("src", source.slice(2)));
  }
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
