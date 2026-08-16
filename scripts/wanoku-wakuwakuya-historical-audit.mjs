#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WAKUWAKUYA_HISTORICAL_AUDIT_VERSION = "wanoku-wakuwakuya-historical-evidence-audit.v1";
export const WAKUWAKUYA_ARCHIVE_URL = "https://wakuwakuya.jp/blog.php";

const WAKUWAKUYA_HOST = "wakuwakuya.jp";
const MAX_MONTHS = 12;
const MAX_RECORDS = 120;
const DEFAULT_DELAY_MS = 200;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SEABASS_PATTERN = /(?:シーバス|セイゴ|フッコ|スズキ)/u;
const OTHER_SPECIES_PATTERN = /(?:クロダイ|チヌ|キビレ|マゴチ|カサゴ|アジ|サワラ|タチウオ|青物|サバ|イナダ|ワラサ|ブリ|タコ|メバル|ヒラメ|マダイ|真鯛|タイ|フグ|エイ|イシモチ)/u;

const UMINEKO_REFERENCE = Object.freeze({
  sampleSize: 50,
  seabassRelatedCount: 14,
  evidenceGeneratedCount: 3,
  catchNumericRateAmongRelevant: 0.2143,
  explicitZeroCount: 0,
  durationKnownRate: 0.0714,
  sourceLocationRate: 0.0714
});

const KACHIDOKI_REFERENCE = Object.freeze({
  sampleSize: 100,
  seabassRelatedCount: 65,
  seabassTargetedCount: 56,
  numericGetRateAmongTargeted: 0.7321,
  positiveCatchCount: 40,
  explicitZeroCount: 1,
  durationKnownRateAmongTargeted: 1,
  anyContactCountAmongTargeted: 29,
  exactContactCountAmongTargeted: 18,
  biteCountAmongTargeted: 15,
  chaseCountAmongTargeted: 2,
  sourceLocationCountAmongTargeted: 4,
  directConvertibilityCount: 46,
  foundationGapCount: 32,
  directAndGapCanOverlap: true
});

const KACHIDOKI_COMMON_INTERACTION_SUPPORT = Object.freeze({
  interactionPresent: true,
  interactionCount: true,
  interactionCountLowerBound: true,
  biteMentioned: true,
  chaseMentioned: true,
  lostFishMentioned: true
});

export function parseWakuwakuyaAuditArgs(argv = process.argv.slice(2)) {
  const options = { maxRecords: MAX_RECORDS, maxMonths: MAX_MONTHS, delayMs: DEFAULT_DELAY_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--max-records") options.maxRecords = parseInteger(readValue(), "max-records", 1, MAX_RECORDS);
    else if (arg === "--max-months") options.maxMonths = parseInteger(readValue(), "max-months", 1, MAX_MONTHS);
    else if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, 10_000);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function discoverWakuwakuyaMonths(html) {
  if (typeof html !== "string") throw new Error("archive HTML must be a string.");
  const months = new Map();
  const pattern = /<a\b[^>]*href=["']([^"']*blog\.php\?f=m(?:&amp;|&)mon=(20\d{2}-\d{2})[^"']*)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const sourceMonth = match[2];
    if (!isSourceMonth(sourceMonth) || months.has(sourceMonth)) continue;
    const label = htmlToText(match[3]);
    const countMatch = /[（(](\d+)[）)]/u.exec(normalizeAsciiDigits(label));
    const url = new URL(decodeHtmlEntities(match[1]), WAKUWAKUYA_ARCHIVE_URL);
    url.search = `?f=m&mon=${sourceMonth}`;
    months.set(sourceMonth, {
      sourceMonth,
      url: url.href,
      advertisedRecordCount: countMatch ? Number(countMatch[1]) : null
    });
  }
  return [...months.values()].sort((left, right) => right.sourceMonth.localeCompare(left.sourceMonth));
}

