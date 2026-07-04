# Battleship MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GitHub Pages-hosted Battleship game with English, Russian, and Chinese localizations, local hotseat PvP, player vs agent, and an online room backend for different-device PvP.

**Architecture:** Use a static vanilla ES module frontend so the project can run on GitHub Pages without a build dependency chain. Keep game rules in a pure `src/core/game.js` module with Node built-in tests. Use a Cloudflare Worker with Durable Objects as the authoritative online room backend.

**Tech Stack:** HTML, CSS, vanilla JavaScript ES modules, Node.js built-in test runner, GitHub Actions for Pages, Cloudflare Workers/Durable Objects for realtime backend.

---

### Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `scripts/build.mjs`
- Create: `src/index.html`
- Create: `src/styles.css`

- [ ] Add npm scripts for `test`, `build`, and `start`.
- [ ] Implement a dependency-free build script that copies `src` into `dist`.
- [ ] Create a static HTML entrypoint that loads `app.js` as an ES module.
- [ ] Add responsive base CSS for desktop and mobile.

### Task 2: Game Engine With TDD

**Files:**
- Create: `tests/game.test.mjs`
- Create: `src/core/game.js`

- [ ] Write tests for empty boards, ship placement validation, misses, hits, sunk ships, turn switching, and victory.
- [ ] Run `node --test tests/game.test.mjs` and confirm it fails because the module does not exist.
- [ ] Implement the minimal exported game engine API needed by the tests.
- [ ] Run `node --test tests/game.test.mjs` and confirm it passes.

### Task 3: Agent With TDD

**Files:**
- Create: `tests/ai.test.mjs`
- Create: `src/core/ai.js`

- [ ] Write tests proving the agent picks only unknown cells and targets neighbors after a hit.
- [ ] Run `node --test tests/ai.test.mjs` and confirm it fails because the module does not exist.
- [ ] Implement easy and normal agent shot selection.
- [ ] Run `node --test tests/ai.test.mjs` and confirm it passes.

### Task 4: Localized Frontend

**Files:**
- Create: `src/i18n.js`
- Create: `src/app.js`

- [ ] Add English, Russian, and Simplified Chinese dictionaries.
- [ ] Implement language switching with `localStorage`.
- [ ] Implement mode selection for hotseat, agent, and online.
- [ ] Implement ship placement with randomize, reset, and ready controls.
- [ ] Implement gameplay boards, turn labels, shot log, and result state.

### Task 5: Online Backend

**Files:**
- Create: `worker/index.js`
- Create: `wrangler.toml`
- Create: `src/remote.js`

- [ ] Add Durable Object room routing for room creation, joining, WebSocket connect, placement, ready, fire, rematch, and close.
- [ ] Keep each player's ship layout hidden from the other player.
- [ ] Validate turn order and shot legality on the Durable Object.
- [ ] Add a frontend remote client that can create or join a room by code.

### Task 6: Deployment

**Files:**
- Create: `.github/workflows/pages.yml`
- Create: `README.md`

- [ ] Add GitHub Pages workflow that runs tests, builds `dist`, and uploads it as a Pages artifact.
- [ ] Document local commands, GitHub Pages setup, and Cloudflare Worker deployment.
- [ ] Document required frontend config for the Worker URL.

### Task 7: Verification

**Commands:**
- `npm test`
- `npm run build`
- `python3 -m http.server 5173 -d dist`

- [ ] Run all tests.
- [ ] Run the build.
- [ ] Start a local static server and inspect that the app loads.
- [ ] Stop the local server before finishing.
