import { canonicalHydroCoastalJson } from "./hydro-coastal-persistence.js";
import { sha256HexFromBytes } from "./jma-tide-prediction-ingestion.js";
import {
  buildSeabassEvidenceSemanticContent,
  seabassExternalEvidenceSourceIdentity
} from "../../../packages/wanoku-core/src/external-evidence.ts";

export const SEABASS_EXTERNAL_EVIDENCE_ID_PREFIX = "wanoku-seabass-evidence:";

const EVIDENCE_TABLE = "seabass_external_evidence";
const EVIDENCE_COLUMNS = [
  "id",
  "payload_hash",
  "schema_version",
  "species_id",
  "source_identity",
  "provider_id",
  "source_class",
  "source_record_id",
  "event_start_at",
  "event_end_at",
  "published_at",
  "collected_at",
  "stored_at",
  "mapped_node_id",
  "evidence_type",
  "presence_support",
  "catch_outcome",
  "payload_json"
];
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TEXT_ENCODER = new TextEncoder();

export class ExternalEvidenceIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalEvidenceIntegrityError";
    this.code = "external_evidence_integrity_error";
  }
}

export function canonicalExternalEvidenceJson(evidence) {
  return canonicalHydroCoastalJson(buildSeabassEvidenceSemanticContent(evidence));
}

export function canonicalExternalEvidencePayloadJson(evidence) {
  return canonicalHydroCoastalJson(evidence);
}

export async function hashSeabassExternalEvidence(evidence, cryptoImpl = globalThis.crypto) {
  const semanticJson = canonicalExternalEvidenceJson(evidence);
  const payloadHash = await sha256HexFromBytes(TEXT_ENCODER.encode(semanticJson), cryptoImpl);
  return {
    semanticJson,
    payloadHash,
    evidenceId: seabassExternalEvidenceId(payloadHash)
  };
}

export function seabassExternalEvidenceId(payloadHash) {
  if (!SHA256_HEX.test(payloadHash)) throw new Error("payloadHash must be a lowercase SHA-256 hex string.");
  return `${SEABASS_EXTERNAL_EVIDENCE_ID_PREFIX}${payloadHash}`;
}

export async function materializeSeabassExternalEvidence(evidence, storedAt, cryptoImpl = globalThis.crypto) {
  if (!isCanonicalUtcIsoDateTime(storedAt)) throw new Error("storedAt must be canonical UTC ISO datetime.");
  const identity = await hashSeabassExternalEvidence(evidence, cryptoImpl);
  return {
    id: identity.evidenceId,
    payloadHash: identity.payloadHash,
    schemaVersion: evidence.schemaVersion,
    speciesId: evidence.species.id,
    sourceIdentity: evidence.sourceIdentity,
    providerId: evidence.source.providerId,
    sourceClass: evidence.source.sourceClass,
    sourceRecordId: evidence.source.sourceRecordId,
    eventStartAt: evidence.eventStartAt,
    eventEndAt: evidence.eventEndAt,
    publishedAt: evidence.publishedAt,
    collectedAt: evidence.collectedAt,
    storedAt,
    mappedNodeId: evidence.location.mappedNodeId,
    evidenceType: evidence.evidenceType,
    presenceSupport: evidence.presenceSupport,
    catchOutcome: evidence.catchOutcome,
    semanticJson: identity.semanticJson,
    payloadJson: canonicalExternalEvidencePayloadJson(evidence)
  };
}

export async function persistSeabassExternalEvidence(
  db,
  { evidence, storedAt, cryptoImpl = globalThis.crypto }
) {
  const candidate = await materializeSeabassExternalEvidence(evidence, storedAt, cryptoImpl);
  const existingRows = await lookupEvidenceRows(db, candidate.id, candidate.payloadHash);
  if (existingRows.length > 0) return existingEvidenceResult(existingRows, candidate, cryptoImpl);

  try {
    await db.prepare(insertEvidenceSql()).bind(...evidenceRowParams(candidate)).run();
  } catch (error) {
    const racedRows = await lookupEvidenceRows(db, candidate.id, candidate.payloadHash);
    if (racedRows.length > 0) return existingEvidenceResult(racedRows, candidate, cryptoImpl);
    throw error;
  }

  return evidenceResult(candidate, evidence, true);
}

export async function readSeabassExternalEvidence(db, evidenceId, cryptoImpl = globalThis.crypto) {
  const row = await db.prepare(`
    SELECT ${evidenceSelectColumns()}
    FROM ${EVIDENCE_TABLE}
    WHERE id = ?
    LIMIT 1
  `).bind(evidenceId).first();
  if (!row) return { found: false };

  const verified = await verifyEvidenceRow(row, cryptoImpl);
  return {
    found: true,
    evidenceId: row.id,
    payloadHash: row.payload_hash,
    storedAt: row.stored_at,
    evidence: verified.evidence
  };
}

