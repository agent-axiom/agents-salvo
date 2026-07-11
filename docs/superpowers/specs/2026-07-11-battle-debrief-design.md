# Battle Debrief Design

## Goal

Make the result modal teach the player what happened in the match, not only who won. After every finished local, agent, or online battle, the player should see a compact debrief with concrete tactical takeaways derived from the battle log.

## Scope

Add a `debrief` block to `buildBattleReport()`. It should include four deterministic insights:

- Search efficiency: whether misses dominated the player's shots.
- Finish discipline: whether the player has a confirmed hit after their last sinking shot, meaning a damaged ship stayed unresolved.
- Pressure: whether the player sank enough ships to control the match.
- Focus: the same training focus that powers the existing coaching plan.

The modal should render those insights above the collapsible tactical training plan. The training plan remains collapsible so the modal stays scrollable on mobile.

## UX

The block title is "Battle debrief" and each insight is a short row with a label and a sentence. Positive insights use the existing accent color; warnings use the existing hit color. Text is localized in English, Russian, and Chinese.

## Data Flow

`buildBattleReport(log, winnerId, playerId)` computes the debrief from already available player stats and coaching output. `renderResultModal()` passes `report.debrief` into a new renderer. No backend schema changes are needed.

## Testing

Unit tests verify the debrief classification for low-accuracy losses and strong wins. UX tests verify that the modal renders the debrief, has localized copy keys, and styles warning/positive rows distinctly.
