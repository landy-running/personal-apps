import { type HabitatGraph } from "./habitat";

export const HYDRO_COASTAL_SCHEMA_VERSION = "wanoku-hydro-coastal-observation.v1";

export const HYDRO_COASTAL_METRICS = [
  "predicted-tide-level",
  "observed-tide-level",
  "tide-anomaly",
  "river-stage",
  "river-discharge",
  "river-water-temperature",
  "significant-wave-height",
  "significant-wave-period",
  "wave-direction",
  "coastal-water-temperature"
] as const;

export type HydroCoastalMetric = typeof HYDRO_COASTAL_METRICS[number];

export const HYDRO_COASTAL_UNITS = ["cm", "m", "m3/s", "celsius", "second", "degree"] as const;

export type HydroCoastalUnit = typeof HYDRO_COASTAL_UNITS[number];

export const HYDRO_COASTAL_STATUSES = ["predicted", "observed", "reanalyzed", "missing", "invalid"] as const;

export type HydroCoastalStatus = typeof HYDRO_COASTAL_STATUSES[number];

export const HYDRO_COASTAL_STATION_TYPES = [
  "tide-gauge",
  "river-gauge",
  "wave-buoy",
  "coastal-observation",
  "forecast-point"
] as const;

export type HydroCoastalStationType = typeof HYDRO_COASTAL_STATION_TYPES[number];

export const HYDRO_COASTAL_PROVIDER_IDS = [
  "jma-tide-prediction",
  "jma-tide-observation",
  "nowphas-wave",
  "mlit-river",
  "jcg-marine-information"
] as const;

export type HydroCoastalProviderId = typeof HYDRO_COASTAL_PROVIDER_IDS[number];

export type VerticalDatumType =
  | "tide-table-datum"
  | "observation-datum"
  | "tp"
  | "local-river-datum"
  | "mean-sea-level"
  | "unknown";

export type VerticalDatum = {
  type: VerticalDatumType;
  stationSpecific: boolean;
  offsetToTpM: number | null;
  description: string;
};

export type HydroCoastalProvenance = {
  sourceName: string;
  sourceKind: "official" | "licensed" | "manual" | "synthetic-fixture";
  sourceUrl?: string;
  sourceTimestamp?: string;
  sourceTimezone?: string;
  normalizedAt: string;
  parserId?: string;
  parserVersion?: string;
  sourceFormatVersion?: string;
  attribution?: string;
  notes?: string[];
};

export type HydroCoastalObservation = {
  schemaVersion: string;
  providerId: HydroCoastalProviderId;
  stationId: string;
  metric: HydroCoastalMetric;
  observedAt: string;
  collectedAt: string;
  forecastIssuedAt: string | null;
  value: number | null;
  unit: HydroCoastalUnit;
  status: HydroCoastalStatus;
  provisional: boolean;
  verticalDatum: VerticalDatum | null;
  provenance: HydroCoastalProvenance;
};

export type HydroCoastalStation = {
  stationId: string;
  providerId: HydroCoastalProviderId;
  name: string;
  latitude: number;
  longitude: number;
  stationType: HydroCoastalStationType;
  supportedMetrics: HydroCoastalMetric[];
  timezone: string;
  active: boolean;
  verticalDatum: VerticalDatum | null;
  sourceMetadata: {
    authority: string;
    sourceName: string;
    sourceUrl?: string;
    syntheticFixture?: boolean;
    notes?: string[];
  };
};

export type HydroCoastalProviderDefinition = {
  providerId: HydroCoastalProviderId;
  authority: string;
  sourceKind: "official" | "licensed" | "registry";
  accessMode: "manual-file" | "documented-download" | "licensed-distribution" | "registry-only";
  updateCadence: string;
  supportedMetrics: HydroCoastalMetric[];
  timeSemantics: string;
  datumSemantics: string;
  automatedAcquisitionAllowed: boolean;
  implementationStatus: "registry-only" | "adapter-not-implemented" | "manual-fixture-only" | "parser-implemented" | "implemented";
  notes: string[];
};

export type HydroCoastalStationNodeMapping = {
  providerId: HydroCoastalProviderId;
  stationId: string;
  habitatNodeId: string;
  mappingMethod: HydroCoastalStationNodeMappingMethod;
  distanceKm: number;
  confidence: number | null;
  validFrom: string;
  validTo: string | null;
  provenance: {
    source: string;
    reviewedAt: string;
    notes: string[];
  };
};

export const HYDRO_COASTAL_STATION_NODE_MAPPING_METHODS = ["explicit", "hydrological", "manual-reviewed"] as const;

export type HydroCoastalStationNodeMappingMethod = typeof HYDRO_COASTAL_STATION_NODE_MAPPING_METHODS[number];

export type HydroCoastalValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type HydroCoastalValidationContext = {
  station?: HydroCoastalStation;
  provider?: HydroCoastalProviderDefinition;
};

export type HydroCoastalAsOfSelectionResult = {
  observations: HydroCoastalObservation[];
  errors: string[];
  warnings: string[];
  excludedObservationCount: number;
};

export type HydroCoastalMappedObservation = {
  observation: HydroCoastalObservation;
  habitatNodeId: string;
  mapping: HydroCoastalStationNodeMapping;
};

