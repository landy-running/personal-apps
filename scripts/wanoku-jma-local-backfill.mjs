#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_BASE_URL = "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/";
const SUPPORTED_STATIONS = ["KZ", "QS", "TT"];
const SUPPORTED_SOURCE_YEARS = [2026];
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOWERCASE_SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_SQL_STATEMENT_BYTES = 90_000;
const TEXT_ENCODER = new TextEncoder();

const SOURCE_RUN_TABLE = "hydro_coastal_source_runs";
const OBSERVATION_TABLE = "hydro_coastal_observations";
const SOURCE_RUN_COLUMNS = [
  "id",
  "provider_id",
  "requested_at",
  "completed_at",
  "status",
  "http_status",
  "error_code",
  "raw_hash",
  "source_name",
  "source_url",
  "parser_id",
  "parser_version",
  "source_format_version",
  "normalized_schema_version",
  "run_json"
];
const OBSERVATION_COLUMNS = [
  "version_key",
  "identity_key",
  "source_run_id",
  "provider_id",
  "station_id",
  "metric",
  "observed_at",
  "collected_at",
  "forecast_issued_at",
  "value",
  "unit",
  "status",
  "provisional",
  "vertical_datum_json",
  "normalized_schema_version",
  "normalized_json"
];

let loadedModules = null;

export class WanokuJmaLocalBackfillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WanokuJmaLocalBackfillError";
    this.code = code;
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new WanokuJmaLocalBackfillError("invalid_cli", `Missing value for ${arg}`);
      index += 1;
      return value;
    };

    if (arg === "--station") {
      options.station = readValue();
    } else if (arg === "--source-year") {
      options.sourceYear = parseIntegerOption(readValue(), "source-year");
    } else if (arg === "--months") {
      options.months = parseMonthsSpec(readValue());
    } else if (arg === "--acquisition-at") {
      options.acquisitionAt = readValue();
    } else if (arg === "--expected-raw-hash") {
      options.expectedRawHash = readValue();
    } else if (arg === "--output") {
      options.output = readValue();
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new WanokuJmaLocalBackfillError("invalid_cli", `Unknown option: ${arg}`);
    }
  }
  return options;
}

export function parseMonthsSpec(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WanokuJmaLocalBackfillError("invalid_months", "months must be specified explicitly.");
  }

  const seen = new Set();
  const months = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (part === "") throw new WanokuJmaLocalBackfillError("invalid_months", "months must not contain empty entries.");
    const range = part.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) {
      const start = parseMonth(range[1]);
      const end = parseMonth(range[2]);
      if (start > end) throw new WanokuJmaLocalBackfillError("invalid_months", `invalid month range: ${part}`);
      for (let month = start; month <= end; month += 1) appendUniqueMonth(month, seen, months);
      continue;
    }
    appendUniqueMonth(parseMonth(part), seen, months);
  }
  if (months.length === 0) throw new WanokuJmaLocalBackfillError("invalid_months", "months must contain at least one month.");
  return months.sort((left, right) => left - right);
}

export async function runLocalBackfill(input = {}) {
  const config = normalizeBackfillOptions(input, { requireOutput: true });
  const generated = await generateJmaLocalBackfillSql(config);
  mkdirSync(path.dirname(config.outputPath), { recursive: true });
  writeFileSync(config.outputPath, generated.sql, "utf8");
  return {
    ...generated,
    summary: {
      ...generated.summary,
      outputPath: config.outputPath
    }
  };
}

