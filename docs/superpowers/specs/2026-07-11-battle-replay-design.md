# Battle Replay Controls Design

## Goal

Add a compact battle replay block to the result modal so players can step through the finished match without leaving the result screen.

## Scope

- Show one replay frame at a time: move number, acting player, result, and coordinate.
- Default to the final move because it explains the win immediately.
- Provide Previous and Next controls with disabled edge states.
- Keep the block small enough for the existing scrollable result modal.
- Reset replay state when starting another flow, closing the result, returning to the menu, or requesting an online rematch.

## Data Flow

The result modal already receives the full battle `log`. The replay reads that log directly, normalizes `state.resultReplayTurn` into a safe one-based turn index, and renders the selected entry. Button actions update only `state.resultReplayTurn` and re-render.

## Testing

Add structural UX tests for the replay state, renderer, controls, action handler, CSS hooks, and i18n keys. Extend the i18n coverage test to require replay labels in English, Russian, and Chinese.