export type HydroCoastalObservationMappingResult = {
  mappedObservations: HydroCoastalMappedObservation[];
  unmappedStationKeys: string[];
  mappingsWithUnknownHabitatNode: HydroCoastalStationNodeMapping[];
  warnings: string[];
};

export type HydroCoastalParseContext = {
  provider: HydroCoastalProviderDefinition;
  stations: readonly HydroCoastalStation[];
  collectedAt: string;
  normalizedAt: string;
};

export type HydroCoastalParseResult = {
  providerId: HydroCoastalProviderId;
  sourceFormatVersion: string;
  observations: HydroCoastalObservation[];
  errors: string[];
  warnings: string[];
};

export type HydroCoastalProviderAdapter<Input = unknown, Context = HydroCoastalParseContext> = {
  providerId: HydroCoastalProviderId;
  sourceFormatVersion: string;
  parse(input: Input, context: Context): HydroCoastalParseResult;
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WATER_LEVEL_METRICS = new Set<HydroCoastalMetric>([
  "predicted-tide-level",
  "observed-tide-level",
  "tide-anomaly",
  "river-stage"
]);
const NON_NEGATIVE_METRICS = new Set<HydroCoastalMetric>([
  "significant-wave-height",
  "significant-wave-period",
  "river-discharge"
]);

const METRIC_UNITS: Record<HydroCoastalMetric, readonly HydroCoastalUnit[]> = {
  "predicted-tide-level": ["cm", "m"],
  "observed-tide-level": ["cm", "m"],
  "tide-anomaly": ["cm", "m"],
  "river-stage": ["cm", "m"],
  "river-discharge": ["m3/s"],
  "river-water-temperature": ["celsius"],
  "significant-wave-height": ["m"],
  "significant-wave-period": ["second"],
  "wave-direction": ["degree"],
  "coastal-water-temperature": ["celsius"]
};

export function validateVerticalDatum(datum: unknown, required = false): HydroCoastalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (datum == null) {
    if (required) errors.push("verticalDatum is required.");
    return result(errors, warnings);
  }
  if (!isRecord(datum)) {
    errors.push("verticalDatum must be an object.");
    return result(errors, warnings);
  }
  if (!isVerticalDatumType(datum.type)) errors.push(`verticalDatum.type is invalid: ${String(datum.type)}.`);
  if (typeof datum.stationSpecific !== "boolean") errors.push("verticalDatum.stationSpecific must be boolean.");
  if (datum.offsetToTpM !== null && !isFiniteNumber(datum.offsetToTpM)) {
    errors.push("verticalDatum.offsetToTpM must be a finite number or null.");
  }
  if (typeof datum.description !== "string" || !datum.description.trim()) {
    errors.push("verticalDatum.description must not be empty.");
  }
  if (datum.type === "unknown") {
    if (datum.offsetToTpM !== null) errors.push("verticalDatum.type=unknown requires offsetToTpM=null.");
    warnings.push("verticalDatum is unknown and cannot be compared or converted.");
  }
  if (datum.type === "tp" && datum.offsetToTpM !== null && datum.offsetToTpM !== 0) {
    errors.push("verticalDatum.type=tp allows only offsetToTpM=null or 0.");
  }
  return result(errors, warnings);
}

export function canCompareVerticalDatums(left: VerticalDatum | null | undefined, right: VerticalDatum | null | undefined): boolean {
  if (!left || !right) return false;
  if (!validateVerticalDatum(left).valid || !validateVerticalDatum(right).valid) return false;
  if (left.type === "unknown" || right.type === "unknown") return false;
  if (left.type === "tp" && right.type === "tp") return true;
  return isFiniteNumber(left.offsetToTpM) && isFiniteNumber(right.offsetToTpM);
}

export function convertWaterLevelToTp(valueM: number, datum: VerticalDatum | null | undefined): number | null {
  if (!isFiniteNumber(valueM) || !datum) return null;
  if (!validateVerticalDatum(datum).valid) return null;
  if (datum.type === "unknown") return null;
  if (datum.type === "tp") return valueM;
  if (isFiniteNumber(datum.offsetToTpM)) return round(valueM + datum.offsetToTpM, 6);
  return null;
}

export function hydroCoastalObservationIdentityKey(observation: Pick<HydroCoastalObservation, "providerId" | "stationId" | "metric" | "observedAt" | "forecastIssuedAt">): string {
  return [
    observation.providerId,
    observation.stationId,
    observation.metric,
    observation.observedAt,
    observation.forecastIssuedAt ?? "none"
  ].join("|");
}

export function hydroCoastalObservationVersionKey(observation: Pick<HydroCoastalObservation, "providerId" | "stationId" | "metric" | "observedAt" | "forecastIssuedAt" | "collectedAt">): string {
  return [
    hydroCoastalObservationIdentityKey(observation),
    observation.collectedAt
  ].join("|");
}

