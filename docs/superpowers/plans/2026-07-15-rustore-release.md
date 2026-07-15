# RuStore Android Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a stable, production-signed Salvo APK, complete its RuStore listing package, and submit a moderation-ready first Android release.

**Architecture:** Gradle loads signing material only from environment variables and refuses unsafe release builds. A manual GitHub Actions workflow builds, tests, verifies, and publishes checksummed APK/AAB artifacts. Versioned repository metadata and screenshots make the owner-controlled RuStore Console submission reproducible.

**Tech Stack:** Android Gradle Plugin, Java 21, Capacitor 8, GitHub Actions, Android SDK build-tools, RuStore Console.

---

## File Map

- Modify `android/app/build.gradle`: version and strict environment-backed release signing.
- Modify `android/app/src/main/AndroidManifest.xml`: final release hardening.
- Create `scripts/verify-android-release.mjs`: manifest/artifact/signature guardrails.
- Create `tests/android-release-config.test.mjs`: source-level release configuration tests.
- Create `.github/workflows/rustore-release.yml`: manual signed release workflow.
- Create `src/privacy.html`: public privacy notice.
- Modify `src/app.js`, `src/i18n.js`, and `src/styles.css`: privacy link near Telegram login.
- Create `distribution/rustore/metadata.ru.md`: exact listing copy and declarations.
- Create `distribution/rustore/moderation-checklist.md`: owner submission checklist.
- Create `distribution/rustore/screenshots/`: five final 9:16 PNG files.
- Create `distribution/rustore/icon-512.png`: opaque store icon.
- Modify `.gitignore`: exclude local keystores and generated signed artifacts.
- Modify `README.md`, `README.ru.md`, `README.zh-CN.md`: release and key-backup operations.

### Task 1: Lock The Android Release Identity

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.gitignore`
- Create: `tests/android-release-config.test.mjs`

- [ ] **Step 1: Write failing release identity tests**

Read Gradle/manifest sources and assert:

```js
assert.match(gradle, /applicationId "io\.github\.agentaxiom\.salvo"/);
assert.match(gradle, /versionCode 1/);
assert.match(gradle, /versionName "1\.0\.0"/);
assert.match(gradle, /SALVO_RELEASE_KEYSTORE/);
assert.doesNotMatch(gradle, /signingConfig signingConfigs\.debug/);
```

Assert `.gitignore` excludes `*.jks`, `*.keystore`, `android/release.properties`, and
`android/app/build/outputs` without ignoring committed Android sources.

- [ ] **Step 2: Run config tests and verify RED**

Run: `node --test tests/android-release-config.test.mjs`

Expected: FAIL because version name is `1.0` and release signing is not configured.

- [ ] **Step 3: Add strict signing configuration**

Read exactly these environment variables:

```text
SALVO_RELEASE_KEYSTORE
SALVO_RELEASE_STORE_PASSWORD
SALVO_RELEASE_KEY_ALIAS
SALVO_RELEASE_KEY_PASSWORD
```

Configure `signingConfigs.release` only when all four are present. Make requested
release tasks throw a Gradle exception listing missing variable names. Debug tasks
must not require release credentials.

- [ ] **Step 4: Set public release version**

Keep package `io.github.agentaxiom.salvo`, set `versionCode 1`, and set
`versionName "1.0.0"`.

- [ ] **Step 5: Run config tests and Gradle debug tasks**

Run: `node --test tests/android-release-config.test.mjs`

Run: `android/gradlew -p android test assembleDebug`

Expected: PASS without release environment variables.

- [ ] **Step 6: Prove unsigned release fails closed**

Run: `android/gradlew -p android assembleRelease`

Expected: FAIL with the explicit missing `SALVO_RELEASE_*` list and no release APK.

- [ ] **Step 7: Commit release identity**

```bash
git add android/app/build.gradle .gitignore tests/android-release-config.test.mjs
git commit -m "build: lock Android release identity"
```

### Task 2: Add Artifact And Signature Verification

**Files:**
- Create: `scripts/verify-android-release.mjs`
- Modify: `package.json`
- Modify: `tests/android-release-config.test.mjs`

- [ ] **Step 1: Write failing verifier tests**

Test path rejection for missing APK/AAB, debug filenames, wrong expected package or
version, missing checksum tool output, and failed `apksigner verify --verbose
--print-certs` status. Inject command execution so tests use deterministic fixtures.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/android-release-config.test.mjs`

