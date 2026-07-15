import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  createTelegramAuthorization,
  exchangeTelegramCode,
  normalizeTelegramOidcUser,
  oidcConfigured,
  verifyTelegramIdToken,
} from "../worker/telegram-oidc.js";

const cryptoApi = globalThis.crypto ?? webcrypto;
const textEncoder = new TextEncoder();
const clientId = "123456";
const clientSecret = "telegram-client-secret";
const redirectUri = "https://worker.example/auth/telegram/mobile/callback?return=exact";
const issuer = "https://oauth.telegram.org";
const nonce = "expected-telegram-nonce";
const now = 1_752_576_000;
const keyId = "telegram-rsa-key";

const signingKeys = await cryptoApi.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const otherSigningKeys = await cryptoApi.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const ecKeys = await cryptoApi.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const publicJwk = {
  ...(await cryptoApi.subtle.exportKey("jwk", signingKeys.publicKey)),
  kid: keyId,
  alg: "RS256",
  use: "sig",
};
const ecPublicJwk = {
  ...(await cryptoApi.subtle.exportKey("jwk", ecKeys.publicKey)),
  kid: keyId,
  alg: "ES256",
  use: "sig",
};

test("oidcConfigured requires trimmed Telegram client credentials", () => {
  assert.equal(
    oidcConfigured({ TELEGRAM_CLIENT_ID: " 123456 ", TELEGRAM_CLIENT_SECRET: " secret " }),
    true,
  );
  assert.equal(oidcConfigured({ TELEGRAM_CLIENT_ID: "", TELEGRAM_CLIENT_SECRET: "secret" }), false);
  assert.equal(oidcConfigured({ TELEGRAM_CLIENT_ID: "123456", TELEGRAM_CLIENT_SECRET: " \t " }), false);
  assert.equal(oidcConfigured({ TELEGRAM_CLIENT_ID: 123456, TELEGRAM_CLIENT_SECRET: "secret" }), false);
  assert.equal(oidcConfigured(null), false);
});

test("createTelegramAuthorization creates independent high-entropy PKCE flow values", async () => {
  const requestedLengths = [];
  let invocation = 0;
  const randomBytes = (length) => {
    requestedLengths.push(length);
    invocation += 1;
    return Uint8Array.from({ length }, (_, index) => (invocation * 67 + index) % 256);
  };

  const request = await createTelegramAuthorization({
    clientId,
    redirectUri,
    platform: "android",
    randomBytes,
  });

  assert.equal(request.url.origin, "https://oauth.telegram.org");
  assert.equal(request.url.pathname, "/auth");
  assert.equal(request.url.searchParams.get("response_type"), "code");
  assert.equal(request.url.searchParams.get("scope"), "openid profile");
  assert.equal(request.url.searchParams.get("client_id"), clientId);
  assert.equal(request.url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(request.url.searchParams.get("state"), request.flow.state);
  assert.equal(request.url.searchParams.get("nonce"), request.flow.nonce);
  assert.equal(request.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(request.url.searchParams.has("client_secret"), false);
  assert.equal(request.flow.platform, "android");
  assert.deepEqual(requestedLengths, [32, 32, 32]);

  const flowSecrets = [request.flow.state, request.flow.nonce, request.flow.codeVerifier];
  assert.equal(new Set(flowSecrets).size, 3);
  for (const value of flowSecrets) {
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(value.includes("="), false);
    assert.equal(Buffer.from(value, "base64url").byteLength, 32);
  }

  const expectedChallenge = Buffer.from(
    await cryptoApi.subtle.digest("SHA-256", textEncoder.encode(request.flow.codeVerifier)),
  ).toString("base64url");
  assert.equal(request.url.searchParams.get("code_challenge"), expectedChallenge);
});

test("createTelegramAuthorization accepts only web, android, and ios platforms", async () => {
  for (const platform of ["web", "android", "ios"]) {
    const request = await createTelegramAuthorization({
      clientId,
      redirectUri,
      platform,
      randomBytes: sequencedRandomBytes(),
    });
    assert.equal(request.flow.platform, platform);
  }

  for (const platform of ["desktop", "", null, "Android"]) {
    await assert.rejects(
      () =>
        createTelegramAuthorization({
          clientId,
          redirectUri,
          platform,
          randomBytes: sequencedRandomBytes(),
        }),
      /platform/i,
    );
  }
});

test("createTelegramAuthorization rejects short injected randomness", async () => {
  await assert.rejects(
    () =>
      createTelegramAuthorization({
        clientId,
        redirectUri,
        platform: "web",
        randomBytes: () => new Uint8Array(16),
      }),
    /random/i,
  );
});

test("exchangeTelegramCode sends the exact form request through the injected fetcher", async () => {
  const calls = [];
  const providerPayload = { id_token: "signed.id.token", token_type: "Bearer" };
  const fetcher = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify(providerPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await exchangeTelegramCode({
    code: "telegram-code+/=",
    redirectUri,
    clientId,
    clientSecret,
    codeVerifier: "pkce-verifier_-.~",
    fetcher,
  });

  assert.deepEqual(result, providerPayload);
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://oauth.telegram.org/token");
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });
  assert.equal(
    String(init.body),
    "grant_type=authorization_code&code=telegram-code%2B%2F%3D&redirect_uri=https%3A%2F%2Fworker.example%2Fauth%2Ftelegram%2Fmobile%2Fcallback%3Freturn%3Dexact&client_id=123456&code_verifier=pkce-verifier_-.%7E",
  );
  assert.equal(String(init.body).includes(clientSecret), false);
});

test("exchangeTelegramCode redacts fetch and non-2xx provider failures", async () => {
  const code = "sensitive-authorization-code";

  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code,
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "sensitive-verifier",
        fetcher: async () => {
          throw new Error(`network failure ${clientSecret} ${code}`);
        },
      }),
    [clientSecret, code, "sensitive-verifier"],
  );

  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code,
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "sensitive-verifier",
        fetcher: async () =>
          new Response(JSON.stringify({ error: `provider denied ${clientSecret}`, id_token: "leaked-token" }), {
            status: 401,
          }),
      }),
    [clientSecret, code, "leaked-token"],
  );
});

