import { describe, expect, it } from "vitest";
import {
  calculateEnvironmentalQuality,
  type EnvironmentalSnapshot
} from "./environment";
import {
  HYDRO_COASTAL_SCHEMA_VERSION,
  type HydroCoastalObservation,
  type HydroCoastalStationNodeMapping
} from "./hydro-coastal";
import { createInitialHabitatGraph, type EnvironmentNodeSeed } from "./habitat-fixtures";
import { buildEnvironmentState } from "./environment-state";
import { JMA_TIDE_PREDICTION_STATIONS_2026 } from "./jma-tide-prediction";
import { buildJmaTidePredictionStationNodeMappings2026 } from "./jma-tide-prediction-mappings";

const GENERATED_AT = "2026-07-14T00:00:00.000Z";
const REVIEWED_AT = "2026-07-14T00:00:00.000Z";
const TARGET_AT = "2026-07-13T06:00:00.000Z";
const NEXT_TARGET_AT = "2026-07-13T07:00:00.000Z";
const LOOKBACK_1H = "2026-07-13T05:00:00.000Z";
const COLLECTED_AT = "2026-07-13T04:00:00.000Z";
const FORECAST_ISSUED_AT = "2025-02-21T06:21:31.000Z";

describe("Wanoku Environment State v1", () => {
  it("is deterministic for the same input data and asOf", () => {
    const input = {
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [snapshot({ windSpeed: 4 })],
      hydroCoastalObservations: [
        observation("TK", TARGET_AT, 110),
        observation("TK", LOOKBACK_1H, 100)
      ],
      hydroCoastalStationNodeMappings: mappings()
    };

    expect(buildEnvironmentState(input)).toEqual(buildEnvironmentState(input));
  });

  it("passes existing marine feature values through with field provenance", () => {
    const state = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [snapshot({
        source: "open-meteo-marine",
        seaSurfaceTemperature: 24.6,
        waveHeight: 0.7,
        wavePeriod: 5.5,
        waveDirection: 120,
        oceanCurrentVelocity: 0.4,
        oceanCurrentDirection: 95,
        seaLevelHeightMsl: 0.18
      })],
      hydroCoastalObservations: [],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.marine).toEqual({
      waterTemperatureC: 24.6,
      waveHeightM: 0.7,
      wavePeriodS: 5.5,
      waveDirectionDeg: 120,
      currentSpeedMps: 0.4,
      currentDirectionDeg: 95,
      seaLevelM: 0.18,
      sourceCollectedAt: COLLECTED_AT,
      sourceProviderIds: ["open-meteo-marine"]
    });
    for (const field of ["waterTemperatureC", "waveHeightM", "currentSpeedMps"]) {
      expect(state.provenance.environmental).toContainEqual(expect.objectContaining({
        field,
        providerId: "open-meteo-marine",
        collectedAt: COLLECTED_AT,
        missingReasons: []
      }));
    }
  });

  it("uses the correct environmental and tide value for different asOf timestamps", () => {
    const base = {
      nodeId: "tokyo-inner-bay-01",
      habitatGraph: graph(),
      environmentalSnapshots: [
        snapshot({ observedAt: TARGET_AT, collectedAt: TARGET_AT, windSpeed: 4 }),
        snapshot({ observedAt: NEXT_TARGET_AT, collectedAt: NEXT_TARGET_AT, windSpeed: 7 })
      ],
      hydroCoastalObservations: [
        observation("TK", TARGET_AT, 100),
        observation("TK", LOOKBACK_1H, 90),
        observation("TK", NEXT_TARGET_AT, 120)
      ],
      hydroCoastalStationNodeMappings: mappings()
    };

    const atSix = buildEnvironmentState({ ...base, asOf: TARGET_AT });
    const atSeven = buildEnvironmentState({ ...base, asOf: NEXT_TARGET_AT });

    expect(atSix.atmosphere.windSpeedMps).toBe(4);
    expect(atSix.tide.levelCm).toBe(100);
    expect(atSeven.atmosphere.windSpeedMps).toBe(7);
    expect(atSeven.tide.levelCm).toBe(120);
  });

  it("does not use future environmental observations or future hydro revisions", () => {
    const state = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [
        snapshot({ observedAt: LOOKBACK_1H, collectedAt: LOOKBACK_1H, windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T06:30:00.000Z", collectedAt: LOOKBACK_1H, windSpeed: 99 })
      ],
      hydroCoastalObservations: [
        observation("TK", TARGET_AT, 100, { collectedAt: LOOKBACK_1H }),
        observation("TK", TARGET_AT, 999, { collectedAt: "2026-07-13T06:30:00.000Z" }),
        observation("TK", LOOKBACK_1H, 90, { collectedAt: LOOKBACK_1H })
      ],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.atmosphere.windSpeedMps).toBe(4);
    expect(state.tide.levelCm).toBe(100);
    expect(state.diagnostics.environmentalWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("observedAt is after calculatedAt")
    ]));
    expect(state.diagnostics.hydroCoastalWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("future hydro-coastal revision excluded")
    ]));
  });

  it("derives tide phase from the existing 1h trend feature", () => {
    expect(stateForTide(100, 90).tide.phase).toBe("rising");
    expect(stateForTide(80, 90).tide.phase).toBe("falling");
    expect(stateForTide(90, 90).tide.phase).toBe("slack");
    expect(buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [],
      hydroCoastalObservations: [observation("TK", TARGET_AT, 90)],
      hydroCoastalStationNodeMappings: mappings()
    }).tide.phase).toBe("unknown");
  });

  it("keeps environmental missing values explicit", () => {
    const state = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [],
      hydroCoastalObservations: [
        observation("TK", TARGET_AT, 100),
        observation("TK", LOOKBACK_1H, 90)
      ],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.atmosphere.windSpeedMps).toBeNull();
    expect(state.marine).toEqual({
      waterTemperatureC: null,
      waveHeightM: null,
      wavePeriodS: null,
      waveDirectionDeg: null,
      currentSpeedMps: null,
      currentDirectionDeg: null,
      seaLevelM: null,
      sourceCollectedAt: null,
      sourceProviderIds: []
    });
    expect(state.freshness.missingComponents).toEqual(expect.arrayContaining([
      "atmosphere.windSpeedMps",
      "atmosphere.pressureHpa",
      "marine.waterTemperatureC",
      "marine.waveHeightM",
      "marine.currentSpeedMps"
    ]));
  });

  it("keeps tide missing values explicit while preserving the mapped station", () => {
    const state = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [snapshot()],
      hydroCoastalObservations: [],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.tide.levelCm).toBeNull();
    expect(state.tide.phase).toBe("unknown");
    expect(state.tide.stationId).toBe("TK");
    expect(state.freshness.missingComponents).toEqual(expect.arrayContaining(["tide.levelCm"]));
  });

  it("distinguishes stale environmental data from fresh data using existing quality reports", () => {
    const oldSnapshot = snapshot({
      observedAt: "2026-07-13T06:00:00.000Z",
      collectedAt: "2026-07-13T06:00:00.000Z"
    });
    const stale = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: "2026-07-15T06:00:00.000Z",
      habitatGraph: graph(),
      environmentalSnapshots: [oldSnapshot],
      environmentalQualityReports: [calculateEnvironmentalQuality(oldSnapshot, "2026-07-15T06:00:00.000Z")],
      hydroCoastalObservations: [],
      hydroCoastalStationNodeMappings: mappings()
    });
    const fresh = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: "2026-07-13T07:00:00.000Z",
      habitatGraph: graph(),
      environmentalSnapshots: [oldSnapshot],
      environmentalQualityReports: [calculateEnvironmentalQuality(oldSnapshot, "2026-07-13T07:00:00.000Z")],
      hydroCoastalObservations: [],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(stale.freshness.atmosphere.stale).toBe(true);
    expect(stale.quality.overall.staleComponents).toEqual(["atmosphere"]);
    expect(fresh.freshness.atmosphere.stale).toBe(false);
    expect(stale.freshness.atmosphere.ageHours).toBe(48);
  });

  it("retains environmental and tide provenance", () => {
    const state = buildEnvironmentState({
      nodeId: "tokyo-inner-bay-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [snapshot()],
      hydroCoastalObservations: [
        observation("TK", TARGET_AT, 100),
        observation("TK", LOOKBACK_1H, 90)
      ],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.provenance.environmental.some((entry) => entry.field === "windSpeedMps")).toBe(true);
    expect(state.provenance.tide.some((entry) => entry.field === "tideLevelCm")).toBe(true);
  });

  it("uses the existing JMA station-to-habitat-node bridge for tide station mapping", () => {
    const state = buildEnvironmentState({
      nodeId: "keihin-canal-01",
      asOf: TARGET_AT,
      habitatGraph: graph(),
      environmentalSnapshots: [],
      hydroCoastalObservations: [],
      hydroCoastalStationNodeMappings: mappings()
    });

    expect(state.tide.stationId).toBe("QS");
    expect(state.diagnostics.tideMissingReasons).toContain("no-target-observation");
  });
});

