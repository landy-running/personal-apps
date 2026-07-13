import {
  ENVIRONMENTAL_SCHEMA_VERSION,
  environmentalSnapshotKey,
  type EnvironmentalQualityReport,
  type EnvironmentalSnapshot
} from "./environment";
import { type HabitatGraph } from "./habitat";

export const NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION = "wanoku-node-environmental-features.v1";

export const FEATURE_WINDOW_KEYS = ["latest", "3h", "6h", "12h", "24h"] as const;

export type FeatureWindowKey = typeof FEATURE_WINDOW_KEYS[number];

export type WindowMetricField =
  | "airTemperatureC"
  | "waterTemperatureC"
  | "windSpeedMps"
  | "waveHeightM"
  | "currentSpeedMps"
  | "seaLevelM"
  | "pressureHpa";

export type DirectionConvention = "toward" | "from" | "unknown";

export type DirectionConventionSet = {
  wind?: DirectionConvention;
  wave?: DirectionConvention;
  current?: DirectionConvention;
};

export type MissingReason =
  | "source-missing"
  | "insufficient-samples"
  | "unsupported-direction-convention"
  | "invalid-source-value"
  | "no-matching-node"
  | "future-source-excluded"
  | "conflicting-source-snapshot"
  | "zero-denominator"
  | "zero-vector-magnitude"
  | "multiple-providers-no-aggregation-policy";

export type EnvironmentalFeatureProvenance = {
  field: string;
  providerId?: string;
  providerIds?: string[];
  collectedAt?: string | null;
  sourceCollectedAts?: string[];
  snapshotSchemaVersion?: string;
  nodeId: string;
  window?: FeatureWindowKey;
  sampleCount?: number;
  invalidSampleCount?: number;
  firstCollectedAt?: string | null;
  lastCollectedAt?: string | null;
  sourceFields?: string[];
  missingReasons: MissingReason[];
};

export type ProviderQualitySummary = {
  providerId: string;
  qualityReportCount: number;
  staleCount: number;
  warningCounts: Record<string, number>;
  missingRate: number | null;
  confidence: number | null;
  freshness: number | null;
};

export type NodeEnvironmentalDataQuality = {
  qualityReportCount: number;
  staleCount: number;
  warningCounts: Record<string, number>;
  missingRate: number | null;
  confidence: number | null;
  freshness: number | null;
  providerQuality: Record<string, ProviderQualitySummary>;
};

export type WindowFeatures = {
  sampleCount: number;
  invalidSampleCount: number;
  providerIds: string[];
  firstCollectedAt: string | null;
  lastCollectedAt: string | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  change: number | null;
  ratePerHour: number | null;
  volatility: number | null;
  missingReasons: MissingReason[];
};

export type NodeEnvironmentalWindows = Record<FeatureWindowKey, Partial<Record<WindowMetricField, WindowFeatures>>>;

export type ProviderNodeEnvironmentalWindows = Record<
  FeatureWindowKey,
  Partial<Record<WindowMetricField, Record<string, WindowFeatures>>>
>;

export type NodeEnvironmentalFeatures = {
  schemaVersion: string;
  nodeId: string;
  calculatedAt: string;
  sourceCollectedAt: string | null;
  sourceProviderIds: string[];
  inputSnapshotCount: number;
  sourceSnapshotCount: number;
  excludedSnapshotCount: number;
  dataQuality: NodeEnvironmentalDataQuality;
  freshness: number | null;

  airTemperatureC: number | null;
  waterTemperatureC: number | null;
  windSpeedMps: number | null;
  windGustMps: number | null;
  windDirectionDeg: number | null;
  waveHeightM: number | null;
  wavePeriodS: number | null;
  waveDirectionDeg: number | null;
  currentSpeedMps: number | null;
  currentDirectionDeg: number | null;
  seaLevelM: number | null;
  pressureHpa: number | null;
  precipitationMm: number | null;

  windVectorEast: number | null;
  windVectorNorth: number | null;
  waveVectorEast: number | null;
  waveVectorNorth: number | null;
  currentVectorEast: number | null;
  currentVectorNorth: number | null;
  windWaveAlignment: number | null;
  windCurrentAlignment: number | null;
  waveCurrentAlignment: number | null;
  temperatureDifferenceC: number | null;
  gustFactor: number | null;
  environmentalVolatility: number | null;
  missingRate: number;
  confidence: number | null;

  windows: NodeEnvironmentalWindows;
  providerWindows: ProviderNodeEnvironmentalWindows;
  provenance: EnvironmentalFeatureProvenance[];
  missingReasons: Partial<Record<string, MissingReason[]>>;
  errors: string[];
  warnings: string[];
};

export type FeatureValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type SnapshotHabitatNodeMapping = {
  snapshotsByNodeId: Map<string, EnvironmentalSnapshot[]>;
  unmatchedSnapshotNodeIds: string[];
};

export type BuildNodeEnvironmentalFeaturesInput = {
  nodeId: string;
  snapshots: readonly EnvironmentalSnapshot[];
  qualityReports?: readonly EnvironmentalQualityReport[];
  calculatedAt: string;
  windowHours?: readonly Exclude<FeatureWindowKey, "latest">[];
  directionConventions?: DirectionConventionSet;
};

export type BuildEnvironmentalFeatureSetInput = {
  snapshots: readonly EnvironmentalSnapshot[];
  qualityReports?: readonly EnvironmentalQualityReport[];
  habitatGraph: HabitatGraph;
  calculatedAt: string;
  windowHours?: readonly Exclude<FeatureWindowKey, "latest">[];
  directionConventions?: DirectionConventionSet;
};

export type BuildEnvironmentalFeatureSetResult = {
  features: NodeEnvironmentalFeatures[];
  errors: string[];
  warnings: string[];
  unmatchedSnapshotNodeIds: string[];
  nodesWithoutSnapshots: string[];
};

type RawFeatureField =
  | "airTemperatureC"
  | "waterTemperatureC"
  | "windSpeedMps"
  | "windGustMps"
  | "windDirectionDeg"
  | "waveHeightM"
  | "wavePeriodS"
  | "waveDirectionDeg"
  | "currentSpeedMps"
  | "currentDirectionDeg"
  | "seaLevelM"
  | "pressureHpa"
  | "precipitationMm";

type VectorField =
  | "windVectorEast"
  | "windVectorNorth"
  | "waveVectorEast"
  | "waveVectorNorth"
  | "currentVectorEast"
  | "currentVectorNorth";

type RawFieldSpec = {
  featureField: RawFeatureField;
  snapshotField: keyof EnvironmentalSnapshot;
  nonNegative?: boolean;
  direction?: boolean;
};

type LatestFieldValue = {
  value: number | null;
  source: EnvironmentalSnapshot | null;
  providerIds: string[];
  sourceCollectedAts: string[];
  invalidSampleCount: number;
  missingReasons: MissingReason[];
  errors: string[];
  warnings: string[];
};

type Vector2D = {
  east: number;
  north: number;
};

type VectorBuildResult = {
  vector: Vector2D | null;
  missingReasons: MissingReason[];
  providerIds: string[];
  sourceCollectedAts: string[];
  sourceFields: string[];
};

type PreparedSnapshots = {
  snapshots: EnvironmentalSnapshot[];
  errors: string[];
  warnings: string[];
  excludedSnapshotCount: number;
  conflictingIdentityKeys: string[];
};

type MatchedQualityReport = {
  report: EnvironmentalQualityReport;
  providerId: string;
};

type PreparedQualityReports = {
  matched: MatchedQualityReport[];
  errors: string[];
  warnings: string[];
};

type WindowBuildResult = {
  windows: NodeEnvironmentalWindows;
  providerWindows: ProviderNodeEnvironmentalWindows;
  provenance: EnvironmentalFeatureProvenance[];
  warnings: string[];
};

type WindowSample = {
  snapshot: EnvironmentalSnapshot;
  value: number;
};

type WindowSampleSet = {
  validSamples: WindowSample[];
  invalidSampleCount: number;
  invalidReasons: MissingReason[];
  invalidReasonsByProvider: Record<string, MissingReason[]>;
  providerIds: string[];
  warnings: string[];
};

