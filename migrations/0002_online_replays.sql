CREATE TABLE IF NOT EXISTS battle_replays (
  id TEXT PRIMARY KEY,
  p1_user_key TEXT NOT NULL,
  p2_user_key TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  winner_id TEXT NOT NULL CHECK (winner_id IN ('p1', 'p2')),
  finished_at TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS battle_replays_p1_finished_idx
  ON battle_replays (p1_user_key, finished_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS battle_replays_p2_finished_idx
  ON battle_replays (p2_user_key, finished_at DESC, id DESC);

ALTER TABLE matches ADD COLUMN replay_id TEXT;

CREATE INDEX IF NOT EXISTS matches_replay_id_idx ON matches (replay_id);
