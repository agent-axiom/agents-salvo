# Battle Replay Controls Design

## Goal

Add a compact battle replay block to the result modal so players can inspect or automatically play through the finished match without leaving the result screen.

## Scope

- Show one replay frame at a time: move number, acting player, result, and coordinate.
- Show a compact replay map for the acting player with shots accumulated up to the selected move.
- Highlight the selected move on that replay map.
- Default to the final move because it explains the win immediately.
- Provide Previous and Next controls with disabled edge states.
- Provide a Play/Pause control and a compact speed control cycling through 1x, 1.5x, and 2x.
- Start playback from move one when Play is pressed at the final move; otherwise continue from the selected move.
- Stop playback when it reaches the final move or when the player navigates manually.
- Animate a short pulse on the selected shot while respecting `prefers-reduced-motion`.
- Keep the block small enough for the existing scrollable result modal.
- Reset replay state and clear its timer when starting another flow, closing the result, returning to the menu, or requesting an online rematch.

## Data Flow

The result modal already receives the full battle `log`. The replay reads that log directly, normalizes `state.resultReplayTurn` into a safe one-based turn index, and renders the selected entry. The map is reconstructed only from public log entries made by the acting player up to that move, so it never reveals hidden ships or guesses missing board state.

Playback uses one module-level interval handle and state fields for playing status and speed index. Starting playback clears any stale interval before creating a new one. Each tick advances one move and re-renders. Manual Previous/Next navigation stops playback first. Reaching the final move stops the interval and updates the Play/Pause label. Changing speed while playing restarts the single interval at the selected delay without changing the current move.

## Testing

Add structural UX tests for replay playback state, the single timer lifecycle, renderer, map builder, active-cell pulse, controls, action handlers, CSS hooks, and i18n keys. Extend the i18n coverage test to require playback labels in English, Russian, and Chinese. Run the full test, 98% coverage, build, and GitHub Pages deployment checks.
