import { describe, expect, it } from "vitest";
import { type EnvironmentState } from "./environment-state";
import { createHabitatNodeFromEnvironmentNode } from "./habitat-fixtures";
import {
  buildHabitatState,
  classifyFlowEnergyState
} from "./habitat-state";

const AS_OF = "2026-08-15T03:00:00.000Z";
const MAKUHARI_NODE = createHabitatNodeFromEnvironmentNode({
  id: "makuhari-shallow-01",
  name: "Makuhari shallow environmental node",
  latitude: 35.62,
  longitude: 140.03,
  area: "Tokyo Bay inner",
  waterType: "shallow_flat"
});

describe("Wanoku Habitat State v1", () => {
  it("is deterministic for the same Environment State, habitat node and asOf", () => {
    const input = {
      environmentState: environmentState(),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    };

    expect(buildHabitatState(input)).toEqual(buildHabitatState(input));
  });

  it("derives the production-like Makuhari physical state without species interpretation", () => {
    const state = buildHabitatState({
      environmentState: environmentState(),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state).toMatchObject({
      schemaVersion: "wanoku-habitat-state.v1",
      nodeId: "makuhari-shallow-01",
      asOf: AS_OF,
      context: {
        waterBodyType: "bay",
        habitatTypes: ["shallow"],
        depthBand: "unknown"
      },
      hydrodynamics: {
        tidePhase: "falling",
        tideSlopeCmPerHour: -24,
        waterLevelState: "unknown",
        exchangeState: "active",
        flowEnergyState: "strong"
      },
      exposure: {
        windState: "moderate",
        directionalExposure: "unknown",
        waveHeightM: null,
        waveState: "unknown",
        currentSpeedMps: null,
        currentState: "unknown"
      },
      freshwater: {
        influenceState: "unknown"
      },
      disturbance: {
        state: "energetic"
      }
    });
  });

  it("keeps the weak, moderate and strong flow boundaries explicit", () => {
    expect(classifyFlowEnergyState(4.999)).toBe("weak");
    expect(classifyFlowEnergyState(-4.999)).toBe("weak");
    expect(classifyFlowEnergyState(5)).toBe("moderate");
    expect(classifyFlowEnergyState(20)).toBe("moderate");
    expect(classifyFlowEnergyState(20.001)).toBe("strong");
    expect(classifyFlowEnergyState(-24)).toBe("strong");
  });

  it("keeps missing tide-derived states unknown", () => {
    const state = buildHabitatState({
      environmentState: environmentState({
        tide: { levelCm: null, slopeCmPerHour: null, phase: "unknown" }
      }),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.hydrodynamics).toMatchObject({
      tidePhase: "unknown",
      flowEnergyState: "unknown",
      exchangeState: "unknown",
      waterLevelState: "unknown"
    });
    expect(state.quality.unknownStateFields).toEqual(expect.arrayContaining([
      "hydrodynamics.tidePhase",
      "hydrodynamics.flowEnergyState",
      "hydrodynamics.exchangeState"
    ]));
  });

  it("preserves stale inputs and null aggregate confidence without inventing a score", () => {
    const state = buildHabitatState({
      environmentState: environmentState({ staleAtmosphere: true, overallConfidence: null }),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.quality.inputStaleComponents).toEqual(["atmosphere"]);
    expect(state.quality.inputOverallConfidence).toBeNull();
  });

  it("keeps directional exposure unknown for an unsupported direction convention", () => {
    const state = buildHabitatState({
      environmentState: environmentState({
        unsupportedDirectionConvention: true,
        marine: { waveDirectionDeg: 170, currentDirectionDeg: 90 }
      }),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.exposure.directionalExposure).toBe("unknown");
    expect(state.diagnostics.unknownStateReasons).toContainEqual({
      field: "exposure.directionalExposure",
      reasons: ["unsupported-direction-convention"]
    });
  });

  it("does not classify freshwater influence as low from zero instantaneous precipitation", () => {
    const state = buildHabitatState({
      environmentState: environmentState({ precipitationMm: 0 }),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.freshwater.influenceState).toBe("unknown");
    expect(unknownReasons(state, "freshwater.influenceState")).toContain("instantaneous-precipitation-insufficient");
  });

  it("does not classify freshwater influence as high from river-mouth metadata alone", () => {
    const riverMouth = createHabitatNodeFromEnvironmentNode({
      id: "sumida-arakawa-mouth-01",
      name: "Sumida-Arakawa river mouth environmental node",
      latitude: 35.64,
      longitude: 139.815,
      area: "Tokyo Bay inner",
      waterType: "river_mouth"
    });
    const state = buildHabitatState({
      environmentState: environmentState({ nodeId: riverMouth.id, precipitationMm: 0 }),
      habitatNode: riverMouth,
      asOf: AS_OF
    });

    expect(state.freshwater.influenceState).toBe("unknown");
    expect(unknownReasons(state, "freshwater.influenceState")).toContain("river-mouth-classification-insufficient");
  });

  it("handles unavailable wave and current facts explicitly", () => {
    const state = buildHabitatState({
      environmentState: environmentState(),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.exposure.waveState).toBe("unknown");
    expect(state.exposure.currentState).toBe("unknown");
    expect(unknownReasons(state, "exposure.waveState")).toEqual(["wave-height-missing"]);
    expect(unknownReasons(state, "exposure.currentState")).toEqual(["current-speed-missing"]);
    expect(state.quality.unknownStateFields).toEqual(expect.arrayContaining([
      "exposure.waveState",
      "exposure.currentState"
    ]));
  });

  it("preserves raw wave and current values while marking their classification rule undefined", () => {
    const state = buildHabitatState({
      environmentState: environmentState({
        marine: {
          waterTemperatureC: 24.6,
          waveHeightM: 0.7,
          wavePeriodS: 5.5,
          waveDirectionDeg: 120,
          currentSpeedMps: 0.4,
          currentDirectionDeg: 95,
          seaLevelM: 0.18,
          sourceCollectedAt: "2026-08-15T02:45:00.000Z",
          sourceProviderIds: ["open-meteo-marine"]
        }
      }),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });

    expect(state.exposure).toMatchObject({
      waveHeightM: 0.7,
      waveState: "unknown",
      currentSpeedMps: 0.4,
      currentState: "unknown"
    });
    expect(unknownReasons(state, "exposure.waveState")).toEqual(["wave-classification-rule-undefined"]);
    expect(unknownReasons(state, "exposure.currentState")).toEqual(["current-classification-rule-undefined"]);
  });

  it("records compact derivation provenance for each derived state", () => {
    const state = buildHabitatState({
      environmentState: environmentState(),
      habitatNode: MAKUHARI_NODE,
      asOf: AS_OF
    });
    const flow = state.provenance.derivations.find((entry) => entry.field === "hydrodynamics.flowEnergyState");

    expect(flow).toEqual({
      field: "hydrodynamics.flowEnergyState",
      inputs: ["environmentState.tide.slopeCmPerHour"],
      ruleVersion: "wanoku-habitat-state-rules.v1"
    });
    expect(state.provenance.environmentStateSchemaVersion).toBe("wanoku-environment-state.v1");
    expect(state.provenance.derivations.length).toBeGreaterThan(0);
  });
});

function environmentState(overrides: {
  nodeId?: string;
  tide?: Partial<EnvironmentState["tide"]>;
  precipitationMm?: number | null;
  staleAtmosphere?: boolean;
  overallConfidence?: number | null;
  unsupportedDirectionConvention?: boolean;
  marine?: Partial<EnvironmentState["marine"]>;
} = {}): EnvironmentState {
  const nodeId = overrides.nodeId ?? MAKUHARI_NODE.id;
  const staleAtmosphere = overrides.staleAtmosphere ?? false;
  const missingComponents: string[] = [];
  return {
    schemaVersion: "wanoku-environment-state.v1",
    nodeId,
    asOf: AS_OF,
    tide: {
      levelCm: 39,
      levelM: 0.39,
      levelTpM: null,
      slopeCmPerHour: -24,
      phase: "falling",
      stationId: "CB",
      observedAt: AS_OF,
      sourceCollectedAt: "2026-08-14T02:20:19.400Z",
      forecastIssuedAt: "2025-02-21T06:21:31.000Z",
      ...overrides.tide
    },
    atmosphere: {
      windSpeedMps: 5.08,
      windDirectionDeg: 80,
      precipitationMm: overrides.precipitationMm ?? 0,
      pressureHpa: 1010.2,
      airTemperatureC: 25.3,
      sourceCollectedAt: "2026-08-15T02:45:00.000Z",
      sourceProviderIds: ["open-meteo-weather"]
    },
    marine: {
      waterTemperatureC: null,
      waveHeightM: null,
      wavePeriodS: null,
      waveDirectionDeg: null,
      currentSpeedMps: null,
      currentDirectionDeg: null,
      seaLevelM: null,
      sourceCollectedAt: null,
      sourceProviderIds: [],
      ...overrides.marine
    },
    freshness: {
      atmosphere: {
        sourceTimestamp: "2026-08-15T02:45:00.000Z",
        ageHours: 0.25,
        freshness: 0.9,
        stale: staleAtmosphere
      },
      tide: {
        sourceTimestamp: "2026-08-14T02:20:19.400Z",
        ageHours: 24.660167,
        freshness: null,
        stale: null
      },
      missingComponents
    },
    quality: {
      atmosphere: {
        qualityReportCount: 1,
        staleCount: staleAtmosphere ? 1 : 0,
        warningCounts: {},
        missingRate: 0,
        confidence: 0.9,
        freshness: 0.9,
        providerQuality: {}
      },
      tide: null,
      overall: {
        confidence: overrides.overallConfidence === undefined ? 0.9 : overrides.overallConfidence,
        missingRate: 0,
        missingComponentCount: 0,
        missingComponents,
        staleComponents: staleAtmosphere ? ["atmosphere"] : []
      }
    },
    provenance: {
      habitatGraphVersion: "wanoku-habitat-graph.v1",
      environmentalFeatureSchemaVersion: "wanoku-node-environmental-features.v1",
      hydroCoastalFeatureSchemaVersion: "wanoku-node-hydro-coastal-features.v1",
      environmental: overrides.unsupportedDirectionConvention
        ? [{
            field: "windVectorEast",
            nodeId,
            missingReasons: ["unsupported-direction-convention"]
          }]
        : [],
      tide: []
    },
    diagnostics: {
      environmentalErrors: [],
      environmentalWarnings: [],
      hydroCoastalErrors: [],
      hydroCoastalWarnings: [],
      tideMissingReasons: []
    }
  };
}

function unknownReasons(state: ReturnType<typeof buildHabitatState>, field: string): string[] {
  return state.diagnostics.unknownStateReasons.find((entry) => entry.field === field)?.reasons ?? [];
}
