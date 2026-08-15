#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "../workers/wanoku-intel-worker/src/environment-nodes.js";

export const UMINEKO_LISTING_URL = "https://umineko.biz/?page_id=306";
export const UMINEKO_PROVIDER_ID = "umineko";
export const UMINEKO_SOURCE_CLASS = "charter-or-guide-log";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UMINEKO_HOST = "umineko.biz";
const MAX_RECENT = 10;
const FETCH_DELAY_MS = 200;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXTRACTOR_VERSION = "wanoku-umineko-evidence-adapter.v1";
const MAPPING_VERSION = "wanoku-umineko-location-preview.v1";
const EVIDENCE_ID_PREFIX = "wanoku-seabass-evidence:";
const KNOWN_NODE_IDS = TOKYO_BAY_ENVIRONMENT_NODES.map((node) => node.id);
const OTHER_SPECIES = [
  { id: "black-seabream", pattern: /(?:チヌ|黒鯛|クロダイ|キビレ)/u },
  { id: "flathead", pattern: /(?:マゴチ|コチ)/u },
  { id: "bluefish", pattern: /(?:イナダ|ワラサ|ブリ|サワラ)/u }
];
const LOCATION_RULES = [
  { pattern: /三番瀬/u, rawLabel: "三番瀬", nodeId: "funabashi-inner-01", reason: "explicit-source-area" },
  { pattern: /船橋/u, rawLabel: "船橋", nodeId: "funabashi-inner-01", reason: "explicit-source-area" },
  { pattern: /幕張/u, rawLabel: "幕張", nodeId: "makuhari-shallow-01", reason: "explicit-source-area" },
  { pattern: /東京方面/u, rawLabel: "東京方面", nodeId: "tokyo-inner-bay-01", reason: "article-says-tokyo-direction", directional: true }
];

let loadedModules = null;

export class UminekoEvidencePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UminekoEvidencePreviewError";
    this.code = code;
  }
}

