# Залп

[English](README.md) | Русский | [中文](README.zh-CN.md)

«Залп» — браузерный «Морской бой» для GitHub Pages: три локализации, PvP на одном устройстве, online PvP и игра против агента.

Публичная версия: https://agent-axiom.github.io/agents-salvo/

Публичный Telegram Mini App: https://agent-axiom.github.io/agents-salvo/telegram/

Публичный MAX Mini App: https://agent-axiom.github.io/agents-salvo/max/

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
- Авторизация через Telegram и подписанные данные запуска Telegram/MAX Mini App.
- Cloudflare Worker backend с Durable Objects для online-комнат и D1 для профилей игроков.
- GitHub Pages workflow: `.github/workflows/pages.yml`.

## Локальная разработка

```bash
npm test
npm run build
npm start
```

После `npm start` открыть `http://localhost:5173`.

## Telegram Mini App

В [@BotFather](https://t.me/BotFather) нужно выбрать бота «Залпа», открыть настройку Main Mini App и указать URL `https://agent-axiom.github.io/agents-salvo/telegram/`.

При запуске внутри Telegram Mini App автоматически отправляет подписанный Telegram `initData` в Cloudflare Worker. Worker проверяет подпись и срок действия данных, а затем создаёт существующую сессию «Залпа», поэтому отдельный вход не требуется.

## MAX Mini App

В настройках бота «Залпа» в MAX нужно указать URL Mini App `https://agent-axiom.github.io/agents-salvo/max/`. Публичная ссылка запуска: `https://max.ru/se13661945_bot?startapp`.

При запуске внутри MAX Mini App отправляет подписанные данные запуска MAX в Cloudflare Worker. Worker проверяет HMAC-подпись и срок действия с приватным `MAX_BOT_TOKEN`, затем создаёт такую же непрозрачную сессию «Залпа», как для других клиентов. Исходные данные запуска и токен бота не сохраняются. MAX и Telegram остаются отдельными профилями, пока не появится явная функция связывания аккаунтов.

Токен MAX-бота нужно хранить только в секретах Worker, затем повторно задеплоить Worker:

```bash
npx wrangler secret put MAX_BOT_TOKEN
npx wrangler deploy
```

Браузер, Telegram Mini App, MAX Mini App, iOS-приложение и Android-приложение используют единое дерево исходного кода и одну команду `npm run build`. Сборка создаёт три HTML shell с общими хешированными JavaScript bundle и stylesheet. Telegram SDK загружается только в Telegram shell. MAX SDK загружается только в MAX shell.

Pages и оба Mini App обновляются сразу после публикации Pages artifact. Нативные приложения не загружают Pages при старте: каждый APK или iOS app содержит сборку выбранного коммита и меняется только после упаковки и выпуска этого коммита.

## Разработка приложений для iOS и Android

Мобильные приложения используют тот же локально собранный `dist/`, что и GitHub Pages, и не загружают публичный сайт при старте. Поэтому бои с агентом, тренировки и PvP на одном устройстве работают без интернета. Для online-комнат, авторизации, профилей и лидерборда нужен доступ к Cloudflare Worker.

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

Ручной workflow `Build RuStore Release` запускается только с `main`, прогоняет тесты, проверяет опубликованное уведомление о конфиденциальности, собирает подписанные APK и AAB, проверяет их подписи, разрешения и идентификаторы и загружает файлы как GitHub Actions artifact. Следующие секреты должны храниться в защищённом GitHub Environment `rustore-production`:

- `RUSTORE_KEYSTORE_BASE64`
- `RUSTORE_STORE_PASSWORD`
- `RUSTORE_KEY_ALIAS`
- `RUSTORE_KEY_PASSWORD`
- `RUSTORE_KEY_ID`
- `RUSTORE_PRIVATE_KEY`
- `RUSTORE_DEVELOPER_EMAIL`

Нельзя коммитить ключи подписи/API или их пароли. Оригинальный keystore и минимум одну зашифрованную резервную копию нужно хранить вне репозитория: все будущие обновления `io.github.agentaxiom.salvo` должны подписываться тем же ключом. Локальная проверка материалов магазина запускается командой `npm run rustore:assets:verify`. Тексты карточки, скриншоты, декларация данных и чек-лист владельца находятся в [`distribution/rustore`](distribution/rustore/).

API-публикация доступна после появления первой активной версии в RuStore. Сначала нужно запустить безопасный workflow `Check RuStore API Access`: он ничего не изменяет. Для обновления запустить `Build RuStore Release` с включённым `submit_to_rustore` и непустым описанием изменений. Проверенный APK отправится на модерацию и после одобрения автоматически откроется для 5% аудитории. Затем защищённый workflow `Expand RuStore Rollout` переводит ту же версию по её ID на 25%, а после проверки — на 100%. Остановка или откат версии остаются явным действием владельца в RuStore Консоли.

## GitHub Pages

1. Запушить репозиторий в GitHub.
2. В Settings -> Pages выбрать GitHub Actions.
3. Запустить workflow `Deploy GitHub Pages` или сделать push в `main`.

Workflow прогоняет тесты и coverage gates, собирает `dist`, проверяет все три HTML shell и общие хешированные артефакты и публикует результат как Pages artifact.

## Online backend

Backend нужен для режима «Онлайн-комната», Telegram/MAX-авторизации и сохранённых профилей игроков.

```bash
npx wrangler deploy
```

Текущий Worker URL прописан во frontend:

```text
https://agents-salvo-room.if-ab6.workers.dev
```

Пользователи этот URL не видят. При смене backend нужно обновить `window.SALVO_CONFIG.workerUrl` во всех исходных shell и заново задеплоить Pages.

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

### Операции с Telegram Stars webhook

Telegram разрешает только один webhook на бота, поэтому его регистрация —
отдельная production-операция. Она не запускается из тестов, сборки, деплоя
Pages, упаковки нативных приложений или деплоя Worker. Перед выполнением
последовательности ниже нужно через менеджер секретов передать в одноразовое
окружение оператора `TELEGRAM_BOT_TOKEN` и тот же стойкий
`TELEGRAM_WEBHOOK_SECRET`. Многоточия ниже — только обозначения значений: их
нельзя коммитить или отправлять в общие логи. Токен бота должен оставаться
экспортированным в этом окружении для финальной read-only проверки.

Production-операции выполняются строго в таком порядке:

```bash
npx wrangler d1 migrations apply agents-salvo-profile --remote
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... npm run telegram:stars:webhook:set
npm run telegram:stars:webhook:check
```

Команда `telegram:stars:webhook:set` регистрирует
`https://agents-salvo-room.if-ab6.workers.dev/telegram/webhook` только для
событий `message` и `pre_checkout_query`, не удаляет накопившиеся события и
затем проверяет точное совпадение URL. Команда
`telegram:stars:webhook:check` ничего не изменяет. Обе команды выводят только
публичный URL webhook и скрывают ответы Telegram. Нельзя запускать их для
второго окружения с тем же ботом.

Реальная smoke-проверка на 8 Stars выполняется только вручную и требует явного
действия оператора. Она никогда не запускается в CI или при деплое.

Для обоснованного ручного возврата попросите пользователя отправить
`/paysupport` в приватном чате с `@agents_salvo_bot` и указать в GitHub issue
только полученный безопасный идентификатор поддержки. Бот формирует его из Telegram
identity отправителя и не выдаёт charge ID, payload, Telegram user ID или session
token. Затем приватно проверьте платёж в D1 Console. В таблице
`star_support_payments` найдите запись по этому идентификатору (opaque `invoice_id`) и убедитесь, что
`status = 'paid'`, `currency = 'XTR'`, а поля `telegram_user_id` и
`telegram_payment_charge_id` заполнены. Запрос и его результат должны оставаться
только в приватной операторской сессии:

```sql
SELECT invoice_id, telegram_user_id, telegram_payment_charge_id,
       amount, currency, status, paid_at
  FROM star_support_payments
 WHERE invoice_id = ? AND status = 'paid';
```

В одобренном приватном клиенте Telegram Bot API вызвать
`refundStarPayment`, передав сохранённый `telegram_user_id` как `user_id`, а
сохранённый `telegram_payment_charge_id` как
`telegram_payment_charge_id`. Токен бота брать из менеджера секретов; нельзя
помещать его, charge ID или Telegram user ID в репозиторий, историю shell,
скриншоты, issue или общие логи. Только после ответа Telegram `ok: true`
перевести ту же запись в статус `refunded` и установить `refunded_at`
параметризованным приватным запросом D1. Нельзя сначала менять D1 или выполнять
возврат по идентификаторам, присланным пользователем.
Публичный безопасный идентификатор служит только ключом поиска и не позволяет изменить
получателя: Telegram возвращает Stars исключительно исходному сохранённому
Telegram-плательщику.

```sql
UPDATE star_support_payments
   SET status = 'refunded', refunded_at = ?
 WHERE invoice_id = ? AND status = 'paid'
   AND telegram_user_id = ? AND telegram_payment_charge_id = ?;
```

Для `refunded_at` используется текущее Unix-время в секундах, а для остальных
параметров — только значения из проверенной квитанции.

## Profile API

- `POST /auth/telegram` проверяет Telegram Login Widget payload и возвращает подписанную сессию.
- `POST /auth/telegram/miniapp` проверяет подписанные данные запуска Telegram Mini App и создаёт непрозрачную D1-сессию.
- `POST /auth/max/miniapp` проверяет подписанные данные запуска MAX Mini App и создаёт непрозрачную D1-сессию.
- `GET /profile/me` возвращает профиль игрока, сводную статистику, online-рейтинг, сезонную статистику, таблицу лидеров и последние бои.
- `POST /profile/matches` сохраняет завершённые бои против агента; online-результаты записывает сервер комнаты.
- `GET /leaderboard` возвращает публичную online-таблицу лидеров по серверно записанным online-матчам.

Если при создании или входе в online-комнату передан `Authorization: Bearer ...`, Durable Object привязывает подтверждённый профиль к игроку и сам записывает итог боя в D1 после завершения партии.

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
