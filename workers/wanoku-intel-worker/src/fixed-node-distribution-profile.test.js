import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  assertReadOnlySelect,
  buildDataQualityProfile,
  buildFacilitySpeciesProfile,
  buildFixedNodeDistributionProfile,
  buildRollingBaselineProfile,
  buildVisitorProfile,
  captureFixedNodeProfileSnapshot,
  catchRate100,
  isValidIntensityRow,
  logOnePlus,
  medianAbsoluteDeviation,
  normalizeSourceRow,
  parseCliArgs,
  parseWranglerD1JsonOutput,
  quantile,
  sha256Hex
} from "../../../scripts/wanoku-fixed-node-distribution-profile.mjs";

function rawRow(overrides = {}) {
  return {
    report_id: "wanoku-fixed-report:default",
    identity_key: "identity:default",
    facility_id: "facility-a",
    observation_date: "2026-01-01",
    collected_at: "2026-01-01T12:00:00.000Z",
    visitor_count: 200,
    operating_status: "operating",
    report_completeness: "complete",
    species_id: "japanese-seabass",
    catch_count: 4,
    presence_state: "present",
    completeness: "complete",
    alias_coverage: "sufficient",
    ...overrides
  };
}

function fullBundle(facilityId, observationDate, { operatingStatus = "operating", reportCompleteness = "complete", speciesOverrides = {} } = {}) {
  const species = ["japanese-seabass", "sardine", "sappa", "konoshiro", "aji", "saba", "bora", "haze"];
  return species.map((speciesId) => rawRow({
    report_id: `wanoku-fixed-report:${facilityId}:${observationDate}`,
    identity_key: `identity:${facilityId}:${observationDate}`,
    facility_id: facilityId,
    observation_date: observationDate,
    operating_status: operatingStatus,
    report_completeness: reportCompleteness,
    species_id: speciesId,
    catch_count: reportCompleteness === "complete" && operatingStatus === "operating" ? 1 : null,
    presence_state: reportCompleteness === "complete" && operatingStatus === "operating" ? "present" : "unknown",
    completeness: reportCompleteness,
    alias_coverage: reportCompleteness === "complete" ? "sufficient" : "unknown",
    ...(speciesOverrides[speciesId] ?? {})
  }));
}

describe("Fixed-Node Distribution Profile v1 — primitives", () => {
  it("computes catchRate100 as catchCount/visitorCount*100", () => {
    expect(catchRate100(6, 200)).toBe(3);
    expect(catchRate100(0, 100)).toBe(0);
  });

  it("computes log1p transform via Math.log1p", () => {
    expect(logOnePlus(0)).toBe(0);
    expect(logOnePlus(catchRate100(6, 200))).toBeCloseTo(Math.log1p(3), 12);
  });

  it("computes a deterministic linear-interpolation quantile (R-7)", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(sorted, 0.25)).toBe(3.25);
    expect(quantile(sorted, 0.5)).toBe(5.5);
    expect(quantile(sorted, 0)).toBe(1);
    expect(quantile(sorted, 1)).toBe(10);
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([42], 0.9)).toBe(42);
  });

  it("computes median absolute deviation", () => {
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
    expect(medianAbsoluteDeviation([5, 5, 5, 5])).toBe(0);
    expect(medianAbsoluteDeviation([])).toBeNull();
  });

  it("shifts ISO calendar dates deterministically", () => {
    expect(addDaysIso("2026-03-01", -56)).toBe("2026-01-04");
    expect(addDaysIso("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysIso("2026-01-01", 0)).toBe("2026-01-01");
  });
});

