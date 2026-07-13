import { angleDiff } from "./angle";

export const ENVIRONMENT_WINDOW_HOURS = [3, 6, 12, 24, 48, 72] as const;

export type EnvironmentWindowHour = typeof ENVIRONMENT_WINDOW_HOURS[number];
export type EnvironmentWindowKey = `${EnvironmentWindowHour}h`;

export type DataProvenance = {
  provider: string;
  source: string;
  model?: string;
  requestedAt?: string;
  completedAt?: string;
  collectedAt?: string;
  forecastIssuedAt?: string | null;
  status?: "ok" | "partial" | "failed";
  httpStatus?: number;
  errorCode?: "timeout" | "http_error" | "malformed_response" | "network_error" | "validation" | "unknown";
  modelVersion?: string;
  rawHash?: string;
  normalizedSchemaVersion: string;
  attribution?: string;
};

type BaseEnvironmentalObservation = {
  observedAt: string;
  collectedAt: string;
  forecastIssuedAt?: string | null;
  latitude: number;
  longitude: number;
  coordinateDistanceKm?: number;
  source: string;
  model?: string;
  confidence: number;
  freshness: number;
  missingFields: string[];
  provenance?: DataProvenance[];
};

export type WeatherObservation = BaseEnvironmentalObservation & {
  windSpeed?: number;
  windDirection?: number;
  windGust?: number;
  pressure?: number;
  pressureTrend?: number;
  precipitation?: number;
  accumulatedRain?: number;
  airTemperature?: number;
};

export type MarineObservation = BaseEnvironmentalObservation & {
  waveHeight?: number;
  waveDirection?: number;
  wavePeriod?: number;
  windWaveHeight?: number;
  windWaveDirection?: number;
  windWavePeriod?: number;
  swellHeight?: number;
  swellDirection?: number;
  swellPeriod?: number;
  seaSurfaceTemperature?: number;
  oceanCurrentVelocity?: number;
  oceanCurrentDirection?: number;
  seaLevelHeightMsl?: number;
};

export type EnvironmentalSnapshot = BaseEnvironmentalObservation & {
  nodeId?: string;
  windSpeed?: number;
  windDirection?: number;
  windGust?: number;
  pressure?: number;
  pressureTrend?: number;
  precipitation?: number;
  accumulatedRain?: number;
  airTemperature?: number;
  waveHeight?: number;
  waveDirection?: number;
  wavePeriod?: number;
  windWaveHeight?: number;
  windWaveDirection?: number;
  windWavePeriod?: number;
  swellHeight?: number;
  swellDirection?: number;
  swellPeriod?: number;
  seaSurfaceTemperature?: number;
  oceanCurrentVelocity?: number;
  oceanCurrentDirection?: number;
  seaLevelHeightMsl?: number;
};

export type WindContinuity = {
  windowHours: EnvironmentWindowHour;
  sampleCount: number;
  meanSpeed?: number;
  directionStability?: number;
  dominantDirection?: number;
};

export type RapidChange = {
  field: "windSpeed" | "pressure" | "waveHeight" | "seaSurfaceTemperature" | "seaLevelHeightMsl";
  severity: "watch" | "alert";
  delta: number;
  windowHours: number;
};

export type EnvironmentalFeatureVector = {
  nodeId?: string;
  observedAt: string;
  collectedAt: string;
  forecastIssuedAt?: string;
  latitude: number;
  longitude: number;
  coordinateDistanceKm?: number;
  windContinuity: Record<EnvironmentWindowKey, WindContinuity>;
  pressureChangeHpaPerHour?: number;
  accumulatedRain: Record<EnvironmentWindowKey, number>;
  waveHeightChangeM?: number;
  wavePeriodChangeSec?: number;
  windWaveToSwellRatio?: number;
  seaSurfaceTemperatureChangeC?: number;
  oceanCurrentVector?: { east: number; north: number; speed: number; direction: number };
  seaLevelHeightChangeM?: number;
  rapidChanges: RapidChange[];
  missingRate: number;
  freshness: number;
};

export type EnvironmentalQualityReport = {
  snapshotKey: string;
  nodeId?: string;
  observedAt: string;
  collectedAt: string;
  forecastIssuedAt?: string | null;
  coordinateDistanceKm?: number | null;
  freshness: number;
  missingRate: number;
  confidence: number;
  missingFields: string[];
  stale: boolean;
  warnings: string[];
};

export type EnvironmentalContradiction = {
  leftKey: string;
  rightKey: string;
  field: "windSpeed" | "windDirection" | "seaSurfaceTemperature" | "seaLevelHeightMsl";
  delta: number;
  severity: "watch" | "alert";
};

