import {
  HYDRO_COASTAL_PROVIDER_IDS,
  convertWaterLevelToTp,
  hydroCoastalObservationIdentityKey,
  hydroCoastalObservationVersionKey,
  mapHydroCoastalObservationsToHabitatNodes,
  selectHydroCoastalObservationsAsOf,
  validateHydroCoastalStationNodeMapping,
  type HydroCoastalMappedObservation,
  type HydroCoastalObservation,
  type HydroCoastalProviderId,
  type HydroCoastalStationNodeMapping,
  type HydroCoastalStationNodeMappingMethod,
  type HydroCoastalUnit,
  type VerticalDatum
} from "./hydro-coastal";
import { type HabitatGraph } from "./habitat";

export const NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION = "wanoku-node-hydro-coastal-features.v1";
export const TIDE_PREDICTION_CHANGE_WINDOWS_HOURS = [1, 3, 6] as const;

export type TidePredictionChangeWindowHours = typeof TIDE_PREDICTION_CHANGE_WINDOWS_HOURS[number];
export type TideTrendDirection = "rising" | "falling" | "steady" | "unknown";

export type HydroCoastalFeatureMissingReason =
  | "no-active-mapping"
  | "no-target-observation"
  | "missing-lookback-observation"
  | "no-common-forecast-vintage"
  | "conflicting-observation"
  | "conflicting-mapping"
  | "future-revision-excluded"
  | "invalid-observation"
  | "unsupported-unit"
  | "datum-not-convertible-to-tp"
  | "multiple-active-stations"
  | "mapping-outside-validity"
  | "unknown-habitat-node";

export type HydroCoastalFeatureProvenance = {
  field: string;
  providerId: HydroCoastalProviderId | null;
  stationId: string | null;
  nodeId: string;
  targetAt: string;
  forecastIssuedAt: string | null;
  collectedAt: string | null;
  observationIdentityKey?: string;
  observationVersionKey?: string;
  targetObservationIdentityKey?: string;
  targetObservationVersionKey?: string;
  lookbackObservationIdentityKey?: string;
  lookbackObservationVersionKey?: string;
  lookbackAt?: string;
  windowHours?: TidePredictionChangeWindowHours;
  mappingMethod: HydroCoastalStationNodeMappingMethod | null;
  mappingDistanceKm: number | null;
  mappingSource: string | null;
  mappingReviewedAt: string | null;
  datumType?: VerticalDatum["type"] | null;
  offsetToTpM?: number | null;
  conversionUtility?: string;
  missingReasons: HydroCoastalFeatureMissingReason[];
};

export type NodeHydroCoastalDataQuality = {
  requiredObservationCount: number;
  availableObservationCount: number;
  missingRate: number;
  confidence: number | null;
  inputObservationCount: number;
  selectedAsOfObservationCount: number;
  nodeObservationCount: number;
};

export type NodeHydroCoastalFeatures = {
  schemaVersion: string;
  nodeId: string;
  calculatedAt: string;
  targetAt: string;
  providerId: HydroCoastalProviderId | null;
  stationId: string | null;
  forecastIssuedAt: string | null;
  sourceCollectedAt: string | null;
  mappingMethod: HydroCoastalStationNodeMappingMethod | null;
  mappingDistanceKm: number | null;
  mappingConfidence: number | null;
  verticalDatum: VerticalDatum | null;
  tideLevelCm: number | null;
  tideLevelM: number | null;
  tideLevelTpM: number | null;
  change1hCm: number | null;
  change3hCm: number | null;
  change6hCm: number | null;
  rate1hCmPerHour: number | null;
  rate3hCmPerHour: number | null;
  rate6hCmPerHour: number | null;
  trend1h: TideTrendDirection;
  dataQuality: NodeHydroCoastalDataQuality;
  provenance: HydroCoastalFeatureProvenance[];
  missingReasons: HydroCoastalFeatureMissingReason[];
  errors: string[];
  warnings: string[];
};

export type BuildHydroCoastalFeatureSetInput = {
  observations: readonly unknown[];
  mappings: readonly HydroCoastalStationNodeMapping[];
  habitatGraph: HabitatGraph;
  calculatedAt: string;
  targetAt: string;
};

export type BuildHydroCoastalFeatureSetResult = {
  features: NodeHydroCoastalFeatures[];
  errors: string[];
  warnings: string[];
  nodesWithoutActiveMapping: string[];
  nodesWithoutTargetObservation: string[];
  unmappedStationKeys: string[];
  mappingsWithUnknownHabitatNode: HydroCoastalStationNodeMapping[];
  excludedObservationCount: number;
};

export type BuildNodeHydroCoastalFeaturesInput = {
  nodeId: string;
  activeMappings: readonly HydroCoastalStationNodeMapping[];
  mappedObservations: readonly HydroCoastalMappedObservation[];
  inputObservationCount: number;
  selectedAsOfObservationCount: number;
  calculatedAt: string;
  targetAt: string;
  lookbackAts: Readonly<Record<TidePredictionChangeWindowHours, string>>;
  inheritedErrors?: readonly string[];
  inheritedWarnings?: readonly string[];
  inheritedMissingReasons?: readonly HydroCoastalFeatureMissingReason[];
  attributedDiagnostics?: readonly AttributedHydroCoastalDiagnostic[];
};

export type WaterLevelNormalizationResult = {
  valueCm: number | null;
  missingReasons: HydroCoastalFeatureMissingReason[];
};

export type HydroCoastalFeatureValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUIRED_OBSERVATION_COUNT = 1 + TIDE_PREDICTION_CHANGE_WINDOWS_HOURS.length;
const HYDRO_COASTAL_FEATURE_MISSING_REASONS = [
  "no-active-mapping",
  "no-target-observation",
  "missing-lookback-observation",
  "no-common-forecast-vintage",
  "conflicting-observation",
  "conflicting-mapping",
  "future-revision-excluded",
  "invalid-observation",
  "unsupported-unit",
  "datum-not-convertible-to-tp",
  "multiple-active-stations",
  "mapping-outside-validity",
  "unknown-habitat-node"
] as const satisfies readonly HydroCoastalFeatureMissingReason[];
const FEATURE_FIELDS = [
  "tideLevelCm",
  "tideLevelM",
  "tideLevelTpM",
  "change1hCm",
  "change3hCm",
  "change6hCm",
  "rate1hCmPerHour",
  "rate3hCmPerHour",
  "rate6hCmPerHour",
  "trend1h"
] as const;

