import { type EnvironmentState } from "./environment-state";
import { type HabitatNode } from "./habitat";
import { type HabitatState, type HabitatStateEnergy } from "./habitat-state";

export const SEABASS_STATE_SCHEMA_VERSION = "wanoku-seabass-state.v1";
export const SEABASS_STATE_RULE_VERSION = "wanoku-seabass-state-rules.v1";
export const JAPANESE_SEABASS_SPECIES_ID = "japanese-seabass";
export const JAPANESE_SEABASS_SCIENTIFIC_NAME = "Lateolabrax japonicus";

export type SeabassAxisState = "supportive" | "neutral" | "limiting" | "unknown";
export type SeabassDriverEffect = SeabassAxisState;
export type SeabassDriverValue = string | number | boolean | null | string[];

export type SeabassDriver = {
  input: string;
  value: SeabassDriverValue;
  effect: SeabassDriverEffect;
  reason: string;
};

export type SeabassAxis = {
  state: SeabassAxisState;
  meaning: string;
  drivers: SeabassDriver[];
  constraints: string[];
};

export type SeabassStateDerivation = {
  field: "presence" | "activation" | "shoreCatchability";
  inputs: string[];
  ruleVersion: typeof SEABASS_STATE_RULE_VERSION;
};

export type SeabassState = {
  schemaVersion: typeof SEABASS_STATE_SCHEMA_VERSION;
  species: {
    id: typeof JAPANESE_SEABASS_SPECIES_ID;
    scientificName: typeof JAPANESE_SEABASS_SCIENTIFIC_NAME;
  };
  nodeId: string;
  asOf: string;
  presence: SeabassAxis;
  activation: SeabassAxis;
  shoreCatchability: SeabassAxis;
  quality: {
    inputOverallConfidence: number | null;
    staleInputs: string[];
    missingInputs: string[];
    unknownDerivedComponents: string[];
    directFishEvidenceAbsent: true;
  };
  provenance: {
    environmentStateSchemaVersion: EnvironmentState["schemaVersion"];
    habitatStateSchemaVersion: HabitatState["schemaVersion"];
    habitatGraphVersion: string;
    derivations: SeabassStateDerivation[];
  };
  diagnostics: {
    unknownAxisReasons: Array<{
      field: "presence.state" | "activation.state" | "shoreCatchability.state";
      reasons: string[];
    }>;
  };
};

export type BuildSeabassStateInput = {
  environmentState: EnvironmentState;
  habitatState: HabitatState;
  habitatNode: HabitatNode;
  asOf: string;
};

const SUPPORTED_WATER_BODY_TYPES = new Set<HabitatNode["waterBodyType"]>([
  "bay",
  "river-mouth",
  "canal",
  "coastal",
  "strait"
]);
const SUPPORTED_HABITAT_TYPES = new Set<HabitatNode["habitatTypes"][number]>([
  "shallow",
  "tidal-flat",
  "river-mouth",
  "canal",
  "artificial-shore",
  "open-water",
  "cape",
  "rocky-coast",
  "sandy-bottom",
  "muddy-bottom",
  "mixed-bottom"
]);

