import {
  HYDRO_COASTAL_PROVIDER_IDS,
  HYDRO_COASTAL_SCHEMA_VERSION,
  hydroCoastalObservationIdentityKey,
  hydroCoastalObservationVersionKey,
  selectHydroCoastalObservationsAsOf,
  validateHydroCoastalObservation
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";

export const HYDRO_COASTAL_PERSISTENCE_SCHEMA_VERSION = "wanoku-hydro-coastal-persistence.v1";
export const HYDRO_COASTAL_SOURCE_RUN_STATUSES = ["ok", "partial", "failed"];
export const D1_MAX_BOUND_PARAMS_PER_STATEMENT = 90;
export const HYDRO_COASTAL_MAX_WRITE_ATTEMPTS = 3;

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
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function canonicalHydroCoastalJson(value) {
  return stableSerialize(value, true);
}

export function prepareHydroCoastalPersistenceBatch(input) {
  const sourceRun = normalizeSourceRun(input?.sourceRun);
  const observations = Array.isArray(input?.observations) ? input.observations : [];
  const errors = [];
  const warnings = [];
  const sourceRunValidation = validateSourceRun(sourceRun);
  errors.push(...sourceRunValidation.errors);
  warnings.push(...sourceRunValidation.warnings);

  let sourceRunJson = null;
  try {
    sourceRunJson = canonicalHydroCoastalJson(sourceRun);
  } catch (error) {
    errors.push(`sourceRun canonical JSON failed: ${error.message}`);
  }
  const sourceRunValid = sourceRunValidation.errors.length === 0 && typeof sourceRunJson === "string";

  if (sourceRun.status === "failed" && observations.length > 0) {
    errors.push("failed source run must not include observations.");
  }

  const acceptedCandidates = [];
  let invalidCount = 0;
  for (const [index, candidate] of observations.entries()) {
    const validation = validateHydroCoastalObservation(candidate);
    warnings.push(...validation.warnings.map((warning) => `observation ${index}: ${warning}`));
    if (!validation.valid) {
      invalidCount += 1;
      errors.push(...validation.errors.map((error) => `observation ${index}: ${error}`));
      continue;
    }
    if (candidate.schemaVersion !== HYDRO_COASTAL_SCHEMA_VERSION) {
      invalidCount += 1;
      errors.push(`observation ${index}: unsupported schemaVersion.`);
      continue;
    }
    if (candidate.providerId !== sourceRun.providerId) {
      invalidCount += 1;
      errors.push(`observation ${index}: providerId does not match sourceRun.providerId.`);
      continue;
    }

    let normalizedJson;
    let verticalDatumJson = null;
    try {
      normalizedJson = canonicalHydroCoastalJson(candidate);
      verticalDatumJson = candidate.verticalDatum == null ? null : canonicalHydroCoastalJson(candidate.verticalDatum);
    } catch (error) {
      invalidCount += 1;
      errors.push(`observation ${index}: canonical JSON failed: ${error.message}`);
      continue;
    }
    const identityKey = hydroCoastalObservationIdentityKey(candidate);
    const versionKey = hydroCoastalObservationVersionKey(candidate);
    acceptedCandidates.push({
      observation: candidate,
      row: {
        versionKey,
        identityKey,
        sourceRunId: sourceRun.id,
        providerId: candidate.providerId,
        stationId: candidate.stationId,
        metric: candidate.metric,
        observedAt: candidate.observedAt,
        collectedAt: candidate.collectedAt,
        forecastIssuedAt: candidate.forecastIssuedAt,
        value: candidate.value,
        unit: candidate.unit,
        status: candidate.status,
        provisional: candidate.provisional ? 1 : 0,
        verticalDatumJson,
        normalizedSchemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
        normalizedJson
      }
    });
  }

  const byVersion = new Map();
  for (const candidate of acceptedCandidates) {
    byVersion.set(candidate.row.versionKey, [...(byVersion.get(candidate.row.versionKey) || []), candidate]);
  }

  const observationRows = [];
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const [versionKey, group] of [...byVersion.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.length === 1) {
      observationRows.push(group[0].row);
      continue;
    }
    const jsons = new Set(group.map((item) => item.row.normalizedJson));
    if (jsons.size === 1) {
      duplicateCount += group.length - 1;
      warnings.push(`duplicate hydro-coastal observation in input ignored: ${versionKey}`);
      observationRows.push(group[0].row);
    } else {
      conflictCount += group.length;
      errors.push(`conflicting hydro-coastal observation in input: ${versionKey}`);
    }
  }

  const statusErrorsBlockOk = sourceRun.status === "ok" && errors.length > 0;
  return {
    sourceRun,
    sourceRunJson,
    sourceRunRow: sourceRunJson ? sourceRunToRow(sourceRun, sourceRunJson) : null,
    sourceRunValid,
    observationRows: statusErrorsBlockOk ? [] : observationRows.sort((left, right) => left.versionKey.localeCompare(right.versionKey)),
    inputObservationCount: observations.length,
    validObservationCount: statusErrorsBlockOk ? 0 : observationRows.length,
    duplicateCount,
    conflictCount,
    invalidCount,
    errors: unique(errors),
    warnings: unique(warnings)
  };
}

