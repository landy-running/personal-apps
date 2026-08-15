import { describe, expect, it } from "vitest";
import worker from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const node = TOKYO_BAY_ENVIRONMENT_NODES[0];
const asOf = "2026-07-11T15:00:00.000Z";

describe("wanoku intel worker environment state endpoint", () => {
  it("rejects an invalid nodeId", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/environment/state?nodeId=missing-node&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_node_id");
  });

  it("rejects a non-canonical at parameter", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/environment/state?nodeId=${node.id}&at=2026-07-11`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_at");
  });

  it("returns Environment State v1 from fixture snapshots without D1", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/environment/state?nodeId=${node.id}&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: "wanoku-environment-state.v1",
      nodeId: node.id,
      asOf,
      source: "fixture",
      dbConfigured: false,
      tide: {
        phase: "unknown"
      }
    });
    expect(body.atmosphere.windSpeedMps).toBe(4);
    expect(body.freshness.missingComponents).toContain("tide.levelCm");
    expect(body.provenance.environmental.length).toBeGreaterThan(0);
  });

  it("uses only read-only D1 statements", async () => {
    const db = new ReadOnlyD1();
    const response = await worker.fetch(
      new Request(`https://worker.example/environment/state?nodeId=${node.id}&at=${asOf}`),
      { WANOKU_INTEL_D1: db }
    );

    expect(response.status).toBe(200);
    expect(db.runCalled).toBe(false);
    expect(db.batchCalled).toBe(false);
    expect(db.boundStatements.map((statement) => statement.sql).join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
  });

  it("applies the as-of cutoff before limiting environmental snapshots", async () => {
    const historicalRow = environmentSnapshotRow({
      snapshotKey: "historical-valid",
      observedAt: "2026-07-11T14:00:00.000Z",
      collectedAt: "2026-07-11T13:00:00.000Z",
      windSpeed: 6
    });
    const futureRevision = environmentSnapshotRow({
      snapshotKey: "future-revision",
      observedAt: "2026-07-11T14:00:00.000Z",
      collectedAt: "2026-07-11T16:00:00.000Z",
      windSpeed: 88
    });
    const futureObservedRows = Array.from({ length: 501 }, (_, index) => environmentSnapshotRow({
      snapshotKey: `future-observed-${index}`,
      observedAt: "2026-07-12T00:00:00.000Z",
      collectedAt: "2026-07-11T14:30:00.000Z",
      windSpeed: 99
    }));
    const tableRows = [historicalRow, futureRevision, ...futureObservedRows];
    const oldLimitedRows = [...tableRows].sort(compareEnvironmentRows).slice(0, 500);
    expect(oldLimitedRows.some((row) => row.snapshot_key === historicalRow.snapshot_key)).toBe(false);

    const db = new ReadOnlyD1({ environmentRows: tableRows });
    const response = await worker.fetch(
      new Request(`https://worker.example/environment/state?nodeId=${node.id}&at=${asOf}`),
      { WANOKU_INTEL_D1: db }
    );
    const body = await response.json();
    const snapshotStatement = db.boundStatements.find((statement) => (
      statement.sql.includes("FROM environmental_snapshots")
    ));

    expect(response.status).toBe(200);
    expect(snapshotStatement?.sql).toMatch(/observed_at\s*<=\s*\?/);
    expect(snapshotStatement?.sql).toMatch(/collected_at\s*<=\s*\?/);
    expect(snapshotStatement?.params).toEqual([node.id, asOf, asOf, 500]);
    expect(db.returnedEnvironmentRows.map((row) => row.snapshot_key)).toEqual(["historical-valid"]);
    expect(body.atmosphere.windSpeedMps).toBe(6);
    expect(body.freshness.missingComponents).not.toContain("atmosphere.windSpeedMps");
    expect(db.runCalled).toBe(false);
    expect(db.batchCalled).toBe(false);
  });

  it("lists the read-only environment state endpoint in health", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {});
    const body = await response.json();

    expect(body.endpoints).toContain("/environment/state");
  });
});

class ReadOnlyD1 {
  constructor({ environmentRows = [] } = {}) {
    this.boundStatements = [];
    this.runCalled = false;
    this.batchCalled = false;
    this.environmentRows = environmentRows;
    this.returnedEnvironmentRows = [];
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        db.boundStatements.push({ sql, params });
        return {
          async all() {
            if (sql.includes("FROM environmental_snapshots")) {
              const limit = params.at(-1);
              let rows = db.environmentRows.filter((row) => row.node_id === params[0]);
              if (/observed_at\s*<=\s*\?/.test(sql)) {
                rows = rows.filter((row) => row.observed_at <= params[1]);
              }
              if (/collected_at\s*<=\s*\?/.test(sql)) {
                rows = rows.filter((row) => row.collected_at <= params[2]);
              }
              db.returnedEnvironmentRows = rows.sort(compareEnvironmentRows).slice(0, limit);
              return { results: db.returnedEnvironmentRows };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            db.runCalled = true;
            throw new Error("read-only D1 fixture does not allow run()");
          }
        };
      }
    };
  }

  async batch() {
    this.batchCalled = true;
    throw new Error("read-only D1 fixture does not allow batch()");
  }
}

function environmentSnapshotRow({ snapshotKey, observedAt, collectedAt, windSpeed }) {
  return {
    snapshot_key: snapshotKey,
    node_id: node.id,
    observed_at: observedAt,
    collected_at: collectedAt,
    forecast_issued_at: null,
    created_at: collectedAt,
    normalized_json: JSON.stringify({
      snapshotKey,
      nodeId: node.id,
      observedAt,
      collectedAt,
      forecastIssuedAt: null,
      latitude: node.latitude,
      longitude: node.longitude,
      coordinateDistanceKm: 0.1,
      source: "open-meteo-weather",
      model: "test-fixture",
      confidence: 0.9,
      freshness: 1,
      missingFields: [],
      windSpeed,
      windDirection: 180,
      pressure: 1008,
      precipitation: 0.2,
      airTemperature: 26
    })
  };
}

function compareEnvironmentRows(left, right) {
  const leftVintage = left.collected_at || left.forecast_issued_at || left.created_at;
  const rightVintage = right.collected_at || right.forecast_issued_at || right.created_at;
  return rightVintage.localeCompare(leftVintage)
    || right.observed_at.localeCompare(left.observed_at)
    || right.created_at.localeCompare(left.created_at);
}
