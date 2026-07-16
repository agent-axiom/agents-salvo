# RuStore API Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tested, credential-safe GitHub Actions workflows that submit verified Salvo APK updates to RuStore at 5% rollout and manually expand an approved release to 25% or 100%.

**Architecture:** A repository-owned Node.js module handles RSA/SHA-512 authentication and the small RuStore publishing API surface through injected `fetch`. Thin CLI commands validate environment and arguments. Manual workflows call the CLI only inside the protected `rustore-production` environment after existing Android release verification succeeds.

**Tech Stack:** Node.js 24 Web APIs and `node:crypto`, GitHub Actions, Android Gradle, RuStore Public API.

---

## File Map

- Create `scripts/rustore-api-client.mjs`: authentication, response validation, draft, upload, moderation, status, and rollout operations.
- Create `scripts/rustore-api.mjs`: `check`, `submit`, and `rollout` CLI commands with safe summaries.
- Create `tests/rustore-api-client.test.mjs`: deterministic cryptography, request, cleanup, redaction, and rollout tests.
- Modify `package.json`: stable CLI scripts.
- Create `.github/workflows/rustore-api-check.yml`: non-mutating credential and application-access check.
- Modify `.github/workflows/rustore-release.yml`: optional 5% API submission after APK verification.
- Create `.github/workflows/rustore-rollout.yml`: guarded 25%/100% expansion.
- Modify `tests/rustore-workflow.test.mjs`: workflow security and behavior contracts.
- Modify `distribution/rustore/moderation-checklist.md` and READMEs: API setup and operating sequence.

### Task 1: RuStore API Client

**Files:**
- Create: `tests/rustore-api-client.test.mjs`
- Create: `scripts/rustore-api-client.mjs`

- [ ] **Step 1: Write failing authentication and response tests**

Generate an ephemeral RSA key with `generateKeyPairSync`, request a token through injected `fetch`, and verify the signed payload with the public key. Add failure cases for missing inputs, malformed private keys, HTTP errors, non-`OK` RuStore responses, missing JWE, and secret redaction.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/rustore-api-client.test.mjs`

Expected: FAIL because `scripts/rustore-api-client.mjs` does not exist.

- [ ] **Step 3: Implement authentication and request validation**

Export constants for the API base URL and package name, a `RuStoreApiError`, `createRuStoreToken()`, and `createRuStoreClient()`. Sign `${keyId}${timestamp}` with `RSA-SHA512`, parse `body.jwe`, and require every JSON response to have HTTP success and `code === "OK"`.

- [ ] **Step 4: Write failing publishing lifecycle tests**

Assert exact endpoints and payloads for app/version listing, `INSTANTLY` draft creation with `partialValue: 5`, multipart main APK upload with `isMainApk=true`, moderation commit, owned-draft cleanup, and rollout update.

- [ ] **Step 5: Implement the publishing lifecycle**

Expose client methods `listApplications`, `listVersions`, `createDraft`, `uploadApk`, `submitForModeration`, `deleteDraft`, and `changeRollout`. Add orchestration helpers `checkRuStoreAccess`, `submitRuStoreUpdate`, and `expandRuStoreRollout` that validate app visibility, version state, monotonic percentages, and clean up only drafts created by the current call.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/rustore-api-client.test.mjs`

Expected: PASS.

### Task 2: Safe CLI Commands

**Files:**
- Modify: `tests/rustore-api-client.test.mjs`
- Create: `scripts/rustore-api.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI tests**

Spawn the CLI with stubbed API responses and assert stable exit codes for `check`, `submit`, and `rollout`; reject missing APK, blank release notes, invalid targets, and secrets in stdout/stderr.

- [ ] **Step 2: Run the CLI tests and verify RED**

Run: `node --test tests/rustore-api-client.test.mjs`

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement CLI and scripts**

Read `RUSTORE_KEY_ID`, `RUSTORE_PRIVATE_KEY`, and `RUSTORE_DEVELOPER_EMAIL`; accept release notes from `RUSTORE_RELEASE_NOTES`; require explicit version ID and `25|100` target for rollout. Print only package, version ID, version code/status, and rollout percentage.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/rustore-api-client.test.mjs`

Expected: PASS.

### Task 3: Credential Check Workflow

**Files:**
- Modify: `tests/rustore-workflow.test.mjs`
- Create: `.github/workflows/rustore-api-check.yml`

- [ ] **Step 1: Add a failing workflow contract test**

Require a manual-only workflow, `contents: read`, `rustore-production`, pinned checkout/setup-node actions, all three API secrets, and only `npm run rustore:api:check` as the mutating boundary.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: FAIL because the check workflow is absent.

- [ ] **Step 3: Implement the credential check workflow**

Install with `npm ci`, run the focused client tests, and execute the non-mutating `check` command. Write a minimal success result to the step summary.

- [ ] **Step 4: Run workflow tests and verify GREEN**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: PASS.

### Task 4: Submit Verified Updates At 5%

**Files:**
- Modify: `tests/rustore-workflow.test.mjs`
- Modify: `.github/workflows/rustore-release.yml`

- [ ] **Step 1: Add failing submission contract tests**

Require `submit_to_rustore` and `release_notes` dispatch inputs, version-code propagation, API secrets mapped only on the submit step, submission strictly after signed APK verification, and no API call when confirmation is false.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: FAIL because the release workflow is build-only.

- [ ] **Step 3: Add guarded API submission**

Keep artifact upload unchanged. Add a conditional `npm run rustore:api:submit` step with the verified APK path, release notes input, developer email, and protected API credentials. Record the returned version ID in the GitHub summary.

- [ ] **Step 4: Run workflow tests and verify GREEN**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: PASS.

### Task 5: Expand Rollout Manually

**Files:**
- Modify: `tests/rustore-workflow.test.mjs`
- Create: `.github/workflows/rustore-rollout.yml`

- [ ] **Step 1: Add failing rollout workflow tests**

Require manual `version_id`, choice target `25|100`, protected environment, pinned actions, three API secrets, and the rollout CLI only after focused tests.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Implement rollout workflow**

Map inputs to `RUSTORE_VERSION_ID` and `RUSTORE_ROLLOUT_TARGET`, then execute `npm run rustore:api:rollout`. The client validates `PARTIAL_ACTIVE` and increasing percentages before the API request.

- [ ] **Step 4: Run workflow tests and verify GREEN**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: PASS.

### Task 6: Operations Documentation And Verification

**Files:**
- Modify: `distribution/rustore/moderation-checklist.md`
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Document credential scope and release sequence**

Document the environment secrets, required API methods, first-active-version prerequisite, credential check, 5% submission, 25%/100% expansion, and console rollback boundary.

- [ ] **Step 2: Run full verification**

Run: `npm test`

Run: `npm run coverage`

Run: `npm run mobile:verify`

Run: `git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 3: Commit, push, and open a PR**

Stage only the planned files, commit the implementation, push `codex/rustore-api-publish`, open a PR, and wait for web/Android/iOS CI.

- [ ] **Step 4: Merge and run the real credential check**

After CI passes, merge to `main`, dispatch `Check RuStore API Access`, and report whether the key can authenticate and see `io.github.agentaxiom.salvo`. Do not submit an update while the initial version is not active.
