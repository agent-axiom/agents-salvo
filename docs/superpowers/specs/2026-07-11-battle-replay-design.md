# Battle Replay Controls Design

## Goal

Add a compact battle replay block to the result modal so players can step through the finished match without leaving the result screen.

## Scope

- Show one replay frame at a time: move number, acting player, result, and coordinate.
- Show a compact replay map for the acting player with shots accumulated up to the selected move.
- Highlight the selected move on that replay map.
- Default to the final move because it explains the win immediately.
- Provide Previous and Next controls with disabled edge states.
- Keep the block small enough for the existing scrollable result modal.
- Reset replay state when starting another flow, closing the result, returning to the menu, or requesting an online rematch.

## Data Flow

The result modal already receives the full battle `log`. The replay reads that log directly, normalizes `state.resultReplayTurn` into a safe one-based turn index, and renders the selected entry. The map is reconstructed only from public log entries made by the acting player up to that move, so it never reveals hidden ships or guesses missing board state. Button actions update only `state.resultReplayTurn` and re-render.

## Testing

Add structural UX tests for the replay state, renderer, map builder, active-cell highlight, controls, action handler, CSS hooks, and i18n keys. Extend the i18n coverage test to require replay labels in English, Russian, and Chinese.
