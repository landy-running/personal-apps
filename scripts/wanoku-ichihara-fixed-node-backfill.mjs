#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ICHIHARA_BACKFILL_SCHEMA_VERSION = "wanoku-ichihara-fixed-node-backfill.v1";
export const ICHIHARA_BACKFILL_START_DATE = "2025-09-01";
export const ICHIHARA_BACKFILL_END_DATE = "2026-08-19";
export const ICHIHARA_BACKFILL_OUTPUT_DIR = ".tmp/wanoku-ichihara-backfill-live";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_URL = "https://ichihara-umizuri.com/fishing/";
const ROBOTS_URL = "https://ichihara-umizuri.com/robots.txt";
const FACILITY_ID = "ichihara-original-maker";
const PROVIDER_ID = "ichihara-umizuri";
const MODEL_VERSION = "wanoku-ichihara-historical-backfill-v1";
const MAX_ARCHIVE_PAGES = 50;
const MAX_RETRIES = 2;
const SOURCE_RUN_COLUMNS = [
  "id", "provider", "node_id", "requested_at", "completed_at", "status", "http_status", "error_code",
  "model_version", "raw_hash", "normalized_schema_version"
];
const REPORT_COLUMNS = [
  "report_id", "version_key", "identity_key", "semantic_hash", "facility_id", "provider_id", "observation_date",
  "source_record_id", "source_run_id", "published_at", "collected_at", "stored_at", "visitor_count", "operating_status",
  "report_completeness", "normalized_schema_version", "source_url", "payload_json"
];
const SPECIES_COLUMNS = [
  "observation_id", "report_id", "facility_id", "observation_date", "species_id", "source_labels_json", "catch_count",
  "presence_state", "min_size_cm", "max_size_cm", "area_labels_json", "completeness", "alias_coverage"
];
let loadedModules = null;

export class IchiharaHistoricalBackfillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "IchiharaHistoricalBackfillError";
    this.code = code;
  }
}

export function parseIchiharaBackfillArgs(argv = process.argv.slice(2)) {
  const options = {
    outputDir: ICHIHARA_BACKFILL_OUTPUT_DIR,
    startDate: ICHIHARA_BACKFILL_START_DATE,
    endDate: ICHIHARA_BACKFILL_END_DATE,
    delayMs: 400,
    offline: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new IchiharaHistoricalBackfillError("invalid_cli", `Missing value for ${arg}.`);
      index += 1;
      return next;
    };
    if (arg === "--output-dir") options.outputDir = value();
    else if (arg === "--start-date") options.startDate = requireIsoDate(value(), "start-date");
    else if (arg === "--end-date") options.endDate = requireIsoDate(value(), "end-date");
    else if (arg === "--delay-ms") options.delayMs = parseInteger(value(), "delay-ms", 300, 10_000);
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new IchiharaHistoricalBackfillError("invalid_cli", `Unknown option: ${arg}`);
  }
  if (options.startDate > options.endDate) throw new IchiharaHistoricalBackfillError("invalid_range", "start-date must be <= end-date.");
  return options;
}

export async function runIchiharaHistoricalBackfill(input = {}) {
  const outputDir = path.resolve(input.outputDir ?? ICHIHARA_BACKFILL_OUTPUT_DIR);
  const startDate = requireIsoDate(input.startDate ?? ICHIHARA_BACKFILL_START_DATE, "startDate");
  const endDate = requireIsoDate(input.endDate ?? ICHIHARA_BACKFILL_END_DATE, "endDate");
  if (startDate > endDate) throw new IchiharaHistoricalBackfillError("invalid_range", "startDate must be <= endDate.");
  mkdirSync(outputDir, { recursive: true });
  const acquisition = await acquireIchiharaHistoricalArtifacts({
    outputDir,
    startDate,
    endDate,
    delayMs: input.delayMs ?? 400,
    offline: input.offline ?? false,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    clock: input.clock ?? (() => new Date())
  });
  const generated = await generateIchiharaImportPackage({ outputDir, startDate, endDate, acquisition });
  writeGeneratedArtifacts(outputDir, generated);
  const localD1 = input.skipLocalD1
    ? { ok: true, skipped: true, reason: "test-or-explicit-skip" }
    : validateWithLocalD1(outputDir, generated);
  if (!localD1.ok) throw new IchiharaHistoricalBackfillError("local_d1_validation_failed", localD1.errors.join(" "));
  const manifest = buildManifest({ outputDir, generated, acquisition, localD1, clock: input.clock ?? (() => new Date()) });
  atomicWriteJson(path.join(outputDir, "manifest.json"), manifest);
  return { ...generated, acquisition, localD1, manifest, outputDir };
}

