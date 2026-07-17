import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { t } from "../src/i18n.js";

const app = readFileSync("src/app.js", "utf8");
const index = readFileSync("src/index.html", "utf8");
const remote = readFileSync("src/remote.js", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

test("Telegram Mini App copy covers auth, room failure, and account status in every locale", () => {
  const expected = {
    en: {
      "auth.miniAppOpenInTelegram": "Open Salvo in Telegram to sign in.",
      "auth.miniAppReopen": "This Telegram Mini App session expired. Reopen Salvo to sign in again.",
      "auth.retry": "Retry",
      "online.roomUnavailable": "This room is full, closed, or unavailable. Return to the online lobby and try another room.",
      "auth.miniAppAccountStatus": "Telegram Mini App account confirmed. Your existing profile and online progress are available.",
    },
    ru: {
      "auth.miniAppOpenInTelegram": "Откройте Залп в Telegram, чтобы войти.",
      "auth.miniAppReopen": "Сеанс Telegram Mini App истёк. Откройте Залп снова, чтобы войти.",
      "auth.retry": "Повторить",
      "online.roomUnavailable": "Комната заполнена, закрыта или недоступна. Вернитесь в онлайн-лобби и выберите другую комнату.",
      "auth.miniAppAccountStatus": "Аккаунт Telegram Mini App подтверждён. Ваш существующий профиль и онлайн-прогресс доступны.",
    },
    "zh-CN": {
      "auth.miniAppOpenInTelegram": "请在 Telegram 中打开 Salvo 以登录。",
      "auth.miniAppReopen": "Telegram Mini App 会话已过期。请重新打开 Salvo 以登录。",
      "auth.retry": "重试",
      "online.roomUnavailable": "此房间已满、已关闭或不可用。请返回在线大厅并尝试其他房间。",
      "auth.miniAppAccountStatus": "Telegram Mini App 账号已确认。您可以继续使用现有档案和在线进度。",
    },
  };

  for (const [language, copy] of Object.entries(expected)) {
    for (const [key, value] of Object.entries(copy)) {
      assert.equal(t(language, key), value, `${language} must define ${key}`);
    }
  }
});

test("Telegram runtime consumes content safe areas and the stable viewport", () => {
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(
      styles,
      new RegExp(`--salvo-safe-${side}:\\s*var\\(--tg-content-safe-area-inset-${side},\\s*env\\(safe-area-inset-${side},\\s*0px\\)\\)`),
    );
  }
  assert.match(styles, /html\[data-runtime="telegram"\]\s*\{[\s\S]*?--salvo-safe-top:/);
  assert.match(styles, /html\[data-runtime="telegram"\] \.shell\s*\{[\s\S]*?min-height:\s*var\(--tg-viewport-stable-height,[^;]+\);/);
  assert.match(styles, /html\[data-runtime="telegram"\] \.shell\s*\{[\s\S]*?var\(--salvo-safe-top\)[\s\S]*?var\(--salvo-safe-right\)[\s\S]*?var\(--salvo-safe-bottom\)[\s\S]*?var\(--salvo-safe-left\)/);
  assert.match(styles, /html\[data-runtime="telegram"\] \.modal-backdrop\s*\{[\s\S]*?var\(--salvo-safe-top\)[\s\S]*?var\(--salvo-safe-right\)[\s\S]*?var\(--salvo-safe-bottom\)[\s\S]*?var\(--salvo-safe-left\)/);
});

test("Telegram phone boards fit without changing web and native replay overflow", () => {
  const phoneStyles = styles.slice(styles.indexOf("@media (max-width: 720px)"));
  assert.doesNotMatch(phoneStyles, /(?:^|\n)  body\s*\{/);
  assert.match(phoneStyles, /\.board-scroll\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip/);
  assert.match(phoneStyles, /\.column-headers,[\s\S]*?\.board-grid\s*\{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(phoneStyles, /html\[data-runtime="telegram"\] \.replay-board-view\s*\{[^}]*overflow-x:\s*clip/);
  assert.match(phoneStyles, /html\[data-runtime="telegram"\] \.replay-board-view \.board-panel\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(phoneStyles, /(?:^|\n)  \.replay-board-view\s*\{/);
  assert.doesNotMatch(phoneStyles, /html\[data-runtime="telegram"\] \.replay-board-view \.column-headers,[^}]*font-size/);
});

test("frontend config exposes the public Telegram bot username only", () => {
  assert.match(index, /telegramBotUsername:\s*"agents_salvo_bot"/);
  assert.doesNotMatch(index, /TELEGRAM_BOT_TOKEN|SESSION_SECRET/);
});

test("frontend selects legacy or OIDC Telegram login from worker capability", () => {
  assert.match(app, /import \{ createTelegramAuthClient \} from "\.\/telegram-auth\.js"/);
  assert.match(app, /captureTelegramAuthBootstrap/);
  assert.match(app, /telegram-widget\.js/);
  assert.match(app, /window\.onTelegramAuth/);
  assert.match(app, /isTelegramLoginOriginAllowed/);
  assert.match(app, /auth\.domainHint/);
  assert.match(app, /auth:\s*\{[\s\S]*?method:\s*"unknown"/);
  assert.match(app, /data-action="auth-telegram-oidc"/);
  assert.match(app, /\/agents-salvo\/privacy\.html/);
  assert.match(app, /client\.start\(authPlatform/);
  assert.match(app, /client\.redeem\(ticket/);
  assert.match(app, /\/auth\/telegram/);
  assert.match(app, /\/auth\/me/);
  assert.match(app, /salvo\.authToken/);
  assert.match(app, /data-action="auth-logout"/);
  assert.doesNotMatch(app, /auth\.mobileSecureLoginPending/);
});

test("Telegram Mini App auth is isolated from legacy Telegram login startup", () => {
  assert.match(app, /import \{ createTelegramMiniAppAuthClient \} from "\.\/telegram-mini-app-auth\.js"/);
  assert.match(app, /platform\.getPlatform\(\) === "telegram"/);
  assert.match(app, /createTelegramMiniAppAuthClient\(\{/);
  assert.match(app, /authenticateTelegramMiniApp/);
  assert.match(app, /platform\.getLaunchData\(\)/);
  assert.match(app, /miniapp-unavailable/);
  assert.match(app, /telegramMiniAppClient\.authenticate\(launchData/);
  assert.match(app, /establishAuthSession\(/);
  assert.match(app, /telegramMainMiniAppUrl/);
  assert.match(app, /miniapp-expired/);
  assert.match(app, /auth\.miniAppOpenInTelegram/);
  assert.match(app, /auth\.miniAppReopen/);
  assert.match(app, /action: "auth-miniapp-open"/);
  assert.match(app, /action: "auth-miniapp-reopen"/);
});

test("runtime settings metadata validates and escapes the shared build identifier", () => {
  assert.match(app, /\^\[A-Za-z0-9\._-\]\{1,64\}\$/);
  assert.match(app, /window\.SALVO_CONFIG\?\.buildId/);
  assert.match(app, /settings-build-id/);
  assert.match(app, /escapeHtml\(buildId\)/);
});

test("Telegram login requires an explicit, readable privacy consent control", () => {
  assert.match(app, /data-action="auth-consent"/);
  assert.match(app, /authConsentSettingKey/);
  assert.match(app, /requireTelegramAuthConsent\(\)/);
  assert.match(styles, /\.auth-consent\s*\{/);
  assert.match(styles, /\.auth-consent input/);
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

test("private replay archive state uses authenticated participant endpoints", () => {
  assert.match(app, /archive:\s*\{\s*items:\s*\[\],\s*nextCursor:\s*"",\s*loading:\s*false,\s*error:\s*""/s);
  assert.match(app, /replayArchive:\s*\{\s*requestedId:/s);
  assert.match(app, /function loadReplayArchive\(\{ append = false \} = \{\}\)/);
  assert.match(app, /\/profile\/replays/);
  assert.match(app, /function loadArchivedReplay\(id\)/);
  assert.match(app, /\/replays\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(app, /Authorization:\s*`Bearer \$\{authRequest\.token\}`/);
});

test("replay deep links survive auth restoration and use browser history", () => {
  assert.match(app, /replayIdFromSearch\(window\.location\.search\)/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(app, /resumeRequestedReplay/);
  assert.match(app, /await resumeRequestedReplay\(\)/);
  assert.match(app, /resetResultReplayPlayback\(\)/);
  assert.match(app, /canonicalReplayBaseUrl\s*=\s*"https:\/\/agent-axiom\.github\.io\/agents-salvo\/"/);
  assert.match(app, /replayUrlForId\(canonicalReplayBaseUrl, replayId\)/);
});

test("private async work is scoped to one auth epoch and abortable request owners", () => {
  assert.match(app, /let authEpoch = 0;/);
  assert.match(app, /const privateRequestControllers = \{/);
  assert.match(app, /auth:\s*null/);
  assert.match(app, /profile:\s*null/);
  assert.match(app, /archive:\s*null/);
  assert.match(app, /replay:\s*null/);
  assert.match(app, /saves:\s*new Set\(\)/);
  assert.match(app, /new AbortController\(\)/);
  assert.match(app, /signal:\s*controller\.signal/);
  assert.match(app, /authRequestIsCurrent/);
  assert.match(app, /function captureAuthRequest\(\)/);
  assert.match(app, /function abortAllPrivateRequests\(\)/);
  assert.match(app, /function privateRequestIsCurrent\(/);
});

test("logout invalidates and renders private state before best-effort network logout", () => {
  const logout = sourceBetween("async function logoutAuth()", "async function refreshProfile");
  const invalidateAt = logout.indexOf("invalidateAuthSession");
  const renderAt = logout.indexOf("render()");
  const fetchAt = logout.indexOf("fetch(");

  assert.ok(invalidateAt >= 0, "logout must invalidate the local session");
  assert.ok(renderAt > invalidateAt, "logout must render cleared state after invalidation");
  assert.ok(fetchAt > renderAt, "logout network request must happen after the synchronous render");
  assert.match(logout, /const token = state\.auth\.token/);
  assert.match(logout, /const invalidated = await invalidateAuthSession/);
  assert.match(logout, /render\(\);\s+if \(!invalidated\) return;/);
  assert.match(logout, /Authorization:\s*`Bearer \$\{token\}`/);
});

test("profile loads and battle saves reject stale session responses", () => {
  const profile = sourceBetween("async function refreshProfile", "async function recordCompletedBattle");
  const save = sourceBetween("async function recordCompletedBattle", "async function refreshLeaderboard");
  const reset = sourceBetween("function resetProfile()", "async function readAuthJson");

  assert.match(profile, /captureAuthRequest\(\)/);
  assert.match(profile, /beginPrivateRequest\("profile"\)/);
  assert.match(profile, /authRequestIsCurrent/);
  assert.match(profile, /privateRequestIsCurrent\("profile", controller\)/);
  assert.match(save, /captureAuthRequest\(\)/);
  assert.match(save, /privateRequestControllers\.saves\.add\(controller\)/);
  assert.match(save, /authRequestIsCurrent/);
  assert.match(reset, /abortPrivateRequest\("profile"\)/);
});

test("archive and replay requests abort superseded work and gate final renders", () => {
  const archive = sourceBetween("async function loadReplayArchive", "async function loadArchivedReplay");
  const replay = sourceBetween("async function loadArchivedReplay", "function currentArchiveRequest");

  for (const [source, owner] of [
    [archive, "archive"],
    [replay, "replay"],
  ]) {
    assert.match(source, new RegExp(`beginPrivateRequest\\("${owner}"\\)`));
    assert.match(source, /signal:\s*controller\.signal/);
    assert.match(source, new RegExp(`${owner === "archive" ? "archiveLoad" : "archivedReplayLoad"}IsCurrent`));
    assert.match(
      app,
      new RegExp(`function ${owner === "archive" ? "archiveLoad" : "archivedReplayLoad"}IsCurrent[\\s\\S]*?privateRequestIsCurrent\\("${owner}", controller\\)`),
    );
    assert.match(source, /finally\s*\{[\s\S]*?if \([^)]*IsCurrent[\s\S]*?render\(\);/);
  }
  assert.match(app, /function archiveLoadIsCurrent[\s\S]*?authRequestIsCurrent/);
  assert.match(app, /function archivedReplayLoadIsCurrent[\s\S]*?authRequestIsCurrent/);
});

test("legacy archive and recent rows remain visible without acting like replay links", () => {
  const archiveRow = sourceBetween("function renderArchiveRow", "function renderArchivedReplay");
  const recentRows = sourceBetween("function renderRecentMatches", "function renderLeaderboard");

  assert.match(archiveRow, /archiveReplayId\(item\)/);
  assert.match(archiveRow, /data-replay-id="\$\{escapeHtml\(replayId\)\}"/);
  assert.match(archiveRow, /data-replay-source="archive"/);
  assert.match(archiveRow, /archive\.historicalUnavailable/);
  assert.match(archiveRow, /archive-row-content/);
  assert.match(recentRows, /archiveReplayId\(match\)/);
  assert.match(recentRows, /match\.mode === "online"/);
  assert.match(recentRows, /data-replay-source="recent"/);
  assert.match(recentRows, /archive\.historicalUnavailable/);
});

test("failed archive pagination retries the preserved page without dropping existing rows", () => {
  const archive = sourceBetween("async function loadReplayArchive", "async function loadArchivedReplay");
  const retry = sourceBetween("async function retryReplayArchive", "async function loadArchivedReplay");

  assert.match(archive, /const requestCursor =/);
  assert.match(archive, /state\.archive\.retryAppend = appendRequest/);
  assert.match(archive, /state\.archive\.retryCursor = requestCursor/);
  assert.match(archive, /appendRequest \? uniqueArchiveItems\(\[\.\.\.state\.archive\.items, \.\.\.items\]\) : items/);
  assert.match(retry, /archiveRetryOptions/);
  assert.match(retry, /state\.archive\.retrying = true/);
  assert.match(app, /if \(action === "archive-retry"\) await retryReplayArchive\(\)/);
});

test("replay back reuses archive history only when the replay came from the archive", () => {
  const openReplay = sourceBetween("async function openArchivedReplay", "function updateReplayHistory");
  const back = sourceBetween("async function backToReplayArchive", "function updateReplayHistory");

  assert.match(openReplay, /source = "direct"/);
  assert.match(openReplay, /state\.replayArchive\.openedFromArchive = source === "archive"/);
  assert.match(openReplay, /replaySource:\s*source/);
  assert.match(back, /state\.replayArchive\.openedFromArchive/);
  assert.match(back, /window\.history\.back\(\)/);
  assert.match(back, /openReplayArchive\(\{ historyMode: "replace" \}\)/);
  assert.match(app, /if \(action === "replay-back"\) await backToReplayArchive\(\)/);
});

function sourceBetween(start, end) {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source start: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source end: ${end}`);
  return app.slice(startIndex, endIndex);
}
