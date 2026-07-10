import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");
const css = readFileSync("src/styles.css", "utf8");
const i18n = readFileSync("src/i18n.js", "utf8");

test("main menu is a focused game hub with agent play as the primary action", () => {
  assert.match(app, /class="game-hub"/);
  assert.match(app, /class="hub-primary"/);
  assert.match(app, /class="hub-cta primary-button"[^>]+data-action="start-agent"/);
  assert.match(app, /class="hub-rule-summary"/);
  assert.match(app, /renderCompactProfile/);
  assert.match(app, /class="rules-panel"/);
});

test("topbar delegates secondary controls to a settings panel", () => {
  assert.match(app, /data-action="toggle-settings"/);
  assert.match(app, /function renderSettingsPanel/);
  assert.match(app, /class="settings-panel/);
  assert.match(app, /settings-row/);
  assert.match(app, /data-action="theme-toggle"/);
  assert.match(app, /data-action="visual-style-toggle"/);
  assert.match(app, /data-action="audio-toggle"/);
  assert.match(app, /data-action="language"/);
});

test("battlefield prioritizes the opponent board and keeps own fleet/log secondary", () => {
  assert.match(app, /class="battlefield target-first"/);
  assert.match(app, /class="[^"]*target-primary/);
  assert.match(app, /class="[^"]*own-minimap/);
  assert.match(app, /class="[^"]*battle-log-aside/);
  assert.match(app, /class="battle-tabs"/);
  assert.match(app, /data-action="battle-tab"/);
  assert.match(css, /\.target-primary/);
  assert.match(css, /\.own-minimap/);
});

test("agent battles keep the human fleet as own board after the agent wins", () => {
  assert.match(app, /function localPerspectivePlayerId/);
  assert.match(app, /state\.mode === "agent" \? "p1" : state\.game\.currentPlayerId/);
  assert.match(app, /const perspectivePlayerId = localPerspectivePlayerId\(\)/);
  assert.match(app, /const ownBoard = state\.game\.players\[perspectivePlayerId\]\.board/);
});

test("main menu exposes a public leaderboard", () => {
  assert.match(app, /leaderboard:\s*\{/);
  assert.match(app, /renderPublicLeaderboard/);
  assert.match(app, /refreshLeaderboard/);
  assert.match(app, /\/leaderboard/);
  assert.match(app, /class="public-leaderboard"/);
  assert.match(css, /\.public-leaderboard/);
  assert.match(i18n, /"leaderboard\.title"/);
});

test("manual setup has random-first actions, progress, and placement preview states", () => {
  assert.match(app, /class="setup-primary-actions"/);
  assert.match(app, /class="setup-progress"/);
  assert.match(app, /function setupPreview/);
  assert.match(app, /placement-ok/);
  assert.match(app, /placement-bad/);
  assert.match(css, /\.cell\.placement-ok/);
  assert.match(css, /\.cell\.placement-bad/);
});

test("online mode separates lobby controls from the active room state", () => {
  assert.match(app, /function renderOnlineLobby/);
  assert.match(app, /function renderOnlineRoom/);
  assert.match(app, /class="[^"]*online-lobby/);
  assert.match(app, /class="[^"]*online-room/);
  assert.match(app, /data-action="copy-room-code"/);
  assert.match(app, /data-action="share-telegram"/);
});

test("online result modal highlights rating movement and next match actions", () => {
  assert.match(app, /function renderOnlineRatingChange/);
  assert.match(app, /function onlineRematch/);
  assert.match(app, /snapshot\.ratingChange/);
  assert.match(app, /requestRematch/);
  assert.match(app, /result\.ratingChange/);
  assert.match(app, /data-action="online-rematch"/);
  assert.match(app, /online\.rematch/);
  assert.match(app, /online\.rematchWaiting/);
  assert.match(app, /online\.rematchOffered/);
  assert.match(app, /data-action="share-telegram"/);
});

test("result modal includes a player battle report with achievements", () => {
  assert.match(app, /function renderBattleReport/);
  assert.match(app, /buildBattleReport/);
  assert.match(app, /class="battle-report"/);
  assert.match(app, /class="achievement-list"/);
  assert.match(app, /achievement\./);
  assert.match(css, /\.battle-report/);
  assert.match(css, /\.achievement-list/);
  assert.match(i18n, /"result\.report"/);
  assert.match(i18n, /"achievement\.sharpshooter\.title"/);
});

test("profile exposes online competition rank, best-of-three, and rating history", () => {
  assert.match(app, /function renderCompetitionProfile/);
  assert.match(app, /profile\.competition/);
  assert.match(app, /class="competition-card"/);
  assert.match(app, /class="rating-history"/);
  assert.match(app, /competition\.bestOfThree/);
  assert.match(css, /\.competition-card/);
  assert.match(css, /\.rating-history/);
  assert.match(i18n, /"competition\.title"/);
  assert.match(i18n, /"competition\.ratingHistory"/);
});

test("topbar profile opens a stats popover for authenticated players", () => {
  assert.match(app, /profileOpen:\s*false/);
  assert.match(app, /data-action="toggle-profile"/);
  assert.match(app, /function renderProfilePopover/);
  assert.match(app, /state\.profileOpen \? renderProfilePopover\(\) : ""/);
  assert.match(app, /function toggleProfilePopover/);
  assert.match(app, /await refreshProfile\(\{ renderWhenDone: false \}\)/);
  assert.match(app, /data-action="close-profile"/);
  assert.match(app, /renderProfilePanel\(\)/);
  assert.match(css, /\.profile-popover/);
  assert.match(css, /\.profile-popover \.profile-panel/);
});

