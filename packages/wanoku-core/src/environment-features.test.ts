import { describe, expect, it } from "vitest";
import {
  NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION,
  buildEnvironmentalFeatureSet,
  buildNodeEnvironmentalFeatures,
  calculateCircularMeanDegrees,
  calculateDirectionalAlignment,
  circularDifferenceDegrees,
  findHabitatNodesWithoutSnapshots,
  findSnapshotsWithoutHabitatNode,
  mapSnapshotsToHabitatNodes,
  normalizeDirectionDegrees,
  validateNodeEnvironmentalFeatures,
  vectorFromSpeedAndDirection,
  type BuildEnvironmentalFeatureSetResult
} from "./environment-features";
import { environmentalSnapshotKey, type EnvironmentalQualityReport, type EnvironmentalSnapshot } from "./environment";
import { type HabitatGraph, type HabitatNode } from "./habitat";

const calculatedAt = "2026-07-13T06:00:00.000Z";

describe("Wanoku Environmental Feature Engine v1", () => {
  it("validates canonical UTC ISO calculatedAt", () => {
    const valid = buildEnvironmentalFeatureSet({
      habitatGraph: graph(),
      snapshots: [],
      calculatedAt,
      qualityReports: []
    });
    const invalid = buildEnvironmentalFeatureSet({
      habitatGraph: graph(),
      snapshots: [],
      calculatedAt: "2026-07-13",
      qualityReports: []
    });

    expect(valid.errors).not.toContain("calculatedAt must be canonical UTC ISO datetime such as 2026-07-13T00:00:00.000Z.");
    expect(invalid.errors).toContain("calculatedAt must be canonical UTC ISO datetime such as 2026-07-13T00:00:00.000Z.");
  });

  it("joins snapshots to habitat nodes by exact nodeId and exposes unknown nodes", () => {
    const snapshots = [
      snapshot({ nodeId: "node-a" }),
      snapshot({ nodeId: "unknown-node" })
    ];
    const mapping = mapSnapshotsToHabitatNodes(snapshots, graph());

    expect(mapping.snapshotsByNodeId.get("node-a")).toHaveLength(1);
    expect(mapping.unmatchedSnapshotNodeIds).toEqual(["unknown-node"]);
    expect(findSnapshotsWithoutHabitatNode(snapshots, graph())).toEqual(["unknown-node"]);
  });

  it("detects habitat nodes without snapshots", () => {
    expect(findHabitatNodesWithoutSnapshots(graph(), [snapshot({ nodeId: "node-a" })])).toEqual(["node-b"]);
  });

  it("builds node features from current weather and marine snapshots without scoring fish presence", () => {
    const result = featureSet();
    const feature = result.features.find((item) => item.nodeId === "node-a");

    expect(result.errors).toEqual([]);
    expect(feature).toMatchObject({
      schemaVersion: NODE_ENVIRONMENTAL_FEATURE_SCHEMA_VERSION,
      nodeId: "node-a",
      inputSnapshotCount: 3,
      sourceSnapshotCount: 3,
      excludedSnapshotCount: 0,
      sourceCollectedAt: "2026-07-13T03:00:00.000Z",
      sourceProviderIds: ["open-meteo-marine", "open-meteo-weather"],
      airTemperatureC: 22,
      waterTemperatureC: 18,
      windSpeedMps: 6,
      windGustMps: 9,
      windDirectionDeg: 1,
      waveHeightM: 0.5,
      wavePeriodS: 5,
      waveDirectionDeg: 90,
      currentSpeedMps: 0.2,
      currentDirectionDeg: 180,
      seaLevelM: 0.1,
      pressureHpa: 998,
      precipitationMm: 0.5,
      temperatureDifferenceC: -4,
      gustFactor: 1.5,
      environmentalVolatility: null,
      confidence: 0.8,
      freshness: 0.9
    });
    expect(feature?.windVectorNorth).toBeCloseTo(5.999, 3);
    expect(feature?.windVectorEast).toBeCloseTo(0.1047, 3);
    expect(feature?.windWaveAlignment).toBeCloseTo(Math.cos(89 * Math.PI / 180), 5);
    expect(feature).not.toHaveProperty("presenceProbability");
  });

  it("keeps nulls and missing reasons when source values or direction conventions are unavailable", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ airTemperature: 20, windSpeed: 4, windDirection: 45 })],
      calculatedAt
    });

    expect(feature.waterTemperatureC).toBeNull();
    expect(feature.temperatureDifferenceC).toBeNull();
    expect(feature.windVectorEast).toBeNull();
    expect(feature.missingReasons.waterTemperatureC).toEqual(["source-missing"]);
    expect(feature.missingReasons.windVectorEast).toEqual(["unsupported-direction-convention"]);
    expect(feature.missingReasons.windVectorNorth).toEqual(["unsupported-direction-convention"]);
  });

  it("normalizes directions and uses circular math", () => {
    expect(normalizeDirectionDegrees(361)).toBe(1);
    expect(normalizeDirectionDegrees(-1)).toBe(359);
    expect(circularDifferenceDegrees(350, 10)).toBe(20);
    expect(calculateCircularMeanDegrees([359, 1])).toBeCloseTo(0, 6);
  });

  it("converts speed and direction to vectors only with explicit convention", () => {
    expect(vectorFromSpeedAndDirection(2, 90, "toward")).toEqual({ east: 2, north: 0 });
    expect(vectorFromSpeedAndDirection(2, 90, "from")).toEqual({ east: -2, north: -0 });
    expect(vectorFromSpeedAndDirection(2, 90, "unknown")).toBeNull();
  });

  it("calculates directional alignment as -1..1", () => {
    expect(calculateDirectionalAlignment(0, 0)).toBe(1);
    expect(calculateDirectionalAlignment(0, 90)).toBeCloseTo(0, 6);
    expect(calculateDirectionalAlignment(0, 180)).toBe(-1);
  });

  it("filters snapshots as of calculatedAt and never lets future data become latest", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T05:30:00.000Z", collectedAt: "2026-07-13T06:30:00.000Z", windSpeed: 99 }),
        snapshot({ observedAt: "2026-07-13T06:30:00.000Z", collectedAt: "2026-07-13T05:30:00.000Z", windSpeed: 88 })
      ],
      calculatedAt
    });

    expect(feature.windSpeedMps).toBe(4);
    expect(feature.sourceSnapshotCount).toBe(1);
    expect(feature.excludedSnapshotCount).toBe(2);
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("observedAt is after calculatedAt"),
      expect.stringContaining("collectedAt is after calculatedAt")
    ]));
  });

  it("applies as-of filtering to quality reports", () => {
    const base = snapshot();
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [base],
      qualityReports: [
        qualityReport(base, { collectedAt: "2026-07-13T06:30:00.000Z" })
      ],
      calculatedAt
    });

    expect(feature.dataQuality.qualityReportCount).toBe(0);
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Future quality report excluded")
    ]));
  });

  it("anchors windows to calculatedAt with inclusive boundaries", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T03:00:00.000Z", collectedAt: "2026-07-13T03:00:00.000Z", windSpeed: 3 }),
        snapshot({ observedAt: "2026-07-13T06:00:00.000Z", collectedAt: "2026-07-13T06:00:00.000Z", windSpeed: 6 })
      ],
      calculatedAt
    });
    const wind3h = feature.windows["3h"].windSpeedMps;

    expect(wind3h?.sampleCount).toBe(2);
    expect(wind3h?.mean).toBe(4.5);
    expect(wind3h?.min).toBe(3);
    expect(wind3h?.max).toBe(6);
    expect(wind3h?.change).toBe(3);
    expect(wind3h?.ratePerHour).toBe(1);
    expect(wind3h?.volatility).toBe(1.5);
  });

  it("leaves a calculatedAt-based window empty when only older samples exist", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T02:59:59.000Z", collectedAt: "2026-07-13T02:59:59.000Z", windSpeed: 4 })
      ],
      calculatedAt
    });
    const wind3h = feature.windows["3h"].windSpeedMps;

    expect(wind3h?.sampleCount).toBe(0);
    expect(wind3h?.missingReasons).toContain("source-missing");
  });

  it("uses latest as the newest valid value at or before calculatedAt", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T04:00:00.000Z", windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: -1 })
      ],
      calculatedAt
    });

    expect(feature.windSpeedMps).toBe(4);
    expect(feature.errors).toContain("windSpeedMps has invalid source value.");
    expect(feature.warnings).toContain("windSpeedMps used an older valid sample after excluding newer invalid source value.");
  });

  it("keeps latest window values when the newest field is null", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T04:00:00.000Z", windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: null as unknown as number })
      ],
      calculatedAt
    });

    expect(feature.windows.latest.windSpeedMps?.sampleCount).toBe(1);
    expect(feature.windows.latest.windSpeedMps?.mean).toBe(4);
    expect(feature.providerWindows.latest.windSpeedMps?.["open-meteo-weather"]?.mean).toBe(4);
  });

  it("keeps latest window values when the newest field is invalid and records the fallback", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T04:00:00.000Z", windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: -1 })
      ],
      calculatedAt
    });
    const latest = feature.windows.latest.windSpeedMps;

    expect(latest?.sampleCount).toBe(1);
    expect(latest?.invalidSampleCount).toBe(1);
    expect(latest?.mean).toBe(4);
    expect(latest?.missingReasons).toContain("invalid-source-value");
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("latest.windSpeedMps")
    ]));
  });

  it("accepts source RFC 3339 timestamps with explicit +09:00 offset and normalizes provenance to UTC", () => {
    const sourceSnapshot = snapshot({
      observedAt: "2026-07-13T10:00:00+09:00",
      collectedAt: "2026-07-13T10:30:00+09:00",
      windSpeed: 5
    });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [sourceSnapshot],
      qualityReports: [qualityReport(sourceSnapshot)],
      calculatedAt: "2026-07-13T02:00:00.000Z"
    });

    expect(feature.errors).toEqual([]);
    expect(feature.windSpeedMps).toBe(5);
    expect(feature.sourceCollectedAt).toBe("2026-07-13T01:30:00.000Z");
    expect(feature.provenance.find((item) => item.field === "windSpeedMps")).toMatchObject({
      collectedAt: "2026-07-13T01:30:00.000Z",
      sourceCollectedAts: ["2026-07-13T01:30:00.000Z"]
    });
    expect(feature.dataQuality.qualityReportCount).toBe(1);
  });

  it("rejects invalid source datetimes before using values", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13", windSpeed: 99 }),
        snapshot({ collectedAt: "2026-07-13T09:00:00", windSpeed: 88 }),
        snapshot({ forecastIssuedAt: "2026-02-30T00:00:00.000Z", windSpeed: 77 })
      ],
      calculatedAt
    });

    expect(feature.windSpeedMps).toBeNull();
    expect(feature.sourceSnapshotCount).toBe(0);
    expect(feature.excludedSnapshotCount).toBe(3);
    expect(feature.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("has invalid observedAt"),
      expect.stringContaining("has invalid collectedAt"),
      expect.stringContaining("has invalid forecastIssuedAt")
    ]));
  });

  it("does not use snapshots or quality reports when calculatedAt is invalid", () => {
    const sourceSnapshot = snapshot({ windSpeed: 99 });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [sourceSnapshot],
      qualityReports: [qualityReport(sourceSnapshot)],
      calculatedAt: "2026-07-13T06:00:00+09:00"
    });

    expect(feature.windSpeedMps).toBeNull();
    expect(feature.dataQuality.qualityReportCount).toBe(0);
    expect(feature.sourceSnapshotCount).toBe(0);
    expect(feature.excludedSnapshotCount).toBe(1);
    expect(feature.errors).toContain("calculatedAt must be canonical UTC ISO datetime such as 2026-07-13T00:00:00.000Z.");
  });

  it("excludes non-matching nodeId snapshots in the direct node builder", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ nodeId: "node-b", windSpeed: 9 })],
      calculatedAt
    });

    expect(feature.windSpeedMps).toBeNull();
    expect(feature.sourceSnapshotCount).toBe(0);
    expect(feature.excludedSnapshotCount).toBe(1);
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match input nodeId")
    ]));
  });

  it("keeps exact duplicate source snapshots as a warning only", () => {
    const base = snapshot({ windSpeed: 4 });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [base, { ...base }],
      calculatedAt
    });

    expect(feature.inputSnapshotCount).toBe(2);
    expect(feature.sourceSnapshotCount).toBe(1);
    expect(feature.excludedSnapshotCount).toBe(1);
    expect(feature.errors).toEqual([]);
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate-source-snapshot")
    ]));
    expect(feature.dataQuality.warningCounts["duplicate-source-snapshot"]).toBe(1);
  });

  it("excludes conflicting duplicate source snapshots without arbitrary adoption", () => {
    const base = snapshot({ windSpeed: 4 });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [base, { ...base, windSpeed: 9 }],
      calculatedAt
    });

    expect(feature.windSpeedMps).toBeNull();
    expect(feature.sourceSnapshotCount).toBe(0);
    expect(feature.excludedSnapshotCount).toBe(2);
    expect(feature.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("conflicting-source-snapshot")
    ]));
    expect(feature.missingReasons.windSpeedMps).toContain("conflicting-source-snapshot");
  });

  it("treats NaN and null under the same identity key as conflicting duplicate content", () => {
    const base = snapshot({ windSpeed: Number.NaN });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [base, { ...base, windSpeed: null as unknown as number }],
      calculatedAt
    });

    expect(feature.sourceSnapshotCount).toBe(0);
    expect(feature.excludedSnapshotCount).toBe(2);
    expect(feature.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("conflicting-source-snapshot")
    ]));
  });

  it("matches quality reports by exact snapshotKey and does not borrow another provider quality", () => {
    const weather = snapshot({
      source: "open-meteo-weather",
      observedAt: "2026-07-13T05:00:00.000Z",
      collectedAt: "2026-07-13T05:00:00.000Z"
    });
    const marine = snapshot({
      source: "open-meteo-marine",
      observedAt: "2026-07-13T05:00:00.000Z",
      collectedAt: "2026-07-13T05:00:00.000Z",
      windSpeed: undefined,
      seaSurfaceTemperature: 18
    });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [weather, marine],
      qualityReports: [
        qualityReport(weather, { confidence: 0.7, freshness: 0.6 }),
        qualityReport(marine, { snapshotKey: "wrong-key", confidence: 0.1, freshness: 0.1 })
      ],
      calculatedAt
    });

    expect(feature.dataQuality.qualityReportCount).toBe(1);
    expect(feature.dataQuality.providerQuality["open-meteo-weather"]).toMatchObject({
      qualityReportCount: 1,
      confidence: 0.7,
      freshness: 0.6
    });
    expect(feature.dataQuality.providerQuality["open-meteo-marine"]).toBeUndefined();
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Unmatched quality report excluded")
    ]));
  });

  it("keeps provider quality separate and does not invent a cross-provider confidence", () => {
    const weather = snapshot({ source: "open-meteo-weather" });
    const marine = snapshot({
      source: "open-meteo-marine",
      seaSurfaceTemperature: 18,
      windSpeed: undefined,
      windGust: undefined,
      windDirection: undefined
    });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [weather, marine],
      qualityReports: [
        qualityReport(weather, { confidence: 0.7, freshness: 0.6 }),
        qualityReport(marine, { confidence: 0.9, freshness: 0.8 })
      ],
      calculatedAt
    });

    expect(feature.confidence).toBeNull();
    expect(feature.freshness).toBeNull();
    expect(feature.missingReasons.confidence).toContain("multiple-providers-no-aggregation-policy");
    expect(Object.keys(feature.dataQuality.providerQuality).sort()).toEqual(["open-meteo-marine", "open-meteo-weather"]);
  });

  it("validates provider quality value ranges", () => {
    const weather = snapshot({ source: "open-meteo-weather" });
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [weather],
      qualityReports: [qualityReport(weather, { confidence: 1.5, freshness: -0.1, missingRate: 2 })],
      calculatedAt
    });
    const validation = validateNodeEnvironmentalFeatures(feature, feature.sourceSnapshotCount);

    expect(validation.errors).toEqual(expect.arrayContaining([
      "dataQuality.confidence must be null or between 0 and 1.",
      "dataQuality.freshness must be null or between 0 and 1.",
      "dataQuality.missingRate must be null or between 0 and 1.",
      "dataQuality.providerQuality.open-meteo-weather.confidence must be null or between 0 and 1.",
      "dataQuality.providerQuality.open-meteo-weather.freshness must be null or between 0 and 1.",
      "dataQuality.providerQuality.open-meteo-weather.missingRate must be null or between 0 and 1."
    ]));
  });

  it("records missing reasons for zero denominator and zero vector magnitude", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ windSpeed: 0, windGust: 5, windDirection: 90 }),
        snapshot({
          source: "open-meteo-marine",
          windSpeed: undefined,
          windGust: undefined,
          windDirection: undefined,
          waveHeight: 0.5,
          waveDirection: 90,
          oceanCurrentVelocity: 0,
          oceanCurrentDirection: 180
        })
      ],
      calculatedAt,
      directionConventions: {
        wind: "toward",
        wave: "toward",
        current: "toward"
      }
    });

    expect(feature.gustFactor).toBeNull();
    expect(feature.missingReasons.gustFactor).toContain("zero-denominator");
    expect(feature.windCurrentAlignment).toBeNull();
    expect(feature.missingReasons.windCurrentAlignment).toContain("zero-vector-magnitude");
  });

  it("rejects invalid directionConventions without treating them as toward", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ windSpeed: 2, windDirection: 90 })],
      calculatedAt,
      directionConventions: { wind: "sideways" } as never
    });

    expect(feature.windVectorEast).toBeNull();
    expect(feature.errors).toContain("directionConventions.wind must be toward, from, or unknown.");
    expect(feature.missingReasons.windVectorEast).toContain("unsupported-direction-convention");
  });

  it("rejects invalid windowHours and normalizes duplicate window requests", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: 4 })],
      calculatedAt,
      windowHours: ["3h", "bad", "3h"] as never
    });

    expect(feature.errors).toContain("windowHours contains invalid value: bad.");
    expect(feature.warnings).toContain("windowHours duplicate ignored: 3h.");
    expect(feature.windows["3h"].windSpeedMps?.sampleCount).toBe(1);
  });

  it("propagates invalid source value reasons into derived fields", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T04:00:00.000Z", airTemperature: Number.NaN, seaSurfaceTemperature: 18 })
      ],
      calculatedAt
    });

    expect(feature.temperatureDifferenceC).toBeNull();
    expect(feature.missingReasons.airTemperatureC).toContain("invalid-source-value");
    expect(feature.missingReasons.temperatureDifferenceC).toContain("invalid-source-value");
  });

  it("keeps detailed provenance for derived values", () => {
    const result = featureSet();
    const feature = result.features.find((item) => item.nodeId === "node-a");
    const temperature = feature?.provenance.find((item) => item.field === "temperatureDifferenceC");
    const gust = feature?.provenance.find((item) => item.field === "gustFactor");
    const windVector = feature?.provenance.find((item) => item.field === "windVectorEast");
    const alignment = feature?.provenance.find((item) => item.field === "windWaveAlignment");

    expect(temperature).toMatchObject({
      sourceFields: ["waterTemperatureC", "airTemperatureC"],
      providerIds: ["open-meteo-marine", "open-meteo-weather"],
      nodeId: "node-a",
      sampleCount: 2,
      missingReasons: []
    });
    expect(gust).toMatchObject({
      sourceFields: ["windGustMps", "windSpeedMps"],
      providerIds: ["open-meteo-weather"],
      sourceCollectedAts: ["2026-07-13T03:00:00.000Z"],
      sampleCount: 2
    });
    expect(windVector).toMatchObject({
      sourceFields: ["windSpeedMps", "windDirectionDeg"],
      providerIds: ["open-meteo-weather"],
      sampleCount: 1
    });
    expect(alignment).toMatchObject({
      sourceFields: ["windSpeedMps", "windDirectionDeg", "waveHeightM", "waveDirectionDeg"],
      providerIds: ["open-meteo-marine", "open-meteo-weather"],
      sampleCount: 2
    });
  });

  it("records provider-specific window provenance and avoids implicit multi-provider averages", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ source: "provider-a", observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", airTemperature: 20 }),
        snapshot({ source: "provider-b", observedAt: "2026-07-13T05:30:00.000Z", collectedAt: "2026-07-13T05:30:00.000Z", airTemperature: 30 })
      ],
      calculatedAt
    });
    const aggregate = feature.windows["3h"].airTemperatureC;
    const providerA = feature.providerWindows["3h"].airTemperatureC?.["provider-a"];
    const providerB = feature.providerWindows["3h"].airTemperatureC?.["provider-b"];
    const provenance = feature.provenance.find((item) => item.field === "airTemperatureC" && item.window === "3h");

    expect(aggregate?.sampleCount).toBe(0);
    expect(aggregate?.missingReasons).toContain("multiple-providers-no-aggregation-policy");
    expect(providerA?.mean).toBe(20);
    expect(providerB?.mean).toBe(30);
    expect(provenance).toMatchObject({
      providerIds: ["provider-a", "provider-b"],
      sampleCount: 0,
      invalidSampleCount: 0,
      firstCollectedAt: "2026-07-13T05:00:00.000Z",
      lastCollectedAt: "2026-07-13T05:30:00.000Z"
    });
  });

  it("records invalid window sample counts without using invalid values in statistics", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T04:00:00.000Z", windSpeed: 4 }),
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: -1 })
      ],
      calculatedAt
    });
    const wind3h = feature.windows["3h"].windSpeedMps;
    const provenance = feature.provenance.find((item) => item.field === "windSpeedMps" && item.window === "3h");

    expect(wind3h?.sampleCount).toBe(1);
    expect(wind3h?.invalidSampleCount).toBe(1);
    expect(wind3h?.missingReasons).toContain("invalid-source-value");
    expect(provenance).toMatchObject({
      sampleCount: 1,
      invalidSampleCount: 1
    });
    expect(provenance?.missingReasons).toEqual(expect.arrayContaining(["invalid-source-value"]));
  });

  it("keeps provider-specific invalid window reasons from contaminating other providers", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ source: "provider-a", observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: -1 }),
        snapshot({ source: "provider-b", observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: 5 })
      ],
      calculatedAt
    });
    const providerA = feature.providerWindows["3h"].windSpeedMps?.["provider-a"];
    const providerB = feature.providerWindows["3h"].windSpeedMps?.["provider-b"];

    expect(providerA?.sampleCount).toBe(0);
    expect(providerA?.invalidSampleCount).toBe(1);
    expect(providerA?.missingReasons).toContain("invalid-source-value");
    expect(providerB?.sampleCount).toBe(1);
    expect(providerB?.invalidSampleCount).toBe(0);
    expect(providerB?.missingReasons).not.toContain("invalid-source-value");
    expect(feature.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("3h.windSpeedMps invalid source sample excluded for provider provider-a")
    ]));
  });

  it("reports non-finite and negative source values as validation errors", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ windSpeed: -1, waveHeight: Number.NaN })
      ],
      calculatedAt
    });
    const validation = validateNodeEnvironmentalFeatures(feature, 1);

    expect(validation.errors).toEqual(expect.arrayContaining([
      "windSpeedMps has invalid source value.",
      "waveHeightM has invalid source value."
    ]));
  });

  it("validates missingRate and sourceSnapshotCount consistency", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ windSpeed: 4 })],
      calculatedAt
    });
    const validation = validateNodeEnvironmentalFeatures({
      ...feature,
      missingRate: 1.2,
      confidence: 1.1
    }, 2);

    expect(validation.errors).toEqual(expect.arrayContaining([
      "sourceSnapshotCount 1 does not match expected used count 2.",
      "missingRate must be between 0 and 1.",
      "confidence must be null or between 0 and 1."
    ]));
  });

  it("keeps provenance for raw provider, collectedAt, schema version, node and sample counts", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [snapshot({ windSpeed: 4, source: "open-meteo-weather" })],
      calculatedAt
    });
    const windProvenance = feature.provenance.find((item) => item.field === "windSpeedMps");

    expect(windProvenance).toMatchObject({
      providerId: "open-meteo-weather",
      providerIds: ["open-meteo-weather"],
      collectedAt: "2026-07-13T00:00:00.000Z",
      sourceCollectedAts: ["2026-07-13T00:00:00.000Z"],
      snapshotSchemaVersion: "wanoku-environmental-snapshot.v1",
      nodeId: "node-a",
      sampleCount: 1,
      missingReasons: []
    });
  });

  it("sets sourceCollectedAt from the maximum used collectedAt instead of observedAt order", () => {
    const feature = buildNodeEnvironmentalFeatures({
      nodeId: "node-a",
      snapshots: [
        snapshot({ observedAt: "2026-07-13T05:00:00.000Z", collectedAt: "2026-07-13T05:00:00.000Z", windSpeed: 5 }),
        snapshot({ observedAt: "2026-07-13T04:00:00.000Z", collectedAt: "2026-07-13T05:30:00.000Z", windSpeed: 4 })
      ],
      calculatedAt
    });

    expect(feature.sourceCollectedAt).toBe("2026-07-13T05:30:00.000Z");
  });

  it("is compatible with the current EnvironmentalSnapshot and EnvironmentalQualityReport schema", () => {
    const snapshots = [
      snapshot({
        nodeId: "node-a",
        coordinateDistanceKm: 2.606,
        provenance: [{
          provider: "open-meteo-weather",
          source: "open-meteo-weather",
          normalizedSchemaVersion: "wanoku-environmental-snapshot.v1"
        }]
      })
    ];
    const result = buildEnvironmentalFeatureSet({
      habitatGraph: graph(),
      snapshots,
      qualityReports: [qualityReport(snapshots[0])],
      calculatedAt
    });
    const feature = result.features.find((item) => item.nodeId === "node-a");

    expect(result.errors).toEqual([]);
    expect(feature?.dataQuality.qualityReportCount).toBe(1);
    expect(feature?.dataQuality.warningCounts.wind_gust_below_sustained_wind).toBe(1);
    expect(feature?.sourceProviderIds).toEqual(["open-meteo-weather"]);
  });

  it("returns full feature set bookkeeping for unmatched and empty nodes", () => {
    const result: BuildEnvironmentalFeatureSetResult = buildEnvironmentalFeatureSet({
      habitatGraph: graph(),
      snapshots: [snapshot({ nodeId: "unknown-node" })],
      qualityReports: [],
      calculatedAt
    });

    expect(result.features).toHaveLength(2);
    expect(result.unmatchedSnapshotNodeIds).toEqual(["unknown-node"]);
    expect(result.nodesWithoutSnapshots).toEqual(["node-a", "node-b"]);
    expect(result.warnings).toContain("No matching habitat node for snapshot nodeId: unknown-node");
  });
});