export function selectHydroCoastalObservationsAsOf(
  observations: readonly unknown[],
  calculatedAt: string
): HydroCoastalAsOfSelectionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isCanonicalUtcIsoDateTime(calculatedAt)) {
    return {
      observations: [],
      errors: ["calculatedAt must be canonical UTC ISO datetime."],
      warnings,
      excludedObservationCount: observations.length
    };
  }

  const calculatedAtMs = Date.parse(calculatedAt);
  const eligible: HydroCoastalObservation[] = [];
  for (const candidate of observations) {
    const validation = validateHydroCoastalObservation(candidate);
    warnings.push(...validation.warnings);
    if (!validation.valid) {
      errors.push(...validation.errors);
      continue;
    }
    const observation = candidate as HydroCoastalObservation;
    if (Date.parse(observation.collectedAt) > calculatedAtMs) {
      warnings.push(`future hydro-coastal revision excluded: ${hydroCoastalObservationVersionKey(observation)}`);
      continue;
    }
    eligible.push(observation);
  }

  const byVersion = new Map<string, HydroCoastalObservation[]>();
  for (const observation of eligible) {
    const key = hydroCoastalObservationVersionKey(observation);
    byVersion.set(key, [...(byVersion.get(key) ?? []), observation]);
  }

  const deduped: HydroCoastalObservation[] = [];
  for (const [versionKey, group] of byVersion.entries()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    const serializations = new Set(group.map(stableSerialize));
    if (serializations.size === 1) {
      warnings.push(`duplicate hydro-coastal observation ignored: ${versionKey}`);
      deduped.push(group[0]);
    } else {
      errors.push(`conflicting hydro-coastal observation version: ${versionKey}`);
    }
  }

  const byIdentity = new Map<string, HydroCoastalObservation[]>();
  for (const observation of deduped) {
    const key = hydroCoastalObservationIdentityKey(observation);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), observation]);
  }

  const selected = Array.from(byIdentity.values())
    .map((items) => items.slice().sort(compareObservationRevision).at(-1))
    .filter((item): item is HydroCoastalObservation => Boolean(item))
    .sort(compareObservationStable);

  return {
    observations: selected,
    errors,
    warnings,
    excludedObservationCount: observations.length - selected.length
  };
}

export function validateHydroCoastalObservation(
  observation: unknown,
  context: HydroCoastalValidationContext = {}
): HydroCoastalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(observation)) {
    errors.push("observation must be an object.");
    return result(errors, warnings);
  }

  if (observation.schemaVersion !== HYDRO_COASTAL_SCHEMA_VERSION) errors.push("schemaVersion is not supported.");
  if (!isNonEmptyString(observation.providerId)) {
    errors.push("providerId must not be empty.");
  } else if (!isHydroCoastalProviderId(observation.providerId)) {
    errors.push(`providerId is unknown: ${String(observation.providerId)}.`);
  }
  if (!isNonEmptyString(observation.stationId)) errors.push("stationId must not be empty.");
  const metricValid = isHydroCoastalMetric(observation.metric);
  const unitValid = isHydroCoastalUnit(observation.unit);
  const statusValid = isHydroCoastalStatus(observation.status);
  const observedAtValid = isCanonicalUtcIsoDateTime(observation.observedAt);
  const collectedAtValid = isCanonicalUtcIsoDateTime(observation.collectedAt);
  const forecastIssuedAtValid = observation.forecastIssuedAt === null || isCanonicalUtcIsoDateTime(observation.forecastIssuedAt);
  const metric: HydroCoastalMetric | null = metricValid ? observation.metric as HydroCoastalMetric : null;
  const unit: HydroCoastalUnit | null = unitValid ? observation.unit as HydroCoastalUnit : null;
  const status: HydroCoastalStatus | null = statusValid ? observation.status as HydroCoastalStatus : null;
  const observedAt: string | null = observedAtValid ? observation.observedAt as string : null;
  const collectedAt: string | null = collectedAtValid ? observation.collectedAt as string : null;
  const forecastIssuedAt: string | null = isCanonicalUtcIsoDateTime(observation.forecastIssuedAt) ? observation.forecastIssuedAt : null;

  if (!metricValid) errors.push(`metric is invalid: ${String(observation.metric)}.`);
  if (!unitValid) errors.push(`unit is invalid: ${String(observation.unit)}.`);
  if (!statusValid) errors.push(`status is invalid: ${String(observation.status)}.`);
  if (!observedAtValid) errors.push("observedAt must be canonical UTC ISO datetime.");
  if (!collectedAtValid) errors.push("collectedAt must be canonical UTC ISO datetime.");
  if (!forecastIssuedAtValid) {
    errors.push("forecastIssuedAt must be canonical UTC ISO datetime when present.");
  }
  if (status === "predicted" && metric != null && metric !== "predicted-tide-level") {
    errors.push("status=predicted is only valid for metric=predicted-tide-level.");
  }
  if (metric === "predicted-tide-level" && observation.forecastIssuedAt == null) {
    errors.push("predicted-tide-level requires forecastIssuedAt.");
  }
  if (status === "predicted" && observation.forecastIssuedAt == null) {
    errors.push("predicted observations require forecastIssuedAt.");
  }
  if (
    status === "predicted" &&
    observedAt != null &&
    collectedAt != null &&
    forecastIssuedAt != null
  ) {
    if (Date.parse(forecastIssuedAt) > Date.parse(collectedAt)) {
      errors.push("predicted forecastIssuedAt must be <= collectedAt.");
    }
    if (Date.parse(forecastIssuedAt) > Date.parse(observedAt)) {
      errors.push("predicted forecastIssuedAt must be <= observedAt.");
    }
  }
  if (
    (status === "observed" || status === "reanalyzed") &&
    observedAt != null &&
    collectedAt != null &&
    Date.parse(observedAt) > Date.parse(collectedAt)
  ) {
    errors.push("observed/reanalyzed observedAt must be <= collectedAt.");
  }
  if (status === "missing") {
    if (observation.value !== null) errors.push("status=missing requires value=null.");
  } else if (status === "invalid") {
    if (observation.value !== null) errors.push("status=invalid requires value=null.");
  } else if (!isFiniteNumber(observation.value)) {
    errors.push("value must be finite unless status=missing or status=invalid.");
  }
  if (metric != null && isFiniteNumber(observation.value) && NON_NEGATIVE_METRICS.has(metric) && observation.value < 0) {
    errors.push(`${metric} must be non-negative.`);
  }
  if (metric === "wave-direction" && isFiniteNumber(observation.value) && (observation.value < 0 || observation.value >= 360)) {
    errors.push("wave-direction must be within [0, 360).");
  }
  if (metric != null && unit != null && !METRIC_UNITS[metric].includes(unit)) {
    errors.push(`unit ${unit} is not compatible with metric ${metric}.`);
  }
  const datum = validateVerticalDatum(observation.verticalDatum, metric != null && WATER_LEVEL_METRICS.has(metric));
  errors.push(...datum.errors);
  warnings.push(...datum.warnings);
  if (typeof observation.provisional !== "boolean") errors.push("provisional must be boolean.");
  validateProvenance(observation.provenance, errors);

  if (context.station && isNonEmptyString(observation.providerId) && isNonEmptyString(observation.stationId) && metric != null) {
    if (context.station.providerId !== observation.providerId) errors.push("station.providerId does not match observation.providerId.");
    if (context.station.stationId !== observation.stationId) errors.push("station.stationId does not match observation.stationId.");
    if (!context.station.supportedMetrics.includes(metric)) errors.push("station does not support observation metric.");
  }
  if (context.provider && isNonEmptyString(observation.providerId) && metric != null) {
    if (context.provider.providerId !== observation.providerId) errors.push("provider.providerId does not match observation.providerId.");
    if (!context.provider.supportedMetrics.includes(metric)) errors.push("provider does not support observation metric.");
  }

  return result(errors, warnings);
}