export async function generateJmaLocalBackfillSql(input = {}) {
  const config = normalizeBackfillOptions(input, { requireOutput: false });
  const modules = loadWanokuModules();
  const artifact = await readAnnualArtifact(config, input);
  const forecastIssuedAt = forecastIssuedAtFromLastModified(artifact.lastModified);
  const rawHash = sha256HexFromBytes(artifact.bytes);
  const sourceByteLength = artifact.bytes.byteLength;

  if (config.expectedRawHash && rawHash !== config.expectedRawHash) {
    throw new WanokuJmaLocalBackfillError("raw_hash_mismatch", "expectedRawHash does not match the fetched annual source raw hash.");
  }

  const sourceText = decodeJmaSourceBytes(artifact.bytes);
  const observations = parseRequestedMonths({
    config: { ...config, forecastIssuedAt },
    modules,
    sourceText
  });
  const sourceRun = buildSourceRun({
    config,
    modules,
    httpStatus: artifact.httpStatus,
    rawHash
  });
  const sourceRunRow = buildSourceRunRow(sourceRun, modules);
  const observationRows = observations.map((observation) => buildObservationRow(observation, sourceRun.id, modules));
  assertNoDuplicateGeneratedVersionKeys(observationRows);

  const statements = [
    ...buildInsertStatements(SOURCE_RUN_TABLE, SOURCE_RUN_COLUMNS, [sourceRunRow], MAX_SQL_STATEMENT_BYTES),
    ...buildInsertStatements(OBSERVATION_TABLE, OBSERVATION_COLUMNS, observationRows, MAX_SQL_STATEMENT_BYTES)
  ];
  const sql = `${statements.join("\n\n")}\n`;
  assertSafeGeneratedSql(sql, statements);

  return {
    sql,
    statements,
    sourceRun,
    sourceRunRows: [sourceRunRow],
    observations,
    observationRows,
    summary: {
      station: config.station,
      sourceYear: config.sourceYear,
      months: formatMonthsForSummary(config.months),
      acquisitionAt: config.acquisitionAt,
      forecastIssuedAt,
      rawHash,
      sourceByteLength,
      observationCount: observations.length,
      sourceRunCount: 1,
      statementCount: statements.length,
      sqlByteLength: utf8ByteLength(sql),
      outputPath: config.outputPath ?? null
    }
  };
}

export function buildJmaAnnualSourceUrl(station, sourceYear) {
  if (!SUPPORTED_STATIONS.includes(station)) {
    throw new WanokuJmaLocalBackfillError("invalid_station", "station must be one of KZ, QS, TT.");
  }
  if (!SUPPORTED_SOURCE_YEARS.includes(sourceYear)) {
    throw new WanokuJmaLocalBackfillError("invalid_source_year", "sourceYear must be 2026.");
  }
  return new URL(`${sourceYear}/${station}.txt`, SOURCE_BASE_URL).toString();
}

export function formatDryRunSummary(summary) {
  return [
    `station: ${summary.station}`,
    `sourceYear: ${summary.sourceYear}`,
    `months: ${summary.months}`,
    `acquisitionAt: ${summary.acquisitionAt}`,
    `forecastIssuedAt: ${summary.forecastIssuedAt}`,
    `rawHash: ${summary.rawHash}`,
    `sourceByteLength: ${summary.sourceByteLength}`,
    `observationCount: ${summary.observationCount}`,
    `sourceRunCount: ${summary.sourceRunCount}`,
    `SQL statementCount: ${summary.statementCount}`,
    `SQL byteLength: ${summary.sqlByteLength}`,
    `output path: ${summary.outputPath}`
  ].join("\n");
}

function normalizeBackfillOptions(input, { requireOutput }) {
  const station = input.station;
  const sourceYear = input.sourceYear;
  const months = Array.isArray(input.months) ? normalizeMonthsArray(input.months) : null;
  const acquisitionAt = input.acquisitionAt;
  const expectedRawHash = input.expectedRawHash ?? null;
  const outputPath = input.output ? path.resolve(input.output) : null;

  if (!SUPPORTED_STATIONS.includes(station)) throw new WanokuJmaLocalBackfillError("invalid_station", "station must be one of KZ, QS, TT.");
  if (!SUPPORTED_SOURCE_YEARS.includes(sourceYear)) throw new WanokuJmaLocalBackfillError("invalid_source_year", "sourceYear must be 2026.");
  if (!months || months.length === 0) throw new WanokuJmaLocalBackfillError("invalid_months", "months must be specified explicitly.");
  if (!isCanonicalUtcIsoDateTime(acquisitionAt)) {
    throw new WanokuJmaLocalBackfillError("invalid_acquisition_at", "acquisitionAt must be canonical UTC ISO datetime.");
  }
  if (expectedRawHash != null && (typeof expectedRawHash !== "string" || !LOWERCASE_SHA256_HEX.test(expectedRawHash))) {
    throw new WanokuJmaLocalBackfillError("invalid_expected_raw_hash", "expectedRawHash must be a lowercase SHA-256 64-character hex string.");
  }
  if (requireOutput && (!outputPath || outputPath.trim() === "")) {
    throw new WanokuJmaLocalBackfillError("invalid_output", "output path is required.");
  }

  return {
    ...input,
    station,
    sourceYear,
    months,
    acquisitionAt,
    expectedRawHash,
    outputPath,
    sourceUrl: buildJmaAnnualSourceUrl(station, sourceYear)
  };
}

