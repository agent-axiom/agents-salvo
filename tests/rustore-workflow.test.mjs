import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

const workflowPath = ".github/workflows/rustore-release.yml";

test("RuStore release workflow is manual and least privilege", () => {
  assert.equal(existsSync(workflowPath), true, "RuStore release workflow must exist");
  const source = readFileSync(workflowPath, "utf8");
  const workflow = YAML.parse(source);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(source, /^\s*(push|pull_request):/m);
});

test("RuStore release workflow validates, signs, verifies, and uploads both formats", () => {
  const source = readFileSync(workflowPath, "utf8");

  for (const requirement of [
    /node-version-file:\s*\.nvmrc/,
    /java-version:\s*["']?21["']?/,
    /npm ci/,
    /npm test/,
    /npm run coverage/,
    /npm run mobile:sync/,
    /gradlew[^\n]*(test|lint)/,
    /connectedDebugAndroidTest/,
    /RUSTORE_KEYSTORE_BASE64/,
    /RUSTORE_STORE_PASSWORD/,
    /RUSTORE_KEY_ALIAS/,
    /RUSTORE_KEY_PASSWORD/,
    /SALVO_RELEASE_KEYSTORE/,
    /assembleRelease/,
    /bundleRelease/,
    /android:release:verify/,
    /app-release\.apk\.sha256/,
    /app-release\.aab\.sha256/,
    /if:\s*\$\{\{ always\(\) \}\}/,
  ]) {
    assert.match(source, requirement);
  }

  const actionUses = [...source.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionUses.length >= 5);
  for (const action of actionUses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/i, `${action} must be pinned to a full commit SHA`);
  }
});