test("exchangeTelegramCode aborts a pending provider request with a generic redacted error", async () => {
  const code = "sensitive-timeout-code";
  const providerError = "sensitive-provider-timeout";
  let requestSignal;
  const startedAt = Date.now();

  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code,
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "sensitive-timeout-verifier",
        timeoutMilliseconds: 20,
        fetcher: async (_url, init) => {
          requestSignal = init.signal;
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              "abort",
              () => reject(new Error(`${providerError} ${code} ${clientSecret}`)),
              { once: true },
            );
          });
        },
      }),
    [clientSecret, code, "sensitive-timeout-verifier", providerError],
  );

  assert.equal(requestSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("exchangeTelegramCode rejects malformed JSON with a generic error", async () => {
  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code: "code",
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "verifier",
        fetcher: async () => new Response(`not-json-${clientSecret}`, { status: 200 }),
      }),
    [clientSecret],
  );
});

test("exchangeTelegramCode rejects token responses without an id_token", async () => {
  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code: "code",
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "verifier",
        fetcher: async () =>
          new Response(JSON.stringify({ access_token: "provider-access-token" }), { status: 200 }),
      }),
    [clientSecret, "provider-access-token"],
  );
});

test("exchangeTelegramCode rejects oversized token responses", async () => {
  await assertTelegramFailure(
    () =>
      exchangeTelegramCode({
        code: "code",
        redirectUri,
        clientId,
        clientSecret,
        codeVerifier: "verifier",
        fetcher: async () =>
          new Response(JSON.stringify({ id_token: "provider-token", padding: "x".repeat(70 * 1024) }), {
            status: 200,
          }),
      }),
    [clientSecret, "provider-token"],
  );
});

test("verifyTelegramIdToken verifies a real RS256 token and normalizes Telegram identity", async () => {
  let jwksLoads = 0;
  const idToken = await signJwt({
    claims: validClaims({
      id: "9007199254740993",
      name: "  Ada Lovelace  ",
      preferred_username: "  ada  ",
      picture: "  https://cdn.example/ada.jpg  ",
    }),
  });

  const user = await verifyTelegramIdToken(idToken, {
    clientId,
    nonce,
    now,
    loadJwks: async () => {
      jwksLoads += 1;
      return { keys: [publicJwk] };
    },
  });

  assert.equal(jwksLoads, 1);
  assert.deepEqual(user, {
    provider: "telegram",
    id: "9007199254740993",
    name: "Ada Lovelace",
    username: "ada",
    photoUrl: "https://cdn.example/ada.jpg",
  });
});

test("verifyTelegramIdToken accepts scalar and array audiences containing the client id", async () => {
  for (const aud of [clientId, ["another-client", clientId]]) {
    const user = await verifyValidToken(validClaims({ aud }));
    assert.equal(user.id, "42");
  }
});

test("verifyTelegramIdToken rejects scalar and array audiences for other clients", async () => {
  for (const aud of ["another-client", ["another-client", "third-client"]]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ aud })));
  }
});

