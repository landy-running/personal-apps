#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildYokohamaGraphqlGetUrl,
  buildYokohamaMonthlyQuery,
  canonicalFixedNodeSpeciesGroup,
  extractYokohamaBundleUrl,
  extractYokohamaReadConfig,
  normalizeYokohamaAppSyncEndpoint,
  normalizeYokohamaAssetUrl,
  parseYokohamaLastPost as parseYokohamaSourceRecord,
  YOKOHAMA_FIXED_NODE_SPECIES_GROUPS
} from "../workers/wanoku-intel-worker/src/yokohama-fixed-node-source.js";

export { extractYokohamaReadConfig };

export const COASTAL_FIXED_NODE_AUDIT_VERSION = "wanoku-coastal-fixed-node-historical-audit.v1";
export const YOKOHAMA_ROOT_URL = "https://yokohama-fishingpiers.jp/";
export const ICHIHARA_ARCHIVE_URL = "https://ichihara-umizuri.com/fishing/";

const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 36;
const DEFAULT_DELAY_MS = 100;
const MAX_DELAY_MS = 10_000;
const MAX_ICHIHARA_PAGES = 30;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const YOKOHAMA_HOST = "yokohama-fishingpiers.jp";
const ICHIHARA_HOST = "ichihara-umizuri.com";

export const COASTAL_FACILITIES = Object.freeze([
  Object.freeze({
    facilityId: "yokohama-honmoku",
    providerId: "yokohama-fishing-piers",
    providerFacilityKey: "honmoku",
    label: "本牧海づり施設",
    sourceUrl: "https://yokohama-fishingpiers.jp/honmoku/fishing-history",
    officialCoordinates: null,
    sourceFamily: "yokohama-appsync"
  }),
  Object.freeze({
    facilityId: "yokohama-daikoku",
    providerId: "yokohama-fishing-piers",
    providerFacilityKey: "daikoku",
    label: "大黒海づり施設",
    sourceUrl: "https://yokohama-fishingpiers.jp/daikoku/fishing-history",
    officialCoordinates: null,
    sourceFamily: "yokohama-appsync"
  }),
  Object.freeze({
    facilityId: "yokohama-isogo",
    providerId: "yokohama-fishing-piers",
    providerFacilityKey: "isogo",
    label: "磯子海づり施設",
    sourceUrl: "https://yokohama-fishingpiers.jp/isogo/fishing-history",
    officialCoordinates: null,
    sourceFamily: "yokohama-appsync"
  }),
  Object.freeze({
    facilityId: "ichihara-original-maker",
    providerId: "ichihara-umizuri",
    providerFacilityKey: "original-maker",
    label: "オリジナルメーカー海づり公園",
    sourceUrl: ICHIHARA_ARCHIVE_URL,
    officialCoordinates: null,
    sourceFamily: "ichihara-wordpress"
  })
]);

const AUDIT_SPECIES_GROUPS = Object.freeze(Object.keys(YOKOHAMA_FIXED_NODE_SPECIES_GROUPS));
const SOURCE_FIELD_COVERAGE = Object.freeze({
  "yokohama-appsync": Object.freeze({
    dailyRecord: "EXACT",
    stableRecordIdentity: "EXACT",
    speciesCatchCount: "EXACT",
    seabassCatch: "EXACT",
    size: "EXACT",
    visitors: "EXACT",
    operatingHours: "PARTIAL",
    closure: "TEXT_ONLY",
    weather: "EXACT",
    waterTemperature: "EXACT",
    tide: "EXACT",
    method: "UNAVAILABLE",
    timeOfDay: "UNAVAILABLE",
    facilityArea: "EXACT",
    baitSpecies: "EXACT",
    publicationTimestamp: "PARTIAL"
  }),
  "ichihara-wordpress": Object.freeze({
    dailyRecord: "EXACT",
    stableRecordIdentity: "EXACT",
    speciesCatchCount: "EXACT",
    seabassCatch: "EXACT",
    size: "EXACT",
    visitors: "EXACT",
    operatingHours: "PARTIAL",
    closure: "TEXT_ONLY",
    weather: "EXACT",
    waterTemperature: "EXACT",
    tide: "EXACT",
    method: "UNAVAILABLE",
    timeOfDay: "UNAVAILABLE",
    facilityArea: "TEXT_ONLY",
    baitSpecies: "EXACT",
    publicationTimestamp: "UNAVAILABLE"
  })
});

