#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KACHIDOKI_HISTORICAL_AUDIT_VERSION = "wanoku-kachidoki-historical-evidence-audit.v1";
export const KACHIDOKI_RESULTS_URL = "https://kachidoki-marina.com/fishing-results/";

const KACHIDOKI_HOST = "kachidoki-marina.com";
const MAX_MONTHS = 12;
const MAX_ENTRIES = 100;
const DEFAULT_DELAY_MS = 200;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OTHER_SPECIES = [
  "クロダイ", "チヌ", "キビレ", "マゴチ", "タチウオ", "サワラ", "青物", "イナダ", "ワラサ",
  "ブリ", "アジ", "カサゴ", "メバル", "ヒラメ", "マダイ", "真鯛", "タコ", "フグ"
];
const COMBO_DURATION_MINUTES = new Map([[4, 240], [5, 300], [6, 360], [8, 480], [9, 600]]);
const UMINEKO_REFERENCE = Object.freeze({
  sampleSize: 50,
  seabassRelatedCount: 14,
  evidenceGeneratedCount: 3,
  catchCountCoverageAmongRelevant: 0.2143,
  explicitZeroCount: 0,
  durationKnownRate: 0.0714,
  anglerCountKnownRate: 0.1429,
  sourceLocationRate: 0.0714
});

