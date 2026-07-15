import { publicUser } from "./auth.js";

const authorizationEndpoint = "https://oauth.telegram.org/auth";
const tokenEndpoint = "https://oauth.telegram.org/token";
const telegramIssuer = "https://oauth.telegram.org";
const allowedPlatforms = new Set(["web", "android", "ios"]);
const randomByteLength = 32;
const maxIdTokenLength = 16 * 1024;
const maxTokenResponseBytes = 64 * 1024;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function oidcConfigured(env) {
  return hasTrimmedString(env?.TELEGRAM_CLIENT_ID) && hasTrimmedString(env?.TELEGRAM_CLIENT_SECRET);
}

export async function createTelegramAuthorization(options = {}) {
  const { clientId, redirectUri, platform } = options;
  if (!allowedPlatforms.has(platform)) {
    throw new Error("Telegram authorization platform is invalid");
  }
  if (!hasTrimmedString(clientId) || !hasTrimmedString(redirectUri)) {
    throw new Error("Telegram authorization configuration is invalid");
  }

  const randomBytes = options.randomBytes ?? secureRandomBytes;
  if (typeof randomBytes !== "function") {
    throw new Error("Telegram authorization randomness is invalid");
  }

  const state = base64UrlEncode(await randomValue(randomBytes));
  const nonce = base64UrlEncode(await randomValue(randomBytes));
  const codeVerifier = base64UrlEncode(await randomValue(randomBytes));
  const challengeDigest = await crypto.subtle.digest("SHA-256", textEncoder.encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(challengeDigest));

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);

  return {
    url,
    flow: { state, nonce, codeVerifier, platform },
  };
}

