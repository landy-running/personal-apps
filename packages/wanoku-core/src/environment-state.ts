import { calculateEnvironmentalQuality, type EnvironmentalQualityReport, type EnvironmentalSnapshot } from "./environment";
import {
  NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION,
  buildNodeEnvironmentalFeatures,
  type EnvironmentalFeatureProvenance,
  type NodeEnvironmentalDataQuality
} from "./environment-features";
import { type HabitatGraph } from "./habitat";
import { type HydroCoastalObservation, type HydroCoastalStationNodeMapping } from "./hydro-coastal";
import {
  NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION,
  buildHydroCoastalFeatureSet,
  type HydroCoastalFeatureMissingReason,
  type HydroCoastalFeatureProvenance,
  type NodeHydroCoastalDataQuality,
  type TideTrendDirection
} from "./hydro-coastal-features";

export const ENVIRONMENT_STATE_SCHEMA_VERSION = "wanoku-environment-state.v1";

export type EnvironmentStateTidePhase = "rising" | "falling" | "slack" | "unknown";

export type EnvironmentStateTide = {
  levelCm: number | null;
  levelM: number | null;
  levelTpM: number | null;
  slopeCmPerHour: number | null;
  phase: EnvironmentStateTidePhase;
  stationId: string | null;
  observedAt: string | null;
  sourceCollectedAt: string | null;
  forecastIssuedAt: string | null;
};

export type EnvironmentStateAtmosphere = {
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  precipitationMm: number | null;
  pressureHpa: number | null;
  airTemperatureC: number | null;
  sourceCollectedAt: string | null;
  sourceProviderIds: string[];
};

export type EnvironmentStateMarine = {
  waterTemperatureC: number | null;
  waveHeightM: number | null;
  wavePeriodS: number | null;
  waveDirectionDeg: number | null;
  currentSpeedMps: number | null;
  currentDirectionDeg: number | null;
  seaLevelM: number | null;
  sourceCollectedAt: string | null;
  sourceProviderIds: string[];
};

export type EnvironmentStateFreshnessComponent = {
  sourceTimestamp: string | null;
  ageHours: number | null;
  freshness: number | null;
  stale: boolean | null;
};

export type EnvironmentStateFreshness = {
  atmosphere: EnvironmentStateFreshnessComponent;
  tide: EnvironmentStateFreshnessComponent;
  missingComponents: string[];
};

export type EnvironmentStateQuality = {
  atmosphere: NodeEnvironmentalDataQuality;
  tide: NodeHydroCoastalDataQuality | null;
  overall: {
    confidence: number | null;
    missingRate: number;
    missingComponentCount: number;
    missingComponents: string[];
    staleComponents: string[];
  };
};

export type EnvironmentStateProvenance = {
  habitatGraphVersion: string;
  environmentalFeatureSchemaVersion: typeof NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION;
  hydroCoastalFeatureSchemaVersion: typeof NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION;
  environmental: EnvironmentalFeatureProvenance[];
  tide: HydroCoastalFeatureProvenance[];
};

export type EnvironmentStateDiagnostics = {
  environmentalErrors: string[];
  environmentalWarnings: string[];
  hydroCoastalErrors: string[];
  hydroCoastalWarnings: string[];
  tideMissingReasons: HydroCoastalFeatureMissingReason[];
};

export type EnvironmentState = {
  schemaVersion: typeof ENVIRONMENT_STATE_SCHEMA_VERSION;
  nodeId: string;
  asOf: string;
  tide: EnvironmentStateTide;
  atmosphere: EnvironmentStateAtmosphere;
  marine: EnvironmentStateMarine;
  freshness: EnvironmentStateFreshness;
  quality: EnvironmentStateQuality;
  provenance: EnvironmentStateProvenance;
  diagnostics: EnvironmentStateDiagnostics;
};

export type BuildEnvironmentStateInput = {
  nodeId: string;
  asOf: string;
  habitatGraph: HabitatGraph;
  environmentalSnapshots?: readonly EnvironmentalSnapshot[];
  environmentalQualityReports?: readonly EnvironmentalQualityReport[];
  hydroCoastalObservations?: readonly HydroCoastalObservation[];
  hydroCoastalStationNodeMappings?: readonly HydroCoastalStationNodeMapping[];
};

const STATE_COMPONENTS = [
  "tide.levelCm",
  "tide.slopeCmPerHour",
  "atmosphere.windSpeedMps",
  "atmosphere.windDirectionDeg",
  "atmosphere.precipitationMm",
  "atmosphere.pressureHpa",
  "atmosphere.airTemperatureC",
  "marine.waterTemperatureC",
  "marine.waveHeightM",
  "marine.wavePeriodS",
  "marine.waveDirectionDeg",
  "marine.currentSpeedMps",
  "marine.currentDirectionDeg",
  "marine.seaLevelM"
] as const;