export async function writeHydroCoastalBatch(db, input) {
  const prepared = prepareHydroCoastalPersistenceBatch(input);
  const result = {
    ok: false,
    partial: false,
    sourceRunId: prepared.sourceRun.id || null,
    inputObservationCount: prepared.inputObservationCount,
    validObservationCount: prepared.validObservationCount,
    insertedCount: 0,
    duplicateCount: prepared.duplicateCount,
    conflictCount: prepared.conflictCount,
    invalidCount: prepared.invalidCount,
    statementCount: 0,
    errors: [...prepared.errors],
    warnings: [...prepared.warnings]
  };
  const duplicateVersionKeys = new Set();
  const conflictVersionKeys = new Set();
  let sourceRunDuplicateWarned = false;

  if (!db || typeof db.prepare !== "function") {
    result.errors.push("D1 database is not configured.");
    return finalizeWriteResult(result);
  }
  if (typeof db.batch !== "function") {
    result.errors.push("D1 database batch() is required for atomic hydro-coastal writes.");
    return finalizeWriteResult(result);
  }
  if (!prepared.sourceRunValid || !prepared.sourceRunRow || !prepared.sourceRunJson) {
    return finalizeWriteResult(result);
  }
  if (prepared.sourceRun.status === "ok" && prepared.errors.length > 0) {
    return finalizeWriteResult(result);
  }
  if (prepared.sourceRun.status === "failed" && prepared.inputObservationCount > 0) {
    return finalizeWriteResult(result);
  }

  result.partial = prepared.sourceRun.status === "partial";

  const sourceRunCheck = await readExistingSourceRun(db, prepared.sourceRun.id);
  result.statementCount += sourceRunCheck.statementCount;
  if (sourceRunCheck.error) {
    result.errors.push(sourceRunCheck.error);
    return finalizeWriteResult(result);
  }
  if (sourceRunCheck.row && sourceRunCheck.row.run_json !== prepared.sourceRunJson) {
    result.errors.push(`source run conflict: ${prepared.sourceRun.id}`);
    return finalizeWriteResult(result);
  }
  let shouldInsertSourceRun = !sourceRunCheck.row;
  if (!shouldInsertSourceRun) {
    result.warnings.push(`duplicate hydro-coastal source run ignored: ${prepared.sourceRun.id}`);
    sourceRunDuplicateWarned = true;
  }

  const existingObservationCheck = await readExistingObservationRows(db, prepared.observationRows.map((row) => row.versionKey));
  result.statementCount += existingObservationCheck.statementCount;
  if (existingObservationCheck.error) {
    result.errors.push(existingObservationCheck.error);
    return finalizeWriteResult(result);
  }

  let pendingRows = classifyExistingObservationRows({
    rows: prepared.observationRows,
    rowsByVersionKey: existingObservationCheck.rowsByVersionKey,
    result,
    duplicateVersionKeys,
    conflictVersionKeys,
    duplicateMessage: "duplicate hydro-coastal observation already exists",
    conflictMessage: "existing hydro-coastal observation conflict"
  });

  if (prepared.sourceRun.status === "ok" && result.errors.length > 0) {
    return finalizeWriteResult(result);
  }

  for (let attempt = 1; attempt <= HYDRO_COASTAL_MAX_WRITE_ATTEMPTS; attempt += 1) {
    if (!shouldInsertSourceRun && pendingRows.length === 0) {
      result.ok = result.errors.length === 0;
      return finalizeWriteResult(result);
    }

    const statements = [];
    if (shouldInsertSourceRun) statements.push(sourceRunInsertStatement(db, prepared.sourceRunRow));
    statements.push(...observationInsertStatements(db, pendingRows));
    result.statementCount += statements.length;

    try {
      await db.batch(statements);
      result.insertedCount += pendingRows.length;
      result.ok = result.errors.length === 0;
      return finalizeWriteResult(result);
    } catch (error) {
      const sourceRace = shouldInsertSourceRun
        ? await classifySourceRunRace(db, prepared, result, sourceRunDuplicateWarned)
        : { shouldInsertSourceRun, sourceRunDuplicateWarned };
      result.statementCount += sourceRace.statementCount || 0;
      shouldInsertSourceRun = sourceRace.shouldInsertSourceRun;
      sourceRunDuplicateWarned = sourceRace.sourceRunDuplicateWarned;
      if (sourceRace.stop) return finalizeWriteResult(result);

      const observationRace = await readExistingObservationRows(db, pendingRows.map((row) => row.versionKey));
      result.statementCount += observationRace.statementCount;
      if (observationRace.error) {
        result.errors.push(observationRace.error);
        return finalizeWriteResult(result);
      }
      pendingRows = classifyExistingObservationRows({
        rows: pendingRows,
        rowsByVersionKey: observationRace.rowsByVersionKey,
        result,
        duplicateVersionKeys,
        conflictVersionKeys,
        duplicateMessage: "duplicate hydro-coastal observation after write race",
        conflictMessage: "hydro-coastal observation conflict after write race"
      });

      if (prepared.sourceRun.status === "ok" && result.errors.length > 0) {
        return finalizeWriteResult(result);
      }
      if (attempt === HYDRO_COASTAL_MAX_WRITE_ATTEMPTS && (shouldInsertSourceRun || pendingRows.length > 0)) {
        if (shouldInsertSourceRun) {
          result.errors.push(`source run race could not be classified: ${prepared.sourceRun.id}`);
        }
        result.errors.push(`hydro-coastal atomic write retry limit exceeded after ${HYDRO_COASTAL_MAX_WRITE_ATTEMPTS} attempts: ${error.message}`);
        return finalizeWriteResult(result);
      }
    }
  }

  result.errors.push("hydro-coastal atomic write exited unexpectedly.");
  return finalizeWriteResult(result);
}

