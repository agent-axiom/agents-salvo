import { allShipsSunk, createBoard, placeShip, receiveShot } from "./game.js";

export const trainingScenarios = [
  {
    id: "checkerboard",
    size: 6,
    shotLimit: 8,
  },
  {
    id: "lineFinish",
    size: 6,
    shotLimit: 5,
  },
  {
    id: "endgame",
    size: 6,
    shotLimit: 9,
  },
];

export const trainingProgramScenarioIds = ["checkerboard", "lineFinish", "endgame"];
export const trainingProgramAwardIds = ["firstWatch", "chainComplete", "threeDayStreak", "sevenDayStreak"];

export function createTrainingSession(scenarioId = "checkerboard") {
  const scenario = scenarioById(scenarioId);
  return {
    scenarioId: scenario.id,
    phase: "playing",
    board: createScenarioBoard(scenario.id),
    log: [],
    score: 0,
    shotLimit: scenario.shotLimit,
  };
}

export function trainingScenarioForDrill(drillId) {
  const scenariosByDrill = {
    checkerboard: "checkerboard",
    lineFinish: "lineFinish",
    salvoControl: "endgame",
    openingMap: "checkerboard",
  };
  return scenariosByDrill[drillId] ?? "checkerboard";
}

export function applyTrainingShot(session, coordinate) {
  if (session.phase !== "playing") {
    throw new Error("Training session is already finished");
  }

  const scenario = scenarioById(session.scenarioId);
  const result = receiveShot(session.board, coordinate);
  const evaluation = evaluateTrainingShot(scenario.id, session.board, coordinate, result.outcome.type);
  const log = [
    ...session.log,
    {
      coordinate: { ...coordinate },
      result: result.outcome.type,
      quality: evaluation.quality,
      feedbackId: evaluation.feedbackId,
    },
  ];
  const nextSession = {
    ...session,
    board: result.board,
    log,
    score: Math.max(0, session.score + evaluation.scoreDelta),
  };

  return {
    ...nextSession,
    phase: isTrainingFinished(nextSession) ? "finished" : "playing",
  };
}

export function trainingSummary(session) {
  const hits = session.log.filter((entry) => entry.result === "hit" || entry.result === "sunk").length;
  const misses = session.log.filter((entry) => entry.result === "miss").length;
  const sunk = session.log.filter((entry) => entry.result === "sunk").length;
  const accuracy = session.log.length === 0 ? 0 : Math.round((hits / session.log.length) * 100);
  return {
    shots: session.log.length,
    hits,
    misses,
    sunk,
    score: session.score,
    accuracy,
    ratingId: trainingRating({ phase: session.phase, shots: session.log.length, accuracy, score: session.score }),
  };
}

export function updateTrainingProgress(progress = {}, session, playedAt = new Date().toISOString()) {
  const summary = trainingSummary(session);
  const previousProgress = progress?.[session.scenarioId] ?? {};
  const playedDate = dateKey(playedAt);

  return {
    ...(progress ?? {}),
    [session.scenarioId]: {
      completions: safeNumber(previousProgress.completions) + 1,
      bestScore: Math.max(safeNumber(previousProgress.bestScore), summary.score),
      bestAccuracy: Math.max(safeNumber(previousProgress.bestAccuracy), summary.accuracy),
      bestRatingId: strongerTrainingRating(previousProgress.bestRatingId, summary.ratingId),
      lastPlayedAt: playedAt,
    },
    daily: updateDailyTrainingProgress(progress?.daily, session.scenarioId, playedDate),
  };
}

export function trainingProgramSummary(progress = {}, today = new Date().toISOString()) {
  const currentDate = dateKey(today);
  const daily = progress?.daily ?? {};
  const completedScenarioIds = daily.date === currentDate ? normalizedScenarioIds(daily.completedScenarioIds) : [];
  const completed = Math.min(completedScenarioIds.length, trainingProgramScenarioIds.length);
  const nextScenarioId =
    trainingProgramScenarioIds.find((scenarioId) => !completedScenarioIds.includes(scenarioId)) ??
    trainingProgramScenarioIds[0];
  const earnedAwards = normalizedAwardIds(daily.awards);

  return {
    target: trainingProgramScenarioIds.length,
    completed,
    remaining: Math.max(0, trainingProgramScenarioIds.length - completed),
    completedToday: completed >= trainingProgramScenarioIds.length,
    nextScenarioId,
    streak: safeNumber(daily.streak),
    bestStreak: safeNumber(daily.bestStreak),
    awards: trainingProgramAwardIds.map((id) => ({ id, earned: earnedAwards.includes(id) })),
  };
}

function scenarioById(scenarioId) {
  const scenario = trainingScenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) {
    throw new Error(`Unknown training scenario: ${scenarioId}`);
  }
  return scenario;
}

function createScenarioBoard(scenarioId) {
  if (scenarioId === "checkerboard") {
    let board = createBoard(6);
    board = placeShip(board, { id: "search-cruiser", length: 3 }, { row: 4, col: 1 }, "horizontal");
    return placeShip(board, { id: "search-destroyer", length: 2 }, { row: 1, col: 4 }, "vertical");
  }

  if (scenarioId === "lineFinish") {
    const board = placeShip(createBoard(6), { id: "damaged-cruiser", length: 3 }, { row: 2, col: 1 }, "horizontal");
    return receiveShot(board, { row: 2, col: 2 }).board;
  }

  let board = createBoard(6);
  board = placeShip(board, { id: "endgame-one", length: 1 }, { row: 1, col: 1 }, "horizontal");
  board = placeShip(board, { id: "endgame-two", length: 1 }, { row: 3, col: 4 }, "horizontal");
  return placeShip(board, { id: "endgame-three", length: 1 }, { row: 5, col: 2 }, "horizontal");
}

