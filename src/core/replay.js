export const replaySpeeds = Object.freeze([
  { label: "1x", delay: 1000 },
  { label: "1.5x", delay: 667 },
  { label: "2x", delay: 500 },
]);

export function normalizeReplayTurn(selectedTurn, totalTurns) {
  if (!Number.isInteger(totalTurns) || totalTurns <= 0) {
    return 0;
  }
  const turn = Number.isInteger(selectedTurn) ? selectedTurn : totalTurns;
  return Math.min(Math.max(turn, 1), totalTurns);
}

export function startReplayTurn(selectedTurn, totalTurns) {
  const currentTurn = normalizeReplayTurn(selectedTurn, totalTurns);
  return currentTurn >= totalTurns ? 1 : currentTurn;
}

export function advanceReplayTurn(selectedTurn, totalTurns) {
  const currentTurn = normalizeReplayTurn(selectedTurn, totalTurns);
  const turn = Math.min(currentTurn + 1, totalTurns);
  return { turn, complete: turn >= totalTurns };
}

export function nextReplaySpeedIndex(index) {
  const currentIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return (currentIndex + 1) % replaySpeeds.length;
}

export function createReplayClock({ setInterval: schedule, clearInterval: cancel }) {
  let intervalHandle = null;

  return {
    get running() {
      return intervalHandle !== null;
    },
    start(callback, delay) {
      if (intervalHandle !== null) {
        cancel(intervalHandle);
      }
      intervalHandle = schedule(callback, delay);
    },
    stop() {
      if (intervalHandle === null) {
        return;
      }
      cancel(intervalHandle);
      intervalHandle = null;
    },
  };
}