type RuntimeOptions = {
  directionConventions: DirectionConventionSet;
  windowHours: Exclude<FeatureWindowKey, "latest">[];
  errors: string[];
  warnings: string[];
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_RFC3339_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const DEFAULT_WINDOW_HOURS: readonly Exclude<FeatureWindowKey, "latest">[] = ["3h", "6h", "12h", "24h"];
const VALID_DIRECTION_CONVENTIONS = ["toward", "from", "unknown"] as const;
const VALID_WINDOW_HOURS = ["3h", "6h", "12h", "24h"] as const;

const RAW_FIELD_SPECS: readonly RawFieldSpec[] = [
  { featureField: "airTemperatureC", snapshotField: "airTemperature" },
  { featureField: "waterTemperatureC", snapshotField: "seaSurfaceTemperature" },
  { featureField: "windSpeedMps", snapshotField: "windSpeed", nonNegative: true },
  { featureField: "windGustMps", snapshotField: "windGust", nonNegative: true },
  { featureField: "windDirectionDeg", snapshotField: "windDirection", direction: true },
  { featureField: "waveHeightM", snapshotField: "waveHeight", nonNegative: true },
  { featureField: "wavePeriodS", snapshotField: "wavePeriod", nonNegative: true },
  { featureField: "waveDirectionDeg", snapshotField: "waveDirection", direction: true },
  { featureField: "currentSpeedMps", snapshotField: "oceanCurrentVelocity", nonNegative: true },
  { featureField: "currentDirectionDeg", snapshotField: "oceanCurrentDirection", direction: true },
  { featureField: "seaLevelM", snapshotField: "seaLevelHeightMsl" },
  { featureField: "pressureHpa", snapshotField: "pressure" },
  { featureField: "precipitationMm", snapshotField: "precipitation", nonNegative: true }
];

const WINDOW_FIELD_SPECS: readonly RawFieldSpec[] = [
  { featureField: "airTemperatureC", snapshotField: "airTemperature" },
  { featureField: "waterTemperatureC", snapshotField: "seaSurfaceTemperature" },
  { featureField: "windSpeedMps", snapshotField: "windSpeed", nonNegative: true },
  { featureField: "waveHeightM", snapshotField: "waveHeight", nonNegative: true },
  { featureField: "currentSpeedMps", snapshotField: "oceanCurrentVelocity", nonNegative: true },
  { featureField: "seaLevelM", snapshotField: "seaLevelHeightMsl" },
  { featureField: "pressureHpa", snapshotField: "pressure" }
];

export function normalizeDirectionDegrees(direction: number): number | null {
  if (!Number.isFinite(direction)) return null;
  return round(((direction % 360) + 360) % 360, 6);
}

export function circularDifferenceDegrees(left: number, right: number): number | null {
  const normalizedLeft = normalizeDirectionDegrees(left);
  const normalizedRight = normalizeDirectionDegrees(right);
  if (normalizedLeft == null || normalizedRight == null) return null;
  const diff = Math.abs(normalizedLeft - normalizedRight);
  return Math.min(diff, 360 - diff);
}

export function calculateCircularMeanDegrees(directions: readonly number[]): number | null {
  const normalized = directions
    .map((direction) => normalizeDirectionDegrees(direction))
    .filter((direction): direction is number => direction != null);
  if (!normalized.length) return null;

  const sum = normalized.reduce((acc, direction) => {
    const radians = direction * Math.PI / 180;
    return {
      sin: acc.sin + Math.sin(radians),
      cos: acc.cos + Math.cos(radians)
    };
  }, { sin: 0, cos: 0 });

  if (Math.abs(sum.sin) < 1e-12 && Math.abs(sum.cos) < 1e-12) return null;
  const degrees = Math.atan2(sum.sin, sum.cos) * 180 / Math.PI;
  return normalizeDirectionDegrees(degrees);
}

export function vectorFromSpeedAndDirection(
  speed: number | null | undefined,
  directionDegrees: number | null | undefined,
  directionConvention: DirectionConvention
): Vector2D | null {
  if (
    !isFiniteNumber(speed)
    || speed < 0
    || !isFiniteNumber(directionDegrees)
    || !isValidDirectionConvention(directionConvention)
    || directionConvention === "unknown"
  ) {
    return null;
  }
  const normalizedDirection = normalizeDirectionDegrees(directionDegrees);
  if (normalizedDirection == null) return null;
  const towardDirection = directionConvention === "from"
    ? normalizeDirectionDegrees(normalizedDirection + 180)
    : normalizedDirection;
  if (towardDirection == null) return null;
  const radians = towardDirection * Math.PI / 180;
  return {
    east: round(speed * Math.sin(radians), 6),
    north: round(speed * Math.cos(radians), 6)
  };
}

export function calculateDirectionalAlignment(leftDirectionDegrees: number, rightDirectionDegrees: number): number | null {
  const diff = circularDifferenceDegrees(leftDirectionDegrees, rightDirectionDegrees);
  if (diff == null) return null;
  return round(Math.cos(diff * Math.PI / 180), 6);
}

export function mapSnapshotsToHabitatNodes(
  snapshots: readonly EnvironmentalSnapshot[],
  habitatGraph: HabitatGraph
): SnapshotHabitatNodeMapping {
  const nodeIds = new Set(habitatGraph.nodes.map((node) => node.id));
  const snapshotsByNodeId = new Map<string, EnvironmentalSnapshot[]>();
  const unmatched = new Set<string>();

  for (const node of habitatGraph.nodes) {
    snapshotsByNodeId.set(node.id, []);
  }
  for (const snapshot of snapshots) {
    const nodeId = snapshot.nodeId || "";
    if (!nodeId || !nodeIds.has(nodeId)) {
      unmatched.add(nodeId);
      continue;
    }
    snapshotsByNodeId.get(nodeId)?.push(snapshot);
  }

  return {
    snapshotsByNodeId,
    unmatchedSnapshotNodeIds: Array.from(unmatched).sort()
  };
}

export function findSnapshotsWithoutHabitatNode(
  snapshots: readonly EnvironmentalSnapshot[],
  habitatGraph: HabitatGraph
): string[] {
  return mapSnapshotsToHabitatNodes(snapshots, habitatGraph).unmatchedSnapshotNodeIds;
}

export function findHabitatNodesWithoutSnapshots(
  habitatGraph: HabitatGraph,
  snapshots: readonly EnvironmentalSnapshot[]
): string[] {
  const nodeIdsWithSnapshots = new Set(snapshots.map((snapshot) => snapshot.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)));
  return habitatGraph.nodes
    .map((node) => node.id)
    .filter((nodeId) => !nodeIdsWithSnapshots.has(nodeId));
}

export function buildEnvironmentalFeatureSet(input: BuildEnvironmentalFeatureSetInput): BuildEnvironmentalFeatureSetResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isCanonicalUtcIsoDateTime(input.calculatedAt)) {
    errors.push("calculatedAt must be canonical UTC ISO datetime such as 2026-07-13T00:00:00.000Z.");
  }

  const mapping = mapSnapshotsToHabitatNodes(input.snapshots, input.habitatGraph);
  for (const unmatched of mapping.unmatchedSnapshotNodeIds) {
    warnings.push(`No matching habitat node for snapshot nodeId: ${unmatched || "(empty)"}`);
  }

  const graphNodeIds = new Set(input.habitatGraph.nodes.map((node) => node.id));
  for (const report of input.qualityReports ?? []) {
    if (!report.nodeId || !graphNodeIds.has(report.nodeId)) {
      warnings.push(`No matching habitat node for quality report nodeId: ${report.nodeId || "(empty)"}`);
    }
  }

  const features: NodeEnvironmentalFeatures[] = [];
  const nodesWithoutSnapshots: string[] = [];
  for (const node of input.habitatGraph.nodes) {
    const nodeSnapshots = mapping.snapshotsByNodeId.get(node.id) ?? [];
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: node.id,
      snapshots: nodeSnapshots,
      qualityReports: input.qualityReports?.filter((report) => report.nodeId === node.id) ?? [],
      calculatedAt: input.calculatedAt,
      windowHours: input.windowHours,
      directionConventions: input.directionConventions
    });
    if (feature.sourceSnapshotCount === 0) nodesWithoutSnapshots.push(node.id);
    const validation = validateNodeEnvironmentalFeatures(feature, feature.sourceSnapshotCount);
    errors.push(...feature.errors, ...validation.errors);
    warnings.push(...feature.warnings, ...validation.warnings);
    features.push(feature);
  }

  return {
    features,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    unmatchedSnapshotNodeIds: mapping.unmatchedSnapshotNodeIds,
    nodesWithoutSnapshots
  };
}

