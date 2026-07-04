# Salvo

Морской бой для GitHub Pages: три локализации, локальный PvP на одном устройстве, игра против агента и online PvP через Cloudflare Workers + Durable Objects.

## Что уже есть

- Static frontend без фреймворка: `src/index.html`, `src/app.js`, `src/styles.css`.
- Чистое ядро правил: `src/core/game.js`.
- Аутентичный набор флота: 1x4, 2x3, 3x2, 4x1; корабли не соприкасаются сторонами и углами.
- Агент easy/normal: `src/core/ai.js`.
- Локализации: English, Русский, 中文.
- Cloudflare Worker backend: `worker/index.js`.
- GitHub Pages workflow: `.github/workflows/pages.yml`.

## Локально

```bash
npm test
npm run build
npm start
```

После `npm start` открыть `http://localhost:5173`.

## GitHub Pages

1. Запушить репозиторий в GitHub.
2. В Settings -> Pages выбрать GitHub Actions.
3. Запустить workflow `Deploy GitHub Pages` или сделать push в `main`.

Workflow прогоняет `npm test`, собирает `dist` и публикует его как Pages artifact.

## Cloudflare backend

Backend нужен только для режима “Online room”.

```bash
npx wrangler deploy
```

Текущий Worker URL уже прописан в frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Его можно переопределить в поле `Worker URL` в online-режиме. Значение сохраняется в `localStorage`.

`wrangler.toml` использует Durable Objects с SQLite storage:

```toml
[[durable_objects.bindings]]
name = "BATTLE_ROOM"
class_name = "BattleRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BattleRoom"]
```

## Online протокол

- `POST /rooms` создает комнату и возвращает `roomCode`, `playerId`, `playerToken`.
- `POST /rooms/:roomCode/join` подключает второго игрока.
- `GET /rooms/:roomCode/socket?playerId=...&token=...` открывает WebSocket.
- Клиент отправляет `placeFleet` и `fire`.
- Durable Object валидирует очередность ходов и не раскрывает корабли соперника в snapshot.
