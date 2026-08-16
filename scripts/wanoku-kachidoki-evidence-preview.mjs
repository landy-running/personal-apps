#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  KACHIDOKI_RESULTS_URL,
  discoverKachidokiMonths,
  fetchKachidokiHtml,
  parseKachidokiMonthlyPage
} from "./wanoku-kachidoki-historical-audit.mjs";

export const KACHIDOKI_EVIDENCE_ADAPTER_VERSION = "wanoku-kachidoki-evidence-adapter.v1";
export const KACHIDOKI_EVIDENCE_PROVIDER_ID = "kachidoki-marina";

const SOURCE_CLASS = "charter-or-guide-log";
const EVIDENCE_SCHEMA_VERSION = "wanoku-seabass-external-evidence.v1.1";
const EVIDENCE_ID_PREFIX = "wanoku-seabass-evidence:";
const SPECIES = Object.freeze({ id: "japanese-seabass", scientificName: "Lateolabrax japonicus" });
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SOURCE_MONTH = /^(20\d{2})-(0[1-9]|1[0-2])$/u;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let loadedModules;

export class KachidokiEvidencePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KachidokiEvidencePreviewError";
    this.code = code;
  }
}

export function parseKachidokiEvidencePreviewArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new KachidokiEvidencePreviewError("missing_option_value", `Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === "--month") options.month = requireSourceMonth(readValue());
    else if (arg === "--collected-at") options.collectedAt = requireCanonicalUtcIso(readValue(), "collected-at");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new KachidokiEvidencePreviewError("unknown_option", `Unknown option: ${arg}`);
  }
  if (!options.help && !options.month) throw new KachidokiEvidencePreviewError("month_required", "--month YYYY-MM is required.");
  return options;
}

export async function runKachidokiEvidencePreview(options = {}) {
  const sourceMonth = requireSourceMonth(options.month);
  const collectedAt = requireCanonicalUtcIso(options.collectedAt, "collectedAt");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new KachidokiEvidencePreviewError("fetch_unavailable", "fetch is unavailable.");

  const archiveHtml = await fetchKachidokiHtml(KACHIDOKI_RESULTS_URL, fetchImpl);
  const month = discoverKachidokiMonths(archiveHtml, KACHIDOKI_RESULTS_URL)
    .find((candidate) => candidate.sourceMonth === sourceMonth);
  if (!month) throw new KachidokiEvidencePreviewError("source_month_not_found", `Kachidoki source month was not found: ${sourceMonth}`);
  const html = month.url === KACHIDOKI_RESULTS_URL
    ? archiveHtml
    : await fetchKachidokiHtml(month.url, fetchImpl);
  return buildKachidokiEvidencePreview({
    html,
    url: month.url,
    sourceYear: month.sourceYear,
    sourceMonth: month.month,
    collectedAt
  });
}

export function buildKachidokiEvidencePreview({ html, url, sourceYear, sourceMonth, collectedAt }) {
  const canonicalCollectedAt = requireCanonicalUtcIso(collectedAt, "collectedAt");
  const page = parseKachidokiMonthlyPage({ html, url, sourceYear, sourceMonth });
  const sourceMonthValue = `${page.sourceYear}-${String(page.sourceMonth).padStart(2, "0")}`;
  const numericSourceRecordId = /^post:\d+$/u.test(page.sourceRecordId) ? page.sourceRecordId : null;
  const parsedTrips = [];
  const ignoredTrips = [];
  const pageDiagnostics = [...page.diagnostics];
  if (!numericSourceRecordId) pageDiagnostics.push("source-record-id-numeric-required");
  if (page.publishedAt !== null || page.modifiedAt !== null) {
    pageDiagnostics.push("monthly-page-publication-not-trip-specific");
  }

  for (const record of page.records) {
    const skipDiagnostics = skipDiagnosticsForRecord(record, numericSourceRecordId);
    if (skipDiagnostics.length > 0) {
      ignoredTrips.push(ignoredTrip(record, skipDiagnostics));
      continue;
    }

    let built;
    try {
      built = buildKachidokiTripEvidence({ record, page, collectedAt: canonicalCollectedAt });
    } catch (error) {
      ignoredTrips.push(ignoredTrip(record, [error?.code ?? "evidence-build-failed"]));
      continue;
    }
    if (!built.ok) {
      ignoredTrips.push(ignoredTrip(record, built.diagnostics));
      continue;
    }
    parsedTrips.push(built.trip);
  }

  const summary = {
    discoveredTripCount: page.entryCount,
    evidenceGeneratedCount: parsedTrips.length,
    skippedTripCount: ignoredTrips.length,
    positiveCatchCount: parsedTrips.filter((trip) => trip.canonicalEvidence.evidenceType === "catch").length,
    explicitZeroCount: parsedTrips.filter((trip) => trip.canonicalEvidence.evidenceType === "explicit-effort-zero-catch").length,
    landedCatchTotal: parsedTrips.reduce((sum, trip) => sum + (trip.canonicalEvidence.catchCount ?? 0), 0),
    interactionExactCount: parsedTrips.filter((trip) => trip.canonicalEvidence.interaction.count !== null).length,
    interactionLowerBoundCount: parsedTrips.filter((trip) => trip.canonicalEvidence.interaction.countLowerBound !== null).length,
    interactionPresentCount: parsedTrips.filter((trip) => trip.canonicalEvidence.interaction.present === true).length
  };

  return {
    adapterVersion: KACHIDOKI_EVIDENCE_ADAPTER_VERSION,
    source: {
      providerId: KACHIDOKI_EVIDENCE_PROVIDER_ID,
      sourceClass: SOURCE_CLASS,
      sourceRecordId: numericSourceRecordId,
      sourceMonth: sourceMonthValue,
      sourceUrl: page.sourceUrl
    },
    collectedAt: canonicalCollectedAt,
    summary,
    parsedTrips,
    ignoredTrips,
    diagnostics: unique(pageDiagnostics)
  };
}

export function buildKachidokiTripEvidence({ record, page, collectedAt }) {
  const diagnostics = adapterDiagnostics(record);
  const interval = jstEventDayInterval(record.eventDate, collectedAt);
  const publishedAt = null;
  const effortKnown = record.effortDurationKnown || record.anglerCountKnown;
  const interactionPresent = (
    (record.hitCountKnown && record.hitCount > 0)
    || record.hitCountLowerBound > 0
    || record.hitEvidencePresent
    || record.biteMentioned
    || record.chaseMentioned
    || record.lostFishMentioned
  );
  const evidenceSemantics = evidenceSemanticsForRecord(record);
  const qualityFlags = unique([
    "event-time-day-only",
    ...(record.daypart === "NIGHT" ? ["event-daypart-night-explicit"] : []),
    ...(publishedAt === null ? ["publication-time-unknown"] : []),
    ...(effortKnown ? [] : ["effort-unknown"]),
    "location-unknown"
  ]);
  const input = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    species: { ...SPECIES },
    evidenceType: evidenceSemantics.evidenceType,
    eventStartAt: interval.eventStartAt,
    eventEndAt: interval.eventEndAt,
    publishedAt,
    collectedAt,
    presenceSupport: evidenceSemantics.presenceSupport,
    catchOutcome: evidenceSemantics.catchOutcome,
    directFishEvidence: evidenceSemantics.directFishEvidence,
    catchCount: evidenceSemantics.catchCount,
    interaction: {
      present: interactionPresent ? true : null,
      count: record.hitCountKnown && record.hitCount > 0 ? record.hitCount : null,
      countLowerBound: record.hitCountLowerBound > 0 ? record.hitCountLowerBound : null,
      biteMentioned: record.biteMentioned,
      chaseMentioned: record.chaseMentioned,
      lostFishMentioned: record.lostFishMentioned
    },
    effort: {
      known: effortKnown,
      durationMinutes: record.effortDurationKnown ? record.effortDurationMinutes : null,
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
      providerId: KACHIDOKI_EVIDENCE_PROVIDER_ID,
      sourceClass: SOURCE_CLASS,
      sourceRecordId: record.sourceRecordId,
      sourceEventKey: record.sourceEventKey,
      sourceUrl: record.sourceUrl,
      title: null
    },
    provenance: {
      extractionMethod: "deterministic-parser",
      extractorVersion: KACHIDOKI_EVIDENCE_ADAPTER_VERSION,
      mappingVersion: "wanoku-kachidoki-location.v1"
    },
    qualityFlags
  };

  const validation = validateKachidokiExternalEvidenceInput(input);
  if (!validation.valid || !validation.evidence) {
    return {
      ok: false,
      diagnostics: [...diagnostics, "foundation-validation-failed", ...validation.errors.map((error) => `foundation:${error}`)]
    };
  }
  return {
    ok: true,
    trip: {
      sourceEventKey: record.sourceEventKey,
      externalEvidenceInput: input,
      canonicalEvidence: validation.evidence,
      evidenceId: validation.evidenceId,
      semanticHash: validation.semanticHash,
      adapterMetadata: {
        eventDate: record.eventDate,
        daypart: record.daypart,
        temporalPrecision: record.temporalPrecision,
        durationSource: record.durationSource,
        sourceLocationMentioned: record.sourceLocationMentioned
      },
      diagnostics
    }
  };
}

export function validateKachidokiExternalEvidenceInput(input) {
  const modules = loadWanokuModules();
  const validation = modules.buildSeabassExternalEvidence(input);
  if (!validation.valid || !validation.evidence) {
    return { ...validation, evidenceId: null, semanticHash: null };
  }
  const identity = semanticEvidenceIdentity(validation.evidence, modules);
  return { ...validation, evidenceId: identity.evidenceId, semanticHash: identity.semanticHash };
}

function evidenceSemanticsForRecord(record) {
  if (record.foundationConvertibleType === "positive-catch") {
    return {
      evidenceType: "catch",
      presenceSupport: "positive",
      catchOutcome: "positive",
      directFishEvidence: true,
      catchCount: record.getCount
    };
  }
  if (record.foundationConvertibleType === "explicit-effort-zero-catch") {
    return {
      evidenceType: "explicit-effort-zero-catch",
      presenceSupport: "none",
      catchOutcome: "explicit-zero",
      directFishEvidence: false,
      catchCount: 0
    };
  }
  return {
    evidenceType: "bite-or-contact",
    presenceSupport: "positive",
    catchOutcome: "unknown",
    directFishEvidence: true,
    catchCount: record.getCountKnown && record.getCount === 0 ? 0 : null
  };
}

function skipDiagnosticsForRecord(record, numericSourceRecordId) {
  if (!numericSourceRecordId) return ["source-record-id-numeric-required"];
  if (record.parseStatus !== "ok") return [...record.diagnostics];
  if (record.diagnostics.includes("duplicate-source-event-key")) return ["source-event-identity-ambiguous"];
  if (record.tripCancelled) return ["trip-cancelled"];
  if (record.foundationConvertibleType === null) {
    if (!record.seabassMentioned) return ["no-japanese-seabass-evidence"];
    return ["no-foundation-convertible-evidence"];
  }
  const supportedInteraction = record.hitEvidencePresent
    || record.biteMentioned
    || record.chaseMentioned
    || record.lostFishMentioned;
  if (record.foundationConvertibleType === "bite-or-contact" && !supportedInteraction) {
    return ["unsupported-follow-only-interaction"];
  }
  return [];
}

function adapterDiagnostics(record) {
  return unique([
    ...record.diagnostics.filter((diagnostic) => diagnostic !== "foundation-gap"),
    "trip-publication-time-unavailable",
    ...(record.followMentioned ? ["follow-not-mapped-to-chase"] : [])
  ]);
}

function ignoredTrip(record, diagnostics) {
  return {
    sourceEventKey: record.sourceEventKey,
    adapterMetadata: {
      eventDate: record.eventDate,
      daypart: record.daypart,
      parseStatus: record.parseStatus
    },
    diagnostics: unique(diagnostics)
  };
}

function jstEventDayInterval(eventDate, collectedAt) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(eventDate ?? "");
  if (!match) throw new KachidokiEvidencePreviewError("invalid_event_date", "eventDate must be YYYY-MM-DD.");
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 9 * 60 * 60 * 1000;
  const eventStartAt = new Date(startMs).toISOString();
  const dayEndAt = new Date(startMs + 24 * 60 * 60 * 1000 - 1).toISOString();
  if (Date.parse(eventStartAt) > Date.parse(collectedAt)) {
    throw new KachidokiEvidencePreviewError("future_event", "eventStartAt must be <= collectedAt.");
  }
  return {
    eventStartAt,
    eventEndAt: Date.parse(dayEndAt) <= Date.parse(collectedAt) ? dayEndAt : collectedAt
  };
}

function semanticEvidenceIdentity(evidence, modules) {
  const semantic = modules.buildSeabassEvidenceSemanticContent(evidence);
  const semanticJson = modules.canonicalHydroCoastalJson(semantic);
  const semanticHash = createHash("sha256").update(semanticJson, "utf8").digest("hex");
  return { semanticHash, evidenceId: `${EVIDENCE_ID_PREFIX}${semanticHash}` };
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
  if (!match) throw new KachidokiEvidencePreviewError("invalid_source_month", "month must be YYYY-MM.");
  return `${match[1]}-${match[2]}`;
}

function requireCanonicalUtcIso(value, label) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) {
    throw new KachidokiEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new KachidokiEvidencePreviewError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-kachidoki-evidence-preview.mjs --month YYYY-MM

Optional:
  --collected-at <canonical UTC ISO>  Fix the read-only preview collection time.
`);
}

async function main() {
  const options = parseKachidokiEvidencePreviewArgs();
  if (options.help) return printHelp();
  const preview = await runKachidokiEvidencePreview({
    ...options,
    collectedAt: options.collectedAt ?? new Date().toISOString()
  });
  console.log(JSON.stringify(preview, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`${error?.code ?? "kachidoki_evidence_preview_failed"}: ${error?.message ?? "Kachidoki preview failed."}`);
    process.exitCode = 1;
  });
}
