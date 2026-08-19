#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIXED_NODE_DISTRIBUTION_PROFILE_SCHEMA_VERSION = "wanoku-fixed-node-distribution-profile.v1";

// This profiler is Fixed-Node Distribution Profile v1: deterministic, descriptive statistics only.
// It does NOT choose or freeze anomaly thresholds and does NOT implement Fixed-Node Signal v1.

export const REQUIRED_SPECIES_IDS = Object.freeze([
  "japanese-seabass", "sardine", "sappa", "konoshiro", "aji", "saba", "bora", "haze"
]);
export const CORE_BAIT_SPECIES_IDS = Object.freeze(["sardine", "sappa", "konoshiro", "aji"]);
export const CONTEXT_SPECIES_IDS = Object.freeze(["saba", "bora", "haze"]);
export const TARGET_SPECIES_ID = "japanese-seabass";

export const DEFAULT_EXPECTED_JOINED_ROW_COUNT = 8240;
export const DEFAULT_EXPECTED_REPORT_COUNT = 1030;
export const DEFAULT_BASELINE_FROM_OFFSET_DAYS = 56; // t-56
export const DEFAULT_BASELINE_TO_OFFSET_DAYS = 8; // t-8 (most recent 7 days, t-7..t, are excluded)
export const DEFAULT_MIN_BASELINE_N = 21;

const DATABASE_NAME = "wanoku-intel-db";
const WRANGLER_CONFIG_PATH = "workers/wanoku-intel-worker/wrangler.toml";
const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TRANSIENT_ERROR_MARKERS = ["7403", "10000"];
const MAX_RETRIES_ON_TRANSIENT_ERROR = 1;

const execFileAsync = promisify(execFile);

// The exact read-only SELECT used to capture the profiling input snapshot. Deterministic ordering
// matches: facility_id, observation_date, species_id, collected_at, report_id.
export const FIXED_NODE_PROFILE_SELECT_SQL = `SELECT
  r.report_id AS report_id,
  r.identity_key AS identity_key,
  r.facility_id AS facility_id,
  r.observation_date AS observation_date,
  r.collected_at AS collected_at,
  r.visitor_count AS visitor_count,
  r.operating_status AS operating_status,
  r.report_completeness AS report_completeness,
  s.species_id AS species_id,
  s.catch_count AS catch_count,
  s.presence_state AS presence_state,
  s.completeness AS completeness,
  s.alias_coverage AS alias_coverage
FROM fixed_node_daily_reports r
JOIN fixed_node_species_observations s ON s.report_id = r.report_id
ORDER BY r.facility_id, r.observation_date, s.species_id, r.collected_at, r.report_id;`;

export class FixedNodeDistributionProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FixedNodeDistributionProfileError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Deterministic statistics primitives
// ---------------------------------------------------------------------------

/**
 * Deterministic quantile using linear interpolation between closest ranks
 * (the "R-7" definition, also used by Excel PERCENTILE.INC and numpy's default).
 *
 * For a value array sorted ascending of length n and probability p in [0, 1]:
 *   index = p * (n - 1)
 *   lower = floor(index), upper = ceil(index)
 *   value = sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
 *
 * Returns null for an empty array.
 */
