import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harnessPath = fileURLToPath(new URL("./app-behavior-harness.mjs", import.meta.url));
const childCoverageMode = process.env.SALVO_APP_CHILD_COVERAGE ?? "isolated";
assert.ok(["isolated", "inherit"].includes(childCoverageMode));

test("actual app boot stays rendered and gates auth on deferred runtime state", async () => {
  await runScenarioInChild("startup");
});

test("actual app routes close online state and require destructive confirmation", async () => {
  await runScenarioInChild("navigation");
});

test("actual app requires destructive confirmation before applying a deep link", async () => {
  await runScenarioInChild("deep-link-guard");
});

test("actual app aborts private work while secure logout is pending", async () => {
  await runScenarioInChild("logout");
});

test("actual app renders Telegram auth from platform capability", async () => {
  await runScenarioInChild("auth-capability");
});

test("actual app starts Telegram OIDC with platform-specific browser behavior", async () => {
  await runScenarioInChild("auth-start");
});

test("actual app redeems native Telegram callbacks without leaving the game", async () => {
  await runScenarioInChild("auth-native-callback");
});

test("actual app suppresses stale Telegram auth work and logout races", async () => {
  await runScenarioInChild("auth-races");
});

test("actual app cleans and redeems web Telegram bootstrap callbacks", async () => {
  await runScenarioInChild("auth-bootstrap");
});

test("actual app retries Telegram capability and rejects failed secure persistence", async () => {
  await runScenarioInChild("auth-recovery");
});

async function runScenarioInChild(name) {
  const inheritCoverage = childCoverageMode === "inherit";
  const childEnvironment = {
    SALVO_APP_BEHAVIOR_SCENARIO: name,
    SALVO_APP_CHILD_COVERAGE: childCoverageMode,
  };
  if (inheritCoverage && process.env.NODE_V8_COVERAGE) {
    childEnvironment.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  }
  const command = inheritCoverage ? process.execPath : "/usr/bin/env";
  const args = inheritCoverage
    ? [harnessPath]
    : ["-u", "NODE_V8_COVERAGE", process.execPath, harnessPath];
  const child = spawn(command, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr || stdout);
  assert.match(stdout, new RegExp(`scenario:${name}:ok`));
}
