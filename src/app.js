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
import { summarizeBattleLog } from "./core/stats.js";
import { coordinateColumnLabel, getInitialLanguage, languages, t } from "./i18n.js";
import { RemoteClient } from "./remote.js";

const root = document.querySelector("#app");
const audio = createAudioController();
const authTokenStorageKey = "salvo.authToken";
let telegramWidgetScheduled = false;

const state = {
  language: getInitialLanguage(),
  theme: getInitialTheme(),
  visualStyle: getInitialVisualStyle(),
  audioEnabled: getInitialAudioEnabled(),
  audioUnlocked: false,
  screen: "menu",
  mode: null,
  presetId: "classic",
  setupPlayerId: "p1",
  setupBoard: randomlyPlaceSetup(getGamePreset("classic")),
  setupOrientation: "horizontal",
  setupSelectedShipId: "",
  setupError: "",
  boards: { p1: null, p2: null },
  game: null,
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
  online: {
    workerUrl: window.SALVO_CONFIG?.workerUrl || "",
    roomCodeInput: "",
    status: "",
    error: "",
    session: null,
    snapshot: null,
    client: null,
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
  return "classic";
}

function getInitialAudioEnabled() {
  return localStorage.getItem("salvo.audio") !== "off";
}

function getInitialAuthToken() {
  return localStorage.getItem(authTokenStorageKey) || "";
}

function translate(key, params) {
  return t(state.language, key, params);
}

function playerName(playerId) {
  if (playerId === "p1") {
    return translate("game.player1");
  }
  if (state.mode === "agent" && playerId === "p2") {
    return translate("game.agent");
  }
  return translate("game.player2");
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
        <div class="topbar-controls">
          <div class="audio-control">
            <span>${translate("audio.label")}</span>
            <button
              class="audio-toggle ${state.audioEnabled ? "is-on" : ""}"
              data-action="audio-toggle"
              aria-pressed="${state.audioEnabled}"
              aria-label="${translate("audio.label")}: ${translate(state.audioEnabled ? "audio.on" : "audio.off")}"
            >
              <span class="audio-toggle-icon" aria-hidden="true"></span>
              <strong>${translate(state.audioEnabled ? "audio.on" : "audio.off")}</strong>
            </button>
          </div>
          <div class="theme-control">
            <span>${translate("theme.label")}</span>
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
          <div class="visual-style-control">
            <span>${translate("visualStyle.label")}</span>
            <button
              class="visual-style-toggle ${state.visualStyle === "render" ? "is-render" : ""}"
              data-action="visual-style-toggle"
              aria-pressed="${state.visualStyle === "render"}"
              aria-label="${translate("visualStyle.label")}: ${translate(state.visualStyle === "render" ? "visualStyle.render" : "visualStyle.classic")}"
            >
              <span class="visual-style-toggle-icon" aria-hidden="true"></span>
              <strong>${translate(state.visualStyle === "render" ? "visualStyle.render" : "visualStyle.classic")}</strong>
            </button>
          </div>
          <label class="language-control">
            <span>${translate("nav.language")}</span>
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
        </div>
      </header>
      ${renderScreen()}
    </main>
  `;
  mountTelegramLoginWidget();
  syncMenuMusic();
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
  return renderMenu();
}

function renderMenu() {
  return `
    <section class="mode-layout">
      <div class="mode-panel">
        <div class="section-heading">
          <span>${translate("nav.mode")}</span>
          <h2>${translate("mode.choose")}</h2>
        </div>
        ${renderPresetSelector()}
        <div class="mode-grid">
          <button class="mode-button" data-action="start-hotseat">
            <span class="mode-icon ship-icon" aria-hidden="true"></span>
            <strong>${translate("mode.hotseat")}</strong>
          </button>
          <button class="mode-button" data-action="start-agent">
            <span class="mode-icon radar-icon" aria-hidden="true"></span>
            <strong>${translate("mode.agent")}</strong>
          </button>
          <button class="mode-button" data-action="show-online">
            <span class="mode-icon signal-icon" aria-hidden="true"></span>
            <strong>${translate("mode.online")}</strong>
          </button>
        </div>
        <section class="history-panel">
          <span>${translate("history.kicker")}</span>
          <h3>${translate("history.title")}</h3>
          <p>${translate("history.body")}</p>
          <p>${translate("history.body2")}</p>
          <a href="${translate("history.sourceUrl")}" target="_blank" rel="noreferrer">${translate("history.source")}</a>
        </section>
      </div>
      <figure class="fleet-visual">
        <img src="${menuArtworkSource()}" alt="${translate("art.alt")}" loading="lazy" decoding="async">
      </figure>
    </section>
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
      : translate("setup.player", { player: state.setupPlayerId === "p1" ? "1" : "2" });
  const readyDisabled = hasFullFleet(state.setupBoard) ? "" : "disabled";

  return `
    <section class="play-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("setup.title")}</span>
          <h2>${title}</h2>
        </div>
        <p class="status-line">${translate(`preset.${state.presetId}.name`)}</p>
        ${
          state.mode === "agent"
            ? `<label class="stacked-field">
                <span>${translate("agent.difficulty")}</span>
                <select data-action="agent-difficulty">
                  <option value="easy" ${state.agentDifficulty === "easy" ? "selected" : ""}>${translate("agent.easy")}</option>
                  <option value="normal" ${state.agentDifficulty === "normal" ? "selected" : ""}>${translate("agent.normal")}</option>
                </select>
              </label>`
            : ""
        }
        ${renderSetupTools()}
        <div class="button-row">
          <button data-action="randomize">${translate("setup.randomize")}</button>
          <button class="secondary-button" data-action="reset">${translate("setup.reset")}</button>
        </div>
        <button class="primary-button" data-action="ready" ${readyDisabled}>
          ${readyDisabled ? translate("setup.needFleet") : translate("setup.ready")}
        </button>
      </aside>
      <section class="board-stage">
        ${renderBoard(state.setupBoard, { kind: "setup", title })}
      </section>
    </section>
  `;
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
  const currentPlayerId = state.game.currentPlayerId;
  const opponentId = currentPlayerId === "p1" ? "p2" : "p1";
  const ownBoard = state.game.players[currentPlayerId].board;
  const targetBoard = state.game.players[opponentId].board;
  const status = gameStatusText(state.game);

  return `
    <section class="play-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("nav.mode")}</span>
          <h2>${status}</h2>
        </div>
        <button class="primary-button" data-action="new-game">${translate("game.restart")}</button>
      </aside>
      <section class="board-stage">
        ${renderBattlefield({
          ownBoard,
          targetBoard,
          targetKind: "target",
          targetDisabled: state.game.phase === "finished",
          log: state.game.log,
        })}
      </section>
      ${renderLocalResultModal()}
    </section>
  `;
}

function renderOnline() {
  const snapshot = state.online.snapshot;
  return `
    <section class="play-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("nav.mainMenu")}</button>
        <div class="section-heading">
          <span>${translate("mode.online")}</span>
          <h2>${translate("online.title")}</h2>
        </div>
        <p class="status-line">${translate(`preset.${state.presetId}.name`)}</p>
        ${snapshot ? "" : renderSetupTools()}
        ${
          snapshot
            ? ""
            : `<div class="button-row">
                <button data-action="randomize">${translate("setup.randomize")}</button>
                <button class="secondary-button" data-action="reset">${translate("setup.reset")}</button>
              </div>`
        }
        <div class="button-row">
          <button class="primary-button" data-action="online-create">${translate("online.create")}</button>
        </div>
        <label class="stacked-field">
          <span>${translate("online.roomCode")}</span>
          <input data-action="room-code" value="${escapeHtml(state.online.roomCodeInput)}" />
        </label>
        <button data-action="online-join">${translate("online.join")}</button>
        ${state.online.session ? `<p class="room-code">${state.online.session.roomCode}</p>` : ""}
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
  });
}

function renderBattlefield({ ownBoard, targetBoard, targetKind, targetDisabled, log }) {
  return `
    <div class="two-boards battlefield">
      <div class="board-stack">
        ${renderBoard(ownBoard, { kind: "own", title: translate("game.yourFleet") })}
      </div>
      <div class="target-stack">
        ${renderBoard(targetBoard, {
          kind: targetKind,
          title: translate("game.target"),
          disabled: targetDisabled,
        })}
        ${renderLog(log)}
      </div>
    </div>
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
    log: snapshot.log ?? [],
    newGameAction: "online-new-game",
  });
}