export async function acquireIchiharaHistoricalArtifacts(input) {
  const modules = loadWanokuModules();
  const outputDir = path.resolve(input.outputDir);
  const rawDir = path.join(outputDir, "raw");
  mkdirSync(path.join(rawDir, "archive"), { recursive: true });
  mkdirSync(path.join(rawDir, "detail"), { recursive: true });
  const indexPath = path.join(outputDir, "acquisition.json");
  const state = readAcquisitionState(indexPath, input.startDate, input.endDate);
  const stats = { successfulArchiveGets: 0, successfulDetailGets: 0, successfulRobotsGets: 0, retries: 0, failures: 0, skippedCachedArtifacts: 0 };
  let lastRequestAt = 0;
  const delayMs = input.delayMs;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new IchiharaHistoricalBackfillError("invalid_delay", "delayMs must be 0..10000.");
  if (typeof input.fetchImpl !== "function" && !input.offline) throw new IchiharaHistoricalBackfillError("fetch_unavailable", "fetch is unavailable.");

  const getArtifact = async ({ url, relativePath, artifactType, observationDate = null, numericId = null }) => {
    const absolutePath = path.join(outputDir, relativePath);
    const cached = state.artifacts[url];
    if (cached) {
      if (cached.relativePath !== relativePath || cached.artifactType !== artifactType || cached.observationDate !== observationDate || cached.numericId !== numericId) {
        throw new IchiharaHistoricalBackfillError("artifact_metadata_conflict", `Cached metadata conflicts for ${url}.`);
      }
      if (!existsSync(absolutePath)) throw new IchiharaHistoricalBackfillError("artifact_missing", `Cached artifact is missing: ${relativePath}`);
      const bytes = readFileSync(absolutePath);
      if (sha256(bytes) !== cached.sha256) throw new IchiharaHistoricalBackfillError("artifact_hash_mismatch", `Cached artifact hash mismatch: ${relativePath}`);
      stats.skippedCachedArtifacts += 1;
      return { text: bytes.toString("utf8"), metadata: cached };
    }
    if (existsSync(absolutePath)) throw new IchiharaHistoricalBackfillError("unindexed_artifact", `Unindexed artifact exists and will not be overwritten: ${relativePath}`);
    if (input.offline || state.frozen) throw new IchiharaHistoricalBackfillError("offline_artifact_missing", `Frozen/offline acquisition is missing ${url}.`);
    let response;
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (lastRequestAt > 0 && delayMs > 0) {
        const waitMs = Math.max(0, delayMs - (Date.now() - lastRequestAt));
        if (waitMs > 0) await sleep(waitMs);
      }
      lastRequestAt = Date.now();
      try {
        response = await input.fetchImpl(url, { method: "GET", headers: { accept: artifactType === "robots" ? "text/plain" : "text/html,application/xhtml+xml" } });
        if (response?.status === 429) throw new IchiharaHistoricalBackfillError("source_rate_limited", `Official source returned HTTP 429 for ${url}.`);
        if (response?.ok) break;
        if (!(response?.status >= 500 && response?.status <= 599)) {
          throw new IchiharaHistoricalBackfillError("source_http_error", `Official source returned HTTP ${response?.status ?? "unknown"} for ${url}.`);
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (error?.code === "source_rate_limited" || error?.code === "source_http_error") {
          stats.failures += 1;
          state.networkStats.failures += 1;
          atomicWriteJson(indexPath, state);
          throw error;
        }
        lastError = error;
      }
      if (attempt < MAX_RETRIES) {
        stats.retries += 1;
        state.networkStats.retries += 1;
        atomicWriteJson(indexPath, state);
      }
    }
    if (!response?.ok) {
      stats.failures += 1;
      state.networkStats.failures += 1;
      atomicWriteJson(indexPath, state);
      throw new IchiharaHistoricalBackfillError("source_fetch_failed", `Official source acquisition failed for ${url}: ${lastError?.message ?? "unknown error"}`);
    }
    const text = await response.text();
    const bytes = Buffer.from(text, "utf8");
    const metadata = {
      url,
      httpStatus: response.status,
      acquiredAt: canonicalClock(input.clock()),
      sha256: sha256(bytes),
      byteLength: bytes.length,
      observationDate,
      numericId,
      artifactType,
      relativePath
    };
    atomicWrite(absolutePath, bytes);
    state.artifacts[url] = metadata;
    state.createdAt ??= metadata.acquiredAt;
    state.updatedAt = metadata.acquiredAt;
    if (artifactType === "archive") {
      stats.successfulArchiveGets += 1;
      state.networkStats.successfulArchiveGets += 1;
    } else if (artifactType === "detail") {
      stats.successfulDetailGets += 1;
      state.networkStats.successfulDetailGets += 1;
    } else {
      stats.successfulRobotsGets += 1;
      state.networkStats.successfulRobotsGets += 1;
    }
    atomicWriteJson(indexPath, state);
    return { text, metadata };
  };

  const robots = await getArtifact({ url: ROBOTS_URL, relativePath: "raw/robots.txt", artifactType: "robots" });
  assertRobotsAllowsFishing(robots.text);
  const recordsById = new Map();
  const idByDate = new Map();
  let coveredStart = false;
  let archivePages = 0;
  for (let page = 1; page <= MAX_ARCHIVE_PAGES; page += 1) {
    const url = archivePageUrl(page);
    const artifact = await getArtifact({ url, relativePath: `raw/archive/page-${String(page).padStart(3, "0")}.html`, artifactType: "archive" });
    archivePages += 1;
    let parsed;
    try {
      parsed = modules.parseIchiharaArchive(artifact.text);
    } catch (error) {
      throw new IchiharaHistoricalBackfillError("archive_structure_changed", `Archive page ${page} is incompatible: ${error?.message ?? "parse error"}`);
    }
    if (parsed.records.length === 0) throw new IchiharaHistoricalBackfillError("archive_structure_changed", `Archive page ${page} contained no records.`);
    for (const record of parsed.records) registerArchiveRecord(record, recordsById, idByDate);
    if (parsed.records.some((record) => record.observationDate <= input.startDate)) {
      coveredStart = true;
      break;
    }
  }
  if (!coveredStart) throw new IchiharaHistoricalBackfillError("archive_range_not_covered", "Archive page bound did not cover the requested start date.");
  const selected = [...recordsById.values()]
    .filter((record) => record.observationDate >= input.startDate && record.observationDate <= input.endDate)
    .sort((left, right) => left.observationDate.localeCompare(right.observationDate));
  if (selected.length === 0) throw new IchiharaHistoricalBackfillError("range_empty", "No official reports were discovered in the requested range.");

  const details = [];
  for (const record of selected) {
    const artifact = await getArtifact({
      url: record.sourceUrl,
      relativePath: `raw/detail/${record.numericId}.html`,
      artifactType: "detail",
      observationDate: record.observationDate,
      numericId: record.numericId
    });
    let parsed;
    try {
      parsed = modules.parseIchiharaDetail({ html: artifact.text, sourceUrl: record.sourceUrl, collectedAt: artifact.metadata.acquiredAt });
    } catch (error) {
      throw new IchiharaHistoricalBackfillError("detail_structure_changed", `${record.sourceRecordId} is incompatible: ${error?.message ?? "parse error"}`);
    }
    if (parsed.sourceRecordId !== record.sourceRecordId || parsed.observationDate !== record.observationDate) {
      throw new IchiharaHistoricalBackfillError("list_detail_mismatch", `${record.sourceRecordId} archive/detail identity mismatch.`);
    }
    if (parsed.finality === "unknown" || parsed.finality === "interim") {
      throw new IchiharaHistoricalBackfillError("historical_finality_unresolved", `${record.sourceRecordId} has ${parsed.finality} finality.`);
    }
    details.push({ listing: record, artifact: artifact.metadata, parsed });
  }
  state.frozen = true;
  state.completedAt ??= canonicalClock(input.clock());
  state.archivePages = archivePages;
  state.discoveredReports = selected.length;
  atomicWriteJson(indexPath, state);
  return { state, stats, archivePages, records: details };
}

