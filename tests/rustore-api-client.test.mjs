import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUSTORE_API_BASE_URL,
  RUSTORE_PACKAGE_NAME,
  checkRuStoreAccess,
  createRuStoreClient,
  createRuStoreToken,
  expandRuStoreRollout,
  submitRuStoreUpdate,
} from "../scripts/rustore-api-client.mjs";
import { runRuStoreCli } from "../scripts/rustore-api.mjs";

const TEST_KEY_ID = "key-123";
const TEST_TOKEN = "header.secret-jwe.signature";

function createKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    privateKeyBase64: privateKey.toString("base64"),
    privateKeyPem: generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
    publicKey,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ok(body = null) {
  return jsonResponse({ code: "OK", message: null, body, timestamp: "2026-07-16T12:00:00Z" });
}

function queuedFetch(handlers) {
  const calls = [];
  const queue = [...handlers];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const handler = queue.shift();
    assert.ok(handler, `Unexpected request: ${options.method ?? "GET"} ${url}`);
    return typeof handler === "function" ? handler(String(url), options) : handler;
  };
  fetchImpl.calls = calls;
  fetchImpl.assertDone = () => assert.equal(queue.length, 0, `${queue.length} expected requests were not made`);
  return fetchImpl;
}

function tokenResponse(assertRequest) {
  return (url, options) => {
    assert.equal(url, `${RUSTORE_API_BASE_URL}/public/auth/`);
    assert.equal(options.method, "POST");
    const payload = JSON.parse(options.body);
    assert.equal(payload.keyId, TEST_KEY_ID);
    assertRequest?.(payload);
    return ok({ jwe: TEST_TOKEN, ttl: 900 });
  };
}

test("createRuStoreToken signs key id and timestamp with RSA-SHA512", async () => {
  const keys = createKeys();
  const now = () => new Date("2026-07-16T12:34:56.789Z");
  const fetchImpl = queuedFetch([
    tokenResponse((payload) => {
      assert.equal(payload.timestamp, "2026-07-16T12:34:56.789Z");
      assert.equal(
        verify(
          "RSA-SHA512",
          Buffer.from(`${TEST_KEY_ID}${payload.timestamp}`),
          keys.publicKey,
          Buffer.from(payload.signature, "base64"),
        ),
        true,
      );
    }),
  ]);

  const result = await createRuStoreToken({
    keyId: TEST_KEY_ID,
    privateKey: keys.privateKeyBase64,
    fetchImpl,
    now,
  });

  assert.deepEqual(result, { token: TEST_TOKEN, ttl: 900 });
  fetchImpl.assertDone();
});

test("createRuStoreToken accepts PEM keys and validates required credentials", async () => {
  const keys = createKeys();
  const fetchImpl = queuedFetch([tokenResponse()]);

  assert.equal(
    (await createRuStoreToken({ keyId: TEST_KEY_ID, privateKey: keys.privateKeyPem, fetchImpl })).token,
    TEST_TOKEN,
  );
  await assert.rejects(() => createRuStoreToken({ keyId: "", privateKey: keys.privateKeyPem, fetchImpl }), /key id/i);
  await assert.rejects(() => createRuStoreToken({ keyId: TEST_KEY_ID, privateKey: "", fetchImpl }), /private key/i);
  await assert.rejects(
    () => createRuStoreToken({ keyId: TEST_KEY_ID, privateKey: "not-a-key", fetchImpl }),
    /private key/i,
  );
  await assert.rejects(
    () => createRuStoreToken({ keyId: TEST_KEY_ID, privateKey: "!", fetchImpl }),
    /private key/i,
  );
});

test("RuStore API errors reject invalid responses without exposing credentials", async () => {
  const privateSecret = createKeys().privateKeyBase64;
  const fetchImpl = queuedFetch([
    jsonResponse({ code: "ERROR", message: `${TEST_KEY_ID} ${privateSecret} ${TEST_TOKEN}` }, 401),
  ]);

  await assert.rejects(
    () => createRuStoreToken({ keyId: TEST_KEY_ID, privateKey: privateSecret, fetchImpl }),
    (error) => {
      assert.match(error.message, /authentication/i);
      assert.equal(error.message.includes(TEST_KEY_ID), false);
      assert.equal(error.message.includes(privateSecret), false);
      assert.doesNotMatch(error.message, /secret-jwe/);
      return true;
    },
  );
});

