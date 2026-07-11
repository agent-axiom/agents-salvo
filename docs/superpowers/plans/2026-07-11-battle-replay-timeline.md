# Battle Replay Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible replay range slider and one-click navigation to the battle's key moments.

**Architecture:** Keep deterministic moment-to-turn normalization in `src/core/replay.js` and UI orchestration beside the existing replay renderer in `src/app.js`. Reuse `buildBattleReport()` as the single source of key moments, route all manual navigation through one turn setter that stops autoplay, and replace only the replay subtree while preserving modal scroll and focus.

**Tech Stack:** Vanilla JavaScript, HTML templates, CSS, Node test runner, custom build script.

---

### Task 1: Specify replay moment navigation

**Files:**
- Modify: `tests/replay.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`
- Modify: `tests/i18n.test.mjs`

- [ ] **Step 1: Write failing pure-function tests**

Import `replayMomentTurn` and assert that `{ turn: 3 }` resolves to `3`, `{ startTurn: 5, endTurn: 8 }` resolves to `8`, out-of-range turns clamp to the replay bounds, and malformed moments resolve to `0`.

- [ ] **Step 2: Write the failing UX contract test**

Require a `type="range"` control with the `result-replay-seek` action, moment buttons with `result-replay-jump`, localized labels, `aria-valuetext`, `aria-current`, one shared `setResultReplayTurn()` helper, a range change handler, and responsive timeline CSS.

- [ ] **Step 3: Write the failing localization test**

Require `replay.timeline` and `replay.seek` in English, Russian, and Simplified Chinese.

- [ ] **Step 4: Run focused tests and verify RED**

Run: `node --test tests/replay.test.mjs tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: FAIL because timeline normalization, controls, styles, handlers, and translations do not exist.

### Task 2: Implement deterministic seeking

**Files:**
- Modify: `src/core/replay.js`
- Modify: `src/app.js`
- Modify: `src/i18n.js`

- [ ] **Step 1: Implement moment turn normalization**

Add `replayMomentTurn(moment, totalTurns)`. Prefer `moment.turn`, then `moment.endTurn`, then `moment.startTurn`; reject non-finite or non-positive totals and clamp valid turns with `normalizeReplayTurn()`.

- [ ] **Step 2: Render the timeline and moment buttons**

Pass `report.moments` to `renderBattleReplay()`. Render the current move range, localized `aria-valuetext`, and only moments whose normalized turn is non-zero. Mark a moment active when its turn equals the selected replay turn.

- [ ] **Step 3: Route navigation through one setter**

Add `setResultReplayTurn(turn)`, stop playback there, normalize the requested turn, and refresh only the replay frame. Make Previous, Next, range changes, and moment jumps call this helper.

- [ ] **Step 4: Preserve focus for the range and moment buttons**

Capture the focused action plus moment id before replacing the replay subtree. Restore focus to the corresponding range, moment, or playback control without scrolling.

- [ ] **Step 5: Add translations**

Add English `Timeline` / `Choose replay move`, Russian `Хронология` / `Выбрать ход повтора`, and Simplified Chinese `时间线` / `选择回放回合`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/replay.test.mjs tests/ux-redesign.test.mjs tests/i18n.test.mjs`

Expected: PASS.

### Task 3: Style the responsive timeline

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add the timeline track layout**

Place the move counter and range on one compact row, give the range a stable full width, and use existing paper/ink tokens for its focus and accent colors.

- [ ] **Step 2: Add moment chips**

Render key moments as wrapping compact buttons with a 44-pixel minimum target, selected styling, and no nested cards.

- [ ] **Step 3: Add mobile behavior**

Stack the timeline label above the range on narrow screens while keeping moment buttons readable and horizontally efficient.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/replay.test.mjs tests/ux-redesign.test.mjs tests/i18n.test.mjs`

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

- [ ] **Step 3: Build and check the patch**

Run: `npm run build`

Expected: `dist` builds successfully.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Verify in the browser**

Reach a completed agent battle, seek with the slider, jump through every available moment, start autoplay and interrupt it with a seek, then repeat the layout check at 390x844.

- [ ] **Step 5: Commit and deploy**

Stage the timeline files, commit with `feat: add replay timeline`, push `main`, wait for the GitHub Pages workflow, and verify the public URL returns HTTP 200.