Expected: FAIL because the verifier module does not exist.

- [ ] **Step 3: Implement the verifier CLI**

The command:

```bash
node scripts/verify-android-release.mjs android/app/build/outputs/apk/release/app-release.apk
```

must run `apkanalyzer manifest application-id`, `apkanalyzer manifest version-name`,
`apksigner verify --verbose --print-certs`, calculate SHA-256, and write
`app-release.apk.sha256`. It must require package `io.github.agentaxiom.salvo` and
version `1.0.0`.

- [ ] **Step 4: Add package scripts**

```json
"android:release:verify": "node scripts/verify-android-release.mjs android/app/build/outputs/apk/release/app-release.apk"
```

- [ ] **Step 5: Run verifier unit tests**

Run: `node --test tests/android-release-config.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit artifact verification**

```bash
git add scripts/verify-android-release.mjs package.json tests/android-release-config.test.mjs
git commit -m "build: verify Android release artifacts"
```

### Task 3: Publish A Concrete Privacy Notice

**Files:**
- Create: `src/privacy.html`
- Modify: `scripts/build.mjs`
- Modify: `src/app.js`
- Modify: `src/i18n.js`
- Modify: `src/styles.css`
- Create: `tests/privacy.test.mjs`
- Modify: `tests/i18n.test.mjs`

- [ ] **Step 1: Write failing privacy-page tests**

Assert the page includes all of these concrete disclosures in Russian and links to
English/Chinese sections: Telegram ID/name/username/photo, match and replay data,
Cloudflare processing, purpose, retention, local play without login, no ads/analytics,
session protection, deletion request path, and support URL
`https://github.com/agent-axiom/agents-salvo/issues`.

Assert the build copies `privacy.html` and the auth control links to
`./privacy.html` with translated text.

- [ ] **Step 2: Run privacy tests and verify RED**

Run: `node --test tests/privacy.test.mjs tests/i18n.test.mjs`

Expected: FAIL because the privacy page and link do not exist.

- [ ] **Step 3: Add the static privacy page**

Use existing paper/ink tokens through a small self-contained stylesheet. State the
effective date `2026-07-15`, service URLs, exact collected fields, and GitHub Issues
contact. Do not claim a legal operator identity that has not been supplied by the
owner.

- [ ] **Step 4: Add the in-app privacy link**

Place it directly below the Telegram sign-in action. Native opens the canonical HTTPS
page through `platform.openExternalUrl`; web uses a normal same-origin link.

- [ ] **Step 5: Run privacy, i18n, and build tests**

Run: `node --test tests/privacy.test.mjs tests/i18n.test.mjs && npm run build`

Expected: PASS and `dist/privacy.html` exists.

- [ ] **Step 6: Commit privacy disclosure**

```bash
git add src/privacy.html scripts/build.mjs src/app.js src/i18n.js src/styles.css tests/privacy.test.mjs tests/i18n.test.mjs
git commit -m "feat: publish account privacy notice"
```

### Task 4: Add The Signed RuStore Release Workflow

**Files:**
- Create: `.github/workflows/rustore-release.yml`
- Create: `tests/rustore-workflow.test.mjs`

- [ ] **Step 1: Write failing workflow contract tests**

