import { describe, expect, it } from "vitest";
import {
  type HabitatEdge,
  type HabitatGraph,
  type HabitatNode,
  calculateGraphSummary,
  findShortestPathByDistance,
  getAdjacentNodes,
  getConnectedComponents,
  getIncomingEdges,
  getOutgoingEdges,
  haversineDistanceKm,
  roundDistanceKm,
  validateHabitatGraph
} from "./habitat";
import {
  createHabitatNodeFromEnvironmentNode,
  createInitialHabitatGraph,
  type EnvironmentNodeSeed
} from "./habitat-fixtures";

const environmentNodeSeeds: EnvironmentNodeSeed[] = [
  {
    id: "tokyo-inner-bay-01",
    name: "Tokyo inner bay environmental node",
    latitude: 35.62,
    longitude: 139.82,
    area: "inner",
    waterType: "inner_bay"
  },
  {
    id: "sumida-arakawa-mouth-01",
    name: "Sumida-Arakawa river mouth environmental node",
    latitude: 35.64,
    longitude: 139.815,
    area: "inner",
    waterType: "river_mouth"
  },
  {
    id: "tama-river-mouth-01",
    name: "Tama river mouth environmental node",
    latitude: 35.545,
    longitude: 139.775,
    area: "inner",
    waterType: "river_mouth"
  },
  {
    id: "keihin-canal-01",
    name: "Keihin canal environmental node",
    latitude: 35.5,
    longitude: 139.76,
    area: "inner",
    waterType: "canal"
  },
  {
    id: "makuhari-shallow-01",
    name: "Makuhari shallow environmental node",
    latitude: 35.62,
    longitude: 140.03,
    area: "inner",
    waterType: "shallow_flat"
  },
  {
    id: "funabashi-inner-01",
    name: "Funabashi inner bay environmental node",
    latitude: 35.675,
    longitude: 139.995,
    area: "inner",
    waterType: "inner_bay"
  },
  {
    id: "bay-center-north-01",
    name: "Tokyo Bay north-center environmental node",
    latitude: 35.48,
    longitude: 139.89,
    area: "middle",
    waterType: "bay_center"
  },
  {
    id: "bay-center-south-01",
    name: "Tokyo Bay south-center environmental node",
    latitude: 35.35,
    longitude: 139.84,
    area: "middle",
    waterType: "bay_center"
  },
  {
    id: "kisarazu-north-01",
    name: "Kisarazu northern Uchibo environmental node",
    latitude: 35.39,
    longitude: 139.89,
    area: "uchibo",
    waterType: "uchibo_north"
  },
  {
    id: "futtsu-cape-01",
    name: "Futtsu cape environmental node",
    latitude: 35.31,
    longitude: 139.79,
    area: "uchibo",
    waterType: "cape"
  },
  {
    id: "kanaya-uchibo-01",
    name: "Kanaya Uchibo environmental node",
    latitude: 35.17,
    longitude: 139.815,
    area: "uchibo",
    waterType: "uchibo_south"
  },
  {
    id: "tateyama-north-01",
    name: "Tateyama northern environmental node",
    latitude: 35,
    longitude: 139.84,
    area: "uchibo",
    waterType: "uchibo_south"
  }
];

