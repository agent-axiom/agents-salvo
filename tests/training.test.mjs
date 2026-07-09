import test from "node:test";
import assert from "node:assert/strict";

import { getCell } from "../src/core/game.js";
import {
  applyTrainingShot,
  createTrainingSession,
  trainingScenarios,
  trainingScenarioForDrill,
  trainingSummary,
} from "../src/core/training.js";

test("training scenarios expose search, finishing, and endgame drills", () => {
  assert.deepEqual(
    trainingScenarios.map((scenario) => scenario.id),
    ["checkerboard", "lineFinish", "endgame"],
  );
  assert.equal(createTrainingSession().scenarioId, "checkerboard");
  assert.throws(() => createTrainingSession("missing"), /Unknown training scenario/);
});

test("trainingScenarioForDrill maps coaching drills to playable scenarios", () => {
  assert.equal(trainingScenarioForDrill("checkerboard"), "checkerboard");
  assert.equal(trainingScenarioForDrill("lineFinish"), "lineFinish");
  assert.equal(trainingScenarioForDrill("salvoControl"), "endgame");
  assert.equal(trainingScenarioForDrill("openingMap"), "checkerboard");
  assert.equal(trainingScenarioForDrill("unknown"), "checkerboard");
});

test("checkerboard training rewards patterned search before random water shots", () => {
  const session = createTrainingSession("checkerboard");

  const strong = applyTrainingShot(session, { row: 0, col: 0 });
  const weak = applyTrainingShot(strong, { row: 0, col: 1 });

  assert.equal(strong.log.at(-1).result, "miss");
  assert.equal(strong.log.at(-1).quality, "strong");
  assert.equal(weak.log.at(-1).quality, "weak");
  assert.equal(weak.score, 1);
});

test("checkerboard training can finish by shot limit and reports steady patterned play", () => {
  let session = createTrainingSession("checkerboard");
  session = applyTrainingShot(session, { row: 0, col: 0 });
  session = applyTrainingShot(session, { row: 0, col: 2 });

  assert.equal(trainingSummary(session).ratingId, "steady");

  for (const coordinate of [
    { row: 0, col: 1 },
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 0, col: 5 },
    { row: 1, col: 0 },
    { row: 1, col: 1 },
  ]) {
    session = applyTrainingShot(session, coordinate);
  }

  assert.equal(session.phase, "finished");
  assert.throws(() => applyTrainingShot(session, { row: 1, col: 2 }), /already finished/);
});

test("line finishing training starts with a known hit and finishes the damaged ship", () => {
  const session = createTrainingSession("lineFinish");

  assert.equal(getCell(session.board, { row: 2, col: 2 }).shot, "hit");

  const first = applyTrainingShot(session, { row: 2, col: 1 });
  const finished = applyTrainingShot(first, { row: 2, col: 3 });

  assert.equal(first.log.at(-1).quality, "strong");
  assert.equal(finished.log.at(-1).result, "sunk");
  assert.equal(finished.phase, "finished");
  assert.equal(trainingSummary(finished).ratingId, "excellent");
});

test("line finishing training distinguishes adjacent follow-up from off-line shots", () => {
  const adjacent = applyTrainingShot(createTrainingSession("lineFinish"), { row: 1, col: 2 });
  const offLine = applyTrainingShot(createTrainingSession("lineFinish"), { row: 0, col: 0 });

  assert.equal(adjacent.log.at(-1).feedbackId, "finishLine");
  assert.equal(adjacent.log.at(-1).quality, "strong");
  assert.equal(offLine.log.at(-1).feedbackId, "offLine");
  assert.equal(offLine.log.at(-1).quality, "weak");
});

test("endgame training completes after sinking all three remaining ships", () => {
  let session = createTrainingSession("endgame");

  session = applyTrainingShot(session, { row: 1, col: 1 });
  session = applyTrainingShot(session, { row: 3, col: 4 });
  session = applyTrainingShot(session, { row: 5, col: 2 });

  const summary = trainingSummary(session);
  assert.equal(session.phase, "finished");
  assert.equal(summary.hits, 3);
  assert.equal(summary.sunk, 3);
  assert.equal(summary.ratingId, "excellent");
});

test("endgame training reports neutral misses as repeat-worthy practice", () => {
  const session = applyTrainingShot(createTrainingSession("endgame"), { row: 0, col: 0 });
  const summary = trainingSummary(session);

  assert.equal(session.log.at(-1).feedbackId, "miss");
  assert.equal(session.log.at(-1).quality, "neutral");
  assert.equal(summary.ratingId, "needsWork");
});
