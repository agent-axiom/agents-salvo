import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTelegramStartParam,
  telegramMainMiniAppUrl,
  telegramReplayUrl,
  telegramRoomInviteUrl,
} from "../src/telegram-launch.js";

test("parseTelegramStartParam accepts only exact room and replay launch patterns", () => {
  assert.deepEqual(parseTelegramStartParam("room_ABCD"), {
    type: "room",
    roomCode: "ABCD",
  });
  assert.deepEqual(parseTelegramStartParam("room_A1B2C3D4E5F6"), {
    type: "room",
    roomCode: "A1B2C3D4E5F6",
  });
  assert.deepEqual(parseTelegramStartParam("replay_replay-123"), {
    type: "replay",
    replayId: "replay-123",
  });
  assert.deepEqual(parseTelegramStartParam(`replay_${"a".repeat(128)}`), {
    type: "replay",
    replayId: "a".repeat(128),
  });
});

test("parseTelegramStartParam returns null for unknown, malformed, and hostile values", () => {
  const invalidValues = [
    undefined,
    null,
    false,
    42,
    {},
    [],
    "",
    "menu",
    "room_abcd",
    "room_ABC",
    "room_ABCDEFGHIJKLM",
    "room_ABCD?x",
    "room_ABCD&startapp=replay_x",
    "room_AB/CD",
    "room_АБВГ",
    " room_ABCD",
    "room_ABCD ",
    "replay_",
    `replay_${"a".repeat(129)}`,
    "replay_a_b",
    "replay_a/b",
    "replay_a?b",
    "replay_a#b",
    "replay_a%b",
    "replay_данные",
  ];

  for (const value of invalidValues) {
    assert.equal(parseTelegramStartParam(value), null, String(value));
  }
});

test("canonical Telegram room and replay links use encoded startapp parameters", () => {
  assert.equal(
    telegramMainMiniAppUrl("agents_salvo_bot"),
    "https://t.me/agents_salvo_bot?startapp",
  );
  assert.equal(
    telegramRoomInviteUrl("agents_salvo_bot", "ABCD"),
    "https://t.me/agents_salvo_bot?startapp=room_ABCD",
  );
  assert.equal(
    telegramReplayUrl("Agents_Salvo_Bot", "replay-123"),
    "https://t.me/Agents_Salvo_Bot?startapp=replay_replay-123",
  );
});

test("launch links reject invalid bot usernames including URL and credential syntax", () => {
  const invalidUsernames = [
    undefined,
    null,
    "",
    "abcd",
    "1agents",
    "_agents",
    "agents-salvo",
    "agents.salvo",
    "agents/salvo",
    "agents?startapp=room_EVIL",
    "agents#fragment",
    "user@evil.test",
    "https://t.me/agents_salvo_bot",
    "аgents_salvo_bot",
    `a${"b".repeat(32)}`,
  ];

  for (const botUsername of invalidUsernames) {
    assert.throws(() => telegramMainMiniAppUrl(botUsername), { name: "TypeError" });
    assert.throws(() => telegramRoomInviteUrl(botUsername, "ABCD"), { name: "TypeError" });
    assert.throws(() => telegramReplayUrl(botUsername, "replay-123"), { name: "TypeError" });
  }
});

test("launch links reject malformed room codes and replay identifiers", () => {
  for (const roomCode of [
    undefined,
    null,
    "",
    "ABC",
    "ABCDEFGHIJKLM",
    "abcd",
    "AB_D",
    "AB/CD",
    "AB?D",
    "АБВГ",
  ]) {
    assert.throws(() => telegramRoomInviteUrl("agents_salvo_bot", roomCode), {
      name: "TypeError",
    }, String(roomCode));
  }

  for (const replayId of [
    undefined,
    null,
    "",
    "a".repeat(129),
    "replay_id",
    "replay/id",
    "replay?id",
    "replay&id",
    "replay#id",
    "replay%20id",
    "повтор",
  ]) {
    assert.throws(() => telegramReplayUrl("agents_salvo_bot", replayId), {
      name: "TypeError",
    }, String(replayId));
  }
});
