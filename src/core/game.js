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
    if (findTouchingShipAt(board, cell)) {
      throw new Error("Ship placement would touch another ship");
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

export function getCell(board, coordinate) {
  assertCoordinate(board, coordinate);
  const ship = findShipAt(board, coordinate);
  const shot = board.shots.find((entry) => sameCoordinate(entry, coordinate));

  return {
    shipId: ship?.id ?? null,
    shot: shot?.result ?? null,
  };
}

export function receiveShot(board, coordinate) {
  assertCoordinate(board, coordinate);
  if (board.shots.some((shot) => sameCoordinate(shot, coordinate))) {
    throw new Error("Cell has already been shot");
  }

  const targetShip = findShipAt(board, coordinate);
  if (!targetShip) {
    return {
      board: {
        ...board,
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

  return {
    board: {
      ...board,
      ships: updatedShips,
      shots: [...board.shots, { ...coordinate, result: type, shipId: targetShip.id }],
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
    board.size === 10 &&
    sortedLengths(board.ships) === sortedLengths(fleet) &&
    board.ships.every((ship) => ship.cells.length === ship.length) &&
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

export function createGameFromBoards(p1Board, p2Board, firstPlayerId = "p1") {
  if (firstPlayerId !== "p1" && firstPlayerId !== "p2") {
    throw new Error(`Invalid first player: ${firstPlayerId}`);
  }

  return {
    phase: "playing",
    currentPlayerId: firstPlayerId,
    winnerId: null,
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
  const nextPlayerId = result.outcome.type === "miss" ? targetPlayerId : playerId;

  return {
    game: {
      ...game,
      phase: finished ? "finished" : "playing",
      currentPlayerId: finished ? playerId : nextPlayerId,
      winnerId: finished ? playerId : null,
      players: {
        ...game.players,
        [targetPlayerId]: {
          ...game.players[targetPlayerId],
          board: targetBoard,
        },
      },
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
    ships: board.ships.map(cloneShip),
    shots: board.shots.map((shot) => ({ ...shot })),
  };
}

function cloneShip(ship) {
  return {
    id: ship.id,
    length: ship.length,
    cells: ship.cells.map((cell) => ({ ...cell })),
    hits: ship.hits.map((hit) => ({ ...hit })),
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