export function parseWakuwakuyaMonthlyPage({ html, url, sourceMonth }) {
  if (typeof html !== "string") throw new Error("monthly HTML must be a string.");
  if (!isSourceMonth(sourceMonth)) throw new Error("sourceMonth is invalid.");
  const sourceUrl = normalizeWakuwakuyaMonthUrl(url, sourceMonth);
  const sectionPattern = /<section\b[^>]*\bclass=["'][^"']*\bframe\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/giu;
  const sections = [...html.matchAll(sectionPattern)];
  const records = sections.map((section) => {
    try {
      return parseWakuwakuyaRecord({ sectionHtml: section[1], sourceUrl, sourceMonth });
    } catch (error) {
      return failedWakuwakuyaRecord({ sourceUrl, diagnostic: error?.code ?? "record-parse-error" });
    }
  });
  markDuplicatePostIds(records);
  return { sourceMonth, sourceUrl, entryCount: sections.length, records };
}

export function parseWakuwakuyaRecord({ sectionHtml, sourceUrl, sourceMonth }) {
  if (typeof sectionHtml !== "string") throw auditParseError("record-html-invalid");
  const headingHtml = /<h2\b[^>]*>([\s\S]*?)<\/h2>/iu.exec(sectionHtml)?.[1];
  if (!headingHtml) throw auditParseError("record-heading-missing");
  const heading = htmlToText(headingHtml);
  const dateMatch = /(20\d{2})年(\d{1,2})月(\d{1,2})日[（(][^）)]*[）)]/u.exec(normalizeAsciiDigits(heading));
  if (!dateMatch) throw auditParseError("record-date-missing");
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  if (!isValidDate(year, month, day)) throw auditParseError("record-date-invalid");
  const eventDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (sourceMonth && !eventDate.startsWith(sourceMonth)) throw auditParseError("record-month-mismatch");

  const paragraphTexts = [...sectionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)].map((match) => htmlToText(match[1]));
  const body = paragraphTexts.filter(Boolean).join("\n");
  const identityIds = unique([...sectionHtml.matchAll(/funayado_images\/\d+_(\d+)_/giu)].map((match) => match[1]));
  const numericId = identityIds.length === 1 ? identityIds[0] : null;
  const sourceRecordId = numericId ? `post:${numericId}` : null;
  const url = numericId ? `https://${WAKUWAKUYA_HOST}/blog.php?f=d&id=${numericId}` : sourceUrl;
  const diagnostics = [];
  if (!numericId) diagnostics.push(identityIds.length > 1 ? "numeric-detail-id-ambiguous" : "numeric-detail-id-missing");

  const tripStatus = parseTripStatus(heading, body);
  const daypart = parseDaypart(heading);
  const seabassMentioned = SEABASS_PATTERN.test(`${heading}\n${body}`);
  const seabassTargeted = seabassMentioned ? isSeabassTargeted(heading, body) : null;
  const explicitSeabassEffort = tripStatus === "completed" && seabassTargeted === true;
  const seabassContext = extractSeabassContext(heading, body, seabassTargeted === true);
  const landed = parseLandedEvidence(seabassContext);
  const contact = parseContactEvidence(seabassContext);
  const biteMentioned = /(?:バイト|アタリ)/u.test(positiveInteractionContext(seabassContext));
  const chaseMentioned = /(?:チェイス|追尾)/u.test(seabassContext);
  const followMentioned = /(?:追って|追いかけ|付いてくる|ついてくる|後ろに付)/u.test(seabassContext);
  const lostFishMentioned = /(?:バラシ|バラし|ばらし|フックアウト|ラインブレイク|抜けて|抜けた)/u
    .test(positiveLostFishContext(seabassContext));
  const visibleFishMentioned = /(?:魚が見え|姿が見え|群れ|ボイル|飛び出)/u.test(seabassContext);
  const zeroPhrasePresent = /(?:生命感なし|反応なし|アタリなし|バイトなし|ノーバイト|釣れず|釣れな|不発|撃沈|姿(?:を)?見(?:られ|れ)ず|顔(?:を)?見(?:られ|れ)ず|ノーフィッシュ|0\s*本)/u.test(seabassContext);
  const zeroSegmentCandidate = explicitSeabassEffort && zeroPhrasePresent;
  const explicitZeroCandidate = Boolean(
    tripStatus === "completed"
    && zeroSegmentCandidate
    && !landed.positive
    && !contact.present
  );
  const effort = parseEffort(heading, body);
  const anglerCount = parseAnglerCount(heading, body);
  const conditionChange = parseConditionChange(body);
  const habitatClues = parseHabitatClues(`${heading}\n${body}`);
  const environmentalClues = parseEnvironmentalClues(body);
  const sourceLocationLabel = parseSourceLocation(`${heading}\n${body}`);
  const sourceEventKey = `${eventDate}-${daypart}-${seabassTargeted ? "seabass" : inferTargetKey(heading)}`;
  const informationLossFields = collectInformationLossFields({
    landed,
    contact,
    biteMentioned,
    chaseMentioned,
    followMentioned,
    lostFishMentioned,
    visibleFishMentioned,
    conditionChangeMentioned: conditionChange.mentioned,
    zeroSegmentCandidate
  });
  const currentFoundationConvertible = isCurrentFoundationConvertible({
    tripStatus,
    landed,
    contact,
    explicitZeroCandidate,
    durationKnown: effort.known,
    anglerCountKnown: anglerCount !== null
  });
  const foundationConvertibility = !currentFoundationConvertible
    ? "not-convertible"
    : informationLossFields.length === 0
      ? "convertible-without-loss"
      : "convertible-with-information-loss";

  if (daypart === "unknown") diagnostics.push("daypart-missing");
  else diagnostics.push("daypart-only-no-clock");
  if (zeroSegmentCandidate && !explicitZeroCandidate) diagnostics.push("segment-zero-not-trip-zero");
  if (tripStatus === "cancelled") diagnostics.push("cancelled-not-zero");
  if (informationLossFields.length > 0) diagnostics.push("foundation-information-loss");

  return {
    sourceRecordId,
    sourceEventKey,
    url,
    eventDate,
    tripStatus,
    daypart,
    temporalPrecision: daypart === "unknown" ? "date-only" : "daypart",
    exactClockKnown: false,
    seabassMentioned,
    seabassTargeted,
    landedCountKnown: landed.exact !== null,
    landedCount: landed.exact,
    landedCountLowerBound: landed.lowerBound,
    landedPositiveEvidence: landed.positive,
    contactEvidencePresent: contact.present,
    contactCountKnown: contact.exact !== null,
    contactCount: contact.exact,
    contactCountLowerBound: contact.lowerBound,
    biteMentioned,
    chaseMentioned,
    followMentioned,
    lostFishMentioned,
    visibleFishMentioned,
    explicitSeabassEffort,
    explicitZeroCandidate,
    zeroSegmentCandidate,
    durationKnown: effort.known,
    durationMinutes: effort.minutes,
    durationSource: effort.source,
    anglerCountKnown: anglerCount !== null,
    anglerCount,
    habitatClues,
    environmentalClues,
    conditionChangeMentioned: conditionChange.mentioned,
    conditionChangeTypes: conditionChange.types,
    outcomeBeforeAfterResolvable: conditionChange.beforeAfterResolvable,
    sourceLocationMentioned: sourceLocationLabel !== null,
    sourceLocationLabel,
    currentFoundationConvertible,
    foundationConvertibility,
    informationLossFields,
    parseStatus: "ok",
    diagnostics: unique(diagnostics)
  };
}

