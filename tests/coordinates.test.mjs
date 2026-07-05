import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("src/app.js", "utf8");

test("board and log coordinates use localized column labels", () => {
  assert.match(app, /coordinateColumnLabel/);
  assert.doesNotMatch(app, /String\.fromCharCode\(65 \+/);
});