type ParsedHydroCoastalVersionKey = {
  providerId: HydroCoastalProviderId;
  stationId: string;
  metric: string;
  observedAt: string;
  forecastIssuedAt: string | null;
  collectedAt: string;
};

type AttributedHydroCoastalDiagnostic = {
  reason: HydroCoastalFeatureMissingReason;
  observedAt: string;
  versionKey: string;
};

export function buildHydroCoastalFeatureSet(
  input: BuildHydroCoastalFeatureSetInput
): BuildHydroCoastalFeatureSetResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const calculatedAtValid = isCanonicalUtcIsoDateTime(input.calculatedAt);
  const targetAtValid = isCanonicalUtcIsoDateTime(input.targetAt);
  const targetAtExactHour = targetAtValid && isExactUtcHour(input.targetAt);

  if (!calculatedAtValid) errors.push("calculatedAt must be canonical UTC ISO datetime.");
  if (!targetAtValid) errors.push("targetAt must be canonical UTC ISO datetime.");
  if (targetAtValid && !targetAtExactHour) errors.push("targetAt must be an exact UTC hour.");

  const lookbackAts = targetAtValid
    ? calculateLookbackAts(input.targetAt)
    : {
        1: input.targetAt,
        3: input.targetAt,
        6: input.targetAt
      } satisfies Record<TidePredictionChangeWindowHours, string>;
  const targetTimes = new Set<string>([input.targetAt, ...Object.values(lookbackAts)]);

  const selection = selectHydroCoastalObservationsAsOf(input.observations, input.calculatedAt);
  errors.push(...selection.errors);
  warnings.push(...selection.warnings);

  const mappingPrep = prepareMappings(input.mappings, input.habitatGraph, input.targetAt);
  errors.push(...mappingPrep.errors);
  warnings.push(...mappingPrep.warnings);

  const candidateObservations = selection.observations.filter((observation) => (
    observation.metric === "predicted-tide-level" &&
    observation.status === "predicted" &&
    isFiniteNumber(observation.value) &&
    targetTimes.has(observation.observedAt)
  ));
  const mappingResult = mapHydroCoastalObservationsToHabitatNodes(
    candidateObservations,
    mappingPrep.usableMappings,
    input.habitatGraph
  );
  warnings.push(...mappingResult.warnings);
  const attributedDiagnosticsByNode = attributeAsOfDiagnosticsToNodes(
    selection.errors,
    selection.warnings,
    mappingPrep.usableMappings,
    input.habitatGraph,
    targetTimes
  );

  const activeMappingsByNode = groupMappingsByNode(mappingPrep.activeMappings);
  for (const [nodeId, activeMappings] of activeMappingsByNode.entries()) {
    const distinctStationKeys = new Set(activeMappings.map(mappingStationKey));
    if (distinctStationKeys.size > 1) {
      errors.push(`multiple active hydro-coastal stations for habitat node: ${nodeId}`);
    }
  }
  const features = input.habitatGraph.nodes.map((node) => buildNodeHydroCoastalFeatures({
    nodeId: node.id,
    activeMappings: activeMappingsByNode.get(node.id) ?? [],
    mappedObservations: mappingResult.mappedObservations.filter((mapped) => mapped.habitatNodeId === node.id),
    inputObservationCount: input.observations.length,
    selectedAsOfObservationCount: selection.observations.length,
    calculatedAt: input.calculatedAt,
    targetAt: input.targetAt,
    lookbackAts,
    inheritedErrors: [
      ...(calculatedAtValid ? [] : ["calculatedAt must be canonical UTC ISO datetime."]),
      ...(targetAtValid ? [] : ["targetAt must be canonical UTC ISO datetime."]),
      ...(targetAtValid && !targetAtExactHour ? ["targetAt must be an exact UTC hour."] : []),
      ...mappingPrep.nodeErrors.get(node.id) ?? []
    ],
    inheritedWarnings: mappingPrep.nodeWarnings.get(node.id) ?? [],
    inheritedMissingReasons: [
      ...mappingPrep.nodeMissingReasons.get(node.id) ?? []
    ],
    attributedDiagnostics: attributedDiagnosticsByNode.get(node.id) ?? []
  }));

  const nodesWithoutActiveMapping = features
    .filter((feature) => feature.missingReasons.includes("no-active-mapping"))
    .map((feature) => feature.nodeId);
  const nodesWithoutTargetObservation = features
    .filter((feature) => feature.missingReasons.includes("no-target-observation"))
    .map((feature) => feature.nodeId);

  return {
    features,
    errors: unique(errors),
    warnings: unique(warnings),
    nodesWithoutActiveMapping,
    nodesWithoutTargetObservation,
    unmappedStationKeys: mappingResult.unmappedStationKeys,
    mappingsWithUnknownHabitatNode: uniqueMappings([
      ...mappingPrep.mappingsWithUnknownHabitatNode,
      ...mappingResult.mappingsWithUnknownHabitatNode
    ]),
    excludedObservationCount: selection.excludedObservationCount
  };
}

