import { describe, expect, it } from "vitest";
import {
  HYDRO_COASTAL_SCHEMA_VERSION,
  hydroCoastalObservationVersionKey,
  type HydroCoastalObservation,
  type HydroCoastalStationNodeMapping
} from "./hydro-coastal";
import {
  buildHydroCoastalFeatureSet,
  buildNodeHydroCoastalFeatures,
  classifyTideTrend,
  normalizeWaterLevelToCm,
  validateNodeHydroCoastalFeatures
} from "./hydro-coastal-features";
import { createInitialHabitatGraph, type EnvironmentNodeSeed } from "./habitat-fixtures";
import {
  JMA_TIDE_PREDICTION_MAPPING_VALID_FROM,
  JMA_TIDE_PREDICTION_MAPPING_VALID_TO,
  buildJmaTidePredictionStationNodeMappings2026
} from "./jma-tide-prediction-mappings";
import { JMA_TIDE_PREDICTION_STATIONS_2026 } from "./jma-tide-prediction";

const GENERATED_AT = "2026-07-13T00:00:00.000Z";
const REVIEWED_AT = "2026-07-13T00:00:00.000Z";
const CALCULATED_AT = "2025-12-31T02:00:00.000Z";
const COLLECTED_AT = "2025-12-31T01:00:00.000Z";
const FORECAST_ISSUED_AT = "2025-12-31T00:00:00.000Z";
const OLDER_FORECAST_ISSUED_AT = "2025-12-30T00:00:00.000Z";
const TARGET_AT = "2026-01-01T03:00:00.000Z";
const LOOKBACK_1H = "2026-01-01T02:00:00.000Z";
const LOOKBACK_3H = "2026-01-01T00:00:00.000Z";
const LOOKBACK_6H = "2025-12-31T21:00:00.000Z";

