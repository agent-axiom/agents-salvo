const botUsernamePattern = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const roomCodePattern = /^[A-Z0-9]{4,12}$/;
const replayIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const roomStartPattern = /^room_([A-Z0-9]{4,12})$/;
const replayStartPattern = /^replay_([A-Za-z0-9-]{1,128})$/;

export function parseTelegramStartParam(value) {
  if (typeof value !== "string") return null;

  const roomMatch = roomStartPattern.exec(value);
  if (roomMatch) {
    return { type: "room", roomCode: roomMatch[1] };
  }

  const replayMatch = replayStartPattern.exec(value);
  if (replayMatch) {
    return { type: "replay", replayId: replayMatch[1] };
  }
  return null;
}

export function telegramRoomInviteUrl(botUsername, roomCode) {
  requireBotUsername(botUsername);
  if (typeof roomCode !== "string" || !roomCodePattern.test(roomCode)) {
    throw new TypeError("Invalid Telegram room code");
  }
  return telegramLaunchUrl(botUsername, ["room", roomCode].join("_"));
}

export function telegramReplayUrl(botUsername, replayId) {
  requireBotUsername(botUsername);
  if (typeof replayId !== "string" || !replayIdPattern.test(replayId)) {
    throw new TypeError("Invalid Telegram replay ID");
  }
  return telegramLaunchUrl(botUsername, ["replay", replayId].join("_"));
}

function requireBotUsername(botUsername) {
  if (typeof botUsername !== "string" || !botUsernamePattern.test(botUsername)) {
    throw new TypeError("Invalid Telegram bot username");
  }
}

function telegramLaunchUrl(botUsername, startParam) {
  const url = new URL("https://t.me/");
  url.pathname = botUsername;
  const search = new URLSearchParams();
  search.set("startapp", startParam);
  url.search = search;
  return url.toString();
}
