#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CORRIDORS } from "./wanoku-river-canal-observability-audit.mjs";

export const ANGLERS_MACRO_SIGNAL_AUDIT_VERSION = "wanoku-anglers-macro-signal-audit.v1";
export const ANGLERS_HOST = "anglers.jp";

const DEFAULT_DELAY_MS = 250;
const MAX_DELAY_MS = 10_000;
const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const AREA_URL = /^https:\/\/anglers\.jp\/areas\/(\d+)(?:\/fishings)?(?:\?page=(\d+))?$/u;
const FISHING_URL = /^https:\/\/anglers\.jp\/fishings\/(\d+)$/u;
const JST_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const JST_DATETIME_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

export const MACRO_SPECIES_ALIASES = Object.freeze({
  seabass: Object.freeze(["シーバス", "スズキ", "フッコ", "セイゴ"]),
  konoshiro: Object.freeze(["コノシロ", "コハダ"]),
  sardine: Object.freeze(["イワシ", "カタクチイワシ", "マイワシ", "ウルメイワシ"]),
  sappa: Object.freeze(["サッパ"]),
  aji: Object.freeze(["アジ", "マアジ"]),
  saba: Object.freeze(["サバ", "マサバ", "ゴマサバ"]),
  bora: Object.freeze(["ボラ", "イナ", "オボコ"]),
  haze: Object.freeze(["ハゼ", "マハゼ"])
});

export const ANGLERS_AREAS = Object.freeze([
  area("550", "東京湾湾奥", "東京湾湾奥", "coastal", "COASTAL_MACRO_ONLY", ["tokyo-inner-bay"], {
    parentAreaId: null,
    fishingsAccess: "top-page-summary; /fishings may challenge direct GET",
    historicalDepth: "Top page exposed old trip samples in 2021/2023 and current month samples.",
    overlap: "Contains many river-mouth, canal, and coastal subareas; never co-locate with fixed nodes."
  }),
  area("533", "東京湾（アクアライン以北）", "東京湾（アクアライン以北）", "coastal", "COASTAL_MACRO_ONLY", ["tokyo-chiba-yokohama-inner-bay"], {
    parentAreaId: null,
    fishingsAccess: "top-page-summary; /fishings may challenge direct GET",
    historicalDepth: "Top page exposed old trip samples back to 2018.",
    overlap: "Very broad north/central bay macro; useful only as coastal denominator or coarse lead-lag context."
  }),
  area("2509", "荒川下流", "荒川", "river", "MULTI_SEGMENT", ["ARA-0", "ARA-1", "ARA-2"], {
    parentAreaId: "986",
    fishingsAccess: "top-page-summary with recent trips and recommended child areas",
    historicalDepth: "Top page exposed current month plus older samples.",
    overlap: "Lower river, mouth, and bridge names overlap with Koto/estuary public labels."
  }),
  area("986", "荒川", "荒川", "river", "CORRIDOR_ONLY", ["arakawa"], {
    parentAreaId: null,
    fishingsAccess: "top-page-summary; some /fishings requests challenged in live probe",
    historicalDepth: "Top page exposed old trip samples in 2021/2023.",
    overlap: "Whole river area includes upstream freshwater activity and is too broad for segment-only inference."
  }),
  area("357", "中川", "中川", "river", "CORRIDOR_ONLY", ["nakagawa"], {
    parentAreaId: null,
    fishingsAccess: "month-grouped /fishings page exists in cached public HTML; live direct access may challenge",
    historicalDepth: "Cached fishings page exposed monthly continuity over 2024-2025 with pagination.",
    overlap: "Broad area includes old labels and adjacent lower-river spots."
  }),
  area("2351", "新中川", "新中川", "river", "MULTI_SEGMENT", ["SNK-0", "SNK-1", "SNK-2"], {
    parentAreaId: null,
    fishingsAccess: "top-page-summary and month-grouped /fishings samples",
    historicalDepth: "Top page exposed old trip samples in 2021/2023.",
    overlap: "Corridor area does not resolve upper/lower branch movement by itself."
  }),
  area("1261", "旧江戸川", "旧江戸川", "river", "MULTI_SEGMENT", ["KED-0", "KED-1", "KED-2", "KED-3"], {
    parentAreaId: "550",
    fishingsAccess: "top-page-summary with recent trips and old samples",
    historicalDepth: "Top page exposed old trip samples in 2022/2023.",
    overlap: "River-wide area overlaps lower estuary and nearby spot pages."
  }),
  area("515", "旧江戸川河口", "旧江戸川河口", "estuary", "MULTI_SEGMENT", ["KED-0", "KED-1"], {
    parentAreaId: "1261",
    fishingsAccess: "area identity observed historically; current live access can challenge",
    historicalDepth: "Historical samples are available through parent and nearby area pages.",
    overlap: "Estuary-mouth page should stay multi-segment, not a single point."
  }),
  area("2350", "江戸川下流", "江戸川", "river", "MULTI_SEGMENT", ["EDO-0", "EDO-1", "KED-2"], {
    parentAreaId: "550",
    fishingsAccess: "cached month-grouped public /fishings page; top page challenged in current probe",
    historicalDepth: "Cached fishings page exposed 2025-2026 continuity and pagination.",
    overlap: "Lower Edogawa and Kyu-Edogawa split cannot be collapsed without gate-aware context."
  }),
  area("1052", "隅田川", "隅田川", "river", "CORRIDOR_ONLY", ["sumida"], {
    parentAreaId: null,
    fishingsAccess: "cached fishings page exists; current top page can challenge",
    historicalDepth: "Cached fishings page exposed recent and historical samples.",
    overlap: "Whole river area includes lower and middle urban river labels."
  }),
  area("2675", "隅田川下流", "隅田川", "river", "MULTI_SEGMENT", ["SUM-0", "SUM-1", "SUM-2"], {
    parentAreaId: "1052",
    fishingsAccess: "cached fishings page exists; current top page can challenge",
    historicalDepth: "Historical continuity must be confirmed through bounded pagination.",
    overlap: "Lower Sumida overlaps bay-side and canal-mouth labels."
  }),
  area("1105", "小名木川", "江東内部河川・運河群", "canal", "EXACT_SEGMENT", ["KCI-2"], {
    parentAreaId: "550",
    fishingsAccess: "top-page-summary with nearby canal pages",
    historicalDepth: "Top page exposed current and old samples.",
    overlap: "Narrow canal label, but adjacent canal pages can still duplicate macro activity."
  }),
  area("1211", "曙北運河", "江東内部河川・運河群", "canal", "EXACT_SEGMENT", ["KCI-0"], {
    parentAreaId: "550",
    fishingsAccess: "top-page-summary with recent and old samples",
    historicalDepth: "Top page exposed current, 2024, and 2021 samples.",
    overlap: "Canal label is useful as Koto internal macro signal, not directional movement."
  }),
  area("3362", "花見川", "花見川 / 印旛放水路", "river", "MULTI_SEGMENT", ["HNM-0", "HNM-1", "HNM-2", "HNM-3"], {
    parentAreaId: null,
    fishingsAccess: "top-page-summary and cached /fishings samples",
    historicalDepth: "Top page exposed old trip samples in 2023.",
    overlap: "Whole river area mixes river, urban edge, and bay-mouth activity."
  }),
  area("526", "花見川河口", "花見川 / 印旛放水路", "estuary", "EXACT_SEGMENT", ["HNM-0"], {
    parentAreaId: "3362",
    fishingsAccess: "top-page-summary",
    historicalDepth: "Top page exposed current and older samples.",
    overlap: "Bay-mouth label should be macro-adjacent to coastal nodes, never co-located."
  }),
  area("3861", "船橋港親水公園", "海老川", "coastal-park", "COASTAL_MACRO_ONLY", ["funabashi-inner-bay"], {
    parentAreaId: "550",
    fishingsAccess: "public area exists but current probe challenged",
    historicalDepth: "Not established by this bounded audit.",
    overlap: "Nearby to Ebigawa mouth, but not evidence for EBI segment coverage."
  }),
  area("mamagawa-unresolved", "真間川", "真間川", "river", "UNMAPPABLE", [], {
    parentAreaId: null,
    fishingsAccess: "no stable dedicated public ANGLERS area found in bounded prior audit",
    historicalDepth: "unknown",
    overlap: "Do not infer from Ichikawa/Urayasu coastal pages."
  }),
  area("miakegawa-unresolved", "見明川", "見明川", "river", "UNMAPPABLE", [], {
    parentAreaId: null,
    fishingsAccess: "no stable dedicated public ANGLERS area found in bounded prior audit",
    historicalDepth: "unknown",
    overlap: "Do not infer from nearby Disney/Urayasu macro pages."
  })
]);

