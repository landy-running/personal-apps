DROP INDEX IF EXISTS idx_environmental_snapshots_unique_logical;

ALTER TABLE source_runs ADD COLUMN node_id TEXT;

ALTER TABLE environmental_snapshots ADD COLUMN collected_at TEXT;

UPDATE source_runs
SET node_id = (
  SELECT environmental_snapshots.node_id
  FROM environmental_snapshots
  WHERE environmental_snapshots.source_run_id = source_runs.id
  LIMIT 1
)
WHERE node_id IS NULL;

UPDATE environmental_snapshots
SET collected_at = COALESCE(
  (
    SELECT source_runs.completed_at
    FROM source_runs
    WHERE source_runs.id = environmental_snapshots.source_run_id
  ),
  (
    SELECT source_runs.requested_at
    FROM source_runs
    WHERE source_runs.id = environmental_snapshots.source_run_id
  ),
  forecast_issued_at,
  created_at
)
WHERE collected_at IS NULL;

UPDATE environmental_snapshots
SET forecast_issued_at = NULL
WHERE (
    provider IN ('open-meteo-weather', 'open-meteo-marine')
    OR source IN ('open-meteo-weather', 'open-meteo-marine')
  )
  AND forecast_issued_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_runs_provider_node_requested
  ON source_runs (provider, node_id, requested_at);

CREATE INDEX IF NOT EXISTS idx_environmental_snapshots_node_provider_observed
  ON environmental_snapshots (node_id, provider, observed_at);

CREATE INDEX IF NOT EXISTS idx_environmental_snapshots_node_provider_collected
  ON environmental_snapshots (node_id, provider, collected_at);

CREATE INDEX IF NOT EXISTS idx_environmental_snapshots_source_run
  ON environmental_snapshots (source_run_id);