export function quantile(sortedAscendingValues, p) {
  const n = sortedAscendingValues.length;
  if (n === 0) return null;
  if (typeof p !== "number" || p < 0 || p > 1) {
    throw new FixedNodeDistributionProfileError("invalid_quantile_probability", "p must be in [0, 1].");
  }
  if (n === 1) return sortedAscendingValues[0];
  const index = p * (n - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedAscendingValues[lower];
  const fraction = index - lower;
  return sortedAscendingValues[lower] + (sortedAscendingValues[upper] - sortedAscendingValues[lower]) * fraction;
}

export function median(values) {
  if (values.length === 0) return null;
  return quantile([...values].sort(numericAscending), 0.5);
}

/** Median absolute deviation: median(|x_i - median(x)|). */
export function medianAbsoluteDeviation(values) {
  if (values.length === 0) return null;
  const med = median(values);
  const deviations = values.map((value) => Math.abs(value - med));
  return median(deviations);
}

export function catchRate100(catchCount, visitorCount) {
  return (catchCount / visitorCount) * 100;
}

export function logOnePlus(catchRate100Value) {
  return Math.log1p(catchRate100Value);
}

function numericAscending(left, right) {
  return left - right;
}

function summarizeDistribution(values, probLabels) {
  const sorted = [...values].sort(numericAscending);
  const summary = { n: sorted.length, min: sorted.length > 0 ? sorted[0] : null };
  for (const [label, p] of probLabels) summary[label] = quantile(sorted, p);
  summary.max = sorted.length > 0 ? sorted.at(-1) : null;
  return summary;
}

const CATCH_RATE_QUANTILES = [["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9], ["p95", 0.95]];
const VISITOR_QUANTILES = [["p10", 0.1], ["p25", 0.25], ["p33", 1 / 3], ["median", 0.5], ["p67", 2 / 3], ["p75", 0.75], ["p90", 0.9]];
const BASELINE_N_QUANTILES = [["p10", 0.1], ["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9]];
const MAD_QUANTILES = [["p25", 0.25], ["p50", 0.5], ["p75", 0.75], ["p90", 0.9]];
const LOW_NONZERO_MAD_QUANTILES = [["p05", 0.05], ["p10", 0.1], ["p25", 0.25]];

// ---------------------------------------------------------------------------
// Source row normalization
// ---------------------------------------------------------------------------

export function normalizeSourceRow(raw) {
  return Object.freeze({
    reportId: requireNonEmptyString(raw.report_id, "report_id"),
    identityKey: requireNonEmptyString(raw.identity_key, "identity_key"),
    facilityId: requireNonEmptyString(raw.facility_id, "facility_id"),
    observationDate: requireIsoDate(raw.observation_date, "observation_date"),
    collectedAt: requireNonEmptyString(raw.collected_at, "collected_at"),
    visitorCount: nullableInteger(raw.visitor_count, "visitor_count"),
    operatingStatus: requireNonEmptyString(raw.operating_status, "operating_status"),
    reportCompleteness: requireNonEmptyString(raw.report_completeness, "report_completeness"),
    speciesId: requireNonEmptyString(raw.species_id, "species_id"),
    catchCount: nullableInteger(raw.catch_count, "catch_count"),
    presenceState: requireNonEmptyString(raw.presence_state, "presence_state"),
    speciesCompleteness: requireNonEmptyString(raw.completeness, "completeness"),
    aliasCoverage: requireNonEmptyString(raw.alias_coverage, "alias_coverage")
  });
}

/**
 * A species/day is valid for normalized catch intensity only when ALL are true:
 *   report.operating_status = 'operating'
 *   report.report_completeness = 'complete'
 *   species.completeness = 'complete'
 *   species.alias_coverage = 'sufficient'
 *   species.catch_count IS NOT NULL
 *   report.visitor_count IS NOT NULL
 *   report.visitor_count > 0
 * Invalid/unknown rows are never converted to a zero intensity observation.
 */
export function isValidIntensityRow(row) {
  return row.operatingStatus === "operating"
    && row.reportCompleteness === "complete"
    && row.speciesCompleteness === "complete"
    && row.aliasCoverage === "sufficient"
    && row.catchCount !== null
    && row.visitorCount !== null
    && row.visitorCount > 0;
}

// ---------------------------------------------------------------------------
// Profile 1 — facility x species
// ---------------------------------------------------------------------------

export function buildFacilitySpeciesProfile(rows) {
  const groups = groupBy(rows, (row) => `${row.facilityId}|${row.speciesId}`);
  return sortByFacilityThenSpecies([...groups.values()].map((groupRows) => {
    const { facilityId, speciesId } = groupRows[0];
    const validRows = groupRows.filter(isValidIntensityRow);
    const rates = validRows.map((row) => catchRate100(row.catchCount, row.visitorCount));
    const xs = rates.map(logOnePlus);
    const positiveDays = validRows.filter((row) => row.catchCount > 0).length;
    const zeroDays = validRows.filter((row) => row.catchCount === 0).length;
    const reportDays = groupRows.length;
    const validIntensityDays = validRows.length;
    return {
      facilityId,
      speciesId,
      coverage: {
        reportDays,
        validIntensityDays,
        invalidIntensityDays: reportDays - validIntensityDays,
        positiveDays,
        zeroDays,
        unknownPresenceDays: groupRows.filter((row) => row.presenceState === "unknown").length,
        validIntensityRate: rate(validIntensityDays, reportDays),
        zeroRateAmongValid: rate(zeroDays, validIntensityDays),
        positiveRateAmongValid: rate(positiveDays, validIntensityDays)
      },
      catchRate100: summarizeDistribution(rates, CATCH_RATE_QUANTILES),
      x: { ...summarizeDistribution(xs, CATCH_RATE_QUANTILES), mad: medianAbsoluteDeviation(xs) }
    };
  }));
}

// ---------------------------------------------------------------------------
// Profile 2 — visitor distribution
// ---------------------------------------------------------------------------

export function buildVisitorProfile(rows) {
  const reportsByFacility = groupBy(uniqueReports(rows), (report) => report.facilityId);
  return [...reportsByFacility.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([facilityId, reports]) => {
    const validPositive = reports.filter((report) => report.visitorCount !== null && report.visitorCount > 0);
    return {
      facilityId,
      visitorCount: summarizeDistribution(validPositive.map((report) => report.visitorCount), VISITOR_QUANTILES),
      visitorCountNullDays: reports.filter((report) => report.visitorCount === null).length,
      visitorCountZeroDays: reports.filter((report) => report.visitorCount === 0).length
    };
  });
}

function uniqueReports(rows) {
  const byReportId = new Map();
  for (const row of rows) {
    if (!byReportId.has(row.reportId)) {
      byReportId.set(row.reportId, {
        reportId: row.reportId,
        facilityId: row.facilityId,
        observationDate: row.observationDate,
        visitorCount: row.visitorCount
      });
    }
  }
  return [...byReportId.values()];
}

// ---------------------------------------------------------------------------
// Profile 3 — rolling baseline feasibility (t-56 .. t-8, excluding t-7..t)
// ---------------------------------------------------------------------------

export function buildRollingBaselineProfile(rows, config = {}) {
  const baselineFromOffsetDays = config.baselineFromOffsetDays ?? DEFAULT_BASELINE_FROM_OFFSET_DAYS;
  const baselineToOffsetDays = config.baselineToOffsetDays ?? DEFAULT_BASELINE_TO_OFFSET_DAYS;
  const minBaselineN = config.minBaselineN ?? DEFAULT_MIN_BASELINE_N;
  if (!Number.isInteger(baselineFromOffsetDays) || baselineFromOffsetDays <= baselineToOffsetDays) {
    throw new FixedNodeDistributionProfileError("invalid_baseline_config", "baselineFromOffsetDays must exceed baselineToOffsetDays.");
  }
  if (!Number.isInteger(baselineToOffsetDays) || baselineToOffsetDays < 0) {
    throw new FixedNodeDistributionProfileError("invalid_baseline_config", "baselineToOffsetDays must be a non-negative integer.");
  }
  if (!Number.isInteger(minBaselineN) || minBaselineN < 1) {
    throw new FixedNodeDistributionProfileError("invalid_baseline_config", "minBaselineN must be a positive integer.");
  }

  const targetDatesByFacility = buildTargetDatesByFacility(rows);
  const groups = groupBy(rows, (row) => `${row.facilityId}|${row.speciesId}`);
  return sortByFacilityThenSpecies([...groups.values()].map((groupRows) => {
    const { facilityId, speciesId } = groupRows[0];
    const targetDates = targetDatesByFacility.get(facilityId) ?? [];
    const validXByDate = new Map();
    for (const row of groupRows) {
      if (isValidIntensityRow(row)) validXByDate.set(row.observationDate, logOnePlus(catchRate100(row.catchCount, row.visitorCount)));
    }
    const validDatesSorted = [...validXByDate.keys()].sort();

    const baselineNs = [];
    const eligibleMedians = [];
    const eligibleMads = [];
    for (const targetDate of targetDates) {
      const lowDate = addDaysIso(targetDate, -baselineFromOffsetDays);
      const highDate = addDaysIso(targetDate, -baselineToOffsetDays);
      const windowXs = validDatesSorted
        .filter((date) => date >= lowDate && date <= highDate)
        .map((date) => validXByDate.get(date));
      baselineNs.push(windowXs.length);
      if (windowXs.length >= minBaselineN) {
        eligibleMedians.push(median(windowXs));
        eligibleMads.push(medianAbsoluteDeviation(windowXs));
      }
    }
    const nonZeroMads = eligibleMads.filter((value) => value > 0);
    const zeroMadWindowCount = eligibleMads.length - nonZeroMads.length;

    return {
      facilityId,
      speciesId,
      candidateTargetDates: targetDates.length,
      baselineWindowsWithNAtLeast21: eligibleMads.length,
      baselineEligibilityRate: rate(eligibleMads.length, targetDates.length),
      baselineN: summarizeDistribution(baselineNs, BASELINE_N_QUANTILES),
      eligible: {
        medianOfBaselineMedians: median(eligibleMedians),
        medianOfBaselineMad: median(eligibleMads),
        baselineMadQuantiles: quantilesOnly(eligibleMads, MAD_QUANTILES),
        zeroMadWindowCount,
        zeroMadWindowRate: rate(zeroMadWindowCount, eligibleMads.length),
        nonZeroMadCount: nonZeroMads.length,
        lowNonZeroMadQuantiles: quantilesOnly(nonZeroMads, LOW_NONZERO_MAD_QUANTILES)
      }
    };
  }));
}

function buildTargetDatesByFacility(rows) {
  const byFacility = new Map();
  for (const row of rows) {
    if (!byFacility.has(row.facilityId)) byFacility.set(row.facilityId, new Set());
    byFacility.get(row.facilityId).add(row.observationDate);
  }
  const result = new Map();
  for (const [facilityId, dateSet] of byFacility) result.set(facilityId, [...dateSet].sort());
  return result;
}

function quantilesOnly(values, probLabels) {
  const sorted = [...values].sort(numericAscending);
  const summary = { n: sorted.length };
  for (const [label, p] of probLabels) summary[label] = quantile(sorted, p);
  return summary;
}

export function addDaysIso(dateStr, deltaDays) {
  if (!ISO_DATE.test(dateStr)) throw new FixedNodeDistributionProfileError("invalid_date", `Invalid ISO date: ${dateStr}`);
  const [year, month, day] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + deltaDays * 86_400_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Profile 4 — data quality / sanity
// ---------------------------------------------------------------------------

export function buildDataQualityProfile(rows, expected = {}) {
  const expectedJoinedRowCount = expected.expectedJoinedRowCount ?? null;
  const expectedReportCount = expected.expectedReportCount ?? null;

  const joinedRowCount = rows.length;
  const reports = uniqueReports(rows);
  const reportCount = reports.length;

  const facilityCounts = countBy(reports, (report) => report.facilityId);
  const speciesCounts = countBy(rows, (row) => row.speciesId);

  const dedupeKeyCounts = countBy(rows, (row) => `${row.facilityId}|${row.observationDate}|${row.speciesId}`);
  const duplicateFacilityDateSpeciesRows = Object.values(dedupeKeyCounts).reduce((total, count) => total + Math.max(0, count - 1), 0);

  const negativeCatchCountRows = rows.filter((row) => row.catchCount !== null && row.catchCount < 0).length;
  const negativeVisitorCountRows = rows.filter((row) => row.visitorCount !== null && row.visitorCount < 0).length;
  const absentRowsWithNonzeroCatch = rows.filter((row) => row.presenceState === "absent" && row.catchCount !== 0).length;
  const presentRowsWithZeroCatch = rows.filter((row) => row.presenceState === "present" && row.catchCount === 0).length;
  const almostValidIntensityRowsWithNonpositiveVisitor = rows.filter((row) => (
    row.operatingStatus === "operating"
    && row.reportCompleteness === "complete"
    && row.speciesCompleteness === "complete"
    && row.aliasCoverage === "sufficient"
    && row.catchCount !== null
    && row.visitorCount !== null
    && row.visitorCount <= 0
  )).length;

  const speciesCountByReportDay = countBy(rows, (row) => `${row.facilityId}|${row.observationDate}`);
  const reportDaysWithSpeciesCountNot8 = Object.values(speciesCountByReportDay).filter((count) => count !== REQUIRED_SPECIES_IDS.length).length;

  const errors = [];
  if (expectedJoinedRowCount !== null && joinedRowCount !== expectedJoinedRowCount) {
    errors.push(`Expected ${expectedJoinedRowCount} joined rows, found ${joinedRowCount}.`);
  }
  if (expectedReportCount !== null && reportCount !== expectedReportCount) {
    errors.push(`Expected ${expectedReportCount} reports, found ${reportCount}.`);
  }
  if (duplicateFacilityDateSpeciesRows !== 0) errors.push(`Found ${duplicateFacilityDateSpeciesRows} duplicate facility/date/species rows.`);
  if (negativeCatchCountRows !== 0) errors.push(`Found ${negativeCatchCountRows} rows with negative catch_count.`);
  if (negativeVisitorCountRows !== 0) errors.push(`Found ${negativeVisitorCountRows} rows with negative visitor_count.`);
  if (absentRowsWithNonzeroCatch !== 0) errors.push(`Found ${absentRowsWithNonzeroCatch} absent rows with catch_count != 0.`);
  if (presentRowsWithZeroCatch !== 0) errors.push(`Found ${presentRowsWithZeroCatch} present rows with catch_count = 0.`);
  if (reportDaysWithSpeciesCountNot8 !== 0) errors.push(`Found ${reportDaysWithSpeciesCountNot8} report-days without exactly ${REQUIRED_SPECIES_IDS.length} species rows.`);

  return {
    joinedRowCount,
    reportCount,
    facilityCounts,
    speciesCounts,
    duplicateFacilityDateSpeciesRows,
    negativeCatchCountRows,
    negativeVisitorCountRows,
    absentRowsWithNonzeroCatch,
    presentRowsWithZeroCatch,
    almostValidIntensityRowsWithNonpositiveVisitor,
    reportDaysWithSpeciesCountNot8,
    expected: { expectedJoinedRowCount, expectedReportCount },
    ok: errors.length === 0,
    errors
  };
}

// ---------------------------------------------------------------------------
// Profile 5 — seabass / core bait summary
// ---------------------------------------------------------------------------

export function buildSeabassCoreBaitSummary(facilitySpeciesProfile, visitorProfile, rollingBaselineProfile) {
  const facilityIds = [...new Set(facilitySpeciesProfile.map((entry) => entry.facilityId))].sort();
  return facilityIds.map((facilityId) => {
    const bySpecies = new Map(facilitySpeciesProfile.filter((entry) => entry.facilityId === facilityId).map((entry) => [entry.speciesId, entry]));
    const rollingBySpecies = new Map(rollingBaselineProfile.filter((entry) => entry.facilityId === facilityId).map((entry) => [entry.speciesId, entry]));
    const seabass = bySpecies.get(TARGET_SPECIES_ID);
    const seabassRolling = rollingBySpecies.get(TARGET_SPECIES_ID);
    const visitor = visitorProfile.find((entry) => entry.facilityId === facilityId);
    const visitorSpreadRatio = visitor?.visitorCount?.p90 && visitor?.visitorCount?.p10
      ? round(visitor.visitorCount.p90 / visitor.visitorCount.p10, 3)
      : null;

    const coreBait = CORE_BAIT_SPECIES_IDS.map((speciesId) => summarizeBaitSpecies(speciesId, bySpecies.get(speciesId)));
    const context = CONTEXT_SPECIES_IDS.map((speciesId) => summarizeBaitSpecies(speciesId, bySpecies.get(speciesId)));

    return {
      facilityId,
      seabass: {
        zeroRateAmongValid: seabass?.coverage?.zeroRateAmongValid ?? null,
        medianCatchRate100: seabass?.catchRate100?.median ?? null,
        p90CatchRate100: seabass?.catchRate100?.p90 ?? null,
        validIntensityDays: seabass?.coverage?.validIntensityDays ?? null,
        rollingMedianOfBaselineMad: seabassRolling?.eligible?.medianOfBaselineMad ?? null,
        rollingZeroMadWindowRate: seabassRolling?.eligible?.zeroMadWindowRate ?? null,
        rollingBaselineEligibilityRate: seabassRolling?.baselineEligibilityRate ?? null
      },
      coreBait,
      context,
      visitorCountVariability: {
        n: visitor?.visitorCount?.n ?? null,
        p10: visitor?.visitorCount?.p10 ?? null,
        median: visitor?.visitorCount?.median ?? null,
        p90: visitor?.visitorCount?.p90 ?? null,
        p90OverP10: visitorSpreadRatio
      },
      narrative: buildFacilityNarrative(facilityId, seabass, coreBait, visitor, visitorSpreadRatio)
    };
  });
}

function summarizeBaitSpecies(speciesId, entry) {
  return {
    speciesId,
    validIntensityDays: entry?.coverage?.validIntensityDays ?? null,
    zeroRateAmongValid: entry?.coverage?.zeroRateAmongValid ?? null,
    positiveRateAmongValid: entry?.coverage?.positiveRateAmongValid ?? null,
    medianCatchRate100: entry?.catchRate100?.median ?? null
  };
}

function buildFacilityNarrative(facilityId, seabass, coreBait, visitor, visitorSpreadRatio) {
  const seabassZeroPct = formatPercent(seabass?.coverage?.zeroRateAmongValid);
  const baitZeroSummary = coreBait
    .map((entry) => `${entry.speciesId}=${formatPercent(entry.zeroRateAmongValid)}`)
    .join(", ");
  return `${facilityId}: seabass zero rate ${seabassZeroPct} among valid intensity days (median catchRate100 `
    + `${formatNumber(seabass?.catchRate100?.median)}, p90 ${formatNumber(seabass?.catchRate100?.p90)}). `
    + `Core bait zero rates: ${baitZeroSummary}. `
    + `Visitor count p10/median/p90 = ${formatNumber(visitor?.visitorCount?.p10)}/${formatNumber(visitor?.visitorCount?.median)}/`
    + `${formatNumber(visitor?.visitorCount?.p90)} (p90/p10 = ${formatNumber(visitorSpreadRatio)}).`;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${round(value * 100, 1)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "n/a" : String(round(value, 3));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export function buildFixedNodeDistributionProfile(sourceRows, options = {}) {
  const rows = sourceRows.map(normalizeSourceRow);
  const baselineConfig = {
    baselineFromOffsetDays: options.baselineFromOffsetDays ?? DEFAULT_BASELINE_FROM_OFFSET_DAYS,
    baselineToOffsetDays: options.baselineToOffsetDays ?? DEFAULT_BASELINE_TO_OFFSET_DAYS,
    minBaselineN: options.minBaselineN ?? DEFAULT_MIN_BASELINE_N
  };
  const dataQuality = buildDataQualityProfile(rows, {
    expectedJoinedRowCount: options.expectedJoinedRowCount ?? null,
    expectedReportCount: options.expectedReportCount ?? null
  });

  const result = {
    schemaVersion: FIXED_NODE_DISTRIBUTION_PROFILE_SCHEMA_VERSION,
    config: {
      requiredSpeciesIds: REQUIRED_SPECIES_IDS,
      targetSpeciesId: TARGET_SPECIES_ID,
      coreBaitSpeciesIds: CORE_BAIT_SPECIES_IDS,
      contextSpeciesIds: CONTEXT_SPECIES_IDS,
      candidateBaseline: baselineConfig,
      quantileDefinition: "linear interpolation between closest ranks (R-7 / Excel PERCENTILE.INC / numpy default)"
    },
    dataQuality
  };

  if (!dataQuality.ok) {
    return { ...result, validated: false, stoppedBeforeStatisticalProfiling: true };
  }

  const facilitySpecies = buildFacilitySpeciesProfile(rows);
  const visitor = buildVisitorProfile(rows);
  const rollingBaseline = buildRollingBaselineProfile(rows, baselineConfig);
  const seabassCoreBaitSummary = buildSeabassCoreBaitSummary(facilitySpecies, visitor, rollingBaseline);

  return {
    ...result,
    validated: true,
    stoppedBeforeStatisticalProfiling: false,
    facilitySpecies,
    visitor,
    rollingBaseline,
    seabassCoreBaitSummary
  };
}

export function renderProfileMarkdown(profile) {
  const lines = [];
  lines.push("# Wanoku Fixed-Node Distribution Profile v1", "");
  lines.push(`Schema version: \`${profile.schemaVersion}\``, "");
  lines.push(`Validation: **${profile.validated ? "PASSED" : "FAILED"}**`, "");
  if (!profile.validated) {
    lines.push("Statistical profiling was stopped because a Profile 4 (data quality) invariant failed:", "");
    for (const error of profile.dataQuality.errors) lines.push(`- ${error}`);
    return lines.join("\n");
  }

  lines.push("## Profile 4 — Data quality / sanity", "");
  lines.push(`- joined rows: ${profile.dataQuality.joinedRowCount}`);
  lines.push(`- reports: ${profile.dataQuality.reportCount}`);
  lines.push(`- duplicate facility/date/species rows: ${profile.dataQuality.duplicateFacilityDateSpeciesRows}`);
  lines.push(`- report-days without exactly 8 species rows: ${profile.dataQuality.reportDaysWithSpeciesCountNot8}`);
  lines.push("");

  lines.push("## Profile 1 — Facility x species (valid intensity days)", "");
  for (const entry of profile.facilitySpecies) {
    lines.push(`### ${entry.facilityId} / ${entry.speciesId}`);
    lines.push(`- validIntensityDays=${entry.coverage.validIntensityDays} of ${entry.coverage.reportDays} (rate=${entry.coverage.validIntensityRate})`);
    lines.push(`- zeroRateAmongValid=${entry.coverage.zeroRateAmongValid}, positiveRateAmongValid=${entry.coverage.positiveRateAmongValid}`);
    lines.push(`- catchRate100 median=${entry.catchRate100.median}, p90=${entry.catchRate100.p90}, max=${entry.catchRate100.max}`);
    lines.push(`- x=log1p(catchRate100) median=${entry.x.median}, MAD=${entry.x.mad}`);
    lines.push("");
  }

  lines.push("## Profile 2 — Visitor distribution", "");
  for (const entry of profile.visitor) {
    lines.push(`### ${entry.facilityId}`);
    lines.push(`- n=${entry.visitorCount.n}, p10=${entry.visitorCount.p10}, p33=${entry.visitorCount.p33}, median=${entry.visitorCount.median}, p67=${entry.visitorCount.p67}, p90=${entry.visitorCount.p90}`);
    lines.push(`- visitorCountNullDays=${entry.visitorCountNullDays}, visitorCountZeroDays=${entry.visitorCountZeroDays}`);
    lines.push("");
  }

  lines.push("## Profile 3 — Rolling baseline feasibility (candidate t-56..t-8, n>=21)", "");
  for (const entry of profile.rollingBaseline) {
    lines.push(`### ${entry.facilityId} / ${entry.speciesId}`);
    lines.push(`- candidateTargetDates=${entry.candidateTargetDates}, eligibleWindows=${entry.baselineWindowsWithNAtLeast21}, eligibilityRate=${entry.baselineEligibilityRate}`);
    lines.push(`- baselineN median=${entry.baselineN.median}, p10=${entry.baselineN.p10}, p90=${entry.baselineN.p90}`);
    lines.push(`- medianOfBaselineMad=${entry.eligible.medianOfBaselineMad}, zeroMadWindowRate=${entry.eligible.zeroMadWindowRate}`);
    lines.push("");
  }

  lines.push("## Profile 5 — Seabass / core bait summary", "");
  for (const entry of profile.seabassCoreBaitSummary) lines.push(`- ${entry.narrative}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Snapshot capture (the only part that touches remote D1; read-only SELECT only)
// ---------------------------------------------------------------------------

export function assertReadOnlySelect(sql) {
  const trimmed = sql.trim();
  if (!/^SELECT\b/iu.test(trimmed)) {
    throw new FixedNodeDistributionProfileError("unsafe_sql", "Only a SELECT statement may be used to capture the snapshot.");
  }
  if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|BEGIN|COMMIT|SAVEPOINT|ATTACH|DETACH)\b/iu.test(trimmed)) {
    throw new FixedNodeDistributionProfileError("unsafe_sql", "SQL must not contain a write or DDL statement.");
  }
  return trimmed;
}

/**
 * Parses the JSON envelope produced by `wrangler d1 execute --json`.
 * Wrangler 4.44.0 prints an array of query-result objects, one per statement,
 * each shaped like { results: [...], success: boolean, meta: {...} }.
 * This function verifies that shape explicitly rather than assuming it.
 */
export function parseWranglerD1JsonOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new FixedNodeDistributionProfileError("wrangler_json_parse_failed", "wrangler --json output was not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new FixedNodeDistributionProfileError("wrangler_json_shape_unexpected", "Expected a non-empty JSON array of statement results.");
  }
  const [statementResult] = parsed;
  if (!statementResult || typeof statementResult !== "object" || !Array.isArray(statementResult.results)) {
    throw new FixedNodeDistributionProfileError("wrangler_json_shape_unexpected", "Expected the first array element to have a results array.");
  }
  if (statementResult.success !== true) {
    throw new FixedNodeDistributionProfileError("wrangler_query_failed", "wrangler reported the query as unsuccessful.");
  }
  return statementResult.results;
}

function flattenSqlForShellArgument(sql) {
  // Windows spawns .cmd files (npx.cmd) via cmd.exe even without an explicit shell option, and cmd.exe
  // cannot pass an argument containing embedded newlines through correctly. SQL statement semantics are
  // whitespace-insensitive between tokens, so collapse to a single line before it becomes an argv element.
  return sql.replace(/\s+/gu, " ").trim();
}

async function runWranglerD1Query({ sql, database, configPath, execImpl }) {
  const safeSql = flattenSqlForShellArgument(assertReadOnlySelect(sql));
  const args = ["wrangler", "d1", "execute", database, "--remote", "--config", configPath, "--json", "--command", safeSql];
  let attempt = 0;
  for (;;) {
    try {
      return await execImpl(args);
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? "");
      const isTransient = TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
      if (isTransient && attempt < MAX_RETRIES_ON_TRANSIENT_ERROR) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

async function defaultWranglerExec(args) {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const { stdout } = await execFileAsync(npxCommand, args, { maxBuffer: 1024 * 1024 * 128 });
  return stdout;
}

export async function captureFixedNodeProfileSnapshot(options = {}) {
  const database = options.database ?? DATABASE_NAME;
  const configPath = options.configPath ?? WRANGLER_CONFIG_PATH;
  const sql = options.sql ?? FIXED_NODE_PROFILE_SELECT_SQL;
  const execImpl = options.execImpl ?? defaultWranglerExec;
  const capturedAt = requireCanonicalUtcIso(options.capturedAt ?? new Date().toISOString(), "capturedAt");

  const stdout = await runWranglerD1Query({ sql, database, configPath, execImpl });
  const rawRows = parseWranglerD1JsonOutput(stdout);
  const rowsJson = JSON.stringify(rawRows);
  const rowsSha256 = sha256Hex(rowsJson);

  return {
    schemaVersion: FIXED_NODE_DISTRIBUTION_PROFILE_SCHEMA_VERSION,
    capturedAt,
    database,
    configPath,
    sql,
    rowCount: rawRows.length,
    rowsSha256,
    rows: rawRows
  };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return Object.fromEntries(counts);
}

function sortByFacilityThenSpecies(entries) {
  return entries.sort((left, right) => left.facilityId.localeCompare(right.facilityId) || left.speciesId.localeCompare(right.speciesId));
}

function rate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 6) : null;
}

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value;
  return Number(value.toFixed(digits));
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new FixedNodeDistributionProfileError("invalid_source_row", `${label} must be a non-empty string.`);
  return value;
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) throw new FixedNodeDistributionProfileError("invalid_source_row", `${label} must be an ISO date (YYYY-MM-DD).`);
  return value;
}

function nullableInteger(value, label) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new FixedNodeDistributionProfileError("invalid_source_row", `${label} must be an integer or null.`);
  return number;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO.test(value)) throw new FixedNodeDistributionProfileError("invalid_timestamp", `${label} must be canonical UTC ISO datetime.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new FixedNodeDistributionProfileError("invalid_timestamp", `${label} is invalid.`);
  return value;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCliArgs(argv = process.argv.slice(2)) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "capture" && subcommand !== "profile") {
    throw new FixedNodeDistributionProfileError("invalid_cli", "First argument must be 'capture' or 'profile'.");
  }
  const options = { subcommand, outputDir: ".tmp/wanoku-fixed-node-profile" };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const readValue = () => {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new FixedNodeDistributionProfileError("invalid_cli", `Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--output-dir") options.outputDir = readValue();
    else if (arg === "--input") options.input = readValue();
    else if (arg === "--database") options.database = readValue();
    else if (arg === "--config") options.configPath = readValue();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new FixedNodeDistributionProfileError("invalid_cli", `Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-fixed-node-distribution-profile.mjs capture [--output-dir <dir>] [--database <name>] [--config <path>]
  node scripts/wanoku-fixed-node-distribution-profile.mjs profile [--input <source.json>] [--output-dir <dir>]

'capture' performs exactly one read-only SELECT against remote D1 (via wrangler) and writes source.json.
'profile' reads a previously captured source.json and writes profile.json and profile.md. No network access.`);
}

async function runCapture(options) {
  const outputDir = path.resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const snapshot = await captureFixedNodeProfileSnapshot({
    database: options.database,
    configPath: options.configPath
  });
  const sourcePath = path.join(outputDir, "source.json");
  writeFileSync(sourcePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, sourcePath, rowCount: snapshot.rowCount, rowsSha256: snapshot.rowsSha256 }, null, 2));
}

function runProfile(options) {
  const outputDir = path.resolve(options.outputDir);
  const inputPath = path.resolve(options.input ?? path.join(outputDir, "source.json"));
  mkdirSync(outputDir, { recursive: true });
  const source = JSON.parse(readFileSync(inputPath, "utf8"));
  const recomputedHash = sha256Hex(JSON.stringify(source.rows));
  if (source.rowsSha256 && recomputedHash !== source.rowsSha256) {
    throw new FixedNodeDistributionProfileError("snapshot_hash_mismatch", "source.json rows do not match their recorded rowsSha256.");
  }
  const profile = buildFixedNodeDistributionProfile(source.rows, {
    expectedJoinedRowCount: DEFAULT_EXPECTED_JOINED_ROW_COUNT,
    expectedReportCount: DEFAULT_EXPECTED_REPORT_COUNT
  });
  const withInput = {
    ...profile,
    input: { sourcePath: inputPath, rowCount: source.rows.length, rowsSha256: recomputedHash, capturedAt: source.capturedAt ?? null }
  };
  writeFileSync(path.join(outputDir, "profile.json"), `${JSON.stringify(withInput, null, 2)}\n`, "utf8");
  writeFileSync(path.join(outputDir, "profile.md"), `${renderProfileMarkdown(withInput)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, validated: profile.validated, outputDir }, null, 2));
}

async function main() {
  const options = parseCliArgs();
  if (options.help) return printHelp();
  if (options.subcommand === "capture") return runCapture(options);
  return runProfile(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.code ?? "fixed_node_distribution_profile_failed", message: error?.message ?? "Profiling failed." }));
    process.exitCode = 1;
  });
}
