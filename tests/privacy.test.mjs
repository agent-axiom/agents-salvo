import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = readFileSync("src/app.js", "utf8");

function privacySection(privacy, language, nextLanguage = null) {
  const start = privacy.indexOf(`<section id="${language}"`);
  const end = nextLanguage
    ? privacy.indexOf(`<section id="${nextLanguage}"`, start)
    : privacy.indexOf("</body>", start);
  assert.ok(start >= 0, `privacy notice must include ${language}`);
  assert.ok(end > start, `privacy notice must close ${language}`);
  return privacy.slice(start, end);
}

test("privacy notice describes account and gameplay processing in all locales", () => {
  assert.equal(existsSync("src/privacy.html"), true, "privacy notice source must exist");
  const privacy = readFileSync("src/privacy.html", "utf8");

  for (const language of ["ru", "en", "zh-CN"]) {
    assert.match(privacy, new RegExp(`id=["']${language}["']`));
  }
  for (const disclosure of [
    "Telegram ID",
    "Telegram username",
    "profile photo",
    "match statistics",
    "battle replays",
    "Cloudflare Pages",
    "Cloudflare Workers",
    "Cloudflare D1",
    "30 days",
    "without signing in",
    "no advertising",
    "no analytics",
    "session token",
    "https://github.com/agent-axiom/agents-salvo/issues",
  ]) {
    assert.match(privacy, new RegExp(disclosure, "i"));
  }
  assert.match(privacy, /15 July 2026/);
  assert.match(privacy, /until you request deletion/i);
  assert.match(privacy, /do not include.*token|never include.*token/i);
  assert.match(privacy, /Agent Axiom/);
  assert.match(privacy, /оператор персональных данных/i);
  assert.match(privacy, /data controller/i);
  assert.match(privacy, /个人信息处理者/);
  assert.match(privacy, /согласие.*до входа|consent.*before signing in|登录前.*同意/is);
  assert.match(privacy, /leaderboard[^<]*(display name|отображаемое имя|显示名称)[^<]*(rating|рейтинг|评级)/i);
  assert.match(privacy, /username[^<]*(not public|не публику|不会公开)/i);
  assert.match(privacy, /profile photo[^<]*(not public|не публику|不会公开)/i);
});

test("privacy notice explains Telegram Mini App identity processing in all locales", () => {
  const privacy = readFileSync("src/privacy.html", "utf8");
  const sections = {
    ru: privacySection(privacy, "ru", "en"),
    en: privacySection(privacy, "en", "zh-CN"),
    "zh-CN": privacySection(privacy, "zh-CN"),
  };

  assert.match(sections.ru, /подписанные данные запуска Telegram[\s\S]*Cloudflare Workers[\s\S]*проверки личности/i);
  assert.match(sections.ru, /исходные данные запуска не сохраняются/i);
  assert.match(sections.ru, /те же записи профиля/i);

  assert.match(sections.en, /signed Telegram launch data[\s\S]*Cloudflare Workers[\s\S]*identity validation/i);
  assert.match(sections.en, /raw launch data is not persisted/i);
  assert.match(sections.en, /same profile records/i);

  assert.match(sections["zh-CN"], /已签名的 Telegram 启动数据[\s\S]*Cloudflare Workers[\s\S]*身份验证/);
  assert.match(sections["zh-CN"], /原始启动数据不会被持久保存/);
  assert.match(sections["zh-CN"], /同一份档案记录/);
});

test("privacy notice distinguishes explicit Telegram consent from automatic Mini App validation", () => {
  const privacy = readFileSync("src/privacy.html", "utf8");
  const sections = {
    ru: privacySection(privacy, "ru", "en"),
    en: privacySection(privacy, "en", "zh-CN"),
    "zh-CN": privacySection(privacy, "zh-CN"),
  };

  assert.match(sections.ru, /на сайте и в установленном приложении[\s\S]*явное согласие[\s\S]*перед входом через Telegram/i);
  assert.match(sections.ru, /Telegram Mini App[\s\S]*проверка личности начинается автоматически[\s\S]*подписанных данных запуска/i);
  assert.match(sections.ru, /на сайте и в установленном приложении[\s\S]*без входа/i);

  assert.match(sections.en, /website and installed app[\s\S]*explicit consent[\s\S]*before Telegram sign-in/i);
  assert.match(sections.en, /Telegram Mini App[\s\S]*identity validation starts automatically[\s\S]*signed launch data/i);
  assert.match(sections.en, /without signing in[\s\S]*website and installed app/i);

  assert.match(sections["zh-CN"], /网站和已安装的应用[\s\S]*Telegram 登录前[\s\S]*明确同意/);
  assert.match(sections["zh-CN"], /Telegram Mini App[\s\S]*已签名启动数据[\s\S]*身份验证会在打开时自动开始/);
  assert.match(sections["zh-CN"], /网站和已安装应用[\s\S]*无需登录/);
});

test("privacy notice is built and linked from Telegram authentication", () => {
  assert.match(app, /data-action=["']open-privacy["']/);
  assert.match(app, /href=["']\/agents-salvo\/privacy\.html["']/);
  assert.match(app, /canonicalPrivacyUrl/);
  assert.match(app, /platform\.isNative\(\)[\s\S]*platform\.openExternalUrl\(canonicalPrivacyUrl\)/);

  const buildOutput = mkdtempSync(join(tmpdir(), "salvo-privacy-build-"));
  const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
    encoding: "utf8",
    env: { ...process.env, SALVO_BUILD_DIR: buildOutput },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(buildOutput, "privacy.html")), true);
});