export const ANGLERS_READ_SOURCES = Object.freeze([
  source("anglers-robots", "access-policy", "https://anglers.jp/robots.txt", ["User-agent"]),
  source("anglers-terms-free", "access-policy", "https://anglers.jp/terms/free", ["無断", "サーバー"]),
  source("anglers-post-guideline", "access-policy", "https://anglers.jp/terms/post_guideline", ["投稿", "釣果"]),
  source("area-tokyo-inner-bay", "coastal-representative", "https://anglers.jp/areas/550", ["東京湾湾奥", "釣果投稿"]),
  source("area-tokyo-bay-north", "coastal-representative", "https://anglers.jp/areas/533", ["東京湾", "釣果投稿"]),
  source("area-arakawa-lower", "a-corridor-representative", "https://anglers.jp/areas/2509", ["荒川下流", "釣果投稿"]),
  source("area-arakawa-fishings", "older-pagination-sample", "https://anglers.jp/areas/986/fishings", ["荒川", "釣行"]),
  source("area-nakagawa-fishings-page5", "older-pagination-sample", "https://anglers.jp/areas/357/fishings?page=5", ["中川", "釣行"]),
  source("area-shin-nakagawa", "b-corridor-representative", "https://anglers.jp/areas/2351", ["新中川", "釣果投稿"]),
  source("area-kyu-edogawa", "a-corridor-representative", "https://anglers.jp/areas/1261", ["旧江戸川", "釣果投稿"]),
  source("area-edogawa-lower", "a-corridor-representative", "https://anglers.jp/areas/2350", ["江戸川下流", "釣果投稿"]),
  source("area-sumida", "a-corridor-representative", "https://anglers.jp/areas/1052", ["隅田川", "釣果投稿"]),
  source("area-koto-onagigawa", "b-corridor-representative", "https://anglers.jp/areas/1105", ["小名木川", "釣果投稿"]),
  source("area-hanamigawa-mouth", "b-corridor-representative", "https://anglers.jp/areas/526", ["花見川河口", "釣果投稿"]),
  source("area-funabashi-park", "c-corridor-proxy-check", "https://anglers.jp/areas/3861", ["船橋港親水公園", "釣果投稿"])
]);

const SOURCE_BY_URL = new Map(ANGLERS_READ_SOURCES.map((entry) => [entry.url, entry]));
const AREA_BY_ID = new Map(ANGLERS_AREAS.map((entry) => [entry.areaId, entry]));
const SEGMENT_IDS = new Set(CORRIDORS.flatMap((corridor) => corridor.segments.map((segment) => segment.segmentId)));
const CORRIDOR_IDS = new Set(CORRIDORS.map((corridor) => corridor.corridorId));

