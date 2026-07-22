# Unified Battle Command Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the opponent board before all battle intelligence and replace the separate shot summary and tactical advisor with one collapsed-by-default command panel below the board.

**Architecture:** Keep all calculations in the existing frontend and compose them through one `renderBattleCommandPanel` boundary. One ephemeral state flag controls only manual disclosure; local shots, online snapshots, and rerenders preserve it, while new battles and rematches reset it. The same DOM order and component serve web, native shells, Telegram, and MAX.

**Tech Stack:** Vanilla JavaScript, CSS media queries, existing i18n dictionary, Node test runner, actual-app behavior harness.

---

## File Structure

- Modify `src/app.js`: command-panel state, rendering order, disclosure interaction, platform-back behavior, and reset lifecycle.
- Modify `src/styles.css`: unified surface, responsive compact summary, expanded details, and 44px mobile controls.
- Modify `src/i18n.js`: localized details and hide-details actions.
- Modify `tests/app-behavior-harness.mjs`: real-render scenario covering order, collapse, toggle, and rerender persistence.
- Modify `tests/app-behavior.test.mjs`: register the real-app scenario as a test.
- Modify `tests/ux-redesign.test.mjs`: replace obsolete pulse/advisor structure assertions with unified-panel and responsive-style assertions.

### Task 1: Add A Failing Real-App Behavior Test

**Files:**
- Modify: `tests/app-behavior-harness.mjs:19-45`
- Modify: `tests/app-behavior-harness.mjs` after `runOnlinePlayerNamesScenario`
- Modify: `tests/app-behavior.test.mjs:55-58`

- [ ] **Step 1: Register the new harness scenario**

Add the map entry:

```js
"battle-command-panel": runBattleCommandPanelScenario,
```

- [ ] **Step 2: Add the scenario implementation**

```js
async function runBattleCommandPanelScenario() {
  const { bootSalvoApp } = await import("../src/app.js");
  const harness = createAppHarness();
  const app = bootSalvoApp(harness.dependencies);
  await app.startup.done;

  await harness.root.click("start-agent");
  await harness.root.click("ready");

  let targetPanel = targetPanelHtml(harness.root.innerHTML);
  assert.ok(targetPanel.indexOf("board-panel") < targetPanel.indexOf("battle-command-panel"));
  assert.equal(app.getState().battleCommandPanelOpen, false);
  assert.match(targetPanel, /class="battle-command-summary"/);
  assert.match(targetPanel, /data-action="toggle-battle-command-panel"/);
  assert.match(targetPanel, /aria-expanded="false"/);
  assert.doesNotMatch(targetPanel, /class="battle-command-details"/);

  const targetShip = app.getState().game.players.p2.board.ships[0];
  await harness.root.click("shot", {
    row: String(targetShip.cells[0].row),
    col: String(targetShip.cells[0].col),
  });
  assert.equal(app.getState().battleCommandPanelOpen, false);

  await harness.root.click("toggle-battle-command-panel");
  targetPanel = targetPanelHtml(harness.root.innerHTML);
  assert.equal(app.getState().battleCommandPanelOpen, true);
  assert.match(targetPanel, /aria-expanded="true"/);
  assert.match(targetPanel, /class="battle-command-details"/);
  assert.match(targetPanel, /class="battle-command-tactics/);
  assert.doesNotMatch(targetPanel, /class="tactical-advisor/);

  await harness.root.click("shot", {
    row: String(targetShip.cells[1].row),
    col: String(targetShip.cells[1].col),
  });
  assert.equal(app.getState().battleCommandPanelOpen, true);
  assert.match(targetPanelHtml(harness.root.innerHTML), /aria-expanded="true"/);
  await app.stop();
}

function targetPanelHtml(html) {
  const start = html.indexOf('class="target-primary');
  const end = html.indexOf('<aside class="battle-side"', start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}
```

- [ ] **Step 3: Expose the scenario through the Node test file**

```js
test("actual battle UI keeps one command panel below the opponent board", async () => {
  await runScenarioInChild("battle-command-panel");
});
```

- [ ] **Step 4: Cover the online initial state in the existing online-name scenario**

After the snapshot assertions in `runOnlinePlayerNamesScenario()`, add:

```js
assert.equal(app.getState().battleCommandPanelOpen, false);
assert.match(targetPanelHtml(harness.root.innerHTML), /class="battle-command-panel is-collapsed"/);
assert.match(targetPanelHtml(harness.root.innerHTML), /aria-expanded="false"/);
```

- [ ] **Step 5: Run the scenario and verify RED**

Run:

```bash
SALVO_APP_CHILD_COVERAGE=isolated SALVO_APP_BEHAVIOR_SCENARIO=battle-command-panel node tests/app-behavior-harness.mjs
```

Expected: FAIL because `battleCommandPanelOpen` and `.battle-command-panel` do not exist and the current pulse/advisor render before the board.

- [ ] **Step 6: Commit the failing regression test**

```bash
git add tests/app-behavior-harness.mjs tests/app-behavior.test.mjs
git commit -m "test: define unified battle command panel behavior"
```

### Task 2: Implement Unified Rendering And Disclosure State

**Files:**
- Modify: `src/app.js:180-190`
- Modify: `src/app.js:2515-2766`
- Modify: `src/app.js:3393-3442`
- Modify: `src/app.js:3530-3574`
- Modify: `src/app.js:3592-3653`
- Modify: `src/app.js:4331-4334`
- Modify: `src/app.js:5063-5070`
- Modify: `src/i18n.js` in all three locale dictionaries

- [ ] **Step 1: Replace the advisor-only state with collapsed command-panel state**

Use this state property:

```js
battleCommandPanelOpen: false,
```

In `startSetup()` and `showOnline()`, reset it with:

```js
state.battleCommandPanelOpen = false;
```

- [ ] **Step 2: Render the board before the command panel**

Change the target panel to this order:

```js
<div class="target-primary battle-tab-panel" data-panel="target">
  ${renderBoard(targetBoard, {
    kind: targetKind,
    title: translate("game.target"),
    disabled: targetDisabled,
    priorityTargets: tacticalAnalysis.priorityTargets,
  })}
  ${renderBattleCommandPanel(log, {
    targetDisabled,
    salvoRemaining,
    tacticalAnalysis,
    playerId,
    ownBoard,
    targetBoard,
    targetAction,
  })}
</div>
```

- [ ] **Step 3: Add the unified renderer**

Implement one section with a persistent compact summary and conditional details:

```js
function renderBattleCommandPanel(
  log,
  {
    targetDisabled = false,
    salvoRemaining = 1,
    tacticalAnalysis,
    playerId = "p1",
    ownBoard,
    targetBoard,
    targetAction = "shot",
  } = {},
) {
  const expanded = state.battleCommandPanelOpen;
  const detailsId = "battle-command-details";
  return `
    <section class="battle-command-panel ${expanded ? "is-expanded" : "is-collapsed"}">
      ${renderBattleCommandSummary(log, playerId)}
      <button
        class="battle-command-toggle"
        data-action="toggle-battle-command-panel"
        aria-expanded="${expanded}"
        aria-controls="${detailsId}"
      >
        ${translate(expanded ? "battle.hideDetails" : "battle.details")}
      </button>
      ${expanded ? `
        <div id="${detailsId}" class="battle-command-details">
          <div class="battle-command-intel">
            ${renderBattlePulseMetrics({ targetDisabled, salvoRemaining, tacticalAnalysis })}
            ${renderBattleMomentum(log, playerId)}
            ${renderFleetIntel(log, playerId, ownBoard)}
            ${renderTargetIntel(targetBoard)}
          </div>
          ${renderTacticalAdvisor(tacticalAnalysis, { disabled: targetDisabled, targetAction })}
        </div>
      ` : ""}
    </section>
  `;
}
```

`renderBattleCommandSummary()` must contain the current last-shot/awaiting-shot copy, result marker, and `renderBattleLiveStats(log, playerId)`. Remove metrics, momentum, fleet, and target intelligence from the summary so they appear only once in expanded details.

- [ ] **Step 4: Turn the advisor into unframed panel content**

Render only the recommendation and action body:

```js
function renderTacticalAdvisor(analysis, { disabled = false, targetAction = "shot" } = {}) {
  const priority = analysis.priorityTargets.length
    ? analysis.priorityTargets.slice(0, 3).map(formatCoordinate).join(" · ")
    : translate("tactics.noPriority");
  return `
    <div class="battle-command-tactics ${disabled ? "is-paused" : ""}">
      <div class="battle-command-tactics-title">
        <span>${translate("tactics.title")}</span>
        <strong>${translate(`tactics.recommendation.${analysis.recommendationId}`)}</strong>
      </div>
      <div class="battle-command-tactics-body">
        ${renderQuickFireButton(analysis.priorityTargets[0], { disabled, targetAction })}
        <div class="tactical-stats">
          ${renderTacticalStat("tactics.targets", analysis.availableTargets)}
          ${renderTacticalStat("tactics.unresolved", analysis.unresolvedHits)}
          ${renderTacticalStat("tactics.priority", priority)}
          ${analysis.salvoRemaining > 1 ? renderTacticalStat("tactics.salvo", analysis.salvoRemaining) : ""}
        </div>
        ${renderPriorityTargetChips(analysis.priorityTargets, { disabled, targetAction })}
      </div>
    </div>
  `;
}
```

- [ ] **Step 5: Rename the toggle action and platform-back behavior**

Use:

```js
if (action === "toggle-battle-command-panel") toggleBattleCommandPanel();

function toggleBattleCommandPanel() {
  state.battleCommandPanelOpen = !state.battleCommandPanelOpen;
  render();
}

function isBattleCommandPanelVisible() {
  return Boolean(
    state.battleCommandPanelOpen
    && (state.screen === "playing" || (state.screen === "online" && state.online.snapshot)),
  );
}
```

The platform back handler collapses this panel before leaving the battle.

Update `runTelegramRuntimeScenario()` so it opens the collapsed-by-default panel before testing platform back:

```js
assert.equal(app.getState().battleCommandPanelOpen, false);
await harness.root.click("toggle-battle-command-panel");
assert.equal(app.getState().battleCommandPanelOpen, true);
await harness.emitBack();
assert.equal(app.getState().battleCommandPanelOpen, false, "visible battle details collapse");
```

- [ ] **Step 6: Reset the panel when a remote rematch begins**

Before assigning a new online snapshot, detect a transition away from a finished match:

```js
const rematchStarted = state.online.snapshot?.phase === "finished"
  && message.snapshot.phase !== "finished";
if (rematchStarted) state.battleCommandPanelOpen = false;
state.online.snapshot = message.snapshot;
```

- [ ] **Step 7: Add localized disclosure labels**

Add these keys to every locale:

```js
// English
"battle.details": "Details",
"battle.hideDetails": "Hide details",

// Russian
"battle.details": "Подробнее",
"battle.hideDetails": "Скрыть подробности",

// Chinese
"battle.details": "详情",
"battle.hideDetails": "隐藏详情",
```

- [ ] **Step 8: Run the real-app scenario and verify GREEN**

Run:

```bash
SALVO_APP_CHILD_COVERAGE=isolated SALVO_APP_BEHAVIOR_SCENARIO=battle-command-panel node tests/app-behavior-harness.mjs
```

Expected: `scenario:battle-command-panel:ok`.

- [ ] **Step 9: Commit rendering and interaction behavior**

```bash
git add src/app.js src/i18n.js tests/app-behavior-harness.mjs tests/app-behavior.test.mjs
git commit -m "feat: unify battle intelligence below target board"
```

### Task 3: Style The Unified Panel And Replace Structural Tests

**Files:**
- Modify: `src/styles.css:2051-2373`
- Modify: `src/styles.css:4705-4707`
- Modify: `src/styles.css:4755-4768`
- Modify: `src/styles.css:4928-4930`
- Modify: `tests/ux-redesign.test.mjs:88-105`
- Modify: `tests/ux-redesign.test.mjs:468-535`
- Modify: `tests/ux-redesign.test.mjs:580-590`

- [ ] **Step 1: Replace obsolete structural assertions with unified-panel assertions**

Assert the new renderer, state, action, accessibility, and removal of the standalone advisor:

```js
test("battlefield puts one collapsed command panel below the opponent board", () => {
  const boardCall = app.indexOf("${renderBoard(targetBoard");
  const panelCall = app.indexOf("${renderBattleCommandPanel(log");
  assert.ok(boardCall >= 0 && panelCall > boardCall);
  assert.match(app, /battleCommandPanelOpen:\s*false/);
  assert.match(app, /class="battle-command-panel/);
  assert.match(app, /class="battle-command-summary"/);
  assert.match(app, /data-action="toggle-battle-command-panel"/);
  assert.match(app, /aria-controls="\$\{detailsId\}"/);
  assert.match(app, /aria-expanded="\$\{expanded\}"/);
  assert.doesNotMatch(app, /class="tactical-advisor/);
});
```

Add i18n assertions for `battle.details` and `battle.hideDetails`, and retain assertions for tactical quick-fire actions and priority highlighting.

- [ ] **Step 2: Run the static UX tests and verify RED**

Run:

```bash
node --test tests/ux-redesign.test.mjs
```

Expected: FAIL because the new `.battle-command-*` CSS does not exist yet.

- [ ] **Step 3: Add the unified panel CSS surface**

Implement these layout primitives and migrate the existing result-marker, metrics, momentum, fleet, target, tactical-stats, quick-fire, and priority-chip rules under the new panel:

```css
.battle-command-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 12px;
  align-items: center;
  margin-top: 12px;
  padding: 12px;
  color: var(--ink);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  border-radius: 8px;
}

.battle-command-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 10px;
  align-items: center;
  min-width: 0;
}

.battle-command-toggle {
  min-height: 38px;
  padding: 0 14px;
  color: var(--accent-strong);
  font: inherit;
  font-size: 12px;
  font-weight: 850;
  background: color-mix(in srgb, var(--surface-strong) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line));
  border-radius: 999px;
  cursor: pointer;
}

.battle-command-details {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
}

.battle-command-intel,
.battle-command-tactics,
.battle-command-tactics-body {
  display: grid;
  gap: 8px;
}
```

Remove the old `.battle-pulse` surface and `.tactical-advisor` surface/toggle/collapsed rules so no nested or duplicate panels remain.

- [ ] **Step 4: Add responsive behavior**

At `max-width: 720px`, use:

```css
.battle-command-panel,
.battle-command-summary {
  grid-template-columns: 1fr;
}

.battle-command-toggle {
  width: 100%;
  min-height: 44px;
}

.battle-command-summary .battle-live-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.battle-command-summary .battle-live-stats span {
  min-width: 0;
  justify-content: center;
  white-space: normal;
}
```

- [ ] **Step 5: Run focused UX and behavior tests**

Run:

```bash
node --test tests/ux-redesign.test.mjs tests/app-behavior.test.mjs
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 6: Commit visual integration**

```bash
git add src/styles.css tests/ux-redesign.test.mjs
git commit -m "style: optimize battle command panel for mobile"
```

### Task 4: Verify, Publish, And Confirm Shared Shells

**Files:**
- Verify only; no production edits expected.

- [ ] **Step 1: Run the full project tests**

```bash
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run all coverage gates**

```bash
npm run coverage
```

Expected: exit code 0 and every configured line-coverage threshold remains at or above 98%.

- [ ] **Step 3: Build production shells**

```bash
npm run build
```

Expected: `Built .../agents-salvo/dist`.

- [ ] **Step 4: Inspect the final diff and worktree**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intended implementation files or no uncommitted files after commits.

- [ ] **Step 5: Push `main` and monitor both workflows**

```bash
git push origin main
gh run list --branch main --limit 10 --json databaseId,name,status,conclusion,headSha,url
gh run watch "$(gh run list --branch main --workflow 'Deploy GitHub Pages' --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh run watch "$(gh run list --branch main --workflow 'Validate Mobile Builds' --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: `Deploy GitHub Pages` and `Validate Mobile Builds` both complete successfully.

- [ ] **Step 6: Verify Telegram and MAX production build IDs**

```bash
curl -fsSL https://agent-axiom.github.io/agents-salvo/telegram/
curl -fsSL https://agent-axiom.github.io/agents-salvo/max/
```

Expected: both shells expose the pushed commit SHA as `buildId` and reference the same hashed app bundle.