function stateForTide(targetValue: number, lookbackValue: number) {
  return buildEnvironmentState({
    nodeId: "tokyo-inner-bay-01",
    asOf: TARGET_AT,
    habitatGraph: graph(),
    environmentalSnapshots: [snapshot()],
    hydroCoastalObservations: [
      observation("TK", TARGET_AT, targetValue),
      observation("TK", LOOKBACK_1H, lookbackValue)
    ],
    hydroCoastalStationNodeMappings: mappings()
  });
}

function graph() {
  return createInitialHabitatGraph(ENVIRONMENT_NODES, GENERATED_AT);
}

function mappings(): HydroCoastalStationNodeMapping[] {
  const result = buildJmaTidePredictionStationNodeMappings2026({
    habitatGraph: graph(),
    reviewedAt: REVIEWED_AT
  });
  expect(result.errors).toEqual([]);
  return result.mappings;
}

function snapshot(overrides: Partial<EnvironmentalSnapshot> = {}): EnvironmentalSnapshot {
  return {
    nodeId: "tokyo-inner-bay-01",
    observedAt: LOOKBACK_1H,
    collectedAt: COLLECTED_AT,
    forecastIssuedAt: null,
    latitude: 35.62,
    longitude: 139.82,
    coordinateDistanceKm: 0.2,
    source: "open-meteo-weather",
    model: "test-fixture",
    confidence: 0.9,
    freshness: 1,
    missingFields: [],
    windSpeed: 5,
    windDirection: 180,
    pressure: 1008,
    precipitation: 0.2,
    airTemperature: 26,
    ...overrides
  };
}

