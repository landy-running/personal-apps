import {
  type BayPosition,
  type ConnectionType,
  type DepthBand,
  type HabitatEdge,
  type HabitatGraph,
  type HabitatNode,
  type HabitatType,
  type WaterBodyType,
  haversineDistanceKm,
  roundDistanceKm
} from "./habitat";

export const HABITAT_GRAPH_VERSION = "wanoku-habitat-graph.v1";

export type EnvironmentNodeSeed = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  area: string;
  waterType: string;
  representativeness?: string;
};

type HabitatClassification = {
  waterBodyType: WaterBodyType;
  habitatTypes: HabitatType[];
  bayPosition: BayPosition | null;
  depthBand: DepthBand;
};

type HabitatEdgeSeed = {
  fromNodeId: string;
  toNodeId: string;
  connectionType: ConnectionType;
};

export const INITIAL_HABITAT_EDGE_SEEDS: HabitatEdgeSeed[] = [
  { fromNodeId: "sumida-arakawa-mouth-01", toNodeId: "tokyo-inner-bay-01", connectionType: "river-to-bay" },
  { fromNodeId: "tama-river-mouth-01", toNodeId: "keihin-canal-01", connectionType: "river-to-bay" },
  { fromNodeId: "keihin-canal-01", toNodeId: "tokyo-inner-bay-01", connectionType: "canal-to-bay" },
  { fromNodeId: "tokyo-inner-bay-01", toNodeId: "bay-center-north-01", connectionType: "inner-to-outer-bay" },
  { fromNodeId: "funabashi-inner-01", toNodeId: "makuhari-shallow-01", connectionType: "shallow-corridor" },
  { fromNodeId: "funabashi-inner-01", toNodeId: "bay-center-north-01", connectionType: "inner-to-outer-bay" },
  { fromNodeId: "makuhari-shallow-01", toNodeId: "bay-center-north-01", connectionType: "shallow-corridor" },
  { fromNodeId: "bay-center-north-01", toNodeId: "bay-center-south-01", connectionType: "bay-axis" },
  { fromNodeId: "bay-center-south-01", toNodeId: "kisarazu-north-01", connectionType: "inner-to-outer-bay" },
  { fromNodeId: "kisarazu-north-01", toNodeId: "futtsu-cape-01", connectionType: "adjacent-coast" },
  { fromNodeId: "futtsu-cape-01", toNodeId: "kanaya-uchibo-01", connectionType: "cape-transition" },
  { fromNodeId: "kanaya-uchibo-01", toNodeId: "tateyama-north-01", connectionType: "adjacent-coast" }
];

const INTERNAL_ENVIRONMENT_NODE_SOURCE = "workers/wanoku-intel-worker/src/environment-nodes.js";
const PROVISIONAL_TOPOLOGY_SOURCE = "docs/wanoku-spatial-habitat-graph.md";

export function createInitialHabitatGraph(
  environmentNodes: EnvironmentNodeSeed[],
  generatedAt: string
): HabitatGraph {
  const nodes = environmentNodes.map(createHabitatNodeFromEnvironmentNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = INITIAL_HABITAT_EDGE_SEEDS.map((edgeSeed) => createHabitatEdgeFromSeed(edgeSeed, nodeById));

  return {
    version: HABITAT_GRAPH_VERSION,
    generatedAt,
    nodes,
    edges
  };
}

export function createHabitatNodeFromEnvironmentNode(environmentNode: EnvironmentNodeSeed): HabitatNode {
  const classification = classifyEnvironmentNode(environmentNode);
  const notes = [
    "Provisional Habitat Graph v1 classification derived only from the environment node id/name/waterType.",
    "Numeric habitat attributes remain null until supported by explicit bathymetry, substrate, structure or field data."
  ];
  if (environmentNode.representativeness) {
    notes.push(`Environment-node representativeness note: ${environmentNode.representativeness}`);
  }

  return {
    id: environmentNode.id,
    displayName: environmentNode.name,
    latitude: environmentNode.latitude,
    longitude: environmentNode.longitude,
    region: environmentNode.area,
    waterBodyType: classification.waterBodyType,
    habitatTypes: classification.habitatTypes,
    bayPosition: classification.bayPosition,
    depthBand: classification.depthBand,
    riverInfluence: null,
    freshwaterInfluence: null,
    tidalExposure: null,
    waveExposure: null,
    currentExposure: null,
    structureDensity: null,
    shallowAreaRatio: null,
    baitHoldingPotential: null,
    confidence: null,
    dataSources: [INTERNAL_ENVIRONMENT_NODE_SOURCE],
    notes
  };
}

function createHabitatEdgeFromSeed(edgeSeed: HabitatEdgeSeed, nodeById: Map<string, HabitatNode>): HabitatEdge {
  const fromNode = nodeById.get(edgeSeed.fromNodeId);
  const toNode = nodeById.get(edgeSeed.toNodeId);
  if (!fromNode || !toNode) {
    throw new Error(`Habitat edge seed references missing node: ${edgeSeed.fromNodeId} -> ${edgeSeed.toNodeId}`);
  }

  const distanceKm = roundDistanceKm(haversineDistanceKm(
    fromNode.latitude,
    fromNode.longitude,
    toNode.latitude,
    toNode.longitude
  ));

  return {
    id: `${edgeSeed.fromNodeId}__${edgeSeed.toNodeId}__${edgeSeed.connectionType}`,
    fromNodeId: edgeSeed.fromNodeId,
    toNodeId: edgeSeed.toNodeId,
    distanceKm,
    connectionType: edgeSeed.connectionType,
    directionality: "bidirectional",
    hydrologicalConnectivity: null,
    migrationCost: null,
    exposureContinuity: null,
    freshwaterContinuity: null,
    confidence: null,
    dataSources: [INTERNAL_ENVIRONMENT_NODE_SOURCE, PROVISIONAL_TOPOLOGY_SOURCE],
    notes: [
      "Connection topology is a provisional Habitat Graph v1 design.",
      "Distance is calculated from environment-node coordinates.",
      "Hydrological connectivity, migration validity and non-distance movement weights are unverified and intentionally null."
    ]
  };
}

function classifyEnvironmentNode(environmentNode: EnvironmentNodeSeed): HabitatClassification {
  switch (environmentNode.waterType) {
    case "river_mouth":
      return {
        waterBodyType: "river-mouth",
        habitatTypes: ["river-mouth"],
        bayPosition: "inner",
        depthBand: "unknown"
      };
    case "canal":
      return {
        waterBodyType: "canal",
        habitatTypes: ["canal"],
        bayPosition: "inner",
        depthBand: "unknown"
      };
    case "shallow_flat":
      return {
        waterBodyType: "bay",
        habitatTypes: ["shallow"],
        bayPosition: "inner",
        depthBand: "unknown"
      };
    case "bay_center":
      return {
        waterBodyType: "bay",
        habitatTypes: ["open-water"],
        bayPosition: "middle",
        depthBand: "unknown"
      };
    case "cape":
      return {
        waterBodyType: "coastal",
        habitatTypes: ["cape"],
        bayPosition: "outer",
        depthBand: "unknown"
      };
    case "inner_bay":
      return {
        waterBodyType: "bay",
        habitatTypes: ["open-water"],
        bayPosition: "inner",
        depthBand: "unknown"
      };
    case "uchibo_north":
    case "uchibo_south":
      return {
        waterBodyType: "coastal",
        habitatTypes: [],
        bayPosition: null,
        depthBand: "unknown"
      };
    default:
      return {
        waterBodyType: "unknown",
        habitatTypes: [],
        bayPosition: null,
        depthBand: "unknown"
      };
  }
}
