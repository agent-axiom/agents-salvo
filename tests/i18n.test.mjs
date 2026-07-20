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

test("mobile platform notices and controls are localized in every language", () => {
  const expected = {
    en: {
      "settings.haptics": "Haptics",
      "network.offline": "You are offline.",
      "network.retry": "Try again when connected.",
      "restore.resumed": "Battle resumed.",
      "restore.unsupportedVersion": "This saved battle was created by a newer app version.",
      "restore.failed": "Could not restore the saved battle.",
      "nav.leaveBattleTitle": "Leave this battle?",
      "nav.leaveBattleBody": "Your unfinished battle will be lost.",
      "nav.cancel": "Cancel",
      "nav.mainMenu": "Main menu",
      "share.failed": "Could not share.",
      "auth.signInTelegram": "Sign in with Telegram",
      "auth.openingTelegram": "Opening Telegram",
      "auth.cancelled": "Telegram sign-in was cancelled. Try again when ready.",
      "auth.invalidTicket": "This sign-in link expired or is invalid. Please try again.",
      "auth.unavailable": "Telegram login is unavailable right now.",
      "auth.miniAppOpenInTelegram": "Open Salvo in Telegram to sign in.",
      "auth.miniAppOpenCommand": "Open in Telegram",
      "auth.miniAppReopen": "This Telegram Mini App session expired. Reopen Salvo to sign in again.",
      "auth.miniAppReopenCommand": "Reopen in Telegram",
      "auth.retry": "Retry",
      "auth.valueNotice": "Save your profile and online progress. Local play remains available.",
      "auth.privacyNotice": "Read how account data is handled in the",
      "auth.privacyLink": "Privacy notice",
      "auth.consent": "I consent to the processing of my Telegram account data and gameplay statistics as described in the Privacy notice.",
      "auth.consentRequired": "Accept the Privacy notice before signing in.",
      "auth.secureStorageFailed": "Secure login could not be saved.",
    },
    ru: {
      "settings.haptics": "Виброотклик",
      "network.offline": "Нет подключения к сети.",
      "network.retry": "Повторите попытку после подключения.",
      "restore.resumed": "Бой восстановлен.",
      "restore.unsupportedVersion": "Этот сохранённый бой создан в более новой версии приложения.",
      "restore.failed": "Не удалось восстановить сохранённый бой.",
      "nav.leaveBattleTitle": "Покинуть бой?",
      "nav.leaveBattleBody": "Незавершённый бой будет потерян.",
      "nav.cancel": "Отмена",
      "nav.mainMenu": "Главное меню",
      "share.failed": "Не удалось поделиться.",
      "auth.signInTelegram": "Войти через Telegram",
      "auth.openingTelegram": "Открываем Telegram",
      "auth.cancelled": "Вход через Telegram отменён. Повторите попытку, когда будете готовы.",
      "auth.invalidTicket": "Ссылка для входа недействительна или устарела. Попробуйте ещё раз.",
      "auth.unavailable": "Вход через Telegram сейчас недоступен.",
      "auth.miniAppOpenInTelegram": "Откройте Залп в Telegram, чтобы войти.",
      "auth.miniAppOpenCommand": "Открыть в Telegram",
      "auth.miniAppReopen": "Сеанс Telegram Mini App истёк. Откройте Залп снова, чтобы войти.",
      "auth.miniAppReopenCommand": "Открыть снова в Telegram",
      "auth.retry": "Повторить",
      "auth.valueNotice": "Сохраняйте профиль и прогресс онлайн. Локальная игра остаётся доступной.",
      "auth.privacyNotice": "О работе с данными аккаунта читайте в",
      "auth.privacyLink": "Уведомлении о конфиденциальности",
      "auth.consent": "Я соглашаюсь на обработку данных моего Telegram-аккаунта и игровой статистики согласно Уведомлению о конфиденциальности.",
      "auth.consentRequired": "Примите Уведомление о конфиденциальности перед входом.",
      "auth.secureStorageFailed": "Не удалось безопасно сохранить вход.",
    },
    "zh-CN": {
      "settings.haptics": "触觉反馈",
      "network.offline": "当前离线。",
      "network.retry": "联网后请重试。",
      "restore.resumed": "已恢复战斗。",
      "restore.unsupportedVersion": "此保存的战斗来自更新版本的应用。",
      "restore.failed": "无法恢复保存的战斗。",
      "nav.leaveBattleTitle": "离开这场战斗？",
      "nav.leaveBattleBody": "未完成的战斗将会丢失。",
      "nav.cancel": "取消",
      "nav.mainMenu": "主菜单",
      "share.failed": "分享失败。",
      "auth.signInTelegram": "使用 Telegram 登录",
      "auth.openingTelegram": "正在打开 Telegram",
      "auth.cancelled": "已取消 Telegram 登录，准备好后可重试。",
      "auth.invalidTicket": "此登录链接已过期或无效，请重试。",
      "auth.unavailable": "Telegram 登录暂时不可用。",
      "auth.miniAppOpenInTelegram": "请在 Telegram 中打开 Salvo 以登录。",
      "auth.miniAppOpenCommand": "在 Telegram 中打开",
      "auth.miniAppReopen": "Telegram Mini App 会话已过期。请重新打开 Salvo 以登录。",
      "auth.miniAppReopenCommand": "在 Telegram 中重新打开",
      "auth.retry": "重试",
      "auth.valueNotice": "保存个人档案和在线进度；本地游戏仍可使用。",
      "auth.privacyNotice": "账号数据处理方式请参阅",
      "auth.privacyLink": "隐私声明",
      "auth.consent": "我同意按照隐私声明处理我的 Telegram 账号数据和游戏统计信息。",
      "auth.consentRequired": "登录前请接受隐私声明。",
      "auth.secureStorageFailed": "无法安全保存登录信息。",
    },
  };

  for (const [language, translations] of Object.entries(expected)) {
    for (const [key, value] of Object.entries(translations)) {
      assert.equal(t(language, key), value, `${language} must define ${key}`);
    }
  }
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
    "auth.signInTelegram",
    "auth.openingTelegram",
    "auth.cancelled",
    "auth.invalidTicket",
    "auth.unavailable",
    "auth.miniAppOpenInTelegram",
    "auth.miniAppOpenCommand",
    "auth.miniAppReopen",
    "auth.miniAppReopenCommand",
    "auth.retry",
    "auth.valueNotice",
    "auth.privacyNotice",
    "auth.privacyLink",
    "auth.consent",
    "auth.consentRequired",
    "auth.secureStorageFailed",
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
    "debrief.title",
    "debrief.label.search",
    "debrief.label.finish",
    "debrief.label.pressure",
    "debrief.label.focus",
    "debrief.message.weakSearch",
    "debrief.message.strongSearch",
    "debrief.message.noContact",
    "debrief.message.cleanFinish",
    "debrief.message.unfinishedTargets",
    "debrief.message.lowPressure",
    "debrief.message.highPressure",
    "debrief.message.searchPattern",
    "debrief.message.targetDiscipline",
    "debrief.message.endgame",
    "debrief.message.pressure",
    "moments.title",
    "moments.firstContact",
    "moments.firstSunk",
    "moments.missStreak",
    "moments.finalShot",
    "moments.turn",
    "moments.turnRange",
    "moments.noCoordinate",
    "replay.title",
    "replay.map",
    "replay.move",
    "replay.player",
    "replay.result",
    "replay.coordinate",
    "replay.previous",
    "replay.next",
    "replay.play",
    "replay.pause",
    "replay.speed",
    "replay.timeline",
    "replay.seek",
    "replay.position",
    "replay.announcement",
    "replay.empty",
    "archive.open",
    "archive.kicker",
    "archive.title",
    "archive.subtitle",
    "archive.signInRequired",
    "archive.signIn",
    "archive.loading",
    "archive.loadingMore",
    "archive.empty",
    "archive.unavailable",
    "archive.network",
    "archive.retry",
    "archive.loadMore",
    "archive.back",
    "archive.watchReplay",
    "archive.historicalUnavailable",
    "archive.unknownOpponent",
    "archive.opponent",
    "archive.accuracy",
    "archive.shots",
    "archive.turns",
    "replayArchive.title",
    "replayArchive.signInRequired",
    "replayArchive.loading",
    "replayArchive.forbidden",
    "replayArchive.notFound",
    "replayArchive.unavailable",
    "replayArchive.network",
    "replayArchive.copied",
    "replayArchive.copyFailed",
    "replayArchive.copyLink",
    "replayArchive.ownBoard",
    "replayArchive.opponentBoard",
    "replayArchive.captains",
    "replayArchive.winner",
    "replayArchive.preset",
    "replayArchive.date",
    "replayArchive.activeShot",
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
    "battle.momentumTitle",
    "battle.momentum.ahead",
    "battle.momentum.even",
    "battle.momentum.behind",
    "battle.fleetIntel",
    "battle.enemySunk",
    "battle.ownAfloat",
    "battle.targetIntel",
    "battle.scouted",
    "battle.remainingCells",
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

test("Telegram Stars support has complete localized copy and safe amount interpolation", () => {
  const supportKeys = [
    "support.entry",
    "support.entryDescription",
    "support.title",
    "support.voluntary",
    "support.amountLabel",
    "support.customAmount",
    "support.customPlaceholder",
    "support.rangeError",
    "support.terms",
    "support.termsLink",
    "support.continue",
    "support.confirmTitle",
    "support.confirmAmount",
    "support.pay",
    "support.back",
    "support.creating",
    "support.opening",
    "support.verifying",
    "support.thanks",
    "support.pending",
    "support.confirmationPending",
    "support.cancelled",
    "support.failed",
    "support.unavailable",
    "support.retry",
    "support.close",
  ];

  for (const language of languages) {
    for (const key of supportKeys) {
      assert.notEqual(t(language.code, key, { amount: 360 }), key, `${language.code}:${key}`);
    }
    assert.match(t(language.code, "support.confirmAmount", { amount: 360 }), /360/u);
    assert.doesNotMatch(t(language.code, "support.confirmAmount", { amount: 360 }), /\{amount\}/u);
  }
});

test("legacy online battles explain why no replay can be opened", () => {
  assert.equal(t("en", "archive.historicalUnavailable"), "Replay unavailable for this historical battle.");
  assert.equal(t("ru", "archive.historicalUnavailable"), "Повтор недоступен для этого исторического боя.");
  assert.equal(t("zh-CN", "archive.historicalUnavailable"), "此历史战斗没有可用回放。");
});

test("replay range positions are announced as natural localized text", () => {
  assert.equal(t("en", "replay.position", { turn: 12, total: 47 }), "Move 12 of 47");
  assert.equal(t("ru", "replay.position", { turn: 12, total: 47 }), "Ход 12 из 47");
  assert.equal(t("zh-CN", "replay.position", { turn: 12, total: 47 }), "第 12 步，共 47 步");
});

test("private replay errors are distinct and localized in every language", () => {
  for (const language of languages) {
    const messages = [
      t(language.code, "replayArchive.signInRequired"),
      t(language.code, "replayArchive.forbidden"),
      t(language.code, "replayArchive.notFound"),
      t(language.code, "replayArchive.unavailable"),
      t(language.code, "replayArchive.network"),
    ];
    assert.equal(new Set(messages).size, messages.length);
    assert.ok(messages.every((message) => !message.startsWith("replayArchive.")));
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

test("getInitialLanguage uses only browser locale before platform hydration", () => {
  withLanguageGlobals({ browser: "en-US" }, () => {
    assert.equal(i18n.getInitialLanguage(), "en");
  });
  withLanguageGlobals({ browser: "zh-Hans-CN" }, () => {
    assert.equal(i18n.getInitialLanguage(), "zh-CN");
  });
  withLanguageGlobals({ browser: "ru-RU" }, () => {
    assert.equal(i18n.getInitialLanguage(), "ru");
  });
  withLanguageGlobals({ browser: "fr-FR" }, () => {
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

function withLanguageGlobals({ browser }, callback) {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() {
        assert.fail("initial language must not read persisted storage");
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
