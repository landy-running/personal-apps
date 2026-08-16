#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchWakuwakuyaHtml,
  parseWakuwakuyaMonthlyPage
} from "./wanoku-wakuwakuya-historical-audit.mjs";

export const WAKUWAKUYA_EVIDENCE_ADAPTER_VERSION = "wanoku-wakuwakuya-evidence-adapter.v1";
export const WAKUWAKUYA_EVIDENCE_PROVIDER_ID = "wakuwakuya";

const SOURCE_CLASS = "charter-or-guide-log";
const EVIDENCE_SCHEMA_VERSION = "wanoku-seabass-external-evidence.v1.1";
const EVIDENCE_ID_PREFIX = "wanoku-seabass-evidence:";
const SPECIES = Object.freeze({ id: "japanese-seabass", scientificName: "Lateolabrax japonicus" });
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SOURCE_MONTH = /^(20\d{2})-(0[1-9]|1[0-2])$/u;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let loadedModules;

export class WakuwakuyaEvidencePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WakuwakuyaEvidencePreviewError";
    this.code = code;
  }
}

export function parseWakuwakuyaEvidencePreviewArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new WakuwakuyaEvidencePreviewError("missing_option_value", `Missing value for ${arg}.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--month") options.month = requireSourceMonth(readValue());
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new WakuwakuyaEvidencePreviewError("unknown_option", `Unknown option: ${arg}`);
  }
  if (!options.help && !options.month) {
    throw new WakuwakuyaEvidencePreviewError("month_required", "--month YYYY-MM is required.");
  }
  return options;
}

export async function runWakuwakuyaEvidencePreview(options = {}) {
  const sourceMonth = requireSourceMonth(options.month);
  const collectedAt = requireCanonicalUtcIso(options.collectedAt, "collectedAt");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new WakuwakuyaEvidencePreviewError("fetch_unavailable", "fetch is unavailable.");
  }
  const sourceUrl = `https://wakuwakuya.jp/blog.php?f=m&mon=${sourceMonth}`;
  const html = await fetchWakuwakuyaHtml(sourceUrl, fetchImpl);
  return buildWakuwakuyaEvidencePreview({ html, url: sourceUrl, sourceMonth, collectedAt });
}

