export type WaterBodyType = "bay" | "river-mouth" | "canal" | "coastal" | "strait" | "offshore" | "unknown";

export type HabitatType =
  | "shallow"
  | "tidal-flat"
  | "river-mouth"
  | "canal"
  | "artificial-shore"
  | "open-water"
  | "cape"
  | "rocky-coast"
  | "sandy-bottom"
  | "muddy-bottom"
  | "mixed-bottom";

export type BayPosition = "inner" | "middle" | "outer" | "outside";

export type DepthBand = "very-shallow" | "shallow" | "mid-depth" | "deep" | "unknown";

export type ConnectionType =
  | "adjacent-coast"
  | "bay-axis"
  | "river-to-bay"
  | "canal-to-bay"
  | "shallow-corridor"
  | "cape-transition"
  | "inner-to-outer-bay";

export type Directionality = "bidirectional" | "from-to" | "to-from";

export type HabitatNode = {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
  region: string;
  waterBodyType: WaterBodyType;
  habitatTypes: HabitatType[];
  bayPosition?: BayPosition | null;
  depthBand?: DepthBand | null;
  riverInfluence?: number | null;
  freshwaterInfluence?: number | null;
  tidalExposure?: number | null;
  waveExposure?: number | null;
  currentExposure?: number | null;
  structureDensity?: number | null;
  shallowAreaRatio?: number | null;
  baitHoldingPotential?: number | null;
  confidence: number | null;
  dataSources: string[];
  notes: string[];
};

export type HabitatEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  distanceKm: number;
  connectionType: ConnectionType;
  directionality: Directionality;
  hydrologicalConnectivity?: number | null;
  migrationCost?: number | null;
  exposureContinuity?: number | null;
  freshwaterContinuity?: number | null;
  confidence: number | null;
  dataSources: string[];
  notes: string[];
};

export type HabitatGraph = {
  version: string;
  generatedAt: string;
  nodes: HabitatNode[];
  edges: HabitatEdge[];
};

export type HabitatValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type ShortestHabitatPath = {
  nodeIds: string[];
  edgeIds: string[];
  totalDistanceKm: number;
};

export type HabitatGraphSummary = {
  nodeCount: number;
  edgeCount: number;
  connectedComponentCount: number;
  isolatedNodeCount: number;
  totalEdgeDistanceKm: number;
  averageDegree: number;
  habitatTypeCounts: Record<string, number>;
  waterBodyTypeCounts: Record<string, number>;
};

const NODE_SCORE_FIELDS: Array<keyof HabitatNode> = [
  "riverInfluence",
  "freshwaterInfluence",
  "tidalExposure",
  "waveExposure",
  "currentExposure",
  "structureDensity",
  "shallowAreaRatio",
  "baitHoldingPotential",
  "confidence"
];

const EDGE_SCORE_FIELDS: Array<keyof HabitatEdge> = [
  "hydrologicalConnectivity",
  "migrationCost",
  "exposureContinuity",
  "freshwaterContinuity",
  "confidence"
];

const EARTH_RADIUS_KM = 6371.0088;

