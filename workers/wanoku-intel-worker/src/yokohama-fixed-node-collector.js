import {
  FIXED_COASTAL_FACILITIES,
  FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
  FIXED_NODE_SPECIES_IDS,
  buildFixedNodeDailyReport,
  fixedNodeSpeciesIdFromAuditGroup
} from "../../../packages/wanoku-core/src/fixed-node-observation.ts";
import { canonicalHydroCoastalJson } from "./hydro-coastal-persistence.js";
import { sha256HexFromBytes } from "./jma-tide-prediction-ingestion.js";
import {
  materializeFixedNodeDailyReport,
  persistFixedNodeDailyReport
} from "./fixed-node-observation-persistence.js";
import {
  YOKOHAMA_FIXED_NODE_PROVIDER_ID,
  fetchYokohamaFixedNodeDailySource
} from "./yokohama-fixed-node-source.js";

export const YOKOHAMA_FIXED_NODE_COLLECTOR_SCHEMA_VERSION = "wanoku-yokohama-fixed-node-collector.v1";
export const YOKOHAMA_FIXED_NODE_COLLECTOR_MODEL_VERSION = "wanoku-yokohama-fixed-node-collector-v1";

const TEXT_ENCODER = new TextEncoder();
const SOURCE_RUN_COLUMNS = [
  "id",
  "provider",
  "node_id",
  "requested_at",
  "completed_at",
  "status",
  "http_status",
  "error_code",
  "model_version",
  "raw_hash",
  "normalized_schema_version"
];
const SPECIES_GROUP_BY_ID = Object.freeze({
  "japanese-seabass": "seabass",
  sardine: "sardine",
  sappa: "sappa",
  konoshiro: "konoshiro",
  aji: "aji",
  saba: "saba",
  bora: "bora",
  haze: "haze"
});

export async function collectYokohamaFixedNode(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("D1 prepare and batch support are required.");
  }
  const clock = options.now ?? (() => new Date());
  const requestedAt = canonicalNow(options.requestedAt ?? clock(), "requestedAt");
  const collectedAt = canonicalNow(options.collectedAt ?? requestedAt, "collectedAt");
  const storedAt = canonicalNow(options.storedAt ?? collectedAt, "storedAt");
  const observationDate = options.date === undefined ? jstDateAt(requestedAt) : requireIsoDate(options.date);
  const facilities = await readYokohamaFacilityRegistry(db);
  const source = await fetchYokohamaFixedNodeDailySource({
    observationDate,
    collectedAt,
    facilities,
    fetchImpl: options.fetchImpl
  });
  const rawHash = source.artifacts.length === 0
    ? null
    : await sha256HexFromBytes(TEXT_ENCODER.encode(canonicalHydroCoastalJson(source.artifacts)), options.cryptoImpl ?? globalThis.crypto);
  const sourceRun = await buildSourceRun({
    requestedAt,
    completedAt: collectedAt,
    observationDate,
    rawHash,
    failures: source.failures,
    cryptoImpl: options.cryptoImpl ?? globalThis.crypto
  });
  const sourceRunCreated = await persistSourceRun(db, sourceRun);
  const records = [];
  let reportsCreated = 0;
  let reportsExisting = 0;
  let semanticRevisionsCreated = 0;
  let speciesRowsCreated = 0;
  let speciesRowsExisting = 0;
  let persistenceFailures = 0;

  for (const sourceRecord of source.records) {
    try {
      const report = buildYokohamaFixedNodeReport(sourceRecord, sourceRun.id);
      const materialized = await materializeFixedNodeDailyReport(report, storedAt, options.cryptoImpl ?? globalThis.crypto);
      const priorRevision = await hasPriorReportIdentity(db, materialized.identityKey);
      const persisted = await persistFixedNodeDailyReport(db, {
        report,
        storedAt,
        cryptoImpl: options.cryptoImpl ?? globalThis.crypto
      });
      if (persisted.created) {
        reportsCreated += 1;
        speciesRowsCreated += persisted.report.species.length;
        if (priorRevision) semanticRevisionsCreated += 1;
      } else {
        reportsExisting += 1;
        speciesRowsExisting += persisted.report.species.length;
      }
      records.push(summaryRecord(sourceRecord, persisted, priorRevision));
    } catch (error) {
      persistenceFailures += 1;
      records.push({
        facilityId: sourceRecord.facilityId,
        sourceRecordId: sourceRecord.sourceRecordId,
        observationDate: sourceRecord.observationDate,
        status: "FAILED",
        reason: "persistence_error",
        diagnostics: [safeMessage(error)]
      });
    }
  }
  for (const failure of source.failures) {
    records.push({
      facilityId: failure.facilityId,
      sourceRecordId: null,
      observationDate,
      status: "FAILED",
      reason: failure.code,
      httpStatus: failure.httpStatus,
      diagnostics: [failure.message]
    });
  }
  const failed = source.failures.length + persistenceFailures;
  return {
    ok: failed === 0,
    schemaVersion: YOKOHAMA_FIXED_NODE_COLLECTOR_SCHEMA_VERSION,
    observationDate,
    requestedAt,
    collectedAt,
    sourceRunId: sourceRun.id,
    sourceRunCreated,
    facilitiesRequested: facilities.length,
    facilitiesFetched: source.facilitiesFetched,
    reportsGenerated: source.records.length,
    reportsCreated,
    reportsExisting,
    semanticRevisionsCreated,
    speciesRowsCreated,
    speciesRowsExisting,
    skipped: 0,
    failed,
    remoteReads: source.remoteReads,
    records
  };
}

