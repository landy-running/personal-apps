import { describe, expect, it } from "vitest";
import {
  REQUIRED_SPECIES_IDS,
  WEST_FACILITY_IDS,
  addDaysIso,
  aggregateWestFacilityValues,
  catchRate100,
  classifyAnomalyState,
  computeCoreBaitSignal,
  computeDetectionConfidence,
  computeFacilityDaySignal,
  computeRobustAnomaly,
  computeWestSignal,
  isValidIntensityRow,
  logOnePlus,
  normalizeSignalSourceRow,
  selectAsOfRows
} from "../../../scripts/wanoku-fixed-node-signal.mjs";

const FACILITY_ID = "yokohama-honmoku";
const KNOWLEDGE_AT = "2026-08-19T00:00:00.000Z";

function rawRow(overrides = {}) {
  return {
    report_id: "wanoku-fixed-report:default",
    version_key: "wanoku-fixed-report:default|v1",
    identity_key: "identity:default",
    facility_id: FACILITY_ID,
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

function singleSpeciesCatchCounts(speciesId, catchCount, fallback = 1) {
  const counts = {};
  for (const id of REQUIRED_SPECIES_IDS) counts[id] = id === speciesId ? catchCount : fallback;
  return counts;
}

function fullDay(facilityId, date, {
  catchCounts = {},
  visitorCount = 200,
  operatingStatus = "operating",
  reportCompleteness = "complete",
  collectedAt,
  reportIdSuffix = "r1"
} = {}) {
  const operational = operatingStatus === "operating" && reportCompleteness === "complete";
  const reportId = `wanoku-fixed-report:${facilityId}:${date}:${reportIdSuffix}`;
  const identityKey = `identity:${facilityId}:${date}`;
  const versionKey = `${reportId}|v1`;
  const collected = collectedAt ?? `${date}T12:00:00.000Z`;
  return REQUIRED_SPECIES_IDS.map((speciesId) => rawRow({
    report_id: reportId,
    version_key: versionKey,
    identity_key: identityKey,
    facility_id: facilityId,
    observation_date: date,
    collected_at: collected,
    visitor_count: operational ? visitorCount : null,
    operating_status: operatingStatus,
    report_completeness: reportCompleteness,
    species_id: speciesId,
    catch_count: operational ? (catchCounts[speciesId] ?? 1) : null,
    presence_state: operational ? "present" : "unknown",
    completeness: reportCompleteness,
    alias_coverage: reportCompleteness === "complete" ? "sufficient" : "unknown"
  }));
}

function buildBaselineFullDays(facilityId, targetDate, speciesId, count, catchCount = 3) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const date = addDaysIso(targetDate, -(8 + i));
    rows.push(...fullDay(facilityId, date, { catchCounts: singleSpeciesCatchCounts(speciesId, catchCount) }));
  }
  return rows;
}

describe("Fixed-Node Signal v1 — valid intensity (case 1 & 2)", () => {
  it("case1: a fully valid row has valid normalized intensity", () => {
    const row = normalizeSignalSourceRow(rawRow());
    expect(isValidIntensityRow(row)).toBe(true);
  });

  it("case2: an invalid/unknown observation remains unknown, never a zero intensity", () => {
    const targetDate = "2026-06-01";
    const rows = [
      ...buildBaselineFullDays(FACILITY_ID, targetDate, "sardine", 21, 3),
      ...fullDay(FACILITY_ID, targetDate, { operatingStatus: "closed", reportCompleteness: "unknown" })
    ];
    const result = computeFacilityDaySignal(rows, { facilityId: FACILITY_ID, targetDate, knowledgeAt: KNOWLEDGE_AT });
    expect(result.species.sardine.intensity.valid).toBe(false);
    expect(result.species.sardine.intensity.x).toBeNull();
    expect(result.species.sardine.intensity.catchCount).toBeNull();
    expect(result.species.sardine.presenceState).toBe("unknown");
    expect(result.species.sardine.anomaly.available).toBe(false);
    expect(result.species.sardine.anomaly.reason).toBe("current_observation_invalid");
    expect(result.species.sardine.anomaly.state).toBe("UNKNOWN");
  });

  it("bonus: a zero catch count is a valid observed intensity, not proof of absence", () => {
    const row = normalizeSignalSourceRow(rawRow({ catch_count: 0, presence_state: "absent" }));
    expect(isValidIntensityRow(row)).toBe(true);
    expect(logOnePlus(catchRate100(row.catchCount, row.visitorCount))).toBe(0);
  });
});