export function validateHydroCoastalStation(station: unknown): HydroCoastalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(station)) {
    errors.push("station must be an object.");
    return result(errors, warnings);
  }
  if (!isNonEmptyString(station.stationId)) errors.push("stationId must not be empty.");
  if (!isNonEmptyString(station.providerId)) {
    errors.push("providerId must not be empty.");
  } else if (!isHydroCoastalProviderId(station.providerId)) {
    errors.push(`providerId is unknown: ${String(station.providerId)}.`);
  }
  if (!isNonEmptyString(station.name)) errors.push("name must not be empty.");
  if (!isFiniteNumber(station.latitude) || station.latitude < -90 || station.latitude > 90) errors.push("latitude must be finite and within [-90, 90].");
  if (!isFiniteNumber(station.longitude) || station.longitude < -180 || station.longitude > 180) errors.push("longitude must be finite and within [-180, 180].");
  if (!isHydroCoastalStationType(station.stationType)) errors.push(`stationType is invalid: ${String(station.stationType)}.`);
  if (!Array.isArray(station.supportedMetrics) || !station.supportedMetrics.length) errors.push("supportedMetrics must not be empty.");
  const metricSet = new Set<HydroCoastalMetric>();
  for (const metric of Array.isArray(station.supportedMetrics) ? station.supportedMetrics : []) {
    if (!isHydroCoastalMetric(metric)) {
      errors.push(`supportedMetrics contains invalid metric: ${String(metric)}.`);
      continue;
    }
    if (metricSet.has(metric)) errors.push(`supportedMetrics contains duplicate metric: ${metric}.`);
    metricSet.add(metric);
  }
  if (!isNonEmptyString(station.timezone)) errors.push("timezone must not be empty.");
  if (typeof station.active !== "boolean") errors.push("active must be boolean.");
  const datum = validateVerticalDatum(station.verticalDatum, Array.from(metricSet).some((metric) => WATER_LEVEL_METRICS.has(metric)));
  errors.push(...datum.errors);
  warnings.push(...datum.warnings);
  if (!isRecord(station.sourceMetadata)) {
    errors.push("sourceMetadata must be an object.");
  } else {
    if (!isNonEmptyString(station.sourceMetadata.authority)) errors.push("sourceMetadata.authority must not be empty.");
    if (!isNonEmptyString(station.sourceMetadata.sourceName)) errors.push("sourceMetadata.sourceName must not be empty.");
  }
  return result(errors, warnings);
}