test("verifyTelegramIdToken rejects malformed JWT segment counts", async () => {
  let jwksLoads = 0;
  const options = verificationOptions(async () => {
    jwksLoads += 1;
    return { keys: [publicJwk] };
  });

  for (const token of ["one.two", "one.two.three.four", ".two.three", "one..three", "one.two."]) {
    await assertTelegramFailure(() => verifyTelegramIdToken(token, options));
  }
  assert.equal(jwksLoads, 0);
});

test("verifyTelegramIdToken rejects oversized tokens before loading keys", async () => {
  const oversizedToken = await signJwt({
    claims: validClaims({ padding: "x".repeat(16 * 1024) }),
  });
  let jwksLoads = 0;

  assert.ok(oversizedToken.length > 16 * 1024);
  await assertTelegramFailure(
    () =>
      verifyTelegramIdToken(
        oversizedToken,
        verificationOptions(async () => {
          jwksLoads += 1;
          return { keys: [publicJwk] };
        }),
      ),
    [oversizedToken],
  );
  assert.equal(jwksLoads, 0);
});

test("verifyTelegramIdToken rejects malformed or padded base64url before loading keys", async () => {
  let jwksLoads = 0;
  const header = encodeJson({ alg: "RS256", kid: keyId });
  const payload = encodeJson(validClaims());
  const options = verificationOptions(async () => {
    jwksLoads += 1;
    return { keys: [publicJwk] };
  });

  for (const token of [`***.${payload}.AA`, `${header}=.${payload}.AA`, `${header}.${payload}.A`]) {
    await assertTelegramFailure(() => verifyTelegramIdToken(token, options));
  }
  assert.equal(jwksLoads, 0);
});

test("verifyTelegramIdToken rejects malformed header and payload JSON before loading keys", async () => {
  let jwksLoads = 0;
  const options = verificationOptions(async () => {
    jwksLoads += 1;
    return { keys: [publicJwk] };
  });
  const malformedJson = Buffer.from("{not-json", "utf8").toString("base64url");
  const header = encodeJson({ alg: "RS256", kid: keyId });
  const payload = encodeJson(validClaims());

  await assertTelegramFailure(() => verifyTelegramIdToken(`${malformedJson}.${payload}.AA`, options));
  await assertTelegramFailure(() => verifyTelegramIdToken(`${header}.${malformedJson}.AA`, options));
  assert.equal(jwksLoads, 0);
});

test("verifyTelegramIdToken allows only RS256 with a nonempty kid", async () => {
  for (const header of [
    { alg: "HS256", kid: keyId },
    { alg: "none", kid: keyId },
    { alg: "RS256" },
    { alg: "RS256", kid: "  " },
    { alg: "RS256", kid: 42 },
  ]) {
    const token = await signJwt({ header });
    await assertTelegramFailure(() => verifyTelegramIdToken(token, verificationOptions()));
  }
});

test("verifyTelegramIdToken rejects a bad RSA signature", async () => {
  const token = await signJwt({ privateKey: otherSigningKeys.privateKey });
  await assertTelegramFailure(() => verifyTelegramIdToken(token, verificationOptions()));
});

test("verifyTelegramIdToken rejects an unknown signing key", async () => {
  const token = await signJwt({ header: { alg: "RS256", kid: "unknown-key" } });
  await assertTelegramFailure(() => verifyTelegramIdToken(token, verificationOptions()));
});

test("verifyTelegramIdToken rejects a matching non-RSA signing key", async () => {
  const token = await signJwt();
  await assertTelegramFailure(
    () => verifyTelegramIdToken(token, verificationOptions(async () => ({ keys: [ecPublicJwk] }))),
  );
});

test("verifyTelegramIdToken rejects an invalid RSA JWK and malformed JWKS", async () => {
  const token = await signJwt();
  const invalidRsaJwk = { kty: "RSA", kid: keyId, alg: "RS256", use: "sig", n: "bad", e: "AQAB" };

  await assertTelegramFailure(
    () => verifyTelegramIdToken(token, verificationOptions(async () => ({ keys: [invalidRsaJwk] }))),
  );
  for (const jwks of [null, {}, { keys: "not-an-array" }, { keys: [null] }]) {
    await assertTelegramFailure(
      () => verifyTelegramIdToken(token, verificationOptions(async () => jwks)),
    );
  }
});

test("verifyTelegramIdToken redacts JWKS loader errors", async () => {
  const token = await signJwt();
  await assertTelegramFailure(
    () =>
      verifyTelegramIdToken(
        token,
        verificationOptions(async () => {
          throw new Error(`JWKS failed with ${token}`);
        }),
      ),
    [token],
  );
});

