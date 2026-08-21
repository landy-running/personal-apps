import { execFile } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAY_FIXED_NODE_INTERPRETATION_SCOPE,
  BAY_FIXED_NODE_STATE_ALGORITHM_VERSION,
  BAY_FIXED_NODE_STATE_SCHEMA_VERSION,
  EAST_FACILITY_ID,
  computeBayFixedNodeState
} from "./wanoku-bay-fixed-node-state.mjs";
import { WEST_FACILITY_IDS, addDaysIso, median, quantile } from "./wanoku-fixed-node-signal.mjs";
import { assertReadOnlySelect, parseWranglerD1JsonOutput } from "./wanoku-fixed-node-distribution-profile.mjs";

export const BAY_SANITY_SCHEMA_VERSION = "wanoku-bay-fixed-node-state-sanity.v1";
export const BAY_SANITY_ANALYSIS_MODE = "RETROSPECTIVE_POST_BACKFILL";
export const DEFAULT_ANALYSIS_START_DATE = "2025-09-01";
export const DEFAULT_ANALYSIS_END_DATE = "2026-08-16";
export const DEFAULT_SANITY_OUTPUT_DIR = ".tmp/wanoku-bay-fixed-node-state-sanity";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "wanoku-intel-db";
const CONFIG_PATH = "workers/wanoku-intel-worker/wrangler.toml";
const FACILITY_IDS = Object.freeze([...WEST_FACILITY_IDS, EAST_FACILITY_ID]);
const execFileAsync = promisify(execFile);

export async function runBayFixedNodeStateSanity(options = {}) {
  const startDate = options.startDate ?? DEFAULT_ANALYSIS_START_DATE;
  const endDate = options.endDate ?? DEFAULT_ANALYSIS_END_DATE;
  const outputDir = path.resolve(options.outputDir ?? path.join(REPO_ROOT, DEFAULT_SANITY_OUTPUT_DIR));
  const queryStartDate = addDaysIso(startDate, -56);
  const readFacility = options.readFacility ?? readProductionFacility;
  const rowsByFacility = {};
  let remoteReadAttempts = 0;

  for (const facilityId of FACILITY_IDS) {
    const result = await readFacility({ facilityId, queryStartDate, endDate, outputDir });
    rowsByFacility[facilityId] = result.rows;
    remoteReadAttempts += result.attempts ?? 1;
  }

  const rows = FACILITY_IDS.flatMap((facilityId) => rowsByFacility[facilityId]);
  const latestCollectedAt = rows.map((row) => row.collected_at).sort().at(-1);
  if (!latestCollectedAt) throw new Error("No fixed-node rows were returned for the sanity analysis.");
  const knowledgeAt = new Date(Date.parse(latestCollectedAt) + 1).toISOString();
  const summary = analyzeBayFixedNodeRows(rows, {
    startDate,
    endDate,
    queryStartDate,
    knowledgeAt,
    rowsReadPerFacility: Object.fromEntries(FACILITY_IDS.map((facilityId) => [facilityId, rowsByFacility[facilityId].length])),
    capturedAt: (options.clock ?? (() => new Date()))().toISOString(),
    remoteReadAttempts
  });

  mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "summary.json");
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, outputPath);
  return { summary, outputPath };
}

export function analyzeBayFixedNodeRows(rows, options) {
  const targetDates = dateRange(options.startDate, options.endDate);
  const states = targetDates.map((targetDate) => computeBayFixedNodeState(rows, {
    targetDate,
    knowledgeAt: options.knowledgeAt
  }));
  const channels = {
    seabass: summarizeChannel(states, "seabass"),
    coreBait: summarizeChannel(states, "coreBait")
  };
  const sanityFlags = [
    ...buildSanityFlags("seabass", channels.seabass, states),
    ...buildSanityFlags("coreBait", channels.coreBait, states)
  ];

  return {
    schemaVersion: BAY_SANITY_SCHEMA_VERSION,
    analysisMode: BAY_SANITY_ANALYSIS_MODE,
    stateSchemaVersion: BAY_FIXED_NODE_STATE_SCHEMA_VERSION,
    algorithmVersion: BAY_FIXED_NODE_STATE_ALGORITHM_VERSION,
    interpretationScope: BAY_FIXED_NODE_INTERPRETATION_SCOPE,
    capturedAt: options.capturedAt,
    targetDateRange: { startDate: options.startDate, endDate: options.endDate },
    sourceQueryDateRange: { startDate: options.queryStartDate, endDate: options.endDate },
    retrospectiveKnowledgeAt: options.knowledgeAt,
    knowledgeSemantics: "Retrospective reconstruction using rows acquired by retrospectiveKnowledgeAt.",
    database: DATABASE,
    configPath: CONFIG_PATH,
    rowsReadPerFacility: options.rowsReadPerFacility,
    remoteReadAttempts: options.remoteReadAttempts,
    remoteWrites: 0,
    channels,
    sanityFlags,
    limitations: [
      "States are retrospective coastal fixed-node sentinel comparisons against local baselines.",
      "Same-day correlation is descriptive and has no lagged component.",
      "Gradient summarizes spatial contrast between standardized anomalies."
    ]
  };
}