describe("Fixed-Node Distribution Profile v1 — valid intensity rule (case 1 & 2)", () => {
  it("requires all six conditions to treat a species/day as valid intensity", () => {
    const valid = normalizeSourceRow(rawRow());
    expect(isValidIntensityRow(valid)).toBe(true);

    const brokenByEachField = [
      rawRow({ operating_status: "closed" }),
      rawRow({ report_completeness: "incomplete" }),
      rawRow({ completeness: "incomplete" }),
      rawRow({ alias_coverage: "insufficient" }),
      rawRow({ catch_count: null, presence_state: "unknown" }),
      rawRow({ visitor_count: null }),
      rawRow({ visitor_count: 0 })
    ];
    for (const broken of brokenByEachField) {
      expect(isValidIntensityRow(normalizeSourceRow(broken))).toBe(false);
    }
  });

  it("never converts an invalid/unknown row into a zero intensity observation", () => {
    const rows = [
      rawRow({ operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" }),
      rawRow({ report_completeness: "incomplete", catch_count: null, presence_state: "unknown", completeness: "incomplete", alias_coverage: "insufficient" }),
      rawRow({ catch_count: 0, presence_state: "absent" })
    ];
    const [profile] = buildFacilitySpeciesProfile(rows.map(normalizeSourceRow));
    expect(profile.coverage.reportDays).toBe(3);
    expect(profile.coverage.validIntensityDays).toBe(1);
    expect(profile.coverage.zeroDays).toBe(1);
    expect(profile.coverage.unknownPresenceDays).toBe(2);
    expect(profile.catchRate100.n).toBe(1);
  });
});

describe("Fixed-Node Distribution Profile v1 — rolling baseline t-56..t-8 (cases 7, 8, 9, 10)", () => {
  it("includes the t-56 and t-8 boundary dates and excludes t-57 and the t-7..t exclusion window", () => {
    const anchor = "2026-01-01"; // the single valid observation date
    const rows = [
      rawRow({ facility_id: "boundary-facility", species_id: "sardine", observation_date: anchor }),
      rawRow({ facility_id: "boundary-facility", species_id: "sardine", observation_date: addDaysIso(anchor, 8), operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" }),
      rawRow({ facility_id: "boundary-facility", species_id: "sardine", observation_date: addDaysIso(anchor, 7), operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" }),
      rawRow({ facility_id: "boundary-facility", species_id: "sardine", observation_date: addDaysIso(anchor, 56), operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" }),
      rawRow({ facility_id: "boundary-facility", species_id: "sardine", observation_date: addDaysIso(anchor, 57), operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" })
    ];
    const [entry] = buildRollingBaselineProfile(rows.map(normalizeSourceRow), { minBaselineN: 1 });
    expect(entry.candidateTargetDates).toBe(5);
    // target = anchor+8 -> window upper bound = anchor (inclusive) -> baselineN 1
    // target = anchor+56 -> window lower bound = anchor (inclusive) -> baselineN 1
    // target = anchor+7 -> window upper bound = anchor-1, excludes anchor -> baselineN 0
    // target = anchor+57 -> window lower bound = anchor+1, excludes anchor -> baselineN 0
    expect(entry.baselineN.max).toBe(1);
    expect(entry.baselineN.min).toBe(0);
    expect(entry.baselineWindowsWithNAtLeast21).toBe(2);
  });

  it("requires n >= 21 in the baseline window to be eligible (default candidate rule)", () => {
    const rowsFor = (facilityId, count) => {
      const targetDate = "2026-06-01";
      const rows = [rawRow({ facility_id: facilityId, species_id: "sardine", observation_date: targetDate, operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" })];
      for (let offset = 8; offset < 8 + count; offset += 1) {
        rows.push(rawRow({
          facility_id: facilityId,
          species_id: "sardine",
          observation_date: addDaysIso(targetDate, -offset),
          catch_count: 3,
          visitor_count: 150
        }));
      }
      return rows;
    };
    const twentyOne = buildRollingBaselineProfile(rowsFor("facility-21", 21).map(normalizeSourceRow));
    const twenty = buildRollingBaselineProfile(rowsFor("facility-20", 20).map(normalizeSourceRow));
    expect(twentyOne[0].baselineWindowsWithNAtLeast21).toBe(1);
    expect(twenty[0].baselineWindowsWithNAtLeast21).toBe(0);
  });

  it("counts zero-MAD eligible windows separately from nonzero-MAD windows", () => {
    const buildConstantWindow = (facilityId) => {
      const targetDate = "2026-06-01";
      const rows = [rawRow({ facility_id: facilityId, species_id: "sardine", observation_date: targetDate, operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" })];
      for (let offset = 8; offset < 29; offset += 1) {
        rows.push(rawRow({ facility_id: facilityId, species_id: "sardine", observation_date: addDaysIso(targetDate, -offset), catch_count: 3, visitor_count: 150 }));
      }
      return rows;
    };
    const buildVariedWindow = (facilityId) => {
      const targetDate = "2026-06-01";
      const rows = [rawRow({ facility_id: facilityId, species_id: "sardine", observation_date: targetDate, operating_status: "closed", catch_count: null, presence_state: "unknown", completeness: "unknown", alias_coverage: "unknown" })];
      let offset = 8;
      for (let catchCount = 1; catchCount <= 21; catchCount += 1, offset += 1) {
        rows.push(rawRow({ facility_id: facilityId, species_id: "sardine", observation_date: addDaysIso(targetDate, -offset), catch_count: catchCount, visitor_count: 150 }));
      }
      return rows;
    };
    const constant = buildRollingBaselineProfile(buildConstantWindow("facility-zero-mad").map(normalizeSourceRow));
    const varied = buildRollingBaselineProfile(buildVariedWindow("facility-nonzero-mad").map(normalizeSourceRow));
    expect(constant[0].eligible.zeroMadWindowCount).toBe(1);
    expect(constant[0].eligible.zeroMadWindowRate).toBe(1);
    expect(varied[0].eligible.zeroMadWindowCount).toBe(0);
    expect(varied[0].eligible.zeroMadWindowRate).toBe(0);
    expect(varied[0].eligible.lowNonZeroMadQuantiles.n).toBe(1);
    expect(varied[0].eligible.lowNonZeroMadQuantiles.p05).toBeGreaterThan(0);
  });
});

describe("Fixed-Node Distribution Profile v1 — visitor distribution (case 11)", () => {
  it("computes p33 and p67 with the same deterministic quantile definition", () => {
    const visitorCounts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const rows = visitorCounts.map((visitorCount, index) => rawRow({
      report_id: `report-${index}`,
      identity_key: `identity-${index}`,
      observation_date: addDaysIso("2026-01-01", index),
      visitor_count: visitorCount
    }));
    const [entry] = buildVisitorProfile(rows.map(normalizeSourceRow));
    expect(entry.visitorCount.n).toBe(10);
    expect(entry.visitorCount.p33).toBe(40);
    expect(entry.visitorCount.p67).toBe(70);
    expect(entry.visitorCount.median).toBe(55);
  });

  it("counts null and zero visitor report-days separately from the positive distribution", () => {
    const rows = [
      rawRow({ report_id: "r1", identity_key: "i1", observation_date: "2026-01-01", visitor_count: null }),
      rawRow({ report_id: "r2", identity_key: "i2", observation_date: "2026-01-02", visitor_count: 0 }),
      rawRow({ report_id: "r3", identity_key: "i3", observation_date: "2026-01-03", visitor_count: 50 })
    ];
    const [entry] = buildVisitorProfile(rows.map(normalizeSourceRow));
    expect(entry.visitorCountNullDays).toBe(1);
    expect(entry.visitorCountZeroDays).toBe(1);
    expect(entry.visitorCount.n).toBe(1);
  });
});

describe("Fixed-Node Distribution Profile v1 — deterministic ordering (case 12)", () => {
  it("orders facilitySpecies and rollingBaseline by facilityId then speciesId, and visitor by facilityId", () => {
    const rows = [
      rawRow({ report_id: "report-zeta", identity_key: "identity-zeta", facility_id: "zeta", species_id: "sardine" }),
      rawRow({ report_id: "report-alpha", identity_key: "identity-alpha", facility_id: "alpha", species_id: "sappa" }),
      rawRow({ report_id: "report-alpha", identity_key: "identity-alpha", facility_id: "alpha", species_id: "aji" })
    ];
    const normalized = rows.map(normalizeSourceRow);
    expect(buildFacilitySpeciesProfile(normalized).map((entry) => `${entry.facilityId}/${entry.speciesId}`)).toEqual([
      "alpha/aji", "alpha/sappa", "zeta/sardine"
    ]);
    expect(buildRollingBaselineProfile(normalized).map((entry) => `${entry.facilityId}/${entry.speciesId}`)).toEqual([
      "alpha/aji", "alpha/sappa", "zeta/sardine"
    ]);
    expect(buildVisitorProfile(normalized).map((entry) => entry.facilityId)).toEqual(["alpha", "zeta"]);
  });
});

describe("Fixed-Node Distribution Profile v1 — data quality (cases 13 & 14)", () => {
  it("detects duplicate facility/date/species rows and stops before statistical profiling", () => {
    const day = fullBundle("facility-a", "2026-01-01");
    const rows = [...day, day[0]]; // duplicate the first species row
    const quality = buildDataQualityProfile(rows.map(normalizeSourceRow));
    expect(quality.duplicateFacilityDateSpeciesRows).toBe(1);
    expect(quality.ok).toBe(false);

    const full = buildFixedNodeDistributionProfile(rows);
    expect(full.validated).toBe(false);
    expect(full.stoppedBeforeStatisticalProfiling).toBe(true);
    expect(full.facilitySpecies).toBeUndefined();
  });

  it("detects report-days that do not carry exactly 8 species rows", () => {
    const day = fullBundle("facility-a", "2026-01-01");
    const incomplete = day.slice(0, 7); // drop one species row
    const quality = buildDataQualityProfile(incomplete.map(normalizeSourceRow));
    expect(quality.reportDaysWithSpeciesCountNot8).toBe(1);
    expect(quality.ok).toBe(false);
  });

  it("passes validation for a clean 8-species bundle and matches expected counts", () => {
    const day1 = fullBundle("facility-a", "2026-01-01");
    const day2 = fullBundle("facility-a", "2026-01-02");
    const quality = buildDataQualityProfile([...day1, ...day2].map(normalizeSourceRow), {
      expectedJoinedRowCount: 16,
      expectedReportCount: 2
    });
    expect(quality.ok).toBe(true);
    expect(quality.reportDaysWithSpeciesCountNot8).toBe(0);
    expect(quality.duplicateFacilityDateSpeciesRows).toBe(0);
  });

  it("runs the full pipeline end-to-end for clean, complete 8-species bundles", () => {
    const day1 = fullBundle("facility-a", "2026-01-01");
    const day2 = fullBundle("facility-a", "2026-01-02");
    const full = buildFixedNodeDistributionProfile([...day1, ...day2], {
      expectedJoinedRowCount: 16,
      expectedReportCount: 2
    });
    expect(full.validated).toBe(true);
    expect(full.stoppedBeforeStatisticalProfiling).toBe(false);
    expect(full.facilitySpecies).toHaveLength(8);
    expect(full.visitor).toHaveLength(1);
    expect(full.rollingBaseline).toHaveLength(8);
    expect(full.seabassCoreBaitSummary).toHaveLength(1);
    expect(full.seabassCoreBaitSummary[0].narrative).toContain("facility-a");
  });

  it("flags negative catch/visitor counts and presence/catch-count mismatches", () => {
    const rows = [
      rawRow({ catch_count: -1 }),
      rawRow({ visitor_count: -5 }),
      rawRow({ presence_state: "absent", catch_count: 3 }),
      rawRow({ presence_state: "present", catch_count: 0 })
    ];
    const quality = buildDataQualityProfile(rows.map(normalizeSourceRow));
    expect(quality.negativeCatchCountRows).toBe(1);
    expect(quality.negativeVisitorCountRows).toBe(1);
    expect(quality.absentRowsWithNonzeroCatch).toBe(1);
    expect(quality.presentRowsWithZeroCatch).toBe(1);
  });
});

describe("Fixed-Node Distribution Profile v1 — CLI and capture plumbing (no network)", () => {
  it("parses capture and profile subcommands", () => {
    expect(parseCliArgs(["capture", "--output-dir", ".tmp/x"])).toMatchObject({ subcommand: "capture", outputDir: ".tmp/x" });
    expect(parseCliArgs(["profile", "--input", "a.json"])).toMatchObject({ subcommand: "profile", input: "a.json" });
    expect(() => parseCliArgs(["bogus"])).toThrow();
  });

  it("rejects non-SELECT or write-bearing SQL", () => {
    expect(assertReadOnlySelect("SELECT 1")).toBe("SELECT 1");
    expect(() => assertReadOnlySelect("DELETE FROM x")).toThrow();
    expect(() => assertReadOnlySelect("UPDATE x SET y = 1")).toThrow();
  });

  it("parses the verified wrangler --json envelope shape and rejects unexpected shapes", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(parseWranglerD1JsonOutput(JSON.stringify([{ results: rows, success: true, meta: {} }]))).toEqual(rows);
    expect(() => parseWranglerD1JsonOutput("not json")).toThrow();
    expect(() => parseWranglerD1JsonOutput(JSON.stringify({ results: [] }))).toThrow();
    expect(() => parseWranglerD1JsonOutput(JSON.stringify([{ success: false, results: [] }]))).toThrow();
  });

  it("computes a stable sha256 for identical row JSON", () => {
    const hashA = sha256Hex(JSON.stringify([{ a: 1 }]));
    const hashB = sha256Hex(JSON.stringify([{ a: 1 }]));
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retries exactly once on a transient Cloudflare error code, then succeeds", async () => {
    let calls = 0;
    const execImpl = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("boom");
        error.stderr = "Error 7403: temporary failure";
        throw error;
      }
      return JSON.stringify([{ results: [{ a: 1 }], success: true, meta: {} }]);
    };
    const snapshot = await captureFixedNodeProfileSnapshot({ execImpl, capturedAt: "2026-08-19T00:00:00.000Z" });
    expect(calls).toBe(2);
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.rowsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops after a single retry and surfaces the error", async () => {
    let calls = 0;
    const execImpl = async () => {
      calls += 1;
      const error = new Error("boom");
      error.stderr = "Error 10000: still failing";
      throw error;
    };
    await expect(captureFixedNodeProfileSnapshot({ execImpl })).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    const execImpl = async () => {
      calls += 1;
      throw new Error("permanent failure");
    };
    await expect(captureFixedNodeProfileSnapshot({ execImpl })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
