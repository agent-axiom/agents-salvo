import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");
const index = readFileSync("src/index.html", "utf8");

test("frontend config exposes the public Telegram bot username only", () => {
  assert.match(index, /telegramBotUsername:\s*"agents_salvo_bot"/);
  assert.doesNotMatch(index, /TELEGRAM_BOT_TOKEN|SESSION_SECRET/);
});

test("frontend mounts Telegram login and exchanges payloads with the worker", () => {
  assert.match(app, /telegram-widget\.js/);
  assert.match(app, /window\.onTelegramAuth/);
  assert.match(app, /\/auth\/telegram/);
  assert.match(app, /\/auth\/me/);
  assert.match(app, /salvo\.authToken/);
  assert.match(app, /data-action="auth-logout"/);
});
