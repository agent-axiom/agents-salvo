export function defaultFleet() {
  return [
    { id: "battleship", length: 4 },
    { id: "cruiser-1", length: 3 },
    { id: "cruiser-2", length: 3 },
    { id: "destroyer-1", length: 2 },
    { id: "destroyer-2", length: 2 },
    { id: "destroyer-3", length: 2 },
    { id: "torpedo-1", length: 1 },
    { id: "torpedo-2", length: 1 },
    { id: "torpedo-3", length: 1 },
    { id: "torpedo-4", length: 1 },
  ];
}

export function createBoard(size = 10) {
  return {
    size,
    ships: [],
    markers: [],
    shots: [],
  };
}

export function placeShip(board, ship, start, orientation) {
  assertCoordinate(board, start);
  if (!Number.isInteger(ship.length) || ship.length < 1) {
    throw new Error("Ship length must be a positive integer");
  }
  if (board.ships.some((existing) => existing.id === ship.id)) {
    throw new Error(`Ship ${ship.id} is already placed`);
  }
  if (orientation !== "horizontal" && orientation !== "vertical") {
    throw new Error(`Invalid ship orientation: ${orientation}`);
  }

  const cells = Array.from({ length: ship.length }, (_, index) => ({
    row: start.row + (orientation === "vertical" ? index : 0),
    col: start.col + (orientation === "horizontal" ? index : 0),
  }));

  for (const cell of cells) {
    if (!isInBounds(board, cell)) {
      throw new Error("Ship placement is out of bounds");
    }
    if (findShipAt(board, cell)) {
      throw new Error("Ship placement would overlap another ship");
    }
    if (findMarkerAt(board, cell)) {
      throw new Error("Ship placement would overlap a special cell");
    }
    if (findTouchingShipAt(board, cell)) {
      throw new Error("Ship placement would touch another ship");
    }
    if (findTouchingMarkerAt(board, cell)) {
      throw new Error("Ship placement would touch a special cell");
    }
  }

  return {
    ...board,
    ships: [
      ...board.ships,
      {
        id: ship.id,
        length: ship.length,
        cells,
        hits: [],
      },
    ],
  };
}

export function removeShip(board, shipId) {
  if (!board.ships.some((ship) => ship.id === shipId)) {
    throw new Error(`Ship ${shipId} is not placed`);
  }

  return {
    ...board,
    ships: board.ships.filter((ship) => ship.id !== shipId).map(cloneShip),
    markers: (board.markers ?? []).map(cloneMarker),
    shots: board.shots.map((shot) => ({ ...shot })),
  };
}

export function placeMarker(board, marker, coordinate) {
  assertCoordinate(board, coordinate);
  if (marker.type !== "mine" && marker.type !== "sweeper") {
    throw new Error(`Invalid marker type: ${marker.type}`);
  }
  if ((board.markers ?? []).some((existing) => existing.id === marker.id)) {
    throw new Error(`Marker ${marker.id} is already placed`);
  }
  if (findShipAt(board, coordinate) || findMarkerAt(board, coordinate)) {
    throw new Error("Marker placement would overlap another piece");
  }
  if (findTouchingShipAt(board, coordinate) || findTouchingMarkerAt(board, coordinate)) {
    throw new Error("Marker placement would touch another piece");
  }

  return {
    ...board,
    ships: board.ships.map(cloneShip),
    markers: [
      ...(board.markers ?? []).map(cloneMarker),
      {
        id: marker.id,
        type: marker.type,
        cell: { ...coordinate },
      },
    ],
  };
}

export function removeMarker(board, markerId) {
  if (!(board.markers ?? []).some((marker) => marker.id === markerId)) {
    throw new Error(`Marker ${markerId} is not placed`);
  }

  return {
    ...board,
    ships: board.ships.map(cloneShip),
    markers: board.markers.filter((marker) => marker.id !== markerId).map(cloneMarker),
    shots: board.shots.map((shot) => ({ ...shot })),
  };
}

export function randomlyPlaceFleet(fleet = defaultFleet(), size = 10, rng = Math.random) {
  return fleet.reduce((board, ship) => {
    const placements = validPlacements(board, ship);
    if (placements.length === 0) {
      throw new Error(`No valid placement found for ${ship.id}`);
    }

    const index = Math.min(placements.length - 1, Math.floor(rng() * placements.length));
    const placement = placements[index];
    return placeShip(board, ship, placement.start, placement.orientation);
  }, createBoard(size));
}

