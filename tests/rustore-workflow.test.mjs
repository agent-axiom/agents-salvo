import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";

const workflowPath = ".github/workflows/rustore-release.yml";
const apiCheckWorkflowPath = ".github/workflows/rustore-api-check.yml";
const rolloutWorkflowPath = ".github/workflows/rustore-rollout.yml";

function readWorkflow(path) {
  assert.equal(existsSync(path), true, `${path} must exist`);
  const source = readFileSync(path, "utf8");
  return { source, workflow: YAML.parse(source) };
}

function assertPinnedActions(source) {
  const actionUses = [...source.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionUses.length >= 2);
  for (const action of actionUses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/i, `${action} must be pinned to a full commit SHA`);
  }
}

test("RuStore release workflow is manual and least privilege", () => {
  assert.equal(existsSync(workflowPath), true, "RuStore release workflow must exist");
  const source = readFileSync(workflowPath, "utf8");
  const workflow = YAML.parse(source);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "rustore-release",
    "cancel-in-progress": false,
  });
  assert.equal(workflow.jobs.release.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.release.environment, "rustore-production");
  assert.equal(workflow.jobs.release.env.SALVO_VERSION_CODE, "${{ github.run_number }}");
  assert.doesNotMatch(source, /^\s*(push|pull_request):/m);
});

test("RuStore release workflow assigns a monotonically increasing Android version code", () => {
  const source = readFileSync(workflowPath, "utf8");

  assert.match(source, /SALVO_VERSION_CODE:\s*\$\{\{ github\.run_number \}\}/);
  assert.match(source, /Build signed APK and AAB[\s\S]*assembleRelease[\s\S]*bundleRelease/);
});

test("RuStore release workflow requires the published privacy notice before signing", () => {
  const source = readFileSync(workflowPath, "utf8");
  const privacyUrl = "https://agent-axiom.github.io/agents-salvo/privacy.html";
  const privacyCheck = source.indexOf(privacyUrl);
  const signing = source.indexOf("Decode release keystore");

  assert.ok(privacyCheck >= 0, "published privacy URL must be checked");
  assert.ok(signing > privacyCheck, "privacy check must complete before the keystore is decoded");
  assert.match(source, /curl[^\n]*--fail[^\n]*--location[^\n]*--retry/);
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
    /- name: Enable KVM access[\s\S]*?MODE="0666"[\s\S]*?udevadm control --reload-rules[\s\S]*?udevadm trigger --name-match=kvm[\s\S]*?- name: Run Android instrumentation smoke test/,
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

test("RuStore API credential check is manual, protected, pinned, and non-mutating", () => {
  const { source, workflow } = readWorkflow(apiCheckWorkflowPath);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.check.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.check.environment, "rustore-production");
  assert.match(source, /npm ci/);
  assert.match(source, /node --test tests\/rustore-api-client\.test\.mjs/);
  assert.match(source, /npm run rustore:api:check/);
  assert.match(source, /RUSTORE_KEY_ID:\s*\$\{\{ secrets\.RUSTORE_KEY_ID \}\}/);
  assert.match(source, /RUSTORE_PRIVATE_KEY:\s*\$\{\{ secrets\.RUSTORE_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(source, /RUSTORE_DEVELOPER_EMAIL|secrets\.RUSTORE_DEVELOPER_EMAIL/);
  assert.doesNotMatch(source, /rustore:api:(submit|rollout)/);
  assertPinnedActions(source);
});

test("RuStore release submits the verified APK only after explicit confirmation", () => {
  const { source, workflow } = readWorkflow(workflowPath);
  const inputs = workflow.on.workflow_dispatch.inputs;

  assert.deepEqual(inputs.submit_to_rustore, {
    description: "Submit the verified APK to RuStore moderation at 5% rollout",
    required: true,
    type: "boolean",
    default: false,
  });
  assert.equal(inputs.release_notes.type, "string");
  assert.equal(inputs.release_notes.required, false);

  const verifyIndex = source.indexOf("name: Verify signed APK");
  const submitIndex = source.indexOf("name: Submit verified APK to RuStore");
  assert.ok(verifyIndex >= 0);
  assert.ok(submitIndex > verifyIndex, "API submission must happen after APK verification");
  assert.match(source, /if:\s*\$\{\{ inputs\.submit_to_rustore \}\}/);
  assert.match(source, /RUSTORE_RELEASE_NOTES:\s*\$\{\{ inputs\.release_notes \}\}/);
  assert.match(source, /RUSTORE_APK_PATH:\s*android\/app\/build\/outputs\/apk\/release\/app-release\.apk/);
  assert.match(source, /npm run rustore:api:submit/);

  const submitBlock = source.slice(submitIndex, source.indexOf("\n      - name:", submitIndex + 1));
  for (const secret of ["RUSTORE_KEY_ID", "RUSTORE_PRIVATE_KEY", "RUSTORE_DEVELOPER_EMAIL"]) {
    assert.match(submitBlock, new RegExp(`${secret}:\\s*\\$\\{\\{ secrets\\.${secret} \\}\\}`));
    assert.doesNotMatch(source.slice(0, submitIndex), new RegExp(`secrets\\.${secret}`));
  }
});

test("RuStore rollout is manual, protected, and limited to 25 or 100 percent", () => {
  const { source, workflow } = readWorkflow(rolloutWorkflowPath);
  const inputs = workflow.on.workflow_dispatch.inputs;

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.rollout.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.jobs.rollout.environment, "rustore-production");
  assert.equal(inputs.version_id.required, true);
  assert.equal(inputs.version_id.type, "string");
  assert.deepEqual(inputs.target.options, ["25", "100"]);
  assert.equal(inputs.target.type, "choice");
  assert.match(source, /node --test tests\/rustore-api-client\.test\.mjs/);
  assert.match(source, /RUSTORE_VERSION_ID:\s*\$\{\{ inputs\.version_id \}\}/);
  assert.match(source, /RUSTORE_ROLLOUT_TARGET:\s*\$\{\{ inputs\.target \}\}/);
  assert.match(source, /npm run rustore:api:rollout/);
  assert.match(source, /RUSTORE_KEY_ID:\s*\$\{\{ secrets\.RUSTORE_KEY_ID \}\}/);
  assert.match(source, /RUSTORE_PRIVATE_KEY:\s*\$\{\{ secrets\.RUSTORE_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(source, /RUSTORE_DEVELOPER_EMAIL|secrets\.RUSTORE_DEVELOPER_EMAIL/);
  assert.doesNotMatch(source, /rustore:api:submit/);
  assertPinnedActions(source);
});
