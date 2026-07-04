import { chooseAgentShot } from "./core/ai.js";
import {
  createBoard,
  createGameFromBoards,
  defaultFleet,
  fireAt,
  getCell,
  hasCompleteFleet,
  publicBoardView,
  randomlyPlaceFleet,
} from "./core/game.js";
import { getInitialLanguage, languages, t } from "./i18n.js";
import { RemoteClient } from "./remote.js";

const root = document.querySelector("#app");
const fleet = defaultFleet();

const state = {
  language: getInitialLanguage(),
  screen: "menu",
  mode: null,
  setupPlayerId: "p1",
  setupBoard: randomlyPlaceFleet(fleet),
  boards: { p1: null, p2: null },
  game: null,
  agentDifficulty: "normal",
  passPlayerId: null,
  online: {
    workerUrl: localStorage.getItem("salvo.workerUrl") || window.SALVO_CONFIG?.workerUrl || "",
    roomCodeInput: "",
    status: "",
    error: "",
    session: null,
    snapshot: null,
    client: null,
  },
};

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

function render() {
  document.documentElement.lang = state.language;
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
      </header>
      ${renderScreen()}
    </main>
  `;
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
      </div>
      <div class="fleet-visual" aria-hidden="true">
        <div class="sea-grid">
          ${Array.from({ length: 100 }, (_, index) => `<span class="${previewClass(index)}"></span>`).join("")}
        </div>
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
        <button class="ghost-button" data-action="menu">${translate("mode.back")}</button>
        <div class="section-heading">
          <span>${translate("setup.title")}</span>
          <h2>${title}</h2>
        </div>
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
        <div class="button-row">
          <button data-action="randomize">${translate("setup.randomize")}</button>
          <button class="secondary-button" data-action="reset">${translate("setup.reset")}</button>
        </div>
        <button class="primary-button" data-action="ready" ${readyDisabled}>
          ${readyDisabled ? translate("setup.needFleet") : translate("setup.ready")}
        </button>
      </aside>
      <section class="board-stage">
        ${renderBoard(state.setupBoard, { kind: "own", title })}
      </section>
    </section>
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
  const status =
    state.game.phase === "finished"
      ? translate("game.winner", { player: playerName(state.game.winnerId) })
      : translate("game.turn", { player: playerName(currentPlayerId) });

  return `
    <section class="play-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("mode.back")}</button>
        <div class="section-heading">
          <span>${translate("nav.mode")}</span>
          <h2>${status}</h2>
        </div>
        <button class="primary-button" data-action="new-game">${translate("game.restart")}</button>
        ${renderLog(state.game.log)}
      </aside>
      <section class="board-stage two-boards">
        ${renderBoard(ownBoard, { kind: "own", title: translate("game.yourFleet") })}
        ${renderBoard(targetBoard, {
          kind: "target",
          title: translate("game.target"),
          disabled: state.game.phase === "finished",
        })}
      </section>
    </section>
  `;
}

function renderOnline() {
  const snapshot = state.online.snapshot;
  return `
    <section class="play-layout">
      <aside class="control-panel">
        <button class="ghost-button" data-action="menu">${translate("mode.back")}</button>
        <div class="section-heading">
          <span>${translate("mode.online")}</span>
          <h2>${translate("online.title")}</h2>
        </div>
        <label class="stacked-field">
          <span>${translate("online.workerUrl")}</span>
          <input data-action="worker-url" value="${escapeHtml(state.online.workerUrl)}" placeholder="https://salvo.example.workers.dev" />
        </label>
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
        ${snapshot?.log?.length ? renderLog(snapshot.log) : ""}
      </aside>
      <section class="board-stage">
        ${snapshot ? renderOnlineSnapshot(snapshot) : renderBoard(state.setupBoard, { kind: "own", title: translate("game.yourFleet") })}
      </section>
    </section>
  `;
}

function renderOnlineSnapshot(snapshot) {
  const own = snapshot.you?.board ?? createBoard();
  const target = {
    size: snapshot.size ?? 10,
    ships: [],
    shots: snapshot.opponentShots ?? [],
  };
  return `
    <div class="two-boards">
      ${renderBoard(own, { kind: "own", title: translate("game.yourFleet") })}
      ${renderBoard(target, {
        kind: "online-target",
        title: translate("game.target"),
        disabled: snapshot.phase !== "playing" || !snapshot.isYourTurn,
      })}
    </div>
  `;
}

function renderBoard(board, { kind, title, disabled = false }) {
  const columnLabels = Array.from({ length: board.size }, (_, index) =>
    String.fromCharCode(65 + index),
  );
  return `
    <section class="board-panel">
      <div class="board-title">
        <h3>${title}</h3>
      </div>
      <div class="coordinate-board">
        <span class="grid-corner" aria-hidden="true"></span>
        <div class="column-headers" aria-hidden="true">
          ${columnLabels.map((label) => `<span>${label}</span>`).join("")}
        </div>
        <div class="row-headers" aria-hidden="true">
          ${Array.from({ length: board.size }, (_, index) => `<span>${index + 1}</span>`).join("")}
        </div>
        <div class="board-grid ${kind}" role="grid" aria-label="${title}">
          ${Array.from({ length: board.size * board.size }, (_, index) => {
            const row = Math.floor(index / board.size);
            const col = index % board.size;
            const coordinate = { row, col };
            const cell = kind === "own" ? getCell(board, coordinate) : getTargetCell(board, coordinate);
            const label = `${translate("board.row", { row: row + 1 })}, ${translate("board.col", { col: col + 1 })}`;
            const buttonDisabled = disabled || kind === "own" || cell.shot;
            return `<button
              class="cell ${cellClass(cell, kind, board, coordinate)}"
              data-action="${kind === "target" ? "shot" : kind === "online-target" ? "online-shot" : ""}"
              data-row="${row}"
              data-col="${col}"
              aria-label="${label}"
              ${buttonDisabled ? "disabled" : ""}
            >${cellText(cell, kind)}</button>`;
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
          : `<ol>${log
              .slice(-8)
              .reverse()
              .map(
                (entry) =>
                  `<li><span>${playerName(entry.playerId)}</span><strong>${translate(`shot.${entry.result}`)}</strong><small>${String.fromCharCode(65 + entry.coordinate.col)}${entry.coordinate.row + 1}</small></li>`,
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
  if (action === "worker-url") {
    state.online.workerUrl = target.value.trim();
    localStorage.setItem("salvo.workerUrl", state.online.workerUrl);
  }
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
  if (action === "start-hotseat") startSetup("hotseat");
  if (action === "start-agent") startSetup("agent");
  if (action === "show-online") showOnline();
  if (action === "menu") goToMenu();
  if (action === "new-game") startSetup(state.mode);
  if (action === "randomize") randomizeSetup();
  if (action === "reset") resetSetup();
  if (action === "ready") readySetup();
  if (action === "continue-pass") continueAfterPass();
  if (action === "shot") handleLocalShot(readCoordinate(button));
  if (action === "online-shot") handleOnlineShot(readCoordinate(button));
  if (action === "online-create") await onlineCreate();
  if (action === "online-join") await onlineJoin();
});

function startSetup(mode) {
  closeRemote();
  state.mode = mode;
  state.screen = "setup";
  state.setupPlayerId = "p1";
  state.setupBoard = randomlyPlaceFleet(fleet);
  state.boards = { p1: null, p2: null };
  state.game = null;
  render();
}

function showOnline() {
  state.mode = "online";
  state.screen = "online";
  state.setupBoard = randomlyPlaceFleet(fleet);
  render();
}

function goToMenu() {
  closeRemote();
  state.screen = "menu";
  state.mode = null;
  state.game = null;
  state.online.error = "";
  state.online.status = "";
  render();
}

function randomizeSetup() {
  state.setupBoard = randomlyPlaceFleet(fleet);
  render();
}

function resetSetup() {
  state.setupBoard = createBoard();
  render();
}

function readySetup() {
  if (!hasFullFleet(state.setupBoard)) {
    return;
  }

  if (state.mode === "agent") {
    state.boards.p1 = state.setupBoard;
    state.boards.p2 = randomlyPlaceFleet(fleet);
    state.game = createGameFromBoards(state.boards.p1, state.boards.p2, "p1");
    state.screen = "playing";
    render();
    return;
  }

  if (state.setupPlayerId === "p1") {
    state.boards.p1 = state.setupBoard;
    state.setupPlayerId = "p2";
    state.setupBoard = randomlyPlaceFleet(fleet);
    state.passPlayerId = "p2";
    state.screen = "pass";
    render();
    return;
  }

  state.boards.p2 = state.setupBoard;
  state.game = createGameFromBoards(state.boards.p1, state.boards.p2, "p1");
  state.passPlayerId = "p1";
  state.screen = "pass";
  render();
}

function continueAfterPass() {
  state.screen = state.game ? "playing" : "setup";
  render();
}

function handleLocalShot(coordinate) {
  if (!state.game || state.game.phase !== "playing") {
    return;
  }

  const playerId = state.game.currentPlayerId;
  const result = fireAt(state.game, playerId, coordinate);
  state.game = result.game;

  if (state.mode === "agent" && state.game.phase === "playing" && state.game.currentPlayerId === "p2") {
    state.game = runAgentTurns(state.game);
  }

  if (state.mode === "hotseat" && state.game.phase === "playing" && result.outcome.type === "miss") {
    state.passPlayerId = state.game.currentPlayerId;
    state.screen = "pass";
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
    await state.online.client.send("placeFleet", { board: state.setupBoard });
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
    await state.online.client.send("placeFleet", { board: state.setupBoard });
    render();
  });
}

function handleOnlineShot(coordinate) {
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
        state.online.snapshot = message.snapshot;
      }
      if (message.type === "error") {
        state.online.error = message.message;
      }
      render();
    },
  };
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

function hasFullFleet(board) {
  return hasCompleteFleet(board, fleet);
}

function getTargetCell(board, coordinate) {
  const shot = board.shots.find((entry) => entry.row === coordinate.row && entry.col === coordinate.col);
  return {
    shipId: null,
    shot: shot?.result ?? null,
  };
}

function cellClass(cell, kind, board, coordinate) {
  const classes = [];
  if (kind === "own" && cell.shipId) classes.push("has-ship");
  if (cell.shot) classes.push(cell.shot);
  if (cell.shot === "sunk") classes.push(...sunkEdgeClasses(board, coordinate, kind));
  return classes.join(" ");
}

function cellText(cell, kind) {
  if (cell.shot === "miss") return "•";
  if (cell.shot === "hit") return "×";
  if (cell.shot === "sunk") return "×";
  if (kind === "own" && cell.shipId) return "";
  return "";
}

function readCoordinate(button) {
  return {
    row: Number(button.dataset.row),
    col: Number(button.dataset.col),
  };
}

function previewClass(index) {
  const shipCells = new Set([12, 13, 14, 15, 16, 42, 52, 62, 66, 67, 68, 84, 85]);
  const hitCells = new Set([13, 52, 68]);
  if (hitCells.has(index)) return "preview-hit";
  if (shipCells.has(index)) return "preview-ship";
  if ([6, 27, 73].includes(index)) return "preview-miss";
  return "";
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
    }
    if (snapshot.phase === "finished") {
      lines.push(translate("game.winner", { player: playerName(snapshot.winnerId) }));
    }
  }

  return lines.map((line) => `<p class="status-line">${line}</p>`).join("");
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

render();