export function buildNodeEnvironmentalFeatures(input: BuildNodeEnvironmentalFeaturesInput): NodeEnvironmentalFeatures {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!input.nodeId.trim()) errors.push("nodeId must not be empty.");
  const calculatedAtValid = isCanonicalUtcIsoDateTime(input.calculatedAt);
  if (!calculatedAtValid) {
    errors.push("calculatedAt must be canonical UTC ISO datetime such as 2026-07-13T00:00:00.000Z.");
  }
  const runtimeOptions = normalizeRuntimeOptions(input);
  errors.push(...runtimeOptions.errors);
  warnings.push(...runtimeOptions.warnings);

  const prepared = prepareSnapshots(input.snapshots, input.calculatedAt, input.nodeId);
  errors.push(...prepared.errors);
  warnings.push(...prepared.warnings);

  const snapshots = sortSnapshots(prepared.snapshots);
  const snapshotByKey = new Map(snapshots.map((snapshot) => [environmentalSnapshotKey(snapshot), snapshot]));
  const preparedQuality = prepareQualityReports(input.qualityReports ?? [], snapshotByKey, input.calculatedAt, input.nodeId);
  errors.push(...preparedQuality.errors);
  warnings.push(...preparedQuality.warnings);

  const quality = summarizeQualityReports(preparedQuality.matched);
  const directionConventions = runtimeOptions.directionConventions;
  const rawValues = collectRawValues(snapshots);
  const missingReasons: Partial<Record<string, MissingReason[]>> = {};
  const provenance: EnvironmentalFeatureProvenance[] = [];

  for (const spec of RAW_FIELD_SPECS) {
    const raw = rawValues[spec.featureField];
    if (raw.value == null && raw.missingReasons.length) missingReasons[spec.featureField] = raw.missingReasons;
    errors.push(...raw.errors);
    warnings.push(...raw.warnings);
    provenance.push(provenanceForRawField(spec.featureField, input.nodeId, raw));
  }
  if (prepared.conflictingIdentityKeys.length) {
    for (const spec of RAW_FIELD_SPECS) {
      if (rawValues[spec.featureField].value == null) {
        missingReasons[spec.featureField] = uniqueReasons([
          ...(missingReasons[spec.featureField] ?? []),
          "conflicting-source-snapshot"
        ]);
      }
    }
  }

  const windVector = vectorForFeature(
    "wind",
    input.nodeId,
    rawValues.windSpeedMps,
    rawValues.windDirectionDeg,
    directionConventions.wind ?? "unknown",
    provenance,
    missingReasons
  );
  const waveVector = vectorForFeature(
    "wave",
    input.nodeId,
    rawValues.waveHeightM,
    rawValues.waveDirectionDeg,
    directionConventions.wave ?? "unknown",
    provenance,
    missingReasons
  );
  const currentVector = vectorForFeature(
    "current",
    input.nodeId,
    rawValues.currentSpeedMps,
    rawValues.currentDirectionDeg,
    directionConventions.current ?? "unknown",
    provenance,
    missingReasons
  );

  const windowResult = buildWindows(
    snapshots,
    input.calculatedAt,
    input.nodeId,
    runtimeOptions.windowHours
  );
  provenance.push(...windowResult.provenance);
  warnings.push(...windowResult.warnings);

  const sourceProviderIds = Array.from(new Set(snapshots.map((snapshot) => snapshot.source).filter(Boolean))).sort();
  const sourceCollectedAt = latestCanonicalCollectedAt(snapshots);

  const temperatureDifference = deriveTemperatureDifference(rawValues.airTemperatureC, rawValues.waterTemperatureC);
  const gustFactor = deriveGustFactor(rawValues.windSpeedMps, rawValues.windGustMps);
  const windWaveAlignment = deriveAlignment("windWaveAlignment", windVector, waveVector);
  const windCurrentAlignment = deriveAlignment("windCurrentAlignment", windVector, currentVector);
  const waveCurrentAlignment = deriveAlignment("waveCurrentAlignment", waveVector, currentVector);

  applyDerived(
    "temperatureDifferenceC",
    input.nodeId,
    temperatureDifference,
    ["waterTemperatureC", "airTemperatureC"],
    [rawValues.waterTemperatureC, rawValues.airTemperatureC],
    missingReasons,
    provenance
  );
  applyDerived(
    "gustFactor",
    input.nodeId,
    gustFactor,
    ["windGustMps", "windSpeedMps"],
    [rawValues.windGustMps, rawValues.windSpeedMps],
    missingReasons,
    provenance
  );
  applyAlignment("windWaveAlignment", input.nodeId, windWaveAlignment, windVector, waveVector, missingReasons, provenance);
  applyAlignment("windCurrentAlignment", input.nodeId, windCurrentAlignment, windVector, currentVector, missingReasons, provenance);
  applyAlignment("waveCurrentAlignment", input.nodeId, waveCurrentAlignment, waveVector, currentVector, missingReasons, provenance);

  if (Object.keys(quality.providerQuality).length > 1) {
    missingReasons.confidence = ["multiple-providers-no-aggregation-policy"];
    missingReasons.freshness = ["multiple-providers-no-aggregation-policy"];
    warnings.push("Multiple provider quality reports matched; confidence and freshness are not aggregated.");
  }

  const missingRawCount = RAW_FIELD_SPECS.filter((spec) => rawValues[spec.featureField].value == null).length;
  const feature: NodeEnvironmentalFeatures = {
    schemaVersion: NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION,
    nodeId: input.nodeId,
    calculatedAt: input.calculatedAt,
    sourceCollectedAt,
    sourceProviderIds,
    inputSnapshotCount: input.snapshots.length,
    sourceSnapshotCount: snapshots.length,
    excludedSnapshotCount: prepared.excludedSnapshotCount,
    dataQuality: quality,
    freshness: quality.freshness,

    airTemperatureC: rawValues.airTemperatureC.value,
    waterTemperatureC: rawValues.waterTemperatureC.value,
    windSpeedMps: rawValues.windSpeedMps.value,
    windGustMps: rawValues.windGustMps.value,
    windDirectionDeg: rawValues.windDirectionDeg.value,
    waveHeightM: rawValues.waveHeightM.value,
    wavePeriodS: rawValues.wavePeriodS.value,
    waveDirectionDeg: rawValues.waveDirectionDeg.value,
    currentSpeedMps: rawValues.currentSpeedMps.value,
    currentDirectionDeg: rawValues.currentDirectionDeg.value,
    seaLevelM: rawValues.seaLevelM.value,
    pressureHpa: rawValues.pressureHpa.value,
    precipitationMm: rawValues.precipitationMm.value,

    windVectorEast: windVector.vector?.east ?? null,
    windVectorNorth: windVector.vector?.north ?? null,
    waveVectorEast: waveVector.vector?.east ?? null,
    waveVectorNorth: waveVector.vector?.north ?? null,
    currentVectorEast: currentVector.vector?.east ?? null,
    currentVectorNorth: currentVector.vector?.north ?? null,
    windWaveAlignment: windWaveAlignment.value,
    windCurrentAlignment: windCurrentAlignment.value,
    waveCurrentAlignment: waveCurrentAlignment.value,
    temperatureDifferenceC: temperatureDifference.value,
    gustFactor: gustFactor.value,
    environmentalVolatility: null,
    missingRate: round(missingRawCount / RAW_FIELD_SPECS.length, 6),
    confidence: quality.confidence,

    windows: windowResult.windows,
    providerWindows: windowResult.providerWindows,
    provenance,
    missingReasons,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings))
  };

  for (const warning of feature.warnings) {
    const code = warningEventCode(warning);
    feature.dataQuality.warningCounts[code] = (feature.dataQuality.warningCounts[code] ?? 0) + 1;
  }

  return feature;
}

