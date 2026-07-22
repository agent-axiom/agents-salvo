# Unified Battle Command Panel Design

## Goal

Make the opponent board the first and dominant object in battle, especially on phones. Move the current shot summary and tactical advisor below that board and combine them into one compact, manually expandable command panel.

## Scope

The layout applies to local play against the agent, same-device battles, and authenticated online battles across web, Android, iOS, Telegram Mini App, and MAX Mini App. The change affects the active opponent-board tab only. The own-fleet and journal tabs keep their existing content and behavior.

## Information Architecture

The target view uses this semantic and visual order:

1. Battle tabs.
2. Opponent board.
3. Unified battle command panel.

On desktop, the own fleet and journal remain in the existing side column. The command panel spans the width of the opponent-board column directly beneath the board.

## Collapsed State

The panel starts collapsed for every new battle. Its persistent compact header shows:

- the latest shot coordinate and result, or the awaiting-shot state;
- player accuracy;
- player hits and shots;
- enemy ships sunk;
- a single `Details` toggle.

Compact values may wrap on narrow screens but must not introduce horizontal scrolling. The header remains visible after every shot and is the only live announcement region for shot updates.

## Expanded State

Manual expansion reveals the existing battle intelligence without duplicating the compact header:

- fire readiness, salvo shots, and priority-target count;
- battle momentum;
- own fleet afloat;
- scouted and remaining target cells;
- tactical recommendation;
- quick-fire action and priority target buttons when available.

The expanded content uses one visual surface. The tactical advisor is no longer rendered as a separate card inside the command panel.

## Interaction And State

Replace the advisor-only open state with a command-panel open state. It defaults to `false`, changes only through the panel toggle, and resets to `false` when a new battle or rematch starts. Shot updates and remote snapshots must preserve the current state and must never expand, collapse, focus, or scroll the panel automatically.

The toggle is a real button with `aria-expanded` and `aria-controls`. Its label changes between the localized `Details` and `Hide details` actions. Keyboard activation follows native button behavior. Quick-fire and priority-target controls retain their current actions and disabled rules.

## Responsive Behavior

All breakpoints use the same DOM order to avoid platform-specific duplication. At phone widths:

- the opponent board remains fluid and fits the available width;
- the panel follows the board with a small vertical gap;
- the collapsed metrics wrap into a compact grid or row;
- expanded content uses one column and touch targets remain at least 44 CSS pixels high.

Desktop keeps the current two-column battlefield layout, with the reordered target column on the left and battle side content on the right.

## Data And Error Handling

No game-domain or backend changes are required. The panel derives all values from the existing battle log, target analysis, own board, target board, turn state, and salvo state. Missing log entries render the existing awaiting-shot copy. Missing optional tactical targets omit quick-fire controls rather than showing disabled placeholders.

## Testing

Add behavior tests against the real app renderer that verify:

- the opponent board appears before the command panel in target-view DOM order;
- the panel starts collapsed in a new local and online battle;
- the compact header remains visible while expanded-only content is absent;
- activating the toggle reveals the tactical recommendation and changes `aria-expanded`;
- a shot re-render preserves the selected collapsed or expanded state;
- the old standalone tactical-advisor panel is not duplicated;
- existing target actions still dispatch the correct local or online shot action.

Keep the full test suite, 98% coverage gates, production build, and mobile validation workflows green.

## Non-Goals

- No changes to targeting logic or tactical recommendations.
- No changes to battle statistics calculations.
- No redesign of own-fleet or journal tabs.
- No automatic panel expansion based on hit, sunk, turn, or match result.
- No new persistence across separate battles or app restarts.