export function buildWakuwakuyaEvidencePreview({ html, url, sourceMonth, collectedAt }) {
  const canonicalCollectedAt = requireCanonicalUtcIso(collectedAt, "collectedAt");
  const canonicalSourceMonth = requireSourceMonth(sourceMonth);
  const page = parseWakuwakuyaMonthlyPage({ html, url, sourceMonth: canonicalSourceMonth });
  const generated = [];
  const skipped = [];
  const notRelevant = [];
  const parseErrors = [];

  for (const record of page.records) {
    if (record.parseStatus !== "ok") {
      parseErrors.push(ignoredArticle(record, "SKIPPED_AMBIGUOUS", record.diagnostics));
      continue;
    }
    if (!record.seabassMentioned) {
      notRelevant.push({
        sourceRecordId: record.sourceRecordId,
        sourceEventKey: record.sourceEventKey,
        eventDate: record.eventDate
      });
      continue;
    }
    const result = buildWakuwakuyaArticleEvidence({ record, collectedAt: canonicalCollectedAt });
    if (result.ok) generated.push(result.article);
    else skipped.push(result.article);
  }

  const classified = [...generated, ...skipped];
  const evidenceTypeDistribution = Object.fromEntries(
    ["catch", "fish-observation", "bite-or-contact", "explicit-effort-zero-catch"]
      .map((evidenceType) => [
        evidenceType,
        generated.filter((article) => article.canonicalEvidence.evidenceType === evidenceType).length
      ])
  );
  const summary = {
    articlesDiscovered: page.entryCount,
    parsedArticles: page.records.filter((record) => record.parseStatus === "ok").length,
    seabassRelevant: classified.length,
    evidenceGenerated: generated.length,
    skippedNotRepresentable: skipped.filter((article) => article.classification === "SKIPPED_NOT_REPRESENTABLE").length,
    skippedAmbiguous: skipped.filter((article) => article.classification === "SKIPPED_AMBIGUOUS").length,
    cancelled: skipped.filter((article) => article.classification === "CANCELLED").length,
    notRelevant: notRelevant.length,
    parseErrors: parseErrors.length,
    evidenceTypeDistribution,
    exactNumericCatch: generated.filter((article) => article.canonicalEvidence.evidenceType === "catch").length,
    nonnumericPositiveCatch: generated.filter((article) => article.adapterMetadata.landedPositiveUnquantified).length,
    lowerBoundCatch: generated.filter((article) => article.adapterMetadata.landedCountLowerBound !== null).length,
    interactionPresent: generated.filter((article) => article.canonicalEvidence.interaction.present === true).length,
    interactionExactCount: generated.filter((article) => article.canonicalEvidence.interaction.count !== null).length,
    interactionLowerBoundCount: generated.filter((article) => article.canonicalEvidence.interaction.countLowerBound !== null).length,
    lostFishMentioned: generated.filter((article) => article.canonicalEvidence.interaction.lostFishMentioned).length,
    explicitZero: generated.filter((article) => article.canonicalEvidence.evidenceType === "explicit-effort-zero-catch").length,
    effortKnown: generated.filter((article) => article.canonicalEvidence.effort.known).length,
    conditionChangeMetadata: generated.filter((article) => article.adapterMetadata.conditionChanges.length > 0).length,
    habitatMetadata: generated.filter((article) => article.adapterMetadata.habitatClues.length > 0).length
  };

  return {
    adapterVersion: WAKUWAKUYA_EVIDENCE_ADAPTER_VERSION,
    source: {
      providerId: WAKUWAKUYA_EVIDENCE_PROVIDER_ID,
      sourceClass: SOURCE_CLASS,
      sourceMonth: canonicalSourceMonth,
      sourceUrl: page.sourceUrl
    },
    collectedAt: canonicalCollectedAt,
    summary,
    articles: classified,
    parseErrors,
    notRelevant,
    diagnostics: unique([
      ...(parseErrors.length > 0 ? ["monthly-page-record-parse-errors"] : []),
      ...(page.records.some((record) => record.diagnostics.includes("duplicate-source-record-id"))
        ? ["monthly-page-source-identity-collision"]
        : [])
    ])
  };
}

