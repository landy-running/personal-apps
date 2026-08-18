#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  YOKOHAMA_FIXED_NODE_PROVIDER_ID,
  YOKOHAMA_FIXED_NODE_ROOT_URL,
  buildYokohamaGraphqlGetUrl,
  buildYokohamaMonthlyQuery,
  extractYokohamaBundleUrl,
  extractYokohamaReadConfig,
  parseYokohamaLastPost
} from "../workers/wanoku-intel-worker/src/yokohama-fixed-node-source.js";

export const YOKOHAMA_BACKFILL_SCHEMA_VERSION = "wanoku-yokohama-historical-backfill-plan.v1";
export const YOKOHAMA_BACKFILL_START_DATE = "2025-09-01";
export const YOKOHAMA_BACKFILL_END_DATE = "2026-08-16";
export const YOKOHAMA_BACKFILL_CANARY_DATE = "2026-08-16";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_VERSION = "wanoku-yokohama-historical-backfill-v1";
const MAX_DELAY_MS = 10_000;
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
const AUDIT_REFERENCE = Object.freeze({
  "yokohama-honmoku": 342,
  "yokohama-daikoku": 342,
  "yokohama-isogo": 346
});
const BAIT_SPECIES = ["sardine", "sappa", "konoshiro", "aji", "saba", "bora", "haze"];
const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
let loadedModules = null;

export class YokohamaHistoricalBackfillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "YokohamaHistoricalBackfillError";
    this.code = code;
  }
}

export function parseYokohamaBackfillArgs(argv = process.argv.slice(2)) {
  const options = { delayMs: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new YokohamaHistoricalBackfillError("invalid_cli", `Missing value for ${arg}.`);
      index += 1;
      return next;
    };
    if (arg === "--output-dir") options.outputDir = value();
    else if (arg === "--delay-ms") options.delayMs = parseInteger(value(), "delay-ms", 0, MAX_DELAY_MS);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new YokohamaHistoricalBackfillError("invalid_cli", `Unknown option: ${arg}`);
  }
  return options;
}