export function buildNodeHydroCoastalFeatures(
  input: BuildNodeHydroCoastalFeaturesInput
): NodeHydroCoastalFeatures {
  const errors = [...(input.inheritedErrors ?? [])];
  const warnings = [...(input.inheritedWarnings ?? [])];
  const missingReasons = [...(input.inheritedMissingReasons ?? [])];
  const provenance: HydroCoastalFeatureProvenance[] = [];

  const base = emptyFeature({
    nodeId: input.nodeId,
    calculatedAt: input.calculatedAt,
    targetAt: input.targetAt,
    inputObservationCount: input.inputObservationCount,
    selectedAsOfObservationCount: input.selectedAsOfObservationCount,
    nodeObservationCount: input.mappedObservations.length,
    errors,
    warnings,
    missingReasons,
    provenance
  });

  if (input.inheritedErrors?.some((error) => error.includes("targetAt") || error.includes("calculatedAt"))) {
    addMissingReason(base, "no-target-observation");
    addDefaultMissingProvenance(base, "no-target-observation");
    return finalizeFeature(base);
  }

  if (input.inheritedMissingReasons?.includes("conflicting-mapping")) {
    base.errors.push(`conflicting active hydro-coastal station-node mapping for habitat node: ${input.nodeId}`);
    addMissingReason(base, "conflicting-mapping");
    addDefaultMissingProvenance(base, "conflicting-mapping", input.activeMappings[0]);
    return finalizeFeature(base);
  }

  if (input.activeMappings.length === 0) {
    addMissingReason(base, "no-active-mapping");
    addDefaultMissingProvenance(base, "no-active-mapping");
    return finalizeFeature(base);
  }

  const distinctStationKeys = new Set(input.activeMappings.map(mappingStationKey));
  if (distinctStationKeys.size > 1) {
    base.errors.push(`multiple active hydro-coastal stations for habitat node: ${input.nodeId}`);
    addMissingReason(base, "multiple-active-stations");
    addDefaultMissingProvenance(base, "multiple-active-stations");
    return finalizeFeature(base);
  }

  const mapping = input.activeMappings[0];
  base.providerId = mapping.providerId;
  base.stationId = mapping.stationId;
  base.mappingMethod = mapping.mappingMethod;
  base.mappingDistanceKm = mapping.distanceKm;
  base.mappingConfidence = mapping.confidence;

  const targetDiagnostics = diagnosticsForTime(input.attributedDiagnostics ?? [], input.targetAt);
  const targetCandidates = input.mappedObservations
    .filter((mapped) => isMatchingMappedObservation(mapped, mapping, input.targetAt))
    .sort(compareForecastVintageDescending);
  const target = targetCandidates[0];

  if (!target) {
    const targetMissingReasons: HydroCoastalFeatureMissingReason[] = targetDiagnostics.length
      ? targetDiagnostics.map((diagnostic) => diagnostic.reason)
      : ["no-target-observation"];
    addMissingReasons(base, targetMissingReasons);
    addDefaultMissingProvenance(base, targetMissingReasons[0], mapping);
    return finalizeFeature(base);
  }

  const targetNormalization = normalizeWaterLevelToCm(target.observation.value, target.observation.unit);
  if (targetNormalization.valueCm == null) {
    addMissingReasons(base, targetNormalization.missingReasons);
    addDefaultMissingProvenance(base, "unsupported-unit", mapping, target.observation);
    return finalizeFeature(base);
  }

  const targetCm = targetNormalization.valueCm;
  const targetM = round(targetCm / 100, 6);
  base.forecastIssuedAt = target.observation.forecastIssuedAt;
  base.sourceCollectedAt = target.observation.collectedAt;
  base.verticalDatum = target.observation.verticalDatum;
  base.tideLevelCm = targetCm;
  base.tideLevelM = targetM;
  base.trend1h = "unknown";

  base.provenance.push(provenanceForField("tideLevelCm", input.nodeId, input.targetAt, mapping, target.observation));
  base.provenance.push(provenanceForField("tideLevelM", input.nodeId, input.targetAt, mapping, target.observation));
  for (const diagnostic of targetDiagnostics) {
    addMissingReason(base, diagnostic.reason);
  }

  const tpValue = convertWaterLevelToTp(targetM, target.observation.verticalDatum);
  if (tpValue == null) {
    addMissingReason(base, "datum-not-convertible-to-tp");
    base.provenance.push(provenanceForField("tideLevelTpM", input.nodeId, input.targetAt, mapping, target.observation, {
      missingReasons: ["datum-not-convertible-to-tp"],
      datumType: target.observation.verticalDatum?.type ?? null,
      offsetToTpM: target.observation.verticalDatum?.offsetToTpM ?? null,
      conversionUtility: "convertWaterLevelToTp"
    }));
  } else {
    base.tideLevelTpM = tpValue;
    base.provenance.push(provenanceForField("tideLevelTpM", input.nodeId, input.targetAt, mapping, target.observation, {
      datumType: target.observation.verticalDatum?.type ?? null,
      offsetToTpM: target.observation.verticalDatum?.offsetToTpM ?? null,
      conversionUtility: "convertWaterLevelToTp"
    }));
  }

  let availableObservationCount = 1;
  let trendMissingReasons: HydroCoastalFeatureMissingReason[] = [];
  for (const windowHours of TIDE_PREDICTION_CHANGE_WINDOWS_HOURS) {
    const lookbackAt = input.lookbackAts[windowHours];
    const lookbackDiagnostics = diagnosticsForTime(input.attributedDiagnostics ?? [], lookbackAt);
    const lookbackCandidates = input.mappedObservations.filter((mapped) => (
      isMatchingMappedObservation(mapped, mapping, lookbackAt) &&
      mapped.observation.forecastIssuedAt === target.observation.forecastIssuedAt
    ));
    const lookback = lookbackCandidates.sort(compareForecastVintageDescending)[0];
    const hasOtherVintage = input.mappedObservations.some((mapped) => (
      isMatchingMappedObservation(mapped, mapping, lookbackAt) &&
      mapped.observation.forecastIssuedAt !== target.observation.forecastIssuedAt
    ));
    const missingReason: HydroCoastalFeatureMissingReason = hasOtherVintage
      ? "no-common-forecast-vintage"
      : "missing-lookback-observation";

    if (!lookback) {
      const reasons = lookbackDiagnostics.length
        ? lookbackDiagnostics.map((diagnostic) => diagnostic.reason)
        : [missingReason];
      addChangeMissing(base, input.nodeId, input.targetAt, mapping, target.observation, lookbackAt, windowHours, reasons);
      if (windowHours === 1) trendMissingReasons = reasons;
      continue;
    }

    const lookbackNormalization = normalizeWaterLevelToCm(lookback.observation.value, lookback.observation.unit);
    if (lookbackNormalization.valueCm == null) {
      addChangeMissing(base, input.nodeId, input.targetAt, mapping, target.observation, lookbackAt, windowHours, lookbackNormalization.missingReasons, lookback.observation);
      if (windowHours === 1) trendMissingReasons = lookbackNormalization.missingReasons;
      continue;
    }

    availableObservationCount += 1;
    const changeCm = round(targetCm - lookbackNormalization.valueCm, 6);
    const rate = round(changeCm / windowHours, 6);
    setChangeAndRate(base, windowHours, changeCm, rate);
    base.provenance.push(provenanceForChange(`change${windowHours}hCm`, input.nodeId, input.targetAt, mapping, target.observation, lookback.observation, lookbackAt, windowHours));
    base.provenance.push(provenanceForChange(`rate${windowHours}hCmPerHour`, input.nodeId, input.targetAt, mapping, target.observation, lookback.observation, lookbackAt, windowHours));
  }

  base.trend1h = classifyTideTrend(base.change1hCm);
  base.provenance.push(provenanceForField("trend1h", input.nodeId, input.targetAt, mapping, target.observation, {
    missingReasons: base.trend1h === "unknown" ? trendMissingReasons : []
  }));
  base.dataQuality.availableObservationCount = availableObservationCount;
  base.dataQuality.missingRate = round((REQUIRED_OBSERVATION_COUNT - availableObservationCount) / REQUIRED_OBSERVATION_COUNT, 6);

  return finalizeFeature(base);
}

