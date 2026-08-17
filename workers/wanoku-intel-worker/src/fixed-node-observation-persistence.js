import {
  FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
  buildFixedNodeDailyReport,
  buildFixedNodeReportSemanticContent
} from "../../../packages/wanoku-core/src/fixed-node-observation.ts";
import { canonicalHydroCoastalJson } from "./hydro-coastal-persistence.js";
import { sha256HexFromBytes } from "./jma-tide-prediction-ingestion.js";

export const FIXED_NODE_REPORT_ID_PREFIX = "wanoku-fixed-report:";
export const FIXED_NODE_SPECIES_OBSERVATION_ID_PREFIX = "wanoku-fixed-species:";

const REPORT_TABLE = "fixed_node_daily_reports";
const SPECIES_TABLE = "fixed_node_species_observations";
const REPORT_COLUMNS = [
  "report_id",
  "version_key",
  "identity_key",
  "semantic_hash",
  "facility_id",
  "provider_id",
  "observation_date",
  "source_record_id",
  "source_run_id",
  "published_at",
  "collected_at",
  "stored_at",
  "visitor_count",
  "operating_status",
  "report_completeness",
  "normalized_schema_version",
  "source_url",
  "payload_json"
];
const SPECIES_COLUMNS = [
  "observation_id",
  "report_id",
  "facility_id",
  "observation_date",
  "species_id",
  "source_labels_json",
  "catch_count",
  "presence_state",
  "min_size_cm",
  "max_size_cm",
  "area_labels_json",
  "completeness",
  "alias_coverage"
];
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();

export class FixedNodeObservationIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "FixedNodeObservationIntegrityError";
    this.code = "fixed_node_observation_integrity_error";
  }
}

export function canonicalFixedNodeReportJson(report) {
  return canonicalHydroCoastalJson(report);
}

export function canonicalFixedNodeReportSemanticJson(report) {
  return canonicalHydroCoastalJson(buildFixedNodeReportSemanticContent(report));
}

export async function materializeFixedNodeDailyReport(input, storedAt, cryptoImpl = globalThis.crypto) {
  if (!isCanonicalUtcIsoDateTime(storedAt)) throw new Error("storedAt must be canonical UTC ISO datetime.");
  const report = validateReportForPersistence(input);
  const semanticJson = canonicalFixedNodeReportSemanticJson(report);
  const semanticHash = await sha256HexFromBytes(TEXT_ENCODER.encode(semanticJson), cryptoImpl);
  const reportId = fixedNodeReportId(semanticHash);
  const versionKey = `${report.reportIdentity}|${semanticHash}`;
  const species = [];
  for (const observation of report.species) {
    const identityJson = canonicalHydroCoastalJson([reportId, observation.speciesId]);
    const identityHash = await sha256HexFromBytes(TEXT_ENCODER.encode(identityJson), cryptoImpl);
    species.push({
      observationId: `${FIXED_NODE_SPECIES_OBSERVATION_ID_PREFIX}${identityHash}`,
      reportId,
      facilityId: report.facilityId,
      observationDate: report.observationDate,
      speciesId: observation.speciesId,
      sourceLabelsJson: canonicalHydroCoastalJson(observation.sourceLabels),
      catchCount: observation.catchCount,
      presenceState: observation.presenceState,
      minSizeCm: observation.minSizeCm,
      maxSizeCm: observation.maxSizeCm,
      areaLabelsJson: canonicalHydroCoastalJson(observation.areaLabels),
      completeness: observation.completeness,
      aliasCoverage: observation.aliasCoverage
    });
  }
  return {
    reportId,
    versionKey,
    identityKey: report.reportIdentity,
    semanticHash,
    facilityId: report.facilityId,
    providerId: report.providerId,
    observationDate: report.observationDate,
    sourceRecordId: report.sourceRecordId,
    sourceRunId: report.sourceRunId,
    publishedAt: report.publishedAt,
    collectedAt: report.collectedAt,
    storedAt,
    visitorCount: report.visitorCount,
    operatingStatus: report.operatingStatus,
    reportCompleteness: report.reportCompleteness,
    normalizedSchemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
    sourceUrl: report.sourceUrl,
    payloadJson: canonicalFixedNodeReportJson(report),
    semanticJson,
    species,
    report
  };
}