describe("Fixed-Node Signal v1 — normalization primitives (case 3 & 4)", () => {
  it("case3: catchRate100 = catchCount / visitorCount * 100", () => {
    expect(catchRate100(6, 200)).toBe(3);
    expect(catchRate100(0, 100)).toBe(0);
  });

  it("case4: x = log1p(catchRate100)", () => {
    expect(logOnePlus(0)).toBe(0);
    expect(logOnePlus(catchRate100(6, 200))).toBeCloseTo(Math.log1p(3), 12);
  });
});

describe("Fixed-Node Signal v1 — baseline window t-56..t-8 (case 5, 6, 7, 8)", () => {
  it("case5&6: includes t-56 and t-8 exactly, excludes t-7..t and t-57", () => {
    const targetDate = "2026-06-01";
    const rows = [
      ...fullDay(FACILITY_ID, targetDate, { catchCounts: singleSpeciesCatchCounts("sardine", 5) }),
      ...fullDay(FACILITY_ID, addDaysIso(targetDate, -8), { catchCounts: singleSpeciesCatchCounts("sardine", 2), reportIdSuffix: "t8" }),
      ...fullDay(FACILITY_ID, addDaysIso(targetDate, -56), { catchCounts: singleSpeciesCatchCounts("sardine", 3), reportIdSuffix: "t56" }),
      ...fullDay(FACILITY_ID, addDaysIso(targetDate, -7), { catchCounts: singleSpeciesCatchCounts("sardine", 9), reportIdSuffix: "t7" }),
      ...fullDay(FACILITY_ID, addDaysIso(targetDate, -57), { catchCounts: singleSpeciesCatchCounts("sardine", 9), reportIdSuffix: "t57" })
    ];
    const result = computeFacilityDaySignal(rows, {
      facilityId: FACILITY_ID,
      targetDate,
      knowledgeAt: KNOWLEDGE_AT,
      config: { minBaselineN: 1 }
    });
    expect(result.species.sardine.anomaly.baselineN).toBe(2);
    expect(result.species.sardine.anomaly.baselineStart).toBe(addDaysIso(targetDate, -56));
    expect(result.species.sardine.anomaly.baselineEnd).toBe(addDaysIso(targetDate, -8));
  });

  it("case7: baseline N=20 is unavailable", () => {
    const targetDate = "2026-06-01";
    const rows = buildBaselineFullDays(FACILITY_ID, targetDate, "sardine", 20);
    const result = computeFacilityDaySignal(rows, { facilityId: FACILITY_ID, targetDate, knowledgeAt: KNOWLEDGE_AT });
    expect(result.species.sardine.anomaly.baselineN).toBe(20);
    expect(result.species.sardine.anomaly.available).toBe(false);
    expect(result.species.sardine.anomaly.reason).toBe("baseline_insufficient");
    expect(result.species.sardine.anomaly.state).toBe("UNAVAILABLE");
  });

  it("case8: baseline N=21 is available", () => {
    const targetDate = "2026-06-01";
    const rows = [
      ...fullDay(FACILITY_ID, targetDate, { catchCounts: singleSpeciesCatchCounts("sardine", 4) }),
      ...buildBaselineFullDays(FACILITY_ID, targetDate, "sardine", 21, 3)
    ];
    const result = computeFacilityDaySignal(rows, { facilityId: FACILITY_ID, targetDate, knowledgeAt: KNOWLEDGE_AT });
    expect(result.species.sardine.anomaly.baselineN).toBe(21);
    expect(result.species.sardine.anomaly.available).toBe(true);
  });
});

