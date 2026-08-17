import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIXED_COASTAL_FACILITIES,
  FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
  buildFixedNodeDailyReport,
  fixedNodeSpeciesIdFromAuditGroup,
  normalizedCatchPer100Visitors
} from "../../../packages/wanoku-core/src/fixed-node-observation.ts";
import {
  materializeFixedNodeDailyReport,
  persistFixedNodeDailyReport
} from "./fixed-node-observation-persistence.js";
import {
  buildSegmentGraph,
  CORRIDORS
} from "../../../scripts/wanoku-river-canal-observability-audit.mjs";
import { parseYokohamaLastPost } from "../../../scripts/wanoku-coastal-fixed-node-historical-audit.mjs";

const MIGRATION_PATH = "workers/wanoku-intel-worker/migrations/0006_unified_observation_schema.sql";
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const COLLECTED_AT = "2026-08-17T03:00:00.000Z";
const STORED_AT = "2026-08-17T03:00:01.000Z";

describe("Unified Observation Schema v1 core", () => {
  it("keeps the four audited facilities on stable provider identities without invented coordinates", () => {
    expect(FIXED_COASTAL_FACILITIES.map((facility) => facility.facilityId)).toEqual([
      "yokohama-honmoku",
      "yokohama-daikoku",
      "yokohama-isogo",
      "ichihara-original-maker"
    ]);
    expect(FIXED_COASTAL_FACILITIES[0].sourceIdentity).toBe('["yokohama-fishing-piers","honmoku"]');
    expect(FIXED_COASTAL_FACILITIES.every((facility) => facility.officialLatitude === null)).toBe(true);
    expect(FIXED_COASTAL_FACILITIES.every((facility) => facility.officialLongitude === null)).toBe(true);
    expect(FIXED_COASTAL_FACILITIES.every((facility) => facility.spatialRefId === null)).toBe(true);
  });

  it("keeps report identity and semantic version stable across collectedAt-only retries", async () => {
    const first = await materializeFixedNodeDailyReport(reportInput(), STORED_AT);
    const retry = await materializeFixedNodeDailyReport(reportInput({
      collectedAt: "2026-08-17T04:00:00.000Z"
    }), "2026-08-17T04:00:01.000Z");

    expect(retry.identityKey).toBe(first.identityKey);
    expect(retry.semanticHash).toBe(first.semanticHash);
    expect(retry.reportId).toBe(first.reportId);
    expect(retry.versionKey).toBe(first.versionKey);
  });

  it.each([
    ["sourceRunId", { sourceRunId: "fixed-run:metadata-retry" }],
    ["sourceUrl", { sourceUrl: "https://yokohama-fishingpiers.jp/honmoku/fishing-history?source=canonical" }]
  ])("keeps semantic version stable across %s-only retries", async (_name, overrides) => {
    const first = await materializeFixedNodeDailyReport(reportInput(), STORED_AT);
    const retry = await materializeFixedNodeDailyReport(reportInput(overrides), "2026-08-17T03:10:00.000Z");
    expect(retry.reportId).toBe(first.reportId);
    expect(retry.versionKey).toBe(first.versionKey);
  });

  it.each([
    ["catch", reportInput(), reportInput({ species: [speciesRow("japanese-seabass", 13)] })],
    ["visitor", reportInput(), reportInput({ visitorCount: 201 })],
    [
      "operating status",
      reportInput({ operatingStatus: "closed", species: [speciesRow("japanese-seabass", null)] }),
      reportInput({ operatingStatus: "unknown", species: [speciesRow("japanese-seabass", null)] })
    ],
    [
      "species addition",
      reportInput(),
      reportInput({ species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 2)] })
    ],
    [
      "species removal",
      reportInput({ species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 2)] }),
      reportInput()
    ]
  ])("creates a new semantic version for %s changes", async (_name, before, after) => {
    const first = await materializeFixedNodeDailyReport(before, STORED_AT);
    const revision = await materializeFixedNodeDailyReport(after, "2026-08-17T03:10:00.000Z");
    expect(revision.identityKey).toBe(first.identityKey);
    expect(revision.reportId).not.toBe(first.reportId);
    expect(revision.versionKey).not.toBe(first.versionKey);
  });

  it("derives species observation identity from report version and species, never acquisition time", async () => {
    const first = await materializeFixedNodeDailyReport(reportInput(), STORED_AT);
    const retry = await materializeFixedNodeDailyReport(reportInput({ collectedAt: "2026-08-17T04:00:00.000Z" }), STORED_AT);
    expect(first.species[0].observationId).toBe(retry.species[0].observationId);
    expect(first.species[0].observationId).toMatch(/^wanoku-fixed-species:[0-9a-f]{64}$/u);
  });

  it("permits explicit seabass zero only on a complete operating report with sufficient alias coverage", () => {
    const built = buildFixedNodeDailyReport(reportInput({
      facilityId: "yokohama-isogo",
      sourceRecordId: "last-post:isogo-zero",
      species: [speciesRow("japanese-seabass", 0)]
    }));
    expect(built.valid).toBe(true);
    expect(built.report?.species[0]).toMatchObject({ catchCount: 0, presenceState: "absent" });
  });

  it("rejects closed-day zero and preserves closed as unknown", () => {
    const closedUnknown = buildFixedNodeDailyReport(reportInput({
      operatingStatus: "closed",
      reportCompleteness: "complete",
      species: [speciesRow("japanese-seabass", null)]
    }));
    const closedZero = buildFixedNodeDailyReport(reportInput({
      operatingStatus: "closed",
      reportCompleteness: "complete",
      species: [speciesRow("japanese-seabass", 0)]
    }));
    expect(closedUnknown.valid).toBe(true);
    expect(closedUnknown.report?.species[0].presenceState).toBe("unknown");
    expect(closedZero.valid).toBe(false);
    expect(closedZero.errors.join(" ")).toContain("requires an operating report");
  });

  it("rejects incomplete-day zero and preserves incomplete as unknown", () => {
    const incompleteUnknown = buildFixedNodeDailyReport(reportInput({
      reportCompleteness: "incomplete",
      species: [speciesRow("japanese-seabass", null)]
    }));
    const incompleteZero = buildFixedNodeDailyReport(reportInput({
      reportCompleteness: "incomplete",
      species: [speciesRow("japanese-seabass", 0)]
    }));
    expect(incompleteUnknown.valid).toBe(true);
    expect(incompleteZero.valid).toBe(false);
    expect(incompleteZero.errors.join(" ")).toContain("requires a complete report");
  });

  it("keeps visitor null and division by zero out of normalized values", () => {
    expect(buildFixedNodeDailyReport(reportInput({ visitorCount: null })).report?.visitorCount).toBeNull();
    expect(normalizedCatchPer100Visitors(12, null)).toBeNull();
    expect(normalizedCatchPer100Visitors(12, 0)).toBeNull();
    expect(normalizedCatchPer100Visitors(12, 200)).toBe(6);
  });

  it("rejects duplicate species within one report", () => {
    const built = buildFixedNodeDailyReport(reportInput({
      species: [speciesRow("japanese-seabass", 1), speciesRow("japanese-seabass", 2)]
    }));
    expect(built.valid).toBe(false);
    expect(built.errors).toContain("species contains duplicate speciesId: japanese-seabass.");
  });

  it("reuses the audited alias classification and maps its group to the canonical species id", () => {
    const parsed = parseYokohamaLastPost({
      facility: "honmoku",
      id: "alias-fixture",
      date: "2026/07/02",
      createdAt: "2026-07-02T08:00:00.000Z",
      updatedAt: "2026-07-02T08:00:00.000Z",
      visitors: 10,
      fish1Name: "スズキ",
      fish1Count: 2,
      fish1MinSize: 45,
      fish1MaxSize: 55,
      fish1Unit: "cm",
      fish1Place: ["pier"]
    }, { facilityId: "yokohama-honmoku", collectedAt: COLLECTED_AT });
    expect(parsed.species[0].canonicalGroup).toBe("seabass");
    expect(fixedNodeSpeciesIdFromAuditGroup(parsed.species[0].canonicalGroup)).toBe("japanese-seabass");
  });

  it("keeps bait and seabass as separate species facts", () => {
    const built = buildFixedNodeDailyReport(reportInput({
      species: [speciesRow("japanese-seabass", 0), speciesRow("konoshiro", 30)]
    }));
    expect(built.valid).toBe(true);
    expect(built.report?.species.map((row) => [row.speciesId, row.catchCount])).toEqual([
      ["japanese-seabass", 0],
      ["konoshiro", 30]
    ]);
  });
});

