// Fixed-Node Signal v1: deterministic, as-of-safe biological signal computation from
// Fixed-Node daily observations (Honmoku / Daikoku / Isogo).
//
// This module is NOT Makuhari prediction, movement inference, Bay-wide occupancy,
// lead/lag analysis, or planner logic. Yokohama remains a WEST-SIDE SENTINEL only.
//
// It builds on Fixed-Node Distribution Profile v1 (scripts/wanoku-fixed-node-distribution-profile.mjs),
// importing and reusing its deterministic statistics primitives (quantile, median,
// medianAbsoluteDeviation, catchRate100, logOnePlus, addDaysIso), its row normalization
// (normalizeSourceRow) and valid-intensity rule (isValidIntensityRow), and its species
// constants, rather than duplicating them. Signal-specific concerns — versionKey/as-of
// revision selection, anomaly calculation, detection confidence, core bait aggregation,
// and West aggregation — live only here.
//
// No network access. No CLI. Pure functions over already-fetched rows.

import {
  CONTEXT_SPECIES_IDS,
  CORE_BAIT_SPECIES_IDS,
  REQUIRED_SPECIES_IDS,
  TARGET_SPECIES_ID,
  addDaysIso,
  catchRate100,
  isValidIntensityRow,
  logOnePlus,
  median,
  medianAbsoluteDeviation,
  normalizeSourceRow,
  quantile
} from "./wanoku-fixed-node-distribution-profile.mjs";

export {
  CONTEXT_SPECIES_IDS,
  CORE_BAIT_SPECIES_IDS,
  REQUIRED_SPECIES_IDS,
  TARGET_SPECIES_ID,
  addDaysIso,
  catchRate100,
  isValidIntensityRow,
  logOnePlus,
  median,
  medianAbsoluteDeviation,
  quantile
};

export const FIXED_NODE_SIGNAL_SCHEMA_VERSION = "wanoku-fixed-node-signal.v1";
export const FIXED_NODE_SIGNAL_ALGORITHM_VERSION = "fixed-node-signal.v1";

// Sorted alphabetically for deterministic iteration; these are the only facilities that
// may ever contribute to the Yokohama West aggregation.
export const WEST_FACILITY_IDS = Object.freeze(["yokohama-daikoku", "yokohama-honmoku", "yokohama-isogo"]);

export const DEFAULT_BASELINE_FROM_OFFSET_DAYS = 56; // t-56
export const DEFAULT_BASELINE_TO_OFFSET_DAYS = 8; // t-8 (t-7..t excluded)
export const DEFAULT_MIN_BASELINE_N = 21;
export const DEFAULT_SCALE_FLOOR = 0.25;
export const DEFAULT_Z_CLAMP_ABS = 4;
export const DEFAULT_MIN_REFERENCE_N = 21;
export const DEFAULT_CORE_BAIT_MIN_VALID_SPECIES = 3;
export const DEFAULT_WEST_MIN_CONTRIBUTING_FACILITIES = 2;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ALL_SPECIES_IN_SIGNAL_ORDER = Object.freeze([TARGET_SPECIES_ID, ...CORE_BAIT_SPECIES_IDS, ...CONTEXT_SPECIES_IDS]);

export class FixedNodeSignalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FixedNodeSignalError";
    this.code = code;
  }
}

function numericAscending(left, right) {
  return left - right;
}

// ---------------------------------------------------------------------------
// Row normalization
//
// Extends the profiler's normalizeSourceRow (which already validates and normalizes
// reportId, identityKey, facilityId, observationDate, collectedAt, visitorCount,
// operatingStatus, reportCompleteness, speciesId, catchCount, presenceState,
// speciesCompleteness, aliasCoverage) with versionKey, the as-of revision tiebreaker.
// The valid-intensity rule itself (isValidIntensityRow) is reused as-is from the
// profiler, unmodified.
// ---------------------------------------------------------------------------

export function normalizeSignalSourceRow(raw) {
  const base = normalizeSourceRow(raw);
  return Object.freeze({
    ...base,
    versionKey: requireNonEmptyString(raw.version_key ?? raw.report_id, "version_key")
  });
}