test("RuStore client redacts developer contact data from API failures", async () => {
  const developerEmail = "private-release@example.com";
  const fetchImpl = queuedFetch([
    jsonResponse({ code: "ERROR", message: `invalid contact ${developerEmail}` }, 400),
  ]);
  const client = createRuStoreClient({ token: TEST_TOKEN, fetchImpl });

  await assert.rejects(
    () => client.createDraft({ releaseNotes: "Update", developerEmail }),
    (error) => {
      assert.match(error.message, /create rustore draft/i);
      assert.equal(error.message.includes(developerEmail), false);
      return true;
    },
  );
});

test("RuStore authentication rejects transport, JSON, token, and TTL failures", async () => {
  const keys = createKeys();
  const auth = { keyId: TEST_KEY_ID, privateKey: keys.privateKeyBase64 };

  await assert.rejects(
    () => createRuStoreToken({ ...auth, fetchImpl: async () => { throw new Error(TEST_TOKEN); } }),
    (error) => {
      assert.match(error.message, /could not reach/i);
      assert.doesNotMatch(error.message, /secret-jwe/);
      return true;
    },
  );
  await assert.rejects(
    () => createRuStoreToken({ ...auth, fetchImpl: async () => new Response("{", { status: 200 }) }),
    /invalid JSON/i,
  );
  await assert.rejects(
    () => createRuStoreToken({ ...auth, fetchImpl: async () => ok({ ttl: 900 }) }),
    /authentication token is required/i,
  );
  await assert.rejects(
    () => createRuStoreToken({ ...auth, fetchImpl: async () => ok({ jwe: TEST_TOKEN, ttl: 0 }) }),
    /token lifetime/i,
  );
  await assert.rejects(
    () => createRuStoreToken({ ...auth, fetchImpl: null }),
    /fetch implementation/i,
  );
});

test("RuStore client validates drafts, files, identifiers, and empty list responses", async () => {
  assert.throws(() => createRuStoreClient({ token: "" }), /API token/i);
  assert.throws(() => createRuStoreClient({ token: TEST_TOKEN, packageName: "" }), /package name/i);

  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-validation-"));
  const emptyApkPath = join(directory, "empty.apk");
  writeFileSync(emptyApkPath, "");
  const fetchImpl = queuedFetch([ok(), ok({ content: "not-an-array" })]);
  const client = createRuStoreClient({ token: TEST_TOKEN, fetchImpl });

  try {
    assert.deepEqual(await client.listApplications(), []);
    assert.deepEqual(await client.listVersions(), []);
    await assert.rejects(() => client.listVersions({ versionId: 0 }), /positive integer/i);
    await assert.rejects(
      () => client.createDraft({ releaseNotes: "x".repeat(5001), developerEmail: "release@example.com" }),
      /5000/i,
    );
    await assert.rejects(
      () => client.createDraft({ releaseNotes: "Update", developerEmail: "invalid" }),
      /email is invalid/i,
    );
    await assert.rejects(() => client.uploadApk({ versionId: 1, apkPath: "/missing.apk" }), /could not be read/i);
    await assert.rejects(() => client.uploadApk({ versionId: 1, apkPath: emptyApkPath }), /empty/i);
    await assert.rejects(() => client.changeRollout({ versionId: 1, target: 50 }), /25 or 100/i);
    fetchImpl.assertDone();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("RuStore client sends exact list, draft, APK, moderation, and rollout requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-api-"));
  const apkPath = join(directory, "app-release.apk");
  writeFileSync(apkPath, "signed-apk");
  const fetchImpl = queuedFetch([
    (url, options) => {
      assert.equal(url, `${RUSTORE_API_BASE_URL}/public/v1/application`);
      assert.equal(options.headers["Public-Token"], TEST_TOKEN);
      return ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME, appStatus: "ACTIVE" }] });
    },
    (url) => {
      assert.equal(
        url,
        `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version?filterTestingType=RELEASE&page=0&size=100`,
      );
      return ok({ content: [{ versionId: 5, versionStatus: "ACTIVE", versionCode: 5 }] });
    },
    (url, options) => {
      assert.equal(url, `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version`);
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        appName: "Залп",
        appType: "GAMES",
        whatsNew: "Исправлена авторизация и улучшено поле.",
        publishType: "INSTANTLY",
        partialValue: 5,
        minAndroidVersion: 7,
        developerContacts: [{
          email: "release@example.com",
          website: "https://agent-axiom.github.io/agents-salvo/",
        }],
      });
      return ok(777);
    },
    async (url, options) => {
      assert.equal(
        url,
        `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version/777/apk?servicesType=Unknown&isMainApk=true`,
      );
      assert.equal(options.method, "POST");
      assert.ok(options.body instanceof FormData);
      const file = options.body.get("file");
      assert.ok(file instanceof Blob);
      assert.equal(await file.text(), "signed-apk");
      return ok();
    },
    (url, options) => {
      assert.equal(
        url,
        `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version/777/commit?priorityUpdate=0`,
      );
      assert.equal(options.method, "POST");
      return ok();
    },
    (url, options) => {
      assert.equal(
        url,
        `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version/777/publish-settings`,
      );
      assert.deepEqual(JSON.parse(options.body), { partialValue: 25 });
      return ok();
    },
  ]);
  const client = createRuStoreClient({ token: TEST_TOKEN, fetchImpl });

  try {
    assert.equal((await client.listApplications())[0].packageName, RUSTORE_PACKAGE_NAME);
    assert.equal((await client.listVersions())[0].versionCode, 5);
    assert.equal(await client.createDraft({
      releaseNotes: "Исправлена авторизация и улучшено поле.",
      developerEmail: "release@example.com",
    }), 777);
    await client.uploadApk({ versionId: 777, apkPath });
    await client.submitForModeration({ versionId: 777 });
    await client.changeRollout({ versionId: 777, target: 25 });
    fetchImpl.assertDone();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkRuStoreAccess authenticates and confirms the scoped application", async () => {
  const keys = createKeys();
  const fetchImpl = queuedFetch([
    tokenResponse(),
    ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME, appStatus: "ACTIVE", versionCode: 5 }] }),
  ]);

  const result = await checkRuStoreAccess({
    keyId: TEST_KEY_ID,
    privateKey: keys.privateKeyBase64,
    fetchImpl,
  });

  assert.deepEqual(result, { packageName: RUSTORE_PACKAGE_NAME, appStatus: "ACTIVE", versionCode: 5 });
  fetchImpl.assertDone();
});