export async function generateIchiharaImportPackage({ outputDir, startDate, endDate, acquisition }) {
  const modules = loadWanokuModules();
  const byMonth = new Map();
  for (const item of acquisition.records) {
    const month = item.parsed.observationDate.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), item]);
  }
  const sourceRuns = [];
  const envelopes = [];
  const monthPlans = [];
  const unsupportedLabels = new Map();
  for (const [month, items] of [...byMonth.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sourceRun = buildMonthlySourceRun(month, items, modules.FIXED_NODE_OBSERVATION_SCHEMA_VERSION);
    sourceRuns.push(sourceRun);
    const monthly = [];
    for (const item of items.sort((left, right) => left.parsed.observationDate.localeCompare(right.parsed.observationDate))) {
      let report;
      try {
        report = modules.buildIchiharaFixedNodeReport(item.parsed, sourceRun.id);
      } catch (error) {
        throw new IchiharaHistoricalBackfillError("normalized_report_invalid", `${item.parsed.sourceRecordId}: ${error?.message ?? "report validation failed"}`);
      }
      const materialized = await modules.materializeFixedNodeDailyReport(report, item.artifact.acquiredAt);
      const classification = item.parsed.finality === "closure"
        ? "CLOSED"
        : item.parsed.diagnostics.includes("operating-day-interrupted")
          ? "INTERRUPTED"
          : report.reportCompleteness === "complete" ? "REPORT_COMPLETE" : "REPORT_INCOMPLETE";
      for (const row of item.parsed.unsupportedRows) unsupportedLabels.set(row.sourceName, (unsupportedLabels.get(row.sourceName) ?? 0) + 1);
      const envelope = {
        sourceMonth: month,
        classification,
        sourceFacts: {
          finality: item.parsed.finality,
          diagnostics: item.parsed.diagnostics,
          unsupportedSourceLabels: item.parsed.unsupportedRows.map((row) => row.sourceName)
        },
        report,
        materialized
      };
      monthly.push(envelope);
      envelopes.push(envelope);
    }
    monthPlans.push(buildMonthImportPlan(month, sourceRun, monthly));
  }
  const validation = validateLogicalDataset({ startDate, endDate, acquisition, sourceRuns, envelopes, monthPlans });
  if (!validation.ok) throw new IchiharaHistoricalBackfillError("logical_validation_failed", validation.errors.join(" "));
  const normalizedDatasetHash = normalizedHash(sourceRuns, envelopes);
  const secondHash = normalizedHash(sourceRuns, envelopes);
  if (normalizedDatasetHash !== secondHash) throw new IchiharaHistoricalBackfillError("nondeterministic_dataset", "Normalized dataset regeneration is not deterministic.");
  const summary = summarizeDataset({ startDate, endDate, acquisition, sourceRuns, envelopes, unsupportedLabels });
  const importFiles = monthPlans.map((plan) => ({
    sourceMonth: plan.sourceMonth,
    file: `import-${plan.sourceMonth}.sql`,
    reports: plan.reports,
    species: plan.species,
    statementCount: plan.statements.length,
    byteLength: Buffer.byteLength(plan.sql),
    sha256: sha256(plan.sql)
  }));
  return {
    outputDir,
    summary,
    validation,
    sourceRuns,
    envelopes,
    monthPlans,
    importFiles,
    normalizedDatasetHash,
    rawArtifactAggregateHash: rawArtifactAggregateHash(acquisition.state)
  };
}

