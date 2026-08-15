#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  discoverUminekoRecords,
  fetchUminekoHtml,
  runUminekoEvidencePreview,
  UMINEKO_LISTING_URL
} from "./wanoku-umineko-evidence-preview.mjs";

export const UMINEKO_HISTORICAL_AUDIT_VERSION = "wanoku-umineko-historical-evidence-audit.v1";

const MAX_RECORDS = 50;
const MAX_PAGES = 20;
const DEFAULT_DELAY_MS = 200;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseUminekoAuditArgs(argv = process.argv.slice(2)) {
  const options = { limit: MAX_RECORDS, delayMs: DEFAULT_DELAY_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--limit") options.limit = parseInteger(readValue(), "limit", 1, MAX_RECORDS);
    else if (arg === "--delay-ms") options.delayMs = parseInteger(readValue(), "delay-ms", 0, 10_000);
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export async function runUminekoHistoricalAudit(options = {}) {
  const limit = options.limit ?? MAX_RECORDS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) throw new Error(`limit must be 1..${MAX_RECORDS}.`);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error("delayMs must be 0..10000.");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable.");
  const auditedAt = requireCanonicalUtcIso(options.collectedAt ?? new Date().toISOString(), "collectedAt");

  const discoveredById = new Map();
  const discoveryErrors = [];
  let listingPagesFetched = 0;
  let lastRequestAt = 0;
  let abortedReason = null;

  const waitForRequestSlot = async () => {
    if (lastRequestAt && delayMs > 0) await delay(delayMs);
    lastRequestAt = 1;
  };

  for (let page = 1; page <= MAX_PAGES && discoveredById.size < limit; page += 1) {
    const listingUrl = uminekoListingPageUrl(page);
    try {
      await waitForRequestSlot();
      const html = await fetchUminekoHtml(listingUrl, fetchImpl);
      listingPagesFetched += 1;
      const pageRecords = discoverUminekoRecords(html, MAX_RECORDS);
      if (pageRecords.length === 0) break;
      let added = 0;
      for (const record of pageRecords) {
        if (discoveredById.has(record.sourceRecordId)) continue;
        discoveredById.set(record.sourceRecordId, record);
        added += 1;
        if (discoveredById.size >= limit) break;
      }
      if (added === 0) break;
    } catch (error) {
      const failure = auditError(error, "listing-fetch-error", listingUrl);
      discoveryErrors.push(failure);
      if (failure.rateLimited) abortedReason = failure.reason;
      break;
    }
  }

  const discoveredRecords = [...discoveredById.values()].slice(0, limit);
  const records = [];
  const resolvedIds = new Set();
  let detailFetchAttempts = 0;
  let detailFetchSuccesses = 0;
  let detailIdentityDuplicates = 0;

  if (!abortedReason) {
    for (const discovered of discoveredRecords) {
      detailFetchAttempts += 1;
      try {
        await waitForRequestSlot();
        const preview = await runUminekoEvidencePreview({
          url: discovered.url,
          collectedAt: auditedAt,
          fetchImpl
        });
        detailFetchSuccesses += 1;
        const parsed = preview.records[0];
        if (resolvedIds.has(parsed.source.sourceRecordId)) {
          detailIdentityDuplicates += 1;
          continue;
        }
        resolvedIds.add(parsed.source.sourceRecordId);
        records.push(articleAuditRecord(discovered, parsed));
      } catch (error) {
        const failure = auditError(error, "parse-error", discovered.url);
        records.push(failedArticleAuditRecord(discovered, failure));
        if (failure.rateLimited) {
          abortedReason = failure.reason;
          break;
        }
      }
    }
  }

  const summary = aggregateUminekoAudit(records, {
    auditedAt,
    requestedLimit: limit,
    listingPagesFetched,
    discoveredArticleCount: discoveredRecords.length,
    detailFetchAttempts,
    detailFetchSuccesses,
    detailIdentityDuplicates,
    discoveryErrors,
    abortedReason
  });
  return { ...summary, records };
}

export function aggregateUminekoAudit(records, context = {}) {
  const articleRecords = [...records];
  const parsed = articleRecords.filter((record) => record.articleParsed);
  const relevant = parsed.filter((record) => record.seabassMentioned);
  const targeted = relevant.filter((record) => record.seabassTargeted === true);
  const incidental = relevant.filter((record) => record.seabassTargeted === false);
  const evidence = relevant.filter((record) => record.seabassEvidenceGenerated);
  const catchKnown = evidence.filter((record) => record.catchCountKnown);
  const positive = evidence.filter((record) => record.evidenceType === "catch" && Number(record.catchCount) > 0);
  const explicitZero = evidence.filter((record) => (
    record.explicitZeroCatch === true && record.evidenceType === "explicit-effort-zero-catch"
  ));
  const durationKnown = relevant.filter((record) => record.durationKnown);
  const anglerKnown = relevant.filter((record) => record.anglerCountKnown);
  const bothEffortKnown = relevant.filter((record) => record.durationKnown && record.anglerCountKnown);
  const targetKnown = relevant.filter((record) => record.seabassTargeted !== null);
  const eventExact = relevant.filter((record) => record.eventTimePrecision === "exact");
  const eventDayOnly = relevant.filter((record) => record.eventTimePrecision === "day-only");
  const publicationExact = parsed.filter((record) => record.publicationTimePrecision === "exact");
  const publicationDayOnly = parsed.filter((record) => record.publicationTimePrecision === "day-only");
  const sourceLocation = relevant.filter((record) => record.sourceLocationMentioned);
  const inferredCandidate = relevant.filter((record) => record.inferredLocationCandidateCount > 0);
  const selectedNode = relevant.filter((record) => record.selectedMappedNodeId !== null);
  const mappedNull = evidence.filter((record) => record.selectedMappedNodeId === null);
  const multiSpecies = parsed.filter((record) => record.multiSpeciesArticle);
  const unresolved = relevant.filter((record) => record.multipleSeabassEventsUnresolved);
  const numericPostIds = parsed.filter((record) => /^post:\d+$/u.test(record.sourceRecordId));
  const certaintyDistribution = countValues(relevant.flatMap((record) => record.inferenceCertainties ?? []), ["high", "medium", "low", "unknown"]);
  const topDiagnostics = diagnosticFrequency(articleRecords);
  const sourceUsefulness = classifySourceUsefulness({
    relevantCount: relevant.length,
    evidenceCount: evidence.length,
    catchKnownCount: catchKnown.length,
    durationKnownCount: durationKnown.length,
    anglerKnownCount: anglerKnown.length,
    bothEffortKnownCount: bothEffortKnown.length,
    eventExactCount: eventExact.length,
    eventDayOnlyCount: eventDayOnly.length,
    sourceLocationCount: sourceLocation.length,
    selectedNodeCount: selectedNode.length
  });
  const ingestion = ingestionReadiness({
    parsedCount: parsed.length,
    numericPostIdCount: numericPostIds.length,
    relevantCount: relevant.length,
    evidenceCount: evidence.length,
    catchKnownCount: catchKnown.length,
    explicitZeroCount: explicitZero.length,
    unresolvedCount: unresolved.length,
    sourceLocationCount: sourceLocation.length,
    selectedNodeCount: selectedNode.length
  });

  return {
    auditVersion: UMINEKO_HISTORICAL_AUDIT_VERSION,
    auditedAt: context.auditedAt ?? null,
    requestedLimit: context.requestedLimit ?? articleRecords.length,
    discovery: {
      discoveredArticleCount: context.discoveredArticleCount ?? articleRecords.length,
      listingPagesFetched: context.listingPagesFetched ?? null,
      fetchedArticleCount: context.detailFetchSuccesses ?? parsed.length,
      detailFetchAttempts: context.detailFetchAttempts ?? articleRecords.length,
      fetchSuccessRate: rate(context.detailFetchSuccesses ?? parsed.length, context.detailFetchAttempts ?? articleRecords.length),
      stableNumericPostIdCount: numericPostIds.length,
      stableNumericPostIdRate: rate(numericPostIds.length, parsed.length),
      detailIdentityDuplicates: context.detailIdentityDuplicates ?? 0,
      errors: context.discoveryErrors ?? [],
      abortedReason: context.abortedReason ?? null
    },
    seabassCoverage: {
      seabassRelatedArticles: relevant.length,
      targetedSeabassArticles: targeted.length,
      incidentalSeabassArticles: incidental.length,
      evidenceGeneratedCount: evidence.length,
      parseSuccessRateAmongRelevant: rate(evidence.length, relevant.length)
    },
    catch: {
      catchCountKnownCount: catchKnown.length,
      catchCountKnownRate: rate(catchKnown.length, evidence.length),
      totalPositiveCatchRecords: positive.length,
      explicitZeroCount: explicitZero.length,
      explicitZeroCoverage: explicitZero.length > 0 ? "observed" : "none",
      zeroCatchRate: explicitZero.length > 0 ? rate(explicitZero.length, explicitZero.length + positive.length) : null
    },
    effort: {
      denominator: "seabass-related articles",
      durationKnownCount: durationKnown.length,
      durationKnownRate: rate(durationKnown.length, relevant.length),
      anglerCountKnownCount: anglerKnown.length,
      anglerCountKnownRate: rate(anglerKnown.length, relevant.length),
      bothKnownCount: bothEffortKnown.length,
      bothKnownRate: rate(bothEffortKnown.length, relevant.length),
      targetSpeciesExplicitKnownCount: targetKnown.length,
      targetSpeciesExplicitKnownRate: rate(targetKnown.length, relevant.length)
    },
    temporal: {
      eventExactClockCount: eventExact.length,
      eventDayOnlyCount: eventDayOnly.length,
      eventUnknownCount: relevant.length - eventExact.length - eventDayOnly.length,
      publicationExactCount: publicationExact.length,
      publicationDayOnlyCount: publicationDayOnly.length,
      publicationUnknownCount: parsed.length - publicationExact.length - publicationDayOnly.length
    },
    spatial: {
      denominator: "seabass-related articles",
      sourceReportedLocationCount: sourceLocation.length,
      sourceReportedLocationRate: rate(sourceLocation.length, relevant.length),
      inferredCandidateArticleCount: inferredCandidate.length,
      inferredCandidateArticleRate: rate(inferredCandidate.length, relevant.length),
      selectedNodeCount: selectedNode.length,
      selectedNodeRate: rate(selectedNode.length, relevant.length),
      mappedNodeNullCount: mappedNull.length,
      mappedNodeNullRate: rate(mappedNull.length, evidence.length),
      inferenceCertaintyDistribution: certaintyDistribution
    },
    complexity: {
      multiSpeciesArticleCount: multiSpecies.length,
      unresolvedMultipleSeabassEventCount: unresolved.length,
      topDiagnostics
    },
    knownRegressions: evaluateKnownRegressions(articleRecords),
    sourceUsefulness,
    ingestionReadiness: ingestion.status,
    ingestionReadinessReasons: ingestion.reasons
  };
}

function articleAuditRecord(discovered, parsed) {
  const event = parsed.parsedEvents[0] ?? null;
  const evidence = event?.externalEvidencePayload ?? null;
  const signals = parsed.auditSignals;
  const diagnostics = [...new Set(parsed.diagnostics ?? [])];
  const multipleUnresolved = diagnostics.includes("multiple-seabass-events-unresolved");
  return {
    sourceRecordId: parsed.source.sourceRecordId,
    url: parsed.source.url,
    publicationDate: signals.publicationDate ?? discovered.publicationDate ?? null,
    articleParsed: true,
    seabassMentioned: signals.seabassMentioned,
    seabassTargeted: signals.seabassTargeted,
    seabassEvidenceGenerated: Boolean(evidence),
    catchCountKnown: Number.isInteger(evidence?.catchCount),
    catchCount: Number.isInteger(evidence?.catchCount) ? evidence.catchCount : null,
    explicitZeroCatch: evidence?.evidenceType === "explicit-effort-zero-catch",
    evidenceType: evidence?.evidenceType ?? null,
    durationKnown: signals.durationMinutes !== null,
    durationMinutes: signals.durationMinutes,
    anglerCountKnown: signals.anglerCount !== null,
    anglerCount: signals.anglerCount,
    eventDateKnown: signals.eventDate !== null,
    eventTimePrecision: signals.eventTimePrecision,
    publicationTimePrecision: signals.publicationTimePrecision,
    sourceLocationMentioned: signals.sourceLocationMentioned,
    sourceLocationLabel: signals.sourceLocationLabel,
    inferredLocationCandidateCount: signals.locationInference.candidates.length,
    inferenceCertainties: signals.locationInference.candidates.map((candidate) => candidate.certainty ?? "unknown"),
    selectedMappedNodeId: evidence?.location.mappedNodeId ?? signals.locationInference.selected?.nodeId ?? null,
    multipleSeabassEventsUnresolved: multipleUnresolved,
    multiSpeciesArticle: parsed.ignoredSpecies.length > 0,
    sourceIdentity: evidence?.sourceIdentity ?? null,
    evidenceId: event?.evidenceId ?? null,
    ignoredReason: ignoredReason(signals, evidence, diagnostics),
    diagnostics
  };
}

function failedArticleAuditRecord(discovered, failure) {
  return {
    sourceRecordId: discovered.sourceRecordId,
    url: discovered.url,
    publicationDate: discovered.publicationDate ?? null,
    articleParsed: false,
    seabassMentioned: false,
    seabassTargeted: null,
    seabassEvidenceGenerated: false,
    catchCountKnown: false,
    catchCount: null,
    explicitZeroCatch: false,
    evidenceType: null,
    durationKnown: false,
    durationMinutes: null,
    anglerCountKnown: false,
    anglerCount: null,
    eventDateKnown: false,
    eventTimePrecision: "unknown",
    publicationTimePrecision: discovered.publicationDate ? "day-only" : "unknown",
    sourceLocationMentioned: false,
    sourceLocationLabel: null,
    inferredLocationCandidateCount: 0,
    inferenceCertainties: [],
    selectedMappedNodeId: null,
    multipleSeabassEventsUnresolved: false,
    multiSpeciesArticle: false,
    sourceIdentity: null,
    evidenceId: null,
    ignoredReason: failure.reason,
    diagnostics: [failure.reason]
  };
}

function ignoredReason(signals, evidence, diagnostics) {
  if (evidence) return null;
  if (diagnostics.includes("multiple-seabass-events-unresolved")) return "multiple-seabass-events-unresolved";
  if (!signals.seabassMentioned) return "no-seabass";
  if (diagnostics.includes("event-date-missing")) return "unsupported-structure";
  return "no-supported-seabass-evidence";
}

function evaluateKnownRegressions(records) {
  const july14 = records.find((record) => record.sourceRecordId === "post:44876");
  const july7 = records.find((record) => record.sourceRecordId === "post:44791");
  const checks = {
    july14: Boolean(july14 && july14.catchCount === 29 && july14.anglerCount === 4),
    july7: Boolean(july7 && july7.catchCount === 22 && july7.durationMinutes === 240 && july7.anglerCount === 3)
  };
  return { ...checks, passed: checks.july14 && checks.july7 };
}

function classifySourceUsefulness(metrics) {
  const catchEvidence = metrics.relevantCount > 0 && metrics.evidenceCount === metrics.relevantCount && metrics.catchKnownCount === metrics.evidenceCount
    ? "strong"
    : metrics.evidenceCount > 0 && metrics.evidenceCount * 2 >= metrics.relevantCount && metrics.catchKnownCount === metrics.evidenceCount
      ? "moderate" : "weak";
  const effortEvidence = metrics.evidenceCount > 0 && metrics.bothEffortKnownCount === metrics.evidenceCount
    ? "strong"
    : metrics.relevantCount > 0
      && metrics.durationKnownCount * 2 >= metrics.relevantCount
      && metrics.anglerKnownCount * 2 >= metrics.relevantCount
        ? "moderate" : "weak";
  const temporalPrecision = metrics.relevantCount > 0 && metrics.eventExactCount === metrics.relevantCount
    ? "strong"
    : (metrics.eventExactCount + metrics.eventDayOnlyCount) * 2 >= metrics.relevantCount && metrics.relevantCount > 0
      ? "moderate" : "weak";
  const spatialPrecision = metrics.relevantCount > 0 && metrics.selectedNodeCount === metrics.relevantCount
    ? "strong"
    : metrics.relevantCount > 0
      && Math.max(metrics.sourceLocationCount, metrics.selectedNodeCount) * 2 >= metrics.relevantCount
        ? "moderate" : "weak";
  return {
    catchEvidence: { level: catchEvidence, reason: `${metrics.evidenceCount}/${metrics.relevantCount} relevant articles generated evidence; ${metrics.catchKnownCount} had catch counts.` },
    effortEvidence: { level: effortEvidence, reason: `${metrics.durationKnownCount} duration, ${metrics.anglerKnownCount} angler, ${metrics.bothEffortKnownCount} both.` },
    temporalPrecision: { level: temporalPrecision, reason: `${metrics.eventExactCount} exact-clock and ${metrics.eventDayOnlyCount} day-only relevant articles.` },
    spatialPrecision: { level: spatialPrecision, reason: `${metrics.sourceLocationCount} source-reported and ${metrics.selectedNodeCount} selected-node articles.` }
  };
}

function ingestionReadiness(metrics) {
  const reasons = [
    `${metrics.numericPostIdCount}/${metrics.parsedCount} parsed articles used numeric post IDs.`,
    `${metrics.evidenceCount}/${metrics.relevantCount} relevant articles generated evidence.`,
    `${metrics.catchKnownCount}/${metrics.evidenceCount} generated evidence records had catch counts.`,
    `${metrics.explicitZeroCount} explicit effort-zero records were available.`,
    `${metrics.sourceLocationCount} source locations and ${metrics.selectedNodeCount} selected nodes were available.`,
    `${metrics.unresolvedCount} relevant articles had unresolved multiple events.`
  ];
  if (metrics.parsedCount === 0 || metrics.numericPostIdCount === 0 || metrics.evidenceCount === 0) {
    return { status: "NOT_READY", reasons };
  }
  const complete = (
    metrics.numericPostIdCount === metrics.parsedCount
    && metrics.relevantCount > 0
    && metrics.evidenceCount === metrics.relevantCount
    && metrics.catchKnownCount === metrics.evidenceCount
    && metrics.explicitZeroCount > 0
    && metrics.unresolvedCount === 0
    && metrics.selectedNodeCount > 0
  );
  return { status: complete ? "READY" : "READY_WITH_LIMITATIONS", reasons };
}

function diagnosticFrequency(records) {
  const counts = new Map();
  for (const record of records) {
    for (const diagnostic of record.diagnostics ?? []) counts.set(diagnostic, (counts.get(diagnostic) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([diagnostic, count]) => ({ diagnostic, count }))
    .sort((left, right) => right.count - left.count || left.diagnostic.localeCompare(right.diagnostic))
    .slice(0, 12);
}

function countValues(values, knownValues) {
  const counts = Object.fromEntries(knownValues.map((value) => [value, 0]));
  for (const value of values) counts[value in counts ? value : "unknown"] += 1;
  return counts;
}

function auditError(error, fallbackReason, url) {
  const message = String(error?.message ?? "unknown error");
  const statusMatch = /HTTP\s+(\d{3})/u.exec(message);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const rateLimited = status === 403 || status === 429;
  const reason = error?.code === "source_fetch_failed" ? "fetch-error" : fallbackReason;
  return { url, reason, status, rateLimited, message: message.slice(0, 240) };
}

function uminekoListingPageUrl(page) {
  if (page === 1) return UMINEKO_LISTING_URL;
  return `https://umineko.biz/?page_id=306&paged=${page}`;
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-umineko-historical-audit.mjs --limit 50

Optional:
  --collected-at <canonical UTC ISO>
  --delay-ms <0..10000>
`);
}

async function main() {
  const options = parseUminekoAuditArgs();
  if (options.help) return printHelp();
  const report = await runUminekoHistoricalAudit(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.knownRegressions.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`umineko_historical_audit_failed: ${error?.message ?? "unknown error"}`);
    process.exitCode = 1;
  });
}