export function randomlyPlaceSetup(preset, rng = Math.random) {
  const board = randomlyPlaceFleet(preset.fleet, preset.size, rng);
  return (preset.markers ?? []).reduce((currentBoard, marker) => {
    const placements = validMarkerPlacements(currentBoard, marker);
    if (placements.length === 0) {
      throw new Error(`No valid placement found for ${marker.id}`);
    }

    const index = Math.min(placements.length - 1, Math.floor(rng() * placements.length));
    return placeMarker(currentBoard, marker, placements[index]);
  }, board);
}

export function getCell(board, coordinate) {
  assertCoordinate(board, coordinate);
  const ship = findShipAt(board, coordinate);
  const marker = findMarkerAt(board, coordinate);
  const shot = board.shots.find((entry) => sameCoordinate(entry, coordinate));

  return {
    shipId: ship?.id ?? null,
    markerId: marker?.id ?? null,
    markerType: marker?.type ?? null,
    shot: shot?.result ?? null,
  };
}

export function receiveShot(board, coordinate) {
  assertCoordinate(board, coordinate);
  if (board.shots.some((shot) => sameCoordinate(shot, coordinate))) {
    throw new Error("Cell has already been shot");
  }

  const targetMarker = findMarkerAt(board, coordinate);
  if (targetMarker) {
    return {
      board: {
        ...board,
        ships: board.ships.map(cloneShip),
        markers: (board.markers ?? []).map(cloneMarker),
        shots: [
          ...board.shots,
          {
            ...coordinate,
            result: targetMarker.type,
            markerId: targetMarker.id,
          },
        ],
      },
      outcome: { type: targetMarker.type, coordinate, markerId: targetMarker.id },
    };
  }

  const targetShip = findShipAt(board, coordinate);
  if (!targetShip) {
    return {
      board: {
        ...board,
        ships: board.ships.map(cloneShip),
        markers: (board.markers ?? []).map(cloneMarker),
        shots: [...board.shots, { ...coordinate, result: "miss" }],
      },
      outcome: { type: "miss", coordinate },
    };
  }

  const updatedShips = board.ships.map((ship) => {
    if (ship.id !== targetShip.id) {
      return cloneShip(ship);
    }

    return {
      ...cloneShip(ship),
      hits: [...ship.hits, coordinate],
    };
  });
  const updatedShip = updatedShips.find((ship) => ship.id === targetShip.id);
  const type = updatedShip.cells.every((cell) =>
    updatedShip.hits.some((hit) => sameCoordinate(hit, cell)),
  )
    ? "sunk"
    : "hit";
  const shots =
    type === "sunk"
      ? markSunkShipShots(board, updatedShip)
      : [...board.shots, { ...coordinate, result: type, shipId: targetShip.id }];

  return {
    board: {
      ...board,
      ships: updatedShips,
      shots,
    },
    outcome: { type, coordinate, shipId: targetShip.id },
  };
}

export function allShipsSunk(board) {
  return (
    board.ships.length > 0 &&
    board.ships.every((ship) =>
      ship.cells.every((cell) => ship.hits.some((hit) => sameCoordinate(hit, cell))),
    )
  );
}

export function hasCompleteFleet(board, fleet = defaultFleet()) {
  return (
    sortedLengths(board.ships) === sortedLengths(fleet) &&
    board.ships.every((ship) => ship.cells.length === ship.length) &&
    board.ships.every((ship) => ship.cells.every((cell) => isInBounds(board, cell))) &&
    board.ships.every((ship, index) =>
      board.ships.every((otherShip, otherIndex) => {
        if (index === otherIndex) {
          return true;
        }
        return !shipsTouch(ship, otherShip);
      }),
    )
  );
}