export function parseAnglersMacroSignalAuditArgs(argv = process.argv.slice(2)) {
  const options = { delayMs: DEFAULT_DELAY_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, MAX_DELAY_MS);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function buildAreaStableId(areaId) {
  if (typeof areaId !== "string" || !/^(?:\d+|[a-z0-9-]+-unresolved)$/u.test(areaId)) throw new Error(`Invalid ANGLERS area ID: ${areaId}`);
  return `anglers-area:${areaId}`;
}

export function normalizeAnglersReadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== ANGLERS_HOST) throw new Error("ANGLERS audit URL must use https://anglers.jp.");
  url.hash = "";
  const normalized = url.href;
  if (!SOURCE_BY_URL.has(normalized)) throw new Error(`URL is not in the ANGLERS audit allowlist: ${normalized}`);
  return normalized;
}

export function parseAnglersAreaPage(html, context = {}) {
  if (typeof html !== "string") throw new Error("ANGLERS area HTML must be a string.");
  const url = context.url ? new URL(context.url) : null;
  const areaId = url ? AREA_URL.exec(url.href)?.[1] ?? null : context.areaId ?? null;
  const text = htmlToText(html);
  const challenge = detectJsChallenge(text);
  if (challenge) {
    return {
      areaId,
      stableAreaId: areaId ? buildAreaStableId(areaId) : null,
      status: "JS_CHALLENGE",
      displayName: null,
      totalPublicPosts: null,
      speciesCount: null,
      childAreaCount: null,
      recentSpecies: [],
      latestPostDate: null,
      latestPostDateSemantics: "publication-or-reporting-date-unclear",
      visibleTripCount: 0,
      monthHeadings: [],
      oldestVisibleMonth: null,
      historicalDepthMonths: null,
      pagination: { visible: false, pages: [] },
      publicReporterVisible: false
    };
  }
  const collectedAt = context.collectedAt ? requireCanonicalUtcIso(context.collectedAt, "collectedAt") : null;
  const monthHeadings = extractMonthHeadings(text);
  const oldestVisibleMonth = monthHeadings.length > 0 ? monthHeadings[monthHeadings.length - 1] : null;
  return {
    areaId,
    stableAreaId: areaId ? buildAreaStableId(areaId) : null,
    status: "PARSED",
    displayName: extractDisplayName(text, html),
    totalPublicPosts: firstNumberBefore(text, "釣果投稿"),
    speciesCount: firstNumberBefore(text, "魚の種類"),
    childAreaCount: firstNumberBefore(text, "釣り場"),
    recentSpecies: extractRecentSpecies(text),
    latestPostDate: extractJapaneseDate(text, "最新投稿は"),
    latestPostDateSemantics: "publication-or-reporting-date-unclear",
    visibleTripCount: countFishingTripMentions(text),
    monthHeadings,
    oldestVisibleMonth,
    historicalDepthMonths: oldestVisibleMonth && collectedAt ? monthDistance(oldestVisibleMonth, collectedAt.slice(0, 7)) : null,
    pagination: parsePagination(html),
    publicReporterVisible: /最近の釣り人|さんの釣行/u.test(text)
  };
}

export function parseAnglersFishingListPage(html, context = {}) {
  if (typeof html !== "string") throw new Error("ANGLERS fishings HTML must be a string.");
  const url = context.url ? new URL(context.url) : null;
  const areaId = url ? AREA_URL.exec(url.href)?.[1] ?? null : context.areaId ?? null;
  const text = htmlToText(html);
  if (detectJsChallenge(text)) {
    return { areaId, stableAreaId: areaId ? buildAreaStableId(areaId) : null, status: "JS_CHALLENGE", records: [], monthHeadings: [], pagination: { visible: false, pages: [] } };
  }
  const records = [];
  const linkPattern = /<a\b[^>]*href=["']\/fishings\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(linkPattern)) {
    const recordText = htmlToText(match[2]);
    const parsed = parseFishingSummaryText(recordText, {
      sourceRecordId: `fishing:${match[1]}`,
      areaId,
      sourceYearMonth: lastMonthHeading(htmlToText(html.slice(0, match.index ?? 0)))
    });
    if (parsed) records.push(parsed);
  }
  if (records.length === 0) {
    for (const parsed of parsePlainFishingSummaries(text, { areaId })) records.push(parsed);
  }
  return {
    areaId,
    stableAreaId: areaId ? buildAreaStableId(areaId) : null,
    status: "PARSED",
    records,
    monthHeadings: extractMonthHeadings(text),
    pagination: parsePagination(html)
  };
}

export function parseAnglersFishingDetailPage(html, context = {}) {
  if (typeof html !== "string") throw new Error("ANGLERS fishing detail HTML must be a string.");
  const url = context.url ? new URL(context.url) : null;
  const match = url ? FISHING_URL.exec(url.href) : null;
  const sourceRecordId = context.sourceRecordId ?? (match ? `fishing:${match[1]}` : null);
  const text = htmlToText(html);
  if (detectJsChallenge(text)) return { sourceRecordId, status: "JS_CHALLENGE" };
  const datetime = /日時\s*(\d{4})年(\d{2})月(\d{2})日\([^)]*\)\s*(\d{2}):(\d{2})[〜~](\d{2}):(\d{2})/u.exec(text);
  const caughtFishBlock = textBetween(text, "釣った魚", "天気") ?? "";
  const species = canonicalSpecies(caughtFishBlock);
  const sizeValues = [...text.matchAll(/(?:シーバス|スズキ|フッコ|セイゴ)\s+(\d+(?:\.\d+)?)cm/gu)].map((entry) => Number(entry[1]));
  const exactPostCount = extractFishingPostCount(text);
  return {
    sourceRecordId,
    status: "PARSED",
    eventDate: datetime ? `${datetime[1]}-${datetime[2]}-${datetime[3]}` : null,
    eventStartAt: datetime ? normalizeJstMinuteToUtc(`${datetime[1]}-${datetime[2]}-${datetime[3]}T${datetime[4]}:${datetime[5]}`) : null,
    eventEndAt: datetime ? normalizeJstMinuteToUtc(`${datetime[1]}-${datetime[2]}-${datetime[3]}T${datetime[6]}:${datetime[7]}`) : null,
    eventTimeSemantics: datetime ? "source-displayed-fishing-time" : "unknown",
    postCount: exactPostCount,
    species,
    explicitCatchCount: species === "seabass" && exactPostCount !== null ? exactPostCount : null,
    positivePresence: species === "seabass",
    sizeCmValues: sizeValues
  };
}

