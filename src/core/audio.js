import { assetUrl } from "../asset-url.js";

export const menuMusicTracks = [
  assetUrl("./assets/audio/menu-loop.mp3"),
  assetUrl("./assets/audio/menu-loop-v2.mp3"),
];

export const soundPresets = {
  ui: {
    duration: 0.08,
    gain: 0.05,
    steps: [{ type: "triangle", frequency: 520, duration: 0.08 }],
  },
  shot: {
    duration: 0.24,
    gain: 0.11,
    steps: [
      { type: "sawtooth", frequency: 120, duration: 0.08 },
      { type: "square", frequency: 82, duration: 0.16 },
    ],
  },
  miss: {
    duration: 0.34,
    gain: 0.08,
    steps: [
      { type: "sine", frequency: 240, duration: 0.12 },
      { type: "sine", frequency: 170, duration: 0.22 },
    ],
  },
  hit: {
    duration: 0.3,
    gain: 0.1,
    steps: [
      { type: "square", frequency: 180, duration: 0.08 },
      { type: "sawtooth", frequency: 260, duration: 0.1 },
      { type: "triangle", frequency: 132, duration: 0.12 },
    ],
  },
  sunk: {
    duration: 0.72,
    gain: 0.12,
    steps: [
      { type: "sawtooth", frequency: 220, duration: 0.12 },
      { type: "square", frequency: 164, duration: 0.18 },
      { type: "sine", frequency: 86, duration: 0.42 },
    ],
  },
  victory: {
    duration: 0.88,
    gain: 0.09,
    steps: [
      { type: "triangle", frequency: 392, duration: 0.18 },
      { type: "triangle", frequency: 494, duration: 0.18 },
      { type: "triangle", frequency: 587, duration: 0.24 },
      { type: "sine", frequency: 784, duration: 0.28 },
    ],
  },
  defeat: {
    duration: 0.9,
    gain: 0.08,
    steps: [
      { type: "triangle", frequency: 330, duration: 0.2 },
      { type: "triangle", frequency: 247, duration: 0.22 },
      { type: "sine", frequency: 196, duration: 0.48 },
    ],
  },
  turn: {
    duration: 0.18,
    gain: 0.055,
    steps: [
      { type: "sine", frequency: 330, duration: 0.09 },
      { type: "sine", frequency: 440, duration: 0.09 },
    ],
  },
  roomReady: {
    duration: 0.46,
    gain: 0.07,
    steps: [
      { type: "triangle", frequency: 440, duration: 0.14 },
      { type: "triangle", frequency: 660, duration: 0.14 },
      { type: "sine", frequency: 880, duration: 0.18 },
    ],
  },
};

export const musicPreset = {
  loop: true,
  gain: 0.035,
  notes: [
    { frequency: 196, duration: 0.42 },
    { frequency: 247, duration: 0.42 },
    { frequency: 294, duration: 0.56 },
    { frequency: 247, duration: 0.42 },
    { frequency: 220, duration: 0.42 },
    { frequency: 262, duration: 0.56 },
    { frequency: 330, duration: 0.84 },
  ],
};

export function isKnownSound(name) {
  return Object.hasOwn(soundPresets, name);
}