const WATER_BODY_TYPES = ["bay", "river-mouth", "canal", "coastal", "strait", "offshore", "unknown"] as const satisfies readonly WaterBodyType[];
const HABITAT_TYPES = [
  "shallow",
  "tidal-flat",
  "river-mouth",
  "canal",
  "artificial-shore",
  "open-water",
  "cape",
  "rocky-coast",
  "sandy-bottom",
  "muddy-bottom",
  "mixed-bottom"
] as const satisfies readonly HabitatType[];
const BAY_POSITIONS = ["inner", "middle", "outer", "outside"] as const satisfies readonly BayPosition[];
const DEPTH_BANDS = ["very-shallow", "shallow", "mid-depth", "deep", "unknown"] as const satisfies readonly DepthBand[];
const CONNECTION_TYPES = [
  "adjacent-coast",
  "bay-axis",
  "river-to-bay",
  "canal-to-bay",
  "shallow-corridor",
  "cape-transition",
  "inner-to-outer-bay"
] as const satisfies readonly ConnectionType[];
const DIRECTIONALITIES = ["bidirectional", "from-to", "to-from"] as const satisfies readonly Directionality[];
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function haversineDistanceKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number
): number {
  const fromLatRad = toRadians(fromLatitude);
  const toLatRad = toRadians(toLatitude);
  const deltaLat = toRadians(toLatitude - fromLatitude);
  const deltaLon = toRadians(toLongitude - fromLongitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(fromLatRad) * Math.cos(toLatRad) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function roundDistanceKm(distanceKm: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(distanceKm * factor) / factor;
}

export function validateHabitatGraph(graph: HabitatGraph): HabitatValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const directedConnectionKeys = new Set<string>();

  if (!isValidIsoDateTime(graph.generatedAt)) {
    errors.push("Habitat graph generatedAt must be a non-empty valid date-time string.");
  }

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate habitat node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    if (typeof node.displayName !== "string" || !node.displayName.trim()) {
      errors.push(`Habitat node ${node.id} has an empty displayName.`);
    }
    if (!isLatitude(node.latitude) || !isLongitude(node.longitude)) {
      errors.push(`Habitat node ${node.id} has invalid coordinates.`);
    }
    if (!isWaterBodyType(node.waterBodyType)) {
      errors.push(`Habitat node ${node.id} has invalid waterBodyType: ${String(node.waterBodyType)}`);
    }
    if (!Array.isArray(node.habitatTypes)) {
      errors.push(`Habitat node ${node.id} habitatTypes must be an array.`);
    } else {
      if (new Set(node.habitatTypes).size !== node.habitatTypes.length) {
        errors.push(`Habitat node ${node.id} has duplicate habitatTypes.`);
      }
      for (const habitatType of node.habitatTypes) {
        if (!isHabitatType(habitatType)) {
          errors.push(`Habitat node ${node.id} has invalid habitatType: ${String(habitatType)}`);
        }
      }
    }
    if (node.bayPosition != null && !isBayPosition(node.bayPosition)) {
      errors.push(`Habitat node ${node.id} has invalid bayPosition: ${String(node.bayPosition)}`);
    }
    if (node.depthBand != null && !isDepthBand(node.depthBand)) {
      errors.push(`Habitat node ${node.id} has invalid depthBand: ${String(node.depthBand)}`);
    }
    for (const field of NODE_SCORE_FIELDS) {
      const value = node[field];
      if (value != null && !isUnitInterval(value)) {
        errors.push(`Habitat node ${node.id} has ${String(field)} outside 0..1.`);
      }
    }
  }

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`Duplicate habitat edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.fromNodeId)) {
      errors.push(`Habitat edge ${edge.id} references unknown fromNodeId: ${edge.fromNodeId}`);
    }
    if (!nodeIds.has(edge.toNodeId)) {
      errors.push(`Habitat edge ${edge.id} references unknown toNodeId: ${edge.toNodeId}`);
    }
    if (edge.fromNodeId === edge.toNodeId) {
      errors.push(`Habitat edge ${edge.id} is a self-loop.`);
    }
    if (!Number.isFinite(edge.distanceKm) || edge.distanceKm <= 0) {
      errors.push(`Habitat edge ${edge.id} has non-positive distanceKm.`);
    }
    if (!isConnectionType(edge.connectionType)) {
      errors.push(`Habitat edge ${edge.id} has invalid connectionType: ${String(edge.connectionType)}`);
    }
    if (!isDirectionality(edge.directionality)) {
      errors.push(`Habitat edge ${edge.id} has invalid directionality: ${String(edge.directionality)}`);
    }
    for (const field of EDGE_SCORE_FIELDS) {
      const value = edge[field];
      if (value != null && !isUnitInterval(value)) {
        errors.push(`Habitat edge ${edge.id} has ${String(field)} outside 0..1.`);
      }
    }
    if (isDirectionality(edge.directionality) && isConnectionType(edge.connectionType)) {
      for (const key of directedConnectionKeysForEdge(edge)) {
        if (directedConnectionKeys.has(key)) {
          errors.push(`Habitat edge ${edge.id} duplicates direction and connectionType: ${key}`);
        }
        directedConnectionKeys.add(key);
      }
    }
  }

  const components = getConnectedComponents(graph);
  const isolatedNodes = graph.nodes.filter((node) => getIncidentEdges(graph, node.id).length === 0);
  if (isolatedNodes.length > 0) {
    warnings.push(`Isolated habitat nodes detected: ${isolatedNodes.map((node) => node.id).join(", ")}`);
  }
  if (components.length > 1) {
    warnings.push(`Disconnected habitat graph components detected: ${components.length}`);
    const unreachableNodeIds = components
      .slice(1)
      .flatMap((component) => component.nodeIds);
    if (unreachableNodeIds.length) {
      warnings.push(`Nodes unreachable from ${components[0].nodeIds[0]}: ${unreachableNodeIds.join(", ")}`);
    }
  }
  if (graph.edges.every((edge) => isDirectionality(edge.directionality))) {
    warnings.push(...directedReachabilityWarnings(graph));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function getHabitatNode(graph: HabitatGraph, nodeId: string): HabitatNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function getOutgoingEdges(graph: HabitatGraph, nodeId: string): HabitatEdge[] {
  return graph.edges.filter((edge) => directedEndpointsForEdge(edge).some((endpoint) => endpoint.from === nodeId));
}

export function getIncomingEdges(graph: HabitatGraph, nodeId: string): HabitatEdge[] {
  return graph.edges.filter((edge) => directedEndpointsForEdge(edge).some((endpoint) => endpoint.to === nodeId));
}

export function getAdjacentNodes(graph: HabitatGraph, nodeId: string): HabitatNode[] {
  const adjacentIds = new Set<string>();
  for (const edge of graph.edges) {
    for (const endpoint of directedEndpointsForEdge(edge)) {
      if (endpoint.from === nodeId) adjacentIds.add(endpoint.to);
    }
  }
  return graph.nodes.filter((node) => adjacentIds.has(node.id));
}

/**
 * Returns weakly connected components: edge directionality is intentionally ignored here.
 * Use validation warnings for directionality-aware reachability checks.
 */
export function getConnectedComponents(graph: HabitatGraph): Array<{ nodeIds: string[] }> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const visited = new Set<string>();
  const components: Array<{ nodeIds: string[] }> = [];

  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    const queue = [nodeId];
    const componentIds: string[] = [];
    visited.add(nodeId);

    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      componentIds.push(current);
      for (const edge of graph.edges) {
        const neighbors = edge.fromNodeId === current
          ? [edge.toNodeId]
          : edge.toNodeId === current
            ? [edge.fromNodeId]
            : [];
        for (const neighbor of neighbors) {
          if (nodeIds.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    components.push({ nodeIds: componentIds });
  }

  return components;
}

export function findShortestPathByDistance(
  graph: HabitatGraph,
  fromNodeId: string,
  toNodeId: string
): ShortestHabitatPath | null {
  if (!getHabitatNode(graph, fromNodeId) || !getHabitatNode(graph, toNodeId)) return null;

  const distances = new Map<string, number>();
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  const unvisited = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    distances.set(node.id, node.id === fromNodeId ? 0 : Number.POSITIVE_INFINITY);
  }

  while (unvisited.size > 0) {
    let current: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const nodeId of unvisited) {
      const distance = distances.get(nodeId) ?? Number.POSITIVE_INFINITY;
      if (distance < currentDistance) {
        current = nodeId;
        currentDistance = distance;
      }
    }
    if (!current || currentDistance === Number.POSITIVE_INFINITY) break;
    if (current === toNodeId) break;
    unvisited.delete(current);

    for (const edge of graph.edges) {
      for (const endpoint of directedEndpointsForEdge(edge)) {
        if (endpoint.from !== current || !unvisited.has(endpoint.to)) continue;
        const candidateDistance = currentDistance + edge.distanceKm;
        if (candidateDistance < (distances.get(endpoint.to) ?? Number.POSITIVE_INFINITY)) {
          distances.set(endpoint.to, candidateDistance);
          previous.set(endpoint.to, { nodeId: current, edgeId: edge.id });
        }
      }
    }
  }

  const totalDistanceKm = distances.get(toNodeId) ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(totalDistanceKm)) return null;

  const nodeIds = [toNodeId];
  const edgeIds: string[] = [];
  let cursor = toNodeId;
  while (cursor !== fromNodeId) {
    const step = previous.get(cursor);
    if (!step) return null;
    edgeIds.unshift(step.edgeId);
    nodeIds.unshift(step.nodeId);
    cursor = step.nodeId;
  }

  return {
    nodeIds,
    edgeIds,
    totalDistanceKm: roundDistanceKm(totalDistanceKm)
  };
}

export function calculateGraphSummary(graph: HabitatGraph): HabitatGraphSummary {
  const components = getConnectedComponents(graph);
  const isolatedNodeCount = graph.nodes.filter((node) => getIncidentEdges(graph, node.id).length === 0).length;
  const degreeSum = graph.nodes.reduce((sum, node) => sum + getIncidentEdges(graph, node.id).length, 0);
  const habitatTypeCounts: Record<string, number> = {};
  const waterBodyTypeCounts: Record<string, number> = {};

  for (const node of graph.nodes) {
    waterBodyTypeCounts[node.waterBodyType] = (waterBodyTypeCounts[node.waterBodyType] ?? 0) + 1;
    for (const habitatType of node.habitatTypes) {
      habitatTypeCounts[habitatType] = (habitatTypeCounts[habitatType] ?? 0) + 1;
    }
  }

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    connectedComponentCount: components.length,
    isolatedNodeCount,
    totalEdgeDistanceKm: roundDistanceKm(graph.edges.reduce((sum, edge) => sum + edge.distanceKm, 0)),
    averageDegree: graph.nodes.length ? roundDistanceKm(degreeSum / graph.nodes.length, 3) : 0,
    habitatTypeCounts,
    waterBodyTypeCounts
  };
}

function getIncidentEdges(graph: HabitatGraph, nodeId: string): HabitatEdge[] {
  return graph.edges.filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId);
}

function directedConnectionKeysForEdge(edge: HabitatEdge): string[] {
  return directedEndpointsForEdge(edge).map((endpoint) => `${endpoint.from}->${endpoint.to}|${edge.connectionType}`);
}

function directedEndpointsForEdge(edge: HabitatEdge): Array<{ from: string; to: string }> {
  switch (edge.directionality) {
    case "bidirectional":
      return [
        { from: edge.fromNodeId, to: edge.toNodeId },
        { from: edge.toNodeId, to: edge.fromNodeId }
      ];
    case "from-to":
      return [{ from: edge.fromNodeId, to: edge.toNodeId }];
    case "to-from":
      return [{ from: edge.toNodeId, to: edge.fromNodeId }];
    default:
      throw new Error(`Invalid habitat edge directionality: ${String(edge.directionality)}`);
  }
}

function directedReachabilityWarnings(graph: HabitatGraph): string[] {
  const warnings: string[] = [];
  const nodeIds = graph.nodes.map((node) => node.id);
  const nodeIdSet = new Set(nodeIds);

  for (const origin of nodeIds) {
    const reachable = new Set<string>([origin]);
    const queue = [origin];

    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      for (const edge of graph.edges) {
        for (const endpoint of directedEndpointsForEdge(edge)) {
          if (endpoint.from !== current || reachable.has(endpoint.to) || !nodeIdSet.has(endpoint.to)) continue;
          reachable.add(endpoint.to);
          queue.push(endpoint.to);
        }
      }
    }

    const unreachable = nodeIds.filter((nodeId) => !reachable.has(nodeId));
    if (unreachable.length) {
      warnings.push(`Directed reachability from ${origin} cannot reach: ${unreachable.join(", ")}`);
    }
  }

  return warnings;
}

function isLatitude(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitude(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function isWaterBodyType(value: unknown): value is WaterBodyType {
  return typeof value === "string" && (WATER_BODY_TYPES as readonly string[]).includes(value);
}

function isHabitatType(value: unknown): value is HabitatType {
  return typeof value === "string" && (HABITAT_TYPES as readonly string[]).includes(value);
}

function isBayPosition(value: unknown): value is BayPosition {
  return typeof value === "string" && (BAY_POSITIONS as readonly string[]).includes(value);
}

function isDepthBand(value: unknown): value is DepthBand {
  return typeof value === "string" && (DEPTH_BANDS as readonly string[]).includes(value);
}

function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === "string" && (CONNECTION_TYPES as readonly string[]).includes(value);
}

function isDirectionality(value: unknown): value is Directionality {
  return typeof value === "string" && (DIRECTIONALITIES as readonly string[]).includes(value);
}

function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
