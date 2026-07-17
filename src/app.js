import { chooseAgentShot } from "./core/ai.js";
import { assetUrl } from "./asset-url.js";
import { createAudioController } from "./audio.js";
import {
  createLocalBattleSnapshotStore,
  UnsupportedLocalBattleSnapshotVersionError,
} from "./core/local-battle-snapshot.js";
import {
  createBoard,
  createGameFromBoards,
  fireAt,
  getCell,
  hasCompleteSetup,
  placeMarker,
  placeShip,
  publicBoardView,
  randomlyPlaceSetup,
  removeMarker,
  removeShip,
} from "./core/game.js";
import { visibleBattleLog } from "./core/log.js";
import { gamePresets, getGamePreset } from "./core/presets.js";
import {
  advanceReplayTurn,
  archiveReplayId,
  archiveRetryOptions,
  archivedReplayFrame,
  archivedReplayBoardMinWidth,
  authRequestIsCurrent,
  createReplayClock,
  nextReplaySpeedIndex,
  normalizeReplayTurn,
  replayIdFromSearch,
  replayMomentTurn,
  replayRequestIsCurrent,
  replaySpeeds,
  replayUrlForId,
  startReplayTurn,
} from "./core/replay.js";
import { battleMomentum, buildBattleReport, fleetIntel, summarizeBattleLog, targetIntel } from "./core/stats.js";
import { analyzeTargetBoard } from "./core/tactics.js";
import {
  applyTrainingShot,
  createTrainingSession,
  trainingScenarios,
  trainingScenarioForDrill,
  trainingProgramSummary,
  trainingSummary,
  updateTrainingProgress,
} from "./core/training.js";
import { coordinateColumnLabel, getInitialLanguage, languages, t } from "./i18n.js";
import {
  createAppNavigationCoordinator,
  createDiscardableSnapshotStore,
  createDialogFocusController,
  createLatestClientCoordinator,
  createPreferenceCoordinator,
  createSecureSessionCoordinator,
  createUnknownNetworkState,
  captureTelegramAuthBootstrap,
  hasConfirmedNetworkConnection,
  networkStateFromSample,
  parseSalvoDeepLink,
  startMobileAppServices,
} from "./mobile-app-support.js";
import { createMobileRuntime } from "./mobile.js";
import { platform } from "./platform/index.js";
import { RemoteClient } from "./remote.js";
import { createTelegramAuthClient } from "./telegram-auth.js";

export { assetUrl };
export { menuMusicTracks } from "./core/audio.js";