describe("Wanoku habitat graph core", () => {
  it("validates the normal 12-node initial graph", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    const result = validateHabitatGraph(graph);

    expect(graph.nodes).toHaveLength(12);
    expect(graph.edges).toHaveLength(12);
    expect(graph.nodes.every((node) => node.confidence === null)).toBe(true);
    expect(graph.edges.every((edge) => edge.confidence === null)).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).not.toContain("Directed reachability");
  });

  it("requires createInitialHabitatGraph callers to provide generatedAt explicitly", () => {
    expect(createInitialHabitatGraph.length).toBe(2);
  });

  it("accepts only canonical UTC ISO generatedAt values", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");

    expect(validateHabitatGraph(graph).errors).not.toContain("Habitat graph generatedAt must be a non-empty valid date-time string.");
  });

  it("rejects non-canonical or impossible generatedAt values", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    const invalidGeneratedAtValues = [
      "2026-07-13",
      "2026-07-13T00:00:00",
      "2026-07-13T09:00:00+09:00",
      "July 13, 2026",
      "2026-02-30T00:00:00.000Z",
      "",
      "not-a-date"
    ];

    for (const generatedAt of invalidGeneratedAtValues) {
      expect(validateHabitatGraph({ ...graph, generatedAt }).errors).toContain(
        "Habitat graph generatedAt must be a non-empty valid date-time string."
      );
    }
  });

  it("maps unknown environment waterType to unknown instead of falling back to bay", () => {
    const node = createHabitatNodeFromEnvironmentNode({
      id: "unknown-node",
      name: "Unknown water type node",
      latitude: 35,
      longitude: 139,
      area: "unknown",
      waterType: "unclassified"
    });

    expect(node.waterBodyType).toBe("unknown");
    expect(node.confidence).toBeNull();
  });

  it("rejects duplicate node ids", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    graph.nodes.push({ ...graph.nodes[0] });

    expect(validateHabitatGraph(graph).errors).toEqual(expect.arrayContaining([
      "Duplicate habitat node id: tokyo-inner-bay-01"
    ]));
  });

  it("rejects duplicate edge ids and duplicate directed connection keys", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    graph.edges.push({ ...graph.edges[0] });
    graph.edges.push({
      ...graph.edges[0],
      id: "reverse-duplicate",
      fromNodeId: graph.edges[0].toNodeId,
      toNodeId: graph.edges[0].fromNodeId
    });

    const errors = validateHabitatGraph(graph).errors.join("\n");
    expect(errors).toContain("Duplicate habitat edge id");
    expect(errors).toContain("duplicates direction and connectionType");
  });

  it("rejects unknown node references and self loops", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    graph.edges.push({
      ...graph.edges[0],
      id: "unknown-node-edge",
      fromNodeId: "missing-node",
      toNodeId: "tokyo-inner-bay-01"
    });
    graph.edges.push({
      ...graph.edges[0],
      id: "self-loop-edge",
      fromNodeId: "tokyo-inner-bay-01",
      toNodeId: "tokyo-inner-bay-01"
    });

    const errors = validateHabitatGraph(graph).errors.join("\n");
    expect(errors).toContain("references unknown fromNodeId");
    expect(errors).toContain("is a self-loop");
  });

  it("rejects out-of-range numeric fields and duplicate habitatTypes", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    graph.nodes[0] = {
      ...graph.nodes[0],
      latitude: 120,
      confidence: 1.2,
      riverInfluence: -0.1,
      habitatTypes: ["open-water", "open-water"]
    };
    graph.edges[0] = {
      ...graph.edges[0],
      distanceKm: 0,
      migrationCost: 1.5
    };

    const errors = validateHabitatGraph(graph).errors.join("\n");
    expect(errors).toContain("invalid coordinates");
    expect(errors).toContain("confidence outside 0..1");
    expect(errors).toContain("riverInfluence outside 0..1");
    expect(errors).toContain("duplicate habitatTypes");
    expect(errors).toContain("non-positive distanceKm");
    expect(errors).toContain("migrationCost outside 0..1");
  });

  it("allows null confidence but rejects confidence outside 0..1 when present", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    expect(validateHabitatGraph(graph).errors.join("\n")).not.toContain("confidence outside 0..1");

    graph.nodes[0] = { ...graph.nodes[0], confidence: -0.01 };
    graph.edges[0] = { ...graph.edges[0], confidence: 1.01 };

    const errors = validateHabitatGraph(graph).errors.join("\n");
    expect(errors).toContain("Habitat node tokyo-inner-bay-01 has confidence outside 0..1.");
    expect(errors).toContain("has confidence outside 0..1.");
  });

  it("rejects invalid runtime enum values from JSON-like data", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z") as unknown as HabitatGraph;
    graph.nodes[0] = {
      ...graph.nodes[0],
      waterBodyType: "lagoon",
      habitatTypes: ["open-water", "kelp-forest"],
      bayPosition: "upper",
      depthBand: "bottomless"
    } as unknown as HabitatNode;
    graph.edges[0] = {
      ...graph.edges[0],
      connectionType: "wormhole",
      directionality: "sideways"
    } as unknown as HabitatEdge;

    const errors = validateHabitatGraph(graph).errors.join("\n");
    expect(errors).toContain("invalid waterBodyType: lagoon");
    expect(errors).toContain("invalid habitatType: kelp-forest");
    expect(errors).toContain("invalid bayPosition: upper");
    expect(errors).toContain("invalid depthBand: bottomless");
    expect(errors).toContain("invalid connectionType: wormhole");
    expect(errors).toContain("invalid directionality: sideways");
  });

  it("warns about disconnected components and isolated nodes", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    graph.edges = graph.edges.filter((edge) => edge.fromNodeId !== "kanaya-uchibo-01" && edge.toNodeId !== "kanaya-uchibo-01");

    const result = validateHabitatGraph(graph);

    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain("Isolated habitat nodes detected: kanaya-uchibo-01");
    expect(result.warnings.join("\n")).toContain("Disconnected habitat graph components detected");
  });

  it("calculates haversine distance and generated edge distance from coordinates", () => {
    expect(haversineDistanceKm(0, 0, 0, 1)).toBeCloseTo(111.195, 3);

    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    const edge = graph.edges.find((item) => item.id.startsWith("sumida-arakawa-mouth-01__tokyo-inner-bay-01"));
    const from = graph.nodes.find((node) => node.id === "sumida-arakawa-mouth-01");
    const to = graph.nodes.find((node) => node.id === "tokyo-inner-bay-01");

    expect(edge?.distanceKm).toBe(roundDistanceKm(haversineDistanceKm(
      from?.latitude ?? 0,
      from?.longitude ?? 0,
      to?.latitude ?? 0,
      to?.longitude ?? 0
    )));
  });

  it("returns outgoing, incoming and adjacent nodes while respecting directionality", () => {
    const graph = directedGraph();

    expect(getOutgoingEdges(graph, "a").map((edge) => edge.id)).toEqual(["a-to-b"]);
    expect(getIncomingEdges(graph, "a").map((edge) => edge.id)).toEqual([]);
    expect(getAdjacentNodes(graph, "a").map((node) => node.id)).toEqual(["b"]);
    expect(getAdjacentNodes(graph, "b").map((node) => node.id)).toEqual(["c"]);
  });

  it("does not treat invalid directionality as from-to during graph traversal", () => {
    const graph = directedGraph();
    graph.edges[0] = { ...graph.edges[0], directionality: "sideways" } as unknown as HabitatEdge;

    expect(validateHabitatGraph(graph).errors.join("\n")).toContain("invalid directionality: sideways");
    expect(() => getAdjacentNodes(graph, "a")).toThrow("Invalid habitat edge directionality: sideways");
    expect(() => findShortestPathByDistance(graph, "a", "b")).toThrow("Invalid habitat edge directionality: sideways");
  });

  it("warns when a weakly connected graph is not fully reachable by directionality", () => {
    const graph = twoNodeDirectedGraph();
    const result = validateHabitatGraph(graph);

    expect(getConnectedComponents(graph)).toHaveLength(1);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "Directed reachability from b cannot reach: a"
    ]));
  });

  it("finds shortest paths by distance and respects directed edges", () => {
    const graph = directedGraph();

    expect(findShortestPathByDistance(graph, "a", "c")).toEqual({
      nodeIds: ["a", "b", "c"],
      edgeIds: ["a-to-b", "b-to-c"],
      totalDistanceKm: 3
    });
    expect(findShortestPathByDistance(graph, "c", "a")).toBeNull();
    expect(findShortestPathByDistance(graph, "a", "missing")).toBeNull();
  });

  it("calculates connected components and graph summary", () => {
    const graph = createInitialHabitatGraph(environmentNodeSeeds, "2026-07-13T00:00:00.000Z");
    const components = getConnectedComponents(graph);
    const summary = calculateGraphSummary(graph);

    expect(components).toHaveLength(1);
    expect(summary.nodeCount).toBe(12);
    expect(summary.edgeCount).toBe(12);
    expect(summary.connectedComponentCount).toBe(1);
    expect(summary.isolatedNodeCount).toBe(0);
    expect(summary.totalEdgeDistanceKm).toBeGreaterThan(0);
    expect(summary.averageDegree).toBe(2);
    expect(summary.habitatTypeCounts["river-mouth"]).toBe(2);
    expect(summary.waterBodyTypeCounts.bay).toBe(5);
  });
});

