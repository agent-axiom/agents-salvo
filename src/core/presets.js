import { defaultFleet } from "./game.js";

export const gamePresets = {
  quick: {
    id: "quick",
    size: 8,
    fleet: createFleet("quick", [3, 2, 2, 1, 1]),
    markers: [],
    rules: { salvo: false },
  },
  classic: {
    id: "classic",
    size: 10,
    fleet: defaultFleet(),
    markers: [],
    rules: { salvo: false },
  },
  salvo: {
    id: "salvo",
    size: 10,
    fleet: defaultFleet(),
    markers: [],
    rules: { salvo: true },
  },
  perelman: {
    id: "perelman",
    size: 16,
    fleet: createFleet("perelman", [5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1]),
    markers: [
      { id: "mine-1", type: "mine" },
      { id: "mine-2", type: "mine" },
      { id: "mine-3", type: "mine" },
      { id: "sweeper-1", type: "sweeper" },
    ],
    rules: { salvo: false },
  },
};

export function getGamePreset(id) {
  return gamePresets[id] ?? gamePresets.classic;
}

function createFleet(prefix, lengths) {
  const counts = new Map();
  return lengths.map((length) => {
    const number = (counts.get(length) ?? 0) + 1;
    counts.set(length, number);
    return {
      id: `${prefix}-${length}-${number}`,
      length,
    };
  });
}