test("submitRuStoreUpdate cleans up only the draft created by the failed operation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-submit-"));
  const apkPath = join(directory, "app-release.apk");
  writeFileSync(apkPath, "signed-apk");
  const keys = createKeys();
  const fetchImpl = queuedFetch([
    tokenResponse(),
    ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME, appStatus: "ACTIVE" }] }),
    ok({ content: [{ versionId: 5, versionStatus: "ACTIVE", versionCode: 5 }] }),
    ok(888),
    jsonResponse({ code: "ERROR", message: "APK rejected", body: null }, 400),
    (url, options) => {
      assert.equal(
        url,
        `${RUSTORE_API_BASE_URL}/public/v1/application/${RUSTORE_PACKAGE_NAME}/version/888`,
      );
      assert.equal(options.method, "DELETE");
      return ok();
    },
  ]);

  try {
    await assert.rejects(
      () => submitRuStoreUpdate({
        keyId: TEST_KEY_ID,
        privateKey: keys.privateKeyBase64,
        developerEmail: "release@example.com",
        releaseNotes: "Обновление",
        apkPath,
        fetchImpl,
      }),
      /upload apk/i,
    );
    fetchImpl.assertDone();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submitRuStoreUpdate refuses to create a draft before the first active version", async () => {
  const keys = createKeys();
  const fetchImpl = queuedFetch([
    tokenResponse(),
    ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME, appStatus: "MODERATION" }] }),
    ok({ content: [{ versionId: 5, versionStatus: "MODERATION", versionCode: 5 }] }),
  ]);

  await assert.rejects(
    () => submitRuStoreUpdate({
      keyId: TEST_KEY_ID,
      privateKey: keys.privateKeyBase64,
      developerEmail: "release@example.com",
      releaseNotes: "Обновление",
      apkPath: "/unused.apk",
      fetchImpl,
    }),
    /active version/i,
  );
  fetchImpl.assertDone();
});