// ---------------------------------------------------------------------------
// As-of / revision selection
//
// Reuses this repository's existing as-of convention (see
// workers/wanoku-intel-worker/src/unified-observation-schema.test.js):
//   WHERE collected_at <= knowledgeAt
//   ORDER BY collected_at DESC, version_key DESC
//   (take the top row per identity_key)
//
// A "semantic identity" (identityKey) may have multiple report revisions (distinct
// reportId/versionKey, each collected at a different time). Only rows belonging to
// the latest eligible revision, as of knowledgeAt, are visible. Rows collected after
// knowledgeAt are invisible even if their observationDate is far in the past — this
// is what stops the August 2026 backfill from leaking into earlier historical
// knowledgeAt values.
// ---------------------------------------------------------------------------

export function selectAsOfRows(normalizedRows, knowledgeAt) {
  requireCanonicalUtcIso(knowledgeAt, "knowledgeAt");
  const eligible = normalizedRows.filter((row) => row.collectedAt <= knowledgeAt);

  const bestRevisionByIdentity = new Map(); // identityKey -> { reportId, collectedAt, versionKey }
  for (const row of eligible) {
    const current = bestRevisionByIdentity.get(row.identityKey);
    if (
      current === undefined
      || row.collectedAt > current.collectedAt
      || (row.collectedAt === current.collectedAt && row.versionKey > current.versionKey)
    ) {
      bestRevisionByIdentity.set(row.identityKey, {
        reportId: row.reportId,
        collectedAt: row.collectedAt,
        versionKey: row.versionKey
      });
    }
  }

  return eligible.filter((row) => bestRevisionByIdentity.get(row.identityKey).reportId === row.reportId);
}

// ---------------------------------------------------------------------------
// Robust standardization (baseline + z)
// ---------------------------------------------------------------------------

export function computeBaselineWindow(targetDate, config = {}) {
  const fromOffset = config.baselineFromOffsetDays ?? DEFAULT_BASELINE_FROM_OFFSET_DAYS;
  const toOffset = config.baselineToOffsetDays ?? DEFAULT_BASELINE_TO_OFFSET_DAYS;
  return {
    baselineStart: addDaysIso(targetDate, -fromOffset),
    baselineEnd: addDaysIso(targetDate, -toOffset)
  };
}

/**
 * Baseline sufficiency is checked before current-observation validity: if the baseline
 * itself is unavailable (N < minBaselineN), the signal is UNAVAILABLE regardless of
 * whether the current observation is valid. Only once the baseline is sufficient does
 * an invalid/unknown current observation yield UNKNOWN. This mirrors "presence and
 * intensity are separate concepts" — an anomaly can only ever be judged against a
 * baseline that itself exists.
 */
export function computeRobustAnomaly({ targetDate, currentValid, currentX, baselineXs }, config = {}) {
  const scaleFloor = config.scaleFloor ?? DEFAULT_SCALE_FLOOR;
  const minBaselineN = config.minBaselineN ?? DEFAULT_MIN_BASELINE_N;
  const zClampAbs = config.zClampAbs ?? DEFAULT_Z_CLAMP_ABS;
  const { baselineStart, baselineEnd } = computeBaselineWindow(targetDate, config);
  const baselineN = baselineXs.length;

  if (baselineN < minBaselineN) {
    return {
      available: false,
      reason: "baseline_insufficient",
      state: "UNAVAILABLE",
      baselineStart,
      baselineEnd,
      baselineN,
      baselineMedian: null,
      rawMad: null,
      robustScale: null,
      scaleFloor,
      scaleFloorApplied: null,
      effectiveScale: null,
      zRaw: null,
      z: null
    };
  }

  const baselineMedian = median(baselineXs);
  const rawMad = medianAbsoluteDeviation(baselineXs);
  const robustScale = 1.4826 * rawMad;
  const scaleFloorApplied = robustScale < scaleFloor;
  const effectiveScale = Math.max(robustScale, scaleFloor);

  if (!currentValid) {
    return {
      available: false,
      reason: "current_observation_invalid",
      state: "UNKNOWN",
      baselineStart,
      baselineEnd,
      baselineN,
      baselineMedian,
      rawMad,
      robustScale,
      scaleFloor,
      scaleFloorApplied,
      effectiveScale,
      zRaw: null,
      z: null
    };
  }

  const zRaw = (currentX - baselineMedian) / effectiveScale;
  const z = clamp(zRaw, -zClampAbs, zClampAbs);
  return {
    available: true,
    reason: null,
    state: classifyAnomalyState(z),
    baselineStart,
    baselineEnd,
    baselineN,
    baselineMedian,
    rawMad,
    robustScale,
    scaleFloor,
    scaleFloorApplied,
    effectiveScale,
    zRaw,
    z
  };
}

