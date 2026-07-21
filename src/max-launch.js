const botNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{2,63}$/;
const roomCodePattern = /^[A-Z0-9]{4,12}$/;
const replayIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const roomStartPattern = /^room_([A-Z0-9]{4,12})$/;
const replayStartPattern = /^replay_([A-Za-z0-9-]{1,128})$/;

export function parseMaxStartParam(value) {
  if (typeof value !== "string") return null;
  const room = roomStartPattern.exec(value);
  if (room) return { type: "room", roomCode: room[1] };
  const replay = replayStartPattern.exec(value);
  if (replay) return { type: "replay", replayId: replay[1] };
  return null;
}

export function maxMainMiniAppUrl(botName) {
  requireBotName(botName);
  const url = new URL("https://max.ru/");
  url.pathname = botName;
  url.search = "?startapp";
  return url.toString();
}

export function maxRoomInviteUrl(botName, roomCode) {
  requireBotName(botName);
  if (typeof roomCode !== "string" || !roomCodePattern.test(roomCode)) {
    throw new TypeError("Invalid MAX room code");
  }
  return maxLaunchUrl(botName, `room_${roomCode}`);
}

export function maxReplayUrl(botName, replayId) {
  requireBotName(botName);
  if (typeof replayId !== "string" || !replayIdPattern.test(replayId)) {
    throw new TypeError("Invalid MAX replay ID");
  }
  return maxLaunchUrl(botName, `replay_${replayId}`);
}

function requireBotName(botName) {
  if (typeof botName !== "string" || !botNamePattern.test(botName)) {
    throw new TypeError("Invalid MAX bot name");
  }
}

function maxLaunchUrl(botName, startParam) {
  const url = new URL("https://max.ru/");
  url.pathname = botName;
  url.search = new URLSearchParams({ startapp: startParam });
  return url.toString();
}