export function validateHydroCoastalProviderDefinition(provider: unknown): HydroCoastalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(provider)) {
    errors.push("provider must be an object.");
    return result(errors, warnings);
  }
  if (!isNonEmptyString(provider.providerId)) {
    errors.push("providerId must not be empty.");
  } else if (!isHydroCoastalProviderId(provider.providerId)) {
    errors.push(`providerId is unknown: ${String(provider.providerId)}.`);
  }
  if (!isNonEmptyString(provider.authority)) errors.push("authority must not be empty.");
  if (typeof provider.sourceKind !== "string" || !["official", "licensed", "registry"].includes(provider.sourceKind)) errors.push(`sourceKind is invalid: ${String(provider.sourceKind)}.`);
  if (typeof provider.accessMode !== "string" || !["manual-file", "documented-download", "licensed-distribution", "registry-only"].includes(provider.accessMode)) {
    errors.push(`accessMode is invalid: ${String(provider.accessMode)}.`);
  }
  if (!isNonEmptyString(provider.updateCadence)) errors.push("updateCadence must not be empty.");
  if (!Array.isArray(provider.supportedMetrics) || !provider.supportedMetrics.length) errors.push("supportedMetrics must not be empty.");
  const metricSet = new Set<HydroCoastalMetric>();
  for (const metric of Array.isArray(provider.supportedMetrics) ? provider.supportedMetrics : []) {
    if (!isHydroCoastalMetric(metric)) {
      errors.push(`supportedMetrics contains invalid metric: ${String(metric)}.`);
      continue;
    }
    if (metricSet.has(metric)) errors.push(`supportedMetrics contains duplicate metric: ${metric}.`);
    metricSet.add(metric);
  }
  if (!isNonEmptyString(provider.timeSemantics)) errors.push("timeSemantics must not be empty.");
  if (!isNonEmptyString(provider.datumSemantics)) errors.push("datumSemantics must not be empty.");
  if (typeof provider.automatedAcquisitionAllowed !== "boolean") errors.push("automatedAcquisitionAllowed must be boolean.");
  if (typeof provider.implementationStatus !== "string" || !["registry-only", "adapter-not-implemented", "manual-fixture-only", "parser-implemented", "implemented"].includes(provider.implementationStatus)) {
    errors.push(`implementationStatus is invalid: ${String(provider.implementationStatus)}.`);
  }
  if (provider.accessMode === "registry-only" && provider.automatedAcquisitionAllowed) {
    errors.push("registry-only providers must not enable automated acquisition.");
  }
  if (provider.implementationStatus !== "implemented" && provider.automatedAcquisitionAllowed) {
    errors.push("automated acquisition requires implementationStatus=implemented.");
  }
  return result(errors, warnings);
}

export function validateHydroCoastalStationNodeMapping(mapping: unknown): HydroCoastalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(mapping)) {
    errors.push("mapping must be an object.");
    return result(errors, warnings);
  }
  if (!isNonEmptyString(mapping.providerId)) {
    errors.push("providerId must not be empty.");
  } else if (!isHydroCoastalProviderId(mapping.providerId)) {
    errors.push(`providerId is unknown: ${String(mapping.providerId)}.`);
  }
  if (!isNonEmptyString(mapping.stationId)) errors.push("stationId must not be empty.");
  if (!isNonEmptyString(mapping.habitatNodeId)) errors.push("habitatNodeId must not be empty.");
  if (!isHydroCoastalStationNodeMappingMethod(mapping.mappingMethod)) {
    errors.push(`mappingMethod is invalid: ${String(mapping.mappingMethod)}.`);
  }
  if (!isFiniteNumber(mapping.distanceKm) || mapping.distanceKm < 0) {
    errors.push("distanceKm must be finite and >= 0.");
  }
  if (mapping.confidence !== null && !isZeroToOne(mapping.confidence)) {
    errors.push("confidence must be null or within [0, 1].");
  }
  const validFromOk = isCanonicalUtcIsoDateTime(mapping.validFrom);
  const validToOk = mapping.validTo === null || isCanonicalUtcIsoDateTime(mapping.validTo);
  if (!validFromOk) errors.push("validFrom must be canonical UTC ISO datetime.");
  if (!validToOk) errors.push("validTo must be null or canonical UTC ISO datetime.");
  if (validFromOk && validToOk && typeof mapping.validFrom === "string" && typeof mapping.validTo === "string" && Date.parse(mapping.validFrom) >= Date.parse(mapping.validTo)) {
    errors.push("validFrom must be < validTo.");
  }
  if (!isRecord(mapping.provenance)) {
    errors.push("provenance must be an object.");
  } else {
    if (!isNonEmptyString(mapping.provenance.source)) errors.push("provenance.source must not be empty.");
    if (!isCanonicalUtcIsoDateTime(mapping.provenance.reviewedAt)) errors.push("provenance.reviewedAt must be canonical UTC ISO datetime.");
    if (!Array.isArray(mapping.provenance.notes)) errors.push("provenance.notes must be an array.");
  }
  return result(errors, warnings);
}

export function mapHydroCoastalObservationsToHabitatNodes(
  observations: readonly HydroCoastalObservation[],
  mappings: readonly HydroCoastalStationNodeMapping[],
  habitatGraph?: HabitatGraph
): HydroCoastalObservationMappingResult {
  const habitatNodeIds = new Set(habitatGraph?.nodes.map((node) => node.id) ?? []);
  const mappingsWithUnknownHabitatNode = habitatGraph
    ? findMappingsWithUnknownHabitatNode(mappings, habitatGraph)
    : [];
  const mappingByStation = new Map<string, HydroCoastalStationNodeMapping[]>();
  for (const mapping of mappings) {
    const validation = validateHydroCoastalStationNodeMapping(mapping);
    if (!validation.valid) {
      continue;
    }
    const key = stationKey(mapping.providerId, mapping.stationId);
    mappingByStation.set(key, [...(mappingByStation.get(key) ?? []), mapping]);
  }

  const mappedObservations: HydroCoastalMappedObservation[] = [];
  const unmapped = new Set<string>();
  const warnings: string[] = [];
  for (const observation of observations) {
    const key = stationKey(observation.providerId, observation.stationId);
    const stationMappings = mappingByStation.get(key) ?? [];
    if (!stationMappings.length) {
      unmapped.add(key);
      continue;
    }
    for (const mapping of stationMappings) {
      if (!isMappingActiveForObservation(mapping, observation)) {
        warnings.push(`mapping outside validity period: ${stationKey(mapping.providerId, mapping.stationId)}|${mapping.habitatNodeId}`);
        continue;
      }
      if (habitatGraph && !habitatNodeIds.has(mapping.habitatNodeId)) {
        warnings.push(`mapping references unknown habitat node: ${mapping.habitatNodeId}`);
        continue;
      }
      mappedObservations.push({ observation, habitatNodeId: mapping.habitatNodeId, mapping });
    }
  }

  return {
    mappedObservations,
    unmappedStationKeys: Array.from(unmapped).sort(),
    mappingsWithUnknownHabitatNode,
    warnings
  };
}

