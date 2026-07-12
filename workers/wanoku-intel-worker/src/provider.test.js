import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fetchJsonWithTimeout,
  normalizeOpenMeteoMarine,
  normalizeOpenMeteoWeather
} from "./index.js";
import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";

const node = TOKYO_BAY_ENVIRONMENT_NODES[0];

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/wanoku-intelligence/${name}`, import.meta.url), "utf8"));
}

describe("wanoku intel worker environmental providers", () => {
  it("normalizes Open-Meteo weather without exposing raw API response shape", () => {
    const snapshots = normalizeOpenMeteoWeather(fixture("open-meteo-weather-hourly.json"), node, {
      requestedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T00:00:02Z",
      rawHash: "fixture-hash"
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toMatchObject({
      nodeId: node.id,
      source: "open-meteo-weather",
      windSpeed: 4.2,
      windDirection: 350,
      pressure: 1008.2,
      airTemperature: 27.8
    });
    expect(snapshots[0].hourly).toBeUndefined();
    expect(snapshots[0].provenance[0].rawHash).toBe("fixture-hash");
  });

  it("normalizes Open-Meteo marine values including currents and sea level model output", () => {
    const snapshots = normalizeOpenMeteoMarine(fixture("open-meteo-marine-hourly.json"), node, {
      requestedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toMatchObject({
      source: "open-meteo-marine",
      waveHeight: 0.7,
      swellHeight: 0.22,
      seaSurfaceTemperature: 26.7,
      oceanCurrentVelocity: 0.35,
      oceanCurrentDirection: 95,
      seaLevelHeightMsl: 0.15
    });
  });

  it("marks missing provider variables as missing fields", () => {
    const snapshots = normalizeOpenMeteoWeather(fixture("open-meteo-weather-missing-fields.json"), node, {
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(snapshots[0].missingFields).toEqual(expect.arrayContaining(["windSpeed"]));
    expect(snapshots[0].confidence).toBeLessThan(0.82);
  });

  it("classifies provider timeout as a timeout error", async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });

    await expect(fetchJsonWithTimeout("https://example.invalid/slow", {
      timeoutMs: 1,
      retries: 0,
      fetchImpl
    })).rejects.toMatchObject({ errorCode: "timeout" });
  });

  it("classifies HTTP errors and malformed JSON separately", async () => {
    await expect(fetchJsonWithTimeout("https://example.invalid/http", {
      retries: 0,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
    })).rejects.toMatchObject({ errorCode: "http_error", httpStatus: 503 });

    await expect(fetchJsonWithTimeout("https://example.invalid/json", {
      retries: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        }
      })
    })).rejects.toMatchObject({ errorCode: "malformed_response" });
  });

  it("rejects malformed provider payloads during normalization", () => {
    expect(() => normalizeOpenMeteoWeather(fixture("open-meteo-malformed.json"), node, {})).toThrow(/not usable/);
  });
});
