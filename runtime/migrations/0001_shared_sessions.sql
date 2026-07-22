CREATE TABLE IF NOT EXISTS shared_sessions (
  subject_hash TEXT PRIMARY KEY NOT NULL,
  iv_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_sessions_updated_at
  ON shared_sessions(updated_at);