Parse YAML and assert `workflow_dispatch`, least-privilege `contents: read`, Node from
`.nvmrc`, Java 21, `npm ci`, tests, coverage, build/sync, Android test/lint, emulator
smoke, keystore decode, signed APK/AAB build, `apksigner` verification, checksums, and
artifact upload. Assert no pull-request or push trigger can access signing secrets.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test tests/rustore-workflow.test.mjs`

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Implement the manual workflow**

Use repository secrets:

```text
RUSTORE_KEYSTORE_BASE64
RUSTORE_STORE_PASSWORD
RUSTORE_KEY_ALIAS
RUSTORE_KEY_PASSWORD
```

Decode to `${RUNNER_TEMP}/salvo-release.jks`, map to `SALVO_RELEASE_*`, run
`assembleRelease bundleRelease`, verify, and upload:

```text
app-release.apk
app-release.apk.sha256
app-release.aab
app-release.aab.sha256
```

Delete the decoded keystore in an `if: always()` step.

- [ ] **Step 4: Pin third-party actions by full commit SHA**

Use the same reviewed major versions already present in `mobile.yml`; pin the emulator
runner to its existing SHA. Do not introduce a store-upload action in this phase.

- [ ] **Step 5: Run workflow and full Node tests**

Run: `node --test tests/rustore-workflow.test.mjs && npm test`

Expected: PASS.

- [ ] **Step 6: Commit CI release workflow**

```bash
git add .github/workflows/rustore-release.yml tests/rustore-workflow.test.mjs
git commit -m "ci: build signed RuStore releases"
```

### Task 5: Prepare RuStore Listing Copy And Declarations

**Files:**
- Create: `distribution/rustore/metadata.ru.md`
- Create: `distribution/rustore/moderation-checklist.md`
- Create: `tests/rustore-metadata.test.mjs`

- [ ] **Step 1: Write failing metadata constraint tests**

Parse fixed headings and assert name `Залп` is at most 30 characters, short
description at most 80, long description at most 4000, and release notes are nonempty.
Reject the banned marketing words `лучший`, `единственный`, `официальный`, and links
to competing stores.

- [ ] **Step 2: Run metadata tests and verify RED**

Run: `node --test tests/rustore-metadata.test.mjs`

Expected: FAIL because listing files do not exist.

- [ ] **Step 3: Write exact Russian listing copy**

Use these concrete values:

```text
Название: Залп
Краткое описание: Морской бой с AI, локальными и рейтинговыми онлайн-партиями.
Категория: Игры / Настольные игры
Возрастной рейтинг: 6+
Цена: Бесплатно
```

The full description covers authentic fleet rules, 8x8/10x10/16x16 modes, AI,
same-device play, registered online rooms, three languages, themes, sound, replays,
training, leaderboard, and offline local modes without claiming unsupported features.

- [ ] **Step 4: Write data-safety and permissions answers**

Declare only `INTERNET`; Telegram public profile and game/profile data are collected
for account and game services; data is not sold, used for ads, or used for tracking;
traffic is encrypted; local gameplay works without account. Include the privacy and
support URLs from the spec.

- [ ] **Step 5: Write moderator instructions**

Provide a deterministic path: launch → Settings → Sign in with Telegram → return →
Online battle. Explain that moderators use their own Telegram account; no shared
password exists. Include local fallback and the Worker service URL.

- [ ] **Step 6: Run metadata tests and commit**

Run: `node --test tests/rustore-metadata.test.mjs`

Expected: PASS.

```bash
git add distribution/rustore tests/rustore-metadata.test.mjs
git commit -m "docs: prepare RuStore listing"
```

### Task 6: Produce Store Icon And Five Phone Screenshots

**Files:**
- Create: `distribution/rustore/icon-512.png`
- Create: `distribution/rustore/screenshots/01-menu.png`
- Create: `distribution/rustore/screenshots/02-setup.png`
- Create: `distribution/rustore/screenshots/03-battle.png`
- Create: `distribution/rustore/screenshots/04-online.png`
- Create: `distribution/rustore/screenshots/05-profile.png`
- Create: `scripts/verify-rustore-assets.mjs`
- Create: `tests/rustore-assets.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing image-dimension tests**

Add `pngjs@7.0.0` as a dev dependency and use `PNG.sync.read` to assert the icon is
exactly 512x512, PNG, opaque at every pixel, and under 3 MB. Assert exactly five phone
screenshots, each PNG, 1080x1920 (9:16), nonblank, and without duplicate hashes.

- [ ] **Step 2: Run asset tests and verify RED**

Run: `node --test tests/rustore-assets.test.mjs`

Expected: FAIL because the final store assets do not exist.

- [ ] **Step 3: Produce the opaque store icon**

Render the existing Salvo anchor/board identity on the dark ink-paper background at
512x512. Preserve safe margins so RuStore masking does not crop the anchor.

- [ ] **Step 4: Capture deterministic Russian screenshots**

Install the release-equivalent debug build on a 1080x1920 emulator. Set Russian,
render style, and dark theme. Capture menu, complete setup, active battle with clear
hit/miss states, the online sign-in lobby, and the public leaderboard/training entry.
Do not include OS notifications, debug overlays, secrets, room tokens, or personal
Telegram data. Do not add a fake production identity for screenshots.