export function findUnmappedHydroCoastalStations(
  stations: readonly HydroCoastalStation[],
  mappings: readonly HydroCoastalStationNodeMapping[]
): string[] {
  const mapped = new Set(mappings.map((mapping) => stationKey(mapping.providerId, mapping.stationId)));
  return stations
    .map((station) => stationKey(station.providerId, station.stationId))
    .filter((key) => !mapped.has(key))
    .sort();
}

export function findMappingsWithUnknownHabitatNode(
  mappings: readonly HydroCoastalStationNodeMapping[],
  habitatGraph: HabitatGraph
): HydroCoastalStationNodeMapping[] {
  const nodeIds = new Set(habitatGraph.nodes.map((node) => node.id));
  return mappings.filter((mapping) => !nodeIds.has(mapping.habitatNodeId));
}

export const HYDRO_COASTAL_PROVIDER_DEFINITIONS: HydroCoastalProviderDefinition[] = [
  {
    providerId: "jma-tide-prediction",
    authority: "Japan Meteorological Agency",
    sourceKind: "official",
    accessMode: "documented-download",
    updateCadence: "provider documented tide table updates",
    supportedMetrics: ["predicted-tide-level"],
    timeSemantics: "observedAt is predicted tide target time; forecastIssuedAt identifies the published table or model vintage when known.",
    datumSemantics: "Tide table datum is station-specific. Do not compare with TP unless offsetToTpM is known.",
    automatedAcquisitionAllowed: false,
    implementationStatus: "parser-implemented",
    notes: [
      "Phase 3B-1 implements a local documented fixed-width text parser only.",
      "No download, live acquisition, Worker, D1, or Cron integration is implemented.",
      "Use documented downloads only; do not rely on scraping."
    ]
  },
  {
    providerId: "jma-tide-observation",
    authority: "Japan Meteorological Agency",
    sourceKind: "official",
    accessMode: "documented-download",
    updateCadence: "provider documented observation updates",
    supportedMetrics: ["observed-tide-level", "tide-anomaly"],
    timeSemantics: "observedAt is observation target time; collectedAt is Wanoku acquisition time.",
    datumSemantics: "Observation datum is station-specific unless official TP offset is provided.",
    automatedAcquisitionAllowed: false,
    implementationStatus: "adapter-not-implemented",
    notes: ["Adapter not implemented.", "Reconfirm official terms and file format before automation."]
  },
  {
    providerId: "nowphas-wave",
    authority: "NOWPHAS",
    sourceKind: "official",
    accessMode: "documented-download",
    updateCadence: "provider documented wave observation updates",
    supportedMetrics: ["significant-wave-height", "significant-wave-period", "wave-direction", "coastal-water-temperature"],
    timeSemantics: "observedAt is wave observation or forecast target time.",
    datumSemantics: "Wave metrics do not use vertical datum; water temperature has no vertical datum.",
    automatedAcquisitionAllowed: false,
    implementationStatus: "adapter-not-implemented",
    notes: ["No unauthorized scraping.", "Adapter must normalize official records before returning observations."]
  },
  {
    providerId: "mlit-river",
    authority: "Ministry of Land, Infrastructure, Transport and Tourism",
    sourceKind: "licensed",
    accessMode: "licensed-distribution",
    updateCadence: "depends on licensed dataset",
    supportedMetrics: ["river-stage", "river-discharge", "river-water-temperature"],
    timeSemantics: "observedAt is river observation target time.",
    datumSemantics: "River stage datum is local and station-specific unless official TP offset is provided.",
    automatedAcquisitionAllowed: false,
    implementationStatus: "registry-only",
    notes: ["Live acquisition is disabled until terms, distribution method, and format are confirmed."]
  },
  {
    providerId: "jcg-marine-information",
    authority: "Japan Coast Guard",
    sourceKind: "registry",
    accessMode: "registry-only",
    updateCadence: "not configured",
    supportedMetrics: ["coastal-water-temperature"],
    timeSemantics: "registry only in Phase 3A.",
    datumSemantics: "No vertical datum conversion is defined.",
    automatedAcquisitionAllowed: false,
    implementationStatus: "registry-only",
    notes: ["Registry placeholder only.", "Do not implement acquisition before source terms and formats are confirmed."]
  }
];

