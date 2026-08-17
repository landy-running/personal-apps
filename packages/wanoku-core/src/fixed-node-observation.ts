export const FIXED_NODE_OBSERVATION_SCHEMA_VERSION = "wanoku-fixed-node-observation.v1";

export const FIXED_NODE_SPECIES_IDS = [
  "japanese-seabass",
  "sardine",
  "sappa",
  "konoshiro",
  "aji",
  "saba",
  "bora",
  "haze"
] as const;

export type FixedNodeSpeciesId = typeof FIXED_NODE_SPECIES_IDS[number];
export type FixedNodeOperatingStatus = "operating" | "closed" | "unknown";
export type FixedNodeCompleteness = "complete" | "incomplete" | "unknown";
export type FixedNodePresenceState = "present" | "absent" | "unknown";
export type FixedNodeAliasCoverage = "sufficient" | "insufficient" | "unknown";

export type FixedCoastalFacility = {
  facilityId: string;
  providerId: string;
  providerFacilityKey: string;
  displayName: string;
  sourceIdentity: string;
  spatialRefId: string | null;
  officialLatitude: number | null;
  officialLongitude: number | null;
  activeFrom: string | null;
  activeTo: string | null;
};

export type FixedNodeSpeciesObservation = {
  speciesId: FixedNodeSpeciesId;
  sourceLabels: string[];
  catchCount: number | null;
  presenceState: FixedNodePresenceState;
  minSizeCm: number | null;
  maxSizeCm: number | null;
  areaLabels: string[];
  completeness: FixedNodeCompleteness;
  aliasCoverage: FixedNodeAliasCoverage;
};

export type FixedNodeDailyReport = {
  schemaVersion: typeof FIXED_NODE_OBSERVATION_SCHEMA_VERSION;
  providerId: string;
  facilityId: string;
  facilitySourceIdentity: string;
  reportIdentity: string;
  sourceRecordId: string;
  sourceUrl: string | null;
  sourceRunId: string;
  observationDate: string;
  publishedAt: string | null;
  collectedAt: string;
  visitorCount: number | null;
  operatingStatus: FixedNodeOperatingStatus;
  reportCompleteness: FixedNodeCompleteness;
  species: FixedNodeSpeciesObservation[];
};

export type FixedNodeDailyReportInput = Omit<
  FixedNodeDailyReport,
  "facilitySourceIdentity" | "reportIdentity"
>;

export type FixedNodeDailyReportValidationResult = {
  valid: boolean;
  errors: string[];
  report: FixedNodeDailyReport | null;
};

export type FixedNodeReportSemanticContent = Omit<
  FixedNodeDailyReport,
  "sourceUrl" | "sourceRunId" | "collectedAt"
>;

export const FIXED_COASTAL_FACILITIES: readonly FixedCoastalFacility[] = Object.freeze([
  facility("yokohama-honmoku", "yokohama-fishing-piers", "honmoku", "Honmoku Fishing Pier"),
  facility("yokohama-daikoku", "yokohama-fishing-piers", "daikoku", "Daikoku Fishing Pier"),
  facility("yokohama-isogo", "yokohama-fishing-piers", "isogo", "Isogo Fishing Pier"),
  facility("ichihara-original-maker", "ichihara-umizuri", "original-maker", "Original Maker Sea Fishing Park")
]);

export const FIXED_NODE_AUDIT_GROUP_TO_SPECIES_ID = Object.freeze({
  seabass: "japanese-seabass",
  sardine: "sardine",
  sappa: "sappa",
  konoshiro: "konoshiro",
  aji: "aji",
  saba: "saba",
  bora: "bora",
  haze: "haze"
} as const satisfies Record<string, FixedNodeSpeciesId>);

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPERATING_STATUSES = ["operating", "closed", "unknown"] as const;
const COMPLETENESS_VALUES = ["complete", "incomplete", "unknown"] as const;
const PRESENCE_STATES = ["present", "absent", "unknown"] as const;
const ALIAS_COVERAGE_VALUES = ["sufficient", "insufficient", "unknown"] as const;
const TOP_LEVEL_INPUT_FIELDS = [
  "schemaVersion",
  "providerId",
  "facilityId",
  "sourceRecordId",
  "sourceUrl",
  "sourceRunId",
  "observationDate",
  "publishedAt",
  "collectedAt",
  "visitorCount",
  "operatingStatus",
  "reportCompleteness",
  "species"
] as const;
const SPECIES_FIELDS = [
  "speciesId",
  "sourceLabels",
  "catchCount",
  "presenceState",
  "minSizeCm",
  "maxSizeCm",
  "areaLabels",
  "completeness",
  "aliasCoverage"
] as const;

export function fixedCoastalFacilitySourceIdentity(providerId: string, providerFacilityKey: string): string {
  return JSON.stringify([providerId, providerFacilityKey]);
}

export function fixedNodeReportIdentity(
  providerId: string,
  facilityId: string,
  observationDate: string,
  sourceRecordId: string
): string {
  return JSON.stringify([providerId, facilityId, observationDate, sourceRecordId]);
}

