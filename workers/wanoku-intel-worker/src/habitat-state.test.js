import { describe, expect, it } from "vitest";
import worker from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const node = TOKYO_BAY_ENVIRONMENT_NODES[0];
const asOf = "2026-07-11T15:00:00.000Z";

describe("wanoku intel worker habitat state endpoint", () => {
  it("rejects an invalid nodeId", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/habitat/state?nodeId=missing-node&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_node_id");
  });

  it("rejects a non-canonical at parameter", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/habitat/state?nodeId=${node.id}&at=2026-07-11`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_at");
  });

  it("returns Habitat State v1 through the existing Environment State read path", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/habitat/state?nodeId=${node.id}&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: "wanoku-habitat-state.v1",
      nodeId: node.id,
      asOf,
      source: "fixture",
      dbConfigured: false,
      context: {
        waterBodyType: "bay"
      },
      exposure: {
        windState: "moderate",
        directionalExposure: "unknown",
        waveHeightM: 0.4,
        waveState: "unknown",
        currentSpeedMps: 0.3,
        currentState: "unknown"
      }
    });
    expect(body.diagnostics.unknownStateReasons).toEqual(expect.arrayContaining([
      {
        field: "exposure.waveState",
        reasons: ["wave-classification-rule-undefined"]
      },
      {
        field: "exposure.currentState",
        reasons: ["current-classification-rule-undefined"]
      }
    ]));
  });

  it("uses only read-only D1 statements", async () => {
    const db = new ReadOnlyD1();
    const response = await worker.fetch(
      new Request(`https://worker.example/habitat/state?nodeId=${node.id}&at=${asOf}`),
      { WANOKU_INTEL_D1: db }
    );

    expect(response.status).toBe(200);
    expect(db.runCalled).toBe(false);
    expect(db.batchCalled).toBe(false);
    expect(db.boundStatements.map((statement) => statement.sql).join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
    expect(db.boundStatements.filter((statement) => statement.sql.includes("FROM environmental_snapshots"))).toHaveLength(1);
  });

  it("lists the read-only habitat state endpoint in health", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {});
    const body = await response.json();

    expect(body.endpoints).toContain("/habitat/state");
  });
});

class ReadOnlyD1 {
  constructor() {
    this.boundStatements = [];
    this.runCalled = false;
    this.batchCalled = false;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...params) {
        db.boundStatements.push({ sql, params });
        return {
          async all() {
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
