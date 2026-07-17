const textEncoder = new TextEncoder();
const authenticationErrorMessage = "Telegram Mini App authentication failed";
const maxInitDataBytes = 16 * 1024;
const maxTelegramId = 2 ** 52 - 1;
const maxNamePartLength = 128;
const maxUsernameLength = 64;
const maxLanguageCodeLength = 35;
const maxPhotoUrlLength = 2048;
const maxStartParamLength = 512;
const allowedFields = new Set([
  "auth_date",
  "can_send_after",
  "chat",
  "chat_instance",
  "chat_type",
  "hash",
  "query_id",
  "receiver",
  "signature",
  "start_param",
  "user",
]);

export async function verifyTelegramMiniAppInitData(
  rawInitData,
  botToken,
  {
    now = Math.floor(Date.now() / 1000),
    maxAgeSeconds = 300,
    maxFutureSeconds = 60,
  } = {},
) {
  try {
    if (typeof botToken !== "string" || botToken.length === 0) {
      throw authenticationError();
    }
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(maxAgeSeconds) ||
      maxAgeSeconds < 0 ||
      !Number.isFinite(maxFutureSeconds) ||
      maxFutureSeconds < 0
    ) {
      throw authenticationError();
    }

    const fields = parseInitData(rawInitData);
    const suppliedHash = requireHexHash(fields.get("hash"));
    const dataCheckString = [...fields]
      .filter(([key]) => key !== "hash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secret = await hmac(textEncoder.encode("WebAppData"), botToken);
    const expectedHash = bytesToHex(await hmac(secret, dataCheckString));
    if (!timingSafeEqualHex(expectedHash, suppliedHash)) {
      throw authenticationError();
    }

    const authDate = strictEpoch(fields.get("auth_date"));
    if (now - authDate > maxAgeSeconds || authDate - now > maxFutureSeconds) {
      throw authenticationError();
    }
    return normalizeResult(fields);
  } catch {
    throw authenticationError();
  }
}

function parseInitData(rawInitData) {
  if (
    typeof rawInitData !== "string" ||
    rawInitData.length === 0 ||
    textEncoder.encode(rawInitData).byteLength > maxInitDataBytes
  ) {
    throw authenticationError();
  }

  validateQueryEncoding(rawInitData);
  const fields = new Map();
  for (const [key, value] of new URLSearchParams(rawInitData)) {
    if (!allowedFields.has(key) || fields.has(key)) {
      throw authenticationError();
    }
    fields.set(key, value);
  }
  for (const requiredField of ["hash", "auth_date", "user"]) {
    if (!fields.has(requiredField)) {
      throw authenticationError();
    }
  }
  return fields;
}

function validateQueryEncoding(rawInitData) {
  for (const component of rawInitData.split("&")) {
    const separatorIndex = component.indexOf("=");
    if (separatorIndex <= 0) {
      throw authenticationError();
    }
    decodeQueryComponent(component.slice(0, separatorIndex));
    decodeQueryComponent(component.slice(separatorIndex + 1));
  }
}

function decodeQueryComponent(value) {
  try {
    decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw authenticationError();
  }
}

function requireHexHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw authenticationError();
  }
  return value;
}

function strictEpoch(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw authenticationError();
  }
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) {
    throw authenticationError();
  }
  return epoch;
}

function normalizeResult(fields) {
  const telegramUser = JSON.parse(fields.get("user"));
  if (!isPlainObject(telegramUser)) {
    throw authenticationError();
  }
  if (
    !Number.isSafeInteger(telegramUser.id) ||
    telegramUser.id <= 0 ||
    telegramUser.id > maxTelegramId ||
    (telegramUser.is_bot !== undefined && telegramUser.is_bot !== false)
  ) {
    throw authenticationError();
  }

  const firstName = requiredBoundedString(telegramUser.first_name, maxNamePartLength).trim();
  const lastName = optionalBoundedString(telegramUser.last_name, maxNamePartLength).trim();
  const username = optionalBoundedString(telegramUser.username, maxUsernameLength).trim();
  const languageCode = optionalBoundedString(telegramUser.language_code, maxLanguageCodeLength).trim();
  const photoUrl = optionalBoundedString(telegramUser.photo_url, maxPhotoUrlLength);
  const startParam = optionalBoundedString(fields.get("start_param"), maxStartParamLength);
  if (!firstName || !validPhotoUrl(photoUrl)) {
    throw authenticationError();
  }

  return {
    user: {
      provider: "telegram",
      id: String(telegramUser.id),
      name: [firstName, lastName].filter(Boolean).join(" "),
      username,
      photoUrl,
    },
    languageCode,
    startParam,
  };
}

function requiredBoundedString(value, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw authenticationError();
  }
  return value;
}

function optionalBoundedString(value, maximumLength) {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw authenticationError();
  }
  return value;
}

function validPhotoUrl(value) {
  if (!value) {
    return true;
  }
  try {
    return value === value.trim() && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(value)));
}

function timingSafeEqualHex(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authenticationError() {
  return new Error(authenticationErrorMessage);
}
