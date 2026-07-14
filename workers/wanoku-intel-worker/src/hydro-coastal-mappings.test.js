import { describe, expect, it } from "vitest";
import {
  findMappingsWithUnknownHabitatNode,
  findUnmappedHydroCoastalStations
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";
import { createInitialHabitatGraph } from "../../../packages/wanoku-core/src/habitat-fixtures.ts";
import { JMA_TIDE_PREDICTION_STATIONS_2026 } from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import {
  buildJmaTidePredictionStationNodeMappings2026
} from "../../../packages/wanoku-core/src/jma-tide-prediction-mappings.ts";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

describe("Wanoku hydro-coastal mappings against current environment nodes", () => {
  it("builds JMA tide prediction primary anchors for the current 12-node Habitat Graph", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-14T00:00:00.000Z");
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: "2026-07-14T00:00:00.000Z"
    });

    expect(graph.nodes).toHaveLength(12);
    expect(result.errors).toEqual([]);
    expect(result.mappings).toHaveLength(5);
    expect(result.mappings.map((mapping) => [mapping.stationId, mapping.habitatNodeId])).toEqual([
      ["TK", "tokyo-inner-bay-01"],
      ["CB", "makuhari-shallow-01"],
      ["KZ", "kisarazu-north-01"],
      ["QS", "keihin-canal-01"],
      ["TT", "tateyama-north-01"]
    ]);
    expect(findMappingsWithUnknownHabitatNode(result.mappings, graph)).toEqual([]);
    expect(findUnmappedHydroCoastalStations(JMA_TIDE_PREDICTION_STATIONS_2026, result.mappings)).toEqual([]);
  });

  it("keeps mapping target coordinates aligned with the current environment node ids", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-14T00:00:00.000Z");
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: "2026-07-14T00:00:00.000Z"
    });
    const environmentById = new Map(TOKYO_BAY_ENVIRONMENT_NODES.map((node) => [node.id, node]));
    const graphById = new Map(graph.nodes.map((node) => [node.id, node]));

    for (const mapping of result.mappings) {
      const environmentNode = environmentById.get(mapping.habitatNodeId);
      const graphNode = graphById.get(mapping.habitatNodeId);
      expect(environmentNode).toBeDefined();
      expect(graphNode?.latitude).toBe(environmentNode.latitude);
      expect(graphNode?.longitude).toBe(environmentNode.longitude);
    }
  });
});
