import test from "node:test";
import assert from "node:assert/strict";

import * as i18n from "../src/i18n.js";

const { languages, t } = i18n;

test("i18n exposes English, Russian, and Chinese", () => {
  assert.deepEqual(
    languages.map((language) => language.code),
    ["en", "ru", "zh-CN"],
  );
});

test("i18n translates primary mode labels in every language", () => {
  for (const language of languages) {
    assert.notEqual(t(language.code, "mode.hotseat"), "mode.hotseat");
    assert.notEqual(t(language.code, "mode.agent"), "mode.agent");
    assert.notEqual(t(language.code, "mode.online"), "mode.online");
  }
});

test("i18n labels menu exit actions as main menu", () => {
  assert.equal(t("en", "nav.mainMenu"), "Main menu");
  assert.equal(t("ru", "nav.mainMenu"), "Главное меню");
  assert.equal(t("zh-CN", "nav.mainMenu"), "主菜单");
});

test("i18n translates result modal, theme, and history labels in every language", () => {
  const keys = [
    "result.title",
    "result.totalShots",
    "result.accuracy",
    "theme.label",
    "theme.dark",
    "visualStyle.label",
    "visualStyle.classic",
    "visualStyle.render",
    "audio.label",
    "audio.on",
    "audio.off",
    "history.title",
    "history.body",
    "history.body2",
    "history.source",
    "art.alt",
    "setup.manual",
    "setup.orientation",
    "setup.horizontal",
    "setup.vertical",
    "setup.invalidPlacement",
    "setup.allPlaced",
    "setup.selectShip",
    "setup.mine",
    "setup.sweeper",
    "preset.title",
    "preset.quick.name",
    "preset.quick.desc",
    "preset.classic.name",
    "preset.classic.desc",
    "preset.salvo.name",
    "preset.salvo.desc",
    "preset.perelman.name",
    "preset.perelman.desc",
    "game.salvoTurn",
    "game.salvoShots",
    "shot.mine",
    "shot.sweeper",
  ];

  for (const language of languages) {
    for (const key of keys) {
      assert.notEqual(t(language.code, key), key);
    }
  }
});

test("i18n uses localized Wikipedia source URLs", () => {
  assert.equal(t("en", "history.sourceUrl"), "https://en.wikipedia.org/wiki/Battleship_(game)");
  assert.equal(
    t("ru", "history.sourceUrl"),
    "https://ru.wikipedia.org/wiki/Морской_бой_(игра)",
  );
  assert.equal(t("zh-CN", "history.sourceUrl"), "https://zh.wikipedia.org/wiki/海战棋");
});

test("Russian board columns use Cyrillic coordinate letters", () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => i18n.coordinateColumnLabel("ru", index)),
    ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К"],
  );
  assert.deepEqual(
    Array.from({ length: 16 }, (_, index) => i18n.coordinateColumnLabel("ru", index)),
    ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К", "Л", "М", "Н", "О", "П", "Р"],
  );
  assert.equal(i18n.coordinateColumnLabel("en", 9), "J");
  assert.equal(i18n.coordinateColumnLabel("zh-CN", 9), "J");
});