async function lookupEvidenceRows(db, evidenceId, payloadHash) {
  const rows = await db.prepare(`
    SELECT ${evidenceSelectColumns()}
    FROM ${EVIDENCE_TABLE}
    WHERE id = ? OR payload_hash = ?
    LIMIT 2
  `).bind(evidenceId, payloadHash).all();
  return rows?.results ?? [];
}

async function existingEvidenceResult(rows, candidate, cryptoImpl) {
  if (rows.length !== 1) {
    throw new ExternalEvidenceIntegrityError("Multiple rows matched one content-addressed external evidence record.");
  }
  const row = rows[0];
  const verified = await verifyEvidenceRow(row, cryptoImpl);
  if (
    row.id !== candidate.id
    || row.payload_hash !== candidate.payloadHash
    || verified.semanticJson !== candidate.semanticJson
  ) {
    throw new ExternalEvidenceIntegrityError("Stored external evidence does not match the requested content.");
  }
  return evidenceResult(candidate, verified.evidence, false, row.stored_at);
}

async function verifyEvidenceRow(row, cryptoImpl) {
  let evidence;
  try {
    evidence = JSON.parse(row.payload_json);
  } catch {
    throw new ExternalEvidenceIntegrityError("Stored external evidence payload is not valid JSON.");
  }

  let canonicalPayloadJson;
  let semanticJson;
  let payloadHash;
  let sourceIdentity;
  try {
    canonicalPayloadJson = canonicalExternalEvidencePayloadJson(evidence);
    semanticJson = canonicalExternalEvidenceJson(evidence);
    payloadHash = await sha256HexFromBytes(TEXT_ENCODER.encode(semanticJson), cryptoImpl);
    sourceIdentity = seabassExternalEvidenceSourceIdentity(
      evidence.source.providerId,
      evidence.source.sourceRecordId,
      evidence.source.sourceEventKey
    );
  } catch {
    throw new ExternalEvidenceIntegrityError("Stored external evidence payload cannot be verified.");
  }
  if (canonicalPayloadJson !== row.payload_json) {
    throw new ExternalEvidenceIntegrityError("Stored external evidence payload is not canonical.");
  }
  if (payloadHash !== row.payload_hash || seabassExternalEvidenceId(payloadHash) !== row.id) {
    throw new ExternalEvidenceIntegrityError("Stored external evidence hash or ID does not match its payload.");
  }
  if (
    row.schema_version !== evidence.schemaVersion
    || row.species_id !== evidence.species?.id
    || row.source_identity !== evidence.sourceIdentity
    || evidence.sourceIdentity !== sourceIdentity
    || row.provider_id !== evidence.source?.providerId
    || row.source_class !== evidence.source?.sourceClass
    || row.source_record_id !== evidence.source?.sourceRecordId
    || row.event_start_at !== evidence.eventStartAt
    || row.event_end_at !== evidence.eventEndAt
    || row.published_at !== evidence.publishedAt
    || row.collected_at !== evidence.collectedAt
    || row.mapped_node_id !== evidence.location?.mappedNodeId
    || row.evidence_type !== evidence.evidenceType
    || row.presence_support !== evidence.presenceSupport
    || row.catch_outcome !== evidence.catchOutcome
  ) {
    throw new ExternalEvidenceIntegrityError("Stored external evidence query columns do not match its payload.");
  }
  return { evidence, canonicalPayloadJson, semanticJson, payloadHash };
}

function evidenceResult(candidate, evidence, created, storedAt = candidate.storedAt) {
  return {
    evidenceId: candidate.id,
    payloadHash: candidate.payloadHash,
    storedAt,
    created,
    evidence
  };
}

function insertEvidenceSql() {
  return `INSERT INTO ${EVIDENCE_TABLE} (${EVIDENCE_COLUMNS.join(", ")}) VALUES (${EVIDENCE_COLUMNS.map(() => "?").join(", ")})`;
}

function evidenceRowParams(row) {
  return [
    row.id,
    row.payloadHash,
    row.schemaVersion,
    row.speciesId,
    row.sourceIdentity,
    row.providerId,
    row.sourceClass,
    row.sourceRecordId,
    row.eventStartAt,
    row.eventEndAt,
    row.publishedAt,
    row.collectedAt,
    row.storedAt,
    row.mappedNodeId,
    row.evidenceType,
    row.presenceSupport,
    row.catchOutcome,
    row.payloadJson
  ];
}

function evidenceSelectColumns() {
  return EVIDENCE_COLUMNS.join(", ");
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
