import test from "node:test";
import assert from "node:assert/strict";
import { resolveRuStoreReleaseNotes } from "../scripts/rustore-release-notes.mjs";
import { runRuStoreCli } from "../scripts/rustore-api.mjs";

test("blank release notes use only the prepared What's New section", () => {
  const readMetadata = () => "# Карточка\n\n## Что нового\n\nНовая графика.\nВторая строка.\n\n## Контакты\nprivate@example.com\n";
  for (const override of ["", " \t\n"]) {
    assert.equal(resolveRuStoreReleaseNotes({ override, readMetadata }), "Новая графика.\nВторая строка.");
  }
});

test("manual release notes win without reading the metadata", () => {
  assert.equal(resolveRuStoreReleaseNotes({
    override: "  Ручное описание.\n ",
    readMetadata: () => assert.fail("metadata should not be needed for an override"),
  }), "Ручное описание.");
});

test("release notes support CRLF, subsections and a final section without newline", () => {
  assert.equal(resolveRuStoreReleaseNotes({
    override: "",
    readMetadata: () => "## Что нового\r\n\r\nОбновление.\r\n### Интерфейс\r\nНовая графика.",
  }), "Обновление.\n### Интерфейс\nНовая графика.");
});

test("missing, empty and oversized release notes fail before publication", () => {
  for (const [metadata, pattern] of [
    ["## Контакты\nПоддержка", /Что нового/],
    ["## Что нового\n \n## Контакты\nПоддержка", /empty/],
    [`## Что нового\n${"x".repeat(5001)}`, /5000/],
  ]) {
    assert.throws(() => resolveRuStoreReleaseNotes({ override: "", readMetadata: () => metadata }), pattern);
  }
  assert.throws(() => resolveRuStoreReleaseNotes({ override: "x".repeat(5001) }), /5000/);
  assert.equal(resolveRuStoreReleaseNotes({ override: "x".repeat(5000) }).length, 5000);
  assert.throws(() => resolveRuStoreReleaseNotes({
    override: "",
    readMetadata: () => { throw new Error("metadata unavailable"); },
  }), /metadata unavailable/);
});

test("CLI submission with empty input uses the same repository notes as preflight", async () => {
  let received;
  await runRuStoreCli({
    argv: ["submit"],
    env: {
      RUSTORE_KEY_ID: "test-key-id",
      RUSTORE_PRIVATE_KEY: "test-private-key",
      RUSTORE_DEVELOPER_EMAIL: "release@example.com",
      RUSTORE_APK_PATH: "/tmp/app-release.apk",
    },
    stdout: { write() {} },
    operations: {
      submit: async (options) => {
        received = options;
        return { packageName: "io.github.agentaxiom.salvo", versionId: 777, rollout: 5 };
      },
    },
  });
  assert.equal(received.releaseNotes, resolveRuStoreReleaseNotes({ override: "" }));
  assert.ok(received.releaseNotes.length > 0);
  assert.doesNotMatch(received.releaseNotes, /## Контакты/);
});

test("CLI rejects oversized notes before invoking any RuStore operation", async () => {
  await assert.rejects(() => runRuStoreCli({
    argv: ["submit"],
    env: {
      RUSTORE_KEY_ID: "test-key-id",
      RUSTORE_PRIVATE_KEY: "test-private-key",
      RUSTORE_DEVELOPER_EMAIL: "release@example.com",
      RUSTORE_APK_PATH: "/tmp/app-release.apk",
      RUSTORE_RELEASE_NOTES: "x".repeat(5001),
    },
    operations: { submit: async () => assert.fail("RuStore must not be contacted") },
  }), /5000/);
});
