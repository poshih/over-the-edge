CREATE TABLE art_connections (
  owner TEXT PRIMARY KEY,
  credential TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE art_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE art_variants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefab TEXT NOT NULL,
  parts TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE art_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  asset_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner, request_id)
);
CREATE INDEX art_jobs_owner ON art_jobs(owner, created_at DESC);
CREATE INDEX art_jobs_pending ON art_jobs(status, lease_until);