function evaluateTrainingShot(scenarioId, board, coordinate, result) {
  if (result === "sunk") {
    return { quality: "strong", feedbackId: "sunk", scoreDelta: 4 };
  }
  if (result === "hit") {
    return { quality: "strong", feedbackId: "hit", scoreDelta: 3 };
  }
  if (scenarioId === "checkerboard") {
    return (coordinate.row + coordinate.col) % 2 === 0
      ? { quality: "strong", feedbackId: "pattern", scoreDelta: 1 }
      : { quality: "weak", feedbackId: "randomWater", scoreDelta: 0 };
  }
  if (scenarioId === "lineFinish") {
    return isAdjacentToKnownHit(board, coordinate)
      ? { quality: "strong", feedbackId: "finishLine", scoreDelta: 1 }
      : { quality: "weak", feedbackId: "offLine", scoreDelta: 0 };
  }
  return { quality: "neutral", feedbackId: "miss", scoreDelta: 0 };
}

function isTrainingFinished(session) {
  return allShipsSunk(session.board) || session.log.length >= session.shotLimit;
}

function isAdjacentToKnownHit(board, coordinate) {
  return board.shots
    .filter((shot) => shot.result === "hit")
    .some((shot) => Math.abs(shot.row - coordinate.row) + Math.abs(shot.col - coordinate.col) === 1);
}

function trainingRating({ phase, shots, accuracy, score }) {
  if (phase === "finished" && shots > 0 && accuracy >= 70) {
    return "excellent";
  }
  if (score >= Math.max(2, shots)) {
    return "steady";
  }
  return "needsWork";
}

const trainingRatingRank = {
  needsWork: 0,
  steady: 1,
  excellent: 2,
};

function strongerTrainingRating(previousRatingId, nextRatingId) {
  const previousRank = trainingRatingRank[previousRatingId] ?? -1;
  const nextRank = trainingRatingRank[nextRatingId] ?? -1;
  return previousRank >= nextRank ? previousRatingId : nextRatingId;
}

function updateDailyTrainingProgress(previousDaily = {}, scenarioId, playedDate) {
  const sameDay = previousDaily?.date === playedDate;
  const completedScenarioIds = sameDay ? normalizedScenarioIds(previousDaily.completedScenarioIds) : [];
  const awards = normalizedAwardIds(previousDaily.awards);
  const nextDaily = {
    date: playedDate,
    completions: (sameDay ? safeNumber(previousDaily.completions) : 0) + 1,
    completedScenarioIds: addUniqueScenarioId(completedScenarioIds, scenarioId),
    goalCompletedDate: previousDaily?.goalCompletedDate ?? "",
    streak: safeNumber(previousDaily?.streak),
    bestStreak: safeNumber(previousDaily?.bestStreak),
    awards,
  };

  const goalCompleted =
    nextDaily.completedScenarioIds.length >= trainingProgramScenarioIds.length &&
    nextDaily.goalCompletedDate !== playedDate;

  if (!goalCompleted) {
    return nextDaily;
  }

  const streak = isPreviousDate(nextDaily.goalCompletedDate, playedDate) ? nextDaily.streak + 1 : 1;
  nextDaily.goalCompletedDate = playedDate;
  nextDaily.streak = streak;
  nextDaily.bestStreak = Math.max(nextDaily.bestStreak, streak);
  nextDaily.awards = earnedTrainingAwards(awards, streak);
  return nextDaily;
}

function earnedTrainingAwards(previousAwards, streak) {
  const awards = [...previousAwards];
  addUniqueAwardId(awards, "firstWatch");
  addUniqueAwardId(awards, "chainComplete");
  if (streak >= 3) {
    addUniqueAwardId(awards, "threeDayStreak");
  }
  if (streak >= 7) {
    addUniqueAwardId(awards, "sevenDayStreak");
  }
  return awards;
}

function addUniqueScenarioId(scenarioIds, scenarioId) {
  if (!trainingProgramScenarioIds.includes(scenarioId) || scenarioIds.includes(scenarioId)) {
    return scenarioIds;
  }
  return [...scenarioIds, scenarioId];
}

function addUniqueAwardId(awards, awardId) {
  if (trainingProgramAwardIds.includes(awardId) && !awards.includes(awardId)) {
    awards.push(awardId);
  }
}

function normalizedScenarioIds(scenarioIds) {
  return Array.isArray(scenarioIds)
    ? scenarioIds.filter((scenarioId) => trainingProgramScenarioIds.includes(scenarioId))
    : [];
}

function normalizedAwardIds(awardIds) {
  return Array.isArray(awardIds) ? awardIds.filter((awardId) => trainingProgramAwardIds.includes(awardId)) : [];
}

function isPreviousDate(previousDate, nextDate) {
  if (!previousDate) {
    return false;
  }
  const previousTime = Date.parse(`${previousDate}T00:00:00.000Z`);
  const nextTime = Date.parse(`${nextDate}T00:00:00.000Z`);
  return Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime - previousTime === 86_400_000;
}

function dateKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