export function parseUminekoPreviewArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new UminekoEvidencePreviewError("invalid_cli", `Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--url") options.url = normalizeUminekoDetailUrl(readValue());
    else if (arg === "--recent") options.recent = parseRecent(readValue());
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new UminekoEvidencePreviewError("invalid_cli", `Unknown option: ${arg}`);
  }
  if (!options.help && Boolean(options.url) === Boolean(options.recent)) {
    throw new UminekoEvidencePreviewError("invalid_cli", "Specify exactly one of --url or --recent.");
  }
  return options;
}

export function sourceRecordIdFromUminekoUrl(value) {
  const url = new URL(normalizeUminekoDetailUrl(value));
  return `news:${url.searchParams.get("news")}`;
}

function sourceRecordIdFromUminekoArticle(html, fallbackUrl) {
  const postId = extractWordPressPostId(html);
  return postId
    ? { sourceRecordId: `post:${postId}`, slugFallback: false }
    : { sourceRecordId: sourceRecordIdFromUminekoUrl(fallbackUrl), slugFallback: true };
}

function extractWordPressPostId(html) {
  for (const tag of html.match(/<article\b[^>]*>/giu) ?? []) {
    const classes = attributeFromTag(tag, "class")?.split(/\s+/u) ?? [];
    const postId = /^post-(\d+)$/u.exec(attributeFromTag(tag, "id") ?? "")?.[1];
    if (classes.includes("news") && postId) return postId;
  }
  return null;
}

export function discoverUminekoRecords(html, limit = MAX_RECENT) {
  if (typeof html !== "string") throw new UminekoEvidencePreviewError("invalid_html", "listing HTML must be a string.");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT) {
    throw new UminekoEvidencePreviewError("invalid_limit", `recent must be an integer from 1 to ${MAX_RECENT}.`);
  }

  const records = [];
  const seen = new Set();
  const articles = html.match(/<article\b[\s\S]*?<\/article>/giu) ?? [];
  for (const article of articles) {
    if (!/class\s*=\s*["'][^"']*\bnews\b/iu.test(article)) continue;
    const titleBlock = firstMatch(article, /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/iu);
    const href = titleBlock ? attributeFromFirstTag(titleBlock, "a", "href") : null;
    if (!href) continue;
    let url;
    try {
      url = normalizeUminekoDetailUrl(href);
    } catch {
      continue;
    }
    const sourceRecordId = sourceRecordIdFromUminekoArticle(article, url).sourceRecordId;
    if (seen.has(sourceRecordId)) continue;
    seen.add(sourceRecordId);
    records.push({
      sourceRecordId,
      url,
      title: htmlToText(titleBlock),
      publicationDate: extractPublicationDate(article)
    });
    if (records.length >= limit) break;
  }
  return records;
}

export async function parseUminekoDetail({ html, url, collectedAt }) {
  if (typeof html !== "string" || html.trim() === "") {
    throw new UminekoEvidencePreviewError("invalid_html", "detail HTML must be a non-empty string.");
  }
  const canonicalUrl = extractCanonicalUrl(html) ?? normalizeUminekoDetailUrl(url);
  const normalizedUrl = normalizeUminekoDetailUrl(canonicalUrl);
  const canonicalCollectedAt = requireCanonicalUtcIso(collectedAt, "collectedAt");
  const title = htmlToText(extractClassSection(html, "entry-title"));
  const bodyHtml = extractClassSection(html, "entry-content");
  const bodyText = htmlToText(bodyHtml);
  const text = [title, bodyText].filter(Boolean).join("\n");
  const sourceRecordIdentity = sourceRecordIdFromUminekoArticle(html, normalizedUrl);
  const sourceRecordId = sourceRecordIdentity.sourceRecordId;
  const source = { providerId: UMINEKO_PROVIDER_ID, sourceRecordId, url: normalizedUrl, title };
  const ignoredSpecies = OTHER_SPECIES.filter((species) => species.pattern.test(bodyText)).map((species) => species.id);
  const diagnostics = [];
  if (sourceRecordIdentity.slugFallback) diagnostics.push("source-record-id-slug-fallback");
  const catchCandidates = extractSeabassCatchCandidates(title, bodyText);

  if (catchCandidates.length === 0) {
    diagnostics.push("no-japanese-seabass-catch-evidence");
    return { source, parsedEvents: [], ignoredSpecies, diagnostics };
  }
  if (catchCandidates.length > 1) {
    diagnostics.push("multiple-seabass-events-unresolved");
    return { source, parsedEvents: [], ignoredSpecies, diagnostics };
  }

  const eventDate = extractEventDate(title, bodyText);
  const publicationDate = extractPublicationDate(html);
  if (!eventDate) diagnostics.push("event-date-missing");
  if (!publicationDate) diagnostics.push("publication-time-unknown");
  if (!eventDate) return { source, parsedEvents: [], ignoredSpecies, diagnostics };

  const eventTime = eventIntervalFromJstDate(eventDate, canonicalCollectedAt);
  const publication = publicationTimeFromHtml(html, publicationDate, canonicalCollectedAt);
  const locationInference = inferUminekoLocation(text);
  const duration = extractDuration(bodyText);
  const guestCount = extractGuestCount(bodyText);
  const captainCatchCount = extractCaptainCatchCount(bodyText);
  const anglerCount = guestCount === null ? null : guestCount + (captainCatchCount === null ? 0 : 1);
  const targetSpeciesExplicit = extractTargetSpeciesExplicit(title, bodyText);
  const effortKnown = duration.minutes !== null || anglerCount !== null;
  const qualityFlags = ["event-time-day-only"];
  if (/(?:ナイト|夜便)/u.test(text)) qualityFlags.push("event-daypart-night-explicit");
  if (publication.conservative) qualityFlags.push("publication-time-day-only-conservative");
  else if (!publication.at) qualityFlags.push("publication-time-unknown");
  if (locationInference.selected) qualityFlags.push("location-approximate");
  else qualityFlags.push("location-unknown");
  if (!effortKnown) qualityFlags.push("effort-unknown");

  const input = {
    schemaVersion: "wanoku-seabass-external-evidence.v1",
    species: { id: "japanese-seabass", scientificName: "Lateolabrax japonicus" },
    evidenceType: "catch",
    eventStartAt: eventTime.startAt,
    eventEndAt: eventTime.endAt,
    publishedAt: publication.at,
    collectedAt: canonicalCollectedAt,
    presenceSupport: "positive",
    catchOutcome: "positive",
    directFishEvidence: true,
    catchCount: catchCandidates[0].count,
    effort: {
      known: effortKnown,
      durationMinutes: duration.minutes,
      anglerCount,
      targetSpeciesExplicit
    },
    location: canonicalLocation(locationInference),
    source: {
      providerId: UMINEKO_PROVIDER_ID,
      sourceClass: UMINEKO_SOURCE_CLASS,
      sourceRecordId,
      sourceEventKey: "seabass-main",
      sourceUrl: normalizedUrl,
      title
    },
    provenance: {
      extractionMethod: "deterministic-parser",
      extractorVersion: EXTRACTOR_VERSION,
      mappingVersion: MAPPING_VERSION
    },
    qualityFlags
  };

  const modules = loadWanokuModules();
  const built = modules.buildSeabassExternalEvidence(input, KNOWN_NODE_IDS);
  if (!built.valid || !built.evidence) {
    throw new UminekoEvidencePreviewError("evidence_validation_failed", built.errors.join("; "));
  }
  const identity = semanticEvidenceIdentity(built.evidence, modules);
  const extractionDiagnostics = {
    eventDate,
    publicationDate,
    catchText: catchCandidates[0].text,
    sizeText: extractSizeText(bodyText),
    durationText: duration.text,
    guestCount,
    captainCatchCount,
    imageUrls: extractImageUrls(bodyHtml, normalizedUrl)
  };

  return {
    source,
    parsedEvents: [{
      externalEvidencePayload: built.evidence,
      evidenceId: identity.evidenceId,
      payloadHash: identity.payloadHash,
      locationInference,
      extractionDiagnostics
    }],
    ignoredSpecies,
    diagnostics
  };
}

export async function runUminekoEvidencePreview(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new UminekoEvidencePreviewError("fetch_unavailable", "fetch is unavailable.");
  const collectedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");
  if (options.url) {
    const url = normalizeUminekoDetailUrl(options.url);
    const html = await fetchUminekoHtml(url, fetchImpl);
    const record = await parseUminekoDetail({ html, url, collectedAt });
    return { collectedAt, discoveredRecords: [], records: [record] };
  }

  const recent = parseRecent(options.recent);
  const listingHtml = await fetchUminekoHtml(UMINEKO_LISTING_URL, fetchImpl);
  const discoveredRecords = discoverUminekoRecords(listingHtml, recent);
  const records = [];
  for (const [index, discovered] of discoveredRecords.entries()) {
    if (index > 0 && options.delay !== false) await delay(FETCH_DELAY_MS);
    const html = await fetchUminekoHtml(discovered.url, fetchImpl);
    records.push(await parseUminekoDetail({ html, url: discovered.url, collectedAt }));
  }
  return { collectedAt, discoveredRecords, records };
}

export function formatUminekoPreview(result) {
  return JSON.stringify(result, null, 2);
}

async function fetchUminekoHtml(value, fetchImpl) {
  const url = assertUminekoUrl(value);
  const response = await fetchImpl(url.href, {
    method: "GET",
    headers: { Accept: "text/html,application/xhtml+xml" }
  });
  if (!response?.ok) throw new UminekoEvidencePreviewError("source_fetch_failed", `Umineko returned HTTP ${response?.status ?? "unknown"}.`);
  return response.text();
}

function extractSeabassCatchCandidates(title, bodyText) {
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  const targetExplicit = extractTargetSpeciesExplicit(title, bodyText) === true;
  const resultStart = lines.findIndex((line) => /^結果[：:]?$/u.test(line));
  const scopedLines = resultStart >= 0 ? lines.slice(resultStart + 1) : lines;
  const candidates = [];
  for (const [index, line] of scopedLines.entries()) {
    const catchMatch = line.match(/(\d{1,3})\s*本\s*(?:キャッチ|ゲット|釣果)/u);
    const incidentalMatch = line.match(/シーバス[^\d\n]{0,20}(\d{1,3})\s*本/u);
    if (incidentalMatch) {
      candidates.push({ index, count: Number(incidentalMatch[1]), text: line });
      continue;
    }
    if (!catchMatch) continue;
    const context = scopedLines.slice(Math.max(0, index - 2), index + 1).join("\n");
    if ((targetExplicit || /シーバス/u.test(context)) && !nearestSpeciesContextIsOther(context)) {
      candidates.push({ index, count: Number(catchMatch[1]), text: line });
    }
  }
  return candidates.filter((candidate, index) => (
    candidates.findIndex((other) => other.index === candidate.index && other.count === candidate.count) === index
  ));
}

function extractDuration(text) {
  const actual = [...text.matchAll(/(\d{1,2})\s*時間便(?:でした|となりました|にて|で終了)/gu)];
  if (actual.length === 1) return { minutes: Number(actual[0][1]) * 60, text: actual[0][0] };
  if (actual.length > 1) return { minutes: null, text: null };
  const general = [...text.matchAll(/(\d{1,2})\s*時間(?:便|コース)/gu)];
  if (general.length === 1) return { minutes: Number(general[0][1]) * 60, text: general[0][0] };
  return { minutes: null, text: null };
}

function extractGuestCount(text) {
  const matches = [...text.matchAll(/ゲスト\s*(\d{1,2})\s*名様?/gu)].map((match) => Number(match[1]));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function extractCaptainCatchCount(text) {
  const matches = [...text.matchAll(/(?:せんちょ|船長)\s*(\d{1,3})\s*本/gu)].map((match) => Number(match[1]));
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

function extractTargetSpeciesExplicit(title, bodyText) {
  if (/(?:シーバス便|ナイトシーバス|デイシーバス)/u.test(title)) return true;
  if (/(?:チニング|チヌ便|マゴチ便|青物便)/u.test(title) && /シーバス/u.test(bodyText)) return false;
  return null;
}

function extractEventDate(title, bodyText) {
  return parseCalendarDate(title) ?? parseCalendarDate(bodyText);
}

function extractPublicationDate(html) {
  const footer = extractClassSection(html, "entry-meta") || html;
  return parseCalendarDate(htmlToText(footer));
}

function publicationTimeFromHtml(html, publicationDate, collectedAt) {
  const publicationHtml = extractClassSection(html, "entry-meta");
  const timeTags = publicationHtml.match(/<time\b[^>]*>/giu) ?? [];
  for (const tag of timeTags) {
    const datetime = attributeFromTag(tag, "datetime");
    if (datetime && /T/u.test(datetime)) {
      const value = new Date(datetime);
      if (Number.isFinite(value.getTime())) return { at: value.toISOString(), conservative: false };
    }
  }
  return publicationDate
    ? { at: earlierDateTime(jstDayBounds(publicationDate).endAt, collectedAt), conservative: true }
    : { at: null, conservative: false };
}

function nearestSpeciesContextIsOther(context) {
  const seabassIndex = context.lastIndexOf("シーバス");
  const otherIndex = Math.max(...OTHER_SPECIES.map((species) => lastPatternIndex(context, species.pattern)));
  return otherIndex > seabassIndex;
}

function lastPatternIndex(value, pattern) {
  const flags = pattern.flags.replaceAll("g", "") + "g";
  let index = -1;
  for (const match of value.matchAll(new RegExp(pattern.source, flags))) index = match.index;
  return index;
}

function eventIntervalFromJstDate(value, collectedAt) {
  const bounds = jstDayBounds(value);
  return { ...bounds, endAt: earlierDateTime(bounds.endAt, collectedAt) };
}

function jstDayBounds(value) {
  const { year, month, day } = calendarDateParts(value);
  const startMs = Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000;
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + 24 * 60 * 60 * 1000 - 1).toISOString()
  };
}

function earlierDateTime(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function parseCalendarDate(text) {
  const match = String(text ?? "").match(/(20\d{2})\s*(?:[.\/-]|年)\s*(\d{1,2})\s*(?:[.\/-]|月)\s*(\d{1,2})\s*日?/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function calendarDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new UminekoEvidencePreviewError("invalid_calendar_date", `Invalid calendar date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function inferUminekoLocation(text) {
  const matched = LOCATION_RULES.find((rule) => rule.pattern.test(text));
  const sourceReported = {
    rawLabel: matched?.rawLabel ?? null,
    basis: matched ? "article-text" : null
  };
  const candidates = [];
  if (matched) {
    candidates.push({
      nodeId: matched.nodeId,
      method: "source-text",
      status: "approximate",
      certainty: matched.directional ? "low" : "medium",
      reasons: [matched.reason]
    });
  }
  if (!candidates.some((candidate) => candidate.nodeId === "funabashi-inner-01")) {
    candidates.push({
      nodeId: "funabashi-inner-01",
      method: "operator-service-area",
      status: "approximate",
      certainty: "low",
      reasons: ["operator-service-area"]
    });
  }
  const selectedCandidate = matched && !matched.directional ? candidates[0] : null;
  return {
    sourceReported,
    candidates,
    selected: selectedCandidate ? {
      nodeId: selectedCandidate.nodeId,
      method: "reviewed-manual",
      status: "approximate",
      certainty: selectedCandidate.certainty,
      reasons: [...selectedCandidate.reasons]
    } : null
  };
}

function canonicalLocation(inference) {
  return {
    rawLabel: inference.sourceReported.rawLabel,
    latitude: null,
    longitude: null,
    mappedNodeId: inference.selected?.nodeId ?? null,
    mapping: inference.selected
      ? { method: "reviewed-manual", status: "approximate" }
      : { method: "unknown", status: "unknown" }
  };
}

function extractSizeText(text) {
  return text.match(/\d{1,3}\s*[〜～~-]\s*\d{1,3}\s*cm(?:まで)?/iu)?.[0] ?? null;
}

function extractImageUrls(html, baseUrl) {
  const urls = [];
  for (const tag of html.match(/<img\b[^>]*>/giu) ?? []) {
    const src = attributeFromTag(tag, "src");
    if (!src) continue;
    try {
      const url = new URL(src, baseUrl);
      if ((url.protocol === "http:" || url.protocol === "https:") && !urls.includes(url.href)) urls.push(url.href);
    } catch {
      // Ignore malformed reference URLs; evidence parsing does not depend on images.
    }
    if (urls.length >= 12) break;
  }
  return urls;
}

function extractCanonicalUrl(html) {
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const rel = attributeFromTag(tag, "rel");
    if (rel?.toLowerCase().split(/\s+/u).includes("canonical")) return attributeFromTag(tag, "href");
  }
  return null;
}

