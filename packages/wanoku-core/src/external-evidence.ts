import {
  JAPANESE_SEABASS_SCIENTIFIC_NAME,
  JAPANESE_SEABASS_SPECIES_ID
} from "./seabass-state";

export const SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION = "wanoku-seabass-external-evidence.v1";
export const JAPANESE_SEABASS_EXTERNAL_EVIDENCE_SPECIES_ID = JAPANESE_SEABASS_SPECIES_ID;

export const SEABASS_EXTERNAL_EVIDENCE_TYPES = [
  "fish-observation",
  "catch",
  "bite-or-contact",
  "explicit-effort-zero-catch",
  "survey-detection"
] as const;
export const SEABASS_EXTERNAL_EVIDENCE_SOURCE_CLASSES = [
  "official-survey",
  "scientific-study",
  "charter-or-guide-log",
  "structured-angler-log",
  "social-or-blog",
  "user-observation",
  "other"
] as const;
export const SEABASS_EXTERNAL_EVIDENCE_EXTRACTION_METHODS = [
  "structured-source",
  "deterministic-parser",
  "ai-assisted",
  "manual"
] as const;
export const SEABASS_EXTERNAL_EVIDENCE_MAPPING_METHODS = [
  "exact-coordinate",
  "reviewed-manual",
  "source-area",
  "nearest-node",
  "unknown"
] as const;
export const SEABASS_EXTERNAL_EVIDENCE_MAPPING_STATUSES = ["exact", "approximate", "unknown"] as const;
export const SEABASS_EXTERNAL_EVIDENCE_QUALITY_FLAGS = [
  "event-time-approximate",
  "event-time-day-only",
  "event-daypart-night-explicit",
  "location-approximate",
  "location-unknown",
  "publication-time-day-only-conservative",
  "publication-time-unknown",
  "effort-unknown",
  "species-identification-unverified"
] as const;

export type SeabassExternalEvidenceType = typeof SEABASS_EXTERNAL_EVIDENCE_TYPES[number];
export type SeabassExternalEvidenceSourceClass = typeof SEABASS_EXTERNAL_EVIDENCE_SOURCE_CLASSES[number];
export type SeabassExternalEvidenceExtractionMethod = typeof SEABASS_EXTERNAL_EVIDENCE_EXTRACTION_METHODS[number];
export type SeabassExternalEvidenceMappingMethod = typeof SEABASS_EXTERNAL_EVIDENCE_MAPPING_METHODS[number];
export type SeabassExternalEvidenceMappingStatus = typeof SEABASS_EXTERNAL_EVIDENCE_MAPPING_STATUSES[number];
export type SeabassExternalEvidenceQualityFlag = typeof SEABASS_EXTERNAL_EVIDENCE_QUALITY_FLAGS[number];
export type SeabassExternalEvidencePresenceSupport = "positive" | "none";
export type SeabassExternalEvidenceCatchOutcome = "positive" | "explicit-zero" | "unknown";

export type SeabassExternalEvidenceInput = {
  schemaVersion: typeof SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION;
  species: {
    id: typeof JAPANESE_SEABASS_EXTERNAL_EVIDENCE_SPECIES_ID;
    scientificName: typeof JAPANESE_SEABASS_SCIENTIFIC_NAME;
  };
  evidenceType: SeabassExternalEvidenceType;
  eventStartAt: string;
  eventEndAt: string | null;
  publishedAt: string | null;
  collectedAt: string;
  presenceSupport: SeabassExternalEvidencePresenceSupport;
  catchOutcome: SeabassExternalEvidenceCatchOutcome;
  directFishEvidence: boolean;
  catchCount: number | null;
  effort: {
    known: boolean;
    durationMinutes: number | null;
    anglerCount: number | null;
    targetSpeciesExplicit: boolean | null;
  };
  location: {
    rawLabel: string | null;
    latitude: number | null;
    longitude: number | null;
    mappedNodeId: string | null;
    mapping: {
      method: SeabassExternalEvidenceMappingMethod;
      status: SeabassExternalEvidenceMappingStatus;
    };
  };
  source: {
    providerId: string;
    sourceClass: SeabassExternalEvidenceSourceClass;
    sourceRecordId: string;
    sourceEventKey?: string | null;
    sourceUrl: string | null;
    title: string | null;
  };
  provenance: {
    extractionMethod: SeabassExternalEvidenceExtractionMethod;
    extractorVersion: string;
    mappingVersion: string;
  };
  qualityFlags: SeabassExternalEvidenceQualityFlag[];
};