function summarizeChannel(states, channelId) {
  const entries = states.map((state) => ({ targetDate: state.targetDate, channel: state.channels[channelId] }));
  const eastAvailableDates = entries.filter((entry) => entry.channel.east.available).length;
  const westAvailableDates = entries.filter((entry) => entry.channel.west.available).length;
  const both = entries.filter((entry) => entry.channel.east.available && entry.channel.west.available);
  const gradients = entries.filter((entry) => entry.channel.gradient.available);
  const gradientValues = gradients.map((entry) => entry.channel.gradient.gradientZ).sort(numericAscending);
  const commonStateCounts = countStates(entries, "common", ["SHARED_POSITIVE", "SHARED_NEGATIVE", "SHARED_NEUTRAL", "DIVERGENT", "WEST_MIXED", "UNAVAILABLE"]);
  const gradientStateCounts = countStates(entries, "gradient", ["EAST_LEAN", "WEST_LEAN", "BALANCED", "UNAVAILABLE"]);
  const pairedValues = both
    .filter((entry) => typeof entry.channel.east.z === "number" && typeof entry.channel.west.z === "number")
    .map((entry) => ({ east: entry.channel.east.z, west: entry.channel.west.z }));

  return {
    totalTargetDates: entries.length,
    eastAvailableDates,
    westAvailableDates,
    bothAvailableDates: both.length,
    availabilityRate: rate(both.length, entries.length),
    commonStateCounts,
    gradientStateCounts,
    gradient: {
      availableDates: gradientValues.length,
      p10: percentile(gradientValues, 0.1),
      median: gradientValues.length > 0 ? median(gradientValues) : null,
      p90: percentile(gradientValues, 0.9)
    },
    sameDayEastWestCorrelation: pearsonCorrelation(pairedValues),
    strongestEastLeanDates: gradients
      .filter((entry) => entry.channel.gradient.state === "EAST_LEAN")
      .sort((left, right) => right.channel.gradient.gradientZ - left.channel.gradient.gradientZ || left.targetDate.localeCompare(right.targetDate))
      .slice(0, 10)
      .map(strengthRecord),
    strongestWestLeanDates: gradients
      .filter((entry) => entry.channel.gradient.state === "WEST_LEAN")
      .sort((left, right) => left.channel.gradient.gradientZ - right.channel.gradient.gradientZ || left.targetDate.localeCompare(right.targetDate))
      .slice(0, 10)
      .map(strengthRecord)
  };
}

function countStates(entries, component, states) {
  const counts = Object.fromEntries(states.map((state) => [state, 0]));
  for (const entry of entries) counts[entry.channel[component].state] += 1;
  return counts;
}

function strengthRecord(entry) {
  return {
    targetDate: entry.targetDate,
    eastZ: entry.channel.east.z,
    westZ: entry.channel.west.z,
    gradientZ: entry.channel.gradient.gradientZ,
    commonState: entry.channel.common.state,
    westConsensus: entry.channel.west.consensus
  };
}

function pearsonCorrelation(values) {
  if (values.length < 2) return { pairedDates: values.length, value: null };
  const meanEast = values.reduce((sum, item) => sum + item.east, 0) / values.length;
  const meanWest = values.reduce((sum, item) => sum + item.west, 0) / values.length;
  let covariance = 0;
  let eastSquares = 0;
  let westSquares = 0;
  for (const item of values) {
    const eastDelta = item.east - meanEast;
    const westDelta = item.west - meanWest;
    covariance += eastDelta * westDelta;
    eastSquares += eastDelta ** 2;
    westSquares += westDelta ** 2;
  }
  const denominator = Math.sqrt(eastSquares * westSquares);
  return { pairedDates: values.length, value: denominator === 0 ? null : covariance / denominator };
}