export function buildWakuwakuyaArticleEvidence({ record, collectedAt }) {
  const canonicalCollectedAt = requireCanonicalUtcIso(collectedAt, "collectedAt");
  const blocking = blockingClassification(record);
  if (blocking) {
    return {
      ok: false,
      article: ignoredArticle(record, blocking.classification, blocking.diagnostics)
    };
  }

  const semantics = evidenceSemanticsForRecord(record);
  if (!semantics) {
    const sourceSemanticClass = sourceSemanticClassForRecord(record);
    const ambiguousReaction = record.environmentalClues.includes("fish-response")
      && !record.contactEvidencePresent
      && !record.landedPositiveEvidence;
    const visibleOnly = sourceSemanticClass === "visible-only";
    return {
      ok: false,
      article: ignoredArticle(
        record,
        ambiguousReaction ? "SKIPPED_AMBIGUOUS" : "SKIPPED_NOT_REPRESENTABLE",
        [
          ambiguousReaction
            ? "ambiguous-reaction-not-contact"
            : visibleOnly
              ? "visible-only-not-foundation-promoted"
              : "no-foundation-representable-evidence"
        ]
      )
    };
  }

  const interval = jstEventDayInterval(record.eventDate, canonicalCollectedAt);
  const sourceEventKey = seabassSourceEventKey(record);
  const interaction = interactionForRecord(record);
  const effortKnown = record.durationKnown || record.anglerCountKnown;
  const qualityFlags = unique([
    "event-time-day-only",
    ...(record.daypart === "night" ? ["event-daypart-night-explicit"] : []),
    "publication-time-unknown",
    ...(effortKnown ? [] : ["effort-unknown"]),
    "location-unknown"
  ]);
  const input = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    species: { ...SPECIES },
    evidenceType: semantics.evidenceType,
    eventStartAt: interval.eventStartAt,
    eventEndAt: interval.eventEndAt,
    publishedAt: null,
    collectedAt: canonicalCollectedAt,
    presenceSupport: semantics.presenceSupport,
    catchOutcome: semantics.catchOutcome,
    directFishEvidence: semantics.directFishEvidence,
    catchCount: semantics.catchCount,
    interaction,
    effort: {
      known: effortKnown,
      durationMinutes: record.durationKnown ? record.durationMinutes : null,
      anglerCount: record.anglerCountKnown ? record.anglerCount : null,
      targetSpeciesExplicit: record.seabassTargeted
    },
    location: {
      rawLabel: record.sourceLocationLabel,
      latitude: null,
      longitude: null,
      mappedNodeId: null,
      mapping: { method: "unknown", status: "unknown" }
    },
    source: {
      providerId: WAKUWAKUYA_EVIDENCE_PROVIDER_ID,
      sourceClass: SOURCE_CLASS,
      sourceRecordId: record.sourceRecordId,
      sourceEventKey,
      sourceUrl: record.url,
      title: null
    },
    provenance: {
      extractionMethod: "deterministic-parser",
      extractorVersion: WAKUWAKUYA_EVIDENCE_ADAPTER_VERSION,
      mappingVersion: "wanoku-wakuwakuya-location.v1"
    },
    qualityFlags
  };

  const validation = validateWakuwakuyaExternalEvidenceInput(input);
  if (!validation.valid || !validation.evidence) {
    return {
      ok: false,
      article: ignoredArticle(record, "SKIPPED_NOT_REPRESENTABLE", [
        "foundation-validation-failed",
        ...validation.errors.map((error) => `foundation:${error}`)
      ])
    };
  }

  return {
    ok: true,
    article: {
      classification: "GENERATED",
      sourceRecordId: record.sourceRecordId,
      sourceEventKey,
      externalEvidenceInput: input,
      canonicalEvidence: validation.evidence,
      semanticHash: validation.semanticHash,
      evidenceId: validation.evidenceId,
      adapterMetadata: adapterMetadata(record),
      diagnostics: adapterDiagnostics(record, semantics)
    }
  };
}

export function validateWakuwakuyaExternalEvidenceInput(input) {
  const modules = loadWanokuModules();
  const validation = modules.buildSeabassExternalEvidence(input);
  if (!validation.valid || !validation.evidence) {
    return { ...validation, evidenceId: null, semanticHash: null };
  }
  const semantic = modules.buildSeabassEvidenceSemanticContent(validation.evidence);
  const semanticJson = modules.canonicalHydroCoastalJson(semantic);
  const semanticHash = createHash("sha256").update(semanticJson, "utf8").digest("hex");
  return {
    ...validation,
    semanticHash,
    evidenceId: `${EVIDENCE_ID_PREFIX}${semanticHash}`
  };
}

function evidenceSemanticsForRecord(record) {
  if (record.landedCountKnown && record.landedCount > 0) {
    return {
      evidenceType: "catch",
      presenceSupport: "positive",
      catchOutcome: "positive",
      directFishEvidence: true,
      catchCount: record.landedCount
    };
  }
  if (
    record.landedCountLowerBound !== null
    || (record.landedPositiveEvidence && !record.landedCountKnown)
  ) {
    return {
      evidenceType: "fish-observation",
      presenceSupport: "positive",
      catchOutcome: "unknown",
      directFishEvidence: true,
      catchCount: null
    };
  }
  if (interactionForRecord(record).present === true) {
    return {
      evidenceType: "bite-or-contact",
      presenceSupport: "positive",
      catchOutcome: "unknown",
      directFishEvidence: true,
      catchCount: record.landedCountKnown && record.landedCount === 0 ? 0 : null
    };
  }
  const explicitTripZero = record.explicitZeroCandidate
    || (
      record.explicitSeabassEffort
      && record.landedCountKnown
      && record.landedCount === 0
      && !record.contactEvidencePresent
    );
  if (explicitTripZero && (record.durationKnown || record.anglerCountKnown)) {
    return {
      evidenceType: "explicit-effort-zero-catch",
      presenceSupport: "none",
      catchOutcome: "explicit-zero",
      directFishEvidence: false,
      catchCount: 0
    };
  }
  return null;
}