describe("Fixed-Node Signal v1 — robust standardization (case 9, 10, 11, 12, 13)", () => {
  it("case9: computes MAD-based provenance", () => {
    const result = computeRobustAnomaly(
      { targetDate: "2026-06-01", currentValid: true, currentX: 3.5, baselineXs: [1, 2, 3, 4, 5] },
      { minBaselineN: 5 }
    );
    expect(result.baselineMedian).toBe(3);
    expect(result.rawMad).toBe(1);
    expect(result.robustScale).toBeCloseTo(1.4826, 10);
  });

  it("case10: scale floor applied when baseline MAD is zero (Isogo sardine zero-MAD style)", () => {
    const result = computeRobustAnomaly(
      { targetDate: "2026-06-01", currentValid: true, currentX: 2, baselineXs: [1, 1, 1, 1, 1] },
      { minBaselineN: 5 }
    );
    expect(result.rawMad).toBe(0);
    expect(result.robustScale).toBe(0);
    expect(result.scaleFloorApplied).toBe(true);
    expect(result.effectiveScale).toBe(0.25);
  });

  it("case11: scale floor is not applied when robustScale exceeds the floor", () => {
    const result = computeRobustAnomaly(
      { targetDate: "2026-06-01", currentValid: true, currentX: 2, baselineXs: [0, 1, 2, 3, 4] },
      { minBaselineN: 5 }
    );
    expect(result.robustScale).toBeGreaterThan(0.25);
    expect(result.scaleFloorApplied).toBe(false);
    expect(result.effectiveScale).toBe(result.robustScale);
  });

  it("case12: zRaw = (currentX - center) / effectiveScale", () => {
    const result = computeRobustAnomaly(
      { targetDate: "2026-06-01", currentValid: true, currentX: 1.5, baselineXs: [1, 1, 1, 1, 1] },
      { minBaselineN: 5 }
    );
    expect(result.zRaw).toBeCloseTo((1.5 - 1) / 0.25, 10);
    expect(result.z).toBeCloseTo(2, 10);
  });

  it("case13: z is clamped to [-4, 4]", () => {
    const baselineXs = [1, 1, 1, 1, 1];
    const high = computeRobustAnomaly({ targetDate: "2026-06-01", currentValid: true, currentX: 100, baselineXs }, { minBaselineN: 5 });
    const low = computeRobustAnomaly({ targetDate: "2026-06-01", currentValid: true, currentX: -100, baselineXs }, { minBaselineN: 5 });
    expect(high.zRaw).toBeGreaterThan(4);
    expect(high.z).toBe(4);
    expect(low.zRaw).toBeLessThan(-4);
    expect(low.z).toBe(-4);
  });
});

describe("Fixed-Node Signal v1 — state thresholds (case 14)", () => {
  it("classifies exact state boundaries", () => {
    expect(classifyAnomalyState(4)).toBe("STRONG_POSITIVE");
    expect(classifyAnomalyState(1.5)).toBe("STRONG_POSITIVE");
    expect(classifyAnomalyState(1.4999999999)).toBe("POSITIVE");
    expect(classifyAnomalyState(0.5)).toBe("POSITIVE");
    expect(classifyAnomalyState(0.4999999999)).toBe("NEUTRAL");
    expect(classifyAnomalyState(0)).toBe("NEUTRAL");
    expect(classifyAnomalyState(-0.4999999999)).toBe("NEUTRAL");
    expect(classifyAnomalyState(-0.5)).toBe("NEGATIVE");
    expect(classifyAnomalyState(-1.4999999999)).toBe("NEGATIVE");
    expect(classifyAnomalyState(-1.5)).toBe("STRONG_NEGATIVE");
    expect(classifyAnomalyState(-4)).toBe("STRONG_NEGATIVE");
  });
});

