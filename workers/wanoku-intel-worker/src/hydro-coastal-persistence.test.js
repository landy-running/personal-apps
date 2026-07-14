import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HYDRO_COASTAL_SCHEMA_VERSION,
  hydroCoastalObservationVersionKey,
  selectHydroCoastalObservationsAsOf
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";
import { buildHydroCoastalFeatureSet } from "../../../packages/wanoku-core/src/hydro-coastal-features.ts";
import { createInitialHabitatGraph } from "../../../packages/wanoku-core/src/habitat-fixtures.ts";
import {
  JMA_TIDE_PREDICTION_LINE_LENGTH,
  JMA_TIDE_PREDICTION_STATIONS_2026,
  getJmaTidePredictionProviderDefinition,
  parseJmaTidePredictionFixedWidth
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import { buildJmaTidePredictionStationNodeMappings2026 } from "../../../packages/wanoku-core/src/jma-tide-prediction-mappings.ts";
import {
  D1_MAX_BOUND_PARAMS_PER_STATEMENT,
  canonicalHydroCoastalJson,
  chunkRowsForHydroCoastalBoundLimit,
  hydrateHydroCoastalObservationRow,
  prepareHydroCoastalPersistenceBatch,
  readHydroCoastalHistory,
  readHydroCoastalObservationsAsOf,
  writeHydroCoastalBatch
} from "./hydro-coastal-persistence.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const MIGRATION_0003 = readFileSync(
  new URL("../migrations/0003_hydro_coastal_persistence.sql", import.meta.url),
  "utf8"
);
const REQUESTED_AT = "2025-12-31T00:00:00.000Z";
const COLLECTED_AT = "2025-12-31T01:00:00.000Z";
const LATER_COLLECTED_AT = "2025-12-31T02:00:00.000Z";
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const NEXT_OBSERVED_AT = "2026-01-01T01:00:00.000Z";
const FORECAST_ISSUED_AT = "2025-12-31T00:00:00.000Z";

describe("Hydro-Coastal Persistence Spine migration", () => {
  it("adds dedicated hydro-coastal tables without altering existing environmental tables", () => {
    expect(MIGRATION_0003).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(MIGRATION_0003).not.toMatch(/\bDROP\s+(TABLE|INDEX)\b/i);
    expect(MIGRATION_0003).toContain("CREATE TABLE IF NOT EXISTS hydro_coastal_source_runs");
    expect(MIGRATION_0003).toContain("CREATE TABLE IF NOT EXISTS hydro_coastal_observations");
    expect(MIGRATION_0003).toContain("version_key TEXT NOT NULL UNIQUE");
    expect(MIGRATION_0003).toContain("status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed'))");
    expect(MIGRATION_0003).toContain("provisional INTEGER NOT NULL CHECK (provisional IN (0, 1))");
    expect(MIGRATION_0003).toContain("FOREIGN KEY (source_run_id) REFERENCES hydro_coastal_source_runs(id)");
    expect(MIGRATION_0003).toContain("idx_hydro_coastal_observations_identity_collected");
    expect(MIGRATION_0003).toContain("idx_hydro_coastal_observations_station_observed");
    expect(MIGRATION_0003).toContain("idx_hydro_coastal_source_runs_provider_requested");
  });
});

