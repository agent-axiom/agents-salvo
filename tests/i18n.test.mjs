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

test("i18n labels the setup ready action as a battle CTA", () => {
  assert.equal(t("en", "setup.ready"), "To battle!");
  assert.equal(t("ru", "setup.ready"), "В бой!");
  assert.equal(t("zh-CN", "setup.ready"), "开战！");
});

test("Russian online room invite names the Salvo game clearly", () => {
  assert.equal(t("ru", "online.shareText", { code: "ABC123" }), "Присоединяйся к моей комнате в игре Залп: ABC123");
});

test("i18n translates result modal, theme, and history labels in every language", () => {
  const keys = [
    "result.title",
    "result.totalShots",
    "result.accuracy",
    "result.ratingChange",
    "result.report",
    "result.you",
    "result.opponent",
    "result.streak",
    "result.achievements",
    "result.noAchievements",
    "result.copySummary",
    "result.copySuccess",
    "result.shareSummary",
    "result.shareText",
    "achievement.victory.title",
    "achievement.victory.desc",
    "achievement.flawlessAim.title",
    "achievement.flawlessAim.desc",
    "achievement.sharpshooter.title",
    "achievement.sharpshooter.desc",
    "achievement.fleetHunter.title",
    "achievement.fleetHunter.desc",
    "achievement.finalBlow.title",
    "achievement.finalBlow.desc",
    "theme.label",
    "theme.dark",
    "visualStyle.label",
    "visualStyle.classic",
    "visualStyle.render",
    "audio.label",
    "audio.on",
    "audio.off",
    "auth.label",
    "auth.telegram",
    "auth.loading",
    "auth.logout",
    "auth.error",
    "auth.notConfigured",
    "auth.domainHint",
    "profile.title",
    "profile.subtitle",
    "profile.empty",
    "profile.loginPrompt",
    "profile.refresh",
    "profile.matches",
    "profile.winRate",
    "profile.accuracy",
    "profile.streak",
    "profile.bestMode",
    "profile.rating",
    "profile.league",
    "profile.online",
    "profile.season",
    "profile.seasonRecord",
    "profile.leaderboard",
    "profile.noLeaderboard",
    "profile.achievements",
    "profile.achievementCount",
    "competition.title",
    "competition.subtitle",
    "competition.globalRank",
    "competition.seasonRank",
    "competition.noRank",
    "competition.bestOfThree",
    "competition.seriesScore",
    "competition.seriesStatus.active",
    "competition.seriesStatus.won",
    "competition.seriesStatus.lost",
    "competition.seriesStatus.none",
    "competition.ratingHistory",
    "competition.ratingDelta",
    "competition.noRatingHistory",
    "profile.recent",
    "profile.noMatches",
    "profile.saved",
    "profile.saveError",
    "profile.result.win",
    "profile.result.loss",
    "profile.ratingLabel.unrated",
    "profile.ratingLabel.cadet",
    "profile.ratingLabel.lieutenant",
    "profile.ratingLabel.commander",
    "profile.ratingLabel.admiral",
    "agent.hard",
    "coaching.title",
    "coaching.focus",
    "coaching.drill",
    "coaching.plan",
    "coaching.startTraining",
    "coaching.diagnosis.precision",
    "coaching.diagnosis.lowAccuracy",
    "coaching.diagnosis.finishShips",
    "coaching.diagnosis.steady",
    "coaching.focus.searchPattern",
    "coaching.focus.targetDiscipline",
    "coaching.focus.endgame",
    "coaching.focus.pressure",
    "coaching.drill.checkerboard",
    "coaching.drill.lineFinish",
    "coaching.drill.salvoControl",
    "coaching.drill.openingMap",
    "mode.training",
    "training.title",
    "training.subtitle",
    "training.choose",
    "training.progress",
    "training.completed",
    "training.bestScore",
    "training.bestAccuracy",
    "training.program",
    "training.dailyGoal",
    "training.streak",
    "training.bestStreak",
    "training.nextDrill",
    "training.awards",
    "training.award.firstWatch",
    "training.award.chainComplete",
    "training.award.threeDayStreak",
    "training.award.sevenDayStreak",
    "training.score",
    "training.shots",
    "training.restart",
    "training.resultTitle",
    "training.rating.excellent",
    "training.rating.steady",
    "training.rating.needsWork",
    "training.scenario.checkerboard.name",
    "training.scenario.checkerboard.desc",
    "training.scenario.lineFinish.name",
    "training.scenario.lineFinish.desc",
    "training.scenario.endgame.name",
    "training.scenario.endgame.desc",
    "training.feedback.pattern",
    "training.feedback.randomWater",
    "training.feedback.finishLine",
    "training.feedback.offLine",
    "training.feedback.hit",
    "training.feedback.sunk",
    "training.feedback.miss",
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
    "battle.lastShot",
    "battle.awaitingShot",
    "battle.nextAction",
    "battle.ready",
    "battle.paused",
    "battle.priorityCount",
    "battle.liveStats",
    "battle.accuracy",
    "battle.hits",
    "battle.sunk",
    "tactics.quickFire",
    "online.newRoom",
    "online.rematch",
    "online.rematchWaiting",
    "online.rematchOffered",
    "online.rematchUnavailable",
    "shot.mine",
    "shot.sweeper",
    "online.opponent",
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

test("getInitialLanguage prefers saved language and falls back from browser locale", () => {
  withLanguageGlobals({ saved: "ru", browser: "en-US" }, () => {
    assert.equal(i18n.getInitialLanguage(), "ru");
  });
  withLanguageGlobals({ saved: "unknown", browser: "zh-Hans-CN" }, () => {
    assert.equal(i18n.getInitialLanguage(), "zh-CN");
  });
  withLanguageGlobals({ saved: "", browser: "ru-RU" }, () => {
    assert.equal(i18n.getInitialLanguage(), "ru");
  });
  withLanguageGlobals({ saved: "", browser: "fr-FR" }, () => {
    assert.equal(i18n.getInitialLanguage(), "en");
  });
});

test("translations and coordinates fall back safely", () => {
  assert.equal(t("missing-language", "nav.mainMenu"), "Main menu");
  assert.equal(t("en", "missing.key"), "missing.key");
  assert.equal(t("en", "online.opponent", { player: "Ada" }), "Opponent: Ada");
  assert.equal(i18n.coordinateColumnLabel("missing-language", 0), "A");
  assert.equal(i18n.coordinateColumnLabel("en", 30), "31");
});

function withLanguageGlobals({ saved, browser }, callback) {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key) {
        return key === "salvo.language" ? saved : null;
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: browser },
  });

  try {
    callback();
  } finally {
    restoreDescriptor("localStorage", previousLocalStorage);
    restoreDescriptor("navigator", previousNavigator);
  }
}

function restoreDescriptor(name, descriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete globalThis[name];
  }
}
