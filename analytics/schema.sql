-- Divar AR analytics — single events table (visits + presence beats).
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- epoch ms
  kind    TEXT    NOT NULL,   -- 'visit' | 'beat'
  sid     TEXT    NOT NULL,   -- anonymous session id (random, device-local)
  src     TEXT,               -- 'qr' | 'direct'
  poi     TEXT,               -- POI currently guided to (or null)
  lat     REAL,
  lon     REAL,
  country TEXT                -- from Cloudflare edge (request.cf.country)
);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_sid     ON events(sid);
