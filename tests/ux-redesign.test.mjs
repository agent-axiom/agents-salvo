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

test("smart battle adds hard agent difficulty and post-battle coaching", () => {
  assert.match(app, /value="hard"/);
  assert.match(app, /function renderBattleCoaching/);
  assert.match(app, /class="battle-coaching"/);
  assert.match(app, /data-action="start-coaching-training"/);
  assert.match(app, /data-drill-id/);
  assert.match(app, /trainingScenarioForDrill/);
  assert.match(app, /coaching\.diagnosis/);
  assert.match(app, /coaching\.drill/);
  assert.match(css, /\.battle-coaching/);
  assert.match(i18n, /"agent\.hard"/);
  assert.match(i18n, /"coaching\.title"/);
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

test("board cells expose localized state in aria labels", () => {
  assert.match(app, /function cellAriaLabel/);
  assert.match(app, /board\.state\./);
  assert.match(i18n, /"board\.state\.empty"/);
  assert.match(i18n, /"board\.state\.miss"/);
  assert.match(i18n, /"board\.state\.hit"/);
  assert.match(i18n, /"board\.state\.sunk"/);
});

test("mobile setup controls use compact topbar and full-width actions", () => {
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.topbar-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.settings-button strong\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.setup-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(css, /\.setup-primary-actions \[data-action="ready"\]:not\(:disabled\)/);
});
