import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";
import {
  PredictionSnapshotIntegrityError,
  SEABASS_PREDICTION_SNAPSHOT_SCHEMA_VERSION,
  buildSeabassPredictionSnapshotPayload,
  canonicalPredictionSnapshotJson,
  hashPredictionSnapshotPayload,
  materializeSeabassPredictionSnapshot,
  persistSeabassPredictionSnapshot,
  predictionSnapshotId,
  readSeabassPredictionSnapshot
} from "./prediction-snapshot.js";

const MIGRATION_0004 = readFileSync(
  new URL("../migrations/0004_seabass_prediction_snapshots.sql", import.meta.url),
  "utf8"
);
const node = TOKYO_BAY_ENVIRONMENT_NODES.find((item) => item.id === "makuhari-shallow-01");
const KNOWLEDGE_AT = "2026-08-15T00:00:00.000Z";
const TARGET_AT = "2026-08-15T03:00:00.000Z";
const STORED_AT = "2026-08-15T03:00:01.000Z";
const ADMIN_SECRET = "test-secret";

describe("Immutable Prediction Snapshot v1 canonical payload", () => {
  it("canonicalizes object key order while preserving array order and null", async () => {
    const payload = samplePayload();
    const reordered = reverseObjectKeys(payload);
    const first = await hashPredictionSnapshotPayload(payload);
    const second = await hashPredictionSnapshotPayload(reordered);

    expect(first.payloadJson).toBe(second.payloadJson);
    expect(first.payloadHash).toBe(second.payloadHash);

    const reorderedArray = structuredClone(payload);
    reorderedArray.decision.constraints.reverse();
    await expect(hashPredictionSnapshotPayload(reorderedArray)).resolves.not.toMatchObject({
      payloadHash: first.payloadHash
    });
    expect(canonicalPredictionSnapshotJson({ value: null })).not.toBe(canonicalPredictionSnapshotJson({}));
  });

  it("creates the same lowercase SHA-256 and content-addressed ID for the same payload", async () => {
    const first = await hashPredictionSnapshotPayload(samplePayload());
    const second = await hashPredictionSnapshotPayload(samplePayload());

    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toEqual(second);
    expect(first.snapshotId).toBe(`wanoku-seabass-prediction:${first.payloadHash}`);
    expect(predictionSnapshotId(first.payloadHash)).toBe(first.snapshotId);
  });

  it("keeps storedAt outside the canonical payload, hash, and snapshot ID", async () => {
    const payload = samplePayload();
    const first = await materializeSeabassPredictionSnapshot(payload, STORED_AT);
    const second = await materializeSeabassPredictionSnapshot(payload, "2026-08-15T03:00:02.000Z");

    expect(first.payloadHash).toBe(second.payloadHash);
    expect(first.id).toBe(second.id);
    expect(first.payloadJson).toBe(second.payloadJson);
    expect(first.storedAt).not.toBe(second.storedAt);
    expect(first.payloadJson).not.toContain("storedAt");
  });

  it("copies temporal values, schema/rule versions, decision details, and quality", () => {
    const payload = samplePayload();

    expect(payload).toMatchObject({
      schemaVersion: SEABASS_PREDICTION_SNAPSHOT_SCHEMA_VERSION,
      species: { id: "japanese-seabass" },
      nodeId: node.id,
      knowledgeAt: KNOWLEDGE_AT,
      targetAt: TARGET_AT,
      leadHours: 3,
      environment: {
        tide: { phase: "falling" },
        atmosphere: { windSpeedMps: 5.08 },
        marine: { waveHeightM: 0.6 }
      },
      provenance: {
        environmentStateSchemaVersion: "wanoku-environment-state.v1",
        habitatStateSchemaVersion: "wanoku-habitat-state.v1",
        seabassStateSchemaVersion: "wanoku-seabass-state.v1",
        decisionSchemaVersion: "wanoku-seabass-decision.v1",
        ruleVersions: {
          habitat: "wanoku-habitat-state-rules.v1",
          seabass: "wanoku-seabass-state-rules.v1",
          decision: "wanoku-seabass-decision-rules.v1"
        }
      }
    });
    expect(payload.decision.drivers).toHaveLength(3);
    expect(payload.decision.constraints).toContain("direct-fish-evidence-absent");
    expect(payload.seabass.quality.directFishEvidenceAbsent).toBe(true);
    expect(payload.decision.quality.directFishEvidenceAbsent).toBe(true);
    expect(payload).not.toHaveProperty("source");
    expect(payload).not.toHaveProperty("dbConfigured");
    expect(payload).not.toHaveProperty("readDiagnostics");
  });
});