export function buildSeabassState(input: BuildSeabassStateInput): SeabassState {
  const presenceDrivers = buildPresenceDrivers(input.environmentState, input.habitatState, input.habitatNode);
  const activationDrivers = buildActivationDrivers(input.habitatState);
  const shoreDrivers = buildShoreCatchabilityDrivers(input.habitatState, input.habitatNode);
  const presenceState = aggregatePresenceEffects(presenceDrivers);
  const activationState = aggregateSeabassAxisEffects(activationDrivers.map((entry) => entry.effect));
  const shoreUnknownReasons = shoreCatchabilityUnknownReasons(input.habitatState);
  const shoreCatchabilityState = shoreUnknownReasons.length
    ? "unknown"
    : aggregateSeabassAxisEffects(shoreDrivers.map((entry) => entry.effect));
  const unknownAxisReasons = [
    ...(presenceState === "unknown"
      ? [{ field: "presence.state" as const, reasons: ["presence-support-inputs-unavailable"] }]
      : []),
    ...(activationState === "unknown"
      ? [{ field: "activation.state" as const, reasons: ["activation-inputs-unavailable"] }]
      : []),
    ...(shoreCatchabilityState === "unknown"
      ? [{ field: "shoreCatchability.state" as const, reasons: shoreUnknownReasons.length
          ? shoreUnknownReasons
          : ["shore-physical-inputs-unavailable"] }]
      : [])
  ];

  return {
    schemaVersion: SEABASS_STATE_SCHEMA_VERSION,
    species: {
      id: JAPANESE_SEABASS_SPECIES_ID,
      scientificName: JAPANESE_SEABASS_SCIENTIFIC_NAME
    },
    nodeId: input.habitatNode.id,
    asOf: input.asOf,
    presence: {
      state: presenceState,
      meaning: "environment-and-habitat-support-not-observed-fish-presence",
      drivers: presenceDrivers,
      constraints: [
        "direct-fish-evidence-absent",
        "catch-evidence-not-in-v1"
      ]
    },
    activation: {
      state: activationState,
      meaning: "feeding-opportunity-potential-not-observed-feeding",
      drivers: activationDrivers,
      constraints: [
        "bait-density-unavailable",
        "light-unavailable",
        "turbidity-unavailable",
        "dissolved-oxygen-unavailable",
        "salinity-unavailable"
      ]
    },
    shoreCatchability: {
      state: shoreCatchabilityState,
      meaning: "physical-shore-fishing-opportunity-not-access-or-safety",
      drivers: shoreDrivers,
      constraints: uniqueStrings([
        "shore-accessibility-unavailable",
        "shore-safety-unavailable",
        "shore-structure-unavailable",
        ...shoreUnknownReasons
      ])
    },
    quality: {
      inputOverallConfidence: input.habitatState.quality.inputOverallConfidence,
      staleInputs: [...input.habitatState.quality.inputStaleComponents],
      missingInputs: uniqueSorted([
        ...input.environmentState.freshness.missingComponents,
        ...input.habitatState.quality.inputMissingComponents
      ]),
      unknownDerivedComponents: [...input.habitatState.quality.unknownStateFields],
      directFishEvidenceAbsent: true
    },
    provenance: {
      environmentStateSchemaVersion: input.environmentState.schemaVersion,
      habitatStateSchemaVersion: input.habitatState.schemaVersion,
      habitatGraphVersion: input.habitatState.provenance.habitatGraphVersion,
      derivations: seabassStateDerivations()
    },
    diagnostics: {
      unknownAxisReasons
    }
  };
}

export function aggregateSeabassAxisEffects(effects: readonly SeabassDriverEffect[]): SeabassAxisState {
  const hasSupportive = effects.includes("supportive");
  const hasLimiting = effects.includes("limiting");
  const hasNeutral = effects.includes("neutral");
  if (hasSupportive && hasLimiting) return "neutral";
  if (hasSupportive) return "supportive";
  if (hasLimiting) return "limiting";
  if (hasNeutral) return "neutral";
  return "unknown";
}

function aggregatePresenceEffects(drivers: readonly SeabassDriver[]): SeabassAxisState {
  const aggregate = aggregateSeabassAxisEffects(drivers.map((entry) => entry.effect));
  const supportiveCount = drivers.filter((entry) => entry.effect === "supportive").length;
  return aggregate === "supportive" && supportiveCount < 2 ? "neutral" : aggregate;
}