export function normalizeWaterLevelToCm(value: unknown, unit: HydroCoastalUnit | string): WaterLevelNormalizationResult {
  if (!isFiniteNumber(value)) {
    return { valueCm: null, missingReasons: ["invalid-observation"] };
  }
  if (unit === "cm") {
    const valueCm = round(value, 6);
    return isFiniteNumber(valueCm)
      ? { valueCm, missingReasons: [] }
      : { valueCm: null, missingReasons: ["invalid-observation"] };
  }
  if (unit === "m") {
    const valueCm = round(value * 100, 6);
    return isFiniteNumber(valueCm)
      ? { valueCm, missingReasons: [] }
      : { valueCm: null, missingReasons: ["invalid-observation"] };
  }
  return { valueCm: null, missingReasons: ["unsupported-unit"] };
}

export function classifyTideTrend(change1hCm: number | null): TideTrendDirection {
  if (change1hCm == null) return "unknown";
  if (change1hCm > 0) return "rising";
  if (change1hCm < 0) return "falling";
  return "steady";
}

export function validateNodeHydroCoastalFeatures(feature: unknown): HydroCoastalFeatureValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(feature)) {
    return { valid: false, errors: ["feature must be an object."], warnings };
  }
  if (feature.schemaVersion !== NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION) errors.push("schemaVersion is not supported.");
  if (!isNonEmptyString(feature.nodeId)) errors.push("nodeId must not be empty.");
  if (!isCanonicalUtcIsoDateTime(feature.calculatedAt)) errors.push("calculatedAt must be canonical UTC ISO datetime.");
  if (!isCanonicalUtcIsoDateTime(feature.targetAt)) {
    errors.push("targetAt must be canonical UTC ISO datetime.");
  } else if (!isExactUtcHour(feature.targetAt)) {
    errors.push("targetAt must be an exact UTC hour.");
  }
  if (!((feature.providerId === null && feature.stationId === null) || (isNonEmptyString(feature.providerId) && isNonEmptyString(feature.stationId)))) {
    errors.push("providerId and stationId must both be null or both be non-empty strings.");
  }
  if (feature.providerId !== null && !isHydroCoastalProviderId(feature.providerId)) {
    errors.push(`providerId is unknown: ${String(feature.providerId)}.`);
  }
  if (feature.forecastIssuedAt !== null && !isCanonicalUtcIsoDateTime(feature.forecastIssuedAt)) {
    errors.push("forecastIssuedAt must be null or canonical UTC ISO datetime.");
  }
  if (feature.sourceCollectedAt !== null && !isCanonicalUtcIsoDateTime(feature.sourceCollectedAt)) {
    errors.push("sourceCollectedAt must be null or canonical UTC ISO datetime.");
  }

  const nullableNumericFields = [
    "mappingDistanceKm",
    "mappingConfidence",
    "tideLevelCm",
    "tideLevelM",
    "tideLevelTpM",
    "change1hCm",
    "change3hCm",
    "change6hCm",
    "rate1hCmPerHour",
    "rate3hCmPerHour",
    "rate6hCmPerHour"
  ];
  for (const field of nullableNumericFields) {
    const value = feature[field];
    if (value !== null && !isFiniteNumber(value)) errors.push(`${field} must be finite or null.`);
  }
  if (isFiniteNumber(feature.mappingDistanceKm) && feature.mappingDistanceKm < 0) {
    errors.push("mappingDistanceKm must be >= 0.");
  }
  if (feature.mappingConfidence !== null && !isZeroToOne(feature.mappingConfidence)) {
    errors.push("mappingConfidence must be null or within [0, 1].");
  }
  if (feature.mappingMethod !== null && !isHydroCoastalStationNodeMappingMethod(feature.mappingMethod)) {
    errors.push(`mappingMethod is invalid: ${String(feature.mappingMethod)}.`);
  }
  if (!["rising", "falling", "steady", "unknown"].includes(String(feature.trend1h))) {
    errors.push(`trend1h is invalid: ${String(feature.trend1h)}.`);
  }
  if ((feature.tideLevelCm === null) !== (feature.tideLevelM === null)) {
    errors.push("tideLevelCm and tideLevelM must both be null or both be finite.");
  }
  if (isFiniteNumber(feature.tideLevelCm) && isFiniteNumber(feature.tideLevelM)) {
    if (round(feature.tideLevelCm / 100, 6) !== round(feature.tideLevelM, 6)) {
      errors.push("tideLevelM must equal tideLevelCm / 100.");
    }
    if (
      !isNonEmptyString(feature.providerId) ||
      !isNonEmptyString(feature.stationId) ||
      !isCanonicalUtcIsoDateTime(feature.forecastIssuedAt) ||
      !isRecord(feature.verticalDatum) ||
      !isHydroCoastalStationNodeMappingMethod(feature.mappingMethod)
    ) {
      errors.push("tideLevelCm requires providerId, stationId, forecastIssuedAt, verticalDatum, and mappingMethod.");
    }
  }
  for (const windowHours of TIDE_PREDICTION_CHANGE_WINDOWS_HOURS) {
    const change = feature[`change${windowHours}hCm`];
    const rate = feature[`rate${windowHours}hCmPerHour`];
    if ((change === null) !== (rate === null)) {
      errors.push(`change${windowHours}hCm and rate${windowHours}hCmPerHour must both be null or both be finite.`);
    }
    if (isFiniteNumber(change) && isFiniteNumber(rate)) {
      if (round(change / windowHours, 6) !== round(rate, 6)) {
        errors.push(`rate${windowHours}hCmPerHour must equal change${windowHours}hCm / ${windowHours}.`);
      }
    }
  }
  if (feature.tideLevelCm === null && feature.forecastIssuedAt !== null) {
    errors.push("forecastIssuedAt must be null when tideLevelCm is null.");
  }
  if (feature.trend1h !== classifyTideTrend(isFiniteNumber(feature.change1hCm) ? feature.change1hCm : null)) {
    errors.push("trend1h must match classifyTideTrend(change1hCm).");
  }
  if (!Array.isArray(feature.errors) || !feature.errors.every((value) => typeof value === "string")) errors.push("errors must be a string array.");
  if (!Array.isArray(feature.warnings) || !feature.warnings.every((value) => typeof value === "string")) errors.push("warnings must be a string array.");
  if (!Array.isArray(feature.missingReasons)) {
    errors.push("missingReasons must be an array.");
  } else {
    for (const reason of feature.missingReasons) {
      if (!isHydroCoastalFeatureMissingReason(reason)) errors.push(`missingReasons contains invalid reason: ${String(reason)}.`);
    }
  }
  if (!Array.isArray(feature.provenance)) {
    errors.push("provenance must be an array.");
  } else {
    for (const [index, entry] of feature.provenance.entries()) {
      validateProvenanceEntry(entry, index, errors);
    }
  }
  if (!isRecord(feature.dataQuality)) {
    errors.push("dataQuality must be an object.");
  } else {
    const required = feature.dataQuality.requiredObservationCount;
    const available = feature.dataQuality.availableObservationCount;
    const missingRate = feature.dataQuality.missingRate;
    if (!isNonNegativeInteger(required)) errors.push("dataQuality.requiredObservationCount must be a non-negative integer.");
    if (!isNonNegativeInteger(available)) errors.push("dataQuality.availableObservationCount must be a non-negative integer.");
    if (isNonNegativeInteger(required) && isNonNegativeInteger(available) && available > required) {
      errors.push("dataQuality.availableObservationCount must be <= requiredObservationCount.");
    }
    if (!isZeroToOne(missingRate)) {
      errors.push("dataQuality.missingRate must be within [0, 1].");
    } else if (isNonNegativeInteger(required) && isNonNegativeInteger(available) && available <= required) {
      const expectedMissingRate = required === 0 ? 0 : round((required - available) / required, 6);
      if (round(missingRate, 6) !== expectedMissingRate) {
        errors.push("dataQuality.missingRate must equal (requiredObservationCount - availableObservationCount) / requiredObservationCount rounded to 6 digits.");
      }
    }
    if (feature.dataQuality.confidence !== null && !isZeroToOne(feature.dataQuality.confidence)) errors.push("dataQuality.confidence must be null or within [0, 1].");
    if (!isNonNegativeInteger(feature.dataQuality.inputObservationCount)) errors.push("dataQuality.inputObservationCount must be a non-negative integer.");
    if (!isNonNegativeInteger(feature.dataQuality.selectedAsOfObservationCount)) errors.push("dataQuality.selectedAsOfObservationCount must be a non-negative integer.");
    if (!isNonNegativeInteger(feature.dataQuality.nodeObservationCount)) errors.push("dataQuality.nodeObservationCount must be a non-negative integer.");
  }
  return { valid: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}