function interactionForRecord(record) {
  const count = record.contactCountKnown && record.contactCount > 0 ? record.contactCount : null;
  const countLowerBound = record.contactCountLowerBound > 0 ? record.contactCountLowerBound : null;
  const present = Boolean(
    record.contactEvidencePresent
    || count !== null
    || countLowerBound !== null
    || record.biteMentioned
    || record.chaseMentioned
    || record.lostFishMentioned
  );
  return {
    present: present ? true : null,
    count,
    countLowerBound,
    biteMentioned: record.biteMentioned,
    chaseMentioned: record.chaseMentioned,
    lostFishMentioned: record.lostFishMentioned
  };
}

function blockingClassification(record) {
  if (record.tripStatus === "cancelled") {
    return { classification: "CANCELLED", diagnostics: ["trip-cancelled"] };
  }
  if (!/^post:\d+$/u.test(record.sourceRecordId ?? "")) {
    return { classification: "SKIPPED_AMBIGUOUS", diagnostics: ["source-record-id-unresolved"] };
  }
  if (record.diagnostics.includes("duplicate-source-record-id")) {
    return {
      classification: "SKIPPED_AMBIGUOUS",
      diagnostics: ["source-identity-collision", "source-event-identity-collision"]
    };
  }
  return null;
}

function adapterMetadata(record) {
  return {
    eventDate: record.eventDate,
    daypart: record.daypart,
    temporalPrecision: record.temporalPrecision,
    landedCountLowerBound: record.landedCountLowerBound,
    landedPositiveUnquantified: Boolean(
      record.landedPositiveEvidence
      && !record.landedCountKnown
      && record.landedCountLowerBound === null
    ),
    followMentioned: record.followMentioned,
    visibleFishMentioned: record.visibleFishMentioned,
    zeroSegmentMentioned: record.zeroSegmentCandidate,
    durationSource: record.durationSource,
    sourceLocationMentioned: record.sourceLocationMentioned,
    sourceSemanticClass: sourceSemanticClassForRecord(record),
    conditionChanges: record.conditionChangeTypes.map((type) => ({
      type,
      outcomeBeforeAfterResolvable: record.outcomeBeforeAfterResolvable
    })),
    habitatClues: [...record.habitatClues],
    environmentalClues: [...record.environmentalClues]
  };
}

function adapterDiagnostics(record, semantics) {
  return unique([
    ...record.diagnostics,
    "trip-publication-time-unavailable",
    ...(record.landedCountLowerBound !== null ? ["landed-count-lower-bound-not-representable"] : []),
    ...(semantics.evidenceType === "fish-observation" && record.landedCountLowerBound === null
      ? ["landed-count-unquantified"]
      : []),
    ...(record.followMentioned ? ["follow-not-mapped-to-chase"] : []),
    ...(record.visibleFishMentioned ? ["visible-fish-adapter-metadata-only"] : []),
    ...(record.conditionChangeTypes.length > 0 ? ["condition-change-adapter-metadata-only"] : []),
    ...(record.habitatClues.length > 0 ? ["habitat-clue-adapter-metadata-only"] : [])
  ]);
}

