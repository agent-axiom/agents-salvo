# Battle Replay Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable Play/Pause, 1x/1.5x/2x speed selection, and an accessible active-shot pulse to the battle replay.

**Architecture:** Keep playback orchestration in `src/app.js` beside the existing replay renderer and navigation. Store only serializable UI state in `state`, keep the interval handle module-local, and route every exit path through a single cleanup helper so no timer survives a closed result modal. CSS supplies the pulse and disables it for reduced motion.

**Tech Stack:** Vanilla JavaScript, HTML templates, CSS, Node test runner, custom build script.

---

### Task 1: Specify playback controls and lifecycle

**Files:**
- Modify: `tests/ux-redesign.test.mjs`
- Modify: `tests/i18n.test.mjs`

- [ ] **Step 1: Write the failing UX test**

Extend the replay test with assertions for `resultReplayPlaying`, `resultReplaySpeedIndex`, `resultReplayTimer`, the Play/Pause and speed actions, playback lifecycle helpers, `setInterval`, `clearInterval`, the pulse pseudo-element, and reduced-motion handling.

- [ ] **Step 2: Write the failing localization test**

Require `replay.play`, `replay.pause`, and `replay.speed` in every locale.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: FAIL because playback state, controls, helpers, CSS pulse, and localization keys do not exist.

### Task 2: Implement deterministic replay playback

**Files:**
- Modify: `src/app.js`
- Modify: `src/i18n.js`

- [ ] **Step 1: Add playback state and speed definitions**

Add `resultReplayPlaying: false`, `resultReplaySpeedIndex: 0`, one module-level `resultReplayTimer`, and immutable speed choices for 1x, 1.5x, and 2x.

- [ ] **Step 2: Render playback controls**

Render Play/Pause and speed-cycle buttons before Previous/Next. The labels come from i18n and the speed button includes the active multiplier.

- [ ] **Step 3: Implement the timer lifecycle**

Add helpers to start, stop, clear, toggle, and restart playback. A tick advances exactly one move. Playback stops and re-renders at the final move. Play at the final move resets to move one first.

- [ ] **Step 4: Integrate manual controls and exits**

Previous/Next stop playback before changing the turn. Closing results, returning to menu, starting setup/training/online, and requesting an online rematch clear playback through the same reset helper.

- [ ] **Step 5: Add translations**

Add English, Russian, and Simplified Chinese labels for Play, Pause, and `Speed {speed}`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: PASS.

### Task 3: Add active-shot motion and responsive layout

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add compact playback layout**

Use a four-column desktop control grid and a two-column mobile grid so labels stay readable.

- [ ] **Step 2: Add the active-shot pulse**

Render a non-interactive ring from `.cell.replay-active::before` and animate it with `@keyframes replayShotPulse`.

- [ ] **Step 3: Respect reduced motion**

Disable the pulse animation inside `@media (prefers-reduced-motion: reduce)` while preserving the static active-cell outline.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: PASS.

### Task 4: Verify and release

**Files:**
- Verify: all modified files

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run coverage**

Run: `npm run coverage`

Expected: line coverage remains at or above 98%.

- [ ] **Step 3: Build and lint the patch**

Run: `npm run build`

Expected: `dist` builds successfully.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Commit and deploy**

Stage the replay files, commit with `feat: animate battle replay`, push `main`, wait for the GitHub Pages workflow, and verify the public URL returns HTTP 200.