export function bootSalvoApp({
  document: appDocument = globalThis.document,
  window: appWindow = globalThis.window,
  navigator: appNavigator = globalThis.navigator,
  platform: appPlatform = platform,
  audio: appAudio = createAudioController(),
  fetch: appFetch = globalThis.fetch,
  createRemoteClient = (handlers) => new RemoteClient(handlers),
} = {}) {
const document = appDocument;
const window = appWindow;
const navigator = appNavigator;
const platform = appPlatform;
const audio = appAudio;
const fetch = appFetch;
const telegramAuthBootstrap = platform.isNative()
  ? { type: "none" }
  : captureTelegramAuthBootstrap({ rawUrl: window.location.href, history: window.history });
const root = document.querySelector("#app");
if (!root) throw new Error("Salvo app root was not found");
const trainingProgressSettingKey = "trainingProgress";
const authConsentSettingKey = "authConsentV1";
const canonicalReplayBaseUrl = "https://agent-axiom.github.io/agents-salvo/";
const canonicalPrivacyUrl = `${canonicalReplayBaseUrl}privacy.html`;
const resultReplayClock = createReplayClock({
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (handle) => window.clearInterval(handle),
});
let telegramWidgetScheduled = false;
let platformHydrationRenderScheduled = false;
let leaveDialogReturnFocus = null;
let pendingLeaveTransition = null;
const initialRequestedReplayId = replayIdFromSearch(window.location.search);
let authEpoch = 0;
let authCallbacksBlocked = false;
let activeAuthTicket = null;
let capabilityGeneration = 0;
let capabilityController = null;
const privateRequestControllers = {
  auth: null,
  profile: null,
  archive: null,
  replay: null,
  saves: new Set(),
};

const state = {
  language: getInitialLanguage(),
  theme: getInitialTheme(),
  visualStyle: getInitialVisualStyle(),
  audioEnabled: getInitialAudioEnabled(),
  hapticsEnabled: platform.isNative(),
  audioUnlocked: false,
  settingsOpen: false,
  profileOpen: false,
  leaderboardOpen: false,
  leaveBattleDialog: false,
  restoredBattle: false,
  restoreError: "",
  network: createUnknownNetworkState(),
  screen: initialRequestedReplayId ? "replay" : "menu",
  mode: null,
  presetId: "classic",
  setupPlayerId: "p1",
  setupBoard: randomlyPlaceSetup(getGamePreset("classic")),
  setupOrientation: "horizontal",
  setupSelectedShipId: "",
  setupHover: null,
  setupError: "",
  boards: { p1: null, p2: null },
  game: null,
  battleTab: "target",
  tacticalAdvisorOpen: true,
  agentDifficulty: "normal",
  passPlayerId: null,
  resultModalDismissed: null,
  resultCopyStatus: "",
  resultReplayTurn: null,
  resultReplayPlaying: false,
  resultReplaySpeedIndex: 0,
  auth: {
    workerUrl: window.SALVO_CONFIG?.workerUrl || "",
    telegramBotUsername: window.SALVO_CONFIG?.telegramBotUsername || "",
    method: "unknown",
    consent: false,
    token: "",
    user: null,
    error: "",
    loading: false,
    opening: false,
  },
  profile: {
    data: null,
    loading: false,
    error: "",
    saveMessage: "",
    savedMatchKeys: new Set(),
  },
  leaderboard: {
    data: null,
    loading: false,
    error: "",
  },
  archive: {
    items: [],
    nextCursor: "",
    loading: false,
    error: "",
    retryAppend: false,
    retryCursor: "",
    retrying: false,
    requestId: 0,
  },
  replayArchive: {
    requestedId: initialRequestedReplayId,
    data: null,
    loading: false,
    error: "",
    tab: "own",
    copyStatus: "",
    openedFromArchive: false,
    requestId: 0,
  },
  online: {
    workerUrl: window.SALVO_CONFIG?.workerUrl || "",
    roomCodeInput: "",
    status: "",
    error: "",
    session: null,
    snapshot: null,
    client: null,
  },
  training: {
    scenarioId: "checkerboard",
    session: null,
    progress: {},
  },
};

let telegramAuthClient = null;
if (state.auth.workerUrl) {
  try {
    telegramAuthClient = createTelegramAuthClient({
      workerUrl: state.auth.workerUrl,
      fetcher: fetch,
    });
  } catch {
    telegramAuthClient = null;
  }
}

const preferenceCoordinator = createPreferenceCoordinator({
  settings: platform.settings,
  onError: reportRuntimeError,
});
const secureSessionCoordinator = createSecureSessionCoordinator({
  // The web adapter owns compatibility with the legacy "salvo.authToken" key.
  secureSession: platform.secureSession,
});
const localBattleSnapshots = createDiscardableSnapshotStore(
  createLocalBattleSnapshotStore(platform.settings),
);
const onlineClientCoordinator = createLatestClientCoordinator({
  createClient: createRemoteClient,
  onChange(client) {
    state.online.client = client;
  },
});
const appNavigation = createAppNavigationCoordinator({
  shouldDiscardLocalBattle: hasLocalBattleSnapshotContext,
  discardLocalBattle: (transition) => localBattleSnapshots.discard(transition),
  resetOnline: resetOnlineConnectionState,
  onError: reportRuntimeError,
});
const leaveDialogFocus = createDialogFocusController({
  root,
  document,
  dialogSelector: '[data-dialog="leave-battle"]',
  onCancel: cancelLeaveBattle,
});
const mobileRuntime = createMobileRuntime({
  platform,
  snapshots: localBattleSnapshots,
  getState: () => state,
  applySnapshot: applyLocalBattleSnapshot,
  onRestoreError: handleLocalBattleRestoreError,
  onNetwork: handleNetwork,
  onDeepLink: handlePlatformDeepLink,
  onBack: handlePlatformBack,
  pauseAudio: () => audio.pauseForLifecycle(),
  resumeAudio: () => audio.resumeForLifecycle(state.audioEnabled, state.screen === "menu"),
  onRuntimeError: reportRuntimeError,
});

function getInitialTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialVisualStyle() {
  // The legacy first paint used localStorage.getItem("salvo.visualStyle").
  return "render";
}

function getInitialAudioEnabled() {
  return true;
}

function hydratePlatformPreferences() {
  return Promise.all([
    preferenceCoordinator.hydrate("language", (language) => {
      if (languages.some(({ code }) => code === language)) {
        state.language = language;
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate("theme", (theme) => {
      if (["light", "dark"].includes(theme)) {
        state.theme = theme;
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate("visualStyle", (visualStyle) => {
      if (["classic", "render"].includes(visualStyle)) {
        state.visualStyle = visualStyle;
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate("audio", (audioSetting) => {
      if (["on", "off"].includes(audioSetting)) {
        state.audioEnabled = audioSetting === "on";
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate("haptics", (haptics) => {
      if (["on", "off"].includes(haptics)) {
        state.hapticsEnabled = haptics === "on";
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate("trainingProgress", (progress) => {
      let trainingProgress = null;
      try {
        trainingProgress = progress ? JSON.parse(progress) : null;
      } catch {
        trainingProgress = null;
      }
      if (trainingProgress && typeof trainingProgress === "object" && !Array.isArray(trainingProgress)) {
        state.training.progress = trainingProgress;
        schedulePlatformHydrationRender();
      }
    }),
    preferenceCoordinator.hydrate(authConsentSettingKey, (consent) => {
      if (consent === "accepted") {
        state.auth.consent = true;
        schedulePlatformHydrationRender();
      }
    }),
  ]);
}

function hydrateSecureSession() {
  return secureSessionCoordinator.hydrate((token) => {
    state.auth.token = token;
    render();
  });
}

function schedulePlatformHydrationRender() {
  if (platformHydrationRenderScheduled) return;
  platformHydrationRenderScheduled = true;
  queueMicrotask(() => {
    platformHydrationRenderScheduled = false;
    render();
  });
}

function applyLocalBattleSnapshot(snapshot) {
  closeRemote();
  abortPrivateRequest("archive");
  abortPrivateRequest("replay");
  state.screen = snapshot.screen;
  state.mode = snapshot.mode;
  state.presetId = snapshot.presetId;
  state.setupPlayerId = snapshot.setupPlayerId;
  state.setupBoard = snapshot.setupBoard;
  state.setupOrientation = snapshot.setupOrientation;
  state.setupSelectedShipId = snapshot.setupSelectedShipId;
  state.boards = snapshot.boards;
  state.game = snapshot.game;
  state.battleTab = snapshot.battleTab;
  state.agentDifficulty = snapshot.agentDifficulty;
  state.passPlayerId = snapshot.passPlayerId;
  state.training = snapshot.training;
  state.setupHover = null;
  state.setupError = "";
  state.settingsOpen = false;
  state.profileOpen = false;
  state.leaderboardOpen = false;
  state.leaveBattleDialog = false;
  state.online.roomCodeInput = "";
  state.online.error = "";
  state.online.status = "";
  state.resultModalDismissed = null;
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  clearPrivateReplayData();
  state.restoreError = "";
  state.restoredBattle = true;
  render();
}

function handleLocalBattleRestoreError(error) {
  state.restoredBattle = false;
  state.restoreError = error instanceof UnsupportedLocalBattleSnapshotVersionError
    ? "restore.unsupportedVersion"
    : "restore.failed";
  state.leaveBattleDialog = false;
  render();
}

function handleNetwork(status) {
  state.network = networkStateFromSample(status);
  render();
}

function requireOnline(onOffline) {
  if (hasConfirmedNetworkConnection(state.network)) return true;
  const message = `${translate("network.offline")} ${translate("network.retry")}`;
  onOffline?.(message);
  render();
  return false;
}

function startMobileApp() {
  const services = startMobileAppServices({
    startRuntime: () => mobileRuntime.start(),
    hydratePreferences: hydratePlatformPreferences,
    hydrateSecureSession,
    refreshAuth: telegramAuthBootstrap.type === "ticket" ? async () => {} : refreshAuth,
    refreshLeaderboard,
    onError: reportRuntimeError,
  });
  const capabilityReady = services.runtimeReady.then(loadTelegramAuthCapability);
  const bootstrapReady = Promise.all([
    services.runtimeReady,
    services.secureSessionReady,
    capabilityReady,
  ]).then(processTelegramAuthBootstrap);
  const done = Promise.all([services.done, capabilityReady, bootstrapReady]).then(() => undefined);
  return {
    ...services,
    capabilityReady,
    bootstrapReady,
    done,
  };
}

async function loadTelegramAuthCapability() {
  const generation = ++capabilityGeneration;
  capabilityController?.abort();
  capabilityController = null;

  if (!telegramAuthClient || !requireOnline()) {
    if (generation !== capabilityGeneration) return;
    state.auth.method = "unavailable";
    if (!state.auth.user) state.auth.error = translate("auth.unavailable");
    render();
    return;
  }

  const controller = new AbortController();
  capabilityController = controller;
  try {
    const capability = await telegramAuthClient.capability({ signal: controller.signal });
    if (generation !== capabilityGeneration || controller.signal.aborted) return;
    state.auth.method = capability.method;
    if (!state.auth.user && !state.auth.loading) state.auth.error = "";
    render();
  } catch {
    if (generation !== capabilityGeneration || controller.signal.aborted) return;
    state.auth.method = "unavailable";
    if (!state.auth.user) state.auth.error = translate("auth.unavailable");
    render();
  } finally {
    if (capabilityGeneration === generation && capabilityController === controller) {
      capabilityController = null;
    }
  }
}

async function processTelegramAuthBootstrap() {
  if (telegramAuthBootstrap.type === "ticket") {
    return redeemTelegramTicket(telegramAuthBootstrap.ticket);
  }
  if (telegramAuthBootstrap.type === "authError") {
    return cancelTelegramAuth();
  }
  return false;
}

function reportRuntimeError(error) {
  console.error("Salvo mobile runtime error", error);
}

function observePlatformWrite(operation) {
  void Promise.resolve(operation).catch(reportRuntimeError);
}

function translate(key, params) {
  return t(state.language, key, params);
}

function localPlayerName() {
  const name = state.auth.user?.name?.trim();
  if (name) {
    return escapeHtml(name);
  }
  const username = state.auth.user?.username?.trim();
  if (username) {
    return `@${escapeHtml(username)}`;
  }
  return translate("game.player1");
}

function playerName(playerId) {
  if (playerId === "p1") {
    return localPlayerName();
  }
  if (state.mode === "agent" && playerId === "p2") {
    return translate("game.agent");
  }
  return translate("game.player2");
}

function setupPlayerTitle(playerId) {
  if (playerId === "p1" && state.auth.user) {
    return localPlayerName();
  }
  return translate("setup.player", { player: playerId === "p1" ? "1" : "2" });
}

function isOnlineAuthReady() {
  return Boolean(
    !state.auth.loading
    && state.auth.user
    && state.auth.token
    && state.online.workerUrl
  );
}

function gameStatusText(game) {
  if (game.phase === "finished") {
    return translate("game.winner", { player: playerName(game.winnerId) });
  }
  if (game.rules?.salvo) {
    return translate("game.salvoTurn", {
      player: playerName(game.currentPlayerId),
      count: game.salvoRemaining,
    });
  }
  return translate("game.turn", { player: playerName(game.currentPlayerId) });
}

function localPerspectivePlayerId() {
  return state.mode === "agent" ? "p1" : state.game.currentPlayerId;
}

function render() {
  document.documentElement.lang = state.language;
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.visualStyle = state.visualStyle;
  root.innerHTML = `
    <main class="shell">
      <div class="app-content" data-dialog-background>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <h1>${translate("app.title")}</h1>
            <p>${translate("app.subtitle")}</p>
          </div>
        </div>
        <div class="topbar-controls compact-controls">
          ${renderTopbarProfile()}
          ${renderTopbarLeaderboard()}
          <button
            class="settings-button"
            data-action="toggle-settings"
            aria-expanded="${state.settingsOpen}"
            aria-label="${translate("settings.open")}"
          >
            <span aria-hidden="true">⚙</span>
            <strong>${translate("settings.title")}</strong>
          </button>
        </div>
        ${state.profileOpen ? renderProfilePopover() : ""}
        ${state.leaderboardOpen ? renderLeaderboardPopover() : ""}
        ${renderSettingsPanel()}
      </header>
      ${renderStatusBanners()}
      ${renderScreen()}
      </div>
      ${state.leaveBattleDialog ? renderLeaveBattleDialog() : ""}
    </main>
  `;
  if (state.leaveBattleDialog) {
    leaveDialogFocus.activate(leaveDialogReturnFocus);
  } else {
    leaveDialogFocus.deactivate();
  }
  mountTelegramLoginWidget();
  syncMenuMusic();
}

function renderStatusBanners() {
  return `
    ${
      state.network.confirmed && !state.network.connected
        ? `<div class="offline-banner" role="status">${translate("network.offline")} ${translate("network.retry")}</div>`
        : ""
    }
    ${
      state.restoredBattle
        ? `<div class="restore-banner" role="status">
            <span>${translate("restore.resumed")}</span>
            <button class="icon-button" data-action="dismiss-restore-notice" aria-label="${translate("settings.close")}">×</button>
          </div>`
        : ""
    }
    ${
      state.restoreError
        ? `<div class="restore-banner is-error" role="status">
            <span>${translate(state.restoreError)}</span>
            <button class="icon-button" data-action="dismiss-restore-notice" aria-label="${translate("settings.close")}">×</button>
          </div>`
        : ""
    }
  `;
}

function renderTopbarProfile() {
  if (!state.auth.user) {
    return `
      <button class="topbar-profile" data-action="toggle-settings">
        <span class="auth-avatar" aria-hidden="true">T</span>
        <span>
          <strong>${translate("auth.telegram")}</strong>
          <small>${translate("profile.compactAnonymous")}</small>
        </span>
      </button>
    `;
  }

  const profile = state.profile.data;
  const summary = profile?.summary;
  const rating = profile?.rating;
  return `
    <button
      class="topbar-profile"
      data-action="toggle-profile"
      aria-haspopup="dialog"
      aria-expanded="${state.profileOpen}"
      ${state.auth.loading ? "disabled" : ""}
    >
      ${renderAuthAvatar(state.auth.user)}
      <span>
        <strong>${escapeHtml(state.auth.user.name || translate("auth.telegram"))}</strong>
        <small>${translate("profile.compactStats", {
          wins: summary?.wins ?? 0,
          rating: rating?.onlineMatches ? rating.mmr : "—",
        })}</small>
      </span>
    </button>
  `;
}

function renderTopbarLeaderboard() {
  return `
    <button
      class="leaderboard-button"
      data-action="toggle-leaderboard"
      aria-haspopup="dialog"
      aria-expanded="${state.leaderboardOpen}"
      aria-label="${translate("leaderboard.title")}"
    >
      <span class="leaderboard-button-icon" aria-hidden="true"></span>
      <strong>${translate("profile.leaderboard")}</strong>
    </button>
  `;
}

function renderLeaderboardPopover() {
  return `
    <section class="leaderboard-popover" role="dialog" aria-label="${translate("leaderboard.title")}">
      <button class="icon-button leaderboard-popover-close" data-action="close-leaderboard" aria-label="${translate("settings.close")}">×</button>
      ${renderLeaderboardPanel()}
    </section>
  `;
}

function renderProfilePopover() {
  return `
    <section class="profile-popover" role="dialog" aria-label="${translate("profile.title")}">
      <button class="icon-button profile-popover-close" data-action="close-profile" aria-label="${translate("settings.close")}">×</button>
      ${renderProfilePanel()}
    </section>
  `;
}

function renderSettingsPanel() {
  const simplified = state.visualStyle === "classic";
  return `
    <section class="settings-panel ${state.settingsOpen ? "is-open" : ""}" ${state.settingsOpen ? "" : "hidden"}>
      <div class="settings-panel-header">
        <h2>${translate("settings.title")}</h2>
        <button class="icon-button" data-action="toggle-settings" aria-label="${translate("settings.close")}">×</button>
      </div>
      <div class="settings-row">
        <div>
          <strong>${translate("audio.label")}</strong>
          <span>${translate(state.audioEnabled ? "audio.on" : "audio.off")}</span>
        </div>
        <button
          class="audio-toggle ${state.audioEnabled ? "is-on" : ""}"
          data-action="audio-toggle"
          aria-pressed="${state.audioEnabled}"
          aria-label="${translate("audio.label")}: ${translate(state.audioEnabled ? "audio.on" : "audio.off")}"
        >
          <span class="audio-toggle-icon" aria-hidden="true">
            <span class="audio-toggle-slash"></span>
          </span>
          <strong>${translate(state.audioEnabled ? "audio.on" : "audio.off")}</strong>
        </button>
      </div>
      <div class="settings-row">
        <div>
          <strong>${translate("settings.haptics")}</strong>
          <span>${translate(state.hapticsEnabled ? "settings.on" : "settings.off")}</span>
        </div>
        <button
          class="haptics-toggle ${state.hapticsEnabled ? "is-on" : ""}"
          data-action="haptics-toggle"
          aria-pressed="${state.hapticsEnabled}"
          aria-label="${translate("settings.haptics")}: ${translate(state.hapticsEnabled ? "settings.on" : "settings.off")}"
        >
          <span aria-hidden="true">≋</span>
          <strong>${translate(state.hapticsEnabled ? "settings.on" : "settings.off")}</strong>
        </button>
      </div>
      <div class="settings-row">
        <div>
          <strong>${translate("theme.label")}</strong>
          <span>${translate(state.theme === "dark" ? "theme.dark" : "theme.light")}</span>
        </div>
        <button
          class="theme-toggle ${state.theme === "dark" ? "is-dark" : ""}"
          data-action="theme-toggle"
          aria-pressed="${state.theme === "dark"}"
          aria-label="${translate("theme.label")}: ${translate(state.theme === "dark" ? "theme.dark" : "theme.light")}"
        >
          <span class="theme-toggle-track" aria-hidden="true"><span></span></span>
          <strong>${translate(state.theme === "dark" ? "theme.dark" : "theme.light")}</strong>
        </button>
      </div>
      <div class="settings-row">
        <div>
          <strong>${translate("settings.simplifiedGraphics")}</strong>
          <span>${translate("settings.simplifiedGraphicsDesc")}</span>
        </div>
        <button
          class="visual-style-toggle ${simplified ? "" : "is-render"}"
          data-action="visual-style-toggle"
          aria-pressed="${simplified}"
          aria-label="${translate("settings.simplifiedGraphics")}: ${translate(simplified ? "settings.on" : "settings.off")}"
        >
          <span class="visual-style-toggle-icon" aria-hidden="true"></span>
          <strong>${translate(simplified ? "settings.on" : "settings.off")}</strong>
        </button>
      </div>
      <label class="settings-row language-control">
        <div>
          <strong>${translate("nav.language")}</strong>
          <span>${languages.find((language) => language.code === state.language)?.label ?? state.language}</span>
        </div>
        <select data-action="language">
          ${languages
            .map(
              (language) =>
                `<option value="${language.code}" ${language.code === state.language ? "selected" : ""}>${language.label}</option>`,
            )
            .join("")}
        </select>
      </label>
      ${renderAuthControl()}
    </section>
  `;
}

function renderAuthControl() {
  if (state.auth.user) {
    const user = state.auth.user;
    return `
      <div class="auth-control is-authenticated">
        <span>${translate("auth.label")}</span>
        <div class="auth-card">
          ${renderAuthAvatar(user)}
          <div class="auth-name">
            <strong>${escapeHtml(user.name || translate("auth.telegram"))}</strong>
            <small>${user.username ? `@${escapeHtml(user.username)}` : translate("auth.telegram")}</small>
          </div>
          <button class="icon-button auth-logout" data-action="auth-logout" aria-label="${translate("auth.logout")}" ${state.auth.loading ? "disabled" : ""}>×</button>
        </div>
        ${state.auth.loading ? `<small>${translate("auth.loading")}</small>` : ""}
        ${state.auth.error ? `<small class="auth-error">${translate("auth.error", { message: state.auth.error })}</small>` : ""}
      </div>
    `;
  }

  const oidcAvailable = state.auth.method === "oidc" && (
    !platform.isNative() || platform.getPlatform() === "android"
  );
  if (oidcAvailable) {
    return `
      <div class="auth-control">
        <span>${translate("auth.label")}</span>
        ${renderTelegramAuthConsent()}
        <button
          class="primary-button auth-oidc-button"
          data-action="auth-telegram-oidc"
          ${state.auth.loading || !state.auth.consent ? "disabled" : ""}
        >${translate(state.auth.opening ? "auth.openingTelegram" : "auth.signInTelegram")}</button>
        ${state.auth.loading ? `<small>${translate(state.auth.opening ? "auth.openingTelegram" : "auth.loading")}</small>` : ""}
        ${state.auth.error ? `<small class="auth-error">${escapeHtml(state.auth.error)}</small>` : ""}
        ${renderTelegramAuthNotices()}
      </div>
    `;
  }

  if (!platform.isNative() && state.auth.method === "legacy") {
    return `
      <div class="auth-control">
        <span>${translate("auth.label")}</span>
        ${renderTelegramAuthConsent()}
        ${state.auth.consent ? `<div id="telegram-login-slot" class="telegram-login-slot" aria-label="${translate("auth.telegram")}"></div>` : ""}
        ${state.auth.loading ? `<small>${translate("auth.loading")}</small>` : ""}
        ${state.auth.error ? `<small class="auth-error">${translate("auth.error", { message: state.auth.error })}</small>` : ""}
        ${renderTelegramAuthNotices()}
      </div>
    `;
  }

  return `
    <div class="auth-control">
      <span>${translate("auth.label")}</span>
      <p class="status-line auth-unavailable">${escapeHtml(state.auth.error || translate("auth.unavailable"))}</p>
      <button class="secondary-button auth-retry-button" data-action="auth-telegram-retry">${translate("auth.retry")}</button>
      ${renderTelegramAuthNotices()}
    </div>
  `;
}

function renderTelegramAuthNotices() {
  return `
    <small class="auth-value-notice">${translate("auth.valueNotice")}</small>
    <small class="auth-privacy">
      ${translate("auth.privacyNotice")}
      <a href="/agents-salvo/privacy.html" data-action="open-privacy" target="_blank" rel="noopener noreferrer">${translate("auth.privacyLink")}</a>.
    </small>
  `;
}

function renderTelegramAuthConsent() {
  return `
    <label class="auth-consent">
      <input type="checkbox" data-action="auth-consent" ${state.auth.consent ? "checked" : ""}>
      <span>${translate("auth.consent")}</span>
    </label>
  `;
}

function renderLeaveBattleDialog() {
  return `
    <div
      class="modal-backdrop leave-battle-backdrop"
      data-dialog="leave-battle"
      role="dialog" aria-modal="true"
      aria-labelledby="leave-battle-title"
      aria-describedby="leave-battle-body"
    >
      <section class="leave-battle-dialog">
        <h2 id="leave-battle-title">${translate("nav.leaveBattleTitle")}</h2>
        <p id="leave-battle-body">${translate("nav.leaveBattleBody")}</p>
        <div class="leave-battle-actions button-row">
          <button data-action="cancel-leave-battle">${translate("nav.cancel")}</button>
          <button class="primary-button" data-action="confirm-leave-battle">${translate(pendingLeaveTransition ? "game.continue" : "nav.mainMenu")}</button>
        </div>
      </section>
    </div>
  `;
}

function renderAuthAvatar(user) {
  if (user.photoUrl) {
    return `<img class="auth-avatar" src="${escapeHtml(user.photoUrl)}" alt="" referrerpolicy="no-referrer">`;
  }
  const letter = (user.name || user.username || "T").trim().slice(0, 1).toUpperCase();
  return `<span class="auth-avatar" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

function renderScreen() {
  if (state.screen === "archive") {
    return renderReplayArchive();
  }
  if (state.screen === "replay") {
    return renderArchivedReplay();
  }
  if (state.screen === "setup") {
    return renderSetup();
  }
  if (state.screen === "playing") {
    return renderGame();
  }
  if (state.screen === "pass") {
    return renderPass();
  }
  if (state.screen === "online") {
    return renderOnline();
  }
  if (state.screen === "training") {
    return renderTraining();
  }
  return renderMenu();
}

function renderMenu() {
  return `
    <section class="game-hub">
      <div class="hub-primary">
        <div class="section-heading">
          <span>${translate("nav.mode")}</span>
          <h2>${translate("mode.choose")}</h2>
          <p>${translate("hub.subtitle")}</p>
        </div>
        <div class="hub-actions">
          <button class="hub-cta primary-button" data-action="start-agent">
            <span class="mode-icon radar-icon" aria-hidden="true"></span>
            <strong>${translate("mode.agent")}</strong>
          </button>
          <button class="hub-cta" data-action="show-online">
            <span class="mode-icon signal-icon" aria-hidden="true"></span>
            <strong>${translate("mode.online")}</strong>
          </button>
          <button class="hub-cta" data-action="start-training">
            <span class="mode-icon target-icon" aria-hidden="true"></span>
            <strong>${translate("mode.training")}</strong>
          </button>
          <button class="hub-cta" data-action="start-hotseat">
            <span class="mode-icon ship-icon" aria-hidden="true"></span>
            <strong>${translate("mode.hotseat")}</strong>
          </button>
        </div>
        <details class="hub-rule-summary">
          <summary>
            <span>${translate("preset.title")}</span>
            <strong>${translate(`preset.${state.presetId}.name`)}</strong>
          </summary>
          ${renderPresetSelector()}
        </details>
        <details class="rules-panel">
          <summary>${translate("history.title")}</summary>
          <div class="history-panel">
            <span>${translate("history.kicker")}</span>
            <p>${translate("history.body")}</p>
            <p>${translate("history.body2")}</p>
            <a href="${translate("history.sourceUrl")}" target="_blank" rel="noreferrer">${translate("history.source")}</a>
          </div>
        </details>
      </div>
      <figure class="fleet-visual hub-art">
        <img src="${menuArtworkSource()}" alt="${translate("art.alt")}" loading="lazy" decoding="async">
      </figure>
    </section>
  `;
}

function renderReplayArchive() {
  const items = state.archive.items;
  return `
    <section class="archive-screen">
      <header class="archive-header">
        <div>
          <span>${translate("archive.kicker")}</span>
          <h2>${translate("archive.title")}</h2>
          <p>${translate("archive.subtitle")}</p>
        </div>
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
      </header>
      ${
        !state.auth.user
          ? `<div class="archive-state" role="status">
              <p>${translate("archive.signInRequired")}</p>
              <button class="primary-button" data-action="toggle-settings">${translate("archive.signIn")}</button>
            </div>`
          : ""
      }
      ${state.archive.loading && !items.length ? `<p class="archive-state" role="status">${translate("archive.loading")}</p>` : ""}
      ${
        state.auth.user && state.archive.error
          ? `<div class="archive-state is-error" role="alert">
              <p>${translate(state.archive.error)}</p>
              <button data-action="archive-retry">${translate("archive.retry")}</button>
            </div>`
          : ""
      }
      ${
        state.auth.user && !state.archive.loading && !state.archive.error && !items.length
          ? `<p class="archive-state">${translate("archive.empty")}</p>`
          : ""
      }
      ${
        items.length
          ? `<ol class="archive-list">
              ${items.map(renderArchiveRow).join("")}
            </ol>`
          : ""
      }
      ${
        state.archive.nextCursor && !state.archive.error
          ? `<button class="archive-load-more" data-action="archive-load-more" ${state.archive.loading ? "disabled" : ""}>${translate(
              state.archive.loading ? "archive.loadingMore" : "archive.loadMore",
            )}</button>`
          : ""
      }
      ${state.archive.loading && items.length ? `<p class="archive-page-status" role="status">${translate("archive.loadingMore")}</p>` : ""}
    </section>
  `;
}

function renderArchiveRow(item) {
  const replayId = archiveReplayId(item);
  const opponent =
    typeof item.opponent === "string" && item.opponent !== "online"
      ? item.opponent
      : translate("archive.unknownOpponent");
  const content = `
    <span class="archive-row-result">${translate(`profile.result.${item.result}`)}</span>
    <span class="archive-row-opponent">
      <small>${translate("archive.opponent")}</small>
      <strong class="archive-row-name">${escapeHtml(opponent)}</strong>
    </span>
    <span class="archive-row-battle">
      <strong>${archivedPresetName(item.presetId)}</strong>
      <small>${formatReplayDate(item.finishedAt)}</small>
    </span>
    <span class="archive-row-stat">
      <small>${translate("archive.accuracy")}</small>
      <strong>${Number(item.accuracy) || 0}%</strong>
    </span>
    <span class="archive-row-stat">
      <small>${translate("archive.shots")}</small>
      <strong>${Number(item.playerHits) || 0}/${Number(item.playerShots) || 0}</strong>
    </span>
  `;
  return `
    <li class="archive-row is-${item.result === "win" ? "win" : "loss"} ${replayId ? "has-replay" : "is-historical"}">
      ${
        replayId
          ? `<button data-action="open-replay" data-replay-id="${escapeHtml(replayId)}" data-replay-source="archive">
              ${content}
              <span class="archive-row-play" aria-hidden="true">▶</span>
            </button>`
          : `<div class="archive-row-content">
              ${content}
              <span class="archive-row-unavailable">${translate("archive.historicalUnavailable")}</span>
            </div>`
      }
    </li>
  `;
}

function renderArchivedReplay() {
  return `
    <section class="archived-replay-screen">
      <header class="archived-replay-header">
        <button class="ghost-button" data-action="replay-back">${translate("archive.back")}</button>
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
      </header>
      ${
        !state.auth.user
          ? `<div class="replay-archive-state" role="status">
              <h2>${translate("replayArchive.title")}</h2>
              <p>${translate("replayArchive.signInRequired")}</p>
              <button class="primary-button" data-action="toggle-settings">${translate("archive.signIn")}</button>
            </div>`
          : ""
      }
      ${state.replayArchive.loading ? `<p class="replay-archive-state" role="status">${translate("replayArchive.loading")}</p>` : ""}
      ${
        state.auth.user && state.replayArchive.error
          ? `<div class="replay-archive-state is-error" role="alert">
              <p>${translate(state.replayArchive.error)}</p>
              <button data-action="replay-retry">${translate("archive.retry")}</button>
            </div>`
          : ""
      }
      ${state.auth.user && state.replayArchive.data ? `<div class="archived-replay-content">${renderArchivedReplayContent()}</div>` : ""}
    </section>
  `;
}

function renderArchivedReplayContent() {
  const replay = state.replayArchive.data;
  const frame = archivedReplayFrame(replay, state.resultReplayTurn);
  const viewerPlayerId = replay.viewerPlayerId;
  if (!frame.totalTurns || (viewerPlayerId !== "p1" && viewerPlayerId !== "p2")) {
    return `<div class="replay-archive-state is-error" role="alert"><p>${translate("replayArchive.unavailable")}</p></div>`;
  }
  const opponentPlayerId = viewerPlayerId === "p1" ? "p2" : "p1";
  const ownName = archivedCaptainName(replay.players?.[viewerPlayerId]);
  const opponentName = archivedCaptainName(replay.players?.[opponentPlayerId]);
  const winnerName = archivedCaptainName(replay.players?.[replay.winnerId]);
  const entry = frame.activeEntry;
  const replaySpeed = currentResultReplaySpeed();
  const report = buildBattleReport(replay.log, replay.winnerId, viewerPlayerId);
  const ownSelected = state.replayArchive.tab === "own";
  const activeAnnouncement = entry
    ? translate("replayArchive.activeShot", {
        turn: frame.turn,
        total: frame.totalTurns,
        captain: archivedCaptainName(replay.players?.[entry.playerId]),
        result: translate(`shot.${entry.result}`),
        coordinate: formatCoordinate(entry.coordinate),
      })
    : "";
  return `
    <div class="archived-replay-summary">
      <div>
        <span>${translate("replayArchive.title")}</span>
        <h2>${ownName} <i aria-hidden="true">/</i> ${opponentName}</h2>
        <p>${translate("replayArchive.winner", { captain: winnerName })}</p>
      </div>
      <dl class="archived-replay-meta">
        <div><dt>${translate("replayArchive.preset")}</dt><dd>${archivedPresetName(replay.presetId)}</dd></div>
        <div><dt>${translate("replayArchive.date")}</dt><dd>${formatReplayDate(replay.finishedAt)}</dd></div>
        <div><dt>${translate("replay.timeline")}</dt><dd>${translate("replay.move", { turn: frame.turn, total: frame.totalTurns })}</dd></div>
      </dl>
      <button data-action="replay-copy-link">${translate("replayArchive.copyLink")}</button>
    </div>
    ${
      state.replayArchive.copyStatus
        ? `<p class="replay-copy-status ${state.replayArchive.copyStatus === "error" ? "is-error" : ""}" role="status">${translate(
            state.replayArchive.copyStatus === "copied" ? "replayArchive.copied" : "replayArchive.copyFailed",
          )}</p>`
        : ""
    }
    <div class="archived-replay-tabs" role="group" aria-label="${translate("replayArchive.captains")}">
      <button data-action="replay-tab" data-tab="own" aria-pressed="${ownSelected}" class="${ownSelected ? "is-selected" : ""}">${translate("replayArchive.ownBoard")}</button>
      <button data-action="replay-tab" data-tab="opponent" aria-pressed="${!ownSelected}" class="${!ownSelected ? "is-selected" : ""}">${translate("replayArchive.opponentBoard")}</button>
    </div>
    <div class="archived-replay-boards">
      <div
        class="replay-board-view is-own ${ownSelected ? "is-selected" : ""}"
        style="--replay-board-min-width: ${archivedReplayBoardMinWidth(frame.boards[viewerPlayerId].size)}px"
      >
        ${renderBoard(frame.boards[viewerPlayerId], {
          kind: "own",
          title: `${translate("replayArchive.ownBoard")} · ${ownName}`,
          disabled: true,
          highlightCoordinate: frame.activeTargetPlayerId === viewerPlayerId ? frame.activeCoordinate : null,
        })}
      </div>
      <div
        class="replay-board-view is-opponent ${!ownSelected ? "is-selected" : ""}"
        style="--replay-board-min-width: ${archivedReplayBoardMinWidth(frame.boards[opponentPlayerId].size)}px"
      >
        ${renderBoard(frame.boards[opponentPlayerId], {
          kind: "own",
          title: `${translate("replayArchive.opponentBoard")} · ${opponentName}`,
          disabled: true,
          highlightCoordinate: frame.activeTargetPlayerId === opponentPlayerId ? frame.activeCoordinate : null,
        })}
      </div>
    </div>
    <section class="archived-replay-timeline" aria-label="${translate("replay.timeline")}">
      <p class="archived-replay-live" aria-live="polite" aria-atomic="true">${activeAnnouncement}</p>
      <label>
        <span>${translate("replay.timeline")}</span>
        <input
          data-action="archived-replay-seek"
          type="range"
          min="1"
          max="${frame.totalTurns}"
          step="1"
          value="${frame.turn}"
          aria-label="${translate("replay.seek")}"
          aria-valuetext="${translate("replay.position", { turn: frame.turn, total: frame.totalTurns })}"
        >
      </label>
      ${renderArchivedReplayMoments(report.moments?.items ?? [], frame.totalTurns, frame.turn)}
      <div class="archived-replay-controls">
        <button class="primary-button" data-action="archived-replay-toggle-play">
          <span aria-hidden="true">${state.resultReplayPlaying ? "Ⅱ" : "▶"}</span>
          ${translate(state.resultReplayPlaying ? "replay.pause" : "replay.play")}
        </button>
        <button data-action="archived-replay-speed" aria-label="${translate("replay.speed", { speed: replaySpeed.label })}">${replaySpeed.label}</button>
        <button data-action="archived-replay-prev" ${frame.turn <= 1 ? "disabled" : ""}>← ${translate("replay.previous")}</button>
        <button data-action="archived-replay-next" ${frame.turn >= frame.totalTurns ? "disabled" : ""}>${translate("replay.next")} →</button>
      </div>
    </section>
  `;
}

function renderArchivedReplayMoments(moments, totalTurns, activeTurn) {
  const controls = moments
    .map((moment) => {
      const turn = replayMomentTurn(moment, totalTurns);
      if (!turn) return "";
      return `<button
        data-action="archived-replay-jump"
        data-turn="${turn}"
        class="${turn === activeTurn ? "is-selected" : ""}"
        ${turn === activeTurn ? 'aria-current="step"' : ""}
      >
        <span>${translate(`moments.${moment.id}`)}</span>
        <small>${translate("moments.turn", { turn })}</small>
      </button>`;
    })
    .filter(Boolean)
    .join("");
  return controls ? `<div class="archived-replay-moments">${controls}</div>` : "";
}

function archivedCaptainName(captain) {
  const name = typeof captain?.name === "string" ? captain.name.trim() : "";
  if (name) return escapeHtml(name);
  const username = typeof captain?.username === "string" ? captain.username.trim() : "";
  return username ? `@${escapeHtml(username)}` : translate("archive.unknownOpponent");
}

function archivedPresetName(presetId) {
  return Object.hasOwn(gamePresets, presetId) ? translate(`preset.${presetId}.name`) : "—";
}

function formatReplayDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(state.language, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function renderLeaderboardPanel() {
  const leaderboard = state.leaderboard.data ?? state.profile.data?.leaderboard;
  const entries = leaderboard?.entries ?? [];
  return `
    <section class="leaderboard-panel">
      <div class="leaderboard-panel-header">
        <div>
          <span>${translate("leaderboard.title")}</span>
          <p>${translate("leaderboard.subtitle")}</p>
        </div>
        <button data-action="refresh-leaderboard">${translate("leaderboard.refresh")}</button>
      </div>
      ${state.leaderboard.loading ? `<p class="status-line">${translate("leaderboard.loading")}</p>` : ""}
      ${state.leaderboard.error ? `<p class="error-line">${translate("leaderboard.error", { message: state.leaderboard.error })}</p>` : ""}
      ${
        entries.length === 0
          ? `<p>${translate("profile.noLeaderboard")}</p>`
          : `<ol>
              ${entries
                .slice(0, 5)
                .map(
                  (entry) => `
                    <li>
                      <strong>#${entry.rank}</strong>
                      <span>${escapeHtml(entry.name)}</span>
                      <small>${entry.rating} · ${entry.onlineWins}-${entry.onlineLosses}</small>
                    </li>
                  `,
                )
                .join("")}
            </ol>`
      }
    </section>
  `;
}

function renderProfilePanel() {
  if (!state.auth.user) {
    return `
      <section class="profile-panel">
        <div>
          <span>${translate("profile.title")}</span>
          <p>${translate("profile.loginPrompt")}</p>
        </div>
      </section>
    `;
  }

  const profile = state.profile.data;
  const summary = profile?.summary;
  const rating = profile?.rating;
  const season = profile?.season;
  return `
    <section class="profile-panel">
      <div class="profile-panel-header">
        <div>
          <span>${translate("profile.title")}</span>
          <h3>${escapeHtml(state.auth.user.name || translate("auth.telegram"))}</h3>
          <p>${translate("profile.subtitle")}</p>
        </div>
        <button
          class="icon-button"
          data-action="refresh-profile"
          aria-label="${translate("profile.refresh")}"
          title="${translate("profile.refresh")}"
        >↻</button>
      </div>
      ${state.profile.loading ? `<p class="status-line">${translate("auth.loading")}</p>` : ""}
      ${state.profile.error ? `<p class="error-line">${escapeHtml(state.profile.error)}</p>` : ""}
      ${state.profile.saveMessage ? `<p class="status-line">${escapeHtml(state.profile.saveMessage)}</p>` : ""}
      <button class="profile-archive-button" data-action="open-archive">
        <span aria-hidden="true">↺</span>
        <strong>${translate("archive.open")}</strong>
      </button>
      ${
        summary && summary.totalMatches > 0
          ? `
            <div class="profile-stats">
              ${renderProfileStat("profile.matches", summary.totalMatches)}
              ${renderProfileStat("profile.winRate", `${summary.winRate}%`)}
              ${renderProfileStat("profile.accuracy", `${summary.accuracy}%`)}
              ${renderProfileStat("profile.streak", summary.currentWinStreak)}
              ${renderProfileStat(
                "profile.bestMode",
                summary.bestMode ? translate(`mode.${summary.bestMode}`) : "—",
              )}
              ${renderProfileStat("profile.rating", rating?.onlineMatches ? rating.mmr : "—")}
              ${renderProfileStat(
                "profile.league",
                translate(`profile.ratingLabel.${rating?.label ?? "unrated"}`),
              )}
              ${renderProfileStat("profile.online", `${rating?.onlineWins ?? 0}-${rating?.onlineLosses ?? 0}`)}
              ${renderProfileStat("profile.season", season?.id ?? "—")}
              ${renderProfileStat("profile.seasonRecord", `${season?.wins ?? 0}-${season?.losses ?? 0}`)}
            </div>
            ${renderCompetitionProfile(profile.competition)}
            ${renderProfileAchievements(profile.achievements ?? [])}
            ${renderRecentMatches(profile.recentMatches ?? [])}
            ${renderLeaderboard(profile.leaderboard)}
          `
          : `<p>${translate("profile.empty")}</p>`
      }
    </section>
  `;
}

function renderCompetitionProfile(competition) {
  const rank = competition?.rank ?? {};
  const bestOfThree = competition?.bestOfThree ?? {};
  const history = competition?.ratingHistory ?? [];
  return `
    <div class="competition-card">
      <div class="competition-card-header">
        <div>
          <h4>${translate("competition.title")}</h4>
          <p>${translate("competition.subtitle")}</p>
        </div>
      </div>
      <div class="competition-stats">
        ${renderCompetitionStat("competition.globalRank", formatRank(rank.global, rank.totalPlayers))}
        ${renderCompetitionStat("competition.seasonRank", formatRank(rank.season, rank.seasonPlayers))}
        ${renderCompetitionStat(
          "competition.bestOfThree",
          translate("competition.seriesScore", {
            wins: bestOfThree.wins ?? 0,
            losses: bestOfThree.losses ?? 0,
          }),
        )}
      </div>
      <p class="competition-series">
        ${translate(`competition.seriesStatus.${bestOfThree.status ?? "none"}`, {
          opponent: bestOfThree.opponent || "—",
        })}
      </p>
      <div class="rating-history">
        <h4>${translate("competition.ratingHistory")}</h4>
        ${
          history.length
            ? `<ol>
                ${history
                  .map(
                    (entry) => `
                      <li class="${entry.delta >= 0 ? "is-positive" : "is-negative"}">
                        <strong>${signedNumber(entry.delta)}</strong>
                        <span>${escapeHtml(entry.opponent || "online")}</span>
                        <small>${translate("competition.ratingDelta", {
                          before: entry.before,
                          after: entry.after,
                        })}</small>
                      </li>
                    `,
                  )
                  .join("")}
              </ol>`
            : `<p>${translate("competition.noRatingHistory")}</p>`
        }
      </div>
    </div>
  `;
}

function renderCompetitionStat(key, value) {
  return `
    <div>
      <span>${translate(key)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function formatRank(rank, total) {
  return rank ? `#${rank} / ${total}` : translate("competition.noRank");
}

function signedNumber(value) {
  const number = Number(value);
  return number > 0 ? `+${number}` : String(number);
}

function renderProfileAchievements(achievements) {
  return `
    <div class="profile-achievements">
      <h4>${translate("profile.achievements")}</h4>
      ${
        achievements.length
          ? `<div class="achievement-list">
              ${achievements
                .map(
                  (achievement) => `
                    <article class="achievement-card">
                      <strong>${translate(`achievement.${achievement.id}.title`)}</strong>
                      <small>${translate("profile.achievementCount", { count: achievement.count })}</small>
                    </article>
                  `,
                )
                .join("")}
            </div>`
          : `<p>${translate("result.noAchievements")}</p>`
      }
    </div>
  `;
}

function renderProfileStat(key, value) {
  return `
    <div>
      <span>${translate(key)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderRecentMatches(matches) {
  return `
    <div class="profile-recent">
      <h4>${translate("profile.recent")}</h4>
      ${
        matches.length === 0
          ? `<p>${translate("profile.noMatches")}</p>`
          : `<ol>
              ${matches
                .map((match) => {
                  const replayId = archiveReplayId(match);
                  const historicalOnlineMatch = match.mode === "online" && !replayId;
                  return `
                    <li class="${replayId ? "has-replay" : historicalOnlineMatch ? "is-historical" : ""}">
                      <strong>${translate(`profile.result.${match.result}`)}</strong>
                      <span>${translate(`mode.${match.mode}`)} · ${translate(`preset.${match.presetId}.name`)}</span>
                      <small>${match.playerShots} / ${match.accuracy}%</small>
                      ${
                        replayId
                          ? `<button
                              class="icon-button recent-replay-button"
                              data-action="open-replay"
                              data-replay-id="${escapeHtml(replayId)}"
                              data-replay-source="recent"
                              aria-label="${translate("archive.watchReplay")}"
                              title="${translate("archive.watchReplay")}"
                            >▶</button>`
                          : historicalOnlineMatch
                            ? `<small class="historical-replay-unavailable">${translate("archive.historicalUnavailable")}</small>`
                            : ""
                      }
                    </li>
                  `;
                })
                .join("")}
            </ol>`
      }
    </div>
  `;
}

function renderLeaderboard(leaderboard) {
  const entries = leaderboard?.entries ?? [];
  return `
    <div class="profile-leaderboard">
      <h4>${translate("profile.leaderboard")}</h4>
      ${
        entries.length === 0
          ? `<p>${translate("profile.noLeaderboard")}</p>`
          : `<ol>
              ${entries
                .map(
                  (entry) => `
                    <li>
                      <strong>#${entry.rank}</strong>
                      <span>${escapeHtml(entry.name)}</span>
                      <small>${entry.rating} · ${entry.onlineWins}-${entry.onlineLosses}</small>
                    </li>
                  `,
                )
                .join("")}
            </ol>`
      }
    </div>
  `;
}

function menuArtworkSource() {
  if (state.visualStyle !== "render") {
    return assetUrl("./assets/salvo-board-action.png");
  }
  return state.theme === "dark"
    ? assetUrl("./assets/images/backgrounds/main-menu-hero-dark-no-ui.png")
    : assetUrl("./assets/images/backgrounds/main-menu-hero-no-ui.png");
}

function renderPresetSelector() {
  return `
    <section class="preset-selector">
      <div>
        <span>${translate("preset.title")}</span>
        <strong>${translate(`preset.${state.presetId}.name`)}</strong>
      </div>
      <div class="preset-grid">
        ${Object.values(gamePresets)
          .map((preset) => {
            const selected = preset.id === state.presetId ? "is-selected" : "";
            return `
              <button
                class="preset-button ${selected}"
                data-action="select-preset"
                data-preset-id="${preset.id}"
                aria-pressed="${preset.id === state.presetId}"
              >
                <strong>${translate(`preset.${preset.id}.name`)}</strong>
                <span>${translate(`preset.${preset.id}.desc`)}</span>
              </button>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderSetup() {
  const title =
    state.mode === "agent"
      ? translate("setup.agent")
      : setupPlayerTitle(state.setupPlayerId);
  const readyDisabled = hasFullFleet(state.setupBoard) ? "" : "disabled";

  return `
    <section class="play-layout setup-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("setup.title")}</span>
          <h2>${title}</h2>
          <p>${translate("setup.rulesHint")}</p>
        </div>
        <p class="status-line">${translate(`preset.${state.presetId}.name`)}</p>
        ${
          state.mode === "agent"
            ? `<label class="stacked-field">
                <span>${translate("agent.difficulty")}</span>
                <select data-action="agent-difficulty">
                  <option value="easy" ${state.agentDifficulty === "easy" ? "selected" : ""}>${translate("agent.easy")}</option>
                  <option value="normal" ${state.agentDifficulty === "normal" ? "selected" : ""}>${translate("agent.normal")}</option>
                  <option value="hard" ${state.agentDifficulty === "hard" ? "selected" : ""}>${translate("agent.hard")}</option>
                </select>
              </label>`
            : ""
        }
        <div class="setup-primary-actions">
          <button class="setup-action-card setup-action-random" data-action="randomize">${translate("setup.randomize")}</button>
          <button class="setup-action-card setup-action-reset" data-action="reset">${translate("setup.reset")}</button>
          <button class="setup-action-card setup-action-ready" data-action="ready" ${readyDisabled}>
            ${readyDisabled ? translate("setup.needFleet") : translate("setup.ready")}
          </button>
        </div>
        ${renderSetupProgress()}
        ${renderSetupTools()}
      </aside>
      <section class="board-stage">
        ${renderBoard(state.setupBoard, { kind: "setup", title })}
      </section>
    </section>
  `;
}

function renderSetupProgress() {
  const remainingPieces = setupPieces().filter((piece) => !isPiecePlaced(state.setupBoard, piece.id));
  return `
    <section class="setup-progress">
      <span>${translate("setup.remaining")}</span>
      ${
        remainingPieces.length === 0
          ? `<strong>${translate("setup.allPlaced")}</strong>`
          : `<div>${remainingPieces.map((piece) => `<small>${setupPieceLabel(piece)}</small>`).join("")}</div>`
      }
    </section>
  `;
}

function setupPieceLabel(piece) {
  if (piece.type) {
    return translate(`setup.${piece.type}`);
  }
  return translate("setup.selectShip", { length: piece.length });
}

function renderSetupTools() {
  const preset = currentPreset();
  const remainingPieces = setupPieces(preset).filter((piece) => !isPiecePlaced(state.setupBoard, piece.id));
  const orientationKey =
    state.setupOrientation === "horizontal" ? "setup.horizontal" : "setup.vertical";

  return `
    <section class="setup-tools">
      <div class="setup-tools-header">
        <span>${translate("setup.manual")}</span>
        <button
          class="orientation-button"
          data-action="rotate-setup"
          aria-label="${translate("setup.orientation")}: ${translate(orientationKey)}"
        >
          <span aria-hidden="true">${state.setupOrientation === "horizontal" ? "↔" : "↕"}</span>
          <strong>${translate(orientationKey)}</strong>
        </button>
      </div>
      <div class="ship-picker" aria-label="${translate("setup.manual")}">
        ${
          remainingPieces.length === 0
            ? `<p>${translate("setup.allPlaced")}</p>`
            : remainingPieces.map((piece) => renderShipChoice(piece)).join("")
        }
      </div>
      ${state.setupError ? `<p class="error-line">${translate(state.setupError)}</p>` : ""}
    </section>
  `;
}

function renderShipChoice(piece) {
  const selected = piece.id === state.setupSelectedShipId ? "is-selected" : "";
  if (piece.type) {
    return `
      <button
        class="ship-choice marker-choice ${selected}"
        data-action="select-setup-ship"
        data-ship-id="${piece.id}"
        aria-pressed="${piece.id === state.setupSelectedShipId}"
        aria-label="${translate(`setup.${piece.type}`)}"
      >
        <span class="marker-choice-icon ${piece.type}" aria-hidden="true">${piece.type === "mine" ? "!" : "^"}</span>
        <strong>${translate(`setup.${piece.type}`)}</strong>
      </button>
    `;
  }
  return `
    <button
      class="ship-choice ${selected}"
      data-action="select-setup-ship"
      data-ship-id="${piece.id}"
      aria-pressed="${piece.id === state.setupSelectedShipId}"
      aria-label="${translate("setup.selectShip", { length: piece.length })}"
    >
      <span class="ship-choice-cells" aria-hidden="true">
        ${Array.from({ length: piece.length }, () => "<span></span>").join("")}
      </span>
      <strong>${piece.length}</strong>
    </button>
  `;
}

function renderPass() {
  return `
    <section class="pass-screen">
      <div class="pass-panel">
        <span class="mode-icon ship-icon" aria-hidden="true"></span>
        <h2>${translate("game.passTitle")}</h2>
        <p>${translate("game.passBody", { player: playerName(state.passPlayerId) })}</p>
        <button class="primary-button" data-action="continue-pass">${translate("game.continue")}</button>
      </div>
    </section>
  `;
}

function renderGame() {
  const perspectivePlayerId = localPerspectivePlayerId();
  const opponentId = perspectivePlayerId === "p1" ? "p2" : "p1";
  const ownBoard = state.game.players[perspectivePlayerId].board;
  const targetBoard = state.game.players[opponentId].board;
  const status = gameStatusText(state.game);

  return `
    <section class="game-screen">
      <div class="battle-header">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div>
          <span>${translate(`preset.${state.presetId}.name`)}</span>
          <h2>${status}</h2>
        </div>
        <button class="secondary-button" data-action="new-game">${translate("game.restart")}</button>
      </div>
      <section class="board-stage">
        ${renderBattlefield({
          ownBoard,
          targetBoard,
          targetKind: "target",
          targetDisabled: state.game.phase === "finished",
          log: state.game.log,
          salvoRemaining: state.game.salvoRemaining,
          playerId: perspectivePlayerId,
        })}
      </section>
      ${renderLocalResultModal()}
    </section>
  `;
}

function renderTraining() {
  const session = state.training.session ?? createTrainingSession(state.training.scenarioId);
  const summary = trainingSummary(session);
  return `
    <section class="play-layout training-screen">
      <aside class="control-panel training-panel">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("mode.training")}</span>
          <h2>${translate("training.title")}</h2>
          <p>${translate("training.subtitle")}</p>
        </div>
        ${renderTrainingProgram()}
        <div class="training-score">
          ${renderTrainingStat("training.score", summary.score)}
          ${renderTrainingStat("training.shots", `${summary.shots}/${session.shotLimit}`)}
          ${renderTrainingStat("result.accuracy", `${summary.accuracy}%`)}
        </div>
        ${renderTrainingProgress(session.scenarioId)}
        ${renderTrainingScenarios(session.scenarioId)}
        ${renderTrainingResult(session, summary)}
        ${renderTrainingLog(session)}
      </aside>
      <section class="board-stage">
        ${renderBoard(session.board, {
          kind: "training-target",
          title: translate(`training.scenario.${session.scenarioId}.name`),
          disabled: session.phase !== "playing",
        })}
      </section>
    </section>
  `;
}

function renderTrainingProgram() {
  const program = trainingProgramSummary(state.training.progress);
  return `
    <section class="training-program">
      <div class="training-program-header">
        <span>${translate("training.program")}</span>
        <strong>${program.completed}/${program.target}</strong>
      </div>
      <div class="training-program-grid">
        ${renderTrainingStat("training.dailyGoal", `${program.completed}/${program.target}`)}
        ${renderTrainingStat("training.streak", program.streak)}
        ${renderTrainingStat("training.bestStreak", program.bestStreak)}
        ${renderTrainingStat("training.nextDrill", translate(`training.scenario.${program.nextScenarioId}.name`))}
      </div>
      <div class="training-awards" aria-label="${translate("training.awards")}">
        ${program.awards
          .map(
            (award) => `
              <span class="${award.earned ? "is-earned" : "is-locked"}">
                ${translate(`training.award.${award.id}`)}
              </span>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderTrainingProgress(scenarioId) {
  const progress = state.training.progress?.[scenarioId] ?? {};
  return `
    <section class="training-progress">
      <span>${translate("training.progress")}</span>
      <div>
        ${renderTrainingStat("training.completed", progress.completions ?? 0)}
        ${renderTrainingStat("training.bestScore", progress.bestScore ?? 0)}
        ${renderTrainingStat("training.bestAccuracy", `${progress.bestAccuracy ?? 0}%`)}
      </div>
    </section>
  `;
}

function renderTrainingStat(key, value) {
  return `
    <div>
      <span>${translate(key)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderTrainingScenarios(activeScenarioId) {
  return `
    <section class="training-scenarios">
      <span>${translate("training.choose")}</span>
      ${trainingScenarios
        .map(
          (scenario) => `
            <button
              class="training-card ${scenario.id === activeScenarioId ? "is-selected" : ""}"
              data-action="select-training-scenario"
              data-scenario-id="${scenario.id}"
              aria-pressed="${scenario.id === activeScenarioId}"
            >
              <strong>${translate(`training.scenario.${scenario.id}.name`)}</strong>
              <small>${translate(`training.scenario.${scenario.id}.desc`)}</small>
            </button>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderTrainingResult(session, summary) {
  if (session.phase !== "finished") {
    return "";
  }
  return `
    <section class="training-result">
      <span>${translate("training.resultTitle")}</span>
      <strong>${translate(`training.rating.${summary.ratingId}`)}</strong>
      <button class="primary-button" data-action="restart-training">${translate("training.restart")}</button>
    </section>
  `;
}

function renderTrainingLog(session) {
  return `
    <section class="training-log">
      <h3>${translate("log.title")}</h3>
      ${
        session.log.length === 0
          ? `<p>${translate("log.empty")}</p>`
          : `<ol>
              ${[...session.log]
                .reverse()
                .map(
                  (entry) => `
                    <li class="${entry.quality}">
                      <strong>${translate(`shot.${entry.result}`)}</strong>
                      <span>${coordinateColumnLabel(state.language, entry.coordinate.col)}${entry.coordinate.row + 1}</span>
                      <small>${translate(`training.feedback.${entry.feedbackId}`)}</small>
                    </li>
                  `,
                )
                .join("")}
            </ol>`
      }
    </section>
  `;
}

function renderOnline() {
  const snapshot = state.online.snapshot;
  if (state.online.session || snapshot) {
    return renderOnlineRoom(snapshot);
  }
  return renderOnlineLobby();
}

function renderOnlineLobby() {
  const onlineDisabled = isOnlineAuthReady() ? "" : "disabled";

  return `
    <section class="play-layout online-screen">
      <aside class="control-panel online-lobby">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("mode.online")}</span>
          <h2>${translate("online.title")}</h2>
          <p>${isOnlineAuthReady() ? translate("online.authReady") : translate("online.authHint")}</p>
        </div>
        <p class="status-line">${translate(`preset.${state.presetId}.name`)}</p>
        <div class="setup-primary-actions">
          <button class="setup-action-card setup-action-random" data-action="randomize">${translate("setup.randomize")}</button>
          <button class="setup-action-card setup-action-reset" data-action="reset">${translate("setup.reset")}</button>
        </div>
        ${renderSetupProgress()}
        ${renderSetupTools()}
        ${renderOnlineAuthGate()}
        <div class="online-actions">
          <button class="primary-button" data-action="online-create" ${onlineDisabled}>${translate("online.create")}</button>
          <label class="stacked-field">
            <span>${translate("online.roomCode")}</span>
            <input data-action="room-code" value="${escapeHtml(state.online.roomCodeInput)}" ${onlineDisabled} />
          </label>
          <button data-action="online-join" ${onlineDisabled}>${translate("online.join")}</button>
        </div>
        ${state.online.error ? `<p class="error-line">${translate("online.error", { message: state.online.error })}</p>` : ""}
      </aside>
      <section class="board-stage">
        ${renderBoard(state.setupBoard, { kind: "setup", title: translate("game.yourFleet") })}
      </section>
    </section>
  `;
}

function renderOnlineAuthGate() {
  if (isOnlineAuthReady()) {
    return "";
  }
  return `
    <div class="online-auth-gate">
      <p>${translate("online.authRequired")}</p>
      <button class="secondary-button" data-action="toggle-settings">${translate("auth.telegram")}</button>
    </div>
  `;
}

function renderOnlineRoom(snapshot) {
  const roomCode = state.online.session?.roomCode ?? snapshot?.roomCode ?? "";
  return `
    <section class="play-layout online-screen">
      <aside class="control-panel online-room">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("mode.online")}</span>
          <h2>${translate("online.title")}</h2>
        </div>
        ${roomCode ? `<p class="room-code">${escapeHtml(roomCode)}</p>` : ""}
        <div class="button-row">
          <button data-action="copy-room-code">${translate("online.copyCode")}</button>
          <button data-action="share-telegram">${translate("online.shareTelegram")}</button>
        </div>
        ${renderOnlineStatus(snapshot)}
        ${state.online.error ? `<p class="error-line">${translate("online.error", { message: state.online.error })}</p>` : ""}
      </aside>
      <section class="board-stage">
        ${snapshot ? renderOnlineSnapshot(snapshot) : renderBoard(state.setupBoard, { kind: "setup", title: translate("game.yourFleet") })}
      </section>
      ${renderOnlineResultModal(snapshot)}
    </section>
  `;
}

function renderOnlineSnapshot(snapshot) {
  const own = snapshot.you?.board ?? createBoard();
  const target = {
    size: snapshot.size ?? 10,
    ships: [],
    markers: [],
    shots: snapshot.opponentShots ?? [],
  };
  return renderBattlefield({
    ownBoard: own,
    targetBoard: target,
    targetKind: "online-target",
    targetDisabled: snapshot.phase !== "playing" || !snapshot.isYourTurn,
    log: snapshot.log ?? [],
    salvoRemaining: snapshot.salvoRemaining ?? 1,
    playerId: snapshot.playerId,
  });
}

function renderBattlefield({ ownBoard, targetBoard, targetKind, targetDisabled, log, salvoRemaining = 1, playerId = "p1" }) {
  const activeTab = state.battleTab || "target";
  const tacticalAnalysis = analyzeTargetBoard(targetBoard, { salvoRemaining });
  const targetAction = targetKind === "online-target" ? "online-shot" : "shot";
  return `
    <div class="battlefield target-first" data-active-tab="${activeTab}">
      <div class="battle-tabs" role="tablist" aria-label="${translate("battle.tabs")}">
        ${renderBattleTab("target", "game.target", activeTab)}
        ${renderBattleTab("own", "game.yourFleet", activeTab)}
        ${renderBattleTab("log", "log.title", activeTab)}
      </div>
      <div class="target-primary battle-tab-panel" data-panel="target">
        ${renderBattlePulse(log, { targetDisabled, salvoRemaining, tacticalAnalysis, playerId, ownBoard, targetBoard })}
        ${renderTacticalAdvisor(tacticalAnalysis, { disabled: targetDisabled, targetAction })}
        ${renderBoard(targetBoard, {
          kind: targetKind,
          title: translate("game.target"),
          disabled: targetDisabled,
          priorityTargets: tacticalAnalysis.priorityTargets,
        })}
      </div>
      <aside class="battle-side">
        <div class="own-minimap battle-tab-panel" data-panel="own">
          ${renderBoard(ownBoard, { kind: "own", title: translate("game.yourFleet") })}
        </div>
        <div class="battle-log-aside battle-tab-panel" data-panel="log">
          ${renderLog(log)}
        </div>
      </aside>
    </div>
  `;
}

function renderBattlePulse(
  log,
  {
    targetDisabled = false,
    salvoRemaining = 1,
    tacticalAnalysis = null,
    playerId = "p1",
    ownBoard = null,
    targetBoard = null,
  } = {},
) {
  const lastEntry = visibleBattleLog(log)[0];
  const metrics = renderBattlePulseMetrics({ targetDisabled, salvoRemaining, tacticalAnalysis });
  const liveStats = renderBattleLiveStats(log, playerId);
  const momentum = renderBattleMomentum(log, playerId);
  const fleet = renderFleetIntel(log, playerId, ownBoard);
  const target = renderTargetIntel(targetBoard);
  if (!lastEntry) {
    return `
      <section class="battle-pulse is-empty" aria-live="polite">
        <div>
          <span>${translate("battle.awaitingShot")}</span>
          <strong>${translate("battle.nextAction")}</strong>
        </div>
        ${metrics}
        ${liveStats}
        ${momentum}
        ${fleet}
        ${target}
      </section>
    `;
  }

  const nextAction =
    targetDisabled || salvoRemaining <= 1
      ? translate("battle.nextAction")
      : translate("game.salvoShots", { count: salvoRemaining });
  return `
    <section class="battle-pulse ${lastEntry.result}" aria-live="polite">
      <div>
        <span>${translate("battle.lastShot")}</span>
        <strong>${playerName(lastEntry.playerId)} · ${formatCoordinate(lastEntry.coordinate)}</strong>
      </div>
      <div class="battle-pulse-result ${lastEntry.result}">
        <i aria-hidden="true"></i>
        <strong>${translate(`shot.${lastEntry.result}`)}</strong>
      </div>
      <small>${nextAction}</small>
      ${metrics}
      ${liveStats}
      ${momentum}
      ${fleet}
      ${target}
    </section>
  `;
}

function renderBattlePulseMetrics({ targetDisabled, salvoRemaining, tacticalAnalysis }) {
  const priorityCount = tacticalAnalysis?.priorityTargets?.length ?? 0;
  return `
    <div class="battle-pulse-metrics" aria-label="${translate("battle.nextAction")}">
      <span>${translate(targetDisabled ? "battle.paused" : "battle.ready")}</span>
      <span>${translate("game.salvoShots", { count: salvoRemaining })}</span>
      <span>${translate("battle.priorityCount", { count: priorityCount })}</span>
    </div>
  `;
}

function renderBattleLiveStats(log, playerId) {
  const stats =
    summarizeBattleLog(log, playerId).players.find((candidate) => candidate.playerId === playerId) ?? {
      shots: 0,
      hits: 0,
      sunk: 0,
      accuracy: 0,
  };
  return `
    <div class="battle-live-stats" aria-label="${translate("battle.liveStats")}">
      <span>${translate("battle.accuracy")}: <strong>${stats.accuracy}%</strong></span>
      <span>${translate("battle.hits")}: <strong>${stats.hits}/${stats.shots}</strong></span>
      <span>${translate("battle.sunk")}: <strong>${stats.sunk}</strong></span>
    </div>
  `;
}

function renderFleetIntel(log, playerId, ownBoard) {
  const intel = fleetIntel(log, playerId, ownBoard);
  return `
    <div class="battle-fleet-intel" aria-label="${translate("battle.fleetIntel")}">
      <span>${translate("battle.enemySunk")}: <strong>${intel.enemySunk}</strong></span>
      <span>${translate("battle.ownAfloat")}: <strong>${intel.ownAfloat}/${intel.ownTotal}</strong></span>
    </div>
  `;
}

function renderTargetIntel(targetBoard) {
  const intel = targetIntel(targetBoard);
  return `
    <div class="battle-target-intel" aria-label="${translate("battle.targetIntel")}">
      <span>${translate("battle.scouted")}: <strong>${intel.coverage}%</strong></span>
      <span>${translate("battle.remainingCells")}: <strong>${intel.remaining}</strong></span>
    </div>
  `;
}

function renderBattleMomentum(log, playerId) {
  const momentum = battleMomentum(log, playerId);
  return `
    <div class="battle-momentum ${momentum.state}" aria-label="${translate("battle.momentumTitle")}">
      <div class="battle-momentum-label">
        <span>${translate("battle.momentumTitle")}</span>
        <strong>${translate(`battle.momentum.${momentum.state}`)}</strong>
      </div>
      <div class="battle-momentum-track" style="--momentum: ${momentum.playerShare}%">
        <i aria-hidden="true"></i>
      </div>
      <small>${momentum.playerScore}:${momentum.opponentScore}</small>
    </div>
  `;
}

function renderTacticalAdvisor(analysis, { disabled = false, targetAction = "shot" } = {}) {
  const expanded = state.tacticalAdvisorOpen;
  const toggleLabel = translate(expanded ? "tactics.collapse" : "tactics.expand");
  if (!expanded) {
    return `
      <section class="tactical-advisor is-collapsed" aria-label="${translate("tactics.title")}">
        <button
          class="tactical-advisor-toggle tactical-advisor-compact-toggle"
          data-action="toggle-tactical-advisor"
          aria-expanded="false"
          aria-label="${translate("tactics.expand")}"
        >
          ${translate("tactics.expand")}
        </button>
      </section>
    `;
  }

  const priority = analysis.priorityTargets.length
    ? analysis.priorityTargets.slice(0, 3).map(formatCoordinate).join(" · ")
    : translate("tactics.noPriority");
  return `
    <section class="tactical-advisor ${disabled ? "is-paused" : ""} is-expanded" aria-label="${translate("tactics.title")}">
      <div class="tactical-advisor-heading">
        <div class="tactical-advisor-title">
          <span>${translate("tactics.title")}</span>
          <strong>${translate(`tactics.recommendation.${analysis.recommendationId}`)}</strong>
        </div>
        <button
          class="tactical-advisor-toggle"
          data-action="toggle-tactical-advisor"
          aria-expanded="${expanded}"
          aria-label="${toggleLabel}"
        >
          ${toggleLabel}
        </button>
      </div>
      <div class="tactical-advisor-body">
        ${renderQuickFireButton(analysis.priorityTargets[0], { disabled, targetAction })}
        <div class="tactical-stats">
          ${renderTacticalStat("tactics.targets", analysis.availableTargets)}
          ${renderTacticalStat("tactics.unresolved", analysis.unresolvedHits)}
          ${renderTacticalStat("tactics.priority", priority)}
          ${analysis.salvoRemaining > 1 ? renderTacticalStat("tactics.salvo", analysis.salvoRemaining) : ""}
        </div>
        ${renderPriorityTargetChips(analysis.priorityTargets, { disabled, targetAction })}
      </div>
    </section>
  `;
}

function renderQuickFireButton(target, { disabled = false, targetAction = "shot" } = {}) {
  if (!target) return "";
  return `
    <button
      class="tactical-quick-fire"
      data-action="${targetAction}"
      data-row="${target.row}"
      data-col="${target.col}"
      ${disabled ? "disabled" : ""}
    >
      ${translate("tactics.quickFire", { coordinate: formatCoordinate(target) })}
    </button>
  `;
}

function renderPriorityTargetChips(priorityTargets, { disabled = false, targetAction = "shot" } = {}) {
  const targets = priorityTargets.slice(0, 3);
  if (!targets.length) return "";
  return `
    <div class="priority-targets" aria-label="${translate("tactics.priority")}">
      ${targets
        .map(
          (target) => `
            <button
              class="priority-target-chip"
              data-action="${targetAction}"
              data-row="${target.row}"
              data-col="${target.col}"
              ${disabled ? "disabled" : ""}
            >
              ${formatCoordinate(target)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderTacticalStat(key, value) {
  return `
    <div>
      <span>${translate(key)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderBattleTab(tab, labelKey, activeTab) {
  return `
    <button
      class="${activeTab === tab ? "is-selected" : ""}"
      data-action="battle-tab"
      data-tab="${tab}"
      role="tab"
      aria-selected="${activeTab === tab}"
    >${translate(labelKey)}</button>
  `;
}

function renderLocalResultModal() {
  if (!state.game || state.game.phase !== "finished") {
    return "";
  }
  const resultKey = localResultKey(state.game);
  if (state.resultModalDismissed === resultKey) {
    return "";
  }
  return renderResultModal({
    winnerId: state.game.winnerId,
    playerId: state.mode === "agent" ? "p1" : state.game.winnerId,
    log: state.game.log,
    newGameAction: "new-game",
  });
}

function renderOnlineResultModal(snapshot) {
  if (!snapshot || snapshot.phase !== "finished") {
    return "";
  }
  const resultKey = onlineResultKey(snapshot);
  if (state.resultModalDismissed === resultKey) {
    return "";
  }
  return renderResultModal({
    winnerId: snapshot.winnerId,
    playerId: snapshot.playerId,
    log: snapshot.log ?? [],
    newGameAction: "online-rematch",
    ratingChange: snapshot.ratingChange,
    onlineActions: true,
  });
}

function renderResultModal({ winnerId, playerId = winnerId, log, newGameAction, ratingChange = null, onlineActions = false }) {
  const report = buildBattleReport(log, winnerId, playerId);
  const summary = report.summary;
  const stats = report.player;
  return `
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="result-title">
      <section class="result-modal">
        <span>${translate("result.title")}</span>
        <h2 id="result-title">${translate("game.winner", { player: playerName(winnerId) })}</h2>
        <div class="result-stats">
          ${renderResultStat("result.totalShots", summary.totalShots)}
          ${renderResultStat("result.shots", stats.shots)}
          ${renderResultStat("result.hits", stats.hits)}
          ${renderResultStat("result.misses", stats.misses)}
          ${renderResultStat("result.sunk", stats.sunk)}
          ${renderResultStat("result.accuracy", `${stats.accuracy}%`)}
        </div>
        ${renderBattleReport(report, ratingChange)}
        <p class="replay-live-status visually-hidden" aria-live="polite" aria-atomic="true"></p>
        ${renderBattleReplay(log, report.moments)}
        ${renderOnlineRatingChange(ratingChange)}
        ${
          state.resultCopyStatus
            ? `<p class="result-share-status status-line" role="status">${translate(
                state.resultCopyStatus === "copied" ? "result.copySuccess" : "share.failed",
              )}</p>`
            : ""
        }
        <div class="result-actions button-row">
          <button data-action="close-result">${translate("result.inspect")}</button>
          <button data-action="copy-battle-summary">${translate("result.copySummary")}</button>
          <button data-action="share-battle-summary">${translate("result.shareSummary")}</button>
          ${
            onlineActions
              ? `<button data-action="share-telegram">${translate("online.shareTelegram")}</button>
                <button class="primary-button" data-action="online-rematch">${translate("online.rematch")}</button>`
              : `<button class="primary-button" data-action="${newGameAction}">${translate("game.restart")}</button>`
          }
        </div>
      </section>
    </div>
  `;
}

function renderBattleReport(report, ratingChange = null) {
  const streak = ratingChange?.currentOnlineWinStreak ?? state.profile.data?.summary?.currentWinStreak ?? "—";
  return `
    <section class="battle-report">
      <div class="battle-report-header">
        <span>${translate("result.report")}</span>
        <strong>${translate(`profile.result.${report.result}`)}</strong>
      </div>
      <div class="battle-report-grid">
        ${renderResultStat("result.you", `${report.player.hits}/${report.player.shots}`)}
        ${renderResultStat("result.opponent", `${report.opponent.hits}/${report.opponent.shots}`)}
        ${renderResultStat("result.streak", streak)}
      </div>
      ${renderBattleDebrief(report.debrief)}
      ${renderBattleMoments(report.moments)}
      <div class="achievement-block">
        <span>${translate("result.achievements")}</span>
        ${
          report.achievements.length
            ? `<div class="achievement-list">
                ${report.achievements.map(renderAchievement).join("")}
              </div>`
            : `<p>${translate("result.noAchievements")}</p>`
        }
      </div>
      ${renderBattleCoaching(report.coaching, report.trainingPlan)}
    </section>
  `;
}

function renderBattleDebrief(debrief) {
  const insights = Array.isArray(debrief?.insights) ? debrief.insights : [];
  if (!insights.length) {
    return "";
  }
  return `
    <section class="battle-debrief" aria-label="${translate("debrief.title")}">
      <span>${translate("debrief.title")}</span>
      <ul class="battle-debrief-list">
        ${insights
          .map(
            (insight) => `
              <li class="battle-debrief-item is-${escapeHtml(insight.tone)}">
                <strong>${translate(`debrief.label.${insight.id}`)}</strong>
                <small>${translate(`debrief.message.${insight.messageId}`)}</small>
              </li>
            `,
          )
          .join("")}
      </ul>
    </section>
  `;
}

function renderBattleMoments(moments) {
  const items = Array.isArray(moments?.items) ? moments.items : [];
  if (!items.length) {
    return "";
  }
  return `
    <section class="battle-moments" aria-label="${translate("moments.title")}">
      <span>${translate("moments.title")}</span>
      <ol class="battle-moment-list">
        ${items
          .map(
            (moment) => `
              <li class="battle-moment-item">
                <strong>${translate(`moments.${moment.id}`)}</strong>
                <small>${momentDetailText(moment)}</small>
              </li>
            `,
          )
          .join("")}
      </ol>
    </section>
  `;
}

function renderBattleReplay(log, moments) {
  const entries = Array.isArray(log) ? log : [];
  if (!entries.length) {
    return "";
  }
  const activeTurn = normalizedReplayTurn(entries.length);
  const entry = entries[activeTurn - 1];
  const replayBoard = replayBoardForLog(entries, activeTurn);
  const replaySpeed = currentResultReplaySpeed();
  const momentItems = Array.isArray(moments?.items) ? moments.items : [];
  const replayMoveText = translate("replay.move", { turn: activeTurn, total: entries.length });
  const replayPositionText = translate("replay.position", { turn: activeTurn, total: entries.length });
  return `
    <section class="battle-replay" aria-label="${translate("replay.title")}">
      <div class="battle-replay-header">
        <span>${translate("replay.title")}</span>
        <strong>${replayMoveText}</strong>
      </div>
      <div class="battle-replay-timeline">
        <label class="battle-replay-timeline-track">
          <span>${translate("replay.timeline")}</span>
          <input
            data-action="result-replay-seek"
            type="range"
            min="1"
            max="${entries.length}"
            step="1"
            value="${activeTurn}"
            aria-label="${translate("replay.seek")}"
            aria-valuetext="${replayPositionText}"
          >
        </label>
        ${renderBattleReplayMoments(momentItems, entries.length, activeTurn)}
      </div>
      <div class="battle-replay-map">
        ${renderBoard(replayBoard, {
          kind: "replay-target",
          title: translate("replay.map"),
          disabled: true,
          highlightCoordinate: entry.coordinate,
        })}
      </div>
      <div class="battle-replay-card">
        <div>
          <small>${translate("replay.player")}</small>
          <strong>${playerName(entry.playerId)}</strong>
        </div>
        <div>
          <small>${translate("replay.result")}</small>
          <strong>${translate(`shot.${entry.result}`)}</strong>
        </div>
        <div>
          <small>${translate("replay.coordinate")}</small>
          <strong>${battleReplayCoordinateText(entry)}</strong>
        </div>
      </div>
      <div class="battle-replay-controls">
        <button
          class="primary-button replay-play-button"
          data-action="result-replay-toggle-play"
        >
          <span aria-hidden="true">${state.resultReplayPlaying ? "Ⅱ" : "▶"}</span>
          ${translate(state.resultReplayPlaying ? "replay.pause" : "replay.play")}
        </button>
        <button
          data-action="result-replay-speed"
          aria-label="${translate("replay.speed", { speed: replaySpeed.label })}"
          title="${translate("replay.speed", { speed: replaySpeed.label })}"
        >
          <span aria-hidden="true">${replaySpeed.label}</span>
        </button>
        <button data-action="result-replay-prev" ${activeTurn <= 1 ? "disabled" : ""}>
          <span aria-hidden="true">←</span> ${translate("replay.previous")}
        </button>
        <button data-action="result-replay-next" ${activeTurn >= entries.length ? "disabled" : ""}>
          ${translate("replay.next")} <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  `;
}

function renderBattleReplayMoments(moments, totalTurns, activeTurn) {
  const controls = moments
    .map((moment) => {
      const turn = replayMomentTurn(moment, totalTurns);
      if (!turn) {
        return "";
      }
      const isActive = turn === activeTurn;
      return `
        <button
          class="battle-replay-moment ${isActive ? "is-active" : ""}"
          data-action="result-replay-jump"
          data-moment-id="${escapeHtml(moment.id)}"
          data-turn="${turn}"
          ${isActive ? 'aria-current="step"' : ""}
        >
          <span>${translate(`moments.${moment.id}`)}</span>
          <small>${translate("moments.turn", { turn })}</small>
        </button>
      `;
    })
    .filter(Boolean)
    .join("");

  return controls ? `<div class="battle-replay-moments">${controls}</div>` : "";
}

function replayBoardForLog(log, activeTurn) {
  const entry = log[activeTurn - 1];
  const context = currentBattleResultContext();
  const size = getGamePreset(context?.presetId ?? state.presetId).size;
  return {
    size,
    ships: [],
    markers: [],
    shots: log
      .slice(0, activeTurn)
      .filter((shot) => shot.playerId === entry.playerId && shot.coordinate)
      .map((shot) => ({
        ...shot.coordinate,
        result: shot.result,
        shipId: shot.shipId ?? null,
      })),
  };
}

function normalizedReplayTurn(total) {
  return normalizeReplayTurn(state.resultReplayTurn, total);
}

function battleReplayCoordinateText(entry) {
  return entry.coordinate ? formatCoordinate(entry.coordinate) : translate("replay.empty");
}

function momentDetailText(moment) {
  if (moment.id === "missStreak") {
    return translate("moments.turnRange", {
      start: moment.startTurn,
      end: moment.endTurn,
      count: moment.length,
    });
  }
  return `${translate("moments.turn", { turn: moment.turn })} · ${momentCoordinateText(moment)}`;
}

function momentCoordinateText(moment) {
  return moment.coordinate ? formatCoordinate(moment.coordinate) : translate("moments.noCoordinate");
}

function renderBattleCoaching(coaching, trainingPlan) {
  if (!coaching) {
    return "";
  }
  const trainingPlanSteps =
    Array.isArray(trainingPlan?.steps) && trainingPlan.steps.length
      ? trainingPlan.steps
      : [{ drillId: coaching.drillId, focusId: coaching.focusId, reasonId: coaching.diagnosisId }];
  return `
    <details class="battle-coaching">
      <summary class="battle-coaching-summary">
        <span>${translate("coaching.title")}</span>
        <strong>${translate(`coaching.drill.${coaching.drillId}`)}</strong>
        <small class="battle-coaching-preview">${translate(`coaching.diagnosis.${coaching.diagnosisId}`)}</small>
      </summary>
      <p>${translate(`coaching.diagnosis.${coaching.diagnosisId}`)}</p>
      <div class="coaching-grid">
        <div>
          <small>${translate("coaching.focus")}</small>
          <strong>${translate(`coaching.focus.${coaching.focusId}`)}</strong>
        </div>
        <div>
          <small>${translate("coaching.drill")}</small>
          <strong>${translate(`coaching.drill.${coaching.drillId}`)}</strong>
        </div>
      </div>
      <div class="training-plan">
        <span>${translate("coaching.plan")}</span>
        <ol>
          ${trainingPlanSteps
            .map(
              (step, index) => `
                <li>
                  <span>${index + 1}</span>
                  <div>
                    <strong>${translate(`coaching.drill.${step.drillId}`)}</strong>
                    <small>
                      ${translate(`coaching.focus.${step.focusId}`)} ·
                      ${translate(`coaching.diagnosis.${step.reasonId}`)}
                    </small>
                  </div>
                  <button
                    class="training-link"
                    data-action="start-coaching-training"
                    data-drill-id="${escapeHtml(step.drillId)}"
                  >${translate("coaching.startTraining")}</button>
                </li>
          `,
            )
            .join("")}
        </ol>
      </div>
    </details>
  `;
}

function renderAchievement(achievement) {
  return `
    <article class="achievement-card">
      <strong>${translate(`achievement.${achievement.id}.title`)}</strong>
      <small>${translate(`achievement.${achievement.id}.desc`)}</small>
    </article>
  `;
}

function renderOnlineRatingChange(ratingChange) {
  if (!ratingChange) {
    return "";
  }
  const delta = Number(ratingChange.delta);
  const signedDelta = delta > 0 ? `+${delta}` : String(delta);
  const tone = delta >= 0 ? "is-positive" : "is-negative";
  return `
    <div class="online-rating-change ${tone}">
      <span>${translate("result.ratingChange")}</span>
      <strong>${signedDelta}</strong>
      <small>${ratingChange.before} → ${ratingChange.after} · ${translate(`profile.ratingLabel.${ratingChange.label}`)}</small>
    </div>
  `;
}

function renderResultStat(key, value) {
  return `
    <div>
      <span>${translate(key)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderBoard(board, { kind, title, disabled = false, priorityTargets = [], highlightCoordinate = null }) {
  const columnLabels = Array.from({ length: board.size }, (_, index) =>
    coordinateColumnLabel(state.language, index),
  );
  const priorityTargetKeys = new Set(priorityTargets.map(coordinateKey));
  let hasFocusableCell = false;
  return `
    <section class="board-panel">
      <div class="board-title">
        <h3>${title}</h3>
      </div>
      <div class="board-scroll">
      <div class="coordinate-board" style="--board-size: ${board.size}">
        <span class="grid-corner" aria-hidden="true"></span>
        <div class="column-headers" style="--board-size: ${board.size}" aria-hidden="true">
          ${columnLabels.map((label) => `<span>${label}</span>`).join("")}
        </div>
        <div class="row-headers" style="--board-size: ${board.size}" aria-hidden="true">
          ${Array.from({ length: board.size }, (_, index) => `<span>${index + 1}</span>`).join("")}
        </div>
        <div class="board-grid ${kind}" style="--board-size: ${board.size}" role="grid" aria-label="${title}">
          ${Array.from({ length: board.size * board.size }, (_, index) => {
            const row = Math.floor(index / board.size);
            const col = index % board.size;
            const coordinate = { row, col };
            const cell = kind === "own" || kind === "setup" ? getCell(board, coordinate) : getTargetCell(board, coordinate);
            const label = cellAriaLabel(cell, kind, row, columnLabels[col]);
            const buttonDisabled = disabled || kind === "own" || cell.shot;
            const isFirstFocusableCell = !buttonDisabled && !hasFocusableCell;
            if (isFirstFocusableCell) {
              hasFocusableCell = true;
            }
            const classes = [
              "cell",
              cellClass(cell, kind, board, coordinate),
              priorityTargetKeys.has(coordinateKey(coordinate)) ? "tactical-priority" : "",
              highlightCoordinate && sameCoordinate(coordinate, highlightCoordinate) ? "replay-active" : "",
            ].filter(Boolean).join(" ");
            return `<button
              class="${classes}"
              data-action="${kind === "target" ? "shot" : kind === "online-target" ? "online-shot" : kind === "training-target" ? "training-shot" : kind === "setup" ? "setup-cell" : ""}"
              data-row="${row}"
              data-col="${col}"
              aria-label="${label}"
              ${buttonDisabled ? "" : `tabindex="${isFirstFocusableCell ? "0" : "-1"}"`}
              ${buttonDisabled ? "disabled" : ""}
            >${cellContents(cell, kind, board, coordinate)}</button>`;
          }).join("")}
        </div>
      </div>
      </div>
    </section>
  `;
}

function formatCoordinate(coordinate) {
  return `${coordinateColumnLabel(state.language, coordinate.col)}${coordinate.row + 1}`;
}

function renderLog(log) {
  return `
    <section class="log-panel">
      <h3>${translate("log.title")}</h3>
      ${
        log.length === 0
          ? `<p>${translate("log.empty")}</p>`
          : `<ol>${visibleBattleLog(log)
              .map(
                (entry) =>
                  `<li class="log-entry ${entry.result}">
                    <span>${playerName(entry.playerId)}</span>
                    <strong><i aria-hidden="true"></i>${translate(`shot.${entry.result}`)}</strong>
                    <small>${coordinateColumnLabel(state.language, entry.coordinate.col)}${entry.coordinate.row + 1}</small>
                  </li>`,
              )
              .join("")}</ol>`
      }
    </section>
  `;
}

root.addEventListener("change", async (event) => {
  const action = event.target.dataset.action;
  if (action === "language") {
    state.language = event.target.value;
    render();
    await preferenceCoordinator.write("language", state.language);
  }
  if (action === "auth-consent") {
    state.auth.consent = Boolean(event.target.checked);
    state.auth.error = "";
    render();
    await preferenceCoordinator.write(
      authConsentSettingKey,
      state.auth.consent ? "accepted" : "declined",
    );
  }
  if (action === "agent-difficulty") {
    state.agentDifficulty = event.target.value;
  }
  if (action === "result-replay-seek") {
    setResultReplayTurn(event.target.value);
  }
  if (action === "archived-replay-seek") {
    setResultReplayTurn(event.target.value);
  }
});

root.addEventListener("input", (event) => {
  updateOnlineInput(event.target);
});

root.addEventListener("change", (event) => {
  updateOnlineInput(event.target);
});

root.addEventListener("keydown", handleBoardKeydown);
root.addEventListener("focusin", handleSetupFocusin);

function updateOnlineInput(target) {
  const action = target.dataset.action;
  if (action === "room-code") {
    state.online.roomCodeInput = target.value.trim().toUpperCase();
  }
}

function handleBoardKeydown(event) {
  const button = event.target.closest?.(".board-grid .cell[data-row][data-col]");
  if (!button) {
    return;
  }

  const isRotateShortcut = !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r";
  if (button.matches('.setup .cell[data-action="setup-cell"]') && isRotateShortcut) {
    event.preventDefault();
    rotateSetupOrientation();
    restoreBoardFocus(button);
    return;
  }

  const deltas = {
    ArrowRight: { row: 0, col: 1 },
    ArrowLeft: { row: 0, col: -1 },
    ArrowDown: { row: 1, col: 0 },
    ArrowUp: { row: -1, col: 0 },
  };
  const delta = deltas[event.key];
  if (!delta) {
    return;
  }

  event.preventDefault();
  moveBoardFocus(button, delta);
}

function moveBoardFocus(button, delta) {
  const nextCell = nextBoardCell(button, delta);
  if (!nextCell) {
    return;
  }

  button.tabIndex = -1;
  nextCell.tabIndex = 0;
  nextCell.focus();
}

function restoreBoardFocus(button) {
  const grid = button.closest(".board-grid");
  const boardKind = ["setup", "target", "own", "training-target"].find((kind) => grid?.classList.contains(kind));
  const row = button.dataset.row;
  const col = button.dataset.col;
  const scheduleFocus = window.requestAnimationFrame ?? ((callback) => window.setTimeout(callback, 0));
  scheduleFocus(() => {
    const gridSelector = boardKind ? `.board-grid.${boardKind}` : ".board-grid";
    const nextButton = root.querySelector(`${gridSelector} .cell[data-row="${row}"][data-col="${col}"]:not(:disabled)`);
    if (!nextButton) {
      return;
    }
    nextButton.tabIndex = 0;
    nextButton.focus();
  });
}

function nextBoardCell(button, delta) {
  const grid = button.closest(".board-grid");
  const size = Number.parseInt(grid?.style.getPropertyValue("--board-size"), 10);
  if (!grid || !Number.isInteger(size)) {
    return null;
  }

  let row = Number.parseInt(button.dataset.row, 10) + delta.row;
  let col = Number.parseInt(button.dataset.col, 10) + delta.col;
  while (row >= 0 && row < size && col >= 0 && col < size) {
    const candidate = grid.querySelector(
      `.cell[data-row="${row}"][data-col="${col}"]:not(:disabled)`,
    );
    if (candidate) {
      return candidate;
    }
    row += delta.row;
    col += delta.col;
  }
  return null;
}

root.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  if (action === "open-privacy" && platform.isNative()) {
    event.preventDefault();
    await platform.openExternalUrl(canonicalPrivacyUrl);
    return;
  }
  void unlockAudio();
  if (action !== "shot" && action !== "online-shot" && action !== "audio-toggle") {
    playSound("ui");
  }
  if (action === "toggle-settings") toggleSettings();
  if (action === "start-hotseat") startSetup("hotseat");
  if (action === "start-agent") startSetup("agent");
  if (action === "start-training") startTraining();
  if (action === "start-coaching-training") startTraining(trainingScenarioForDrill(button.dataset.drillId));
  if (action === "show-online") showOnline();
  if (action === "select-preset") selectPreset(button.dataset.presetId);
  if (action === "audio-toggle") await toggleAudio();
  if (action === "haptics-toggle") await toggleHaptics();
  if (action === "theme-toggle") await toggleTheme();
  if (action === "visual-style-toggle") await toggleVisualStyle();
  if (action === "toggle-profile") await toggleProfilePopover();
  if (action === "close-profile") closeProfilePopover();
  if (action === "toggle-leaderboard") await toggleLeaderboardPopover();
  if (action === "close-leaderboard") closeLeaderboardPopover();
  if (action === "toggle-tactical-advisor") toggleTacticalAdvisor();
  if (action === "menu") await requestLeaveBattle();
  if (action === "cancel-leave-battle") cancelLeaveBattle();
  if (action === "confirm-leave-battle") await confirmLeaveBattle();
  if (action === "dismiss-restore-notice") dismissRestoreNotice();
  if (action === "new-game") startSetup(state.mode);
  if (action === "online-new-game") showOnline();
  if (action === "close-result") closeResultModal();
  if (action === "result-replay-toggle-play") toggleResultReplayPlayback();
  if (action === "result-replay-speed") cycleResultReplaySpeed();
  if (action === "result-replay-prev") changeResultReplayTurn(-1);
  if (action === "result-replay-next") changeResultReplayTurn(1);
  if (action === "result-replay-jump") setResultReplayTurn(button.dataset.turn);
  if (action === "open-archive") await openReplayArchive();
  if (action === "archive-retry") await retryReplayArchive();
  if (action === "archive-load-more") await loadReplayArchive({ append: true });
  if (action === "open-replay") {
    await openArchivedReplay(button.dataset.replayId, { source: button.dataset.replaySource || "direct" });
  }
  if (action === "replay-retry") await loadArchivedReplay(state.replayArchive.requestedId);
  if (action === "replay-copy-link") await copyArchivedReplayLink();
  if (action === "replay-back") await backToReplayArchive();
  if (action === "replay-tab") selectArchivedReplayTab(button.dataset.tab);
  if (action === "archived-replay-toggle-play") toggleResultReplayPlayback();
  if (action === "archived-replay-speed") cycleResultReplaySpeed();
  if (action === "archived-replay-prev") changeResultReplayTurn(-1);
  if (action === "archived-replay-next") changeResultReplayTurn(1);
  if (action === "archived-replay-jump") setResultReplayTurn(button.dataset.turn);
  if (action === "select-setup-ship") selectSetupShip(button.dataset.shipId);
  if (action === "rotate-setup") rotateSetupOrientation();
  if (action === "randomize") randomizeSetup();
  if (action === "reset") resetSetup();
  if (action === "ready") readySetup();
  if (action === "select-training-scenario") startTraining(button.dataset.scenarioId);
  if (action === "restart-training") startTraining(state.training.scenarioId);
  if (action === "continue-pass") continueAfterPass();
  if (action === "setup-cell") handleSetupCell(readCoordinate(button));
  if (action === "training-shot") handleTrainingShot(readCoordinate(button));
  if (action === "shot") handleLocalShot(readCoordinate(button));
  if (action === "online-shot") handleOnlineShot(readCoordinate(button));
  if (action === "online-create") await onlineCreate();
  if (action === "online-join") await onlineJoin();
  if (action === "online-rematch") await onlineRematch();
  if (action === "copy-room-code") await copyRoomCode();
  if (action === "copy-battle-summary") await copyBattleSummary();
  if (action === "share-battle-summary") await shareBattleSummary();
  if (action === "share-telegram") await shareRoom();
  if (action === "battle-tab") selectBattleTab(button.dataset.tab);
  if (action === "auth-telegram-oidc") await startTelegramOidc();
  if (action === "auth-telegram-retry") await loadTelegramAuthCapability();
  if (action === "auth-logout") await logoutAuth();
  if (action === "refresh-profile") await refreshProfile();
  if (action === "refresh-leaderboard") await refreshLeaderboard();
});

root.addEventListener("mouseover", (event) => {
  const cell = event.target.closest('.setup .cell[data-action="setup-cell"]');
  if (cell) {
    updateSetupHover(readCoordinate(cell));
  }
});

function handleSetupFocusin(event) {
  const cell = event.target.closest('.setup .cell[data-action="setup-cell"]');
  if (cell) {
    updateSetupHover(readCoordinate(cell));
    restoreBoardFocus(cell);
  }
}

window.onTelegramAuth = (payload) => {
  void handleTelegramAuth(payload);
};

function selectPreset(presetId) {
  if (!gamePresets[presetId]) {
    return;
  }
  state.presetId = presetId;
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupHover = null;
  render();
}

function startSetup(mode) {
  closeRemote();
  state.settingsOpen = false;
  state.profileOpen = false;
  state.leaderboardOpen = false;
  state.mode = mode;
  state.screen = "setup";
  state.setupPlayerId = "p1";
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupOrientation = "horizontal";
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupHover = null;
  state.setupError = "";
  state.boards = { p1: null, p2: null };
  state.game = null;
  state.battleTab = "target";
  state.tacticalAdvisorOpen = true;
  state.resultModalDismissed = null;
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  render();
}

function showOnline() {
  closeRemote();
  state.settingsOpen = false;
  state.profileOpen = false;
  state.leaderboardOpen = false;
  state.mode = "online";
  state.screen = "online";
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupOrientation = "horizontal";
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupHover = null;
  state.setupError = "";
  state.online.roomCodeInput = "";
  state.online.error = "";
  state.online.status = "";
  state.battleTab = "target";
  state.tacticalAdvisorOpen = true;
  state.resultModalDismissed = null;
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  render();
}

function startTraining(scenarioId = state.training.scenarioId) {
  closeRemote();
  state.settingsOpen = false;
  state.profileOpen = false;
  state.leaderboardOpen = false;
  state.mode = "training";
  state.screen = "training";
  state.training.scenarioId = scenarioId || "checkerboard";
  state.training.session = createTrainingSession(state.training.scenarioId);
  state.resultModalDismissed = null;
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  render();
}

async function handlePlatformBack() {
  if (state.settingsOpen) {
    state.settingsOpen = false;
    render();
    return true;
  }
  if (state.profileOpen) {
    state.profileOpen = false;
    render();
    return true;
  }
  if (state.leaderboardOpen) {
    state.leaderboardOpen = false;
    render();
    return true;
  }
  if (["archive", "replay"].includes(state.screen)) {
    await goToMenu();
    return true;
  }
  if (["setup", "playing", "pass", "training", "online"].includes(state.screen)) {
    return requestLeaveBattle();
  }
  return false;
}

async function requestLeaveBattle(transition = null) {
  if (state.leaveBattleDialog) {
    if (transition) return false;
    cancelLeaveBattle();
    return true;
  }
  if (!hasUnfinishedBattle()) {
    if (transition) return transition();
    const handled = state.screen !== "menu";
    if (handled) await goToMenu();
    return handled;
  }
  pendingLeaveTransition = transition;
  leaveDialogReturnFocus = leaveDialogFocus.captureReturnFocus();
  state.leaveBattleDialog = true;
  render();
  return true;
}

function hasUnfinishedBattle() {
  if (state.screen === "setup" || state.screen === "pass") return true;
  if (state.screen === "playing") return state.game?.phase !== "finished";
  if (state.screen === "training") return state.training.session?.phase !== "finished";
  if (state.screen === "online") return state.online.snapshot?.phase !== "finished";
  return false;
}

function cancelLeaveBattle() {
  const returnFocus = leaveDialogReturnFocus;
  pendingLeaveTransition = null;
  state.leaveBattleDialog = false;
  render();
  leaveDialogFocus.restoreFocus(returnFocus);
  leaveDialogReturnFocus = null;
}

async function confirmLeaveBattle() {
  const transition = pendingLeaveTransition;
  const completed = transition ? await transition() : await goToMenu();
  if (completed) {
    pendingLeaveTransition = null;
    leaveDialogReturnFocus = null;
    if (state.leaveBattleDialog) {
      state.leaveBattleDialog = false;
      render();
    }
  }
}

function dismissRestoreNotice() {
  state.restoredBattle = false;
  state.restoreError = "";
  render();
}

async function handlePlatformDeepLink(rawUrl) {
  const route = parseSalvoDeepLink(rawUrl);
  if (!route) return false;
  if (route.type === "auth" || route.type === "authError") {
    await closeTelegramBrowser();
    if (route.type === "authError") {
      return cancelTelegramAuth();
    }
    return redeemTelegramTicket(route.ticket);
  }
  return requestLeaveBattle(async () => {
    try {
      if (route.type === "room") {
        return await appNavigation.run(() => {
          showOnline();
          state.online.roomCodeInput = route.roomCode;
          render();
        });
      }
      return await openArchivedReplay(route.replayId, { source: "direct" });
    } catch {
      return false;
    }
  });
}

async function goToMenu({ updateHistory = true } = {}) {
  return appNavigation.run(() => applyMenuState({ updateHistory }));
}

function applyMenuState({ updateHistory }) {
  abortPrivateRequest("archive");
  abortPrivateRequest("replay");
  state.settingsOpen = false;
  state.profileOpen = false;
  state.leaderboardOpen = false;
  state.leaveBattleDialog = false;
  state.restoredBattle = false;
  state.screen = "menu";
  state.mode = null;
  state.game = null;
  state.training.session = null;
  state.online.error = "";
  state.online.status = "";
  state.resultModalDismissed = null;
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  state.replayArchive.requestedId = "";
  state.replayArchive.data = null;
  state.replayArchive.loading = false;
  state.replayArchive.error = "";
  state.replayArchive.copyStatus = "";
  state.replayArchive.openedFromArchive = false;
  state.archive.loading = false;
  state.archive.requestId += 1;
  state.replayArchive.requestId += 1;
  if (updateHistory) {
    updateReplayHistory("", "push", "menu");
  }
  render();
}

function hasLocalBattleSnapshotContext() {
  return (
    ["agent", "hotseat", "training"].includes(state.mode)
    && ["setup", "playing", "pass", "training"].includes(state.screen)
  );
}

async function openReplayArchive({ historyMode = "push" } = {}) {
  return appNavigation.run(async () => {
    resetResultReplayPlayback();
    abortPrivateRequest("archive");
    abortPrivateRequest("replay");
    state.settingsOpen = false;
    state.profileOpen = false;
    state.leaderboardOpen = false;
    state.screen = "archive";
    state.replayArchive.requestedId = "";
    state.replayArchive.data = null;
    state.replayArchive.loading = false;
    state.replayArchive.error = "";
    state.replayArchive.copyStatus = "";
    state.replayArchive.openedFromArchive = false;
    state.replayArchive.requestId += 1;
    updateReplayHistory("", historyMode, "archive");
    await loadReplayArchive();
  });
}

async function openArchivedReplay(id, { source = "direct" } = {}) {
  const replayId = replayIdFromSearch(`?replay=${encodeURIComponent(id || "")}`);
  if (!replayId) {
    return false;
  }
  return appNavigation.run(async () => {
    resetResultReplayPlayback();
    abortPrivateRequest("archive");
    abortPrivateRequest("replay");
    state.settingsOpen = false;
    state.profileOpen = false;
    state.leaderboardOpen = false;
    state.screen = "replay";
    state.replayArchive.requestedId = replayId;
    state.replayArchive.data = null;
    state.replayArchive.error = "";
    state.replayArchive.tab = "own";
    state.replayArchive.copyStatus = "";
    state.replayArchive.openedFromArchive = source === "archive";
    state.archive.requestId += 1;
    state.archive.loading = false;
    updateReplayHistory(replayId, "push", "replay", { replaySource: source });
    await loadArchivedReplay(replayId);
  });
}

async function backToReplayArchive() {
  resetResultReplayPlayback();
  abortPrivateRequest("replay");
  if (state.replayArchive.openedFromArchive) {
    window.history.back();
    return;
  }
  await openReplayArchive({ historyMode: "replace" });
}

function updateReplayHistory(replayId, mode, screen, details = {}) {
  let url;
  if (replayId) {
    url = replayUrlForId(window.location.href, replayId);
  } else {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("replay");
    nextUrl.hash = "";
    url = nextUrl.toString();
  }
  if (mode === "replace") {
    window.history.replaceState({ screen, ...details }, "", url);
    return;
  }
  window.history.pushState({ screen, ...details }, "", url);
}

async function handleReplayPopState(event) {
  const replayId = replayIdFromSearch(window.location.search);
  return appNavigation.run(async () => {
    resetResultReplayPlayback();
    abortPrivateRequest("archive");
    abortPrivateRequest("replay");
    if (replayId) {
      state.screen = "replay";
      state.replayArchive.requestedId = replayId;
      state.replayArchive.data = null;
      state.replayArchive.error = "";
      state.replayArchive.openedFromArchive = event.state?.replaySource === "archive";
      await loadArchivedReplay(replayId);
      return;
    }
    if (event.state?.screen === "archive") {
      state.screen = "archive";
      state.replayArchive.requestedId = "";
      state.replayArchive.data = null;
      state.replayArchive.openedFromArchive = false;
      await loadReplayArchive();
      return;
    }
    await applyMenuState({ updateHistory: false });
  });
}

function selectArchivedReplayTab(tab) {
  if (tab !== "own" && tab !== "opponent") {
    return;
  }
  state.replayArchive.tab = tab;
  renderArchivedReplayFrame();
}

async function copyArchivedReplayLink() {
  const replayId = state.replayArchive.requestedId;
  const url = replayUrlForId(canonicalReplayBaseUrl, replayId);
  if (!url) {
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable");
    }
    await navigator.clipboard.writeText(url);
    state.replayArchive.copyStatus = "copied";
  } catch {
    state.replayArchive.copyStatus = "error";
  }
  render();
}

function toggleSettings() {
  state.settingsOpen = !state.settingsOpen;
  if (state.settingsOpen) {
    state.profileOpen = false;
    state.leaderboardOpen = false;
  }
  render();
}

function toggleTacticalAdvisor() {
  state.tacticalAdvisorOpen = !state.tacticalAdvisorOpen;
  render();
}

async function toggleProfilePopover() {
  if (!state.auth.user) {
    state.settingsOpen = true;
    state.profileOpen = false;
    state.leaderboardOpen = false;
    render();
    return;
  }

  state.profileOpen = !state.profileOpen;
  state.settingsOpen = false;
  state.leaderboardOpen = false;
  if (!state.profileOpen) {
    render();
    return;
  }

  state.profile.loading = true;
  state.profile.error = "";
  render();
  await refreshProfile({ renderWhenDone: false });
  if (state.profileOpen) {
    render();
  }
}

function closeProfilePopover() {
  state.profileOpen = false;
  render();
}

async function toggleLeaderboardPopover() {
  state.leaderboardOpen = !state.leaderboardOpen;
  state.settingsOpen = false;
  state.profileOpen = false;
  if (!state.leaderboardOpen) {
    render();
    return;
  }

  state.leaderboard.loading = true;
  state.leaderboard.error = "";
  render();
  await refreshLeaderboard({ renderWhenDone: false });
  if (state.leaderboardOpen) {
    render();
  }
}

function closeLeaderboardPopover() {
  state.leaderboardOpen = false;
  render();
}

async function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  render();
  await preferenceCoordinator.write("theme", state.theme);
}

async function toggleVisualStyle() {
  state.visualStyle = state.visualStyle === "classic" ? "render" : "classic";
  render();
  await preferenceCoordinator.write("visualStyle", state.visualStyle);
}

async function toggleAudio() {
  state.audioEnabled = !state.audioEnabled;
  if (state.audioEnabled) {
    playSound("ui");
  } else {
    audio.stopMusic();
  }
  render();
  await preferenceCoordinator.write("audio", state.audioEnabled ? "on" : "off");
}

async function toggleHaptics() {
  state.hapticsEnabled = !state.hapticsEnabled;
  render();
  await preferenceCoordinator.write("haptics", state.hapticsEnabled ? "on" : "off");
}

function closeResultModal() {
  const resultKey = currentResultKey();
  if (resultKey) {
    state.resultModalDismissed = resultKey;
  }
  state.resultCopyStatus = "";
  resetResultReplayPlayback();
  render();
}

function setResultReplayTurn(turn) {
  stopResultReplayPlayback();
  const entries = activeReplayEntries();
  if (!entries.length) {
    return;
  }
  const selectedTurn = Number.parseInt(turn, 10);
  if (!Number.isInteger(selectedTurn)) {
    return;
  }
  state.resultReplayTurn = normalizeReplayTurn(selectedTurn, entries.length);
  renderActiveReplayFrame();
}

function changeResultReplayTurn(delta) {
  const entries = activeReplayEntries();
  if (!entries.length) {
    return;
  }
  const currentTurn = normalizedReplayTurn(entries.length);
  const nextTurn = Math.min(Math.max(currentTurn + delta, 1), entries.length);
  setResultReplayTurn(nextTurn);
}

function currentResultReplaySpeed() {
  return replaySpeeds[state.resultReplaySpeedIndex] ?? replaySpeeds[0];
}

function stopResultReplayPlayback() {
  resultReplayClock.stop();
  state.resultReplayPlaying = false;
}

function resetResultReplayPlayback() {
  stopResultReplayPlayback();
  state.resultReplayTurn = null;
  state.resultReplaySpeedIndex = 0;
}

function activeReplayEntries() {
  if (state.screen === "replay") {
    return Array.isArray(state.replayArchive.data?.log) ? state.replayArchive.data.log : [];
  }
  const context = currentBattleResultContext();
  return Array.isArray(context?.log) ? context.log : [];
}

function renderActiveReplayFrame() {
  if (state.screen === "replay") {
    renderArchivedReplayFrame();
    return;
  }
  renderResultReplayFrame();
}

function renderArchivedReplayFrame() {
  const focusedControl = document.activeElement?.closest(".archived-replay-screen [data-action]");
  const activeAction = focusedControl?.dataset.action;
  const activeTurn = focusedControl?.dataset.turn;
  const activeTab = focusedControl?.dataset.tab;
  render();
  if (!activeAction) {
    return;
  }

  const controls = [...root.querySelectorAll(`.archived-replay-screen [data-action="${activeAction}"]`)];
  const matchingControl = controls.find(
    (control) =>
      (!activeTurn || control.dataset.turn === activeTurn) &&
      (!activeTab || control.dataset.tab === activeTab),
  );
  const focusTarget = matchingControl?.disabled
    ? root.querySelector('[data-action="archived-replay-toggle-play"]')
    : matchingControl;
  focusTarget?.focus({ preventScroll: true });
}

function renderResultReplayFrame() {
  const resultModal = root.querySelector(".result-modal");
  const replayElement = resultModal?.querySelector(".battle-replay");
  const context = currentBattleResultContext();
  if (!resultModal || !replayElement || !context?.log?.length) {
    render();
    return;
  }

  const scrollTop = resultModal.scrollTop;
  const focusedControl = document.activeElement?.closest(".battle-replay [data-action]");
  const activeAction = focusedControl?.dataset.action;
  const activeMomentId = focusedControl?.dataset.momentId;
  const moments = buildBattleReport(context.log, context.winnerId, context.playerId).moments;
  replayElement.outerHTML = renderBattleReplay(context.log, moments);
  resultModal.scrollTop = scrollTop;

  if (activeAction) {
    const matchingControls = [...resultModal.querySelectorAll(`[data-action="${activeAction}"]`)];
    const matchingControl = activeMomentId
      ? matchingControls.find((control) => control.dataset.momentId === activeMomentId)
      : matchingControls[0];
    const focusTarget = matchingControl?.disabled
      ? resultModal.querySelector('[data-action="result-replay-toggle-play"]')
      : matchingControl;
    focusTarget?.focus({ preventScroll: true });
  }

  const activeTurn = normalizedReplayTurn(context.log.length);
  const entry = context.log[activeTurn - 1];
  const liveStatus = resultModal.querySelector(".replay-live-status");
  if (liveStatus) {
    liveStatus.textContent = translate("replay.announcement", {
      turn: activeTurn,
      total: context.log.length,
      player: playerName(entry.playerId),
      result: translate(`shot.${entry.result}`),
      coordinate: battleReplayCoordinateText(entry),
    });
  }
}

function scheduleResultReplayTimer() {
  resultReplayClock.start(advanceResultReplayPlayback, currentResultReplaySpeed().delay);
}

function startResultReplayPlayback() {
  const entries = activeReplayEntries();
  if (!entries.length) {
    return;
  }
  state.resultReplayTurn = startReplayTurn(state.resultReplayTurn, entries.length);
  state.resultReplayPlaying = true;
  scheduleResultReplayTimer();
  renderActiveReplayFrame();
}

function toggleResultReplayPlayback() {
  if (state.resultReplayPlaying) {
    stopResultReplayPlayback();
    renderActiveReplayFrame();
    return;
  }
  startResultReplayPlayback();
}

function advanceResultReplayPlayback() {
  const entries = activeReplayEntries();
  if (!entries.length) {
    stopResultReplayPlayback();
    return;
  }
  const frame = advanceReplayTurn(state.resultReplayTurn, entries.length);
  state.resultReplayTurn = frame.turn;
  if (frame.complete) {
    stopResultReplayPlayback();
  }
  renderActiveReplayFrame();
}

function cycleResultReplaySpeed() {
  state.resultReplaySpeedIndex = nextReplaySpeedIndex(state.resultReplaySpeedIndex);
  if (state.resultReplayPlaying) {
    scheduleResultReplayTimer();
  }
  renderActiveReplayFrame();
}

function selectSetupShip(shipId) {
  if (!shipId || isPiecePlaced(state.setupBoard, shipId)) {
    return;
  }
  state.setupSelectedShipId = shipId;
  state.setupHover = null;
  state.setupError = "";
  render();
}

function rotateSetupOrientation() {
  state.setupOrientation = state.setupOrientation === "horizontal" ? "vertical" : "horizontal";
  state.setupError = "";
  render();
}

function randomizeSetup() {
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupHover = null;
  state.setupError = "";
  render();
}

function resetSetup() {
  state.setupBoard = createBoard(currentPreset().size);
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupHover = null;
  state.setupError = "";
  render();
}

function readySetup() {
  if (!hasFullFleet(state.setupBoard)) {
    return;
  }

  if (state.mode === "agent") {
    state.boards.p1 = state.setupBoard;
    state.boards.p2 = randomlyPlaceSetup(currentPreset());
    state.game = createGameFromBoards(state.boards.p1, state.boards.p2, "p1", gameOptions());
    state.screen = "playing";
    render();
    return;
  }

  if (state.setupPlayerId === "p1") {
    state.boards.p1 = state.setupBoard;
    state.setupPlayerId = "p2";
    state.setupBoard = randomlyPlaceSetup(currentPreset());
    state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    state.setupHover = null;
    state.setupError = "";
    state.passPlayerId = "p2";
    state.screen = "pass";
    render();
    return;
  }

  state.boards.p2 = state.setupBoard;
  state.game = createGameFromBoards(state.boards.p1, state.boards.p2, "p1", gameOptions());
  state.passPlayerId = "p1";
  state.screen = "pass";
  render();
}

function continueAfterPass() {
  state.screen = state.game ? "playing" : "setup";
  render();
}

function handleSetupCell(coordinate) {
  const cell = getCell(state.setupBoard, coordinate);
  if (cell.shipId) {
    state.setupBoard = removeShip(state.setupBoard, cell.shipId);
    state.setupSelectedShipId = cell.shipId;
    state.setupHover = null;
    state.setupError = "";
    render();
    return;
  }
  if (cell.markerId) {
    state.setupBoard = removeMarker(state.setupBoard, cell.markerId);
    state.setupSelectedShipId = cell.markerId;
    state.setupHover = null;
    state.setupError = "";
    render();
    return;
  }

  const preset = currentPreset();
  const ship = preset.fleet.find((candidate) => candidate.id === state.setupSelectedShipId);
  const marker = (preset.markers ?? []).find((candidate) => candidate.id === state.setupSelectedShipId);
  const piece = ship ?? marker;
  if (!piece || isPiecePlaced(state.setupBoard, piece.id)) {
    state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    state.setupHover = null;
    state.setupError = "";
    render();
    return;
  }

  try {
    state.setupBoard = ship
      ? placeShip(state.setupBoard, ship, coordinate, state.setupOrientation)
      : placeMarker(state.setupBoard, marker, coordinate);
    state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    state.setupHover = null;
    state.setupError = "";
    playHaptic("placement");
  } catch {
    state.setupError = "setup.invalidPlacement";
    playHaptic("invalid");
  }
  render();
}

function updateSetupHover(coordinate) {
  if (state.screen !== "setup" && state.screen !== "online") {
    return;
  }
  if (state.setupHover && sameCoordinate(state.setupHover, coordinate)) {
    return;
  }
  state.setupHover = coordinate;
  render();
}

function handleLocalShot(coordinate) {
  if (!state.game || state.game.phase !== "playing") {
    return;
  }

  playSound("shot");
  const playerId = state.game.currentPlayerId;
  const result = fireAt(state.game, playerId, coordinate);
  state.game = result.game;
  playShotOutcome(result.outcome.type);

  if (state.mode === "agent" && state.game.phase === "playing" && state.game.currentPlayerId === "p2") {
    playSound("turn");
    state.game = runAgentTurns(state.game);
  }

  if (state.mode === "hotseat" && state.game.phase === "playing" && state.game.currentPlayerId !== playerId) {
    state.passPlayerId = state.game.currentPlayerId;
    state.screen = "pass";
  }

  if (state.game.phase === "finished") {
    playFinalSound(state.game.winnerId, playerId);
    if (state.mode === "agent") {
      void recordCompletedBattle(
        completedBattleMatch({
          key: localResultKey(state.game),
          mode: "agent",
          presetId: state.game.presetId,
          playerId: "p1",
          winnerId: state.game.winnerId,
          opponent: "agent",
          log: state.game.log,
        }),
      );
    }
  }

  render();
}

function handleTrainingShot(coordinate) {
  const session = state.training.session;
  if (!session || session.phase !== "playing") {
    return;
  }

  playSound("shot");
  try {
    state.training.session = applyTrainingShot(session, coordinate);
    playShotOutcome(state.training.session.log.at(-1).result);
    if (state.training.session.phase === "finished") {
      saveTrainingProgress(state.training.session);
      playSound("victory");
      playHaptic("victory");
    }
  } catch {
    return;
  }
  render();
}

function saveTrainingProgress(session) {
  state.training.progress = updateTrainingProgress(state.training.progress, session);
  void preferenceCoordinator.write(
    trainingProgressSettingKey,
    JSON.stringify(state.training.progress),
  );
}

function runAgentTurns(game) {
  let nextGame = game;
  while (nextGame.phase === "playing" && nextGame.currentPlayerId === "p2") {
    const view = publicBoardView(nextGame.players.p1.board);
    const shot = chooseAgentShot({
      size: view.size,
      shots: view.shots,
      difficulty: state.agentDifficulty,
    });
    nextGame = fireAt(nextGame, "p2", shot).game;
  }
  return nextGame;
}

async function onlineCreate() {
  if (!requireOnline((message) => {
    state.online.error = message;
  })) return;
  if (!isOnlineAuthReady()) {
    state.online.error = translate("online.authRequired");
    render();
    return;
  }
  if (!hasFullFleet(state.setupBoard)) {
    state.online.error = translate("setup.needFleet");
    render();
    return;
  }
  await onlineClientCoordinator.run({
    handlers: remoteHandlers(),
    onStart: prepareOnlineConnection,
    async operation(client, isCurrent) {
      const session = await client.createRoom();
      if (!isCurrent()) return session;
      await client.send("placeFleet", { board: state.setupBoard, presetId: state.presetId });
      return session;
    },
    onSuccess(session) {
      state.online.session = session;
      state.online.roomCodeInput = session.roomCode;
      render();
    },
    onError: handleOnlineConnectionError,
  });
}

async function onlineJoin() {
  if (!requireOnline((message) => {
    state.online.error = message;
  })) return;
  if (!isOnlineAuthReady()) {
    state.online.error = translate("online.authRequired");
    render();
    return;
  }
  if (!hasFullFleet(state.setupBoard)) {
    state.online.error = translate("setup.needFleet");
    render();
    return;
  }
  const roomCode = state.online.roomCodeInput;
  await onlineClientCoordinator.run({
    handlers: remoteHandlers(),
    onStart: prepareOnlineConnection,
    async operation(client, isCurrent) {
      const session = await client.joinRoom(roomCode);
      if (!isCurrent()) return { session };
      const preset = getGamePreset(session.presetId || state.presetId);
      const board = preset.id === state.presetId
        ? state.setupBoard
        : randomlyPlaceSetup(preset);
      await client.send("placeFleet", { board, presetId: preset.id });
      return { session, preset, board };
    },
    onSuccess({ session, preset, board }) {
      state.online.session = session;
      state.presetId = preset.id;
      state.setupBoard = board;
      state.setupSelectedShipId = firstUnplacedShipId(board);
      render();
    },
    onError: handleOnlineConnectionError,
  });
}

function prepareOnlineConnection() {
  state.online.session = null;
  state.online.snapshot = null;
  state.online.status = "";
  state.online.error = "";
  render();
}

function handleOnlineConnectionError(error) {
  state.online.session = null;
  state.online.snapshot = null;
  state.online.status = "";
  state.online.error = error.message;
  render();
}

async function onlineRematch() {
  if (!requireOnline((message) => {
    state.online.error = message;
  })) return;
  await withOnlineError(async () => {
    const snapshot = state.online.snapshot;
    if (!state.online.client || !snapshot || snapshot.phase !== "finished") {
      throw new Error(translate("online.rematchUnavailable"));
    }
    const preset = getGamePreset(snapshot.presetId || state.presetId);
    state.presetId = preset.id;
    state.setupBoard = randomlyPlaceSetup(preset);
    state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    state.resultModalDismissed = onlineResultKey(snapshot);
    state.resultCopyStatus = "";
    resetResultReplayPlayback();
    await state.online.client.send("requestRematch", { board: state.setupBoard, presetId: preset.id });
    render();
  });
}

function handleOnlineShot(coordinate) {
  if (!requireOnline((message) => {
    state.online.error = message;
  })) return;
  playSound("shot");
  withOnlineError(async () => {
    await state.online.client.send("fire", { coordinate });
  });
}

async function copyRoomCode() {
  const roomCode = state.online.session?.roomCode ?? state.online.snapshot?.roomCode ?? "";
  if (!roomCode) {
    return;
  }
  try {
    await navigator.clipboard?.writeText(roomCode);
  } catch {}
  state.online.status = "copied";
  render();
}

async function copyBattleSummary() {
  const context = currentBattleResultContext();
  if (!context) {
    return;
  }
  const report = buildBattleReport(context.log, context.winnerId, context.playerId);
  const summaryText = buildBattleSummaryText(report, context);
  try {
    await navigator.clipboard?.writeText(summaryText);
  } catch {}
  state.resultCopyStatus = "copied";
  render();
}

function buildBattleSummaryText(report, context) {
  return translate("result.shareText", {
    app: translate("app.title"),
    mode: translate(`mode.${context.mode}`),
    preset: translate(`preset.${context.presetId}.name`),
    winner: playerName(context.winnerId),
    result: translate(`profile.result.${report.result}`),
    hits: report.player.hits,
    shots: report.player.shots,
    accuracy: report.player.accuracy,
    url: canonicalReplayBaseUrl,
  });
}

async function shareBattleSummary() {
  const context = currentBattleResultContext();
  if (!context) {
    return;
  }
  const report = buildBattleReport(context.log, context.winnerId, context.playerId);
  const summaryText = buildBattleSummaryText(report, context);
  const shared = await shareWithTelegramFallback(summaryText, canonicalReplayBaseUrl);
  state.resultCopyStatus = shared ? "" : "share-failed";
  render();
}

async function shareRoom() {
  const roomCode = state.online.session?.roomCode ?? state.online.snapshot?.roomCode ?? "";
  if (!roomCode) {
    return;
  }
  const showingResult = Boolean(currentBattleResultContext());
  const text = translate("online.shareText", { code: roomCode });
  const shared = await shareWithTelegramFallback(text, canonicalReplayBaseUrl);
  state.online.error = shared ? "" : translate("share.failed");
  if (showingResult) state.resultCopyStatus = shared ? "" : "share-failed";
  render();
}

async function shareWithTelegramFallback(text, url) {
  try {
    const result = await platform.share({
      title: translate("app.title"),
      text: text,
      url: url,
    });
    if (result.shared) return true;
    const telegramUrl = new URL("https://t.me/share/url");
    telegramUrl.searchParams.set("url", url);
    telegramUrl.searchParams.set("text", text);
    await platform.openExternalUrl(telegramUrl.toString());
    return true;
  } catch {
    return false;
  }
}

function selectBattleTab(tab) {
  if (!["target", "own", "log"].includes(tab)) {
    return;
  }
  state.battleTab = tab;
  render();
}

function remoteHandlers() {
  return {
    workerUrl: state.online.workerUrl,
    authToken: state.auth.token,
    onStatus(status) {
      state.online.status = status;
      render();
    },
    onError(error) {
      state.online.error = error.message;
      render();
    },
    onMessage(message) {
      if (message.type === "snapshot") {
        const finishedNow = state.online.snapshot?.phase !== "finished" && message.snapshot.phase === "finished";
        playOnlineSnapshotSounds(state.online.snapshot, message.snapshot);
        state.online.snapshot = message.snapshot;
        if (finishedNow && state.auth.user) {
          void refreshProfile();
        }
      }
      if (message.type === "error") {
        state.online.error = message.message;
      }
      render();
    },
  };
}

function mountTelegramLoginWidget() {
  if (platform.isNative() || state.auth.method !== "legacy") {
    return;
  }
  const slot = document.querySelector("#telegram-login-slot");
  if (!slot || !state.auth.consent || state.auth.user || state.auth.loading) {
    return;
  }
  if (!state.network.connected || navigator.onLine === false) {
    slot.textContent = `${translate("network.offline")} ${translate("network.retry")}`;
    return;
  }
  if (!state.auth.telegramBotUsername) {
    slot.textContent = translate("auth.notConfigured");
    return;
  }
  if (!isTelegramLoginOriginAllowed()) {
    slot.textContent = translate("auth.domainHint");
    return;
  }
  if (document.readyState !== "complete") {
    if (!telegramWidgetScheduled) {
      telegramWidgetScheduled = true;
      window.addEventListener(
        "load",
        () => {
          telegramWidgetScheduled = false;
          mountTelegramLoginWidget();
        },
        { once: true },
      );
    }
    return;
  }

  slot.innerHTML = "";
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.async = true;
  script.setAttribute("data-telegram-login", state.auth.telegramBotUsername);
  script.setAttribute("data-size", "medium");
  script.setAttribute("data-radius", "6");
  script.setAttribute("data-onauth", "onTelegramAuth(user)");
  slot.append(script);
}

function isTelegramLoginOriginAllowed() {
  return !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function authIdentity(user = state.auth.user) {
  return user?.provider && user?.id ? `${user.provider}:${user.id}` : "";
}

function captureAuthRequest() {
  return {
    epoch: authEpoch,
    token: state.auth.token,
    identity: authIdentity(),
  };
}

function currentAuthRequest() {
  return captureAuthRequest();
}

function beginPrivateRequest(owner) {
  abortPrivateRequest(owner);
  const controller = new AbortController();
  privateRequestControllers[owner] = controller;
  return controller;
}

function abortPrivateRequest(owner) {
  const controller = privateRequestControllers[owner];
  if (controller) {
    controller.abort();
  }
  privateRequestControllers[owner] = null;
}

function finishPrivateRequest(owner, controller) {
  if (privateRequestControllers[owner] === controller) {
    privateRequestControllers[owner] = null;
  }
}

function privateRequestIsCurrent(owner, controller) {
  return privateRequestControllers[owner] === controller && !controller.signal.aborted;
}

function abortAllPrivateRequests() {
  for (const owner of ["auth", "profile", "archive", "replay"]) {
    abortPrivateRequest(owner);
  }
  for (const controller of privateRequestControllers.saves) {
    controller.abort();
  }
  privateRequestControllers.saves.clear();
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function loadReplayArchive({ append = false } = {}) {
  state.screen = "archive";
  if (!state.auth.token || !state.auth.user || !state.auth.workerUrl) {
    abortPrivateRequest("archive");
    state.archive.loading = false;
    state.archive.error = "archive.signInRequired";
    render();
    return;
  }
  if (!requireOnline(() => {
    state.archive.loading = false;
    state.archive.error = "network.offline";
  })) return;
  const retry = state.archive.retrying
    ? archiveRetryOptions({ append: state.archive.retryAppend, cursor: state.archive.retryCursor })
    : null;
  state.archive.retrying = false;
  const appendRequest = retry ? retry.append : append;
  const requestCursor = appendRequest ? retry?.cursor || state.archive.nextCursor : "";
  if (appendRequest && !requestCursor) {
    return;
  }

  state.archive.loading = true;
  state.archive.error = "";
  state.archive.retryAppend = false;
  state.archive.retryCursor = "";
  state.archive.requestId += 1;
  const authRequest = captureAuthRequest();
  const controller = beginPrivateRequest("archive");
  const workerUrl = state.auth.workerUrl;
  const request = {
    token: authRequest.token,
    requestId: state.archive.requestId,
    replayId: "",
  };
  if (!appendRequest) {
    state.archive.items = [];
    state.archive.nextCursor = "";
  }
  render();

  try {
    const url = new URL(`${workerUrl}/profile/replays`);
    if (appendRequest) {
      url.searchParams.set("cursor", requestCursor);
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${authRequest.token}` },
      signal: controller.signal,
    });
    const payload = await readReplayJson(response);
    if (!archiveLoadIsCurrent(request, authRequest, controller)) {
      return;
    }
    if (!payload.archive || !Array.isArray(payload.archive.items)) {
      throw replayUnavailableError();
    }
    const items = payload.archive.items;
    state.archive.items = appendRequest ? uniqueArchiveItems([...state.archive.items, ...items]) : items;
    state.archive.nextCursor = payload.archive?.nextCursor || "";
    state.archive.retryAppend = false;
    state.archive.retryCursor = "";
  } catch (error) {
    if (isAbortError(error) || !archiveLoadIsCurrent(request, authRequest, controller)) {
      return;
    }
    if (error.status === 401) {
      await expireReplayAuthentication(authRequest);
      return;
    }
    state.archive.retryAppend = appendRequest;
    state.archive.retryCursor = requestCursor;
    state.archive.error = replayRequestErrorKey(error, "archive");
  } finally {
    if (archiveLoadIsCurrent(request, authRequest, controller)) {
      state.archive.loading = false;
      finishPrivateRequest("archive", controller);
      render();
    } else {
      finishPrivateRequest("archive", controller);
    }
  }
}

async function retryReplayArchive() {
  const retry = archiveRetryOptions({
    append: state.archive.retryAppend,
    cursor: state.archive.retryCursor,
  });
  state.archive.retryAppend = retry.append;
  state.archive.retryCursor = retry.cursor;
  state.archive.retrying = true;
  await loadReplayArchive({ append: retry.append });
}

async function loadArchivedReplay(id) {
  const replayId = replayIdFromSearch(`?replay=${encodeURIComponent(id || "")}`);
  if (!replayId) {
    state.replayArchive.error = "replayArchive.notFound";
    render();
    return;
  }
  if (state.replayArchive.requestedId !== replayId) {
    resetResultReplayPlayback();
  }
  state.screen = "replay";
  state.replayArchive.requestedId = replayId;
  state.replayArchive.copyStatus = "";
  if (!state.auth.token || !state.auth.user || !state.auth.workerUrl) {
    abortPrivateRequest("replay");
    state.replayArchive.loading = false;
    state.replayArchive.data = null;
    state.replayArchive.error = "replayArchive.signInRequired";
    render();
    return;
  }
  if (!requireOnline(() => {
    state.replayArchive.loading = false;
    state.replayArchive.data = null;
    state.replayArchive.error = "network.offline";
  })) return;

  resetResultReplayPlayback();
  state.replayArchive.loading = true;
  state.replayArchive.data = null;
  state.replayArchive.error = "";
  state.replayArchive.requestId += 1;
  const authRequest = captureAuthRequest();
  const controller = beginPrivateRequest("replay");
  const workerUrl = state.auth.workerUrl;
  const request = {
    token: authRequest.token,
    requestId: state.replayArchive.requestId,
    replayId,
  };
  render();
  try {
    const response = await fetch(`${workerUrl}/replays/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${authRequest.token}` },
      signal: controller.signal,
    });
    const payload = await readReplayJson(response);
    if (!archivedReplayLoadIsCurrent(request, authRequest, controller)) {
      return;
    }
    if (payload.replay?.id !== replayId) {
      throw replayUnavailableError();
    }
    state.replayArchive.data = payload.replay;
  } catch (error) {
    if (isAbortError(error) || !archivedReplayLoadIsCurrent(request, authRequest, controller)) {
      return;
    }
    if (error.status === 401) {
      await expireReplayAuthentication(authRequest);
      return;
    }
    state.replayArchive.error = replayRequestErrorKey(error, "replayArchive");
  } finally {
    if (archivedReplayLoadIsCurrent(request, authRequest, controller)) {
      state.replayArchive.loading = false;
      finishPrivateRequest("replay", controller);
      render();
    } else {
      finishPrivateRequest("replay", controller);
    }
  }
}

function archiveLoadIsCurrent(request, authRequest, controller) {
  return (
    replayRequestIsCurrent(request, currentArchiveRequest()) &&
    authRequestIsCurrent(authRequest, currentAuthRequest()) &&
    privateRequestIsCurrent("archive", controller)
  );
}

function archivedReplayLoadIsCurrent(request, authRequest, controller) {
  return (
    replayRequestIsCurrent(request, currentArchivedReplayRequest()) &&
    authRequestIsCurrent(authRequest, currentAuthRequest()) &&
    privateRequestIsCurrent("replay", controller)
  );
}

function currentArchiveRequest() {
  return {
    token: state.auth.token,
    requestId: state.archive.requestId,
    replayId: "",
  };
}

function currentArchivedReplayRequest() {
  return {
    token: state.auth.token,
    requestId: state.replayArchive.requestId,
    replayId: state.replayArchive.requestedId,
  };
}

async function resumeRequestedReplay() {
  if (!state.auth.user || !state.auth.token) {
    return;
  }
  if (state.replayArchive.requestedId) {
    await loadArchivedReplay(state.replayArchive.requestedId);
    return;
  }
  if (state.screen === "archive") {
    await loadReplayArchive();
  }
}

function uniqueArchiveItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

async function readReplayJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function replayUnavailableError() {
  const error = new Error("Replay response is unavailable");
  error.status = 503;
  return error;
}

function replayRequestErrorKey(error, scope) {
  if (error?.status === 401) return `${scope}.signInRequired`;
  if (error?.status === 403) return "replayArchive.forbidden";
  if (error?.status === 404) return "replayArchive.notFound";
  if (!error?.status) return `${scope}.network`;
  return `${scope}.unavailable`;
}

async function expireReplayAuthentication(request) {
  if (!authRequestIsCurrent(request, currentAuthRequest())) {
    return false;
  }
  await invalidateAuthSession({ preserveRequestedId: true });
  render();
  return true;
}

function clearPrivateReplayData({ preserveRequestedId = false } = {}) {
  abortPrivateRequest("archive");
  abortPrivateRequest("replay");
  const requestedId = preserveRequestedId ? state.replayArchive.requestedId : "";
  state.archive.items = [];
  state.archive.nextCursor = "";
  state.archive.loading = false;
  state.archive.error = "";
  state.archive.retryAppend = false;
  state.archive.retryCursor = "";
  state.archive.retrying = false;
  state.archive.requestId += 1;
  state.replayArchive.requestedId = requestedId;
  state.replayArchive.data = null;
  state.replayArchive.loading = false;
  state.replayArchive.error = "";
  state.replayArchive.copyStatus = "";
  state.replayArchive.openedFromArchive = false;
  state.replayArchive.requestId += 1;
}

async function establishAuthSession(token, user, isCurrent) {
  try {
    return await secureSessionCoordinator.establish(token, () => {
      applyAuthenticatedSession(token, user);
    }, { isCurrent: () => isCurrent() });
  } catch {
    throw Object.assign(new Error(translate("auth.secureStorageFailed")), {
      authKey: "auth.secureStorageFailed",
    });
  }
}

function applyAuthenticatedSession(token, user) {
  const identityChanged = authIdentity() !== authIdentity(user);
  authEpoch += 1;
  abortAllPrivateRequests();
  resetOnlineConnectionState();
  if (identityChanged) {
    resetResultReplayPlayback();
    resetProfile();
    clearPrivateReplayData({ preserveRequestedId: true });
  }
  state.auth.token = token;
  state.auth.user = user;
  state.auth.error = "";
  state.auth.loading = false;
  state.auth.opening = false;
  authCallbacksBlocked = true;
  activeAuthTicket = null;
}

async function invalidateAuthSession({ error = "", preserveRequestedId = true } = {}) {
  const invalidationEpoch = ++authEpoch;
  abortAllPrivateRequests();
  resetOnlineConnectionState();
  state.auth.loading = true;
  state.auth.error = "";
  state.profileOpen = false;
  render();
  try {
    return await secureSessionCoordinator.invalidate(() => {
      abortAllPrivateRequests();
      resetOnlineConnectionState();
      state.auth.token = "";
      state.auth.user = null;
      state.auth.error = error;
      state.auth.loading = false;
      state.auth.opening = false;
      activeAuthTicket = null;
      resetProfile();
      clearPrivateReplayData({ preserveRequestedId });
      resetResultReplayPlayback();
    });
  } catch (storageError) {
    reportRuntimeError(storageError);
    if (authEpoch === invalidationEpoch) {
      state.auth.loading = false;
      if (!state.auth.error) state.auth.error = translate("auth.secureStorageFailed");
      render();
    }
    return false;
  }
}

function authOperationIsCurrent(request, controller) {
  return (
    authRequestIsCurrent(request, currentAuthRequest()) &&
    privateRequestIsCurrent("auth", controller)
  );
}

async function handleAuthFailure(error, request, controller) {
  if (isAbortError(error) || !authOperationIsCurrent(request, controller)) {
    return false;
  }
  await invalidateAuthSession({ error: error.message, preserveRequestedId: true });
  render();
  return true;
}

async function startTelegramOidc() {
  if (!requireTelegramAuthConsent()) return false;
  const client = telegramAuthClient;
  const authPlatform = platform.isNative() ? platform.getPlatform() : "web";
  if (
    state.auth.method !== "oidc"
    || !client
    || (platform.isNative() && authPlatform !== "android")
  ) {
    state.auth.error = translate("auth.unavailable");
    render();
    return false;
  }
  if (!requireOnline(() => {
    state.auth.error = translate("auth.unavailable");
  })) return false;

  authCallbacksBlocked = false;
  activeAuthTicket = null;
  const request = captureAuthRequest();
  const controller = beginPrivateRequest("auth");
  let opened = false;
  state.auth.loading = true;
  state.auth.opening = true;
  state.auth.error = "";
  render();
  try {
    const { authorizationUrl } = await client.start(authPlatform, { signal: controller.signal });
    if (!authOperationIsCurrent(request, controller)) return false;
    await platform.openExternalUrl(authorizationUrl);
    if (!authOperationIsCurrent(request, controller)) return false;
    opened = true;
    render();
    return true;
  } catch {
    if (!authOperationIsCurrent(request, controller)) return false;
    state.auth.loading = false;
    state.auth.opening = false;
    state.auth.error = translate("auth.unavailable");
    render();
    return false;
  } finally {
    if (!opened) finishPrivateRequest("auth", controller);
  }
}

async function closeTelegramBrowser() {
  if (!platform.isNative() || typeof platform.closeExternalUrl !== "function") return;
  try {
    await platform.closeExternalUrl();
  } catch {
    // Browser cleanup must not prevent processing a validated callback.
  }
}

function cancelTelegramAuth() {
  if (state.auth.user || authCallbacksBlocked) return true;
  abortPrivateRequest("auth");
  activeAuthTicket = null;
  state.auth.loading = false;
  state.auth.opening = false;
  state.auth.error = translate("auth.cancelled");
  render();
  return true;
}

async function redeemTelegramTicket(ticket) {
  if (!requireTelegramAuthConsent()) return false;
  if (state.auth.user || authCallbacksBlocked || activeAuthTicket === ticket) return true;
  const client = telegramAuthClient;
  if (!client || !requireOnline(() => {
    state.auth.error = translate("auth.unavailable");
  })) {
    state.auth.loading = false;
    state.auth.opening = false;
    render();
    return true;
  }

  activeAuthTicket = ticket;
  const request = captureAuthRequest();
  const controller = beginPrivateRequest("auth");
  state.auth.loading = true;
  state.auth.opening = false;
  state.auth.error = "";
  render();
  try {
    const authPayload = await client.redeem(ticket, { signal: controller.signal });
    if (!authOperationIsCurrent(request, controller)) return true;
    const established = await establishAuthSession(
      authPayload.token,
      authPayload.user,
      () => authOperationIsCurrent(request, controller),
    );
    if (!established) return true;
    render();
    const sessionRequest = captureAuthRequest();
    await refreshProfile();
    if (authRequestIsCurrent(sessionRequest, currentAuthRequest())) {
      await resumeRequestedReplay();
    }
    return true;
  } catch (error) {
    if (!authOperationIsCurrent(request, controller)) return true;
    const errorKey = error?.authKey === "auth.secureStorageFailed"
      ? "auth.secureStorageFailed"
      : "auth.invalidTicket";
    await invalidateAuthSession({
      error: translate(errorKey),
      preserveRequestedId: true,
    });
    render();
    return true;
  } finally {
    if (activeAuthTicket === ticket) activeAuthTicket = null;
    if (privateRequestControllers.auth === controller) {
      state.auth.loading = false;
      state.auth.opening = false;
      finishPrivateRequest("auth", controller);
      render();
    }
  }
}

async function handleTelegramAuth(payload) {
  if (!requireTelegramAuthConsent()) return;
  if (!requireOnline((message) => {
    state.auth.error = message;
  })) return;
  const request = captureAuthRequest();
  const controller = beginPrivateRequest("auth");
  const workerUrl = state.auth.workerUrl;
  state.auth.loading = true;
  state.auth.error = "";
  render();
  try {
    const response = await fetch(`${workerUrl}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const authPayload = await readAuthJson(response);
    if (!authOperationIsCurrent(request, controller)) {
      return;
    }
    if (!authPayload.token || !authPayload.user) {
      throw new Error("Telegram authentication response is incomplete");
    }
    const established = await establishAuthSession(
      authPayload.token,
      authPayload.user,
      () => authOperationIsCurrent(request, controller),
    );
    if (!established) return;
    render();
    const sessionRequest = captureAuthRequest();
    await refreshProfile();
    if (authRequestIsCurrent(sessionRequest, currentAuthRequest())) {
      await resumeRequestedReplay();
    }
  } catch (error) {
    await handleAuthFailure(error, request, controller);
  } finally {
    if (authOperationIsCurrent(request, controller)) {
      state.auth.loading = false;
      finishPrivateRequest("auth", controller);
      render();
    } else {
      finishPrivateRequest("auth", controller);
    }
  }
}

function requireTelegramAuthConsent() {
  if (state.auth.consent) return true;
  state.auth.error = translate("auth.consentRequired");
  render();
  return false;
}

async function refreshAuth() {
  if (!state.auth.token || !state.auth.workerUrl) {
    return;
  }
  if (!requireOnline((message) => {
    state.auth.error = message;
  })) return;
  const request = captureAuthRequest();
  const controller = beginPrivateRequest("auth");
  const workerUrl = state.auth.workerUrl;
  state.auth.loading = true;
  state.auth.error = "";
  render();
  try {
    const response = await fetch(`${workerUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${request.token}` },
      signal: controller.signal,
    });
    const payload = await readAuthJson(response);
    if (!authOperationIsCurrent(request, controller)) {
      return;
    }
    if (!payload.user) {
      await invalidateAuthSession({ preserveRequestedId: true });
      render();
      return;
    }
    applyAuthenticatedSession(request.token, payload.user);
    render();
    const sessionRequest = captureAuthRequest();
    await refreshProfile();
    if (authRequestIsCurrent(sessionRequest, currentAuthRequest())) {
      await resumeRequestedReplay();
    }
  } catch (error) {
    await handleAuthFailure(error, request, controller);
  } finally {
    if (authOperationIsCurrent(request, controller)) {
      state.auth.loading = false;
      finishPrivateRequest("auth", controller);
      render();
    } else {
      finishPrivateRequest("auth", controller);
    }
  }
}

async function logoutAuth() {
  authCallbacksBlocked = true;
  activeAuthTicket = null;
  const token = state.auth.token;
  const workerUrl = state.auth.workerUrl;
  const invalidated = await invalidateAuthSession({ preserveRequestedId: true });
  render();
  if (!invalidated) return;
  if (token && workerUrl && requireOnline((message) => {
    state.auth.error = message;
  })) {
    await fetch(`${workerUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

async function refreshProfile({ renderWhenDone = true } = {}) {
  if (!state.auth.token || !state.auth.workerUrl || !state.auth.user) {
    resetProfile();
    return;
  }
  if (!requireOnline((message) => {
    state.profile.loading = false;
    state.profile.error = message;
  })) return;
  const request = captureAuthRequest();
  const controller = beginPrivateRequest("profile");
  const workerUrl = state.auth.workerUrl;
  state.profile.loading = true;
  state.profile.error = "";
  if (renderWhenDone) {
    render();
  }
  try {
    const response = await fetch(`${workerUrl}/profile/me`, {
      headers: { Authorization: `Bearer ${request.token}` },
      signal: controller.signal,
    });
    const payload = await readAuthJson(response);
    if (
      !authRequestIsCurrent(request, currentAuthRequest()) ||
      !privateRequestIsCurrent("profile", controller)
    ) {
      return;
    }
    state.profile.data = payload.profile;
    state.leaderboard.data = payload.profile?.leaderboard ?? state.leaderboard.data;
  } catch (error) {
    if (
      !isAbortError(error) &&
      authRequestIsCurrent(request, currentAuthRequest()) &&
      privateRequestIsCurrent("profile", controller)
    ) {
      state.profile.error = error.message;
    }
  } finally {
    if (
      authRequestIsCurrent(request, currentAuthRequest()) &&
      privateRequestIsCurrent("profile", controller)
    ) {
      state.profile.loading = false;
      finishPrivateRequest("profile", controller);
      if (renderWhenDone) {
        render();
      }
    } else {
      finishPrivateRequest("profile", controller);
    }
  }
}

async function recordCompletedBattle(match) {
  if (!match || !state.auth.token || !state.auth.user || !state.auth.workerUrl) {
    return;
  }
  if (state.profile.savedMatchKeys.has(match.id)) {
    return;
  }
  if (!requireOnline((message) => {
    state.profile.error = message;
  })) return;
  state.profile.savedMatchKeys.add(match.id);
  state.profile.saveMessage = "";
  const request = captureAuthRequest();
  const controller = new AbortController();
  const workerUrl = state.auth.workerUrl;
  privateRequestControllers.saves.add(controller);
  try {
    const response = await fetch(`${workerUrl}/profile/matches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(match),
      signal: controller.signal,
    });
    const payload = await readAuthJson(response);
    if (
      !authRequestIsCurrent(request, currentAuthRequest()) ||
      controller.signal.aborted ||
      !privateRequestControllers.saves.has(controller)
    ) {
      return;
    }
    state.profile.data = payload.profile;
    state.leaderboard.data = payload.profile?.leaderboard ?? state.leaderboard.data;
    state.profile.saveMessage = translate("profile.saved");
  } catch (error) {
    if (
      !isAbortError(error) &&
      authRequestIsCurrent(request, currentAuthRequest()) &&
      privateRequestControllers.saves.has(controller)
    ) {
      state.profile.error = translate("profile.saveError", { message: error.message });
    }
  } finally {
    const shouldRender =
      authRequestIsCurrent(request, currentAuthRequest()) &&
      !controller.signal.aborted &&
      privateRequestControllers.saves.has(controller);
    privateRequestControllers.saves.delete(controller);
    if (shouldRender) {
      render();
    }
  }
}

async function refreshLeaderboard({ renderWhenDone = true } = {}) {
  const workerUrl = state.online.workerUrl || state.auth.workerUrl;
  if (!workerUrl) {
    return;
  }
  if (!requireOnline((message) => {
    state.leaderboard.loading = false;
    state.leaderboard.error = message;
  })) return;
  state.leaderboard.loading = true;
  state.leaderboard.error = "";
  if (renderWhenDone) {
    render();
  }
  try {
    const response = await fetch(`${workerUrl}/leaderboard`);
    const payload = await readAuthJson(response);
    state.leaderboard.data = payload.leaderboard;
  } catch (error) {
    state.leaderboard.error = error.message;
  } finally {
    state.leaderboard.loading = false;
    if (renderWhenDone) {
      render();
    }
  }
}

function resetProfile() {
  abortPrivateRequest("profile");
  state.profileOpen = false;
  state.profile.data = null;
  state.profile.loading = false;
  state.profile.error = "";
  state.profile.saveMessage = "";
  state.profile.savedMatchKeys.clear();
}

async function readAuthJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function unlockAudio() {
  state.audioUnlocked = true;
  if (state.screen === "menu" && state.audioEnabled) {
    await audio.startMusic(true);
  }
}

function playSound(name) {
  void audio.play(name, state.audioEnabled && state.audioUnlocked);
}

function playHaptic(event) {
  if (!state.hapticsEnabled) return;
  observePlatformWrite(platform.haptic(event));
}

function playShotOutcome(result) {
  if (result === "miss" || result === "mine" || result === "sweeper") {
    playSound("miss");
  }
  if (result === "hit") {
    playSound("hit");
    playHaptic("hit");
  }
  if (result === "sunk") {
    playSound("sunk");
    playHaptic("sunk");
  }
}

function playFinalSound(winnerId, lastShooterId) {
  if (state.mode === "agent") {
    const result = winnerId === "p1" ? "victory" : "defeat";
    playSound(result);
    if (result === "victory") playHaptic("victory");
    if (result === "defeat") playHaptic("defeat");
    return;
  }
  const result = winnerId === lastShooterId ? "victory" : "defeat";
  playSound(result);
  if (result === "victory") playHaptic("victory");
  if (result === "defeat") playHaptic("defeat");
}

function playOnlineSnapshotSounds(previousSnapshot, nextSnapshot) {
  if (!previousSnapshot && nextSnapshot?.opponentJoined) {
    playSound("roomReady");
  }
  const previousLogLength = previousSnapshot?.log?.length ?? 0;
  const nextLog = nextSnapshot?.log ?? [];
  for (const entry of nextLog.slice(previousLogLength)) {
    if (entry.playerId === nextSnapshot.playerId) {
      playShotOutcome(entry.result);
    } else {
      playSound("shot");
      playShotOutcome(entry.result);
    }
  }
  if (previousSnapshot?.phase !== "finished" && nextSnapshot?.phase === "finished") {
    const result = nextSnapshot.winnerId === nextSnapshot.playerId ? "victory" : "defeat";
    playSound(result);
    if (result === "victory") playHaptic("victory");
    if (result === "defeat") playHaptic("defeat");
  }
}

function syncMenuMusic() {
  if (state.screen === "menu" && state.audioEnabled && state.audioUnlocked) {
    void audio.startMusic(true);
    return;
  }
  audio.stopMusic();
}

async function withOnlineError(action) {
  try {
    state.online.error = "";
    await action();
  } catch (error) {
    state.online.error = error.message;
    render();
  }
}

function closeRemote() {
  resetOnlineConnectionState();
}

function resetOnlineConnectionState() {
  onlineClientCoordinator.close();
  state.online.session = null;
  state.online.snapshot = null;
  state.online.status = "";
  state.online.error = "";
}

function currentPreset() {
  return getGamePreset(state.presetId);
}

function setupPieces(preset = currentPreset()) {
  return [...preset.fleet, ...(preset.markers ?? [])];
}

function setupPreview(origin = state.setupHover) {
  if (!origin) {
    return null;
  }
  const preset = currentPreset();
  const ship = preset.fleet.find((candidate) => candidate.id === state.setupSelectedShipId);
  const marker = (preset.markers ?? []).find((candidate) => candidate.id === state.setupSelectedShipId);
  const piece = ship ?? marker;
  if (!piece || isPiecePlaced(state.setupBoard, piece.id)) {
    return null;
  }

  const cells = ship ? shipPreviewCells(ship, origin) : [origin];
  const visibleCells = cells.filter(
    (cell) =>
      cell.row >= 0 &&
      cell.col >= 0 &&
      cell.row < state.setupBoard.size &&
      cell.col < state.setupBoard.size,
  );

  try {
    if (ship) {
      placeShip(state.setupBoard, ship, origin, state.setupOrientation);
    } else {
      placeMarker(state.setupBoard, marker, origin);
    }
    return { cells: visibleCells, valid: true };
  } catch {
    return { cells: visibleCells, valid: false };
  }
}

function shipPreviewCells(ship, origin) {
  return Array.from({ length: ship.length }, (_, index) => ({
    row: origin.row + (state.setupOrientation === "vertical" ? index : 0),
    col: origin.col + (state.setupOrientation === "horizontal" ? index : 0),
  }));
}

function setupPreviewClass(coordinate) {
  const preview = setupPreview();
  if (!preview?.cells.some((cell) => sameCoordinate(cell, coordinate))) {
    return "";
  }
  return preview.valid ? "placement-ok" : "placement-bad";
}

function sameCoordinate(first, second) {
  return first.row === second.row && first.col === second.col;
}

function coordinateKey(coordinate) {
  return `${coordinate.row}:${coordinate.col}`;
}

function gameOptions() {
  const preset = currentPreset();
  return {
    presetId: preset.id,
    rules: preset.rules,
  };
}

function hasFullFleet(board) {
  return hasCompleteSetup(board, currentPreset());
}

function firstUnplacedShipId(board) {
  return setupPieces().find((piece) => !isPiecePlaced(board, piece.id))?.id ?? "";
}

function isPiecePlaced(board, pieceId) {
  return (
    board.ships.some((ship) => ship.id === pieceId) ||
    (board.markers ?? []).some((marker) => marker.id === pieceId)
  );
}

function getTargetCell(board, coordinate) {
  const shot = board.shots.find((entry) => entry.row === coordinate.row && entry.col === coordinate.col);
  return {
    shipId: shot?.result === "sunk" ? shot.shipId ?? null : null,
    markerId: null,
    markerType: null,
    shot: shot?.result ?? null,
  };
}

function cellClass(cell, kind, board, coordinate) {
  const classes = [];
  if (kind === "setup") {
    const previewClass = setupPreviewClass(coordinate);
    if (previewClass) classes.push(previewClass);
  }
  if ((kind === "own" || kind === "setup") && cell.shipId) {
    classes.push("has-ship", ...shipEdgeClasses(board, coordinate));
  }
  if ((kind === "own" || kind === "setup") && isShipSpriteAnchor(board, coordinate)) {
    classes.push("ship-anchor");
  }
  if ((kind === "own" || kind === "setup") && cell.markerType) classes.push(`has-${cell.markerType}`);
  if (cell.shot) classes.push(cell.shot);
  if (cell.shot === "sunk") classes.push(...sunkEdgeClasses(board, coordinate, kind));
  return classes.join(" ");
}

function cellAriaLabel(cell, kind, row, columnLabel) {
  return [
    translate("board.row", { row: row + 1 }),
    translate("board.col", { col: columnLabel }),
    cellStateLabel(cell, kind),
  ].join(", ");
}

function cellStateLabel(cell, kind) {
  if (cell.shot) {
    return translate(`board.state.${cell.shot}`);
  }
  if ((kind === "own" || kind === "setup") && cell.shipId) {
    return translate("board.state.ship");
  }
  if ((kind === "own" || kind === "setup") && cell.markerType) {
    return translate(`board.state.${cell.markerType}`);
  }
  return translate("board.state.empty");
}

function cellContents(cell, kind, board, coordinate) {
  const text = cellText(cell, kind);
  return `
    ${shipSprite(cell, kind, board, coordinate)}
    ${markerSprite(cell, kind)}
    ${shotSprite(cell, kind, board, coordinate)}
    ${text ? `<span class="cell-symbol">${text}</span>` : ""}
  `;
}

function cellText(cell, kind) {
  if (cell.shot === "miss") return "•";
  if (cell.shot === "mine") return "!";
  if (cell.shot === "sweeper") return "^";
  if (cell.shot === "hit") return "×";
  if (cell.shot === "sunk") return "×";
  if ((kind === "own" || kind === "setup") && cell.markerType === "mine") return "!";
  if ((kind === "own" || kind === "setup") && cell.markerType === "sweeper") return "^";
  if ((kind === "own" || kind === "setup") && cell.shipId) return "";
  return "";
}

function shipSprite(cell, kind, board, coordinate) {
  const ship = visibleShipForCell(cell, kind, board, coordinate);
  if (!ship) {
    return "";
  }
  if (!sameCoordinate(shipStartCell(ship), coordinate)) {
    return "";
  }
  const orientation = shipOrientation(ship);
  const state = shipState(ship);
  const direction = orientation === "horizontal" ? "h" : "v";
  const path = assetUrl(
    `./assets/images/ships/ship-${ship.length}-${direction}-${state}.png`,
  );
  return `<span class="ship-sprite ship-sprite-${direction}" style="--ship-cells: ${ship.length}; --ship-image: url('${path}')" aria-hidden="true"></span>`;
}

function visibleShipForCell(cell, kind, board, coordinate) {
  if ((kind === "own" || kind === "setup") && cell.shipId) {
    return findShipForCoordinate(board, coordinate);
  }
  if ((kind === "target" || kind === "online-target" || kind === "training-target") && cell.shot === "sunk" && cell.shipId) {
    return findShipForCoordinate(board, coordinate) ?? findRevealedSunkShip(board, cell.shipId, coordinate);
  }
  return null;
}

function findRevealedSunkShip(board, shipId, coordinate) {
  const cells = (board.shots ?? [])
    .filter((shot) => shot.result === "sunk" && shot.shipId === shipId)
    .map(({ row, col }) => ({ row, col }));

  if (!cells.some((cell) => sameCoordinate(cell, coordinate))) {
    return null;
  }

  return {
    id: shipId,
    length: cells.length,
    cells,
    hits: cells.map((cell) => ({ ...cell })),
  };
}

function markerSprite(cell, kind) {
  if ((kind !== "own" && kind !== "setup") || !cell.markerType) {
    return "";
  }
  const path =
    cell.markerType === "mine"
      ? assetUrl("./assets/images/special/mine.png")
      : assetUrl("./assets/images/special/minesweeper-2-h-normal.png");
  return `<span class="marker-sprite marker-sprite-${cell.markerType}" style="--marker-image: url('${path}')" aria-hidden="true"></span>`;
}

function shotSprite(cell, kind, board, coordinate) {
  const paths = {
    miss: assetUrl("./assets/images/markers/miss-blue-dot.png"),
    hit: assetUrl("./assets/images/effects/hit-explosion-smoke.png"),
    sunk: assetUrl("./assets/images/effects/sunk-destruction-smoke.png"),
    mine: assetUrl("./assets/images/special/mine-triggered.png"),
    sweeper: assetUrl("./assets/images/special/mine-disabled.png"),
  };
  const path = paths[cell.shot];
  if (!path) {
    return "";
  }
  if (cell.shot === "sunk") {
    const ship = visibleShipForCell(cell, kind, board, coordinate);
    if (ship) {
      if (!sameCoordinate(shipStartCell(ship), coordinate)) {
        return "";
      }
      const direction = shipOrientation(ship) === "horizontal" ? "h" : "v";
      return `<span class="shot-sprite shot-sprite-sunk shot-sprite-ship-sunk shot-sprite-ship-${direction}" style="--ship-cells: ${ship.length}; --shot-image: url('${path}')" aria-hidden="true"></span>`;
    }
  }
  return `<span class="shot-sprite shot-sprite-${cell.shot}" style="--shot-image: url('${path}')" aria-hidden="true"></span>`;
}

function findShipForCoordinate(board, coordinate) {
  return board.ships.find((ship) =>
    ship.cells.some((cell) => cell.row === coordinate.row && cell.col === coordinate.col),
  );
}

function shipOrientation(ship) {
  if (ship.cells.length < 2) {
    return "horizontal";
  }
  return ship.cells.every((cell) => cell.row === ship.cells[0].row) ? "horizontal" : "vertical";
}

function shipStartCell(ship) {
  const orientation = shipOrientation(ship);
  return [...ship.cells].sort((first, second) =>
    orientation === "horizontal" ? first.col - second.col : first.row - second.row,
  )[0];
}

function isShipSpriteAnchor(board, coordinate) {
  const ship = findShipForCoordinate(board, coordinate);
  if (!ship) {
    return false;
  }
  const start = shipStartCell(ship);
  return start.row === coordinate.row && start.col === coordinate.col;
}

function shipState(ship) {
  if (
    ship.cells.every((cell) =>
      ship.hits.some((hit) => hit.row === cell.row && hit.col === cell.col),
    )
  ) {
    return "sunk";
  }
  return ship.hits.length > 0 ? "damaged" : "normal";
}

function readCoordinate(button) {
  return {
    row: Number(button.dataset.row),
    col: Number(button.dataset.col),
  };
}

function onlineStatusText(status) {
  const keys = {
    connecting: "online.connecting",
    connected: "online.connected",
    copied: "online.copied",
    disconnected: "online.disconnected",
  };
  return translate(keys[status] ?? "online.waiting");
}

function renderOnlineStatus(snapshot) {
  const lines = [];
  if (state.online.status) {
    lines.push(onlineStatusText(state.online.status));
  }
  if (snapshot) {
    lines.push(translate("online.youAre", { player: playerName(snapshot.playerId) }));
    if (snapshot.opponentUser) {
      lines.push(
        translate("online.opponent", {
          player: snapshot.opponentUser.name || snapshot.opponentUser.username || translate("game.player2"),
        }),
      );
    }
    if (snapshot.phase === "lobby") lines.push(translate("online.waiting"));
    if (snapshot.phase === "setup") lines.push(translate("online.setup"));
    if (snapshot.phase === "playing") {
      lines.push(snapshot.isYourTurn ? translate("online.yourTurn") : translate("online.theirTurn"));
      if (snapshot.rules?.salvo) {
        lines.push(translate("game.salvoShots", { count: snapshot.salvoRemaining ?? 1 }));
      }
    }
    if (snapshot.phase === "finished") {
      lines.push(translate("game.winner", { player: playerName(snapshot.winnerId) }));
      if (snapshot.rematch?.requestedByYou && !snapshot.rematch?.opponentRequested) {
        lines.push(translate("online.rematchWaiting"));
      }
      if (!snapshot.rematch?.requestedByYou && snapshot.rematch?.opponentRequested) {
        lines.push(translate("online.rematchOffered"));
      }
    }
  }

  return lines.map((line) => `<p class="status-line">${line}</p>`).join("");
}

function currentResultKey() {
  if (state.screen === "playing" && state.game?.phase === "finished") {
    return localResultKey(state.game);
  }
  if (state.screen === "online" && state.online.snapshot?.phase === "finished") {
    return onlineResultKey(state.online.snapshot);
  }
  return "";
}

function currentBattleResultContext() {
  if (state.screen === "playing" && state.game?.phase === "finished") {
    return {
      winnerId: state.game.winnerId,
      playerId: state.mode === "agent" ? "p1" : state.game.winnerId,
      log: state.game.log,
      mode: state.mode,
      presetId: state.game.presetId ?? state.presetId,
    };
  }
  const snapshot = state.online.snapshot;
  if (state.screen === "online" && snapshot?.phase === "finished") {
    return {
      winnerId: snapshot.winnerId,
      playerId: snapshot.playerId,
      log: snapshot.log ?? [],
      mode: "online",
      presetId: snapshot.presetId ?? state.presetId,
    };
  }
  return null;
}

function localResultKey(game) {
  return `local:${state.mode}:${game.winnerId}:${game.log.length}`;
}

function onlineResultKey(snapshot) {
  return `online:${snapshot.roomCode}:${snapshot.winnerId}:${snapshot.log?.length ?? 0}`;
}

function completedBattleMatch({ key, mode, presetId, playerId, winnerId, opponent, log }) {
  const summary = summarizeBattleLog(log, winnerId);
  const playerStats = summary.players.find((stats) => stats.playerId === playerId) ?? {
    shots: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
    accuracy: 0,
  };
  return {
    id: `${state.auth.user?.provider ?? "anon"}:${state.auth.user?.id ?? "anon"}:${key}`,
    mode,
    presetId,
    result: winnerId === playerId ? "win" : "loss",
    opponent,
    totalShots: summary.totalShots,
    playerShots: playerStats.shots,
    playerHits: playerStats.hits,
    playerMisses: playerStats.misses,
    playerSunk: playerStats.sunk,
    accuracy: playerStats.accuracy,
    turns: log.length,
    winnerId,
    playedAt: new Date().toISOString(),
  };
}

function sunkEdgeClasses(board, coordinate, kind) {
  const hasSunkNeighbor = (rowOffset, colOffset) => {
    const target = {
      row: coordinate.row + rowOffset,
      col: coordinate.col + colOffset,
    };
    if (target.row < 0 || target.col < 0 || target.row >= board.size || target.col >= board.size) {
      return false;
    }
    const cell = kind === "own" ? getCell(board, target) : getTargetCell(board, target);
    return cell.shot === "sunk";
  };

  return [
    hasSunkNeighbor(-1, 0) ? "" : "sunk-edge-top",
    hasSunkNeighbor(1, 0) ? "" : "sunk-edge-bottom",
    hasSunkNeighbor(0, -1) ? "" : "sunk-edge-left",
    hasSunkNeighbor(0, 1) ? "" : "sunk-edge-right",
  ].filter(Boolean);
}

function shipEdgeClasses(board, coordinate) {
  const cell = getCell(board, coordinate);
  if (!cell.shipId) {
    return [];
  }

  const hasSameShipNeighbor = (rowOffset, colOffset) => {
    const target = {
      row: coordinate.row + rowOffset,
      col: coordinate.col + colOffset,
    };
    if (target.row < 0 || target.col < 0 || target.row >= board.size || target.col >= board.size) {
      return false;
    }
    return getCell(board, target).shipId === cell.shipId;
  };

  return [
    hasSameShipNeighbor(-1, 0) ? "" : "ship-edge-top",
    hasSameShipNeighbor(1, 0) ? "" : "ship-edge-bottom",
    hasSameShipNeighbor(0, -1) ? "" : "ship-edge-left",
    hasSameShipNeighbor(0, 1) ? "" : "ship-edge-right",
  ].filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

window.addEventListener("popstate", (event) => {
  void handleReplayPopState(event);
});

if (new URLSearchParams(window.location.search).has("replay") && !initialRequestedReplayId) {
  updateReplayHistory("", "replace", "menu");
}

render();
const startup = startMobileApp();

return {
  getState: () => state,
  startup,
  stop: () => mobileRuntime.stop(),
};
}

if (typeof document !== "undefined") {
  bootSalvoApp();
}