test("verifyTelegramIdToken requires the exact Telegram issuer", async () => {
  for (const iss of ["https://oauth.telegram.org/", "http://oauth.telegram.org", "telegram"])
    await assertTelegramFailure(() => verifyValidToken(validClaims({ iss })));
});

test("verifyTelegramIdToken requires expiry strictly after now", async () => {
  for (const exp of [now, now - 1, String(now + 300), null]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ exp })));
  }
});

test("verifyTelegramIdToken permits 60 seconds of iat skew but rejects later or malformed values", async () => {
  assert.equal((await verifyValidToken(validClaims({ iat: now + 60 }))).id, "42");
  for (const iat of [now + 61, String(now), null]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ iat })));
  }
});

test("verifyTelegramIdToken requires an exact nonce", async () => {
  for (const tokenNonce of ["different-nonce", "", null, undefined]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ nonce: tokenNonce })));
  }
});

test("verifyTelegramIdToken requires a nonempty string subject", async () => {
  for (const sub of ["", "  ", null, 42, undefined]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ sub })));
  }
});

test("verifyTelegramIdToken requires a usable Telegram profile id", async () => {
  for (const id of ["", "  ", null, false, {}, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    await assertTelegramFailure(() => verifyValidToken(validClaims({ id })));
  }
});

test("verifyTelegramIdToken rejects malformed claim containers and numeric dates", async () => {
  for (const claims of [null, [], "claims", validClaims({ exp: Number.NaN }), validClaims({ iat: Infinity })]) {
    const token = await signJwt({ claims });
    await assertTelegramFailure(() => verifyTelegramIdToken(token, verificationOptions()));
  }
});

test("normalizeTelegramOidcUser applies the required profile fallback order", () => {
  assert.deepEqual(
    normalizeTelegramOidcUser({
      sub: "telegram-subject-42",
      id: 42,
      name: "  Explicit Name  ",
      given_name: "Ignored",
      family_name: "Person",
      preferred_username: "  telegram_user  ",
      picture: "  https://cdn.example/user.jpg  ",
    }),
    {
      provider: "telegram",
      id: "42",
      name: "Explicit Name",
      username: "telegram_user",
      photoUrl: "https://cdn.example/user.jpg",
    },
  );
  assert.equal(
    normalizeTelegramOidcUser({
      sub: "telegram-subject-43",
      id: "43",
      given_name: " Grace ",
      family_name: " Hopper ",
    }).name,
    "Grace Hopper",
  );
  assert.equal(
    normalizeTelegramOidcUser({
      sub: "telegram-subject-44",
      id: "44",
      preferred_username: " amazing_grace ",
    }).name,
    "amazing_grace",
  );
  assert.equal(
    normalizeTelegramOidcUser({ sub: "telegram-subject-45", id: "45" }).name,
    "Telegram 45",
  );
});

test("normalizeTelegramOidcUser rejects missing or blank subjects", () => {
  for (const claims of [{ id: "42" }, { sub: "", id: "42" }, { sub: " \t ", id: "42" }]) {
    assert.throws(() => normalizeTelegramOidcUser(claims), /Telegram authentication failed/);
  }
});

function validClaims(overrides = {}) {
  return {
    iss: issuer,
    aud: clientId,
    exp: now + 300,
    iat: now,
    nonce,
    sub: "telegram-subject-42",
    id: "42",
    given_name: "Ada",
    family_name: "Lovelace",
    preferred_username: "ada",
    picture: "https://cdn.example/ada.jpg",
    ...overrides,
  };
}

function verificationOptions(loadJwks = async () => ({ keys: [publicJwk] })) {
  return { clientId, nonce, now, loadJwks };
}

async function verifyValidToken(claims) {
  return verifyTelegramIdToken(await signJwt({ claims }), verificationOptions());
}

async function signJwt({
  header = { alg: "RS256", kid: keyId, typ: "JWT" },
  claims = validClaims(),
  privateKey = signingKeys.privateKey,
} = {}) {
  const headerSegment = encodeJson(header);
  const payloadSegment = encodeJson(claims);
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = await cryptoApi.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sequencedRandomBytes() {
  let invocation = 0;
  return (length) => {
    invocation += 1;
    return Uint8Array.from({ length }, (_, index) => (invocation * 41 + index) % 256);
  };
}

async function assertTelegramFailure(action, sensitiveValues = []) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, "Telegram authentication failed");
    for (const value of sensitiveValues) {
      assert.equal(error.message.includes(value), false);
    }
    return true;
  });
}
