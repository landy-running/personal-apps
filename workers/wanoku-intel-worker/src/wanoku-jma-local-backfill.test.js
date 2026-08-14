import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hydroCoastalObservationIdentityKey,
  hydroCoastalObservationVersionKey
} from "../../../packages/wanoku-core/src/hydro-coastal.ts";
import { JMA_TIDE_PREDICTION_LINE_LENGTH } from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import {
  generateJmaLocalBackfillSql,
  parseMonthsSpec,
  runLocalBackfill
} from "../../../scripts/wanoku-jma-local-backfill.mjs";

const ACQUISITION_AT = "2026-08-14T02:20:19.400Z";
const KZ_LAST_MODIFIED = "Fri, 21 Feb 2025 06:21:31 GMT";
const KZ_FORECAST_ISSUED_AT = "2025-02-21T06:21:31.000Z";

describe("Wanoku JMA local backfill SQL generator", () => {
  it("generates KZ months 2-12 without January observations", async () => {
    const result = await generateJmaLocalBackfillSql({
      station: "KZ",
      sourceYear: 2026,
      months: parseMonthsSpec("2-12"),
      acquisitionAt: ACQUISITION_AT,
      lastModifiedHeader: KZ_LAST_MODIFIED,
      sourceText: annualStationBody("KZ")
    });

    expect(result.summary.observationCount).toBe(8016);
    expect(result.summary.sourceRunCount).toBe(1);
    expect(result.summary.months).toBe("02-12");
    expect(result.summary.forecastIssuedAt).toBe(KZ_FORECAST_ISSUED_AT);
    expect(result.sourceRun.id).toContain("local-backfill");
    expect(result.sourceRun.id).toContain("KZ");
    expect(result.observations.every((observation) => observation.stationId === "KZ")).toBe(true);
    expect(result.observations.every((observation) => observation.forecastIssuedAt === KZ_FORECAST_ISSUED_AT)).toBe(true);
    expect(result.observations.every((observation) => observation.collectedAt === ACQUISITION_AT)).toBe(true);
    expect(result.observations.every((observation) => observation.provenance.normalizedAt === ACQUISITION_AT)).toBe(true);
    expect(result.observations.some((observation) => observation.provenance.sourceTimestamp.startsWith("2026-01-"))).toBe(false);
    expect(result.observations.every((observation) => !observation.provenance.sourceTimestamp.startsWith("2026-01-"))).toBe(true);
  });

  it("generates complete annual QS and TT imports", async () => {
    for (const station of ["QS", "TT"]) {
      const result = await generateJmaLocalBackfillSql({
        station,
        sourceYear: 2026,
        months: parseMonthsSpec("1-12"),
        acquisitionAt: ACQUISITION_AT,
        lastModifiedHeader: KZ_LAST_MODIFIED,
        sourceText: annualStationBody(station)
      });

      expect(result.summary.observationCount).toBe(8760);
      expect(result.observations).toHaveLength(8760);
      expect(result.observations.every((observation) => observation.stationId === station)).toBe(true);
    }
  });

  it("rejects invalid and duplicate months", () => {
    for (const value of ["", "0", "13", "1.5", "2-1", "1,1", "1-3,3"]) {
      expect(() => parseMonthsSpec(value)).toThrow();
    }
  });

  it("fails before writing output when expectedRawHash mismatches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wanoku-jma-hash-"));
    const output = path.join(dir, "out.sql");
    try {
      await expect(runLocalBackfill({
        station: "KZ",
        sourceYear: 2026,
        months: parseMonthsSpec("2-12"),
        acquisitionAt: ACQUISITION_AT,
        expectedRawHash: "0".repeat(64),
        output,
        lastModifiedHeader: KZ_LAST_MODIFIED,
        sourceText: annualStationBody("KZ")
      })).rejects.toMatchObject({ code: "raw_hash_mismatch" });
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails before writing output when the parser rejects a requested month", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wanoku-jma-parser-"));
    const output = path.join(dir, "out.sql");
    const lines = annualStationBody("KZ").split("\n");
    lines[31] = `S3!${lines[31].slice(3)}`;
    try {
      await expect(runLocalBackfill({
        station: "KZ",
        sourceYear: 2026,
        months: parseMonthsSpec("2"),
        acquisitionAt: ACQUISITION_AT,
        output,
        lastModifiedHeader: KZ_LAST_MODIFIED,
        sourceText: lines.join("\n")
      })).rejects.toMatchObject({ code: "parse_failed" });
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the existing hydro coastal identity and version semantics", async () => {
    const result = await generateJmaLocalBackfillSql({
      station: "KZ",
      sourceYear: 2026,
      months: parseMonthsSpec("2"),
      acquisitionAt: ACQUISITION_AT,
      lastModifiedHeader: KZ_LAST_MODIFIED,
      sourceText: annualStationBody("KZ")
    });

    const row = result.observationRows[0];
    const observation = result.observations[0];
    expect(observation.forecastIssuedAt).toBe(KZ_FORECAST_ISSUED_AT);
    expect(row.identity_key).toBe(hydroCoastalObservationIdentityKey(observation));
    expect(row.version_key).toBe(hydroCoastalObservationVersionKey(observation));
    expect(row.identity_key.split("|")).toHaveLength(5);
    expect(row.version_key.split("|")).toHaveLength(6);
    expect(row.identity_key).not.toContain("sourceMonth");
    expect(row.identity_key).not.toContain("local-backfill");
    expect(row.version_key).not.toContain("sourceMonth");
    expect(row.version_key).not.toContain("local-backfill");
  });

  it("generates safe chunked plain INSERT SQL", async () => {
    const result = await generateJmaLocalBackfillSql({
      station: "QS",
      sourceYear: 2026,
      months: parseMonthsSpec("1-12"),
      acquisitionAt: ACQUISITION_AT,
      lastModifiedHeader: KZ_LAST_MODIFIED,
      sourceText: annualStationBody("QS")
    });

    expect(result.sql).toContain("INSERT INTO hydro_coastal_source_runs");
    expect(result.sql).toContain("INSERT INTO hydro_coastal_observations");
    expect(result.sql).not.toMatch(/\bBEGIN\b/i);
    expect(result.sql).not.toMatch(/\bCOMMIT\b/i);
    expect(result.sql).not.toMatch(/\bINSERT\s+OR\s+IGNORE\b/i);
    expect(result.sql).not.toMatch(/\bINSERT\s+OR\s+REPLACE\b/i);
    expect(result.sql).not.toMatch(/\bUPDATE\b/i);
    expect(result.sql).not.toMatch(/\bDELETE\b/i);
    expect(result.sql).not.toMatch(/\bDROP\b/i);
    expect(result.statements.every((statement) => new TextEncoder().encode(statement).byteLength < 90_000)).toBe(true);
  });

  it("produces deterministic SQL for deterministic input", async () => {
    const input = {
      station: "TT",
      sourceYear: 2026,
      months: parseMonthsSpec("1-2"),
      acquisitionAt: ACQUISITION_AT,
      lastModifiedHeader: KZ_LAST_MODIFIED,
      sourceText: annualStationBody("TT")
    };
    const first = await generateJmaLocalBackfillSql(input);
    const second = await generateJmaLocalBackfillSql(input);

    expect(second.sql).toBe(first.sql);
    expect(second.summary).toEqual(first.summary);
  });
});

function annualStationBody(station) {
  return Array.from({ length: 365 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index));
    return jmaLine({
      station,
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      startLevel: 50 + (index % 60)
    });
  }).join("\n");
}

function jmaLine({ station, year = 26, month, day, startLevel }) {
  const hourly = Array.from({ length: 24 }, (_, hour) => String(startLevel + hour).padStart(3, " ")).join("");
  const date = `${String(year).padStart(2, "0")}${String(month).padStart(2, " ")}${String(day).padStart(2, " ")}`;
  const highTides = ["0130123", "1410134", "9999999", "9999999"].join("");
  const lowTides = ["0720 45", "2000 56", "9999999", "9999999"].join("");
  const line = `${hourly}${date}${station}${highTides}${lowTides}`;
  expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
  return line;
}