export const SYNTHETIC_HYDRO_COASTAL_STATIONS: HydroCoastalStation[] = [
  {
    stationId: "synthetic-jma-tokyo-tide-prediction",
    providerId: "jma-tide-prediction",
    name: "Synthetic JMA Tokyo Tide Prediction Station",
    latitude: 35.62,
    longitude: 139.77,
    stationType: "tide-gauge",
    supportedMetrics: ["predicted-tide-level"],
    timezone: "Asia/Tokyo",
    active: true,
    verticalDatum: {
      type: "tide-table-datum",
      stationSpecific: true,
      offsetToTpM: null,
      description: "Synthetic fixture datum. Not an official station datum."
    },
    sourceMetadata: {
      authority: "Japan Meteorological Agency",
      sourceName: "Synthetic fixture for contract tests",
      syntheticFixture: true,
      notes: ["Not an observed or predicted real tide value."]
    }
  },
  {
    stationId: "synthetic-jma-tokyo-tide-observation",
    providerId: "jma-tide-observation",
    name: "Synthetic JMA Tokyo Tide Observation Station",
    latitude: 35.61,
    longitude: 139.78,
    stationType: "tide-gauge",
    supportedMetrics: ["observed-tide-level", "tide-anomaly"],
    timezone: "Asia/Tokyo",
    active: true,
    verticalDatum: {
      type: "observation-datum",
      stationSpecific: true,
      offsetToTpM: null,
      description: "Synthetic fixture datum. Not an official observation datum."
    },
    sourceMetadata: {
      authority: "Japan Meteorological Agency",
      sourceName: "Synthetic fixture for contract tests",
      syntheticFixture: true,
      notes: ["Not a real observation."]
    }
  },
  {
    stationId: "synthetic-nowphas-tokyo-bay-wave",
    providerId: "nowphas-wave",
    name: "Synthetic NOWPHAS Tokyo Bay Wave Station",
    latitude: 35.45,
    longitude: 139.82,
    stationType: "wave-buoy",
    supportedMetrics: ["significant-wave-height", "significant-wave-period", "wave-direction"],
    timezone: "Asia/Tokyo",
    active: true,
    verticalDatum: null,
    sourceMetadata: {
      authority: "NOWPHAS",
      sourceName: "Synthetic fixture for contract tests",
      syntheticFixture: true,
      notes: ["Not a real wave observation."]
    }
  },
  {
    stationId: "synthetic-mlit-arakawa-river",
    providerId: "mlit-river",
    name: "Synthetic MLIT Arakawa River Station",
    latitude: 35.68,
    longitude: 139.83,
    stationType: "river-gauge",
    supportedMetrics: ["river-stage", "river-discharge", "river-water-temperature"],
    timezone: "Asia/Tokyo",
    active: true,
    verticalDatum: {
      type: "local-river-datum",
      stationSpecific: true,
      offsetToTpM: null,
      description: "Synthetic fixture datum. Not an official river datum."
    },
    sourceMetadata: {
      authority: "Ministry of Land, Infrastructure, Transport and Tourism",
      sourceName: "Synthetic fixture for contract tests",
      syntheticFixture: true,
      notes: ["Not a real river observation."]
    }
  }
];

export const SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS: HydroCoastalObservation[] = [
  syntheticObservation({
    providerId: "jma-tide-prediction",
    stationId: "synthetic-jma-tokyo-tide-prediction",
    metric: "predicted-tide-level",
    forecastIssuedAt: "2026-07-12T15:00:00.000Z",
    value: 120,
    unit: "cm",
    status: "predicted",
    verticalDatum: SYNTHETIC_HYDRO_COASTAL_STATIONS[0].verticalDatum
  }),
  syntheticObservation({
    providerId: "jma-tide-observation",
    stationId: "synthetic-jma-tokyo-tide-observation",
    metric: "observed-tide-level",
    forecastIssuedAt: null,
    value: 1.18,
    unit: "m",
    status: "observed",
    verticalDatum: SYNTHETIC_HYDRO_COASTAL_STATIONS[1].verticalDatum
  }),
  syntheticObservation({
    providerId: "nowphas-wave",
    stationId: "synthetic-nowphas-tokyo-bay-wave",
    metric: "significant-wave-height",
    forecastIssuedAt: null,
    value: 0.4,
    unit: "m",
    status: "observed",
    verticalDatum: null
  }),
  syntheticObservation({
    providerId: "mlit-river",
    stationId: "synthetic-mlit-arakawa-river",
    metric: "river-discharge",
    forecastIssuedAt: null,
    value: 45,
    unit: "m3/s",
    status: "observed",
    verticalDatum: null
  })
];

export const SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS: HydroCoastalStationNodeMapping[] = [
  syntheticMapping("jma-tide-prediction", "synthetic-jma-tokyo-tide-prediction", "tokyo-inner-bay-01", 3.2),
  syntheticMapping("jma-tide-observation", "synthetic-jma-tokyo-tide-observation", "tokyo-inner-bay-01", 2.9),
  syntheticMapping("nowphas-wave", "synthetic-nowphas-tokyo-bay-wave", "bay-center-north-01", 4.8),
  syntheticMapping("mlit-river", "synthetic-mlit-arakawa-river", "sumida-arakawa-mouth-01", 1.7)
];

