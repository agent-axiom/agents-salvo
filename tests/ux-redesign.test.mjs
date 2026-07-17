import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");
const css = readFileSync("src/styles.css", "utf8");
const i18n = readFileSync("src/i18n.js", "utf8");
const html = readFileSync("src/index.html", "utf8");
const mobileSupport = readFileSync("src/mobile-app-support.js", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

test("app integration coverage does not mask the application source", () => {
  assert.doesNotMatch(app, /node:coverage disable/);
});

test("coverage uses separate truthful core and actual-app gates", () => {
  const scripts = packageJson.scripts;
  assert.match(scripts.coverage, /npm run coverage:core/);
  assert.match(scripts.coverage, /npm run coverage:app/);
  assert.match(scripts["coverage:core"], /SALVO_APP_CHILD_COVERAGE=isolated/);
  assert.match(scripts["coverage:core"], /--test-coverage-lines=98/);
  assert.doesNotMatch(scripts["coverage:core"], /--test-coverage-include=src\/app\.js/);
  assert.match(scripts["coverage:core"], /tests\/\*\.test\.mjs/);
  assert.match(scripts["coverage:app"], /SALVO_APP_CHILD_COVERAGE=inherit/);
  assert.match(scripts["coverage:app"], /--test-coverage-include=src\/app\.js/);
  assert.match(scripts["coverage:app"], /--test-coverage-lines=39/);
  assert.match(scripts["coverage:app"], /tests\/app-behavior\.test\.mjs/);
});

test("main menu is a focused game hub with agent play as the primary action", () => {
  assert.match(app, /class="game-hub"/);
  assert.match(app, /class="hub-primary"/);
  assert.match(app, /class="hub-cta primary-button"[^>]+data-action="start-agent"/);
  assert.match(app, /class="hub-rule-summary"/);
  assert.doesNotMatch(app, /renderCompactProfile/);
  assert.doesNotMatch(app, /class="profile-compact"/);
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

test("battlefield shows a compact last-shot pulse above the target board", () => {
  assert.match(app, /function renderBattlePulse/);
  assert.match(app, /renderBattlePulse\(log, \{ targetDisabled, salvoRemaining, tacticalAnalysis, playerId, ownBoard, targetBoard \}\)/);
  assert.match(app, /visibleBattleLog\(log\)\[0\]/);
  assert.match(app, /class="battle-pulse/);
  assert.match(app, /class="battle-pulse-result/);
  assert.match(app, /class="battle-pulse-metrics"/);
  assert.match(app, /battle\.lastShot/);
  assert.match(app, /battle\.awaitingShot/);
  assert.match(app, /battle\.ready/);
  assert.match(app, /battle\.paused/);
  assert.match(app, /battle\.priorityCount/);
  assert.match(css, /\.battle-pulse/);
  assert.match(css, /\.battle-pulse-result/);
  assert.match(css, /\.battle-pulse-metrics/);
  assert.match(i18n, /"battle\.lastShot"/);
  assert.match(i18n, /"battle\.awaitingShot"/);
});

test("battle pulse shows live player accuracy and hit progress", () => {
  assert.match(app, /function renderBattleLiveStats/);
  assert.match(app, /summarizeBattleLog\(log, playerId\)/);
  assert.match(app, /class="battle-live-stats"/);
  assert.match(app, /battle\.accuracy/);
  assert.match(app, /battle\.hits/);
  assert.match(app, /battle\.sunk/);
  assert.match(app, /playerId:\s*perspectivePlayerId/);
  assert.match(app, /playerId:\s*snapshot\.playerId/);
  assert.match(css, /\.battle-live-stats/);
  assert.match(i18n, /"battle\.accuracy"/);
  assert.match(i18n, /"battle\.hits"/);
  assert.match(i18n, /"battle\.sunk"/);
});

test("battle pulse shows a live momentum strip from battle pressure", () => {
  assert.match(app, /battleMomentum\(log, playerId\)/);
  assert.match(app, /function renderBattleMomentum/);
  assert.match(app, /class="battle-momentum/);
  assert.match(app, /class="battle-momentum-track"/);
  assert.match(app, /--momentum:\s*\$\{momentum\.playerShare\}%/);
  assert.match(app, /battle\.momentumTitle/);
  assert.match(app, /battle\.momentum\.\$\{momentum\.state\}/);
  assert.match(css, /\.battle-momentum/);
  assert.match(css, /\.battle-momentum-track/);
  assert.match(i18n, /"battle\.momentumTitle"/);
  assert.match(i18n, /"battle\.momentum\.ahead"/);
  assert.match(i18n, /"battle\.momentum\.even"/);
  assert.match(i18n, /"battle\.momentum\.behind"/);
});

test("battle pulse shows compact fleet intel for sunk and afloat ships", () => {
  assert.match(app, /renderBattlePulse\(log, \{ targetDisabled, salvoRemaining, tacticalAnalysis, playerId, ownBoard, targetBoard \}\)/);
  assert.match(app, /function renderFleetIntel/);
  assert.match(app, /fleetIntel\(log, playerId, ownBoard\)/);
  assert.match(app, /class="battle-fleet-intel"/);
  assert.match(app, /battle\.fleetIntel/);
  assert.match(app, /battle\.enemySunk/);
  assert.match(app, /battle\.ownAfloat/);
  assert.match(css, /\.battle-fleet-intel/);
  assert.match(i18n, /"battle\.fleetIntel"/);
  assert.match(i18n, /"battle\.enemySunk"/);
  assert.match(i18n, /"battle\.ownAfloat"/);
});

test("battle pulse shows target reconnaissance coverage without revealing ships", () => {
  assert.match(app, /function renderTargetIntel/);
  assert.match(app, /targetIntel\(targetBoard\)/);
  assert.match(app, /class="battle-target-intel"/);
  assert.match(app, /battle\.targetIntel/);
  assert.match(app, /battle\.scouted/);
  assert.match(app, /battle\.remainingCells/);
  assert.match(css, /\.battle-target-intel/);
  assert.match(i18n, /"battle\.targetIntel"/);
  assert.match(i18n, /"battle\.scouted"/);
  assert.match(i18n, /"battle\.remainingCells"/);
});

test("agent battles keep the human fleet as own board after the agent wins", () => {
  assert.match(app, /function localPerspectivePlayerId/);
  assert.match(app, /state\.mode === "agent" \? "p1" : state\.game\.currentPlayerId/);
  assert.match(app, /const perspectivePlayerId = localPerspectivePlayerId\(\)/);
  assert.match(app, /const ownBoard = state\.game\.players\[perspectivePlayerId\]\.board/);
});

test("topbar exposes the public leaderboard as a popover", () => {
  assert.match(app, /leaderboard:\s*\{/);
  assert.match(app, /leaderboardOpen:\s*false/);
  assert.match(app, /renderTopbarLeaderboard/);
  assert.match(app, /data-action="toggle-leaderboard"/);
  assert.match(app, /state\.leaderboardOpen \? renderLeaderboardPopover\(\) : ""/);
  assert.match(app, /function renderLeaderboardPopover/);
  assert.match(app, /data-action="close-leaderboard"/);
  assert.match(app, /await refreshLeaderboard\(\{ renderWhenDone: false \}\)/);
  assert.doesNotMatch(app, /renderPublicLeaderboard/);
  assert.doesNotMatch(app, /class="public-leaderboard"/);
  assert.match(app, /refreshLeaderboard/);
  assert.match(app, /\/leaderboard/);
  assert.match(css, /\.leaderboard-popover/);
  assert.match(css, /\.leaderboard-panel/);
  assert.match(i18n, /"leaderboard\.title"/);
});

test("manual setup has random-first actions, progress, and placement preview states", () => {
  assert.match(app, /class="setup-primary-actions"/);
  assert.match(app, /class="setup-action-card setup-action-random"/);
  assert.match(app, /class="setup-action-card setup-action-ready"/);
  assert.match(app, /class="setup-progress"/);
  assert.match(app, /function setupPreview/);
  assert.match(app, /placement-ok/);
  assert.match(app, /placement-bad/);
  assert.match(css, /\.cell\.placement-ok/);
  assert.match(css, /\.cell\.placement-bad/);
});

test("desktop controls use a cohesive polished button system", () => {
  assert.match(cssRule("button"), /--button-bg:/);
  assert.match(cssRule("button"), /min-height:\s*40px/);
  assert.match(cssRule("button"), /border-radius:\s*8px/);
  assert.match(cssRule("button:hover:not(:disabled)"), /translateY\(-2px\)/);
  assert.match(cssRule("button:focus-visible"), /outline:\s*3px solid/);
  assert.match(css, /select,\ninput\s*\{[\s\S]*?border-radius:\s*10px/);
  assert.match(cssRule(".primary-button"), /linear-gradient/);
  assert.match(cssRule(".secondary-button"), /--button-bg:/);
  assert.match(cssRule(".ghost-button"), /--button-bg:\s*transparent/);
  assert.match(cssRule(".setup-primary-actions"), /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(cssRule(".setup-action-card"), /min-height:\s*56px/);
  assert.match(cssRule(".setup-action-ready"), /grid-column:\s*1 \/ -1/);
  assert.match(cssRule(".setup-action-ready:not(:disabled)"), /linear-gradient/);
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
  assert.match(app, /class="result-actions button-row"/);
  assert.match(app, /class="achievement-list"/);
  assert.match(app, /achievement\./);
  assert.match(css, /\.battle-report/);
  assert.match(cssRule(".result-actions"), /position:\s*sticky/);
  assert.match(cssRule(".result-modal"), /--result-modal-padding:\s*22px/);
  assert.match(cssRule(".result-actions"), /bottom:\s*calc\(var\(--result-modal-padding\) \* -1\)/);
  assert.match(css, /\.achievement-list/);
  assert.match(i18n, /"result\.report"/);
  assert.match(i18n, /"achievement\.sharpshooter\.title"/);
});

test("result modal includes a tactical battle debrief", () => {
  assert.match(app, /function renderBattleDebrief/);
  assert.match(app, /report\.debrief/);
  assert.match(app, /class="battle-debrief"/);
  assert.match(app, /debrief\.insights/);
  assert.match(app, /debrief\.message\.\$\{insight\.messageId\}/);
  assert.match(css, /\.battle-debrief/);
  assert.match(css, /\.battle-debrief-list/);
  assert.match(css, /\.battle-debrief-item\.is-warning/);
  assert.match(css, /\.battle-debrief-item\.is-positive/);
  assert.match(i18n, /"debrief\.title"/);
  assert.match(i18n, /"debrief\.message\.weakSearch"/);
  assert.match(i18n, /"debrief\.message\.cleanFinish"/);
});

test("result modal includes key battle moments", () => {
  assert.match(app, /function renderBattleMoments/);
  assert.match(app, /report\.moments/);
  assert.match(app, /class="battle-moments"/);
  assert.match(app, /moments\.items/);
  assert.match(app, /momentCoordinateText/);
  assert.match(app, /moment\.id === "missStreak"/);
  assert.match(css, /\.battle-moments/);
  assert.match(css, /\.battle-moment-list/);
  assert.match(css, /\.battle-moment-item/);
  assert.match(i18n, /"moments\.title"/);
  assert.match(i18n, /"moments\.firstContact"/);
  assert.match(i18n, /"moments\.missStreak"/);
});

test("result modal includes timeline and step-through battle replay controls", () => {
  assert.match(app, /resultReplayTurn:\s*null/);
  assert.match(app, /resultReplayPlaying:\s*false/);
  assert.match(app, /resultReplaySpeedIndex:\s*0/);
  assert.match(app, /const resultReplayClock = createReplayClock/);
  assert.match(app, /function renderBattleReplay/);
  assert.match(app, /renderBattleReplay\(log, report\.moments\)/);
  assert.match(app, /function replayBoardForLog/);
  assert.match(app, /renderBoard\(replayBoard, \{/);
  assert.match(app, /kind:\s*"replay-target"/);
  assert.match(app, /highlightCoordinate:\s*entry\.coordinate/);
  assert.match(app, /data-action="result-replay-prev"/);
  assert.match(app, /data-action="result-replay-next"/);
  assert.match(app, /data-action="result-replay-toggle-play"/);
  assert.match(app, /data-action="result-replay-speed"/);
  assert.match(app, /data-action="result-replay-seek"/);
  assert.match(app, /data-action="result-replay-jump"/);
  assert.match(app, /type="range"/);
  assert.match(app, /const replayMoveText = translate\("replay\.move"/);
  assert.match(app, /const replayPositionText = translate\("replay\.position"/);
  assert.match(app, /aria-valuetext="\$\{replayPositionText\}"/);
  assert.match(app, /aria-current="step"/);
  assert.match(app, /aria-label="\$\{translate\("replay\.speed", \{ speed: replaySpeed\.label \}\)\}"/);
  assert.match(app, /<span aria-hidden="true">\$\{replaySpeed\.label\}<\/span>/);
  assert.match(app, /function setResultReplayTurn/);
  assert.match(app, /function changeResultReplayTurn/);
  assert.match(app, /function toggleResultReplayPlayback/);
  assert.match(app, /function cycleResultReplaySpeed/);
  assert.match(app, /function stopResultReplayPlayback/);
  assert.match(app, /function resetResultReplayPlayback/);
  assert.match(app, /function renderResultReplayFrame/);
  assert.match(app, /replayElement\.outerHTML = renderBattleReplay/);
  assert.match(app, /resultModal\.scrollTop = scrollTop/);
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /class="replay-live-status visually-hidden"/);
  assert.match(app, /aria-live="polite" aria-atomic="true"/);
  assert.match(app, /resultReplayClock\.start/);
  assert.match(app, /resultReplayClock\.stop/);
  assert.doesNotMatch(app, /aria-pressed="\$\{state\.resultReplayPlaying\}"/);
  assert.match(app, /state\.resultReplayTurn = normalizeReplayTurn/);
  assert.match(app, /result-replay-seek/);
  assert.match(app, /result-replay-jump/);
  assert.match(app, /class="battle-replay"/);
  assert.match(app, /class="battle-replay-map"/);
  assert.match(app, /replay-active/);
  assert.match(app, /battleReplayCoordinateText/);
  assert.match(css, /\.battle-replay/);
  assert.match(css, /\.battle-replay-map/);
  assert.match(css, /\.cell\.replay-active/);
  assert.match(css, /\.cell\.replay-active::before/);
  assert.match(css, /@keyframes replayShotPulse/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /\.battle-replay-controls/);
  assert.match(css, /\.battle-replay-timeline/);
  assert.match(css, /\.battle-replay-timeline input\[type="range"\]\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.battle-replay-moments/);
  assert.match(css, /\.battle-replay-moment\.is-active/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.battle-replay-moment span\s*\{[^}]*white-space:\s*normal/s);
  assert.match(css, /\.visually-hidden/);
  assert.match(css, /\.battle-replay-controls button\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /\.battle-replay-controls button\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(i18n, /"replay\.title"/);
  assert.match(i18n, /"replay\.map"/);
  assert.match(i18n, /"replay\.move"/);
  assert.match(i18n, /"replay\.previous"/);
  assert.match(i18n, /"replay\.next"/);
  assert.match(i18n, /"replay\.play"/);
  assert.match(i18n, /"replay\.pause"/);
  assert.match(i18n, /"replay\.speed"/);
  assert.match(i18n, /"replay\.timeline"/);
  assert.match(i18n, /"replay\.seek"/);
  assert.match(i18n, /"replay\.position"/);
  assert.match(i18n, /"replay\.announcement"/);
});

test("result modal can copy and share a battle summary through the platform", () => {
  assert.match(app, /data-action="copy-battle-summary"/);
  assert.match(app, /data-action="share-battle-summary"/);
  assert.match(app, /function copyBattleSummary/);
  assert.match(app, /async function shareBattleSummary/);
  assert.match(app, /function buildBattleSummaryText/);
  assert.match(app, /currentBattleResultContext/);
  assert.match(app, /navigator\.clipboard\?\.writeText\(summaryText\)/);
  assert.match(app, /platform\.share\(\{[\s\S]*?title:\s*translate\("app\.title"\)[\s\S]*?text:[\s\S]*?url:/);
  assert.match(app, /platform\.openExternalUrl\(telegramUrl\.toString\(\)\)/);
  assert.match(app, /resultCopyStatus:\s*""/);
  assert.match(app, /state\.resultCopyStatus = "copied"/);
  assert.match(app, /state\.resultCopyStatus = outcome\.shared \? "" : outcome\.copied \? "link-copied" : "share-failed"/);
  assert.match(app, /class="result-share-status status-line"/);
  assert.match(i18n, /"share\.linkCopied"/);
  assert.match(i18n, /"result\.copySummary"/);
  assert.match(i18n, /"result\.copySuccess"/);
  assert.match(i18n, /"result\.shareSummary"/);
  assert.match(i18n, /"result\.shareText"/);
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
  assert.match(app, /state\.leaderboardOpen = false/);
  assert.match(app, /renderProfilePanel\(\)/);
  assert.match(css, /\.profile-popover/);
  assert.match(css, /\.profile-popover \.profile-panel/);
});

test("smart battle adds hard agent difficulty and post-battle coaching", () => {
  assert.match(app, /value="hard"/);
  assert.match(app, /function renderBattleCoaching/);
  assert.match(app, /<details class="battle-coaching"/);
  assert.match(app, /class="battle-coaching-summary"/);
  assert.match(app, /class="battle-coaching-preview"/);
  assert.match(app, /class="training-plan"/);
  assert.match(app, /trainingPlan\.steps/);
  assert.match(app, /data-action="start-coaching-training"/);
  assert.match(app, /data-drill-id/);
  assert.match(app, /trainingScenarioForDrill/);
  assert.match(app, /coaching\.diagnosis/);
  assert.match(app, /coaching\.drill/);
  assert.match(app, /report\.trainingPlan/);
  assert.match(cssRule(".result-modal"), /max-height:\s*calc\(100dvh - 36px\)/);
  assert.match(cssRule(".result-modal"), /overflow-y:\s*auto/);
  assert.match(css, /\.battle-coaching/);
  assert.match(cssRule(".battle-coaching-summary"), /cursor:\s*pointer/);
  assert.match(cssRule(".battle-coaching:not([open]) .training-plan"), /display:\s*none/);
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
  assert.match(app, /trainingProgressSettingKey/);
  assert.match(app, /updateTrainingProgress/);
  assert.match(app, /function renderTrainingProgress/);
  assert.match(app, /preferenceCoordinator\.write\([\s\S]*?trainingProgressSettingKey,[\s\S]*?JSON\.stringify\(state\.training\.progress\)/);
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

test("tactical advisor exposes priority targets as fireable coordinate chips", () => {
  assert.match(app, /function renderPriorityTargetChips/);
  assert.match(app, /targetKind === "online-target" \? "online-shot" : "shot"/);
  assert.match(app, /renderPriorityTargetChips\(analysis\.priorityTargets, \{ disabled, targetAction \}\)/);
  assert.match(app, /class="priority-targets"/);
  assert.match(app, /class="priority-target-chip"/);
  assert.match(app, /data-action="\$\{targetAction\}"/);
  assert.match(app, /data-row="\$\{target\.row\}"/);
  assert.match(app, /data-col="\$\{target\.col\}"/);
  assert.match(css, /\.priority-targets/);
  assert.match(css, /\.priority-target-chip/);
});

test("tactical advisor exposes a one-tap recommended shot", () => {
  assert.match(app, /function renderQuickFireButton/);
  assert.match(app, /renderQuickFireButton\(analysis\.priorityTargets\[0\], \{ disabled, targetAction \}\)/);
  assert.match(app, /class="tactical-quick-fire"/);
  assert.match(app, /data-action="\$\{targetAction\}"/);
  assert.match(app, /data-row="\$\{target\.row\}"/);
  assert.match(app, /data-col="\$\{target\.col\}"/);
  assert.match(app, /translate\("tactics\.quickFire"/);
  assert.match(css, /\.tactical-quick-fire/);
  assert.match(i18n, /"tactics\.quickFire"/);
});

test("tactical advisor can collapse into a compact battle control", () => {
  assert.match(app, /tacticalAdvisorOpen:\s*true/);
  assert.match(app, /data-action="toggle-tactical-advisor"/);
  assert.match(app, /aria-expanded="\$\{expanded\}"/);
  assert.match(app, /function toggleTacticalAdvisor/);
  assert.match(app, /state\.tacticalAdvisorOpen = !state\.tacticalAdvisorOpen/);
  assert.match(app, /class="tactical-advisor \$\{disabled \? "is-paused" : ""\} is-expanded"/);
  assert.match(app, /class="tactical-advisor-body"/);
  assert.match(css, /\.tactical-advisor-toggle/);
  assert.match(css, /\.tactical-advisor\.is-collapsed/);
  assert.match(i18n, /"tactics\.collapse"/);
  assert.match(i18n, /"tactics\.expand"/);
});

test("collapsed tactical advisor renders as a single compact toggle", () => {
  assert.match(app, /if \(!expanded\) \{/);
  assert.match(app, /class="tactical-advisor is-collapsed"/);
  assert.match(app, /class="tactical-advisor-toggle tactical-advisor-compact-toggle"/);
  assert.match(app, /aria-expanded="false"/);
  assert.match(app, /aria-label="\$\{translate\("tactics\.expand"\)\}"/);
  assert.match(css, /\.tactical-advisor-compact-toggle/);
  assert.match(cssRule(".tactical-advisor.is-collapsed"), /padding:\s*0/);
  assert.match(cssRule(".tactical-advisor.is-collapsed"), /background:\s*transparent/);
});

test("tactical priority hints do not mimic sunk or miss markers", () => {
  const priorityMarkerRule = combinedCssRule(
    ".target .cell.tactical-priority:not(:disabled)::before",
    ".online-target .cell.tactical-priority:not(:disabled)::before",
  );

  assert.doesNotMatch(priorityMarkerRule, /border:\s*2px dashed/);
  assert.doesNotMatch(priorityMarkerRule, /border-radius:\s*50%/);
  assert.match(priorityMarkerRule, /linear-gradient/);
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
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.topbar-controls\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.settings-button strong\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.setup-primary-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.battle-pulse\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  assert.match(css, /\.setup-action-ready:not\(:disabled\)/);
});

test("private archive renders replay-enabled rows and complete request states", () => {
  assert.match(app, /function renderReplayArchive\(\)/);
  assert.match(app, /class="archive-list"/);
  assert.match(app, /class="archive-row/);
  assert.match(app, /data-action="archive-load-more"/);
  assert.match(app, /data-action="archive-retry"/);
  assert.match(app, /data-action="open-replay"/);
  assert.match(app, /archive\.signInRequired/);
  assert.match(app, /archive\.empty/);
  assert.match(css, /\.archive-screen/);
  assert.match(css, /\.archive-row/);
  assert.match(css, /\.profile-recent li\.is-historical/);
  assert.match(css, /\.historical-replay-unavailable[\s\S]*?grid-column:\s*1 \/ -1/);
});

test("archived replay uses viewer perspective, two boards, and mobile board tabs", () => {
  assert.match(app, /archivedReplayFrame\(replay, state\.resultReplayTurn\)/);
  assert.match(app, /replay\.viewerPlayerId/);
  assert.match(app, /class="archived-replay-boards"/);
  assert.match(app, /class="replay-board-view[^\"]*is-own/);
  assert.match(app, /class="replay-board-view[^\"]*is-opponent/);
  assert.match(app, /data-action="replay-tab"/);
  assert.match(app, /data-action="archived-replay-seek"/);
  assert.match(app, /data-action="replay-copy-link"/);
  assert.match(app, /aria-live="polite"/);
  assert.match(css, /\.archived-replay-boards/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.replay-board-view:not\(\.is-selected\)\s*\{[\s\S]*?display:\s*none;/);
});

test("archive replay controls remain touchable and do not force viewport overflow", () => {
  assert.match(cssRule('.archived-replay-timeline input[type="range"]'), /min-height:\s*44px/);
  assert.match(cssRule(".archive-screen"), /max-width:\s*100%/);
  assert.match(cssRule(".archived-replay-screen"), /max-width:\s*100%/);
  assert.doesNotMatch(cssRule(".archive-screen"), /100vw/);
  assert.doesNotMatch(cssRule(".archived-replay-screen"), /100vw/);
  assert.match(css, /\.archive-row-name[\s\S]*?overflow-wrap:\s*anywhere/);
});

test("archived replay playback preserves keyboard focus between rendered frames", () => {
  assert.match(app, /function renderArchivedReplayFrame\(\)/);
  assert.match(app, /\.archived-replay-screen \[data-action\]/);
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /renderActiveReplayFrame\(\)[\s\S]*?renderArchivedReplayFrame\(\)/);
});

test("archived replay board chooser is a valid focus-preserving segmented control", () => {
  const replayContent = sourceBetween("function renderArchivedReplayContent", "function renderArchivedReplayMoments");
  const selectBoard = sourceBetween("function selectArchivedReplayTab", "async function copyArchivedReplayLink");
  const archiveRow = sourceBetween("function renderArchiveRow", "function renderArchivedReplay");

  assert.match(replayContent, /class="archived-replay-tabs" role="group"/);
  assert.match(replayContent, /aria-pressed="\$\{ownSelected\}"/);
  assert.match(replayContent, /aria-pressed="\$\{!ownSelected\}"/);
  assert.doesNotMatch(replayContent, /role="tab(?:list)?"/);
  assert.doesNotMatch(replayContent, /aria-selected=/);
  assert.match(selectBoard, /renderArchivedReplayFrame\(\)/);
  assert.doesNotMatch(archiveRow, /aria-label="\$\{translate\("archive\.watchReplay"\)\}"/);
});

test("16x16 archived boards scroll inside the replay at 320px while 10x10 stays fluid", () => {
  assert.match(app, /archivedReplayBoardMinWidth\(frame\.boards\[viewerPlayerId\]\.size\)/);
  assert.match(app, /archivedReplayBoardMinWidth\(frame\.boards\[opponentPlayerId\]\.size\)/);
  assert.match(app, /--replay-board-min-width:/);
  assert.match(cssRule(".replay-board-view"), /max-width:\s*100%/);
  assert.match(cssRule(".replay-board-view"), /overflow-x:\s*auto/);
  assert.match(cssRule(".replay-board-view"), /overscroll-behavior-inline:\s*contain/);
  assert.match(cssRule(".replay-board-view .board-panel"), /width:\s*max\(100%,\s*var\(--replay-board-min-width,\s*0px\)\)/);
  assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*?\.archive-screen,[\s\S]*?\.archived-replay-screen\s*\{[\s\S]*?padding:\s*8px;/);
  assert.match(cssRule(".archived-replay-screen"), /overflow-x:\s*clip/);
});

test("mobile startup wires the platform, snapshot store, and runtime after first paint", () => {
  assert.match(app, /import \{ platform \} from "\.\/platform\/index\.js"/);
  assert.match(app, /import \{ createMobileRuntime \} from "\.\/mobile\.js"/);
  assert.match(
    app,
    /import \{[\s\S]*createLocalBattleSnapshotStore,[\s\S]*UnsupportedLocalBattleSnapshotVersionError[\s\S]*\} from "\.\/core\/local-battle-snapshot\.js"/,
  );
  assert.match(app, /createDiscardableSnapshotStore\(\s*createLocalBattleSnapshotStore\(platform\.settings\)/);
  assert.match(app, /createMobileRuntime\(\{[\s\S]*?platform,[\s\S]*?snapshots:[\s\S]*?getState:\s*\(\) => state/);
  assert.match(app, /applySnapshot:\s*applyLocalBattleSnapshot/);
  assert.match(app, /pauseAudio:\s*\(\) => audio\.pauseForLifecycle\(\)/);
  assert.match(app, /resumeAudio:\s*\(\) => audio\.resumeForLifecycle\(state\.audioEnabled, state\.screen === "menu"\)/);
  assert.match(app, /startMobileAppServices\(\{[\s\S]*?startRuntime:\s*\(\) => mobileRuntime\.start\(\)/);
  assert.match(mobileSupport, /export function startMobileAppServices/);
});

test("preferences and secure auth hydrate asynchronously through the platform", () => {
  const hydration = sourceBetween("function hydratePlatformPreferences", "function hydrateSecureSession");
  for (const key of ["language", "theme", "visualStyle", "audio", "haptics", "trainingProgress"]) {
    assert.match(hydration, new RegExp(`preferenceCoordinator\\.hydrate\\("${key}"`));
  }
  assert.match(hydration, /Array\.isArray\(trainingProgress\)/);
  assert.match(app, /createPreferenceCoordinator\(\{[\s\S]*?settings:\s*platform\.settings/);
  assert.match(app, /createSecureSessionCoordinator\(\{[\s\S]*?secureSession:\s*platform\.secureSession/);
  assert.match(app, /preferenceCoordinator\.write\("language", state\.language\)/);
  assert.match(app, /preferenceCoordinator\.write\("theme", state\.theme\)/);
  assert.match(app, /preferenceCoordinator\.write\("visualStyle", state\.visualStyle\)/);
  assert.match(app, /preferenceCoordinator\.write\("audio", state\.audioEnabled \? "on" : "off"\)/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|removeItem)\([^\n]*(?:authToken|salvo\.authToken)/);
  const visualStyleInitializer = sourceBetween("function getInitialVisualStyle", "function getInitialAudioEnabled");
  const languageStart = i18n.indexOf("export function getInitialLanguage");
  const languageEnd = i18n.indexOf("export function t", languageStart);
  assert.doesNotMatch(visualStyleInitializer.replaceAll(/\/\/.*$/gm, ""), /localStorage\.getItem/);
  assert.doesNotMatch(i18n.slice(languageStart, languageEnd), /localStorage\.getItem/);
  assert.match(mobileSupport, /secureSession\.get\(\)/);
  assert.match(mobileSupport, /secureSession\.set\(token\)/);
  assert.match(mobileSupport, /secureSession\.clear\(\)/);
  assert.match(app, /await secureSessionCoordinator\.establish\([\s\S]*?isCurrent:/);
  assert.match(app, /await secureSessionCoordinator\.invalidate\(/);
  assert.match(app, /auth\.secureStorageFailed/);
  assert.match(app, /state\.auth\.method === "oidc"/);
  assert.match(app, /platform\.getPlatform\(\) === "android"/);
  assert.match(app, /translate\("auth\.unavailable"\)/);
  assert.doesNotMatch(app, /auth\.mobileSecureLoginPending/);
});

test("restores only normalized local battle fields and reports recoverable restore errors", () => {
  const restore = sourceBetween("function applyLocalBattleSnapshot", "function handleLocalBattleRestoreError");
  for (const field of [
    "screen",
    "mode",
    "presetId",
    "setupPlayerId",
    "setupBoard",
    "setupOrientation",
    "setupSelectedShipId",
    "boards",
    "game",
    "battleTab",
    "agentDifficulty",
    "passPlayerId",
    "training",
  ]) {
    assert.match(restore, new RegExp(`state\\.${field} = snapshot\\.${field}`));
  }
  assert.doesNotMatch(restore, /Object\.assign|\.\.\.snapshot/);
  assert.match(restore, /state\.setupHover = null/);
  assert.match(restore, /state\.setupError = ""/);
  assert.match(restore, /state\.restoredBattle = true/);
  assert.match(restore, /state\.leaveBattleDialog = false/);
  assert.match(app, /error instanceof UnsupportedLocalBattleSnapshotVersionError/);
  assert.match(app, /"restore\.unsupportedVersion"/);
  assert.match(app, /"restore\.failed"/);
  assert.match(app, /class="restore-banner/);
  assert.match(app, /data-action="dismiss-restore-notice"/);
});

test("network state renders an offline banner and guards remote work", () => {
  assert.match(app, /network:\s*createUnknownNetworkState\(\)/);
  assert.match(app, /function handleNetwork\(status\)/);
  assert.match(app, /state\.network = networkStateFromSample\(status\)/);
  assert.match(app, /hasConfirmedNetworkConnection\(state\.network\)/);
  assert.match(app, /state\.network\.confirmed && !state\.network\.connected/);
  assert.match(app, /class="offline-banner" role="status"/);
  assert.match(app, /translate\("network\.offline"\)/);
  assert.match(app, /function requireOnline/);
  for (const functionName of [
    "onlineCreate",
    "onlineJoin",
    "onlineRematch",
    "handleOnlineShot",
    "handleTelegramAuth",
    "startTelegramOidc",
    "loadTelegramAuthCapability",
    "refreshAuth",
    "logoutAuth",
    "loadReplayArchive",
    "loadArchivedReplay",
    "refreshProfile",
    "recordCompletedBattle",
    "refreshLeaderboard",
  ]) {
    const start = app.indexOf(`function ${functionName}`) >= 0
      ? `function ${functionName}`
      : `async function ${functionName}`;
    const section = sourceFunction(start);
    assert.match(section, /requireOnline\(/, `${functionName} must guard network work`);
  }
  const telegramWidget = sourceBetween("function mountTelegramLoginWidget", "function isTelegramLoginOriginAllowed");
  const offlineGuard = telegramWidget.indexOf("navigator.onLine === false");
  const scriptRequest = telegramWidget.indexOf('document.createElement("script")');
  assert.ok(offlineGuard >= 0 && offlineGuard < scriptRequest, "Telegram widget must stop before its offline script request");
});

test("platform back navigation uses ordered dialogs, overlays, and destructive leave", () => {
  const back = sourceBetween("async function handlePlatformBack", "async function requestLeaveBattle");
  const leaveDialog = back.indexOf("state.leaveBattleDialog");
  const resultDialog = back.indexOf("isResultModalVisible()");
  const settings = back.indexOf("state.settingsOpen");
  const profile = back.indexOf("state.profileOpen");
  const leaderboard = back.indexOf("state.leaderboardOpen");
  const coaching = back.indexOf("isTacticalAdvisorVisible()");
  const replay = back.indexOf('state.screen === "replay"');
  const archive = back.indexOf('state.screen === "archive"');
  const battle = back.indexOf('["setup", "playing", "pass", "training", "online"]');
  assert.ok(
    leaveDialog >= 0
    && leaveDialog < resultDialog
    && resultDialog < settings
    && settings < profile
    && profile < leaderboard
    && leaderboard < coaching
    && coaching < replay
    && replay < archive
    && archive < battle,
  );
  assert.match(back, /cancelLeaveBattle\(\)/);
  assert.match(back, /closeResultModal\(\)/);
  assert.match(back, /backToReplayArchive\(\)/);
  assert.match(back, /return false/);
  assert.match(app, /leaveBattleDialog:\s*false/);
  assert.match(app, /function renderLeaveBattleDialog/);
  assert.match(app, /role="dialog" aria-modal="true"/);
  assert.match(app, /aria-labelledby="leave-battle-title"/);
  assert.match(app, /aria-describedby="leave-battle-body"/);
  assert.match(app, /data-action="cancel-leave-battle"/);
  assert.match(app, /data-action="confirm-leave-battle"/);
  assert.match(app, /translate\("nav\.leaveBattleTitle"\)/);
  assert.match(app, /translate\("nav\.leaveBattleBody"\)/);
  assert.match(app, /createDialogFocusController\(\{[\s\S]*?dialogSelector:\s*'\[data-dialog="leave-battle"\]'/);
  assert.match(app, /data-dialog="leave-battle"/);
  assert.match(app, /data-dialog-background/);
  assert.match(app, /leaveDialogFocus\.captureReturnFocus\(\)/);
  assert.match(app, /leaveDialogFocus\.restoreFocus\(/);
  assert.match(app, /discardLocalBattle:\s*\(transition\) => localBattleSnapshots\.discard\(transition\)/);
});

test("menu, archive, replay, and history routes use the guarded app transition", () => {
  assert.match(app, /createAppNavigationCoordinator\(\{/);
  assert.match(app, /shouldDiscardLocalBattle:\s*hasLocalBattleSnapshotContext/);
  assert.match(app, /resetOnline:\s*resetOnlineConnectionState/);
  for (const functionName of ["goToMenu", "openReplayArchive", "openArchivedReplay", "handleReplayPopState"]) {
    const section = sourceFunction(`async function ${functionName}`);
    assert.match(section, /appNavigation\.run\(/, `${functionName} must guard route changes`);
  }
});

test("deep links fail closed while routing sanitized room and replay targets", () => {
  const deepLinks = sourceBetween("async function handlePlatformDeepLink", "async function goToMenu");
  assert.match(deepLinks, /parseSalvoDeepLink\(rawUrl\)/);
  assert.match(deepLinks, /route\.type === "auth"/);
  assert.match(deepLinks, /route\.type === "authError"/);
  assert.ok(
    deepLinks.indexOf('route.type === "auth"') < deepLinks.indexOf("requestLeaveBattle"),
    "auth callbacks must be handled before destructive navigation",
  );
  assert.match(deepLinks, /showOnline\(\)/);
  assert.match(deepLinks, /state\.online\.roomCodeInput = route\.roomCode/);
  assert.match(deepLinks, /await openArchivedReplay\(route\.replayId/);
  assert.match(mobileSupport, /canonicalDeepLinkOrigin/);
  assert.match(mobileSupport, /url\.protocol !== "https:"/);
  assert.match(mobileSupport, /url\.username \|\| url\.password/);
});

test("online operations use latest-client generations and auth resets active rooms", () => {
  assert.match(app, /createLatestClientCoordinator\(\{/);
  assert.match(app, /onlineClientCoordinator\.run\(\{/);
  assert.match(app, /onlineClientCoordinator\.close\(\)/);
  assert.match(app, /function resetOnlineConnectionState/);
  const establish = sourceBetween("async function establishAuthSession", "async function invalidateAuthSession");
  const invalidate = sourceBetween("async function invalidateAuthSession", "function authOperationIsCurrent");
  assert.match(establish, /resetOnlineConnectionState\(\)/);
  assert.match(establish, /isCurrent/);
  assert.match(invalidate, /resetOnlineConnectionState\(\)/);
  assert.match(mobileSupport, /guardHandlers/);
});

test("room and summary sharing await platform share with Telegram fallback", () => {
  assert.match(app, /async function shareRoom/);
  assert.match(app, /async function shareBattleSummary/);
  assert.match(app, /const result = await platform\.share\(\{/);
  assert.match(app, /if \(result\.shared\) return \{ shared: true, copied: false \}/);
  assert.match(app, /if \(result\.copied\) return \{ shared: false, copied: true \}/);
  assert.match(app, /await platform\.openExternalUrl\(telegramUrl\.toString\(\)\)/);
  assert.match(app, /translate\("share\.failed"\)/);
  assert.match(app, /state\.online\.shareStatus = outcome\.copied \? "invite-copied" : ""/);
  assert.doesNotMatch(sourceBetween("async function shareRoom", "async function shareWithTelegramFallback"), /state\.online\.status/);
  assert.match(app, /state\.online\.error = succeeded \? "" : translate\("share\.failed"\)/);
  assert.match(i18n, /"online\.inviteCopied"/);
  assert.match(app, /if \(action === "share-battle-summary"\) await shareBattleSummary\(\)/);
  assert.match(app, /if \(action === "share-telegram"\) await shareRoom\(\)/);
});

test("haptics are independently configured and mapped to gameplay outcomes", () => {
  assert.match(app, /hapticsEnabled:\s*platform\.isNative\(\)/);
  assert.match(app, /data-action="haptics-toggle"/);
  assert.match(app, /function toggleHaptics/);
  assert.match(app, /preferenceCoordinator\.write\("haptics", state\.hapticsEnabled \? "on" : "off"\)/);
  assert.match(app, /function playHaptic\(event\)/);
  assert.match(app, /platform\.haptic\(event\)/);
  for (const event of ["placement", "invalid", "hit", "sunk", "victory", "defeat"]) {
    assert.match(app, new RegExp(`playHaptic\\("${event}"\\)`));
  }
  const outcomes = sourceBetween("function playShotOutcome", "function playFinalSound");
  assert.doesNotMatch(outcomes, /playHaptic\("miss"\)/);
});

test("mobile layout applies safe areas, compact banners, and fluid battle boards", () => {
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1\.0, viewport-fit=cover"\s*\/>/);
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(css, new RegExp(`--safe-${side}:\\s*var\\(--safe-area-inset-${side},\\s*env\\(safe-area-inset-${side},\\s*0px\\)\\)`));
  }
  assert.match(cssRule(".shell"), /var\(--safe-top\)/);
  assert.match(cssRule(".shell"), /var\(--safe-right\)/);
  assert.match(cssRule(".shell"), /var\(--safe-left\)/);
  assert.match(css, /\.offline-banner/);
  assert.match(css, /\.restore-banner/);
  assert.match(css, /:root\[data-theme="dark"\] \.offline-banner/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?button,[\s\S]*?select,[\s\S]*?input,[\s\S]*?\{[\s\S]*?min-height:\s*44px/);
  for (const selector of [
    ".ghost-button",
    ".orientation-button",
    ".ship-choice",
    ".tactical-advisor-toggle",
    ".tactical-advisor-compact-toggle",
    ".tactical-quick-fire",
    ".priority-target-chip",
    ".battle-coaching .training-link",
    ".battle-tabs button",
  ]) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(css, new RegExp(`@media \\(max-width: 720px\\)[\\s\\S]*?${escapedSelector}[\\s\\S]*?min-height:\\s*44px`));
  }
  assert.match(app, /class="board-scroll"/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.board-scroll\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.coordinate-board\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.column-headers,[\s\S]*?\.board-grid\s*\{[\s\S]*?minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.row-headers\s*\{[\s\S]*?minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.cell\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?min-height:\s*0/);
  assert.match(css, /\.setup-primary-actions[\s\S]*?var\(--safe-bottom\)/);
  assert.match(cssRule(".result-actions"), /var\(--safe-bottom\)/);
  assert.match(cssRule(".modal-backdrop"), /var\(--safe-bottom\)/);
});

function combinedCssRule(...selectors) {
  const escapedSelectors = selectors.map((selector) =>
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(`${escapedSelectors.join("\\s*,\\s*")}\\s*\\{([\\s\\S]*?)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `Missing CSS rule: ${selectors.join(", ")}`);
  return match[1];
}

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

function sourceBetween(start, end) {
  const startIndex = app.indexOf(start);
  const endIndex = app.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source start: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source end: ${end}`);
  return app.slice(startIndex, endIndex);
}

function sourceFunction(start) {
  const startIndex = app.indexOf(start);
  assert.ok(startIndex >= 0, `Missing function source: ${start}`);
  const nextFunction = app.indexOf("\nfunction ", startIndex + start.length);
  const nextAsyncFunction = app.indexOf("\nasync function ", startIndex + start.length);
  const candidates = [nextFunction, nextAsyncFunction].filter((index) => index > startIndex);
  const endIndex = candidates.length ? Math.min(...candidates) : app.length;
  return app.slice(startIndex, endIndex);
}