export function buildMonthImportPlan(sourceMonth, sourceRun, envelopes) {
  const statements = [insertStatement("source_runs", SOURCE_RUN_COLUMNS, sourceRunParams(sourceRun))];
  for (const envelope of envelopes) {
    statements.push(insertStatement("fixed_node_daily_reports", REPORT_COLUMNS, reportParams(envelope.materialized)));
    for (const species of envelope.materialized.species) {
      statements.push(insertStatement("fixed_node_species_observations", SPECIES_COLUMNS, speciesParams(species)));
    }
  }
  const sql = `${statements.join("\n\n")}\n`;
  assertSafeSql(sql);
  return { sourceMonth, sourceRunId: sourceRun.id, reports: envelopes.length, species: envelopes.length * 8, statements, sql };
}

export function validateLogicalDataset({ startDate, endDate, acquisition, sourceRuns, envelopes, monthPlans }) {
  const errors = [];
  const species = envelopes.flatMap((item) => item.materialized.species);
  checkUnique(envelopes.map((item) => item.materialized.reportId), "report_id", errors);
  checkUnique(envelopes.map((item) => item.materialized.versionKey), "version_key", errors);
  checkUnique(envelopes.map((item) => `${item.materialized.identityKey}|${item.materialized.semanticHash}`), "identity+semantic_hash", errors);
  checkUnique(species.map((row) => row.observationId), "species observation_id", errors);
  checkUnique(species.map((row) => `${row.reportId}|${row.speciesId}`), "report_id+species_id", errors);
  if (sourceRuns.length !== monthPlans.length) errors.push("Source-run/month-plan count mismatch.");
  if (species.length !== envelopes.length * 8) errors.push("Species count is not report count * 8.");
  for (const item of envelopes) {
    const ids = new Set(item.materialized.species.map((row) => row.speciesId));
    if (item.materialized.species.length !== 8 || ids.size !== 8) errors.push(`${item.report.sourceRecordId} does not have 8 distinct species.`);
    if (item.report.observationDate < startDate || item.report.observationDate > endDate || item.report.observationDate >= "2026-08-20") errors.push(`${item.report.sourceRecordId} is out of range.`);
    if (item.report.providerId !== PROVIDER_ID || item.report.facilityId !== FACILITY_ID) errors.push(`${item.report.sourceRecordId} has wrong provider/facility.`);
    if (!/^https:\/\/ichihara-umizuri\.com\/fishing\/[1-9]\d*\/$/u.test(item.report.sourceUrl)) errors.push(`${item.report.sourceRecordId} has a non-official URL.`);
    if (item.report.publishedAt !== null) errors.push(`${item.report.sourceRecordId} invented publishedAt.`);
    const interrupted = item.classification === "INTERRUPTED";
    for (const row of item.report.species) {
      if (row.speciesId === "sardine" && row.sourceLabels.some((label) => label.includes("カタボシイワシ"))) errors.push(`${item.report.sourceRecordId} leaks kataboshi into sardine.`);
      if (row.presenceState === "absent" || row.catchCount === 0) {
        if (item.report.operatingStatus !== "operating" || item.report.reportCompleteness !== "complete" || interrupted || row.completeness !== "complete" || row.aliasCoverage !== "sufficient") {
          errors.push(`${item.report.sourceRecordId}/${row.speciesId} violates explicit-zero contract.`);
        }
      }
    }
  }
  if (acquisition.records.length !== envelopes.length) errors.push("Acquired detail/report count mismatch.");
  return {
    schemaVersion: `${ICHIHARA_BACKFILL_SCHEMA_VERSION}.logical-validation`,
    ok: errors.length === 0,
    errors,
    checks: {
      sourceRunsUnique: new Set(sourceRuns.map((run) => run.id)).size === sourceRuns.length,
      reportIdsUnique: new Set(envelopes.map((item) => item.materialized.reportId)).size === envelopes.length,
      versionKeysUnique: new Set(envelopes.map((item) => item.materialized.versionKey)).size === envelopes.length,
      speciesBundlesExact: species.length === envelopes.length * 8,
      explicitZeroValid: !errors.some((error) => error.includes("explicit-zero")),
      rangeValid: !errors.some((error) => error.includes("out of range")),
      kataboshiLeakAbsent: !errors.some((error) => error.includes("kataboshi"))
    }
  };
}

