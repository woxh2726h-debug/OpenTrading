-- Optional D1 schema for the server-side watchlist.
-- The Worker also creates this table on first use, so running it manually
-- is only needed if you prefer migrations.

CREATE TABLE IF NOT EXISTS watchlist (
  sid TEXT NOT NULL,
  symbol TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sid, symbol)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_sid ON watchlist (sid, created_at);
