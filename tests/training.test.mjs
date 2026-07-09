import test from "node:test";
import assert from "node:assert/strict";

import { getCell } from "../src/core/game.js";
import {
  applyTrainingShot,
  createTrainingSession,
  trainingScenarios,
  trainingScenarioForDrill,
  trainingProgramSummary,
  trainingSummary,
  updateTrainingProgress,
} from "../src/core/training.js";

const completionShotsByScenario = {
  checkerboard: [
    { row: 0, col: 0 },
    { row: 0, col: 2 },
    { row: 0, col: 1 },
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 0, col: 5 },
    { row: 1, col: 0 },
    { row: 1, col: 1 },
  ],
  lineFinish: [
    { row: 2, col: 1 },
    { row: 2, col: 3 },
  ],
  endgame: [
    { row: 1, col: 1 },
    { row: 3, col: 4 },
    { row: 5, col: 2 },
  ],
};

function completedTrainingSession(scenarioId) {
  let session = createTrainingSession(scenarioId);
  for (const coordinate of completionShotsByScenario[scenarioId]) {
    session = applyTrainingShot(session, coordinate);
  }
  assert.equal(session.phase, "finished");
  return session;
}

function completeDailyTrainingChain(progress, date) {
  return ["checkerboard", "lineFinish", "endgame"].reduce(
    (nextProgress, scenarioId, index) =>
      updateTrainingProgress(nextProgress, completedTrainingSession(scenarioId), `${date}T1${index}:00:00.000Z`),
    progress,
  );
}

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

test("updateTrainingProgress records completions and keeps best results", () => {
  let session = createTrainingSession("endgame");
  session = applyTrainingShot(session, { row: 1, col: 1 });
  session = applyTrainingShot(session, { row: 3, col: 4 });
  session = applyTrainingShot(session, { row: 5, col: 2 });

  const firstProgress = updateTrainingProgress({}, session, "2026-07-09T18:30:00.000Z");
  let weakerSession = createTrainingSession("endgame");
  for (const coordinate of [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: 2 },
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 0, col: 5 },
    { row: 2, col: 0 },
    { row: 2, col: 2 },
    { row: 1, col: 1 },
  ]) {
    weakerSession = applyTrainingShot(weakerSession, coordinate);
  }
  const nextProgress = updateTrainingProgress(firstProgress, weakerSession, "2026-07-09T18:31:00.000Z");

  assert.equal(weakerSession.phase, "finished");
  assert.deepEqual(nextProgress.endgame, {
    completions: 2,
    bestScore: 12,
    bestAccuracy: 100,
    bestRatingId: "excellent",
    lastPlayedAt: "2026-07-09T18:31:00.000Z",
  });
});

test("training program tracks a daily chain, next drill, and earned awards", () => {
  let progress = {};
  progress = updateTrainingProgress(progress, completedTrainingSession("checkerboard"), "2026-07-09T10:00:00.000Z");
  progress = updateTrainingProgress(progress, completedTrainingSession("lineFinish"), "2026-07-09T11:00:00.000Z");
  progress = updateTrainingProgress(progress, completedTrainingSession("endgame"), "2026-07-09T12:00:00.000Z");

  assert.deepEqual(progress.daily, {
    date: "2026-07-09",
    completions: 3,
    completedScenarioIds: ["checkerboard", "lineFinish", "endgame"],
    goalCompletedDate: "2026-07-09",
    streak: 1,
    bestStreak: 1,
    awards: ["firstWatch", "chainComplete"],
  });
  assert.deepEqual(trainingProgramSummary(progress, "2026-07-09T13:00:00.000Z"), {
    target: 3,
    completed: 3,
    remaining: 0,
    completedToday: true,
    nextScenarioId: "checkerboard",
    streak: 1,
    bestStreak: 1,
    awards: [
      { id: "firstWatch", earned: true },
      { id: "chainComplete", earned: true },
      { id: "threeDayStreak", earned: false },
      { id: "sevenDayStreak", earned: false },
    ],
  });
});

test("training program rewards streaks and resets the current chain on a new day", () => {
  let progress = completeDailyTrainingChain({}, "2026-07-09");
  progress = completeDailyTrainingChain(progress, "2026-07-10");
  progress = completeDailyTrainingChain(progress, "2026-07-11");

  assert.equal(progress.daily.streak, 3);
  assert.equal(progress.daily.bestStreak, 3);
  assert.deepEqual(progress.daily.awards, ["firstWatch", "chainComplete", "threeDayStreak"]);

  const nextDaySummary = trainingProgramSummary(progress, "2026-07-12T09:00:00.000Z");
  assert.equal(nextDaySummary.completed, 0);
  assert.equal(nextDaySummary.nextScenarioId, "checkerboard");
  assert.equal(nextDaySummary.streak, 3);

  progress = completeDailyTrainingChain(progress, "2026-07-13");
  assert.equal(progress.daily.streak, 1);
  assert.equal(progress.daily.bestStreak, 3);
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
