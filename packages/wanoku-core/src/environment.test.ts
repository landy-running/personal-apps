import { describe, expect, it } from "vitest";
import {
  buildEnvironmentalFeatureVector,
  calculateDataFreshness,
  calculateEnvironmentalQuality,
  calculateMissingFields,
  detectEnvironmentalContradictions,
  environmentalSnapshotKey,
  type EnvironmentalSnapshot
} from "./environment";

const baseSnapshot: EnvironmentalSnapshot = {
  nodeId: "tokyo-bay-inner-01",
  observedAt: "2026-07-12T00:00:00+09:00",
  collectedAt: "2026-07-11T18:05:00+09:00",
  forecastIssuedAt: "2026-07-11T18:00:00+09:00",
  latitude: 35.58,
  longitude: 139.82,
  coordinateDistanceKm: 2.606,
  windSpeed: 4,
  windDirection: 350,
  windGust: 8,
  pressure: 1008,
  pressureTrend: -0.5,
  precipitation: 0.2,
  accumulatedRain: 1.2,
  airTemperature: 28,
  waveHeight: 0.4,
  waveDirection: 180,
  wavePeriod: 4,
  swellHeight: 0.2,
  swellDirection: 170,
  swellPeriod: 6,
  seaSurfaceTemperature: 26.5,
  oceanCurrentVelocity: 0.3,
  oceanCurrentDirection: 90,
  seaLevelHeightMsl: 0.12,
  source: "open-meteo",
  model: "fixture",
  confidence: 0.82,
  freshness: 0.9,
  missingFields: []
};

function snapshot(overrides: Partial<EnvironmentalSnapshot>): EnvironmentalSnapshot {
  return { ...baseSnapshot, ...overrides };
}

describe("wanoku environmental spine core", () => {
  it("builds stable snapshot keys for duplicate prevention", () => {
    const left = environmentalSnapshotKey(baseSnapshot);
    const right = environmentalSnapshotKey({ ...baseSnapshot });

    expect(left).toBe(right);
    expect(left).toContain("tokyo-bay-inner-01");
    expect(left).toContain("issued:2026-07-11T18:00:00+09:00");
  });

  it("uses collectedAt as the forecast vintage when forecastIssuedAt is unknown", () => {
    const key = environmentalSnapshotKey(snapshot({ forecastIssuedAt: null }));

    expect(key).toContain("collected:2026-07-11T18:05:00+09:00");
  });

  it("reports missing fields and quality without treating partial data as success", () => {
    const partial = snapshot({
      windSpeed: undefined,
      waveHeight: undefined,
      seaSurfaceTemperature: undefined,
      missingFields: ["waveHeight"]
    });

    expect(calculateMissingFields(partial)).toEqual(expect.arrayContaining(["windSpeed", "waveHeight", "seaSurfaceTemperature"]));
    const quality = calculateEnvironmentalQuality(partial, "2026-07-12T03:00:00+09:00");
    expect(quality.missingRate).toBeGreaterThan(0);
    expect(quality.confidence).toBeLessThan(baseSnapshot.confidence);
    expect(quality.coordinateDistanceKm).toBe(2.606);
  });

  it("flags gust below sustained wind without modifying the original values", () => {
    const anomalous = snapshot({ windSpeed: 5.33, windGust: 2.3 });
    const quality = calculateEnvironmentalQuality(anomalous, "2026-07-12T03:00:00+09:00");

    expect(anomalous.windSpeed).toBe(5.33);
    expect(anomalous.windGust).toBe(2.3);
    expect(quality.warnings).toContain("wind_gust_below_sustained_wind");
  });

  it("calculates freshness from observed or forecast issue time", () => {
    const fresh = calculateDataFreshness(baseSnapshot, "2026-07-12T01:00:00+09:00");
    const old = calculateDataFreshness(baseSnapshot, "2026-07-14T00:00:00+09:00");

    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeLessThan(0.2);
  });

  it("handles wind direction continuity across the 0/360 boundary", () => {
    const features = buildEnvironmentalFeatureVector([
      snapshot({ observedAt: "2026-07-11T21:00:00+09:00", windDirection: 350, windSpeed: 5 }),
      snapshot({ observedAt: "2026-07-11T22:00:00+09:00", windDirection: 0, windSpeed: 4 }),
      snapshot({ observedAt: "2026-07-12T00:00:00+09:00", windDirection: 10, windSpeed: 6 })
    ], "2026-07-12T00:30:00+09:00");

    expect(features.windContinuity["3h"].sampleCount).toBe(3);
    expect(features.windContinuity["3h"].directionStability).toBeGreaterThan(0.9);
  });

  it("creates current vectors from ocean current speed and direction", () => {
    const features = buildEnvironmentalFeatureVector([snapshot({ oceanCurrentVelocity: 0.5, oceanCurrentDirection: 90 })]);

    expect(features.oceanCurrentVector?.east).toBeCloseTo(0.5, 4);
    expect(features.oceanCurrentVector?.north).toBeCloseTo(0, 4);
  });

  it("aggregates 72 hour rainfall", () => {
    const series = Array.from({ length: 25 }, (_, index) => snapshot({
      observedAt: new Date(Date.parse("2026-07-09T00:00:00+09:00") + index * 3 * 3600_000).toISOString(),
      precipitation: 1
    }));

    const features = buildEnvironmentalFeatureVector(series, "2026-07-12T00:00:00+09:00");

    expect(features.accumulatedRain["72h"]).toBe(25);
    expect(features.accumulatedRain["24h"]).toBe(9);
  });

  it("detects rapid SST, pressure, wave and sea level changes", () => {
    const features = buildEnvironmentalFeatureVector([
      snapshot({
        observedAt: "2026-07-11T18:00:00+09:00",
        pressure: 1012,
        waveHeight: 0.3,
        seaSurfaceTemperature: 24,
        seaLevelHeightMsl: 0.0
      }),
      snapshot({
        observedAt: "2026-07-12T00:00:00+09:00",
        pressure: 1003,
        waveHeight: 1.4,
        seaSurfaceTemperature: 27,
        seaLevelHeightMsl: 0.55
      })
    ], "2026-07-12T00:00:00+09:00");

    expect(features.rapidChanges.map((change) => change.field)).toEqual(expect.arrayContaining([
      "pressure",
      "waveHeight",
      "seaSurfaceTemperature",
      "seaLevelHeightMsl"
    ]));
  });

  it("flags conflicting provider values without auto-resolving them", () => {
    const contradictions = detectEnvironmentalContradictions([
      snapshot({ source: "open-meteo-weather", windSpeed: 3, windDirection: 20, seaSurfaceTemperature: 26, seaLevelHeightMsl: 0.1 }),
      snapshot({ source: "fixture-official", windSpeed: 12, windDirection: 190, seaSurfaceTemperature: 29.5, seaLevelHeightMsl: 0.7 })
    ]);

    expect(contradictions.map((item) => item.field)).toEqual(expect.arrayContaining([
      "windSpeed",
      "windDirection",
      "seaSurfaceTemperature",
      "seaLevelHeightMsl"
    ]));
  });
});
