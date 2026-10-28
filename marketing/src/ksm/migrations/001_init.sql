-- KrushiSarva marketing autopilot — initial schema.
-- All timestamps are UTC ISO-8601 strings. SQLite runs in WAL mode with foreign keys on.

CREATE TABLE IF NOT EXISTS slots (
  id             TEXT PRIMARY KEY,                 -- '2026-10-17@fresh'
  slot_date      TEXT NOT NULL,                    -- IST date
  kind           TEXT NOT NULL CHECK (kind IN ('fresh','advisory')),
  publish_at     TEXT NOT NULL,
  produce_from   TEXT NOT NULL,
  approve_by     TEXT NOT NULL,
  late_until     TEXT NOT NULL,
  video_id       INTEGER UNIQUE REFERENCES videos(id),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','filled','missed','skipped')),
  UNIQUE (slot_date, kind)
);

CREATE TABLE IF NOT EXISTS videos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  series         TEXT NOT NULL,
  topic_key      TEXT NOT NULL,
  data_date      TEXT,                             -- date the data describes; NULL for evergreen
  evergreen      INTEGER NOT NULL DEFAULT 0,
  time_sensitive INTEGER NOT NULL DEFAULT 0,
  fresh_until    TEXT,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL,
  redo_count     INTEGER NOT NULL DEFAULT 0,
  feedback       TEXT,                             -- check feedback for the next writer attempt
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (series, topic_key, data_date)
);
CREATE INDEX IF NOT EXISTS videos_state ON videos(state);

CREATE TABLE IF NOT EXISTS revisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id       INTEGER NOT NULL REFERENCES videos(id),
  rev_no         INTEGER NOT NULL,
  script_json    TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',       -- final per-platform title/caption/hashtags (after edits)
  checks_json    TEXT NOT NULL DEFAULT '{}',
  timeline_json  TEXT,
  master_path    TEXT,
  master_sha256  TEXT,
  preview_path   TEXT,
  cover_path     TEXT,
  duration_s     REAL,
  content_hash   TEXT,                             -- sha256(master_sha256 + metadata_json); approvals bind to it
  prompt_version TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (video_id, rev_no)
);

CREATE TABLE IF NOT EXISTS data_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL,                    -- 'agmarknet'
  key            TEXT NOT NULL,                    -- e.g. 'Maharashtra'
  data_date      TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  UNIQUE (source, key, data_date)
);

CREATE TABLE IF NOT EXISTS approvals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id      INTEGER NOT NULL REFERENCES revisions(id),
  content_hash     TEXT NOT NULL,
  nonce            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','superseded')),
  platforms_json   TEXT NOT NULL DEFAULT '[]',     -- platforms selected on the card
  message_ids_json TEXT NOT NULL DEFAULT '[]',
  sent_at          TEXT,
  decided_at       TEXT,
  decision_json    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_approval
  ON approvals(revision_id) WHERE status IN ('pending','approved');

CREATE TABLE IF NOT EXISTS publications (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id             INTEGER NOT NULL REFERENCES videos(id),
  revision_id          INTEGER NOT NULL REFERENCES revisions(id),
  platform             TEXT NOT NULL CHECK (platform IN ('yt','ig','fb')),
  state                TEXT NOT NULL,
  upload_session_uri   TEXT,                       -- yt resumable session; persisted BEFORE bytes are sent
  container_id         TEXT,                       -- ig container / fb video id; persisted BEFORE upload
  container_created_at TEXT,
  remote_id            TEXT,
  scheduled_for        TEXT,
  published_at         TEXT,
  permalink            TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT,
  last_error           TEXT,
  UNIQUE (video_id, platform),
  UNIQUE (platform, remote_id)
);

CREATE TABLE IF NOT EXISTS tg_updates (update_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  video_id  INTEGER,
  kind      TEXT NOT NULL,
  json      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  month      TEXT NOT NULL,                        -- 'YYYY-MM' (IST)
  provider   TEXT NOT NULL,                        -- 'anthropic' | 'sarvam' | ...
  op         TEXT NOT NULL,                        -- 'writer' | 'factcheck' | 'tts' | ...
  video_id   INTEGER,
  units_json TEXT NOT NULL DEFAULT '{}',
  cost_inr   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_month ON cost_ledger(month);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  platform    TEXT NOT NULL,
  remote_id   TEXT NOT NULL,
  bucket      TEXT NOT NULL,                       -- '24h' | '48h' | '7d'
  captured_at TEXT NOT NULL,
  json        TEXT NOT NULL,
  PRIMARY KEY (platform, remote_id, bucket)
);

CREATE TABLE IF NOT EXISTS follower_snapshots (
  platform  TEXT NOT NULL,
  date      TEXT NOT NULL,
  followers INTEGER NOT NULL,
  PRIMARY KEY (platform, date)
);

CREATE TABLE IF NOT EXISTS series_weights (
  series     TEXT PRIMARY KEY,
  weight     REAL NOT NULL,
  updated_at TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'config'
);

CREATE TABLE IF NOT EXISTS leases (
  name       TEXT PRIMARY KEY,
  pid        INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
