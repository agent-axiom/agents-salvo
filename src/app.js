import { chooseAgentShot } from "./core/ai.js";
import { createAudioController } from "./audio.js";
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
import { buildBattleReport, summarizeBattleLog } from "./core/stats.js";
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
import { RemoteClient } from "./remote.js";

const root = document.querySelector("#app");
const audio = createAudioController();
const authTokenStorageKey = "salvo.authToken";
const trainingProgressStorageKey = "salvo.trainingProgress";
let telegramWidgetScheduled = false;

const state = {
  language: getInitialLanguage(),
  theme: getInitialTheme(),
  visualStyle: getInitialVisualStyle(),
  audioEnabled: getInitialAudioEnabled(),
  audioUnlocked: false,
  settingsOpen: false,
  screen: "menu",
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
  agentDifficulty: "normal",
  passPlayerId: null,
  resultModalDismissed: null,
  auth: {
    workerUrl: window.SALVO_CONFIG?.workerUrl || "",
    telegramBotUsername: window.SALVO_CONFIG?.telegramBotUsername || "",
    token: getInitialAuthToken(),
    user: null,
    error: "",
    loading: false,
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
    progress: getInitialTrainingProgress(),
  },
};

function getInitialTheme() {
  const saved = localStorage.getItem("salvo.theme");
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialVisualStyle() {
  const saved = localStorage.getItem("salvo.visualStyle");
  if (saved === "classic" || saved === "render") {
    return saved;
  }
  return "render";
}

function getInitialAudioEnabled() {
  return localStorage.getItem("salvo.audio") !== "off";
}

function getInitialAuthToken() {
  return localStorage.getItem(authTokenStorageKey) || "";
}

function getInitialTrainingProgress() {
  try {
    const savedProgress = JSON.parse(localStorage.getItem(trainingProgressStorageKey) || "{}");
    return savedProgress && typeof savedProgress === "object" ? savedProgress : {};
  } catch {
    return {};
  }
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
  return Boolean(state.auth.user && state.auth.token && state.online.workerUrl);
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
        ${renderSettingsPanel()}
      </header>
      ${renderScreen()}
    </main>
  `;
  mountTelegramLoginWidget();
  syncMenuMusic();
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
    <button class="topbar-profile" data-action="refresh-profile">
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
          <button class="icon-button auth-logout" data-action="auth-logout" aria-label="${translate("auth.logout")}">×</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="auth-control">
      <span>${translate("auth.label")}</span>
      <div id="telegram-login-slot" class="telegram-login-slot" aria-label="${translate("auth.telegram")}"></div>
      ${state.auth.loading ? `<small>${translate("auth.loading")}</small>` : ""}
      ${state.auth.error ? `<small class="auth-error">${translate("auth.error", { message: state.auth.error })}</small>` : ""}
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
        ${renderCompactProfile()}
        ${renderPublicLeaderboard()}
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

function renderPublicLeaderboard() {
  const leaderboard = state.leaderboard.data ?? state.profile.data?.leaderboard;
  const entries = leaderboard?.entries ?? [];
  return `
    <section class="public-leaderboard">
      <div class="public-leaderboard-header">
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

function renderCompactProfile() {
  if (!state.auth.user) {
    return `
      <section class="profile-compact">
        <div>
          <span>${translate("profile.title")}</span>
          <p>${translate("profile.loginPrompt")}</p>
        </div>
        <button data-action="toggle-settings">${translate("auth.telegram")}</button>
      </section>
    `;
  }

  const profile = state.profile.data;
  const summary = profile?.summary;
  const rating = profile?.rating;
  return `
    <section class="profile-compact">
      <div>
        <span>${translate("profile.title")}</span>
        <h3>${escapeHtml(state.auth.user.name || translate("auth.telegram"))}</h3>
        <p>${translate("profile.compactStats", {
          wins: summary?.wins ?? 0,
          rating: rating?.onlineMatches ? rating.mmr : "—",
        })}</p>
      </div>
      <button data-action="refresh-profile">${translate("profile.refresh")}</button>
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
                .map(
                  (match) => `
                    <li>
                      <strong>${translate(`profile.result.${match.result}`)}</strong>
                      <span>${translate(`mode.${match.mode}`)} · ${translate(`preset.${match.presetId}.name`)}</span>
                      <small>${match.playerShots} / ${match.accuracy}%</small>
                    </li>
                  `,
                )
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
    return "./assets/salvo-board-action.png";
  }
  return state.theme === "dark"
    ? "./assets/images/backgrounds/main-menu-hero-dark-no-ui.png"
    : "./assets/images/backgrounds/main-menu-hero-no-ui.png";
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
          <button class="primary-button" data-action="randomize">${translate("setup.randomize")}</button>
          <button class="secondary-button" data-action="reset">${translate("setup.reset")}</button>
          <button data-action="ready" ${readyDisabled}>
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
          <button class="primary-button" data-action="randomize">${translate("setup.randomize")}</button>
          <button class="secondary-button" data-action="reset">${translate("setup.reset")}</button>
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
  });
}

function renderBattlefield({ ownBoard, targetBoard, targetKind, targetDisabled, log, salvoRemaining = 1 }) {
  const activeTab = state.battleTab || "target";
  return `
    <div class="battlefield target-first" data-active-tab="${activeTab}">
      <div class="battle-tabs" role="tablist" aria-label="${translate("battle.tabs")}">
        ${renderBattleTab("target", "game.target", activeTab)}
        ${renderBattleTab("own", "game.yourFleet", activeTab)}
        ${renderBattleTab("log", "log.title", activeTab)}
      </div>
      <div class="target-primary battle-tab-panel" data-panel="target">
        ${renderTacticalAdvisor(targetBoard, { disabled: targetDisabled, salvoRemaining })}
        ${renderBoard(targetBoard, {
          kind: targetKind,
          title: translate("game.target"),
          disabled: targetDisabled,
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

function renderTacticalAdvisor(targetBoard, { disabled = false, salvoRemaining = 1 } = {}) {
  const analysis = analyzeTargetBoard(targetBoard, { salvoRemaining });
  const priority = analysis.priorityTargets.length
    ? analysis.priorityTargets.slice(0, 3).map(formatCoordinate).join(" · ")
    : translate("tactics.noPriority");
  return `
    <section class="tactical-advisor ${disabled ? "is-paused" : ""}" aria-label="${translate("tactics.title")}">
      <div class="tactical-advisor-heading">
        <span>${translate("tactics.title")}</span>
        <strong>${translate(`tactics.recommendation.${analysis.recommendationId}`)}</strong>
      </div>
      <div class="tactical-stats">
        ${renderTacticalStat("tactics.targets", analysis.availableTargets)}
        ${renderTacticalStat("tactics.unresolved", analysis.unresolvedHits)}
        ${renderTacticalStat("tactics.priority", priority)}
        ${analysis.salvoRemaining > 1 ? renderTacticalStat("tactics.salvo", analysis.salvoRemaining) : ""}
      </div>
    </section>
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
        ${renderOnlineRatingChange(ratingChange)}
        <div class="button-row">
          <button data-action="close-result">${translate("result.inspect")}</button>
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

function renderBattleCoaching(coaching, trainingPlan) {
  if (!coaching) {
    return "";
  }
  const trainingPlanSteps =
    Array.isArray(trainingPlan?.steps) && trainingPlan.steps.length
      ? trainingPlan.steps
      : [{ drillId: coaching.drillId, focusId: coaching.focusId, reasonId: coaching.diagnosisId }];
  return `
    <section class="battle-coaching">
      <span>${translate("coaching.title")}</span>
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
    </section>
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

function renderBoard(board, { kind, title, disabled = false }) {
  const columnLabels = Array.from({ length: board.size }, (_, index) =>
    coordinateColumnLabel(state.language, index),
  );
  return `
    <section class="board-panel">
      <div class="board-title">
        <h3>${title}</h3>
      </div>
      <div class="coordinate-board">
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
            return `<button
              class="cell ${cellClass(cell, kind, board, coordinate)}"
              data-action="${kind === "target" ? "shot" : kind === "online-target" ? "online-shot" : kind === "training-target" ? "training-shot" : kind === "setup" ? "setup-cell" : ""}"
              data-row="${row}"
              data-col="${col}"
              aria-label="${label}"
              ${buttonDisabled ? "disabled" : ""}
            >${cellContents(cell, kind, board, coordinate)}</button>`;
          }).join("")}
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

root.addEventListener("change", (event) => {
  const action = event.target.dataset.action;
  if (action === "language") {
    state.language = event.target.value;
    localStorage.setItem("salvo.language", state.language);
    render();
  }
  if (action === "agent-difficulty") {
    state.agentDifficulty = event.target.value;
  }
});

root.addEventListener("input", (event) => {
  updateOnlineInput(event.target);
});

root.addEventListener("change", (event) => {
  updateOnlineInput(event.target);
});

function updateOnlineInput(target) {
  const action = target.dataset.action;
  if (action === "room-code") {
    state.online.roomCodeInput = target.value.trim().toUpperCase();
  }
}

root.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
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
  if (action === "audio-toggle") toggleAudio();
  if (action === "theme-toggle") toggleTheme();
  if (action === "visual-style-toggle") toggleVisualStyle();
  if (action === "menu") goToMenu();
  if (action === "new-game") startSetup(state.mode);
  if (action === "online-new-game") showOnline();
  if (action === "close-result") closeResultModal();
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
  if (action === "share-telegram") shareRoomInTelegram();
  if (action === "battle-tab") selectBattleTab(button.dataset.tab);
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

root.addEventListener("focusin", (event) => {
  const cell = event.target.closest('.setup .cell[data-action="setup-cell"]');
  if (cell) {
    updateSetupHover(readCoordinate(cell));
  }
});

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
  state.resultModalDismissed = null;
  render();
}

function showOnline() {
  closeRemote();
  state.settingsOpen = false;
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
  state.resultModalDismissed = null;
  render();
}

function startTraining(scenarioId = state.training.scenarioId) {
  closeRemote();
  state.settingsOpen = false;
  state.mode = "training";
  state.screen = "training";
  state.training.scenarioId = scenarioId || "checkerboard";
  state.training.session = createTrainingSession(state.training.scenarioId);
  state.resultModalDismissed = null;
  render();
}

function goToMenu() {
  closeRemote();
  state.settingsOpen = false;
  state.screen = "menu";
  state.mode = null;
  state.game = null;
  state.training.session = null;
  state.online.error = "";
  state.online.status = "";
  state.resultModalDismissed = null;
  render();
}

function toggleSettings() {
  state.settingsOpen = !state.settingsOpen;
  render();
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("salvo.theme", state.theme);
  render();
}

function toggleVisualStyle() {
  state.visualStyle = state.visualStyle === "classic" ? "render" : "classic";
  localStorage.setItem("salvo.visualStyle", state.visualStyle);
  render();
}

function toggleAudio() {
  state.audioEnabled = !state.audioEnabled;
  localStorage.setItem("salvo.audio", state.audioEnabled ? "on" : "off");
  if (state.audioEnabled) {
    playSound("ui");
  } else {
    audio.stopMusic();
  }
  render();
}

function closeResultModal() {
  const resultKey = currentResultKey();
  if (resultKey) {
    state.resultModalDismissed = resultKey;
  }
  render();
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
  } catch {
    state.setupError = "setup.invalidPlacement";
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
    }
  } catch {
    return;
  }
  render();
}

function saveTrainingProgress(session) {
  state.training.progress = updateTrainingProgress(state.training.progress, session);
  try {
    localStorage.setItem(trainingProgressStorageKey, JSON.stringify(state.training.progress));
  } catch {
    // Training should continue even when local storage is blocked.
  }
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
  await withOnlineError(async () => {
    if (!isOnlineAuthReady()) {
      state.online.error = translate("online.authRequired");
      render();
      return;
    }
    if (!hasFullFleet(state.setupBoard)) {
      throw new Error(translate("setup.needFleet"));
    }
    state.online.client = new RemoteClient(remoteHandlers());
    state.online.session = await state.online.client.createRoom();
    state.online.roomCodeInput = state.online.session.roomCode;
    await state.online.client.send("placeFleet", { board: state.setupBoard, presetId: state.presetId });
    render();
  });
}

async function onlineJoin() {
  await withOnlineError(async () => {
    if (!isOnlineAuthReady()) {
      state.online.error = translate("online.authRequired");
      render();
      return;
    }
    if (!hasFullFleet(state.setupBoard)) {
      throw new Error(translate("setup.needFleet"));
    }
    state.online.client = new RemoteClient(remoteHandlers());
    state.online.session = await state.online.client.joinRoom(state.online.roomCodeInput);
    if (state.online.session.presetId && state.online.session.presetId !== state.presetId) {
      state.presetId = state.online.session.presetId;
      state.setupBoard = randomlyPlaceSetup(currentPreset());
      state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    }
    await state.online.client.send("placeFleet", { board: state.setupBoard, presetId: state.presetId });
    render();
  });
}

async function onlineRematch() {
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
    await state.online.client.send("requestRematch", { board: state.setupBoard, presetId: preset.id });
    render();
  });
}

function handleOnlineShot(coordinate) {
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

function shareRoomInTelegram() {
  const roomCode = state.online.session?.roomCode ?? state.online.snapshot?.roomCode ?? "";
  if (!roomCode) {
    return;
  }
  const text = translate("online.shareText", { code: roomCode });
  const url = new URL("https://t.me/share/url");
  url.searchParams.set("url", window.location.href);
  url.searchParams.set("text", text);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
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
  const slot = document.querySelector("#telegram-login-slot");
  if (!slot || state.auth.user || state.auth.loading) {
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

async function handleTelegramAuth(payload) {
  await withAuthError(async () => {
    const response = await fetch(`${state.auth.workerUrl}/auth/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const authPayload = await readAuthJson(response);
    state.auth.token = authPayload.token;
    state.auth.user = authPayload.user;
    localStorage.setItem(authTokenStorageKey, state.auth.token);
    await refreshProfile({ renderWhenDone: false });
  });
}

async function refreshAuth() {
  if (!state.auth.token || !state.auth.workerUrl) {
    return;
  }
  await withAuthError(async () => {
    const response = await fetch(`${state.auth.workerUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${state.auth.token}` },
    });
    const payload = await readAuthJson(response);
    state.auth.user = payload.user;
    if (!payload.user) {
      state.auth.token = "";
      localStorage.removeItem(authTokenStorageKey);
      resetProfile();
    } else {
      await refreshProfile({ renderWhenDone: false });
    }
  });
}

async function logoutAuth() {
  await withAuthError(async () => {
    if (state.auth.token && state.auth.workerUrl) {
      await fetch(`${state.auth.workerUrl}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.auth.token}` },
      }).catch(() => {});
    }
    state.auth.token = "";
    state.auth.user = null;
    resetProfile();
    localStorage.removeItem(authTokenStorageKey);
  });
}

async function refreshProfile({ renderWhenDone = true } = {}) {
  if (!state.auth.token || !state.auth.workerUrl || !state.auth.user) {
    resetProfile();
    return;
  }
  state.profile.loading = true;
  state.profile.error = "";
  if (renderWhenDone) {
    render();
  }
  try {
    const response = await fetch(`${state.auth.workerUrl}/profile/me`, {
      headers: { Authorization: `Bearer ${state.auth.token}` },
    });
    const payload = await readAuthJson(response);
    state.profile.data = payload.profile;
    state.leaderboard.data = payload.profile?.leaderboard ?? state.leaderboard.data;
  } catch (error) {
    state.profile.error = error.message;
  } finally {
    state.profile.loading = false;
    if (renderWhenDone) {
      render();
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
  state.profile.savedMatchKeys.add(match.id);
  state.profile.saveMessage = "";
  try {
    const response = await fetch(`${state.auth.workerUrl}/profile/matches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(match),
    });
    const payload = await readAuthJson(response);
    state.profile.data = payload.profile;
    state.leaderboard.data = payload.profile?.leaderboard ?? state.leaderboard.data;
    state.profile.saveMessage = translate("profile.saved");
  } catch (error) {
    state.profile.error = translate("profile.saveError", { message: error.message });
  }
  render();
}

async function refreshLeaderboard({ renderWhenDone = true } = {}) {
  const workerUrl = state.online.workerUrl || state.auth.workerUrl;
  if (!workerUrl) {
    return;
  }
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
  state.profile.data = null;
  state.profile.loading = false;
  state.profile.error = "";
  state.profile.saveMessage = "";
  state.profile.savedMatchKeys.clear();
}

async function withAuthError(action) {
  state.auth.loading = true;
  state.auth.error = "";
  render();
  try {
    await action();
  } catch (error) {
    state.auth.error = error.message;
    state.auth.token = "";
    state.auth.user = null;
    resetProfile();
    localStorage.removeItem(authTokenStorageKey);
  } finally {
    state.auth.loading = false;
    render();
  }
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

function playShotOutcome(result) {
  if (result === "miss" || result === "mine" || result === "sweeper") {
    playSound("miss");
  }
  if (result === "hit") {
    playSound("hit");
  }
  if (result === "sunk") {
    playSound("sunk");
  }
}

function playFinalSound(winnerId, lastShooterId) {
  if (state.mode === "agent") {
    playSound(winnerId === "p1" ? "victory" : "defeat");
    return;
  }
  playSound(winnerId === lastShooterId ? "victory" : "defeat");
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
    playSound(nextSnapshot.winnerId === nextSnapshot.playerId ? "victory" : "defeat");
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
  state.online.client?.close();
  state.online.client = null;
  state.online.session = null;
  state.online.snapshot = null;
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
  const path = `./assets/images/ships/ship-${ship.length}-${direction}-${state}.png`;
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
      ? "./assets/images/special/mine.png"
      : "./assets/images/special/minesweeper-2-h-normal.png";
  return `<span class="marker-sprite marker-sprite-${cell.markerType}" style="--marker-image: url('${path}')" aria-hidden="true"></span>`;
}

function shotSprite(cell, kind, board, coordinate) {
  const paths = {
    miss: "./assets/images/markers/miss-blue-dot.png",
    hit: "./assets/images/effects/hit-explosion-smoke.png",
    sunk: "./assets/images/effects/sunk-destruction-smoke.png",
    mine: "./assets/images/special/mine-triggered.png",
    sweeper: "./assets/images/special/mine-disabled.png",
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

render();
void refreshAuth();
void refreshLeaderboard();
