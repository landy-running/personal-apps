import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type EnvironmentState } from "./environment-state";
import { type HabitatNode } from "./habitat";
import { createHabitatNodeFromEnvironmentNode } from "./habitat-fixtures";
import { buildHabitatState, type HabitatState } from "./habitat-state";
import {
  aggregateSeabassAxisEffects,
  buildSeabassState
} from "./seabass-state";

const AS_OF = "2026-08-15T03:00:00.000Z";
const MAKUHARI_NODE = createHabitatNodeFromEnvironmentNode({
  id: "makuhari-shallow-01",
  name: "Makuhari shallow environmental node",
  latitude: 35.62,
  longitude: 140.03,
  area: "Tokyo Bay inner",
  waterType: "shallow_flat"
});

describe("Wanoku Seabass State v1", () => {
  it("is deterministic for the same states, habitat node and asOf", () => {
    const environment = environmentState();
    const habitat = habitatState(environment);
    const input = { environmentState: environment, habitatState: habitat, habitatNode: MAKUHARI_NODE, asOf: AS_OF };

    expect(buildSeabassState(input)).toEqual(buildSeabassState(input));
  });

  it("keeps the species core free of clocks, randomness, network and writes", () => {
    const source = readFileSync(new URL("./seabass-state.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\.run\s*\(/);
    expect(source).not.toMatch(/\.batch\s*\(/);
  });

  it("treats active exchange as a supportive activation driver", () => {
    const state = makuhariSeabassState();
    const exchange = driverFor(state.activation.drivers, "habitatState.hydrodynamics.exchangeState");

    expect(exchange).toMatchObject({ value: "active", effect: "supportive", reason: "active-water-exchange" });
    expect(state.activation.state).toBe("supportive");
  });

  it.each(["falling", "rising"] as const)("does not give %s tide an automatic activation effect", (phase) => {
    const state = seabassState({
      habitat: {
        hydrodynamics: {
          tidePhase: phase,
          tideSlopeCmPerHour: null,
          exchangeState: "unknown",
          flowEnergyState: "unknown"
        },
        disturbance: { state: "unknown" }
      }
    });
    const tide = driverFor(state.activation.drivers, "habitatState.hydrodynamics.tidePhase");

    expect(tide.effect).toBe("neutral");
    expect(state.activation.state).toBe("neutral");
  });

  it("keeps strong flow as activation context instead of an automatic boost", () => {
    const state = seabassState({
      habitat: {
        hydrodynamics: {
          tidePhase: "unknown",
          tideSlopeCmPerHour: -24,
          exchangeState: "unknown",
          flowEnergyState: "strong"
        },
        disturbance: { state: "unknown" }
      }
    });
    const flow = driverFor(state.activation.drivers, "habitatState.hydrodynamics.flowEnergyState");

    expect(flow.effect).toBe("neutral");
    expect(state.activation.state).toBe("neutral");
  });

  it("does not let water temperature alone determine presence support", () => {
    const unknownNode = unknownHabitatNode("unknown-temperature-node");
    const environment = environmentState({ nodeId: unknownNode.id });
    const state = seabassState({ environment, node: unknownNode });
    const temperature = driverFor(state.presence.drivers, "environmentState.marine.waterTemperatureC");

    expect(temperature).toMatchObject({ value: 27.6, effect: "neutral" });
    expect(state.presence.state).toBe("neutral");
  });

  it("does not let river-mouth waterBodyType alone determine supportive presence", () => {
    const riverMouth = {
      ...createHabitatNodeFromEnvironmentNode({
        id: "river-mouth-only",
        name: "River mouth only",
        latitude: 35.64,
        longitude: 139.815,
        area: "Tokyo Bay inner",
        waterType: "river_mouth"
      }),
      habitatTypes: []
    } satisfies HabitatNode;
    const environment = environmentState({ nodeId: riverMouth.id, waterTemperatureC: null });
    const state = seabassState({ environment, node: riverMouth });

    expect(driverFor(state.presence.drivers, "habitatNode.waterBodyType").effect).toBe("supportive");
    expect(state.presence.state).toBe("neutral");
    expect(state.presence.constraints).toContain("direct-fish-evidence-absent");
  });

  it("keeps stale atmosphere in quality instead of turning it into a biological negative", () => {
    const stale = makuhariSeabassState();
    const freshEnvironment = environmentState({ staleAtmosphere: false });
    const fresh = seabassState({ environment: freshEnvironment });

    expect(stale.quality.staleInputs).toEqual(["atmosphere"]);
    expect(stale.presence.state).toBe(fresh.presence.state);
    expect(stale.activation.state).toBe(fresh.activation.state);
    expect(stale.presence.drivers.some((entry) => entry.effect === "limiting")).toBe(false);
  });

  it("makes absent direct fish evidence explicit and accepts null confidence", () => {
    const state = makuhariSeabassState();

    expect(state.quality.inputOverallConfidence).toBeNull();
    expect(state.quality.directFishEvidenceAbsent).toBe(true);
    expect(state.presence.constraints).toContain("direct-fish-evidence-absent");
  });

  it("keeps shore catchability unknown when direction and wave/current classifications are unresolved", () => {
    const state = makuhariSeabassState();

    expect(state.shoreCatchability.state).toBe("unknown");
    expect(state.shoreCatchability.constraints).toEqual(expect.arrayContaining([
      "directional-exposure-unknown",
      "wave-classification-rule-undefined",
      "current-classification-rule-undefined"
    ]));
    expect(state.diagnostics.unknownAxisReasons).toContainEqual({
      field: "shoreCatchability.state",
      reasons: [
        "directional-exposure-unknown",
        "wave-classification-rule-undefined",
        "current-classification-rule-undefined"
      ]
    });
  });

  it("distinguishes missing wave/current values from undefined classification rules", () => {
    const environment = environmentState({
      waveHeightM: null,
      currentSpeedMps: null
    });
    const state = seabassState({ environment });

    expect(state.shoreCatchability.constraints).toEqual(expect.arrayContaining([
      "wave-state-missing",
      "current-state-missing"
    ]));
  });

  it("aggregates supportive and limiting effects deterministically", () => {
    expect(aggregateSeabassAxisEffects(["supportive", "limiting", "unknown"])).toBe("neutral");
    expect(aggregateSeabassAxisEffects(["limiting", "supportive", "unknown"])).toBe("neutral");

    const state = seabassState({
      habitat: {
        hydrodynamics: {
          tidePhase: "falling",
          tideSlopeCmPerHour: -24,
          exchangeState: "active",
          flowEnergyState: "strong"
        },
        exposure: {
          windState: "weak",
          directionalExposure: "sheltered",
          waveHeightM: 0.1,
          waveState: "weak",
          currentSpeedMps: 0.2,
          currentState: "weak"
        }
      }
    });
    expect(state.shoreCatchability.state).toBe("neutral");
  });

  it("returns unknown axes when every relevant input is unknown", () => {
    const node = unknownHabitatNode("all-unknown-node");
    const environment = environmentState({
      nodeId: node.id,
      allUnknown: true
    });
    const state = seabassState({ environment, node });

    expect(state.presence.state).toBe("unknown");
    expect(state.activation.state).toBe("unknown");
    expect(state.shoreCatchability.state).toBe("unknown");
  });

  it("derives the conservative production-like Makuhari result", () => {
    const state = makuhariSeabassState();

    expect(state).toMatchObject({
      schemaVersion: "wanoku-seabass-state.v1",
      species: {
        id: "japanese-seabass",
        scientificName: "Lateolabrax japonicus"
      },
      nodeId: "makuhari-shallow-01",
      asOf: AS_OF,
      presence: { state: "supportive" },
      activation: { state: "supportive" },
      shoreCatchability: { state: "unknown" },
      quality: {
        inputOverallConfidence: null,
        staleInputs: ["atmosphere"],
        directFishEvidenceAbsent: true
      }
    });
    expect(driverFor(state.presence.drivers, "environmentState.marine.waterTemperatureC").effect).toBe("neutral");
    expect(driverFor(state.activation.drivers, "habitatState.hydrodynamics.tidePhase").effect).toBe("neutral");
    expect(driverFor(state.activation.drivers, "habitatState.hydrodynamics.flowEnergyState").effect).toBe("neutral");
    expect(driverFor(state.shoreCatchability.drivers, "habitatState.exposure.waveHeightM")).toMatchObject({
      value: 0.1,
      effect: "neutral",
      reason: "wave-raw-value-no-v1-threshold"
    });
    expect(driverFor(state.shoreCatchability.drivers, "habitatState.exposure.currentSpeedMps")).toMatchObject({
      value: 0.2,
      effect: "neutral",
      reason: "current-raw-value-no-v1-threshold"
    });
    expect(driverFor(state.shoreCatchability.drivers, "habitatState.hydrodynamics.flowEnergyState").effect).toBe("limiting");
    expect(state.provenance.derivations.map((entry) => entry.field)).toEqual([
      "presence",
      "activation",
      "shoreCatchability"
    ]);
  });
});

function makuhariSeabassState() {
  return seabassState();
}

function seabassState(options: {
  environment?: EnvironmentState;
  node?: HabitatNode;
  habitat?: {
    hydrodynamics?: Partial<HabitatState["hydrodynamics"]>;
    exposure?: Partial<HabitatState["exposure"]>;
    disturbance?: Partial<HabitatState["disturbance"]>;
  };
} = {}) {
  const node = options.node ?? MAKUHARI_NODE;
  const environment = options.environment ?? environmentState({ nodeId: node.id });
  const habitat = habitatState(environment, node, options.habitat);
  return buildSeabassState({
    environmentState: environment,
    habitatState: habitat,
    habitatNode: node,
    asOf: AS_OF
  });
}

function habitatState(
  environment: EnvironmentState,
  node: HabitatNode = MAKUHARI_NODE,
  overrides: {
    hydrodynamics?: Partial<HabitatState["hydrodynamics"]>;
    exposure?: Partial<HabitatState["exposure"]>;
    disturbance?: Partial<HabitatState["disturbance"]>;
  } = {}
): HabitatState {
  const base = buildHabitatState({ environmentState: environment, habitatNode: node, asOf: AS_OF });
  return {
    ...base,
    hydrodynamics: { ...base.hydrodynamics, ...overrides.hydrodynamics },
    exposure: { ...base.exposure, ...overrides.exposure },
    disturbance: { ...base.disturbance, ...overrides.disturbance }
  };
}

function environmentState(options: {
  nodeId?: string;
  waterTemperatureC?: number | null;
  waveHeightM?: number | null;
  currentSpeedMps?: number | null;
  staleAtmosphere?: boolean;
  allUnknown?: boolean;
} = {}): EnvironmentState {
  const nodeId = options.nodeId ?? MAKUHARI_NODE.id;
  const allUnknown = options.allUnknown ?? false;
  const staleAtmosphere = options.staleAtmosphere ?? true;
  const missingComponents = allUnknown
    ? [
        "tide.levelCm",
        "tide.slopeCmPerHour",
        "atmosphere.windSpeedMps",
        "marine.waterTemperatureC",
        "marine.waveHeightM",
        "marine.currentSpeedMps"
      ]
    : [];
  return {
    schemaVersion: "wanoku-environment-state.v1",
    nodeId,
    asOf: AS_OF,
    tide: {
      levelCm: allUnknown ? null : 39,
      levelM: allUnknown ? null : 0.39,
      levelTpM: null,
      slopeCmPerHour: allUnknown ? null : -24,
      phase: allUnknown ? "unknown" : "falling",
      stationId: allUnknown ? null : "CB",
      observedAt: allUnknown ? null : AS_OF,
      sourceCollectedAt: allUnknown ? null : "2026-08-14T02:20:19.400Z",
      forecastIssuedAt: allUnknown ? null : "2025-02-21T06:21:31.000Z"
    },
    atmosphere: {
      windSpeedMps: allUnknown ? null : 5.08,
      windDirectionDeg: allUnknown ? null : 80,
      precipitationMm: allUnknown ? null : 0,
      pressureHpa: allUnknown ? null : 1010.2,
      airTemperatureC: allUnknown ? null : 25.3,
      sourceCollectedAt: allUnknown ? null : "2026-08-15T02:45:00.000Z",
      sourceProviderIds: allUnknown ? [] : ["open-meteo-weather"]
    },
    marine: {
      waterTemperatureC: allUnknown ? null : options.waterTemperatureC === undefined ? 27.6 : options.waterTemperatureC,
      waveHeightM: allUnknown ? null : options.waveHeightM === undefined ? 0.1 : options.waveHeightM,
      wavePeriodS: allUnknown ? null : 7.6,
      waveDirectionDeg: allUnknown ? null : 192,
      currentSpeedMps: allUnknown ? null : options.currentSpeedMps === undefined ? 0.2 : options.currentSpeedMps,
      currentDirectionDeg: allUnknown ? null : 270,
      seaLevelM: allUnknown ? null : 0.48,
      sourceCollectedAt: allUnknown ? null : "2026-08-15T02:45:00.000Z",
      sourceProviderIds: allUnknown ? [] : ["open-meteo-marine"]
    },
    freshness: {
      atmosphere: {
        sourceTimestamp: allUnknown ? null : "2026-08-15T02:45:00.000Z",
        ageHours: allUnknown ? null : 0.25,
        freshness: allUnknown ? null : 0.9,
        stale: allUnknown ? null : staleAtmosphere
      },
      tide: {
        sourceTimestamp: allUnknown ? null : "2026-08-14T02:20:19.400Z",
        ageHours: allUnknown ? null : 24.660167,
        freshness: null,
        stale: null
      },
      missingComponents
    },
    quality: {
      atmosphere: {
        qualityReportCount: allUnknown ? 0 : 1,
        staleCount: staleAtmosphere && !allUnknown ? 1 : 0,
        warningCounts: {},
        missingRate: allUnknown ? null : 0,
        confidence: null,
        freshness: allUnknown ? null : 0.9,
        providerQuality: {}
      },
      tide: null,
      overall: {
        confidence: null,
        missingRate: allUnknown ? 1 : 0,
        missingComponentCount: missingComponents.length,
        missingComponents,
        staleComponents: staleAtmosphere && !allUnknown ? ["atmosphere"] : []
      }
    },
    provenance: {
      habitatGraphVersion: "wanoku-habitat-graph.v1",
      environmentalFeatureSchemaVersion: "wanoku-node-environmental-features.v1",
      hydroCoastalFeatureSchemaVersion: "wanoku-node-hydro-coastal-features.v1",
      environmental: allUnknown
        ? []
        : [{
            field: "waveVectorEast",
            nodeId,
            missingReasons: ["unsupported-direction-convention"]
          }],
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

function unknownHabitatNode(id: string): HabitatNode {
  return createHabitatNodeFromEnvironmentNode({
    id,
    name: "Unknown habitat node",
    latitude: 35.5,
    longitude: 139.8,
    area: "Unknown",
    waterType: "unclassified"
  });
}

function driverFor(drivers: ReturnType<typeof makuhariSeabassState>["activation"]["drivers"], input: string) {
  const driver = drivers.find((entry) => entry.input === input);
  expect(driver).toBeDefined();
  return driver!;
}