const MARINE_FEATURE_FIELDS = [
  "waterTemperatureC",
  "waveHeightM",
  "wavePeriodS",
  "waveDirectionDeg",
  "currentSpeedMps",
  "currentDirectionDeg",
  "seaLevelM"
] as const;

export function buildEnvironmentState(input: BuildEnvironmentStateInput): EnvironmentState {
  const environmentalSnapshots = input.environmentalSnapshots ?? [];
  const environmentalQualityReports = input.environmentalQualityReports
    ?? environmentalSnapshots.map((snapshot) => calculateEnvironmentalQuality(snapshot, input.asOf));
  const environmentalFeature = buildNodeEnvironmentalFeatures({
    nodeId: input.nodeId,
    snapshots: environmentalSnapshots,
    qualityReports: environmentalQualityReports,
    calculatedAt: input.asOf
  });

  const hydroCoastalResult = buildHydroCoastalFeatureSet({
    observations: input.hydroCoastalObservations ?? [],
    mappings: input.hydroCoastalStationNodeMappings ?? [],
    habitatGraph: input.habitatGraph,
    calculatedAt: input.asOf,
    targetAt: input.asOf
  });
  const hydroCoastalFeature = hydroCoastalResult.features.find((feature) => feature.nodeId === input.nodeId) ?? null;

  const tide: EnvironmentStateTide = {
    levelCm: hydroCoastalFeature?.tideLevelCm ?? null,
    levelM: hydroCoastalFeature?.tideLevelM ?? null,
    levelTpM: hydroCoastalFeature?.tideLevelTpM ?? null,
    slopeCmPerHour: hydroCoastalFeature?.rate1hCmPerHour ?? null,
    phase: tidePhaseFromTrend(hydroCoastalFeature?.trend1h ?? "unknown"),
    stationId: hydroCoastalFeature?.stationId ?? null,
    observedAt: hydroCoastalFeature?.tideLevelCm == null ? null : hydroCoastalFeature.targetAt,
    sourceCollectedAt: hydroCoastalFeature?.sourceCollectedAt ?? null,
    forecastIssuedAt: hydroCoastalFeature?.forecastIssuedAt ?? null
  };
  const atmosphere: EnvironmentStateAtmosphere = {
    windSpeedMps: environmentalFeature.windSpeedMps,
    windDirectionDeg: environmentalFeature.windDirectionDeg,
    precipitationMm: environmentalFeature.precipitationMm,
    pressureHpa: environmentalFeature.pressureHpa,
    airTemperatureC: environmentalFeature.airTemperatureC,
    sourceCollectedAt: environmentalFeature.sourceCollectedAt,
    sourceProviderIds: environmentalFeature.sourceProviderIds
  };
  const marineSource = componentSourceMetadata(environmentalFeature.provenance, MARINE_FEATURE_FIELDS);
  const marine: EnvironmentStateMarine = {
    waterTemperatureC: environmentalFeature.waterTemperatureC,
    waveHeightM: environmentalFeature.waveHeightM,
    wavePeriodS: environmentalFeature.wavePeriodS,
    waveDirectionDeg: environmentalFeature.waveDirectionDeg,
    currentSpeedMps: environmentalFeature.currentSpeedMps,
    currentDirectionDeg: environmentalFeature.currentDirectionDeg,
    seaLevelM: environmentalFeature.seaLevelM,
    sourceCollectedAt: marineSource.sourceCollectedAt,
    sourceProviderIds: marineSource.sourceProviderIds
  };
  const missingComponents = missingStateComponents(tide, atmosphere, marine);
  const staleComponents = [
    ...(environmentalFeature.dataQuality.staleCount > 0 ? ["atmosphere"] : [])
  ];

  return {
    schemaVersion: ENVIRONMENT_STATE_SCHEMA_VERSION,
    nodeId: input.nodeId,
    asOf: input.asOf,
    tide,
    atmosphere,
    marine,
    freshness: {
      atmosphere: {
        sourceTimestamp: atmosphere.sourceCollectedAt,
        ageHours: ageHours(atmosphere.sourceCollectedAt, input.asOf),
        freshness: environmentalFeature.freshness,
        stale: environmentalFeature.dataQuality.qualityReportCount > 0
          ? environmentalFeature.dataQuality.staleCount > 0
          : null
      },
      tide: {
        sourceTimestamp: tide.sourceCollectedAt,
        ageHours: ageHours(tide.sourceCollectedAt, input.asOf),
        freshness: null,
        stale: null
      },
      missingComponents
    },
    quality: {
      atmosphere: environmentalFeature.dataQuality,
      tide: hydroCoastalFeature?.dataQuality ?? null,
      overall: {
        confidence: overallConfidence(environmentalFeature.confidence, hydroCoastalFeature?.dataQuality.confidence ?? null),
        missingRate: round(missingComponents.length / STATE_COMPONENTS.length, 6),
        missingComponentCount: missingComponents.length,
        missingComponents,
        staleComponents
      }
    },
    provenance: {
      habitatGraphVersion: input.habitatGraph.version,
      environmentalFeatureSchemaVersion: NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION,
      hydroCoastalFeatureSchemaVersion: NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION,
      environmental: environmentalFeature.provenance,
      tide: hydroCoastalFeature?.provenance ?? []
    },
    diagnostics: {
      environmentalErrors: environmentalFeature.errors,
      environmentalWarnings: environmentalFeature.warnings,
      hydroCoastalErrors: unique([
        ...hydroCoastalResult.errors,
        ...(hydroCoastalFeature?.errors ?? [])
      ]),
      hydroCoastalWarnings: unique([
        ...hydroCoastalResult.warnings,
        ...(hydroCoastalFeature?.warnings ?? [])
      ]),
      tideMissingReasons: hydroCoastalFeature?.missingReasons ?? []
    }
  };
}

