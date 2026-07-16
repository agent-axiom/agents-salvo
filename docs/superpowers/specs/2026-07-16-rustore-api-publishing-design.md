# RuStore API Publishing Design

## Goal

Automate verified Salvo updates from GitHub Actions to RuStore while keeping moderation mandatory and limiting every newly approved update to 5% of users until the owner explicitly expands the rollout.

## Safety Boundary

- The existing `rustore-production` GitHub Environment remains the only place that can access signing and RuStore API credentials.
- The repository contains no RuStore private key, JWE token, keystore, password, or developer email.
- API requests use a repository-owned Node.js client. No third-party store publishing action receives credentials or release files.
- The first active RuStore version remains a prerequisite. API publication is not run while version `1.0.0 (5)` is awaiting moderation.
- Moderation is never bypassed. A successful submission means "waiting for RuStore moderation", not "published".

## Credentials And Configuration

The `rustore-production` environment provides these secrets:

- `RUSTORE_KEY_ID`
- `RUSTORE_PRIVATE_KEY`
- `RUSTORE_DEVELOPER_EMAIL`
- the existing Android signing secrets

Static, non-secret configuration stays in source control:

- package: `io.github.agentaxiom.salvo`
- application name: `Залп`
- application type: `GAMES`
- minimum Android version: `7`, corresponding to the current Android API 24 minimum
- website: `https://agent-axiom.github.io/agents-salvo/`
- initial rollout: `5`

The RuStore API key is scoped to this application and only the methods needed to list applications and versions, create/delete a draft, upload an APK, submit moderation, and change publication settings.

## API Client

`scripts/rustore-api-client.mjs` owns authentication and HTTP behavior. It imports either a Base64 PKCS#8 or PEM RSA private key, signs `keyId + timestamp` with RSA/SHA-512, and exchanges the signature for a 15-minute JWE token. Tokens exist only in process memory and are never printed.

The client exposes typed operations for:

1. checking API access and application visibility;
2. listing application versions;
3. creating a draft with release notes, `INSTANTLY`, and `partialValue: 5`;
4. uploading the verified APK as the main non-HMS APK;
5. submitting the draft for moderation with normal update priority;
6. deleting a draft after a pre-moderation failure;
7. increasing an approved partial rollout to 25% or 100%.

Every response must have HTTP success and RuStore response code `OK`. Errors include the operation and RuStore message but redact the private key, authorization signature, JWE token, and request authorization headers.

## Workflows

### Credential Check

`Check RuStore API Access` is a manual workflow. It obtains a token and confirms that `io.github.agentaxiom.salvo` is visible to the key. It creates no draft and uploads nothing, so it is safe to run before the first version becomes active.

### Submit Update

`Build RuStore Release` keeps its existing tests, coverage gates, emulator smoke test, signing, signature verification, checksums, and artifact upload. A required confirmation input controls API submission. When enabled after the first version is active, the workflow:

1. validates release notes;
2. creates a draft configured for automatic 5% publication after approval;
3. uploads the signed and verified APK;
4. submits the draft for moderation;
5. records `versionId`, `versionCode`, and moderation status in the GitHub step summary.

If draft creation succeeds but upload or submission fails, the client attempts to delete that draft so a corrected rerun is possible. It never deletes an existing draft that it did not create in the current process.

### Expand Rollout

`Expand RuStore Rollout` is a separate manual workflow with explicit `versionId` and a constrained target of `25` or `100`. It first verifies that the requested version belongs to Salvo, is `PARTIAL_ACTIVE`, and has a lower current percentage. It then changes only `partialValue`. The API prevents decreasing rollout, and the workflow performs the same check before sending a request.

The intended sequence is `5% -> 25% -> 100%`. A rollback remains an owner action in the RuStore Console because deactivating a release has wider consequences than changing its rollout percentage.

## Testing

- Unit tests use an injected fetch implementation and generated ephemeral RSA keys; they never use production secrets or contact RuStore.
- Tests cover RSA request signing, token parsing, secret redaction, response validation, draft cleanup, APK form upload, moderation submission, version-state validation, and monotonic rollout.
- Workflow contract tests assert manual triggers, environment protection, secret mapping, pinned actions, release verification before upload, and constrained rollout inputs.
- A real credential-check workflow is run after merge. The update submission path is first run only after RuStore reports the initial version as active.

## Operational Result

An approved API-submitted update becomes available to 5% of users automatically. The owner reviews crashes, authentication, online rooms, and user feedback before manually expanding the same `versionId` to 25% and then 100%.
