import { describe, expect, it } from "vitest";
import {
  BAY_FIXED_NODE_INTERPRETATION_SCOPE,
  BAY_FIXED_NODE_STATE_ALGORITHM_VERSION,
  BAY_FIXED_NODE_STATE_SCHEMA_VERSION,
  EAST_FACILITY_ID,
  buildBayChannelState,
  classifyEastBucket,
  computeBayFixedNodeState,
  computeEastWestGradient,
  deriveWestDirection
} from "../../../scripts/wanoku-bay-fixed-node-state.mjs";
import { REQUIRED_SPECIES_IDS, WEST_FACILITY_IDS, addDaysIso } from "../../../scripts/wanoku-fixed-node-signal.mjs";
import {
  BAY_SANITY_ANALYSIS_MODE,
  BAY_SANITY_SCHEMA_VERSION,
  analyzeBayFixedNodeRows
} from "../../../scripts/wanoku-bay-fixed-node-state-sanity.mjs";

const TARGET_DATE = "2026-06-01";
const KNOWLEDGE_AT = "2026-08-22T00:00:00.000Z";
const CONFIG = { minBaselineN: 1, minReferenceN: 1, minValidSpeciesCount: 3, minContributingFacilities: 2 };

describe("Wanoku Bay Fixed-Node State v1", () => {
  it("exposes the frozen version and coastal-sentinel scope", () => {
    const state = computeBayFixedNodeState(buildFourFacilityRows(), options());
    expect(state).toMatchObject({
      schemaVersion: BAY_FIXED_NODE_STATE_SCHEMA_VERSION,
      algorithmVersion: BAY_FIXED_NODE_STATE_ALGORITHM_VERSION,
      interpretationScope: BAY_FIXED_NODE_INTERPRETATION_SCOPE,
      targetDate: TARGET_DATE,
      knowledgeAt: KNOWLEDGE_AT
    });
  });

  it("represents East as exactly one Ichihara node and preserves detection confidence", () => {
    const detectionConfidence = { confidence: "MEDIUM", visitorCount: 100, referenceN: 21, p33: 80, p67: 140 };
    const channel = channelState(east(0.75, detectionConfidence), west(0.8, "positive-consensus"));
    expect(channel.east).toMatchObject({
      facilityId: EAST_FACILITY_ID,
      nodeType: "single-node",
      available: true,
      z: 0.75,
      direction: "positive",
      detectionConfidence
    });
    expect(channel.support).toMatchObject({ eastFacilityId: EAST_FACILITY_ID, eastNodeCount: 1, eastDetectionConfidence: detectionConfidence });
  });

  it("keeps unavailable East explicit with its missing reason", () => {
    const channel = channelState(eastUnavailable("baseline_insufficient"), west(0.8, "positive-consensus"));
    expect(channel.east).toMatchObject({ available: false, z: null, direction: "unavailable", missingReason: "baseline_insufficient" });
    expect(channel.common).toEqual({ available: false, state: "UNAVAILABLE", commonZ: null });
  });

  it.each([
    [0.5, "positive"],
    [-0.5, "negative"],
    [0.499999, "neutral"],
    [-0.499999, "neutral"],
    [null, "unavailable"]
  ])("uses the frozen East bucket boundary for %s", (z, expected) => {
    expect(classifyEastBucket(z)).toBe(expected);
  });

  it.each([
    ["positive-consensus", "positive"],
    ["negative-consensus", "negative"],
    ["neutral-consensus", "neutral"],
    ["mixed", "mixed"],
    ["insufficient", "unavailable"]
  ])("derives West direction from consensus %s", (consensus, expected) => {
    expect(deriveWestDirection(consensus)).toBe(expected);
  });

  it("reuses West consensus and support without converting a positive mixed median to consensus", () => {
    const channel = channelState(east(0.9), west(0.8, "mixed", { dispersion: 2.5 }));
    expect(channel.west).toMatchObject({ available: true, z: 0.8, direction: "mixed", consensus: "mixed", dispersion: 2.5 });
    expect(channel.common).toEqual({ available: true, state: "WEST_MIXED", commonZ: null });
    expect(channel.support).toMatchObject({ westConsensus: "mixed", westFacilityCount: 3, westContributingFacilityCount: 2 });
  });

  it("keeps insufficient West unavailable", () => {
    const channel = channelState(east(0.9), westUnavailable());
    expect(channel.west).toMatchObject({ available: false, z: null, direction: "unavailable", consensus: "insufficient" });
    expect(channel.common.state).toBe("UNAVAILABLE");
    expect(channel.gradient.state).toBe("UNAVAILABLE");
  });

  it.each([
    [0.8, 1.2, "positive-consensus", "SHARED_POSITIVE", 1],
    [-0.8, -1.2, "negative-consensus", "SHARED_NEGATIVE", -1],
    [0.2, -0.2, "neutral-consensus", "SHARED_NEUTRAL", 0],
    [0.8, -0.8, "negative-consensus", "DIVERGENT", null],
    [-0.8, 0.8, "positive-consensus", "DIVERGENT", null]
  ])("derives common state %s/%s as %s", (eastZ, westZ, consensus, expectedState, expectedZ) => {
    const common = channelState(east(eastZ), west(westZ, consensus)).common;
    expect(common.state).toBe(expectedState);
    expect(common.commonZ).toBe(expectedZ);
  });

  it("sets common z only for shared states", () => {
    const shared = channelState(east(0.5), west(1.5, "positive-consensus")).common;
    const divergent = channelState(east(0.5), west(-0.5, "negative-consensus")).common;
    const mixed = channelState(east(0.5), west(0.5, "mixed")).common;
    const unavailable = channelState(eastUnavailable(), west(0.5, "positive-consensus")).common;
    expect(shared.commonZ).toBe(1);
    expect([divergent.commonZ, mixed.commonZ, unavailable.commonZ]).toEqual([null, null, null]);
  });

  it.each([
    [1, 0.5, "EAST_LEAN", 0.5],
    [0.5, 1, "WEST_LEAN", -0.5],
    [0.7, 0.3, "BALANCED", 0.4]
  ])("classifies gradient %s - %s", (eastZ, westZ, expectedState, expectedZ) => {
    expect(computeEastWestGradient({ z: eastZ }, { z: westZ })).toEqual({
      available: true,
      state: expectedState,
      gradientZ: expect.closeTo(expectedZ, 12),
      gradientMagnitude: expect.closeTo(Math.abs(expectedZ), 12)
    });
  });

  it("makes a numerical gradient unavailable when either side has no z", () => {
    expect(computeEastWestGradient({ z: null }, { z: 1 })).toEqual({ available: false, state: "UNAVAILABLE", gradientZ: null, gradientMagnitude: null });
  });

  it("keeps seabass and core bait as independent channels", () => {
    const state = computeBayFixedNodeState(buildFourFacilityRows({ coreBaitCatch: 0 }), options());
    expect(state.channels.seabass.common.state).toBe("SHARED_POSITIVE");
    expect(state.channels.coreBait.common.state).toBe("SHARED_NEGATIVE");
    expect(state.channels.seabass).not.toEqual(state.channels.coreBait);
  });

  it("reuses exactly the existing three Yokohama West facilities", () => {
    const state = computeBayFixedNodeState(buildFourFacilityRows(), options());
    expect(state.east.facilityId).toBe(EAST_FACILITY_ID);
    expect(state.west.facilityIds).toEqual([...WEST_FACILITY_IDS]);
    expect(Object.keys(state.west.westSignal.facilities).sort()).toEqual([...WEST_FACILITY_IDS].sort());
  });

  it("prevents historical backfill rows from leaking before collectedAt", () => {
    const rows = buildFourFacilityRows({ collectedAt: "2026-08-21T00:00:00.000Z" });
    const before = computeBayFixedNodeState(rows, options({ knowledgeAt: "2026-08-20T23:59:59.999Z" }));
    const after = computeBayFixedNodeState(rows, options());
    expect(before.channels.seabass.east).toMatchObject({ available: false, missingReason: "baseline_insufficient" });
    expect(before.channels.seabass.west).toMatchObject({ available: false, consensus: "insufficient" });
    expect(after.channels.seabass.east.available).toBe(true);
    expect(after.channels.seabass.west.available).toBe(true);
  });

  it("is deterministic for identical rows and as-of inputs", () => {
    const rows = buildFourFacilityRows();
    expect(computeBayFixedNodeState(rows, options())).toEqual(computeBayFixedNodeState(rows, options()));
  });

  it("has no movement, occupancy, or lead-lag output fields", () => {
    const state = computeBayFixedNodeState(buildFourFacilityRows(), options());
    const keys = collectKeys(state);
    expect(keys).not.toEqual(expect.arrayContaining(["movementDirection", "migrationDirection", "fishMovedEast", "fishMovedWest", "leadLag", "occupancy"]));
  });

  it("summarizes retrospective sanity output without changing state semantics", () => {
    const summary = analyzeBayFixedNodeRows(buildAnalysisRows(), {
      startDate: TARGET_DATE,
      endDate: TARGET_DATE,
      queryStartDate: "2026-04-06",
      knowledgeAt: KNOWLEDGE_AT,
      capturedAt: "2026-08-22T00:00:01.000Z",
      rowsReadPerFacility: Object.fromEntries([EAST_FACILITY_ID, ...WEST_FACILITY_IDS].map((facilityId) => [facilityId, 176])),
      remoteReadAttempts: 4
    });
    expect(summary).toMatchObject({
      schemaVersion: BAY_SANITY_SCHEMA_VERSION,
      analysisMode: BAY_SANITY_ANALYSIS_MODE,
      retrospectiveKnowledgeAt: KNOWLEDGE_AT,
      remoteWrites: 0,
      channels: {
        seabass: { totalTargetDates: 1, eastAvailableDates: 1, westAvailableDates: 1, bothAvailableDates: 1 },
        coreBait: { totalTargetDates: 1, eastAvailableDates: 1, westAvailableDates: 1, bothAvailableDates: 1 }
      }
    });
    expect(summary.channels.seabass.commonStateCounts.SHARED_POSITIVE).toBe(1);
    expect(summary.channels.seabass.gradientStateCounts.BALANCED).toBe(1);
  });
});

