import { describe, expect, it } from "vitest";
import {
  findMappingsWithUnknownHabitatNode,
  findUnmappedHydroCoastalStations,
  validateHydroCoastalStationNodeMapping
} from "./hydro-coastal";
import {
  createInitialHabitatGraph,
  type EnvironmentNodeSeed
} from "./habitat-fixtures";
import {
  haversineDistanceKm,
  roundDistanceKm,
  type HabitatGraph
} from "./habitat";
import {
  JMA_TIDE_PREDICTION_STATIONS_2026
} from "./jma-tide-prediction";
import {
  JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026,
  JMA_TIDE_PREDICTION_MAPPING_VALID_FROM,
  JMA_TIDE_PREDICTION_MAPPING_VALID_TO,
  JMA_TIDE_PREDICTION_MAPPING_VERSION,
  buildJmaTidePredictionStationNodeMappings2026
} from "./jma-tide-prediction-mappings";

const REVIEWED_AT = "2026-07-14T00:00:00.000Z";

describe("JMA Tide Prediction Station-to-Habitat Mapping v1", () => {
  it("builds exactly five manual-reviewed primary anchor mappings", () => {
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: habitatGraph(),
      reviewedAt: REVIEWED_AT
    });

    expect(result.errors).toEqual([]);
    expect(result.mappingVersion).toBe(JMA_TIDE_PREDICTION_MAPPING_VERSION);
    expect(result.mappings).toHaveLength(5);
    expect(result.mappings.map((mapping) => [mapping.stationId, mapping.habitatNodeId])).toEqual([
      ["TK", "tokyo-inner-bay-01"],
      ["CB", "makuhari-shallow-01"],
      ["KZ", "kisarazu-north-01"],
      ["QS", "keihin-canal-01"],
      ["TT", "tateyama-north-01"]
    ]);
    expect(result.mappings.every((mapping) => mapping.mappingMethod === "manual-reviewed")).toBe(true);
    expect(result.mappings.every((mapping) => mapping.confidence === null)).toBe(true);
  });

  it("uses the 2026 JST validity window and caller-supplied reviewedAt", () => {
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: habitatGraph(),
      reviewedAt: REVIEWED_AT
    });

    expect(result.mappings.every((mapping) => mapping.validFrom === JMA_TIDE_PREDICTION_MAPPING_VALID_FROM)).toBe(true);
    expect(result.mappings.every((mapping) => mapping.validTo === JMA_TIDE_PREDICTION_MAPPING_VALID_TO)).toBe(true);
    expect(result.mappings.every((mapping) => mapping.provenance.reviewedAt === REVIEWED_AT)).toBe(true);
    expect(result.mappings[0].provenance.notes).toEqual(expect.arrayContaining([
      JMA_TIDE_PREDICTION_MAPPING_VERSION,
      expect.stringContaining("Primary anchor mapping"),
      expect.stringContaining("Not selected by nearest-neighbor")
    ]));
    expect(result.mappings.find((mapping) => mapping.stationId === "QS")?.provenance.notes).toEqual(expect.arrayContaining([
      expect.stringContaining("Provisional proxy anchor")
    ]));
  });

  it("passes HydroCoastal mapping validation and maps all five stations", () => {
    const graph = habitatGraph();
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: REVIEWED_AT
    });

    expect(result.mappings.map(validateHydroCoastalStationNodeMapping).every((validation) => validation.valid)).toBe(true);
    expect(findUnmappedHydroCoastalStations(JMA_TIDE_PREDICTION_STATIONS_2026, result.mappings)).toEqual([]);
    expect(findMappingsWithUnknownHabitatNode(result.mappings, graph)).toEqual([]);
  });

  it("calculates distanceKm from station and habitat node coordinates as audit metadata", () => {
    const graph = habitatGraph();
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: graph,
      reviewedAt: REVIEWED_AT
    });
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const stationsById = new Map(JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => [station.stationId, station]));

    expect(Object.fromEntries(result.mappings.map((mapping) => [mapping.stationId, mapping.distanceKm]))).toEqual({
      TK: 5.862,
      CB: 6.708,
      KZ: 3.546,
      QS: 11.407,
      TT: 2.065
    });
    for (const mapping of result.mappings) {
      const station = stationsById.get(mapping.stationId);
      const node = nodesById.get(mapping.habitatNodeId);
      expect(station).toBeDefined();
      expect(node).toBeDefined();
      expect(mapping.distanceKm).toBe(roundDistanceKm(haversineDistanceKm(
        station!.latitude,
        station!.longitude,
        node!.latitude,
        node!.longitude
      )));
    }
  });

  it("is independent of station and graph node input order", () => {
    const graph = habitatGraph();
    const reversedGraph: HabitatGraph = {
      ...graph,
      nodes: [...graph.nodes].reverse()
    };
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: reversedGraph,
      stations: [...JMA_TIDE_PREDICTION_STATIONS_2026].reverse(),
      reviewedAt: REVIEWED_AT
    });

    expect(result.errors).toEqual([]);
    expect(result.mappings.map((mapping) => mapping.stationId)).toEqual(JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026.map((target) => target.stationId));
  });

  it("reports unknown habitat nodes without falling back to nearest nodes", () => {
    const graph = habitatGraph();
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: {
        ...graph,
        nodes: graph.nodes.filter((node) => node.id !== "keihin-canal-01")
      },
      reviewedAt: REVIEWED_AT
    });

    expect(result.mappings).toEqual([]);
    expect(result.errors).toContain("missing habitat node for mapping target: keihin-canal-01.");
  });

  it("reports missing and duplicate stations without fallback", () => {
    const missing = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: habitatGraph(),
      stations: JMA_TIDE_PREDICTION_STATIONS_2026.filter((station) => station.stationId !== "TT"),
      reviewedAt: REVIEWED_AT
    });
    const duplicate = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: habitatGraph(),
      stations: [...JMA_TIDE_PREDICTION_STATIONS_2026, JMA_TIDE_PREDICTION_STATIONS_2026[0]],
      reviewedAt: REVIEWED_AT
    });

    expect(missing.mappings).toEqual([]);
    expect(missing.errors).toContain("missing JMA tide prediction station: TT.");
    expect(duplicate.mappings).toEqual([]);
    expect(duplicate.errors).toContain("duplicate stationId in stations: TK.");
  });

  it("reports invalid reviewedAt without generating mappings", () => {
    const result = buildJmaTidePredictionStationNodeMappings2026({
      habitatGraph: habitatGraph(),
      reviewedAt: "2026-07-14T09:00:00+09:00"
    });

    expect(result.mappings).toEqual([]);
    expect(result.errors).toContain("reviewedAt must be canonical UTC ISO datetime.");
  });
});

