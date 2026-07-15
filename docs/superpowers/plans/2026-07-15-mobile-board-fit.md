# Mobile Board Fit And Extended Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every 8x8 and 10x10 board fit the mobile viewport without horizontal scrolling while giving 16x16 boards explicit, readable zoom controls.

**Architecture:** `renderBoard` classifies boards by size and exposes controls only for extended boards. CSS uses fractional tracks for normal boards and a bounded pixel cell variable inside a native scroll viewport for 16x16. One small state value owns extended zoom across setup, battle, training, and replay screens.

**Tech Stack:** Vanilla JavaScript, CSS Grid, Node test runner, Capacitor Android WebView.

---

## File Map

- Modify `src/app.js`: board size classes, zoom state, controls, handlers, reset behavior.
- Modify `src/styles.css`: normal fit rules and extended viewport rules.
- Modify `src/i18n.js`: zoom control labels for EN/RU/ZH.
- Modify `tests/ux-redesign.test.mjs`: rendered contract and responsive CSS assertions.
- Modify `tests/app-behavior-harness.mjs`: board zoom interaction harness.
- Modify `tests/app-behavior.test.mjs`: zoom clamp/reset behavior.
- Create `tests/mobile-board-layout.test.mjs`: static layout regression assertions.
- Create `android/app/src/androidTest/java/io/github/agentaxiom/salvo/BoardViewportSmokeTest.java`: real WebView overflow assertions.

### Task 1: Replace The Fixed Mobile Cell Contract

**Files:**
- Create: `tests/mobile-board-layout.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`
- Create: `android/app/src/androidTest/java/io/github/agentaxiom/salvo/BoardViewportSmokeTest.java`

- [ ] **Step 1: Write failing fit-contract tests**

Assert that `renderBoard` emits `is-fit-board` for size `<= 10` and
`is-extended-board` for size `> 10`. Assert mobile CSS contains:

```css
.board-scroll.is-fit-board { overflow-x: visible; }
.is-fit-board .coordinate-board { width: 100%; min-width: 0; }
.is-fit-board .board-grid { grid-template-columns: repeat(var(--board-size), minmax(0, 1fr)); }
.is-fit-board .cell { min-width: 0; min-height: 0; }
```

Explicitly reject the old global mobile rules `minmax(44px, 1fr)` and `.cell {
min-width: 44px; min-height: 44px; }` under the board media query.

- [ ] **Step 2: Add the failing real-WebView assertion**

Launch `MainActivity`, evaluate JavaScript in the Capacitor WebView, navigate to a
10x10 setup board, and assert:

```js
document.querySelector('.board-scroll.is-fit-board').scrollWidth <=
document.querySelector('.board-scroll.is-fit-board').clientWidth + 1
```

Also assert `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs`

Expected: FAIL because all mobile boards still force 44px cells and overflow.

Run: `npm run mobile:sync && android/gradlew -p android connectedDebugAndroidTest`

Expected: the WebView viewport assertion fails on the old 44px layout.

- [ ] **Step 4: Add board classification markup**

In `renderBoard`, derive:

```js
const boardSizeClass = board.size <= 10 ? "is-fit-board" : "is-extended-board";
```

Apply it to `.board-scroll` and `.coordinate-board`. Preserve `--board-size` and all
existing role/grid/ARIA behavior.

- [ ] **Step 5: Implement normal board fit CSS**

At `max-width: 720px`, reserve a `26px` row-label gutter and `22px` column-label row,
set normal board tracks to `minmax(0, 1fr)`, remove cell minimums, and keep the board
square. Ensure parent panels use `min-width: 0`.

- [ ] **Step 6: Run fit tests**

Run: `node --test tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs`

Expected: PASS.

- [ ] **Step 7: Run the WebView assertion and verify GREEN**

Run: `npm run mobile:sync && android/gradlew -p android connectedDebugAndroidTest`

Expected: PASS with no board or page-level horizontal overflow.

- [ ] **Step 8: Commit normal mobile fit**

```bash
git add src/app.js src/styles.css tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs android/app/src/androidTest/java/io/github/agentaxiom/salvo/BoardViewportSmokeTest.java
git commit -m "fix: fit normal boards on phones"
```

### Task 2: Add Bounded 16x16 Zoom State

**Files:**
- Modify: `src/app.js`
- Modify: `src/i18n.js`
- Modify: `tests/app-behavior-harness.mjs`
- Modify: `tests/app-behavior.test.mjs`
- Modify: `tests/i18n.test.mjs`
- Modify: `android/app/src/androidTest/java/io/github/agentaxiom/salvo/BoardViewportSmokeTest.java`

- [ ] **Step 1: Write failing zoom behavior tests**

Use constants and expected transitions:

```js
const EXTENDED_BOARD_ZOOM_MIN = 24;
const EXTENDED_BOARD_ZOOM_DEFAULT = 32;
const EXTENDED_BOARD_ZOOM_MAX = 48;
const EXTENDED_BOARD_ZOOM_STEP = 4;
```