export function validateNodeEnvironmentalFeatures(
  features: NodeEnvironmentalFeatures,
  expectedSourceSnapshotCount?: number
): FeatureValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!features.nodeId.trim()) errors.push("nodeId must not be empty.");
  if (!isCanonicalUtcIsoDateTime(features.calculatedAt)) errors.push("calculatedAt must be canonical UTC ISO datetime.");
  if (features.sourceCollectedAt != null && !isCanonicalUtcIsoDateTime(features.sourceCollectedAt)) {
    errors.push("sourceCollectedAt must be canonical UTC ISO datetime when present.");
  }
  if (expectedSourceSnapshotCount != null && features.sourceSnapshotCount !== expectedSourceSnapshotCount) {
    errors.push(`sourceSnapshotCount ${features.sourceSnapshotCount} does not match expected used count ${expectedSourceSnapshotCount}.`);
  }
  if (!Number.isInteger(features.inputSnapshotCount) || features.inputSnapshotCount < 0) {
    errors.push("inputSnapshotCount must be a non-negative integer.");
  }
  if (!Number.isInteger(features.sourceSnapshotCount) || features.sourceSnapshotCount < 0) {
    errors.push("sourceSnapshotCount must be a non-negative integer.");
  }
  if (!Number.isInteger(features.excludedSnapshotCount) || features.excludedSnapshotCount < 0) {
    errors.push("excludedSnapshotCount must be a non-negative integer.");
  }
  if (features.inputSnapshotCount !== features.sourceSnapshotCount + features.excludedSnapshotCount) {
    errors.push("inputSnapshotCount must equal sourceSnapshotCount + excludedSnapshotCount.");
  }
  if (!isUnitInterval(features.missingRate)) errors.push("missingRate must be between 0 and 1.");
  if (features.confidence != null && !isUnitInterval(features.confidence)) errors.push("confidence must be null or between 0 and 1.");
  validateQualitySummary("dataQuality", features.dataQuality, errors);
  for (const [field, reasons] of Object.entries(features.missingReasons)) {
    if (reasons?.includes("invalid-source-value")) {
      errors.push(`${field} has invalid source value.`);
    }
  }

  for (const field of NUMERIC_FEATURE_FIELDS) {
    const value = features[field];
    if (value != null && !isFiniteNumber(value)) errors.push(`${field} must be finite when present.`);
  }
  for (const field of NON_NEGATIVE_FEATURE_FIELDS) {
    const value = features[field];
    if (value != null && value < 0) errors.push(`${field} must be non-negative when present.`);
  }
  for (const field of DIRECTION_FEATURE_FIELDS) {
    const value = features[field];
    if (value != null && (value < 0 || value >= 360)) errors.push(`${field} must be normalized to [0, 360).`);
  }

  validateWindows(features.windows, errors, warnings);
  validateWindowsByProvider(features.providerWindows, errors, warnings);

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings))
  };
}

function prepareSnapshots(snapshots: readonly EnvironmentalSnapshot[], calculatedAt: string, nodeId: string): PreparedSnapshots {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflictingIdentityKeys: string[] = [];
  let excludedSnapshotCount = 0;
  if (!isCanonicalUtcIsoDateTime(calculatedAt)) {
    return {
      snapshots: [],
      errors,
      warnings,
      excludedSnapshotCount: snapshots.length,
      conflictingIdentityKeys
    };
  }
  const calculatedAtMs = Date.parse(calculatedAt);
  const candidates: EnvironmentalSnapshot[] = [];

  for (const snapshot of snapshots) {
    const id = snapshotIdentityKey(snapshot);
    if (snapshot.nodeId !== nodeId) {
      warnings.push(`Snapshot excluded: nodeId ${snapshot.nodeId || "(empty)"} does not match input nodeId ${nodeId || "(empty)"}.`);
      excludedSnapshotCount += 1;
      continue;
    }
    const dateErrors = validateSnapshotDates(snapshot, "snapshot", id);
    if (dateErrors.length) {
      errors.push(...dateErrors);
      excludedSnapshotCount += 1;
      continue;
    }
    if (parseTime(snapshot.observedAt) > calculatedAtMs) {
      warnings.push(`Future snapshot excluded: ${id} observedAt is after calculatedAt.`);
      excludedSnapshotCount += 1;
      continue;
    }
    if (parseTime(snapshot.collectedAt) > calculatedAtMs) {
      warnings.push(`Future snapshot excluded: ${id} collectedAt is after calculatedAt.`);
      excludedSnapshotCount += 1;
      continue;
    }
    candidates.push(snapshot);
  }

  const byIdentity = new Map<string, EnvironmentalSnapshot[]>();
  for (const snapshot of candidates) {
    const key = snapshotIdentityKey(snapshot);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), snapshot]);
  }

  const used: EnvironmentalSnapshot[] = [];
  for (const [key, group] of byIdentity.entries()) {
    if (group.length === 1) {
      used.push(group[0]);
      continue;
    }
    const serializations = new Set(group.map((snapshot) => stableSerialize(snapshot)));
    if (serializations.size === 1) {
      warnings.push(`duplicate-source-snapshot: ${key}`);
      excludedSnapshotCount += group.length - 1;
      used.push(group[0]);
    } else {
      errors.push(`conflicting-source-snapshot: ${key}`);
      conflictingIdentityKeys.push(key);
      excludedSnapshotCount += group.length;
    }
  }

  return {
    snapshots: sortSnapshots(used),
    errors,
    warnings,
    excludedSnapshotCount,
    conflictingIdentityKeys
  };
}

function prepareQualityReports(
  qualityReports: readonly EnvironmentalQualityReport[],
  snapshotByKey: ReadonlyMap<string, EnvironmentalSnapshot>,
  calculatedAt: string,
  nodeId: string
): PreparedQualityReports {
  const errors: string[] = [];
  const warnings: string[] = [];
  const matched: MatchedQualityReport[] = [];
  if (!isCanonicalUtcIsoDateTime(calculatedAt)) {
    return { matched, errors, warnings };
  }
  const calculatedAtMs = Date.parse(calculatedAt);

  for (const report of qualityReports) {
    const id = report.snapshotKey || "(missing-snapshot-key)";
    if (report.nodeId !== nodeId) {
      warnings.push(`Quality report excluded: nodeId ${report.nodeId || "(empty)"} does not match input nodeId ${nodeId || "(empty)"}.`);
      continue;
    }
    const dateErrors = validateQualityDates(report, id);
    if (dateErrors.length) {
      errors.push(...dateErrors);
      continue;
    }
    if (parseTime(report.observedAt) > calculatedAtMs) {
      warnings.push(`Future quality report excluded: ${id} observedAt is after calculatedAt.`);
      continue;
    }
    if (parseTime(report.collectedAt) > calculatedAtMs) {
      warnings.push(`Future quality report excluded: ${id} collectedAt is after calculatedAt.`);
      continue;
    }
    const snapshot = snapshotByKey.get(report.snapshotKey);
    if (!snapshot) {
      warnings.push(`Unmatched quality report excluded: ${id}`);
      continue;
    }
    if (snapshot.nodeId !== report.nodeId) {
      warnings.push(`Quality report excluded: ${id} nodeId does not match matched snapshot.`);
      continue;
    }
    if (!qualityReportMatchesSnapshotDates(report, snapshot)) {
      warnings.push(`Quality report excluded: ${id} timestamps do not match matched snapshot.`);
      continue;
    }
    matched.push({ report, providerId: snapshot.source });
  }

  return { matched, errors, warnings };
}

function collectRawValues(snapshots: readonly EnvironmentalSnapshot[]): Record<RawFeatureField, LatestFieldValue> {
  return Object.fromEntries(
    RAW_FIELD_SPECS.map((spec) => [spec.featureField, latestFieldValue(snapshots, spec)])
  ) as Record<RawFeatureField, LatestFieldValue>;
}

function latestFieldValue(snapshots: readonly EnvironmentalSnapshot[], spec: RawFieldSpec): LatestFieldValue {
  const sorted = sortSnapshotsForLatest(snapshots);
  const errors: string[] = [];
  const warnings: string[] = [];
  let invalidSampleCount = 0;
  const invalidProviders = new Set<string>();
  const invalidCollectedAts = new Set<string>();

  for (const snapshot of sorted) {
    const value = snapshot[spec.snapshotField];
    if (value == null) continue;
    const sourceCollectedAt = toCanonicalUtcIso(snapshot.collectedAt);
    if (!isFiniteNumber(value)) {
      invalidSampleCount += 1;
      invalidProviders.add(snapshot.source);
      if (sourceCollectedAt) invalidCollectedAts.add(sourceCollectedAt);
      errors.push(`${spec.featureField} has invalid source value.`);
      continue;
    }
    if (spec.nonNegative && value < 0) {
      invalidSampleCount += 1;
      invalidProviders.add(snapshot.source);
      if (sourceCollectedAt) invalidCollectedAts.add(sourceCollectedAt);
      errors.push(`${spec.featureField} has invalid source value.`);
      continue;
    }
    if (invalidSampleCount > 0) {
      warnings.push(`${spec.featureField} used an older valid sample after excluding newer invalid source value.`);
    }
    return {
      value: spec.direction ? normalizeDirectionDegrees(value) : value,
      source: snapshot,
      providerIds: Array.from(new Set([snapshot.source, ...invalidProviders])).sort(),
      sourceCollectedAts: Array.from(new Set([sourceCollectedAt, ...invalidCollectedAts].filter((item): item is string => Boolean(item)))).sort(),
      invalidSampleCount,
      missingReasons: invalidSampleCount > 0 ? ["invalid-source-value"] : [],
      errors,
      warnings
    };
  }

  return {
    value: null,
    source: null,
    providerIds: Array.from(invalidProviders).sort(),
    sourceCollectedAts: Array.from(invalidCollectedAts).sort(),
    invalidSampleCount,
    missingReasons: invalidSampleCount > 0 ? ["invalid-source-value"] : ["source-missing"],
    errors,
    warnings
  };
}

