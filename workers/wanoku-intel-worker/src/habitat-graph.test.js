import { describe, expect, it } from "vitest";
import {
  calculateGraphSummary,
  validateHabitatGraph
} from "../../../packages/wanoku-core/src/habitat.ts";
import { buildEnvironmentalFeatureSet } from "../../../packages/wanoku-core/src/environment-features.ts";
import { createInitialHabitatGraph } from "../../../packages/wanoku-core/src/habitat-fixtures.ts";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const EXPECTED_NODE_IDS = [
  "tokyo-inner-bay-01",
  "sumida-arakawa-mouth-01",
  "tama-river-mouth-01",
  "keihin-canal-01",
  "makuhari-shallow-01",
  "funabashi-inner-01",
  "bay-center-north-01",
  "bay-center-south-01",
  "kisarazu-north-01",
  "futtsu-cape-01",
  "kanaya-uchibo-01",
  "tateyama-north-01"
];

describe("Wanoku habitat graph fixture from environmental nodes", () => {
  it("uses the 12 environment node ids without creating extra nodes", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-13T00:00:00.000Z");

    expect(graph.nodes.map((node) => node.id)).toEqual(EXPECTED_NODE_IDS);
    expect(new Set(graph.nodes.map((node) => node.id))).toEqual(new Set(TOKYO_BAY_ENVIRONMENT_NODES.map((node) => node.id)));
  });

  it("keeps habitat node coordinates identical to environment-nodes.js", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-13T00:00:00.000Z");
    const habitatById = new Map(graph.nodes.map((node) => [node.id, node]));

    for (const environmentNode of TOKYO_BAY_ENVIRONMENT_NODES) {
      const habitatNode = habitatById.get(environmentNode.id);
      expect(habitatNode?.latitude).toBe(environmentNode.latitude);
      expect(habitatNode?.longitude).toBe(environmentNode.longitude);
    }
  });

  it("has no validation errors and remains one connected provisional graph", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-13T00:00:00.000Z");
    const validation = validateHabitatGraph(graph);
    const summary = calculateGraphSummary(graph);

    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(summary.nodeCount).toBe(12);
    expect(summary.edgeCount).toBe(12);
    expect(summary.connectedComponentCount).toBe(1);
    expect(summary.isolatedNodeCount).toBe(0);
    expect(validation.warnings.join("\n")).not.toContain("Directed reachability");
  });

  it("leaves unsupported numeric habitat attributes and confidence unknown instead of encoding unknown as zero", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-13T00:00:00.000Z");

    for (const node of graph.nodes) {
      expect(node.confidence).toBeNull();
      expect(node.riverInfluence).toBeNull();
      expect(node.freshwaterInfluence).toBeNull();
      expect(node.tidalExposure).toBeNull();
      expect(node.waveExposure).toBeNull();
      expect(node.currentExposure).toBeNull();
      expect(node.structureDensity).toBeNull();
      expect(node.shallowAreaRatio).toBeNull();
      expect(node.baitHoldingPotential).toBeNull();
      expect(node.notes.join(" ")).toContain("Provisional");
    }
    for (const edge of graph.edges) {
      expect(edge.confidence).toBeNull();
      expect(edge.migrationCost).toBeNull();
      expect(edge.hydrologicalConnectivity).toBeNull();
      expect(edge.dataSources).toContain("workers/wanoku-intel-worker/src/environment-nodes.js");
      expect(edge.dataSources).toContain("docs/wanoku-spatial-habitat-graph.md");
      expect(edge.notes.join(" ")).toContain("provisional Habitat Graph v1 design");
      expect(edge.notes.join(" ")).toContain("Distance is calculated from environment-node coordinates");
      expect(edge.notes.join(" ")).toContain("Hydrological connectivity, migration validity");
    }
  });

  it("can build one environmental feature vector per initial habitat node with exact nodeId matching", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-13T00:00:00.000Z");
    const snapshots = TOKYO_BAY_ENVIRONMENT_NODES.map((node, index) => ({
      nodeId: node.id,
      observedAt: "2026-07-13T00:00:00.000Z",
      collectedAt: "2026-07-13T00:05:00.000Z",
      forecastIssuedAt: null,
      latitude: node.latitude,
      longitude: node.longitude,
      source: index % 2 === 0 ? "open-meteo-weather" : "open-meteo-marine",
      confidence: 0.8,
      freshness: 0.9,
      missingFields: [],
      airTemperature: 25 + index,
      windSpeed: 3 + index / 10
    }));

    const result = buildEnvironmentalFeatureSet({
      habitatGraph: graph,
      snapshots,
      calculatedAt: "2026-07-13T01:00:00.000Z"
    });

    expect(result.errors).toEqual([]);
    expect(result.unmatchedSnapshotNodeIds).toEqual([]);
    expect(result.nodesWithoutSnapshots).toEqual([]);
    expect(result.features).toHaveLength(TOKYO_BAY_ENVIRONMENT_NODES.length);
    expect(new Set(result.features.map((feature) => feature.nodeId))).toEqual(new Set(TOKYO_BAY_ENVIRONMENT_NODES.map((node) => node.id)));
  });
});