function channelState(eastValue, westAggregate) {
  return buildBayChannelState({ channelId: "seabass", eastValue, westAggregate, targetDate: TARGET_DATE, knowledgeAt: KNOWLEDGE_AT });
}

function east(z, detectionConfidence = { confidence: "HIGH", visitorCount: 100, referenceN: 21, p33: 50, p67: 90 }) {
  return { available: true, z, anomalyState: z >= 0.5 ? "POSITIVE" : z <= -0.5 ? "NEGATIVE" : "NEUTRAL", detectionConfidence, missingReason: null };
}

function eastUnavailable(missingReason = "current_observation_invalid") {
  return { available: false, z: null, anomalyState: "UNAVAILABLE", detectionConfidence: { confidence: "UNKNOWN" }, missingReason };
}

function west(z, consensus, overrides = {}) {
  return {
    available: true,
    westZ: z,
    contributingFacilities: ["yokohama-daikoku", "yokohama-honmoku"],
    missingFacilities: ["yokohama-isogo"],
    dispersion: 0.4,
    consensus,
    facilityValues: [
      { facilityId: "yokohama-daikoku", z },
      { facilityId: "yokohama-honmoku", z },
      { facilityId: "yokohama-isogo", z: null }
    ],
    ...overrides
  };
}

function westUnavailable() {
  return {
    available: false,
    westZ: null,
    contributingFacilities: ["yokohama-honmoku"],
    missingFacilities: ["yokohama-daikoku", "yokohama-isogo"],
    dispersion: null,
    consensus: "insufficient",
    facilityValues: WEST_FACILITY_IDS.map((facilityId) => ({ facilityId, z: facilityId === "yokohama-honmoku" ? 0.8 : null }))
  };
}