export function normalizeJstDateToUtcDay(value) {
  const match = JST_DATE.exec(value);
  if (!match) throw new Error("date must be YYYY-MM-DD.");
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000+09:00`;
}

export function normalizeJstMinuteToUtc(value) {
  const match = JST_DATETIME_MINUTE.exec(value);
  if (!match) throw new Error("timestamp must be YYYY-MM-DDTHH:mm in JST.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 9, Number(match[5]), 0, 0));
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp is invalid.");
  return date.toISOString();
}

export function normalizeCatchCount(value) {
  if (value === null || value === undefined || value === "") return { count: null, known: false, positivePresence: false };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return { count: value, known: true, positivePresence: value > 0 };
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/u.test(trimmed)) {
      const count = Number(trimmed);
      return { count, known: true, positivePresence: count > 0 };
    }
    return { count: null, known: false, positivePresence: positiveWords(trimmed) };
  }
  return { count: null, known: false, positivePresence: false };
}

export function anonymizeReporterId(sourceValue) {
  if (typeof sourceValue !== "string" || sourceValue.trim() === "") return null;
  const hash = createHash("sha256").update(`anglers-public-reporter:v1:${sourceValue.trim()}`).digest("hex");
  return `public-reporter-sha256:${hash.slice(0, 24)}`;
}

export function aggregateMacroSignals(records, options = {}) {
  const grouped = new Map();
  for (const record of records) {
    if (!record || record.noObservation === true) continue;
    const areaId = record.areaId;
    const date = record.date;
    const species = record.species ?? canonicalSpecies(record.sourceSpeciesName ?? "");
    if (!areaId || !date || !species) continue;
    const key = `${areaId}|${date}|${species}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        areaId,
        wanokuSpatialLevel: AREA_BY_ID.get(areaId)?.wanokuSpatialLevel ?? "UNMAPPABLE",
        wanokuSpatialIds: AREA_BY_ID.get(areaId)?.wanokuSpatialIds ?? [],
        date,
        species,
        postCount: 0,
        uniqueReporterCount: 0,
        positivePresencePosts: 0,
        explicitCatchCountSum: null,
        explicitCatchCountKnownPosts: 0,
        explicitCatchCountCoverage: 0,
        allSpeciesActivityCount: options.allSpeciesActivityByAreaDate?.[`${areaId}|${date}`] ?? null,
        sizeKnownPosts: 0,
        medianSize: null,
        maxSize: null,
        completeness: "BOUNDED_SAMPLE",
        sourceBiasFlags: [
          "positive-report-bias",
          "popularity-bias",
          "skilled-user-bias",
          "geographic-precision-loss"
        ],
        reporterKeys: new Set(),
        sourceRecordIds: new Set(),
        sizes: []
      });
    }
    const bucket = grouped.get(key);
    const sourceRecordId = record.sourceRecordId ?? null;
    if (sourceRecordId && bucket.sourceRecordIds.has(sourceRecordId)) continue;
    if (sourceRecordId) bucket.sourceRecordIds.add(sourceRecordId);
    bucket.postCount += 1;
    if (record.reporterPublicId) {
      const anonymized = anonymizeReporterId(record.reporterPublicId);
      if (anonymized) bucket.reporterKeys.add(anonymized);
    }
    if (record.positivePresence === true) bucket.positivePresencePosts += 1;
    if (Number.isInteger(record.explicitCatchCount)) {
      bucket.explicitCatchCountSum = (bucket.explicitCatchCountSum ?? 0) + record.explicitCatchCount;
      bucket.explicitCatchCountKnownPosts += 1;
    }
    const sizes = Array.isArray(record.sizeCmValues) ? record.sizeCmValues.filter((value) => Number.isFinite(value) && value > 0) : [];
    if (sizes.length > 0) {
      bucket.sizeKnownPosts += 1;
      bucket.sizes.push(...sizes);
    }
  }
  return [...grouped.values()].map((bucket) => {
    const sortedSizes = bucket.sizes.toSorted((left, right) => left - right);
    return Object.freeze({
      areaId: bucket.areaId,
      wanokuSpatialLevel: bucket.wanokuSpatialLevel,
      wanokuSpatialIds: bucket.wanokuSpatialIds,
      date: bucket.date,
      species: bucket.species,
      postCount: bucket.postCount,
      uniqueReporterCount: bucket.reporterKeys.size,
      positivePresencePosts: bucket.positivePresencePosts,
      explicitCatchCountSum: bucket.explicitCatchCountSum,
      explicitCatchCountKnownPosts: bucket.explicitCatchCountKnownPosts,
      explicitCatchCountCoverage: bucket.postCount > 0 ? round(bucket.explicitCatchCountKnownPosts / bucket.postCount, 4) : null,
      allSpeciesActivityCount: bucket.allSpeciesActivityCount,
      sizeKnownPosts: bucket.sizeKnownPosts,
      medianSize: median(sortedSizes),
      maxSize: sortedSizes.length > 0 ? sortedSizes.at(-1) : null,
      completeness: bucket.completeness,
      sourceBiasFlags: Object.freeze(bucket.sourceBiasFlags)
    });
  });
}