export type SeabassExternalEvidence = Omit<SeabassExternalEvidenceInput, "source"> & {
  source: Omit<SeabassExternalEvidenceInput["source"], "sourceEventKey"> & {
    sourceEventKey: string | null;
  };
  sourceIdentity: string;
};

export type SeabassEvidenceSemanticContent = {
  schemaVersion: typeof SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION;
  species: SeabassExternalEvidence["species"];
  source: Pick<
    SeabassExternalEvidence["source"],
    "providerId" | "sourceRecordId" | "sourceEventKey" | "sourceClass"
  >;
  evidenceType: SeabassExternalEvidenceType;
  eventStartAt: string;
  eventEndAt: string | null;
  publishedAt: string | null;
  presenceSupport: SeabassExternalEvidencePresenceSupport;
  catchOutcome: SeabassExternalEvidenceCatchOutcome;
  directFishEvidence: boolean;
  catchCount: number | null;
  effort: SeabassExternalEvidence["effort"];
  location: SeabassExternalEvidence["location"];
  qualityFlags: SeabassExternalEvidenceQualityFlag[];
};

export type SeabassExternalEvidenceValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  evidence: SeabassExternalEvidence | null;
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "species",
  "evidenceType",
  "eventStartAt",
  "eventEndAt",
  "publishedAt",
  "collectedAt",
  "presenceSupport",
  "catchOutcome",
  "directFishEvidence",
  "catchCount",
  "effort",
  "location",
  "source",
  "provenance",
  "qualityFlags"
] as const;