function ignoredArticle(record, classification, diagnostics) {
  return {
    classification,
    sourceRecordId: record.sourceRecordId,
    sourceEventKey: record.seabassMentioned && record.eventDate
      ? seabassSourceEventKey(record)
      : record.sourceEventKey,
    adapterMetadata: {
      eventDate: record.eventDate,
      daypart: record.daypart,
      parseStatus: record.parseStatus,
      sourceSemanticClass: sourceSemanticClassForRecord(record)
    },
    diagnostics: unique(diagnostics)
  };
}

function sourceSemanticClassForRecord(record) {
  if (record.landedCountKnown && record.landedCount > 0) return "landed-positive-exact";
  if (record.landedCountLowerBound !== null) return "landed-positive-lower-bound";
  if (record.landedPositiveEvidence && !record.landedCountKnown) return "landed-positive-unquantified";
  if (interactionForRecord(record).present === true) return "interaction-only";
  if (record.visibleFishMentioned) return "visible-only";
  if (record.explicitZeroCandidate || (record.landedCountKnown && record.landedCount === 0)) {
    return "explicit-landed-zero";
  }
  return null;
}

function seabassSourceEventKey(record) {
  return `${record.eventDate}-${record.daypart}-seabass`;
}

function jstEventDayInterval(eventDate, collectedAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(eventDate ?? "");
  if (!match) throw new WakuwakuyaEvidencePreviewError("invalid_event_date", "eventDate must be YYYY-MM-DD.");
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 9 * 60 * 60 * 1000;
  const eventStartAt = new Date(startMs).toISOString();
  const eventDayEndAt = new Date(startMs + 24 * 60 * 60 * 1000 - 1).toISOString();
  if (Date.parse(eventStartAt) > Date.parse(collectedAt)) {
    throw new WakuwakuyaEvidencePreviewError("future_event", "eventStartAt must be <= collectedAt.");
  }
  return {
    eventStartAt,
    eventEndAt: Date.parse(eventDayEndAt) <= Date.parse(collectedAt) ? eventDayEndAt : collectedAt
  };
}

function loadWanokuModules() {
  if (loadedModules) return loadedModules;
  const requireFn = createRequire(import.meta.url);
  registerTypeScriptRequireHook(requireFn);
  const externalEvidence = requireFn(path.join(REPO_ROOT, "packages/wanoku-core/src/external-evidence.ts"));
  const persistence = loadEsmFileAsCommonJs(
    path.join(REPO_ROOT, "workers/wanoku-intel-worker/src/hydro-coastal-persistence.js"),
    requireFn
  );
  loadedModules = {
    buildSeabassExternalEvidence: externalEvidence.buildSeabassExternalEvidence,
    buildSeabassEvidenceSemanticContent: externalEvidence.buildSeabassEvidenceSemanticContent,
    canonicalHydroCoastalJson: persistence.canonicalHydroCoastalJson
  };
  return loadedModules;
}

function registerTypeScriptRequireHook(requireFn) {
  const Module = requireFn("node:module");
  if (Module._extensions[".ts"]?.__wanokuEvidencePreview) return;
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
  hook.__wanokuEvidencePreview = true;
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

function requireSourceMonth(value) {
  const match = SOURCE_MONTH.exec(String(value ?? ""));
  if (!match) {
    throw new WakuwakuyaEvidencePreviewError("invalid_source_month", "month must be YYYY-MM.");
  }
  return `${match[1]}-${match[2]}`;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) {
    throw new WakuwakuyaEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new WakuwakuyaEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-wakuwakuya-evidence-preview.mjs --month YYYY-MM

Optional:
  --collected-at <canonical UTC ISO>  Fix the read-only preview collection time.
`);
}

async function main() {
  const options = parseWakuwakuyaEvidencePreviewArgs();
  if (options.help) return printHelp();
  const preview = await runWakuwakuyaEvidencePreview({
    ...options,
    collectedAt: options.collectedAt ?? new Date().toISOString()
  });
  console.log(JSON.stringify(preview, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`${error?.code ?? "wakuwakuya_evidence_preview_failed"}: ${error?.message ?? "Wakuwakuya preview failed."}`);
    process.exitCode = 1;
  });
}