export function buildAnglersMacroSignalAudit(input = {}) {
  const collectedAt = requireCanonicalUtcIso(input.collectedAt ?? "2026-08-17T00:00:00.000Z", "collectedAt");
  const probes = Array.isArray(input.probes) ? input.probes : [];
  const mappings = buildAreaMappings();
  const parsedAreas = probes.filter((probe) => probe.areaSummary?.status === "PARSED").map((probe) => probe.areaSummary);
  const challenged = probes.filter((probe) => probe.jsChallenge === true).length;
  const termsRisk = accessPolicyAssessment(probes);
  const coverage = buildCoverageAssessment();
  return deepFreeze({
    schemaVersion: ANGLERS_MACRO_SIGNAL_AUDIT_VERSION,
    collectedAt,
    source: {
      providerId: "anglers-public",
      publicAccessOnly: true,
      loginRequired: false,
      privateApiUsed: false,
      tokenExtractionUsed: false,
      antiBotBypassUsed: false,
      productionCollectorRecommendation: "do-not-build-without-permission",
      sustainabilityClass: "C PERMISSION_REQUIRED",
      reasons: termsRisk.reasons
    },
    publicSourceStructures: {
      areaTopPage: "Public /areas/:id pages expose broad area identity, current species, total public posts, recent trip samples, nearby area links, and old trip snippets when accessible.",
      areaFishingsPage: "Public /areas/:id/fishings pages expose month-grouped trip summaries and pagination when accessible; current direct GET can return JavaScript robot verification.",
      fishingDetailPage: "Public /fishings/:id pages expose trip-level event time, post count, species, size, lure/tackle, weather, and public reporter profile, but detail collection is privacy and terms sensitive.",
      publicApi: null,
      clientSideEndpoint: "No stable public collection API was adopted; private endpoint discovery and token extraction are out of scope."
    },
    areasAudited: mappings,
    areaCounts: summarizeMappings(mappings),
    parsedAreaSummaries: parsedAreas.map((summary) => ({
      areaId: summary.areaId,
      displayName: summary.displayName,
      totalPublicPosts: summary.totalPublicPosts,
      speciesCount: summary.speciesCount,
      childAreaCount: summary.childAreaCount,
      recentSpecies: summary.recentSpecies,
      latestPostDate: summary.latestPostDate,
      oldestVisibleMonth: summary.oldestVisibleMonth,
      historicalDepthMonths: summary.historicalDepthMonths,
      visibleTripCount: summary.visibleTripCount,
      publicReporterVisible: summary.publicReporterVisible
    })),
    historicalDepth: {
      minimum12MonthsFeasible: "partial",
      target24To36MonthsFeasible: "partial",
      evidence: "Several top pages expose old trip snippets back to 2021-2023 and broad coastal pages back to 2018; reliable month-by-month continuity requires permissioned pagination.",
      caveat: "Zero-post days are NO_OBSERVATION, never zero catch."
    },
    temporalContinuity: {
      liveTopPages: parsedAreas.length,
      challengedOrUnavailableReads: challenged,
      monthGroupedPagination: "available in public HTML when not challenged, but not operationally reliable enough for unsanctioned production collection",
      zeroPostDaySemantics: "NO_OBSERVATION"
    },
    coverage,
    signalFeasibility: {
      seabass: "STRONG for broad macro positive activity where pages are accessible; not gold-standard presence.",
      explicitCatchCount: "WEAK from list pages alone; detail pages expose post counts and fish entries but collection is privacy/permission sensitive.",
      uniqueReporter: "MODERATE technically via public stable links, but production storage must anonymize and requires permission review.",
      allSpeciesDenominator: "MODERATE on area-level pages because total/recent all-species activity is visible; exact daily denominator needs pagination access.",
      baitSpecies: "MODERATE for catch-based bait-associated signals for konoshiro/sardine/sappa/aji/saba/bora/haze aliases; not stomach-content evidence.",
      sizeCohort: "WEAK to MODERATE from detail pages where size is public; threshold formalization is deferred.",
      negativeEvidence: "WEAK; no post and no seabass post are not negative evidence. Explicit no-catch posts, if present, must be a separate biased candidate."
    },
    normalizationRecommendation: [
      "Prefer C: seabass posts / all-species posts when a reliable all-species daily denominator is permissioned.",
      "Use B/D with anonymized reporter keys to reduce repeat-poster bias.",
      "Use within-area seasonal anomaly and 3-day/7-day ratios only after pagination continuity is verified.",
      "Never infer absolute abundance."
    ],
    feasibility: {
      historicalAnomaly: "partial; area/month baselines look feasible for broad areas, but exact daily continuity requires permissioned collection.",
      leadLag: "partial; strong A-corridor/coastal density may support exploratory lead-lag, C corridors are sparse.",
      movementSignal: "partial; useful as positive macro activity only, not individual fish movement.",
      repeatReporter: "technical-only; anonymized stable keys are feasible, PII storage is forbidden."
    },
    sourceBiases: [
      "positive-report-bias",
      "popularity-bias",
      "skilled-user-bias",
      "lure-target-bias",
      "hotspot-naming-distortion",
      "geographic-precision-loss",
      "duplicate-or-multi-post-behavior",
      "app-adoption-trend",
      "seasonality",
      "weekend-bias"
    ],
    privacyHandling: {
      storeDisplayNames: false,
      storeProfileText: false,
      reporterKeyPolicy: "Use salted one-way anonymous keys only if permissioned and needed for aggregate bias measurement.",
      artifactContainsPii: false
    },
    prototypeAggregateSchema: {
      areaId: "anglers area numeric ID",
      wanokuSpatialLevel: "EXACT_SEGMENT | MULTI_SEGMENT | CORRIDOR_ONLY | COASTAL_MACRO_ONLY | UNMAPPABLE",
      wanokuSpatialIds: "Wanoku segment/corridor/macro IDs",
      date: "JST calendar date",
      species: "canonical species group",
      postCount: "public post/trip count in bounded sample",
      uniqueReporterCount: "anonymous stable reporter count or null",
      positivePresencePosts: "positive posts without invented catch count",
      explicitCatchCountSum: "sum of explicit numeric catch counts only",
      explicitCatchCountKnownPosts: "posts where numeric catch count is known",
      explicitCatchCountCoverage: "known numeric count posts / postCount",
      allSpeciesActivityCount: "daily all-species denominator when available",
      sizeKnownPosts: "posts with numeric size",
      medianSize: "numeric median cm when available",
      maxSize: "numeric max cm when available",
      completeness: "bounded sample completeness",
      sourceBiasFlags: "known source-level bias flags"
    },
    remoteReads: summarizeProbes(probes),
    remoteWrites: 0,
    finalVerdict: "ANGLERS_PERMISSION_REQUIRED"
  });
}