export function fixedNodeSpeciesIdFromAuditGroup(group: string): FixedNodeSpeciesId | null {
  return FIXED_NODE_AUDIT_GROUP_TO_SPECIES_ID[group as keyof typeof FIXED_NODE_AUDIT_GROUP_TO_SPECIES_ID] ?? null;
}

export function buildFixedNodeDailyReport(value: unknown): FixedNodeDailyReportValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["report must be an object."], report: null };

  rejectUnsupportedFields(value, TOP_LEVEL_INPUT_FIELDS, "report", errors);
  requireFields(value, TOP_LEVEL_INPUT_FIELDS, "report", errors);
  if (value.schemaVersion !== FIXED_NODE_OBSERVATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${FIXED_NODE_OBSERVATION_SCHEMA_VERSION}.`);
  }
  validateRequiredString(value.providerId, "providerId", errors);
  validateRequiredString(value.facilityId, "facilityId", errors);
  validateRequiredString(value.sourceRecordId, "sourceRecordId", errors);
  validateRequiredString(value.sourceRunId, "sourceRunId", errors);
  if (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) errors.push("sourceUrl must be null or an HTTP(S) URL.");
  if (!isIsoDate(value.observationDate)) errors.push("observationDate must be a valid YYYY-MM-DD date.");
  if (value.publishedAt !== null && !isCanonicalUtcIsoDateTime(value.publishedAt)) {
    errors.push("publishedAt must be null or canonical UTC ISO datetime.");
  }
  if (!isCanonicalUtcIsoDateTime(value.collectedAt)) errors.push("collectedAt must be canonical UTC ISO datetime.");
  if (
    isCanonicalUtcIsoDateTime(value.publishedAt)
    && isCanonicalUtcIsoDateTime(value.collectedAt)
    && Date.parse(value.publishedAt) > Date.parse(value.collectedAt)
  ) {
    errors.push("publishedAt must be <= collectedAt.");
  }
  if (value.visitorCount !== null && (!Number.isInteger(value.visitorCount) || Number(value.visitorCount) < 0)) {
    errors.push("visitorCount must be null or a non-negative integer.");
  }
  if (!includes(OPERATING_STATUSES, value.operatingStatus)) errors.push("operatingStatus is invalid.");
  if (!includes(COMPLETENESS_VALUES, value.reportCompleteness)) errors.push("reportCompleteness is invalid.");

  const facility = FIXED_COASTAL_FACILITIES.find((candidate) => candidate.facilityId === value.facilityId);
  if (!facility) errors.push("facilityId is not in the fixed coastal facility registry.");
  if (facility && facility.providerId !== value.providerId) errors.push("providerId does not match facilityId.");

  const species = validateSpeciesRows(value.species, value, errors);
  if (errors.length > 0 || !facility) return { valid: false, errors: unique(errors), report: null };

  const report: FixedNodeDailyReport = {
    schemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
    providerId: value.providerId as string,
    facilityId: value.facilityId as string,
    facilitySourceIdentity: facility.sourceIdentity,
    reportIdentity: fixedNodeReportIdentity(
      value.providerId as string,
      value.facilityId as string,
      value.observationDate as string,
      value.sourceRecordId as string
    ),
    sourceRecordId: value.sourceRecordId as string,
    sourceUrl: value.sourceUrl as string | null,
    sourceRunId: value.sourceRunId as string,
    observationDate: value.observationDate as string,
    publishedAt: value.publishedAt as string | null,
    collectedAt: value.collectedAt as string,
    visitorCount: value.visitorCount as number | null,
    operatingStatus: value.operatingStatus as FixedNodeOperatingStatus,
    reportCompleteness: value.reportCompleteness as FixedNodeCompleteness,
    species
  };
  return { valid: true, errors: [], report };
}

export function buildFixedNodeReportSemanticContent(report: FixedNodeDailyReport): FixedNodeReportSemanticContent {
  return {
    schemaVersion: report.schemaVersion,
    providerId: report.providerId,
    facilityId: report.facilityId,
    facilitySourceIdentity: report.facilitySourceIdentity,
    reportIdentity: report.reportIdentity,
    sourceRecordId: report.sourceRecordId,
    observationDate: report.observationDate,
    publishedAt: report.publishedAt,
    visitorCount: report.visitorCount,
    operatingStatus: report.operatingStatus,
    reportCompleteness: report.reportCompleteness,
    species: report.species.map(cloneSpeciesRow)
  };
}

export function normalizedCatchPer100Visitors(catchCount: number | null, visitorCount: number | null): number | null {
  if (catchCount === null || visitorCount === null || visitorCount <= 0) return null;
  return Math.round((catchCount / visitorCount) * 1_000_000) / 10_000;
}

function validateSpeciesRows(
  value: unknown,
  report: Record<string, unknown>,
  errors: string[]
): FixedNodeSpeciesObservation[] {
  if (!Array.isArray(value)) {
    errors.push("species must be an array.");
    return [];
  }
  const rows: FixedNodeSpeciesObservation[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const label = `species[${index}]`;
    if (!isRecord(candidate)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    rejectUnsupportedFields(candidate, SPECIES_FIELDS, label, errors);
    requireFields(candidate, SPECIES_FIELDS, label, errors);
    if (!includes(FIXED_NODE_SPECIES_IDS, candidate.speciesId)) errors.push(`${label}.speciesId is invalid.`);
    if (typeof candidate.speciesId === "string" && seen.has(candidate.speciesId)) {
      errors.push(`species contains duplicate speciesId: ${candidate.speciesId}.`);
    }
    if (typeof candidate.speciesId === "string") seen.add(candidate.speciesId);
    const sourceLabels = validateStringArray(candidate.sourceLabels, `${label}.sourceLabels`, errors);
    const areaLabels = validateStringArray(candidate.areaLabels, `${label}.areaLabels`, errors);
    if (candidate.catchCount !== null && (!Number.isInteger(candidate.catchCount) || Number(candidate.catchCount) < 0)) {
      errors.push(`${label}.catchCount must be null or a non-negative integer.`);
    }
    if (!includes(PRESENCE_STATES, candidate.presenceState)) errors.push(`${label}.presenceState is invalid.`);
    validateNullableNonnegativeNumber(candidate.minSizeCm, `${label}.minSizeCm`, errors);
    validateNullableNonnegativeNumber(candidate.maxSizeCm, `${label}.maxSizeCm`, errors);
    if (
      typeof candidate.minSizeCm === "number"
      && typeof candidate.maxSizeCm === "number"
      && candidate.minSizeCm > candidate.maxSizeCm
    ) {
      errors.push(`${label}.minSizeCm must be <= maxSizeCm.`);
    }
    if (!includes(COMPLETENESS_VALUES, candidate.completeness)) errors.push(`${label}.completeness is invalid.`);
    if (!includes(ALIAS_COVERAGE_VALUES, candidate.aliasCoverage)) errors.push(`${label}.aliasCoverage is invalid.`);
    validatePresenceSemantics(candidate, report, label, errors);

    if (
      includes(FIXED_NODE_SPECIES_IDS, candidate.speciesId)
      && includes(PRESENCE_STATES, candidate.presenceState)
      && includes(COMPLETENESS_VALUES, candidate.completeness)
      && includes(ALIAS_COVERAGE_VALUES, candidate.aliasCoverage)
    ) {
      rows.push({
        speciesId: candidate.speciesId,
        sourceLabels,
        catchCount: candidate.catchCount as number | null,
        presenceState: candidate.presenceState,
        minSizeCm: candidate.minSizeCm as number | null,
        maxSizeCm: candidate.maxSizeCm as number | null,
        areaLabels,
        completeness: candidate.completeness,
        aliasCoverage: candidate.aliasCoverage
      });
    }
  }
  return rows.sort((left, right) => left.speciesId.localeCompare(right.speciesId));
}

function validatePresenceSemantics(
  species: Record<string, unknown>,
  report: Record<string, unknown>,
  label: string,
  errors: string[]
): void {
  if (species.presenceState === "present" && species.catchCount !== null && Number(species.catchCount) <= 0) {
    errors.push(`${label} present catchCount must be null or > 0.`);
  }
  if (species.presenceState === "absent") {
    if (species.catchCount !== 0) errors.push(`${label} absent requires catchCount 0.`);
    if (report.operatingStatus !== "operating") errors.push(`${label} absent requires an operating report.`);
    if (report.reportCompleteness !== "complete") errors.push(`${label} absent requires a complete report.`);
    if (species.completeness !== "complete") errors.push(`${label} absent requires complete species data.`);
    if (species.aliasCoverage !== "sufficient") errors.push(`${label} absent requires sufficient alias coverage.`);
  }
  if (species.presenceState === "unknown" && species.catchCount !== null) {
    errors.push(`${label} unknown requires catchCount null.`);
  }
  if (species.catchCount === 0 && species.presenceState !== "absent") {
    errors.push(`${label} catchCount 0 requires presenceState absent.`);
  }
  if (typeof species.catchCount === "number" && species.catchCount > 0 && species.presenceState !== "present") {
    errors.push(`${label} positive catchCount requires presenceState present.`);
  }
}

function facility(facilityId: string, providerId: string, providerFacilityKey: string, displayName: string): FixedCoastalFacility {
  return Object.freeze({
    facilityId,
    providerId,
    providerFacilityKey,
    displayName,
    sourceIdentity: fixedCoastalFacilitySourceIdentity(providerId, providerFacilityKey),
    spatialRefId: null,
    officialLatitude: null,
    officialLongitude: null,
    activeFrom: null,
    activeTo: null
  });
}

function cloneSpeciesRow(row: FixedNodeSpeciesObservation): FixedNodeSpeciesObservation {
  return { ...row, sourceLabels: [...row.sourceLabels], areaLabels: [...row.areaLabels] };
}

function validateStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return [];
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`${label} must contain only non-empty strings.`);
      continue;
    }
    output.push(entry.trim());
  }
  return [...new Set(output)].sort((left, right) => left.localeCompare(right));
}

function validateNullableNonnegativeNumber(value: unknown, label: string, errors: string[]): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    errors.push(`${label} must be null or a non-negative finite number.`);
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

function validateRequiredString(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string.`);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
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

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