function buildWindows(
  snapshots: readonly EnvironmentalSnapshot[],
  calculatedAt: string,
  nodeId: string,
  windowHours: readonly Exclude<FeatureWindowKey, "latest">[]
): WindowBuildResult {
  const windows = Object.fromEntries(
    FEATURE_WINDOW_KEYS.map((key) => [key, {}])
  ) as NodeEnvironmentalWindows;
  const providerWindows = Object.fromEntries(
    FEATURE_WINDOW_KEYS.map((key) => [key, {}])
  ) as ProviderNodeEnvironmentalWindows;
  const provenance: EnvironmentalFeatureProvenance[] = [];
  const warnings: string[] = [];

  for (const spec of WINDOW_FIELD_SPECS) {
    const latestMetric = buildWindowMetric(snapshots, spec, "latest", calculatedAt);
    windows.latest[spec.featureField as WindowMetricField] = latestMetric.aggregate;
    providerWindows.latest[spec.featureField as WindowMetricField] = latestMetric.byProvider;
    warnings.push(...latestMetric.warnings);
    provenance.push(provenanceForWindow(spec.featureField, nodeId, "latest", latestMetric.aggregate));

    for (const windowKey of windowHours) {
      const metric = buildWindowMetric(snapshots, spec, windowKey, calculatedAt);
      windows[windowKey][spec.featureField as WindowMetricField] = metric.aggregate;
      providerWindows[windowKey][spec.featureField as WindowMetricField] = metric.byProvider;
      warnings.push(...metric.warnings);
      provenance.push(provenanceForWindow(spec.featureField, nodeId, windowKey, metric.aggregate));
    }
  }

  return { windows, providerWindows, provenance, warnings };
}

function buildWindowMetric(
  snapshots: readonly EnvironmentalSnapshot[],
  spec: RawFieldSpec,
  windowKey: FeatureWindowKey,
  calculatedAt: string
): { aggregate: WindowFeatures; byProvider: Record<string, WindowFeatures>; warnings: string[] } {
  const sampleSet = samplesForWindow(snapshots, spec, windowKey, calculatedAt);
  const byProvider: Record<string, WindowFeatures> = {};
  const warnings: string[] = [...sampleSet.warnings];
  const providerIds = sampleSet.providerIds;

  for (const providerId of providerIds) {
    const samples = sampleSet.validSamples.filter((sample) => sample.snapshot.source === providerId);
    byProvider[providerId] = statsForSamples(
      samples,
      sampleSet.invalidSampleCountByProvider?.[providerId] ?? 0,
      sampleSet.invalidReasonsByProvider[providerId] ?? [],
      [providerId]
    );
  }

  if (providerIds.length === 0) {
    const reasons: MissingReason[] = sampleSet.invalidSampleCount > 0 ? uniqueReasons(sampleSet.invalidReasons) : ["source-missing"];
    return {
      aggregate: emptyWindow(reasons, sampleSet.invalidSampleCount, []),
      byProvider,
      warnings
    };
  }

  if (providerIds.length > 1) {
    warnings.push(`${windowKey}.${spec.featureField} has multiple providers and no aggregation policy.`);
    return {
      aggregate: emptyWindowFromSamples(
        uniqueReasons(["multiple-providers-no-aggregation-policy", ...sampleSet.invalidReasons]),
        sampleSet.invalidSampleCount,
        providerIds,
        sampleSet.validSamples
      ),
      byProvider,
      warnings
    };
  }

  return {
    aggregate: statsForSamples(sampleSet.validSamples, sampleSet.invalidSampleCount, sampleSet.invalidReasons, providerIds),
    byProvider,
    warnings
  };
}

function samplesForWindow(
  snapshots: readonly EnvironmentalSnapshot[],
  spec: RawFieldSpec,
  windowKey: FeatureWindowKey,
  calculatedAt: string
): WindowSampleSet & { invalidSampleCountByProvider: Record<string, number> } {
  const calculatedAtMs = Date.parse(calculatedAt);
  const lowerBoundMs = windowKey === "latest"
    ? Number.NEGATIVE_INFINITY
    : calculatedAtMs - Number.parseInt(windowKey, 10) * 3600_000;

  const candidates = snapshots.filter((snapshot) => {
    const observedAt = Date.parse(snapshot.observedAt);
    return Number.isFinite(observedAt) && observedAt >= lowerBoundMs && observedAt <= calculatedAtMs;
  });
  const validSamples: WindowSample[] = [];
  const invalidReasons: MissingReason[] = [];
  const invalidSampleCountByProvider: Record<string, number> = {};
  const invalidReasonsByProvider: Record<string, MissingReason[]> = {};
  const warnings: string[] = [];

  const recordInvalid = (snapshot: EnvironmentalSnapshot): void => {
    invalidReasons.push("invalid-source-value");
    invalidReasonsByProvider[snapshot.source] = uniqueReasons([
      ...(invalidReasonsByProvider[snapshot.source] ?? []),
      "invalid-source-value"
    ]);
    invalidSampleCountByProvider[snapshot.source] = (invalidSampleCountByProvider[snapshot.source] ?? 0) + 1;
  };

  if (windowKey === "latest") {
    const byProvider = snapshotsByProvider(candidates);
    for (const [providerId, providerSnapshots] of byProvider.entries()) {
      let sawInvalid = false;
      for (const snapshot of sortSnapshotsForLatest(providerSnapshots)) {
        const value = snapshot[spec.snapshotField];
        if (value == null) continue;
        if (!isFiniteNumber(value) || (spec.nonNegative && value < 0)) {
          sawInvalid = true;
          recordInvalid(snapshot);
          continue;
        }
        if (sawInvalid) {
          warnings.push(`latest.${spec.featureField} for ${providerId} used an older valid sample after excluding newer invalid source value.`);
        }
        validSamples.push({ snapshot, value: spec.direction ? normalizeDirectionDegrees(value) ?? value : value });
        break;
      }
    }
  } else {
    for (const snapshot of candidates) {
      const value = snapshot[spec.snapshotField];
      if (value == null) continue;
      if (!isFiniteNumber(value) || (spec.nonNegative && value < 0)) {
        recordInvalid(snapshot);
        warnings.push(`${windowKey}.${spec.featureField} invalid source sample excluded for provider ${snapshot.source}.`);
        continue;
      }
      validSamples.push({ snapshot, value: spec.direction ? normalizeDirectionDegrees(value) ?? value : value });
    }
  }

  const providerIds = uniqueStrings([
    ...validSamples.map((sample) => sample.snapshot.source),
    ...Object.keys(invalidSampleCountByProvider)
  ]);
  return {
    validSamples: validSamples.sort((a, b) => compareSnapshotsForStats(a.snapshot, b.snapshot)),
    invalidSampleCount: Object.values(invalidSampleCountByProvider).reduce((sum, count) => sum + count, 0),
    invalidReasons,
    invalidReasonsByProvider,
    providerIds,
    warnings,
    invalidSampleCountByProvider
  };
}

function snapshotsByProvider(snapshots: readonly EnvironmentalSnapshot[]): Map<string, EnvironmentalSnapshot[]> {
  const byProvider = new Map<string, EnvironmentalSnapshot[]>();
  for (const snapshot of snapshots) {
    byProvider.set(snapshot.source, [...(byProvider.get(snapshot.source) ?? []), snapshot]);
  }
  return byProvider;
}

