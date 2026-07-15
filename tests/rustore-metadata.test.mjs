import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const metadataPath = "distribution/rustore/metadata.ru.md";
const checklistPath = "distribution/rustore/moderation-checklist.md";

function section(source, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^## ${escaped}\\s*\\n+([\\s\\S]*?)(?=^## |\\Z)`, "m"));
  return match?.[1].trim() ?? "";
}

test("RuStore listing copy respects catalog constraints", () => {
  assert.equal(existsSync(metadataPath), true);
  const metadata = readFileSync(metadataPath, "utf8");
  const name = section(metadata, "Название");
  const shortDescription = section(metadata, "Краткое описание");
  const longDescription = section(metadata, "Подробное описание");
  const releaseNotes = section(metadata, "Что нового");

  assert.equal(name, "Залп");
  assert.ok([...name].length <= 30);
  assert.ok([...shortDescription].length <= 80);
  assert.ok([...longDescription].length <= 4000);
  assert.ok(releaseNotes.length > 0);
  assert.doesNotMatch(metadata, /\b(лучший|единственный|официальный)\b/i);
  assert.doesNotMatch(metadata, /play\.google|apps\.apple|appgallery/i);
});

test("RuStore package documents data safety and moderator access", () => {
  assert.equal(existsSync(checklistPath), true);
  const metadata = readFileSync(metadataPath, "utf8");
  const checklist = readFileSync(checklistPath, "utf8");

  for (const value of [
    "io.github.agentaxiom.salvo",
    "INTERNET",
    "ACCESS_NETWORK_STATE",
    "VIBRATE",
    "https://agent-axiom.github.io/agents-salvo/privacy.html",
    "https://github.com/agent-axiom/agents-salvo/issues",
    "https://agents-salvo-room.if-ab6.workers.dev",
    "Telegram",
    "не продаются",
    "не используются для рекламы",
    "зашифрован",
  ]) {
    assert.match(metadata, new RegExp(value.replaceAll(".", "\\."), "i"));
  }
  assert.match(checklist, /оператор[а-я\s-]*персональн/i);
  assert.match(checklist, /владелец|owner action/i);
  assert.match(checklist, /собственн[а-я\s]+Telegram/i);
  assert.match(checklist, /8×8[^\n]*10×10[^\n]*ширин/i);
  assert.match(checklist, /16×16[^\n]*(панорам|прокрутк|масштаб)/i);
  assert.doesNotMatch(checklist, /Декларировано только разрешение `INTERNET`/);
});