function options(overrides = {}) {
  return { targetDate: TARGET_DATE, knowledgeAt: KNOWLEDGE_AT, config: CONFIG, ...overrides };
}

function buildFourFacilityRows({ collectedAt = "2026-08-21T00:00:00.000Z", coreBaitCatch = 10 } = {}) {
  const rows = [];
  for (const facilityId of [EAST_FACILITY_ID, ...WEST_FACILITY_IDS]) {
    rows.push(...fullDay(facilityId, "2026-05-24", { collectedAt, seabassCatch: 1, coreBaitCatch: 1 }));
    rows.push(...fullDay(facilityId, TARGET_DATE, { collectedAt, seabassCatch: 10, coreBaitCatch }));
  }
  return rows;
}

function buildAnalysisRows() {
  const collectedAt = "2026-08-21T00:00:00.000Z";
  const rows = [];
  for (const facilityId of [EAST_FACILITY_ID, ...WEST_FACILITY_IDS]) {
    for (let offset = 8; offset <= 28; offset += 1) {
      rows.push(...fullDay(facilityId, addDaysIso(TARGET_DATE, -offset), { collectedAt, seabassCatch: 1, coreBaitCatch: 1 }));
    }
    rows.push(...fullDay(facilityId, TARGET_DATE, { collectedAt, seabassCatch: 10, coreBaitCatch: 10 }));
  }
  return rows;
}

function fullDay(facilityId, date, { collectedAt, seabassCatch, coreBaitCatch }) {
  const reportId = `report:${facilityId}:${date}`;
  return REQUIRED_SPECIES_IDS.map((speciesId) => {
    const catchCount = speciesId === "japanese-seabass"
      ? seabassCatch
      : ["sardine", "sappa", "konoshiro", "aji"].includes(speciesId) ? coreBaitCatch : 1;
    return {
      report_id: reportId,
      version_key: `${reportId}:v1`,
      identity_key: `identity:${facilityId}:${date}`,
      facility_id: facilityId,
      observation_date: date,
      collected_at: collectedAt,
      visitor_count: 100,
      operating_status: "operating",
      report_completeness: "complete",
      species_id: speciesId,
      catch_count: catchCount,
      presence_state: catchCount === 0 ? "absent" : "present",
      completeness: "complete",
      alias_coverage: "sufficient"
    };
  });
}

function collectKeys(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectKeys(item, output);
    }
  }
  return output;
}
