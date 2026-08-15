import { canonicalHydroCoastalJson } from "./hydro-coastal-persistence.js";
import { sha256HexFromBytes } from "./jma-tide-prediction-ingestion.js";

export const SEABASS_PREDICTION_SNAPSHOT_SCHEMA_VERSION = "wanoku-seabass-prediction-snapshot.v1";
export const SEABASS_PREDICTION_SNAPSHOT_ID_PREFIX = "wanoku-seabass-prediction:";

const SNAPSHOT_TABLE = "seabass_prediction_snapshots";
const SNAPSHOT_COLUMNS = [
  "id",
  "schema_version",
  "species_id",
  "node_id",
  "knowledge_at",
  "target_at",
  "lead_hours",
  "decision_action",
  "payload_hash",
  "payload_json",
  "stored_at",
  "environment_state_schema_version",
  "habitat_state_schema_version",
  "seabass_state_schema_version",
  "decision_schema_version"
];
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();

export class PredictionSnapshotIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "PredictionSnapshotIntegrityError";
    this.code = "prediction_snapshot_integrity_error";
  }
}

export function buildSeabassPredictionSnapshotPayload({
  preview,
  habitatState,
  seabassState,
  decision
}) {
  const payload = {
    schemaVersion: SEABASS_PREDICTION_SNAPSHOT_SCHEMA_VERSION,
    species: { id: preview.species.id },
    nodeId: preview.nodeId,
    knowledgeAt: preview.knowledgeAt,
    targetAt: preview.targetAt,
    leadHours: preview.leadHours,
    environment: {
      tide: { ...preview.environmentSummary.tide },
      atmosphere: { ...preview.environmentSummary.atmosphere },
      marine: { ...preview.environmentSummary.marine }
    },
    habitat: {
      context: { ...preview.habitatSummary.context },
      hydrodynamics: { ...preview.habitatSummary.hydrodynamics },
      exposure: { ...preview.habitatSummary.exposure },
      freshwater: { ...preview.habitatSummary.freshwater },
      disturbance: { ...preview.habitatSummary.disturbance },
      quality: { ...habitatState.quality }
    },
    seabass: {
      presence: { ...seabassState.presence },
      activation: { ...seabassState.activation },
      shoreCatchability: { ...seabassState.shoreCatchability },
      quality: { ...seabassState.quality }
    },
    decision: {
      decision: { ...decision.decision },
      axes: { ...decision.axes },
      drivers: decision.drivers.map((driver) => ({ ...driver })),
      constraints: [...decision.constraints],
      quality: { ...decision.quality }
    },
    provenance: {
      ...preview.provenance,
      ruleVersions: { ...preview.provenance.ruleVersions }
    },
    diagnostics: {
      ...preview.diagnostics,
      environmentalErrors: [...preview.diagnostics.environmentalErrors],
      environmentalWarnings: [...preview.diagnostics.environmentalWarnings],
      hydroCoastalErrors: [...preview.diagnostics.hydroCoastalErrors],
      hydroCoastalWarnings: [...preview.diagnostics.hydroCoastalWarnings],
      habitatUnknownStateReasons: preview.diagnostics.habitatUnknownStateReasons.map((entry) => ({
        field: entry.field,
        reasons: [...entry.reasons]
      })),
      seabassUnknownAxisReasons: preview.diagnostics.seabassUnknownAxisReasons.map((entry) => ({
        field: entry.field,
        reasons: [...entry.reasons]
      })),
      decisionIntegrityFailures: [...preview.diagnostics.decisionIntegrityFailures]
    }
  };

  return JSON.parse(canonicalPredictionSnapshotJson(payload));
}

export function canonicalPredictionSnapshotJson(payload) {
  return canonicalHydroCoastalJson(payload);
}

export async function hashPredictionSnapshotPayload(payload, cryptoImpl = globalThis.crypto) {
  const payloadJson = canonicalPredictionSnapshotJson(payload);
  const payloadHash = await sha256HexFromBytes(TEXT_ENCODER.encode(payloadJson), cryptoImpl);
  return {
    payloadJson,
    payloadHash,
    snapshotId: predictionSnapshotId(payloadHash)
  };
}

export function predictionSnapshotId(payloadHash) {
  if (!SHA256_HEX.test(payloadHash)) throw new Error("payloadHash must be a lowercase SHA-256 hex string.");
  return `${SEABASS_PREDICTION_SNAPSHOT_ID_PREFIX}${payloadHash}`;
}

export async function materializeSeabassPredictionSnapshot(payload, storedAt, cryptoImpl = globalThis.crypto) {
  if (!isCanonicalUtcIsoDateTime(storedAt)) {
    throw new Error("storedAt must be canonical UTC ISO datetime.");
  }
  const identity = await hashPredictionSnapshotPayload(payload, cryptoImpl);
  return {
    id: identity.snapshotId,
    schemaVersion: payload.schemaVersion,
    speciesId: payload.species.id,
    nodeId: payload.nodeId,
    knowledgeAt: payload.knowledgeAt,
    targetAt: payload.targetAt,
    leadHours: payload.leadHours,
    decisionAction: payload.decision.decision.action,
    payloadHash: identity.payloadHash,
    payloadJson: identity.payloadJson,
    storedAt,
    environmentStateSchemaVersion: payload.provenance.environmentStateSchemaVersion,
    habitatStateSchemaVersion: payload.provenance.habitatStateSchemaVersion,
    seabassStateSchemaVersion: payload.provenance.seabassStateSchemaVersion,
    decisionSchemaVersion: payload.provenance.decisionSchemaVersion
  };
}

