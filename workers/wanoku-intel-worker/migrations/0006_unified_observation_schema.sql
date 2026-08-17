CREATE TABLE IF NOT EXISTS observation_spatial_references (
  spatial_ref_id TEXT PRIMARY KEY,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('habitat-node', 'river-segment')),
  source_registry_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS hydro_coastal_station_spatial_mappings (
  provider_id TEXT NOT NULL,
  station_id TEXT NOT NULL,
  spatial_ref_id TEXT NOT NULL,
  mapping_method TEXT NOT NULL CHECK (mapping_method IN ('explicit', 'hydrological', 'manual-reviewed')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider_id, station_id, spatial_ref_id, valid_from),
  FOREIGN KEY (spatial_ref_id) REFERENCES observation_spatial_references(spatial_ref_id),
  CHECK (valid_to IS NULL OR valid_from < valid_to)
);

CREATE INDEX IF NOT EXISTS idx_hydro_coastal_station_spatial_ref
  ON hydro_coastal_station_spatial_mappings (spatial_ref_id, provider_id, station_id);

CREATE TABLE IF NOT EXISTS fixed_coastal_facilities (
  facility_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  provider_facility_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  source_identity TEXT NOT NULL UNIQUE,
  spatial_ref_id TEXT,
  official_lat REAL,
  official_lon REAL,
  active_from TEXT,
  active_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (spatial_ref_id) REFERENCES observation_spatial_references(spatial_ref_id),
  UNIQUE (provider_id, provider_facility_key),
  CHECK ((official_lat IS NULL AND official_lon IS NULL) OR (official_lat BETWEEN -90 AND 90 AND official_lon BETWEEN -180 AND 180)),
  CHECK (active_to IS NULL OR active_from IS NULL OR active_from < active_to)
);

INSERT INTO fixed_coastal_facilities (
  facility_id,
  provider_id,
  provider_facility_key,
  display_name,
  source_identity,
  spatial_ref_id,
  official_lat,
  official_lon,
  active_from,
  active_to
) VALUES
  ('yokohama-honmoku', 'yokohama-fishing-piers', 'honmoku', 'Honmoku Fishing Pier', '["yokohama-fishing-piers","honmoku"]', NULL, NULL, NULL, NULL, NULL),
  ('yokohama-daikoku', 'yokohama-fishing-piers', 'daikoku', 'Daikoku Fishing Pier', '["yokohama-fishing-piers","daikoku"]', NULL, NULL, NULL, NULL, NULL),
  ('yokohama-isogo', 'yokohama-fishing-piers', 'isogo', 'Isogo Fishing Pier', '["yokohama-fishing-piers","isogo"]', NULL, NULL, NULL, NULL, NULL),
  ('ichihara-original-maker', 'ichihara-umizuri', 'original-maker', 'Original Maker Sea Fishing Park', '["ichihara-umizuri","original-maker"]', NULL, NULL, NULL, NULL, NULL);

CREATE TABLE IF NOT EXISTS fixed_node_daily_reports (
  report_id TEXT PRIMARY KEY,
  version_key TEXT NOT NULL UNIQUE,
  identity_key TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  published_at TEXT,
  collected_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  visitor_count INTEGER,
  operating_status TEXT NOT NULL CHECK (operating_status IN ('operating', 'closed', 'unknown')),
  report_completeness TEXT NOT NULL CHECK (report_completeness IN ('complete', 'incomplete', 'unknown')),
  normalized_schema_version TEXT NOT NULL,
  source_url TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (facility_id) REFERENCES fixed_coastal_facilities(facility_id),
  FOREIGN KEY (source_run_id) REFERENCES source_runs(id),
  UNIQUE (report_id, facility_id, observation_date),
  CHECK (visitor_count IS NULL OR visitor_count >= 0),
  CHECK (published_at IS NULL OR published_at <= collected_at)
);

CREATE INDEX IF NOT EXISTS idx_fixed_node_reports_facility_date
  ON fixed_node_daily_reports (facility_id, observation_date);

CREATE INDEX IF NOT EXISTS idx_fixed_node_reports_identity_latest
  ON fixed_node_daily_reports (identity_key, collected_at DESC, version_key DESC);

CREATE INDEX IF NOT EXISTS idx_fixed_node_reports_source_record
  ON fixed_node_daily_reports (provider_id, source_record_id);

CREATE TABLE IF NOT EXISTS fixed_node_species_observations (
  observation_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  observation_date TEXT NOT NULL,
  species_id TEXT NOT NULL CHECK (species_id IN ('japanese-seabass', 'sardine', 'sappa', 'konoshiro', 'aji', 'saba', 'bora', 'haze')),
  source_labels_json TEXT NOT NULL,
  catch_count INTEGER,
  presence_state TEXT NOT NULL CHECK (presence_state IN ('present', 'absent', 'unknown')),
  min_size_cm REAL,
  max_size_cm REAL,
  area_labels_json TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete', 'unknown')),
  alias_coverage TEXT NOT NULL CHECK (alias_coverage IN ('sufficient', 'insufficient', 'unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (report_id, facility_id, observation_date)
    REFERENCES fixed_node_daily_reports(report_id, facility_id, observation_date),
  UNIQUE (report_id, species_id),
  CHECK (catch_count IS NULL OR catch_count >= 0),
  CHECK (min_size_cm IS NULL OR min_size_cm >= 0),
  CHECK (max_size_cm IS NULL OR max_size_cm >= 0),
  CHECK (min_size_cm IS NULL OR max_size_cm IS NULL OR min_size_cm <= max_size_cm),
  CHECK (
    (presence_state = 'present' AND (catch_count IS NULL OR catch_count > 0))
    OR (presence_state = 'absent' AND catch_count = 0 AND completeness = 'complete' AND alias_coverage = 'sufficient')
    OR (presence_state = 'unknown' AND catch_count IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fixed_node_species_date
  ON fixed_node_species_observations (species_id, observation_date);

CREATE INDEX IF NOT EXISTS idx_fixed_node_species_facility_date
  ON fixed_node_species_observations (facility_id, species_id, observation_date);

CREATE TRIGGER IF NOT EXISTS trg_fixed_node_absence_requires_complete_operating_report
BEFORE INSERT ON fixed_node_species_observations
WHEN NEW.presence_state = 'absent'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM fixed_node_daily_reports
    WHERE report_id = NEW.report_id
      AND facility_id = NEW.facility_id
      AND observation_date = NEW.observation_date
      AND operating_status = 'operating'
      AND report_completeness = 'complete'
  ) THEN RAISE(ABORT, 'fixed-node absence requires a complete operating report') END;
END;