function prepareMappings(
  mappings: readonly HydroCoastalStationNodeMapping[],
  habitatGraph: HabitatGraph,
  targetAt: string
): {
  usableMappings: HydroCoastalStationNodeMapping[];
  activeMappings: HydroCoastalStationNodeMapping[];
  mappingsWithUnknownHabitatNode: HydroCoastalStationNodeMapping[];
  errors: string[];
  warnings: string[];
  nodeErrors: Map<string, string[]>;
  nodeWarnings: Map<string, string[]>;
  nodeMissingReasons: Map<string, HydroCoastalFeatureMissingReason[]>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeErrors = new Map<string, string[]>();
  const nodeWarnings = new Map<string, string[]>();
  const nodeMissingReasons = new Map<string, HydroCoastalFeatureMissingReason[]>();
  const nodeIds = new Set(habitatGraph.nodes.map((node) => node.id));
  const seen = new Map<string, HydroCoastalStationNodeMapping>();
  const byPair = new Map<string, HydroCoastalStationNodeMapping[]>();
  const conflictingPairKeys = new Set<string>();
  const usableMappings: HydroCoastalStationNodeMapping[] = [];

  for (const mapping of mappings) {
    const validation = validateHydroCoastalStationNodeMapping(mapping);
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      errors.push(...validation.errors.map((error) => `mapping ${mapping?.stationId ?? "unknown"}: ${error}`));
      continue;
    }
    const serialized = stableSerialize(mapping);
    if (seen.has(serialized)) {
      warnings.push(`duplicate hydro-coastal station-node mapping ignored: ${mapping.providerId}|${mapping.stationId}|${mapping.habitatNodeId}`);
      continue;
    }
    seen.set(serialized, mapping);
    usableMappings.push(mapping);
    const pairKey = `${mapping.providerId}|${mapping.stationId}|${mapping.habitatNodeId}`;
    byPair.set(pairKey, [...(byPair.get(pairKey) ?? []), mapping]);
  }

  for (const [pairKey, group] of byPair.entries()) {
    if (group.length <= 1) continue;
    const activeGroup = group.filter((mapping) => isMappingActiveAt(mapping, targetAt));
    if (activeGroup.length > 1) {
      const nodeId = activeGroup[0].habitatNodeId;
      const message = `conflicting active hydro-coastal station-node mapping: ${pairKey}`;
      errors.push(message);
      pushMap(nodeErrors, nodeId, message);
      pushMap(nodeMissingReasons, nodeId, "conflicting-mapping");
      conflictingPairKeys.add(pairKey);
    }
  }

  const mappingsWithUnknownHabitatNode = usableMappings.filter((mapping) => !nodeIds.has(mapping.habitatNodeId));
  for (const mapping of mappingsWithUnknownHabitatNode) {
    const message = `mapping references unknown habitat node: ${mapping.habitatNodeId}`;
    warnings.push(message);
  }

  const activeMappings = usableMappings.filter((mapping) => (
    nodeIds.has(mapping.habitatNodeId) &&
    isMappingActiveAt(mapping, targetAt) &&
    !conflictingPairKeys.has(mappingPairKey(mapping))
  ));

  for (const mapping of usableMappings) {
    if (!nodeIds.has(mapping.habitatNodeId)) continue;
    if (!isMappingActiveAt(mapping, targetAt)) {
      const message = `mapping outside validity period at targetAt: ${mapping.providerId}|${mapping.stationId}|${mapping.habitatNodeId}`;
      warnings.push(message);
      pushMap(nodeWarnings, mapping.habitatNodeId, message);
      pushMap(nodeMissingReasons, mapping.habitatNodeId, "mapping-outside-validity");
    }
  }

  return {
    usableMappings,
    activeMappings,
    mappingsWithUnknownHabitatNode,
    errors: unique(errors),
    warnings: unique(warnings),
    nodeErrors,
    nodeWarnings,
    nodeMissingReasons
  };
}

