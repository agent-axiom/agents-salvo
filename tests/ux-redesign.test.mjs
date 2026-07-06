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