async function readAnnualArtifact(config, input) {
  if (input.sourceBytes != null || input.sourceText != null) {
    const bytes = input.sourceBytes != null ? toUint8Array(input.sourceBytes) : TEXT_ENCODER.encode(input.sourceText);
    return {
      bytes,
      lastModified: input.lastModifiedHeader ?? input.lastModified ?? null,
      httpStatus: input.httpStatus ?? 200
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new WanokuJmaLocalBackfillError("fetch_unavailable", "fetch is not available.");
  const response = await fetchImpl(config.sourceUrl, {
    headers: {
      Accept: "text/plain,*/*;q=0.1"
    }
  });
  if (!response || typeof response.arrayBuffer !== "function") {
    throw new WanokuJmaLocalBackfillError("fetch_error", "JMA source fetch did not return a Response-like object.");
  }
  if (!response.ok) {
    throw new WanokuJmaLocalBackfillError("fetch_error", `JMA source fetch failed with HTTP ${response.status}.`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    lastModified: response.headers?.get?.("last-modified") ?? null,
    httpStatus: response.status
  };
}

function parseRequestedMonths({ config, modules, sourceText }) {
  const allObservations = [];
  for (const sourceMonth of config.months) {
    const expectedDailyLineCount = modules.daysInMonth(config.sourceYear, sourceMonth);
    const expectedObservationCount = expectedDailyLineCount * 24;
    const sliced = modules.sliceJmaTidePredictionFixedWidthBySourceMonth(sourceText, {
      sourceYear: config.sourceYear,
      sourceMonth
    });
    if (sliced.errors.length) {
      throw new WanokuJmaLocalBackfillError("month_completeness_error", `sourceMonth ${sourceMonth} could not be sliced: ${sliced.errors.join("; ")}`);
    }
    if (sliced.selectedLineCount !== expectedDailyLineCount) {
      throw new WanokuJmaLocalBackfillError(
        "month_completeness_error",
        `sourceMonth ${sourceMonth} expected ${expectedDailyLineCount} daily lines and found ${sliced.selectedLineCount}.`
      );
    }

    const parsed = modules.parseJmaTidePredictionFixedWidth(sliced.text, {
      provider: modules.getJmaTidePredictionProviderDefinition(),
      stations: modules.JMA_TIDE_PREDICTION_STATIONS_2026,
      sourceYear: config.sourceYear,
      collectedAt: config.acquisitionAt,
      normalizedAt: config.acquisitionAt,
      forecastIssuedAt: config.forecastIssuedAt,
      sourceUrl: config.sourceUrl,
      sourceName: sourceNameFor(config),
      attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku."
    });

    if (!Array.isArray(parsed.observations) || !Array.isArray(parsed.errors) || !Array.isArray(parsed.warnings)) {
      throw new WanokuJmaLocalBackfillError("parse_failed", `sourceMonth ${sourceMonth} parser returned a malformed result.`);
    }
    const duplicateDailyLine = parsed.warnings.some((warning) => typeof warning === "string" && warning.startsWith("duplicate JMA tide prediction daily line ignored:"));
    if (parsed.errors.length > 0) {
      throw new WanokuJmaLocalBackfillError("parse_failed", `sourceMonth ${sourceMonth} parser errors: ${formatDiagnosticList(parsed.errors)}`);
    }
    if (duplicateDailyLine) {
      throw new WanokuJmaLocalBackfillError("month_completeness_error", `sourceMonth ${sourceMonth} contains duplicate daily lines.`);
    }
    if (parsed.observations.length !== expectedObservationCount) {
      throw new WanokuJmaLocalBackfillError(
        "month_completeness_error",
        `sourceMonth ${sourceMonth} expected ${expectedObservationCount} observations and parsed ${parsed.observations.length}.`
      );
    }

    const monthPrefix = `${config.sourceYear}-${pad2(sourceMonth)}-`;
    for (const observation of parsed.observations) {
      if (observation.stationId !== config.station) {
        throw new WanokuJmaLocalBackfillError("station_mismatch", `sourceMonth ${sourceMonth} generated station ${observation.stationId}, expected ${config.station}.`);
      }
      if (observation.collectedAt !== config.acquisitionAt || observation.provenance?.normalizedAt !== config.acquisitionAt) {
        throw new WanokuJmaLocalBackfillError("timestamp_mismatch", `sourceMonth ${sourceMonth} did not use acquisitionAt for collectedAt and normalizedAt.`);
      }
      if (!observation.provenance?.sourceTimestamp?.startsWith(monthPrefix)) {
        throw new WanokuJmaLocalBackfillError("month_completeness_error", `sourceMonth ${sourceMonth} generated an observation outside the requested month.`);
      }
    }
    allObservations.push(...parsed.observations);
  }
  return allObservations;
}

function buildSourceRun({ config, modules, httpStatus, rawHash }) {
  return {
    id: buildSourceRunId(config, rawHash),
    providerId: modules.JMA_TIDE_PREDICTION_PROVIDER_ID,
    requestedAt: config.acquisitionAt,
    completedAt: config.acquisitionAt,
    status: "ok",
    httpStatus,
    errorCode: null,
    rawHash,
    sourceName: `${sourceNameFor(config)} local backfill months ${formatMonthsForSummary(config.months)}`,
    sourceUrl: config.sourceUrl,
    parserId: modules.JMA_TIDE_PREDICTION_PARSER_ID,
    parserVersion: modules.JMA_TIDE_PREDICTION_PARSER_VERSION,
    sourceFormatVersion: modules.JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
    normalizedSchemaVersion: modules.HYDRO_COASTAL_SCHEMA_VERSION
  };
}

function buildSourceRunId(config, rawHash) {
  return [
    "jma-tide-prediction",
    "local-backfill",
    String(config.sourceYear),
    config.station,
    monthScopeForId(config.months),
    config.acquisitionAt,
    rawHash.slice(0, 16)
  ].join(":");
}

function buildSourceRunRow(sourceRun, modules) {
  return {
    id: sourceRun.id,
    provider_id: sourceRun.providerId,
    requested_at: sourceRun.requestedAt,
    completed_at: sourceRun.completedAt,
    status: sourceRun.status,
    http_status: sourceRun.httpStatus,
    error_code: sourceRun.errorCode,
    raw_hash: sourceRun.rawHash,
    source_name: sourceRun.sourceName,
    source_url: sourceRun.sourceUrl,
    parser_id: sourceRun.parserId,
    parser_version: sourceRun.parserVersion,
    source_format_version: sourceRun.sourceFormatVersion,
    normalized_schema_version: sourceRun.normalizedSchemaVersion,
    run_json: modules.canonicalHydroCoastalJson(sourceRun)
  };
}

function buildObservationRow(observation, sourceRunId, modules) {
  return {
    version_key: modules.hydroCoastalObservationVersionKey(observation),
    identity_key: modules.hydroCoastalObservationIdentityKey(observation),
    source_run_id: sourceRunId,
    provider_id: observation.providerId,
    station_id: observation.stationId,
    metric: observation.metric,
    observed_at: observation.observedAt,
    collected_at: observation.collectedAt,
    forecast_issued_at: observation.forecastIssuedAt ?? null,
    value: observation.value,
    unit: observation.unit,
    status: observation.status,
    provisional: observation.provisional ? 1 : 0,
    vertical_datum_json: observation.verticalDatum == null ? null : modules.canonicalHydroCoastalJson(observation.verticalDatum),
    normalized_schema_version: modules.HYDRO_COASTAL_SCHEMA_VERSION,
    normalized_json: modules.canonicalHydroCoastalJson(observation)
  };
}

function buildInsertStatements(table, columns, rows, maxStatementBytes) {
  const prefix = `INSERT INTO ${table} (${columns.join(", ")}) VALUES`;
  const statements = [];
  let tuples = [];

  for (const row of rows) {
    const tuple = `(${columns.map((column) => sqlLiteral(row[column])).join(", ")})`;
    const singleStatement = renderInsertStatement(prefix, [tuple]);
    if (utf8ByteLength(singleStatement) >= maxStatementBytes) {
      throw new WanokuJmaLocalBackfillError("sql_statement_too_large", `single ${table} row exceeds ${maxStatementBytes} bytes.`);
    }

    const candidate = renderInsertStatement(prefix, [...tuples, tuple]);
    if (tuples.length > 0 && utf8ByteLength(candidate) >= maxStatementBytes) {
      statements.push(renderInsertStatement(prefix, tuples));
      tuples = [tuple];
    } else {
      tuples.push(tuple);
    }
  }

  if (tuples.length > 0) statements.push(renderInsertStatement(prefix, tuples));
  return statements;
}

function renderInsertStatement(prefix, tuples) {
  return `${prefix}\n${tuples.join(",\n")};`;
}

function assertSafeGeneratedSql(sql, statements) {
  const forbidden = [
    /\bINSERT\s+OR\s+IGNORE\b/i,
    /\bINSERT\s+OR\s+REPLACE\b/i,
    /\bUPDATE\b/i,
    /\bDELETE\b/i,
    /\bDROP\b/i,
    /\bALTER\b/i,
    /\bCREATE\b/i,
    /\bBEGIN\b/i,
    /\bCOMMIT\b/i
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) throw new WanokuJmaLocalBackfillError("unsafe_sql", `generated SQL matched forbidden pattern ${pattern}.`);
  }
  for (const statement of statements) {
    const byteLength = utf8ByteLength(statement);
    if (byteLength >= MAX_SQL_STATEMENT_BYTES) {
      throw new WanokuJmaLocalBackfillError("sql_statement_too_large", `generated SQL statement is ${byteLength} bytes.`);
    }
  }
}

function assertNoDuplicateGeneratedVersionKeys(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.version_key)) {
      throw new WanokuJmaLocalBackfillError("duplicate_version_key", `duplicate generated version_key: ${row.version_key}`);
    }
    seen.add(row.version_key);
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WanokuJmaLocalBackfillError("invalid_sql_value", "SQL number values must be finite.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new WanokuJmaLocalBackfillError("invalid_sql_value", `unsupported SQL value type: ${typeof value}`);
}

function loadWanokuModules() {
  if (loadedModules) return loadedModules;
  const requireFn = createRequire(import.meta.url);
  registerTypeScriptRequireHook(requireFn);
  const jma = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/jma-tide-prediction.ts"));
  const hydro = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/hydro-coastal.ts"));
  const persistence = loadEsmFileAsCommonJs(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/hydro-coastal-persistence.js"), requireFn);
  loadedModules = {
    ...jma,
    HYDRO_COASTAL_SCHEMA_VERSION: hydro.HYDRO_COASTAL_SCHEMA_VERSION,
    hydroCoastalObservationIdentityKey: hydro.hydroCoastalObservationIdentityKey,
    hydroCoastalObservationVersionKey: hydro.hydroCoastalObservationVersionKey,
    canonicalHydroCoastalJson: persistence.canonicalHydroCoastalJson
  };
  return loadedModules;
}

function registerTypeScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".ts"]?.__wanokuJmaLocalBackfill) return;
  const ts = requireFn("typescript");
  const previous = Module._extensions[".ts"];
  const hook = function compileTypeScript(module, filename) {
    const source = readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }).outputText;
    module._compile(output, filename);
  };
  hook.__wanokuJmaLocalBackfill = true;
  hook.__previous = previous;
  Module._extensions[".ts"] = hook;
}