function calculateLookbackAts(targetAt: string): Record<TidePredictionChangeWindowHours, string> {
  const targetMs = Date.parse(targetAt);
  return {
    1: new Date(targetMs - 1 * 60 * 60 * 1000).toISOString(),
    3: new Date(targetMs - 3 * 60 * 60 * 1000).toISOString(),
    6: new Date(targetMs - 6 * 60 * 60 * 1000).toISOString()
  };
}

function groupMappingsByNode(mappings: readonly HydroCoastalStationNodeMapping[]): Map<string, HydroCoastalStationNodeMapping[]> {
  const grouped = new Map<string, HydroCoastalStationNodeMapping[]>();
  for (const mapping of mappings) {
    grouped.set(mapping.habitatNodeId, [...(grouped.get(mapping.habitatNodeId) ?? []), mapping]);
  }
  return grouped;
}

function emptyFeature(input: {
  nodeId: string;
  calculatedAt: string;
  targetAt: string;
  inputObservationCount: number;
  selectedAsOfObservationCount: number;
  nodeObservationCount: number;
  errors: string[];
  warnings: string[];
  missingReasons: HydroCoastalFeatureMissingReason[];
  provenance: HydroCoastalFeatureProvenance[];
}): NodeHydroCoastalFeatures {
  return {
    schemaVersion: NODE_HYDRO_COASTAL_FEATURE_SCHEMA_VERSION,
    nodeId: input.nodeId,
    calculatedAt: input.calculatedAt,
    targetAt: input.targetAt,
    providerId: null,
    stationId: null,
    forecastIssuedAt: null,
    sourceCollectedAt: null,
    mappingMethod: null,
    mappingDistanceKm: null,
    mappingConfidence: null,
    verticalDatum: null,
    tideLevelCm: null,
    tideLevelM: null,
    tideLevelTpM: null,
    change1hCm: null,
    change3hCm: null,
    change6hCm: null,
    rate1hCmPerHour: null,
    rate3hCmPerHour: null,
    rate6hCmPerHour: null,
    trend1h: "unknown",
    dataQuality: {
      requiredObservationCount: REQUIRED_OBSERVATION_COUNT,
      availableObservationCount: 0,
      missingRate: 1,
      confidence: null,
      inputObservationCount: input.inputObservationCount,
      selectedAsOfObservationCount: input.selectedAsOfObservationCount,
      nodeObservationCount: input.nodeObservationCount
    },
    provenance: input.provenance,
    missingReasons: [...input.missingReasons],
    errors: input.errors,
    warnings: input.warnings
  };
}

function finalizeFeature(feature: NodeHydroCoastalFeatures): NodeHydroCoastalFeatures {
  feature.errors = unique(feature.errors);
  feature.warnings = unique(feature.warnings);
  feature.missingReasons = unique(feature.missingReasons);
  feature.provenance = dedupeProvenance(feature.provenance);
  return feature;
}

function addDefaultMissingProvenance(
  feature: NodeHydroCoastalFeatures,
  reason: HydroCoastalFeatureMissingReason,
  mapping?: HydroCoastalStationNodeMapping,
  observation?: HydroCoastalObservation
): void {
  for (const field of FEATURE_FIELDS) {
    feature.provenance.push(provenanceForField(field, feature.nodeId, feature.targetAt, mapping, observation, {
      missingReasons: [reason]
    }));
  }
}