function buildMonthlySourceRun(month, items, schemaVersion) {
  const timestamps = items.map((item) => item.artifact.acquiredAt).sort();
  const artifacts = items.map((item) => ({
    url: item.artifact.url,
    sha256: item.artifact.sha256,
    observationDate: item.artifact.observationDate,
    numericId: item.artifact.numericId
  })).sort((left, right) => left.url.localeCompare(right.url));
  const rawHash = sha256(canonicalJson(artifacts));
  const requestedAt = timestamps[0];
  const completedAt = timestamps.at(-1);
  const idHash = sha256(canonicalJson([PROVIDER_ID, "historical-backfill", month, requestedAt, completedAt, rawHash]));
  return {
    id: `wanoku-fixed-node-ichihara-backfill:${month}:${idHash}`,
    provider: PROVIDER_ID,
    nodeId: null,
    requestedAt,
    completedAt,
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    modelVersion: MODEL_VERSION,
    rawHash,
    normalizedSchemaVersion: schemaVersion
  };
}

function summarizeDataset({ startDate, endDate, acquisition, sourceRuns, envelopes, unsupportedLabels }) {
  const dates = dateRange(startDate, endDate);
  const discoveredDates = new Set(envelopes.map((item) => item.report.observationDate));
  const explicitZeroBySpecies = {};
  for (const speciesId of ["japanese-seabass", "sardine", "sappa", "konoshiro", "aji", "saba", "bora", "haze"]) {
    explicitZeroBySpecies[speciesId] = envelopes.reduce((total, item) => total + Number(item.report.species.some((row) => row.speciesId === speciesId && row.catchCount === 0)), 0);
  }
  return {
    schemaVersion: `${ICHIHARA_BACKFILL_SCHEMA_VERSION}.summary`,
    startDate,
    endDate,
    calendarDays: dates.length,
    missingCalendarDates: dates.filter((date) => !discoveredDates.has(date)),
    firstObservationDate: envelopes[0]?.report.observationDate ?? null,
    lastObservationDate: envelopes.at(-1)?.report.observationDate ?? null,
    reportCount: envelopes.length,
    speciesCount: envelopes.length * 8,
    sourceRunCount: sourceRuns.length,
    reportCountByMonth: Object.fromEntries(sourceRuns.map((run) => [run.id.split(":")[1], envelopes.filter((item) => item.sourceMonth === run.id.split(":")[1]).length])),
    operatingCount: envelopes.filter((item) => item.report.operatingStatus === "operating").length,
    closedCount: envelopes.filter((item) => item.classification === "CLOSED").length,
    interruptedCount: envelopes.filter((item) => item.classification === "INTERRUPTED").length,
    incompleteCount: envelopes.filter((item) => item.report.reportCompleteness !== "complete").length,
    explicitZeroBySpecies,
    unsupportedLabelFrequencies: Object.fromEntries([...unsupportedLabels.entries()].sort(([left], [right]) => left.localeCompare(right))),
    archivePages: acquisition.archivePages,
    acquiredArtifactCount: Object.keys(acquisition.state.artifacts).length
  };
}

function writeGeneratedArtifacts(outputDir, generated) {
  atomicWriteJson(path.join(outputDir, "summary.json"), generated.summary);
  atomicWriteJson(path.join(outputDir, "logical-validation.json"), generated.validation);
  atomicWrite(path.join(outputDir, "canonical.ndjson"), Buffer.from(`${generated.envelopes.map((item) => JSON.stringify({
    sourceMonth: item.sourceMonth,
    classification: item.classification,
    sourceFacts: item.sourceFacts,
    report: item.report,
    reportId: item.materialized.reportId,
    versionKey: item.materialized.versionKey,
    semanticHash: item.materialized.semanticHash,
    speciesRows: item.materialized.species
  })).join("\n")}\n`, "utf8"));
  for (const month of generated.monthPlans) atomicWrite(path.join(outputDir, `import-${month.sourceMonth}.sql`), Buffer.from(month.sql, "utf8"));
}