describe("Fixed-Node Signal v1 — detection confidence (case 15 & 16)", () => {
  it("case15: computes deterministic p33/p67 confidence from the reference visitor distribution", () => {
    const referenceVisitorCounts = Array.from({ length: 21 }, (_, index) => (index + 1) * 10); // 10..210
    const probe = computeDetectionConfidence({ currentVisitorCount: 999, referenceVisitorCounts });
    expect(probe.referenceN).toBe(21);
    expect(computeDetectionConfidence({ currentVisitorCount: probe.p67, referenceVisitorCounts }).confidence).toBe("HIGH");
    expect(computeDetectionConfidence({ currentVisitorCount: probe.p33, referenceVisitorCounts }).confidence).toBe("MEDIUM");
    expect(computeDetectionConfidence({ currentVisitorCount: probe.p33 - 0.001, referenceVisitorCounts }).confidence).toBe("LOW");
  });

  it("case16: confidence is UNKNOWN with insufficient reference N or a missing/nonpositive visitor count", () => {
    const insufficientReference = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    expect(computeDetectionConfidence({ currentVisitorCount: 500, referenceVisitorCounts: insufficientReference }).confidence).toBe("UNKNOWN");

    const sufficientReference = Array.from({ length: 21 }, (_, index) => (index + 1) * 10);
    expect(computeDetectionConfidence({ currentVisitorCount: null, referenceVisitorCounts: sufficientReference }).confidence).toBe("UNKNOWN");
    expect(computeDetectionConfidence({ currentVisitorCount: 0, referenceVisitorCounts: sufficientReference }).confidence).toBe("UNKNOWN");
  });
});

describe("Fixed-Node Signal v1 — core bait signal (case 17, 18, 19)", () => {
  it("case17: requires at least 3 of 4 core species with a valid anomaly z", () => {
    const twoValid = computeCoreBaitSignal([
      { speciesId: "sardine", available: true, z: 1 },
      { speciesId: "sappa", available: true, z: 0.5 },
      { speciesId: "konoshiro", available: false, z: null },
      { speciesId: "aji", available: false, z: null }
    ]);
    expect(twoValid.available).toBe(false);
    expect(twoValid.validSpeciesCount).toBe(2);
    expect(twoValid.coverage).toBe(0.5);
    expect(twoValid.coreBaitZ).toBeNull();

    const threeValid = computeCoreBaitSignal([
      { speciesId: "sardine", available: true, z: 1 },
      { speciesId: "sappa", available: true, z: 0.5 },
      { speciesId: "konoshiro", available: true, z: -0.2 },
      { speciesId: "aji", available: false, z: null }
    ]);
    expect(threeValid.available).toBe(true);
    expect(threeValid.validSpeciesCount).toBe(3);
  });

  it("case18: coreBaitZ is the median of the valid species z values", () => {
    const result = computeCoreBaitSignal([
      { speciesId: "sardine", available: true, z: 1 },
      { speciesId: "sappa", available: true, z: 3 },
      { speciesId: "konoshiro", available: true, z: 2 },
      { speciesId: "aji", available: true, z: 10 }
    ]);
    expect(result.coreBaitZ).toBe(2.5);
  });

  it("case19: computes positive and strong-positive breadth counts", () => {
    const result = computeCoreBaitSignal([
      { speciesId: "sardine", available: true, z: 0.6 },
      { speciesId: "sappa", available: true, z: 1.6 },
      { speciesId: "konoshiro", available: true, z: -1 },
      { speciesId: "aji", available: true, z: 0.4 }
    ]);
    expect(result.coreBaitBreadthPositive).toBe(2);
    expect(result.coreBaitBreadthStrong).toBe(1);
  });
});

