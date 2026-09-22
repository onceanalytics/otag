-- Events, and nothing else.
--
-- The table matches Once Analytics column for column, so upgrading later means
-- pointing the paid worker at this same database rather than migrating out of
-- it. Do not add or reorder columns here without changing it there too.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  event_name TEXT NOT NULL,
  page_path TEXT NOT NULL,
  referrer TEXT,
  country TEXT,
  browser TEXT,
  os TEXT,
  device TEXT,
  is_bot INTEGER DEFAULT 0,
  privacy_mode INTEGER,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  event_data TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One index, covering `WHERE site_id = ? AND created_at BETWEEN ? AND ?`.
--
-- Every index costs a written row per insert, and on Cloudflare's free plan
-- writes are what run out first: 100,000 rows a day is about 23,000 pageviews
-- with this index and about 5,000 with the eight that Once Analytics carries.
-- Add your own when a query of yours is slow - it is one statement, and the
-- trade is yours to make.
CREATE INDEX IF NOT EXISTS idx_events_site_created ON events(site_id, created_at);

-- Instance values that have to survive a redeploy. Currently one row: the salt.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