export async function exchangeTelegramCode(options = {}) {
  try {
    const { code, redirectUri, clientId, clientSecret, codeVerifier } = options;
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (
      !hasTrimmedString(code) ||
      !hasTrimmedString(redirectUri) ||
      !hasTrimmedString(clientId) ||
      !hasTrimmedString(clientSecret) ||
      !hasTrimmedString(codeVerifier) ||
      typeof fetcher !== "function"
    ) {
      throw telegramAuthenticationError();
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("client_id", clientId);
    body.set("code_verifier", codeVerifier);

    const response = await fetcher(tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${base64Encode(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!isSuccessfulResponse(response)) {
      throw telegramAuthenticationError();
    }

    const responseText = await readBoundedResponseText(response);
    const payload = JSON.parse(responseText);
    if (
      !isRecord(payload) ||
      Object.hasOwn(payload, "error") ||
      typeof payload.id_token !== "string" ||
      payload.id_token.trim() === ""
    ) {
      throw telegramAuthenticationError();
    }
    return payload;
  } catch {
    throw telegramAuthenticationError();
  }
}

export async function verifyTelegramIdToken(idToken, options = {}) {
  try {
    if (typeof idToken !== "string" || idToken.length > maxIdTokenLength) {
      throw telegramAuthenticationError();
    }
    const segments = idToken.split(".");
    if (segments.length !== 3 || segments.some((segment) => segment === "")) {
      throw telegramAuthenticationError();
    }

    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    const header = parseJsonSegment(encodedHeader);
    const claims = parseJsonSegment(encodedClaims);
    const signature = base64UrlDecode(encodedSignature);
    if (!isRecord(header) || !isRecord(claims)) {
      throw telegramAuthenticationError();
    }
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.trim() === ""
    ) {
      throw telegramAuthenticationError();
    }

    const loadJwks = options.loadJwks;
    if (typeof loadJwks !== "function") {
      throw telegramAuthenticationError();
    }
    const jwks = await loadJwks();
    if (!isRecord(jwks) || !Array.isArray(jwks.keys)) {
      throw telegramAuthenticationError();
    }
    const signingJwk = jwks.keys.find(
      (jwk) =>
        isRecord(jwk) &&
        jwk.kid === header.kid &&
        jwk.kty === "RSA" &&
        (jwk.use === undefined || jwk.use === "sig") &&
        (jwk.alg === undefined || jwk.alg === "RS256") &&
        (jwk.key_ops === undefined || (Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify"))),
    );
    if (!signingJwk) {
      throw telegramAuthenticationError();
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      signingJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signature,
      textEncoder.encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!verified) {
      throw telegramAuthenticationError();
    }

    validateClaims(claims, options);
    return normalizeTelegramOidcUser(claims);
  } catch {
    throw telegramAuthenticationError();
  }
}

export function normalizeTelegramOidcUser(claims) {
  if (!hasTrimmedString(claims?.sub)) {
    throw telegramAuthenticationError();
  }
  const id = telegramProfileId(claims?.id);
  const explicitName = trimmedString(claims?.name);
  const givenName = trimmedString(claims?.given_name);
  const familyName = trimmedString(claims?.family_name);
  const username = trimmedString(claims?.preferred_username);
  const photoUrl = trimmedString(claims?.picture);
  const combinedName = [givenName, familyName].filter(Boolean).join(" ");

  return publicUser({
    provider: "telegram",
    id,
    name: explicitName || combinedName || username || `Telegram ${id}`,
    username,
    photoUrl,
  });
}

async function randomValue(randomBytes) {
  const bytes = await randomBytes(randomByteLength);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== randomByteLength) {
    throw new Error("Telegram authorization randomness must contain 32 bytes");
  }
  return bytes;
}

function secureRandomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function validateClaims(claims, options) {
  const currentTime = options.now ?? Math.floor(Date.now() / 1000);
  const expectedClientId = options.clientId;
  const expectedNonce = options.nonce;
  const audienceValid =
    claims.aud === expectedClientId ||
    (Array.isArray(claims.aud) && claims.aud.includes(expectedClientId));

  if (
    !hasTrimmedString(expectedClientId) ||
    !hasTrimmedString(expectedNonce) ||
    !Number.isFinite(currentTime) ||
    claims.iss !== telegramIssuer ||
    !audienceValid ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= currentTime ||
    !Number.isFinite(claims.iat) ||
    claims.iat > currentTime + 60 ||
    claims.nonce !== expectedNonce ||
    typeof claims.sub !== "string" ||
    claims.sub.trim() === "" ||
    telegramProfileId(claims.id) === ""
  ) {
    throw telegramAuthenticationError();
  }
}

function telegramProfileId(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return "";
}

function parseJsonSegment(segment) {
  return JSON.parse(textDecoder.decode(base64UrlDecode(segment)));
}

function base64UrlDecode(value) {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
    throw telegramAuthenticationError();
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) {
    throw telegramAuthenticationError();
  }
  return bytes;
}

function base64UrlEncode(bytes) {
  return base64EncodeBytes(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64Encode(value) {
  return base64EncodeBytes(textEncoder.encode(value));
}

function base64EncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function readBoundedResponseText(response) {
  const contentLength = response.headers?.get?.("Content-Length");
  if (contentLength !== null && contentLength !== undefined) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxTokenResponseBytes) {
      throw telegramAuthenticationError();
    }
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!(value instanceof Uint8Array)) {
          throw telegramAuthenticationError();
        }
        totalLength += value.byteLength;
        if (totalLength > maxTokenResponseBytes) {
          try {
            await reader.cancel();
          } catch {
            // The generic caller error is sufficient if cancellation also fails.
          }
          throw telegramAuthenticationError();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return textDecoder.decode(bytes);
  }

  if (typeof response.text !== "function") {
    throw telegramAuthenticationError();
  }
  const text = await response.text();
  if (textEncoder.encode(text).byteLength > maxTokenResponseBytes) {
    throw telegramAuthenticationError();
  }
  return text;
}

function isSuccessfulResponse(response) {
  if (!response || typeof response !== "object") {
    return false;
  }
  if (typeof response.ok === "boolean") {
    return response.ok;
  }
  return Number.isFinite(response.status) && response.status >= 200 && response.status < 300;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function telegramAuthenticationError() {
  return new Error("Telegram authentication failed");
}
