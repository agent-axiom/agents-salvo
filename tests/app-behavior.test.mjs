import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("actual app authenticates Telegram Mini App launch data automatically", async () => {
  await runScenarioInChild("telegram-bootstrap");
});

test("actual app routes Telegram room and replay launches after authentication", async () => {
  await runScenarioInChild("telegram-launch-routing");
});

test("actual app retains Telegram room and replay launches across auth retry", async () => {
  await runScenarioInChild("telegram-launch-retry");
});

test("actual app makes valid Telegram launch params authoritative over URL replays", async () => {
  await runScenarioInChild("telegram-launch-authority");
});

test("actual app shares Telegram launches without changing web canonical links", async () => {
  await runScenarioInChild("telegram-launch-sharing");
});

test("actual app preserves online connection status while Telegram sharing settles", async () => {
  await runScenarioInChild("telegram-share-status-race");
});

test("actual app keeps Telegram Mini App auth failures recoverable and race-safe", async () => {
  await runScenarioInChild("telegram-auth-recovery");
});

test("actual app connects Telegram runtime controls through mobile lifecycle cleanup", async () => {
  await runScenarioInChild("telegram-runtime");
});

test("actual app contains rejected haptics without interrupting gameplay renders", async () => {
  await runScenarioInChild("haptic-runtime");
});

test("actual app honors Telegram theme precedence and renders safe build metadata", async () => {
  await runScenarioInChild("telegram-theme-build");
});

test("actual app retries Telegram capability and rejects failed secure persistence", async () => {
  await runScenarioInChild("auth-recovery");
});

test("actual app shows voluntary Stars support only in capable Telegram Mini Apps", async () => {
  await runScenarioInChild("stars-support-visibility");
});

test("actual app validates optional Stars amounts and terms without preselection", async () => {
  await runScenarioInChild("stars-support-selection");
});

test("actual app keeps Stars payment lifecycle cancellable, focused, and race-safe", async () => {
  await runScenarioInChild("stars-support-lifecycle");
});

test("Stars support terms expose a full-size touch target", () => {
  const styles = readFileSync("src/styles.css", "utf8");
  assert.match(
    styles,
    /\.stars-support-terms\s*\{[^}]*min-height:\s*44px;/u,
  );
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