function buildPresenceDrivers(
  environmentState: EnvironmentState,
  habitatState: HabitatState,
  habitatNode: HabitatNode
): SeabassDriver[] {
  const supportedHabitatTypes = habitatNode.habitatTypes.filter((value) => SUPPORTED_HABITAT_TYPES.has(value));
  return [
    driver(
      "habitatNode.waterBodyType",
      habitatNode.waterBodyType,
      habitatNode.waterBodyType === "unknown"
        ? "unknown"
        : SUPPORTED_WATER_BODY_TYPES.has(habitatNode.waterBodyType) ? "supportive" : "neutral",
      SUPPORTED_WATER_BODY_TYPES.has(habitatNode.waterBodyType)
        ? "coastal-estuarine-water-body-support"
        : "water-body-context-without-v1-species-effect"
    ),
    driver(
      "habitatNode.habitatTypes",
      [...habitatNode.habitatTypes],
      habitatNode.habitatTypes.length === 0
        ? "unknown"
        : supportedHabitatTypes.length > 0 ? "supportive" : "neutral",
      supportedHabitatTypes.length > 0
        ? "coastal-habitat-type-support"
        : "habitat-type-context-without-v1-species-effect"
    ),
    driver(
      "habitatNode.bayPosition",
      habitatNode.bayPosition ?? null,
      habitatNode.bayPosition == null ? "unknown" : "neutral",
      habitatNode.bayPosition == null ? "bay-position-missing" : "bay-position-context-no-v1-bonus"
    ),
    driver(
      "environmentState.marine.waterTemperatureC",
      environmentState.marine.waterTemperatureC,
      environmentState.marine.waterTemperatureC == null ? "unknown" : "neutral",
      environmentState.marine.waterTemperatureC == null
        ? "water-temperature-missing"
        : "water-temperature-context-no-v1-threshold"
    ),
    driver(
      "habitatState.freshwater.influenceState",
      habitatState.freshwater.influenceState,
      habitatState.freshwater.influenceState === "unknown" ? "unknown" : "neutral",
      habitatState.freshwater.influenceState === "unknown"
        ? "freshwater-influence-unknown"
        : "freshwater-context-without-salinity"
    )
  ];
}

function buildActivationDrivers(habitatState: HabitatState): SeabassDriver[] {
  const exchangeState = habitatState.hydrodynamics.exchangeState;
  const flowEnergyState = habitatState.hydrodynamics.flowEnergyState;
  const tidePhase = habitatState.hydrodynamics.tidePhase;
  const disturbanceState = habitatState.disturbance.state;
  return [
    driver(
      "habitatState.hydrodynamics.exchangeState",
      exchangeState,
      exchangeState === "active" ? "supportive" : exchangeState === "unknown" ? "unknown" : "neutral",
      exchangeState === "active"
        ? "active-water-exchange"
        : exchangeState === "slack" ? "slack-exchange-not-supportive" : "exchange-state-unknown"
    ),
    driver(
      "habitatState.hydrodynamics.flowEnergyState",
      flowEnergyState,
      flowEnergyState === "unknown" ? "unknown" : "neutral",
      flowEnergyState === "unknown" ? "flow-energy-unknown" : "flow-energy-context-no-v1-activation-boost"
    ),
    driver(
      "habitatState.hydrodynamics.tidePhase",
      tidePhase,
      tidePhase === "unknown" ? "unknown" : "neutral",
      tidePhase === "unknown" ? "tide-phase-unknown" : "tide-direction-no-universal-v1-effect"
    ),
    driver(
      "habitatState.disturbance.state",
      disturbanceState,
      disturbanceState === "unknown" ? "unknown" : "neutral",
      disturbanceState === "unknown" ? "disturbance-state-unknown" : "disturbance-context-not-observed-feeding"
    )
  ];
}

function buildShoreCatchabilityDrivers(habitatState: HabitatState, habitatNode: HabitatNode): SeabassDriver[] {
  return [
    energyDriver("habitatState.exposure.windState", habitatState.exposure.windState, "wind"),
    driver(
      "habitatState.exposure.directionalExposure",
      habitatState.exposure.directionalExposure,
      habitatState.exposure.directionalExposure === "sheltered"
        ? "supportive"
        : habitatState.exposure.directionalExposure === "exposed" ? "limiting" : "unknown",
      habitatState.exposure.directionalExposure === "sheltered"
        ? "sheltered-directional-exposure"
        : habitatState.exposure.directionalExposure === "exposed"
          ? "exposed-directional-condition"
          : "directional-exposure-unknown"
    ),
    ...classifiedPhysicalDrivers(
      "habitatState.exposure.waveHeightM",
      habitatState.exposure.waveHeightM,
      "habitatState.exposure.waveState",
      habitatState.exposure.waveState,
      "wave"
    ),
    ...classifiedPhysicalDrivers(
      "habitatState.exposure.currentSpeedMps",
      habitatState.exposure.currentSpeedMps,
      "habitatState.exposure.currentState",
      habitatState.exposure.currentState,
      "current"
    ),
    energyDriver("habitatState.hydrodynamics.flowEnergyState", habitatState.hydrodynamics.flowEnergyState, "flow"),
    driver(
      "habitatNode.habitatTypes",
      [...habitatNode.habitatTypes],
      habitatNode.habitatTypes.length ? "neutral" : "unknown",
      habitatNode.habitatTypes.length
        ? "habitat-context-without-accessibility-inference"
        : "habitat-context-missing"
    )
  ];
}