export function classifyAnomalyState(z) {
  if (z <= -1.5) return "STRONG_NEGATIVE";
  if (z <= -0.5) return "NEGATIVE";
  if (z < 0.5) return "NEUTRAL";
  if (z < 1.5) return "POSITIVE";
  return "STRONG_POSITIVE";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Detection confidence (per facility/date visitor-count context)
// ---------------------------------------------------------------------------

export function computeDetectionConfidence({ currentVisitorCount, referenceVisitorCounts }, config = {}) {
  const minReferenceN = config.minReferenceN ?? DEFAULT_MIN_REFERENCE_N;
  const referenceN = referenceVisitorCounts.length;
  const hasSufficientReference = referenceN >= minReferenceN;
  const sorted = [...referenceVisitorCounts].sort(numericAscending);
  const p33 = hasSufficientReference ? quantile(sorted, 1 / 3) : null;
  const p67 = hasSufficientReference ? quantile(sorted, 2 / 3) : null;
  const hasCurrentVisitorCount = currentVisitorCount !== null && currentVisitorCount !== undefined && currentVisitorCount > 0;

  let confidence = "UNKNOWN";
  if (hasSufficientReference && hasCurrentVisitorCount) {
    confidence = currentVisitorCount >= p67 ? "HIGH" : currentVisitorCount >= p33 ? "MEDIUM" : "LOW";
  }

  return {
    visitorCount: hasCurrentVisitorCount ? currentVisitorCount : null,
    referenceN,
    p33,
    p67,
    confidence
  };
}

// ---------------------------------------------------------------------------
// Core bait signal
// ---------------------------------------------------------------------------

export function computeCoreBaitSignal(coreSpeciesAnomalies, config = {}) {
  const minValidSpeciesCount = config.minValidSpeciesCount ?? DEFAULT_CORE_BAIT_MIN_VALID_SPECIES;
  const validEntries = coreSpeciesAnomalies.filter((entry) => entry.available && typeof entry.z === "number");
  const validSpeciesCount = validEntries.length;
  const coverage = validSpeciesCount / CORE_BAIT_SPECIES_IDS.length;

  if (validSpeciesCount < minValidSpeciesCount) {
    return { available: false, validSpeciesCount, coverage, coreBaitZ: null, coreBaitBreadthPositive: null, coreBaitBreadthStrong: null };
  }

  const zs = validEntries.map((entry) => entry.z);
  return {
    available: true,
    validSpeciesCount,
    coverage,
    coreBaitZ: median(zs),
    coreBaitBreadthPositive: zs.filter((z) => z >= 0.5).length,
    coreBaitBreadthStrong: zs.filter((z) => z >= 1.5).length
  };
}

// ---------------------------------------------------------------------------
// Yokohama West aggregation
//
// Frozen deterministic consensus rule, given the contributing facility z values:
//   fewer than 2 values                    -> "insufficient"
//   all values >= +0.5                     -> "positive-consensus"
//   all values <= -0.5                     -> "negative-consensus"
//   all values strictly between -0.5/+0.5  -> "neutral-consensus"
//   otherwise                              -> "mixed"
// +0.5 belongs to positive, not neutral; -0.5 belongs to negative, not neutral (see the
// exact-boundary tests). dispersion = max(z) - min(z) across contributing facilities,
// and facilityValues exposes every facility's raw value (contributing or missing), so a
// single-facility spike among otherwise-quiet facilities stays visible as high
// dispersion + "mixed" even though the median (westZ) itself suppresses the spike.
// ---------------------------------------------------------------------------

export function aggregateWestFacilityValues(facilityValues, config = {}) {
  const minContributingFacilities = config.minContributingFacilities ?? DEFAULT_WEST_MIN_CONTRIBUTING_FACILITIES;
  const contributing = facilityValues.filter((entry) => typeof entry.z === "number");
  const contributingFacilities = contributing.map((entry) => entry.facilityId);
  const missingFacilities = facilityValues.filter((entry) => typeof entry.z !== "number").map((entry) => entry.facilityId);

  if (contributing.length < minContributingFacilities) {
    return { available: false, contributingFacilities, missingFacilities, westZ: null, dispersion: null, consensus: "insufficient", facilityValues };
  }

  const zs = contributing.map((entry) => entry.z);
  const westZ = median(zs);
  const dispersion = Math.max(...zs) - Math.min(...zs);
  const buckets = zs.map(bucketOfZ);
  const consensus = buckets.every((bucket) => bucket === "positive")
    ? "positive-consensus"
    : buckets.every((bucket) => bucket === "negative")
      ? "negative-consensus"
      : buckets.every((bucket) => bucket === "neutral")
        ? "neutral-consensus"
        : "mixed";

  return { available: true, contributingFacilities, missingFacilities, westZ, dispersion, consensus, facilityValues };
}

function bucketOfZ(z) {
  if (z >= 0.5) return "positive";
  if (z <= -0.5) return "negative";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function computeFacilityDaySignal(sourceRows, { facilityId, targetDate, knowledgeAt, config = {} } = {}) {
  requireNonEmptyString(facilityId, "facilityId");
  requireIsoDate(targetDate, "targetDate");
  requireCanonicalUtcIso(knowledgeAt, "knowledgeAt");

  const normalized = sourceRows.map(normalizeSignalSourceRow);
  const asOfRows = selectAsOfRows(normalized, knowledgeAt);
  const facilityRows = asOfRows.filter((row) => row.facilityId === facilityId);

  const validXBySpeciesDate = buildValidXBySpeciesDate(facilityRows);
  const { baselineStart, baselineEnd } = computeBaselineWindow(targetDate, config);

  const species = {};
  for (const speciesId of ALL_SPECIES_IN_SIGNAL_ORDER) {
    const baselineXs = collectBaselineXs(validXBySpeciesDate, speciesId, baselineStart, baselineEnd);
    const currentRow = findLatestRow(facilityRows, (row) => row.speciesId === speciesId && row.observationDate === targetDate);
    const currentValid = currentRow !== null && isValidIntensityRow(currentRow);
    const currentX = currentValid ? logOnePlus(catchRate100(currentRow.catchCount, currentRow.visitorCount)) : null;
    const anomaly = computeRobustAnomaly({ targetDate, currentValid, currentX, baselineXs }, config);

    species[speciesId] = {
      speciesId,
      presenceState: currentRow ? currentRow.presenceState : "unknown",
      intensity: {
        valid: currentValid,
        catchCount: currentRow ? currentRow.catchCount : null,
        visitorCount: currentRow ? currentRow.visitorCount : null,
        catchRate100: currentValid ? catchRate100(currentRow.catchCount, currentRow.visitorCount) : null,
        x: currentX
      },
      anomaly
    };
  }

  const coreBaitAnomalies = CORE_BAIT_SPECIES_IDS.map((speciesId) => ({
    speciesId,
    available: species[speciesId].anomaly.available,
    z: species[speciesId].anomaly.z
  }));
  const coreBait = computeCoreBaitSignal(coreBaitAnomalies, config);

  const referenceVisitorCounts = collectReferenceVisitorCounts(facilityRows, baselineStart, baselineEnd);
  const currentReportRow = findLatestRow(facilityRows, (row) => row.observationDate === targetDate);
  const detectionConfidence = computeDetectionConfidence({
    currentVisitorCount: currentReportRow ? currentReportRow.visitorCount : null,
    referenceVisitorCounts
  }, config);

  return {
    schemaVersion: FIXED_NODE_SIGNAL_SCHEMA_VERSION,
    algorithmVersion: FIXED_NODE_SIGNAL_ALGORITHM_VERSION,
    facilityId,
    targetDate,
    knowledgeAt,
    species,
    coreBait,
    detectionConfidence
  };
}

export function computeWestSignal(sourceRows, { targetDate, knowledgeAt, config = {} } = {}) {
  const facilities = {};
  for (const facilityId of WEST_FACILITY_IDS) {
    facilities[facilityId] = computeFacilityDaySignal(sourceRows, { facilityId, targetDate, knowledgeAt, config });
  }

  const seabassFacilityValues = WEST_FACILITY_IDS.map((facilityId) => ({
    facilityId,
    z: facilities[facilityId].species[TARGET_SPECIES_ID].anomaly.available ? facilities[facilityId].species[TARGET_SPECIES_ID].anomaly.z : null
  }));
  const coreBaitFacilityValues = WEST_FACILITY_IDS.map((facilityId) => ({
    facilityId,
    z: facilities[facilityId].coreBait.available ? facilities[facilityId].coreBait.coreBaitZ : null
  }));

  return {
    schemaVersion: FIXED_NODE_SIGNAL_SCHEMA_VERSION,
    algorithmVersion: FIXED_NODE_SIGNAL_ALGORITHM_VERSION,
    targetDate,
    knowledgeAt,
    facilities,
    westSeabassZ: aggregateWestFacilityValues(seabassFacilityValues, config),
    westCoreBaitZ: aggregateWestFacilityValues(coreBaitFacilityValues, config)
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildValidXBySpeciesDate(rows) {
  const bySpecies = new Map();
  for (const row of rows) {
    if (!isValidIntensityRow(row)) continue;
    if (!bySpecies.has(row.speciesId)) bySpecies.set(row.speciesId, new Map());
    bySpecies.get(row.speciesId).set(row.observationDate, logOnePlus(catchRate100(row.catchCount, row.visitorCount)));
  }
  return bySpecies;
}

function collectBaselineXs(validXBySpeciesDate, speciesId, baselineStart, baselineEnd) {
  const byDate = validXBySpeciesDate.get(speciesId);
  if (!byDate) return [];
  const xs = [];
  for (const [date, x] of byDate) {
    if (date >= baselineStart && date <= baselineEnd) xs.push(x);
  }
  return xs;
}

function collectReferenceVisitorCounts(rows, baselineStart, baselineEnd) {
  const visitorCountByDate = new Map();
  for (const row of rows) {
    if (row.observationDate < baselineStart || row.observationDate > baselineEnd) continue;
    if (row.visitorCount === null || row.visitorCount <= 0) continue;
    if (!visitorCountByDate.has(row.observationDate)) visitorCountByDate.set(row.observationDate, row.visitorCount);
  }
  return [...visitorCountByDate.values()];
}

/**
 * Rows are already as-of resolved (one revision per identityKey), so at most one row
 * should match a given (speciesId, observationDate) predicate. The sort is a
 * deterministic fallback for the rare case of two distinct identityKeys reporting the
 * same facility/date (e.g. an out-of-band correction posted as a new source record).
 */
function findLatestRow(rows, predicate) {
  const matches = rows.filter(predicate);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return [...matches].sort((left, right) => (
    right.collectedAt.localeCompare(left.collectedAt) || right.versionKey.localeCompare(left.versionKey)
  ))[0];
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new FixedNodeSignalError("invalid_input", `${label} must be a non-empty string.`);
  return value;
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) throw new FixedNodeSignalError("invalid_input", `${label} must be an ISO date (YYYY-MM-DD).`);
  return value;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO.test(value)) throw new FixedNodeSignalError("invalid_input", `${label} must be canonical UTC ISO datetime.`);
  return value;
}
