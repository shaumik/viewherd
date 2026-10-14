CREATE TABLE webdr_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