function statsForSamples(
  samples: readonly WindowSample[],
  invalidSampleCount: number,
  invalidReasons: readonly MissingReason[],
  providerIdsOverride?: readonly string[]
): WindowFeatures {
  if (!samples.length) {
    return emptyWindow(invalidSampleCount > 0 ? uniqueReasons(invalidReasons) : ["source-missing"], invalidSampleCount, providerIdsOverride ?? []);
  }
  const values = samples.map((sample) => sample.value);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsedHours = (Date.parse(last.snapshot.observedAt) - Date.parse(first.snapshot.observedAt)) / 3600_000;
  const providerIds = providerIdsOverride?.length
    ? Array.from(providerIdsOverride).sort()
    : Array.from(new Set(samples.map((sample) => sample.snapshot.source))).sort();

  return {
    sampleCount: samples.length,
    invalidSampleCount,
    providerIds,
    firstCollectedAt: canonicalMin(samples.map((sample) => sample.snapshot.collectedAt)),
    lastCollectedAt: canonicalMax(samples.map((sample) => sample.snapshot.collectedAt)),
    mean: round(mean(values), 6),
    min: Math.min(...values),
    max: Math.max(...values),
    change: samples.length >= 2 ? round(last.value - first.value, 6) : null,
    ratePerHour: samples.length >= 2 && elapsedHours > 0 ? round((last.value - first.value) / elapsedHours, 6) : null,
    volatility: samples.length >= 2 ? round(standardDeviation(values), 6) : null,
    missingReasons: samples.length >= 2 ? uniqueReasons(invalidReasons) : uniqueReasons(["insufficient-samples", ...invalidReasons])
  };
}

function vectorForFeature(
  kind: "wind" | "wave" | "current",
  nodeId: string,
  speed: LatestFieldValue,
  direction: LatestFieldValue,
  convention: DirectionConvention,
  provenance: EnvironmentalFeatureProvenance[],
  missingReasons: Partial<Record<string, MissingReason[]>>
): VectorBuildResult {
  const sourceFields = vectorSourceFields(kind);
  const providerIds = uniqueStrings([...speed.providerIds, ...direction.providerIds]);
  const sourceCollectedAts = uniqueStrings([...speed.sourceCollectedAts, ...direction.sourceCollectedAts]);
  const reasons: MissingReason[] = [];
  if (speed.value == null || direction.value == null) reasons.push("source-missing");
  if (speed.missingReasons.includes("invalid-source-value") || direction.missingReasons.includes("invalid-source-value")) reasons.push("invalid-source-value");
  if (convention === "unknown" && speed.value != null && direction.value != null) reasons.push("unsupported-direction-convention");

  const vector = vectorFromSpeedAndDirection(speed.value, direction.value, convention);
  const fieldNames = vectorFieldNames(kind);
  if (reasons.length) {
    for (const field of fieldNames) missingReasons[field] = uniqueReasons(reasons);
  }
  for (const field of fieldNames) {
    provenance.push({
      field,
      nodeId,
      providerIds,
      sourceCollectedAts,
      snapshotSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
      sampleCount: vector ? 1 : 0,
      invalidSampleCount: speed.invalidSampleCount + direction.invalidSampleCount,
      sourceFields,
      missingReasons: uniqueReasons(reasons)
    });
  }

  return {
    vector,
    missingReasons: uniqueReasons(reasons),
    providerIds,
    sourceCollectedAts,
    sourceFields
  };
}

function deriveTemperatureDifference(air: LatestFieldValue, water: LatestFieldValue): { value: number | null; missingReasons: MissingReason[] } {
  if (air.value != null && water.value != null) {
    return { value: round(water.value - air.value, 6), missingReasons: [] };
  }
  return { value: null, missingReasons: reasonsFromRaw([air, water]) };
}

function deriveGustFactor(windSpeed: LatestFieldValue, windGust: LatestFieldValue): { value: number | null; missingReasons: MissingReason[] } {
  if (windSpeed.value != null && windGust.value != null) {
    if (windSpeed.value === 0) return { value: null, missingReasons: ["zero-denominator"] };
    return { value: round(windGust.value / windSpeed.value, 6), missingReasons: [] };
  }
  return { value: null, missingReasons: reasonsFromRaw([windSpeed, windGust]) };
}

function deriveAlignment(
  field: "windWaveAlignment" | "windCurrentAlignment" | "waveCurrentAlignment",
  left: VectorBuildResult,
  right: VectorBuildResult
): { value: number | null; missingReasons: MissingReason[]; field: typeof field } {
  if (!left.vector || !right.vector) {
    return { field, value: null, missingReasons: reasonsFromVectors(left, right) };
  }
  const leftMagnitude = Math.hypot(left.vector.east, left.vector.north);
  const rightMagnitude = Math.hypot(right.vector.east, right.vector.north);
  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return { field, value: null, missingReasons: ["zero-vector-magnitude"] };
  }
  return {
    field,
    value: round((left.vector.east * right.vector.east + left.vector.north * right.vector.north) / (leftMagnitude * rightMagnitude), 6),
    missingReasons: []
  };
}

function applyDerived(
  field: "temperatureDifferenceC" | "gustFactor",
  nodeId: string,
  derived: { value: number | null; missingReasons: MissingReason[] },
  sourceFields: string[],
  rawValues: readonly LatestFieldValue[],
  missingReasons: Partial<Record<string, MissingReason[]>>,
  provenance: EnvironmentalFeatureProvenance[]
): void {
  if (derived.value == null) missingReasons[field] = uniqueReasons(derived.missingReasons);
  provenance.push({
    field,
    nodeId,
    providerIds: uniqueStrings(rawValues.flatMap((raw) => raw.providerIds)),
    sourceCollectedAts: uniqueStrings(rawValues.flatMap((raw) => raw.sourceCollectedAts)),
    snapshotSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
    sampleCount: rawValues.filter((raw) => raw.source).length,
    invalidSampleCount: rawValues.reduce((sum, raw) => sum + raw.invalidSampleCount, 0),
    sourceFields,
    missingReasons: uniqueReasons(derived.missingReasons)
  });
}

function applyAlignment(
  field: "windWaveAlignment" | "windCurrentAlignment" | "waveCurrentAlignment",
  nodeId: string,
  derived: { value: number | null; missingReasons: MissingReason[] },
  left: VectorBuildResult,
  right: VectorBuildResult,
  missingReasons: Partial<Record<string, MissingReason[]>>,
  provenance: EnvironmentalFeatureProvenance[]
): void {
  if (derived.value == null) missingReasons[field] = uniqueReasons(derived.missingReasons);
  provenance.push({
    field,
    nodeId,
    providerIds: uniqueStrings([...left.providerIds, ...right.providerIds]),
    sourceCollectedAts: uniqueStrings([...left.sourceCollectedAts, ...right.sourceCollectedAts]),
    snapshotSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
    sampleCount: left.vector && right.vector ? 2 : 0,
    sourceFields: [...left.sourceFields, ...right.sourceFields],
    missingReasons: uniqueReasons(derived.missingReasons)
  });
}

function summarizeQualityReports(matchedReports: readonly MatchedQualityReport[]): NodeEnvironmentalDataQuality {
  const providerQuality: Record<string, ProviderQualitySummary> = {};
  const warningCounts: Record<string, number> = {};
  for (const { report, providerId } of matchedReports) {
    providerQuality[providerId] ??= {
      providerId,
      qualityReportCount: 0,
      staleCount: 0,
      warningCounts: {},
      missingRate: null,
      confidence: null,
      freshness: null
    };
    const summary = providerQuality[providerId];
    summary.qualityReportCount += 1;
    if (report.stale) summary.staleCount += 1;
    for (const warning of report.warnings) {
      summary.warningCounts[warning] = (summary.warningCounts[warning] ?? 0) + 1;
      warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
    }
  }

  for (const providerId of Object.keys(providerQuality)) {
    const latest = matchedReports
      .filter((item) => item.providerId === providerId)
      .map((item) => item.report)
      .sort(compareQualityReports)
      .at(-1);
    providerQuality[providerId].missingRate = latest?.missingRate ?? null;
    providerQuality[providerId].confidence = latest?.confidence ?? null;
    providerQuality[providerId].freshness = latest?.freshness ?? null;
  }

  const providerIds = Object.keys(providerQuality).sort();
  const singleProvider = providerIds.length === 1 ? providerQuality[providerIds[0]] : null;
  return {
    qualityReportCount: matchedReports.length,
    staleCount: matchedReports.filter((item) => item.report.stale).length,
    warningCounts,
    missingRate: singleProvider?.missingRate ?? null,
    confidence: singleProvider?.confidence ?? null,
    freshness: singleProvider?.freshness ?? null,
    providerQuality
  };
}

function provenanceForRawField(field: string, nodeId: string, raw: LatestFieldValue): EnvironmentalFeatureProvenance {
  return {
    field,
    providerId: raw.source?.source,
    providerIds: raw.providerIds,
    collectedAt: raw.source ? toCanonicalUtcIso(raw.source.collectedAt) : null,
    sourceCollectedAts: raw.sourceCollectedAts,
    snapshotSchemaVersion: raw.source?.provenance?.[0]?.normalizedSchemaVersion ?? ENVIRONMENTAL_SCHEMA_VERSION,
    nodeId,
    sampleCount: raw.source ? 1 : 0,
    invalidSampleCount: raw.invalidSampleCount,
    sourceFields: [field],
    missingReasons: raw.missingReasons
  };
}