export async function readHydroCoastalHistory(db, query = {}) {
  const validation = validateHistoryQuery(query);
  if (validation.errors.length) {
    return {
      observations: [],
      errors: validation.errors,
      warnings: validation.warnings,
      scannedRowCount: 0,
      returnedObservationCount: 0
    };
  }
  const filters = [];
  const params = [];
  addOptionalEqualityFilter(filters, params, "provider_id", query.providerId);
  addOptionalEqualityFilter(filters, params, "station_id", query.stationId);
  addOptionalEqualityFilter(filters, params, "metric", query.metric);
  addOptionalEqualityFilter(filters, params, "forecast_issued_at", query.forecastIssuedAt);
  addRangeFilter(filters, params, "observed_at", query.observedStart, query.observedEnd);
  addRangeFilter(filters, params, "collected_at", query.collectedStart, query.collectedEnd);
  const limit = normalizeLimit(query.limit, 200, 1000);
  const sql = `
    SELECT ${OBSERVATION_SELECT_COLUMNS.join(", ")}
    FROM ${OBSERVATION_TABLE}
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY observed_at ASC,
      provider_id ASC,
      station_id ASC,
      metric ASC,
      COALESCE(forecast_issued_at, '') ASC,
      collected_at ASC,
      version_key ASC
    LIMIT ?
  `;
  try {
    const rows = await db.prepare(sql).bind(...params, limit).all();
    return hydrateRowsResult(rows?.results || []);
  } catch (error) {
    return {
      observations: [],
      errors: [`hydro-coastal history query failed: ${error.message}`],
      warnings: [],
      scannedRowCount: 0,
      returnedObservationCount: 0
    };
  }
}

