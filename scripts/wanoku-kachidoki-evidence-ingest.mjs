#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchKachidokiHtml } from "./wanoku-kachidoki-historical-audit.mjs";
import {
  buildKachidokiEvidencePreview,
  validateKachidokiExternalEvidenceInput
} from "./wanoku-kachidoki-evidence-preview.mjs";

export const KACHIDOKI_EVIDENCE_INGEST_VERSION = "wanoku-kachidoki-evidence-ingest.v1";
export const KACHIDOKI_PRODUCTION_WORKER_URL = "https://wanoku-intel-worker.mtk0808.workers.dev";

const SOURCE_MONTH = /^(20\d{2})-(0[1-9]|1[0-2])$/u;
const DEFAULT_DELAY_MS = 100;

export class KachidokiEvidenceIngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KachidokiEvidenceIngestError";
    this.code = code;
  }
}

export function parseKachidokiEvidenceIngestArgs(argv = process.argv.slice(2)) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--month") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw ingestError("missing_option_value", "Missing value for --month.");
      options.month = requireSourceMonth(value);
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw ingestError("unknown_option", `Unknown option: ${arg}`);
    }
  }
  if (!options.help && !options.month) throw ingestError("month_required", "--month YYYY-MM is required.");
  return options;
}

export function kachidokiMonthlySourceUrl(value) {
  const month = requireSourceMonth(value);
  return `https://kachidoki-marina.com/fishing-results-${month.replace("-", "")}/`;
}

export async function runKachidokiEvidenceIngest(options = {}) {
  const month = requireSourceMonth(options.month);
  const apply = options.apply === true;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw ingestError("fetch_unavailable", "fetch is unavailable.");
  const adminSecret = apply ? options.adminSecret ?? process.env.WANOKU_ADMIN_SECRET : null;
  if (apply && (typeof adminSecret !== "string" || adminSecret.length === 0)) {
    throw ingestError("admin_secret_required", "WANOKU_ADMIN_SECRET is required for --apply.");
  }

  const workerBaseUrl = requireWorkerBaseUrl(options.workerBaseUrl ?? KACHIDOKI_PRODUCTION_WORKER_URL);
  const delayMs = requireDelay(options.delayMs ?? DEFAULT_DELAY_MS);
  const sourceUrl = kachidokiMonthlySourceUrl(month);
  const sourceFetchedAt = canonicalTimestamp(options.collectedAt ?? (options.clock ?? systemClock)(), "collectedAt");
  const [sourceYear, sourceMonth] = month.split("-").map(Number);
  const html = await fetchKachidokiHtml(sourceUrl, fetchImpl);
  const buildPreview = options.buildPreviewImpl ?? buildKachidokiEvidencePreview;
  const validateEvidence = options.validateEvidenceImpl ?? validateKachidokiExternalEvidenceInput;
  const preview = buildPreview({ html, url: sourceUrl, sourceYear, sourceMonth, collectedAt: sourceFetchedAt });
  const summaryPath = options.summaryPath === undefined
    ? path.join(tmpdir(), `wanoku-kachidoki-ingest-${month}-summary.json`)
    : options.summaryPath;
  const summary = initialSummary({ apply, month, sourceFetchedAt, preview });
  const candidates = preview.parsedTrips.map((trip) => ({ trip, record: evidenceRecord(trip) }));
  summary.records.push(...candidates.map((candidate) => candidate.record));
  summary.records.push(...preview.ignoredTrips.map(skippedRecord));

  const ambiguous = preview.ignoredTrips.filter((trip) => (
    trip.diagnostics.includes("source-event-identity-ambiguous")
  )).length;
  summary.ambiguous = ambiguous;
  if (ambiguous > 0) addFatal(summary, "source_identity_collision", null, null);

  const seenSourceIdentities = new Set();
  for (const candidate of candidates) {
    const validation = validateEvidence(candidate.trip.externalEvidenceInput);
    if (!validPreparedCandidate(candidate.trip, validation)) {
      addFatal(summary, "invalid_generated_evidence", candidate.trip.evidenceId ?? null, null);
      continue;
    }
    if (seenSourceIdentities.has(validation.evidence.sourceIdentity)) {
      summary.ambiguous += 1;
      addFatal(summary, "source_identity_collision", validation.evidenceId, null);
      continue;
    }
    seenSourceIdentities.add(validation.evidence.sourceIdentity);
    candidate.requestPayload = candidate.trip.externalEvidenceInput;
    candidate.evidenceId = validation.evidenceId;
    candidate.semanticHash = validation.semanticHash;
  }

  if (summary.fatalErrors.length > 0) {
    markPendingSkipped(candidates, "preflight-aborted");
    return finishSummary(summary, summaryPath);
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const preflight = await preflightEvidence(fetchImpl, workerBaseUrl, candidate);
    if (preflight.status === "EXISTING" || preflight.status === "WOULD_CREATE") {
      candidate.record.status = preflight.status;
    } else {
      candidate.record.status = "SKIPPED";
      candidate.record.reason = preflight.code;
      addFatal(summary, preflight.code, candidate.evidenceId, preflight.httpStatus);
      markPendingSkipped(candidates.slice(index + 1), "preflight-aborted");
      break;
    }
    if (delayMs > 0 && index < candidates.length - 1) await pause(delayMs);
  }

  if (!apply || summary.fatalErrors.length > 0) return finishSummary(summary, summaryPath);

  const writable = candidates.filter((candidate) => candidate.record.status === "WOULD_CREATE");
  for (let index = 0; index < writable.length; index += 1) {
    const candidate = writable[index];
    const writeResult = await createEvidence(fetchImpl, workerBaseUrl, adminSecret, candidate);
    if (writeResult.status === "CREATED" || writeResult.status === "EXISTING") {
      candidate.record.status = writeResult.status;
    } else {
      candidate.record.status = "FAILED";
      candidate.record.reason = writeResult.code;
      addFatal(summary, writeResult.code, candidate.evidenceId, writeResult.httpStatus);
      summary.createdBeforeFailure = candidates.filter((item) => item.record.status === "CREATED").length;
      summary.failedEvidenceId = candidate.evidenceId;
      summary.remaining = writable.slice(index + 1).filter((item) => item.record.status === "WOULD_CREATE").length;
      break;
    }
    if (delayMs > 0 && index < writable.length - 1) await pause(delayMs);
  }

  return finishSummary(summary, summaryPath);
}