function provenanceForWindow(
  field: string,
  nodeId: string,
  window: FeatureWindowKey,
  metric: WindowFeatures
): EnvironmentalFeatureProvenance {
  return {
    field,
    nodeId,
    window,
    providerIds: metric.providerIds,
    collectedAt: metric.lastCollectedAt,
    sourceCollectedAts: uniqueStrings([metric.firstCollectedAt, metric.lastCollectedAt].filter((value): value is string => Boolean(value))),
    snapshotSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
    sampleCount: metric.sampleCount,
    invalidSampleCount: metric.invalidSampleCount,
    firstCollectedAt: metric.firstCollectedAt,
    lastCollectedAt: metric.lastCollectedAt,
    sourceFields: [field],
    missingReasons: metric.missingReasons
  };
}

function emptyWindow(missingReasons: MissingReason[], invalidSampleCount: number, providerIds: readonly string[]): WindowFeatures {
  return {
    sampleCount: 0,
    invalidSampleCount,
    providerIds: Array.from(providerIds).sort(),
    firstCollectedAt: null,
    lastCollectedAt: null,
    mean: null,
    min: null,
    max: null,
    change: null,
    ratePerHour: null,
    volatility: null,
    missingReasons: uniqueReasons(missingReasons)
  };
}

function emptyWindowFromSamples(
  missingReasons: MissingReason[],
  invalidSampleCount: number,
  providerIds: readonly string[],
  samples: readonly WindowSample[]
): WindowFeatures {
  const sorted = samples.slice().sort((left, right) => compareSnapshotsForStats(left.snapshot, right.snapshot));
  return {
    sampleCount: 0,
    invalidSampleCount,
    providerIds: Array.from(providerIds).sort(),
    firstCollectedAt: sorted.at(0) ? toCanonicalUtcIso(sorted.at(0)?.snapshot.collectedAt) : null,
    lastCollectedAt: sorted.at(-1) ? toCanonicalUtcIso(sorted.at(-1)?.snapshot.collectedAt) : null,
    mean: null,
    min: null,
    max: null,
    change: null,
    ratePerHour: null,
    volatility: null,
    missingReasons: uniqueReasons(missingReasons)
  };
}

function validateSnapshotDates(snapshot: EnvironmentalSnapshot, label: string, id: string): string[] {
  const errors: string[] = [];
  if (!isSupportedSourceDateTime(snapshot.observedAt)) errors.push(`${label} ${id} has invalid observedAt.`);
  if (!isSupportedSourceDateTime(snapshot.collectedAt)) errors.push(`${label} ${id} has invalid collectedAt.`);
  if (snapshot.forecastIssuedAt != null && !isSupportedSourceDateTime(snapshot.forecastIssuedAt)) {
    errors.push(`${label} ${id} has invalid forecastIssuedAt.`);
  }
  return errors;
}

function validateQualityDates(report: EnvironmentalQualityReport, id: string): string[] {
  const errors: string[] = [];
  if (!isSupportedSourceDateTime(report.observedAt)) errors.push(`quality report ${id} has invalid observedAt.`);
  if (!isSupportedSourceDateTime(report.collectedAt)) errors.push(`quality report ${id} has invalid collectedAt.`);
  if (report.forecastIssuedAt != null && !isSupportedSourceDateTime(report.forecastIssuedAt)) {
    errors.push(`quality report ${id} has invalid forecastIssuedAt.`);
  }
  return errors;
}

function qualityReportMatchesSnapshotDates(report: EnvironmentalQualityReport, snapshot: EnvironmentalSnapshot): boolean {
  return toCanonicalUtcIso(report.observedAt) === toCanonicalUtcIso(snapshot.observedAt)
    && toCanonicalUtcIso(report.collectedAt) === toCanonicalUtcIso(snapshot.collectedAt)
    && nullableCanonicalIso(report.forecastIssuedAt) === nullableCanonicalIso(snapshot.forecastIssuedAt);
}

function nullableCanonicalIso(value: string | null | undefined): string | null {
  return value == null ? null : toCanonicalUtcIso(value);
}

function snapshotIdentityKey(snapshot: EnvironmentalSnapshot): string {
  return [
    snapshot.nodeId ?? "",
    snapshot.source ?? "",
    snapshot.observedAt ?? "",
    snapshot.collectedAt ?? ""
  ].join("|");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    return `number:${JSON.stringify(value)}`;
  }
  if (value === null) return "null";
  return JSON.stringify(value) ?? "undefined";
}

function sortSnapshots(snapshots: readonly EnvironmentalSnapshot[]): EnvironmentalSnapshot[] {
  return snapshots.slice().sort(compareSnapshotsForStats);
}

function sortSnapshotsForLatest(snapshots: readonly EnvironmentalSnapshot[]): EnvironmentalSnapshot[] {
  return snapshots.slice().sort((left, right) => {
    const observedDelta = parseTime(right.observedAt) - parseTime(left.observedAt);
    if (observedDelta !== 0) return observedDelta;
    const collectedDelta = parseTime(right.collectedAt) - parseTime(left.collectedAt);
    if (collectedDelta !== 0) return collectedDelta;
    return (left.source || "").localeCompare(right.source || "");
  });
}

function compareSnapshotsForStats(left: EnvironmentalSnapshot, right: EnvironmentalSnapshot): number {
  const observedDelta = parseTime(left.observedAt) - parseTime(right.observedAt);
  if (observedDelta !== 0) return observedDelta;
  const collectedDelta = parseTime(left.collectedAt) - parseTime(right.collectedAt);
  if (collectedDelta !== 0) return collectedDelta;
  return (left.source || "").localeCompare(right.source || "");
}

function compareQualityReports(left: EnvironmentalQualityReport, right: EnvironmentalQualityReport): number {
  const observedDelta = parseTime(left.observedAt) - parseTime(right.observedAt);
  if (observedDelta !== 0) return observedDelta;
  const collectedDelta = parseTime(left.collectedAt) - parseTime(right.collectedAt);
  if (collectedDelta !== 0) return collectedDelta;
  return (left.snapshotKey || "").localeCompare(right.snapshotKey || "");
}

function latestCanonicalCollectedAt(snapshots: readonly EnvironmentalSnapshot[]): string | null {
  return canonicalMax(snapshots.map((snapshot) => snapshot.collectedAt));
}

function canonicalMin(values: readonly string[]): string | null {
  return canonicalExtreme(values, "min");
}

function canonicalMax(values: readonly string[]): string | null {
  return canonicalExtreme(values, "max");
}

function canonicalExtreme(values: readonly string[], mode: "min" | "max"): string | null {
  const times = values
    .map((value) => toCanonicalUtcIso(value))
    .filter((value): value is string => value != null)
    .sort();
  if (!times.length) return null;
  return mode === "min" ? times[0] : times[times.length - 1];
}