describe("Hydro-Coastal Feature Bridge v1", () => {
  it("creates one feature per 12 habitat nodes without node propagation", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: observationsForAllMappedStations(),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    expect(result.errors).toEqual([]);
    expect(result.features).toHaveLength(12);
    expect(result.features.filter((feature) => feature.stationId !== null)).toHaveLength(5);
    expect(result.nodesWithoutActiveMapping).toHaveLength(7);
    expect(result.features.filter((feature) => feature.missingReasons.includes("no-active-mapping"))).toHaveLength(7);
    expect(result.features.find((feature) => feature.nodeId === "funabashi-inner-01")?.tideLevelCm).toBeNull();
    expect(result.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")).toMatchObject({
      stationId: "TK",
      tideLevelCm: 100,
      change1hCm: 10,
      change3hCm: 30,
      change6hCm: 60,
      rate3hCmPerHour: 10,
      trend1h: "rising"
    });
  });

  it("requires exact-hour targetAt and does not interpolate adjacent observations", () => {
    const nonHour = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: "2026-01-01T03:30:00.000Z"
    });
    expect(nonHour.errors).toContain("targetAt must be an exact UTC hour.");
    expect(nonHour.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.tideLevelCm).toBeNull();

    const noExactTarget = buildHydroCoastalFeatureSet({
      observations: [
        observation("TK", "2026-01-01T02:00:00.000Z", 90),
        observation("TK", "2026-01-01T04:00:00.000Z", 110)
      ],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = noExactTarget.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.tideLevelCm).toBeNull();
    expect(feature?.missingReasons).toContain("no-target-observation");
  });

  it("allows future and historical targetAt because calculatedAt is only the as-of cutoff", () => {
    const future = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(future.errors).toEqual([]);
    expect(future.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.tideLevelCm).toBe(100);

    const historicalTarget = "2025-12-31T15:00:00.000Z";
    const historical = buildHydroCoastalFeatureSet({
      observations: [observation("TK", historicalTarget, 88)],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: "2026-01-01T00:00:00.000Z",
      targetAt: historicalTarget
    });
    expect(historical.errors).toEqual([]);
    expect(historical.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.tideLevelCm).toBe(88);
  });

  it("uses as-of selection: future revisions are excluded and latest eligible revision wins", () => {
    const older = observation("TK", TARGET_AT, 100, {
      collectedAt: "2025-12-31T00:30:00.000Z"
    });
    const latest = observation("TK", TARGET_AT, 120, {
      collectedAt: "2025-12-31T01:30:00.000Z"
    });
    const future = observation("TK", TARGET_AT, 500, {
      collectedAt: "2025-12-31T03:00:00.000Z"
    });

    const result = buildHydroCoastalFeatureSet({
      observations: [future, older, latest],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.tideLevelCm).toBe(120);
    expect(result.warnings.some((warning) => warning.includes("future hydro-coastal revision excluded"))).toBe(true);
    expect(feature?.missingReasons).toContain("future-revision-excluded");
    expect(result.features.find((item) => item.nodeId === "makuhari-shallow-01")?.missingReasons).not.toContain("future-revision-excluded");
    expect(result.features.find((item) => item.nodeId === "funabashi-inner-01")?.missingReasons).not.toContain("future-revision-excluded");
  });

  it("propagates exact duplicate warnings and conflicting version errors from as-of selection", () => {
    const exact = observation("TK", TARGET_AT, 100);
    const duplicate = buildHydroCoastalFeatureSet({
      observations: [exact, { ...exact }],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(duplicate.errors).toEqual([]);
    expect(duplicate.warnings.some((warning) => warning.includes("duplicate hydro-coastal observation ignored"))).toBe(true);

    const conflict = buildHydroCoastalFeatureSet({
      observations: [exact, { ...exact, value: 101 }],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(conflict.errors.some((error) => error.includes("conflicting hydro-coastal observation version"))).toBe(true);
    expect(conflict.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.missingReasons).toContain("conflicting-observation");
    expect(conflict.features.find((feature) => feature.nodeId === "makuhari-shallow-01")?.missingReasons).not.toContain("conflicting-observation");
    expect(conflict.features.find((feature) => feature.nodeId === "funabashi-inner-01")?.missingReasons).not.toContain("conflicting-observation");
  });

  it("does not attach unrelated as-of diagnostics to node features", () => {
    const futureOutsideTargetWindow = observation("TK", "2026-01-01T12:00:00.000Z", 500, {
      collectedAt: "2025-12-31T03:00:00.000Z"
    });
    const result = buildHydroCoastalFeatureSet({
      observations: [...observationsForStation("TK"), futureOutsideTargetWindow],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    expect(result.warnings.some((warning) => warning.includes("future hydro-coastal revision excluded"))).toBe(true);
    expect(result.features.every((feature) => !feature.missingReasons.includes("future-revision-excluded"))).toBe(true);
  });

  it("keeps unknown habitat mappings at result level without dirtying existing nodes", () => {
    const unknownNode: HydroCoastalStationNodeMapping = { ...mappings()[0], habitatNodeId: "missing-node" };
    const result = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: [unknownNode],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    expect(result.mappingsWithUnknownHabitatNode).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("mapping references unknown habitat node"))).toBe(true);
    expect(result.features.every((feature) => !feature.missingReasons.includes("unknown-habitat-node"))).toBe(true);
  });

  it("chooses the newest forecast vintage and never fills lookbacks from an older vintage", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: [
        observation("TK", TARGET_AT, 100, { forecastIssuedAt: OLDER_FORECAST_ISSUED_AT }),
        observation("TK", LOOKBACK_3H, 70, { forecastIssuedAt: OLDER_FORECAST_ISSUED_AT }),
        observation("TK", LOOKBACK_6H, 40, { forecastIssuedAt: OLDER_FORECAST_ISSUED_AT }),
        observation("TK", TARGET_AT, 200, { forecastIssuedAt: FORECAST_ISSUED_AT }),
        observation("TK", LOOKBACK_1H, 190, { forecastIssuedAt: FORECAST_ISSUED_AT })
      ],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.forecastIssuedAt).toBe(FORECAST_ISSUED_AT);
    expect(feature?.tideLevelCm).toBe(200);
    expect(feature?.change1hCm).toBe(10);
    expect(feature?.change3hCm).toBeNull();
    expect(feature?.change6hCm).toBeNull();
    expect(feature?.missingReasons).toContain("no-common-forecast-vintage");
  });

  it("normalizes cm/m units, allows negative tide levels, and classifies simple trends", () => {
    expect(normalizeWaterLevelToCm(1.25, "m")).toEqual({ valueCm: 125, missingReasons: [] });
    expect(normalizeWaterLevelToCm(-4, "cm")).toEqual({ valueCm: -4, missingReasons: [] });
    expect(normalizeWaterLevelToCm(1, "ft")).toEqual({ valueCm: null, missingReasons: ["unsupported-unit"] });
    expect(classifyTideTrend(1)).toBe("rising");
    expect(classifyTideTrend(-1)).toBe("falling");
    expect(classifyTideTrend(0)).toBe("steady");
    expect(classifyTideTrend(null)).toBe("unknown");

    const result = buildHydroCoastalFeatureSet({
      observations: [
        observation("TK", TARGET_AT, -0.1, { unit: "m" }),
        observation("TK", LOOKBACK_1H, -20),
        observation("TK", LOOKBACK_3H, -40),
        observation("TK", LOOKBACK_6H, -70)
      ],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.tideLevelCm).toBe(-10);
    expect(feature?.tideLevelM).toBe(-0.1);
    expect(feature?.change1hCm).toBe(10);
  });

  it("converts TP only when datum offset is known while still allowing same-datum changes", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: [...observationsForStation("TK"), ...observationsForStation("QS"), ...observationsForStation("KZ")],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });

    const tk = result.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01");
    const qs = result.features.find((feature) => feature.nodeId === "keihin-canal-01");
    const kz = result.features.find((feature) => feature.nodeId === "kisarazu-north-01");
    expect(tk?.tideLevelTpM).toBe(-0.141);
    expect(qs?.tideLevelTpM).toBe(-0.15);
    expect(kz?.tideLevelTpM).toBeNull();
    expect(kz?.missingReasons).toContain("datum-not-convertible-to-tp");
    expect(kz?.change1hCm).toBe(10);
  });

  it("respects mapping validity as [validFrom, validTo) and reports unknown/unmapped mappings without fallback", () => {
    const baseMappings = mappings();
    const expiredAtTarget: HydroCoastalStationNodeMapping = {
      ...baseMappings[0],
      validTo: TARGET_AT
    };
    const expired = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: [expiredAtTarget],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(expired.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.missingReasons).toContain("no-active-mapping");
    expect(expired.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.missingReasons).toContain("mapping-outside-validity");
    expect(expired.features.find((feature) => feature.nodeId === "makuhari-shallow-01")?.missingReasons).not.toContain("mapping-outside-validity");

    const unknownNode: HydroCoastalStationNodeMapping = { ...baseMappings[0], habitatNodeId: "missing-node" };
    const unknown = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: [unknownNode],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(unknown.mappingsWithUnknownHabitatNode).toHaveLength(1);
    expect(unknown.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01")?.tideLevelCm).toBeNull();

    const unmapped = buildHydroCoastalFeatureSet({
      observations: [observation("ZZ", TARGET_AT, 100)],
      mappings: baseMappings,
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(unmapped.unmappedStationKeys).toEqual(["jma-tide-prediction|ZZ"]);
  });

  it("rejects multiple active stations and conflicting mappings without choosing by distance", () => {
    const baseMappings = mappings();
    const cbToTokyo: HydroCoastalStationNodeMapping = {
      ...baseMappings.find((mapping) => mapping.stationId === "CB")!,
      habitatNodeId: "tokyo-inner-bay-01",
      distanceKm: 1
    };
    const multiple = buildHydroCoastalFeatureSet({
      observations: [...observationsForStation("TK"), ...observationsForStation("CB")],
      mappings: [...baseMappings, cbToTokyo],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = multiple.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.tideLevelCm).toBeNull();
    expect(feature?.missingReasons).toContain("multiple-active-stations");
    expect(multiple.errors.some((error) => error.includes("multiple active hydro-coastal stations"))).toBe(true);

    const duplicate = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: [baseMappings[0], { ...baseMappings[0] }],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(duplicate.errors).toEqual([]);
    expect(duplicate.warnings.some((warning) => warning.includes("duplicate hydro-coastal station-node mapping ignored"))).toBe(true);

    const conflictingMapping = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: [baseMappings[0], { ...baseMappings[0], distanceKm: baseMappings[0].distanceKm + 1 }],
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(conflictingMapping.errors.some((error) => error.includes("conflicting active hydro-coastal station-node mapping"))).toBe(true);
    const conflictingFeature = conflictingMapping.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(conflictingFeature?.tideLevelCm).toBeNull();
    expect(conflictingFeature?.missingReasons).toContain("conflicting-mapping");
    expect(conflictingFeature?.missingReasons).not.toContain("multiple-active-stations");
  });

  it("keeps trend provenance aligned with the actual 1h missing reason", () => {
    const oldVintage = buildHydroCoastalFeatureSet({
      observations: [
        observation("TK", TARGET_AT, 200, { forecastIssuedAt: FORECAST_ISSUED_AT }),
        observation("TK", LOOKBACK_1H, 90, { forecastIssuedAt: OLDER_FORECAST_ISSUED_AT })
      ],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(oldVintage.features.find((item) => item.nodeId === "tokyo-inner-bay-01")?.provenance.find((item) => item.field === "trend1h")?.missingReasons).toContain("no-common-forecast-vintage");

    const conflict = buildHydroCoastalFeatureSet({
      observations: [
        observation("TK", TARGET_AT, 100),
        observation("TK", LOOKBACK_1H, 90),
        { ...observation("TK", LOOKBACK_1H, 90), value: 91 }
      ],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    expect(conflict.features.find((item) => item.nodeId === "tokyo-inner-bay-01")?.provenance.find((item) => item.field === "trend1h")?.missingReasons).toContain("conflicting-observation");
  });

  it("reports quality counts, field missing reasons, and keeps confidence null", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: [observation("TK", TARGET_AT, 100)],
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature?.dataQuality).toMatchObject({
      requiredObservationCount: 4,
      availableObservationCount: 1,
      missingRate: 0.75,
      confidence: null
    });
    expect(feature?.missingReasons).toContain("missing-lookback-observation");
    expect(feature?.provenance.find((item) => item.field === "change3hCm")?.missingReasons).toContain("missing-lookback-observation");
  });

  it("validates generated features and never throws for malformed feature input", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01");
    expect(feature && validateNodeHydroCoastalFeatures(feature).valid).toBe(true);
    expect(() => validateNodeHydroCoastalFeatures(null)).not.toThrow();
    expect(() => validateNodeHydroCoastalFeatures([])).not.toThrow();
    expect(validateNodeHydroCoastalFeatures({ schemaVersion: "bad" }).valid).toBe(false);
  });

  it("rejects inconsistent feature identity, values, quality, and provenance", () => {
    const valid = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    }).features.find((item) => item.nodeId === "tokyo-inner-bay-01")!;

    expect(validateNodeHydroCoastalFeatures({ ...valid, forecastIssuedAt: null }).errors).toContain("tideLevelCm requires providerId, stationId, forecastIssuedAt, verticalDatum, and mappingMethod.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, providerId: null }).errors).toContain("providerId and stationId must both be null or both be non-empty strings.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, tideLevelM: null }).errors).toContain("tideLevelCm and tideLevelM must both be null or both be finite.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, rate1hCmPerHour: null }).errors).toContain("change1hCm and rate1hCmPerHour must both be null or both be finite.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, trend1h: "falling" }).errors).toContain("trend1h must match classifyTideTrend(change1hCm).");
    expect(validateNodeHydroCoastalFeatures({
      ...valid,
      dataQuality: { ...valid.dataQuality, availableObservationCount: 2, missingRate: 0.9 }
    }).errors).toContain("dataQuality.missingRate must equal (requiredObservationCount - availableObservationCount) / requiredObservationCount rounded to 6 digits.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, missingReasons: ["mystery"] }).errors).toContain("missingReasons contains invalid reason: mystery.");
    expect(validateNodeHydroCoastalFeatures({ ...valid, provenance: [{ field: "", nodeId: "", targetAt: "bad", missingReasons: ["mystery"] }] }).errors).toEqual(expect.arrayContaining([
      "provenance[0].field must not be empty.",
      "provenance[0].nodeId must not be empty.",
      "provenance[0].targetAt must be canonical UTC ISO datetime.",
      "provenance[0].missingReasons contains invalid reason: mystery."
    ]));
    const nullTideWithForecast = { ...valid, tideLevelCm: null, tideLevelM: null, forecastIssuedAt: FORECAST_ISSUED_AT };
    expect(validateNodeHydroCoastalFeatures(nullTideWithForecast).errors).toContain("forecastIssuedAt must be null when tideLevelCm is null.");
  });

  it("handles overflow during unit normalization as invalid observation", () => {
    expect(normalizeWaterLevelToCm(Number.MAX_VALUE, "m")).toEqual({
      valueCm: null,
      missingReasons: ["invalid-observation"]
    });
  });

  it("can expose unsupported-unit as the 1h trend provenance reason when node builder receives such source data", () => {
    const mapping = mappings()[0];
    const feature = buildNodeHydroCoastalFeatures({
      nodeId: "tokyo-inner-bay-01",
      activeMappings: [mapping],
      mappedObservations: [
        { observation: observation("TK", TARGET_AT, 100), habitatNodeId: "tokyo-inner-bay-01", mapping },
        {
          observation: { ...observation("TK", LOOKBACK_1H, 1), unit: "ft" as "cm" },
          habitatNodeId: "tokyo-inner-bay-01",
          mapping
        }
      ],
      inputObservationCount: 2,
      selectedAsOfObservationCount: 2,
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT,
      lookbackAts: {
        1: LOOKBACK_1H,
        3: LOOKBACK_3H,
        6: LOOKBACK_6H
      }
    });

    expect(feature.provenance.find((item) => item.field === "trend1h")?.missingReasons).toContain("unsupported-unit");
  });

  it("is input-order independent for observations and mappings", () => {
    const ordered = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const reversed = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK").slice().reverse(),
      mappings: mappings().slice().reverse(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const left = ordered.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01");
    const right = reversed.features.find((feature) => feature.nodeId === "tokyo-inner-bay-01");
    expect(right?.tideLevelCm).toBe(left?.tideLevelCm);
    expect(right?.change6hCm).toBe(left?.change6hCm);
    expect(right?.forecastIssuedAt).toBe(left?.forecastIssuedAt);
  });

  it("keeps provenance for target, change, rate, TP conversion, and observation version keys", () => {
    const result = buildHydroCoastalFeatureSet({
      observations: observationsForStation("TK"),
      mappings: mappings(),
      habitatGraph: graph(),
      calculatedAt: CALCULATED_AT,
      targetAt: TARGET_AT
    });
    const feature = result.features.find((item) => item.nodeId === "tokyo-inner-bay-01")!;
    expect(feature.provenance.find((entry) => entry.field === "tideLevelCm")).toMatchObject({
      providerId: "jma-tide-prediction",
      stationId: "TK",
      nodeId: "tokyo-inner-bay-01",
      targetAt: TARGET_AT,
      forecastIssuedAt: FORECAST_ISSUED_AT,
      mappingMethod: "manual-reviewed"
    });
    expect(feature.provenance.find((entry) => entry.field === "change1hCm")).toMatchObject({
      windowHours: 1,
      lookbackAt: LOOKBACK_1H
    });
    expect(feature.provenance.find((entry) => entry.field === "tideLevelTpM")).toMatchObject({
      conversionUtility: "convertWaterLevelToTp",
      offsetToTpM: -1.141
    });
    expect(feature.provenance.some((entry) => entry.observationVersionKey === hydroCoastalObservationVersionKey(observation("TK", TARGET_AT, 100)))).toBe(true);
  });
});

function graph() {
  return createInitialHabitatGraph(ENVIRONMENT_NODES, GENERATED_AT);
}

function mappings(): HydroCoastalStationNodeMapping[] {
  const result = buildJmaTidePredictionStationNodeMappings2026({
    habitatGraph: graph(),
    reviewedAt: REVIEWED_AT
  });
  expect(result.errors).toEqual([]);
  expect(result.mappings).toHaveLength(5);
  return result.mappings;
}

function observationsForAllMappedStations(): HydroCoastalObservation[] {
  return ["TK", "CB", "KZ", "QS", "TT"].flatMap((stationId) => observationsForStation(stationId));
}

function observationsForStation(stationId: string): HydroCoastalObservation[] {
  return [
    observation(stationId, TARGET_AT, 100),
    observation(stationId, LOOKBACK_1H, 90),
    observation(stationId, LOOKBACK_3H, 70),
    observation(stationId, LOOKBACK_6H, 40)
  ];
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
    verticalDatum: station?.verticalDatum ?? {
      type: "tide-table-datum",
      stationSpecific: true,
      offsetToTpM: null,
      description: "Synthetic test datum."
    },
    provenance: {
      sourceName: "Hydro-Coastal Feature Bridge synthetic test",
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