export async function runAnglersMacroSignalAudit(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const collectedAt = requireCanonicalUtcIso(options.collectedAt ?? (options.clock ?? systemClock)(), "collectedAt");
  const delayMs = parseInteger(String(options.delayMs ?? DEFAULT_DELAY_MS), "delay-ms", 0, MAX_DELAY_MS);
  const sources = options.sources ?? ANGLERS_READ_SOURCES;
  const probes = [];
  for (let index = 0; index < sources.length; index += 1) {
    const sourceEntry = sources[index];
    const url = normalizeAnglersReadUrl(sourceEntry.url);
    const startedAt = (options.clock ?? systemClock)();
    try {
      const response = await fetchImpl(url, { method: "GET", headers: { accept: "text/html, text/plain;q=0.8" } });
      const text = await response.text();
      const jsChallenge = detectJsChallenge(htmlToText(text));
      const areaSummary = sourceEntry.kind.includes("representative") || sourceEntry.kind.includes("sample")
        ? parseProbeAreaSummary(sourceEntry, text, collectedAt)
        : null;
      probes.push({
        sourceId: sourceEntry.sourceId,
        kind: sourceEntry.kind,
        url,
        method: "GET",
        ok: response.ok,
        status: response.status,
        contentType: readHeader(response.headers, "content-type"),
        byteLength: Buffer.byteLength(text, "utf8"),
        jsChallenge,
        markersFound: sourceEntry.expectedMarkers.filter((marker) => text.includes(marker)),
        areaSummary,
        startedAt
      });
    } catch (error) {
      probes.push({
        sourceId: sourceEntry.sourceId,
        kind: sourceEntry.kind,
        url,
        method: "GET",
        ok: false,
        status: null,
        contentType: null,
        byteLength: 0,
        jsChallenge: false,
        markersFound: [],
        areaSummary: null,
        startedAt,
        error: String(error?.name ?? "fetch-error")
      });
    }
    if (delayMs > 0 && index < sources.length - 1) await delay(delayMs);
  }
  return buildAnglersMacroSignalAudit({ collectedAt, probes });
}

function parseProbeAreaSummary(sourceEntry, text, collectedAt) {
  if (/\/fishings/u.test(sourceEntry.url)) {
    const parsed = parseAnglersFishingListPage(text, { url: sourceEntry.url, collectedAt });
    return {
      areaId: parsed.areaId,
      stableAreaId: parsed.stableAreaId,
      status: parsed.status,
      displayName: AREA_BY_ID.get(parsed.areaId)?.displayName ?? null,
      totalPublicPosts: null,
      speciesCount: null,
      childAreaCount: null,
      recentSpecies: [],
      latestPostDate: null,
      latestPostDateSemantics: "publication-or-reporting-date-unclear",
      visibleTripCount: parsed.records.length,
      monthHeadings: parsed.monthHeadings,
      oldestVisibleMonth: parsed.monthHeadings.at(-1) ?? null,
      historicalDepthMonths: parsed.monthHeadings.at(-1) ? monthDistance(parsed.monthHeadings.at(-1), collectedAt.slice(0, 7)) : null,
      pagination: parsed.pagination,
      publicReporterVisible: parsed.records.some((record) => record.reporterPublicId)
    };
  }
  return parseAnglersAreaPage(text, { url: sourceEntry.url, collectedAt });
}

function buildAreaMappings() {
  validateAreaMappings(ANGLERS_AREAS);
  return ANGLERS_AREAS.map((entry) => Object.freeze({
    anglersAreaId: entry.areaId,
    stableAreaId: entry.stableAreaId,
    displayName: entry.displayName,
    parentAreaId: entry.parentAreaId,
    waterBody: entry.waterBody,
    sourceUrl: entry.sourceUrl,
    urlStability: entry.areaId.includes("unresolved") ? "unresolved" : "numeric-area-id",
    fishingsAccess: entry.fishingsAccess,
    pagination: entry.areaId.includes("unresolved") ? "unavailable" : "visible on /fishings or 'see all' paths when accessible",
    dateAvailability: entry.areaId.includes("unresolved") ? "unknown" : "date visible in trip summaries",
    speciesAvailability: entry.areaId.includes("unresolved") ? "unknown" : "species visible at area and detail levels",
    locationPrecision: entry.wanokuSpatialLevel,
    overlapWithNeighbors: entry.overlap,
    riverBridgeSpotGranularity: entry.wanokuSpatialLevel,
    wanokuSpatialLevel: entry.wanokuSpatialLevel,
    wanokuSpatialIds: entry.wanokuSpatialIds,
    historicalDepth: entry.historicalDepth
  }));
}

function validateAreaMappings(entries) {
  for (const entry of entries) {
    if (entry.wanokuSpatialLevel === "EXACT_SEGMENT" || entry.wanokuSpatialLevel === "MULTI_SEGMENT") {
      for (const spatialId of entry.wanokuSpatialIds) {
        if (!SEGMENT_IDS.has(spatialId)) throw new Error(`Unknown Wanoku segment ID for ${entry.areaId}: ${spatialId}`);
      }
    } else if (entry.wanokuSpatialLevel === "CORRIDOR_ONLY") {
      for (const spatialId of entry.wanokuSpatialIds) {
        if (!CORRIDOR_IDS.has(spatialId)) throw new Error(`Unknown Wanoku corridor ID for ${entry.areaId}: ${spatialId}`);
      }
    } else if (entry.wanokuSpatialLevel === "UNMAPPABLE" && entry.wanokuSpatialIds.length !== 0) {
      throw new Error(`Unmappable area must not have Wanoku spatial IDs: ${entry.areaId}`);
    }
  }
  return true;
}