function validateWithLocalD1(outputDir, generated) {
  const persistDir = path.join(outputDir, "local-d1-validation");
  rmSync(persistDir, { recursive: true, force: true });
  mkdirSync(persistDir, { recursive: true });
  const config = path.join(REPO_ROOT, "workers/wanoku-intel-worker/wrangler.toml");
  const wrangler = path.join(REPO_ROOT, "node_modules/wrangler/bin/wrangler.js");
  const run = (args) => {
    const result = spawnSync(process.execPath, [wrangler, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, WRANGLER_LOG_PATH: path.join(tmpdir(), "wanoku-wrangler-logs") },
      maxBuffer: 20 * 1024 * 1024
    });
    if (result.status !== 0) throw new IchiharaHistoricalBackfillError("local_d1_command_failed", `${result.stderr || result.stdout}`.trim().slice(0, 1000));
    return result.stdout;
  };
  run(["d1", "migrations", "apply", "wanoku-intel-db", "--local", "--config", config, "--persist-to", persistDir]);
  for (const file of generated.importFiles) run(["d1", "execute", "wanoku-intel-db", "--local", "--config", config, "--persist-to", persistDir, "--file", path.join(outputDir, file.file)]);
  for (const file of generated.importFiles) run(["d1", "execute", "wanoku-intel-db", "--local", "--config", config, "--persist-to", persistDir, "--file", path.join(outputDir, file.file)]);
  const scalar = (sql, key) => {
    const stdout = run(["d1", "execute", "wanoku-intel-db", "--local", "--config", config, "--persist-to", persistDir, "--command", sql, "--json"]);
    const payload = JSON.parse(stdout);
    return payload?.[0]?.results?.[0]?.[key] ?? null;
  };
  const checks = {
    facilityCount: scalar(`SELECT COUNT(*) AS value FROM fixed_coastal_facilities WHERE facility_id = '${FACILITY_ID}'`, "value"),
    sourceRunCount: scalar(`SELECT COUNT(*) AS value FROM source_runs WHERE provider = '${PROVIDER_ID}'`, "value"),
    reportCount: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}'`, "value"),
    speciesCount: scalar(`SELECT COUNT(*) AS value FROM fixed_node_species_observations WHERE facility_id = '${FACILITY_ID}'`, "value"),
    badBundles: scalar(`SELECT COUNT(*) AS value FROM (SELECT report_id FROM fixed_node_species_observations WHERE facility_id = '${FACILITY_ID}' GROUP BY report_id HAVING COUNT(*) != 8 OR COUNT(DISTINCT species_id) != 8)`, "value"),
    orphanSpecies: scalar(`SELECT COUNT(*) AS value FROM fixed_node_species_observations s LEFT JOIN fixed_node_daily_reports r ON r.report_id = s.report_id WHERE s.facility_id = '${FACILITY_ID}' AND r.report_id IS NULL`, "value"),
    foreignKeyViolations: scalar("SELECT COUNT(*) AS value FROM pragma_foreign_key_check", "value"),
    duplicateReportIds: scalar(`SELECT COUNT(*) AS value FROM (SELECT report_id FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' GROUP BY report_id HAVING COUNT(*) > 1)`, "value"),
    duplicateVersionKeys: scalar(`SELECT COUNT(*) AS value FROM (SELECT version_key FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' GROUP BY version_key HAVING COUNT(*) > 1)`, "value"),
    duplicateIdentitySemantic: scalar(`SELECT COUNT(*) AS value FROM (SELECT identity_key, semantic_hash FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' GROUP BY identity_key, semantic_hash HAVING COUNT(*) > 1)`, "value"),
    duplicateReportSpecies: scalar(`SELECT COUNT(*) AS value FROM (SELECT report_id, species_id FROM fixed_node_species_observations WHERE facility_id = '${FACILITY_ID}' GROUP BY report_id, species_id HAVING COUNT(*) > 1)`, "value"),
    outOfRangeReports: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' AND (observation_date < '${generated.summary.startDate}' OR observation_date > '${generated.summary.endDate}')`, "value"),
    canaryOverlap: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' AND observation_date >= '2026-08-20'`, "value"),
    wrongProviderFacility: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' AND provider_id != '${PROVIDER_ID}'`, "value"),
    nonOfficialUrls: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' AND source_url NOT GLOB 'https://ichihara-umizuri.com/fishing/[0-9]*/'`, "value"),
    kataboshiLeaks: scalar(`SELECT COUNT(*) AS value FROM fixed_node_species_observations WHERE facility_id = '${FACILITY_ID}' AND species_id = 'sardine' AND source_labels_json LIKE '%カタボシイワシ%'`, "value"),
    nonNullPublishedAt: scalar(`SELECT COUNT(*) AS value FROM fixed_node_daily_reports WHERE facility_id = '${FACILITY_ID}' AND published_at IS NOT NULL`, "value")
  };
  const errors = [];
  if (Number(checks.facilityCount) !== 1) errors.push("Ichihara facility seed missing.");
  if (Number(checks.sourceRunCount) !== generated.summary.sourceRunCount) errors.push("Source-run count mismatch.");
  if (Number(checks.reportCount) !== generated.summary.reportCount) errors.push("Report count mismatch.");
  if (Number(checks.speciesCount) !== generated.summary.speciesCount) errors.push("Species count mismatch.");
  for (const [key, value] of Object.entries(checks)) {
    if (!["facilityCount", "sourceRunCount", "reportCount", "speciesCount"].includes(key) && Number(value) !== 0) errors.push(`${key} must be zero, found ${value}.`);
  }
  return { ok: errors.length === 0, skipped: false, replayedImportFileCount: generated.importFiles.length, errors, checks };
}