export function buildYokohamaFixedNodeReport(sourceRecord, sourceRunId) {
  if (!sourceRecord || sourceRecord.providerId !== YOKOHAMA_FIXED_NODE_PROVIDER_ID) {
    throw new Error("Yokohama source record is invalid.");
  }
  const reportCompleteness = sourceRecord.reportComplete
    ? "complete"
    : sourceRecord.operatingStatus === "operating"
      ? "incomplete"
      : "unknown";
  const species = FIXED_NODE_SPECIES_IDS.map((speciesId) => normalizeSpecies(sourceRecord, speciesId, reportCompleteness));
  const built = buildFixedNodeDailyReport({
    schemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
    providerId: sourceRecord.providerId,
    facilityId: sourceRecord.facilityId,
    sourceRecordId: sourceRecord.sourceRecordId,
    sourceUrl: sourceRecord.sourceUrl,
    sourceRunId,
    observationDate: sourceRecord.observationDate,
    publishedAt: sourceRecord.publishedAt,
    collectedAt: sourceRecord.collectedAt,
    visitorCount: sourceRecord.visitors,
    operatingStatus: sourceRecord.operatingStatus,
    reportCompleteness,
    species
  });
  if (!built.valid || !built.report) throw new Error(`Yokohama fixed-node report is invalid: ${built.errors.join(" ")}`);
  return built.report;
}

export function jstDateAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("clock value is invalid.");
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function readYokohamaFacilityRegistry(db) {
  const rows = await db.prepare(`
    SELECT facility_id, provider_id, provider_facility_key, display_name
    FROM fixed_coastal_facilities
    WHERE provider_id = ?
    ORDER BY facility_id
  `).bind(YOKOHAMA_FIXED_NODE_PROVIDER_ID).all();
  const facilities = (rows?.results ?? []).map((row) => ({
    facilityId: row.facility_id,
    providerId: row.provider_id,
    providerFacilityKey: row.provider_facility_key,
    displayName: row.display_name
  }));
  const expectedIds = FIXED_COASTAL_FACILITIES
    .filter((facility) => facility.providerId === YOKOHAMA_FIXED_NODE_PROVIDER_ID)
    .map((facility) => `${facility.facilityId}:${facility.providerFacilityKey}`)
    .sort();
  const actualIds = facilities.map((facility) => `${facility.facilityId}:${facility.providerFacilityKey}`).sort();
  if (canonicalHydroCoastalJson(actualIds) !== canonicalHydroCoastalJson(expectedIds)) {
    throw new Error("Yokohama facility DB registry is incomplete or unexpected.");
  }
  return facilities;
}

function normalizeSpecies(sourceRecord, speciesId, reportCompleteness) {
  const group = SPECIES_GROUP_BY_ID[speciesId];
  if (fixedNodeSpeciesIdFromAuditGroup(group) !== speciesId) throw new Error(`Unsupported Yokohama species: ${speciesId}`);
  const rows = sourceRecord.species.filter((row) => row.canonicalGroup === group);
  const sourceLabels = unique(rows.map((row) => row.sourceName));
  const areaLabels = unique(rows.flatMap((row) => row.areaLabels));
  const countsKnown = rows.length > 0 && rows.every((row) => row.countKnown);
  const count = countsKnown ? rows.reduce((total, row) => total + row.count, 0) : null;
  let catchCount = null;
  let presenceState = "unknown";
  if (count !== null && count > 0) {
    catchCount = count;
    presenceState = "present";
  } else if (sourceRecord.operatingStatus === "operating" && reportCompleteness === "complete") {
    catchCount = count ?? 0;
    presenceState = catchCount > 0 ? "present" : "absent";
  }
  const sizeRows = rows.filter((row) => row.sizeUnit?.toLowerCase() === "cm");
  const minimums = sizeRows.map((row) => row.minSize).filter((value) => value !== null);
  const maximums = sizeRows.map((row) => row.maxSize).filter((value) => value !== null);
  return {
    speciesId,
    sourceLabels,
    catchCount,
    presenceState,
    minSizeCm: minimums.length > 0 ? Math.min(...minimums) : null,
    maxSizeCm: maximums.length > 0 ? Math.max(...maximums) : null,
    areaLabels,
    completeness: presenceState === "unknown" ? (reportCompleteness === "complete" ? "unknown" : "incomplete") : "complete",
    aliasCoverage: "sufficient"
  };
}