function buildCoverageAssessment() {
  return {
    coastal: {
      grade: "STRONG",
      reason: "Tokyo inner bay and Tokyo Bay north macro pages expose high-volume all-species and seabass-visible summaries, but fixed-node co-location is forbidden."
    },
    riverCanal: [
      corridorSignal("arakawa", "STRONG", ["986", "2509"], "A corridor has broad and lower-river public areas, including lower/mouth child labels."),
      corridorSignal("nakagawa", "MODERATE", ["357"], "A corridor has a broad river page; segment separation is weak."),
      corridorSignal("shin-nakagawa", "MODERATE", ["2351"], "B corridor has a public page with recent and old samples; segment split is unavailable."),
      corridorSignal("kyu-edogawa", "STRONG", ["1261", "515"], "A corridor has high-volume river and estuary-mouth public areas."),
      corridorSignal("sumida", "MODERATE", ["1052", "2675"], "A corridor has public areas but live access was less stable in bounded probes."),
      corridorSignal("edogawa", "MODERATE", ["2350"], "A corridor lower page is useful, but gate split prevents a single-segment mapping."),
      corridorSignal("koto-internal", "MODERATE", ["1105", "1211"], "B canal network has narrow public canal labels but hydraulic direction remains unresolved."),
      corridorSignal("hanamigawa", "STRONG", ["3362", "526"], "B corridor has river and mouth public pages with sizeable history."),
      corridorSignal("ebigawa", "WEAK", ["3861"], "Only nearby coastal public area proxy was found; no dedicated Ebigawa river area."),
      corridorSignal("mamagawa", "NONE", ["mamagawa-unresolved"], "No stable dedicated public ANGLERS area found in bounded audit."),
      corridorSignal("miakegawa", "NONE", ["miakegawa-unresolved"], "No stable dedicated public ANGLERS area found in bounded audit.")
    ]
  };
}

function corridorSignal(corridorId, grade, areaIds, reason) {
  return { corridorId, grade, anglersAreaIds: areaIds, reason };
}

function summarizeMappings(mappings) {
  const byLevel = {};
  for (const entry of mappings) byLevel[entry.wanokuSpatialLevel] = (byLevel[entry.wanokuSpatialLevel] ?? 0) + 1;
  return {
    total: mappings.length,
    byLevel,
    dedicatedRiverOrCanalAreas: mappings.filter((entry) => ["EXACT_SEGMENT", "MULTI_SEGMENT", "CORRIDOR_ONLY"].includes(entry.wanokuSpatialLevel)).length,
    unmappable: mappings.filter((entry) => entry.wanokuSpatialLevel === "UNMAPPABLE").length
  };
}

function accessPolicyAssessment(probes) {
  const termsProbe = probes.find((probe) => probe.sourceId === "anglers-terms-free");
  const challengeCount = probes.filter((probe) => probe.jsChallenge).length;
  const reasons = [
    "Terms page states ANGLERS domain content is governed by the service terms and includes restrictions on unauthorized reproduction/redistribution and server burden.",
    "No stable public collection API was adopted in this audit.",
    "Some direct public HTML paths return JavaScript robot verification, so unsanctioned production collection is operationally fragile."
  ];
  if (!termsProbe) reasons.push("Terms/robots status should be rechecked before any production use.");
  if (challengeCount > 0) reasons.push(`${challengeCount} bounded probe(s) returned a JavaScript verification/challenge page.`);
  return { class: "C PERMISSION_REQUIRED", reasons };
}

function summarizeProbes(probes) {
  const byKind = {};
  for (const probe of probes) byKind[probe.kind] = (byKind[probe.kind] ?? 0) + 1;
  return {
    total: probes.length,
    successful: probes.filter((probe) => probe.ok).length,
    failed: probes.filter((probe) => !probe.ok).length,
    jsChallenge: probes.filter((probe) => probe.jsChallenge).length,
    markerComplete: probes.filter((probe) => {
      const sourceEntry = SOURCE_BY_URL.get(probe.url);
      return sourceEntry && probe.markersFound.length === sourceEntry.expectedMarkers.length;
    }).length,
    byKind
  };
}

function area(areaId, displayName, waterBody, areaType, wanokuSpatialLevel, wanokuSpatialIds, metadata) {
  const sourceUrl = /^\d+$/u.test(areaId) ? `https://anglers.jp/areas/${areaId}` : null;
  return Object.freeze({
    areaId,
    stableAreaId: buildAreaStableId(areaId),
    displayName,
    waterBody,
    areaType,
    sourceUrl,
    parentAreaId: metadata.parentAreaId,
    fishingsAccess: metadata.fishingsAccess,
    historicalDepth: metadata.historicalDepth,
    overlap: metadata.overlap,
    wanokuSpatialLevel,
    wanokuSpatialIds: Object.freeze(wanokuSpatialIds)
  });
}

function source(sourceId, kind, url, expectedMarkers) {
  return Object.freeze({ sourceId, kind, url: new URL(url).href, expectedMarkers: Object.freeze(expectedMarkers) });
}

