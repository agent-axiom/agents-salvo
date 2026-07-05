import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;
const readText = (path) => readFileSync(join(projectRoot, path), "utf8");

test("main menu and readmes use the shared salvo board artwork", () => {
  assert.equal(existsSync(join(projectRoot, "src/assets/salvo-board-action.png")), true);

  assert.match(readText("src/app.js"), /\.\/assets\/salvo-board-action\.png/);

  for (const readme of ["README.md", "README.ru.md", "README.zh-CN.md"]) {
    assert.match(readText(readme), /src\/assets\/salvo-board-action\.png/);
  }
});