export function fixedNodeReportId(semanticHash) {
  if (!SHA256_HEX.test(semanticHash)) throw new Error("semanticHash must be a lowercase SHA-256 hex string.");
  return `${FIXED_NODE_REPORT_ID_PREFIX}${semanticHash}`;
}

export async function persistFixedNodeDailyReport(
  db,
  { report, storedAt, cryptoImpl = globalThis.crypto }
) {
  const candidate = await materializeFixedNodeDailyReport(report, storedAt, cryptoImpl);
  const existingRows = await lookupReportRows(db, candidate.reportId, candidate.versionKey);
  if (existingRows.length > 0) return existingReportResult(db, existingRows, candidate, cryptoImpl);
  if (typeof db?.batch !== "function") throw new Error("D1 batch support is required for fixed-node report atomicity.");

  const statements = [
    db.prepare(insertSql(REPORT_TABLE, REPORT_COLUMNS)).bind(...reportRowParams(candidate)),
    ...candidate.species.map((row) => db.prepare(insertSql(SPECIES_TABLE, SPECIES_COLUMNS)).bind(...speciesRowParams(row)))
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const racedRows = await lookupReportRows(db, candidate.reportId, candidate.versionKey);
    if (racedRows.length > 0) return existingReportResult(db, racedRows, candidate, cryptoImpl);
    throw error;
  }

  return reportResult(candidate, true);
}

async function lookupReportRows(db, reportId, versionKey) {
  const rows = await db.prepare(`
    SELECT ${REPORT_COLUMNS.join(", ")}
    FROM ${REPORT_TABLE}
    WHERE report_id = ? OR version_key = ?
    LIMIT 2
  `).bind(reportId, versionKey).all();
  return rows?.results ?? [];
}

async function lookupSpeciesRows(db, reportId) {
  const rows = await db.prepare(`
    SELECT ${SPECIES_COLUMNS.join(", ")}
    FROM ${SPECIES_TABLE}
    WHERE report_id = ?
    ORDER BY species_id
  `).bind(reportId).all();
  return rows?.results ?? [];
}

async function existingReportResult(db, rows, candidate, cryptoImpl) {
  if (rows.length !== 1) {
    throw new FixedNodeObservationIntegrityError("Multiple rows matched one fixed-node report version.");
  }
  const row = rows[0];
  const verified = await verifyStoredReport(row, cryptoImpl);
  const speciesRows = await lookupSpeciesRows(db, row.report_id);
  verifyStoredSpeciesRows(speciesRows, verified.materialized.species);
  if (
    row.report_id !== candidate.reportId
    || row.version_key !== candidate.versionKey
    || row.identity_key !== candidate.identityKey
    || row.semantic_hash !== candidate.semanticHash
    || verified.materialized.semanticJson !== candidate.semanticJson
  ) {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node report does not match the requested semantic version.");
  }
  return reportResult(verified.materialized, false, row.stored_at);
}

