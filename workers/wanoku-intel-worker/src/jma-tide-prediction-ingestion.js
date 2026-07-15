import {
  HYDRO_COASTAL_SCHEMA_VERSION
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";
import {
  JMA_TIDE_PREDICTION_PARSER_ID,
  JMA_TIDE_PREDICTION_PARSER_VERSION,
  JMA_TIDE_PREDICTION_PROVIDER_ID,
  JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
  JMA_TIDE_PREDICTION_STATIONS_2026,
  getJmaTidePredictionProviderDefinition,
  parseJmaTidePredictionFixedWidth
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import { writeHydroCoastalBatch } from "./hydro-coastal-persistence.js";

export const JMA_TIDE_PREDICTION_INGESTION_ID = "wanoku-jma-tide-prediction-ingestion";
export const JMA_TIDE_PREDICTION_SUPPORTED_SOURCE_YEARS = [2026];
export const JMA_TIDE_PREDICTION_ERROR_CODES = [
  "invalid_input",
  "fetch_error",
  "http_error",
  "body_read_error",
  "empty_body",
  "decode_error",
  "parse_failed",
  "no_observations",
  "persistence_error"
];

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function ingestJmaTidePredictionSource(input = {}) {
  const diagnostics = createDiagnostics();
  const resultBase = {
    ok: false,
    partial: false,
    status: "failed",
    sourceRunId: null,
    sourceUrl: safeSourceUrlForResult(input.sourceUrl),
    sourceYear: input.sourceYear ?? null,
    requestedAt: null,
    completedAt: null,
    forecastIssuedAt: input.forecastIssuedAt ?? null,
    httpStatus: null,
    rawHash: null,
    sourceByteLength: null,
    parsedObservationCount: 0,
    parserErrorCount: 0,
    parserWarningCount: 0,
    persistence: null
  };

  const validation = validateIngestionInput(input);
  diagnostics.errors.push(...validation.errors);
  diagnostics.warnings.push(...validation.warnings);
  if (diagnostics.errors.length) return finalizeIngestionResult(resultBase, diagnostics);

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? (() => new Date().toISOString());
  const runIdFactory = input.runIdFactory ?? defaultJmaTidePredictionRunId;
  const sha256Impl = input.sha256Impl ?? ((bytes) => sha256HexFromBytes(bytes, input.cryptoImpl ?? globalThis.crypto));
  const parseImpl = input.parseImpl ?? parseJmaTidePredictionFixedWidth;
  const persistenceImpl = input.persistenceImpl ?? writeHydroCoastalBatch;
  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  const sourceYear = input.sourceYear;
  const forecastIssuedAt = input.forecastIssuedAt;
  const sourceName = input.sourceName ?? "Japan Meteorological Agency tide table";
  const attribution = input.attribution ?? "Source: Japan Meteorological Agency. Normalized and processed by Wanoku.";

  const requestedAt = readCanonicalNow(now, "requestedAt", diagnostics);
  resultBase.requestedAt = requestedAt;
  if (!requestedAt) return finalizeIngestionResult(resultBase, diagnostics);

  let response;
  try {
    response = await fetchImpl(sourceUrl);
  } catch (error) {
    const completedAt = readCanonicalNow(now, "completedAt", diagnostics);
    resultBase.completedAt = completedAt;
    if (!completedAt || !validateChronology(requestedAt, completedAt, diagnostics)) return finalizeIngestionResult(resultBase, diagnostics);
    diagnostics.errors.push(diagnostic("fetch_error", `fetch failed: ${safeErrorMessage(error)}`));
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus: null,
        errorCode: "fetch_error",
        rawHash: null,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: null,
      persistenceImpl
    });
  }

  const responseShape = validateResponseShape(response);
  if (responseShape.errors.length) {
    const completedAt = readCanonicalNow(now, "completedAt", diagnostics);
    resultBase.completedAt = completedAt;
    if (!completedAt || !validateChronology(requestedAt, completedAt, diagnostics)) return finalizeIngestionResult(resultBase, diagnostics);
    diagnostics.errors.push(...responseShape.errors);
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus: responseShape.httpStatus,
        errorCode: "fetch_error",
        rawHash: null,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: null,
      persistenceImpl
    });
  }
  diagnostics.warnings.push(...responseShape.warnings);

  const httpStatus = responseShape.httpStatus;
  resultBase.httpStatus = httpStatus;
  const httpSuccessful = isSuccessfulHttpStatus(httpStatus);

  let bytes;
  let bodyReadDiagnostic = null;
  try {
    const arrayBuffer = await response.arrayBuffer();
    if (!(arrayBuffer instanceof ArrayBuffer)) {
      bodyReadDiagnostic = diagnostic("body_read_error", "response body must resolve to an ArrayBuffer.");
    } else {
      bytes = new Uint8Array(arrayBuffer);
    }
  } catch (error) {
    bodyReadDiagnostic = diagnostic("body_read_error", `response body could not be read: ${safeErrorMessage(error)}`);
  }
  if (bodyReadDiagnostic) {
    const completedAt = readCanonicalNow(now, "completedAt", diagnostics);
    resultBase.completedAt = completedAt;
    if (!completedAt || !validateChronology(requestedAt, completedAt, diagnostics)) return finalizeIngestionResult(resultBase, diagnostics);
    if (!httpSuccessful) {
      diagnostics.errors.push(httpErrorDiagnostic(httpStatus));
      diagnostics.warnings.push(bodyReadDiagnostic);
      return persistAndFinalize({
        input,
        resultBase,
        diagnostics,
        sourceRunInput: {
          requestedAt,
          completedAt,
          status: "failed",
          httpStatus,
          errorCode: "http_error",
          rawHash: null,
          sourceName,
          sourceUrl,
          sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
        },
        observations: [],
        runIdFactory,
        rawHashForRunId: null,
        persistenceImpl
      });
    }
    diagnostics.errors.push(bodyReadDiagnostic);
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "body_read_error",
        rawHash: null,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: null,
      persistenceImpl
    });
  }

  resultBase.sourceByteLength = bytes.byteLength;
  let rawHash = null;
  const hashDiagnostics = [];
  try {
    rawHash = await sha256Impl(bytes);
  } catch (error) {
    hashDiagnostics.push(diagnostic("fetch_error", `raw byte SHA-256 failed: ${safeErrorMessage(error)}`));
  }
  if (rawHash != null && !/^[0-9a-f]{64}$/.test(rawHash)) {
    hashDiagnostics.push(diagnostic("fetch_error", "raw byte SHA-256 must be a 64-character lowercase hex string."));
    rawHash = null;
  }
  resultBase.rawHash = rawHash;

  const completedAt = readCanonicalNow(now, "completedAt", diagnostics);
  resultBase.completedAt = completedAt;
  if (!completedAt || !validateChronology(requestedAt, completedAt, diagnostics)) return finalizeIngestionResult(resultBase, diagnostics);

  if (!rawHash && hashDiagnostics.length === 0) {
    hashDiagnostics.push(diagnostic("fetch_error", "raw byte SHA-256 did not produce a valid hash."));
  }
  if (!rawHash) {
    if (!httpSuccessful) {
      diagnostics.errors.push(httpErrorDiagnostic(httpStatus));
      diagnostics.warnings.push(...hashDiagnostics);
      return persistAndFinalize({
        input,
        resultBase,
        diagnostics,
        sourceRunInput: {
          requestedAt,
          completedAt,
          status: "failed",
          httpStatus,
          errorCode: "http_error",
          rawHash: null,
          sourceName,
          sourceUrl,
          sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
        },
        observations: [],
        runIdFactory,
        rawHashForRunId: null,
        persistenceImpl
      });
    }
    diagnostics.errors.push(...hashDiagnostics);
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "fetch_error",
        rawHash: null,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: null,
      persistenceImpl
    });
  }

  if (!httpSuccessful) {
    diagnostics.errors.push(httpErrorDiagnostic(httpStatus));
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "http_error",
        rawHash,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: rawHash,
      persistenceImpl
    });
  }

  if (bytes.byteLength === 0) {
    diagnostics.errors.push(diagnostic("empty_body", "source body is empty."));
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "empty_body",
        rawHash,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: rawHash,
      persistenceImpl
    });
  }

  const decoded = decodeJmaTidePredictionBytes(bytes);
  diagnostics.warnings.push(...decoded.warnings);
  if (decoded.errors.length) {
    diagnostics.errors.push(...decoded.errors);
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "decode_error",
        rawHash,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: rawHash,
      persistenceImpl
    });
  }

  let parsed;
  try {
    parsed = parseImpl(decoded.text, {
      provider: getJmaTidePredictionProviderDefinition(),
      stations: JMA_TIDE_PREDICTION_STATIONS_2026,
      sourceYear,
      collectedAt: completedAt,
      normalizedAt: completedAt,
      forecastIssuedAt,
      sourceUrl,
      sourceName,
      attribution
    });
  } catch (error) {
    diagnostics.errors.push(diagnostic("parse_failed", `parser threw: ${safeErrorMessage(error)}`));
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "parse_failed",
        rawHash,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: rawHash,
      persistenceImpl
    });
  }

  const normalizedParsed = normalizeParserResult(parsed, diagnostics);
  if (!normalizedParsed.valid) {
    resultBase.parserErrorCount = normalizedParsed.parserErrorCount;
    resultBase.parserWarningCount = normalizedParsed.parserWarningCount;
    return persistAndFinalize({
      input,
      resultBase,
      diagnostics,
      sourceRunInput: {
        requestedAt,
        completedAt,
        status: "failed",
        httpStatus,
        errorCode: "parse_failed",
        rawHash,
        sourceName,
        sourceUrl,
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      },
      observations: [],
      runIdFactory,
      rawHashForRunId: rawHash,
      persistenceImpl
    });
  }

  const parserErrors = normalizedParsed.errors;
  const parserWarnings = normalizedParsed.warnings;
  const observations = normalizedParsed.observations;
  resultBase.parsedObservationCount = observations.length;
  resultBase.parserErrorCount = parserErrors.length;
  resultBase.parserWarningCount = parserWarnings.length;
  diagnostics.errors.push(...parserErrors.map((message) => diagnostic("parse_failed", sanitizeParserDiagnostic(message, "parser error redacted."))));
  diagnostics.warnings.push(...parserWarnings.map((message) => diagnostic("parser_warning", sanitizeParserDiagnostic(message, "parser warning redacted."))));
  const sourceFormatVersion = normalizeSourceFormatVersion(parsed.sourceFormatVersion, diagnostics);

  let status = "ok";
  let errorCode = null;
  if (observations.length === 0) {
    status = "failed";
    errorCode = parserErrors.length ? "parse_failed" : "no_observations";
    diagnostics.errors.push(diagnostic(errorCode, parserErrors.length ? "parser returned errors and no observations." : "parser returned no observations."));
  } else if (parserErrors.length > 0) {
    status = "partial";
    errorCode = "parse_failed";
  }

  return persistAndFinalize({
    input,
    resultBase,
    diagnostics,
    sourceRunInput: {
      requestedAt,
      completedAt,
      status,
      httpStatus,
      errorCode,
      rawHash,
      sourceName,
      sourceUrl,
      sourceFormatVersion
    },
    observations: status === "failed" ? [] : observations,
    runIdFactory,
    rawHashForRunId: rawHash,
    persistenceImpl
  });
}

