# Battle Moments Design

## Goal

Make the battle result feel like an after-action report by showing the most important moments of the match, not only aggregate stats.

## Scope

`buildBattleReport()` adds a `moments` block with player-focused events:

- First contact: the player's first hit or sinking shot.
- First sinking: the player's first sunk ship.
- Longest miss streak: the player's longest consecutive run of miss-like shots.
- Final shot: the last shot of the battle, regardless of player.

Each moment stores the turn number and coordinate when the log entry includes one. The UI formats coordinates locally, so the stats layer stays independent of language and board alphabet.

## UX

The result modal renders a compact "Key moments" section after the debrief. It uses a light timeline style with short labels and details, avoiding large cards so the modal remains scrollable on mobile.

## Testing

Unit tests cover moment extraction from a battle log. UX and i18n tests ensure the result modal renders the section and all three localizations have the required labels.