Assert zoom-out clamps at `24`, reset returns `32`, zoom-in clamps at `48`, a new
game resets to `32`, and size-10 rendering contains no zoom toolbar.

Extend the WebView smoke test to navigate with existing `data-action` controls to the
16x16 preset, then assert the zoom toolbar exists, the dedicated board viewport is
scrollable, and zoom actions change the cell-size CSS variable within `[24px, 48px]`.

- [ ] **Step 2: Run behavior tests and verify RED**

Run: `node --test tests/app-behavior.test.mjs tests/i18n.test.mjs`

Expected: FAIL because zoom state/actions do not exist.

Run: `npm run mobile:sync && android/gradlew -p android connectedDebugAndroidTest`

Expected: FAIL because the 16x16 zoom toolbar and actions do not exist; the 10x10 fit
assertions remain green.

- [ ] **Step 3: Add state and action handlers**

Add `extendedBoardCellSize: 32` to state. Handle:

```text
board-zoom-out
board-zoom-reset
board-zoom-in
```

Each handler clamps, renders, and returns focus to its action button. Reset the value
in new-game and menu-to-new-game state initialization, not when merely switching
battle tabs.

- [ ] **Step 4: Render an extended-only toolbar**

For `board.size > 10`, render three icon buttons with translated accessible labels and
a visible percentage calculated as `cellSize / 32 * 100`. Set
`--extended-board-cell-size: ${state.extendedBoardCellSize}px` on the coordinate board.

- [ ] **Step 5: Add translation parity**

Add EN/RU/ZH labels for zoom out, reset, zoom in, and board scale. Keep all locales at
identical key sets.

- [ ] **Step 6: Run behavior, i18n, and WebView tests**

Run: `node --test tests/app-behavior.test.mjs tests/i18n.test.mjs tests/ux-redesign.test.mjs`

Run: `npm run mobile:sync && android/gradlew -p android connectedDebugAndroidTest`

Expected: PASS.

- [ ] **Step 7: Commit zoom behavior**

```bash
git add src/app.js src/i18n.js tests/app-behavior-harness.mjs tests/app-behavior.test.mjs tests/i18n.test.mjs android/app/src/androidTest/java/io/github/agentaxiom/salvo/BoardViewportSmokeTest.java
git commit -m "feat: add extended board zoom controls"
```

### Task 3: Style The Extended Board Viewport

**Files:**
- Modify: `src/styles.css`
- Modify: `tests/mobile-board-layout.test.mjs`
- Modify: `tests/ux-redesign.test.mjs`

- [ ] **Step 1: Write failing extended-layout tests**

Require the extended wrapper to use `overflow-x: auto`, native momentum scrolling,
and the grid/header tracks below:

```css
.is-extended-board .column-headers,
.is-extended-board .board-grid {
  grid-template-columns: repeat(var(--board-size), var(--extended-board-cell-size));
}
```

Require 44px icon-button hit targets even though grid cells remain 24-48px.

- [ ] **Step 2: Run layout tests and verify RED**

Run: `node --test tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs`

Expected: FAIL because extended-specific styles are absent.

- [ ] **Step 3: Implement extended viewport and toolbar CSS**

Use `width: max-content` only under `.is-extended-board`. Give the toolbar stable
height, compact icon buttons, visible focus rings, and no overlap with board labels.
Use `overscroll-behavior-inline: contain` and `-webkit-overflow-scrolling: touch`.

- [ ] **Step 4: Verify both themes and visual styles in CSS tests**

Assert toolbar colors use existing semantic variables rather than hard-coded light
colors. Confirm render and simplified selectors do not reintroduce fixed normal-cell
minimums.

- [ ] **Step 5: Run all board/UI tests**

Run: `node --test tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs tests/app-behavior.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit extended board styles**

```bash
git add src/styles.css tests/mobile-board-layout.test.mjs tests/ux-redesign.test.mjs
git commit -m "feat: style extended board viewport"
```

### Task 4: Verify Real Mobile Viewports

**Files:**
- None: this task performs fresh verification and captures review evidence.

- [ ] **Step 1: Run full Node and Android verification**

Run: `npm test && npm run coverage && npm run build && npm run mobile:sync && android/gradlew -p android test lint connectedDebugAndroidTest`

Expected: all commands exit `0`.

- [ ] **Step 2: Capture review screenshots**

Capture setup and battle in light/dark at emulator sizes equivalent to 360x800 and
412x915. Capture 16x16 at minimum/default/maximum zoom. Inspect every image for
clipped coordinates, page overflow, and incoherent overlap.

- [ ] **Step 3: Record screenshot paths in the RuStore asset task**

Keep screenshots outside Git until they pass the dimensions and visual checks in the
RuStore plan. Do not create an empty verification commit.
