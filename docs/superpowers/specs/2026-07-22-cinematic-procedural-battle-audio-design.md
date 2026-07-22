# Cinematic Procedural Battle Audio Design

## Context

Salvo currently synthesizes effects as short sequences of basic oscillator tones. This keeps the application small and portable, but shots and explosions sound electronic rather than like naval artillery. The menu music remains the only MP3 content; previous sampled combat effects were intentionally removed.

## Goal

Replace the synthetic character of the shot, hit, miss, and sunk effects with a cinematic naval sound while keeping all combat audio procedural. The same implementation must run from the shared codebase in web, Android, iOS, Telegram Mini App, and MAX Mini App builds.

## Non-goals

- Add downloadable MP3, OGG, or WAV combat assets.
- Change the sound toggle, music behavior, haptics, or gameplay event model.
- Add an equalizer, volume mixer, or sound-style selector.
- Rework victory, defeat, room, turn, placement, or UI sounds beyond compatibility with the new output bus.

## Chosen Approach

Use layered Web Audio synthesis. Simple UI and notification presets can keep their existing sequential tone steps. Combat presets may define parallel tone and filtered-noise layers with independent delays and envelopes.

The effect renderer will support:

- tone layers with waveform, start and end frequency, delay, duration, attack, release, and gain;
- noise layers with delay, duration, attack, release, gain, and optional biquad filter settings;
- repeated layers expressed explicitly in the preset rather than through unbounded timers;
- an effect output bus with a conservative gain stage and dynamics compressor to prevent clipping when a shot and its outcome overlap.

A reusable white-noise buffer will be created lazily per `AudioContext`. No sound work or audio context will be created while sound is disabled.

## Sound Direction

### Shot

The shot targets a 580 ms total duration and must not exceed 650 ms. It combines:

1. a very short filtered-noise crack for the muzzle transient;
2. a mid-frequency sawtooth or triangle pitch drop for audible impact on phone speakers;
3. a low sine pitch sweep for the cannon body;
4. a quiet filtered-noise tail for the pressure wave.

The result should feel heavy without relying only on sub-bass that small speakers cannot reproduce.

### Hit

The hit starts 100 ms after invocation because the application intentionally triggers `shot` and the outcome together. It combines a metallic transient, a compact noise explosion, and a short low-frequency body. Its total scheduled duration must not exceed 700 ms. It must be clearly stronger than a miss but shorter than a sunk effect.

### Miss

The miss starts 100 ms after invocation and uses a band-limited noise splash plus a soft descending tone. Its total scheduled duration must not exceed 550 ms. It stays quieter and less bass-heavy than hit or sunk, preserving immediate result recognition.

### Sunk

The sunk effect starts 100 ms after invocation, targets a 1.4 second total duration, and must not exceed 1.5 seconds. It combines:

1. a primary explosion;
2. a secondary detonation at 320 ms;
3. a sustained low rumble;
4. a descending metallic groan;
5. a filtered debris/noise tail.

All layers use bounded start and stop times. The effect must remain intelligible when the victory or defeat sound begins immediately afterward.

## Compatibility And Failure Behavior

- Continue using `AudioContext` with the existing `webkitAudioContext` fallback.
- Keep the existing no-op behavior when Web Audio is unavailable.
- Build the compressor and filters only after a valid context has been obtained.
- Keep gains conservative and route every combat layer through the effect bus.
- If a preset uses only legacy `steps`, preserve the current renderer behavior.
- Do not add background timers or resources that survive application lifecycle suspension.

## Testing

Tests will define the new behavior before implementation:

- combat presets contain the required cinematic layer types and bounded values;
- hit, miss, and sunk include an impact delay that follows the shot transient;
- shot and sunk contain both noise and pitched low-frequency layers;
- the controller schedules parallel layers through one protected output bus;
- tone sweeps, noise filters, gain envelopes, and finite stop times are applied;
- the noise buffer is reused within one audio context;
- disabled audio and missing Web Audio remain no-ops;
- legacy tone-only presets and menu lifecycle tests continue to pass;
- the source tree still contains only the two existing menu MP3 files.

## Acceptance Criteria

- Shot sounds like a naval cannon rather than two electronic beeps.
- Hit, miss, and sunk remain distinguishable on phone speakers.
- Sunk audibly includes primary and secondary destruction stages.
- Concurrent shot and outcome playback does not clip or throw.
- No new media files or user settings are introduced.
- Full tests, coverage gates, production build, and mobile verification pass.
