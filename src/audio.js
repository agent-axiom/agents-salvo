import { musicPreset, soundPresets } from "./core/audio.js";

export function createAudioController() {
  let context = null;
  let musicTimer = null;

  const getContext = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return null;
    }
    context ??= new AudioContext();
    return context;
  };

  const ensureRunning = async () => {
    const audioContext = getContext();
    if (!audioContext) {
      return null;
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  };

  const play = async (name, enabled) => {
    if (!enabled) {
      return;
    }
    const preset = soundPresets[name];
    const audioContext = await ensureRunning();
    if (!preset || !audioContext) {
      return;
    }

    let offset = 0;
    for (const step of preset.steps) {
      playTone(audioContext, step, preset.gain, offset);
      offset += step.duration;
    }
  };

  const startMusic = async (enabled) => {
    if (!enabled || musicTimer) {
      return;
    }
    const audioContext = await ensureRunning();
    if (!audioContext) {
      return;
    }

    const loop = () => {
      let offset = 0;
      for (const note of musicPreset.notes) {
        playTone(
          audioContext,
          { type: "sine", frequency: note.frequency, duration: note.duration },
          musicPreset.gain,
          offset,
        );
        offset += note.duration;
      }
      musicTimer = window.setTimeout(loop, offset * 1000);
    };
    loop();
  };

  const stopMusic = () => {
    if (musicTimer) {
      window.clearTimeout(musicTimer);
      musicTimer = null;
    }
  };

  return {
    play,
    startMusic,
    stopMusic,
  };
}

function playTone(audioContext, step, gainValue, offset) {
  const start = audioContext.currentTime + offset;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = step.type;
  oscillator.frequency.setValueAtTime(step.frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + step.duration);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + step.duration + 0.02);
}