function energyDriver(
  input: string,
  state: HabitatStateEnergy,
  kind: "wind" | "wave" | "current" | "flow",
  unknownReason = `${kind}-physical-state-missing`
): SeabassDriver {
  if (state === "unknown") {
    return driver(input, state, "unknown", unknownReason);
  }
  if (state === "strong") return driver(input, state, "limiting", `strong-${kind}-physical-difficulty`);
  if (state === "weak") return driver(input, state, "supportive", `weak-${kind}-physical-condition`);
  return driver(input, state, "neutral", `moderate-${kind}-physical-condition`);
}

function classifiedPhysicalDrivers(
  rawInput: string,
  rawValue: number | null,
  stateInput: string,
  state: HabitatStateEnergy,
  kind: "wave" | "current"
): SeabassDriver[] {
  return [
    driver(
      rawInput,
      rawValue,
      rawValue == null ? "unknown" : "neutral",
      rawValue == null ? `${kind}-raw-value-missing` : `${kind}-raw-value-no-v1-threshold`
    ),
    energyDriver(
      stateInput,
      state,
      kind,
      rawValue == null ? `${kind}-physical-state-missing` : `${kind}-classification-rule-undefined`
    )
  ];
}

function shoreCatchabilityUnknownReasons(habitatState: HabitatState): string[] {
  return uniqueStrings([
    ...(habitatState.exposure.directionalExposure === "unknown" ? ["directional-exposure-unknown"] : []),
    ...(habitatState.exposure.waveState === "unknown"
      ? [habitatState.exposure.waveHeightM == null ? "wave-state-missing" : "wave-classification-rule-undefined"]
      : []),
    ...(habitatState.exposure.currentState === "unknown"
      ? [habitatState.exposure.currentSpeedMps == null ? "current-state-missing" : "current-classification-rule-undefined"]
      : [])
  ]);
}

function seabassStateDerivations(): SeabassStateDerivation[] {
  return [
    {
      field: "presence",
      inputs: [
        "habitatNode.waterBodyType",
        "habitatNode.habitatTypes",
        "habitatNode.bayPosition",
        "environmentState.marine.waterTemperatureC",
        "habitatState.freshwater.influenceState"
      ],
      ruleVersion: SEABASS_STATE_RULE_VERSION
    },
    {
      field: "activation",
      inputs: [
        "habitatState.hydrodynamics.exchangeState",
        "habitatState.hydrodynamics.flowEnergyState",
        "habitatState.hydrodynamics.tidePhase",
        "habitatState.disturbance.state"
      ],
      ruleVersion: SEABASS_STATE_RULE_VERSION
    },
    {
      field: "shoreCatchability",
      inputs: [
        "habitatState.exposure.windState",
        "habitatState.exposure.directionalExposure",
        "habitatState.exposure.waveState",
        "habitatState.exposure.currentState",
        "habitatState.hydrodynamics.flowEnergyState",
        "habitatNode.habitatTypes"
      ],
      ruleVersion: SEABASS_STATE_RULE_VERSION
    }
  ];
}

function driver(
  input: string,
  value: SeabassDriverValue,
  effect: SeabassDriverEffect,
  reason: string
): SeabassDriver {
  return { input, value, effect, reason };
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