describe("Hydro-Coastal Persistence Spine repository", () => {
  it("canonicalizes JSON independent of object key order while preserving array order", () => {
    expect(canonicalHydroCoastalJson({ b: 2, a: 1 })).toBe(canonicalHydroCoastalJson({ a: 1, b: 2 }));
    expect(canonicalHydroCoastalJson({ a: [1, 2] })).not.toBe(canonicalHydroCoastalJson({ a: [2, 1] }));
    expect(canonicalHydroCoastalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalHydroCoastalJson({ a: [1, undefined, 2] })).toBe('{"a":[1,null,2]}');
    expect(() => canonicalHydroCoastalJson(undefined)).toThrow("top-level undefined");
    expect(() => canonicalHydroCoastalJson({ a: () => null })).toThrow("function cannot be serialized");
    expect(() => canonicalHydroCoastalJson({ a: Symbol("bad") })).toThrow("symbol cannot be serialized");
    expect(() => canonicalHydroCoastalJson({ a: 1n })).toThrow("bigint cannot be serialized");
    expect(() => canonicalHydroCoastalJson({ a: Number.NaN })).toThrow("non-finite number");
    expect(() => canonicalHydroCoastalJson({ a: Infinity })).toThrow("non-finite number");
  });

  it("prepares valid observations, exact duplicates, conflicts, revisions, and provider mismatches", () => {
    const base = observation();
    const duplicate = { ...base };
    const conflictBase = observation({ observedAt: NEXT_OBSERVED_AT, value: 130 });
    const conflicting = observation({ observedAt: NEXT_OBSERVED_AT, value: 222 });
    const revision = observation({ collectedAt: LATER_COLLECTED_AT, value: 111 });
    const invalid = { ...base, observedAt: "not-iso" };
    const mismatch = observation({ providerId: "jma-tide-observation" });
    const prepared = prepareHydroCoastalPersistenceBatch({
      sourceRun: sourceRun({ status: "partial" }),
      observations: [revision, mismatch, conflicting, duplicate, base, invalid, conflictBase]
    });

    expect(prepared.inputObservationCount).toBe(7);
    expect(prepared.duplicateCount).toBe(1);
    expect(prepared.conflictCount).toBe(2);
    expect(prepared.invalidCount).toBe(2);
    expect(prepared.observationRows).toHaveLength(2);
    expect(prepared.observationRows.map((row) => row.collectedAt)).toEqual([COLLECTED_AT, LATER_COLLECTED_AT]);
    expect(prepared.errors).toEqual(expect.arrayContaining([
      "observation 1: providerId does not match sourceRun.providerId.",
      "observation 5: observedAt must be canonical UTC ISO datetime.",
      `conflicting hydro-coastal observation in input: ${hydroCoastalObservationVersionKey(conflictBase)}`
    ]));
  });

  it("keeps same identity with different collectedAt as revisions", () => {
    const prepared = prepareHydroCoastalPersistenceBatch({
      sourceRun: sourceRun(),
      observations: [observation(), observation({ collectedAt: LATER_COLLECTED_AT, value: 110 })]
    });

    expect(prepared.errors).toEqual([]);
    expect(prepared.observationRows).toHaveLength(2);
    expect(new Set(prepared.observationRows.map((row) => row.identityKey)).size).toBe(1);
    expect(new Set(prepared.observationRows.map((row) => row.versionKey)).size).toBe(2);
  });

  it("writes source runs and observations idempotently while distinguishing source run conflicts", async () => {
    const db = new MockD1Database();
    const first = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [observation(), observation({ observedAt: NEXT_OBSERVED_AT, value: 120 })]
    });
    const second = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [observation(), observation({ observedAt: NEXT_OBSERVED_AT, value: 120 })]
    });
    const conflict = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ sourceName: "Different source" }),
      observations: [observation({ observedAt: "2026-01-01T02:00:00.000Z", value: 130 })]
    });

    expect(first).toMatchObject({ ok: true, insertedCount: 2, duplicateCount: 0, conflictCount: 0 });
    expect(second).toMatchObject({ ok: true, insertedCount: 0, duplicateCount: 2, conflictCount: 0 });
    expect(second.warnings).toEqual(expect.arrayContaining(["duplicate hydro-coastal source run ignored: run-1"]));
    expect(conflict.ok).toBe(false);
    expect(conflict.errors).toContain("source run conflict: run-1");
    expect(db.observations.size).toBe(2);
  });

  it("does not write ok runs with invalid observations, but partial runs write valid rows", async () => {
    const okDb = new MockD1Database();
    const partialDb = new MockD1Database();
    const invalid = { ...observation(), observedAt: "bad" };
    const okResult = await writeHydroCoastalBatch(okDb, {
      sourceRun: sourceRun({ id: "ok-run", status: "ok" }),
      observations: [observation(), invalid]
    });
    const partialResult = await writeHydroCoastalBatch(partialDb, {
      sourceRun: sourceRun({ id: "partial-run", status: "partial" }),
      observations: [observation(), invalid]
    });

    expect(okResult.ok).toBe(false);
    expect(okDb.sourceRuns.size).toBe(0);
    expect(okDb.observations.size).toBe(0);
    expect(partialResult.partial).toBe(true);
    expect(partialDb.sourceRuns.size).toBe(1);
    expect(partialDb.observations.size).toBe(1);
  });

  it("allows failed runs with zero observations and rejects failed runs with observations", async () => {
    const db = new MockD1Database();
    const failedOnly = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "failed-run", status: "failed", completedAt: null, errorCode: "download_failed" }),
      observations: []
    });
    const failedWithObservations = await writeHydroCoastalBatch(new MockD1Database(), {
      sourceRun: sourceRun({ id: "bad-failed-run", status: "failed" }),
      observations: [observation()]
    });

    expect(failedOnly.ok).toBe(true);
    expect(db.sourceRuns.has("failed-run")).toBe(true);
    expect(failedWithObservations.ok).toBe(false);
    expect(failedWithObservations.errors).toContain("failed source run must not include observations.");
  });

  it("does not write observations when source run metadata is invalid", async () => {
    const db = new MockD1Database();
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "invalid-source-run", providerId: "unknown-provider", status: "partial" }),
      observations: [observation()]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("sourceRun.providerId is invalid.");
    expect(db.sourceRuns.size).toBe(0);
    expect(db.observations.size).toBe(0);
  });

  it("requires db.batch and does not use a non-atomic fallback", async () => {
    const result = await writeHydroCoastalBatch(
      { prepare: (sql) => new MockD1Statement(new MockD1Database(), sql) },
      { sourceRun: sourceRun(), observations: [observation()] }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("D1 database batch() is required for atomic hydro-coastal writes.");
  });

  it("detects existing DB conflicts without overwriting rows", async () => {
    const db = new MockD1Database();
    await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [observation({ value: 100 })]
    });
    const originalJson = [...db.observations.values()][0].normalized_json;
    const conflict = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "run-2" }),
      observations: [observation({ value: 101 })]
    });

    expect(conflict.ok).toBe(false);
    expect(conflict.errors).toContain(`existing hydro-coastal observation conflict: ${hydroCoastalObservationVersionKey(observation())}`);
    expect([...db.observations.values()][0].normalized_json).toBe(originalJson);
  });

  it("rolls back source run and all observation chunks when an atomic batch statement fails", async () => {
    const db = new MockD1Database();
    const observations = Array.from({ length: 7 }, (_, index) => observation({
      observedAt: new Date(Date.parse(OBSERVED_AT) + index * 3600_000).toISOString(),
      value: index
    }));
    db.failOnObservationVersionKeys.add(hydroCoastalObservationVersionKey(observations[6]));
    const result = await writeHydroCoastalBatch(db, { sourceRun: sourceRun({ id: "atomic-fail" }), observations });

    expect(result.ok).toBe(false);
    expect(result.insertedCount).toBe(0);
    expect(db.sourceRuns.has("atomic-fail")).toBe(false);
    expect(db.observations.size).toBe(0);
  });

  it("reclassifies exact duplicate source run races and retries unsaved observations", async () => {
    const db = new MockD1Database();
    db.beforeBatch = (raceDb) => {
      raceDb.sourceRuns.set("race-run", sourceRunRowFromParams(sourceRunParams(sourceRun({ id: "race-run" }))));
    };
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "race-run" }),
      observations: [observation(), observation({ observedAt: NEXT_OBSERVED_AT, value: 120 })]
    });

    expect(result).toMatchObject({ ok: true, insertedCount: 2, duplicateCount: 0, conflictCount: 0 });
    expect(result.warnings).toContain("duplicate hydro-coastal source run after write race: race-run");
    expect(db.observations.size).toBe(2);
  });

  it("reclassifies source run conflict races without saving observations", async () => {
    const db = new MockD1Database();
    db.beforeBatch = (raceDb) => {
      raceDb.sourceRuns.set("race-conflict", sourceRunRowFromParams(sourceRunParams(sourceRun({ id: "race-conflict", sourceName: "Other" }))));
    };
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "race-conflict" }),
      observations: [observation()]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("source run conflict after write race: race-conflict");
    expect(db.observations.size).toBe(0);
  });

  it("classifies observation duplicate races with mutually exclusive counts", async () => {
    const db = new MockD1Database();
    const observations = Array.from({ length: 5 }, (_, index) => observation({
      observedAt: new Date(Date.parse(OBSERVED_AT) + index * 3600_000).toISOString(),
      value: index
    }));
    db.beforeBatch = (raceDb) => {
      raceDb.sourceRuns.set("race-dup", sourceRunRowFromParams(sourceRunParams(sourceRun({ id: "race-dup" }))));
      const row = observationRowFromObservation(observations[2], "race-dup");
      raceDb.observations.set(row.version_key, row);
    };
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "race-dup" }),
      observations
    });

    expect(result).toMatchObject({ ok: true, insertedCount: 4, duplicateCount: 1, conflictCount: 0 });
    expect(db.observations.size).toBe(5);
  });

  it("keeps status=ok atomic when an observation conflict race occurs", async () => {
    const db = new MockD1Database();
    const observations = Array.from({ length: 5 }, (_, index) => observation({
      observedAt: new Date(Date.parse(OBSERVED_AT) + index * 3600_000).toISOString(),
      value: index
    }));
    db.beforeBatch = (raceDb) => {
      raceDb.sourceRuns.set("race-conflict-ok", sourceRunRowFromParams(sourceRunParams(sourceRun({ id: "race-conflict-ok" }))));
      const row = observationRowFromObservation({ ...observations[1], value: 999 }, "race-conflict-ok");
      raceDb.observations.set(row.version_key, row);
    };
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "race-conflict-ok" }),
      observations
    });

    expect(result).toMatchObject({ ok: false, insertedCount: 0, conflictCount: 1, partial: false });
    expect(db.observations.size).toBe(1);
  });

  it("allows partial runs to save non-conflicting rows after an observation conflict race", async () => {
    const db = new MockD1Database();
    const observations = Array.from({ length: 5 }, (_, index) => observation({
      observedAt: new Date(Date.parse(OBSERVED_AT) + index * 3600_000).toISOString(),
      value: index
    }));
    db.beforeBatch = (raceDb) => {
      raceDb.sourceRuns.set("race-conflict-partial", sourceRunRowFromParams(sourceRunParams(sourceRun({ id: "race-conflict-partial", status: "partial" }))));
      const row = observationRowFromObservation({ ...observations[1], value: 999 }, "race-conflict-partial");
      raceDb.observations.set(row.version_key, row);
    };
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "race-conflict-partial", status: "partial" }),
      observations
    });

    expect(result).toMatchObject({ ok: false, partial: true, insertedCount: 4, conflictCount: 1 });
    expect(db.observations.size).toBe(5);
  });

  it("returns ok=true and partial=true for clean partial source runs", async () => {
    const db = new MockD1Database();
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "clean-partial", status: "partial" }),
      observations: [observation()]
    });

    expect(result).toMatchObject({ ok: true, partial: true, insertedCount: 1 });
  });

  it("returns a classification error after bounded unclassified write races", async () => {
    const db = new MockD1Database();
    db.failNextBatchCount = 3;
    const result = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({ id: "unclassified-race" }),
      observations: [observation()]
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("retry limit exceeded"))).toBe(true);
    expect(db.sourceRuns.size).toBe(0);
    expect(db.observations.size).toBe(0);
  });

  it("reads history with filters, ranges, deterministic order, and limits", async () => {
    const db = new MockD1Database();
    await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [
        observation({ stationId: "TK", observedAt: NEXT_OBSERVED_AT, value: 120 }),
        observation({ stationId: "CB", observedAt: OBSERVED_AT, value: 80 }),
        observation({ stationId: "TK", observedAt: OBSERVED_AT, value: 100 })
      ]
    });

    const tk = await readHydroCoastalHistory(db, {
      providerId: "jma-tide-prediction",
      stationId: "TK",
      metric: "predicted-tide-level",
      observedStart: OBSERVED_AT,
      observedEnd: "2026-01-01T02:00:00.000Z"
    });
    const limited = await readHydroCoastalHistory(db, { limit: 1 });
    const invalid = await readHydroCoastalHistory(db, { observedStart: "not-iso" });

    expect(tk.errors).toEqual([]);
    expect(tk.observations.map((item) => `${item.stationId}:${item.observedAt}`)).toEqual([
      `TK:${OBSERVED_AT}`,
      `TK:${NEXT_OBSERVED_AT}`
    ]);
    expect(limited.returnedObservationCount).toBe(1);
    expect(invalid.errors).toContain("observedStart must be canonical UTC ISO datetime.");
    expect(db.statements.every((statement) => statement.params.length <= D1_MAX_BOUND_PARAMS_PER_STATEMENT)).toBe(true);
  });

  it("reads as-of latest revisions without using created_at and matches core selection", async () => {
    const db = new MockD1Database();
    const observations = [
      observation({ value: 100 }),
      observation({ collectedAt: LATER_COLLECTED_AT, value: 110 }),
      observation({ observedAt: NEXT_OBSERVED_AT, value: 120 }),
      observation({ forecastIssuedAt: "2025-12-30T00:00:00.000Z", value: 90 })
    ];
    await writeHydroCoastalBatch(db, { sourceRun: sourceRun(), observations });

    const asOfEarly = await readHydroCoastalObservationsAsOf(db, {
      calculatedAt: "2025-12-31T01:30:00.000Z",
      observedStart: "2025-12-31T23:00:00.000Z",
      observedEnd: "2026-01-01T02:00:00.000Z"
    });
    const asOfLate = await readHydroCoastalObservationsAsOf(db, {
      calculatedAt: "2025-12-31T03:00:00.000Z",
      observedStart: "2025-12-31T23:00:00.000Z",
      observedEnd: "2026-01-01T02:00:00.000Z"
    });
    const parity = selectHydroCoastalObservationsAsOf(observations, "2025-12-31T03:00:00.000Z");

    expect(asOfEarly.observations.find((item) => item.observedAt === OBSERVED_AT && item.forecastIssuedAt === FORECAST_ISSUED_AT)?.value).toBe(100);
    expect(asOfLate.observations.find((item) => item.observedAt === OBSERVED_AT && item.forecastIssuedAt === FORECAST_ISSUED_AT)?.value).toBe(110);
    expect(asOfLate.observations.map(hydroCoastalObservationVersionKey).sort()).toEqual(parity.observations.map(hydroCoastalObservationVersionKey).sort());
  });

  it("excludes a corrupt latest as-of row without hiding an older healthy revision", async () => {
    const db = new MockD1Database();
    const older = observation({ value: 100 });
    const latest = observation({ collectedAt: LATER_COLLECTED_AT, value: 110 });
    await writeHydroCoastalBatch(db, { sourceRun: sourceRun(), observations: [older, latest] });
    const latestKey = hydroCoastalObservationVersionKey(latest);
    db.observations.set(latestKey, { ...db.observations.get(latestKey), normalized_json: "{bad" });

    const asOf = await readHydroCoastalObservationsAsOf(db, {
      calculatedAt: "2025-12-31T03:00:00.000Z",
      observedStart: "2025-12-31T23:00:00.000Z",
      observedEnd: "2026-01-01T01:00:00.000Z"
    });

    expect(asOf.errors).toContain("normalized_json is malformed.");
    expect(asOf.observations).toHaveLength(1);
    expect(asOf.observations[0].value).toBe(100);
  });

  it("hydrates rows safely and excludes corrupt rows during reads", async () => {
    const db = new MockD1Database();
    await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [observation()]
    });
    const validRow = [...db.observations.values()][0];
    db.observations.set("corrupt-json", { ...validRow, version_key: "corrupt-json", normalized_json: "{bad" });
    db.observations.set("mismatch", { ...validRow, version_key: "mismatch", normalized_json: validRow.normalized_json });

    expect(hydrateHydroCoastalObservationRow({ ...validRow, identity_key: "wrong" }).errors).toContain("identity_key does not match normalized_json.");
    const history = await readHydroCoastalHistory(db, {});

    expect(history.returnedObservationCount).toBe(1);
    expect(history.errors).toEqual(expect.arrayContaining([
      "normalized_json is malformed.",
      "version_key does not match normalized_json."
    ]));
    expect(history.observations[0].collectedAt).toBe(COLLECTED_AT);
  });

  it("rejects non-canonical normalized_json during hydration", async () => {
    const db = new MockD1Database();
    await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun(),
      observations: [observation()]
    });
    const validRow = [...db.observations.values()][0];
    const parsed = JSON.parse(validRow.normalized_json);
    const nonCanonicalJson = JSON.stringify({ stationId: parsed.stationId, schemaVersion: parsed.schemaVersion, ...parsed });

    const hydrated = hydrateHydroCoastalObservationRow({ ...validRow, normalized_json: nonCanonicalJson });

    expect(hydrated.observation).toBeNull();
    expect(hydrated.errors).toContain("normalized_json is not canonical.");
  });

  it("chunks writes below the 90 bound-parameter budget and handles empty batches", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ index }));
    expect(chunkRowsForHydroCoastalBoundLimit(rows, 16).map((chunk) => chunk.length)).toEqual([5, 5, 2]);

    const db = new MockD1Database();
    const many = Array.from({ length: 12 }, (_, index) => observation({
      observedAt: new Date(Date.parse(OBSERVED_AT) + index * 3600_000).toISOString(),
      value: index
    }));
    await writeHydroCoastalBatch(db, { sourceRun: sourceRun(), observations: many });
    const observationInsertStatements = db.statements.filter((statement) => statement.sql.includes("INTO hydro_coastal_observations"));
    expect(observationInsertStatements).toHaveLength(3);
    expect(observationInsertStatements.every((statement) => statement.sql.trim().startsWith("INSERT INTO"))).toBe(true);
    expect(db.statements.every((statement) => statement.params.length <= D1_MAX_BOUND_PARAMS_PER_STATEMENT)).toBe(true);

    const failed = await writeHydroCoastalBatch(new MockD1Database(), {
      sourceRun: sourceRun({ id: "failed-empty", status: "failed" }),
      observations: []
    });
    expect(failed.ok).toBe(true);
  });

  it("persists parsed JMA tide predictions and feeds Feature Bridge from as-of repository output", async () => {
    const db = new MockD1Database();
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-14T00:00:00.000Z");
    const parsed = parseJmaTidePredictionFixedWidth(
      ["TK", "CB", "KZ", "QS", "TT"].map((stationCode) => buildJmaLine({ stationCode })).join("\n"),
      {
        provider: getJmaTidePredictionProviderDefinition(),
        stations: JMA_TIDE_PREDICTION_STATIONS_2026,
        sourceYear: 2026,
        collectedAt: COLLECTED_AT,
        normalizedAt: COLLECTED_AT,
        forecastIssuedAt: FORECAST_ISSUED_AT,
        sourceUrl: "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/",
        sourceName: "Japan Meteorological Agency tide table",
        attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku."
      }
    );
    const write = await writeHydroCoastalBatch(db, {
      sourceRun: sourceRun({
        id: "jma-2026-sample",
        sourceFormatVersion: parsed.sourceFormatVersion,
        parserId: "wanoku-jma-tide-prediction-fixed-width",
        parserVersion: "1.0.0"
      }),
      observations: parsed.observations
    });
    const read = await readHydroCoastalObservationsAsOf(db, {
      calculatedAt: "2025-12-31T02:00:00.000Z",
      observedStart: "2025-12-31T15:00:00.000Z",
      observedEnd: "2026-01-01T15:00:00.000Z",
      providerId: "jma-tide-prediction",
      metric: "predicted-tide-level",
      limit: 200
    });
    const mappingResult = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: "2026-07-14T00:00:00.000Z"
    });
    const features = buildHydroCoastalFeatureSet({
      observations: read.observations,
      mappings: mappingResult.mappings,
      habitatGraph: graph,
      calculatedAt: "2025-12-31T02:00:00.000Z",
      targetAt: "2026-01-01T00:00:00.000Z"
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.observations).toHaveLength(120);
    expect(write).toMatchObject({ ok: true, insertedCount: 120 });
    expect(read.errors).toEqual([]);
    expect(read.returnedObservationCount).toBe(120);
    expect(features.errors).toEqual([]);
    expect(features.features).toHaveLength(12);
    expect(features.features.filter((feature) => feature.stationId !== null)).toHaveLength(5);
    expect(features.features.filter((feature) => feature.missingReasons.includes("no-active-mapping"))).toHaveLength(7);
  });
});

