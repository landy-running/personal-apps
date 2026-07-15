import { describe, expect, it } from "vitest";
import {
  HYDRO_COASTAL_SCHEMA_VERSION
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";
import {
  JMA_TIDE_PREDICTION_LINE_LENGTH,
  JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
  parseJmaTidePredictionFixedWidth
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import {
  defaultJmaTidePredictionRunId,
  ingestJmaTidePredictionSource,
  sha256HexFromBytes
} from "./jma-tide-prediction-ingestion.js";

const SOURCE_URL = "https://example.test/jma/tide/2026.txt";
const SOURCE_YEAR = 2026;
const FORECAST_ISSUED_AT = "2025-12-30T00:00:00.000Z";
const REQUESTED_AT = "2025-12-31T00:00:00.000Z";
const COMPLETED_AT = "2025-12-31T00:00:03.000Z";

describe("JMA Tide Prediction Ingestion Orchestrator", () => {
  it("fetches exact bytes, hashes before parsing, parses 120 observations, and persists an ok source run", async () => {
    const db = new MockD1Database();
    const sourceText = fiveStationBody();
    const sourceBytes = bytesFromText(sourceText);
    let bodyReadCount = 0;
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromBytes(sourceBytes, { onArrayBuffer: () => { bodyReadCount += 1; } }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    const expectedHash = await sha256HexFromBytes(sourceBytes);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.partial).toBe(false);
    expect(result.rawHash).toBe(expectedHash);
    expect(result.sourceByteLength).toBe(sourceBytes.byteLength);
    expect(result.parsedObservationCount).toBe(120);
    expect(result.parserErrorCount).toBe(0);
    expect(result.parserWarningCount).toBe(0);
    expect(result.persistence).toMatchObject({ ok: true, insertedCount: 120, duplicateCount: 0 });
    expect(result.sourceRunId).toContain(expectedHash.slice(0, 16));
    expect(result.requestedAt).toBe(REQUESTED_AT);
    expect(result.completedAt).toBe(COMPLETED_AT);
    expect(bodyReadCount).toBe(1);
    expect(db.sourceRuns.size).toBe(1);
    expect(db.observations.size).toBe(120);
    const sourceRun = [...db.sourceRuns.values()][0];
    expect(sourceRun.status).toBe("ok");
    expect(sourceRun.raw_hash).toBe(expectedHash);
    expect(sourceRun.normalized_schema_version).toBe(HYDRO_COASTAL_SCHEMA_VERSION);
    const persistedObservation = JSON.parse([...db.observations.values()][0].normalized_json);
    expect(persistedObservation.collectedAt).toBe(COMPLETED_AT);
    expect(persistedObservation.provenance.sourceUrl).toBe(SOURCE_URL);
    expect(persistedObservation.provenance.attribution).toContain("Japan Meteorological Agency");
    expect(JSON.stringify(result)).not.toContain(sourceText);
    expect(sourceRun.run_json).not.toContain(sourceText);
  });

  it("computes SHA-256 from raw bytes as lowercase hexadecimal", async () => {
    await expect(sha256HexFromBytes(bytesFromText("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("generates deterministic run IDs and uses nohash before bytes are available", () => {
    expect(defaultJmaTidePredictionRunId({
      sourceYear: 2026,
      requestedAt: REQUESTED_AT,
      rawHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    })).toBe("jma-tide-prediction:2026:2025-12-31T00:00:00.000Z:abcdef0123456789");
    expect(defaultJmaTidePredictionRunId({
      sourceYear: 2026,
      requestedAt: REQUESTED_AT,
      rawHash: null
    })).toBe("jma-tide-prediction:2026:2025-12-31T00:00:00.000Z:nohash");
  });

  it("persists a failed source run when fetch throws without returning tokens or raw payload", async () => {
    const db = new MockD1Database();
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => { throw new Error("network unavailable with SECRET_INTERNAL_DETAIL"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.sourceRunId).toContain(":nohash");
    expect(result.httpStatus).toBeNull();
    expect(result.rawHash).toBeNull();
    expect(result.persistence).toMatchObject({ ok: true, insertedCount: 0 });
    expect(result.errors.map((item) => item.code)).toContain("fetch_error");
    expect(db.sourceRuns.size).toBe(1);
    expect(db.observations.size).toBe(0);
    expect([...db.sourceRuns.values()][0]).toMatchObject({ status: "failed", error_code: "fetch_error" });
    expect(JSON.stringify(result)).not.toContain("SECRET_INTERNAL_DETAIL");
  });

  it("reads and hashes HTTP error bodies but does not parse them", async () => {
    const db = new MockD1Database();
    const body = bytesFromText("not parsed");
    let parseCalled = false;
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromBytes(body, { status: 404 }),
      parseImpl: () => {
        parseCalled = true;
        throw new Error("parser must not be called");
      },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(404);
    expect(result.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.errors.map((item) => item.code)).toContain("http_error");
    expect(parseCalled).toBe(false);
    expect(db.sourceRuns.size).toBe(1);
    expect(db.observations.size).toBe(0);
  });

  it("uses response.status as the primary HTTP classifier even when response.ok disagrees", async () => {
    const notFoundDb = new MockD1Database();
    const okDisagreesDb = new MockD1Database();
    const successDb = new MockD1Database();
    const notFound = await ingestJmaTidePredictionSource({
      ...baseInput(notFoundDb),
      fetchImpl: async () => responseFromText("not parsed", { status: 404, ok: true }),
      parseImpl: () => { throw new Error("parser must not run"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const success = await ingestJmaTidePredictionSource({
      ...baseInput(successDb),
      fetchImpl: async () => responseFromText(jmaLine(), { status: 200, ok: false }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const invalidStatus = await ingestJmaTidePredictionSource({
      ...baseInput(okDisagreesDb),
      fetchImpl: async () => responseFromText(jmaLine(), { status: 600, ok: true }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(notFound.status).toBe("failed");
    expect(notFound.errors.map((item) => item.code)).toContain("http_error");
    expect(notFound.warnings.map((item) => item.code)).toContain("http_status_warning");
    expect([...notFoundDb.sourceRuns.values()][0].error_code).toBe("http_error");
    expect(success.status).toBe("ok");
    expect(success.ok).toBe(true);
    expect(success.warnings.map((item) => item.code)).toContain("http_status_warning");
    expect(invalidStatus.errors.map((item) => item.code)).toContain("fetch_error");
    expect(okDisagreesDb.observations.size).toBe(0);
  });

  it("keeps http_error primary when non-2xx body read or hash best-effort handling fails", async () => {
    const bodyThrowDb = new MockD1Database();
    const hashThrowDb = new MockD1Database();
    const bodyThrow = await ingestJmaTidePredictionSource({
      ...baseInput(bodyThrowDb),
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => { throw new Error("SECRET_BODY_READ"); }
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const hashThrow = await ingestJmaTidePredictionSource({
      ...baseInput(hashThrowDb),
      fetchImpl: async () => responseFromText("not parsed", { status: 404 }),
      sha256Impl: async () => { throw new Error("SECRET_HASH"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(bodyThrow.errors.map((item) => item.code)).toEqual(["http_error"]);
    expect(bodyThrow.warnings.map((item) => item.code)).toContain("body_read_error");
    expect([...bodyThrowDb.sourceRuns.values()][0].error_code).toBe("http_error");
    expect(hashThrow.errors.map((item) => item.code)).toEqual(["http_error"]);
    expect(hashThrow.warnings.map((item) => item.code)).toContain("fetch_error");
    expect([...hashThrowDb.sourceRuns.values()][0].error_code).toBe("http_error");
    expect(JSON.stringify(bodyThrow)).not.toContain("SECRET_BODY_READ");
    expect(JSON.stringify(hashThrow)).not.toContain("SECRET_HASH");
  });

  it("classifies response arrayBuffer failures and invalid response shapes as failed source runs", async () => {
    const bodyReadDb = new MockD1Database();
    const invalidShapeDb = new MockD1Database();
    const bodyRead = await ingestJmaTidePredictionSource({
      ...baseInput(bodyReadDb),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => { throw new Error("body unavailable"); }
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const invalidShape = await ingestJmaTidePredictionSource({
      ...baseInput(invalidShapeDb),
      fetchImpl: async () => ({ ok: true, status: 200 }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(bodyRead.errors.map((item) => item.code)).toContain("body_read_error");
    expect([...bodyReadDb.sourceRuns.values()][0].error_code).toBe("body_read_error");
    expect(invalidShape.errors.map((item) => item.code)).toContain("fetch_error");
    expect([...invalidShapeDb.sourceRuns.values()][0].error_code).toBe("fetch_error");
  });

  it("treats invalid arrayBuffer results as body_read_error instead of empty body", async () => {
    const successDb = new MockD1Database();
    const httpDb = new MockD1Database();
    const success = await ingestJmaTidePredictionSource({
      ...baseInput(successDb),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => "not an ArrayBuffer"
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const http = await ingestJmaTidePredictionSource({
      ...baseInput(httpDb),
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => ({})
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(success.errors.map((item) => item.code)).toContain("body_read_error");
    expect(success.errors.map((item) => item.code)).not.toContain("empty_body");
    expect([...successDb.sourceRuns.values()][0].error_code).toBe("body_read_error");
    expect(http.errors.map((item) => item.code)).toEqual(["http_error"]);
    expect(http.warnings.map((item) => item.code)).toContain("body_read_error");
  });

  it("persists failed source runs for empty body and decode errors without parser execution", async () => {
    const emptyDb = new MockD1Database();
    const decodeDb = new MockD1Database();
    let parseCalled = false;
    const empty = await ingestJmaTidePredictionSource({
      ...baseInput(emptyDb),
      fetchImpl: async () => responseFromBytes(new Uint8Array()),
      parseImpl: () => {
        parseCalled = true;
        return {};
      },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const decode = await ingestJmaTidePredictionSource({
      ...baseInput(decodeDb),
      fetchImpl: async () => responseFromBytes(new Uint8Array([0xff])),
      parseImpl: () => {
        parseCalled = true;
        return {};
      },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(empty.errors.map((item) => item.code)).toContain("empty_body");
    expect(decode.errors.map((item) => item.code)).toContain("decode_error");
    expect(parseCalled).toBe(false);
    expect(empty.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decode.rawHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emptyDb.observations.size).toBe(0);
    expect(decodeDb.observations.size).toBe(0);
  });

  it("rejects decoded replacement characters before fixed-width parsing", async () => {
    const db = new MockD1Database();
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromText(`\uFFFD${jmaLine().slice(1)}`),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.status).toBe("failed");
    expect(result.errors.map((item) => item.code)).toContain("decode_error");
    expect(db.observations.size).toBe(0);
  });

  it("preserves fixed-width spaces while accepting CRLF and BOM boundaries", async () => {
    const crlfDb = new MockD1Database();
    const bomDb = new MockD1Database();
    const crlf = await ingestJmaTidePredictionSource({
      ...baseInput(crlfDb),
      fetchImpl: async () => responseFromText([jmaLine({ station: "TK" }), jmaLine({ station: "CB" })].join("\r\n")),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const bom = await ingestJmaTidePredictionSource({
      ...baseInput(bomDb),
      fetchImpl: async () => responseFromBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesFromText(jmaLine({ station: "TK" }))])),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(jmaLine()).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
    expect(crlf.status).toBe("ok");
    expect(crlf.parsedObservationCount).toBe(48);
    expect(bom.status).toBe("ok");
    expect(bom.parsedObservationCount).toBe(24);
  });

  it("classifies parser throw, no observations, partial parser errors, and warning-only parses", async () => {
    const throwDb = new MockD1Database();
    const noneDb = new MockD1Database();
    const partialDb = new MockD1Database();
    const warningDb = new MockD1Database();
    const parserThrow = await ingestJmaTidePredictionSource({
      ...baseInput(throwDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      parseImpl: () => { throw new Error("parser exploded"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const noObservations = await ingestJmaTidePredictionSource({
      ...baseInput(noneDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      parseImpl: () => ({
        providerId: "jma-tide-prediction",
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
        observations: [],
        errors: [],
        warnings: []
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const partial = await ingestJmaTidePredictionSource({
      ...baseInput(partialDb),
      fetchImpl: async () => responseFromText([jmaLine({ station: "TK" }), jmaLine({ station: "ZZ" })].join("\n")),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const warningOnly = await ingestJmaTidePredictionSource({
      ...baseInput(warningDb),
      fetchImpl: async () => responseFromText([jmaLine({ station: "TK" }), jmaLine({ station: "TK" })].join("\n")),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(parserThrow.status).toBe("failed");
    expect(parserThrow.errors.map((item) => item.code)).toContain("parse_failed");
    expect(noObservations.status).toBe("failed");
    expect(noObservations.errors.map((item) => item.code)).toContain("no_observations");
    expect(partial.status).toBe("partial");
    expect(partial.ok).toBe(false);
    expect(partial.partial).toBe(true);
    expect(partial.parsedObservationCount).toBe(24);
    expect(partial.persistence).toMatchObject({ ok: true, partial: true, insertedCount: 24 });
    expect(warningOnly.status).toBe("ok");
    expect(warningOnly.ok).toBe(true);
    expect(warningOnly.parserWarningCount).toBeGreaterThan(0);
    expect(warningOnly.parsedObservationCount).toBe(24);
  });

  it("handles malformed parser results as parse_failed structured results", async () => {
    const malformedResults = [
      null,
      undefined,
      "bad",
      42,
      {},
      { observations: {}, errors: [], warnings: [] },
      { observations: [], errors: "bad", warnings: [] },
      { observations: [], errors: [], warnings: {} }
    ];

    for (const malformed of malformedResults) {
      const db = new MockD1Database();
      const result = await ingestJmaTidePredictionSource({
        ...baseInput(db),
        fetchImpl: async () => responseFromText(jmaLine()),
        parseImpl: () => malformed,
        now: nowSequence([REQUESTED_AT, COMPLETED_AT])
      });
      expect(result.status).toBe("failed");
      expect(result.ok).toBe(false);
      expect(result.parsedObservationCount).toBe(0);
      expect(result.errors.map((item) => item.code)).toContain("parse_failed");
      expect(db.sourceRuns.size).toBe(1);
      expect(db.observations.size).toBe(0);
    }
  });

  it("sanitizes parser diagnostics, non-string diagnostics, and invalid sourceFormatVersion", async () => {
    const invalidFieldDb = new MockD1Database();
    const rawBodyDb = new MockD1Database();
    const nonStringDb = new MockD1Database();
    const invalidVersionDb = new MockD1Database();
    const invalidField = await ingestJmaTidePredictionSource({
      ...baseInput(invalidFieldDb),
      fetchImpl: async () => responseFromText(jmaLineWithFirstHourlyField("S3!")),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const rawBody = await ingestJmaTidePredictionSource({
      ...baseInput(rawBodyDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      parseImpl: () => ({
        observations: [],
        errors: [`SECRET_RAW_BODY ${jmaLine()} SECRET_END`],
        warnings: [],
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const nonString = await ingestJmaTidePredictionSource({
      ...baseInput(nonStringDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      parseImpl: () => ({
        observations: [],
        errors: [new Error("SECRET_ERROR_OBJECT"), { secret: "SECRET_OBJECT" }, () => "SECRET_FUNCTION"],
        warnings: [Symbol("SECRET_SYMBOL")],
        sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const invalidVersion = await ingestJmaTidePredictionSource({
      ...baseInput(invalidVersionDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      parseImpl: (text, context) => ({
        ...parseJmaTidePredictionFixedWidth(text, context),
        sourceFormatVersion: ""
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    const invalidFieldJson = JSON.stringify(invalidField);
    expect(invalidFieldJson).not.toContain("S3!");
    expect(invalidFieldJson).toContain("line 1 hour 0");
    expect(invalidFieldJson).toContain("[redacted]");
    expect(JSON.stringify(rawBody)).not.toContain("SECRET_RAW_BODY");
    expect(JSON.stringify(rawBody)).not.toContain(jmaLine());
    expect(JSON.stringify(nonString)).not.toContain("SECRET_ERROR_OBJECT");
    expect(JSON.stringify(nonString)).not.toContain("SECRET_OBJECT");
    expect(JSON.stringify(nonString)).not.toContain("SECRET_SYMBOL");
    expect(nonString.errors).toHaveLength(2);
    expect(nonString.warnings).toHaveLength(1);
    expect(invalidVersion.status).toBe("ok");
    expect(invalidVersion.warnings.map((item) => item.message)).toContain("parser sourceFormatVersion was invalid; default JMA tide prediction source format version was used.");
    expect([...invalidVersionDb.sourceRuns.values()][0].source_format_version).toBe(JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION);
  });

  it("does not write to persistence on input validation failures", async () => {
    const db = new MockD1Database();
    let fetchCalled = false;
    const invalidUrl = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      sourceUrl: "https://user:pass@example.test/secret.txt",
      fetchImpl: async () => {
        fetchCalled = true;
        return responseFromText(jmaLine());
      }
    });
    const unsupportedYear = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      sourceYear: 2027,
      fetchImpl: async () => responseFromText(jmaLine())
    });
    const invalidForecastIssuedAt = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      forecastIssuedAt: "2025-12-30T09:00:00+09:00",
      fetchImpl: async () => responseFromText(jmaLine())
    });

    expect(invalidUrl.errors.map((item) => item.code)).toContain("invalid_input");
    expect(JSON.stringify(invalidUrl)).not.toContain("user:pass");
    expect(unsupportedYear.errors.map((item) => item.code)).toContain("invalid_input");
    expect(invalidForecastIssuedAt.errors.map((item) => item.code)).toContain("invalid_input");
    expect(fetchCalled).toBe(false);
    expect(db.sourceRuns.size).toBe(0);
    expect(db.observations.size).toBe(0);
  });

  it("requires both db.prepare and db.batch before fetch, parser, or persistence execution", async () => {
    let fetchCalled = false;
    let persistenceCalled = false;
    const result = await ingestJmaTidePredictionSource({
      ...baseInput({ prepare: () => ({}) }),
      fetchImpl: async () => {
        fetchCalled = true;
        return responseFromText(jmaLine());
      },
      persistenceImpl: async () => {
        persistenceCalled = true;
        return { ok: true };
      },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.errors.map((item) => item.code)).toContain("invalid_input");
    expect(fetchCalled).toBe(false);
    expect(persistenceCalled).toBe(false);
  });

  it("stops before persistence when now() is invalid or completedAt precedes requestedAt", async () => {
    const invalidNowDb = new MockD1Database();
    const reversedDb = new MockD1Database();
    const invalidNow = await ingestJmaTidePredictionSource({
      ...baseInput(invalidNowDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      now: nowSequence(["not-canonical"])
    });
    const reversed = await ingestJmaTidePredictionSource({
      ...baseInput(reversedDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      now: nowSequence([COMPLETED_AT, REQUESTED_AT])
    });

    expect(invalidNow.errors.map((item) => item.code)).toContain("invalid_input");
    expect(reversed.errors.map((item) => item.code)).toContain("invalid_input");
    expect(invalidNowDb.sourceRuns.size).toBe(0);
    expect(reversedDb.sourceRuns.size).toBe(0);
  });

  it("surfaces structured persistence failures without hiding repository result", async () => {
    const db = new MockD1Database();
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromText(jmaLine()),
      persistenceImpl: async () => ({
        ok: false,
        partial: false,
        sourceRunId: "structured-failure",
        errors: ["repository conflict"],
        warnings: ["repository warning"],
        insertedCount: 0,
        duplicateCount: 0,
        conflictCount: 1
      }),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.status).toBe("ok");
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain("persistence_error");
    expect(result.persistence.ok).toBe(false);
    expect(result.persistence.errors).toContain("repository conflict");
  });

  it("returns structured results when persistence throws and does not leak Error details", async () => {
    const db = new MockD1Database();
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromText(jmaLine()),
      persistenceImpl: async () => {
        throw new Error("SECRET_PERSISTENCE_STACK");
      },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.status).toBe("ok");
    expect(result.ok).toBe(false);
    expect(result.persistence).toBeNull();
    expect(result.errors.map((item) => item.code)).toContain("persistence_error");
    expect(JSON.stringify(result)).not.toContain("SECRET_PERSISTENCE_STACK");
  });

  it("rejects raw hash failures, invalid hash output, and empty run IDs as failed or invalid", async () => {
    const hashThrowDb = new MockD1Database();
    const invalidHashDb = new MockD1Database();
    const runIdDb = new MockD1Database();
    const hashThrow = await ingestJmaTidePredictionSource({
      ...baseInput(hashThrowDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      sha256Impl: async () => { throw new Error("crypto unavailable"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const invalidHash = await ingestJmaTidePredictionSource({
      ...baseInput(invalidHashDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      sha256Impl: async () => "NOT_A_HEX_HASH",
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const emptyRunId = await ingestJmaTidePredictionSource({
      ...baseInput(runIdDb),
      fetchImpl: async () => responseFromText(jmaLine()),
      runIdFactory: () => "",
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(hashThrow.status).toBe("failed");
    expect(hashThrow.rawHash).toBeNull();
    expect(hashThrowDb.sourceRuns.size).toBe(1);
    expect(invalidHash.status).toBe("failed");
    expect(invalidHash.rawHash).toBeNull();
    expect(invalidHashDb.sourceRuns.size).toBe(1);
    expect(emptyRunId.status).toBe("failed");
    expect(emptyRunId.errors.map((item) => item.code)).toContain("invalid_input");
    expect(runIdDb.sourceRuns.size).toBe(0);
  });

  it("returns structured results when runIdFactory throws", async () => {
    const db = new MockD1Database();
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromText(jmaLine()),
      runIdFactory: () => { throw new Error("SECRET_RUN_ID"); },
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });

    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain("invalid_input");
    expect(JSON.stringify(result)).not.toContain("SECRET_RUN_ID");
    expect(db.sourceRuns.size).toBe(0);
    expect(db.observations.size).toBe(0);
  });

  it("does not include raw text, ArrayBuffer, Response, or Error objects in the return contract", async () => {
    const db = new MockD1Database();
    const rawSecret = `SECRET_RAW_PAYLOAD\n${jmaLine()}`;
    const result = await ingestJmaTidePredictionSource({
      ...baseInput(db),
      fetchImpl: async () => responseFromText(rawSecret),
      now: nowSequence([REQUESTED_AT, COMPLETED_AT])
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("SECRET_RAW_PAYLOAD");
    expect(serialized).not.toContain("ArrayBuffer");
    expect(serialized).not.toContain("Response");
    expect(db.sourceRuns.size).toBe(1);
    expect([...db.sourceRuns.values()][0].run_json).not.toContain("SECRET_RAW_PAYLOAD");
  });
});

function baseInput(db) {
  return {
    db,
    sourceUrl: SOURCE_URL,
    sourceYear: SOURCE_YEAR,
    forecastIssuedAt: FORECAST_ISSUED_AT,
    sourceName: "Japan Meteorological Agency tide table",
    attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku."
  };
}

function nowSequence(values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function bytesFromText(text) {
  return new TextEncoder().encode(text);
}

function responseFromText(text, options = {}) {
  return responseFromBytes(bytesFromText(text), options);
}

function responseFromBytes(bytes, { status = 200, ok = status >= 200 && status < 300, onArrayBuffer } = {}) {
  return {
    ok,
    status,
    async arrayBuffer() {
      onArrayBuffer?.();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function fiveStationBody() {
  return ["TK", "CB", "KZ", "QS", "TT"].map((station, index) => jmaLine({ station, startLevel: 100 + index * 10 })).join("\n");
}

function jmaLine({ station = "TK", year = 26, month = 1, day = 1, startLevel = 100 } = {}) {
  const hourly = Array.from({ length: 24 }, (_, hour) => String(startLevel + hour).padStart(3, " ")).join("");
  const date = `${String(year).padStart(2, "0")}${String(month).padStart(2, " ")}${String(day).padStart(2, " ")}`;
  const highTides = ["0130123", "1410134", "9999999", "9999999"].join("");
  const lowTides = ["0720 45", "2000 56", "9999999", "9999999"].join("");
  const line = `${hourly}${date}${station}${highTides}${lowTides}`;
  expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
  return line;
}

function jmaLineWithFirstHourlyField(field) {
  return `${field}${jmaLine().slice(3)}`;
}

class MockD1Database {
  constructor() {
    this.sourceRuns = new Map();
    this.observations = new Map();
    this.statements = [];
  }

  prepare(sql) {
    return new MockD1Statement(this, sql);
  }

  async batch(statements) {
    const sourceRuns = new Map(this.sourceRuns);
    const observations = new Map(this.observations);
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.sourceRuns = sourceRuns;
      this.observations = observations;
      throw error;
    }
  }
}

class MockD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    this.db.statements.push({ sql: this.sql, params });
    return this;
  }

  async first() {
    if (this.sql.includes("FROM hydro_coastal_source_runs")) {
      return this.db.sourceRuns.get(this.params[0]) || null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE version_key IN")) {
      return {
        results: this.params
          .map((versionKey) => this.db.observations.get(versionKey))
          .filter(Boolean)
          .map((row) => ({ version_key: row.version_key, normalized_json: row.normalized_json }))
      };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("INTO hydro_coastal_source_runs")) {
      const row = sourceRunRowFromParams(this.params);
      if (this.db.sourceRuns.has(row.id)) throw new Error("UNIQUE constraint failed: hydro_coastal_source_runs.id");
      this.db.sourceRuns.set(row.id, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INTO hydro_coastal_observations")) {
      let changes = 0;
      for (let index = 0; index < this.params.length; index += 16) {
        const row = observationRowFromParams(this.params.slice(index, index + 16));
        if (this.db.observations.has(row.version_key)) throw new Error("UNIQUE constraint failed: hydro_coastal_observations.version_key");
        this.db.observations.set(row.version_key, row);
        changes += 1;
      }
      return { meta: { changes } };
    }
    return { meta: { changes: 0 } };
  }
}

function sourceRunRowFromParams(params) {
  const [
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json
  ] = params;
  return {
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function observationRowFromParams(params) {
  const [
    version_key,
    identity_key,
    source_run_id,
    provider_id,
    station_id,
    metric,
    observed_at,
    collected_at,
    forecast_issued_at,
    value,
    unit,
    status,
    provisional,
    vertical_datum_json,
    normalized_schema_version,
    normalized_json
  ] = params;
  return {
    id: 1,
    version_key,
    identity_key,
    source_run_id,
    provider_id,
    station_id,
    metric,
    observed_at,
    collected_at,
    forecast_issued_at,
    value,
    unit,
    status,
    provisional,
    vertical_datum_json,
    normalized_schema_version,
    normalized_json,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}