export function defaultJmaTidePredictionRunId({ providerId = JMA_TIDE_PREDICTION_PROVIDER_ID, sourceYear, requestedAt, rawHash }) {
  const hashPart = typeof rawHash === "string" && rawHash.length > 0 ? rawHash.slice(0, 16) : "nohash";
  return `${providerId}:${sourceYear}:${requestedAt}:${hashPart}`;
}

export async function sha256HexFromBytes(bytes, cryptoImpl = globalThis.crypto) {
  if (!(bytes instanceof Uint8Array)) throw new Error("bytes must be Uint8Array.");
  if (!cryptoImpl?.subtle?.digest) throw new Error("Web Crypto subtle.digest is unavailable.");
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeJmaTidePredictionBytes(bytes) {
  const errors = [];
  const warnings = [];
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    return {
      text: null,
      errors: [diagnostic("decode_error", `source bytes could not be decoded as UTF-8: ${safeErrorMessage(error)}`)],
      warnings
    };
  }
  if (text.includes("\uFFFD")) {
    errors.push(diagnostic("decode_error", "decoded source text contains replacement characters."));
  }
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
    warnings.push(diagnostic("decode_bom", "UTF-8 BOM was removed before fixed-width parsing."));
  }
  return { text, errors, warnings };
}

function validateIngestionInput(input) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== "object") {
    errors.push(diagnostic("invalid_input", "input must be an object."));
    return { errors, warnings };
  }
  if (!input.db || typeof input.db.prepare !== "function" || typeof input.db.batch !== "function") {
    errors.push(diagnostic("invalid_input", "db must be a D1-compatible binding with prepare() and batch()."));
  }
  const sourceUrl = validateSourceUrl(input.sourceUrl);
  if (sourceUrl.error) errors.push(sourceUrl.error);
  if (!Number.isInteger(input.sourceYear)) {
    errors.push(diagnostic("invalid_input", "sourceYear must be an integer."));
  } else if (!JMA_TIDE_PREDICTION_SUPPORTED_SOURCE_YEARS.includes(input.sourceYear)) {
    errors.push(diagnostic("invalid_input", `sourceYear ${input.sourceYear} is not supported; only 2026 station metadata is available.`));
  }
  if (!isCanonicalUtcIsoDateTime(input.forecastIssuedAt)) {
    errors.push(diagnostic("invalid_input", "forecastIssuedAt must be caller supplied canonical UTC ISO datetime."));
  }
  if (input.fetchImpl != null && typeof input.fetchImpl !== "function") errors.push(diagnostic("invalid_input", "fetchImpl must be a function when provided."));
  if (input.now != null && typeof input.now !== "function") errors.push(diagnostic("invalid_input", "now must be a function when provided."));
  if (input.runIdFactory != null && typeof input.runIdFactory !== "function") errors.push(diagnostic("invalid_input", "runIdFactory must be a function when provided."));
  if (input.sha256Impl != null && typeof input.sha256Impl !== "function") errors.push(diagnostic("invalid_input", "sha256Impl must be a function when provided."));
  if (input.parseImpl != null && typeof input.parseImpl !== "function") errors.push(diagnostic("invalid_input", "parseImpl must be a function when provided."));
  if (input.persistenceImpl != null && typeof input.persistenceImpl !== "function") errors.push(diagnostic("invalid_input", "persistenceImpl must be a function when provided."));
  if (input.sourceName != null && typeof input.sourceName !== "string") errors.push(diagnostic("invalid_input", "sourceName must be a string when provided."));
  if (input.attribution != null && typeof input.attribution !== "string") errors.push(diagnostic("invalid_input", "attribution must be a string when provided."));
  return { errors, warnings };
}

function validateSourceUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: diagnostic("invalid_input", "sourceUrl must be a non-empty HTTPS URL.") };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { error: diagnostic("invalid_input", "sourceUrl must use HTTPS.") };
    if (url.username || url.password) return { error: diagnostic("invalid_input", "sourceUrl must not contain credentials.") };
    return { url: url.toString() };
  } catch {
    return { error: diagnostic("invalid_input", "sourceUrl must be a valid HTTPS URL.") };
  }
}

function normalizeSourceUrl(value) {
  return new URL(value).toString();
}

function safeSourceUrlForResult(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateResponseShape(response) {
  const errors = [];
  const warnings = [];
  const httpStatus = Number.isInteger(response?.status) ? response.status : null;
  if (!response || typeof response !== "object") {
    errors.push(diagnostic("fetch_error", "fetch response must be an object."));
  } else {
    if (typeof response.arrayBuffer !== "function") errors.push(diagnostic("fetch_error", "fetch response must provide arrayBuffer()."));
    if (httpStatus == null) {
      errors.push(diagnostic("fetch_error", "fetch response status must be an integer."));
    } else if (httpStatus < 100 || httpStatus > 599) {
      errors.push(diagnostic("fetch_error", "fetch response status must be between 100 and 599."));
    } else if (typeof response.ok === "boolean" && response.ok !== isSuccessfulHttpStatus(httpStatus)) {
      warnings.push(diagnostic("http_status_warning", "response.ok disagrees with response.status; response.status is used."));
    }
  }
  return { errors, warnings, httpStatus };
}

function isSuccessfulHttpStatus(httpStatus) {
  return httpStatus >= 200 && httpStatus <= 299;
}

function httpErrorDiagnostic(httpStatus) {
  return diagnostic("http_error", `HTTP status ${httpStatus} is not successful.`);
}

function normalizeParserResult(parsed, diagnostics) {
  const parserErrorCount = Array.isArray(parsed?.errors) ? parsed.errors.length : 0;
  const parserWarningCount = Array.isArray(parsed?.warnings) ? parsed.warnings.length : 0;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.errors.push(diagnostic("parse_failed", "parser result must be a non-null object."));
    return { valid: false, observations: [], errors: [], warnings: [], parserErrorCount, parserWarningCount };
  }
  const shapeErrors = [];
  if (!Array.isArray(parsed.observations)) shapeErrors.push("parser result observations must be an array.");
  if (!Array.isArray(parsed.errors)) shapeErrors.push("parser result errors must be an array.");
  if (!Array.isArray(parsed.warnings)) shapeErrors.push("parser result warnings must be an array.");
  if (shapeErrors.length) {
    diagnostics.errors.push(...shapeErrors.map((message) => diagnostic("parse_failed", message)));
    return { valid: false, observations: [], errors: [], warnings: [], parserErrorCount, parserWarningCount };
  }
  return {
    valid: true,
    observations: parsed.observations,
    errors: parsed.errors,
    warnings: parsed.warnings,
    parserErrorCount,
    parserWarningCount
  };
}