function syntheticObservation(input: {
  providerId: HydroCoastalProviderId;
  stationId: string;
  metric: HydroCoastalMetric;
  forecastIssuedAt: string | null;
  value: number;
  unit: HydroCoastalUnit;
  status: HydroCoastalStatus;
  verticalDatum: VerticalDatum | null;
}): HydroCoastalObservation {
  return {
    schemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
    providerId: input.providerId,
    stationId: input.stationId,
    metric: input.metric,
    observedAt: "2026-07-13T00:00:00.000Z",
    collectedAt: "2026-07-13T00:10:00.000Z",
    forecastIssuedAt: input.forecastIssuedAt,
    value: input.value,
    unit: input.unit,
    status: input.status,
    provisional: true,
    verticalDatum: input.verticalDatum,
    provenance: {
      sourceName: "Wanoku synthetic hydro-coastal fixture",
      sourceKind: "synthetic-fixture",
      sourceTimestamp: "2026-07-13T09:00:00+09:00",
      sourceTimezone: "Asia/Tokyo",
      normalizedAt: "2026-07-13T00:10:00.000Z",
      notes: ["Synthetic fixture only. Do not treat as official observed data."]
    }
  };
}

function syntheticMapping(
  providerId: HydroCoastalProviderId,
  stationId: string,
  habitatNodeId: string,
  distanceKm: number
): HydroCoastalStationNodeMapping {
  return {
    providerId,
    stationId,
    habitatNodeId,
    mappingMethod: "explicit",
    distanceKm,
    confidence: null,
    validFrom: "2026-07-13T00:00:00.000Z",
    validTo: null,
    provenance: {
      source: "packages/wanoku-core/src/hydro-coastal.ts synthetic explicit mapping fixture",
      reviewedAt: "2026-07-13T00:00:00.000Z",
      notes: ["Explicit synthetic mapping for contract tests. Not generated by nearest-neighbor."]
    }
  };
}

function validateProvenance(provenance: unknown, errors: string[]): void {
  if (!isRecord(provenance)) {
    errors.push("provenance must be an object.");
    return;
  }
  if (!isNonEmptyString(provenance.sourceName)) errors.push("provenance.sourceName must not be empty.");
  if (typeof provenance.sourceKind !== "string" || !["official", "licensed", "manual", "synthetic-fixture"].includes(provenance.sourceKind)) {
    errors.push(`provenance.sourceKind is invalid: ${String(provenance.sourceKind)}.`);
  }
  if (!isCanonicalUtcIsoDateTime(provenance.normalizedAt)) errors.push("provenance.normalizedAt must be canonical UTC ISO datetime.");
}

function result(errors: string[], warnings: string[]): HydroCoastalValidationResult {
  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings))
  };
}

function stationKey(providerId: HydroCoastalProviderId, stationId: string): string {
  return `${providerId}|${stationId}`;
}

function isMappingActiveForObservation(mapping: HydroCoastalStationNodeMapping, observation: HydroCoastalObservation): boolean {
  if (!isCanonicalUtcIsoDateTime(observation.observedAt)) return false;
  const observedAtMs = Date.parse(observation.observedAt);
  const validFromMs = Date.parse(mapping.validFrom);
  const validToMs = mapping.validTo == null ? null : Date.parse(mapping.validTo);
  return validFromMs <= observedAtMs && (validToMs == null || observedAtMs < validToMs);
}

function compareObservationRevision(left: HydroCoastalObservation, right: HydroCoastalObservation): number {
  const collectedDelta = Date.parse(left.collectedAt) - Date.parse(right.collectedAt);
  if (collectedDelta !== 0) return collectedDelta;
  return hydroCoastalObservationVersionKey(left).localeCompare(hydroCoastalObservationVersionKey(right));
}

function compareObservationStable(left: HydroCoastalObservation, right: HydroCoastalObservation): number {
  return hydroCoastalObservationVersionKey(left).localeCompare(hydroCoastalObservationVersionKey(right));
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

function isHydroCoastalMetric(value: unknown): value is HydroCoastalMetric {
  return typeof value === "string" && (HYDRO_COASTAL_METRICS as readonly string[]).includes(value);
}

function isHydroCoastalUnit(value: unknown): value is HydroCoastalUnit {
  return typeof value === "string" && (HYDRO_COASTAL_UNITS as readonly string[]).includes(value);
}

function isHydroCoastalStatus(value: unknown): value is HydroCoastalStatus {
  return typeof value === "string" && (HYDRO_COASTAL_STATUSES as readonly string[]).includes(value);
}

function isHydroCoastalProviderId(value: unknown): value is HydroCoastalProviderId {
  return typeof value === "string" && (HYDRO_COASTAL_PROVIDER_IDS as readonly string[]).includes(value);
}

function isHydroCoastalStationType(value: unknown): value is HydroCoastalStationType {
  return typeof value === "string" && (HYDRO_COASTAL_STATION_TYPES as readonly string[]).includes(value);
}

function isHydroCoastalStationNodeMappingMethod(value: unknown): value is HydroCoastalStationNodeMappingMethod {
  return typeof value === "string" && (HYDRO_COASTAL_STATION_NODE_MAPPING_METHODS as readonly string[]).includes(value);
}

function isVerticalDatumType(value: unknown): value is VerticalDatumType {
  return typeof value === "string" && [
    "tide-table-datum",
    "observation-datum",
    "tp",
    "local-river-datum",
    "mean-sea-level",
    "unknown"
  ].includes(value);
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isZeroToOne(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
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