export async function readHydroCoastalObservationsAsOf(db, query = {}) {
  const validation = validateAsOfQuery(query);
  if (validation.errors.length) {
    return {
      observations: [],
      errors: validation.errors,
      warnings: validation.warnings,
      scannedRowCount: 0,
      returnedObservationCount: 0
    };
  }
  const filters = ["observed_at >= ?", "observed_at < ?", "collected_at <= ?"];
  const params = [query.observedStart, query.observedEnd, query.calculatedAt];
  addOptionalEqualityFilter(filters, params, "provider_id", query.providerId);
  addOptionalEqualityFilter(filters, params, "station_id", query.stationId);
  addOptionalEqualityFilter(filters, params, "metric", query.metric);
  addOptionalEqualityFilter(filters, params, "forecast_issued_at", query.forecastIssuedAt);
  const limit = normalizeLimit(query.limit, 200, 1000);
  const sql = `
    SELECT ${OBSERVATION_SELECT_COLUMNS.join(", ")}
    FROM ${OBSERVATION_TABLE}
    WHERE ${filters.join(" AND ")}
    ORDER BY observed_at ASC,
      provider_id ASC,
      station_id ASC,
      metric ASC,
      COALESCE(forecast_issued_at, '') ASC,
      collected_at ASC,
      version_key ASC
  `;
  try {
    const rows = await db.prepare(sql).bind(...params).all();
    const hydrated = hydrateRowsResult(rows?.results || []);
    const selected = selectHydroCoastalObservationsAsOf(hydrated.observations, query.calculatedAt);
    return {
      observations: selected.observations.slice(0, limit),
      errors: unique([...hydrated.errors, ...selected.errors]),
      warnings: unique([...hydrated.warnings, ...selected.warnings]),
      scannedRowCount: hydrated.scannedRowCount,
      returnedObservationCount: selected.observations.slice(0, limit).length
    };
  } catch (error) {
    return {
      observations: [],
      errors: [`hydro-coastal as-of query failed: ${error.message}`],
      warnings: [],
      scannedRowCount: 0,
      returnedObservationCount: 0
    };
  }
}

export function hydrateHydroCoastalObservationRow(row) {
  const errors = [];
  const warnings = [];
  let observation;
  try {
    observation = JSON.parse(row?.normalized_json);
  } catch {
    return { observation: null, errors: ["normalized_json is malformed."], warnings };
  }
  const validation = validateHydroCoastalObservation(observation);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);
  if (!validation.valid) {
    return { observation: null, errors: unique(errors), warnings: unique(warnings) };
  }
  let canonicalJson;
  try {
    canonicalJson = canonicalHydroCoastalJson(observation);
  } catch (error) {
    errors.push(`normalized_json canonicalization failed: ${error.message}`);
    return { observation: null, errors: unique(errors), warnings: unique(warnings) };
  }
  if (row?.normalized_json !== canonicalJson) {
    errors.push("normalized_json is not canonical.");
  }
  const expectedIdentityKey = hydroCoastalObservationIdentityKey(observation);
  const expectedVersionKey = hydroCoastalObservationVersionKey(observation);
  const checks = [
    ["version_key", row?.version_key, expectedVersionKey],
    ["identity_key", row?.identity_key, expectedIdentityKey],
    ["provider_id", row?.provider_id, observation.providerId],
    ["station_id", row?.station_id, observation.stationId],
    ["metric", row?.metric, observation.metric],
    ["observed_at", row?.observed_at, observation.observedAt],
    ["collected_at", row?.collected_at, observation.collectedAt],
    ["forecast_issued_at", row?.forecast_issued_at ?? null, observation.forecastIssuedAt],
    ["normalized_schema_version", row?.normalized_schema_version, observation.schemaVersion]
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) errors.push(`${field} does not match normalized_json.`);
  }
  return {
    observation: errors.length ? null : observation,
    errors: unique(errors),
    warnings: unique(warnings)
  };
}

