import {
  FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
  FIXED_NODE_SPECIES_IDS,
  buildFixedNodeDailyReport
} from "../../../packages/wanoku-core/src/fixed-node-observation.ts";
import { canonicalHydroCoastalJson } from "./hydro-coastal-persistence.js";
import { sha256HexFromBytes } from "./jma-tide-prediction-ingestion.js";
import {
  materializeFixedNodeDailyReport,
  persistFixedNodeDailyReport
} from "./fixed-node-observation-persistence.js";

export const ICHIHARA_FIXED_NODE_ARCHIVE_URL = "https://ichihara-umizuri.com/fishing/";
export const ICHIHARA_FIXED_NODE_PROVIDER_ID = "ichihara-umizuri";
export const ICHIHARA_FIXED_NODE_FACILITY_ID = "ichihara-original-maker";
export const ICHIHARA_FIXED_NODE_COLLECTOR_SCHEMA_VERSION = "wanoku-ichihara-fixed-node-collector.v1";
export const ICHIHARA_FIXED_NODE_COLLECTOR_MODEL_VERSION = "wanoku-ichihara-fixed-node-collector-v1";

const MAX_DETAIL_READS = 3;
const TEXT_ENCODER = new TextEncoder();
const SOURCE_RUN_COLUMNS = [
  "id", "provider", "node_id", "requested_at", "completed_at", "status", "http_status", "error_code",
  "model_version", "raw_hash", "normalized_schema_version"
];
const SPECIES_ID_BY_ALIAS = new Map([
  ["スズキ", "japanese-seabass"],
  ["フッコ", "japanese-seabass"],
  ["セイゴ", "japanese-seabass"],
  ["イワシ", "sardine"],
  ["マイワシ", "sardine"],
  ["カタクチイワシ", "sardine"],
  ["サッパ", "sappa"],
  ["コノシロ", "konoshiro"],
  ["アジ", "aji"],
  ["サバ", "saba"],
  ["ボラ", "bora"],
  ["ボラの大群", "bora"],
  ["ハゼ", "haze"]
]);
const AUDITED_ALIASES = [...SPECIES_ID_BY_ALIAS.keys()].sort((left, right) => right.length - left.length);
const NON_FISH_LABEL = /^(?:大荒れの海|青潮の海|雪景色|雪の海|海づり桟橋|連絡橋|桟橋|本日の海)$/u;
const CLOSURE_LANGUAGE = /(?:本日の営業は中止|営業を中止|臨時休館|臨時休園|終日閉場|休場|休園)/u;
const INTERRUPTED_LANGUAGE = /(?:\d{1,2}時\d{2}分.*(?:営業|開園).*(?:中止|終了)|雷.*(?:中止|終了)|津波.*(?:中止|終了))/u;
const INTERIM_LANGUAGE = /(?:釣果は\s*\d{1,2}時\d{2}分現在|入場者率\s*\d+\s*[％%]|\d{1,2}時\d{2}分現在)/u;
const FINAL_LANGUAGE = /(?:本日も.*ありがとうございました|ご来場ありがとうございました|ご来園ありがとうございました|明日のご来場をお待ち|本日の(?:入場者数|入園者数|ご来場者数)は)/u;

