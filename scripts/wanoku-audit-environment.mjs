#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localRequire = createRequire(import.meta.url);

const DEFAULTS = {
  workerUrl: "https://wanoku-intel-worker.mtk0808.workers.dev",
  config: "workers/wanoku-intel-worker/wrangler.toml",
  database: "WANOKU_INTEL_D1",
  expectedNodes: 12,
  sinceHours: 6
};

const PROVIDERS = ["open-meteo-weather", "open-meteo-marine"];
const GUST_WARNING = "wind_gust_below_sustained_wind";

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULTS, json: false, fixtureDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--worker-url") {
      options.workerUrl = readValue();
    } else if (arg === "--config") {
      options.config = readValue();
    } else if (arg === "--database") {
      options.database = readValue();
    } else if (arg === "--expected-nodes") {
      options.expectedNodes = parsePositiveInt(readValue(), "expected-nodes");
    } else if (arg === "--since-hours") {
      options.sinceHours = parsePositiveNumber(readValue(), "since-hours");
    } else if (arg === "--fixture-dir") {
      options.fixtureDir = readValue();
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export async function runAudit(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const checkedAt = new Date().toISOString();

  if (config.fixtureDir) {
    return analyzeAuditData({
      checkedAt,
      options: config,
      health: readFixtureJson(config.fixtureDir, "health.json"),
      current: readFixtureJson(config.fixtureDir, "current.json"),
      quality: readFixtureJson(config.fixtureDir, "quality.json"),
      d1: normalizeD1Fixture(readFixtureJson(config.fixtureDir, "d1.json"))
    });
  }

  const fetchPublic = config.fetchPublicApiImpl || fetchPublicApi;
  const api = await fetchPublic(config.workerUrl);
  const d1 = runD1ReadOnlyAudit(config);
  return analyzeAuditData({ checkedAt, options: config, ...api, d1 });
}

export async function fetchPublicApi(workerUrl) {
  const base = workerUrl.replace(/\/+$/, "");
  const [health, current, quality] = await Promise.all([
    fetchJson(`${base}/health`),
    fetchJson(`${base}/environment/current`),
    fetchJson(`${base}/environment/quality`)
  ]);
  return { health, current, quality };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`API request failed: ${new URL(url).pathname} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`API returned invalid JSON: ${new URL(url).pathname}`);
  }
}

export function runD1ReadOnlyAudit(options) {
  const sinceIso = new Date(Date.now() - options.sinceHours * 3600_000).toISOString();
  const queries = [
    {
      name: "recentRuns",
      sql: `
WITH latest AS (
  SELECT provider, MAX(requested_at) AS requested_at
  FROM source_runs
  WHERE provider IN ('open-meteo-weather', 'open-meteo-marine')
  GROUP BY provider
)
SELECT
  sr.provider AS provider,
  sr.requested_at AS requestedAt,
  MAX(sr.completed_at) AS completedAt,
  COUNT(DISTINCT sr.node_id) AS nodeCount,
  SUM(CASE WHEN sr.status = 'ok' THEN 1 ELSE 0 END) AS okCount,
  SUM(CASE WHEN sr.status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
  GROUP_CONCAT(DISTINCT sr.status) AS statuses
FROM source_runs sr
JOIN latest ON latest.provider = sr.provider AND latest.requested_at = sr.requested_at
GROUP BY sr.provider, sr.requested_at
ORDER BY sr.provider`
    },
    {
      name: "failedRuns",
      sql: `
SELECT
  provider AS provider,
  COUNT(*) AS failedCount
FROM source_runs
WHERE requested_at >= '${escapeSqlLiteral(sinceIso)}'
  AND status = 'failed'
  AND provider IN ('open-meteo-weather', 'open-meteo-marine')
GROUP BY provider
ORDER BY provider`
    },
    {
      name: "snapshotSummary",
      sql: `
WITH latest AS (
  SELECT provider, MAX(collected_at) AS collected_at
  FROM environmental_snapshots
  WHERE provider IN ('open-meteo-weather', 'open-meteo-marine')
  GROUP BY provider
)
SELECT
  es.provider AS provider,
  latest.collected_at AS latestCollectedAt,
  COUNT(*) AS snapshotCount,
  COUNT(DISTINCT es.node_id) AS distinctNodes,
  SUM(CASE WHEN es.collected_at IS NULL OR es.collected_at = '' THEN 1 ELSE 0 END) AS collectedMissing,
  SUM(CASE WHEN json_extract(es.normalized_json, '$.coordinateDistanceKm') IS NULL THEN 1 ELSE 0 END) AS distanceMissing,
  SUM(CASE WHEN json_extract(es.normalized_json, '$.model') IS NOT NULL AND json_extract(es.normalized_json, '$.model') != '' THEN 1 ELSE 0 END) AS modelCount,
  SUM(CASE WHEN es.forecast_issued_at IS NOT NULL AND es.forecast_issued_at != '' THEN 1 ELSE 0 END) AS forecastIssuedAtMisuseCount
FROM environmental_snapshots es
JOIN latest ON latest.provider = es.provider AND latest.collected_at = es.collected_at
GROUP BY es.provider, latest.collected_at
ORDER BY es.provider`
    }
  ];

  const out = { recentRuns: [], failedRuns: [], snapshotSummary: [] };
  for (const query of queries) {
    assertReadOnlySql(query.sql);
    out[query.name] = runWranglerD1Query(options, query.sql);
  }
  return out;
}

export function runWranglerD1Query(options, sql) {
  const runner = options.processRunner || spawnSync;
  const wranglerCli = options.wranglerCli || resolveWranglerCli({ requireFn: options.requireFn });
  const result = runner(process.execPath, [
    wranglerCli,
    "d1",
    "execute",
    options.database,
    "--remote",
    "--json",
    "--command",
    sql,
    "--config",
    options.config
  ], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`D1 read-only query failed with exit code ${result.status}: ${result.stderr || "no stderr"}`);
  }
  return extractD1Rows(result.stdout);
}

export function resolveWranglerCli({ requireFn = localRequire } = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = requireFn.resolve("wrangler/package.json");
  } catch {
    throw new Error("Wrangler CLI could not be resolved from this repository.\nRun npm install and try again.");
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    throw new Error("Wrangler CLI could not be resolved from this repository.\nRun npm install and try again.");
  }

  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.wrangler;
  if (!bin || typeof bin !== "string") {
    throw new Error("Wrangler CLI could not be resolved from this repository.\nRun npm install and try again.");
  }

  return path.resolve(path.dirname(packageJsonPath), bin);
}

export function assertReadOnlySql(sql) {
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    throw new Error("Refusing to execute non-SELECT SQL.");
  }
  if (/\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|pragma|vacuum)\b/i.test(sql)) {
    throw new Error("Refusing to execute mutating SQL.");
  }
}

export function extractD1Rows(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => extractRowsFromD1Result(item));
  }
  return extractRowsFromD1Result(parsed);
}

function extractRowsFromD1Result(value) {
  if (Array.isArray(value?.results)) return value.results;
  if (Array.isArray(value?.result?.[0]?.results)) return value.result[0].results;
  if (Array.isArray(value?.[0]?.results)) return value[0].results;
  return [];
}

export function analyzeAuditData({ checkedAt, options, health, current, quality, d1 }) {
  const expectedProviders = PROVIDERS.length;
  const expectedSnapshots = options.expectedNodes * expectedProviders;
  const currentSummary = summarizeCurrent(current);
  const qualitySummary = summarizeQuality(quality);
  const d1Summary = summarizeD1(d1);
  const coordinateDistance = summarizeCoordinateDistance(currentSummary.snapshots);
  const issues = [];
  const informationalWarnings = [];

  if (!health || typeof health !== "object") {
    issues.push(failedIssue("api_health_unavailable", "Health API did not return an object."));
  }
  if (currentSummary.snapshotCount < Math.ceil(expectedSnapshots * 0.75)) {
    issues.push(failedIssue("current_snapshot_shortage", `Current snapshots are far below expected: ${currentSummary.snapshotCount}/${expectedSnapshots}.`));
  } else if (currentSummary.snapshotCount !== expectedSnapshots) {
    issues.push(degradedIssue("current_snapshot_count", `Current snapshots are ${currentSummary.snapshotCount}/${expectedSnapshots}.`));
  }
  if (currentSummary.nodeCount < Math.ceil(options.expectedNodes * 0.75)) {
    issues.push(failedIssue("node_shortage", `Distinct nodes are far below expected: ${currentSummary.nodeCount}/${options.expectedNodes}.`));
  } else if (currentSummary.nodeCount !== options.expectedNodes) {
    issues.push(degradedIssue("node_count", `Distinct nodes are ${currentSummary.nodeCount}/${options.expectedNodes}.`));
  }
  if (currentSummary.providerCount < expectedProviders) {
    issues.push(failedIssue("provider_missing", `Providers are ${currentSummary.providerCount}/${expectedProviders}.`));
  }
  if (qualitySummary.staleCount > 0) {
    issues.push(degradedIssue("stale_quality", `${qualitySummary.staleCount} quality rows are stale.`));
  }
  if (currentSummary.collectedMissing > 0 || currentSummary.distanceMissing > 0 || currentSummary.modelCount > 0) {
    issues.push(degradedIssue("current_schema_quality", "Current API has missing collectedAt, missing distance, or model contamination."));
  }
  if (qualitySummary.distanceMissing > 0 || qualitySummary.invalidConfidenceCount > 0) {
    issues.push(degradedIssue("quality_schema_quality", "Quality API has missing distance or invalid confidence."));
  }
  if (d1Summary.error) {
    issues.push(failedIssue("d1_unavailable", d1Summary.error));
  }
  if (d1Summary.forecastIssuedAtMisuseCount > 0 || d1Summary.modelCount > 0 || d1Summary.collectedMissing > 0 || d1Summary.distanceMissing > 0) {
    issues.push(degradedIssue("d1_schema_quality", "D1 latest snapshots have semantic/schema issues."));
  }
  if (d1Summary.snapshotCount && d1Summary.snapshotCount !== currentSummary.snapshotCount) {
    issues.push(degradedIssue("api_d1_snapshot_mismatch", `D1 latest snapshots ${d1Summary.snapshotCount} differ from current API ${currentSummary.snapshotCount}.`));
  }

  const runChecks = summarizeRecentRunIssues(d1Summary.recentRuns, options.expectedNodes, checkedAt, options.sinceHours);
  issues.push(...runChecks.issues);
  if (qualitySummary.warningCounts[GUST_WARNING]) {
    informationalWarnings.push({
      code: GUST_WARNING,
      count: qualitySummary.warningCounts[GUST_WARNING],
      message: "Provider data includes wind gust below sustained wind; values are not modified."
    });
  }

  const status = chooseStatus(issues);
  const latestCollection = d1Summary.latestCollection || maxIso(currentSummary.snapshots.map((snapshot) => snapshot.collectedAt));
  return {
    status,
    checkedAt,
    latestCollection,
    current: {
      snapshotCount: currentSummary.snapshotCount,
      expectedSnapshots,
      nodeCount: currentSummary.nodeCount,
      expectedNodes: options.expectedNodes,
      providerCount: currentSummary.providerCount,
      expectedProviders,
      collectedMissing: currentSummary.collectedMissing,
      coordinateDistanceMissing: currentSummary.distanceMissing,
      modelCount: currentSummary.modelCount
    },
    quality: {
      count: qualitySummary.count,
      staleCount: qualitySummary.staleCount,
      coordinateDistanceMissing: qualitySummary.distanceMissing,
      missingRatePositiveCount: qualitySummary.missingRatePositiveCount,
      invalidConfidenceCount: qualitySummary.invalidConfidenceCount,
      warningCounts: qualitySummary.warningCounts,
      warningsByNodeProvider: qualitySummary.warningsByNodeProvider
    },
    recentRuns: d1Summary.recentRuns,
    d1: {
      snapshotCount: d1Summary.snapshotCount,
      providerSnapshotCounts: d1Summary.providerSnapshotCounts,
      distinctNodes: d1Summary.distinctNodes,
      failedRunCount: d1Summary.failedRunCount,
      collectedMissing: d1Summary.collectedMissing,
      coordinateDistanceMissing: d1Summary.distanceMissing,
      modelCount: d1Summary.modelCount,
      forecastIssuedAtMisuseCount: d1Summary.forecastIssuedAtMisuseCount,
      latestCollection: d1Summary.latestCollection
    },
    coordinateDistance,
    issues,
    informationalWarnings
  };
}

function summarizeCurrent(current) {
  const snapshots = Array.isArray(current?.snapshots) ? current.snapshots : [];
  const providers = new Set();
  const nodes = new Set();
  let collectedMissing = 0;
  let distanceMissing = 0;
  let modelCount = 0;
  for (const snapshot of snapshots) {
    if (snapshot?.nodeId) nodes.add(snapshot.nodeId);
    const provider = providerOf(snapshot);
    if (provider) providers.add(provider);
    if (!snapshot?.collectedAt) collectedMissing += 1;
    if (!Number.isFinite(Number(snapshot?.coordinateDistanceKm))) distanceMissing += 1;
    if (Object.prototype.hasOwnProperty.call(snapshot || {}, "model") && snapshot.model != null && snapshot.model !== "") modelCount += 1;
  }
  return {
    snapshots,
    snapshotCount: snapshots.length,
    nodeCount: nodes.size,
    providerCount: providers.size,
    collectedMissing,
    distanceMissing,
    modelCount
  };
}

function summarizeQuality(quality) {
  const rows = Array.isArray(quality?.quality) ? quality.quality : [];
  const warningCounts = {};
  const warningsByNodeProvider = [];
  let staleCount = 0;
  let distanceMissing = 0;
  let missingRatePositiveCount = 0;
  let invalidConfidenceCount = 0;
  for (const item of rows) {
    if (item?.stale) staleCount += 1;
    if (!Number.isFinite(Number(item?.coordinateDistanceKm))) distanceMissing += 1;
    if (Number(item?.missingRate) > 0) missingRatePositiveCount += 1;
    if (!Number.isFinite(Number(item?.confidence))) invalidConfidenceCount += 1;
    for (const warning of Array.isArray(item?.warnings) ? item.warnings : []) {
      warningCounts[warning] = (warningCounts[warning] || 0) + 1;
      warningsByNodeProvider.push({
        nodeId: item.nodeId || null,
        provider: providerOf(item) || null,
        warning
      });
    }
  }
  return { count: rows.length, staleCount, distanceMissing, missingRatePositiveCount, invalidConfidenceCount, warningCounts, warningsByNodeProvider };
}

function summarizeD1(d1) {
  try {
    const recentRuns = (d1?.recentRuns || []).map((row) => ({
      provider: row.provider,
      requestedAt: row.requestedAt || row.requested_at || null,
      completedAt: row.completedAt || row.completed_at || null,
      status: normalizeRunStatus(row),
      nodeCount: numberField(row, "nodeCount", "node_count"),
      okCount: numberField(row, "okCount", "ok_count"),
      failedCount: numberField(row, "failedCount", "failed_count")
    }));
    const snapshotSummary = d1?.snapshotSummary || [];
    const failedRuns = d1?.failedRuns || [];
    const providerSnapshotCounts = Object.fromEntries(snapshotSummary.map((row) => [row.provider, numberField(row, "snapshotCount", "snapshot_count")]));
    const latestCollection = maxIso(snapshotSummary.map((row) => row.latestCollectedAt || row.latest_collected_at));
    return {
      recentRuns,
      snapshotCount: sum(snapshotSummary.map((row) => numberField(row, "snapshotCount", "snapshot_count"))),
      providerSnapshotCounts,
      distinctNodes: Math.max(0, ...snapshotSummary.map((row) => numberField(row, "distinctNodes", "distinct_nodes"))),
      failedRunCount: sum(failedRuns.map((row) => numberField(row, "failedCount", "failed_count"))) + sum(recentRuns.map((row) => row.failedCount)),
      collectedMissing: sum(snapshotSummary.map((row) => numberField(row, "collectedMissing", "collected_missing"))),
      distanceMissing: sum(snapshotSummary.map((row) => numberField(row, "distanceMissing", "distance_missing"))),
      modelCount: sum(snapshotSummary.map((row) => numberField(row, "modelCount", "model_count"))),
      forecastIssuedAtMisuseCount: sum(snapshotSummary.map((row) => numberField(row, "forecastIssuedAtMisuseCount", "forecast_issued_at_misuse_count"))),
      latestCollection
    };
  } catch (error) {
    return { error: `D1 summary parse failed: ${error.message}` };
  }
}

function summarizeRecentRunIssues(recentRuns, expectedNodes, checkedAt, sinceHours) {
  const issues = [];
  for (const provider of PROVIDERS) {
    const run = recentRuns.find((item) => item.provider === provider);
    if (!run) {
      issues.push(failedIssue("recent_run_missing", `Missing recent run for ${provider}.`));
      continue;
    }
    if (run.okCount !== expectedNodes || run.nodeCount !== expectedNodes || run.failedCount > 0 || run.status !== "ok") {
      issues.push(degradedIssue("recent_run_partial", `${provider}: ${run.status} ${run.okCount}/${expectedNodes}.`));
    }
    const ageHours = hoursBetween(run.completedAt || run.requestedAt, checkedAt);
    if (ageHours != null && ageHours > sinceHours) {
      issues.push(degradedIssue("latest_collection_old", `${provider} latest run is ${ageHours.toFixed(1)}h old.`));
    }
  }
  return { issues };
}

function summarizeCoordinateDistance(snapshots) {
  const byProvider = {};
  for (const snapshot of snapshots) {
    const provider = providerOf(snapshot) || "unknown";
    const value = Number(snapshot.coordinateDistanceKm);
    if (!Number.isFinite(value)) continue;
    byProvider[provider] ||= { count: 0, sum: 0, max: 0 };
    byProvider[provider].count += 1;
    byProvider[provider].sum += value;
    byProvider[provider].max = Math.max(byProvider[provider].max, value);
  }
  return Object.fromEntries(Object.entries(byProvider).map(([provider, stats]) => [
    provider,
    {
      count: stats.count,
      averageKm: round(stats.sum / stats.count, 3),
      maxKm: round(stats.max, 3)
    }
  ]));
}

function normalizeD1Fixture(value) {
  return {
    recentRuns: value.recentRuns || [],
    failedRuns: value.failedRuns || [],
    snapshotSummary: value.snapshotSummary || []
  };
}

export function formatHumanReport(report) {
  const lines = [];
  lines.push("WANOKU ENVIRONMENT AUDIT");
  lines.push(`Status: ${report.status}`);
  lines.push(`Checked at: ${report.checkedAt}`);
  lines.push(`Latest collection: ${report.latestCollection || "unknown"}`);
  lines.push("");
  lines.push("Current API");
  lines.push(`  Snapshots: ${report.current.snapshotCount}/${report.current.expectedSnapshots}`);
  lines.push(`  Nodes: ${report.current.nodeCount}/${report.current.expectedNodes}`);
  lines.push(`  Providers: ${report.current.providerCount}/${report.current.expectedProviders}`);
  lines.push(`  Missing collectedAt: ${report.current.collectedMissing}`);
  lines.push(`  Missing distance: ${report.current.coordinateDistanceMissing}`);
  lines.push(`  Rows with model: ${report.current.modelCount}`);
  lines.push("");
  lines.push("Quality API");
  lines.push(`  Rows: ${report.quality.count}`);
  lines.push(`  Stale: ${report.quality.staleCount}`);
  lines.push(`  Missing distance: ${report.quality.coordinateDistanceMissing}`);
  lines.push(`  MissingRate > 0: ${report.quality.missingRatePositiveCount}`);
  lines.push(`  Invalid confidence: ${report.quality.invalidConfidenceCount}`);
  lines.push("  Warnings:");
  const warningEntries = Object.entries(report.quality.warningCounts);
  if (!warningEntries.length) lines.push("    none");
  for (const [warning, count] of warningEntries) lines.push(`    ${warning}: ${count}`);
  lines.push("");
  lines.push("Recent Cron");
  for (const provider of PROVIDERS) {
    const run = report.recentRuns.find((item) => item.provider === provider);
    lines.push(`  ${provider}: ${run ? `${run.status} ${run.okCount}/${report.current.expectedNodes}` : "missing"}`);
  }
  lines.push("");
  lines.push("Coordinate distance");
  for (const provider of PROVIDERS) {
    const stats = report.coordinateDistance[provider];
    lines.push(`  ${provider}: ${stats ? `avg ${stats.averageKm} km / max ${stats.maxKm} km` : "no data"}`);
  }
  if (report.issues.length) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of report.issues) lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
  if (report.informationalWarnings.length) {
    lines.push("");
    lines.push("Informational warnings:");
    for (const item of report.informationalWarnings) lines.push(`  ${item.code}: ${item.count}`);
  }
  return `${lines.join("\n")}\n`;
}

export function statusToExitCode(status) {
  if (status === "HEALTHY") return 0;
  if (status === "DEGRADED") return 1;
  if (status === "FAILED") return 2;
  return 3;
}

function chooseStatus(issues) {
  if (issues.some((issue) => issue.severity === "FAILED")) return "FAILED";
  if (issues.some((issue) => issue.severity === "DEGRADED")) return "DEGRADED";
  return "HEALTHY";
}

function failedIssue(code, message) {
  return { severity: "FAILED", code, message };
}

function degradedIssue(code, message) {
  return { severity: "DEGRADED", code, message };
}

function readFixtureJson(dir, file) {
  return JSON.parse(readFileSync(path.join(dir, file), "utf8"));
}

function providerOf(item) {
  return item?.source || item?.provider || null;
}

function normalizeRunStatus(row) {
  const statuses = String(row.statuses || row.status || "").split(",").filter(Boolean);
  if (statuses.length === 1) return statuses[0];
  if (Number(row.failedCount ?? row.failed_count ?? 0) > 0) return "partial";
  return Number(row.okCount ?? row.ok_count ?? 0) > 0 ? "ok" : "unknown";
}

function numberField(row, camel, snake) {
  const value = Number(row?.[camel] ?? row?.[snake] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
}

function maxIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function hoursBetween(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return null;
  return Math.max(0, (rightMs - leftMs) / 3600_000);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function printHelp(out = process.stdout) {
  out.write(`Usage: node scripts/wanoku-audit-environment.mjs [options]

Options:
  --worker-url <url>       Worker origin. Default: ${DEFAULTS.workerUrl}
  --config <path>          Wrangler config path. Default: ${DEFAULTS.config}
  --database <binding>     D1 binding/database name. Default: ${DEFAULTS.database}
  --expected-nodes <n>     Expected environmental nodes. Default: ${DEFAULTS.expectedNodes}
  --since-hours <n>        Freshness window in hours. Default: ${DEFAULTS.sinceHours}
  --fixture-dir <path>     Read health/current/quality/d1 JSON fixtures instead of network/D1.
  --json                  Print only one JSON object.
`);
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }, overrides = {}) {
  try {
    const options = { ...parseArgs(argv), ...overrides };
    if (options.help) {
      printHelp(io.stdout);
      return 0;
    }
    const report = await runAudit(options);
    if (options.json) {
      io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout.write(formatHumanReport(report));
    }
    return statusToExitCode(report.status);
  } catch (error) {
    const payload = {
      status: "ERROR",
      checkedAt: new Date().toISOString(),
      error: error?.message || "Audit tool failed."
    };
    const wantsJson = argv.includes("--json");
    if (wantsJson) {
      io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      io.stderr.write(`WANOKU ENVIRONMENT AUDIT\nStatus: ERROR\n${payload.error}\n`);
    }
    return 3;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export function createFixtureDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "wanoku-audit-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), "utf8");
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