export function parseKachidokiAuditArgs(argv = process.argv.slice(2)) {
  const options = { maxEntries: MAX_ENTRIES, maxMonths: MAX_MONTHS, delayMs: DEFAULT_DELAY_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--max-entries") options.maxEntries = parseInteger(readValue(), "max-entries", 1, MAX_ENTRIES);
    else if (arg === "--max-months") options.maxMonths = parseInteger(readValue(), "max-months", 1, MAX_MONTHS);
    else if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, 10_000);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function discoverKachidokiMonths(html, currentUrl = KACHIDOKI_RESULTS_URL) {
  if (typeof html !== "string") throw new Error("archive HTML must be a string.");
  const normalizedCurrentUrl = normalizeKachidokiResultsUrl(currentUrl);
  const discovered = [];
  const seenMonths = new Set();
  const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/giu;
  for (const match of html.matchAll(optionPattern)) {
    const label = htmlToText(match[2]);
    const monthMatch = /(20\d{2})\s*年\s*(\d{1,2})\s*月/u.exec(label);
    if (!monthMatch) continue;
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) continue;
    const sourceMonth = `${year}-${String(month).padStart(2, "0")}`;
    if (seenMonths.has(sourceMonth)) continue;
    const rawValue = attributeValue(match[1], "value");
    let url;
    if (rawValue && /^https?:\/\//iu.test(rawValue)) url = normalizeKachidokiResultsUrl(rawValue);
    else if (rawValue && /^\d{6}$/u.test(rawValue)) url = normalizedCurrentUrl;
    else continue;
    seenMonths.add(sourceMonth);
    discovered.push({ sourceMonth, sourceYear: year, month, url });
  }
  return discovered.sort((left, right) => right.sourceMonth.localeCompare(left.sourceMonth));
}

export function parseKachidokiMonthlyPage({ html, url, sourceYear, sourceMonth }) {
  if (typeof html !== "string") throw new Error("monthly HTML must be a string.");
  const normalizedUrl = normalizeKachidokiResultsUrl(url);
  const year = requireYear(sourceYear);
  const month = requireMonth(sourceMonth);
  const pagePostId = /<article\b[^>]*\bid=["']post-(\d+)["'][^>]*>/iu.exec(html)?.[1] ?? null;
  const sourceRecordId = pagePostId ? `post:${pagePostId}` : `month:${year}-${String(month).padStart(2, "0")}`;
  const pageDiagnostics = pagePostId ? [] : ["source-record-id-month-fallback"];
  const publishedAt = metaContent(html, "article:published_time");
  const modifiedAt = metaContent(html, "article:modified_time");
  const entryPattern = /<figure\b[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'][^>]*>([\s\S]*?)<\/figure>/giu;
  const entries = [...html.matchAll(entryPattern)];
  const records = entries.map((entry) => {
    const caption = /<figcaption\b[^>]*\bclass=["'][^"']*\bslide-title\b[^"']*["'][^>]*>([\s\S]*?)<\/figcaption>/iu.exec(entry[1])
      ?? /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/iu.exec(entry[1]);
    if (!caption) return failedTripRecord({ sourceRecordId, sourceUrl: normalizedUrl, diagnostic: "entry-caption-missing" });
    try {
      return parseKachidokiTripEntry({
        captionHtml: caption[1],
        sourceRecordId,
        sourceUrl: normalizedUrl,
        sourceYear: year,
        sourceMonth: month,
        pageDiagnostics
      });
    } catch (error) {
      return failedTripRecord({
        sourceRecordId,
        sourceUrl: normalizedUrl,
        diagnostic: error?.code ?? "entry-parse-error"
      });
    }
  });
  markDuplicateEventKeys(records);
  return {
    sourceRecordId,
    sourceUrl: normalizedUrl,
    sourceYear: year,
    sourceMonth: month,
    publishedAt,
    modifiedAt,
    entryCount: entries.length,
    diagnostics: pageDiagnostics,
    records
  };
}

export function parseKachidokiTripEntry({
  captionHtml,
  sourceRecordId,
  sourceUrl,
  sourceYear,
  sourceMonth,
  pageDiagnostics = []
}) {
  const text = htmlToText(captionHtml);
  const header = parseTripHeader(text);
  const year = requireYear(sourceYear);
  const month = requireMonth(sourceMonth);
  const entryMonth = header.month;
  const day = header.day;
  if (entryMonth !== month || !isValidDate(year, month, day)) throw auditParseError("entry-date-invalid");

  const eventDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const daypart = header.daypart;
  const planLabel = header.planLabel;
  const afterHeader = header.afterHeader;
  const seabassMentioned = /シーバス/u.test(afterHeader);
  const seabassWindow = extractSpeciesWindow(afterHeader, "シーバス");
  const resultContext = firstResultContext(afterHeader);
  const explicitSeabassAttempt = hasExplicitSeabassAttempt(afterHeader);
  const seabassResultInLead = /シーバス/u.test(resultContext);
  const seabassTargeted = seabassMentioned ? Boolean(explicitSeabassAttempt || seabassResultInLead) : null;

  const catchResult = parseGetCount(seabassWindow);
  const hitResult = parseHitCount(seabassWindow);
  const chaseMentioned = /チェイス/u.test(afterHeader);
  const biteMentioned = /(?:ショートバイト|水面バイト|バイト)/u.test(afterHeader);
  const followMentioned = /(?:追尾|魚がついて|魚が付いて|\bfollow\b)/iu.test(afterHeader);
  const hitEvidencePresent = hitResult.present || /(?:ヒット|\bhit\b)/iu.test(seabassWindow);
  const explicitZeroCatchCandidate = Boolean(
    explicitSeabassAttempt
    && !(catchResult.known && catchResult.count > 0)
    && hasExplicitSeabassZero(afterHeader)
  );
  const getCountKnown = explicitZeroCatchCandidate ? true : catchResult.known;
  const getCount = explicitZeroCatchCandidate ? 0 : catchResult.count;
  const effort = parseEffort(planLabel);
  const environmentalClues = parseEnvironmentalClues(afterHeader);
  const activationClues = parseActivationClues(afterHeader);
  const structuralClues = parseStructuralClues(afterHeader);
  const sourceLocationLabel = parseSourceLocation(afterHeader);
  const sourceLocationMentioned = sourceLocationLabel !== null;
  const targetKey = seabassMentioned ? "seabass" : inferTargetKey(resultContext);
  const sourceEventKey = `${eventDate}-${daypart.toLowerCase()}-${targetKey}`;
  const foundationConvertibleType = classifyFoundationConvertibility({
    getCountKnown,
    getCount,
    explicitZeroCatchCandidate,
    effortDurationKnown: effort.known,
    seabassContactAttributed: seabassTargeted === true,
    hitEvidencePresent,
    chaseMentioned,
    biteMentioned,
    followMentioned
  });
  const foundationGaps = foundationGapReasons({ hitResult, chaseMentioned, biteMentioned, followMentioned });
  const diagnostics = unique([
    ...pageDiagnostics,
    ...(daypart === "unknown" ? ["daypart-missing"] : ["daypart-only-no-clock"]),
    ...(seabassMentioned && !catchResult.known && !explicitZeroCatchCandidate ? ["seabass-get-count-unknown"] : []),
    ...(hitResult.present && !hitResult.known && hitResult.lowerBound === null ? ["seabass-hit-count-unknown"] : []),
    ...(foundationGaps.length > 0 ? ["foundation-gap"] : [])
  ]);

  return {
    sourceRecordId,
    sourceEventKey,
    sourceUrl,
    eventDate,
    daypart,
    eventClockTime: null,
    temporalPrecision: daypart === "unknown" ? "date-only" : "daypart",
    seabassTargeted,
    seabassMentioned,
    getCountKnown,
    getCount,
    hitCountKnown: hitResult.known,
    hitCount: hitResult.count,
    hitCountLowerBound: hitResult.lowerBound,
    hitEvidencePresent,
    chaseMentioned,
    biteMentioned,
    followMentioned,
    explicitSeabassAttempt,
    explicitZeroCatchCandidate,
    eligibilityReason: explicitZeroCatchCandidate ? "explicit-seabass-attempt-and-explicit-zero" : null,
    effortDurationKnown: effort.known,
    effortDurationMinutes: effort.minutes,
    durationSource: effort.source,
    environmentalClues,
    activationClues,
    structuralClues,
    sourceLocationMentioned,
    sourceLocationLabel,
    foundationConvertibleType,
    foundationGaps,
    parseStatus: "ok",
    diagnostics
  };
}

export async function runKachidokiHistoricalAudit(options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxMonths = options.maxMonths ?? MAX_MONTHS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new Error(`maxEntries must be 1..${MAX_ENTRIES}.`);
  if (!Number.isInteger(maxMonths) || maxMonths < 1 || maxMonths > MAX_MONTHS) throw new Error(`maxMonths must be 1..${MAX_MONTHS}.`);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error("delayMs must be 0..10000.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const auditedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  let requestCount = 0;
  const request = async (url) => {
    if (requestCount > 0 && delayMs > 0) await delay(delayMs);
    requestCount += 1;
    return fetchKachidokiHtml(url, fetchImpl);
  };

  const archiveHtml = await request(KACHIDOKI_RESULTS_URL);
  const discoveredMonths = discoverKachidokiMonths(archiveHtml, KACHIDOKI_RESULTS_URL).slice(0, maxMonths);
  const records = [];
  const fetchedMonths = [];
  const fetchErrors = [];
  let monthFetchAttempts = 0;
  let monthFetchSuccesses = 0;
  let abortedReason = null;

  for (const month of discoveredMonths) {
    if (records.length >= maxEntries) break;
    monthFetchAttempts += 1;
    try {
      const html = month.url === KACHIDOKI_RESULTS_URL ? archiveHtml : await request(month.url);
      monthFetchSuccesses += 1;
      const parsed = parseKachidokiMonthlyPage({
        html,
        url: month.url,
        sourceYear: month.sourceYear,
        sourceMonth: month.month
      });
      fetchedMonths.push({
        sourceMonth: month.sourceMonth,
        sourceRecordId: parsed.sourceRecordId,
        sourceUrl: parsed.sourceUrl,
        entryCount: parsed.entryCount,
        parseErrorCount: parsed.records.filter((record) => record.parseStatus !== "ok").length
      });
      records.push(...parsed.records.slice(0, maxEntries - records.length));
    } catch (error) {
      const failure = auditFetchError(error, month.sourceMonth, month.url);
      fetchErrors.push(failure);
      if (failure.rateLimited) {
        abortedReason = failure.reason;
        break;
      }
    }
  }

  const summary = aggregateKachidokiAudit(records, {
    auditedAt,
    maxEntries,
    maxMonths,
    requestCount,
    discoveredMonths,
    fetchedMonths,
    monthFetchAttempts,
    monthFetchSuccesses,
    fetchErrors,
    abortedReason
  });
  return { ...summary, records };
}

export function aggregateKachidokiAudit(records, context = {}) {
  const all = [...records];
  const parsed = all.filter((record) => record.parseStatus === "ok");
  const related = parsed.filter((record) => record.seabassMentioned);
  const targeted = related.filter((record) => record.seabassTargeted === true);
  const incidental = related.filter((record) => record.seabassTargeted === false);
  const getKnown = targeted.filter((record) => record.getCountKnown);
  const positive = targeted.filter((record) => record.getCountKnown && Number(record.getCount) > 0);
  const explicitZero = targeted.filter((record) => record.explicitZeroCatchCandidate);
  const hitKnown = targeted.filter((record) => record.hitCountKnown);
  const anyHit = targeted.filter((record) => record.hitEvidencePresent);
  const chase = targeted.filter((record) => record.chaseMentioned);
  const bite = targeted.filter((record) => record.biteMentioned);
  const follow = targeted.filter((record) => record.followMentioned);
  const environmental = targeted.filter((record) => Object.values(record.environmentalClues).some(Boolean));
  const durationKnown = targeted.filter((record) => record.effortDurationKnown);
  const standardTwoHour = targeted.filter((record) => record.durationSource === "service-plan" && record.effortDurationMinutes === 120);
  const daypartKnown = parsed.filter((record) => record.daypart === "DAY" || record.daypart === "NIGHT");
  const sourceLocation = targeted.filter((record) => record.sourceLocationMentioned);
  const structure = targeted.filter((record) => record.structuralClues.length > 0);
  const directlyConvertible = related.filter((record) => record.foundationConvertibleType !== null);
  const foundationGap = related.filter((record) => record.foundationGaps.length > 0);
  const exactHitDetails = related.filter((record) => record.hitCountKnown);
  const lowerBoundHitDetails = related.filter((record) => record.hitCountLowerBound !== null);
  const comparisonWithUmineko = compareWithUmineko({
    sampleSize: parsed.length,
    seabassRelatedCount: related.length,
    evidenceGeneratedCount: directlyConvertible.length,
    catchCountCoverageAmongRelevant: rate(related.filter((record) => record.getCountKnown).length, related.length),
    explicitZeroCount: explicitZero.length,
    durationKnownRate: rate(related.filter((record) => record.effortDurationKnown).length, related.length),
    sourceLocationRate: rate(related.filter((record) => record.sourceLocationMentioned).length, related.length)
  });
  const sourceUsefulness = classifySourceUsefulness({
    targetedCount: targeted.length,
    getKnownCount: getKnown.length,
    anyHitCount: anyHit.length,
    environmentalCount: environmental.length,
    durationKnownCount: durationKnown.length,
    daypartKnownCount: daypartKnown.length,
    parsedCount: parsed.length,
    sourceLocationCount: sourceLocation.length,
    structureCount: structure.length,
    explicitZeroCount: explicitZero.length
  });
  const recommendedRoles = unique([
    ...(positive.length > 0 ? ["presence-positive"] : []),
    ...(anyHit.length + chase.length + bite.length > 0 ? ["activation-validation"] : []),
    ...(explicitZero.length > 0 ? ["explicit-zero-validation"] : []),
    ...(durationKnown.length > 0 ? ["effort-aware"] : []),
    ...(sourceLocation.length + structure.length > 0 ? ["spatial-context"] : [])
  ]);
  const ingestionReadiness = parsed.length === 0 || related.length === 0
    ? "NOT_READY"
    : foundationGap.length === 0 && directlyConvertible.length === related.length
      ? "READY"
      : "READY_WITH_LIMITATIONS";

  return {
    auditVersion: KACHIDOKI_HISTORICAL_AUDIT_VERSION,
    auditedAt: context.auditedAt ?? null,
    sourceStructure: {
      monthlyPageIdentity: "article#post-<numeric-id>",
      tripBoundary: "figure.slide > figcaption.slide-title",
      sourceRecordId: "post:<numeric-id>",
      sourceEventKey: "YYYY-MM-DD-<daypart>-<target>",
      publicationMetadata: ["article:published_time", "article:modified_time"]
    },
    discovery: {
      monthsDiscovered: context.discoveredMonths?.length ?? null,
      discoveredMonthRange: monthRange(context.discoveredMonths ?? []),
      monthsFetched: context.fetchedMonths?.length ?? null,
      fetchedMonths: context.fetchedMonths ?? [],
      entriesAudited: all.length,
      parsedEntries: parsed.length,
      parseSuccessRate: rate(parsed.length, all.length),
      monthFetchAttempts: context.monthFetchAttempts ?? null,
      monthFetchSuccesses: context.monthFetchSuccesses ?? null,
      fetchSuccessRate: rate(context.monthFetchSuccesses ?? 0, context.monthFetchAttempts ?? 0),
      httpRequestCount: context.requestCount ?? null,
      fetchErrors: context.fetchErrors ?? [],
      abortedReason: context.abortedReason ?? null
    },
    seabassCoverage: {
      relatedTripCount: related.length,
      targetedTripCount: targeted.length,
      targetedRate: rate(targeted.length, parsed.length),
      incidentalTripCount: incidental.length
    },
    catch: {
      denominator: "seabass-targeted trips",
      numericGetCount: getKnown.length,
      numericGetRate: rate(getKnown.length, targeted.length),
      positiveCatchTripCount: positive.length,
      explicitZeroCandidateCount: explicitZero.length,
      explicitZeroCandidateRate: rate(explicitZero.length, targeted.length)
    },
    activation: {
      denominator: "seabass-targeted trips",
      numericHitCount: hitKnown.length,
      numericHitRate: rate(hitKnown.length, targeted.length),
      anyHitEvidenceCount: anyHit.length,
      anyHitEvidenceRate: rate(anyHit.length, targeted.length),
      chaseCount: chase.length,
      chaseRate: rate(chase.length, targeted.length),
      biteCount: bite.length,
      biteRate: rate(bite.length, targeted.length),
      followCount: follow.length,
      environmentalClueCount: environmental.length,
      environmentalClueRate: rate(environmental.length, targeted.length),
      clueOccurrences: clueOccurrences(targeted)
    },
    effort: {
      denominator: "seabass-targeted trips",
      durationKnownCount: durationKnown.length,
      durationKnownRate: rate(durationKnown.length, targeted.length),
      standardTwoHourDerivedCount: standardTwoHour.length,
      standardTwoHourDerivedRate: rate(standardTwoHour.length, targeted.length),
      durationUnknownCount: targeted.length - durationKnown.length,
      durationUnknownRate: rate(targeted.length - durationKnown.length, targeted.length)
    },
    temporal: {
      denominator: "parsed trips",
      daypartKnownCount: daypartKnown.length,
      daypartKnownRate: rate(daypartKnown.length, parsed.length),
      exactClockCount: 0,
      exactClockRate: rate(0, parsed.length),
      precision: "daypart"
    },
    spatial: {
      denominator: "seabass-targeted trips",
      sourceLocationCount: sourceLocation.length,
      sourceLocationRate: rate(sourceLocation.length, targeted.length),
      structureClueCount: structure.length,
      structureClueRate: rate(structure.length, targeted.length),
      structuralClueOccurrences: listOccurrences(targeted.flatMap((record) => record.structuralClues))
    },
    foundation: {
      denominator: "seabass-related trips",
      directlyConvertibleCount: directlyConvertible.length,
      directlyConvertibleRate: rate(directlyConvertible.length, related.length),
      convertibleByType: listOccurrences(directlyConvertible.map((record) => record.foundationConvertibleType)),
      foundationGapCount: foundationGap.length,
      foundationGapRate: rate(foundationGap.length, related.length),
      gapOccurrences: listOccurrences(foundationGap.flatMap((record) => record.foundationGaps)),
      v11Recommendation: {
        recommended: foundationGap.length > 0,
        measuredOccurrences: {
          hitCount: exactHitDetails.length,
          hitLowerBound: lowerBoundHitDetails.length,
          chase: chase.length,
          bite: bite.length,
          follow: follow.length
        }
      }
    },
    comparisonWithUmineko,
    sourceUsefulness,
    ingestionReadiness,
    recommendedRoles
  };
}

export async function fetchKachidokiHtml(value, fetchImpl = globalThis.fetch) {
  const url = normalizeKachidokiResultsUrl(value);
  const response = await fetchImpl(url, { headers: { accept: "text/html" }, redirect: "follow" });
  if (!response?.ok) {
    const error = new Error(`Kachidoki source returned HTTP ${response?.status ?? "unknown"}.`);
    error.code = "source_fetch_failed";
    error.status = response?.status ?? null;
    throw error;
  }
  return response.text();
}

function parseGetCount(speciesWindow) {
  if (!speciesWindow) return { known: false, count: null };
  const numeric = /(\d+)\s*(?:get|ゲット)/iu.exec(speciesWindow);
  if (numeric) return { known: true, count: Number(numeric[1]) };
  if (/(?:^|\s)(?:get|ゲット)(?:\s|$|[、。])/iu.test(speciesWindow)) return { known: false, count: null };
  return { known: false, count: null };
}

function parseHitCount(speciesWindow) {
  if (!speciesWindow) return { present: false, known: false, count: null, lowerBound: null };
  const lower = /(\d+)\s*(?:hit|ヒット)\s*以上/iu.exec(speciesWindow);
  if (lower) return { present: true, known: false, count: null, lowerBound: Number(lower[1]) };
  const exact = /(\d+)\s*(?:hit|ヒット)/iu.exec(speciesWindow);
  if (exact) return { present: true, known: true, count: Number(exact[1]), lowerBound: null };
  const present = /(?:hit\s*多数|ヒット\s*多数|多数\s*(?:hit|ヒット))/iu.test(speciesWindow);
  return { present, known: false, count: null, lowerBound: null };
}

function parseTripHeader(text) {
  const date = /^(\d{1,2})\/(\d{1,2})（[^）]*）\s*/u.exec(text);
  if (!date) throw auditParseError("entry-header-unrecognized");
  const tail = text.slice(date[0].length);
  const lineBreak = tail.indexOf("\n");
  const firstLine = lineBreak >= 0 ? tail.slice(0, lineBreak) : tail;
  const remainingLines = lineBreak >= 0 ? tail.slice(lineBreak + 1).trim() : "";
  const daypartMatch = /【\s*(DAY|NIGHT)\s*】/iu.exec(firstLine);
  if (!daypartMatch) {
    return {
      month: Number(date[1]),
      day: Number(date[2]),
      daypart: "unknown",
      planLabel: collapseWhitespace(firstLine).slice(0, 160),
      afterHeader: tail.trim()
    };
  }
  const inlineRemainder = firstLine.slice(daypartMatch.index + daypartMatch[0].length).trim();
  return {
    month: Number(date[1]),
    day: Number(date[2]),
    daypart: daypartMatch[1].toUpperCase(),
    planLabel: collapseWhitespace(firstLine.slice(0, daypartMatch.index)),
    afterHeader: [inlineRemainder, remainingLines].filter(Boolean).join("\n")
  };
}

function extractSpeciesWindow(value, species) {
  const start = value.indexOf(species);
  if (start < 0) return "";
  const tail = value.slice(start + species.length);
  let end = tail.length;
  for (const other of OTHER_SPECIES) {
    const index = tail.indexOf(other);
    if (index >= 0 && index < end) end = index;
  }
  return `${species}${tail.slice(0, end)}`.slice(0, 240);
}

function firstResultContext(value) {
  const lines = value.split("\n").filter((line) => line.trim());
  const firstLine = lines.find((line) => ["シーバス", ...OTHER_SPECIES].some((species) => line.includes(species))) ?? lines[0] ?? "";
  return collapseWhitespace(firstLine).slice(0, 180);
}

function hasExplicitSeabassAttempt(value) {
  return /(?:シーバス(?:の[^。\n]{0,20})?(?:狙い|一本勝負|へ)|狙う(?:の|は)?[^。\n]{0,20}シーバス|シーバスを(?:狙|やって|ねら))/u.test(value);
}

function hasExplicitSeabassZero(value) {
  return /(?:シーバス[^。\n]{0,35}(?:次回へ持ち越し|不発|釣れず|釣れな|ノーキャッチ|ノーフィッシュ|0\s*get)|シーバスは次回へ持ち越し)/iu.test(value);
}

function parseEffort(planLabel) {
  const normalizedPlanLabel = normalizeAsciiDigits(planLabel);
  const explicit = /(\d{1,2}(?:\.\d+)?)\s*時間/u.exec(normalizedPlanLabel);
  if (explicit) return { known: true, minutes: Math.round(Number(explicit[1]) * 60), source: "entry-explicit" };
  const combo = /コンボ(?:便)?\s*([45689])(?:\b|時間|h)/iu.exec(normalizedPlanLabel);
  if (combo && COMBO_DURATION_MINUTES.has(Number(combo[1]))) {
    return { known: true, minutes: COMBO_DURATION_MINUTES.get(Number(combo[1])), source: "service-plan" };
  }
  if (/チョイノリ/u.test(normalizedPlanLabel) && !/コンボ/u.test(normalizedPlanLabel)) {
    return { known: true, minutes: 120, source: "service-plan" };
  }
  return { known: false, minutes: null, source: null };
}

function parseEnvironmentalClues(value) {
  return {
    flow: /(?:流れ|カレント)/u.test(value),
    rain: /(?:雨|台風|梅雨)/u.test(value),
    wind: /(?:(?<!台)風|無風)/u.test(value),
    garbage: /(?:ゴミ|ごみ| debris)/iu.test(value),
    tide: /(?:潮|潮止まり|潮変わり)/u.test(value),
    waterCondition: /(?:水が良|水色|濁り|クリア|水質)/u.test(value),
    bait: /(?:ベイト|ハゼ|イワシ|バチ)/u.test(value)
  };
}

function parseActivationClues(value) {
  const clues = [];
  if (/(?:夕マズメ|朝マズメ|明るい時間|暗くな)/u.test(value)) clues.push("twilight");
  if (/(?:明暗|常夜灯|ライト|灯り)/u.test(value)) clues.push("lighting");
  if (/(?:流れ|カレント)/u.test(value)) clues.push("current");
  if (/(?:魚はいっぱいい|魚はいる|魚が見え|見えシーバス)/u.test(value)) clues.push("fish-visible-or-present");
  if (/ショートバイト/u.test(value)) clues.push("short-bite");
  if (/チェイス/u.test(value)) clues.push("chase");
  if (/(?:バラし|ばらし|フックアウト)/u.test(value)) clues.push("missed-fish");
  return clues;
}

function parseStructuralClues(value) {
  const clues = [];
  if (/(?:壁|ヘチ)/u.test(value)) clues.push("wall");
  if (/(?:橋脚|ストラクチャ)/u.test(value)) clues.push("structure");
  if (/シャロー/u.test(value)) clues.push("shallow");
  if (/(?:運河|港|マリーナ)/u.test(value)) clues.push("harbor-or-canal");
  if (/(?:湾央|東京湾)/u.test(value)) clues.push("open-bay");
  if (/(?:明暗|常夜灯)/u.test(value)) clues.push("light");
  if (/(?:エリアを変え|場所を変え|移動)/u.test(value)) clues.push("area-movement");
  return clues;
}

function parseSourceLocation(value) {
  return value.match(/東京湾奥/u)?.[0]
    ?? value.match(/東京湾/u)?.[0]
    ?? value.match(/東京の海/u)?.[0]
    ?? value.match(/湾奥/u)?.[0]
    ?? value.match(/勝どき/u)?.[0]
    ?? null;
}

function inferTargetKey(value) {
  if (/(?:クロダイ|チヌ|キビレ)/u.test(value)) return "black-seabream";
  if (/マゴチ/u.test(value)) return "flathead";
  if (/タチウオ/u.test(value)) return "cutlassfish";
  if (/(?:サワラ|青物|イナダ|ワラサ|ブリ)/u.test(value)) return "pelagic";
  return "unknown";
}

function classifyFoundationConvertibility(input) {
  if (input.getCountKnown && input.getCount > 0) return "positive-catch";
  if (input.explicitZeroCatchCandidate && input.effortDurationKnown) return "explicit-effort-zero-catch";
  if (
    input.seabassContactAttributed
    && (input.hitEvidencePresent || input.chaseMentioned || input.biteMentioned || input.followMentioned)
  ) return "bite-or-contact";
  return null;
}

function foundationGapReasons({ hitResult, chaseMentioned, biteMentioned, followMentioned }) {
  return unique([
    ...(hitResult.known ? ["hit-count-not-representable"] : []),
    ...(hitResult.lowerBound !== null ? ["hit-lower-bound-not-representable"] : []),
    ...(hitResult.present && !hitResult.known && hitResult.lowerBound === null ? ["hit-presence-detail-not-representable"] : []),
    ...(chaseMentioned ? ["chase-not-representable"] : []),
    ...(biteMentioned ? ["bite-detail-not-representable"] : []),
    ...(followMentioned ? ["follow-not-representable"] : [])
  ]);
}

function failedTripRecord({ sourceRecordId, sourceUrl, diagnostic }) {
  return {
    sourceRecordId,
    sourceEventKey: null,
    sourceUrl,
    eventDate: null,
    daypart: "unknown",
    eventClockTime: null,
    temporalPrecision: "unknown",
    seabassTargeted: null,
    seabassMentioned: false,
    getCountKnown: false,
    getCount: null,
    hitCountKnown: false,
    hitCount: null,
    hitCountLowerBound: null,
    hitEvidencePresent: false,
    chaseMentioned: false,
    biteMentioned: false,
    followMentioned: false,
    explicitSeabassAttempt: false,
    explicitZeroCatchCandidate: false,
    eligibilityReason: null,
    effortDurationKnown: false,
    effortDurationMinutes: null,
    durationSource: null,
    environmentalClues: { flow: false, rain: false, wind: false, garbage: false, tide: false, waterCondition: false, bait: false },
    activationClues: [],
    structuralClues: [],
    sourceLocationMentioned: false,
    sourceLocationLabel: null,
    foundationConvertibleType: null,
    foundationGaps: [],
    parseStatus: "error",
    diagnostics: [diagnostic]
  };
}

function markDuplicateEventKeys(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record.sourceEventKey) continue;
    counts.set(record.sourceEventKey, (counts.get(record.sourceEventKey) ?? 0) + 1);
  }
  for (const record of records) {
    if (record.sourceEventKey && counts.get(record.sourceEventKey) > 1) {
      record.diagnostics = unique([...record.diagnostics, "duplicate-source-event-key"]);
    }
  }
}

function compareWithUmineko(kachidoki) {
  return {
    baseline: { source: "umineko", ...UMINEKO_REFERENCE },
    kachidoki,
    deltas: {
      catchCountCoverageAmongRelevant: decimalDelta(kachidoki.catchCountCoverageAmongRelevant, UMINEKO_REFERENCE.catchCountCoverageAmongRelevant),
      explicitZeroCount: kachidoki.explicitZeroCount - UMINEKO_REFERENCE.explicitZeroCount,
      durationKnownRate: decimalDelta(kachidoki.durationKnownRate, UMINEKO_REFERENCE.durationKnownRate),
      sourceLocationRate: decimalDelta(kachidoki.sourceLocationRate, UMINEKO_REFERENCE.sourceLocationRate)
    }
  };
}

function classifySourceUsefulness(metrics) {
  return {
    catchEvidence: coverageLevel(metrics.getKnownCount, metrics.targetedCount, 0.75, 0.4),
    activationEvidence: coverageLevel(Math.max(metrics.anyHitCount, metrics.environmentalCount), metrics.targetedCount, 0.6, 0.3),
    effortEvidence: coverageLevel(metrics.durationKnownCount, metrics.targetedCount, 0.75, 0.4),
    temporalPrecision: coverageLevel(metrics.daypartKnownCount, metrics.parsedCount, 0.9, 0.5),
    spatialPrecision: coverageLevel(Math.max(metrics.sourceLocationCount, metrics.structureCount), metrics.targetedCount, 0.75, 0.3),
    negativeEvidence: metrics.explicitZeroCount >= 3 ? "strong" : metrics.explicitZeroCount >= 1 ? "moderate" : "weak"
  };
}

function coverageLevel(numerator, denominator, strongAt, moderateAt) {
  const value = denominator > 0 ? numerator / denominator : 0;
  if (value >= strongAt) return "strong";
  if (value >= moderateAt) return "moderate";
  return "weak";
}

function clueOccurrences(records) {
  const values = [];
  for (const record of records) {
    for (const [name, present] of Object.entries(record.environmentalClues)) if (present) values.push(name);
    values.push(...record.activationClues);
  }
  return listOccurrences(values);
}

function listOccurrences(values) {
  const counts = new Map();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function normalizeKachidokiResultsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== KACHIDOKI_HOST) throw new Error("Only official Kachidoki Marina HTTPS URLs are allowed.");
  if (!/^\/fishing-results(?:-20\d{4})?\/?$/u.test(url.pathname)) throw new Error("URL is outside the official fishing-results catalog.");
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`<meta\\s+property=["']${escaped}["']\\s+content=["']([^"']*)["']`, "iu").exec(html)?.[1] ?? null;
}

function htmlToText(html) {
  if (!html) return "";
  return decodeHtmlEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/(?:p|div|li|figcaption|figure)>/giu, "\n")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => collapseWhitespace(line))
    .filter(Boolean)
    .join("\n");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function attributeValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}=["']([^"']*)["']`, "iu").exec(attributes)?.[1] ?? null;
}

function auditFetchError(error, sourceMonth, url) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const statusMatch = /HTTP\s+(\d{3})/u.exec(String(error?.message ?? ""));
  const resolvedStatus = status ?? (statusMatch ? Number(statusMatch[1]) : null);
  return {
    sourceMonth,
    url,
    reason: error?.code === "source_fetch_failed" ? "fetch-error" : "month-audit-error",
    status: resolvedStatus,
    rateLimited: resolvedStatus === 403 || resolvedStatus === 429,
    message: String(error?.message ?? "unknown error").slice(0, 200)
  };
}

function auditParseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function monthRange(months) {
  if (months.length === 0) return null;
  const values = months.map((month) => month.sourceMonth).sort();
  return { from: values[0], to: values.at(-1) };
}

function requireYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("sourceYear is invalid.");
  return year;
}

function requireMonth(value) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("sourceMonth is invalid.");
  return month;
}

function isValidDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseInteger(value, label, min, max) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${label} must be ${min}..${max}.`);
  return parsed;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return value;
}

function decimalDelta(left, right) {
  if (left === null || right === null) return null;
  return Number((left - right).toFixed(4));
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function collapseWhitespace(value) {
  return String(value).replace(/[\t\f\v ]+/gu, " ").trim();
}

function normalizeAsciiDigits(value) {
  return String(value).replace(/[０-９]/gu, (digit) => String(digit.codePointAt(0) - 0xff10));
}

function unique(values) {
  return [...new Set(values)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-kachidoki-historical-audit.mjs

Optional:
  --max-entries <1..100>
  --max-months <1..12>
  --delay-ms <0..10000>
  --collected-at <canonical UTC ISO>
`);
}

async function main() {
  const options = parseKachidokiAuditArgs();
  if (options.help) return printHelp();
  const report = await runKachidokiHistoricalAudit(options);
  const { records: _records, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`kachidoki_historical_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
