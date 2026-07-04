export function chooseAgentShot({ size, shots = [], difficulty = "normal", rng = Math.random }) {
  const candidates =
    difficulty === "easy" ? [] : targetedCandidates(size, shots);
  const unknownCells = candidates.length > 0 ? candidates : allUnknownCells(size, shots);

  if (unknownCells.length === 0) {
    throw new Error("No cells left to shoot");
  }

  const index = Math.min(unknownCells.length - 1, Math.floor(rng() * unknownCells.length));
  return unknownCells[index];
}

function targetedCandidates(size, shots) {
  const unresolvedHits = shots.filter((shot) => shot.result === "hit");
  if (unresolvedHits.length === 0) {
    return [];
  }

  const rows = new Set(unresolvedHits.map((shot) => shot.row));
  const cols = new Set(unresolvedHits.map((shot) => shot.col));

  if (unresolvedHits.length > 1 && rows.size === 1) {
    const row = unresolvedHits[0].row;
    const sorted = unresolvedHits.map((shot) => shot.col).sort((a, b) => a - b);
    return [
      { row, col: sorted[0] - 1 },
      { row, col: sorted[sorted.length - 1] + 1 },
    ].filter((coordinate) => isUnknown(size, shots, coordinate));
  }

  if (unresolvedHits.length > 1 && cols.size === 1) {
    const col = unresolvedHits[0].col;
    const sorted = unresolvedHits.map((shot) => shot.row).sort((a, b) => a - b);
    return [
      { row: sorted[0] - 1, col },
      { row: sorted[sorted.length - 1] + 1, col },
    ].filter((coordinate) => isUnknown(size, shots, coordinate));
  }

  return unresolvedHits.flatMap((shot) =>
    [
      { row: shot.row - 1, col: shot.col },
      { row: shot.row, col: shot.col - 1 },
      { row: shot.row, col: shot.col + 1 },
      { row: shot.row + 1, col: shot.col },
    ].filter((coordinate) => isUnknown(size, shots, coordinate)),
  );
}

function allUnknownCells(size, shots) {
  const cells = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const coordinate = { row, col };
      if (isUnknown(size, shots, coordinate)) {
        cells.push(coordinate);
      }
    }
  }
  return cells;
}

function isUnknown(size, shots, coordinate) {
  return (
    coordinate.row >= 0 &&
    coordinate.col >= 0 &&
    coordinate.row < size &&
    coordinate.col < size &&
    !shots.some((shot) => shot.row === coordinate.row && shot.col === coordinate.col)
  );
}