export async function collectIchiharaFixedNode(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new Error("D1 prepare and batch support are required.");
  }
  const clock = options.now ?? (() => new Date());
  const requestedAt = canonicalNow(options.requestedAt ?? clock(), "requestedAt");
  const collectedAt = canonicalNow(options.collectedAt ?? requestedAt, "collectedAt");
  const storedAt = canonicalNow(options.storedAt ?? collectedAt, "storedAt");
  await requireIchiharaFacilityRegistry(db);
  const source = await fetchLatestFinalizedIchiharaSource({
    collectedAt,
    fetchImpl: options.fetchImpl
  });
  const rawHash = await sha256HexFromBytes(
    TEXT_ENCODER.encode(canonicalHydroCoastalJson(source.artifacts)),
    options.cryptoImpl ?? globalThis.crypto
  );
  const sourceRun = await buildSourceRun({
    requestedAt,
    completedAt: collectedAt,
    observationDate: source.record.observationDate,
    rawHash,
    cryptoImpl: options.cryptoImpl ?? globalThis.crypto
  });
  const sourceRunCreated = await persistSourceRun(db, sourceRun);
  const report = buildIchiharaFixedNodeReport(source.record, sourceRun.id);
  const materialized = await materializeFixedNodeDailyReport(report, storedAt, options.cryptoImpl ?? globalThis.crypto);
  const priorRevision = await hasPriorReportIdentity(db, materialized.identityKey);
  const persisted = await persistFixedNodeDailyReport(db, {
    report,
    storedAt,
    cryptoImpl: options.cryptoImpl ?? globalThis.crypto
  });
  const status = persisted.created ? (priorRevision ? "REVISION_CREATED" : "CREATED") : "EXISTING";
  const seabass = persisted.report.species.find((row) => row.speciesId === "japanese-seabass");
  return {
    ok: true,
    schemaVersion: ICHIHARA_FIXED_NODE_COLLECTOR_SCHEMA_VERSION,
    requestedAt,
    collectedAt,
    observationDate: source.record.observationDate,
    sourceRunId: sourceRun.id,
    sourceRunCreated,
    reportsGenerated: 1,
    reportsCreated: persisted.created ? 1 : 0,
    reportsExisting: persisted.created ? 0 : 1,
    semanticRevisionsCreated: persisted.created && priorRevision ? 1 : 0,
    speciesRowsCreated: persisted.created ? persisted.report.species.length : 0,
    speciesRowsExisting: persisted.created ? 0 : persisted.report.species.length,
    skippedInterim: source.skippedInterim,
    failed: 0,
    remoteReads: source.remoteReads,
    records: [{
      facilityId: source.record.facilityId,
      sourceRecordId: source.record.sourceRecordId,
      observationDate: source.record.observationDate,
      finality: source.record.finality,
      visitorCount: source.record.visitors,
      operatingStatus: source.record.operatingStatus,
      reportCompleteness: persisted.report.reportCompleteness,
      seabassCatch: seabass?.catchCount ?? null,
      speciesCount: persisted.report.species.length,
      unsupportedSourceLabels: source.record.unsupportedRows.map((row) => row.sourceName),
      reportId: persisted.reportId,
      status,
      diagnostics: source.record.diagnostics
    }]
  };
}

