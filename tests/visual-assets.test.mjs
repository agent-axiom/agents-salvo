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

test("browser tab uses a themed salvo favicon", () => {
  assert.equal(existsSync(join(projectRoot, "src/favicon.svg")), true);
  assert.match(readText("src/index.html"), /<link rel="icon" type="image\/svg\+xml" href="\.\/favicon\.svg" \/>/);

  const favicon = readText("src/favicon.svg");
  assert.match(favicon, /<svg[^>]+viewBox="0 0 64 64"/);
  assert.match(favicon, /<title>Salvo anchor favicon<\/title>/);
  assert.match(favicon, /anchor/i);
  assert.match(favicon, /grid/i);
});