function loadEsmFileAsCommonJs(filename, requireFn) {
  const Module = requireFn("node:module");
  const ts = requireFn("typescript");
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true
    }
  }).outputText;
  module._compile(output, filename);
  return module.exports;
}

function sha256HexFromBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeJmaSourceBytes(bytes) {
  try {
    return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WanokuJmaLocalBackfillError("decode_error", "annual JMA source could not be decoded as Shift_JIS.");
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new WanokuJmaLocalBackfillError("invalid_source_bytes", "sourceBytes must be Uint8Array or ArrayBuffer.");
}

function normalizeMonthsArray(months) {
  const seen = new Set();
  const normalized = [];
  for (const month of months) appendUniqueMonth(month, seen, normalized);
  return normalized.sort((left, right) => left - right);
}

function appendUniqueMonth(month, seen, months) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new WanokuJmaLocalBackfillError("invalid_months", "months must be integers from 1 to 12.");
  }
  if (seen.has(month)) throw new WanokuJmaLocalBackfillError("invalid_months", `duplicate month: ${month}`);
  seen.add(month);
  months.push(month);
}

function parseMonth(value) {
  if (!/^\d{1,2}$/.test(value)) throw new WanokuJmaLocalBackfillError("invalid_months", `invalid month: ${value}`);
  return Number.parseInt(value, 10);
}