export function buildSeabassExternalEvidence(
  value: unknown,
  knownNodeIds: readonly string[] = []
): SeabassExternalEvidenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["evidence must be an object."], warnings, evidence: null };
  }

  rejectUnsupportedFields(value, TOP_LEVEL_FIELDS, "evidence", errors);
  requireFields(value, TOP_LEVEL_FIELDS, "evidence", errors);
  if (value.schemaVersion !== SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION}.`);
  }
  validateSpecies(value.species, errors);
  if (!includes(SEABASS_EXTERNAL_EVIDENCE_TYPES, value.evidenceType)) errors.push("evidenceType is invalid.");
  validateTemporalFields(value, errors);
  validateEvidenceSemantics(value, errors);
  validateEffort(value.effort, value.evidenceType, errors);
  validateLocation(value.location, knownNodeIds, errors);
  validateSource(value.source, errors);
  validateProvenance(value.provenance, errors);
  validateQualityFlags(value.qualityFlags, errors);

  if (errors.length > 0) return { valid: false, errors: unique(errors), warnings, evidence: null };
  const input = value as unknown as SeabassExternalEvidenceInput;
  const evidence: SeabassExternalEvidence = {
    schemaVersion: input.schemaVersion,
    species: { ...input.species },
    sourceIdentity: seabassExternalEvidenceSourceIdentity(
      input.source.providerId,
      input.source.sourceRecordId,
      input.source.sourceEventKey ?? null
    ),
    evidenceType: input.evidenceType,
    eventStartAt: input.eventStartAt,
    eventEndAt: input.eventEndAt,
    publishedAt: input.publishedAt,
    collectedAt: input.collectedAt,
    presenceSupport: input.presenceSupport,
    catchOutcome: input.catchOutcome,
    directFishEvidence: input.directFishEvidence,
    catchCount: input.catchCount,
    effort: { ...input.effort },
    location: {
      ...input.location,
      mapping: { ...input.location.mapping }
    },
    source: {
      ...input.source,
      sourceEventKey: input.source.sourceEventKey ?? null
    },
    provenance: { ...input.provenance },
    qualityFlags: [...input.qualityFlags]
  };
  return { valid: true, errors: [], warnings, evidence };
}

export function buildSeabassEvidenceSemanticContent(
  evidence: SeabassExternalEvidence
): SeabassEvidenceSemanticContent {
  return {
    schemaVersion: evidence.schemaVersion,
    species: { ...evidence.species },
    source: {
      providerId: evidence.source.providerId,
      sourceRecordId: evidence.source.sourceRecordId,
      sourceEventKey: evidence.source.sourceEventKey,
      sourceClass: evidence.source.sourceClass
    },
    evidenceType: evidence.evidenceType,
    eventStartAt: evidence.eventStartAt,
    eventEndAt: evidence.eventEndAt,
    publishedAt: evidence.publishedAt,
    presenceSupport: evidence.presenceSupport,
    catchOutcome: evidence.catchOutcome,
    directFishEvidence: evidence.directFishEvidence,
    catchCount: evidence.catchCount,
    effort: { ...evidence.effort },
    location: {
      ...evidence.location,
      mapping: { ...evidence.location.mapping }
    },
    qualityFlags: [...evidence.qualityFlags]
  };
}

export function seabassExternalEvidenceSourceIdentity(
  providerId: string,
  sourceRecordId: string,
  sourceEventKey: string | null
): string {
  return JSON.stringify([providerId, sourceRecordId, sourceEventKey]);
}

function validateSpecies(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("species must be an object.");
    return;
  }
  rejectUnsupportedFields(value, ["id", "scientificName"], "species", errors);
  requireFields(value, ["id", "scientificName"], "species", errors);
  if (value.id !== JAPANESE_SEABASS_EXTERNAL_EVIDENCE_SPECIES_ID) errors.push("species.id must be japanese-seabass.");
  if (value.scientificName !== JAPANESE_SEABASS_SCIENTIFIC_NAME) {
    errors.push(`species.scientificName must be ${JAPANESE_SEABASS_SCIENTIFIC_NAME}.`);
  }
}

function validateTemporalFields(value: Record<string, unknown>, errors: string[]): void {
  if (!isCanonicalUtcIsoDateTime(value.eventStartAt)) errors.push("eventStartAt must be canonical UTC ISO datetime.");
  if (value.eventEndAt !== null && !isCanonicalUtcIsoDateTime(value.eventEndAt)) {
    errors.push("eventEndAt must be null or canonical UTC ISO datetime.");
  }
  if (value.publishedAt !== null && !isCanonicalUtcIsoDateTime(value.publishedAt)) {
    errors.push("publishedAt must be null or canonical UTC ISO datetime.");
  }
  if (!isCanonicalUtcIsoDateTime(value.collectedAt)) errors.push("collectedAt must be canonical UTC ISO datetime.");
  if (
    isCanonicalUtcIsoDateTime(value.eventStartAt)
    && isCanonicalUtcIsoDateTime(value.eventEndAt)
    && Date.parse(value.eventEndAt) < Date.parse(value.eventStartAt)
  ) {
    errors.push("eventEndAt must be >= eventStartAt.");
  }
  if (
    isCanonicalUtcIsoDateTime(value.eventStartAt)
    && isCanonicalUtcIsoDateTime(value.collectedAt)
    && Date.parse(value.eventStartAt) > Date.parse(value.collectedAt)
  ) {
    errors.push("eventStartAt must be <= collectedAt.");
  }
  if (
    isCanonicalUtcIsoDateTime(value.eventEndAt)
    && isCanonicalUtcIsoDateTime(value.collectedAt)
    && Date.parse(value.eventEndAt) > Date.parse(value.collectedAt)
  ) {
    errors.push("eventEndAt must be <= collectedAt.");
  }
  if (
    isCanonicalUtcIsoDateTime(value.publishedAt)
    && isCanonicalUtcIsoDateTime(value.collectedAt)
    && Date.parse(value.publishedAt) > Date.parse(value.collectedAt)
  ) {
    errors.push("publishedAt must be <= collectedAt.");
  }
}

function validateEvidenceSemantics(value: Record<string, unknown>, errors: string[]): void {
  if (!includes(["positive", "none"] as const, value.presenceSupport)) errors.push("presenceSupport is invalid.");
  if (!includes(["positive", "explicit-zero", "unknown"] as const, value.catchOutcome)) errors.push("catchOutcome is invalid.");
  if (typeof value.directFishEvidence !== "boolean") errors.push("directFishEvidence must be boolean.");
  if (value.catchCount !== null && (!Number.isInteger(value.catchCount) || Number(value.catchCount) < 0)) {
    errors.push("catchCount must be null or a non-negative integer.");
  }

  if (value.evidenceType === "catch" || value.catchOutcome === "positive") {
    if (!Number.isInteger(value.catchCount) || Number(value.catchCount) <= 0) errors.push("positive catch evidence requires catchCount > 0.");
    if (value.presenceSupport !== "positive") errors.push("positive catch evidence requires presenceSupport positive.");
    if (value.catchOutcome !== "positive") errors.push("catch evidence requires catchOutcome positive.");
    if (value.directFishEvidence !== true) errors.push("positive catch evidence requires directFishEvidence true.");
  }
  if (["fish-observation", "bite-or-contact", "survey-detection"].includes(String(value.evidenceType))) {
    if (value.presenceSupport !== "positive") errors.push(`${String(value.evidenceType)} requires presenceSupport positive.`);
    if (value.catchOutcome !== "unknown") errors.push(`${String(value.evidenceType)} requires catchOutcome unknown.`);
    if (value.directFishEvidence !== true) errors.push(`${String(value.evidenceType)} requires directFishEvidence true.`);
    if (value.catchCount !== null) errors.push(`${String(value.evidenceType)} requires catchCount null.`);
  }
  if (
    value.evidenceType === "bite-or-contact"
    && Array.isArray(value.qualityFlags)
    && value.qualityFlags.includes("species-identification-unverified")
  ) {
    errors.push("bite-or-contact requires explicit Japanese seabass attribution.");
  }
  if (value.evidenceType === "explicit-effort-zero-catch" || value.catchOutcome === "explicit-zero") {
    if (value.evidenceType !== "explicit-effort-zero-catch") errors.push("catchOutcome explicit-zero requires evidenceType explicit-effort-zero-catch.");
    if (value.catchOutcome !== "explicit-zero") errors.push("explicit-effort-zero-catch requires catchOutcome explicit-zero.");
    if (value.catchCount !== 0) errors.push("explicit-effort-zero-catch requires catchCount 0.");
    if (value.presenceSupport !== "none") errors.push("explicit-effort-zero-catch requires presenceSupport none.");
    if (value.directFishEvidence !== false) errors.push("explicit-effort-zero-catch requires directFishEvidence false.");
  }
}

function validateEffort(value: unknown, evidenceType: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("effort must be an object.");
    return;
  }
  const fields = ["known", "durationMinutes", "anglerCount", "targetSpeciesExplicit"] as const;
  rejectUnsupportedFields(value, fields, "effort", errors);
  requireFields(value, fields, "effort", errors);
  if (typeof value.known !== "boolean") errors.push("effort.known must be boolean.");
  if (value.durationMinutes !== null && (!Number.isInteger(value.durationMinutes) || Number(value.durationMinutes) <= 0)) {
    errors.push("effort.durationMinutes must be null or a positive integer.");
  }
  if (value.anglerCount !== null && (!Number.isInteger(value.anglerCount) || Number(value.anglerCount) <= 0)) {
    errors.push("effort.anglerCount must be null or a positive integer.");
  }
  if (value.targetSpeciesExplicit !== null && typeof value.targetSpeciesExplicit !== "boolean") {
    errors.push("effort.targetSpeciesExplicit must be null or boolean.");
  }
  if (evidenceType === "explicit-effort-zero-catch") {
    if (value.known !== true) errors.push("explicit-effort-zero-catch requires effort.known true.");
    if (value.targetSpeciesExplicit !== true) errors.push("explicit-effort-zero-catch requires effort.targetSpeciesExplicit true.");
    if (value.durationMinutes === null && value.anglerCount === null) {
      errors.push("explicit-effort-zero-catch requires explicit durationMinutes or anglerCount.");
    }
  }
}

function validateLocation(value: unknown, knownNodeIds: readonly string[], errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("location must be an object.");
    return;
  }
  const fields = ["rawLabel", "latitude", "longitude", "mappedNodeId", "mapping"] as const;
  rejectUnsupportedFields(value, fields, "location", errors);
  requireFields(value, fields, "location", errors);
  validateNullableString(value.rawLabel, "location.rawLabel", 500, errors);
  const hasLatitude = value.latitude !== null;
  const hasLongitude = value.longitude !== null;
  if (hasLatitude !== hasLongitude) errors.push("location.latitude and longitude must be provided together.");
  if (hasLatitude && (!isFiniteNumber(value.latitude) || Number(value.latitude) < -90 || Number(value.latitude) > 90)) {
    errors.push("location.latitude must be null or -90..90.");
  }
  if (hasLongitude && (!isFiniteNumber(value.longitude) || Number(value.longitude) < -180 || Number(value.longitude) > 180)) {
    errors.push("location.longitude must be null or -180..180.");
  }
  validateNullableString(value.mappedNodeId, "location.mappedNodeId", 200, errors);
  if (typeof value.mappedNodeId === "string" && knownNodeIds.length > 0 && !knownNodeIds.includes(value.mappedNodeId)) {
    errors.push("location.mappedNodeId is not a known Habitat node.");
  }
  if (!isRecord(value.mapping)) {
    errors.push("location.mapping must be an object.");
    return;
  }
  rejectUnsupportedFields(value.mapping, ["method", "status"], "location.mapping", errors);
  requireFields(value.mapping, ["method", "status"], "location.mapping", errors);
  if (!includes(SEABASS_EXTERNAL_EVIDENCE_MAPPING_METHODS, value.mapping.method)) errors.push("location.mapping.method is invalid.");
  if (!includes(SEABASS_EXTERNAL_EVIDENCE_MAPPING_STATUSES, value.mapping.status)) errors.push("location.mapping.status is invalid.");

  if (value.mapping.method === "source-area") {
    if (value.mappedNodeId !== null) errors.push("source-area location must not be assigned to an exact Habitat node.");
    if (value.mapping.status === "exact") errors.push("source-area location cannot have exact mapping status.");
  }
  if (value.mapping.method === "unknown") {
    if (value.mappedNodeId !== null || value.mapping.status !== "unknown") {
      errors.push("unknown mapping requires mappedNodeId null and status unknown.");
    }
  }
  if (value.mapping.method === "nearest-node") {
    if (!hasLatitude || !hasLongitude || typeof value.mappedNodeId !== "string") {
      errors.push("nearest-node mapping requires coordinates and mappedNodeId.");
    }
    if (value.mapping.status !== "approximate") errors.push("nearest-node mapping must have approximate status.");
  }
  if (value.mapping.method === "exact-coordinate") {
    if (!hasLatitude || !hasLongitude || typeof value.mappedNodeId !== "string") {
      errors.push("exact-coordinate mapping requires coordinates and mappedNodeId.");
    }
    if (value.mapping.status !== "exact") errors.push("exact-coordinate mapping must have exact status.");
  }
  if (value.mapping.method === "reviewed-manual" && typeof value.mappedNodeId !== "string") {
    errors.push("reviewed-manual mapping requires mappedNodeId.");
  }
}

function validateSource(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("source must be an object.");
    return;
  }
  const fields = ["providerId", "sourceClass", "sourceRecordId", "sourceEventKey", "sourceUrl", "title"] as const;
  rejectUnsupportedFields(value, fields, "source", errors);
  requireFields(value, ["providerId", "sourceClass", "sourceRecordId", "sourceUrl", "title"], "source", errors);
  validateRequiredString(value.providerId, "source.providerId", 200, errors);
  if (!includes(SEABASS_EXTERNAL_EVIDENCE_SOURCE_CLASSES, value.sourceClass)) errors.push("source.sourceClass is invalid.");
  validateRequiredString(value.sourceRecordId, "source.sourceRecordId", 500, errors);
  validateNullableNonEmptyString(value.sourceEventKey ?? null, "source.sourceEventKey", 500, errors);
  if (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) errors.push("source.sourceUrl must be null or an HTTP(S) URL.");
  validateNullableString(value.title, "source.title", 500, errors);
}

function validateProvenance(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("provenance must be an object.");
    return;
  }
  const fields = ["extractionMethod", "extractorVersion", "mappingVersion"] as const;
  rejectUnsupportedFields(value, fields, "provenance", errors);
  requireFields(value, fields, "provenance", errors);
  if (!includes(SEABASS_EXTERNAL_EVIDENCE_EXTRACTION_METHODS, value.extractionMethod)) {
    errors.push("provenance.extractionMethod is invalid.");
  }
  validateRequiredString(value.extractorVersion, "provenance.extractorVersion", 200, errors);
  validateRequiredString(value.mappingVersion, "provenance.mappingVersion", 200, errors);
}

function validateQualityFlags(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("qualityFlags must be an array.");
    return;
  }
  const seen = new Set<string>();
  for (const [index, flag] of value.entries()) {
    if (!includes(SEABASS_EXTERNAL_EVIDENCE_QUALITY_FLAGS, flag)) errors.push(`qualityFlags[${index}] is invalid.`);
    if (typeof flag === "string" && seen.has(flag)) errors.push(`qualityFlags contains duplicate: ${flag}.`);
    if (typeof flag === "string") seen.add(flag);
  }
}

function requireFields(value: Record<string, unknown>, fields: readonly string[], label: string, errors: string[]): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${label}.${field} is required.`);
  }
}

function rejectUnsupportedFields(value: Record<string, unknown>, fields: readonly string[], label: string, errors: string[]): void {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label}.${field} is not supported.`);
  }
}

function validateRequiredString(value: unknown, label: string, maxLength: number, errors: string[]): void {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    errors.push(`${label} must be a non-empty string up to ${maxLength} characters.`);
  }
}

function validateNullableString(value: unknown, label: string, maxLength: number, errors: string[]): void {
  if (value !== null && (typeof value !== "string" || value.length > maxLength)) {
    errors.push(`${label} must be null or a string up to ${maxLength} characters.`);
  }
}

function validateNullableNonEmptyString(value: unknown, label: string, maxLength: number, errors: string[]): void {
  if (value !== null && (typeof value !== "string" || value.trim() === "" || value.length > maxLength)) {
    errors.push(`${label} must be null or a non-empty string up to ${maxLength} characters.`);
  }
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
