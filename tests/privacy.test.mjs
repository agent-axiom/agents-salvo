import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = readFileSync("src/app.js", "utf8");

function localizedSection(document, language, nextLanguage = null) {
  const start = document.indexOf(`<section id="${language}"`);
  const end = nextLanguage
    ? document.indexOf(`<section id="${nextLanguage}"`, start)
    : document.indexOf("</body>", start);
  assert.ok(start >= 0, `localized document must include ${language}`);
  assert.ok(end > start, `localized document must close ${language}`);
  return document.slice(start, end);
}

function localizedSections(document) {
  return {
    ru: localizedSection(document, "ru", "en"),
    en: localizedSection(document, "en", "zh-CN"),
    "zh-CN": localizedSection(document, "zh-CN"),
  };
}

function textOnly(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function paragraphTexts(html) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gu)].map((match) => textOnly(match[1]));
}

function assertParagraph(html, pattern, message) {
  assert.equal(
    paragraphTexts(html).some((paragraph) => pattern.test(paragraph)),
    true,
    message ?? `expected one paragraph to match ${pattern}`,
  );
}

test("support terms are voluntary and confer no benefits in every locale", () => {
  assert.equal(existsSync("src/support.html"), true, "support terms source must exist");
  const support = readFileSync("src/support.html", "utf8");
  const sections = localizedSections(support);

  assert.match(support, /<link rel="canonical" href="https:\/\/agent-axiom\.github\.io\/agents-salvo\/support\.html" \/>/);
  assert.match(support, /href="https:\/\/agent-axiom\.github\.io\/agents-salvo\/privacy\.html"/);
  assert.match(support, /<main>\s*<section id="ru"/u);
  assert.match(support, /<\/section>\s*<\/main>\s*<\/body>/u);

  assertParagraph(sections.ru, /поддержк[а-яё]*.*добровольн.*(можете не выбирать сумму|не поддерживать)/i);
  assertParagraph(sections.ru, /выбранн[а-яё]* сумм[а-яё]*.*Stars.*один раз/i);
  assertParagraph(sections.ru, /не является покупкой.*не является.*пожертвованием.*налог/i);
  assertParagraph(sections.ru, /не да[её]т.*(игров[а-яё]* преимуществ|доступ[а-яё]* к игре).*(профил|рейтинг|значк)/i);
  assertParagraph(sections.ru, /Telegram.*обрабатывает.*(плат[её]ж|транзакц)/i);
  assertParagraph(sections.ru, /возврат.*GitHub Issues/i);
  assertParagraph(sections.ru, /Telegram Support.*не.*спор/i);
  assertParagraph(sections.ru, /не публикуйте.*session token.*invoice payload.*(charge ID|идентификатор списания)/i);
  assertParagraph(sections.ru, /\/paysupport.*безопасн[а-яё]* идентификатор/i);
  assertParagraph(sections.ru, /публичн[а-яё]* обращен.*только.*идентификатор.*возврат.*исходн[а-яё]* Telegram-аккаунт/i);

  assertParagraph(sections.en, /support is.*voluntary.*(may choose no amount|do not have to support)/i);
  assertParagraph(sections.en, /selected Stars amount.*charged once/i);
  assertParagraph(sections.en, /not a purchase.*not a tax-deductible donation/i);
  assertParagraph(sections.en, /no gameplay.*(profile|rating|badge)/i);
  assertParagraph(sections.en, /Telegram processes.*(payment|transaction)/i);
  assertParagraph(sections.en, /refund.*GitHub Issues/i);
  assertParagraph(sections.en, /Telegram Support.*cannot.*merchant disputes/i);
  assertParagraph(sections.en, /do not publish.*session token.*invoice payload.*charge ID/i);
  assertParagraph(sections.en, /\/paysupport.*safe support reference/i);
  assertParagraph(sections.en, /public issue.*only.*reference.*refund.*original Telegram account/i);

  assertParagraph(sections["zh-CN"], /支持完全自愿.*(可以不选择任何金额|无需提供支持)/);
  assertParagraph(sections["zh-CN"], /所选.*Stars.*仅收取一次/);
  assertParagraph(sections["zh-CN"], /不是购买.*不属于.*可抵税捐赠/);
  assertParagraph(sections["zh-CN"], /不会获得.*(游戏优势|游戏内容).*(个人资料|评级|徽章)/);
  assertParagraph(sections["zh-CN"], /Telegram.*处理.*(付款|交易)/);
  assertParagraph(sections["zh-CN"], /退款.*GitHub Issues/);
  assertParagraph(sections["zh-CN"], /Telegram Support.*无法.*商家争议/);
  assertParagraph(sections["zh-CN"], /请勿公开.*session token.*invoice payload.*charge ID/);
  assertParagraph(sections["zh-CN"], /\/paysupport.*安全.*参考号/);
  assertParagraph(sections["zh-CN"], /公开问题.*只.*参考号.*退款.*原 Telegram 账号/);
});

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
  assert.match(privacy, /20 July 2026/);
  assert.match(privacy, /<main>\s*<section id="ru"/u);
  assert.match(privacy, /<\/section>\s*<\/main>\s*<\/body>/u);
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
  const sections = localizedSections(privacy);

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
  const sections = localizedSections(privacy);

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