function habitatGraph(): HabitatGraph {
  return createInitialHabitatGraph(TOKYO_BAY_ENVIRONMENT_NODES, "2026-07-14T00:00:00.000Z");
}

const TOKYO_BAY_ENVIRONMENT_NODES: EnvironmentNodeSeed[] = [
  {
    id: "tokyo-inner-bay-01",
    name: "Tokyo inner bay environmental node",
    latitude: 35.620,
    longitude: 139.820,
    area: "東京湾奥",
    waterType: "inner_bay"
  },
  {
    id: "sumida-arakawa-mouth-01",
    name: "Sumida-Arakawa river mouth environmental node",
    latitude: 35.640,
    longitude: 139.815,
    area: "河口・運河",
    waterType: "river_mouth"
  },
  {
    id: "tama-river-mouth-01",
    name: "Tama river mouth environmental node",
    latitude: 35.545,
    longitude: 139.775,
    area: "河口・運河",
    waterType: "river_mouth"
  },
  {
    id: "keihin-canal-01",
    name: "Keihin canal environmental node",
    latitude: 35.500,
    longitude: 139.760,
    area: "河口・運河",
    waterType: "canal"
  },
  {
    id: "makuhari-shallow-01",
    name: "Makuhari shallow environmental node",
    latitude: 35.620,
    longitude: 140.030,
    area: "東京湾奥",
    waterType: "shallow_flat"
  },
  {
    id: "funabashi-inner-01",
    name: "Funabashi inner bay environmental node",
    latitude: 35.675,
    longitude: 139.995,
    area: "東京湾奥",
    waterType: "inner_bay"
  },
  {
    id: "bay-center-north-01",
    name: "Tokyo Bay north-center environmental node",
    latitude: 35.480,
    longitude: 139.890,
    area: "湾央",
    waterType: "bay_center"
  },
  {
    id: "bay-center-south-01",
    name: "Tokyo Bay south-center environmental node",
    latitude: 35.350,
    longitude: 139.840,
    area: "湾央",
    waterType: "bay_center"
  },
  {
    id: "kisarazu-north-01",
    name: "Kisarazu northern Uchibo environmental node",
    latitude: 35.390,
    longitude: 139.890,
    area: "内房北部",
    waterType: "uchibo_north"
  },
  {
    id: "futtsu-cape-01",
    name: "Futtsu cape environmental node",
    latitude: 35.310,
    longitude: 139.790,
    area: "内房北部",
    waterType: "cape"
  },
  {
    id: "kanaya-uchibo-01",
    name: "Kanaya Uchibo environmental node",
    latitude: 35.170,
    longitude: 139.815,
    area: "内房南部",
    waterType: "uchibo_south"
  },
  {
    id: "tateyama-north-01",
    name: "Tateyama northern environmental node",
    latitude: 35.000,
    longitude: 139.840,
    area: "内房南部",
    waterType: "uchibo_south"
  }
];
