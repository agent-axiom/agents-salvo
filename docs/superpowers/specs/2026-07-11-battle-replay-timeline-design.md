# Battle Replay Timeline Design

**Date:** 2026-07-11

## Goal

Make long battle replays easy to inspect without repeatedly pressing Previous or Next. A player must be able to scrub directly to any move and jump to the battle's most important moments.

## Interaction

- A native range input spans moves `1..N` and shows the currently selected move.
- Seeking stops autoplay and displays the selected replay frame.
- The range input updates on `change`, so replacing the replay subtree cannot interrupt an active pointer drag.
- Four compact moment buttons appear when data exists: first contact, first sunk ship, longest miss streak, and final shot.
- A regular moment jumps to `moment.turn`; a miss streak jumps to `moment.endTurn`, where the streak becomes complete.
- The active moment receives `aria-current="step"` and a visible selected state.
- Previous, Next, Play/Pause, speed selection, and the existing live announcement continue to work unchanged.

## Accessibility

- The range input has a localized label and `aria-valuetext` in the form `Move 12 of 47`.
- Moment buttons expose localized moment names and move numbers as visible text.
- Seeking and jumping preserve focus inside the rebuilt replay controls and announce the selected move through the existing `aria-live` region.
- Touch targets remain at least 44 CSS pixels high on mobile.

## Architecture

- `src/core/replay.js` owns pure normalization of moment turns, including range clamping and miss-streak semantics.
- `src/app.js` renders the timeline, derives moments from the existing battle report, and routes range, moment, Previous, and Next actions through one replay-turn setter.
- `src/styles.css` supplies a compact timeline and horizontally wrapping moment controls.
- `src/i18n.js` adds timeline and seek labels for English, Russian, and Simplified Chinese.

No persistence or backend schema changes are required. The replay continues to derive entirely from the final battle log.

## Verification

- Pure unit tests cover regular moments, streak moments, invalid values, and bounds.
- UX contract tests cover range semantics, moment controls, focus preservation, styles, and all locale keys.
- Browser verification covers mouse/keyboard seeking, moment jumps, autoplay cancellation, scroll preservation, and mobile layout.