function addChangeMissing(
  feature: NodeHydroCoastalFeatures,
  nodeId: string,
  targetAt: string,
  mapping: HydroCoastalStationNodeMapping,
  targetObservation: HydroCoastalObservation,
  lookbackAt: string,
  windowHours: TidePredictionChangeWindowHours,
  missingReasons: readonly HydroCoastalFeatureMissingReason[],
  lookbackObservation?: HydroCoastalObservation
): void {
  addMissingReasons(feature, missingReasons);
  feature.provenance.push(provenanceForChange(`change${windowHours}hCm`, nodeId, targetAt, mapping, targetObservation, lookbackObservation, lookbackAt, windowHours, [...missingReasons]));
  feature.provenance.push(provenanceForChange(`rate${windowHours}hCmPerHour`, nodeId, targetAt, mapping, targetObservation, lookbackObservation, lookbackAt, windowHours, [...missingReasons]));
}

function setChangeAndRate(
  feature: NodeHydroCoastalFeatures,
  windowHours: TidePredictionChangeWindowHours,
  changeCm: number,
  rateCmPerHour: number
): void {
  switch (windowHours) {
    case 1:
      feature.change1hCm = changeCm;
      feature.rate1hCmPerHour = rateCmPerHour;
      return;
    case 3:
      feature.change3hCm = changeCm;
      feature.rate3hCmPerHour = rateCmPerHour;
      return;
    case 6:
      feature.change6hCm = changeCm;
      feature.rate6hCmPerHour = rateCmPerHour;
      return;
  }
}

function provenanceForField(
  field: string,
  nodeId: string,
  targetAt: string,
  mapping?: HydroCoastalStationNodeMapping,
  observation?: HydroCoastalObservation,
  overrides: Partial<HydroCoastalFeatureProvenance> = {}
): HydroCoastalFeatureProvenance {
  return {
    field,
    providerId: observation?.providerId ?? mapping?.providerId ?? null,
    stationId: observation?.stationId ?? mapping?.stationId ?? null,
    nodeId,
    targetAt,
    forecastIssuedAt: observation?.forecastIssuedAt ?? null,
    collectedAt: observation?.collectedAt ?? null,
    observationIdentityKey: observation ? hydroCoastalObservationIdentityKey(observation) : undefined,
    observationVersionKey: observation ? hydroCoastalObservationVersionKey(observation) : undefined,
    mappingMethod: mapping?.mappingMethod ?? null,
    mappingDistanceKm: mapping?.distanceKm ?? null,
    mappingSource: mapping?.provenance.source ?? null,
    mappingReviewedAt: mapping?.provenance.reviewedAt ?? null,
    missingReasons: [],
    ...overrides
  };
}

function provenanceForChange(
  field: string,
  nodeId: string,
  targetAt: string,
  mapping: HydroCoastalStationNodeMapping,
  targetObservation: HydroCoastalObservation,
  lookbackObservation: HydroCoastalObservation | undefined,
  lookbackAt: string,
  windowHours: TidePredictionChangeWindowHours,
  missingReasons: HydroCoastalFeatureMissingReason[] = []
): HydroCoastalFeatureProvenance {
  return {
    field,
    providerId: targetObservation.providerId,
    stationId: targetObservation.stationId,
    nodeId,
    targetAt,
    forecastIssuedAt: targetObservation.forecastIssuedAt,
    collectedAt: targetObservation.collectedAt,
    targetObservationIdentityKey: hydroCoastalObservationIdentityKey(targetObservation),
    targetObservationVersionKey: hydroCoastalObservationVersionKey(targetObservation),
    lookbackObservationIdentityKey: lookbackObservation ? hydroCoastalObservationIdentityKey(lookbackObservation) : undefined,
    lookbackObservationVersionKey: lookbackObservation ? hydroCoastalObservationVersionKey(lookbackObservation) : undefined,
    lookbackAt,
    windowHours,
    mappingMethod: mapping.mappingMethod,
    mappingDistanceKm: mapping.distanceKm,
    mappingSource: mapping.provenance.source,
    mappingReviewedAt: mapping.provenance.reviewedAt,
    missingReasons
  };
}

function isMatchingMappedObservation(
  mapped: HydroCoastalMappedObservation,
  mapping: HydroCoastalStationNodeMapping,
  observedAt: string
): boolean {
  return (
    mapped.habitatNodeId === mapping.habitatNodeId &&
    mapped.observation.providerId === mapping.providerId &&
    mapped.observation.stationId === mapping.stationId &&
    mapped.observation.observedAt === observedAt
  );
}

function compareForecastVintageDescending(left: HydroCoastalMappedObservation, right: HydroCoastalMappedObservation): number {
  const forecastDelta = Date.parse(right.observation.forecastIssuedAt ?? "") - Date.parse(left.observation.forecastIssuedAt ?? "");
  if (forecastDelta !== 0) return forecastDelta;
  const collectedDelta = Date.parse(right.observation.collectedAt) - Date.parse(left.observation.collectedAt);
  if (collectedDelta !== 0) return collectedDelta;
  return hydroCoastalObservationVersionKey(left.observation).localeCompare(hydroCoastalObservationVersionKey(right.observation));
}

function mappingStationKey(mapping: HydroCoastalStationNodeMapping): string {
  return `${mapping.providerId}|${mapping.stationId}`;
}

function mappingPairKey(mapping: HydroCoastalStationNodeMapping): string {
  return `${mapping.providerId}|${mapping.stationId}|${mapping.habitatNodeId}`;
}

function isMappingActiveAt(mapping: HydroCoastalStationNodeMapping, observedAt: string): boolean {
  if (!isCanonicalUtcIsoDateTime(observedAt)) return false;
  const observedAtMs = Date.parse(observedAt);
  return Date.parse(mapping.validFrom) <= observedAtMs && (mapping.validTo == null || observedAtMs < Date.parse(mapping.validTo));
}