test("submitRuStoreUpdate never deletes a version after moderation submission starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-commit-"));
  const apkPath = join(directory, "app-release.apk");
  writeFileSync(apkPath, "signed-apk");
  const keys = createKeys();
  const fetchImpl = queuedFetch([
    tokenResponse(),
    ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME }] }),
    ok({ content: [{ versionId: 5, versionStatus: "ACTIVE", versionCode: 5 }] }),
    ok(903),
    ok(),
    jsonResponse({ code: "ERROR", message: "gateway timeout" }, 504),
  ]);

  try {
    await assert.rejects(
      () => submitRuStoreUpdate({
        keyId: TEST_KEY_ID,
        privateKey: keys.privateKeyBase64,
        developerEmail: "release@example.com",
        releaseNotes: "Обновление",
        apkPath,
        fetchImpl,
      }),
      /903.*inspect/i,
    );
    fetchImpl.assertDone();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submitRuStoreUpdate completes moderation and preserves the original error if cleanup fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "salvo-rustore-lifecycle-"));
  const apkPath = join(directory, "app-release.apk");
  writeFileSync(apkPath, "signed-apk");
  const keys = createKeys();
  const options = {
    keyId: TEST_KEY_ID,
    privateKey: keys.privateKeyBase64,
    developerEmail: "release@example.com",
    releaseNotes: "Обновление",
    apkPath,
  };
  const successFetch = queuedFetch([
    tokenResponse(),
    ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME }] }),
    ok({ content: [{ versionId: 5, versionStatus: "ACTIVE", versionCode: 5 }] }),
    ok({ versionId: 901 }),
    ok(),
    ok(),
  ]);

  try {
    assert.deepEqual(await submitRuStoreUpdate({ ...options, fetchImpl: successFetch }), {
      packageName: RUSTORE_PACKAGE_NAME,
      versionId: 901,
      rollout: 5,
      status: "MODERATION",
    });
    successFetch.assertDone();

    const cleanupFailureFetch = queuedFetch([
      tokenResponse(),
      ok({ content: [{ packageName: RUSTORE_PACKAGE_NAME }] }),
      ok({ content: [{ versionId: 5, versionStatus: "PARTIAL_ACTIVE", versionCode: 5 }] }),
      ok(902),
      jsonResponse({ code: "ERROR", message: "bad apk" }, 400),
      jsonResponse({ code: "ERROR", message: "cleanup unavailable" }, 503),
    ]);
    await assert.rejects(
      () => submitRuStoreUpdate({ ...options, fetchImpl: cleanupFailureFetch }),
      /upload apk/i,
    );
    cleanupFailureFetch.assertDone();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("RuStore operations reject inaccessible applications and invalid rollout records", async () => {
  const keys = createKeys();
  const auth = { keyId: TEST_KEY_ID, privateKey: keys.privateKeyBase64 };
  const inaccessibleFetch = queuedFetch([tokenResponse(), ok({ content: [] })]);
  await assert.rejects(
    () => checkRuStoreAccess({ ...auth, fetchImpl: inaccessibleFetch }),
    /cannot access/i,
  );

  const missingVersionFetch = queuedFetch([tokenResponse(), ok({ content: [] })]);
  await assert.rejects(
    () => expandRuStoreRollout({
      ...auth,
      versionId: 777,
      target: 25,
      fetchImpl: missingVersionFetch,
    }),
    /was not found/i,
  );

  const invalidPercentageFetch = queuedFetch([
    tokenResponse(),
    ok({ content: [{ versionId: 777, versionStatus: "PARTIAL_ACTIVE", partialValue: "invalid" }] }),
  ]);
  await assert.rejects(
    () => expandRuStoreRollout({
      ...auth,
      versionId: 777,
      target: 25,
      fetchImpl: invalidPercentageFetch,
    }),
    /invalid rollout percentage/i,
  );
});

test("expandRuStoreRollout permits only increasing 5 to 25 to 100 on partial active versions", async () => {
  const keys = createKeys();
  const successFetch = queuedFetch([
    tokenResponse(),
    ok({ content: [{ versionId: 777, versionStatus: "PARTIAL_ACTIVE", partialValue: 5, versionCode: 6 }] }),
    ok(),
  ]);

  const result = await expandRuStoreRollout({
    keyId: TEST_KEY_ID,
    privateKey: keys.privateKeyBase64,
    versionId: 777,
    target: 25,
    fetchImpl: successFetch,
  });
  assert.deepEqual(result, { versionId: 777, versionCode: 6, previous: 5, target: 25 });
  successFetch.assertDone();

  for (const [version, target, pattern] of [
    [{ versionId: 777, versionStatus: "ACTIVE", partialValue: 100 }, 100, /partial active/i],
    [{ versionId: 777, versionStatus: "PARTIAL_ACTIVE", partialValue: 25 }, 25, /increase/i],
    [{ versionId: 777, versionStatus: "PARTIAL_ACTIVE", partialValue: 5 }, 50, /25 or 100/i],
  ]) {
    const fetchImpl = queuedFetch([tokenResponse(), ok({ content: [version] })]);
    await assert.rejects(
      () => expandRuStoreRollout({
        keyId: TEST_KEY_ID,
        privateKey: keys.privateKeyBase64,
        versionId: 777,
        target,
        fetchImpl,
      }),
      pattern,
    );
  }
});

function captureStream() {
  let value = "";
  return {
    write(chunk) {
      value += String(chunk);
    },
    value() {
      return value;
    },
  };
}

test("RuStore CLI check passes credentials without printing secrets", async () => {
  const stdout = captureStream();
  const privateKey = "private-key-value";
  let received;

  await runRuStoreCli({
    argv: ["check"],
    env: { RUSTORE_KEY_ID: TEST_KEY_ID, RUSTORE_PRIVATE_KEY: privateKey },
    stdout,
    operations: {
      check: async (options) => {
        received = options;
        return { packageName: RUSTORE_PACKAGE_NAME, appStatus: "ACTIVE", versionCode: 5 };
      },
    },
  });

  assert.equal(received.keyId, TEST_KEY_ID);
  assert.equal(received.privateKey, privateKey);
  assert.match(stdout.value(), new RegExp(RUSTORE_PACKAGE_NAME));
  assert.match(stdout.value(), /ACTIVE/);
  assert.doesNotMatch(stdout.value(), /private-key-value/);
});

test("RuStore CLI submit validates release inputs and prints only the created version", async () => {
  const stdout = captureStream();
  let received;

  await runRuStoreCli({
    argv: ["submit"],
    env: {
      RUSTORE_KEY_ID: TEST_KEY_ID,
      RUSTORE_PRIVATE_KEY: "private-key-value",
      RUSTORE_DEVELOPER_EMAIL: "release@example.com",
      RUSTORE_RELEASE_NOTES: "Исправления",
      RUSTORE_APK_PATH: "/tmp/app-release.apk",
    },
    stdout,
    operations: {
      submit: async (options) => {
        received = options;
        return { packageName: RUSTORE_PACKAGE_NAME, versionId: 777, rollout: 5, status: "MODERATION" };
      },
    },
  });

  assert.equal(received.developerEmail, "release@example.com");
  assert.equal(received.releaseNotes, "Исправления");
  assert.equal(received.apkPath, "/tmp/app-release.apk");
  assert.match(stdout.value(), /777/);
  assert.match(stdout.value(), /5%/);
  assert.doesNotMatch(stdout.value(), /private-key-value|release@example\.com/);

  await assert.rejects(
    () => runRuStoreCli({
      argv: ["submit"],
      env: { RUSTORE_KEY_ID: TEST_KEY_ID, RUSTORE_PRIVATE_KEY: "key" },
      operations: { submit: async () => assert.fail("submit must not run") },
    }),
    /developer email/i,
  );
});

test("RuStore CLI rollout requires explicit version and a 25 or 100 target", async () => {
  const stdout = captureStream();
  let received;
  const base = {
    RUSTORE_KEY_ID: TEST_KEY_ID,
    RUSTORE_PRIVATE_KEY: "private-key-value",
    RUSTORE_VERSION_ID: "777",
  };

  await runRuStoreCli({
    argv: ["rollout"],
    env: { ...base, RUSTORE_ROLLOUT_TARGET: "25" },
    stdout,
    operations: {
      rollout: async (options) => {
        received = options;
        return { versionId: 777, versionCode: 6, previous: 5, target: 25 };
      },
    },
  });
  assert.equal(received.versionId, 777);
  assert.equal(received.target, 25);
  assert.match(stdout.value(), /5%.*25%/);

  for (const env of [
    { ...base, RUSTORE_VERSION_ID: "", RUSTORE_ROLLOUT_TARGET: "25" },
    { ...base, RUSTORE_ROLLOUT_TARGET: "50" },
  ]) {
    await assert.rejects(
      () => runRuStoreCli({
        argv: ["rollout"],
        env,
        operations: { rollout: async () => assert.fail("rollout must not run") },
      }),
      /version id|25 or 100/i,
    );
  }
});

test("RuStore CLI rejects unknown commands and missing credentials", async () => {
  await assert.rejects(() => runRuStoreCli({ argv: ["unknown"], env: {} }), /check, submit, or rollout/i);
  await assert.rejects(() => runRuStoreCli({ argv: ["check"], env: {} }), /key id/i);
  await assert.rejects(
    () => runRuStoreCli({ argv: ["check"], env: { RUSTORE_KEY_ID: TEST_KEY_ID } }),
    /private key/i,
  );
});