export const ENVIRONMENTAL_SCHEMA_VERSION = "wanoku-environmental-snapshot.v1";

export const ENVIRONMENTAL_REQUIRED_FIELDS = [
  "observedAt",
  "collectedAt",
  "latitude",
  "longitude",
  "windSpeed",
  "windDirection",
  "pressure",
  "precipitation",
  "airTemperature",
  "waveHeight",
  "wavePeriod",
  "seaSurfaceTemperature",
  "source",
  "confidence",
  "freshness"
] as const;

export function environmentalSnapshotKey(snapshot: EnvironmentalSnapshot): string {
  const vintage = snapshot.forecastIssuedAt
    ? `issued:${snapshot.forecastIssuedAt}`
    : `collected:${snapshot.collectedAt}`;
  return [
    snapshot.nodeId || "unknown-node",
    snapshot.source || "unknown-source",
    snapshot.observedAt,
    vintage,
    ENVIRONMENTAL_SCHEMA_VERSION
  ].join("|");
}

export function calculateMissingFields(
  snapshot: Partial<EnvironmentalSnapshot>,
  fields: readonly string[] = ENVIRONMENTAL_REQUIRED_FIELDS
): string[] {
  return fields.filter((field) => {
    const value = (snapshot as Record<string, unknown>)[field];
    return value == null || value === "" || (typeof value === "number" && !Number.isFinite(value));
  });
}

export function calculateMissingRate(
  snapshot: Partial<EnvironmentalSnapshot>,
  fields: readonly string[] = ENVIRONMENTAL_REQUIRED_FIELDS
): number {
  if (!fields.length) return 0;
  return calculateMissingFields(snapshot, fields).length / fields.length;
}

export function calculateDataFreshness(snapshot: Pick<EnvironmentalSnapshot, "observedAt" | "collectedAt" | "forecastIssuedAt">, asOf: string | Date = new Date()): number {
  const basisMs = Math.max(parseTime(snapshot.observedAt), parseTime(snapshot.collectedAt), parseTime(snapshot.forecastIssuedAt));
  const asOfMs = typeof asOf === "string" ? Date.parse(asOf) : asOf.getTime();
  if (!Number.isFinite(basisMs) || !Number.isFinite(asOfMs)) return 0;
  const ageHours = Math.max(0, (asOfMs - basisMs) / 3600_000);
  return clamp01(Math.exp(-ageHours / 18));
}

export function calculateEnvironmentalQuality(
  snapshot: EnvironmentalSnapshot,
  asOf: string | Date = new Date()
): EnvironmentalQualityReport {
  const missingFields = Array.from(new Set([...snapshot.missingFields, ...calculateMissingFields(snapshot)]));
  const freshness = Math.min(snapshot.freshness, calculateDataFreshness(snapshot, asOf));
  const missingRate = missingFields.length / ENVIRONMENTAL_REQUIRED_FIELDS.length;
  const warnings: string[] = [];
  if (freshness < 0.35) warnings.push("stale_environmental_data");
  if (missingRate > 0.25) warnings.push("many_missing_fields");
  if (snapshot.confidence < 0.5) warnings.push("low_provider_confidence");
  if (isFiniteNumber(snapshot.windSpeed) && isFiniteNumber(snapshot.windGust) && snapshot.windGust < snapshot.windSpeed) {
    warnings.push("wind_gust_below_sustained_wind");
  }

  return {
    snapshotKey: environmentalSnapshotKey(snapshot),
    nodeId: snapshot.nodeId,
    observedAt: snapshot.observedAt,
    collectedAt: snapshot.collectedAt,
    forecastIssuedAt: snapshot.forecastIssuedAt,
    coordinateDistanceKm: snapshot.coordinateDistanceKm ?? null,
    freshness,
    missingRate,
    confidence: clamp01(snapshot.confidence * (1 - missingRate) * (0.5 + freshness / 2)),
    missingFields,
    stale: freshness < 0.35,
    warnings
  };
}