function buildSanityFlags(channelId, summary, states) {
  const flags = [];
  const availableRate = summary.availabilityRate;
  if (availableRate < 0.2) flags.push(flag(channelId, "LOW_BOTH_SIDE_AVAILABILITY", "Few dates satisfy both the East single-node and West minimum-contribution requirements."));

  const commonAvailable = summary.bothAvailableDates;
  const dominantCommon = Object.entries(summary.commonStateCounts)
    .filter(([state]) => state !== "UNAVAILABLE")
    .sort((left, right) => right[1] - left[1])[0];
  if (commonAvailable >= 10 && dominantCommon && dominantCommon[1] / commonAvailable >= 0.9) {
    flags.push(flag(channelId, "COMMON_STATE_CONCENTRATED", `${dominantCommon[0]} dominates available dates; local baselines or persistent source distributions may be concentrated.`));
  }

  const gradientAvailable = summary.gradient.availableDates;
  const eastLean = summary.gradientStateCounts.EAST_LEAN;
  const westLean = summary.gradientStateCounts.WEST_LEAN;
  if (gradientAvailable >= 10 && Math.max(eastLean, westLean) / gradientAvailable >= 0.9) {
    flags.push(flag(channelId, "GRADIENT_ONE_SIDED", "One side dominates the standardized spatial contrast; this may reflect persistent relative baselines or source coverage."));
  }

  const eastValues = states.map((state) => state.channels[channelId].east.z).filter((value) => typeof value === "number");
  const saturated = eastValues.filter((value) => Math.abs(value) === 4).length;
  if (eastValues.length >= 10 && saturated / eastValues.length >= 0.9) {
    flags.push(flag(channelId, "EAST_Z_CLAMP_SATURATION", "East values are usually clamped; sparse or zero-MAD baselines with the fixed scale floor are a likely reason."));
  }

  const westAvailable = states.filter((state) => state.channels[channelId].west.available);
  const westMixed = westAvailable.filter((state) => state.channels[channelId].west.consensus === "mixed").length;
  if (westAvailable.length >= 10 && westMixed / westAvailable.length >= 0.5) {
    flags.push(flag(channelId, "WEST_FREQUENTLY_MIXED", "Yokohama facilities often occupy different anomaly buckets despite adequate contribution."));
  }

  if (channelId === "coreBait" && availableRate < 0.4) {
    flags.push(flag(channelId, "CORE_BAIT_LOW_COVERAGE", "Core bait requires at least three valid species per side, reducing coverage when reports or baselines are incomplete."));
  }
  return flags;
}

function flag(channelId, code, likelyReason) {
  return { channelId, code, severity: "review", likelyReason };
}

async function readProductionFacility({ facilityId, queryStartDate, endDate, outputDir }) {
  const sql = assertReadOnlySelect(`
    SELECT
      r.report_id,
      r.version_key,
      r.identity_key,
      r.facility_id,
      r.observation_date,
      r.collected_at,
      r.visitor_count,
      r.operating_status,
      r.report_completeness,
      s.species_id,
      s.catch_count,
      s.presence_state,
      s.completeness,
      s.alias_coverage
    FROM fixed_node_daily_reports r
    JOIN fixed_node_species_observations s ON s.report_id = r.report_id
    WHERE r.facility_id = '${facilityId}'
      AND r.observation_date BETWEEN '${queryStartDate}' AND '${endDate}'
    ORDER BY r.observation_date, r.collected_at, r.version_key, s.species_id
  `).replace(/\s+/gu, " ").trim();
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const logDir = path.join(outputDir, "wrangler-logs");
  mkdirSync(logDir, { recursive: true });
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const { stdout } = await execFileAsync(npx, [
        "wrangler", "d1", "execute", DATABASE,
        "--remote", "--config", CONFIG_PATH,
        "--command", sql, "--json"
      ], {
        cwd: REPO_ROOT,
        env: { ...process.env, WRANGLER_LOG_PATH: logDir },
        maxBuffer: 128 * 1024 * 1024
      });
      return { rows: parseWranglerD1JsonOutput(stdout), attempts };
    } catch (error) {
      const message = String(error?.stderr ?? error?.stdout ?? error?.message ?? "");
      if (attempts === 1 && /(?:7403|not valid or is not authorized)/iu.test(message)) continue;
      throw error;
    }
  }
}

function percentile(sorted, probability) {
  return sorted.length > 0 ? quantile(sorted, probability) : null;
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function numericAscending(left, right) {
  return left - right;
}

function dateRange(startDate, endDate) {
  const dates = [];
  for (let date = startDate; date <= endDate; date = addDaysIso(date, 1)) dates.push(date);
  return dates;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--start-date") options.startDate = argv[++index];
    else if (arg === "--end-date") options.endDate = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBayFixedNodeStateSanity(parseCliArgs(process.argv.slice(2)))
    .then(({ summary, outputPath }) => {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: summary.schemaVersion,
        analysisMode: summary.analysisMode,
        targetDateRange: summary.targetDateRange,
        retrospectiveKnowledgeAt: summary.retrospectiveKnowledgeAt,
        rowsReadPerFacility: summary.rowsReadPerFacility,
        sanityFlagCount: summary.sanityFlags.length,
        outputPath
      }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, message: error?.message ?? String(error) })}\n`);
      process.exitCode = 1;
    });
}