describe("Immutable Prediction Snapshot v1 migration", () => {
  it("adds one dedicated immutable table and two query indexes without destructive SQL", () => {
    expect(MIGRATION_0004).toContain("CREATE TABLE IF NOT EXISTS seabass_prediction_snapshots");
    expect(MIGRATION_0004).toContain("payload_hash TEXT NOT NULL UNIQUE");
    expect(MIGRATION_0004).toContain("idx_seabass_prediction_snapshots_node_target");
    expect(MIGRATION_0004).toContain("idx_seabass_prediction_snapshots_knowledge");
    expect(MIGRATION_0004.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(MIGRATION_0004).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/i);
    expect(MIGRATION_0004).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(MIGRATION_0004).not.toMatch(/\bINSERT\s+OR\s+REPLACE\b/i);
    expect(MIGRATION_0004).not.toMatch(/\bREPLACE\s+INTO\b/i);
  });

  it("applies in local SQLite with the expected columns and indexes", () => {
    const script = String.raw`
import json
import sqlite3
from pathlib import Path

sql = Path("workers/wanoku-intel-worker/migrations/0004_seabass_prediction_snapshots.sql").read_text(encoding="utf-8")
conn = sqlite3.connect(":memory:")
conn.executescript(sql)
columns = [row[1] for row in conn.execute("PRAGMA table_info(seabass_prediction_snapshots)")]
indexes = [row[1] for row in conn.execute("PRAGMA index_list(seabass_prediction_snapshots)")]
print(json.dumps({"columns": columns, "indexes": indexes}))
`;
    const result = spawnSync("python", ["-c", script], { cwd: process.cwd(), encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const schema = JSON.parse(result.stdout);

    expect(schema.columns).toEqual([
      "id",
      "schema_version",
      "species_id",
      "node_id",
      "knowledge_at",
      "target_at",
      "lead_hours",
      "decision_action",
      "payload_hash",
      "payload_json",
      "stored_at",
      "environment_state_schema_version",
      "habitat_state_schema_version",
      "seabass_state_schema_version",
      "decision_schema_version"
    ]);
    expect(schema.indexes).toEqual(expect.arrayContaining([
      "idx_seabass_prediction_snapshots_node_target",
      "idx_seabass_prediction_snapshots_knowledge"
    ]));
  });
});

describe("Immutable Prediction Snapshot v1 repository", () => {
  it("plain-inserts once and treats an exact retry as idempotent", async () => {
    const db = new SnapshotD1({ environmentRows: [] });
    const first = await persistSeabassPredictionSnapshot(db, {
      snapshot: samplePayload(),
      storedAt: STORED_AT
    });
    const second = await persistSeabassPredictionSnapshot(db, {
      snapshot: samplePayload(),
      storedAt: "2026-08-15T03:00:02.000Z"
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.storedAt).toBe(STORED_AT);
    expect(db.snapshotRows).toHaveLength(1);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("fails integrity verification when the same hash row has different payload", async () => {
    const db = new SnapshotD1({ environmentRows: [] });
    const first = await persistSeabassPredictionSnapshot(db, {
      snapshot: samplePayload(),
      storedAt: STORED_AT
    });
    db.snapshotRows[0].payload_json = db.snapshotRows[0].payload_json.replace("CONSIDER", "PRIORITIZE");

    await expect(persistSeabassPredictionSnapshot(db, {
      snapshot: samplePayload(),
      storedAt: "2026-08-15T03:00:02.000Z"
    })).rejects.toBeInstanceOf(PredictionSnapshotIntegrityError);
    expect(db.writeStatements).toHaveLength(1);
    expect(first.snapshotId).toBe(db.snapshotRows[0].id);
  });

  it("stores changed content at the same logical times as a separate snapshot", async () => {
    const db = new SnapshotD1({ environmentRows: [] });
    const original = samplePayload();
    const changed = structuredClone(original);
    changed.decision.decision.meaning = "changed-content";
    const first = await persistSeabassPredictionSnapshot(db, { snapshot: original, storedAt: STORED_AT });
    const second = await persistSeabassPredictionSnapshot(db, {
      snapshot: changed,
      storedAt: "2026-08-15T03:00:02.000Z"
    });

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(db.snapshotRows).toHaveLength(2);
    expect(db.writeStatements).toHaveLength(2);
  });

  it("never generates UPDATE, REPLACE, or overwrite UPSERT SQL", async () => {
    const db = new SnapshotD1({ environmentRows: [] });
    await persistSeabassPredictionSnapshot(db, { snapshot: samplePayload(), storedAt: STORED_AT });
    const sql = db.prepared.map((entry) => entry.sql).join("\n");

    expect(sql).toMatch(/INSERT INTO seabass_prediction_snapshots/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bREPLACE\b/i);
    expect(sql).not.toMatch(/\bUPSERT\b|ON\s+CONFLICT\s+.+DO\s+UPDATE/i);
  });

  it("reads and hash-verifies the stored canonical payload", async () => {
    const db = new SnapshotD1({ environmentRows: [] });
    const created = await persistSeabassPredictionSnapshot(db, {
      snapshot: samplePayload(),
      storedAt: STORED_AT
    });
    const read = await readSeabassPredictionSnapshot(db, created.snapshotId);

    expect(read).toMatchObject({
      found: true,
      snapshotId: created.snapshotId,
      payloadHash: created.payloadHash,
      storedAt: STORED_AT,
      snapshot: samplePayload()
    });
  });
});

describe("Immutable Prediction Snapshot v1 API", () => {
  it("requires admin auth before body reads or prediction/D1 work", async () => {
    const db = new SnapshotD1();
    const request = createRequest();
    const bodySpy = vi.spyOn(request, "text");
    const response = await worker.fetch(request, {
      WANOKU_ADMIN_SECRET: ADMIN_SECRET,
      WANOKU_INTEL_D1: db
    });

    expect(response.status).toBe(403);
    expect(bodySpy).not.toHaveBeenCalled();
    expect(db.prepared).toHaveLength(0);
    expect(db.writeStatements).toHaveLength(0);
  });

  it.each([
    ["invalid node", { nodeId: "missing-node" }, "invalid_node_id"],
    ["invalid knowledgeAt", { knowledgeAt: "2026-08-15" }, "invalid_knowledge_at"],
    ["invalid targetAt", { targetAt: "2026-08-15" }, "invalid_target_at"],
    ["knowledge after target", { knowledgeAt: TARGET_AT, targetAt: KNOWLEDGE_AT }, "knowledge_after_target"]
  ])("rejects %s before any write", async (_case, overrides, error) => {
    const db = new SnapshotD1();
    const response = await worker.fetch(createRequest({ ...validCreateBody(), ...overrides }, true), {
      WANOKU_ADMIN_SECRET: ADMIN_SECRET,
      WANOKU_INTEL_D1: db
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(error);
    expect(db.writeStatements).toHaveLength(0);
  });

  it("creates a Makuhari CONSIDER snapshot with one D1 write and no internal HTTP", async () => {
    const db = new SnapshotD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("internal HTTP is not allowed"));
    try {
      const response = await worker.fetch(createRequest(validCreateBody(), true), {
        WANOKU_ADMIN_SECRET: ADMIN_SECRET,
        WANOKU_INTEL_D1: db
      });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.created).toBe(true);
      expect(body.snapshot.schemaVersion).toBe(SEABASS_PREDICTION_SNAPSHOT_SCHEMA_VERSION);
      expect(body.snapshot.decision.decision.action).toBe("CONSIDER");
      expect(body.snapshot.seabass.quality.directFishEvidenceAbsent).toBe(true);
      expect(body.snapshot.knowledgeAt).toBe(KNOWLEDGE_AT);
      expect(body.snapshot.targetAt).toBe(TARGET_AT);
      expect(body.snapshot.provenance.ruleVersions).toEqual({
        habitat: "wanoku-habitat-state-rules.v1",
        seabass: "wanoku-seabass-state-rules.v1",
        decision: "wanoku-seabass-decision-rules.v1"
      });
      expect(db.writeStatements).toHaveLength(1);
      expect(db.writeStatements[0].sql).toMatch(/^INSERT INTO seabass_prediction_snapshots/i);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns created=false on exact retry without a second INSERT", async () => {
    const db = new SnapshotD1();
    const env = { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db };
    const first = await worker.fetch(createRequest(validCreateBody(), true), env);
    const second = await worker.fetch(createRequest(validCreateBody(), true), env);
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.created).toBe(true);
    expect(second.status).toBe(200);
    expect(secondBody.created).toBe(false);
    expect(secondBody.snapshotId).toBe(firstBody.snapshotId);
    expect(secondBody.storedAt).toBe(firstBody.storedAt);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("GET returns the stored payload without rerunning prediction", async () => {
    const db = new SnapshotD1();
    const env = { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db };
    const createdResponse = await worker.fetch(createRequest(validCreateBody(), true), env);
    const created = await createdResponse.json();
    const statementStart = db.prepared.length;
    const response = await worker.fetch(new Request(
      `https://worker.example/predictions/seabass/snapshots/${encodeURIComponent(created.snapshotId)}`
    ), env);
    const body = await response.json();
    const readStatements = db.prepared.slice(statementStart);

    expect(response.status).toBe(200);
    expect(body.snapshot).toEqual(created.snapshot);
    expect(body.payloadHash).toBe(created.payloadHash);
    expect(readStatements).toHaveLength(1);
    expect(readStatements[0].sql).toContain("FROM seabass_prediction_snapshots");
    expect(readStatements[0].sql).not.toMatch(/environmental_snapshots|hydro_coastal_observations/);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("returns 404 for a missing snapshot", async () => {
    const db = new SnapshotD1();
    const missingId = `wanoku-seabass-prediction:${"0".repeat(64)}`;
    const response = await worker.fetch(new Request(
      `https://worker.example/predictions/seabass/snapshots/${missingId}`
    ), { WANOKU_INTEL_D1: db });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("prediction_snapshot_not_found");
  });

  it("returns an integrity error for corrupted stored payload without repairing it", async () => {
    const db = new SnapshotD1();
    const env = { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db };
    const createdResponse = await worker.fetch(createRequest(validCreateBody(), true), env);
    const created = await createdResponse.json();
    db.snapshotRows[0].payload_json = db.snapshotRows[0].payload_json.replace("CONSIDER", "PRIORITIZE");
    const writeCount = db.writeStatements.length;

    const response = await worker.fetch(new Request(
      `https://worker.example/predictions/seabass/snapshots/${created.snapshotId}`
    ), env);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("prediction_snapshot_integrity_error");
    expect(db.writeStatements).toHaveLength(writeCount);
  });

  it("keeps preview and existing state/decision endpoints compatible", async () => {
    const preview = await worker.fetch(new Request(
      `https://worker.example/species/seabass/prediction-preview?nodeId=${node.id}&knowledgeAt=${KNOWLEDGE_AT}&targetAt=${TARGET_AT}`
    ), {});
    const previewBody = await preview.json();
    expect(preview.status).toBe(200);
    expect(previewBody.schemaVersion).toBe("wanoku-seabass-prediction-preview.v1");

    for (const path of ["/environment/state", "/habitat/state", "/species/seabass/state", "/species/seabass/decision"]) {
      const response = await worker.fetch(new Request(
        `https://worker.example${path}?nodeId=${node.id}&at=${TARGET_AT}`
      ), {});
      expect(response.status).toBe(200);
    }
  });
});

function samplePayload() {
  return buildSeabassPredictionSnapshotPayload(sampleArtifacts());
}

function sampleArtifacts() {
  const quality = {
    inputOverallConfidence: 0.8,
    staleInputs: [],
    missingInputs: ["tide.levelCm"],
    unknownDerivedComponents: ["directionalExposure"],
    directFishEvidenceAbsent: true
  };
  const axis = (state, input) => ({
    state,
    meaning: `${input}-meaning`,
    drivers: [{ input, value: state, effect: state, reason: `${input}-reason` }],
    constraints: []
  });
  const preview = {
    schemaVersion: "wanoku-seabass-prediction-preview.v1",
    species: { id: "japanese-seabass" },
    nodeId: node.id,
    knowledgeAt: KNOWLEDGE_AT,
    targetAt: TARGET_AT,
    leadHours: 3,
    decision: { action: "CONSIDER", meaning: "candidate" },
    axes: { presence: "supportive", activation: "neutral", shoreCatchability: "unknown" },
    environmentSummary: {
      tide: { levelCm: 39, slopeCmPerHour: -24, phase: "falling", stationId: "CB", observedAt: TARGET_AT },
      atmosphere: { windSpeedMps: 5.08, windDirectionDeg: 180, precipitationMm: 0, pressureHpa: 1008, airTemperatureC: 27 },
      marine: { waterTemperatureC: 24.6, waveHeightM: 0.6, currentSpeedMps: 0.3 }
    },
    habitatSummary: {
      context: { waterBodyType: "bay", habitatTypes: ["shallow", "tidal-flat"] },
      hydrodynamics: { flowEnergy: "strong", exchangeState: "active", waterLevelState: "unknown" },
      exposure: { windState: "moderate", waveState: "unknown", currentState: "unknown", directionalExposure: "unknown" },
      freshwater: { influence: "unknown" },
      disturbance: { state: "energetic" }
    },
    quality: { sourceAgeAtKnowledge: { atmosphereHours: 0, marineHours: 0, tideHours: 3 } },
    provenance: {
      environmentStateSchemaVersion: "wanoku-environment-state.v1",
      habitatStateSchemaVersion: "wanoku-habitat-state.v1",
      seabassStateSchemaVersion: "wanoku-seabass-state.v1",
      decisionSchemaVersion: "wanoku-seabass-decision.v1",
      ruleVersions: {
        habitat: "wanoku-habitat-state-rules.v1",
        seabass: "wanoku-seabass-state-rules.v1",
        decision: "wanoku-seabass-decision-rules.v1"
      }
    },
    diagnostics: {
      environmentalErrors: [],
      environmentalWarnings: [],
      hydroCoastalErrors: [],
      hydroCoastalWarnings: [],
      habitatUnknownStateReasons: [{ field: "directionalExposure", reasons: ["unsupported-direction-convention"] }],
      seabassUnknownAxisReasons: [{ field: "shoreCatchability.state", reasons: ["directional-exposure-unknown"] }],
      decisionRule: "E",
      decisionIntegrityFailures: []
    }
  };
  const habitatState = { quality: { inputOverallConfidence: 0.8, inputStaleComponents: [], inputMissingComponents: [], unknownStateFields: [] } };
  const seabassState = {
    presence: axis("supportive", "habitat"),
    activation: axis("neutral", "flow"),
    shoreCatchability: axis("unknown", "exposure"),
    quality
  };
  const decision = {
    decision: preview.decision,
    axes: preview.axes,
    drivers: [
      { axis: "presence", state: "supportive", effect: "supports-priority" },
      { axis: "activation", state: "neutral", effect: "allows-consideration" },
      { axis: "shoreCatchability", state: "unknown", effect: "prevents-prioritize" }
    ],
    constraints: ["direct-fish-evidence-absent", "access-not-evaluated"],
    quality
  };
  return { preview, habitatState, seabassState, decision };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

function validCreateBody() {
  return { nodeId: node.id, knowledgeAt: KNOWLEDGE_AT, targetAt: TARGET_AT };
}

function createRequest(body = validCreateBody(), authorized = false) {
  return new Request("https://worker.example/admin/predictions/seabass/snapshots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${ADMIN_SECRET}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function productionEnvironmentRows() {
  return [
    environmentSnapshotRow("weather", {
      source: "open-meteo-weather",
      windSpeed: 5.08,
      windDirection: 180,
      pressure: 1008,
      precipitation: 0,
      airTemperature: 27
    }),
    environmentSnapshotRow("marine", {
      source: "open-meteo-marine",
      seaSurfaceTemperature: 24.6,
      waveHeight: 0.6,
      wavePeriod: 5.5,
      waveDirection: 120,
      oceanCurrentVelocity: 0.3,
      oceanCurrentDirection: 95,
      seaLevelHeightMsl: 0.18
    })
  ];
}

function environmentSnapshotRow(snapshotKey, values) {
  const snapshot = {
    nodeId: node.id,
    observedAt: TARGET_AT,
    collectedAt: KNOWLEDGE_AT,
    forecastIssuedAt: null,
    latitude: node.latitude,
    longitude: node.longitude,
    model: "production-like-fixture",
    confidence: 0.9,
    freshness: 1,
    missingFields: [],
    ...values
  };
  return {
    snapshot_key: snapshotKey,
    normalized_json: JSON.stringify(snapshot),
    collected_at: snapshot.collectedAt,
    forecast_issued_at: snapshot.forecastIssuedAt,
    created_at: snapshot.collectedAt
  };
}

class SnapshotD1 {
  constructor({ environmentRows = productionEnvironmentRows(), snapshotRows = [] } = {}) {
    this.environmentRows = environmentRows;
    this.snapshotRows = snapshotRows;
    this.prepared = [];
    this.writeStatements = [];
  }

  prepare(sql) {
    const db = this;
    const prepared = { sql, params: [] };
    db.prepared.push(prepared);
    return {
      bind(...params) {
        prepared.params = params;
        return {
          async all() {
            if (sql.includes("FROM environmental_snapshots")) return { results: db.environmentRows };
            if (sql.includes("FROM hydro_coastal_observations")) return { results: [] };
            if (sql.includes("FROM seabass_prediction_snapshots")) {
              const [id, hash] = params;
              return {
                results: db.snapshotRows.filter((row) => row.id === id || row.payload_hash === hash).slice(0, 2)
              };
            }
            return { results: [] };
          },
          async first() {
            if (!sql.includes("FROM seabass_prediction_snapshots")) return null;
            return db.snapshotRows.find((row) => row.id === params[0]) ?? null;
          },
          async run() {
            if (!/^INSERT INTO seabass_prediction_snapshots/i.test(sql)) {
              throw new Error("unexpected D1 write");
            }
            const row = snapshotRowFromParams(params);
            if (db.snapshotRows.some((item) => item.id === row.id || item.payload_hash === row.payload_hash)) {
              throw new Error("D1_CONSTRAINT");
            }
            db.writeStatements.push(prepared);
            db.snapshotRows.push(row);
            return { success: true };
          }
        };
      }
    };
  }
}

function snapshotRowFromParams(params) {
  const [
    id,
    schemaVersion,
    speciesId,
    nodeId,
    knowledgeAt,
    targetAt,
    leadHours,
    decisionAction,
    payloadHash,
    payloadJson,
    storedAt,
    environmentStateSchemaVersion,
    habitatStateSchemaVersion,
    seabassStateSchemaVersion,
    decisionSchemaVersion
  ] = params;
  return {
    id,
    schema_version: schemaVersion,
    species_id: speciesId,
    node_id: nodeId,
    knowledge_at: knowledgeAt,
    target_at: targetAt,
    lead_hours: leadHours,
    decision_action: decisionAction,
    payload_hash: payloadHash,
    payload_json: payloadJson,
    stored_at: storedAt,
    environment_state_schema_version: environmentStateSchemaVersion,
    habitat_state_schema_version: habitatStateSchemaVersion,
    seabass_state_schema_version: seabassStateSchemaVersion,
    decision_schema_version: decisionSchemaVersion
  };
}
