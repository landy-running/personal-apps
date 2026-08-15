import {
  ENVIRONMENT_STATE_SCHEMA_VERSION,
  type EnvironmentState,
  type EnvironmentStateTidePhase
} from "./environment-state";
import { type HabitatNode } from "./habitat";

export const HABITAT_STATE_SCHEMA_VERSION = "wanoku-habitat-state.v1";
export const HABITAT_STATE_RULE_VERSION = "wanoku-habitat-state-rules.v1";
export const FLOW_ENERGY_MODERATE_MIN_CM_PER_HOUR = 5;
export const FLOW_ENERGY_STRONG_ABOVE_CM_PER_HOUR = 20;
export const WIND_ENERGY_MODERATE_MIN_MPS = 3;
export const WIND_ENERGY_STRONG_MIN_MPS = 8;

export type HabitatStateEnergy = "weak" | "moderate" | "strong" | "unknown";
export type HabitatStateWaterLevel = "low" | "moderate" | "high" | "unknown";
export type HabitatStateExchange = "slack" | "active" | "unknown";
export type HabitatStateDirectionalExposure = "sheltered" | "exposed" | "unknown";
export type HabitatStateFreshwaterInfluence = "low" | "moderate" | "high" | "unknown";
export type HabitatStateDisturbance = "calm" | "moderate" | "energetic" | "unknown";

export type HabitatStateContext = {
  displayName: string;
  region: string;
  waterBodyType: HabitatNode["waterBodyType"];
  habitatTypes: HabitatNode["habitatTypes"];
  bayPosition: HabitatNode["bayPosition"];
  depthBand: HabitatNode["depthBand"];
};

export type HabitatStateHydrodynamics = {
  tidePhase: EnvironmentStateTidePhase;
  tideSlopeCmPerHour: number | null;
  waterLevelState: HabitatStateWaterLevel;
  exchangeState: HabitatStateExchange;
  flowEnergyState: HabitatStateEnergy;
};

export type HabitatStateExposure = {
  windState: HabitatStateEnergy;
  directionalExposure: HabitatStateDirectionalExposure;
  waveHeightM: number | null;
  waveState: HabitatStateEnergy;
  currentSpeedMps: number | null;
  currentState: HabitatStateEnergy;
};

export type HabitatStateUnknownReason = {
  field: string;
  reasons: string[];
};

export type HabitatStateDerivation = {
  field: string;
  inputs: string[];
  ruleVersion: typeof HABITAT_STATE_RULE_VERSION;
};

export type HabitatState = {
  schemaVersion: typeof HABITAT_STATE_SCHEMA_VERSION;
  nodeId: string;
  asOf: string;
  context: HabitatStateContext;
  hydrodynamics: HabitatStateHydrodynamics;
  exposure: HabitatStateExposure;
  freshwater: {
    influenceState: HabitatStateFreshwaterInfluence;
  };
  disturbance: {
    state: HabitatStateDisturbance;
  };
  quality: {
    inputOverallConfidence: number | null;
    inputStaleComponents: string[];
    inputMissingComponents: string[];
    unknownStateFields: string[];
  };
  provenance: {
    environmentStateSchemaVersion: typeof ENVIRONMENT_STATE_SCHEMA_VERSION;
    habitatGraphVersion: string;
    habitatNodeDataSources: string[];
    derivations: HabitatStateDerivation[];
  };
  diagnostics: {
    unknownStateReasons: HabitatStateUnknownReason[];
  };
};

export type BuildHabitatStateInput = {
  environmentState: EnvironmentState;
  habitatNode: HabitatNode;
  asOf: string;
};