export function hasCompleteSetup(board, preset) {
  return (
    board.size === preset.size &&
    hasCompleteFleet(board, preset.fleet) &&
    sortedMarkerTypes(board.markers ?? []) === sortedMarkerTypes(preset.markers ?? []) &&
    (board.markers ?? []).every((marker) => marker.cell && isInBounds(board, marker.cell)) &&
    (board.markers ?? []).every((marker, index) =>
      (board.markers ?? []).every((otherMarker, otherIndex) => {
        if (index === otherIndex) {
          return true;
        }
        return !cellsTouch(marker.cell, otherMarker.cell);
      }),
    ) &&
    (board.markers ?? []).every(
      (marker) => !board.ships.some((ship) => ship.cells.some((cell) => cellsTouch(cell, marker.cell))),
    )
  );
}

export function createGameFromBoards(p1Board, p2Board, firstPlayerId = "p1", options = {}) {
  if (firstPlayerId !== "p1" && firstPlayerId !== "p2") {
    throw new Error(`Invalid first player: ${firstPlayerId}`);
  }
  const rules = normalizeRules(options.rules);

  return {
    phase: "playing",
    currentPlayerId: firstPlayerId,
    winnerId: null,
    presetId: options.presetId ?? "classic",
    rules,
    salvoRemaining: rules.salvo ? salvoShotCount(p1Board, p2Board, firstPlayerId) : 1,
    players: {
      p1: { id: "p1", board: cloneBoard(p1Board) },
      p2: { id: "p2", board: cloneBoard(p2Board) },
    },
    log: [],
  };
}

export function fireAt(game, playerId, coordinate) {
  if (game.phase !== "playing") {
    throw new Error("Game is already finished");
  }
  if (game.currentPlayerId !== playerId) {
    throw new Error("It is not this player's turn");
  }

  const targetPlayerId = playerId === "p1" ? "p2" : "p1";
  const result = receiveShot(game.players[targetPlayerId].board, coordinate);
  const targetBoard = result.board;
  const finished = allShipsSunk(targetBoard);
  const rules = normalizeRules(game.rules);
  const missed = result.outcome.type !== "hit" && result.outcome.type !== "sunk";
  const currentSalvoRemaining = Number.isInteger(game.salvoRemaining)
    ? game.salvoRemaining
    : salvoShotCountForBoard(game.players[playerId].board);
  const spentSalvo = rules.salvo ? Math.max(0, currentSalvoRemaining - 1) : 0;
  const nextPlayerId = rules.salvo
    ? spentSalvo > 0
      ? playerId
      : targetPlayerId
    : missed
      ? targetPlayerId
      : playerId;
  const players = {
    ...game.players,
    [targetPlayerId]: {
      ...game.players[targetPlayerId],
      board: targetBoard,
    },
  };
  const salvoRemaining = rules.salvo
    ? finished
      ? 0
      : nextPlayerId === playerId
        ? spentSalvo
        : salvoShotCountForBoard(players[nextPlayerId].board)
    : 1;

  return {
    game: {
      ...game,
      phase: finished ? "finished" : "playing",
      currentPlayerId: finished ? playerId : nextPlayerId,
      winnerId: finished ? playerId : null,
      rules,
      salvoRemaining,
      players,
      log: [
        ...game.log,
        {
          playerId,
          targetPlayerId,
          coordinate,
          result: result.outcome.type,
          shipId: result.outcome.shipId ?? null,
        },
      ],
    },
    outcome: result.outcome,
  };
}

export function publicBoardView(board) {
  return {
    size: board.size,
    shots: board.shots.map((shot) => ({ ...shot })),
  };
}

export function cloneBoard(board) {
  return {
    size: board.size,
    ships: (board.ships ?? []).map(cloneShip),
    markers: (board.markers ?? []).map(cloneMarker),
    shots: (board.shots ?? []).map((shot) => ({ ...shot })),
  };
}

function cloneShip(ship) {
  return {
    id: ship.id,
    length: ship.length,
    cells: ship.cells.map((cell) => ({ ...cell })),
    hits: (ship.hits ?? []).map((hit) => ({ ...hit })),
  };
}

function cloneMarker(marker) {
  return {
    id: marker.id,
    type: marker.type,
    cell: { ...marker.cell },
  };
}

function findShipAt(board, coordinate) {
  return board.ships.find((ship) =>
    ship.cells.some((cell) => sameCoordinate(cell, coordinate)),
  );
}