async function buildSourceRun({ requestedAt, completedAt, observationDate, rawHash, failures, cryptoImpl }) {
  const status = failures.length === 0 ? "ok" : failures.length < 3 ? "partial" : "failed";
  const errorCode = failures.length === 0 ? null : unique(failures.map((failure) => failure.code)).sort().join(",");
  const identity = canonicalHydroCoastalJson([
    YOKOHAMA_FIXED_NODE_PROVIDER_ID,
    observationDate,
    requestedAt,
    completedAt,
    rawHash,
    status,
    errorCode
  ]);
  const hash = await sha256HexFromBytes(TEXT_ENCODER.encode(identity), cryptoImpl);
  return {
    id: `wanoku-fixed-node-yokohama-run:${hash}`,
    provider: YOKOHAMA_FIXED_NODE_PROVIDER_ID,
    nodeId: null,
    requestedAt,
    completedAt,
    status,
    httpStatus: null,
    errorCode,
    modelVersion: YOKOHAMA_FIXED_NODE_COLLECTOR_MODEL_VERSION,
    rawHash,
    normalizedSchemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION
  };
}

async function persistSourceRun(db, run) {
  const existing = await db.prepare(`SELECT ${SOURCE_RUN_COLUMNS.join(", ")} FROM source_runs WHERE id = ?`).bind(run.id).first();
  const params = sourceRunParams(run);
  if (existing) {
    const existingParams = SOURCE_RUN_COLUMNS.map((column) => existing[column]);
    if (canonicalHydroCoastalJson(existingParams) !== canonicalHydroCoastalJson(params)) {
      throw new Error("Yokohama source run id conflict.");
    }
    return false;
  }
  const sql = `INSERT INTO source_runs (${SOURCE_RUN_COLUMNS.join(", ")}) VALUES (${SOURCE_RUN_COLUMNS.map(() => "?").join(", ")})`;
  await db.prepare(sql).bind(...params).run();
  return true;
}

async function hasPriorReportIdentity(db, identityKey) {
  const row = await db.prepare("SELECT report_id FROM fixed_node_daily_reports WHERE identity_key = ? LIMIT 1").bind(identityKey).first();
  return Boolean(row);
}

function sourceRunParams(run) {
  return [
    run.id,
    run.provider,
    run.nodeId,
    run.requestedAt,
    run.completedAt,
    run.status,
    run.httpStatus,
    run.errorCode,
    run.modelVersion,
    run.rawHash,
    run.normalizedSchemaVersion
  ];
}

function summaryRecord(sourceRecord, persisted, priorRevision) {
  const seabass = persisted.report.species.find((row) => row.speciesId === "japanese-seabass");
  return {
    facilityId: sourceRecord.facilityId,
    sourceRecordId: sourceRecord.sourceRecordId,
    observationDate: sourceRecord.observationDate,
    visitorCount: sourceRecord.visitors,
    operatingStatus: sourceRecord.operatingStatus,
    reportCompleteness: persisted.report.reportCompleteness,
    seabassCatch: seabass?.catchCount ?? null,
    speciesCount: persisted.report.species.length,
    sourceAreaFacts: unique(persisted.report.species.flatMap((row) => row.areaLabels)),
    reportId: persisted.reportId,
    status: persisted.created ? (priorRevision ? "REVISION_CREATED" : "CREATED") : "EXISTING",
    diagnostics: sourceRecord.diagnostics
  };
}

function canonicalNow(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return canonical;
}

function requireIsoDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) throw new Error("date must be YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("date must be a valid YYYY-MM-DD date.");
  return value;
}

function safeMessage(error) {
  return String(error?.message ?? "Fixed-node persistence failed.").slice(0, 200);
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