describe("Unified Observation Schema v1 repository", () => {
  it("preserves source revisions as separate rows", async () => {
    const db = new FixedNodeD1();
    const first = await persistFixedNodeDailyReport(db, { report: reportInput(), storedAt: STORED_AT });
    const revision = await persistFixedNodeDailyReport(db, {
      report: reportInput({
        collectedAt: "2026-08-17T04:00:00.000Z",
        species: [speciesRow("japanese-seabass", 14)]
      }),
      storedAt: "2026-08-17T04:00:01.000Z"
    });
    expect(revision.reportId).not.toBe(first.reportId);
    expect(revision.report.reportIdentity).toBe(first.report.reportIdentity);
    expect(db.reportRows).toHaveLength(2);
    expect(db.speciesRows).toHaveLength(2);
  });

  it("treats collectedAt-only retry as idempotent and keeps the first acquisition row", async () => {
    const db = new FixedNodeD1();
    const first = await persistFixedNodeDailyReport(db, { report: reportInput(), storedAt: STORED_AT });
    const retry = await persistFixedNodeDailyReport(db, {
      report: reportInput({ collectedAt: "2026-08-17T04:00:00.000Z" }),
      storedAt: "2026-08-17T04:00:01.000Z"
    });
    expect(retry.created).toBe(false);
    expect(retry.reportId).toBe(first.reportId);
    expect(retry.report.collectedAt).toBe(COLLECTED_AT);
    expect(db.reportRows).toHaveLength(1);
    expect(db.batchCalls).toBe(1);
  });

  it("duplicates one complete species bundle when only one species is revised", async () => {
    const db = new FixedNodeD1();
    const original = reportInput({ species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 30)] });
    const revision = reportInput({
      collectedAt: "2026-08-17T04:00:00.000Z",
      species: [speciesRow("japanese-seabass", 13), speciesRow("konoshiro", 30)]
    });
    await persistFixedNodeDailyReport(db, { report: original, storedAt: STORED_AT });
    await persistFixedNodeDailyReport(db, { report: revision, storedAt: "2026-08-17T04:00:01.000Z" });
    expect(db.reportRows).toHaveLength(2);
    expect(db.speciesRows).toHaveLength(4);
    expect(db.batchCalls).toBe(2);
    expect(db.writeStatements).toHaveLength(6);
  });

  it("duplicates one complete species bundle when only visitor count is revised", async () => {
    const db = new FixedNodeD1();
    const original = reportInput({ species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 30)] });
    const revision = reportInput({
      collectedAt: "2026-08-17T04:00:00.000Z",
      visitorCount: 201,
      species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 30)]
    });
    await persistFixedNodeDailyReport(db, { report: original, storedAt: STORED_AT });
    await persistFixedNodeDailyReport(db, { report: revision, storedAt: "2026-08-17T04:00:01.000Z" });
    expect(db.reportRows).toHaveLength(2);
    expect(db.speciesRows).toHaveLength(4);
    expect(db.writeStatements).toHaveLength(6);
  });

  it("uses one D1 batch for report plus species and only plain INSERT statements", async () => {
    const db = new FixedNodeD1();
    await persistFixedNodeDailyReport(db, {
      report: reportInput({ species: [speciesRow("japanese-seabass", 12), speciesRow("konoshiro", 30)] }),
      storedAt: STORED_AT
    });
    const writes = db.writeStatements.map((entry) => entry.sql).join("\n");
    expect(db.batchCalls).toBe(1);
    expect(db.writeStatements).toHaveLength(3);
    expect(writes).toMatch(/^INSERT INTO fixed_node_daily_reports/mu);
    expect(writes).not.toMatch(/\b(UPDATE|DELETE|REPLACE|UPSERT|DROP)\b/iu);
  });
});