export function tidePhaseFromTrend(trend: TideTrendDirection): EnvironmentStateTidePhase {
  if (trend === "rising" || trend === "falling") return trend;
  if (trend === "steady") return "slack";
  return "unknown";
}

function missingStateComponents(
  tide: EnvironmentStateTide,
  atmosphere: EnvironmentStateAtmosphere,
  marine: EnvironmentStateMarine
): string[] {
  const missing: string[] = [];
  if (tide.levelCm == null) missing.push("tide.levelCm");
  if (tide.slopeCmPerHour == null) missing.push("tide.slopeCmPerHour");
  if (atmosphere.windSpeedMps == null) missing.push("atmosphere.windSpeedMps");
  if (atmosphere.windDirectionDeg == null) missing.push("atmosphere.windDirectionDeg");
  if (atmosphere.precipitationMm == null) missing.push("atmosphere.precipitationMm");
  if (atmosphere.pressureHpa == null) missing.push("atmosphere.pressureHpa");
  if (atmosphere.airTemperatureC == null) missing.push("atmosphere.airTemperatureC");
  if (marine.waterTemperatureC == null) missing.push("marine.waterTemperatureC");
  if (marine.waveHeightM == null) missing.push("marine.waveHeightM");
  if (marine.wavePeriodS == null) missing.push("marine.wavePeriodS");
  if (marine.waveDirectionDeg == null) missing.push("marine.waveDirectionDeg");
  if (marine.currentSpeedMps == null) missing.push("marine.currentSpeedMps");
  if (marine.currentDirectionDeg == null) missing.push("marine.currentDirectionDeg");
  if (marine.seaLevelM == null) missing.push("marine.seaLevelM");
  return missing;
}

function componentSourceMetadata(
  provenance: readonly EnvironmentalFeatureProvenance[],
  fields: readonly string[]
): { sourceCollectedAt: string | null; sourceProviderIds: string[] } {
  const fieldSet = new Set(fields);
  const matched = provenance.filter((entry) => fieldSet.has(entry.field) && (entry.sampleCount ?? 0) > 0);
  const collectedTimes = matched.flatMap((entry) => [
    entry.collectedAt,
    ...(entry.sourceCollectedAts ?? [])
  ]).filter((value): value is string => Boolean(value));
  const sourceCollectedAt = collectedTimes
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)
    .at(0);
  const sourceProviderIds = [...new Set(matched.flatMap((entry) => [
    entry.providerId,
    ...(entry.providerIds ?? [])
  ]).filter((value): value is string => Boolean(value)))].sort();

  return {
    sourceCollectedAt: sourceCollectedAt == null ? null : new Date(sourceCollectedAt).toISOString(),
    sourceProviderIds
  };
}

function ageHours(sourceTimestamp: string | null | undefined, asOf: string): number | null {
  if (!sourceTimestamp) return null;
  const sourceMs = Date.parse(sourceTimestamp);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(sourceMs) || !Number.isFinite(asOfMs)) return null;
  return round(Math.max(0, (asOfMs - sourceMs) / 3_600_000), 6);
}

function overallConfidence(environmentalConfidence: number | null, tideConfidence: number | null): number | null {
  const values = [environmentalConfidence, tideConfidence].filter(isFiniteNumber);
  if (!values.length) return null;
  return round(Math.min(...values), 6);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
