import {
  type HydroCoastalStation,
  type HydroCoastalStationNodeMapping,
  validateHydroCoastalStationNodeMapping,
  validateHydroCoastalStation
} from "./hydro-coastal";
import {
  type HabitatGraph,
  haversineDistanceKm,
  roundDistanceKm
} from "./habitat";
import {
  JMA_TIDE_PREDICTION_PROVIDER_ID,
  JMA_TIDE_PREDICTION_STATIONS_2026
} from "./jma-tide-prediction";

export const JMA_TIDE_PREDICTION_MAPPING_VERSION = "jma-tide-prediction-habitat-mapping.2026.v1";
export const JMA_TIDE_PREDICTION_MAPPING_VALID_FROM = "2025-12-31T15:00:00.000Z";
export const JMA_TIDE_PREDICTION_MAPPING_VALID_TO = "2026-12-31T15:00:00.000Z";

export type JmaTidePredictionMappingTarget2026 = {
  stationId: string;
  habitatNodeId: string;
  rationale: string;
  proxy: boolean;
};

export type JmaTidePredictionMappingBuildInput = {
  habitatGraph: HabitatGraph;
  reviewedAt: string;
  stations?: readonly HydroCoastalStation[];
};

export type JmaTidePredictionMappingBuildResult = {
  mappingVersion: string;
  mappings: HydroCoastalStationNodeMapping[];
  errors: string[];
  warnings: string[];
};

export const JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026: readonly JmaTidePredictionMappingTarget2026[] = [
  {
    stationId: "TK",
    habitatNodeId: "tokyo-inner-bay-01",
    rationale: "Tokyo inner-bay primary tide anchor; avoids river-mouth-specific interpretation even if a river mouth node may be geographically closer.",
    proxy: false
  },
  {
    stationId: "CB",
    habitatNodeId: "makuhari-shallow-01",
    rationale: "Eastern inner-bay / Makuhari shallow anchor.",
    proxy: false
  },
  {
    stationId: "KZ",
    habitatNodeId: "kisarazu-north-01",
    rationale: "Northern Uchibo / Kisarazu anchor.",
    proxy: false
  },
  {
    stationId: "QS",
    habitatNodeId: "keihin-canal-01",
    rationale: "Western urban-bay provisional proxy because the current Habitat Graph has no dedicated Yokohama node.",
    proxy: true
  },
  {
    stationId: "TT",
    habitatNodeId: "tateyama-north-01",
    rationale: "Tateyama / southern Uchibo anchor.",
    proxy: false
  }
];

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROVENANCE_SOURCE = "docs/wanoku-jma-tide-prediction-habitat-mapping.md";

export function buildJmaTidePredictionStationNodeMappings2026(
  input: JmaTidePredictionMappingBuildInput
): JmaTidePredictionMappingBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stations = input.stations ?? JMA_TIDE_PREDICTION_STATIONS_2026;
  const stationById = new Map<string, HydroCoastalStation>();
  const nodeById = new Map(input.habitatGraph.nodes.map((node) => [node.id, node]));
  const nodeIdCounts = countBy(input.habitatGraph.nodes.map((node) => node.id));
  const targetStationCounts = countBy(JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026.map((target) => target.stationId));
  const targetPairCounts = countBy(JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026.map((target) => `${target.stationId}|${target.habitatNodeId}`));

  if (!isCanonicalUtcIsoDateTime(input.reviewedAt)) {
    errors.push("reviewedAt must be canonical UTC ISO datetime.");
  }

  for (const [nodeId, count] of nodeIdCounts.entries()) {
    if (count > 1) errors.push(`duplicate habitat node id in graph: ${nodeId}.`);
  }
  for (const [stationId, count] of targetStationCounts.entries()) {
    if (count > 1) errors.push(`duplicate mapping target stationId: ${stationId}.`);
  }
  for (const [pair, count] of targetPairCounts.entries()) {
    if (count > 1) errors.push(`duplicate mapping target station/node pair: ${pair}.`);
  }

  for (const station of stations) {
    if (stationById.has(station.stationId)) {
      errors.push(`duplicate stationId in stations: ${station.stationId}.`);
      continue;
    }
    stationById.set(station.stationId, station);
    if (station.providerId !== JMA_TIDE_PREDICTION_PROVIDER_ID) {
      errors.push(`station ${station.stationId}: providerId must be ${JMA_TIDE_PREDICTION_PROVIDER_ID}.`);
    }
    const stationValidation = validateHydroCoastalStation(station);
    if (!stationValidation.valid) {
      errors.push(...stationValidation.errors.map((error) => `station ${station.stationId}: ${error}`));
    }
  }

  const mappings: HydroCoastalStationNodeMapping[] = [];
  for (const target of JMA_TIDE_PREDICTION_MAPPING_TARGETS_2026) {
    const station = stationById.get(target.stationId);
    const node = nodeById.get(target.habitatNodeId);
    if (!station) {
      errors.push(`missing JMA tide prediction station: ${target.stationId}.`);
      continue;
    }
    if (!node) {
      errors.push(`missing habitat node for mapping target: ${target.habitatNodeId}.`);
      continue;
    }
    if (!isCanonicalUtcIsoDateTime(input.reviewedAt)) continue;

    const mapping: HydroCoastalStationNodeMapping = {
      providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
      stationId: target.stationId,
      habitatNodeId: target.habitatNodeId,
      mappingMethod: "manual-reviewed",
      distanceKm: roundDistanceKm(haversineDistanceKm(
        station.latitude,
        station.longitude,
        node.latitude,
        node.longitude
      )),
      confidence: null,
      validFrom: JMA_TIDE_PREDICTION_MAPPING_VALID_FROM,
      validTo: JMA_TIDE_PREDICTION_MAPPING_VALID_TO,
      provenance: {
        source: PROVENANCE_SOURCE,
        reviewedAt: input.reviewedAt,
        notes: [
          JMA_TIDE_PREDICTION_MAPPING_VERSION,
          target.rationale,
          "Primary anchor mapping; not propagated to other habitat nodes.",
          "Not selected by nearest-neighbor or distance-only logic.",
          "Distance is audit metadata calculated after manual target selection.",
          ...(target.proxy ? ["Provisional proxy anchor because no dedicated habitat node exists in the current graph."] : [])
        ]
      }
    };
    const mappingValidation = validateHydroCoastalStationNodeMapping(mapping);
    if (!mappingValidation.valid) {
      errors.push(...mappingValidation.errors.map((error) => `mapping ${target.stationId}->${target.habitatNodeId}: ${error}`));
      continue;
    }
    warnings.push(...mappingValidation.warnings);
    mappings.push(mapping);
  }

  return {
    mappingVersion: JMA_TIDE_PREDICTION_MAPPING_VERSION,
    mappings: errors.length === 0 ? mappings : [],
    errors: unique(errors),
    warnings: unique(warnings)
  };
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