export function buildEnvironmentalFeatureVector(
  snapshots: readonly EnvironmentalSnapshot[],
  asOf: string | Date = new Date()
): EnvironmentalFeatureVector {
  const sorted = snapshots
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.observedAt)))
    .slice()
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (!sorted.length) {
    throw new RangeError("at least one valid environmental snapshot is required.");
  }

  const latest = sorted[sorted.length - 1];
  const windContinuity = Object.fromEntries(
    ENVIRONMENT_WINDOW_HOURS.map((hours) => [`${hours}h`, calculateWindContinuity(sorted, hours)])
  ) as Record<EnvironmentWindowKey, WindContinuity>;

  return {
    nodeId: latest.nodeId,
    observedAt: latest.observedAt,
    collectedAt: latest.collectedAt,
    forecastIssuedAt: latest.forecastIssuedAt || undefined,
    coordinateDistanceKm: latest.coordinateDistanceKm,
    latitude: latest.latitude,
    longitude: latest.longitude,
    windContinuity,
    pressureChangeHpaPerHour: calculateRate(sorted, "pressure", 24),
    accumulatedRain: Object.fromEntries(
      ENVIRONMENT_WINDOW_HOURS.map((hours) => [`${hours}h`, sumWindow(sorted, "precipitation", hours)])
    ) as Record<EnvironmentWindowKey, number>,
    waveHeightChangeM: calculateDelta(sorted, "waveHeight", 24),
    wavePeriodChangeSec: calculateDelta(sorted, "wavePeriod", 24),
    windWaveToSwellRatio: ratio(latest.windWaveHeight ?? latest.waveHeight, latest.swellHeight),
    seaSurfaceTemperatureChangeC: calculateDelta(sorted, "seaSurfaceTemperature", 24),
    oceanCurrentVector: vectorFromDirection(latest.oceanCurrentVelocity, latest.oceanCurrentDirection),
    seaLevelHeightChangeM: calculateDelta(sorted, "seaLevelHeightMsl", 24),
    rapidChanges: detectRapidEnvironmentalChanges(sorted),
    missingRate: calculateMissingRate(latest),
    freshness: Math.min(latest.freshness, calculateDataFreshness(latest, asOf))
  };
}

export function detectRapidEnvironmentalChanges(snapshots: readonly EnvironmentalSnapshot[]): RapidChange[] {
  const sorted = snapshots
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.observedAt)))
    .slice()
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (sorted.length < 2) return [];

  const changes: RapidChange[] = [];
  pushRapidChange(changes, sorted, "windSpeed", 6, 5, 8);
  pushRapidChange(changes, sorted, "pressure", 6, -4, -8);
  pushRapidChange(changes, sorted, "waveHeight", 6, 0.5, 1.0);
  pushRapidChange(changes, sorted, "seaSurfaceTemperature", 24, 1.5, 2.5);
  pushRapidChange(changes, sorted, "seaLevelHeightMsl", 6, 0.25, 0.45);
  return changes;
}

export function detectEnvironmentalContradictions(
  snapshots: readonly EnvironmentalSnapshot[]
): EnvironmentalContradiction[] {
  const out: EnvironmentalContradiction[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    for (let j = i + 1; j < snapshots.length; j++) {
      const left = snapshots[i];
      const right = snapshots[j];
      if ((left.nodeId || "") !== (right.nodeId || "")) continue;
      if (Math.abs(Date.parse(left.observedAt) - Date.parse(right.observedAt)) > 3600_000) continue;
      maybeContradiction(out, left, right, "windSpeed", 4, 8);
      maybeDirectionContradiction(out, left, right);
      maybeContradiction(out, left, right, "seaSurfaceTemperature", 1.5, 3);
      maybeContradiction(out, left, right, "seaLevelHeightMsl", 0.25, 0.5);
    }
  }

  return out;
}

function calculateWindContinuity(snapshots: readonly EnvironmentalSnapshot[], hours: EnvironmentWindowHour): WindContinuity {
  const windowed = withinWindow(snapshots, hours).filter((snapshot) => isFiniteNumber(snapshot.windSpeed) || isFiniteNumber(snapshot.windDirection));
  const latestDirection = lastFinite(windowed.map((snapshot) => snapshot.windDirection));
  const directions = windowed.map((snapshot) => snapshot.windDirection).filter(isFiniteNumber);
  const meanSpeed = average(windowed.map((snapshot) => snapshot.windSpeed).filter(isFiniteNumber));
  const meanDirectionDiff = average(directions.map((direction) => angleDiff(latestDirection ?? direction, direction)));
  const directionStability = latestDirection == null || !directions.length
    ? undefined
    : clamp01(1 - (meanDirectionDiff ?? 0) / 180);

  return {
    windowHours: hours,
    sampleCount: windowed.length,
    meanSpeed,
    directionStability,
    dominantDirection: latestDirection
  };
}

function withinWindow<T extends { observedAt: string }>(items: readonly T[], hours: number): T[] {
  if (!items.length) return [];
  const latestMs = Math.max(...items.map((item) => Date.parse(item.observedAt)).filter(Number.isFinite));
  return items.filter((item) => {
    const itemMs = Date.parse(item.observedAt);
    return Number.isFinite(itemMs) && latestMs - itemMs <= hours * 3600_000;
  });
}