export function buildHabitatState(input: BuildHabitatStateInput): HabitatState {
  const flowEnergyState = classifyFlowEnergyState(input.environmentState.tide.slopeCmPerHour);
  const windState = classifyWindEnergyState(input.environmentState.atmosphere.windSpeedMps);
  const waveState: HabitatStateEnergy = "unknown";
  const currentState: HabitatStateEnergy = "unknown";
  const directionalExposure: HabitatStateDirectionalExposure = "unknown";
  const waterLevelState: HabitatStateWaterLevel = "unknown";
  const freshwaterInfluenceState: HabitatStateFreshwaterInfluence = "unknown";
  const exchangeState = exchangeStateFromFlow(flowEnergyState);
  const disturbanceState = disturbanceStateFromEnergy([
    flowEnergyState,
    windState,
    waveState,
    currentState
  ]);
  const unknownStateReasons = buildUnknownStateReasons({
    environmentState: input.environmentState,
    habitatNode: input.habitatNode,
    flowEnergyState,
    windState,
    disturbanceState
  });

  return {
    schemaVersion: HABITAT_STATE_SCHEMA_VERSION,
    nodeId: input.habitatNode.id,
    asOf: input.asOf,
    context: {
      displayName: input.habitatNode.displayName,
      region: input.habitatNode.region,
      waterBodyType: input.habitatNode.waterBodyType,
      habitatTypes: [...input.habitatNode.habitatTypes],
      bayPosition: input.habitatNode.bayPosition ?? null,
      depthBand: input.habitatNode.depthBand ?? null
    },
    hydrodynamics: {
      tidePhase: input.environmentState.tide.phase,
      tideSlopeCmPerHour: input.environmentState.tide.slopeCmPerHour,
      waterLevelState,
      exchangeState,
      flowEnergyState
    },
    exposure: {
      windState,
      directionalExposure,
      waveHeightM: input.environmentState.marine.waveHeightM,
      waveState,
      currentSpeedMps: input.environmentState.marine.currentSpeedMps,
      currentState
    },
    freshwater: {
      influenceState: freshwaterInfluenceState
    },
    disturbance: {
      state: disturbanceState
    },
    quality: {
      inputOverallConfidence: input.environmentState.quality.overall.confidence,
      inputStaleComponents: inputStaleComponents(input.environmentState),
      inputMissingComponents: uniqueSorted([
        ...input.environmentState.quality.overall.missingComponents,
        ...input.environmentState.freshness.missingComponents
      ]),
      unknownStateFields: unknownStateReasons.map((entry) => entry.field)
    },
    provenance: {
      environmentStateSchemaVersion: ENVIRONMENT_STATE_SCHEMA_VERSION,
      habitatGraphVersion: input.environmentState.provenance.habitatGraphVersion,
      habitatNodeDataSources: [...input.habitatNode.dataSources],
      derivations: habitatStateDerivations()
    },
    diagnostics: {
      unknownStateReasons
    }
  };
}

export function classifyFlowEnergyState(slopeCmPerHour: number | null): HabitatStateEnergy {
  if (!isFiniteNumber(slopeCmPerHour)) return "unknown";
  const absoluteSlope = Math.abs(slopeCmPerHour);
  if (absoluteSlope < FLOW_ENERGY_MODERATE_MIN_CM_PER_HOUR) return "weak";
  if (absoluteSlope <= FLOW_ENERGY_STRONG_ABOVE_CM_PER_HOUR) return "moderate";
  return "strong";
}

export function classifyWindEnergyState(windSpeedMps: number | null): HabitatStateEnergy {
  if (!isFiniteNumber(windSpeedMps) || windSpeedMps < 0) return "unknown";
  if (windSpeedMps < WIND_ENERGY_MODERATE_MIN_MPS) return "weak";
  if (windSpeedMps < WIND_ENERGY_STRONG_MIN_MPS) return "moderate";
  return "strong";
}

function exchangeStateFromFlow(flowEnergyState: HabitatStateEnergy): HabitatStateExchange {
  if (flowEnergyState === "weak") return "slack";
  if (flowEnergyState === "moderate" || flowEnergyState === "strong") return "active";
  return "unknown";
}

function disturbanceStateFromEnergy(states: HabitatStateEnergy[]): HabitatStateDisturbance {
  if (states.includes("strong")) return "energetic";
  if (states.includes("moderate")) return "moderate";
  if (states.every((state) => state === "weak")) return "calm";
  return "unknown";
}

