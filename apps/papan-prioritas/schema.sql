-- Papan Prioritas: D1 schema. Safe to run more than once.
-- Dates are local (Asia/Jakarta) 'YYYY-MM-DD'; times 'HH:MM'; timestamps ISO-8601 UTC.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  pass_hash   TEXT NOT NULL,
  pass_salt   TEXT NOT NULL,
  pass_iter   INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key  TEXT NOT NULL,
  at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts(key, at);

-- quadrant: q1 Kerjakan (penting + mendesak), q2 Jadwalkan (penting), q3 Delegasikan (mendesak),
-- q4 Singkirkan, NULL = belum dipilah.
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  quadrant     TEXT CHECK (quadrant IN ('q1','q2','q3','q4')),
  due_date     TEXT,
  due_time     TEXT,
  delegate_to  TEXT,
  done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  done_at      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, done, due_date);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_user_date ON events(user_id, date);