test("privacy notice keeps payment receipt fields private in every locale", () => {
  const privacy = readFileSync("src/privacy.html", "utf8");
  const sections = localizedSections(privacy);

  assert.match(privacy, /<link rel="canonical" href="https:\/\/agent-axiom\.github\.io\/agents-salvo\/privacy\.html" \/>/);

  assertParagraph(sections.ru, /invoice ID.*invoice payload.*внутренн[а-яё]* user key.*Telegram ID плательщика.*(charge ID|идентификатор списания)/i);
  assertParagraph(sections.ru, /сумм[а-яё]*.*валют[а-яё]*.*XTR.*статус.*врем[а-яё]* создан.*истечен.*оплат.*ошиб.*возврат/i);
  assertParagraph(sections.ru, /провер.*плат[её]ж.*спор.*возврат.*приватн/i);
  assertParagraph(sections.ru, /непрозрачн[а-яё]* invoice ID.*публичн[а-яё]*.*безопасн[а-яё]* идентификатор.*не раскрывает/i);
  assertParagraph(sections.ru, /не используются.*(публичн[а-яё]* профил|рейтинг).*подбор.*значк.*лидерборд/i);
  assertParagraph(sections.ru, /неоплаченн[а-яё]*.*30 дн.*оплаченн[а-яё]*.*возвращ[а-яё]*.*удален/i);

  assertParagraph(sections.en, /invoice ID.*invoice payload.*internal user key.*Telegram payer ID.*charge ID/i);
  assertParagraph(sections.en, /amount.*currency.*XTR.*payment status.*creation.*expiry.*payment.*failure.*refund timestamps/i);
  assertParagraph(sections.en, /payment verification.*disputes.*refunds.*private/i);
  assertParagraph(sections.en, /opaque invoice ID.*public.*safe support reference.*does not reveal/i);
  assertParagraph(sections.en, /not used.*public profile.*rating.*matchmaking.*badges.*leaderboard/i);
  assertParagraph(sections.en, /unpaid.*30 days.*paid.*refunded.*deletion/i);

  assertParagraph(sections["zh-CN"], /invoice ID.*invoice payload.*内部 user key.*Telegram 付款人 ID.*charge ID/);
  assertParagraph(sections["zh-CN"], /金额.*币种.*XTR.*付款状态.*创建.*到期.*付款.*失败.*退款时间/);
  assertParagraph(sections["zh-CN"], /付款验证.*争议.*退款.*私密/);
  assertParagraph(sections["zh-CN"], /不透明 invoice ID.*公开.*安全支持参考号.*不会泄露/);
  assertParagraph(sections["zh-CN"], /不会用于.*公开个人资料.*评级.*匹配.*徽章.*排行榜/);
  assertParagraph(sections["zh-CN"], /未付款.*30 天.*已付款.*已退款.*删除/);
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
  assert.equal(existsSync(join(buildOutput, "support.html")), true);
  const builtSupport = readFileSync(join(buildOutput, "support.html"), "utf8");
  assert.match(builtSupport, /rel="canonical" href="https:\/\/agent-axiom\.github\.io\/agents-salvo\/support\.html"/u);
  for (const language of ["ru", "en", "zh-CN"]) {
    assert.match(builtSupport, new RegExp(`<section id="${language}"`, "u"));
  }
  assert.match(builtSupport, /support is voluntary/i);
});