function normalizeSourceFormatVersion(sourceFormatVersion, diagnostics) {
  if (typeof sourceFormatVersion === "string" && sourceFormatVersion.trim().length > 0) {
    return sourceFormatVersion;
  }
  diagnostics.warnings.push(diagnostic("parser_warning", "parser sourceFormatVersion was invalid; default JMA tide prediction source format version was used."));
  return JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION;
}

function sanitizeParserDiagnostic(value, fallbackMessage) {
  if (typeof value !== "string") return fallbackMessage;
  let text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/"[^"]*"/g, "\"[redacted]\"").replace(/'[^']*'/g, "'[redacted]'");
  const knownPrefix = /^(line \d+(?: hour \d+)?:|station [A-Za-z0-9_-]+:|duplicate JMA tide prediction daily line ignored:|conflicting JMA tide prediction daily lines:|input must be a string\.|provider validation:|context:)/;
  if (!knownPrefix.test(text)) return fallbackMessage;
  if (text.length > 240) return `${text.slice(0, 240)}...`;
  return text;
}

function readCanonicalNow(now, label, diagnostics) {
  let value;
  try {
    value = now();
  } catch (error) {
    diagnostics.errors.push(diagnostic("invalid_input", `${label} now() failed: ${safeErrorMessage(error)}`));
    return null;
  }
  if (!isCanonicalUtcIsoDateTime(value)) {
    diagnostics.errors.push(diagnostic("invalid_input", `${label} must be canonical UTC ISO datetime.`));
    return null;
  }
  return value;
}

