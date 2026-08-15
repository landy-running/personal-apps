CREATE TABLE IF NOT EXISTS seabass_prediction_snapshots (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  species_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  knowledge_at TEXT NOT NULL,
  target_at TEXT NOT NULL,
  lead_hours REAL NOT NULL,
  decision_action TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  environment_state_schema_version TEXT NOT NULL,
  habitat_state_schema_version TEXT NOT NULL,
  seabass_state_schema_version TEXT NOT NULL,
  decision_schema_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seabass_prediction_snapshots_node_target
  ON seabass_prediction_snapshots (node_id, target_at);

CREATE INDEX IF NOT EXISTS idx_seabass_prediction_snapshots_knowledge
  ON seabass_prediction_snapshots (knowledge_at);
