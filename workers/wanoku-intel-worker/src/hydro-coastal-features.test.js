import { describe, expect, it } from "vitest";
import { buildHydroCoastalFeatureSet } from "../../../packages/wanoku-core/src/hydro-coastal-features.ts";
import { createInitialHabitatGraph } from "../../../packages/wanoku-core/src/habitat-fixtures.ts";
import {
  JMA_TIDE_PREDICTION_LINE_LENGTH,
  JMA_TIDE_PREDICTION_STATIONS_2026,
  getJmaTidePredictionProviderDefinition,
  parseJmaTidePredictionFixedWidth
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import {
  buildJmaTidePredictionStationNodeMappings2026
} from "../../../packages/wanoku-core/src/jma-tide-prediction-mappings.ts";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

describe("Wanoku hydro-coastal features against current environment nodes", () => {
  it("connects parsed JMA tide predictions and explicit mappings into 12 node features", () => {
    const graph = createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-14T00:00:00.000Z");
    const parsed = parseJmaTidePredictionFixedWidth(
      ["TK", "CB", "KZ", "QS", "TT"].map((stationCode) => buildJmaLine({ stationCode })).join("\n"),
      {
        provider: getJmaTidePredictionProviderDefinition(),
        stations: JMA_TIDE_PREDICTION_STATIONS_2026,
        sourceYear: 2026,
        collectedAt: "2025-12-31T01:00:00.000Z",
        normalizedAt: "2025-12-31T01:00:00.000Z",
        forecastIssuedAt: "2025-12-31T00:00:00.000Z",
        sourceUrl: "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/",
        sourceName: "Japan Meteorological Agency tide table",
        attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku."
      }
    );
    const mappingResult = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: "2026-07-14T00:00:00.000Z"
    });
    const features = buildHydroCoastalFeatureSet({
      observations: parsed.observations,
      mappings: mappingResult.mappings,
      habitatGraph: graph,
      calculatedAt: "2025-12-31T02:00:00.000Z",
      targetAt: "2026-01-01T00:00:00.000Z"
    });

    expect(graph.nodes).toHaveLength(12);
    expect(parsed.errors).toEqual([]);
    expect(parsed.observations).toHaveLength(120);
    expect(mappingResult.errors).toEqual([]);
    expect(mappingResult.mappings).toHaveLength(5);
    expect(features.errors).toEqual([]);
    expect(features.features).toHaveLength(12);
    expect(features.features.filter((feature) => feature.stationId !== null)).toHaveLength(5);
    expect(features.features.filter((feature) => feature.missingReasons.includes("no-active-mapping"))).toHaveLength(7);
    expect(features.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")).toMatchObject({
      stationId: "TK",
      tideLevelCm: 19,
      tideLevelTpM: -0.951
    });
    expect(features.features.find((feature) => feature.nodeId === "keihin-canal-01")?.tideLevelTpM).toBe(-0.96);
    expect(features.features.find((feature) => feature.nodeId === "kisarazu-north-01")?.tideLevelTpM).toBeNull();
    expect(features.features.find((feature) => feature.nodeId === "makuhari-shallow-01")?.tideLevelTpM).toBeNull();
    expect(features.features.find((feature) => feature.nodeId === "tateyama-north-01")?.tideLevelTpM).toBeNull();
    expect(new Set(features.features.map((feature) => feature.nodeId))).toEqual(new Set(TOKYO_BAY_ENVIRONMENT_NODES.map((node) => node.id)));
  });
});

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