export async function persistSeabassPredictionSnapshot(
  db,
  { snapshot, storedAt, cryptoImpl = globalThis.crypto }
) {
  const candidate = await materializeSeabassPredictionSnapshot(snapshot, storedAt, cryptoImpl);
  const existingRows = await lookupSnapshotRows(db, candidate.id, candidate.payloadHash);
  if (existingRows.length > 0) {
    return existingSnapshotResult(existingRows, candidate, cryptoImpl);
  }

  try {
    await db.prepare(insertSnapshotSql()).bind(...snapshotRowParams(candidate)).run();
  } catch (error) {
    const racedRows = await lookupSnapshotRows(db, candidate.id, candidate.payloadHash);
    if (racedRows.length > 0) {
      return existingSnapshotResult(racedRows, candidate, cryptoImpl);
    }
    throw error;
  }

  return snapshotResult(candidate, snapshot, true);
}

export async function readSeabassPredictionSnapshot(db, snapshotId, cryptoImpl = globalThis.crypto) {
  const row = await db.prepare(`
    SELECT ${snapshotSelectColumns()}
    FROM ${SNAPSHOT_TABLE}
    WHERE id = ?
    LIMIT 1
  `).bind(snapshotId).first();
  if (!row) return { found: false };

  const verified = await verifySnapshotRow(row, cryptoImpl);
  return {
    found: true,
    snapshotId: row.id,
    payloadHash: row.payload_hash,
    storedAt: row.stored_at,
    snapshot: verified.snapshot
  };
}

async function lookupSnapshotRows(db, snapshotId, payloadHash) {
  const rows = await db.prepare(`
    SELECT ${snapshotSelectColumns()}
    FROM ${SNAPSHOT_TABLE}
    WHERE id = ? OR payload_hash = ?
    LIMIT 2
  `).bind(snapshotId, payloadHash).all();
  return rows?.results ?? [];
}

async function existingSnapshotResult(rows, candidate, cryptoImpl) {
  if (rows.length !== 1) {
    throw new PredictionSnapshotIntegrityError("Multiple rows matched one content-addressed prediction snapshot.");
  }
  const row = rows[0];
  const verified = await verifySnapshotRow(row, cryptoImpl);
  if (
    row.id !== candidate.id
    || row.payload_hash !== candidate.payloadHash
    || row.payload_json !== candidate.payloadJson
  ) {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot does not match the requested content.");
  }
  return snapshotResult(candidate, verified.snapshot, false, row.stored_at);
}

async function verifySnapshotRow(row, cryptoImpl) {
  let snapshot;
  try {
    snapshot = JSON.parse(row.payload_json);
  } catch {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot payload is not valid JSON.");
  }

  let canonicalJson;
  let payloadHash;
  try {
    canonicalJson = canonicalPredictionSnapshotJson(snapshot);
    payloadHash = await sha256HexFromBytes(TEXT_ENCODER.encode(canonicalJson), cryptoImpl);
  } catch {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot payload cannot be verified.");
  }
  if (canonicalJson !== row.payload_json) {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot payload is not canonical.");
  }
  if (payloadHash !== row.payload_hash || predictionSnapshotId(payloadHash) !== row.id) {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot hash or ID does not match its payload.");
  }
  if (
    row.schema_version !== snapshot.schemaVersion
    || row.species_id !== snapshot.species?.id
    || row.node_id !== snapshot.nodeId
    || row.knowledge_at !== snapshot.knowledgeAt
    || row.target_at !== snapshot.targetAt
    || row.lead_hours !== snapshot.leadHours
    || row.decision_action !== snapshot.decision?.decision?.action
    || row.environment_state_schema_version !== snapshot.provenance?.environmentStateSchemaVersion
    || row.habitat_state_schema_version !== snapshot.provenance?.habitatStateSchemaVersion
    || row.seabass_state_schema_version !== snapshot.provenance?.seabassStateSchemaVersion
    || row.decision_schema_version !== snapshot.provenance?.decisionSchemaVersion
  ) {
    throw new PredictionSnapshotIntegrityError("Stored prediction snapshot query columns do not match its payload.");
  }
  return { snapshot, canonicalJson, payloadHash };
}

function snapshotResult(candidate, snapshot, created, storedAt = candidate.storedAt) {
  return {
    snapshotId: candidate.id,
    payloadHash: candidate.payloadHash,
    storedAt,
    created,
    snapshot
  };
}

function insertSnapshotSql() {
  return `INSERT INTO ${SNAPSHOT_TABLE} (${SNAPSHOT_COLUMNS.join(", ")}) VALUES (${SNAPSHOT_COLUMNS.map(() => "?").join(", ")})`;
}

function snapshotRowParams(row) {
  return [
    row.id,
    row.schemaVersion,
    row.speciesId,
    row.nodeId,
    row.knowledgeAt,
    row.targetAt,
    row.leadHours,
    row.decisionAction,
    row.payloadHash,
    row.payloadJson,
    row.storedAt,
    row.environmentStateSchemaVersion,
    row.habitatStateSchemaVersion,
    row.seabassStateSchemaVersion,
    row.decisionSchemaVersion
  ];
}

function snapshotSelectColumns() {
  return SNAPSHOT_COLUMNS.join(", ");
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