async function verifyStoredReport(row, cryptoImpl) {
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node report payload is not valid JSON.");
  }
  let materialized;
  try {
    materialized = await materializeFixedNodeDailyReport(payload, row.stored_at, cryptoImpl);
  } catch {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node report payload cannot be verified.");
  }
  if (canonicalFixedNodeReportJson(materialized.report) !== row.payload_json) {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node report payload is not canonical.");
  }
  if (
    row.report_id !== materialized.reportId
    || row.version_key !== materialized.versionKey
    || row.identity_key !== materialized.identityKey
    || row.semantic_hash !== materialized.semanticHash
    || row.facility_id !== materialized.facilityId
    || row.provider_id !== materialized.providerId
    || row.observation_date !== materialized.observationDate
    || row.source_record_id !== materialized.sourceRecordId
    || row.source_run_id !== materialized.sourceRunId
    || row.published_at !== materialized.publishedAt
    || row.collected_at !== materialized.collectedAt
    || row.visitor_count !== materialized.visitorCount
    || row.operating_status !== materialized.operatingStatus
    || row.report_completeness !== materialized.reportCompleteness
    || row.normalized_schema_version !== FIXED_NODE_OBSERVATION_SCHEMA_VERSION
    || row.source_url !== materialized.sourceUrl
  ) {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node report columns do not match its payload.");
  }
  return { materialized };
}

function verifyStoredSpeciesRows(rows, expected) {
  if (rows.length !== expected.length) {
    throw new FixedNodeObservationIntegrityError("Stored fixed-node species row count does not match its report payload.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = rows[index];
    const candidate = expected[index];
    if (
      row.observation_id !== candidate.observationId
      || row.report_id !== candidate.reportId
      || row.facility_id !== candidate.facilityId
      || row.observation_date !== candidate.observationDate
      || row.species_id !== candidate.speciesId
      || row.source_labels_json !== candidate.sourceLabelsJson
      || row.catch_count !== candidate.catchCount
      || row.presence_state !== candidate.presenceState
      || row.min_size_cm !== candidate.minSizeCm
      || row.max_size_cm !== candidate.maxSizeCm
      || row.area_labels_json !== candidate.areaLabelsJson
      || row.completeness !== candidate.completeness
      || row.alias_coverage !== candidate.aliasCoverage
    ) {
      throw new FixedNodeObservationIntegrityError("Stored fixed-node species rows do not match the report payload.");
    }
  }
}

function validateReportForPersistence(report) {
  const input = { ...report };
  delete input.facilitySourceIdentity;
  delete input.reportIdentity;
  const built = buildFixedNodeDailyReport(input);
  if (!built.valid || !built.report) {
    throw new FixedNodeObservationIntegrityError(`Fixed-node report is invalid: ${built.errors.join(" ")}`);
  }
  if (
    report?.facilitySourceIdentity !== undefined
    && report.facilitySourceIdentity !== built.report.facilitySourceIdentity
  ) {
    throw new FixedNodeObservationIntegrityError("facilitySourceIdentity does not match the facility registry.");
  }
  if (report?.reportIdentity !== undefined && report.reportIdentity !== built.report.reportIdentity) {
    throw new FixedNodeObservationIntegrityError("reportIdentity does not match report fields.");
  }
  return built.report;
}

function reportResult(candidate, created, storedAt = candidate.storedAt) {
  return {
    reportId: candidate.reportId,
    versionKey: candidate.versionKey,
    semanticHash: candidate.semanticHash,
    storedAt,
    created,
    report: candidate.report
  };
}

function insertSql(table, columns) {
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
}

function reportRowParams(row) {
  return [
    row.reportId,
    row.versionKey,
    row.identityKey,
    row.semanticHash,
    row.facilityId,
    row.providerId,
    row.observationDate,
    row.sourceRecordId,
    row.sourceRunId,
    row.publishedAt,
    row.collectedAt,
    row.storedAt,
    row.visitorCount,
    row.operatingStatus,
    row.reportCompleteness,
    row.normalizedSchemaVersion,
    row.sourceUrl,
    row.payloadJson
  ];
}

function speciesRowParams(row) {
  return [
    row.observationId,
    row.reportId,
    row.facilityId,
    row.observationDate,
    row.speciesId,
    row.sourceLabelsJson,
    row.catchCount,
    row.presenceState,
    row.minSizeCm,
    row.maxSizeCm,
    row.areaLabelsJson,
    row.completeness,
    row.aliasCoverage
  ];
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
