const textEncoder = new TextEncoder();
const sessionVersion = 1;

export async function verifyTelegramLoginPayload(
  payload,
  botToken,
  { now = Math.floor(Date.now() / 1000), maxAgeSeconds = 86400 } = {},
) {
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Telegram payload is required");
  }
  if (!payload.id || !payload.auth_date || !payload.hash) {
    throw new Error("Telegram payload is incomplete");
  }

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) {
    throw new Error("Telegram auth date is invalid");
  }
  if (now - authDate > maxAgeSeconds) {
    throw new Error("Telegram login expired");
  }

  const expectedHash = await telegramPayloadHash(payload, botToken);
  if (!timingSafeEqualHex(expectedHash, String(payload.hash))) {
    throw new Error("Invalid Telegram signature");
  }

  return normalizeTelegramUser(payload);
}

export async function createSessionToken(
  user,
  secret,
  { now = Math.floor(Date.now() / 1000), ttlSeconds = 60 * 60 * 24 * 30 } = {},
) {
  if (!secret) {
    throw new Error("Session secret is not configured");
  }
  const payload = {
    v: sessionVersion,
    sub: `${user.provider}:${user.id}`,
    user,
    iat: now,
    exp: now + ttlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await signSessionPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(
  token,
  secret,
  { now = Math.floor(Date.now() / 1000) } = {},
) {
  if (!secret) {
    throw new Error("Session secret is not configured");
  }
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) {
    throw new Error("Session token is invalid");
  }

  const expectedSignature = await signSessionPayload(encodedPayload, secret);
  if (!timingSafeEqual(expectedSignature, signature)) {
    throw new Error("Invalid session signature");
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (payload.v !== sessionVersion || !payload.user || !payload.exp) {
    throw new Error("Session token is invalid");
  }
  if (payload.exp <= now) {
    throw new Error("Session expired");
  }
  return payload.user;
}

export function parseBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

export function publicUser(user) {
  if (!user) {
    return null;
  }
  return {
    provider: user.provider,
    id: String(user.id),
    name: user.name || "",
    username: user.username || "",
    photoUrl: user.photoUrl || "",
  };
}

async function telegramPayloadHash(payload, botToken) {
  const dataCheckString = Object.entries(payload)
    .filter(([key]) => key !== "hash")
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await crypto.subtle.digest("SHA-256", textEncoder.encode(botToken));
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(dataCheckString));
  return bytesToHex(new Uint8Array(signature));
}

async function signSessionPayload(encodedPayload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(encodedPayload));
  return base64UrlEncode(signature);
}

function normalizeTelegramUser(payload) {
  const firstName = String(payload.first_name || "").trim();
  const lastName = String(payload.last_name || "").trim();
  const username = String(payload.username || "").trim();
  const name = [firstName, lastName].filter(Boolean).join(" ") || username || `Telegram ${payload.id}`;
  return publicUser({
    provider: "telegram",
    id: payload.id,
    name,
    username,
    photoUrl: payload.photo_url || "",
  });
}

function base64UrlEncode(value) {
  const bytes =
    typeof value === "string"
      ? textEncoder.encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

function timingSafeEqualHex(first, second) {
  if (!/^[a-f0-9]+$/i.test(first) || !/^[a-f0-9]+$/i.test(second)) {
    return false;
  }
  return timingSafeEqual(first.toLowerCase(), second.toLowerCase());
}

function timingSafeEqual(first, second) {
  if (first.length !== second.length) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < first.length; index += 1) {
    result |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return result === 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