export async function runWakuwakuyaHistoricalAudit(options = {}) {
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const maxMonths = options.maxMonths ?? MAX_MONTHS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new Error(`maxRecords must be 1..${MAX_RECORDS}.`);
  if (!Number.isInteger(maxMonths) || maxMonths < 1 || maxMonths > MAX_MONTHS) throw new Error(`maxMonths must be 1..${MAX_MONTHS}.`);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error("delayMs must be 0..10000.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const auditedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  let requestCount = 0;
  const request = async (url) => {
    if (requestCount > 0 && delayMs > 0) await delay(delayMs);
    requestCount += 1;
    return fetchWakuwakuyaHtml(url, fetchImpl);
  };

  const archiveHtml = await request(WAKUWAKUYA_ARCHIVE_URL);
  const discoveredMonths = discoverWakuwakuyaMonths(archiveHtml).slice(0, maxMonths);
  const recordsByMonth = [];
  const fetchedMonths = [];
  const fetchErrors = [];
  let monthFetchAttempts = 0;
  let monthFetchSuccesses = 0;
  let abortedReason = null;

  for (const month of discoveredMonths) {
    monthFetchAttempts += 1;
    try {
      const html = await request(month.url);
      monthFetchSuccesses += 1;
      const parsed = parseWakuwakuyaMonthlyPage({ html, url: month.url, sourceMonth: month.sourceMonth });
      recordsByMonth.push({ sourceMonth: month.sourceMonth, records: parsed.records });
      fetchedMonths.push({
        sourceMonth: month.sourceMonth,
        sourceUrl: parsed.sourceUrl,
        advertisedRecordCount: month.advertisedRecordCount,
        pageRecordCount: parsed.entryCount,
        parseErrorCount: parsed.records.filter((record) => record.parseStatus !== "ok").length
      });
    } catch (error) {
      const failure = auditFetchError(error, month.sourceMonth, month.url);
      fetchErrors.push(failure);
      if (failure.rateLimited) {
        abortedReason = failure.reason;
        break;
      }
    }
  }

  const selection = selectEvenMonthlySample(recordsByMonth, maxRecords);
  const summary = aggregateWakuwakuyaAudit(selection.records, {
    auditedAt,
    requestCount,
    maxRecords,
    maxMonths,
    discoveredMonths,
    fetchedMonths,
    monthFetchAttempts,
    monthFetchSuccesses,
    fetchErrors,
    abortedReason,
    duplicateCount: selection.duplicateCount
  });
  return { ...summary, records: selection.records };
}

export function aggregateWakuwakuyaAudit(records, context = {}) {
  const all = [...records];
  const parsed = all.filter((record) => record.parseStatus === "ok");
  const stableIds = parsed.filter((record) => /^post:\d+$/u.test(record.sourceRecordId ?? ""));
  const cancelled = parsed.filter((record) => record.tripStatus === "cancelled");
  const related = parsed.filter((record) => record.seabassMentioned);
  const targeted = related.filter((record) => record.seabassTargeted === true);
  const incidental = related.filter((record) => record.seabassTargeted === false);
  const exactLanded = targeted.filter((record) => record.landedCountKnown);
  const lowerLanded = targeted.filter((record) => record.landedCountLowerBound !== null);
  const positive = targeted.filter((record) => record.landedPositiveEvidence);
  const tripZero = targeted.filter((record) => record.explicitZeroCandidate);
  const segmentZero = targeted.filter((record) => record.zeroSegmentCandidate);
  const contact = targeted.filter((record) => record.contactEvidencePresent);
  const exactContact = targeted.filter((record) => record.contactCountKnown);
  const lowerContact = targeted.filter((record) => record.contactCountLowerBound !== null);
  const bite = targeted.filter((record) => record.biteMentioned);
  const chase = targeted.filter((record) => record.chaseMentioned);
  const follow = targeted.filter((record) => record.followMentioned);
  const lost = targeted.filter((record) => record.lostFishMentioned);
  const visible = targeted.filter((record) => record.visibleFishMentioned);
  const changed = targeted.filter((record) => record.conditionChangeMentioned);
  const beforeAfter = changed.filter((record) => record.outcomeBeforeAfterResolvable);
  const duration = targeted.filter((record) => record.durationKnown);
  const anglers = targeted.filter((record) => record.anglerCountKnown);
  const daypart = parsed.filter((record) => record.temporalPrecision === "daypart");
  const exactClock = parsed.filter((record) => record.exactClockKnown);
  const sourceLocation = targeted.filter((record) => record.sourceLocationMentioned);
  const habitat = targeted.filter((record) => record.habitatClues.length > 0);
  const withoutLoss = related.filter((record) => record.foundationConvertibility === "convertible-without-loss");
  const withLoss = related.filter((record) => record.foundationConvertibility === "convertible-with-information-loss");
  const notConvertible = related.filter((record) => record.foundationConvertibility === "not-convertible");
  const interactionDecision = foundationInteractionDecision({
    contactCount: contact.length,
    exactContactCount: exactContact.length,
    lowerContactCount: lowerContact.length,
    biteCount: bite.length,
    chaseCount: chase.length,
    lostFishCount: lost.length
  });
  const sourceUsefulness = classifySourceUsefulness({
    targetedCount: targeted.length,
    positiveCount: positive.length,
    contactCount: contact.length,
    effortKnownCount: targeted.filter((record) => record.durationKnown || record.anglerCountKnown).length,
    parsedCount: parsed.length,
    daypartCount: daypart.length,
    exactClockCount: exactClock.length,
    sourceLocationCount: sourceLocation.length,
    explicitZeroCount: tripZero.length,
    habitatCount: habitat.length
  });
  const recommendedRoles = unique([
    ...(positive.length > 0 ? ["presence-positive"] : []),
    ...(contact.length > 0 ? ["activation-validation"] : []),
    ...(duration.length + anglers.length > 0 ? ["effort-aware"] : []),
    ...(tripZero.length > 0 ? ["negative-validation"] : []),
    ...(habitat.length > 0 ? ["habitat-context"] : []),
    ...(context.discoveredMonths?.length >= 12 ? ["seasonal-baseline"] : [])
  ]);
  const ingestionReadiness = parsed.length === 0 || related.length === 0 || stableIds.length === 0
    ? "NOT_READY"
    : stableIds.length === parsed.length && notConvertible.length === 0
      ? "READY"
      : "READY_WITH_LIMITATIONS";

  return {
    auditVersion: WAKUWAKUYA_HISTORICAL_AUDIT_VERSION,
    auditedAt: context.auditedAt ?? null,
    sourceStructure: {
      monthlyArchiveUrl: "blog.php?f=m&mon=YYYY-MM",
      recordBoundary: "section.frame",
      headingBoundary: "h2 > time plus service label",
      bodyBoundary: "section.frame .frame-inner p",
      numericIdentitySource: "funayado_images/<source>_<numeric-id>_<timestamp>_<image>.jpeg",
      detailUrl: "blog.php?f=d&id=<numeric-id>",
      monthlyPageContainsFullBody: true,
      monthlyFirstPageLimitObserved: 10
    },
    archive: {
      monthsDiscovered: context.discoveredMonths?.length ?? null,
      discoveredMonthRange: monthRange(context.discoveredMonths ?? []),
      monthsFetched: context.fetchedMonths?.length ?? null,
      fetchedMonths: context.fetchedMonths ?? [],
      recordsAudited: all.length,
      parsedRecords: parsed.length,
      parseSuccessRate: rate(parsed.length, all.length),
      cancelledRecords: cancelled.length,
      requestCount: context.requestCount ?? null,
      monthFetchAttempts: context.monthFetchAttempts ?? null,
      monthFetchSuccesses: context.monthFetchSuccesses ?? null,
      fetchSuccessRate: rate(context.monthFetchSuccesses ?? 0, context.monthFetchAttempts ?? 0),
      numericStableIdCount: stableIds.length,
      numericStableIdRate: rate(stableIds.length, parsed.length),
      duplicateCount: context.duplicateCount ?? 0,
      fetchErrors: context.fetchErrors ?? [],
      abortedReason: context.abortedReason ?? null
    },
    seabass: {
      relatedCount: related.length,
      targetedCount: targeted.length,
      targetedRateAmongParsed: rate(targeted.length, parsed.length),
      incidentalCount: incidental.length
    },
    catch: {
      denominator: "seabass-targeted records",
      exactLandedCountRecords: exactLanded.length,
      exactLandedCountRate: rate(exactLanded.length, targeted.length),
      landedLowerBoundRecords: lowerLanded.length,
      landedLowerBoundRate: rate(lowerLanded.length, targeted.length),
      positiveEvidenceRecords: positive.length,
      positiveEvidenceRate: rate(positive.length, targeted.length),
      explicitTripZeroCount: tripZero.length,
      zeroSegmentCount: segmentZero.length
    },
    activation: {
      denominator: "seabass-targeted records",
      anyContactCount: contact.length,
      anyContactRate: rate(contact.length, targeted.length),
      exactContactCountRecords: exactContact.length,
      exactContactCountRate: rate(exactContact.length, targeted.length),
      lowerBoundContactRecords: lowerContact.length,
      lowerBoundContactRate: rate(lowerContact.length, targeted.length),
      biteCount: bite.length,
      biteRate: rate(bite.length, targeted.length),
      chaseCount: chase.length,
      chaseRate: rate(chase.length, targeted.length),
      followCount: follow.length,
      lostFishCount: lost.length,
      lostFishRate: rate(lost.length, targeted.length),
      visibleFishCount: visible.length,
      visibleFishRate: rate(visible.length, targeted.length),
      conditionChangeCount: changed.length,
      conditionChangeRate: rate(changed.length, targeted.length),
      beforeAfterResolvableCount: beforeAfter.length,
      beforeAfterResolvableRate: rate(beforeAfter.length, changed.length),
      conditionChangeTypeOccurrences: listOccurrences(changed.flatMap((record) => record.conditionChangeTypes))
    },
    effort: {
      denominator: "seabass-targeted records",
      durationKnownCount: duration.length,
      durationKnownRate: rate(duration.length, targeted.length),
      anglerCountKnownCount: anglers.length,
      anglerCountKnownRate: rate(anglers.length, targeted.length)
    },
    temporal: {
      denominator: "parsed records",
      exactClockCount: exactClock.length,
      exactClockRate: rate(exactClock.length, parsed.length),
      daypartCount: daypart.length,
      daypartRate: rate(daypart.length, parsed.length),
      dateOnlyCount: parsed.length - daypart.length - exactClock.length,
      dateOnlyRate: rate(parsed.length - daypart.length - exactClock.length, parsed.length)
    },
    spatial: {
      denominator: "seabass-targeted records",
      sourceLocationCount: sourceLocation.length,
      sourceLocationRate: rate(sourceLocation.length, targeted.length),
      habitatClueCount: habitat.length,
      habitatClueRate: rate(habitat.length, targeted.length),
      habitatClueOccurrences: listOccurrences(targeted.flatMap((record) => record.habitatClues))
    },
    foundation: {
      denominator: "seabass-related records",
      convertibleWithoutLossCount: withoutLoss.length,
      convertibleWithoutLossRate: rate(withoutLoss.length, related.length),
      convertibleWithInformationLossCount: withLoss.length,
      convertibleWithInformationLossRate: rate(withLoss.length, related.length),
      notConvertibleCount: notConvertible.length,
      notConvertibleRate: rate(notConvertible.length, related.length),
      informationLossOccurrences: listOccurrences(withLoss.flatMap((record) => record.informationLossFields)),
      interactionEvidenceDecision: interactionDecision
    },
    comparison: {
      umineko: UMINEKO_REFERENCE,
      kachidoki: KACHIDOKI_REFERENCE,
      wakuwakuya: {
        sampleSize: parsed.length,
        seabassRelatedCount: related.length,
        seabassTargetedCount: targeted.length,
        exactLandedRateAmongTargeted: rate(exactLanded.length, targeted.length),
        positiveEvidenceCount: positive.length,
        explicitZeroCount: tripZero.length,
        durationKnownRateAmongTargeted: rate(duration.length, targeted.length),
        anyContactCountAmongTargeted: contact.length,
        exactContactCountAmongTargeted: exactContact.length,
        biteCountAmongTargeted: bite.length,
        chaseCountAmongTargeted: chase.length,
        sourceLocationCountAmongTargeted: sourceLocation.length
      },
      metricNote: "Kachidoki direct-convertibility and foundation-gap overlap; Wakuwakuya three-way classes are mutually exclusive."
    },
    sourceUsefulness,
    ingestionReadiness,
    recommendedRoles
  };
}

export async function fetchWakuwakuyaHtml(value, fetchImpl = globalThis.fetch) {
  const url = normalizeWakuwakuyaReadUrl(value);
  const response = await fetchImpl(url, { headers: { accept: "text/html" }, redirect: "follow" });
  if (!response?.ok) {
    const error = new Error(`Wakuwakuya source returned HTTP ${response?.status ?? "unknown"}.`);
    error.code = "source_fetch_failed";
    error.status = response?.status ?? null;
    throw error;
  }
  return response.text();
}

function parseTripStatus(heading, body) {
  const value = `${heading}\n${body}`;
  const currentTripCompleted = /(?:本日|今日は|本日は)[^。！？\n]{0,80}出船(?!\s*(?:中止|を中止|見合わせ))/u.test(value);
  if (!currentTripCompleted && /(?:出船(?:を)?中止|出船中止|欠航|中止とな|出船見合わせ)/u.test(value)) {
    return "cancelled";
  }
  if (/便/u.test(heading) || /(?:出船|ご乗船|帰着|終了(?:となり|でした|のお時間)|乗合い便|乗り合い便)/u.test(value)) return "completed";
  return "unknown";
}

function parseDaypart(heading) {
  if (/(?:ロング|長時間)/u.test(heading)) return "long";
  if (/(?:ナイト|夜便|夜乗合|夜乗り合)/u.test(heading)) return "night";
  if (/午前/u.test(heading)) return "morning";
  if (/午後/u.test(heading)) return "afternoon";
  return "unknown";
}

function isSeabassTargeted(heading, body) {
  if (SEABASS_PATTERN.test(heading)) return true;
  return /(?:シーバス|セイゴ|フッコ|スズキ)[^。！？\n]{0,24}(?:狙い|狙って|求めて|便|一本|メイン|へ移動|へ)|(?:狙う|狙いは)[^。！？\n]{0,24}(?:シーバス|セイゴ|フッコ|スズキ)/u.test(body);
}

function extractSeabassContext(heading, body, targeted) {
  const headingHasSeabass = SEABASS_PATTERN.test(heading);
  const match = SEABASS_PATTERN.exec(body);
  const fromSpecies = match ? body.slice(match.index) : targeted && headingHasSeabass ? body : headingHasSeabass ? heading : "";
  if (!fromSpecies) return "";
  const switchMatch = new RegExp(`(?:後半|続いて|次に|移動して|それから)[^。！？\\n]{0,35}${OTHER_SPECIES_PATTERN.source}[^。！？\\n]{0,16}(?:狙|へ|開始)`, "u").exec(fromSpecies);
  const otherSpeciesMatch = OTHER_SPECIES_PATTERN.exec(fromSpecies);
  const cutAt = Math.min(
    switchMatch?.index ?? Number.POSITIVE_INFINITY,
    otherSpeciesMatch?.index ?? Number.POSITIVE_INFINITY,
    500
  );
  return fromSpecies.slice(0, cutAt);
}

function parseLandedEvidence(value) {
  const normalized = normalizeAsciiDigits(value);
  const lower = /(\d+)\s*(?:本|匹|キャッチ|GET)\s*(?:以上|オーバー|超え|超)/iu.exec(normalized);
  if (lower) return { exact: null, lowerBound: Number(lower[1]), positive: true };
  const exactMatches = [...normalized.matchAll(/(\d+)\s*(?:本|匹|キャッチ|GET)/giu)].map((match) => Number(match[1]));
  const exact = exactMatches.length === 1 ? exactMatches[0] : null;
  const positive = exact !== null || /(?:キャッチ|GET|全員安打|入れ食い|連発|遊んで貰|遊んでもら|顔が見れた|釣れ(?:た|て|始め|続|まし)|お土産(?:を)?確保|(?:シーバス|セイゴ|フッコ|スズキ)(?:が|は)?ポツポツ(?!\s*(?:ヒット|バイト|アタリ)))/iu.test(normalized);
  return { exact, lowerBound: null, positive };
}

function parseContactEvidence(value) {
  const normalized = normalizeAsciiDigits(value);
  const lower = /(\d+)\s*(?:ヒット|hit|バイト|アタリ)\s*(?:以上|オーバー|超え|超)/iu.exec(normalized);
  if (lower && Number(lower[1]) > 0) return { present: true, exact: null, lowerBound: Number(lower[1]) };
  const exactMatches = [
    ...normalized.matchAll(/(\d+)\s*(?:ヒット|hit|バイト|アタリ)/giu),
    ...normalized.matchAll(/(?:ヒット|hit|バイト|アタリ)(?:は|が)\s*(\d+)(?:回)?/giu)
  ].map((match) => Number(match[1]));
  const uniqueCounts = unique(exactMatches.filter((count) => count > 0));
  const exact = uniqueCounts.length === 1 ? uniqueCounts[0] : null;
  const positiveContext = positiveInteractionContext(normalized);
  const reactionIsContact = /(?:ルアー|ワーム|ミノー)[^。！？\n]{0,18}反応|反応[^。！？\n]{0,18}(?:ヒット|バイト|アタリ)/u.test(normalized);
  const present = exact !== null
    || /(?:ヒット|hit|バイト|アタリ|チェイス|追尾|バラシ|バラし|ばらし|フックアウト|ラインブレイク)/iu.test(positiveContext)
    || reactionIsContact;
  return { present, exact, lowerBound: null };
}

function positiveInteractionContext(value) {
  return value
    .replace(/(?:アタリ|バイト|反応)(?:は|も|が)?(?:なし|無い|ない)/gu, "")
    .replace(/(?:ノーバイト|0\s*(?:ヒット|hit|バイト|アタリ))/giu, "");
}

function positiveLostFishContext(value) {
  return value.replace(/ベイト(?:が|も|は)?抜け(?:て|た)/gu, "");
}

function parseEffort(heading, body) {
  const value = normalizeAsciiDigits(`${heading}\n${body}`);
  const explicit = /(\d{1,2}(?:\.\d+)?)\s*時間/u.exec(value);
  if (explicit) return { known: true, minutes: Math.round(Number(explicit[1]) * 60), source: "entry-explicit" };
  return { known: false, minutes: null, source: "unknown" };
}

function parseAnglerCount(heading, body) {
  const value = normalizeAsciiDigits(`${heading}\n${body}`);
  const match = /(?:^|[\s、。！!])([1-9]\d*)\s*名(?:様)?/u.exec(value);
  return match ? Number(match[1]) : null;
}

function parseConditionChange(value) {
  const types = [];
  if (/(?:潮(?:が|も|の)?(?:変わ|止ま|動き|効き|緩み)|潮止まり|潮変わり)/u.test(value)) types.push("tide-change");
  if (/(?:流れ(?:が|も)?(?:出|止|変わ|効|無く|なく|弱く|強く))/u.test(value)) types.push("flow-change");
  if (/(?:風(?:が|も)?(?:出|吹|変わ|上が|止|強く|弱く)|風向き)/u.test(value)) types.push("wind-change");
  if (/(?:ベイト(?:が|も)?(?:抜け|入|消え|見え|変わ))/u.test(value)) types.push("bait-change");
  if (/(?:ポイント(?:を|も)?(?:移動|変え)|場所を変え|移動(?:して|後|すると|したら))/u.test(value)) types.push("location-change");
  if (/(?:暗くな|明るくな|日が昇|日が落|朝マズメ|夕マズメ)/u.test(value)) types.push("light-change");
  if (types.length === 0 && /(?:状況|活性)[^。！？\n]{0,20}(?:変わ|上が|下が)/u.test(value)) types.push("other");
  const outcome = "(?:ヒット|アタリ|バイト|反応|釣れ|入れ食い|連発|消え|減|無く|なく|なし|不発)";
  const change = "(?:潮|流れ|風|ベイト|ポイント|場所|移動|暗く|明るく|状況|活性)";
  const beforeAfterResolvable = new RegExp(`${change}[^。！？\\n]{0,90}${outcome}|${outcome}[^。！？\\n]{0,90}${change}`, "u").test(value);
  return { mentioned: types.length > 0, types, beforeAfterResolvable: types.length > 0 && beforeAfterResolvable };
}

function parseHabitatClues(value) {
  const clues = [];
  if (/シャロー/u.test(value)) clues.push("shallow");
  if (/(?:ストラクチャ|橋脚)/u.test(value)) clues.push("structure");
  if (/(?:沖のストラクチャ|沖スト|沖の構造物)/u.test(value)) clues.push("offshore-structure");
  if (/(?:壁|ヘチ)/u.test(value)) clues.push("wall");
  if (/(?:穴撃ち|穴打ち|穴を撃)/u.test(value)) clues.push("hole");
  if (/(?:港内|港|マリーナ)/u.test(value)) clues.push("harbor");
  if (/運河/u.test(value)) clues.push("canal");
  if (/(?:河川|川筋|河口)/u.test(value)) clues.push("river-or-estuary");
  if (/(?:湾央|沖へ|沖合)/u.test(value)) clues.push("open-water");
  if (/(?:岸際|沿岸|近岸)/u.test(value)) clues.push("nearshore");
  return unique(clues);
}

function parseEnvironmentalClues(value) {
  const clues = [];
  if (/(?:流れ|潮が効)/u.test(value)) clues.push("flow");
  if (/(?:潮止まり|潮変わり|潮が動)/u.test(value)) clues.push("tide");
  if (/(?:(?<!台)風|無風)/u.test(value)) clues.push("wind");
  if (/(?:雨|雷雨|台風|豪雨)/u.test(value)) clues.push("rain");
  if (/(?:ベイト|イワシ|バチ|ハゼ)/u.test(value)) clues.push("bait");
  if (/(?:水色|濁り|水が良|水の感じ|クリア)/u.test(value)) clues.push("water-condition");
  if (/(?:明暗|マズメ|暗くな|明るくな)/u.test(value)) clues.push("light");
  if (/(?:魚探|反応)/u.test(value)) clues.push("fish-response");
  return unique(clues);
}

function parseSourceLocation(value) {
  return value.match(/東京湾奥/u)?.[0]
    ?? value.match(/東京湾/u)?.[0]
    ?? value.match(/湾奥/u)?.[0]
    ?? value.match(/隅田川/u)?.[0]
    ?? value.match(/荒川/u)?.[0]
    ?? value.match(/羽田/u)?.[0]
    ?? value.match(/横浜/u)?.[0]
    ?? null;
}

function inferTargetKey(heading) {
  if (SEABASS_PATTERN.test(heading)) return "seabass";
  if (/(?:チヌ|クロダイ|キビレ|チニング)/u.test(heading)) return "black-seabream";
  if (/マゴチ/u.test(heading)) return "flathead";
  if (/カサゴ/u.test(heading)) return "rockfish";
  if (/アジ/u.test(heading)) return "horse-mackerel";
  if (/(?:サワラ|青物)/u.test(heading)) return "pelagic";
  return "unknown";
}

function collectInformationLossFields(input) {
  return unique([
    ...(input.landed.lowerBound !== null ? ["landed-lower-bound"] : []),
    ...(input.landed.positive && input.landed.exact === null && input.landed.lowerBound === null ? ["landed-positive-nonnumeric"] : []),
    ...(input.contact.exact !== null ? ["contact-count"] : []),
    ...(input.contact.lowerBound !== null ? ["contact-lower-bound"] : []),
    ...(input.biteMentioned ? ["bite"] : []),
    ...(input.chaseMentioned ? ["chase"] : []),
    ...(input.followMentioned ? ["follow"] : []),
    ...(input.lostFishMentioned ? ["lost-fish"] : []),
    ...(input.visibleFishMentioned ? ["visible-fish"] : []),
    ...(input.conditionChangeMentioned ? ["condition-change"] : []),
    ...(input.zeroSegmentCandidate ? ["segment-zero"] : [])
  ]);
}

function isCurrentFoundationConvertible(input) {
  if (input.tripStatus === "cancelled") return false;
  if (input.landed.positive || input.contact.present) return true;
  return input.explicitZeroCandidate && (input.durationKnown || input.anglerCountKnown);
}

function foundationInteractionDecision(metrics) {
  const supported = {
    interactionPresent: metrics.contactCount,
    interactionCount: metrics.exactContactCount,
    interactionCountLowerBound: metrics.lowerContactCount,
    biteMentioned: metrics.biteCount,
    chaseMentioned: metrics.chaseCount,
    lostFishMentioned: metrics.lostFishCount
  };
  const proposedMinimalCommonSemantics = Object.entries(supported)
    .filter(([name, count]) => count > 0 && KACHIDOKI_COMMON_INTERACTION_SUPPORT[name])
    .map(([name]) => name);
  const decision = supported.interactionPresent > 0 && proposedMinimalCommonSemantics.length >= 2 ? "YES" : "NOT_YET";
  return { decision, proposedMinimalCommonSemantics: decision === "YES" ? proposedMinimalCommonSemantics : [], wakuwakuyaOccurrences: supported };
}

function classifySourceUsefulness(metrics) {
  const temporalPrecision = metrics.exactClockCount > 0 && rateValue(metrics.exactClockCount, metrics.parsedCount) >= 0.5
    ? "strong"
    : rateValue(metrics.daypartCount + metrics.exactClockCount, metrics.parsedCount) >= 0.5
      ? "moderate"
      : "weak";
  return {
    presenceEvidence: coverageLevel(metrics.positiveCount, metrics.targetedCount, 0.7, 0.35),
    activationEvidence: coverageLevel(metrics.contactCount, metrics.targetedCount, 0.6, 0.25),
    effortEvidence: coverageLevel(metrics.effortKnownCount, metrics.targetedCount, 0.75, 0.4),
    temporalPrecision,
    spatialPrecision: coverageLevel(metrics.sourceLocationCount, metrics.targetedCount, 0.7, 0.25),
    negativeEvidence: metrics.explicitZeroCount >= 3 ? "strong" : metrics.explicitZeroCount >= 1 ? "moderate" : "weak",
    habitatContext: coverageLevel(metrics.habitatCount, metrics.targetedCount, 0.6, 0.25)
  };
}

function coverageLevel(numerator, denominator, strongAt, moderateAt) {
  const value = rateValue(numerator, denominator);
  if (value >= strongAt) return "strong";
  if (value >= moderateAt) return "moderate";
  return "weak";
}

function selectEvenMonthlySample(recordsByMonth, limit) {
  const records = [];
  const seen = new Set();
  let duplicateCount = 0;
  for (let offset = 0; records.length < limit; offset += 1) {
    let found = false;
    for (const month of recordsByMonth) {
      const record = month.records[offset];
      if (!record) continue;
      found = true;
      const dedupeKey = record.sourceRecordId ?? `${month.sourceMonth}:${record.sourceEventKey ?? `parse-error:${offset}`}`;
      if (seen.has(dedupeKey)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(dedupeKey);
      records.push(record);
      if (records.length >= limit) break;
    }
    if (!found) break;
  }
  return { records, duplicateCount };
}

function failedWakuwakuyaRecord({ sourceUrl, diagnostic }) {
  return {
    sourceRecordId: null,
    sourceEventKey: null,
    url: sourceUrl,
    eventDate: null,
    tripStatus: "unknown",
    daypart: "unknown",
    temporalPrecision: "unknown",
    exactClockKnown: false,
    seabassMentioned: false,
    seabassTargeted: null,
    landedCountKnown: false,
    landedCount: null,
    landedCountLowerBound: null,
    landedPositiveEvidence: false,
    contactEvidencePresent: false,
    contactCountKnown: false,
    contactCount: null,
    contactCountLowerBound: null,
    biteMentioned: false,
    chaseMentioned: false,
    followMentioned: false,
    lostFishMentioned: false,
    visibleFishMentioned: false,
    explicitSeabassEffort: false,
    explicitZeroCandidate: false,
    zeroSegmentCandidate: false,
    durationKnown: false,
    durationMinutes: null,
    durationSource: "unknown",
    anglerCountKnown: false,
    anglerCount: null,
    habitatClues: [],
    environmentalClues: [],
    conditionChangeMentioned: false,
    conditionChangeTypes: [],
    outcomeBeforeAfterResolvable: false,
    sourceLocationMentioned: false,
    sourceLocationLabel: null,
    currentFoundationConvertible: false,
    foundationConvertibility: "not-convertible",
    informationLossFields: [],
    parseStatus: "error",
    diagnostics: [diagnostic]
  };
}

function markDuplicatePostIds(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record.sourceRecordId) continue;
    counts.set(record.sourceRecordId, (counts.get(record.sourceRecordId) ?? 0) + 1);
  }
  for (const record of records) {
    if (record.sourceRecordId && counts.get(record.sourceRecordId) > 1) {
      record.diagnostics = unique([...record.diagnostics, "duplicate-source-record-id"]);
    }
  }
}