function validateChronology(requestedAt, completedAt, diagnostics) {
  if (Date.parse(completedAt) < Date.parse(requestedAt)) {
    diagnostics.errors.push(diagnostic("invalid_input", "completedAt must be >= requestedAt."));
    return false;
  }
  return true;
}

async function persistAndFinalize({
  input,
  resultBase,
  diagnostics,
  sourceRunInput,
  observations,
  runIdFactory,
  rawHashForRunId,
  persistenceImpl
}) {
  let sourceRunId;
  try {
    sourceRunId = runIdFactory({
      providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
      sourceYear: input.sourceYear,
      requestedAt: sourceRunInput.requestedAt,
      rawHash: rawHashForRunId
    });
  } catch (error) {
    diagnostics.errors.push(diagnostic("invalid_input", `runIdFactory failed: ${safeErrorMessage(error)}`));
    return finalizeIngestionResult(resultBase, diagnostics);
  }
  if (typeof sourceRunId !== "string" || sourceRunId.trim().length === 0) {
    diagnostics.errors.push(diagnostic("invalid_input", "runIdFactory must return a non-empty string."));
    return finalizeIngestionResult(resultBase, diagnostics);
  }

  const sourceRun = {
    id: sourceRunId,
    providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
    requestedAt: sourceRunInput.requestedAt,
    completedAt: sourceRunInput.completedAt,
    status: sourceRunInput.status,
    httpStatus: sourceRunInput.httpStatus,
    errorCode: sourceRunInput.errorCode,
    rawHash: sourceRunInput.rawHash,
    sourceName: sourceRunInput.sourceName,
    sourceUrl: sourceRunInput.sourceUrl,
    parserId: JMA_TIDE_PREDICTION_PARSER_ID,
    parserVersion: JMA_TIDE_PREDICTION_PARSER_VERSION,
    sourceFormatVersion: sourceRunInput.sourceFormatVersion,
    normalizedSchemaVersion: HYDRO_COASTAL_SCHEMA_VERSION
  };
  let persistence = null;
  try {
    persistence = await persistenceImpl(input.db, { sourceRun, observations });
  } catch (error) {
    diagnostics.errors.push(diagnostic("persistence_error", `Hydro-coastal persistence threw: ${safeErrorMessage(error)}`));
  }
  if (persistence && !persistence.ok) diagnostics.errors.push(diagnostic("persistence_error", "Hydro-coastal persistence failed."));

  return finalizeIngestionResult({
    ...resultBase,
    status: sourceRun.status,
    partial: sourceRun.status === "partial",
    sourceRunId,
    sourceUrl: sourceRun.sourceUrl,
    sourceYear: input.sourceYear,
    requestedAt: sourceRun.requestedAt,
    completedAt: sourceRun.completedAt,
    forecastIssuedAt: input.forecastIssuedAt,
    httpStatus: sourceRun.httpStatus,
    rawHash: sourceRun.rawHash,
    persistence
  }, diagnostics);
}

function finalizeIngestionResult(resultBase, diagnostics) {
  const errors = uniqueDiagnostics(diagnostics.errors);
  const warnings = uniqueDiagnostics(diagnostics.warnings);
  const ok = resultBase.status === "ok" && resultBase.persistence?.ok === true && errors.length === 0;
  return {
    ...resultBase,
    ok,
    errors,
    warnings
  };
}

function createDiagnostics() {
  return { errors: [], warnings: [] };
}

function diagnostic(code, message) {
  return { code, message };
}

function uniqueDiagnostics(items) {
  const byKey = new Map();
  for (const item of items) {
    const normalized = normalizeDiagnosticItem(item);
    byKey.set(`${normalized.code}:${normalized.message}`, normalized);
  }
  return [...byKey.values()];
}

function normalizeDiagnosticItem(item) {
  if (typeof item === "string") return diagnostic("diagnostic", item);
  if (item && typeof item === "object" && typeof item.code === "string" && typeof item.message === "string") {
    return diagnostic(item.code, item.message);
  }
  return diagnostic("diagnostic", "diagnostic redacted.");
}

function safeErrorMessage(error) {
  return error instanceof Error ? (error.name || "Error") : typeof error;
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