describe("Fixed-Node Signal v1 — Yokohama West aggregation (case 20 & 21)", () => {
  it("case20: requires at least 2 of 3 contributing facilities", () => {
    const oneOnly = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 1 },
      { facilityId: "yokohama-honmoku", z: null },
      { facilityId: "yokohama-isogo", z: null }
    ]);
    expect(oneOnly.available).toBe(false);
    expect(oneOnly.consensus).toBe("insufficient");
    expect(oneOnly.westZ).toBeNull();

    const twoOk = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 1 },
      { facilityId: "yokohama-honmoku", z: 1.2 },
      { facilityId: "yokohama-isogo", z: null }
    ]);
    expect(twoOk.available).toBe(true);
    expect(twoOk.contributingFacilities).toEqual(["yokohama-daikoku", "yokohama-honmoku"]);
    expect(twoOk.missingFacilities).toEqual(["yokohama-isogo"]);
  });

  it("case21: a single-facility spike is distinguishable from regional agreement", () => {
    const spike = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 0.1 },
      { facilityId: "yokohama-honmoku", z: 0.2 },
      { facilityId: "yokohama-isogo", z: 3.0 }
    ]);
    expect(spike.consensus).toBe("mixed");
    expect(spike.dispersion).toBeCloseTo(2.9, 10);
    expect(spike.westZ).toBeCloseTo(0.2, 10); // median suppresses the lone spike

    const agreement = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 1.6 },
      { facilityId: "yokohama-honmoku", z: 1.8 },
      { facilityId: "yokohama-isogo", z: 2.0 }
    ]);
    expect(agreement.consensus).toBe("positive-consensus");
    expect(agreement.dispersion).toBeCloseTo(0.4, 10);
  });

  it("frozen consensus rule: worked examples", () => {
    const toValues = (zs) => zs.map((z, index) => ({ facilityId: WEST_FACILITY_IDS[index], z }));
    expect(aggregateWestFacilityValues(toValues([0.6, 0.8, 1.2])).consensus).toBe("positive-consensus");
    expect(aggregateWestFacilityValues(toValues([-0.6, -1.0, -0.8])).consensus).toBe("negative-consensus");
    expect(aggregateWestFacilityValues(toValues([-0.2, 0.0, 0.3])).consensus).toBe("neutral-consensus");
    expect(aggregateWestFacilityValues(toValues([3.0, 0.1, 0.2])).consensus).toBe("mixed");
    expect(aggregateWestFacilityValues(toValues([1.0, -0.8, 0.2])).consensus).toBe("mixed");
  });

  it("frozen consensus rule: exact boundary — +0.5 is positive, -0.5 is negative, neither is neutral", () => {
    const plusHalf = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 0.5 },
      { facilityId: "yokohama-honmoku", z: 0.5 }
    ]);
    expect(plusHalf.consensus).toBe("positive-consensus");

    const minusHalf = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: -0.5 },
      { facilityId: "yokohama-honmoku", z: -0.5 }
    ]);
    expect(minusHalf.consensus).toBe("negative-consensus");

    // Just inside +-0.5 is neutral, confirming +0.5/-0.5 themselves are the boundary, not part of neutral.
    const justInside = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 0.4999999999 },
      { facilityId: "yokohama-honmoku", z: -0.4999999999 }
    ]);
    expect(justInside.consensus).toBe("neutral-consensus");

    // Mixing the +0.5 boundary with a neutral value must NOT read as neutral-consensus.
    const boundaryMixedWithNeutral = aggregateWestFacilityValues([
      { facilityId: "yokohama-daikoku", z: 0.5 },
      { facilityId: "yokohama-honmoku", z: 0.0 }
    ]);
    expect(boundaryMixedWithNeutral.consensus).toBe("mixed");
  });

  it("exposes every facility's raw value (contributing or missing) via facilityValues", () => {
    const input = [
      { facilityId: "yokohama-daikoku", z: 0.1 },
      { facilityId: "yokohama-honmoku", z: 0.2 },
      { facilityId: "yokohama-isogo", z: null }
    ];
    const result = aggregateWestFacilityValues(input);
    expect(result.facilityValues).toEqual(input);
  });
});