function findTouchingShipAt(board, coordinate) {
  return board.ships.find((ship) =>
    ship.cells.some((cell) => cellsTouch(cell, coordinate)),
  );
}

function findMarkerAt(board, coordinate) {
  return (board.markers ?? []).find((marker) => sameCoordinate(marker.cell, coordinate));
}

function findTouchingMarkerAt(board, coordinate) {
  return (board.markers ?? []).find((marker) => cellsTouch(marker.cell, coordinate));
}

function markSunkShipShots(board, ship) {
  const shotsByCoordinate = new Map(
    board.shots.map((shot) => [coordinateKey(shot), { ...shot }]),
  );

  for (const cell of ship.cells) {
    shotsByCoordinate.set(coordinateKey(cell), {
      ...cell,
      result: "sunk",
      shipId: ship.id,
    });
  }

  for (const cell of surroundingCells(board, ship.cells)) {
    const key = coordinateKey(cell);
    if (!shotsByCoordinate.has(key)) {
      shotsByCoordinate.set(key, { ...cell, result: "miss" });
    }
  }

  return Array.from(shotsByCoordinate.values());
}

function surroundingCells(board, cells) {
  const shipCells = new Set(cells.map(coordinateKey));
  const surrounding = new Map();

  for (const cell of cells) {
    for (let row = cell.row - 1; row <= cell.row + 1; row += 1) {
      for (let col = cell.col - 1; col <= cell.col + 1; col += 1) {
        const candidate = { row, col };
        const key = coordinateKey(candidate);
        if (isInBounds(board, candidate) && !shipCells.has(key)) {
          surrounding.set(key, candidate);
        }
      }
    }
  }

  return Array.from(surrounding.values());
}

function validPlacements(board, ship) {
  const placements = [];
  for (const orientation of ["horizontal", "vertical"]) {
    for (let row = 0; row < board.size; row += 1) {
      for (let col = 0; col < board.size; col += 1) {
        try {
          placeShip(board, ship, { row, col }, orientation);
          placements.push({ start: { row, col }, orientation });
        } catch {
          // Invalid placements are expected while scanning the board.
        }
      }
    }
  }
  return placements;
}

function validMarkerPlacements(board, marker) {
  const placements = [];
  for (let row = 0; row < board.size; row += 1) {
    for (let col = 0; col < board.size; col += 1) {
      const coordinate = { row, col };
      try {
        placeMarker(board, marker, coordinate);
        placements.push(coordinate);
      } catch {
        // Invalid placements are expected while scanning the board.
      }
    }
  }
  return placements;
}

function assertCoordinate(board, coordinate) {
  if (!isInBounds(board, coordinate)) {
    throw new Error(`Coordinate ${coordinate?.row},${coordinate?.col} is out of bounds`);
  }
}

function isInBounds(board, coordinate) {
  return (
    coordinate &&
    Number.isInteger(coordinate.row) &&
    Number.isInteger(coordinate.col) &&
    coordinate.row >= 0 &&
    coordinate.col >= 0 &&
    coordinate.row < board.size &&
    coordinate.col < board.size
  );
}

function sameCoordinate(a, b) {
  return a.row === b.row && a.col === b.col;
}

function coordinateKey(coordinate) {
  return `${coordinate.row}:${coordinate.col}`;
}

function cellsTouch(a, b) {
  return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
}

function shipsTouch(a, b) {
  return a.cells.some((aCell) => b.cells.some((bCell) => cellsTouch(aCell, bCell)));
}

function sortedLengths(ships) {
  return ships
    .map((ship) => ship.length)
    .sort((a, b) => b - a)
    .join(",");
}

function sortedMarkerTypes(markers) {
  return markers
    .map((marker) => marker.type)
    .sort()
    .join(",");
}

function normalizeRules(rules = {}) {
  return {
    salvo: Boolean(rules.salvo),
  };
}

function salvoShotCount(p1Board, p2Board, playerId) {
  return salvoShotCountForBoard(playerId === "p1" ? p1Board : p2Board);
}

function salvoShotCountForBoard(board) {
  return Math.max(
    1,
    board.ships.filter(
      (ship) => !ship.cells.every((cell) => ship.hits.some((hit) => sameCoordinate(hit, cell))),
    ).length,
  );
}
