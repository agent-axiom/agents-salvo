import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harnessPath = fileURLToPath(new URL("./app-behavior-harness.mjs", import.meta.url));

test("actual app boot stays rendered and gates auth on deferred runtime state", async () => {
  await runScenarioInChild("startup");
});

test("actual app routes close online state and require destructive confirmation", async () => {
  await runScenarioInChild("navigation");
});

async function runScenarioInChild(name) {
  const child = spawn("/usr/bin/env", ["-u", "NODE_V8_COVERAGE", process.execPath, harnessPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { SALVO_APP_BEHAVIOR_SCENARIO: name },
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
