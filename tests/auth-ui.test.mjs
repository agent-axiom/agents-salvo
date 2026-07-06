import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");
const index = readFileSync("src/index.html", "utf8");
const remote = readFileSync("src/remote.js", "utf8");

test("frontend config exposes the public Telegram bot username only", () => {
  assert.match(index, /telegramBotUsername:\s*"agents_salvo_bot"/);
  assert.doesNotMatch(index, /TELEGRAM_BOT_TOKEN|SESSION_SECRET/);
});

test("frontend mounts Telegram login and exchanges payloads with the worker", () => {
  assert.match(app, /telegram-widget\.js/);
  assert.match(app, /window\.onTelegramAuth/);
  assert.match(app, /isTelegramLoginOriginAllowed/);
  assert.match(app, /auth\.domainHint/);
  assert.match(app, /\/auth\/telegram/);
  assert.match(app, /\/auth\/me/);
  assert.match(app, /salvo\.authToken/);
  assert.match(app, /data-action="auth-logout"/);
});

test("frontend exposes player profile and completed battle recording hooks", () => {
  assert.match(app, /\/profile\/me/);
  assert.match(app, /\/profile\/matches/);
  assert.match(app, /renderProfilePanel/);
  assert.match(app, /renderLeaderboard/);
  assert.match(app, /profile\.rating/);
  assert.match(app, /profile\.leaderboard/);
  assert.match(app, /recordCompletedBattle/);
  assert.match(app, /data-action="refresh-profile"/);
});

test("authenticated local player labels use the Telegram display name safely", () => {
  assert.match(app, /function localPlayerName\(\)/);
  assert.match(app, /function setupPlayerTitle\(playerId\)/);
  assert.match(app, /state\.auth\.user\?\.name/);
  assert.match(app, /escapeHtml\((?:name|state\.auth\.user\.name)\)/);
  assert.match(app, /if \(playerId === "p1"\) \{\s*return localPlayerName\(\);\s*\}/s);
  assert.match(app, /:\s*setupPlayerTitle\(state\.setupPlayerId\)/);
});

test("online client sends auth tokens and does not submit online results directly", () => {
  assert.match(remote, /authToken/);
  assert.match(remote, /Authorization/);
  assert.match(remote, /Bearer/);
  assert.match(app, /authToken:\s*state\.auth\.token/);
  assert.match(app, /refreshProfile\(/);
  assert.doesNotMatch(app, /recordCompletedBattle\(\s*completedBattleMatch\(\{\s*key:\s*onlineResultKey/s);
});

test("online room actions require a registered Telegram player in the UI", () => {
  assert.match(app, /function isOnlineAuthReady\(\)/);
  assert.match(app, /function renderOnlineAuthGate\(\)/);
  assert.match(app, /online\.authRequired/);
  assert.match(app, /data-action="online-create"[^>]*\$\{onlineDisabled\}/);
  assert.match(app, /data-action="online-join"[^>]*\$\{onlineDisabled\}/);
  assert.match(app, /if \(!isOnlineAuthReady\(\)\) \{\s*state\.online\.error = translate\("online\.authRequired"\);/s);
});