function renderResultModal({ winnerId, log, newGameAction }) {
  const summary = summarizeBattleLog(log, winnerId);
  const stats = summary.winner;
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
        <div class="button-row">
          <button data-action="close-result">${translate("result.inspect")}</button>
          <button class="primary-button" data-action="${newGameAction}">${translate("game.restart")}</button>
        </div>
      </section>
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
            const label = `${translate("board.row", { row: row + 1 })}, ${translate("board.col", { col: columnLabels[col] })}`;
            const buttonDisabled = disabled || kind === "own" || cell.shot;
            return `<button
              class="cell ${cellClass(cell, kind, board, coordinate)}"
              data-action="${kind === "target" ? "shot" : kind === "online-target" ? "online-shot" : kind === "setup" ? "setup-cell" : ""}"
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
                  `<li><span>${playerName(entry.playerId)}</span><strong>${translate(`shot.${entry.result}`)}</strong><small>${coordinateColumnLabel(state.language, entry.coordinate.col)}${entry.coordinate.row + 1}</small></li>`,
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
  if (action === "start-hotseat") startSetup("hotseat");
  if (action === "start-agent") startSetup("agent");
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
  if (action === "continue-pass") continueAfterPass();
  if (action === "setup-cell") handleSetupCell(readCoordinate(button));
  if (action === "shot") handleLocalShot(readCoordinate(button));
  if (action === "online-shot") handleOnlineShot(readCoordinate(button));
  if (action === "online-create") await onlineCreate();
  if (action === "online-join") await onlineJoin();
  if (action === "auth-logout") await logoutAuth();
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
  render();
}

function startSetup(mode) {
  closeRemote();
  state.mode = mode;
  state.screen = "setup";
  state.setupPlayerId = "p1";
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupOrientation = "horizontal";
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupError = "";
  state.boards = { p1: null, p2: null };
  state.game = null;
  state.resultModalDismissed = null;
  render();
}

function showOnline() {
  closeRemote();
  state.mode = "online";
  state.screen = "online";
  state.setupBoard = randomlyPlaceSetup(currentPreset());
  state.setupOrientation = "horizontal";
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
  state.setupError = "";
  state.online.roomCodeInput = "";
  state.online.error = "";
  state.online.status = "";
  state.resultModalDismissed = null;
  render();
}

function goToMenu() {
  closeRemote();
  state.screen = "menu";
  state.mode = null;
  state.game = null;
  state.online.error = "";
  state.online.status = "";
  state.resultModalDismissed = null;
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
  state.setupError = "";
  render();
}

function resetSetup() {
  state.setupBoard = createBoard(currentPreset().size);
  state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
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
    state.setupError = "";
    render();
    return;
  }
  if (cell.markerId) {
    state.setupBoard = removeMarker(state.setupBoard, cell.markerId);
    state.setupSelectedShipId = cell.markerId;
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
    state.setupError = "";
    render();
    return;
  }

  try {
    state.setupBoard = ship
      ? placeShip(state.setupBoard, ship, coordinate, state.setupOrientation)
      : placeMarker(state.setupBoard, marker, coordinate);
    state.setupSelectedShipId = firstUnplacedShipId(state.setupBoard);
    state.setupError = "";
  } catch {
    state.setupError = "setup.invalidPlacement";
  }
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
  }

  render();
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

function handleOnlineShot(coordinate) {
  playSound("shot");
  withOnlineError(async () => {
    await state.online.client.send("fire", { coordinate });
  });
}

function remoteHandlers() {
  return {
    workerUrl: state.online.workerUrl,
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
        playOnlineSnapshotSounds(state.online.snapshot, message.snapshot);
        state.online.snapshot = message.snapshot;
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
    localStorage.removeItem(authTokenStorageKey);
  });
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
    shipId: null,
    markerId: null,
    markerType: null,
    shot: shot?.result ?? null,
  };
}

function cellClass(cell, kind, board, coordinate) {
  const classes = [];
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

function cellContents(cell, kind, board, coordinate) {
  const text = cellText(cell, kind);
  return `
    ${shipSprite(cell, kind, board, coordinate)}
    ${markerSprite(cell, kind)}
    ${shotSprite(cell)}
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
  if ((kind !== "own" && kind !== "setup") || !cell.shipId) {
    return "";
  }
  const ship = findShipForCoordinate(board, coordinate);
  if (!ship || !isShipSpriteAnchor(board, coordinate)) {
    return "";
  }
  const orientation = shipOrientation(ship);
  const state = shipState(ship);
  const direction = orientation === "horizontal" ? "h" : "v";
  const path = `./assets/images/ships/ship-${ship.length}-${direction}-${state}.png`;
  return `<span class="ship-sprite ship-sprite-${direction}" style="--ship-cells: ${ship.length}; --ship-image: url('${path}')" aria-hidden="true"></span>`;
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

function shotSprite(cell) {
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