function sumWindow(snapshots: readonly EnvironmentalSnapshot[], field: keyof EnvironmentalSnapshot, hours: number): number {
  return withinWindow(snapshots, hours)
    .map((snapshot) => snapshot[field])
    .filter(isFiniteNumber)
    .reduce((total, value) => total + value, 0);
}

function calculateDelta(snapshots: readonly EnvironmentalSnapshot[], field: keyof EnvironmentalSnapshot, hours: number): number | undefined {
  const windowed = withinWindow(snapshots, hours);
  const latest = lastFinite(windowed.map((snapshot) => snapshot[field]));
  const earliest = firstFinite(windowed.map((snapshot) => snapshot[field]));
  if (latest == null || earliest == null) return undefined;
  return round(latest - earliest, 4);
}

function calculateRate(snapshots: readonly EnvironmentalSnapshot[], field: keyof EnvironmentalSnapshot, hours: number): number | undefined {
  const windowed = withinWindow(snapshots, hours).filter((snapshot) => isFiniteNumber(snapshot[field]));
  if (windowed.length < 2) return undefined;
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const delta = (last[field] as number) - (first[field] as number);
  const elapsedHours = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3600_000;
  return elapsedHours > 0 ? round(delta / elapsedHours, 4) : undefined;
}

function vectorFromDirection(speed?: number, direction?: number): EnvironmentalFeatureVector["oceanCurrentVector"] {
  if (!isFiniteNumber(speed) || !isFiniteNumber(direction)) return undefined;
  const radians = normalizeDegrees(direction) * Math.PI / 180;
  return {
    east: round(speed * Math.sin(radians), 4),
    north: round(speed * Math.cos(radians), 4),
    speed,
    direction: normalizeDegrees(direction)
  };
}

function ratio(a?: number, b?: number): number | undefined {
  if (!isFiniteNumber(a) || !isFiniteNumber(b) || b <= 0) return undefined;
  return round(a / b, 4);
}

function pushRapidChange(
  out: RapidChange[],
  snapshots: readonly EnvironmentalSnapshot[],
  field: RapidChange["field"],
  hours: number,
  watchThreshold: number,
  alertThreshold: number
): void {
  const delta = calculateDelta(snapshots, field, hours);
  if (delta == null) return;
  const signed = field === "pressure" ? -delta : delta;
  if (signed >= Math.abs(alertThreshold)) {
    out.push({ field, severity: "alert", delta, windowHours: hours });
  } else if (signed >= Math.abs(watchThreshold)) {
    out.push({ field, severity: "watch", delta, windowHours: hours });
  }
}

function maybeContradiction(
  out: EnvironmentalContradiction[],
  left: EnvironmentalSnapshot,
  right: EnvironmentalSnapshot,
  field: EnvironmentalContradiction["field"],
  watchThreshold: number,
  alertThreshold: number
): void {
  const leftValue = left[field];
  const rightValue = right[field];
  if (!isFiniteNumber(leftValue) || !isFiniteNumber(rightValue)) return;
  const delta = Math.abs(leftValue - rightValue);
  if (delta >= alertThreshold) {
    out.push({ leftKey: environmentalSnapshotKey(left), rightKey: environmentalSnapshotKey(right), field, delta, severity: "alert" });
  } else if (delta >= watchThreshold) {
    out.push({ leftKey: environmentalSnapshotKey(left), rightKey: environmentalSnapshotKey(right), field, delta, severity: "watch" });
  }
}

function maybeDirectionContradiction(out: EnvironmentalContradiction[], left: EnvironmentalSnapshot, right: EnvironmentalSnapshot): void {
  if (!isFiniteNumber(left.windDirection) || !isFiniteNumber(right.windDirection)) return;
  const delta = angleDiff(left.windDirection, right.windDirection);
  if (delta >= 120) {
    out.push({ leftKey: environmentalSnapshotKey(left), rightKey: environmentalSnapshotKey(right), field: "windDirection", delta, severity: "alert" });
  } else if (delta >= 75) {
    out.push({ leftKey: environmentalSnapshotKey(left), rightKey: environmentalSnapshotKey(right), field: "windDirection", delta, severity: "watch" });
  }
}

function parseTime(value?: string | null): number {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function normalizeDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function average(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function firstFinite(values: readonly unknown[]): number | undefined {
  return values.find(isFiniteNumber);
}

function lastFinite(values: readonly unknown[]): number | undefined {
  return values.slice().reverse().find(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
