CREATE TABLE IF NOT EXISTS source_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  http_status INTEGER,
  error_code TEXT,
  model_version TEXT NOT NULL,
  raw_hash TEXT,
  normalized_schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_source_runs_provider_requested
  ON source_runs (provider, requested_at);

CREATE INDEX IF NOT EXISTS idx_source_runs_status_requested
  ON source_runs (status, requested_at);

CREATE TABLE IF NOT EXISTS environmental_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_key TEXT NOT NULL UNIQUE,
  source_run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  node_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  forecast_issued_at TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  confidence REAL NOT NULL,
  freshness REAL NOT NULL,
  missing_fields_json TEXT NOT NULL,
  normalized_schema_version TEXT NOT NULL,
  raw_hash TEXT,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_run_id) REFERENCES source_runs(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_environmental_snapshots_unique_logical
  ON environmental_snapshots (node_id, provider, observed_at, IFNULL(forecast_issued_at, ''), normalized_schema_version);

CREATE INDEX IF NOT EXISTS idx_environmental_snapshots_node_observed
  ON environmental_snapshots (node_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_environmental_snapshots_provider_observed
  ON environmental_snapshots (provider, observed_at);

CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  normalized_schema_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  target_window_start TEXT,
  target_window_end TEXT,
  node_id TEXT,
  provider TEXT,
  requested_at TEXT,
  completed_at TEXT,
  status TEXT,
  http_status INTEGER,
  error_code TEXT,
  raw_hash TEXT,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_node_generated
  ON prediction_snapshots (node_id, generated_at);

CREATE TABLE IF NOT EXISTS evidence_events (
  id TEXT PRIMARY KEY,
  provider TEXT,
  source_id TEXT,
  requested_at TEXT,
  completed_at TEXT,
  status TEXT,
  http_status INTEGER,
  error_code TEXT,
  model_version TEXT,
  raw_hash TEXT,
  normalized_schema_version TEXT NOT NULL,
  node_id TEXT,
  observed_at TEXT,
  forecast_issued_at TEXT,
  published_at TEXT,
  evidence_url TEXT,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_events_observed
  ON evidence_events (observed_at);

CREATE INDEX IF NOT EXISTS idx_evidence_events_source
  ON evidence_events (provider, source_id);

CREATE TABLE IF NOT EXISTS backtest_results (
  id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  normalized_schema_version TEXT NOT NULL,
  provider TEXT,
  requested_at TEXT,
  completed_at TEXT,
  status TEXT,
  http_status INTEGER,
  error_code TEXT,
  raw_hash TEXT,
  node_id TEXT,
  observed_at TEXT,
  forecast_issued_at TEXT,
  window_start TEXT,
  window_end TEXT,
  metrics_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_backtest_results_node_window
  ON backtest_results (node_id, window_start, window_end);