function snapshot(overrides: Partial<EnvironmentalSnapshot> = {}): EnvironmentalSnapshot {
  const base: EnvironmentalSnapshot = {
    nodeId: "node-a",
    observedAt: "2026-07-13T00:00:00.000Z",
    collectedAt: "2026-07-13T00:00:00.000Z",
    forecastIssuedAt: null,
    latitude: 35,
    longitude: 139,
    source: "open-meteo-weather",
    confidence: 0.8,
    freshness: 0.9,
    missingFields: [],
    airTemperature: 20,
    windSpeed: 4,
    windGust: 6,
    windDirection: 359,
    pressure: 1000,
    precipitation: 1
  };
  return { ...base, ...overrides };
}

function qualityReport(snapshotValue: EnvironmentalSnapshot, overrides: Partial<EnvironmentalQualityReport> = {}): EnvironmentalQualityReport {
  return {
    snapshotKey: environmentalSnapshotKey(snapshotValue),
    nodeId: snapshotValue.nodeId,
    observedAt: snapshotValue.observedAt,
    collectedAt: snapshotValue.collectedAt,
    forecastIssuedAt: snapshotValue.forecastIssuedAt,
    coordinateDistanceKm: snapshotValue.coordinateDistanceKm ?? null,
    freshness: 0.9,
    missingRate: 0.1,
    confidence: 0.8,
    missingFields: [],
    stale: false,
    warnings: ["wind_gust_below_sustained_wind"],
    ...overrides
  };
}