function observation(
  stationId: string,
  observedAt: string,
  value: number,
  overrides: Partial<HydroCoastalObservation> = {}
): HydroCoastalObservation {
  const station = JMA_TIDE_PREDICTION_STATIONS_2026.find((item) => item.stationId === stationId);
  return {
    schemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
    providerId: "jma-tide-prediction",
    stationId,
    metric: "predicted-tide-level",
    observedAt,
    collectedAt: COLLECTED_AT,
    forecastIssuedAt: FORECAST_ISSUED_AT,
    value,
    unit: "cm",
    status: "predicted",
    provisional: false,
    verticalDatum: station?.verticalDatum ?? null,
    provenance: {
      sourceName: "Environment State synthetic tide fixture",
      sourceKind: "synthetic-fixture",
      sourceTimestamp: observedAt,
      sourceTimezone: "UTC",
      normalizedAt: COLLECTED_AT,
      notes: ["Synthetic test observation."]
    },
    ...overrides
  };
}

const ENVIRONMENT_NODES: EnvironmentNodeSeed[] = [
  { id: "tokyo-inner-bay-01", name: "Tokyo inner bay environmental node", latitude: 35.620, longitude: 139.820, area: "Tokyo Bay", waterType: "inner_bay" },
  { id: "sumida-arakawa-mouth-01", name: "Sumida-Arakawa river mouth environmental node", latitude: 35.640, longitude: 139.815, area: "Tokyo Bay", waterType: "river_mouth" },
  { id: "tama-river-mouth-01", name: "Tama river mouth environmental node", latitude: 35.545, longitude: 139.775, area: "Tokyo Bay", waterType: "river_mouth" },
  { id: "keihin-canal-01", name: "Keihin canal environmental node", latitude: 35.500, longitude: 139.760, area: "Tokyo Bay", waterType: "canal" },
  { id: "makuhari-shallow-01", name: "Makuhari shallow environmental node", latitude: 35.620, longitude: 140.030, area: "Tokyo Bay", waterType: "shallow_flat" },
  { id: "funabashi-inner-01", name: "Funabashi inner bay environmental node", latitude: 35.675, longitude: 139.995, area: "Tokyo Bay", waterType: "inner_bay" },
  { id: "bay-center-north-01", name: "Tokyo Bay north-center environmental node", latitude: 35.480, longitude: 139.890, area: "Tokyo Bay", waterType: "bay_center" },
  { id: "bay-center-south-01", name: "Tokyo Bay south-center environmental node", latitude: 35.350, longitude: 139.840, area: "Tokyo Bay", waterType: "bay_center" },
  { id: "kisarazu-north-01", name: "Kisarazu northern Uchibo environmental node", latitude: 35.390, longitude: 139.890, area: "Uchibo", waterType: "uchibo_north" },
  { id: "futtsu-cape-01", name: "Futtsu cape environmental node", latitude: 35.310, longitude: 139.790, area: "Uchibo", waterType: "cape" },
  { id: "kanaya-uchibo-01", name: "Kanaya Uchibo environmental node", latitude: 35.170, longitude: 139.815, area: "Uchibo", waterType: "uchibo_south" },
  { id: "tateyama-north-01", name: "Tateyama northern environmental node", latitude: 35.000, longitude: 139.840, area: "Uchibo", waterType: "uchibo_south" }
];
