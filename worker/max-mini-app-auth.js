const textEncoder = new TextEncoder();
const authenticationErrorMessage = "MAX Mini App authentication failed";
const maxInitDataBytes = 16 * 1024;
const maxUserId = 2 ** 52 - 1;
const maxNamePartLength = 128;
const maxUsernameLength = 64;
const maxLanguageCodeLength = 35;
const maxPhotoUrlLength = 2048;
const maxStartParamLength = 512;
const allowedFields = new Set([
  "auth_date",
  "chat",
  "hash",
  "ip",
  "query_id",
  "start_param",
  "user",
]);

export async function verifyMaxMiniAppInitData(
  rawInitData,
  botToken,
  {
    now = Math.floor(Date.now() / 1000),
    maxAgeSeconds = 300,
    maxFutureSeconds = 60,
  } = {},
) {
  try {
    if (typeof botToken !== "string" || botToken.trim() === "") throw authenticationError();
    if (
      !Number.isFinite(now)
      || !Number.isFinite(maxAgeSeconds)
      || maxAgeSeconds < 0
      || !Number.isFinite(maxFutureSeconds)
      || maxFutureSeconds < 0
    ) {
      throw authenticationError();
    }

    const fields = parseInitData(rawInitData);
    const suppliedHash = requireHexHash(fields.get("hash"));
    const launchParams = [...fields]
      .filter(([key]) => key !== "hash")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secret = await hmac(textEncoder.encode("WebAppData"), botToken);
    const expectedHash = bytesToHex(await hmac(secret, launchParams));
    if (!timingSafeEqualHex(expectedHash, suppliedHash)) throw authenticationError();

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
    typeof rawInitData !== "string"
    || rawInitData.length === 0
    || textEncoder.encode(rawInitData).byteLength > maxInitDataBytes
  ) {
    throw authenticationError();
  }

  validateQueryEncoding(rawInitData);
  const fields = new Map();
  for (const [key, value] of new URLSearchParams(rawInitData)) {
    if (!allowedFields.has(key) || fields.has(key)) throw authenticationError();
    fields.set(key, value);
  }
  for (const required of ["hash", "auth_date", "user"]) {
    if (!fields.has(required)) throw authenticationError();
  }
  return fields;
}

function validateQueryEncoding(rawInitData) {
  for (const component of rawInitData.split("&")) {
    const separator = component.indexOf("=");
    if (separator <= 0) throw authenticationError();
    decodeQueryComponent(component.slice(0, separator));
    decodeQueryComponent(component.slice(separator + 1));
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
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw authenticationError();
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) throw authenticationError();
  return epoch;
}

function normalizeResult(fields) {
  const source = JSON.parse(fields.get("user"));
  if (!isPlainObject(source) || !Number.isSafeInteger(source.id)
    || source.id <= 0 || source.id > maxUserId) {
    throw authenticationError();
  }

  const firstName = requiredBoundedString(source.first_name, maxNamePartLength).trim();
  const lastName = optionalBoundedString(source.last_name, maxNamePartLength).trim();
  const username = optionalBoundedString(source.username, maxUsernameLength).trim();
  const languageCode = optionalBoundedString(
    source.language_code,
    maxLanguageCodeLength,
  ).trim();
  const photoUrl = optionalBoundedString(source.photo_url, maxPhotoUrlLength);
  const startParam = optionalBoundedString(fields.get("start_param"), maxStartParamLength);
  if (!firstName || !validPhotoUrl(photoUrl)) throw authenticationError();

  return {
    user: {
      provider: "max",
      id: String(source.id),
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
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximumLength) throw authenticationError();
  return value;
}

function validPhotoUrl(value) {
  if (!value) return true;
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
  if (left.length !== right.length) return false;
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