export async function fetchLatestFinalizedIchiharaSource({ collectedAt, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const canonicalCollectedAt = canonicalNow(collectedAt, "collectedAt");
  const archive = await fetchOfficialText(ICHIHARA_FIXED_NODE_ARCHIVE_URL, fetchImpl);
  const listing = parseIchiharaArchive(archive.body);
  if (listing.records.length === 0) throw collectorError("ichihara_archive_empty", "Ichihara archive contained no report candidates.");
  const artifacts = [{ url: ICHIHARA_FIXED_NODE_ARCHIVE_URL, body: archive.body }];
  let skippedInterim = 0;
  for (const candidate of listing.records.slice(0, MAX_DETAIL_READS)) {
    const detail = await fetchOfficialText(candidate.sourceUrl, fetchImpl);
    artifacts.push({ url: candidate.sourceUrl, body: detail.body });
    const record = parseIchiharaDetail({
      html: detail.body,
      sourceUrl: candidate.sourceUrl,
      collectedAt: canonicalCollectedAt
    });
    if (record.observationDate !== candidate.observationDate || record.sourceRecordId !== candidate.sourceRecordId) {
      throw collectorError("ichihara_list_detail_mismatch", "Ichihara archive and detail identity do not match.");
    }
    if (record.finality === "interim") {
      skippedInterim += 1;
      continue;
    }
    if (record.finality === "unknown") {
      throw collectorError("ichihara_finality_unknown", "Ichihara report finality could not be determined safely.");
    }
    return { record, artifacts, skippedInterim, remoteReads: artifacts.length };
  }
  throw collectorError("ichihara_finalized_report_not_found", "No safely finalized Ichihara report was found within the bounded candidate set.");
}

export function parseIchiharaArchive(html) {
  if (typeof html !== "string") throw new Error("Ichihara archive HTML must be a string.");
  const markerPattern = /<p\b[^>]*\bclass=["'][^"']*font-bold[^"']*["'][^>]*>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日[^<]*<\/p>/giu;
  const markers = [...html.matchAll(markerPattern)];
  const records = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const block = html.slice(marker.index ?? 0, markers[index + 1]?.index ?? html.length);
    const link = /href=["']([^"']*\/fishing\/([1-9]\d*)\/?)['"][^>]*>[\s\S]*?釣れた魚の詳細を見る/iu.exec(block);
    if (!link) continue;
    const observationDate = validDate(Number(marker[1]), Number(marker[2]), Number(marker[3]));
    const sourceUrl = officialDetailUrl(link[1]);
    records.push({
      sourceRecordId: `fishing:${link[2]}`,
      numericId: link[2],
      observationDate,
      sourceUrl
    });
  }
  const deduplicated = new Map();
  for (const record of records) {
    const existing = deduplicated.get(record.sourceRecordId);
    if (existing && canonicalHydroCoastalJson(existing) !== canonicalHydroCoastalJson(record)) {
      throw collectorError("ichihara_archive_identity_conflict", "Ichihara archive contains conflicting report identities.");
    }
    deduplicated.set(record.sourceRecordId, record);
  }
  const output = [...deduplicated.values()].sort((left, right) => (
    right.observationDate.localeCompare(left.observationDate) || Number(right.numericId) - Number(left.numericId)
  ));
  const dates = new Set();
  for (const record of output) {
    if (dates.has(record.observationDate)) {
      throw collectorError("ichihara_archive_date_conflict", "Ichihara archive contains multiple reports for one date.");
    }
    dates.add(record.observationDate);
  }
  return { records: output };
}

export function parseIchiharaDetail({ html, sourceUrl, collectedAt }) {
  if (typeof html !== "string") throw new Error("Ichihara detail HTML must be a string.");
  const canonicalUrl = officialDetailUrl(sourceUrl);
  const numericId = /\/fishing\/([1-9]\d*)\/$/u.exec(new URL(canonicalUrl).pathname)?.[1];
  const dateMatch = /<p\b[^>]*\bclass=["'][^"']*font-bold[^"']*["'][^>]*>\s*(20\d{2})年(\d{1,2})月(\d{1,2})日[^<]*<\/p>/iu.exec(html);
  if (!numericId || !dateMatch) throw collectorError("ichihara_detail_identity_missing", "Ichihara detail identity is missing.");
  const canonicalCollectedAt = canonicalNow(collectedAt, "collectedAt");
  const observationDate = validDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
  const plainText = htmlToText(html);
  const rows = parseIchiharaCatchRows(html);
  const visitors = parseIchiharaVisitorCount(plainText);
  const finality = classifyIchiharaFinality({
    observationDate,
    collectedAt: canonicalCollectedAt,
    plainText,
    rows,
    visitors
  });
  const biologicalRows = rows.filter((row) => row.rowKind !== "non-fish");
  const ambiguousRows = biologicalRows.filter((row) => row.rowKind === "ambiguous");
  const interruptionMentioned = INTERRUPTED_LANGUAGE.test(plainText);
  const operatingStatus = finality === "closure"
    ? "closed"
    : finality === "final" && (biologicalRows.length > 0 || visitors !== null || interruptionMentioned)
      ? "operating"
      : "unknown";
  const interrupted = finality === "final"
    && (interruptionMentioned || CLOSURE_LANGUAGE.test(plainText));
  const reportComplete = finality === "final"
    && operatingStatus === "operating"
    && !interrupted
    && biologicalRows.length > 0
    && ambiguousRows.length === 0
    && biologicalRows.every((row) => row.countKnown);
  return {
    providerId: ICHIHARA_FIXED_NODE_PROVIDER_ID,
    facilityId: ICHIHARA_FIXED_NODE_FACILITY_ID,
    sourceRecordId: `fishing:${numericId}`,
    sourceUrl: canonicalUrl,
    observationDate,
    publishedAt: null,
    collectedAt: canonicalCollectedAt,
    visitors,
    finality,
    operatingStatus,
    reportComplete,
    species: biologicalRows.filter((row) => row.speciesId !== null && row.rowKind === "biological"),
    unsupportedRows: biologicalRows.filter((row) => row.speciesId === null || row.rowKind === "ambiguous"),
    diagnostics: unique([
      "publication-time-unavailable",
      finality === "interim" ? "current-report-interim" : null,
      finality === "closure" ? "full-closure" : null,
      interrupted ? "operating-day-interrupted" : null,
      !reportComplete && operatingStatus === "operating" ? "catch-table-incomplete" : null,
      ...biologicalRows.filter((row) => row.speciesId === null).map((row) => `unsupported-source-label:${row.sourceName}`),
      ...ambiguousRows.map((row) => `ambiguous-source-label:${row.sourceName}`)
    ].filter(Boolean))
  };
}

export function classifyIchiharaFinality({ observationDate, collectedAt, plainText, rows, visitors }) {
  const currentJstDate = jstDateAt(collectedAt);
  const biologicalRows = rows.filter((row) => row.rowKind !== "non-fish");
  const numericBiologicalRows = biologicalRows.filter((row) => row.countKnown);
  const hasClosure = CLOSURE_LANGUAGE.test(plainText);
  const interrupted = INTERRUPTED_LANGUAGE.test(plainText) || (hasClosure && numericBiologicalRows.length > 0);
  if (hasClosure && !interrupted && numericBiologicalRows.length === 0) return "closure";
  if (biologicalRows.some((row) => row.rowKind === "ambiguous")) return "unknown";
  if (observationDate < currentJstDate && (interrupted || (visitors !== null && FINAL_LANGUAGE.test(plainText)))) return "final";
  if (biologicalRows.length === 0) return "unknown";
  if (observationDate < currentJstDate) return "final";
  if (observationDate > currentJstDate) return "unknown";
  if (INTERIM_LANGUAGE.test(plainText)) return "interim";
  return visitors !== null && FINAL_LANGUAGE.test(plainText) ? "final" : "interim";
}

export function parseIchiharaVisitorCount(value) {
  const text = normalizeAscii(String(value ?? ""));
  const match = /本日の(?:入場者数|入園者数|ご来場者数)は\s*([\d,]+)\s*名(?:様)?/u.exec(text);
  if (!match) return null;
  const count = Number(match[1].replace(/,/gu, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function parseIchiharaCatchRows(html) {
  const rows = [];
  const rowPattern = /<div\b[^>]*\bclass=["'][^"']*\bflex\b[^"']*\bborder-b\b[^"']*\bborder-gray-300\b[^"']*["'][^>]*>\s*<div\b[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<\/div>\s*<div\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/giu;
  for (const match of html.matchAll(rowPattern)) {
    const sourceName = cleanText(htmlToText(match[1]));
    if (!sourceName) continue;
    const sizeText = cleanText(htmlToText(match[2])) ?? "";
    const countText = normalizeAscii(cleanText(htmlToText(match[3])) ?? "");
    const countMatch = /合計\s*([\d,]+)\s*匹/u.exec(countText);
    const count = countMatch ? Number(countMatch[1].replace(/,/gu, "")) : null;
    const alias = classifySourceLabel(sourceName);
    const normalizedSizeText = normalizeAscii(sizeText);
    const malformedSize = /\d+\.\s*(?:cm|cｍ|㎝)/iu.test(normalizedSizeText);
    const parsedSizes = malformedSize
      ? []
      : [...normalizedSizeText.matchAll(/\d+(?:\.\d+)?/gu)].map((entry) => Number(entry[0]));
    const sizes = parsedSizes.length > 1 && parsedSizes[0] > parsedSizes[1] ? [] : parsedSizes;
    rows.push({
      sourceName,
      speciesId: alias.speciesId,
      rowKind: alias.rowKind,
      count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      countKnown: Number.isSafeInteger(count) && count >= 0,
      minSizeCm: /(?:cm|cｍ|㎝)/iu.test(sizeText) ? sizes[0] ?? null : null,
      maxSizeCm: /(?:cm|cｍ|㎝)/iu.test(sizeText) ? sizes[1] ?? sizes[0] ?? null : null
    });
  }
  return rows;
}

export function buildIchiharaFixedNodeReport(sourceRecord, sourceRunId) {
  if (!sourceRecord || sourceRecord.providerId !== ICHIHARA_FIXED_NODE_PROVIDER_ID) {
    throw new Error("Ichihara source record is invalid.");
  }
  if (sourceRecord.finality !== "final" && sourceRecord.finality !== "closure") {
    throw new Error("Ichihara report is not safely finalized.");
  }
  const reportCompleteness = sourceRecord.reportComplete
    ? "complete"
    : sourceRecord.operatingStatus === "operating" ? "incomplete" : "unknown";
  const species = FIXED_NODE_SPECIES_IDS.map((speciesId) => normalizeSpecies(sourceRecord, speciesId, reportCompleteness));
  const built = buildFixedNodeDailyReport({
    schemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION,
    providerId: sourceRecord.providerId,
    facilityId: sourceRecord.facilityId,
    sourceRecordId: sourceRecord.sourceRecordId,
    sourceUrl: sourceRecord.sourceUrl,
    sourceRunId,
    observationDate: sourceRecord.observationDate,
    publishedAt: null,
    collectedAt: sourceRecord.collectedAt,
    visitorCount: sourceRecord.visitors,
    operatingStatus: sourceRecord.operatingStatus,
    reportCompleteness,
    species
  });
  if (!built.valid || !built.report) throw new Error(`Ichihara fixed-node report is invalid: ${built.errors.join(" ")}`);
  return built.report;
}

function classifySourceLabel(sourceName) {
  const normalized = sourceName.replace(/[（]/gu, "(").replace(/[）]/gu, ")").replace(/[・／]/gu, "・").trim();
  if (NON_FISH_LABEL.test(normalized)) return { speciesId: null, rowKind: "non-fish" };
  if (/カタボシイワシ/u.test(normalized)) return { speciesId: null, rowKind: "biological" };
  if (SPECIES_ID_BY_ALIAS.has(normalized)) return { speciesId: SPECIES_ID_BY_ALIAS.get(normalized), rowKind: "biological" };
  const matchedAliases = AUDITED_ALIASES.filter((alias) => normalized.includes(alias));
  const matchedSpecies = unique(matchedAliases.map((alias) => SPECIES_ID_BY_ALIAS.get(alias)));
  if (matchedSpecies.length === 1) return { speciesId: matchedSpecies[0], rowKind: "biological" };
  if (matchedSpecies.length > 1) return { speciesId: null, rowKind: "ambiguous" };
  return { speciesId: null, rowKind: "biological" };
}

function normalizeSpecies(sourceRecord, speciesId, reportCompleteness) {
  const rows = sourceRecord.species.filter((row) => row.speciesId === speciesId);
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
  const minimums = rows.map((row) => row.minSizeCm).filter((value) => value !== null);
  const maximums = rows.map((row) => row.maxSizeCm).filter((value) => value !== null);
  return {
    speciesId,
    sourceLabels: unique(rows.map((row) => row.sourceName)),
    catchCount,
    presenceState,
    minSizeCm: minimums.length > 0 ? Math.min(...minimums) : null,
    maxSizeCm: maximums.length > 0 ? Math.max(...maximums) : null,
    areaLabels: [],
    completeness: presenceState === "unknown" ? (reportCompleteness === "complete" ? "unknown" : "incomplete") : "complete",
    aliasCoverage: reportCompleteness === "complete" ? "sufficient" : "unknown"
  };
}

async function requireIchiharaFacilityRegistry(db) {
  const row = await db.prepare(`
    SELECT facility_id, provider_id, provider_facility_key
    FROM fixed_coastal_facilities
    WHERE facility_id = ?
  `).bind(ICHIHARA_FIXED_NODE_FACILITY_ID).first();
  if (
    row?.facility_id !== ICHIHARA_FIXED_NODE_FACILITY_ID
    || row?.provider_id !== ICHIHARA_FIXED_NODE_PROVIDER_ID
    || row?.provider_facility_key !== "original-maker"
  ) {
    throw new Error("Ichihara facility DB registry is missing or unexpected.");
  }
}

async function buildSourceRun({ requestedAt, completedAt, observationDate, rawHash, cryptoImpl }) {
  const identity = canonicalHydroCoastalJson([
    ICHIHARA_FIXED_NODE_PROVIDER_ID, observationDate, requestedAt, completedAt, rawHash, "ok"
  ]);
  const hash = await sha256HexFromBytes(TEXT_ENCODER.encode(identity), cryptoImpl);
  return {
    id: `wanoku-fixed-node-ichihara-run:${hash}`,
    provider: ICHIHARA_FIXED_NODE_PROVIDER_ID,
    nodeId: null,
    requestedAt,
    completedAt,
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    modelVersion: ICHIHARA_FIXED_NODE_COLLECTOR_MODEL_VERSION,
    rawHash,
    normalizedSchemaVersion: FIXED_NODE_OBSERVATION_SCHEMA_VERSION
  };
}

async function persistSourceRun(db, run) {
  const existing = await db.prepare(`SELECT ${SOURCE_RUN_COLUMNS.join(", ")} FROM source_runs WHERE id = ?`).bind(run.id).first();
  const params = sourceRunParams(run);
  if (existing) {
    if (canonicalHydroCoastalJson(SOURCE_RUN_COLUMNS.map((column) => existing[column])) !== canonicalHydroCoastalJson(params)) {
      throw new Error("Ichihara source run id conflict.");
    }
    return false;
  }
  const sql = `INSERT INTO source_runs (${SOURCE_RUN_COLUMNS.join(", ")}) VALUES (${SOURCE_RUN_COLUMNS.map(() => "?").join(", ")})`;
  await db.prepare(sql).bind(...params).run();
  return true;
}

async function hasPriorReportIdentity(db, identityKey) {
  return Boolean(await db.prepare("SELECT report_id FROM fixed_node_daily_reports WHERE identity_key = ? LIMIT 1").bind(identityKey).first());
}

function sourceRunParams(run) {
  return [run.id, run.provider, run.nodeId, run.requestedAt, run.completedAt, run.status, run.httpStatus, run.errorCode,
    run.modelVersion, run.rawHash, run.normalizedSchemaVersion];
}

async function fetchOfficialText(url, fetchImpl) {
  const officialUrl = url === ICHIHARA_FIXED_NODE_ARCHIVE_URL ? url : officialDetailUrl(url);
  const response = await fetchImpl(officialUrl, {
    method: "GET",
    headers: { accept: "text/html,application/xhtml+xml" }
  });
  if (!response?.ok) throw collectorError("ichihara_source_fetch_failed", `Ichihara source GET failed with HTTP ${response?.status ?? "unknown"}.`);
  return { body: await response.text() };
}

function officialDetailUrl(value) {
  const url = new URL(value, ICHIHARA_FIXED_NODE_ARCHIVE_URL);
  if (url.protocol !== "https:" || url.hostname !== "ichihara-umizuri.com" || !/^\/fishing\/[1-9]\d*\/?$/u.test(url.pathname) || url.search || url.hash) {
    throw collectorError("ichihara_source_url_invalid", "Ichihara detail URL is outside the official catalog.");
  }
  const numericId = /\/fishing\/([1-9]\d*)/u.exec(url.pathname)[1];
  return `${ICHIHARA_FIXED_NODE_ARCHIVE_URL}${numericId}/`;
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/(?:p|div|li|span|h1|h2|h3)>/giu, "\n")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
    const codePoint = Number.parseInt(radix === 16 ? entity.slice(2) : entity.slice(1), radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function normalizeAscii(value) {
  return String(value)
    .replace(/[０-９]/gu, (digit) => String(digit.codePointAt(0) - 0xff10))
    .replace(/，/gu, ",")
    .replace(/％/gu, "%");
}

function cleanText(value) {
  const text = String(value ?? "").replace(/[\t\r\n ]+/gu, " ").trim();
  return text || null;
}

function validDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Ichihara report date is invalid.");
  return value;
}

function canonicalNow(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return canonical;
}

function jstDateAt(value) {
  return new Date(Date.parse(value) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function collectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