function sourceRun(overrides = {}) {
  return {
    id: "run-1",
    providerId: "jma-tide-prediction",
    requestedAt: REQUESTED_AT,
    completedAt: COLLECTED_AT,
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    rawHash: "raw-hash-1",
    sourceName: "JMA tide prediction fixture",
    sourceUrl: "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/",
    parserId: "test-parser",
    parserVersion: "1.0.0",
    sourceFormatVersion: "test-format",
    normalizedSchemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
    ...overrides
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
    providerId: "jma-tide-prediction",
    stationId: "TK",
    metric: "predicted-tide-level",
    observedAt: OBSERVED_AT,
    collectedAt: COLLECTED_AT,
    forecastIssuedAt: FORECAST_ISSUED_AT,
    value: 100,
    unit: "cm",
    status: "predicted",
    provisional: false,
    verticalDatum: {
      type: "tide-table-datum",
      stationSpecific: true,
      offsetToTpM: -1.141,
      description: "Synthetic test datum."
    },
    provenance: {
      sourceName: "Hydro-coastal persistence test",
      sourceKind: "synthetic-fixture",
      sourceTimestamp: OBSERVED_AT,
      sourceTimezone: "UTC",
      normalizedAt: COLLECTED_AT,
      notes: ["Synthetic test observation."]
    },
    ...overrides
  };
}

