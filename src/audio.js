import { menuMusicTracks, musicPreset, soundPresets } from "./core/audio.js";

const MUSIC_VOLUME = 0.32;

export function createAudioController() {
  let context = null;
  let contextResumePromise = null;
  let musicGeneration = 0;
  let musicStartPromise = null;
  let musicTimer = null;
  let musicElement = null;

  const getContext = () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return null;
    }
    context ??= new AudioContext();
    return context;
  };

  const resumeContext = async (audioContext) => {
    if (audioContext.state !== "suspended") {
      return;
    }
    if (!contextResumePromise) {
      const operation = Promise.resolve().then(() => audioContext.resume());
      const tracked = operation.finally(() => {
        if (contextResumePromise === tracked) contextResumePromise = null;
      });
      contextResumePromise = tracked;
    }
    await contextResumePromise;
  };

  const ensureRunning = async () => {
    const audioContext = getContext();
    if (!audioContext) {
      return null;
    }
    await resumeContext(audioContext);
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

  const performMusicStart = async (generation) => {
    const track = chooseMenuTrack();
    if (track && (await startMp3Music(track, generation))) {
      return;
    }
    if (generation !== musicGeneration) {
      return;
    }

    const audioContext = await ensureRunning();
    if (!audioContext || generation !== musicGeneration) {
      return;
    }

    const loop = () => {
      if (generation !== musicGeneration) return;
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

  const startMusic = (enabled) => {
    if (!enabled) return Promise.resolve();
    if (musicStartPromise) return musicStartPromise;
    if (musicTimer !== null || musicElement) return Promise.resolve();

    const operation = performMusicStart(musicGeneration);
    const tracked = operation.finally(() => {
      if (musicStartPromise === tracked) musicStartPromise = null;
    });
    musicStartPromise = tracked;
    return tracked;
  };

  const stopMusic = () => {
    musicGeneration += 1;
    musicStartPromise = null;
    if (musicElement) {
      musicElement.pause();
      musicElement.currentTime = 0;
      musicElement = null;
    }
    if (musicTimer !== null) {
      window.clearTimeout(musicTimer);
      musicTimer = null;
    }
  };

  const pauseForLifecycle = async () => {
    stopMusic();
    if (contextResumePromise) {
      try {
        await contextResumePromise;
      } catch {
        // The resume caller observes its own failure; pausing still continues.
      }
    }
    if (context?.state === "running") {
      await context.suspend();
    }
  };

  const resumeForLifecycle = async (enabled, isMenu) => {
    if (!enabled || !isMenu) {
      return;
    }
    const generation = musicGeneration;
    if (context) await resumeContext(context);
    if (generation !== musicGeneration) return;
    await startMusic(true);
  };

  return {
    pauseForLifecycle,
    play,
    resumeForLifecycle,
    startMusic,
    stopMusic,
  };

  async function startMp3Music(source, generation) {
    if (typeof Audio === "undefined") {
      return false;
    }

    const element = new Audio(source);
    element.loop = true;
    element.preload = "auto";
    element.volume = MUSIC_VOLUME;
    musicElement = element;

    try {
      await element.play();
      if (generation !== musicGeneration || musicElement !== element) {
        element.pause();
        element.currentTime = 0;
      }
      return true;
    } catch {
      if (musicElement === element) musicElement = null;
      return false;
    }
  }
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

function chooseMenuTrack() {
  if (menuMusicTracks.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * menuMusicTracks.length);
  return menuMusicTracks[index];
}
