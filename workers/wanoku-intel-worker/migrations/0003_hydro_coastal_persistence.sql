CREATE TABLE IF NOT EXISTS hydro_coastal_source_runs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  http_status INTEGER,
  error_code TEXT,
  raw_hash TEXT,
  source_name TEXT,
  source_url TEXT,
  parser_id TEXT,
  parser_version TEXT,
  source_format_version TEXT,
  normalized_schema_version TEXT NOT NULL,
  run_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_source_runs_provider_requested
  ON hydro_coastal_source_runs (provider_id, requested_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_source_runs_status_requested
  ON hydro_coastal_source_runs (status, requested_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_source_runs_raw_hash
  ON hydro_coastal_source_runs (raw_hash);

CREATE TABLE IF NOT EXISTS hydro_coastal_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_key TEXT NOT NULL UNIQUE,
  identity_key TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  forecast_issued_at TEXT,
  value REAL,
  unit TEXT NOT NULL,
  status TEXT NOT NULL,
  provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
  vertical_datum_json TEXT,
  normalized_schema_version TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (source_run_id) REFERENCES hydro_coastal_source_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_identity_collected
  ON hydro_coastal_observations (identity_key, collected_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_station_observed
  ON hydro_coastal_observations (provider_id, station_id, metric, observed_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_station_collected
  ON hydro_coastal_observations (provider_id, station_id, collected_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_observed
  ON hydro_coastal_observations (observed_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_collected
  ON hydro_coastal_observations (collected_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_forecast_issued
  ON hydro_coastal_observations (forecast_issued_at);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_observations_source_run
  ON hydro_coastal_observations (source_run_id);
