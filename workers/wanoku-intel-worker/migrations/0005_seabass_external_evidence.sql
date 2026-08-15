CREATE TABLE IF NOT EXISTS seabass_external_evidence (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  species_id TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  source_class TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  event_start_at TEXT NOT NULL,
  event_end_at TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  mapped_node_id TEXT,
  evidence_type TEXT NOT NULL,
  presence_support TEXT NOT NULL,
  catch_outcome TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seabass_external_evidence_node_event
  ON seabass_external_evidence (mapped_node_id, event_start_at);

CREATE INDEX IF NOT EXISTS idx_seabass_external_evidence_species_event
  ON seabass_external_evidence (species_id, event_start_at);

CREATE INDEX IF NOT EXISTS idx_seabass_external_evidence_source_version
  ON seabass_external_evidence (source_identity, collected_at);