function directedGraph(): HabitatGraph {
  const nodes: HabitatNode[] = [
    node("a", 35, 139.7),
    node("b", 35.01, 139.71),
    node("c", 35.02, 139.72),
    node("d", 36, 140)
  ];
  const edges: HabitatEdge[] = [
    edge("a-to-b", "a", "b", 1, "from-to"),
    edge("b-to-c", "b", "c", 2, "from-to")
  ];
  return {
    version: "test",
    generatedAt: "2026-07-13T00:00:00.000Z",
    nodes,
    edges
  };
}

function twoNodeDirectedGraph(): HabitatGraph {
  const nodes: HabitatNode[] = [
    node("a", 35, 139.7),
    node("b", 35.01, 139.71)
  ];
  const edges: HabitatEdge[] = [
    edge("a-to-b", "a", "b", 1, "from-to")
  ];
  return {
    version: "test",
    generatedAt: "2026-07-13T00:00:00.000Z",
    nodes,
    edges
  };
}

function node(id: string, latitude: number, longitude: number): HabitatNode {
  return {
    id,
    displayName: id,
    latitude,
    longitude,
    region: "test",
    waterBodyType: "bay",
    habitatTypes: ["open-water"],
    bayPosition: null,
    depthBand: "unknown",
    riverInfluence: null,
    freshwaterInfluence: null,
    tidalExposure: null,
    waveExposure: null,
    currentExposure: null,
    structureDensity: null,
    shallowAreaRatio: null,
    baitHoldingPotential: null,
    confidence: 0.5,
    dataSources: ["test"],
    notes: []
  };
}

function edge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  distanceKm: number,
  directionality: HabitatEdge["directionality"]
): HabitatEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    distanceKm,
    connectionType: "bay-axis",
    directionality,
    hydrologicalConnectivity: null,
    migrationCost: null,
    exposureContinuity: null,
    freshwaterContinuity: null,
    confidence: 0.5,
    dataSources: ["test"],
    notes: []
  };
}