function featureSet(): BuildEnvironmentalFeatureSetResult {
  const snapshots = [
    snapshot({
      observedAt: "2026-07-13T00:00:00.000Z",
      collectedAt: "2026-07-13T00:00:00.000Z",
      airTemperature: 20,
      windSpeed: 4,
      windGust: 6,
      windDirection: 359,
      pressure: 1000,
      precipitation: 1
    }),
    snapshot({
      observedAt: "2026-07-13T03:00:00.000Z",
      collectedAt: "2026-07-13T03:00:00.000Z",
      airTemperature: 22,
      windSpeed: 6,
      windGust: 9,
      windDirection: 1,
      pressure: 998,
      precipitation: 0.5
    }),
    snapshot({
      source: "open-meteo-marine",
      observedAt: "2026-07-13T03:00:00.000Z",
      collectedAt: "2026-07-13T03:00:00.000Z",
      airTemperature: undefined,
      windSpeed: undefined,
      windGust: undefined,
      windDirection: undefined,
      pressure: undefined,
      precipitation: undefined,
      seaSurfaceTemperature: 18,
      waveHeight: 0.5,
      wavePeriod: 5,
      waveDirection: 90,
      oceanCurrentVelocity: 0.2,
      oceanCurrentDirection: 180,
      seaLevelHeightMsl: 0.1
    })
  ];
  return buildEnvironmentalFeatureSet({
    habitatGraph: graph(),
    snapshots,
    qualityReports: [qualityReport(snapshots[1])],
    calculatedAt,
    directionConventions: {
      wind: "toward",
      wave: "toward",
      current: "toward"
    }
  });
}

function graph(): HabitatGraph {
  return {
    version: "test",
    generatedAt: "2026-07-13T00:00:00.000Z",
    nodes: [
      node("node-a"),
      node("node-b")
    ],
    edges: []
  };
}

function node(id: string): HabitatNode {
  return {
    id,
    displayName: id,
    latitude: 35,
    longitude: 139,
    region: "test",
    waterBodyType: "bay",
    habitatTypes: ["open-water"],
    bayPosition: null,
    depthBand: "unknown",
    riverInfluence: null,
    freshwaterInfluence: null,
    tidalExposure: null,
    waveExposure: null,
    currentExposure: null,
    structureDensity: null,
    shallowAreaRatio: null,
    baitHoldingPotential: null,
    confidence: null,
    dataSources: ["test"],
    notes: []
  };
}
