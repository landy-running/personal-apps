import { describe, expect, it } from "vitest";
import {
  JMA_TIDE_PREDICTION_STATIONS_2026
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";
import {
  JMA_TIDE_PREDICTION_SOURCE_BASE_URL,
  buildJmaTidePredictionSourceUrl,
  getJmaTidePredictionSourceDefinition,
  listJmaTidePredictionSourceDefinitions
} from "./jma-tide-prediction-sources.js";

describe("JMA tide prediction official source catalog", () => {
  it("builds exact official 2026 URLs for all allowlisted stations", () => {
    expect(JMA_TIDE_PREDICTION_SOURCE_BASE_URL).toBe("https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/");
    const definitions = listJmaTidePredictionSourceDefinitions();

    expect(definitions.map((item) => item.stationId)).toEqual(JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => station.stationId));
    for (const station of JMA_TIDE_PREDICTION_STATIONS_2026) {
      const result = getJmaTidePredictionSourceDefinition({ stationId: station.stationId, sourceYear: 2026 });
      expect(result.ok).toBe(true);
      expect(result.source).toMatchObject({
        providerId: "jma-tide-prediction",
        stationId: station.stationId,
        stationName: station.name,
        sourceYear: 2026,
        sourceUrl: `https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/${station.stationId}.txt`
      });
      expect(result.source.attribution).toContain("Japan Meteorological Agency");
    }
  });

  it("rejects unsupported year, unsupported station, and path/query injection inputs", () => {
    const invalidInputs = [
      { stationId: "ZZ", sourceYear: 2026 },
      { stationId: "TK", sourceYear: 2027 },
      { stationId: "../TK", sourceYear: 2026 },
      { stationId: "TK.txt?x=1", sourceYear: 2026 },
      { stationId: "TK#frag", sourceYear: 2026 },
      { stationId: "https://evil.example/TK", sourceYear: 2026 },
      { stationId: "T/K", sourceYear: 2026 },
      { stationId: "TK", sourceYear: "2026" }
    ];

    for (const input of invalidInputs) {
      const definition = getJmaTidePredictionSourceDefinition(input);
      const url = buildJmaTidePredictionSourceUrl(input);
      expect(definition.ok).toBe(false);
      expect(definition.source).toBeNull();
      expect(definition.errors.length).toBeGreaterThan(0);
      expect(url.ok).toBe(false);
      expect(JSON.stringify(definition)).not.toContain("evil.example");
    }
  });

  it("is deterministic and does not accept caller-supplied URL components", () => {
    const first = getJmaTidePredictionSourceDefinition({
      stationId: "TK",
      sourceYear: 2026,
      sourceUrl: "https://evil.example/secret.txt"
    });
    const second = getJmaTidePredictionSourceDefinition({
      stationId: "TK",
      sourceYear: 2026,
      sourceUrl: "https://other.example/secret.txt"
    });

    expect(first.ok).toBe(true);
    expect(first.source).toEqual(second.source);
    expect(first.source.sourceUrl).toBe("https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/TK.txt");
    expect(first.source.sourceUrl).not.toContain("evil");
  });
});
