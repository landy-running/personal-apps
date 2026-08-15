import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const node = TOKYO_BAY_ENVIRONMENT_NODES.find((item) => item.id === "makuhari-shallow-01");
const knowledgeAt = "2026-07-11T12:00:00.000Z";
const targetAt = "2026-07-11T15:00:00.000Z";

describe("wanoku intel worker prediction temporal preview", () => {
  it("rejects an invalid nodeId", async () => {
    const response = await worker.fetch(new Request(
      `https://worker.example/species/seabass/prediction-preview?nodeId=missing-node&knowledgeAt=${knowledgeAt}&targetAt=${targetAt}`
    ), {});
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_node_id");
  });

  it("is deterministic for the same node and temporal inputs", async () => {
    const first = await preview();
    const second = await preview();

    expect(await first.json()).toEqual(await second.json());
  });

  it("matches the existing Decision action and axes when knowledgeAt equals targetAt", async () => {
    const at = "2026-08-15T03:00:00.000Z";
    const [decisionResponse, previewResponse] = await Promise.all([
      worker.fetch(new Request(`https://worker.example/species/seabass/decision?nodeId=${node.id}&at=${at}`), {}),
      worker.fetch(new Request(`https://worker.example/species/seabass/prediction-preview?nodeId=${node.id}&knowledgeAt=${at}&targetAt=${at}`), {})
    ]);
    const decision = await decisionResponse.json();
    const temporalPreview = await previewResponse.json();

    expect(decision.decision.action).toBe("CONSIDER");
    expect(temporalPreview.decision).toEqual(decision.decision);
    expect(temporalPreview.axes).toEqual(decision.axes);
    expect(temporalPreview.leadHours).toBe(0);
  });

  it.each([
    ["knowledgeAt", "2026-07-11", targetAt, "invalid_knowledge_at"],
    ["targetAt", knowledgeAt, "2026-07-11", "invalid_target_at"],
    ["order", targetAt, knowledgeAt, "knowledge_after_target"]
  ])("rejects invalid temporal input: %s", async (_case, knowledge, target, error) => {
    const response = await worker.fetch(new Request(
      `https://worker.example/species/seabass/prediction-preview?nodeId=${node.id}&knowledgeAt=${knowledge}&targetAt=${target}`
    ), {});
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe(error);
  });

  it("returns a compact prediction preview with separate source age and lead", async () => {
    const response = await preview();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: "wanoku-seabass-prediction-preview.v1",
      species: { id: "japanese-seabass" },
      nodeId: node.id,
      knowledgeAt,
      targetAt,
      leadHours: 3,
      decision: { action: "CONSIDER" },
      axes: {
        presence: "supportive",
        activation: "neutral",
        shoreCatchability: "unknown"
      },
      quality: {
        sourceAgeAtKnowledge: {
          atmosphereHours: 3,
          marineHours: 3,
          tideHours: null
        }
      },
      provenance: {
        environmentStateSchemaVersion: "wanoku-environment-state.v1",
        habitatStateSchemaVersion: "wanoku-habitat-state.v1",
        seabassStateSchemaVersion: "wanoku-seabass-state.v1",
        decisionSchemaVersion: "wanoku-seabass-decision.v1"
      }
    });
    expect(body.environmentSummary.atmosphere.windSpeedMps).not.toBeNull();
    expect(body.environmentSummary.marine.waveHeightM).not.toBeNull();
  });

  it("keeps atmosphere source age isolated from newer marine metadata", async () => {
    const regressionKnowledgeAt = "2026-07-11T09:00:00.000Z";
    const regressionTargetAt = "2026-07-11T15:00:00.000Z";
    const weatherCollectedAt = "2026-07-11T08:00:00.000Z";
    const marineCollectedAt = regressionKnowledgeAt;
    const db = new ReadOnlyD1({
      environmentRows: [
        environmentSnapshotRow("weather-08", {
          observedAt: regressionTargetAt,
          collectedAt: weatherCollectedAt,
          forecastIssuedAt: weatherCollectedAt,
          source: "open-meteo-weather",
          windSpeed: 5,
          windDirection: 180,
          pressure: 1008,
          precipitation: 0.2,
          airTemperature: 26
        }),
        environmentSnapshotRow("marine-09", {
          observedAt: regressionTargetAt,
          collectedAt: marineCollectedAt,
          forecastIssuedAt: marineCollectedAt,
          source: "open-meteo-marine",
          seaSurfaceTemperature: 24.6,
          waveHeight: 0.7,
          wavePeriod: 5.5,
          waveDirection: 120,
          oceanCurrentVelocity: 0.4,
          oceanCurrentDirection: 95,
          seaLevelHeightMsl: 0.18
        })
      ]
    });
    const response = await worker.fetch(new Request(
      `https://worker.example/species/seabass/prediction-preview?nodeId=${node.id}&knowledgeAt=${regressionKnowledgeAt}&targetAt=${regressionTargetAt}`
    ), { WANOKU_INTEL_D1: db });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.environmentSummary.atmosphere.sourceCollectedAt).toBe(weatherCollectedAt);
    expect(body.environmentSummary.atmosphere.sourceProviderIds).toEqual(["open-meteo-weather"]);
    expect(body.environmentSummary.marine.sourceCollectedAt).toBe(marineCollectedAt);
    expect(body.environmentSummary.marine.sourceProviderIds).toEqual(["open-meteo-marine"]);
    expect(body.quality.sourceAgeAtKnowledge).toEqual({
      atmosphereHours: 1,
      marineHours: 0,
      tideHours: null
    });
    expect(body.leadHours).toBe(6);
  });

  it("keeps all four existing state and decision endpoints compatible", async () => {
    const at = "2026-08-15T03:00:00.000Z";
    const expectations = [
      ["/environment/state", "wanoku-environment-state.v1"],
      ["/habitat/state", "wanoku-habitat-state.v1"],
      ["/species/seabass/state", "wanoku-seabass-state.v1"],
      ["/species/seabass/decision", "wanoku-seabass-decision.v1"]
    ];

    for (const [path, schemaVersion] of expectations) {
      const response = await worker.fetch(new Request(`https://worker.example${path}?nodeId=${node.id}&at=${at}`), {});
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.schemaVersion).toBe(schemaVersion);
      expect(body.asOf).toBe(at);
      if (path.endsWith("/decision")) expect(body.decision.action).toBe("CONSIDER");
    }
  });

  it("uses one read-only environmental and hydro D1 path", async () => {
    const db = new ReadOnlyD1();
    const response = await preview({ WANOKU_INTEL_D1: db });
    const sql = db.boundStatements.map((statement) => statement.sql).join("\n");

    expect(response.status).toBe(200);
    expect(db.runCalled).toBe(false);
    expect(db.batchCalled).toBe(false);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
    expect(db.boundStatements.filter((statement) => statement.sql.includes("FROM environmental_snapshots"))).toHaveLength(1);
    expect(db.boundStatements.filter((statement) => statement.sql.includes("FROM hydro_coastal_observations"))).toHaveLength(1);
    const environmental = db.boundStatements.find((statement) => statement.sql.includes("FROM environmental_snapshots"));
    expect(environmental.params).toEqual([node.id, targetAt, knowledgeAt, knowledgeAt, 500]);
  });

  it("does not make an internal HTTP request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("internal HTTP is not allowed"));
    try {
      const response = await preview();
      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lists the prediction preview endpoint in health", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {});
    const body = await response.json();

    expect(body.endpoints).toContain("/species/seabass/prediction-preview");
  });
});

function preview(env = {}) {
  return worker.fetch(new Request(
    `https://worker.example/species/seabass/prediction-preview?nodeId=${node.id}&knowledgeAt=${knowledgeAt}&targetAt=${targetAt}`
  ), env);
}

function environmentSnapshotRow(snapshotKey, values) {
  const snapshot = {
    nodeId: node.id,
    latitude: node.latitude,
    longitude: node.longitude,
    model: "test-fixture",
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

class ReadOnlyD1 {
  constructor({ environmentRows = [] } = {}) {
    this.boundStatements = [];
    this.runCalled = false;
    this.batchCalled = false;
    this.environmentRows = environmentRows;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        db.boundStatements.push({ sql, params });
        return {
          async all() {
            if (sql.includes("FROM environmental_snapshots")) {
              return { results: db.environmentRows };
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