describe("Fixed-Node Signal v1 — as-of / revision selection (case 22, 23, 24)", () => {
  it("case22: excludes rows collected after knowledgeAt", () => {
    const rows = [rawRow({ collected_at: "2026-08-18T00:00:00.000Z" })].map(normalizeSignalSourceRow);
    expect(selectAsOfRows(rows, "2026-08-17T23:59:59.999Z")).toHaveLength(0);
    expect(selectAsOfRows(rows, "2026-08-18T00:00:00.000Z")).toHaveLength(1);
  });

  it("case23: selects the latest eligible revision by collectedAt DESC then versionKey DESC", () => {
    const identityKey = "identity:honmoku:2026-06-01";
    const rows = [
      rawRow({ identity_key: identityKey, report_id: "report-a", version_key: `${identityKey}|aaa`, collected_at: "2026-06-02T00:00:00.000Z", catch_count: 1 }),
      rawRow({ identity_key: identityKey, report_id: "report-b", version_key: `${identityKey}|aaa`, collected_at: "2026-06-03T00:00:00.000Z", catch_count: 5 }),
      // same collectedAt as report-b: versionKey is the tiebreaker.
      rawRow({ identity_key: identityKey, report_id: "report-c", version_key: `${identityKey}|zzz`, collected_at: "2026-06-03T00:00:00.000Z", catch_count: 9 })
    ].map(normalizeSignalSourceRow);

    const asOfBeforeSecondRevision = selectAsOfRows(rows, "2026-06-02T12:00:00.000Z");
    expect(asOfBeforeSecondRevision).toHaveLength(1);
    expect(asOfBeforeSecondRevision[0].reportId).toBe("report-a");
    expect(asOfBeforeSecondRevision[0].catchCount).toBe(1);

    const asOfAfterBothRevisions = selectAsOfRows(rows, "2026-06-03T23:59:59.999Z");
    expect(asOfAfterBothRevisions).toHaveLength(1);
    expect(asOfAfterBothRevisions[0].reportId).toBe("report-c");
    expect(asOfAfterBothRevisions[0].catchCount).toBe(9);
  });

  it("case24: an August-2026-collected backfill row cannot leak into a knowledgeAt predating its collection", () => {
    const targetDate = "2025-09-15";
    const rows = fullDay(FACILITY_ID, targetDate, {
      catchCounts: singleSpeciesCatchCounts("sardine", 5),
      collectedAt: "2026-08-18T22:58:49.637Z" // matches the real backfill's collection timestamp
    });

    const beforeBackfillCollection = computeFacilityDaySignal(rows, {
      facilityId: FACILITY_ID,
      targetDate,
      knowledgeAt: "2025-09-16T00:00:00.000Z",
      config: { minBaselineN: 0 }
    });
    expect(beforeBackfillCollection.species.sardine.intensity.valid).toBe(false);
    expect(beforeBackfillCollection.species.sardine.presenceState).toBe("unknown");

    const afterBackfillCollection = computeFacilityDaySignal(rows, {
      facilityId: FACILITY_ID,
      targetDate,
      knowledgeAt: "2026-08-19T00:00:00.000Z",
      config: { minBaselineN: 0 }
    });
    expect(afterBackfillCollection.species.sardine.intensity.valid).toBe(true);
    expect(afterBackfillCollection.species.sardine.intensity.catchCount).toBe(5);
  });
});

describe("Fixed-Node Signal v1 — deterministic ordering (case 25)", () => {
  it("orders species and West facilities in a fixed, deterministic sequence", () => {
    const targetDate = "2026-06-01";
    const facilityResult = computeFacilityDaySignal(fullDay(FACILITY_ID, targetDate), {
      facilityId: FACILITY_ID,
      targetDate,
      knowledgeAt: KNOWLEDGE_AT
    });
    expect(Object.keys(facilityResult.species)).toEqual([
      "japanese-seabass", "sardine", "sappa", "konoshiro", "aji", "saba", "bora", "haze"
    ]);

    const westRows = WEST_FACILITY_IDS.flatMap((facilityId) => fullDay(facilityId, targetDate));
    const west = computeWestSignal(westRows, { targetDate, knowledgeAt: KNOWLEDGE_AT });
    expect(Object.keys(west.facilities)).toEqual(["yokohama-daikoku", "yokohama-honmoku", "yokohama-isogo"]);
  });
});
