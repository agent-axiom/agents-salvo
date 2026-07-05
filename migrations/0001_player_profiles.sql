CREATE TABLE IF NOT EXISTS users (
  user_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_provider_identity_idx
  ON users (provider, provider_id);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('agent', 'online', 'hotseat')),
  preset_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss')),
  opponent TEXT NOT NULL,
  total_shots INTEGER NOT NULL DEFAULT 0,
  player_shots INTEGER NOT NULL DEFAULT 0,
  player_hits INTEGER NOT NULL DEFAULT 0,
  player_misses INTEGER NOT NULL DEFAULT 0,
  player_sunk INTEGER NOT NULL DEFAULT 0,
  accuracy INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  winner_id TEXT NOT NULL,
  played_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, user_key),
  FOREIGN KEY (user_key) REFERENCES users (user_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS matches_user_played_at_idx
  ON matches (user_key, played_at DESC);

CREATE INDEX IF NOT EXISTS matches_user_mode_idx
  ON matches (user_key, mode);