export function chunkRowsForHydroCoastalBoundLimit(rows, columnsPerRow, maxParams = D1_MAX_BOUND_PARAMS_PER_STATEMENT) {
  const rowsPerChunk = Math.max(1, Math.floor(maxParams / columnsPerRow));
  const chunks = [];
  for (let index = 0; index < rows.length; index += rowsPerChunk) {
    chunks.push(rows.slice(index, index + rowsPerChunk));
  }
  return chunks;
}

const OBSERVATION_SELECT_COLUMNS = [
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
  "normalized_json",
  "created_at"
];

function normalizeSourceRun(input = {}) {
  return {
    id: input.id,
    providerId: input.providerId,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt ?? null,
    status: input.status,
    httpStatus: input.httpStatus ?? null,
    errorCode: input.errorCode ?? null,
    rawHash: input.rawHash ?? null,
    sourceName: input.sourceName ?? null,
    sourceUrl: input.sourceUrl ?? null,
    parserId: input.parserId ?? null,
    parserVersion: input.parserVersion ?? null,
    sourceFormatVersion: input.sourceFormatVersion ?? null,
    normalizedSchemaVersion: input.normalizedSchemaVersion
  };
}

function validateSourceRun(sourceRun) {
  const errors = [];
  const warnings = [];
  if (!isNonEmptyString(sourceRun.id)) errors.push("sourceRun.id must not be empty.");
  if (!isHydroCoastalProviderId(sourceRun.providerId)) errors.push("sourceRun.providerId is invalid.");
  if (!isCanonicalUtcIsoDateTime(sourceRun.requestedAt)) errors.push("sourceRun.requestedAt must be canonical UTC ISO datetime.");
  if (sourceRun.completedAt !== null && !isCanonicalUtcIsoDateTime(sourceRun.completedAt)) errors.push("sourceRun.completedAt must be null or canonical UTC ISO datetime.");
  if (!HYDRO_COASTAL_SOURCE_RUN_STATUSES.includes(sourceRun.status)) errors.push("sourceRun.status is invalid.");
  if (sourceRun.httpStatus !== null && (!Number.isInteger(sourceRun.httpStatus) || sourceRun.httpStatus < 100 || sourceRun.httpStatus > 599)) errors.push("sourceRun.httpStatus must be null or HTTP status integer.");
  if (sourceRun.normalizedSchemaVersion !== HYDRO_COASTAL_SCHEMA_VERSION) errors.push("sourceRun.normalizedSchemaVersion must match HYDRO_COASTAL_SCHEMA_VERSION.");
  for (const field of ["errorCode", "rawHash", "sourceName", "sourceUrl", "parserId", "parserVersion", "sourceFormatVersion"]) {
    if (sourceRun[field] !== null && typeof sourceRun[field] !== "string") {
      errors.push(`sourceRun.${field} must be null or string.`);
    }
  }
  return { errors, warnings };
}

function sourceRunToRow(sourceRun, runJson) {
  return {
    id: sourceRun.id,
    providerId: sourceRun.providerId,
    requestedAt: sourceRun.requestedAt,
    completedAt: sourceRun.completedAt,
    status: sourceRun.status,
    httpStatus: sourceRun.httpStatus,
    errorCode: sourceRun.errorCode,
    rawHash: sourceRun.rawHash,
    sourceName: sourceRun.sourceName,
    sourceUrl: sourceRun.sourceUrl,
    parserId: sourceRun.parserId,
    parserVersion: sourceRun.parserVersion,
    sourceFormatVersion: sourceRun.sourceFormatVersion,
    normalizedSchemaVersion: sourceRun.normalizedSchemaVersion,
    runJson
  };
}

async function readExistingSourceRun(db, id) {
  try {
    const row = await db.prepare(`SELECT id, run_json FROM ${SOURCE_RUN_TABLE} WHERE id = ?`).bind(id).first();
    return { row, statementCount: 1 };
  } catch (error) {
    return { row: null, statementCount: 1, error: `source run lookup failed: ${error.message}` };
  }
}

