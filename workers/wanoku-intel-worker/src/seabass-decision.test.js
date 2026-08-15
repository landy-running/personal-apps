import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const node = TOKYO_BAY_ENVIRONMENT_NODES[0];
const asOf = "2026-07-11T15:00:00.000Z";

describe("wanoku intel worker seabass decision endpoint", () => {
  it("rejects an invalid nodeId", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/species/seabass/decision?nodeId=missing-node&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_node_id");
  });

  it("rejects a non-canonical at parameter", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/species/seabass/decision?nodeId=${node.id}&at=2026-07-11`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_at");
  });

  it("returns a Decision v1 from the existing state pipeline", async () => {
    const response = await worker.fetch(
      new Request(`https://worker.example/species/seabass/decision?nodeId=${node.id}&at=${asOf}`),
      {}
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      schemaVersion: "wanoku-seabass-decision.v1",
      species: { id: "japanese-seabass" },
      nodeId: node.id,
      asOf,
      decision: { action: "CONSIDER" },
      axes: {
        presence: "supportive",
        activation: "neutral",
        shoreCatchability: "unknown"
      },
      source: "fixture",
      dbConfigured: false,
      provenance: {
        seabassStateSchemaVersion: "wanoku-seabass-state.v1",
        ruleVersion: "wanoku-seabass-decision-rules.v1"
      }
    });
  });

  it("uses one read-only Environment State D1 path", async () => {
    const db = new ReadOnlyD1();
    const response = await worker.fetch(
      new Request(`https://worker.example/species/seabass/decision?nodeId=${node.id}&at=${asOf}`),
      { WANOKU_INTEL_D1: db }
    );

    expect(response.status).toBe(200);
    expect(db.runCalled).toBe(false);
    expect(db.batchCalled).toBe(false);
    expect(db.boundStatements.map((statement) => statement.sql).join("\n")).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP)\b/i);
    expect(db.boundStatements.filter((statement) => statement.sql.includes("FROM environmental_snapshots"))).toHaveLength(1);
  });

  it("does not make an internal HTTP request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("internal HTTP is not allowed"));
    try {
      const response = await worker.fetch(
        new Request(`https://worker.example/species/seabass/decision?nodeId=${node.id}&at=${asOf}`),
        {}
      );

      expect(response.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lists the read-only decision endpoint in health", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {});
    const body = await response.json();

    expect(body.endpoints).toContain("/species/seabass/decision");
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