function parseFishingSummaryText(text, context) {
  const normalized = normalizeText(text);
  const match = /(\d{1,2})日\([^)]*\)\s*(?:[〖\[]?\d*‡?)?([^0-9〖\[]+?)\s*(\d{2}):(\d{2})[〜~](\d{2}):(\d{2})\s*(\d+)投稿\s+(.+?)\s+さんの釣行/u.exec(normalized);
  if (!match) return null;
  const sourceYearMonth = context.sourceYearMonth ?? inferCurrentYearMonth(normalized);
  const date = sourceYearMonth ? `${sourceYearMonth}-${match[1].padStart(2, "0")}` : null;
  return {
    sourceRecordId: context.sourceRecordId ?? null,
    areaId: context.areaId ?? null,
    date,
    eventStartAt: date ? normalizeJstMinuteToUtc(`${date}T${match[3]}:${match[4]}`) : null,
    eventEndAt: date ? normalizeJstMinuteToUtc(`${date}T${match[5]}:${match[6]}`) : null,
    eventTimeSemantics: "source-displayed-fishing-time",
    postPublicationAt: null,
    postPublicationSemantics: "not-visible-on-list",
    locationLabel: cleanLabel(match[2]),
    postCount: Number(match[7]),
    reporterPublicId: match[8].trim(),
    species: null,
    positivePresence: true,
    explicitCatchCount: null,
    sizeCmValues: []
  };
}

function parsePlainFishingSummaries(text, context) {
  const records = [];
  let sourceYearMonth = null;
  for (const part of text.split(/\* \* \*|###|#####/u)) {
    const heading = /(\d{4})年(\d{2})月/u.exec(part);
    if (heading) sourceYearMonth = `${heading[1]}-${heading[2]}`;
    const summary = parseFishingSummaryText(part, { ...context, sourceYearMonth });
    if (summary) records.push(summary);
  }
  return records;
}

function extractDisplayName(text, html) {
  const heading = /(?:^|\n)#?\s*([^\n]+?)の釣果・釣り場情報/u.exec(text)?.[1]
    ?? /(?:^|\n)#?\s*([^\n]+?)の釣行/u.exec(text)?.[1];
  if (heading) return heading.trim();
  return /<title>([^<]+?)の釣果/u.exec(html)?.[1]?.trim() ?? null;
}

function firstNumberBefore(text, label) {
  const escaped = escapeRegExp(label);
  const match = new RegExp(`([\\d,]+)\\s*${escaped}`, "u").exec(text);
  return match ? Number(match[1].replace(/,/gu, "")) : null;
}

function extractRecentSpecies(text) {
  const match = /最近１ヶ月は\s*([\s\S]{0,120}?)\s*が釣れています/u.exec(text);
  if (!match) return [];
  return match[1]
    .split(/[、,\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !["、"].includes(entry));
}

function extractJapaneseDate(text, prefix) {
  const match = new RegExp(`${escapeRegExp(prefix)}\\s*(\\d{4})年(\\d{2})月(\\d{2})日`, "u").exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function extractMonthHeadings(text) {
  const values = [...text.matchAll(/(\d{4})年(\d{2})月/gu)].map((match) => `${match[1]}-${match[2]}`);
  return [...new Set(values)].sort().reverse();
}

function lastMonthHeading(text) {
  const matches = [...text.matchAll(/(\d{4})年(\d{2})月/gu)];
  const last = matches.at(-1);
  return last ? `${last[1]}-${last[2]}` : null;
}

function extractFishingPostCount(text) {
  const match = /釣果投稿\s*(\d+)\s*釣果/u.exec(text);
  return match ? Number(match[1]) : null;
}

function parsePagination(html) {
  const pages = [...html.matchAll(/[?&]page=(\d+)/gu)].map((match) => Number(match[1]));
  const unique = [...new Set(pages)].toSorted((left, right) => left - right);
  return { visible: unique.length > 0 || /すべて見る|›|»/u.test(htmlToText(html)), pages: unique };
}

function countFishingTripMentions(text) {
  return [...text.matchAll(/\d{1,2}日\([^)]*\)[\s\S]{0,80}?\d{1,3}投稿/gu)].length;
}

function canonicalSpecies(value) {
  const text = String(value ?? "");
  for (const [group, aliases] of Object.entries(MACRO_SPECIES_ALIASES)) {
    if (aliases.some((alias) => text.includes(alias))) return group;
  }
  return null;
}

function positiveWords(value) {
  return /釣れ|ヒット|バイト|キャッチ|ゲット|catch|caught/iu.test(value);
}

function detectJsChallenge(text) {
  return /verify that you'?re not a robot|JavaScript is disabled|Enable JavaScript and then reload/u.test(text);
}

function htmlToText(html) {
  return normalizeText(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|h\d|tr|section|article|a)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&quot;/gu, "\""));
}

function normalizeText(value) {
  return String(value).replace(/\r/gu, "\n").replace(/[ \t]+/gu, " ").replace(/\n[ \t]+/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function cleanLabel(value) {
  return String(value).replace(/[〖〗\[\]\d‡]/gu, "").trim();
}

function textBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = text.indexOf(end, startIndex + start.length);
  return text.slice(startIndex + start.length, endIndex < 0 ? undefined : endIndex);
}

function inferCurrentYearMonth(text) {
  const match = /(\d{4})年(\d{2})月/u.exec(text);
  return match ? `${match[1]}-${match[2]}` : null;
}

function monthDistance(startYearMonth, endYearMonth) {
  const [startYear, startMonth] = startYearMonth.split("-").map(Number);
  const [endYear, endMonth] = endYearMonth.split("-").map(Number);
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

function median(values) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle];
  return round((values[middle - 1] + values[middle]) / 2, 4);
}

function parseInteger(value, label, min, max) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error(`${label} must be ${min}..${max}.`);
  return parsed;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO.test(value)) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} must be canonical UTC ISO datetime.`);
  return value;
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  return null;
}

function systemClock() {
  return new Date().toISOString();
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-anglers-macro-signal-audit.mjs

Optional:
  --delay-ms <0..10000>
  --collected-at <canonical UTC ISO>

This command performs allowlisted GET requests only and writes no files or databases.`);
}

async function main() {
  const options = parseAnglersMacroSignalAuditArgs();
  if (options.help) return printHelp();
  const report = await runAnglersMacroSignalAudit(options);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`anglers_macro_signal_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