export function yokohamaBackfillDates(startDate = YOKOHAMA_BACKFILL_START_DATE, endDate = YOKOHAMA_BACKFILL_END_DATE) {
  const start = requireIsoDate(startDate, "startDate");
  const end = requireIsoDate(endDate, "endDate");
  if (start > end) throw new YokohamaHistoricalBackfillError("invalid_range", "startDate must be <= endDate.");
  const dates = [];
  for (let cursor = Date.parse(`${start}T00:00:00.000Z`); cursor <= Date.parse(`${end}T00:00:00.000Z`); cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export async function runYokohamaHistoricalBackfill(input = {}) {
  if (!input.outputDir) throw new YokohamaHistoricalBackfillError("invalid_output", "outputDir is required.");
  const outputDir = path.resolve(input.outputDir);
  const generated = await generateYokohamaHistoricalBackfillPlan(input);
  writeArtifacts(outputDir, generated);
  return { ...generated, outputDir };
}

export async function generateYokohamaHistoricalBackfillPlan(input = {}) {
  const modules = loadWanokuModules();
  const dates = yokohamaBackfillDates(input.startDate, input.endDate);
  const startDate = dates[0];
  const endDate = dates.at(-1);
  const months = unique(dates.map((date) => date.slice(0, 7)));
  const facilities = modules.FIXED_COASTAL_FACILITIES
    .filter((facility) => facility.providerId === YOKOHAMA_FIXED_NODE_PROVIDER_ID)
    .map((facility) => ({ ...facility }));
  if (facilities.length !== 3) throw new YokohamaHistoricalBackfillError("facility_registry_mismatch", "Exactly three Yokohama facilities are required.");

  const acquisition = await acquireMonthlySource({
    months,
    facilities,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    delayMs: input.delayMs ?? 0,
    clock: input.clock ?? (() => new Date()),
    collectedAtByMonth: input.collectedAtByMonth
  });
  const dateSet = new Set(dates);
  const envelopes = [];
  const classifications = [];
  const sourceRuns = [];
  const monthPlans = [];

  for (const month of months) {
    const monthly = acquisition.months.get(month);
    const sourceRun = buildMonthlySourceRun(monthly, modules.FIXED_NODE_OBSERVATION_SCHEMA_VERSION);
    sourceRuns.push(sourceRun);
    const monthEnvelopes = [];
    for (const facility of facilities) {
      const facilityDates = dates.filter((date) => date.startsWith(`${month}-`));
      const sourceResult = monthly.facilities.get(facility.facilityId);
      const recordsByDate = new Map();
      const errorsByDate = new Map();
      let wholeMonthError = null;
      if (!sourceResult.ok) {
        wholeMonthError = sourceResult.error;
      } else {
        for (const sourceItem of sourceResult.items) {
          let candidateDate = slashDateCandidate(sourceItem?.date);
          try {
            const parsed = parseYokohamaLastPost(sourceItem, {
              facility,
              facilityId: facility.facilityId,
              collectedAt: monthly.collectedAt,
              strictSchema: true
            });
            candidateDate = parsed.observationDate;
            if (sourceItem.month !== month.replace("-", "/")) {
              throw new YokohamaHistoricalBackfillError("source_month_mismatch", "Source month does not match observation date partition.");
            }
            if (!dateSet.has(parsed.observationDate)) continue;
            if (recordsByDate.has(parsed.observationDate)) {
              errorsByDate.set(parsed.observationDate, "duplicate_source_record");
              recordsByDate.delete(parsed.observationDate);
              continue;
            }
            if (!errorsByDate.has(parsed.observationDate)) recordsByDate.set(parsed.observationDate, parsed);
          } catch (error) {
            if (candidateDate && dateSet.has(candidateDate)) errorsByDate.set(candidateDate, error?.code ?? "unexpected_schema");
            else wholeMonthError = error?.code ?? "unexpected_schema";
          }
        }
      }
      for (const observationDate of facilityDates) {
        const parsed = recordsByDate.get(observationDate);
        const schemaError = wholeMonthError ?? errorsByDate.get(observationDate);
        if (schemaError) {
          classifications.push(classification(facility, observationDate, "SCHEMA_ERROR", schemaError));
          continue;
        }
        if (!parsed) {
          classifications.push(classification(facility, observationDate, "MISSING_SOURCE_RECORD", "source_record_absent"));
          continue;
        }
        const category = parsed.operatingStatus === "closed"
          ? "CLOSED"
          : parsed.operatingStatus === "operating" && parsed.reportComplete
            ? "REPORT_COMPLETE"
            : "REPORT_INCOMPLETE";
        classifications.push(classification(facility, observationDate, category, null));
        const report = modules.buildYokohamaFixedNodeReport(parsed, sourceRun.id);
        const materialized = await modules.materializeFixedNodeDailyReport(report, monthly.collectedAt);
        const envelope = {
          sourceMonth: month,
          classification: category,
          sourceFacts: {
            weather: parsed.weather,
            waterTemperatureC: parsed.waterTemperatureC,
            tideLabel: parsed.tideLabel,
            modifiedAt: parsed.modifiedAt,
            diagnostics: parsed.diagnostics
          },
          report,
          materialized
        };
        envelopes.push(envelope);
        monthEnvelopes.push(envelope);
      }
    }
    monthPlans.push(buildMonthImportPlan(month, sourceRun, monthEnvelopes));
  }

  assertUnique(envelopes.map((item) => item.materialized.identityKey), "report identity");
  assertUnique(envelopes.map((item) => item.materialized.versionKey), "report version");
  assertUnique(envelopes.flatMap((item) => item.materialized.species.map((row) => row.observationId)), "species observation");
  const facilitySummary = facilities.map((facility) => summarizeFacility(facility, classifications, envelopes));
  const canary = await validateCanaryEquivalence(envelopes, modules);
  const reportsToCreate = monthPlans.reduce((total, month) => total + month.reportsToCreate, 0);
  const speciesToCreate = monthPlans.reduce((total, month) => total + month.speciesToCreate, 0);
  const logicalRows = sourceRuns.length + reportsToCreate + speciesToCreate;
  const estimatedIndexEntries = sourceRuns.length * 5 + reportsToCreate * 7 + speciesToCreate * 5;
  const maxStatementBytes = Math.max(...monthPlans.flatMap((month) => month.statements.map((statement) => Buffer.byteLength(statement))));
  const validation = buildValidation({ dates, months, classifications, envelopes, facilitySummary, canary, acquisition });
  if (!validation.ok) throw new YokohamaHistoricalBackfillError("validation_failed", validation.errors.join(" "));

  const summary = {
    schemaVersion: YOKOHAMA_BACKFILL_SCHEMA_VERSION,
    startDate,
    endDate,
    calendarDays: dates.length,
    facilities: facilities.length,
    facilityDays: classifications.length,
    sourceReads: acquisition.remoteReads,
    canonicalReports: envelopes.length,
    canonicalSpecies: envelopes.length * 8,
    existingOverlapReports: canary.reportCount,
    existingOverlapSpecies: canary.speciesCount,
    reportsToCreate,
    speciesToCreate,
    sourceRuns: sourceRuns.length,
    logicalRowsToWrite: logicalRows,
    estimatedPhysicalBtreeEntries: estimatedIndexEntries,
    maxSqlStatementBytes: maxStatementBytes,
    semanticRevisionsExpected: canary.equivalent ? 0 : canary.reportCount,
    collectedAtPolicy: "actual-monthly-acquisition-time",
    facilitySummary
  };
  const importPlan = {
    schemaVersion: `${YOKOHAMA_BACKFILL_SCHEMA_VERSION}.import`,
    method: "month-chunked-wrangler-d1-execute-file",
    database: "wanoku-intel-db",
    config: "workers/wanoku-intel-worker/wrangler.toml",
    precondition: "Verify production 2026-08-16 canary IDs before applying; generated canary rows are excluded.",
    collisionPolicy: "Plain INSERT constraints fail on unexpected overlap; no UPDATE, REPLACE, DELETE, or OR IGNORE.",
    runbook: [
      "The production import unit is one monthly SQL file (sql/<month>.sql); apply one month at a time.",
      "Execute each file with: npx wrangler d1 execute wanoku-intel-db --remote --config workers/wanoku-intel-worker/wrangler.toml --file <output>/sql/<month>.sql",
      "After a file completes successfully, validate that month's expected reportsToCreate/speciesToCreate counts before starting the next month's file.",
      "If a file execution fails to complete, stop and inspect the wrangler command result before taking any further action. Cloudflare's documented remote d1 execute --file behavior returns the database to its original state on a failed execution, so the same file can be safely retried.",
      "Do not advance to the next month's file until the current month has been verified."
    ],
    chunks: monthPlans.map((month) => ({
      sourceMonth: month.sourceMonth,
      file: `sql/${month.sourceMonth}.sql`,
      reportsToCreate: month.reportsToCreate,
      speciesToCreate: month.speciesToCreate,
      statementCount: month.statements.length,
      byteLength: Buffer.byteLength(month.sql),
      maxStatementBytes: Math.max(...month.statements.map((statement) => Buffer.byteLength(statement))),
      command: `npx wrangler d1 execute wanoku-intel-db --remote --config workers/wanoku-intel-worker/wrangler.toml --file <output>/sql/${month.sourceMonth}.sql`
    }))
  };
  return { summary, validation, importPlan, classifications, envelopes, sourceRuns, monthPlans, acquisition };
}

async function acquireMonthlySource({ months, facilities, fetchImpl, delayMs, clock, collectedAtByMonth }) {
  if (typeof fetchImpl !== "function") throw new YokohamaHistoricalBackfillError("fetch_unavailable", "fetch is unavailable.");
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new YokohamaHistoricalBackfillError("invalid_delay", "delayMs is invalid.");
  let remoteReads = 0;
  const getText = async (url, headers = {}) => {
    if (remoteReads > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    remoteReads += 1;
    const response = await fetchImpl(url, { method: "GET", headers });
    if (!response?.ok) throw new YokohamaHistoricalBackfillError("http_error", `Official source GET failed with HTTP ${response?.status ?? "unknown"}.`);
    return response.text();
  };
  const rootHtml = await getText(YOKOHAMA_FIXED_NODE_ROOT_URL);
  const bundleUrl = extractYokohamaBundleUrl(rootHtml);
  const bundleJs = await getText(bundleUrl);
  const config = extractYokohamaReadConfig(rootHtml, bundleJs);
  const query = buildYokohamaMonthlyQuery();
  const result = new Map();
  for (const month of months) {
    const collectedAt = requireCanonicalUtcIso(collectedAtByMonth?.[month] ?? clock().toISOString(), `collectedAt(${month})`);
    const facilityResults = new Map();
    const artifacts = [];
    for (const facility of facilities) {
      try {
        const variables = { month: month.replace("-", "/"), facility: { eq: facility.providerFacilityKey }, limit: 100 };
        const url = buildYokohamaGraphqlGetUrl(config.endpoint, query, variables);
        const text = await getText(url, { accept: "application/json", "x-api-key": config.apiKey });
        artifacts.push(text);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new YokohamaHistoricalBackfillError("parse_error", "Official source response is not JSON.");
        }
        const connection = payload?.data?.lastPostsByMonthAndFacility;
        if (payload?.errors?.length || !connection || !Array.isArray(connection.items) || connection.nextToken) {
          throw new YokohamaHistoricalBackfillError("unexpected_schema", "Official monthly response shape is invalid.");
        }
        if (connection.items.some((item) => item?.facility !== facility.providerFacilityKey)) {
          throw new YokohamaHistoricalBackfillError("source_mismatch", "Official monthly response contains another facility.");
        }
        facilityResults.set(facility.facilityId, { ok: true, items: connection.items });
      } catch (error) {
        facilityResults.set(facility.facilityId, { ok: false, error: error?.code ?? "source_error" });
      }
    }
    result.set(month, { sourceMonth: month, collectedAt, facilities: facilityResults, artifacts });
  }
  return { months: result, remoteReads, expectedRemoteReads: 2 + months.length * facilities.length };
}

function buildMonthlySourceRun(monthly, schemaVersion) {
  const failures = [...monthly.facilities.values()].filter((item) => !item.ok).map((item) => item.error);
  const status = failures.length === 0 ? "ok" : failures.length < monthly.facilities.size ? "partial" : "failed";
  const errorCode = failures.length === 0 ? null : unique(failures).sort().join(",");
  const rawHash = sha256(JSON.stringify(monthly.artifacts));
  const idHash = sha256(JSON.stringify([YOKOHAMA_FIXED_NODE_PROVIDER_ID, "historical-backfill", monthly.sourceMonth, monthly.collectedAt, rawHash, status, errorCode]));
  return {
    id: `wanoku-fixed-node-yokohama-backfill:${monthly.sourceMonth}:${idHash}`,
    provider: YOKOHAMA_FIXED_NODE_PROVIDER_ID,
    nodeId: null,
    requestedAt: monthly.collectedAt,
    completedAt: monthly.collectedAt,
    status,
    httpStatus: null,
    errorCode,
    modelVersion: MODEL_VERSION,
    rawHash,
    normalizedSchemaVersion: schemaVersion
  };
}

export function buildMonthImportPlan(sourceMonth, sourceRun, envelopes) {
  const candidates = envelopes.filter((item) => item.report.observationDate !== YOKOHAMA_BACKFILL_CANARY_DATE);
  const statements = [insertStatement("source_runs", SOURCE_RUN_COLUMNS, sourceRunParams(sourceRun))];
  for (const envelope of candidates) {
    statements.push(insertStatement("fixed_node_daily_reports", REPORT_COLUMNS, reportParams(envelope.materialized)));
    for (const species of envelope.materialized.species) {
      statements.push(insertStatement("fixed_node_species_observations", SPECIES_COLUMNS, speciesParams(species)));
    }
  }
  const sql = `${statements.join("\n\n")}\n`;
  assertSafeSql(sql);
  return {
    sourceMonth,
    sourceRunId: sourceRun.id,
    reportsToCreate: candidates.length,
    speciesToCreate: candidates.length * 8,
    statements,
    sql
  };
}

function summarizeFacility(facility, classifications, envelopes) {
  const entries = classifications.filter((item) => item.facilityId === facility.facilityId);
  const reports = envelopes.filter((item) => item.report.facilityId === facility.facilityId);
  const complete = reports.filter((item) => item.classification === "REPORT_COMPLETE");
  const seabass = complete.map((item) => item.report.species.find((row) => row.speciesId === "japanese-seabass"));
  const bait = Object.fromEntries(BAIT_SPECIES.map((speciesId) => {
    const rows = complete.map((item) => item.report.species.find((row) => row.speciesId === speciesId));
    return [speciesId, {
      positiveDays: rows.filter((row) => row?.catchCount > 0).length,
      explicitZeroDays: rows.filter((row) => row?.catchCount === 0).length,
      totalCatch: rows.reduce((total, row) => total + (row?.catchCount ?? 0), 0)
    }];
  }));
  return {
    facilityId: facility.facilityId,
    calendarDays: entries.length,
    recordsFound: reports.length,
    completeOperatingDays: entries.filter((item) => item.status === "REPORT_COMPLETE").length,
    closedDays: entries.filter((item) => item.status === "CLOSED").length,
    incompleteDays: entries.filter((item) => item.status === "REPORT_INCOMPLETE").length,
    missingDays: entries.filter((item) => item.status === "MISSING_SOURCE_RECORD").length,
    schemaErrors: entries.filter((item) => item.status === "SCHEMA_ERROR").length,
    visitorKnownDays: reports.filter((item) => item.report.visitorCount !== null).length,
    seabass: {
      positiveDays: seabass.filter((row) => row?.catchCount > 0).length,
      explicitZeroDays: seabass.filter((row) => row?.catchCount === 0).length,
      totalCatch: seabass.reduce((total, row) => total + (row?.catchCount ?? 0), 0)
    },
    bait,
    auditReferenceRecordsFound: AUDIT_REFERENCE[facility.facilityId],
    auditDelta: reports.length - AUDIT_REFERENCE[facility.facilityId]
  };
}

async function validateCanaryEquivalence(envelopes, modules) {
  const canary = envelopes.filter((item) => item.report.observationDate === YOKOHAMA_BACKFILL_CANARY_DATE);
  let equivalent = canary.length === 3;
  for (const item of canary) {
    const retryInput = { ...item.report, sourceRunId: "known-canary-local-equivalence", collectedAt: "2026-08-17T12:00:00.000Z" };
    delete retryInput.facilitySourceIdentity;
    delete retryInput.reportIdentity;
    const rebuilt = modules.buildFixedNodeDailyReport(retryInput);
    if (!rebuilt.valid || !rebuilt.report) equivalent = false;
    else {
      const materialized = await modules.materializeFixedNodeDailyReport(rebuilt.report, "2026-08-17T12:00:00.000Z");
      if (materialized.reportId !== item.materialized.reportId || materialized.versionKey !== item.materialized.versionKey) equivalent = false;
    }
  }
  return { equivalent, reportCount: canary.length, speciesCount: canary.length * 8 };
}

function buildValidation({ dates, months, classifications, envelopes, facilitySummary, canary, acquisition }) {
  const errors = [];
  if (dates.length !== 350) errors.push(`Expected 350 dates, found ${dates.length}.`);
  if (months.length !== 12) errors.push(`Expected 12 months, found ${months.length}.`);
  if (classifications.length !== dates.length * 3) errors.push("Facility/date classification is incomplete.");
  if (acquisition.remoteReads !== acquisition.expectedRemoteReads) errors.push("Monthly source GET count is not deduplicated.");
  for (const facility of facilitySummary) {
    if (facility.auditDelta !== 0) errors.push(`${facility.facilityId} continuity differs from Audit by ${facility.auditDelta}.`);
    if (facility.schemaErrors !== 0) errors.push(`${facility.facilityId} has ${facility.schemaErrors} schema errors.`);
  }
  for (const item of envelopes) {
    if (item.report.collectedAt === item.report.publishedAt || item.report.collectedAt.startsWith(item.report.observationDate)) {
      errors.push(`Synthetic historical collectedAt detected: ${item.report.reportIdentity}.`);
      break;
    }
  }
  if (!canary.equivalent || canary.reportCount !== 3) errors.push("2026-08-16 canary semantic equivalence failed.");
  return {
    schemaVersion: `${YOKOHAMA_BACKFILL_SCHEMA_VERSION}.validation`,
    ok: errors.length === 0,
    errors,
    checks: {
      exactDateRange: dates.length === 350,
      monthlyGetDeduplication: acquisition.remoteReads === acquisition.expectedRemoteReads,
      auditContinuityMatched: facilitySummary.every((item) => item.auditDelta === 0),
      schemaErrorsAbsent: facilitySummary.every((item) => item.schemaErrors === 0),
      canarySemanticEquivalent: canary.equivalent
    }
  };
}

function writeArtifacts(outputDir, generated) {
  mkdirSync(path.join(outputDir, "sql"), { recursive: true });
  writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(generated.summary, null, 2)}\n`, "utf8");
  writeFileSync(path.join(outputDir, "canonical.ndjson"), `${generated.envelopes.map((item) => JSON.stringify({
    sourceMonth: item.sourceMonth,
    classification: item.classification,
    sourceFacts: item.sourceFacts,
    report: item.report,
    reportId: item.materialized.reportId,
    versionKey: item.materialized.versionKey,
    semanticHash: item.materialized.semanticHash,
    speciesRows: item.materialized.species
  })).join("\n")}\n`, "utf8");
  writeFileSync(path.join(outputDir, "import-plan.json"), `${JSON.stringify(generated.importPlan, null, 2)}\n`, "utf8");
  writeFileSync(path.join(outputDir, "validation.json"), `${JSON.stringify(generated.validation, null, 2)}\n`, "utf8");
  for (const month of generated.monthPlans) writeFileSync(path.join(outputDir, "sql", `${month.sourceMonth}.sql`), month.sql, "utf8");
}

function classification(facility, observationDate, status, reason) {
  return { facilityId: facility.facilityId, observationDate, status, reason };
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
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")});`;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new YokohamaHistoricalBackfillError("invalid_sql_value", "SQL number must be finite.");
    return String(value);
  }
  if (typeof value !== "string") throw new YokohamaHistoricalBackfillError("invalid_sql_value", "SQL value must be scalar.");
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertSafeSql(sql) {
  if (/\b(?:UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|BEGIN|COMMIT|SAVEPOINT)\b/iu.test(sql) || /INSERT\s+OR\s+(?:IGNORE|REPLACE)/iu.test(sql)) {
    throw new YokohamaHistoricalBackfillError("unsafe_sql", "Generated SQL contains a forbidden statement.");
  }
}

function slashDateCandidate(value) {
  const match = /^(20\d{2})\/(\d{2})\/(\d{2})$/u.exec(String(value ?? ""));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new YokohamaHistoricalBackfillError("duplicate_identity", `Duplicate ${label} generated.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values) {
  return [...new Set(values)].sort();
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(value)) throw new YokohamaHistoricalBackfillError("invalid_cli", `${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new YokohamaHistoricalBackfillError("invalid_cli", `${label} must be ${minimum}..${maximum}.`);
  return number;
}

function requireIsoDate(value, label) {
  const candidate = value ?? (label === "startDate" ? YOKOHAMA_BACKFILL_START_DATE : YOKOHAMA_BACKFILL_END_DATE);
  if (typeof candidate !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(candidate)) throw new YokohamaHistoricalBackfillError("invalid_date", `${label} must be YYYY-MM-DD.`);
  const date = new Date(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== candidate) throw new YokohamaHistoricalBackfillError("invalid_date", `${label} is invalid.`);
  return candidate;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO.test(value)) throw new YokohamaHistoricalBackfillError("invalid_timestamp", `${label} must be canonical UTC ISO.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new YokohamaHistoricalBackfillError("invalid_timestamp", `${label} is invalid.`);
  return value;
}

function loadWanokuModules() {
  if (loadedModules) return loadedModules;
  const requireFn = createRequire(import.meta.url);
  registerTypeScriptRequireHook(requireFn);
  registerWorkerJavaScriptRequireHook(requireFn);
  const core = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/fixed-node-observation.ts"));
  const collector = requireFn(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/yokohama-fixed-node-collector.js"));
  const persistence = requireFn(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/fixed-node-observation-persistence.js"));
  loadedModules = { ...core, ...collector, ...persistence };
  return loadedModules;
}

function registerTypeScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".ts"]?.__wanokuYokohamaBackfill) return;
  const ts = requireFn("typescript");
  const hook = function compileTypeScript(module, filename) {
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText;
    module._compile(output, filename);
  };
  hook.__wanokuYokohamaBackfill = true;
  Module._extensions[".ts"] = hook;
}

function registerWorkerJavaScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".js"]?.__wanokuYokohamaBackfill) return;
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
  hook.__wanokuYokohamaBackfill = true;
  Module._extensions[".js"] = hook;
}

function printHelp() {
  console.log("Usage: node scripts/wanoku-yokohama-historical-backfill.mjs --output-dir <path> [--delay-ms 100]");
}

async function main() {
  const options = parseYokohamaBackfillArgs();
  if (options.help) return printHelp();
  const result = await runYokohamaHistoricalBackfill(options);
  console.log(JSON.stringify({ ...result.summary, outputDir: result.outputDir }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.code ?? "backfill_failed", message: error?.message ?? "Backfill failed." }));
    process.exitCode = 1;
  });
}
