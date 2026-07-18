CREATE TABLE IF NOT EXISTS star_support_payments (
  invoice_id TEXT PRIMARY KEY,
  invoice_payload TEXT NOT NULL UNIQUE,
  user_key TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 10000),
  currency TEXT NOT NULL DEFAULT 'XTR' CHECK (currency = 'XTR'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  paid_at INTEGER,
  failed_at INTEGER,
  refunded_at INTEGER,
  telegram_payment_charge_id TEXT UNIQUE,
  CHECK ((status = 'paid' AND paid_at IS NOT NULL AND telegram_payment_charge_id IS NOT NULL)
      OR status <> 'paid')
);

CREATE INDEX IF NOT EXISTS idx_star_support_owner_created
  ON star_support_payments (user_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_star_support_expiry
  ON star_support_payments (status, expires_at);