function normalizeWakuwakuyaReadUrl(value) {
  const url = new URL(value, WAKUWAKUYA_ARCHIVE_URL);
  if (url.protocol !== "https:" || url.hostname !== WAKUWAKUYA_HOST || url.pathname !== "/blog.php") {
    throw new Error("Only the official Wakuwakuya blog catalog is allowed.");
  }
  const mode = url.searchParams.get("f");
  if (url.search === "" || (mode === "m" && isSourceMonth(url.searchParams.get("mon")))) {
    if (mode === "m") return normalizeWakuwakuyaMonthUrl(url.href, url.searchParams.get("mon"));
    url.hash = "";
    return url.href;
  }
  throw new Error("URL is outside the official read-only archive scope.");
}

function normalizeWakuwakuyaMonthUrl(value, sourceMonth) {
  if (!isSourceMonth(sourceMonth)) throw new Error("sourceMonth is invalid.");
  const url = new URL(value, WAKUWAKUYA_ARCHIVE_URL);
  if (url.protocol !== "https:" || url.hostname !== WAKUWAKUYA_HOST || url.pathname !== "/blog.php") {
    throw new Error("Only the official Wakuwakuya blog catalog is allowed.");
  }
  url.search = `?f=m&mon=${sourceMonth}`;
  url.hash = "";
  return url.href;
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

function htmlToText(html) {
  if (!html) return "";
  return decodeHtmlEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/(?:p|div|li|h2|time)>/giu, "\n")
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
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function normalizeAsciiDigits(value) {
  return String(value).replace(/[０-９]/gu, (digit) => String(digit.codePointAt(0) - 0xff10));
}

function listOccurrences(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function monthRange(months) {
  if (months.length === 0) return null;
  const values = months.map((month) => month.sourceMonth).sort();
  return { from: values[0], to: values.at(-1) };
}

function isSourceMonth(value) {
  if (typeof value !== "string" || !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(value)) return false;
  return true;
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

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function rateValue(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function unique(values) {
  return [...new Set(values)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-wakuwakuya-historical-audit.mjs

Optional:
  --max-records <1..120>
  --max-months <1..12>
  --delay-ms <0..10000>
  --collected-at <canonical UTC ISO>
`);
}

async function main() {
  const options = parseWakuwakuyaAuditArgs();
  if (options.help) return printHelp();
  const report = await runWakuwakuyaHistoricalAudit(options);
  const { records: _records, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`wakuwakuya_historical_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