export function parseCoastalAuditArgs(argv = process.argv.slice(2)) {
  const options = { months: DEFAULT_MONTHS, delayMs: DEFAULT_DELAY_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--months") options.months = parseInteger(readValue(), "months", 1, MAX_MONTHS);
    else if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, MAX_DELAY_MS);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function parseYokohamaLastPost(item, context) {
  const facility = COASTAL_FACILITIES.find((candidate) => (
    candidate.facilityId === context?.facilityId && candidate.sourceFamily === "yokohama-appsync"
  ));
  if (!facility) throw new Error(`Unknown yokohama-appsync facility: ${context?.facilityId}`);
  return parseYokohamaSourceRecord(item, { ...context, facility });
}

export function parseIchiharaListingPage(html, pageUrl = ICHIHARA_ARCHIVE_URL) {
  if (typeof html !== "string") throw new Error("Ichihara listing HTML must be a string.");
  const normalizedPageUrl = normalizeIchiharaListingUrl(pageUrl);
  const markerPattern = /<p\b[^>]*\bclass=["'][^"']*font-bold[^"']*["'][^>]*>\s*(20\d{2})年(\d{2})月(\d{2})日\([^<]*\)\s*<\/p>/giu;
  const markers = [...html.matchAll(markerPattern)];
  const records = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const start = marker.index ?? 0;
    const end = markers[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const linkMatch = /href=["'](https:\/\/ichihara-umizuri\.com\/fishing\/(\d+)\/?)['"][^>]*>[\s\S]*?釣れた魚の詳細を見る/iu.exec(block);
    if (!linkMatch) continue;
    const observationDate = validateDateParts(Number(marker[1]), Number(marker[2]), Number(marker[3]));
    records.push({
      sourceRecordId: `fishing:${linkMatch[2]}`,
      numericId: linkMatch[2],
      observationDate,
      sourceMonth: observationDate.slice(0, 7),
      url: normalizeIchiharaDetailUrl(linkMatch[1])
    });
  }
  return {
    pageUrl: normalizedPageUrl,
    records,
    duplicateRecordIds: duplicateValues(records.map((record) => record.sourceRecordId)),
    duplicateDates: duplicateValues(records.map((record) => record.observationDate))
  };
}

export function discoverIchiharaArchiveMonths(html) {
  if (typeof html !== "string") throw new Error("Ichihara archive HTML must be a string.");
  const select = /<select\b[^>]*\bname=["']sort\[date\]["'][^>]*>([\s\S]*?)<\/select>/iu.exec(html)?.[1];
  if (!select) return [];
  const months = [];
  for (const match of select.matchAll(/<option\b[^>]*\bvalue=["'](20\d{2})年(\d{2})月["'][^>]*>/giu)) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) months.push(`${match[1]}-${String(month).padStart(2, "0")}`);
  }
  return unique(months).sort().reverse();
}

export function parseIchiharaDetail({ html, url, collectedAt }) {
  if (typeof html !== "string") throw new Error("Ichihara detail HTML must be a string.");
  const normalizedUrl = normalizeIchiharaDetailUrl(url);
  const numericId = /\/fishing\/(\d+)\/?$/u.exec(new URL(normalizedUrl).pathname)?.[1];
  if (!numericId) throw auditParseError("ichihara-record-id-missing");
  const dateMatch = /<p\b[^>]*\bclass=["'][^"']*font-bold[^"']*["'][^>]*>\s*(20\d{2})年(\d{2})月(\d{2})日\([^<]*\)\s*<\/p>/iu.exec(html);
  if (!dateMatch) throw auditParseError("ichihara-observation-date-missing");
  const observationDate = validateDateParts(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
  const species = parseIchiharaFishRows(html);
  const plainText = htmlToText(html);
  const visitors = integerFromPattern(plainText, /本日の入場者数は\s*([\d,]+)\s*名/u);
  const closureMentioned = hasClosureLanguage(plainText);
  const operatingStatus = closureMentioned && species.length === 0 && (!visitors || visitors === 0)
    ? "closed"
    : visitors > 0 || species.length > 0
      ? "operating"
      : "unknown";
  const reportComplete = operatingStatus === "operating" && species.length > 0 && species.every((row) => row.countKnown);
  return {
    providerId: "ichihara-umizuri",
    facilityId: "ichihara-original-maker",
    facilityLabel: "オリジナルメーカー海づり公園",
    sourceFamily: "ichihara-wordpress",
    sourceRecordId: `fishing:${numericId}`,
    sourceUrl: normalizedUrl,
    observationDate,
    observedAt: `${observationDate}T00:00:00+09:00`,
    temporalPrecision: "date-only-jst",
    publishedAt: null,
    publicationSemantics: "unavailable",
    modifiedAt: null,
    collectedAt: requireCanonicalUtcIso(collectedAt, "collectedAt"),
    weather: extractWeather(html),
    waterTemperatureC: firstNumberAfterLabel(html, "水温"),
    tideLabel: firstTextAfterLabel(html, "潮"),
    visitors,
    operatingStatus,
    reportComplete,
    species,
    closureMentioned,
    diagnostics: unique([
      "publication-time-unavailable",
      ...(operatingStatus === "unknown" ? ["operating-status-unknown"] : []),
      ...(!reportComplete && operatingStatus === "operating" ? ["species-table-incomplete"] : [])
    ]),
    parseStatus: "ok"
  };
}

export function buildNormalizedSpeciesPreview(records) {
  const rows = [];
  for (const record of [...records].sort(compareRecordDate)) {
    for (const speciesGroup of AUDIT_SPECIES_GROUPS) {
      const measurement = measureSpeciesGroup(record, speciesGroup);
      rows.push({
        providerId: record.providerId,
        facilityId: record.facilityId,
        facilityLabel: record.facilityLabel,
        sourceRecordId: record.sourceRecordId,
        sourceUrl: record.sourceUrl,
        observationDate: record.observationDate,
        observedAt: record.observedAt,
        publishedAt: record.publishedAt,
        collectedAt: record.collectedAt,
        temporalPrecision: record.temporalPrecision,
        species: speciesGroup,
        sourceSpeciesNames: measurement.sourceSpeciesNames,
        catchCount: measurement.count,
        catchCountKnown: measurement.known,
        presence: measurement.known ? measurement.count > 0 : null,
        explicitZero: measurement.explicitZero,
        minSize: measurement.minSize,
        maxSize: measurement.maxSize,
        sizeUnit: measurement.sizeUnit,
        visitors: record.visitors,
        catchPer100Visitors: measurement.known && record.visitors > 0
          ? round((measurement.count / record.visitors) * 100, 4)
          : null,
        operatingStatus: record.operatingStatus,
        reportComplete: record.reportComplete,
        areaLabels: measurement.areaLabels
      });
    }
  }
  return rows;
}

export function aggregateCoastalFixedNodeAudit({
  records,
  inventoryByFacility,
  targetMonths,
  archiveMetadata,
  collectedAt,
  remoteReads,
  parseFailures = []
}) {
  const facilities = COASTAL_FACILITIES.map((facility) => {
    const facilityRecords = records.filter((record) => record.facilityId === facility.facilityId);
    const inventory = inventoryByFacility[facility.facilityId] ?? [];
    const failureCount = parseFailures.filter((failure) => failure.facilityId === facility.facilityId).length;
    return aggregateFacility(facility, facilityRecords, inventory, targetMonths, collectedAt, failureCount);
  });
  const previewRows = buildNormalizedSpeciesPreview(records);
  return {
    schemaVersion: COASTAL_FIXED_NODE_AUDIT_VERSION,
    auditMode: "READ_ONLY_GET",
    collectedAt,
    targetMonths,
    facilities,
    sourceStructures: {
      yokohama: {
        officialSurface: "Vue SPA backed by public read-only AWS AppSync queries",
        archivePartition: "lastPostsByMonthAndFacility(month, facility)",
        stableRecordIdentity: "LastPost.id UUID",
        dailyObservationDate: "LastPost.date (YYYY/MM/DD)",
        publicationMetadata: "createdAt/updatedAt; createdAt is not asserted as editorial publish time",
        speciesShape: "up to 30 indexed fish rows with count, size, unit, and facility area labels",
        liveMethod: "GET"
      },
      ichihara: {
        officialSurface: "WordPress custom fishing listing and numeric detail pages",
        archivePartition: "/fishing/page/<n>/ listing pagination; month form itself is POST-only and was not used",
        stableRecordIdentity: "numeric /fishing/<id>/ URL",
        dailyObservationDate: "detail/listing Japanese calendar date",
        publicationMetadata: "not exposed on audited fishing detail",
        speciesShape: "detail table rows with species, size range, and total count",
        liveMethod: "GET",
        detailSampling: "one deterministic record nearest day 15 per target month"
      }
    },
    archiveMetadata,
    fieldCoverage: Object.fromEntries(COASTAL_FACILITIES.map((facility) => [
      facility.facilityId,
      SOURCE_FIELD_COVERAGE[facility.sourceFamily]
    ])),
    normalization: {
      catchPerVisitor: "SUPPORTED when visitors and count are known",
      catchPer100Visitors: "RECOMMENDED primary cross-node normalization",
      catchPerOpenHour: "NOT_READY; historical per-date opening duration/early closure is not versioned in the catch records",
      presencePerOperatingDay: "SUPPORTED only for complete operating-day reports",
      capacityAdjustment: "NOT_READY; historical per-date capacity is unavailable",
      rawCatchPerDay: "BIASED by attendance, opening duration, capacity, closures, and reporting practice"
    },
    crossNodeComparability: {
      yokohamaThreeFacilityGrade: "A",
      fourFacilityCatchPer100VisitorsGrade: "B",
      fourFacilityPresencePerReportedOperatingDayGrade: "B",
      rawDailyCatchGrade: "C",
      timeOfDayMethodAreaGrade: "D",
      reason: "The four sources expose exact daily species totals and visitors, but operator definitions, opening duration, capacity, closure handling, and spatial detail are not governed identically."
    },
    leadLagFeasibility: {
      feasible: true,
      resolution: "operating-day/date-only",
      horizonsDays: [0, 1, 2, 3],
      treatment: "exploratory only",
      cautions: [
        "autocorrelation and seasonality",
        "weekend and attendance effects",
        "closure and missing-report censoring",
        "bait catch is a catchability proxy, not direct abundance",
        "facility and operator reporting differences"
      ]
    },
    sourceBiases: [
      "facility opening hours and closures censor observations",
      "visitor volume and capacity alter total catch opportunity",
      "gear, skill, target preference, and family composition are unobserved",
      "daily totals collapse within-day timing and tide phase",
      "absence is zero only on complete operating-day reports",
      "Ichihara species metrics use a monthly stratified detail sample in this audit",
      "record createdAt is not necessarily the public editorial publication time"
    ],
    parser: {
      parsedRecordCount: records.length,
      parseFailureCount: parseFailures.length,
      parseFailures,
      duplicateSourceRecordIds: duplicateValues(records.map((record) => record.sourceRecordId)),
      normalizedPreviewRowCount: previewRows.length
    },
    remoteReads,
    remoteWrites: 0,
    normalizedPreview: previewRows
  };
}

export async function runCoastalFixedNodeHistoricalAudit(options = {}) {
  const months = options.months ?? DEFAULT_MONTHS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw new Error(`months must be 1..${MAX_MONTHS}.`);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new Error(`delayMs must be 0..${MAX_DELAY_MS}.`);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const collectedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  const targetMonths = sourceMonthsEndingAtJst(collectedAt, months);
  const remoteReads = { total: 0, yokohamaRoot: 0, yokohamaBundle: 0, yokohamaAppSync: 0, ichiharaListings: 0, ichiharaDetails: 0 };
  const parseFailures = [];
  const records = [];
  const inventoryByFacility = Object.fromEntries(COASTAL_FACILITIES.map((facility) => [facility.facilityId, []]));

  const getText = async (url, scope, headers = {}) => {
    if (remoteReads.total > 0 && delayMs > 0) await delay(delayMs);
    const normalizedUrl = normalizeAuditReadUrl(url, scope);
    remoteReads.total += 1;
    remoteReads[scope] += 1;
    const response = await fetchImpl(normalizedUrl, { method: "GET", headers });
    if (!response?.ok) throw sourceFetchError(normalizedUrl, response?.status);
    return response.text();
  };

  const rootHtml = await getText(YOKOHAMA_ROOT_URL, "yokohamaRoot");
  const bundleUrl = extractYokohamaBundleUrl(rootHtml);
  const bundleJs = await getText(bundleUrl, "yokohamaBundle");
  const config = extractYokohamaReadConfig(rootHtml, bundleJs);
  const query = buildYokohamaMonthlyQuery();

  for (const facility of COASTAL_FACILITIES.filter((candidate) => candidate.sourceFamily === "yokohama-appsync")) {
    for (const sourceMonth of targetMonths) {
      const variables = { month: sourceMonth.replace("-", "/"), facility: { eq: facility.providerFacilityKey }, limit: 100 };
      const url = buildYokohamaGraphqlGetUrl(config.endpoint, query, variables);
      let payload;
      try {
        const text = await getText(url, "yokohamaAppSync", { accept: "application/json", "x-api-key": config.apiKey });
        payload = JSON.parse(text);
      } catch (error) {
        parseFailures.push(failureRecord(facility.facilityId, sourceMonth, error));
        continue;
      }
      const connection = payload?.data?.lastPostsByMonthAndFacility;
      if (payload?.errors?.length || !connection || !Array.isArray(connection.items)) {
        parseFailures.push(failureRecord(facility.facilityId, sourceMonth, auditParseError("yokohama-graphql-response-invalid")));
        continue;
      }
      if (connection.nextToken) {
        parseFailures.push(failureRecord(facility.facilityId, sourceMonth, auditParseError("yokohama-unexpected-pagination")));
        continue;
      }
      for (const item of connection.items) {
        try {
          const record = parseYokohamaLastPost(item, { facilityId: facility.facilityId, collectedAt });
          records.push(record);
          inventoryByFacility[facility.facilityId].push({ sourceRecordId: record.sourceRecordId, observationDate: record.observationDate });
        } catch (error) {
          parseFailures.push(failureRecord(facility.facilityId, sourceMonth, error));
        }
      }
    }
  }

  const ichiharaInventory = [];
  let archiveMonths = [];
  let oldestSeenMonth = null;
  for (let page = 1; page <= MAX_ICHIHARA_PAGES; page += 1) {
    const pageUrl = page === 1 ? ICHIHARA_ARCHIVE_URL : `${ICHIHARA_ARCHIVE_URL}page/${page}/`;
    const html = await getText(pageUrl, "ichiharaListings");
    if (page === 1) archiveMonths = discoverIchiharaArchiveMonths(html);
    const parsed = parseIchiharaListingPage(html, pageUrl);
    if (parsed.records.length === 0) break;
    ichiharaInventory.push(...parsed.records);
    oldestSeenMonth = parsed.records.map((record) => record.sourceMonth).sort()[0] ?? oldestSeenMonth;
    if (oldestSeenMonth && oldestSeenMonth < targetMonths.at(-1)) break;
  }
  const uniqueIchiharaInventory = deduplicateBy(ichiharaInventory, (record) => record.sourceRecordId);
  inventoryByFacility["ichihara-original-maker"] = uniqueIchiharaInventory
    .filter((record) => targetMonths.includes(record.sourceMonth))
    .map((record) => ({ sourceRecordId: record.sourceRecordId, observationDate: record.observationDate }));
  const selectedDetails = selectMonthlyIchiharaDetails(uniqueIchiharaInventory, targetMonths);
  for (const selected of selectedDetails) {
    try {
      const html = await getText(selected.url, "ichiharaDetails");
      const record = parseIchiharaDetail({ html, url: selected.url, collectedAt });
      if (record.observationDate !== selected.observationDate) throw auditParseError("ichihara-list-detail-date-mismatch");
      records.push(record);
    } catch (error) {
      parseFailures.push(failureRecord("ichihara-original-maker", selected.sourceMonth, error));
    }
  }

  const archiveMetadata = {
    yokohama: {
      monthsRequested: months,
      confirmedMonthRange: { from: targetMonths.at(-1), to: targetMonths[0] },
      advertisedEarliestMonth: null,
      note: "Continuity was measured for the requested monthly partitions; the API exposes no archive catalog."
    },
    ichihara: {
      advertisedMonths: archiveMonths.length,
      advertisedMonthRange: archiveMonths.length > 0 ? { from: archiveMonths.at(-1), to: archiveMonths[0] } : null,
      listingRecordsScanned: uniqueIchiharaInventory.length,
      selectedDetailSamples: selectedDetails.length,
      oldestListingMonthScanned: oldestSeenMonth
    }
  };

  return aggregateCoastalFixedNodeAudit({
    records,
    inventoryByFacility,
    targetMonths,
    archiveMetadata,
    collectedAt,
    remoteReads,
    parseFailures
  });
}

function aggregateFacility(facility, records, inventory, targetMonths, collectedAt, parseFailureCount) {
  const windowDates = datesForTargetMonths(targetMonths, collectedAt);
  const inventoryDates = inventory.map((record) => record.observationDate).filter((date) => windowDates.includes(date));
  const uniqueInventoryDates = unique(inventoryDates);
  const operating = records.filter((record) => record.operatingStatus === "operating");
  const closed = records.filter((record) => record.operatingStatus === "closed");
  const complete = operating.filter((record) => record.reportComplete);
  const seabass = complete.map((record) => measureSpeciesGroup(record, "seabass"));
  const seabassCounts = seabass.filter((measurement) => measurement.known).map((measurement) => measurement.count);
  const baitSignals = Object.fromEntries(AUDIT_SPECIES_GROUPS.filter((group) => group !== "seabass").map((group) => {
    const measurements = complete.map((record) => measureSpeciesGroup(record, group)).filter((measurement) => measurement.known);
    const positive = measurements.filter((measurement) => measurement.count > 0);
    return [group, {
      knownDays: measurements.length,
      positiveDays: positive.length,
      positiveRate: rate(positive.length, measurements.length),
      totalCatch: sum(positive.map((measurement) => measurement.count))
    }];
  }));
  const visitorKnown = complete.filter((record) => record.visitors !== null);
  const revisedRecords = records.filter((record) => record.publishedAt && record.modifiedAt && record.publishedAt !== record.modifiedAt);
  const monthlyContinuity = targetMonths.map((sourceMonth) => {
    const calendarDays = windowDates.filter((date) => date.startsWith(`${sourceMonth}-`)).length;
    const reportDays = uniqueInventoryDates.filter((date) => date.startsWith(`${sourceMonth}-`)).length;
    return {
      sourceMonth,
      calendarDays,
      reportDays,
      missingOrClosedUnknownDays: calendarDays - reportDays,
      reportCoverageRate: rate(reportDays, calendarDays)
    };
  });
  return {
    facilityId: facility.facilityId,
    providerId: facility.providerId,
    providerFacilityKey: facility.providerFacilityKey,
    label: facility.label,
    sourceFamily: facility.sourceFamily,
    sourceUrl: facility.sourceUrl,
    officialCoordinates: facility.officialCoordinates,
    nodeAssessment: {
      stableFacilityIdentity: "EXACT",
      officialPointGeometry: "UNAVAILABLE",
      macrozone: null,
      shorelineType: null,
      note: "No coordinate or macrozone was guessed during this source audit."
    },
    sampleScope: facility.sourceFamily === "yokohama-appsync" ? "all daily records in requested months" : "one detail nearest day 15 per month",
    continuity: {
      calendarDays: windowDates.length,
      reportDays: uniqueInventoryDates.length,
      reportCoverageRate: rate(uniqueInventoryDates.length, windowDates.length),
      missingOrClosedUnknownDays: windowDates.length - uniqueInventoryDates.length,
      duplicateReportDates: duplicateValues(inventoryDates).length,
      duplicateRecordIds: duplicateValues(inventory.map((record) => record.sourceRecordId)).length,
      explicitClosedDaysInParsedSample: closed.length,
      parserFailures: parseFailureCount,
      monthly: monthlyContinuity
    },
    temporalSemantics: {
      observationTime: "date-only JST operating-day label",
      publicationTime: facility.sourceFamily === "yokohama-appsync" ? "record createdAt; editorial publication equivalence is unverified" : "unavailable",
      revisionMetadataAvailable: facility.sourceFamily === "yokohama-appsync",
      recordsWithCreatedAtDifferentFromUpdatedAt: revisedRecords.length,
      revisionHistoryAvailable: false
    },
    effortDenominators: {
      parsedOperatingDays: operating.length,
      completeOperatingDays: complete.length,
      visitorsKnownDays: visitorKnown.length,
      visitorsKnownRate: rate(visitorKnown.length, complete.length),
      operatingHoursPerDate: "UNAVAILABLE",
      anglerCount: "PARTIAL; visitor count is available, active angler count is not separately identified",
      capacityPerDate: "UNAVAILABLE"
    },
    seabass: {
      operatingDays: complete.length,
      positiveDays: seabassCounts.filter((count) => count > 0).length,
      positiveRate: rate(seabassCounts.filter((count) => count > 0).length, seabassCounts.length),
      totalCatch: sum(seabassCounts),
      medianDailyCatch: median(seabassCounts),
      maxDailyCatch: seabassCounts.length > 0 ? Math.max(...seabassCounts) : null,
      explicitZeroDays: seabass.filter((measurement) => measurement.explicitZero).length,
      missingOrUnknownDays: windowDates.length - complete.length,
      sourceAliasesObserved: sourceAliasesObserved(complete, "seabass"),
      zeroRule: "operating + complete species report + all seabass aliases absent or summed to zero",
      explicitZeroReliability: "HIGH within a complete report, subject to the audited alias dictionary"
    },
    baitSignals: Object.fromEntries(Object.entries(baitSignals).map(([group, metrics]) => [
      group,
      { ...metrics, sourceAliasesObserved: sourceAliasesObserved(complete, group) }
    ]))
  };
}

function parseIchiharaFishRows(html) {
  const rows = [];
  const rowPattern = /<div\b[^>]*\bclass=["'][^"']*\bflex\b[^"']*\bborder-b\b[^"']*\bborder-gray-300\b[^"']*["'][^>]*>\s*<div\b[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<\/div>\s*<div\b[^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/giu;
  for (const match of html.matchAll(rowPattern)) {
    const sourceName = cleanText(htmlToText(match[1]));
    const sizeText = cleanText(htmlToText(match[2]));
    const countText = normalizeAsciiDigits(cleanText(htmlToText(match[3])));
    if (!sourceName) continue;
    const countMatch = /合計\s*([\d,]+)\s*匹/u.exec(countText);
    const sizeNumbers = [...normalizeAsciiDigits(sizeText).matchAll(/\d+(?:\.\d+)?/gu)].map((number) => Number(number[0]));
    const count = countMatch ? Number(countMatch[1].replace(/,/gu, "")) : null;
    rows.push({
      sourceName,
      canonicalGroup: canonicalFixedNodeSpeciesGroup(sourceName),
      count: Number.isFinite(count) ? count : null,
      countKnown: Number.isFinite(count),
      minSize: sizeNumbers[0] ?? null,
      maxSize: sizeNumbers[1] ?? sizeNumbers[0] ?? null,
      sizeUnit: /(?:cm|cｍ|㎝)/iu.test(sizeText) ? "cm" : null,
      areaLabels: []
    });
  }
  return rows;
}

function measureSpeciesGroup(record, group) {
  const rows = record.species.filter((species) => species.canonicalGroup === group);
  if (rows.length === 0) {
    const known = record.operatingStatus === "operating" && record.reportComplete;
    return {
      known,
      count: known ? 0 : null,
      explicitZero: known,
      sourceSpeciesNames: [],
      minSize: null,
      maxSize: null,
      sizeUnit: null,
      areaLabels: []
    };
  }
  const known = rows.every((row) => row.countKnown);
  const count = known ? sum(rows.map((row) => row.count)) : null;
  const minSizes = rows.map((row) => row.minSize).filter(Number.isFinite);
  const maxSizes = rows.map((row) => row.maxSize).filter(Number.isFinite);
  const units = unique(rows.map((row) => row.sizeUnit).filter(Boolean));
  return {
    known,
    count,
    explicitZero: known && count === 0 && record.reportComplete,
    sourceSpeciesNames: unique(rows.map((row) => row.sourceName)),
    minSize: minSizes.length > 0 ? Math.min(...minSizes) : null,
    maxSize: maxSizes.length > 0 ? Math.max(...maxSizes) : null,
    sizeUnit: units.length === 1 ? units[0] : null,
    areaLabels: unique(rows.flatMap((row) => row.areaLabels))
  };
}

function sourceAliasesObserved(records, group) {
  return unique(records.flatMap((record) => record.species
    .filter((species) => species.canonicalGroup === group)
    .map((species) => species.sourceName))).sort();
}

function selectMonthlyIchiharaDetails(records, targetMonths) {
  return targetMonths.flatMap((sourceMonth) => {
    const candidates = records
      .filter((record) => record.sourceMonth === sourceMonth)
      .sort((left, right) => {
        const leftDay = Number(left.observationDate.slice(-2));
        const rightDay = Number(right.observationDate.slice(-2));
        return Math.abs(leftDay - 15) - Math.abs(rightDay - 15) || left.observationDate.localeCompare(right.observationDate);
      });
    return candidates[0] ? [candidates[0]] : [];
  });
}

function sourceMonthsEndingAtJst(collectedAt, count) {
  const instant = new Date(requireCanonicalUtcIso(collectedAt, "collectedAt"));
  const jst = new Date(instant.getTime() + 9 * 60 * 60 * 1000);
  const months = [];
  let year = jst.getUTCFullYear();
  let month = jst.getUTCMonth() + 1;
  for (let index = 0; index < count; index += 1) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      year -= 1;
      month = 12;
    }
  }
  return months;
}

function datesForTargetMonths(targetMonths, collectedAt) {
  if (targetMonths.length === 0) return [];
  const instant = new Date(requireCanonicalUtcIso(collectedAt, "collectedAt"));
  const jst = new Date(instant.getTime() + 9 * 60 * 60 * 1000);
  const cutoffDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
  const dates = [];
  for (const sourceMonth of targetMonths) {
    const [year, month] = sourceMonth.split("-").map(Number);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) dates.push(`${sourceMonth}-${String(day).padStart(2, "0")}`);
  }
  return dates.filter((date) => date <= cutoffDate).sort();
}

function extractWeather(html) {
  const value = /<span\b[^>]*>\s*天気\s*<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>/iu.exec(html)?.[1];
  return value ? cleanText(htmlToText(value)) : null;
}

function firstNumberAfterLabel(html, label) {
  const segment = sourceSegmentAfterLabel(html, label, 2500);
  const numbers = [...normalizeAsciiDigits(htmlToText(segment)).matchAll(/\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));
  return numbers[0] ?? null;
}

function firstTextAfterLabel(html, label) {
  const escaped = escapeRegExp(label);
  const value = new RegExp(`<p\\b[^>]*>\\s*${escaped}\\s*<\\/p>\\s*<p\\b[^>]*>([\\s\\S]*?)<\\/p>`, "iu").exec(html)?.[1];
  return value ? cleanText(htmlToText(value)) : null;
}

function sourceSegmentAfterLabel(html, label, length) {
  const index = html.search(new RegExp(`>\\s*${escapeRegExp(label)}\\s*<`, "u"));
  return index >= 0 ? html.slice(index, index + length) : "";
}

function normalizeAuditReadUrl(value, scope) {
  if (scope === "yokohamaRoot") {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== YOKOHAMA_HOST || url.pathname !== "/") throw new Error("Invalid Yokohama root read URL.");
    return url.href;
  }
  if (scope === "yokohamaBundle") return normalizeYokohamaAssetUrl(value);
  if (scope === "yokohamaAppSync") {
    const url = new URL(value);
    normalizeYokohamaAppSyncEndpoint(`${url.origin}${url.pathname}`);
    if (!url.searchParams.has("query")) {
      throw new Error("Invalid Yokohama AppSync read URL.");
    }
    return url.href;
  }
  if (scope === "ichiharaListings") return normalizeIchiharaListingUrl(value);
  if (scope === "ichiharaDetails") return normalizeIchiharaDetailUrl(value);
  throw new Error(`Unknown read scope: ${scope}`);
}

function normalizeIchiharaListingUrl(value) {
  const url = new URL(value, ICHIHARA_ARCHIVE_URL);
  const validPath = url.pathname === "/fishing/" || /^\/fishing\/page\/[1-9]\d*\/$/u.test(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== ICHIHARA_HOST || !validPath || url.search || url.hash) {
    throw new Error("Invalid Ichihara listing read URL.");
  }
  return url.href;
}

function normalizeIchiharaDetailUrl(value) {
  const url = new URL(value, ICHIHARA_ARCHIVE_URL);
  if (url.protocol !== "https:" || url.hostname !== ICHIHARA_HOST || !/^\/fishing\/[1-9]\d*\/?$/u.test(url.pathname)) {
    throw new Error("Invalid Ichihara detail read URL.");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function validateDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw auditParseError("observation-date-invalid");
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function canonicalizeUtcIso(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasClosureLanguage(value) {
  return /(?:休場|休園|臨時休業|営業中止|終日閉場|閉鎖のため休)/u.test(String(value ?? ""));
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
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const codePoint = Number.parseInt(digits, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function normalizeAsciiDigits(value) {
  return String(value).replace(/[０-９]/gu, (digit) => String(digit.codePointAt(0) - 0xff10));
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\t\r\n ]+/gu, " ").trim();
  return text === "" ? null : text;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/gu, ""));
  return Number.isFinite(number) ? number : null;
}

function finiteNonnegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function integerFromPattern(value, pattern) {
  const match = pattern.exec(normalizeAsciiDigits(String(value ?? "")));
  if (!match) return null;
  const number = Number(match[1].replace(/,/gu, ""));
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function failureRecord(facilityId, sourceMonth, error) {
  return {
    facilityId,
    sourceMonth,
    code: error?.code ?? "audit-error",
    message: String(error?.message ?? "unknown error").slice(0, 200)
  };
}

function sourceFetchError(url, status) {
  const error = new Error(`GET ${url} failed with HTTP ${status ?? "unknown"}.`);
  error.code = "source-fetch-failed";
  error.status = Number.isInteger(status) ? status : null;
  return error;
}

function auditParseError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value, count]) => ({ value, count }));
}

function deduplicateBy(values, keyOf) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareRecordDate(left, right) {
  return left.facilityId.localeCompare(right.facilityId) || left.observationDate.localeCompare(right.observationDate) || left.sourceRecordId.localeCompare(right.sourceRecordId);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function rate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

function round(value, digits) {
  return Number(value.toFixed(digits));
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unique(values) {
  return [...new Set(values)];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-coastal-fixed-node-historical-audit.mjs

Optional:
  --months <1..36>
  --delay-ms <0..10000>
  --collected-at <canonical UTC ISO>
`);
}

async function main() {
  const options = parseCoastalAuditArgs();
  if (options.help) return printHelp();
  const report = await runCoastalFixedNodeHistoricalAudit(options);
  const compact = {
    ...report,
    normalizedPreview: report.normalizedPreview.slice(0, 64),
    normalizedPreviewTruncated: report.normalizedPreview.length > 64
  };
  console.log(JSON.stringify(compact, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`coastal_fixed_node_historical_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