function toCanonicalUtcIso(value: string | null | undefined): string | null {
  if (!isSupportedSourceDateTime(value)) return null;
  return new Date(value).toISOString();
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isSupportedSourceDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SOURCE_RFC3339_DATETIME.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zoneText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
  ) {
    return false;
  }
  if (zoneText !== "Z") {
    const offsetHour = Number(zoneText.slice(1, 3));
    const offsetMinute = Number(zoneText.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  if (fractionText && fractionText.length > 4) {
    const truncated = fractionText.slice(0, 4);
    const reparsed = new Date(value.replace(fractionText, truncated));
    return Number.isFinite(reparsed.getTime());
  }
  return true;
}

function parseTime(value: string | null | undefined): number {
  const canonical = toCanonicalUtcIso(value);
  const parsed = canonical ? Date.parse(canonical) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function uniqueReasons(reasons: readonly MissingReason[]): MissingReason[] {
  return Array.from(new Set(reasons));
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function warningEventCode(warning: string): string {
  if (warning.includes("duplicate-source-snapshot")) return "duplicate-source-snapshot";
  if (warning.includes("Future snapshot excluded")) return "future-source-excluded";
  if (warning.includes("Future quality report excluded")) return "future-quality-excluded";
  if (warning.includes("Unmatched quality report excluded")) return "unmatched-quality-report";
  if (warning.includes("multiple providers and no aggregation policy")) return "multiple-providers-no-aggregation-policy";
  return warning;
}

function normalizeRuntimeOptions(input: BuildNodeEnvironmentalFeaturesInput): RuntimeOptions {
  const errors: string[] = [];
  const warnings: string[] = [];
  const directionConventions: DirectionConventionSet = {};
  for (const key of ["wind", "wave", "current"] as const) {
    const value = input.directionConventions?.[key];
    if (value == null) continue;
    if (isValidDirectionConvention(value)) {
      directionConventions[key] = value;
    } else {
      errors.push(`directionConventions.${key} must be toward, from, or unknown.`);
      directionConventions[key] = "unknown";
    }
  }

  const windowHours: Exclude<FeatureWindowKey, "latest">[] = [];
  const seenWindows = new Set<string>();
  for (const windowKey of input.windowHours ?? DEFAULT_WINDOW_HOURS) {
    if (!isValidWindowHour(windowKey)) {
      errors.push(`windowHours contains invalid value: ${String(windowKey)}.`);
      continue;
    }
    if (seenWindows.has(windowKey)) {
      warnings.push(`windowHours duplicate ignored: ${windowKey}.`);
      continue;
    }
    seenWindows.add(windowKey);
    windowHours.push(windowKey);
  }

  return { directionConventions, windowHours, errors, warnings };
}

function isValidDirectionConvention(value: unknown): value is DirectionConvention {
  return typeof value === "string" && (VALID_DIRECTION_CONVENTIONS as readonly string[]).includes(value);
}

function isValidWindowHour(value: unknown): value is Exclude<FeatureWindowKey, "latest"> {
  return typeof value === "string" && (VALID_WINDOW_HOURS as readonly string[]).includes(value);
}

function reasonsFromRaw(values: readonly LatestFieldValue[]): MissingReason[] {
  const reasons = values.flatMap((raw) => raw.missingReasons);
  return reasons.length ? uniqueReasons(reasons) : ["source-missing"];
}

function reasonsFromVectors(left: VectorBuildResult, right: VectorBuildResult): MissingReason[] {
  const reasons = uniqueReasons([...left.missingReasons, ...right.missingReasons]);
  return reasons.length ? reasons : ["source-missing"];
}

function vectorSourceFields(kind: "wind" | "wave" | "current"): string[] {
  if (kind === "wind") return ["windSpeedMps", "windDirectionDeg"];
  if (kind === "wave") return ["waveHeightM", "waveDirectionDeg"];
  return ["currentSpeedMps", "currentDirectionDeg"];
}

function vectorFieldNames(kind: "wind" | "wave" | "current"): [VectorField, VectorField] {
  if (kind === "wind") return ["windVectorEast", "windVectorNorth"];
  if (kind === "wave") return ["waveVectorEast", "waveVectorNorth"];
  return ["currentVectorEast", "currentVectorNorth"];
}

function validateWindows(windows: NodeEnvironmentalWindows, errors: string[], warnings: string[]): void {
  for (const [windowKey, fields] of Object.entries(windows)) {
    for (const [field, window] of Object.entries(fields)) {
      validateWindow(`${windowKey}.${field}`, window, errors, warnings);
    }
  }
}

function validateWindowsByProvider(windows: ProviderNodeEnvironmentalWindows, errors: string[], warnings: string[]): void {
  for (const [windowKey, fields] of Object.entries(windows)) {
    for (const [field, byProvider] of Object.entries(fields)) {
      for (const [providerId, window] of Object.entries(byProvider)) {
        validateWindow(`${windowKey}.${field}.${providerId}`, window, errors, warnings);
      }
    }
  }
}

function validateQualitySummary(label: string, quality: NodeEnvironmentalDataQuality, errors: string[]): void {
  if (!Number.isInteger(quality.qualityReportCount) || quality.qualityReportCount < 0) {
    errors.push(`${label}.qualityReportCount must be a non-negative integer.`);
  }
  if (!Number.isInteger(quality.staleCount) || quality.staleCount < 0) {
    errors.push(`${label}.staleCount must be a non-negative integer.`);
  }
  if (quality.missingRate != null && !isUnitInterval(quality.missingRate)) {
    errors.push(`${label}.missingRate must be null or between 0 and 1.`);
  }
  if (quality.confidence != null && !isUnitInterval(quality.confidence)) {
    errors.push(`${label}.confidence must be null or between 0 and 1.`);
  }
  if (quality.freshness != null && !isUnitInterval(quality.freshness)) {
    errors.push(`${label}.freshness must be null or between 0 and 1.`);
  }
  for (const [providerId, providerQuality] of Object.entries(quality.providerQuality)) {
    if (!Number.isInteger(providerQuality.qualityReportCount) || providerQuality.qualityReportCount < 0) {
      errors.push(`${label}.providerQuality.${providerId}.qualityReportCount must be a non-negative integer.`);
    }
    if (!Number.isInteger(providerQuality.staleCount) || providerQuality.staleCount < 0) {
      errors.push(`${label}.providerQuality.${providerId}.staleCount must be a non-negative integer.`);
    }
    if (providerQuality.missingRate != null && !isUnitInterval(providerQuality.missingRate)) {
      errors.push(`${label}.providerQuality.${providerId}.missingRate must be null or between 0 and 1.`);
    }
    if (providerQuality.confidence != null && !isUnitInterval(providerQuality.confidence)) {
      errors.push(`${label}.providerQuality.${providerId}.confidence must be null or between 0 and 1.`);
    }
    if (providerQuality.freshness != null && !isUnitInterval(providerQuality.freshness)) {
      errors.push(`${label}.providerQuality.${providerId}.freshness must be null or between 0 and 1.`);
    }
  }
}

function validateWindow(label: string, window: WindowFeatures, errors: string[], warnings: string[]): void {
  if (!Number.isInteger(window.sampleCount) || window.sampleCount < 0) {
    errors.push(`${label}.sampleCount must be a non-negative integer.`);
  }
  if (!Number.isInteger(window.invalidSampleCount) || window.invalidSampleCount < 0) {
    errors.push(`${label}.invalidSampleCount must be a non-negative integer.`);
  }
  if (window.firstCollectedAt != null && !isCanonicalUtcIsoDateTime(window.firstCollectedAt)) {
    errors.push(`${label}.firstCollectedAt must be canonical UTC ISO datetime.`);
  }
  if (window.lastCollectedAt != null && !isCanonicalUtcIsoDateTime(window.lastCollectedAt)) {
    errors.push(`${label}.lastCollectedAt must be canonical UTC ISO datetime.`);
  }
  if (
    window.firstCollectedAt != null
    && window.lastCollectedAt != null
    && Date.parse(window.firstCollectedAt) > Date.parse(window.lastCollectedAt)
  ) {
    errors.push(`${label} collectedAt range is reversed.`);
  }
  for (const key of ["mean", "min", "max", "change", "ratePerHour", "volatility"] as const) {
    const value = window[key];
    if (value != null && !isFiniteNumber(value)) errors.push(`${label}.${key} must be finite when present.`);
  }
  if (window.sampleCount < 2 && (window.change != null || window.ratePerHour != null || window.volatility != null)) {
    warnings.push(`${label} has trend statistics with fewer than two samples.`);
  }
}

const NUMERIC_FEATURE_FIELDS = [
  "airTemperatureC",
  "waterTemperatureC",
  "windSpeedMps",
  "windGustMps",
  "windDirectionDeg",
  "waveHeightM",
  "wavePeriodS",
  "waveDirectionDeg",
  "currentSpeedMps",
  "currentDirectionDeg",
  "seaLevelM",
  "pressureHpa",
  "precipitationMm",
  "windVectorEast",
  "windVectorNorth",
  "waveVectorEast",
  "waveVectorNorth",
  "currentVectorEast",
  "currentVectorNorth",
  "windWaveAlignment",
  "windCurrentAlignment",
  "waveCurrentAlignment",
  "temperatureDifferenceC",
  "gustFactor",
  "environmentalVolatility",
  "freshness"
] as const satisfies readonly (keyof NodeEnvironmentalFeatures)[];

const NON_NEGATIVE_FEATURE_FIELDS = [
  "windSpeedMps",
  "windGustMps",
  "waveHeightM",
  "wavePeriodS",
  "currentSpeedMps",
  "precipitationMm"
] as const satisfies readonly (keyof NodeEnvironmentalFeatures)[];

const DIRECTION_FEATURE_FIELDS = [
  "windDirectionDeg",
  "waveDirectionDeg",
  "currentDirectionDeg"
] as const satisfies readonly (keyof NodeEnvironmentalFeatures)[];