function buildJmaLine({ stationCode }) {
  const hourly = Array.from({ length: 24 }, (_, index) => formatLevel3(index + 10)).join("");
  const date = "26 1 1";
  const high = "9999999999999999999999999999";
  const low = "9999999999999999999999999999";
  const line = `${hourly}${date}${stationCode}${high}${low}`;
  expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
  return line;
}

function formatLevel3(value) {
  return String(value).padStart(3, " ");
}

class MockD1Database {
  constructor() {
    this.sourceRuns = new Map();
    this.observations = new Map();
    this.statements = [];
    this.beforeBatch = null;
    this.failNextBatchCount = 0;
    this.failOnObservationVersionKeys = new Set();
  }

  prepare(sql) {
    return new MockD1Statement(this, sql);
  }

  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      hook(this);
    }
    const sourceRunSnapshot = new Map(this.sourceRuns);
    const observationSnapshot = new Map(this.observations);
    try {
      if (this.failNextBatchCount > 0) {
        this.failNextBatchCount -= 1;
        throw new Error("Injected batch failure");
      }
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.sourceRuns = sourceRunSnapshot;
      this.observations = observationSnapshot;
      throw error;
    }
  }
}

class MockD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    this.db.statements.push({ sql: this.sql, params });
    return this;
  }

  async first() {
    if (this.sql.includes("FROM hydro_coastal_source_runs")) {
      return this.db.sourceRuns.get(this.params[0]) || null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE version_key IN")) {
      return {
        results: this.params
          .map((versionKey) => this.db.observations.get(versionKey))
          .filter(Boolean)
          .map((row) => ({ version_key: row.version_key, normalized_json: row.normalized_json }))
      };
    }
    if (this.sql.includes("FROM hydro_coastal_observations")) {
      return { results: queryObservationRows(this.db.observations, this.sql, this.params) };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("INTO hydro_coastal_source_runs")) {
      const row = sourceRunRowFromParams(this.params);
      if (this.db.sourceRuns.has(row.id)) throw new Error("UNIQUE constraint failed: hydro_coastal_source_runs.id");
      this.db.sourceRuns.set(row.id, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INTO hydro_coastal_observations")) {
      let changes = 0;
      for (let index = 0; index < this.params.length; index += 16) {
        const row = observationRowFromParams(this.params.slice(index, index + 16));
        if (this.db.failOnObservationVersionKeys.has(row.version_key)) {
          throw new Error(`Injected observation insert failure: ${row.version_key}`);
        }
        if (this.db.observations.has(row.version_key)) {
          throw new Error("UNIQUE constraint failed: hydro_coastal_observations.version_key");
        }
        this.db.observations.set(row.version_key, row);
        changes += 1;
      }
      return { meta: { changes } };
    }
    return { meta: { changes: 0 } };
  }
}