function attributeAsOfDiagnosticsToNodes(
  errors: readonly string[],
  warnings: readonly string[],
  mappings: readonly HydroCoastalStationNodeMapping[],
  habitatGraph: HabitatGraph,
  targetTimes: ReadonlySet<string>
): Map<string, AttributedHydroCoastalDiagnostic[]> {
  const diagnosticsByNode = new Map<string, AttributedHydroCoastalDiagnostic[]>();
  const nodeIds = new Set(habitatGraph.nodes.map((node) => node.id));
  const messages: Array<{ message: string; prefix: string; reason: HydroCoastalFeatureMissingReason }> = [
    ...errors.map((message) => ({
      message,
      prefix: "conflicting hydro-coastal observation version: ",
      reason: "conflicting-observation" as const
    })),
    ...warnings.map((message) => ({
      message,
      prefix: "future hydro-coastal revision excluded: ",
      reason: "future-revision-excluded" as const
    }))
  ];

  for (const item of messages) {
    if (!item.message.startsWith(item.prefix)) continue;
    const versionKey = item.message.slice(item.prefix.length);
    const parsed = parseHydroCoastalVersionKey(versionKey);
    if (
      !parsed ||
      parsed.metric !== "predicted-tide-level" ||
      !targetTimes.has(parsed.observedAt)
    ) {
      continue;
    }
    for (const mapping of mappings) {
      if (
        mapping.providerId !== parsed.providerId ||
        mapping.stationId !== parsed.stationId ||
        !nodeIds.has(mapping.habitatNodeId) ||
        !isMappingActiveAt(mapping, parsed.observedAt)
      ) {
        continue;
      }
      pushMap(diagnosticsByNode, mapping.habitatNodeId, {
        reason: item.reason,
        observedAt: parsed.observedAt,
        versionKey
      });
    }
  }
  return diagnosticsByNode;
}

function parseHydroCoastalVersionKey(versionKey: string): ParsedHydroCoastalVersionKey | null {
  const parts = versionKey.split("|");
  if (parts.length !== 6) return null;
  const [providerId, stationId, metric, observedAt, forecastIssuedAt, collectedAt] = parts;
  if (!isHydroCoastalProviderId(providerId)) return null;
  if (!stationId || !metric || !isCanonicalUtcIsoDateTime(observedAt) || !isCanonicalUtcIsoDateTime(collectedAt)) return null;
  if (forecastIssuedAt !== "none" && !isCanonicalUtcIsoDateTime(forecastIssuedAt)) return null;
  return {
    providerId,
    stationId,
    metric,
    observedAt,
    forecastIssuedAt: forecastIssuedAt === "none" ? null : forecastIssuedAt,
    collectedAt
  };
}

function diagnosticsForTime(
  diagnostics: readonly AttributedHydroCoastalDiagnostic[],
  observedAt: string
): AttributedHydroCoastalDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.observedAt === observedAt);
}

function addMissingReason(feature: NodeHydroCoastalFeatures, reason: HydroCoastalFeatureMissingReason): void {
  feature.missingReasons.push(reason);
}

function addMissingReasons(feature: NodeHydroCoastalFeatures, reasons: readonly HydroCoastalFeatureMissingReason[]): void {
  for (const reason of reasons) addMissingReason(feature, reason);
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function uniqueMappings(values: readonly HydroCoastalStationNodeMapping[]): HydroCoastalStationNodeMapping[] {
  const seen = new Set<string>();
  const uniqueValues: HydroCoastalStationNodeMapping[] = [];
  for (const value of values) {
    const key = stableSerialize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueValues.push(value);
  }
  return uniqueValues;
}

function dedupeProvenance(values: readonly HydroCoastalFeatureProvenance[]): HydroCoastalFeatureProvenance[] {
  const seen = new Set<string>();
  const result: HydroCoastalFeatureProvenance[] = [];
  for (const value of values) {
    const key = stableSerialize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...value,
      missingReasons: unique(value.missingReasons)
    });
  }
  return result;
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

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isExactUtcHour(value: string): boolean {
  const date = new Date(value);
  return date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isZeroToOne(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isHydroCoastalProviderId(value: unknown): value is HydroCoastalProviderId {
  return typeof value === "string" && (HYDRO_COASTAL_PROVIDER_IDS as readonly string[]).includes(value);
}

function validateProvenanceEntry(entry: unknown, index: number, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`provenance[${index}] must be an object.`);
    return;
  }
  if (!isNonEmptyString(entry.field)) errors.push(`provenance[${index}].field must not be empty.`);
  if (!isNonEmptyString(entry.nodeId)) errors.push(`provenance[${index}].nodeId must not be empty.`);
  if (!isCanonicalUtcIsoDateTime(entry.targetAt)) errors.push(`provenance[${index}].targetAt must be canonical UTC ISO datetime.`);
  if (!Array.isArray(entry.missingReasons)) {
    errors.push(`provenance[${index}].missingReasons must be an array.`);
  } else {
    for (const reason of entry.missingReasons) {
      if (!isHydroCoastalFeatureMissingReason(reason)) {
        errors.push(`provenance[${index}].missingReasons contains invalid reason: ${String(reason)}.`);
      }
    }
  }
  if (entry.mappingDistanceKm !== null && entry.mappingDistanceKm !== undefined && (!isFiniteNumber(entry.mappingDistanceKm) || entry.mappingDistanceKm < 0)) {
    errors.push(`provenance[${index}].mappingDistanceKm must be null or finite >= 0.`);
  }
  if (entry.forecastIssuedAt !== null && entry.forecastIssuedAt !== undefined && !isCanonicalUtcIsoDateTime(entry.forecastIssuedAt)) {
    errors.push(`provenance[${index}].forecastIssuedAt must be null or canonical UTC ISO datetime.`);
  }
  if (entry.collectedAt !== null && entry.collectedAt !== undefined && !isCanonicalUtcIsoDateTime(entry.collectedAt)) {
    errors.push(`provenance[${index}].collectedAt must be null or canonical UTC ISO datetime.`);
  }
}

function isHydroCoastalFeatureMissingReason(value: unknown): value is HydroCoastalFeatureMissingReason {
  return typeof value === "string" && (HYDRO_COASTAL_FEATURE_MISSING_REASONS as readonly string[]).includes(value);
}

function isHydroCoastalStationNodeMappingMethod(value: unknown): value is HydroCoastalStationNodeMappingMethod {
  return typeof value === "string" && ["explicit", "hydrological", "manual-reviewed"].includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