describe("Unified Observation Schema v1 migration", () => {
  it("adds only fixed-node facts plus source-of-truth spatial references and mappings", () => {
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS fixed_node_daily_reports");
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS fixed_node_species_observations");
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS observation_spatial_references");
    expect(MIGRATION).toContain("CREATE TABLE IF NOT EXISTS hydro_coastal_station_spatial_mappings");
    expect(MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS observation_spatial_relations");
    expect(MIGRATION).not.toMatch(/corridor_id|gate_controlled|co_located|relation_type/iu);
    expect(MIGRATION).not.toMatch(/CREATE TABLE[^;]*(?:hydrology|water_quality|biological_prior|macro_catch)/iu);
    expect(MIGRATION).not.toMatch(/\b(?:DROP|UPDATE|DELETE|ALTER)\b/iu);
    expect(MIGRATION).not.toMatch(/INSERT\s+OR\s+(?:IGNORE|REPLACE)|REPLACE\s+INTO/iu);
  });

  it("provides the five requested query indexes without indexing derived normalization", () => {
    expect(MIGRATION).toContain("idx_fixed_node_reports_facility_date");
    expect(MIGRATION).toContain("idx_fixed_node_reports_identity_latest");
    expect(MIGRATION).toContain("idx_fixed_node_reports_source_record");
    expect(MIGRATION).toContain("idx_fixed_node_species_date");
    expect(MIGRATION).toContain("idx_fixed_node_species_facility_date");
    expect(MIGRATION).not.toContain("normalized_catch_per_100_visitors");
    expect(MIGRATION.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(6);
  });

  it("keeps the 39 segments and 46 edges in their audit source of truth and only references their ids", () => {
    const graph = buildSegmentGraph();
    const segmentIds = CORRIDORS.flatMap((corridor) => corridor.segments.map((segment) => segment.segmentId));
    expect(segmentIds).toHaveLength(39);
    expect(graph.edges).toHaveLength(46);
    expect(graph.externalHabitatLinks).toHaveLength(10);
    expect(graph.externalHabitatLinks.every((link) => link.coLocated === false)).toBe(true);
    expect(graph.externalHabitatLinks).toContainEqual(expect.objectContaining({
      segmentId: "ARA-0",
      habitatNodeId: "sumida-arakawa-mouth-01",
      coLocated: false
    }));
    expect(MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS habitat_graph");
    expect(MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS observation_spatial_relations");
    expect(MIGRATION).toContain("reference_kind IN ('habitat-node', 'river-segment')");
  });

  it("keeps hydrology in the existing hydro/coastal fact tables", () => {
    expect(MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS hydro_coastal_observations");
    expect(MIGRATION).not.toContain("CREATE TABLE IF NOT EXISTS hydro_coastal_source_runs");
    expect(MIGRATION).toContain("hydro_coastal_station_spatial_mappings");
  });

  it("has no ANGLERS dependency, network operation, Worker route, or remote command", () => {
    const persistence = readFileSync("workers/wanoku-intel-worker/src/fixed-node-observation-persistence.js", "utf8");
    const combined = `${MIGRATION}\n${persistence}`;
    expect(combined).not.toMatch(/anglers|fetch\s*\(|wrangler|--remote|\/admin\//iu);
  });

  it("applies the clean migration chain and round-trips representative fixtures and derived queries", async () => {
    const materialized = await materializeFixtures();
    const result = runSqliteRoundTrip(materialized);

    expect(result.tables).toEqual(expect.arrayContaining([
      "fixed_coastal_facilities",
      "fixed_node_daily_reports",
      "fixed_node_species_observations",
      "observation_spatial_references",
      "hydro_coastal_station_spatial_mappings"
    ]));
    expect(result.facilityCount).toBe(4);
    expect(result.reportCount).toBe(7);
    expect(result.latestLogicalReportCount).toBe(6);
    expect(result.speciesObservationCount).toBe(8);
    expect(result.honmokuLatestCatchPer100Visitors).toBe(7);
    expect(result.daikokuLargeCatch).toBe(120);
    expect(result.isogoExplicitZero).toEqual([0, "absent"]);
    expect(result.closedUnknown).toEqual([null, "unknown"]);
    expect(result.incompleteUnknown).toEqual([null, "unknown"]);
    expect(result.konoshiroCatch).toBe(30);
    expect(result.completeOperatingPresenceRate).toBeCloseTo(0.5, 8);
    expect(result.baitLeadPairs).toBe(1);
    expect(result.hydroDateJoinCount).toBeGreaterThan(0);
    expect(result.rollingBaselineRows).toBeGreaterThan(0);
    expect(result.seasonalAnomalyRows).toBeGreaterThan(0);
    expect(result.duplicateRejected).toBe(true);
    expect(result.invalidClosedZeroRejected).toBe(true);
    expect(result.invalidIncompleteZeroRejected).toBe(true);
    expect(result.invalidAliasZeroRejected).toBe(true);
    expect(result.invalidUnknownNumericRejected).toBe(true);
    expect(result.invalidPositiveZeroRejected).toBe(true);
    expect(result.zeroTriggerMessage).toContain("fixed-node absence requires a complete operating report");
    expect(result.orphanSpeciesRejected).toBe(true);
    expect(result.orphanReportFacilityRejected).toBe(true);
    expect(result.orphanReportSourceRunRejected).toBe(true);
    expect(result.referencedDeleteRejected).toBe(true);
    expect(result.foreignKeyActions.every((action) => action.onUpdate === "NO ACTION" && action.onDelete === "NO ACTION")).toBe(true);
    expect(result.asOfBeforeRevisionCatch).toBe(12);
    expect(result.asOfAfterRevisionCatch).toBe(14);
    expect(result.asOfPublishedNullIncluded).toBe(true);
    expect(result.explain.identityAsOf).toContain("idx_fixed_node_reports_identity_latest");
    expect(result.explain.facilityDate).toContain("idx_fixed_node_reports_facility_date");
    expect(result.explain.sourceRecord).toContain("idx_fixed_node_reports_source_record");
    expect(result.explain.speciesDate).toContain("idx_fixed_node_species_date");
    expect(result.explain.facilitySpeciesDate).toContain("idx_fixed_node_species_facility_date");
    expect(result.explain.stationSpatial).toContain("idx_hydro_coastal_station_spatial_ref");
  });

  it("applies 0006 over populated 0001-0005 data without changing existing rows or schema objects", () => {
    const result = runPopulatedMigrationCompatibility();
    expect(result.beforeCounts).toEqual({ hydro: 1, prediction: 1, evidence: 1 });
    expect(result.afterCounts).toEqual(result.beforeCounts);
    expect(result.missingExistingObjects).toEqual([]);
    expect(result.newFacilityCount).toBe(4);
    expect(result.foreignKeyViolations).toEqual([]);
  });
});

function reportInput(overrides = {}) {
  return {
    schemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
    providerId: "yokohama-fishing-piers",
    facilityId: "yokohama-honmoku",
    sourceRecordId: "last-post:honmoku-2026-07-02",
    sourceUrl: "https://yokohama-fishingpiers.jp/honmoku/fishing-history",
    sourceRunId: "fixed-run:2026-07",
    observationDate: "2026-07-02",
    publishedAt: "2026-07-02T08:00:00.000Z",
    collectedAt: COLLECTED_AT,
    visitorCount: 200,
    operatingStatus: "operating",
    reportCompleteness: "complete",
    species: [speciesRow("japanese-seabass", 12)],
    ...overrides
  };
}

function speciesRow(speciesId, catchCount, overrides = {}) {
  const presenceState = catchCount === null ? "unknown" : catchCount === 0 ? "absent" : "present";
  return {
    speciesId,
    sourceLabels: speciesId === "japanese-seabass" ? ["スズキ", "フッコ", "セイゴ", "シーバス"] : [speciesId],
    catchCount,
    presenceState,
    minSizeCm: catchCount && catchCount > 0 ? 40 : null,
    maxSizeCm: catchCount && catchCount > 0 ? 65 : null,
    areaLabels: [],
    completeness: catchCount === null ? "incomplete" : "complete",
    aliasCoverage: catchCount === null ? "unknown" : "sufficient",
    ...overrides
  };
}

async function materializeFixtures() {
  const fixtures = [
    reportInput({
      observationDate: "2026-07-01",
      sourceRecordId: "last-post:honmoku-2026-07-01",
      visitorCount: 180,
      species: [speciesRow("japanese-seabass", 0), speciesRow("konoshiro", 30)]
    }),
    reportInput(),
    reportInput({
      collectedAt: "2026-08-17T04:00:00.000Z",
      visitorCount: 200,
      species: [speciesRow("japanese-seabass", 14)]
    }),
    reportInput({
      facilityId: "yokohama-daikoku",
      sourceRecordId: "last-post:daikoku-2026-07-03",
      observationDate: "2026-07-03",
      visitorCount: 300,
      species: [speciesRow("japanese-seabass", 120)]
    }),
    reportInput({
      facilityId: "yokohama-isogo",
      sourceRecordId: "last-post:isogo-2026-07-03",
      observationDate: "2026-07-03",
      visitorCount: 100,
      species: [speciesRow("japanese-seabass", 0)]
    }),
    reportInput({
      sourceRecordId: "last-post:honmoku-2026-07-04",
      observationDate: "2026-07-04",
      visitorCount: 0,
      operatingStatus: "closed",
      reportCompleteness: "complete",
      species: [speciesRow("japanese-seabass", null)]
    }),
    reportInput({
      sourceRecordId: "last-post:honmoku-2026-07-05",
      observationDate: "2026-07-05",
      publishedAt: null,
      visitorCount: null,
      reportCompleteness: "incomplete",
      species: [speciesRow("japanese-seabass", null)]
    })
  ];
  return Promise.all(fixtures.map((fixture, index) => materializeFixedNodeDailyReport(
    fixture,
    `2026-08-17T${String(5 + index).padStart(2, "0")}:00:00.000Z`
  )));
}

function runSqliteRoundTrip(materialized) {
  const script = String.raw`
import json
import sqlite3
import sys
from pathlib import Path

rows = json.load(sys.stdin)
conn = sqlite3.connect(":memory:")
conn.execute("PRAGMA foreign_keys = ON")
for path in sorted(Path("workers/wanoku-intel-worker/migrations").glob("*.sql")):
    conn.executescript(path.read_text(encoding="utf-8"))

run_ids = sorted({row["sourceRunId"] for row in rows})
for run_id in run_ids:
    conn.execute("""
      INSERT INTO source_runs
        (id, provider, requested_at, completed_at, status, model_version, raw_hash, normalized_schema_version, node_id)
      VALUES (?, 'yokohama-fishing-piers', '2026-08-17T03:00:00.000Z', '2026-08-17T03:00:01.000Z', 'ok', 'fixed-node-fixture.v1', NULL, 'wanoku-fixed-node-observation.v1', NULL)
    """, (run_id,))

report_sql = """INSERT INTO fixed_node_daily_reports (
  report_id, version_key, identity_key, semantic_hash, facility_id, provider_id, observation_date,
  source_record_id, source_run_id, published_at, collected_at, stored_at, visitor_count,
  operating_status, report_completeness, normalized_schema_version, source_url, payload_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""
species_sql = """INSERT INTO fixed_node_species_observations (
  observation_id, report_id, facility_id, observation_date, species_id, source_labels_json,
  catch_count, presence_state, min_size_cm, max_size_cm, area_labels_json, completeness, alias_coverage
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""

for row in rows:
    conn.execute(report_sql, (
      row["reportId"], row["versionKey"], row["identityKey"], row["semanticHash"], row["facilityId"],
      row["providerId"], row["observationDate"], row["sourceRecordId"], row["sourceRunId"],
      row["publishedAt"], row["collectedAt"], row["storedAt"], row["visitorCount"],
      row["operatingStatus"], row["reportCompleteness"], row["normalizedSchemaVersion"],
      row["sourceUrl"], row["payloadJson"]
    ))
    for species in row["species"]:
        conn.execute(species_sql, (
          species["observationId"], species["reportId"], species["facilityId"], species["observationDate"],
          species["speciesId"], species["sourceLabelsJson"], species["catchCount"], species["presenceState"],
          species["minSizeCm"], species["maxSizeCm"], species["areaLabelsJson"], species["completeness"],
          species["aliasCoverage"]
        ))

duplicate_rejected = False
try:
    row = rows[0]
    conn.execute(report_sql, (
      row["reportId"], row["versionKey"], row["identityKey"], row["semanticHash"], row["facilityId"],
      row["providerId"], row["observationDate"], row["sourceRecordId"], row["sourceRunId"],
      row["publishedAt"], row["collectedAt"], row["storedAt"], row["visitorCount"],
      row["operatingStatus"], row["reportCompleteness"], row["normalizedSchemaVersion"], row["sourceUrl"], row["payloadJson"]
    ))
except sqlite3.IntegrityError:
    duplicate_rejected = True

invalid_closed_zero_rejected = False
zero_trigger_message = ""
closed = next(row for row in rows if row["operatingStatus"] == "closed")
try:
    conn.execute(species_sql, (
      "invalid-closed-zero", closed["reportId"], closed["facilityId"], closed["observationDate"], "haze", "[]",
      0, "absent", None, None, "[]", "complete", "sufficient"
    ))
except sqlite3.IntegrityError as error:
    invalid_closed_zero_rejected = True
    zero_trigger_message = str(error)

incomplete = next(row for row in rows if row["reportCompleteness"] == "incomplete")
operating = rows[0]

def species_insert_rejected(values):
    try:
        conn.execute(species_sql, values)
        return False
    except sqlite3.IntegrityError:
        return True

invalid_incomplete_zero_rejected = species_insert_rejected((
  "invalid-incomplete-zero", incomplete["reportId"], incomplete["facilityId"], incomplete["observationDate"], "bora", "[]",
  0, "absent", None, None, "[]", "complete", "sufficient"
))
invalid_alias_zero_rejected = species_insert_rejected((
  "invalid-alias-zero", operating["reportId"], operating["facilityId"], operating["observationDate"], "sardine", "[]",
  0, "absent", None, None, "[]", "complete", "insufficient"
))
invalid_unknown_numeric_rejected = species_insert_rejected((
  "invalid-unknown-numeric", operating["reportId"], operating["facilityId"], operating["observationDate"], "sappa", "[]",
  1, "unknown", None, None, "[]", "complete", "sufficient"
))
invalid_positive_zero_rejected = species_insert_rejected((
  "invalid-positive-zero", operating["reportId"], operating["facilityId"], operating["observationDate"], "aji", "[]",
  0, "present", None, None, "[]", "complete", "sufficient"
))
orphan_species_rejected = species_insert_rejected((
  "orphan-species", "missing-report", operating["facilityId"], operating["observationDate"], "saba", "[]",
  None, "unknown", None, None, "[]", "incomplete", "unknown"
))

def report_insert_rejected(values):
    try:
        conn.execute(report_sql, values)
        return False
    except sqlite3.IntegrityError:
        return True

base_report_values = (
  "orphan-report", "orphan-version", "orphan-identity", "0" * 64, operating["facilityId"], operating["providerId"],
  "2026-07-06", "orphan-source", operating["sourceRunId"], None, operating["collectedAt"], operating["storedAt"],
  None, "unknown", "unknown", operating["normalizedSchemaVersion"], None, operating["payloadJson"]
)
orphan_report_facility_rejected = report_insert_rejected(
  base_report_values[:4] + ("missing-facility",) + base_report_values[5:]
)
orphan_report_source_run_rejected = report_insert_rejected(
  base_report_values[:8] + ("missing-source-run",) + base_report_values[9:]
)
referenced_delete_rejected = False
try:
    conn.execute("DELETE FROM source_runs WHERE id = ?", (operating["sourceRunId"],))
except sqlite3.IntegrityError:
    referenced_delete_rejected = True

conn.execute("""INSERT INTO observation_spatial_references
  (spatial_ref_id, reference_kind, source_registry_version)
  VALUES ('ARA-0', 'river-segment', 'wanoku-river-canal-observability-audit.v1')""")
conn.execute("""INSERT INTO hydro_coastal_station_spatial_mappings
  (provider_id, station_id, spatial_ref_id, mapping_method, valid_from, valid_to, provenance_json)
  VALUES ('mlit-river', 'fixture-station', 'ARA-0', 'hydrological', '2026-01-01T00:00:00.000Z', NULL, '{}')""")

foreign_key_actions = []
for table in ["fixed_coastal_facilities", "fixed_node_daily_reports", "fixed_node_species_observations", "hydro_coastal_station_spatial_mappings"]:
    for fk in conn.execute(f"PRAGMA foreign_key_list({table})"):
        foreign_key_actions.append({"table": table, "onUpdate": fk[5], "onDelete": fk[6]})

conn.execute("""INSERT INTO hydro_coastal_source_runs
  (id, provider_id, requested_at, completed_at, status, normalized_schema_version, run_json)
  VALUES ('hydro-fixture', 'mlit-river', '2026-07-02T00:00:00.000Z', '2026-07-02T00:01:00.000Z', 'ok', 'wanoku-hydro-coastal-observation.v1', '{}')""")
conn.execute("""INSERT INTO hydro_coastal_observations
  (version_key, identity_key, source_run_id, provider_id, station_id, metric, observed_at, collected_at,
   forecast_issued_at, value, unit, status, provisional, vertical_datum_json, normalized_schema_version, normalized_json)
  VALUES ('hydro-version', 'hydro-identity', 'hydro-fixture', 'mlit-river', 'fixture-station', 'river-discharge',
   '2026-07-02T00:00:00.000Z', '2026-07-02T00:01:00.000Z', NULL, 45, 'm3/s', 'observed', 0, NULL,
   'wanoku-hydro-coastal-observation.v1', '{}')""")

latest = """
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY identity_key ORDER BY collected_at DESC, version_key DESC) AS rn
  FROM fixed_node_daily_reports
)
SELECT * FROM ranked WHERE rn = 1
"""
latest_count = conn.execute(f"SELECT COUNT(*) FROM ({latest})").fetchone()[0]
revision_identity = next(row["identityKey"] for row in rows if row["sourceRecordId"] == "last-post:honmoku-2026-07-02")

def as_of_catch(knowledge_at):
    return conn.execute("""
      SELECT s.catch_count
      FROM fixed_node_daily_reports r
      JOIN fixed_node_species_observations s ON s.report_id = r.report_id
      WHERE r.identity_key = ? AND r.collected_at <= ? AND s.species_id = 'japanese-seabass'
      ORDER BY r.collected_at DESC, r.version_key DESC
      LIMIT 1
    """, (revision_identity, knowledge_at)).fetchone()[0]

as_of_before_revision_catch = as_of_catch("2026-08-17T03:30:00.000Z")
as_of_after_revision_catch = as_of_catch("2026-08-17T04:30:00.000Z")
as_of_published_null_included = conn.execute("""
  SELECT COUNT(*) FROM fixed_node_daily_reports
  WHERE source_record_id = 'last-post:honmoku-2026-07-05'
    AND published_at IS NULL
    AND collected_at <= '2026-08-17T05:00:00.000Z'
""").fetchone()[0] == 1

def explain(sql, params=()):
    return " | ".join(str(row[3]) for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params))

explain_results = {
  "identityAsOf": explain(
    "SELECT * FROM fixed_node_daily_reports WHERE identity_key = ? AND collected_at <= ? ORDER BY collected_at DESC, version_key DESC LIMIT 1",
    (revision_identity, "2026-08-17T04:30:00.000Z")
  ),
  "facilityDate": explain(
    "SELECT * FROM fixed_node_daily_reports WHERE facility_id = ? AND observation_date BETWEEN ? AND ?",
    ("yokohama-honmoku", "2026-07-01", "2026-07-31")
  ),
  "sourceRecord": explain(
    "SELECT * FROM fixed_node_daily_reports WHERE provider_id = ? AND source_record_id = ?",
    ("yokohama-fishing-piers", "last-post:honmoku-2026-07-02")
  ),
  "speciesDate": explain(
    "SELECT * FROM fixed_node_species_observations WHERE species_id = ? AND observation_date BETWEEN ? AND ?",
    ("japanese-seabass", "2026-07-01", "2026-07-31")
  ),
  "facilitySpeciesDate": explain(
    "SELECT * FROM fixed_node_species_observations WHERE facility_id = ? AND species_id = ? AND observation_date BETWEEN ? AND ?",
    ("yokohama-honmoku", "japanese-seabass", "2026-07-01", "2026-07-31")
  ),
  "stationSpatial": explain(
    "SELECT * FROM hydro_coastal_station_spatial_mappings WHERE spatial_ref_id = ? AND provider_id = ? AND station_id = ?",
    ("ARA-0", "mlit-river", "fixture-station")
  )
}
honmoku_rate = conn.execute(f"""
  SELECT ROUND(s.catch_count * 100.0 / r.visitor_count, 4)
  FROM ({latest}) r JOIN fixed_node_species_observations s ON s.report_id = r.report_id
  WHERE r.source_record_id = 'last-post:honmoku-2026-07-02' AND s.species_id = 'japanese-seabass'
""").fetchone()[0]
presence_rate = conn.execute(f"""
  SELECT AVG(CASE WHEN s.presence_state = 'present' THEN 1.0 ELSE 0.0 END)
  FROM ({latest}) r JOIN fixed_node_species_observations s ON s.report_id = r.report_id
  WHERE r.operating_status = 'operating' AND r.report_completeness = 'complete'
    AND s.species_id = 'japanese-seabass' AND s.presence_state IN ('present', 'absent')
""").fetchone()[0]
bait_leads = conn.execute(f"""
  SELECT COUNT(*)
  FROM ({latest}) bait_report
  JOIN fixed_node_species_observations bait ON bait.report_id = bait_report.report_id AND bait.species_id = 'konoshiro' AND bait.catch_count > 0
  JOIN ({latest}) fish_report ON fish_report.facility_id = bait_report.facility_id
    AND julianday(fish_report.observation_date) - julianday(bait_report.observation_date) BETWEEN 1 AND 3
  JOIN fixed_node_species_observations fish ON fish.report_id = fish_report.report_id
    AND fish.species_id = 'japanese-seabass' AND fish.catch_count > 0
""").fetchone()[0]
hydro_join = conn.execute(f"""
  SELECT COUNT(*) FROM ({latest}) r
  JOIN hydro_coastal_observations h ON substr(h.observed_at, 1, 10) = r.observation_date
""").fetchone()[0]
rolling_rows = conn.execute(f"""
  SELECT COUNT(*) FROM (
    SELECT AVG(s.catch_count) OVER (
      PARTITION BY r.facility_id ORDER BY r.observation_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
    ) AS rolling_baseline
    FROM ({latest}) r JOIN fixed_node_species_observations s ON s.report_id = r.report_id
    WHERE s.species_id = 'japanese-seabass' AND s.catch_count IS NOT NULL
  )
""").fetchone()[0]
seasonal_rows = conn.execute(f"""
  SELECT COUNT(*) FROM (
    SELECT r.facility_id, substr(r.observation_date, 6, 2) AS month,
      s.catch_count - AVG(s.catch_count) OVER (PARTITION BY r.facility_id, substr(r.observation_date, 6, 2)) AS anomaly
    FROM ({latest}) r JOIN fixed_node_species_observations s ON s.report_id = r.report_id
    WHERE s.species_id = 'japanese-seabass' AND s.catch_count IS NOT NULL
  )
""").fetchone()[0]

def pair_for(source_record_id):
    return list(conn.execute(f"""
      SELECT s.catch_count, s.presence_state
      FROM ({latest}) r JOIN fixed_node_species_observations s ON s.report_id = r.report_id
      WHERE r.source_record_id = ? AND s.species_id = 'japanese-seabass'
    """, (source_record_id,)).fetchone())

output = {
  "tables": [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")],
  "facilityCount": conn.execute("SELECT COUNT(*) FROM fixed_coastal_facilities").fetchone()[0],
  "reportCount": conn.execute("SELECT COUNT(*) FROM fixed_node_daily_reports").fetchone()[0],
  "latestLogicalReportCount": latest_count,
  "speciesObservationCount": conn.execute("SELECT COUNT(*) FROM fixed_node_species_observations").fetchone()[0],
  "honmokuLatestCatchPer100Visitors": honmoku_rate,
  "daikokuLargeCatch": pair_for("last-post:daikoku-2026-07-03")[0],
  "isogoExplicitZero": pair_for("last-post:isogo-2026-07-03"),
  "closedUnknown": pair_for("last-post:honmoku-2026-07-04"),
  "incompleteUnknown": pair_for("last-post:honmoku-2026-07-05"),
  "konoshiroCatch": conn.execute("SELECT catch_count FROM fixed_node_species_observations WHERE species_id='konoshiro'").fetchone()[0],
  "completeOperatingPresenceRate": presence_rate,
  "baitLeadPairs": bait_leads,
  "hydroDateJoinCount": hydro_join,
  "rollingBaselineRows": rolling_rows,
  "seasonalAnomalyRows": seasonal_rows,
  "duplicateRejected": duplicate_rejected,
  "invalidClosedZeroRejected": invalid_closed_zero_rejected,
  "invalidIncompleteZeroRejected": invalid_incomplete_zero_rejected,
  "invalidAliasZeroRejected": invalid_alias_zero_rejected,
  "invalidUnknownNumericRejected": invalid_unknown_numeric_rejected,
  "invalidPositiveZeroRejected": invalid_positive_zero_rejected,
  "zeroTriggerMessage": zero_trigger_message,
  "orphanSpeciesRejected": orphan_species_rejected,
  "orphanReportFacilityRejected": orphan_report_facility_rejected,
  "orphanReportSourceRunRejected": orphan_report_source_run_rejected,
  "referencedDeleteRejected": referenced_delete_rejected,
  "foreignKeyActions": foreign_key_actions,
  "asOfBeforeRevisionCatch": as_of_before_revision_catch,
  "asOfAfterRevisionCatch": as_of_after_revision_catch,
  "asOfPublishedNullIncluded": as_of_published_null_included,
  "explain": explain_results
}
print(json.dumps(output))
`;
  const result = spawnSync("python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(materialized)
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runPopulatedMigrationCompatibility() {
  const script = String.raw`
import json
import sqlite3
from pathlib import Path

conn = sqlite3.connect(":memory:")
conn.execute("PRAGMA foreign_keys = ON")
migration_dir = Path("workers/wanoku-intel-worker/migrations")
for path in sorted(migration_dir.glob("000[1-5]_*.sql")):
    conn.executescript(path.read_text(encoding="utf-8"))

conn.execute("""INSERT INTO hydro_coastal_source_runs
  (id, provider_id, requested_at, completed_at, status, normalized_schema_version, run_json)
  VALUES ('existing-hydro-run', 'jma-tide-prediction', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'ok', 'wanoku-hydro-coastal-observation.v1', '{}')""")
conn.execute("""INSERT INTO hydro_coastal_observations
  (version_key, identity_key, source_run_id, provider_id, station_id, metric, observed_at, collected_at,
   forecast_issued_at, value, unit, status, provisional, vertical_datum_json, normalized_schema_version, normalized_json)
  VALUES ('existing-hydro-version', 'existing-hydro-identity', 'existing-hydro-run', 'jma-tide-prediction', 'TK',
   'predicted-tide-level', '2026-01-01T00:00:00.000Z', '2025-02-21T06:30:00.000Z',
   '2025-02-21T06:21:31.000Z', 120, 'cm', 'predicted', 0, NULL, 'wanoku-hydro-coastal-observation.v1', '{}')""")
conn.execute("""INSERT INTO seabass_prediction_snapshots
  (id, schema_version, species_id, node_id, knowledge_at, target_at, lead_hours, decision_action,
   payload_hash, payload_json, stored_at, environment_state_schema_version, habitat_state_schema_version,
   seabass_state_schema_version, decision_schema_version)
  VALUES ('existing-prediction', 'wanoku-seabass-prediction-snapshot.v1', 'japanese-seabass', 'makuhari-shallow-01',
   '2026-08-15T03:00:00.000Z', '2026-08-15T06:00:00.000Z', 3, 'CONSIDER',
   'prediction-hash', '{}', '2026-08-15T03:00:01.000Z', 'wanoku-environment-state.v1',
   'wanoku-habitat-state.v1', 'wanoku-seabass-state.v1', 'wanoku-seabass-decision.v1')""")
conn.execute("""INSERT INTO seabass_external_evidence
  (id, payload_hash, schema_version, species_id, source_identity, provider_id, source_class, source_record_id,
   event_start_at, event_end_at, published_at, collected_at, stored_at, mapped_node_id, evidence_type,
   presence_support, catch_outcome, payload_json)
  VALUES ('existing-evidence', 'evidence-hash', 'wanoku-seabass-external-evidence.v1.1', 'japanese-seabass',
   '["fixture","record",null]', 'fixture', 'official-report', 'record', '2026-07-01T00:00:00.000Z', NULL,
   NULL, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:01.000Z', NULL, 'catch', 'positive', 'positive', '{}')""")

def counts():
    return {
      "hydro": conn.execute("SELECT COUNT(*) FROM hydro_coastal_observations").fetchone()[0],
      "prediction": conn.execute("SELECT COUNT(*) FROM seabass_prediction_snapshots").fetchone()[0],
      "evidence": conn.execute("SELECT COUNT(*) FROM seabass_external_evidence").fetchone()[0]
    }

before_counts = counts()
before_objects = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
conn.executescript((migration_dir / "0006_unified_observation_schema.sql").read_text(encoding="utf-8"))
after_counts = counts()
after_objects = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
print(json.dumps({
  "beforeCounts": before_counts,
  "afterCounts": after_counts,
  "missingExistingObjects": sorted(before_objects - after_objects),
  "newFacilityCount": conn.execute("SELECT COUNT(*) FROM fixed_coastal_facilities").fetchone()[0],
  "foreignKeyViolations": [list(row) for row in conn.execute("PRAGMA foreign_key_check")]
}))
`;
  const result = spawnSync("python", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

class FixedNodeD1 {
  constructor() {
    this.reportRows = [];
    this.speciesRows = [];
    this.prepared = [];
    this.writeStatements = [];
    this.batchCalls = 0;
  }

  prepare(sql) {
    const statement = { sql, params: [] };
    this.prepared.push(statement);
    return {
      bind: (...params) => {
        statement.params = params;
        return {
          all: async () => this.#all(statement),
          _statement: statement
        };
      }
    };
  }

  async batch(boundStatements) {
    this.batchCalls += 1;
    const pendingReports = [...this.reportRows];
    const pendingSpecies = [...this.speciesRows];
    for (const bound of boundStatements) {
      const statement = bound._statement;
      if (statement.sql.startsWith("INSERT INTO fixed_node_daily_reports")) {
        const row = reportRow(statement.params);
        if (pendingReports.some((entry) => entry.report_id === row.report_id || entry.version_key === row.version_key)) {
          throw new Error("D1_CONSTRAINT");
        }
        pendingReports.push(row);
      } else if (statement.sql.startsWith("INSERT INTO fixed_node_species_observations")) {
        const row = speciesObservationRow(statement.params);
        if (pendingSpecies.some((entry) => entry.observation_id === row.observation_id)) throw new Error("D1_CONSTRAINT");
        pendingSpecies.push(row);
      } else {
        throw new Error("unexpected D1 write");
      }
    }
    this.writeStatements.push(...boundStatements.map((bound) => bound._statement));
    this.reportRows = pendingReports;
    this.speciesRows = pendingSpecies;
    return boundStatements.map(() => ({ success: true }));
  }

  async #all(statement) {
    if (statement.sql.includes("FROM fixed_node_daily_reports")) {
      const [reportId, versionKey] = statement.params;
      return { results: this.reportRows.filter((row) => row.report_id === reportId || row.version_key === versionKey).slice(0, 2) };
    }
    if (statement.sql.includes("FROM fixed_node_species_observations")) {
      return {
        results: this.speciesRows
          .filter((row) => row.report_id === statement.params[0])
          .sort((left, right) => left.species_id.localeCompare(right.species_id))
      };
    }
    return { results: [] };
  }
}

function reportRow(params) {
  const keys = [
    "report_id", "version_key", "identity_key", "semantic_hash", "facility_id", "provider_id",
    "observation_date", "source_record_id", "source_run_id", "published_at", "collected_at", "stored_at",
    "visitor_count", "operating_status", "report_completeness", "normalized_schema_version", "source_url", "payload_json"
  ];
  return Object.fromEntries(keys.map((key, index) => [key, params[index]]));
}

function speciesObservationRow(params) {
  const keys = [
    "observation_id", "report_id", "facility_id", "observation_date", "species_id", "source_labels_json",
    "catch_count", "presence_state", "min_size_cm", "max_size_cm", "area_labels_json", "completeness", "alias_coverage"
  ];
  return Object.fromEntries(keys.map((key, index) => [key, params[index]]));
}