function queryObservationRows(observations, sql, params) {
  const isAsOf = sql.includes("collected_at <= ?");
  let index = 0;
  let rows = [...observations.values()];
  const whereConditions = extractFirstWhereConditions(sql);
  if (isAsOf) {
    const observedStart = params[index++];
    const observedEnd = params[index++];
    const calculatedAt = params[index++];
    rows = rows.filter((row) => row.observed_at >= observedStart && row.observed_at < observedEnd && row.collected_at <= calculatedAt);
    ({ rows, index } = applyOptionalFilters(rows, whereConditions, params, index));
  } else {
    ({ rows, index } = applyOptionalFilters(rows, whereConditions, params, index));
    if (whereConditions.has("observed_at >= ?")) {
      const value = params[index++];
      rows = rows.filter((row) => row.observed_at >= value);
    }
    if (whereConditions.has("observed_at < ?")) {
      const value = params[index++];
      rows = rows.filter((row) => row.observed_at < value);
    }
    if (whereConditions.has("collected_at >= ?")) {
      const value = params[index++];
      rows = rows.filter((row) => row.collected_at >= value);
    }
    if (whereConditions.has("collected_at < ?")) {
      const value = params[index++];
      rows = rows.filter((row) => row.collected_at < value);
    }
  }
  const limit = typeof params.at(-1) === "number" ? params.at(-1) : rows.length;
  return rows.sort(compareRows).slice(0, limit);
}