- [ ] **Step 5: Run asset verification and visual inspection**

Run: `node scripts/verify-rustore-assets.mjs`

Run: `node --test tests/rustore-assets.test.mjs`

Expected: PASS. Open all six images and inspect for clipping, illegible text,
horizontal scrollbars, inconsistent themes, and stale UI.

- [ ] **Step 6: Commit listing assets**

```bash
git add distribution/rustore scripts/verify-rustore-assets.mjs tests/rustore-assets.test.mjs package.json package-lock.json
git commit -m "assets: add RuStore listing media"
```

### Task 7: Generate And Back Up The Permanent Release Key

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Create a protected local key directory**

Run:

```bash
mkdir -p "$HOME/.salvo"
chmod 700 "$HOME/.salvo"
```

- [ ] **Step 2: Generate the permanent key interactively**

Set a new strong password in the local shell without writing it to history, then run:

```bash
keytool -genkeypair -v \
  -keystore "$HOME/.salvo/salvo-rustore-release.jks" \
  -alias salvo-rustore \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Salvo, OU=Games, O=Agent Axiom, L=Moscow, C=RU"
chmod 600 "$HOME/.salvo/salvo-rustore-release.jks"
```

The owner records both passwords in a password manager. They are never sent in chat
or committed.

- [ ] **Step 3: Record and back up certificate identity**

Run:

```bash
keytool -list -v -keystore "$HOME/.salvo/salvo-rustore-release.jks" -alias salvo-rustore
```

Save SHA-256 certificate fingerprint in the password-manager record and create one
encrypted offline backup. Losing this key prevents trusted updates.

- [ ] **Step 4: Configure GitHub repository secrets**

Base64-encode the keystore without line breaks and set the four `RUSTORE_*` secrets
through `gh secret set`, reading passwords from the terminal prompt/stdin rather than
command-line arguments.

- [ ] **Step 5: Document key ownership and recovery**

Add exact key path, alias, fingerprint lookup, backup requirement, GitHub secret names,
version-code increment rule, and a warning never to regenerate the key for updates.

- [ ] **Step 6: Commit operational documentation**

```bash
git add README.md README.ru.md README.zh-CN.md
git commit -m "docs: document Android release signing"
```

### Task 8: Build, Verify, And Submit The First RuStore Release

**Files:**
- Modify: `distribution/rustore/moderation-checklist.md`

- [ ] **Step 1: Run complete local verification**

Run:

```bash
npm test
npm run coverage
npm run build
npm run mobile:sync
android/gradlew -p android test lint connectedDebugAndroidTest
```

Expected: every command exits `0`; existing coverage gates remain satisfied.

- [ ] **Step 2: Run the GitHub RuStore release workflow**

Run: `gh workflow run rustore-release.yml --ref codex/mobile-apps`

Run: `gh run watch --exit-status`

Expected: workflow succeeds and uploads signed APK/AAB plus SHA-256 files.

- [ ] **Step 3: Verify the downloaded APK independently**

Download the artifact, run `apksigner verify --verbose --print-certs`, compare its
SHA-256 certificate fingerprint to the password-manager record, compare file checksum,
and install with `adb install -r app-release.apk`.

- [ ] **Step 4: Execute release acceptance on a clean device**

Complete local AI battle, same-device setup, Telegram login, profile refresh, online
room creation/join, app restart, logout, and 10x10/16x16 board checks. Confirm only
`INTERNET` permission is declared.

- [ ] **Step 5: Create or open the RuStore Console draft**

Sign in with the owner's VK ID, choose physical-person developer registration when
appropriate, create package `io.github.agentaxiom.salvo`, upload the signed APK, and
copy the committed listing text, privacy/support URLs, data declarations, icon, and
five screenshots.

- [ ] **Step 6: Complete owner-controlled legal fields**

The owner supplies real developer contact details and confirms rights, personal-data
operator declarations, and age-rating answers. Do not invent these values from GitHub
metadata.

- [ ] **Step 7: Submit for moderation and record the result**

Submit only after every checklist item is checked. Record RuStore draft/version ID and
moderation result in the checklist without storing personal identifiers or secrets.

- [ ] **Step 8: Commit the final non-sensitive release record**

```bash
git add distribution/rustore/moderation-checklist.md
git commit -m "docs: record RuStore submission"
```