function buildManifest({ generated, acquisition, localD1, clock }) {
  return {
    schemaVersion: ICHIHARA_BACKFILL_SCHEMA_VERSION,
    requestedRange: { startDate: generated.summary.startDate, endDate: generated.summary.endDate },
    generatedAt: canonicalClock(clock()),
    artifactCounts: {
      total: Object.keys(acquisition.state.artifacts).length,
      archive: Object.values(acquisition.state.artifacts).filter((item) => item.artifactType === "archive").length,
      detail: Object.values(acquisition.state.artifacts).filter((item) => item.artifactType === "detail").length,
      robots: Object.values(acquisition.state.artifacts).filter((item) => item.artifactType === "robots").length
    },
    acquisition: {
      ...acquisition.state.networkStats,
      skippedCachedArtifacts: acquisition.stats.skippedCachedArtifacts
    },
    reportCount: generated.summary.reportCount,
    speciesCount: generated.summary.speciesCount,
    sourceRunCount: generated.summary.sourceRunCount,
    monthFiles: generated.importFiles,
    normalizedDatasetSha256: generated.normalizedDatasetHash,
    rawArtifactAggregateSha256: generated.rawArtifactAggregateHash,
    validation: { logical: generated.validation, localD1 },
    unresolvedRecords: []
  };
}

function readAcquisitionState(indexPath, startDate, endDate) {
  if (!existsSync(indexPath)) return {
    schemaVersion: `${ICHIHARA_BACKFILL_SCHEMA_VERSION}.acquisition`,
    requestedRange: { startDate, endDate },
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    frozen: false,
    artifacts: {},
    networkStats: {
      successfulArchiveGets: 0,
      successfulDetailGets: 0,
      successfulRobotsGets: 0,
      retries: 0,
      failures: 0
    }
  };
  const state = JSON.parse(readFileSync(indexPath, "utf8"));
  if (state.schemaVersion !== `${ICHIHARA_BACKFILL_SCHEMA_VERSION}.acquisition`) throw new IchiharaHistoricalBackfillError("acquisition_schema_mismatch", "Acquisition state schema mismatch.");
  if (state.requestedRange?.startDate !== startDate || state.requestedRange?.endDate !== endDate) throw new IchiharaHistoricalBackfillError("acquisition_range_mismatch", "Acquisition range differs from cached state.");
  if (!state.networkStats) {
    const artifacts = Object.values(state.artifacts);
    state.networkStats = {
      successfulArchiveGets: artifacts.filter((item) => item.artifactType === "archive").length,
      successfulDetailGets: artifacts.filter((item) => item.artifactType === "detail").length,
      successfulRobotsGets: artifacts.filter((item) => item.artifactType === "robots").length,
      retries: 0,
      failures: 0
    };
  }
  state.createdAt ??= Object.values(state.artifacts).map((item) => item.acquiredAt).sort()[0] ?? null;
  return state;
}

function registerArchiveRecord(record, recordsById, idByDate) {
  if (!/^fishing:[1-9]\d*$/u.test(record.sourceRecordId) || !/^[1-9]\d*$/u.test(record.numericId)) throw new IchiharaHistoricalBackfillError("malformed_archive_identity", "Archive identity is malformed.");
  const existing = recordsById.get(record.sourceRecordId);
  if (existing && existing.observationDate !== record.observationDate) throw new IchiharaHistoricalBackfillError("duplicate_id_conflict", `${record.sourceRecordId} has conflicting dates.`);
  const dateId = idByDate.get(record.observationDate);
  if (dateId && dateId !== record.sourceRecordId) throw new IchiharaHistoricalBackfillError("duplicate_date_conflict", `${record.observationDate} has conflicting IDs.`);
  recordsById.set(record.sourceRecordId, record);
  idByDate.set(record.observationDate, record.sourceRecordId);
}

function archivePageUrl(page) {
  if (!Number.isInteger(page) || page < 1) throw new IchiharaHistoricalBackfillError("invalid_archive_page", "Archive page must be positive.");
  return page === 1 ? ARCHIVE_URL : `${ARCHIVE_URL}page/${page}/`;
}