async function preflightEvidence(fetchImpl, workerBaseUrl, candidate) {
  let response;
  try {
    response = await fetchImpl(
      `${workerBaseUrl}/evidence/seabass/${encodeURIComponent(candidate.evidenceId)}`,
      { method: "GET", headers: { accept: "application/json" } }
    );
  } catch {
    return { status: "FATAL", code: "preflight_network_error", httpStatus: null };
  }
  if (response.status === 404) return { status: "WOULD_CREATE" };
  if (response.status !== 200) {
    return {
      status: "FATAL",
      code: response.status === 500 ? "preflight_integrity_or_server_error" : "preflight_http_error",
      httpStatus: response.status
    };
  }
  const body = await readJson(response);
  if (body?.evidenceId !== candidate.evidenceId || body?.payloadHash !== candidate.semanticHash) {
    return { status: "FATAL", code: "preflight_identity_mismatch", httpStatus: 200 };
  }
  return { status: "EXISTING" };
}

async function createEvidence(fetchImpl, workerBaseUrl, adminSecret, candidate) {
  let response;
  try {
    response = await fetchImpl(`${workerBaseUrl}/admin/evidence/seabass`, {
      method: "POST",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${adminSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(candidate.requestPayload)
    });
  } catch {
    return { status: "FATAL", code: "create_network_error", httpStatus: null };
  }
  if (response.status !== 200 && response.status !== 201) {
    return { status: "FATAL", code: "create_http_error", httpStatus: response.status };
  }
  const body = await readJson(response);
  const validContract = response.status === 201 ? body?.created === true : body?.created === false;
  if (!validContract) return { status: "FATAL", code: "create_response_contract_mismatch", httpStatus: response.status };
  if (body.evidenceId !== candidate.evidenceId) {
    return { status: "FATAL", code: "create_evidence_id_mismatch", httpStatus: response.status };
  }
  if (body.payloadHash !== candidate.semanticHash) {
    return { status: "FATAL", code: "create_payload_hash_mismatch", httpStatus: response.status };
  }
  return { status: body.created ? "CREATED" : "EXISTING" };
}

function initialSummary({ apply, month, sourceFetchedAt, preview }) {
  return {
    schemaVersion: KACHIDOKI_EVIDENCE_INGEST_VERSION,
    mode: apply ? "APPLY" : "DRY_RUN",
    month,
    sourceRecordId: preview.source.sourceRecordId,
    sourceFetchedAt,
    collectedAt: preview.collectedAt,
    tripsDiscovered: preview.summary.discoveredTripCount,
    generated: preview.summary.evidenceGeneratedCount,
    existing: 0,
    wouldCreate: 0,
    created: 0,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    fatalErrors: [],
    revisionDetection: "id-only-preflight",
    createdBeforeFailure: 0,
    failedEvidenceId: null,
    remaining: 0,
    records: []
  };
}

function evidenceRecord(trip) {
  const evidence = trip.canonicalEvidence;
  return {
    sourceEventKey: trip.sourceEventKey,
    evidenceType: evidence.evidenceType,
    presenceSupport: evidence.presenceSupport,
    directFishEvidence: evidence.directFishEvidence,
    catchCount: evidence.catchCount,
    interaction: {
      present: evidence.interaction.present,
      count: evidence.interaction.count,
      countLowerBound: evidence.interaction.countLowerBound
    },
    durationMinutes: evidence.effort.durationMinutes,
    evidenceId: trip.evidenceId,
    status: "PENDING"
  };
}

function skippedRecord(trip) {
  return {
    sourceEventKey: trip.sourceEventKey,
    evidenceType: null,
    presenceSupport: null,
    directFishEvidence: null,
    catchCount: null,
    interaction: { present: null, count: null, countLowerBound: null },
    durationMinutes: null,
    evidenceId: null,
    status: "SKIPPED",
    reason: trip.diagnostics.join(",")
  };
}

function validPreparedCandidate(trip, validation) {
  return (
    !("sourceIdentity" in trip.externalEvidenceInput)
    && validation?.valid === true
    && validation.evidence
    && validation.errors?.length === 0
    && validation.evidenceId === trip.evidenceId
    && validation.semanticHash === trip.semanticHash
    && validation.evidence.sourceIdentity === trip.canonicalEvidence.sourceIdentity
  );
}

function markPendingSkipped(candidates, reason) {
  for (const candidate of candidates) {
    if (candidate.record.status !== "PENDING") continue;
    candidate.record.status = "SKIPPED";
    candidate.record.reason = reason;
  }
}

function addFatal(summary, code, evidenceId, httpStatus) {
  summary.fatalErrors.push({ code, evidenceId, httpStatus });
}

async function finishSummary(summary, summaryPath) {
  summary.existing = summary.records.filter((record) => record.status === "EXISTING").length;
  summary.wouldCreate = summary.records.filter((record) => record.status === "WOULD_CREATE").length;
  summary.created = summary.records.filter((record) => record.status === "CREATED").length;
  summary.skipped = summary.records.filter((record) => record.status === "SKIPPED").length;
  summary.failed = summary.records.filter((record) => record.status === "FAILED").length;
  summary.ok = summary.fatalErrors.length === 0 && summary.failed === 0;
  summary.summaryArtifact = summaryPath ?? null;
  if (summaryPath) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function readJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function requireSourceMonth(value) {
  const match = SOURCE_MONTH.exec(String(value ?? ""));
  if (!match) throw ingestError("invalid_source_month", "month must be YYYY-MM.");
  return `${match[1]}-${match[2]}`;
}

function requireWorkerBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw ingestError("invalid_worker_url", "workerBaseUrl must be an HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw ingestError("invalid_worker_url", "workerBaseUrl must be an HTTPS origin.");
  }
  return url.origin;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw ingestError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw ingestError("invalid_datetime", `${label} must be canonical UTC ISO datetime.`);
  }
  return value;
}

function requireDelay(value) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw ingestError("invalid_delay", "delayMs must be an integer from 0 to 10000.");
  }
  return value;
}

function systemClock() {
  return new Date().toISOString();
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ingestError(code, message) {
  return new KachidokiEvidenceIngestError(code, message);
}

function printHelp() {
  console.log(`Usage:
  node scripts/wanoku-kachidoki-evidence-ingest.mjs --month YYYY-MM [--apply]

Default mode is read-only DRY_RUN. --apply requires WANOKU_ADMIN_SECRET.
`);
}

async function main() {
  const options = parseKachidokiEvidenceIngestArgs();
  if (options.help) return printHelp();
  const summary = await runKachidokiEvidenceIngest(options);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`${error?.code ?? "kachidoki_evidence_ingest_failed"}: ${error?.message ?? "Kachidoki ingestion failed."}`);
    process.exitCode = 1;
  });
}