function buildUnknownStateReasons(input: {
  environmentState: EnvironmentState;
  habitatNode: HabitatNode;
  flowEnergyState: HabitatStateEnergy;
  windState: HabitatStateEnergy;
  disturbanceState: HabitatStateDisturbance;
}): HabitatStateUnknownReason[] {
  const reasons: HabitatStateUnknownReason[] = [];
  reasons.push({
    field: "hydrodynamics.waterLevelState",
    reasons: uniqueStrings([
      ...(input.environmentState.tide.levelCm == null ? ["tide-level-missing"] : []),
      "site-relative-water-level-reference-unavailable"
    ])
  });
  if (input.environmentState.tide.phase === "unknown") {
    reasons.push({ field: "hydrodynamics.tidePhase", reasons: ["tide-phase-missing"] });
  }
  if (input.flowEnergyState === "unknown") {
    reasons.push({ field: "hydrodynamics.flowEnergyState", reasons: ["tide-slope-missing"] });
    reasons.push({ field: "hydrodynamics.exchangeState", reasons: ["tide-slope-missing"] });
  }
  if (input.windState === "unknown") {
    reasons.push({ field: "exposure.windState", reasons: ["wind-speed-missing"] });
  }
  reasons.push({
    field: "exposure.directionalExposure",
    reasons: hasUnsupportedDirectionConvention(input.environmentState)
      ? ["unsupported-direction-convention"]
      : ["directional-habitat-orientation-unavailable"]
  });
  reasons.push({
    field: "exposure.waveState",
    reasons: [input.environmentState.marine.waveHeightM == null
      ? "wave-height-missing"
      : "wave-classification-rule-undefined"]
  });
  reasons.push({
    field: "exposure.currentState",
    reasons: [input.environmentState.marine.currentSpeedMps == null
      ? "current-speed-missing"
      : "current-classification-rule-undefined"]
  });
  reasons.push({
    field: "freshwater.influenceState",
    reasons: uniqueStrings([
      "accumulated-rainfall-unavailable",
      ...(input.environmentState.atmosphere.precipitationMm == null
        ? ["instantaneous-precipitation-missing"]
        : ["instantaneous-precipitation-insufficient"]),
      ...(input.habitatNode.freshwaterInfluence == null ? ["freshwater-baseline-unavailable"] : []),
      ...(input.habitatNode.waterBodyType === "river-mouth"
        ? ["river-mouth-classification-insufficient"]
        : [])
    ])
  });
  if (input.disturbanceState === "unknown") {
    reasons.push({ field: "disturbance.state", reasons: ["disturbance-inputs-incomplete"] });
  }
  return reasons;
}

function hasUnsupportedDirectionConvention(environmentState: EnvironmentState): boolean {
  return environmentState.provenance.environmental.some((entry) => (
    entry.missingReasons.includes("unsupported-direction-convention")
  ));
}

function inputStaleComponents(environmentState: EnvironmentState): string[] {
  return uniqueSorted([
    ...environmentState.quality.overall.staleComponents,
    ...(environmentState.freshness.atmosphere.stale === true ? ["atmosphere"] : []),
    ...(environmentState.freshness.tide.stale === true ? ["tide"] : [])
  ]);
}

function habitatStateDerivations(): HabitatStateDerivation[] {
  return [
    derivation("hydrodynamics.tidePhase", ["environmentState.tide.phase"]),
    derivation("hydrodynamics.tideSlopeCmPerHour", ["environmentState.tide.slopeCmPerHour"]),
    derivation("hydrodynamics.waterLevelState", [
      "environmentState.tide.levelCm",
      "habitatNode.depthBand",
      "habitatNode.tidalExposure"
    ]),
    derivation("hydrodynamics.exchangeState", ["environmentState.tide.slopeCmPerHour"]),
    derivation("hydrodynamics.flowEnergyState", ["environmentState.tide.slopeCmPerHour"]),
    derivation("exposure.windState", ["environmentState.atmosphere.windSpeedMps"]),
    derivation("exposure.directionalExposure", [
      "environmentState.atmosphere.windDirectionDeg",
      "environmentState.provenance.environmental",
      "habitatNode.waveExposure"
    ]),
    derivation("exposure.waveState", ["environmentState.marine.waveHeightM"]),
    derivation("exposure.currentState", ["environmentState.marine.currentSpeedMps"]),
    derivation("freshwater.influenceState", [
      "environmentState.atmosphere.precipitationMm",
      "habitatNode.waterBodyType",
      "habitatNode.freshwaterInfluence"
    ]),
    derivation("disturbance.state", [
      "hydrodynamics.flowEnergyState",
      "exposure.windState",
      "exposure.waveState",
      "exposure.currentState"
    ])
  ];
}

function derivation(field: string, inputs: string[]): HabitatStateDerivation {
  return { field, inputs, ruleVersion: HABITAT_STATE_RULE_VERSION };
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