function applyOptionalFilters(rows, whereConditions, params, index) {
  if (whereConditions.has("provider_id = ?")) {
    const value = params[index++];
    rows = rows.filter((row) => row.provider_id === value);
  }
  if (whereConditions.has("station_id = ?")) {
    const value = params[index++];
    rows = rows.filter((row) => row.station_id === value);
  }
  if (whereConditions.has("metric = ?")) {
    const value = params[index++];
    rows = rows.filter((row) => row.metric === value);
  }
  if (whereConditions.has("forecast_issued_at = ?")) {
    const value = params[index++];
    rows = rows.filter((row) => row.forecast_issued_at === value);
  }
  return { rows, index };
}

function extractFirstWhereConditions(sql) {
  const whereIndex = sql.indexOf("WHERE ");
  if (whereIndex < 0) return new Set();
  const afterWhere = sql.slice(whereIndex + "WHERE ".length);
  const stops = ["\n    ORDER BY", "\n    )"]
    .map((marker) => afterWhere.indexOf(marker))
    .filter((index) => index >= 0);
  const stop = stops.length ? Math.min(...stops) : afterWhere.length;
  return new Set(afterWhere.slice(0, stop).split(/\s+AND\s+/).map((condition) => condition.trim()).filter(Boolean));
}

function compareRows(left, right) {
  return [
    left.observed_at.localeCompare(right.observed_at),
    left.provider_id.localeCompare(right.provider_id),
    left.station_id.localeCompare(right.station_id),
    left.metric.localeCompare(right.metric),
    String(left.forecast_issued_at || "").localeCompare(String(right.forecast_issued_at || "")),
    left.collected_at.localeCompare(right.collected_at),
    left.version_key.localeCompare(right.version_key)
  ].find((value) => value !== 0) || 0;
}