function parseIntegerOption(value, label) {
  if (!/^\d+$/.test(value)) throw new WanokuJmaLocalBackfillError("invalid_cli", `${label} must be an integer.`);
  return Number.parseInt(value, 10);
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function sourceNameFor(config) {
  return `Japan Meteorological Agency tide prediction text data ${config.sourceYear} ${config.station}`;
}

function monthScopeForId(months) {
  return `m${formatMonthsForSummary(months).replaceAll(",", "_").replaceAll("-", "-m")}`;
}

function formatMonthsForSummary(months) {
  if (months.length === 0) return "";
  const ranges = [];
  let start = months[0];
  let previous = months[0];
  for (let index = 1; index < months.length; index += 1) {
    const month = months[index];
    if (month === previous + 1) {
      previous = month;
      continue;
    }
    ranges.push(formatMonthRange(start, previous));
    start = month;
    previous = month;
  }
  ranges.push(formatMonthRange(start, previous));
  return ranges.join(",");
}

function formatMonthRange(start, end) {
  return start === end ? pad2(start) : `${pad2(start)}-${pad2(end)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function utf8ByteLength(value) {
  return TEXT_ENCODER.encode(value).byteLength;
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-jma-local-backfill.mjs --station KZ --source-year 2026 --months 2-12 --acquisition-at 2026-08-14T02:20:19.400Z --output .tmp/kz-2026-02-12.sql

Required:
  --station KZ|QS|TT
  --source-year 2026
  --months 2-12 or 1-12
  --acquisition-at <canonical UTC ISO>
  --output <sql path>

Optional:
  --expected-raw-hash <64 lowercase SHA-256 hex>
`);
}

function formatDiagnosticList(items, limit = 8) {
  const head = items.slice(0, limit).join("; ");
  const remaining = items.length - limit;
  return remaining > 0 ? `${head}; ... ${remaining} more` : head;
}

function forecastIssuedAtFromLastModified(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WanokuJmaLocalBackfillError("missing_last_modified", "JMA source Last-Modified header is required for forecastIssuedAt.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new WanokuJmaLocalBackfillError("invalid_last_modified", "JMA source Last-Modified header is not a valid HTTP date.");
  }
  return date.toISOString();
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  const result = await runLocalBackfill(options);
  console.log(formatDryRunSummary(result.summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (error instanceof WanokuJmaLocalBackfillError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error?.message || "wanoku JMA local backfill failed");
    }
    process.exitCode = 1;
  });
}
