import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RUSTORE_API_BASE_URL = "https://public-api.rustore.ru";
export const RUSTORE_PACKAGE_NAME = "io.github.agentaxiom.salvo";
export const RUSTORE_APP_NAME = "Залп";
export const RUSTORE_INITIAL_ROLLOUT = 5;
export const RUSTORE_ROLLOUT_TARGETS = Object.freeze([25, 100]);

const RUSTORE_WEBSITE = "https://agent-axiom.github.io/agents-salvo/";
const JWE_LIKE_PATTERN = /[A-Za-z0-9_-]{3,}(?:\.[A-Za-z0-9_-]{3,}){2,}/g;

export class RuStoreApiError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RuStoreApiError";
  }
}

function requireText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new RuStoreApiError(`${label} is required.`);
  }
  return normalized;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RuStoreApiError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function redact(message, secrets = []) {
  let safe = String(message ?? "RuStore API request failed.").replace(JWE_LIKE_PATTERN, "[REDACTED]");
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value) {
      safe = safe.split(value).join("[REDACTED]");
    }
  }
  return safe;
}

function importPrivateKey(privateKey) {
  const value = requireText(privateKey, "RuStore private key");
  try {
    if (value.includes("-----BEGIN")) {
      return createPrivateKey(value);
    }
    const decoded = Buffer.from(value.replace(/\s+/g, ""), "base64");
    if (!decoded.length) {
      throw new Error("empty key");
    }
    return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
  } catch (error) {
    throw new RuStoreApiError("RuStore private key is invalid.", { cause: error });
  }
}

async function parseResponse(response, operation, secrets) {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new RuStoreApiError(`${operation} returned invalid JSON.`, { cause: error });
  }

  if (!response.ok || payload?.code !== "OK") {
    const detail = payload?.message ? `: ${payload.message}` : "";
    throw new RuStoreApiError(redact(`${operation} failed${detail}`, secrets));
  }
  return payload;
}

async function requestJson({
  fetchImpl,
  url,
  operation,
  method = "GET",
  token,
  body,
  headers = {},
  secrets = [],
}) {
  const requestHeaders = { ...headers };
  if (token) {
    requestHeaders["Public-Token"] = token;
  }
  if (body !== undefined && !(body instanceof FormData)) {
    requestHeaders["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (error) {
    throw new RuStoreApiError(redact(`${operation} could not reach RuStore.`, secrets), { cause: error });
  }
  return parseResponse(response, operation, [...secrets, token]);
}

export async function createRuStoreToken({
  keyId,
  privateKey,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  baseUrl = RUSTORE_API_BASE_URL,
}) {
  const normalizedKeyId = requireText(keyId, "RuStore key ID");
  const normalizedPrivateKey = requireText(privateKey, "RuStore private key");
  if (typeof fetchImpl !== "function") {
    throw new RuStoreApiError("A fetch implementation is required.");
  }
  const timestamp = now().toISOString();
  let signature;
  try {
    signature = sign(
      "RSA-SHA512",
      Buffer.from(`${normalizedKeyId}${timestamp}`),
      importPrivateKey(normalizedPrivateKey),
    ).toString("base64");
  } catch (error) {
    if (error instanceof RuStoreApiError) {
      throw error;
    }
    throw new RuStoreApiError("RuStore private key could not sign the authentication request.", { cause: error });
  }

  const payload = await requestJson({
    fetchImpl,
    url: `${baseUrl}/public/auth/`,
    operation: "RuStore authentication",
    method: "POST",
    body: { keyId: normalizedKeyId, timestamp, signature },
    secrets: [normalizedKeyId, normalizedPrivateKey, signature],
  });
  const token = requireText(payload?.body?.jwe, "RuStore authentication token");
  const ttl = Number(payload?.body?.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RuStoreApiError("RuStore authentication returned an invalid token lifetime.");
  }
  return { token, ttl };
}

export function createRuStoreClient({
  token,
  fetchImpl = globalThis.fetch,
  baseUrl = RUSTORE_API_BASE_URL,
  packageName = RUSTORE_PACKAGE_NAME,
}) {
  const normalizedToken = requireText(token, "RuStore API token");
  const normalizedPackage = requireText(packageName, "RuStore package name");
  const applicationPath = `${baseUrl}/public/v1/application`;
  const versionPath = `${applicationPath}/${encodeURIComponent(normalizedPackage)}/version`;

  const request = (operation, path, options = {}) => requestJson({
    fetchImpl,
    url: path,
    operation,
    token: normalizedToken,
    ...options,
  });

  return Object.freeze({
    async listApplications() {
      const payload = await request("List RuStore applications", applicationPath);
      return Array.isArray(payload?.body?.content) ? payload.body.content : [];
    },

    async listVersions({ versionId } = {}) {
      const query = versionId === undefined
        ? "filterTestingType=RELEASE&page=0&size=100"
        : `ids=${requirePositiveInteger(versionId, "RuStore version ID")}`;
      const payload = await request("List RuStore versions", `${versionPath}?${query}`);
      return Array.isArray(payload?.body?.content) ? payload.body.content : [];
    },

    async createDraft({ releaseNotes, developerEmail }) {
      const whatsNew = requireText(releaseNotes, "RuStore release notes");
      if (whatsNew.length > 5000) {
        throw new RuStoreApiError("RuStore release notes must not exceed 5000 characters.");
      }
      const email = requireText(developerEmail, "RuStore developer email");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RuStoreApiError("RuStore developer email is invalid.");
      }
      const payload = await request("Create RuStore draft", versionPath, {
        method: "POST",
        secrets: [email],
        body: {
          appName: RUSTORE_APP_NAME,
          appType: "GAMES",
          whatsNew,
          publishType: "INSTANTLY",
          partialValue: RUSTORE_INITIAL_ROLLOUT,
          minAndroidVersion: 7,
          developerContacts: [{ email, website: RUSTORE_WEBSITE }],
        },
      });
      const versionId = typeof payload.body === "object" ? payload.body?.versionId : payload.body;
      return requirePositiveInteger(versionId, "Created RuStore version ID");
    },

    async uploadApk({ versionId, apkPath }) {
      const normalizedVersionId = requirePositiveInteger(versionId, "RuStore version ID");
      const normalizedPath = requireText(apkPath, "RuStore APK path");
      let bytes;
      try {
        bytes = await readFile(normalizedPath);
      } catch (error) {
        throw new RuStoreApiError("Upload APK failed because the verified APK could not be read.", { cause: error });
      }
      if (!bytes.length) {
        throw new RuStoreApiError("Upload APK failed because the verified APK is empty.");
      }
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/vnd.android.package-archive" }), "app-release.apk");
      await request(
        "Upload APK",
        `${versionPath}/${normalizedVersionId}/apk?servicesType=Unknown&isMainApk=true`,
        { method: "POST", body: form },
      );
    },

    async submitForModeration({ versionId }) {
      const normalizedVersionId = requirePositiveInteger(versionId, "RuStore version ID");
      await request(
        "Submit RuStore draft for moderation",
        `${versionPath}/${normalizedVersionId}/commit?priorityUpdate=0`,
        { method: "POST" },
      );
    },

    async deleteDraft({ versionId }) {
      const normalizedVersionId = requirePositiveInteger(versionId, "RuStore version ID");
      await request("Delete RuStore draft", `${versionPath}/${normalizedVersionId}`, { method: "DELETE" });
    },

    async changeRollout({ versionId, target }) {
      const normalizedVersionId = requirePositiveInteger(versionId, "RuStore version ID");
      const normalizedTarget = Number(target);
      if (!RUSTORE_ROLLOUT_TARGETS.includes(normalizedTarget)) {
        throw new RuStoreApiError("RuStore rollout target must be 25 or 100.");
      }
      await request("Change RuStore rollout", `${versionPath}/${normalizedVersionId}/publish-settings`, {
        method: "POST",
        body: { partialValue: normalizedTarget },
      });
    },
  });
}

