import assert from "node:assert/strict";
import test from "node:test";

import {
  maxMainMiniAppUrl,
  maxReplayUrl,
  maxRoomInviteUrl,
  parseMaxStartParam,
} from "../src/max-launch.js";

test("MAX launch parameters accept only canonical room and replay routes", () => {
  assert.deepEqual(parseMaxStartParam("room_ABCD"), {
    type: "room",
    roomCode: "ABCD",
  });
  assert.deepEqual(parseMaxStartParam("replay_replay-123"), {
    type: "replay",
    replayId: "replay-123",
  });

  for (const value of [
    undefined,
    null,
    "",
    "room_abc",
    "room_AB/CD",
    "replay_a_b",
    "replay_повтор",
    `replay_${"a".repeat(129)}`,
  ]) {
    assert.equal(parseMaxStartParam(value), null, String(value));
  }
});

test("MAX launch links target the configured bot and encode startapp routes", () => {
  assert.equal(
    maxMainMiniAppUrl("se13661945_bot"),
    "https://max.ru/se13661945_bot?startapp",
  );
  assert.equal(
    maxRoomInviteUrl("se13661945_bot", "ABCD"),
    "https://max.ru/se13661945_bot?startapp=room_ABCD",
  );
  assert.equal(
    maxReplayUrl("se13661945_bot", "replay-123"),
    "https://max.ru/se13661945_bot?startapp=replay_replay-123",
  );
});

test("MAX launch links reject unsafe bot names and route identifiers", () => {
  for (const botName of [
    undefined,
    "",
    "bad/name",
    "bad?startapp=room_EVIL",
    "https://max.ru/se13661945_bot",
    "бот",
  ]) {
    assert.throws(() => maxMainMiniAppUrl(botName), { name: "TypeError" });
  }

  assert.throws(() => maxRoomInviteUrl("se13661945_bot", "abc"), {
    name: "TypeError",
  });
  assert.throws(() => maxReplayUrl("se13661945_bot", "a/b"), {
    name: "TypeError",
  });
});