function assertRobotsAllowsFishing(value) {
  const lines = String(value).split(/\r?\n/u).map((line) => line.replace(/#.*$/u, "").trim()).filter(Boolean);
  let applies = false;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const content = line.slice(separator + 1).trim();
    if (field === "user-agent") applies = content === "*";
    if (applies && field === "disallow" && (content === "/" || content === "/fishing" || content.startsWith("/fishing/"))) {
      throw new IchiharaHistoricalBackfillError("robots_blocked", `robots.txt disallows ${content}.`);
    }
  }
}

function rawArtifactAggregateHash(state) {
  return sha256(canonicalJson(Object.values(state.artifacts).map((item) => ({ url: item.url, sha256: item.sha256, artifactType: item.artifactType })).sort((left, right) => left.url.localeCompare(right.url))));
}

function normalizedHash(sourceRuns, envelopes) {
  return sha256(canonicalJson({
    sourceRuns,
    reports: envelopes.map((item) => ({ materialized: item.materialized, classification: item.classification }))
  }));
}

function sourceRunParams(run) {
  return [run.id, run.provider, run.nodeId, run.requestedAt, run.completedAt, run.status, run.httpStatus, run.errorCode, run.modelVersion, run.rawHash, run.normalizedSchemaVersion];
}

function reportParams(row) {
  return [row.reportId, row.versionKey, row.identityKey, row.semanticHash, row.facilityId, row.providerId, row.observationDate, row.sourceRecordId, row.sourceRunId, row.publishedAt, row.collectedAt, row.storedAt, row.visitorCount, row.operatingStatus, row.reportCompleteness, row.normalizedSchemaVersion, row.sourceUrl, row.payloadJson];
}

function speciesParams(row) {
  return [row.observationId, row.reportId, row.facilityId, row.observationDate, row.speciesId, row.sourceLabelsJson, row.catchCount, row.presenceState, row.minSizeCm, row.maxSizeCm, row.areaLabelsJson, row.completeness, row.aliasCoverage];
}

function insertStatement(table, columns, values) {
  const literals = values.map(sqlLiteral);
  const exactRow = columns.map((column, index) => `${column} IS ${literals[index]}`).join(" AND ");
  return `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${literals.join(", ")} WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${exactRow});`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IchiharaHistoricalBackfillError("invalid_sql_value", "SQL number must be finite.");
    return String(value);
  }
  if (typeof value !== "string") throw new IchiharaHistoricalBackfillError("invalid_sql_value", "SQL value must be scalar.");
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertSafeSql(sql) {
  if (/\b(?:UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|BEGIN|COMMIT|SAVEPOINT)\b/iu.test(sql) || /INSERT\s+OR\s+(?:IGNORE|REPLACE)/iu.test(sql)) {
    throw new IchiharaHistoricalBackfillError("unsafe_sql", "Generated SQL contains a forbidden statement.");
  }
}

function checkUnique(values, label, errors) {
  if (new Set(values).size !== values.length) errors.push(`Duplicate ${label}.`);
}

function dateRange(startDate, endDate) {
  const dates = [];
  for (let cursor = Date.parse(`${startDate}T00:00:00.000Z`); cursor <= Date.parse(`${endDate}T00:00:00.000Z`); cursor += 86_400_000) dates.push(new Date(cursor).toISOString().slice(0, 10));
  return dates;
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function atomicWrite(filePath, bytes) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, filePath);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new IchiharaHistoricalBackfillError("invalid_clock", "Clock returned an invalid value.");
  return date.toISOString();
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) throw new IchiharaHistoricalBackfillError("invalid_date", `${label} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new IchiharaHistoricalBackfillError("invalid_date", `${label} is invalid.`);
  return value;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(value)) throw new IchiharaHistoricalBackfillError("invalid_cli", `${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new IchiharaHistoricalBackfillError("invalid_cli", `${label} must be ${minimum}..${maximum}.`);
  return number;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function loadWanokuModules() {
  if (loadedModules) return loadedModules;
  const requireFn = createRequire(import.meta.url);
  registerTypeScriptRequireHook(requireFn);
  registerWorkerJavaScriptRequireHook(requireFn);
  const core = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/fixed-node-observation.ts"));
  const collector = requireFn(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/ichihara-fixed-node-collector.js"));
  const persistence = requireFn(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/fixed-node-observation-persistence.js"));
  loadedModules = { ...core, ...collector, ...persistence };
  return loadedModules;
}

function registerTypeScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".ts"]?.__wanokuIchiharaBackfill) return;
  const ts = requireFn("typescript");
  const hook = function compileTypeScript(module, filename) {
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText;
    module._compile(output, filename);
  };
  hook.__wanokuIchiharaBackfill = true;
  Module._extensions[".ts"] = hook;
}

function registerWorkerJavaScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".js"]?.__wanokuIchiharaBackfill) return;
  const ts = requireFn("typescript");
  const previous = Module._extensions[".js"];
  const workerRoot = path.join(REPO_ROOT, "workers", "wanoku-intel-worker", "src") + path.sep;
  const hook = function compileWorkerJavaScript(module, filename) {
    if (!filename.startsWith(workerRoot)) return previous(module, filename);
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText;
    module._compile(output, filename);
  };
  hook.__wanokuIchiharaBackfill = true;
  Module._extensions[".js"] = hook;
}

function printHelp() {
  console.log("Usage: node scripts/wanoku-ichihara-fixed-node-backfill.mjs [--output-dir .tmp/wanoku-ichihara-backfill-live] [--delay-ms 400] [--offline]");
}

async function main() {
  const options = parseIchiharaBackfillArgs();
  if (options.help) return printHelp();
  const result = await runIchiharaHistoricalBackfill(options);
  console.log(JSON.stringify({ ...result.summary, normalizedDatasetSha256: result.normalizedDatasetHash, rawArtifactAggregateSha256: result.rawArtifactAggregateHash, outputDir: result.outputDir }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.code ?? "backfill_failed", message: error?.message ?? "Backfill failed." }));
    process.exitCode = 1;
  });
}