function sourceRunRowFromParams(params) {
  const [
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json
  ] = params;
  return {
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json,
    created_at: "2026-07-14T00:00:00.000Z"
  };
}

function sourceRunParams(run) {
  return [
    run.id,
    run.providerId,
    run.requestedAt,
    run.completedAt,
    run.status,
    run.httpStatus,
    run.errorCode,
    run.rawHash,
    run.sourceName,
    run.sourceUrl,
    run.parserId,
    run.parserVersion,
    run.sourceFormatVersion,
    run.normalizedSchemaVersion,
    canonicalHydroCoastalJson({
      id: run.id,
      providerId: run.providerId,
      requestedAt: run.requestedAt,
      completedAt: run.completedAt,
      status: run.status,
      httpStatus: run.httpStatus,
      errorCode: run.errorCode,
      rawHash: run.rawHash,
      sourceName: run.sourceName,
      sourceUrl: run.sourceUrl,
      parserId: run.parserId,
      parserVersion: run.parserVersion,
      sourceFormatVersion: run.sourceFormatVersion,
      normalizedSchemaVersion: run.normalizedSchemaVersion
    })
  ];
}

function observationRowFromObservation(item, sourceRunId) {
  const normalizedJson = canonicalHydroCoastalJson(item);
  return observationRowFromParams([
    hydroCoastalObservationVersionKey(item),
    `${item.providerId}|${item.stationId}|${item.metric}|${item.observedAt}|${item.forecastIssuedAt ?? "none"}`,
    sourceRunId,
    item.providerId,
    item.stationId,
    item.metric,
    item.observedAt,
    item.collectedAt,
    item.forecastIssuedAt,
    item.value,
    item.unit,
    item.status,
    item.provisional ? 1 : 0,
    item.verticalDatum == null ? null : canonicalHydroCoastalJson(item.verticalDatum),
    item.schemaVersion,
    normalizedJson
  ]);
}

function observationRowFromParams(params) {
  const [
    version_key,
    identity_key,
    source_run_id,
    provider_id,
    station_id,
    metric,
    observed_at,
    collected_at,
    forecast_issued_at,
    value,
    unit,
    status,
    provisional,
    vertical_datum_json,
    normalized_schema_version,
    normalized_json
  ] = params;
  return {
    id: 1,
    version_key,
    identity_key,
    source_run_id,
    provider_id,
    station_id,
    metric,
    observed_at,
    collected_at,
    forecast_issued_at,
    value,
    unit,
    status,
    provisional,
    vertical_datum_json,
    normalized_schema_version,
    normalized_json,
    created_at: "2099-01-01T00:00:00.000Z"
  };
}