async function readExistingObservationRows(db, versionKeys) {
  const rowsByVersionKey = new Map();
  let statementCount = 0;
  if (!versionKeys.length) return { rowsByVersionKey, statementCount };
  for (const chunk of chunkValues(versionKeys, D1_MAX_BOUND_PARAMS_PER_STATEMENT)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const sql = `SELECT version_key, normalized_json FROM ${OBSERVATION_TABLE} WHERE version_key IN (${placeholders})`;
    try {
      const rows = await db.prepare(sql).bind(...chunk).all();
      statementCount += 1;
      for (const row of rows?.results || []) rowsByVersionKey.set(row.version_key, row);
    } catch (error) {
      return { rowsByVersionKey, statementCount: statementCount + 1, error: `observation lookup failed: ${error.message}` };
    }
  }
  return { rowsByVersionKey, statementCount };
}

function sourceRunInsertStatement(db, row) {
  return db.prepare(insertSql(SOURCE_RUN_TABLE, SOURCE_RUN_COLUMNS, 1)).bind(...sourceRunParams(row));
}

function observationInsertStatements(db, rows) {
  return chunkRowsForHydroCoastalBoundLimit(rows, OBSERVATION_COLUMNS.length)
    .map((chunk) => db.prepare(insertSql(OBSERVATION_TABLE, OBSERVATION_COLUMNS, chunk.length)).bind(...chunk.flatMap(observationParams)));
}

async function classifySourceRunRace(db, prepared, result, sourceRunDuplicateWarned) {
  const sourceRunCheck = await readExistingSourceRun(db, prepared.sourceRun.id);
  if (sourceRunCheck.error) {
    result.errors.push(sourceRunCheck.error);
    return {
      statementCount: sourceRunCheck.statementCount,
      shouldInsertSourceRun: true,
      sourceRunDuplicateWarned,
      stop: true
    };
  }
  if (!sourceRunCheck.row) {
    return {
      statementCount: sourceRunCheck.statementCount,
      shouldInsertSourceRun: true,
      sourceRunDuplicateWarned,
      stop: false
    };
  }
  if (sourceRunCheck.row.run_json === prepared.sourceRunJson) {
    if (!sourceRunDuplicateWarned) {
      result.warnings.push(`duplicate hydro-coastal source run after write race: ${prepared.sourceRun.id}`);
      sourceRunDuplicateWarned = true;
    }
    return {
      statementCount: sourceRunCheck.statementCount,
      shouldInsertSourceRun: false,
      sourceRunDuplicateWarned,
      stop: false
    };
  }
  result.errors.push(`source run conflict after write race: ${prepared.sourceRun.id}`);
  return {
    statementCount: sourceRunCheck.statementCount,
    shouldInsertSourceRun: true,
    sourceRunDuplicateWarned,
    stop: true
  };
}

function classifyExistingObservationRows({
  rows,
  rowsByVersionKey,
  result,
  duplicateVersionKeys,
  conflictVersionKeys,
  duplicateMessage,
  conflictMessage
}) {
  const pendingRows = [];
  for (const row of rows) {
    const existing = rowsByVersionKey.get(row.versionKey);
    if (!existing) {
      pendingRows.push(row);
      continue;
    }
    if (existing.normalized_json === row.normalizedJson) {
      if (!duplicateVersionKeys.has(row.versionKey)) {
        duplicateVersionKeys.add(row.versionKey);
        result.duplicateCount += 1;
        result.warnings.push(`${duplicateMessage}: ${row.versionKey}`);
      }
    } else if (!conflictVersionKeys.has(row.versionKey)) {
      conflictVersionKeys.add(row.versionKey);
      result.conflictCount += 1;
      result.errors.push(`${conflictMessage}: ${row.versionKey}`);
    }
  }
  return pendingRows;
}

function sourceRunParams(row) {
  return [
    row.id,
    row.providerId,
    row.requestedAt,
    row.completedAt,
    row.status,
    row.httpStatus,
    row.errorCode,
    row.rawHash,
    row.sourceName,
    row.sourceUrl,
    row.parserId,
    row.parserVersion,
    row.sourceFormatVersion,
    row.normalizedSchemaVersion,
    row.runJson
  ];
}

