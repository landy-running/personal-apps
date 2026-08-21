import {
  TARGET_SPECIES_ID,
  WEST_FACILITY_IDS,
  computeFacilityDaySignal,
  computeWestSignal,
  median
} from "./wanoku-fixed-node-signal.mjs";

export const BAY_FIXED_NODE_STATE_SCHEMA_VERSION = "wanoku-bay-fixed-node-state.v1";
export const BAY_FIXED_NODE_STATE_ALGORITHM_VERSION = "bay-fixed-node-state.v1";
export const BAY_FIXED_NODE_INTERPRETATION_SCOPE = "coastal-fixed-node-sentinel";
export const EAST_FACILITY_ID = "ichihara-original-maker";

const WEST_DIRECTIONS = Object.freeze({
  "positive-consensus": "positive",
  "negative-consensus": "negative",
  "neutral-consensus": "neutral",
  mixed: "mixed",
  insufficient: "unavailable"
});

export function computeBayFixedNodeState(sourceRows, { targetDate, knowledgeAt, config = {} } = {}) {
  const eastFacilitySignal = computeFacilityDaySignal(sourceRows, {
    facilityId: EAST_FACILITY_ID,
    targetDate,
    knowledgeAt,
    config
  });
  const westSignal = computeWestSignal(sourceRows, { targetDate, knowledgeAt, config });

  const eastSeabassAnomaly = eastFacilitySignal.species[TARGET_SPECIES_ID].anomaly;
  const eastSeabass = {
    available: eastSeabassAnomaly.available,
    z: eastSeabassAnomaly.available ? eastSeabassAnomaly.z : null,
    anomalyState: eastSeabassAnomaly.state,
    detectionConfidence: eastFacilitySignal.detectionConfidence,
    missingReason: eastSeabassAnomaly.available ? null : eastSeabassAnomaly.reason
  };
  const eastCoreBait = {
    available: eastFacilitySignal.coreBait.available,
    z: eastFacilitySignal.coreBait.available ? eastFacilitySignal.coreBait.coreBaitZ : null,
    anomalyState: null,
    detectionConfidence: eastFacilitySignal.detectionConfidence,
    missingReason: eastFacilitySignal.coreBait.available ? null : "core_bait_unavailable"
  };

  return {
    schemaVersion: BAY_FIXED_NODE_STATE_SCHEMA_VERSION,
    algorithmVersion: BAY_FIXED_NODE_STATE_ALGORITHM_VERSION,
    interpretationScope: BAY_FIXED_NODE_INTERPRETATION_SCOPE,
    targetDate,
    knowledgeAt,
    east: {
      facilityId: EAST_FACILITY_ID,
      nodeType: "single-node",
      facilitySignal: eastFacilitySignal
    },
    west: {
      facilityIds: [...WEST_FACILITY_IDS],
      westSignal
    },
    channels: {
      seabass: buildBayChannelState({
        channelId: "seabass",
        eastValue: eastSeabass,
        westAggregate: westSignal.westSeabassZ,
        targetDate,
        knowledgeAt
      }),
      coreBait: buildBayChannelState({
        channelId: "coreBait",
        eastValue: eastCoreBait,
        westAggregate: westSignal.westCoreBaitZ,
        targetDate,
        knowledgeAt
      })
    },
    limitations: [
      "East represents one coastal fixed-node sentinel, not a multi-node consensus.",
      "Common states represent concurrent anomalies relative to each side's local baseline.",
      "Gradient states represent spatial contrast between standardized coastal-sentinel anomalies."
    ]
  };
}

export function buildBayChannelState({ channelId, eastValue, westAggregate, targetDate, knowledgeAt }) {
  const east = buildEastChannelState(eastValue);
  const west = buildWestChannelState(westAggregate);
  const common = computeBayCommonState(east, west);
  const gradient = computeEastWestGradient(east, west);
  return {
    channelId,
    east,
    west,
    common,
    gradient,
    support: {
      eastFacilityId: EAST_FACILITY_ID,
      eastNodeCount: 1,
      eastDetectionConfidence: east.detectionConfidence,
      westContributingFacilities: [...west.contributingFacilities],
      westMissingFacilities: [...west.missingFacilities],
      westFacilityCount: WEST_FACILITY_IDS.length,
      westContributingFacilityCount: west.contributingFacilities.length,
      westDispersion: west.dispersion,
      westConsensus: west.consensus,
      targetDate,
      knowledgeAt,
      interpretationScope: BAY_FIXED_NODE_INTERPRETATION_SCOPE
    }
  };
}

export function classifyEastBucket(z) {
  if (typeof z !== "number" || !Number.isFinite(z)) return "unavailable";
  if (z >= 0.5) return "positive";
  if (z <= -0.5) return "negative";
  return "neutral";
}

export function deriveWestDirection(consensus) {
  return WEST_DIRECTIONS[consensus] ?? "unavailable";
}

export function computeBayCommonState(east, west) {
  if (!east.available || !west.available) return { available: false, state: "UNAVAILABLE", commonZ: null };
  if (west.direction === "mixed") return { available: true, state: "WEST_MIXED", commonZ: null };

  const state = east.direction === "positive" && west.direction === "positive"
    ? "SHARED_POSITIVE"
    : east.direction === "negative" && west.direction === "negative"
      ? "SHARED_NEGATIVE"
      : east.direction === "neutral" && west.direction === "neutral"
        ? "SHARED_NEUTRAL"
        : "DIVERGENT";
  const commonZ = state.startsWith("SHARED_") ? median([east.z, west.z]) : null;
  return { available: true, state, commonZ };
}

export function computeEastWestGradient(east, west) {
  if (typeof east.z !== "number" || typeof west.z !== "number") {
    return { available: false, state: "UNAVAILABLE", gradientZ: null, gradientMagnitude: null };
  }
  const gradientZ = east.z - west.z;
  const state = gradientZ >= 0.5 ? "EAST_LEAN" : gradientZ <= -0.5 ? "WEST_LEAN" : "BALANCED";
  return { available: true, state, gradientZ, gradientMagnitude: Math.abs(gradientZ) };
}

function buildEastChannelState(value) {
  const available = value.available === true && typeof value.z === "number";
  const z = available ? value.z : null;
  return {
    facilityId: EAST_FACILITY_ID,
    nodeType: "single-node",
    available,
    z,
    direction: classifyEastBucket(z),
    anomalyState: value.anomalyState ?? null,
    detectionConfidence: value.detectionConfidence,
    missingReason: available ? null : (value.missingReason ?? "east_signal_unavailable")
  };
}

function buildWestChannelState(aggregate) {
  return {
    available: aggregate.available === true,
    z: aggregate.available && typeof aggregate.westZ === "number" ? aggregate.westZ : null,
    direction: deriveWestDirection(aggregate.consensus),
    contributingFacilities: [...aggregate.contributingFacilities],
    missingFacilities: [...aggregate.missingFacilities],
    dispersion: aggregate.dispersion,
    consensus: aggregate.consensus,
    facilityValues: aggregate.facilityValues.map((entry) => ({ ...entry })),
    missingReason: aggregate.available ? null : "west_contribution_insufficient"
  };
}
