# Залп

[English](README.md) | Русский | [中文](README.zh-CN.md)

«Залп» — браузерный «Морской бой» для GitHub Pages: три локализации, PvP на одном устройстве, online PvP и игра против агента.

Публичная версия: https://agent-axiom.github.io/agents-salvo/

![Иллюстрация бумажного поля Залпа](src/assets/salvo-board-action.png)

## Возможности

- Static frontend без фреймворка: `src/index.html`, `src/app.js`, `src/styles.css`.
- Чистое ядро правил: `src/core/game.js`.
- Стиль бумажного поля с синей шариковой ручкой, ближе к классическим тетрадным партиям.
- Классический русский флот: 1x4, 2x3, 3x2, 4x1.
- Корабли не соприкасаются сторонами и углами.
- Потопленные корабли обводятся, клетки вокруг отмечаются водой.
- PvP на одном устройстве, online PvP и режим против агента.
- Локализации: English, Русский, 中文.
- Светлая и тёмная темы.
- Синтетические звуковые эффекты и музыка главной через Web Audio; MP3 пока не нужны.
- Авторизация через Telegram для постоянного профиля игрока.
- Cloudflare Worker backend с Durable Objects для online-комнат и D1 для профилей игроков.
- GitHub Pages workflow: `.github/workflows/pages.yml`.

## Локальная разработка

```bash
npm test
npm run build
npm start
```

После `npm start` открыть `http://localhost:5173`.

## Разработка приложений для iOS и Android

Мобильные приложения используют тот же локально собранный `dist/`, что и GitHub Pages, и не загружают публичный сайт при старте. Поэтому бои с агентом, тренировки и PvP на одном устройстве работают без интернета. Для online-комнат, Telegram-авторизации, профилей и лидерборда нужен доступ к Cloudflare Worker.

Системные требования:

- Node.js 24.14.1 (`.nvmrc`).
- iOS: macOS с Xcode 26 или новее; минимальная версия iOS 15.
- Android: Android Studio Otter 2025.2.1 или новее, JDK 21 и Android SDK 36; минимальный API 24.

Установить зависимости и синхронизировать web-сборку с обоими нативными проектами:

```bash
npm ci
npm run mobile:sync
```

Открыть нужный нативный проект:

```bash
npm run mobile:ios
npm run mobile:android
```

Собрать неподписанные артефакты для разработки без аккаунтов магазинов:

```bash
android/gradlew -p android test lint assembleDebug
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Для Android debug APK и сборки iOS Simulator не нужны аккаунты Google Play или Apple Developer. Запуск на физическом iOS-устройстве и распространение через TestFlight или магазины требуют соответствующих ключей подписи.

### Релиз для RuStore

Ручной workflow `Build RuStore Release` прогоняет тесты, собирает подписанные APK и AAB, проверяет их подписи и идентификаторы и загружает файлы как GitHub Actions artifact. Для него нужны секреты репозитория:

- `RUSTORE_KEYSTORE_BASE64`
- `RUSTORE_STORE_PASSWORD`
- `RUSTORE_KEY_ALIAS`
- `RUSTORE_KEY_PASSWORD`

Нельзя коммитить ключ подписи или его пароли. Оригинальный keystore и минимум одну зашифрованную резервную копию нужно хранить вне репозитория: все будущие обновления `io.github.agentaxiom.salvo` должны подписываться тем же ключом. Локальная проверка материалов магазина запускается командой `npm run rustore:assets:verify`. Тексты карточки, скриншоты, декларация данных и чек-лист владельца находятся в [`distribution/rustore`](distribution/rustore/).

## GitHub Pages

1. Запушить репозиторий в GitHub.
2. В Settings -> Pages выбрать GitHub Actions.
3. Запустить workflow `Deploy GitHub Pages` или сделать push в `main`.

Workflow прогоняет `npm test`, собирает `dist` и публикует его как Pages artifact.

## Online backend

Backend нужен для режима «Онлайн-комната», Telegram-авторизации и сохранённых профилей игроков.

```bash
npx wrangler deploy
```

Текущий Worker URL прописан во frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Пользователи этот URL не видят. При смене backend обновить `window.SALVO_CONFIG.workerUrl` в `src/index.html` и заново задеплоить Pages.

`wrangler.toml` использует Durable Objects для комнат и D1 для профиля/истории:

```toml
[[durable_objects.bindings]]
name = "BATTLE_ROOM"
class_name = "BattleRoom"

[[d1_databases]]
binding = "DB"
database_name = "agents-salvo-profile"
database_id = "fd744630-0b47-4432-8371-c059f5953989"
```

Перед деплоем свежего Worker применить D1 migrations:

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
```

## Profile API

- `POST /auth/telegram` проверяет Telegram Login Widget payload и возвращает подписанную сессию.
- `GET /profile/me` возвращает профиль игрока, сводную статистику, online-рейтинг, сезонную статистику, таблицу лидеров и последние бои.
- `POST /profile/matches` сохраняет завершённые бои против агента; online-результаты записывает сервер комнаты.
- `GET /leaderboard` возвращает публичную online-таблицу лидеров по серверно записанным online-матчам.

Если при создании или входе в online-комнату передан `Authorization: Bearer ...`, Durable Object привязывает Telegram-профиль к игроку и сам записывает итог боя в D1 после завершения партии.

## Звук

Сейчас используются синтетические Web Audio пресеты из `src/core/audio.js` и `src/audio.js`.

Будущие MP3 можно подготовить с такими именами:

```text
public/audio/menu-loop.mp3
public/audio/shot.mp3
public/audio/miss.mp3
public/audio/hit.mp3
public/audio/sunk.mp3
public/audio/victory.mp3
public/audio/defeat.mp3
public/audio/ui-click.mp3
public/audio/turn.mp3
public/audio/room-ready.mp3
```

## Историческая справка

Текст на главной основан на статье «Морской бой (игра)»: https://ru.wikipedia.org/wiki/Морской_бой_(игра)