async function authenticatedClient(options) {
  const { token } = await createRuStoreToken(options);
  return createRuStoreClient({
    token,
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl,
    packageName: options.packageName,
  });
}

async function requireScopedApplication(client, packageName = RUSTORE_PACKAGE_NAME) {
  const applications = await client.listApplications();
  const application = applications.find((candidate) => candidate?.packageName === packageName);
  if (!application) {
    throw new RuStoreApiError(`RuStore API key cannot access ${packageName}.`);
  }
  return application;
}

export async function checkRuStoreAccess(options) {
  const client = await authenticatedClient(options);
  const application = await requireScopedApplication(client, options.packageName);
  return {
    packageName: application.packageName,
    appStatus: application.appStatus ?? null,
    versionCode: application.versionCode ?? null,
  };
}

export async function submitRuStoreUpdate(options) {
  const client = await authenticatedClient(options);
  await requireScopedApplication(client, options.packageName);
  const versions = await client.listVersions();
  if (!versions.some((version) => ["ACTIVE", "PARTIAL_ACTIVE"].includes(version?.versionStatus))) {
    throw new RuStoreApiError("RuStore API publishing requires an existing active version.");
  }
  let createdVersionId = null;
  try {
    createdVersionId = await client.createDraft({
      releaseNotes: options.releaseNotes,
      developerEmail: options.developerEmail,
    });
    await client.uploadApk({ versionId: createdVersionId, apkPath: options.apkPath });
  } catch (error) {
    if (createdVersionId !== null) {
      try {
        await client.deleteDraft({ versionId: createdVersionId });
      } catch {
        // Preserve the publication error; the owned draft ID remains in its message context.
      }
    }
    throw error;
  }
  try {
    await client.submitForModeration({ versionId: createdVersionId });
  } catch (error) {
    throw new RuStoreApiError(
      `RuStore version ${createdVersionId} may have entered moderation; inspect its status before retrying.`,
      { cause: error },
    );
  }
  return {
    packageName: options.packageName ?? RUSTORE_PACKAGE_NAME,
    versionId: createdVersionId,
    rollout: RUSTORE_INITIAL_ROLLOUT,
    status: "MODERATION",
  };
}

export async function expandRuStoreRollout(options) {
  const versionId = requirePositiveInteger(options.versionId, "RuStore version ID");
  const target = Number(options.target);
  if (!RUSTORE_ROLLOUT_TARGETS.includes(target)) {
    throw new RuStoreApiError("RuStore rollout target must be 25 or 100.");
  }
  const client = await authenticatedClient(options);
  const versions = await client.listVersions({ versionId });
  const version = versions.find((candidate) => Number(candidate?.versionId) === versionId);
  if (!version) {
    throw new RuStoreApiError(`RuStore version ${versionId} was not found.`);
  }
  if (version.versionStatus !== "PARTIAL_ACTIVE") {
    throw new RuStoreApiError(
      `RuStore version ${versionId} must be partial active (PARTIAL_ACTIVE) before expanding rollout.`,
    );
  }
  const previous = Number(version.partialValue);
  if (!Number.isFinite(previous) || previous < 0) {
    throw new RuStoreApiError(`RuStore version ${versionId} has an invalid rollout percentage.`);
  }
  if (target <= previous) {
    throw new RuStoreApiError(`RuStore rollout target must increase from ${previous}.`);
  }
  await client.changeRollout({ versionId, target });
  return { versionId, versionCode: version.versionCode ?? null, previous, target };
}