test("smart battle adds hard agent difficulty and post-battle coaching", () => {
  assert.match(app, /value="hard"/);
  assert.match(app, /function renderBattleCoaching/);
  assert.match(app, /class="battle-coaching"/);
  assert.match(app, /class="training-plan"/);
  assert.match(app, /trainingPlan\.steps/);
  assert.match(app, /data-action="start-coaching-training"/);
  assert.match(app, /data-drill-id/);
  assert.match(app, /trainingScenarioForDrill/);
  assert.match(app, /coaching\.diagnosis/);
  assert.match(app, /coaching\.drill/);
  assert.match(app, /report\.trainingPlan/);
  assert.match(css, /\.battle-coaching/);
  assert.match(css, /\.training-plan/);
  assert.match(i18n, /"agent\.hard"/);
  assert.match(i18n, /"coaching\.title"/);
  assert.match(i18n, /"coaching\.plan"/);
  assert.match(i18n, /"coaching\.startTraining"/);
});

test("training mode exposes focused drills from the main game hub", () => {
  assert.match(app, /trainingScenarios/);
  assert.match(app, /data-action="start-training"/);
  assert.match(app, /function renderTraining/);
  assert.match(app, /data-action="select-training-scenario"/);
  assert.match(app, /training-shot/);
  assert.match(app, /applyTrainingShot/);
  assert.match(app, /training-screen/);
  assert.match(css, /\.training-screen/);
  assert.match(css, /\.training-card/);
  assert.match(i18n, /"mode\.training"/);
  assert.match(i18n, /"training\.scenario\.checkerboard\.name"/);
});

test("training mode saves and displays local drill progress", () => {
  assert.match(app, /trainingProgressStorageKey/);
  assert.match(app, /updateTrainingProgress/);
  assert.match(app, /function renderTrainingProgress/);
  assert.match(app, /localStorage\.setItem\(trainingProgressStorageKey/);
  assert.match(css, /\.training-progress/);
  assert.match(i18n, /"training\.bestScore"/);
});

test("training mode exposes a daily chain, streak, and award shelf", () => {
  assert.match(app, /trainingProgramSummary/);
  assert.match(app, /function renderTrainingProgram/);
  assert.match(app, /class="training-program"/);
  assert.match(app, /class="training-awards"/);
  assert.match(css, /\.training-program/);
  assert.match(css, /\.training-awards/);
  assert.match(i18n, /"training\.dailyGoal"/);
  assert.match(i18n, /"training\.award\.threeDayStreak"/);
});

test("battlefield exposes a live tactical advisor during battle", () => {
  assert.match(app, /analyzeTargetBoard/);
  assert.match(app, /function renderTacticalAdvisor/);
  assert.match(app, /class="[^"]*tactical-advisor/);
  assert.match(app, /tactics\.recommendation/);
  assert.match(css, /\.tactical-advisor/);
  assert.match(css, /\.tactical-stats/);
  assert.match(i18n, /"tactics\.title"/);
  assert.match(i18n, /"tactics\.recommendation\.finishDamaged"/);
});

test("tactical advisor highlights priority cells on the target board", () => {
  assert.match(app, /priorityTargetKeys/);
  assert.match(app, /tactical-priority/);
  assert.match(app, /priorityTargets:\s*tacticalAnalysis\.priorityTargets/);
  assert.match(css, /\.cell\.tactical-priority/);
  assert.match(css, /\.target \.cell\.tactical-priority/);
});

test("board cells expose localized state in aria labels", () => {
  assert.match(app, /function cellAriaLabel/);
  assert.match(app, /board\.state\./);
  assert.match(i18n, /"board\.state\.empty"/);
  assert.match(i18n, /"board\.state\.miss"/);
  assert.match(i18n, /"board\.state\.hit"/);
  assert.match(i18n, /"board\.state\.sunk"/);
});

test("board grids support keyboard navigation with visible focus", () => {
  assert.match(app, /root\.addEventListener\("keydown"/);
  assert.match(app, /function handleBoardKeydown/);
  assert.match(app, /function moveBoardFocus/);
  assert.match(app, /function nextBoardCell/);
  assert.match(app, /tabindex=/);
  assert.match(app, /ArrowRight/);
  assert.match(app, /ArrowLeft/);
  assert.match(app, /ArrowUp/);
  assert.match(app, /ArrowDown/);
  assert.match(css, /\.cell:focus-visible/);
});

test("manual setup supports keyboard preview, rotation, and focus restore", () => {
  assert.match(app, /root\.addEventListener\("focusin", handleSetupFocusin\)/);
  assert.match(app, /function handleSetupFocusin/);
  assert.match(app, /updateSetupHover\(readCoordinate\(cell\)\)/);
  assert.match(app, /event\.key\.toLowerCase\(\) === "r"/);
  assert.match(app, /rotateSetupOrientation\(\)/);
  assert.match(app, /restoreBoardFocus\(button\)/);
  assert.match(app, /function restoreBoardFocus/);
  assert.match(app, /requestAnimationFrame/);
});

test("mobile setup controls use compact topbar and full-width actions", () => {
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.topbar-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.settings-button strong\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.setup-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(css, /\.setup-primary-actions \[data-action="ready"\]:not\(:disabled\)/);
});