function observationParams(row) {
  return [
    row.versionKey,
    row.identityKey,
    row.sourceRunId,
    row.providerId,
    row.stationId,
    row.metric,
    row.observedAt,
    row.collectedAt,
    row.forecastIssuedAt,
    row.value,
    row.unit,
    row.status,
    row.provisional,
    row.verticalDatumJson,
    row.normalizedSchemaVersion,
    row.normalizedJson
  ];
}

function insertSql(table, columns, rowCount, modifier = "") {
  const row = `(${columns.map(() => "?").join(", ")})`;
  const insertKeyword = modifier ? `INSERT ${modifier}` : "INSERT";
  return `${insertKeyword} INTO ${table} (${columns.join(", ")}) VALUES ${Array.from({ length: rowCount }, () => row).join(", ")}`;
}

function hydrateRowsResult(rows) {
  const errors = [];
  const warnings = [];
  const observations = [];
  for (const row of rows) {
    const hydrated = hydrateHydroCoastalObservationRow(row);
    errors.push(...hydrated.errors);
    warnings.push(...hydrated.warnings);
    if (hydrated.observation) observations.push(hydrated.observation);
  }
  return {
    observations,
    errors: unique(errors),
    warnings: unique(warnings),
    scannedRowCount: rows.length,
    returnedObservationCount: observations.length
  };
}

function validateHistoryQuery(query) {
  const errors = [];
  const warnings = [];
  validateOptionalCanonical(errors, "observedStart", query.observedStart);
  validateOptionalCanonical(errors, "observedEnd", query.observedEnd);
  validateOptionalCanonical(errors, "collectedStart", query.collectedStart);
  validateOptionalCanonical(errors, "collectedEnd", query.collectedEnd);
  validateOptionalCanonical(errors, "forecastIssuedAt", query.forecastIssuedAt);
  return { errors, warnings };
}

function validateAsOfQuery(query) {
  const base = validateHistoryQuery(query);
  if (!isCanonicalUtcIsoDateTime(query.calculatedAt)) base.errors.push("calculatedAt must be canonical UTC ISO datetime.");
  if (!isCanonicalUtcIsoDateTime(query.observedStart)) base.errors.push("observedStart must be canonical UTC ISO datetime.");
  if (!isCanonicalUtcIsoDateTime(query.observedEnd)) base.errors.push("observedEnd must be canonical UTC ISO datetime.");
  return base;
}

function validateOptionalCanonical(errors, field, value) {
  if (value != null && !isCanonicalUtcIsoDateTime(value)) errors.push(`${field} must be canonical UTC ISO datetime.`);
}

function addOptionalEqualityFilter(filters, params, column, value) {
  if (value == null) return;
  filters.push(`${column} = ?`);
  params.push(value);
}

function addRangeFilter(filters, params, column, start, end) {
  if (start != null) {
    filters.push(`${column} >= ?`);
    params.push(start);
  }
  if (end != null) {
    filters.push(`${column} < ?`);
    params.push(end);
  }
}

function normalizeLimit(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function chunkValues(values, maxParams) {
  const chunks = [];
  for (let index = 0; index < values.length; index += maxParams) {
    chunks.push(values.slice(index, index + maxParams));
  }
  return chunks;
}

function finalizeWriteResult(result) {
  return {
    ...result,
    ok: Boolean(result.ok && result.errors.length === 0),
    partial: Boolean(result.partial),
    errors: unique(result.errors),
    warnings: unique(result.warnings)
  };
}

function stableSerialize(value, isTopLevel = false) {
  if (value === undefined) {
    if (isTopLevel) throw new Error("top-level undefined cannot be serialized.");
    return undefined;
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`${typeof value} cannot be serialized.`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableSerialize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)
      .join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot be serialized.");
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function isHydroCoastalProviderId(value) {
  return typeof value === "string" && HYDRO_COASTAL_PROVIDER_IDS.includes(value);
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
  return Array.from(new Set(values));
}
