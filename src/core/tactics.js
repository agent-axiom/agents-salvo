export function analyzeTargetBoard(board, options = {}) {
  const size = Number.isInteger(board?.size) && board.size > 0 ? board.size : 10;
  const shots = Array.isArray(board?.shots) ? board.shots : [];
  const totalCells = size * size;
  const shotKeys = new Set(shots.map(coordinateKey));
  const unresolvedHitShots = shots.filter((shot) => shot.result === "hit");
  const priorityTargets = unresolvedHitShots.length
    ? uniqueCoordinates(unresolvedHitShots.flatMap((shot) => openOrthogonalNeighbors(size, shot, shotKeys)))
    : [];
  const availableTargets = Math.max(0, totalCells - shotKeys.size);
  const salvoRemaining = Number.isInteger(options.salvoRemaining) && options.salvoRemaining > 0
    ? options.salvoRemaining
    : 1;

  return {
    totalCells,
    shotsTaken: shotKeys.size,
    availableTargets,
    unresolvedHits: unresolvedHitShots.length,
    sunkShips: uniqueShipIds(shots.filter((shot) => shot.result === "sunk")).length,
    salvoRemaining,
    priorityTargets,
    recommendationId: tacticalRecommendation({
      availableTargets,
      priorityTargets,
      salvoRemaining,
      shotsTaken: shotKeys.size,
      totalCells,
      unresolvedHits: unresolvedHitShots.length,
    }),
  };
}

function tacticalRecommendation({
  availableTargets,
  priorityTargets,
  salvoRemaining,
  shotsTaken,
  totalCells,
  unresolvedHits,
}) {
  if (unresolvedHits > 0 || priorityTargets.length > 0) {
    return "finishDamaged";
  }
  if (availableTargets <= Math.max(4, Math.ceil(totalCells * 0.18))) {
    return "endgame";
  }
  if (salvoRemaining > 1) {
    return "salvoPressure";
  }
  if (shotsTaken === 0) {
    return "openingPattern";
  }
  return "huntPattern";
}

function openOrthogonalNeighbors(size, coordinate, shotKeys) {
  return [
    { row: coordinate.row - 1, col: coordinate.col },
    { row: coordinate.row, col: coordinate.col + 1 },
    { row: coordinate.row + 1, col: coordinate.col },
    { row: coordinate.row, col: coordinate.col - 1 },
  ].filter((candidate) => isInBounds(size, candidate) && !shotKeys.has(coordinateKey(candidate)));
}

function isInBounds(size, coordinate) {
  return (
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.col) &&
    coordinate.row >= 0 &&
    coordinate.col >= 0 &&
    coordinate.row < size &&
    coordinate.col < size
  );
}

function uniqueCoordinates(coordinates) {
  const seen = new Set();
  return coordinates.filter((coordinate) => {
    const key = coordinateKey(coordinate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueShipIds(shots) {
  return Array.from(new Set(shots.map((shot) => shot.shipId).filter(Boolean)));
}

function coordinateKey(coordinate) {
  return `${coordinate.row}:${coordinate.col}`;
}