function extractClassSection(html, className) {
  const opening = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`, "iu").exec(html);
  if (!opening) return "";
  const start = opening.index + opening[0].length;
  const rest = html.slice(start);
  const marker = rest.search(new RegExp(`<!--\\s*\\.${escapeRegExp(className)}\\s*-->`, "iu"));
  if (marker >= 0) return rest.slice(0, marker);
  const closing = rest.search(new RegExp(`</${opening[1]}>`, "iu"));
  return closing >= 0 ? rest.slice(0, closing) : rest;
}

function htmlToText(html) {
  if (!html) return "";
  return decodeHtmlEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/giu, " $1 ")
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|section|header|footer)>/giu, "\n")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function decodeHtmlEntities(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (match, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
    const digits = radix === 16 ? entity.slice(2) : entity.slice(1);
    const point = Number.parseInt(digits, radix);
    return Number.isFinite(point) ? String.fromCodePoint(point) : match;
  });
}

function attributeFromFirstTag(html, tagName, attribute) {
  const tag = firstMatch(html, new RegExp(`<${tagName}\\b[^>]*>`, "iu"));
  return tag ? attributeFromTag(tag, attribute) : null;
}

function attributeFromTag(tag, attribute) {
  const match = new RegExp(`\\b${escapeRegExp(attribute)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(tag);
  return match ? decodeHtmlEntities(match[2]).trim() : null;
}

function firstMatch(value, pattern) {
  return pattern.exec(value)?.[0] ?? null;
}

function normalizeUminekoDetailUrl(value) {
  const url = assertUminekoUrl(value);
  const news = url.searchParams.get("news");
  if (!news || news.trim() === "") throw new UminekoEvidencePreviewError("invalid_source_url", "Umineko detail URL must contain a non-empty news parameter.");
  const normalized = new URL("https://umineko.biz/");
  normalized.searchParams.set("news", news);
  return normalized.href;
}

function assertUminekoUrl(value) {
  let url;
  try {
    url = new URL(value, "https://umineko.biz/");
  } catch {
    throw new UminekoEvidencePreviewError("invalid_source_url", "Source URL is invalid.");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase().replace(/^www\./u, "") !== UMINEKO_HOST) {
    throw new UminekoEvidencePreviewError("invalid_source_url", "Only HTTPS Umineko source URLs are allowed.");
  }
  return url;
}

function semanticEvidenceIdentity(evidence, modules) {
  const semantic = modules.buildSeabassEvidenceSemanticContent(evidence);
  const semanticJson = modules.canonicalHydroCoastalJson(semantic);
  const payloadHash = createHash("sha256").update(semanticJson, "utf8").digest("hex");
  return { payloadHash, evidenceId: `${EVIDENCE_ID_PREFIX}${payloadHash}` };
}

function loadWanokuModules() {
  if (loadedModules) return loadedModules;
  const requireFn = createRequire(import.meta.url);
  registerTypeScriptRequireHook(requireFn);
  const externalEvidence = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/external-evidence.ts"));
  const persistence = loadEsmFileAsCommonJs(path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/hydro-coastal-persistence.js"), requireFn);
  loadedModules = {
    buildSeabassExternalEvidence: externalEvidence.buildSeabassExternalEvidence,
    buildSeabassEvidenceSemanticContent: externalEvidence.buildSeabassEvidenceSemanticContent,
    canonicalHydroCoastalJson: persistence.canonicalHydroCoastalJson
  };
  return loadedModules;
}

function registerTypeScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".ts"]?.__wanokuUminekoPreview) return;
  const ts = requireFn("typescript");
  const hook = function compileTypeScript(module, filename) {
    const output = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }).outputText;
    module._compile(output, filename);
  };
  hook.__wanokuUminekoPreview = true;
  Module._extensions[".ts"] = hook;
}

function loadEsmFileAsCommonJs(filename, requireFn) {
  const Module = requireFn("node:module");
  const ts = requireFn("typescript");
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      allowJs: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true
    }
  }).outputText;
  module._compile(output, filename);
  return module.exports;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) {
    throw new UminekoEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new UminekoEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  return value;
}

function parseRecent(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RECENT) {
    throw new UminekoEvidencePreviewError("invalid_limit", `recent must be an integer from 1 to ${MAX_RECENT}.`);
  }
  return parsed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-umineko-evidence-preview.mjs --url "https://umineko.biz/?news=<stable-slug>"
  node scripts/wanoku-umineko-evidence-preview.mjs --recent 10

Optional:
  --collected-at <canonical UTC ISO>  Fix the preview collection time.
`);
}

async function main() {
  const options = parseUminekoPreviewArgs();
  if (options.help) return printHelp();
  const result = await runUminekoEvidencePreview(options);
  console.log(formatUminekoPreview(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`${error?.code ?? "umineko_preview_failed"}: ${error?.message ?? "Umineko preview failed."}`);
    process.exitCode = 1;
  });
}
