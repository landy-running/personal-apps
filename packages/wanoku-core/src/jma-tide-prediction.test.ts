import { describe, expect, it } from "vitest";
import {
  HYDRO_COASTAL_PROVIDER_DEFINITIONS,
  convertWaterLevelToTp,
  validateHydroCoastalObservation,
  validateHydroCoastalStation
} from "./hydro-coastal";
import {
  JMA_TIDE_PREDICTION_LINE_LENGTH,
  JMA_TIDE_PREDICTION_STATIONS_2026,
  decimalDegreesFromDegreesMinutes,
  getJmaTidePredictionProviderDefinition,
  parseJmaTidePredictionFixedWidth,
  type JmaTidePredictionParseContext
} from "./jma-tide-prediction";

describe("JMA Tide Prediction Fixed-Width Parser v1", () => {
  it("parses one 136-character fixed-width line into daily record and 24 observations", () => {
    const line = buildJmaLine();
    const result = parseJmaTidePredictionFixedWidth(line, context());

    expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
    expect(result.errors).toEqual([]);
    expect(result.parsedLineCount).toBe(1);
    expect(result.observationCount).toBe(24);
    expect(result.dailyRecords[0]).toMatchObject({
      stationCode: "TK",
      localDate: "2026-01-01",
      highTides: [{ kind: "high", localTime: "06:30", levelCm: 125 }],
      lowTides: [{ kind: "low", localTime: "00:15", levelCm: 20 }]
    });
  });

  it("rejects non-empty lines that are not exactly 136 characters", () => {
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine().slice(0, 135), context()).errors).toContain("line 1: expected 136 characters, got 135.");
    expect(parseJmaTidePredictionFixedWidth(`${buildJmaLine()}X`, context()).errors).toContain("line 1: expected 136 characters, got 137.");
  });

  it("accepts LF, CRLF, and ignores empty lines", () => {
    const line = buildJmaLine();
    const lf = parseJmaTidePredictionFixedWidth(`${line}\n\n`, context());
    const crlf = parseJmaTidePredictionFixedWidth(`${line}\r\n\r\n`, context());

    expect(lf.inputLineCount).toBe(2);
    expect(lf.observationCount).toBe(24);
    expect(crlf.inputLineCount).toBe(2);
    expect(crlf.observationCount).toBe(24);
  });

  it("uses fixed columns for space-padded and negative hourly values", () => {
    const line = buildJmaLine({ hourlyLevels: [5, -3, ...Array.from({ length: 22 }, (_, index) => index + 10)] });
    const result = parseJmaTidePredictionFixedWidth(line, context());

    expect(result.errors).toEqual([]);
    expect(result.dailyRecords[0].hourlyLevelsCm[0]).toBe(5);
    expect(result.dailyRecords[0].hourlyLevelsCm[1]).toBe(-3);
    expect(result.observations[0].value).toBe(5);
    expect(result.observations[1].value).toBe(-3);
  });

  it("rejects invalid hourly fields without treating 999 as missing", () => {
    const invalidHourly = `${" A1"}${buildJmaLine().slice(3)}`;
    const sentinelLike = buildJmaLine({ hourlyLevels: [999, ...Array.from({ length: 23 }, () => 10)] });

    expect(parseJmaTidePredictionFixedWidth(invalidHourly, context()).errors).toContain('line 1 hour 0: invalid hourly tide level field " A1".');
    expect(parseJmaTidePredictionFixedWidth(sentinelLike, context()).observations[0].value).toBe(999);
  });

  it("validates YY against sourceYear and rejects nonexistent dates", () => {
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ yy: "25" }), context()).errors).toContain("line 1: YY 25 does not match sourceYear 2026.");
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ month: " 2", day: "30" }), context()).errors).toContain("line 1: nonexistent local date 2026-02-30.");
  });

  it("accepts leap day when sourceYear is leap year", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine({ yy: "24", month: " 2", day: "29" }), context({
      sourceYear: 2024,
      collectedAt: "2024-02-28T00:10:00.000Z",
      normalizedAt: "2024-02-28T00:10:00.000Z",
      forecastIssuedAt: "2024-02-28T00:00:00.000Z"
    }));

    expect(result.errors).toEqual([]);
    expect(result.dailyRecords[0].localDate).toBe("2024-02-29");
  });

  it("converts JST timestamps to canonical UTC without using local timezone", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine({ month: " 1", day: " 1" }), context());

    expect(result.observations[0].observedAt).toBe("2025-12-31T15:00:00.000Z");
    expect(result.observations[9].observedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.observations[0].provenance.sourceTimestamp).toBe("2026-01-01T00:00:00+09:00");
  });

  it("parses official station code TK and rejects unknown station codes", () => {
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ stationCode: "TK" }), context()).errors).toEqual([]);
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ stationCode: "ZZ" }), context()).errors).toContain("line 1: unknown JMA tide prediction station code ZZ.");
  });

  it("rejects station or provider context mismatches", () => {
    const badStation = { ...JMA_TIDE_PREDICTION_STATIONS_2026[0], providerId: "jma-tide-observation" as const };
    const badProvider = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((provider) => provider.providerId === "jma-tide-observation");

    expect(parseJmaTidePredictionFixedWidth(buildJmaLine(), context({ stations: [badStation] })).errors).toContain("station TK: providerId must be jma-tide-prediction.");
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine(), context({ provider: badProvider })).errors).toContain("provider.providerId must be jma-tide-prediction.");
  });

  it("keeps 2026 station fixture valid and converts degree-minute coordinates", () => {
    expect(decimalDegreesFromDegreesMinutes(35, 39)).toBe(35.65);
    expect(decimalDegreesFromDegreesMinutes(139, 46)).toBe(139.766667);
    expect(JMA_TIDE_PREDICTION_STATIONS_2026.map(validateHydroCoastalStation).every((result) => result.valid)).toBe(true);
    expect(JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => ({
      stationId: station.stationId,
      latitude: station.latitude,
      longitude: station.longitude,
      offsetToTpM: station.verticalDatum?.offsetToTpM ?? null
    }))).toEqual([
      { stationId: "TK", latitude: 35.65, longitude: 139.766667, offsetToTpM: -1.141 },
      { stationId: "CB", latitude: 35.6, longitude: 140.1, offsetToTpM: null },
      { stationId: "KZ", latitude: 35.366667, longitude: 139.916667, offsetToTpM: null },
      { stationId: "QS", latitude: 35.45, longitude: 139.65, offsetToTpM: -1.15 },
      { stationId: "TT", latitude: 34.983333, longitude: 139.85, offsetToTpM: null }
    ]);
    expect(JMA_TIDE_PREDICTION_STATIONS_2026.every((station) => station.sourceMetadata.syntheticFixture === false)).toBe(true);
    expect(JMA_TIDE_PREDICTION_STATIONS_2026.every((station) => station.sourceMetadata.sourceUrl === "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/")).toBe(true);
  });

  it("uses listed TP offsets for TK and QS while leaving KZ and TT unset", () => {
    const byId = new Map(JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => [station.stationId, station]));

    expect(convertWaterLevelToTp(2, byId.get("TK")?.verticalDatum)).toBe(0.859);
    expect(convertWaterLevelToTp(2, byId.get("QS")?.verticalDatum)).toBe(0.85);
    expect(byId.get("KZ")?.latitude).toBe(35.366667);
    expect(byId.get("KZ")?.longitude).toBe(139.916667);
    expect(byId.get("KZ")?.verticalDatum?.offsetToTpM).toBeNull();
    expect(byId.get("TT")?.latitude).toBe(34.983333);
    expect(byId.get("TT")?.longitude).toBe(139.85);
    expect(byId.get("TT")?.verticalDatum?.offsetToTpM).toBeNull();
  });

  it("parses normal high and low tides but omits 9999/999 extrema", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine({
      high: [
        { time: "0630", level: 125 },
        { time: "1845", level: -5 }
      ],
      low: [{ time: "9999", level: 999 }]
    }), context());

    expect(result.errors).toEqual([]);
    expect(result.dailyRecords[0].highTides).toEqual([
      { kind: "high", localTime: "06:30", levelCm: 125 },
      { kind: "high", localTime: "18:45", levelCm: -5 }
    ]);
    expect(result.dailyRecords[0].lowTides).toEqual([]);
  });

  it("parses JMA extrema times as two-character hour and minute fields", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine({
      high: [
        { time: " 4 8", level: 125 },
        { time: "10 2", level: 134 }
      ],
      low: [
        { time: "23 9", level: 45 },
        { time: "0630", level: 56 }
      ]
    }), context());

    expect(result.errors).toEqual([]);
    expect(result.dailyRecords[0].highTides).toEqual([
      { kind: "high", localTime: "04:08", levelCm: 125 },
      { kind: "high", localTime: "10:02", levelCm: 134 }
    ]);
    expect(result.dailyRecords[0].lowTides).toEqual([
      { kind: "low", localTime: "23:09", levelCm: 45 },
      { kind: "low", localTime: "06:30", levelCm: 56 }
    ]);
  });

  it("rejects partial extrema sentinels and invalid HHMM", () => {
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "9999", level: 100 }] }), context()).errors).toContain("line 1 high tide slot 1: partial sentinel is invalid.");
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "2460", level: 100 }] }), context()).errors).toContain('line 1 high tide slot 1: invalid HHMM "2460".');
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "24 0", level: 100 }] }), context()).errors).toContain('line 1 high tide slot 1: invalid HHMM "24 0".');
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "1260", level: 100 }] }), context()).errors).toContain('line 1 high tide slot 1: invalid HHMM "1260".');
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "0 30", level: 100 }] }), context()).errors).toContain('line 1 high tide slot 1: invalid HHMM "0 30".');
    expect(parseJmaTidePredictionFixedWidth(buildJmaLine({ high: [{ time: "    ", level: 100 }] }), context()).errors).toContain('line 1 high tide slot 1: invalid HHMM "    ".');
  });

  it("requires caller supplied forecastIssuedAt and does not fabricate it from collectedAt", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine(), context({ forecastIssuedAt: "not-iso" }));

    expect(result.observations).toEqual([]);
    expect(result.errors).toContain("forecastIssuedAt must be caller supplied canonical UTC ISO datetime.");
  });

  it("requires collectedAt and normalizedAt to be canonical UTC ISO", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine(), context({
      collectedAt: "2026-01-01T00:00:00+09:00",
      normalizedAt: "2026-01-01T00:00:00"
    }));

    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual(expect.arrayContaining([
      "collectedAt must be canonical UTC ISO datetime.",
      "normalizedAt must be canonical UTC ISO datetime."
    ]));
  });

  it("adds provenance, attribution, and validates all output observations", () => {
    const result = parseJmaTidePredictionFixedWidth(buildJmaLine(), context({ attribution: "出典: 気象庁。Wanokuが正規化・加工。" }));

    expect(result.observations).toHaveLength(24);
    expect(result.observations.every((observation) => validateHydroCoastalObservation(observation, {
      station: JMA_TIDE_PREDICTION_STATIONS_2026[0],
      provider: getJmaTidePredictionProviderDefinition()
    }).valid)).toBe(true);
    expect(result.observations[0]).toMatchObject({
      providerId: "jma-tide-prediction",
      stationId: "TK",
      metric: "predicted-tide-level",
      unit: "cm",
      status: "predicted",
      provisional: false,
      forecastIssuedAt: "2025-12-31T00:00:00.000Z"
    });
    expect(result.observations[0].provenance.attribution).toBe("出典: 気象庁。Wanokuが正規化・加工。");
    expect(result.observations[0].provenance.notes).toEqual(expect.arrayContaining([
      "source line 1",
      "forecastIssuedAt is caller supplied dataset issuance metadata; it is not present in the fixed-width line."
    ]));
  });

  it("is input-order independent for accepted daily records", () => {
    const tk = buildJmaLine({ stationCode: "TK" });
    const cb = buildJmaLine({ stationCode: "CB" });
    const left = parseJmaTidePredictionFixedWidth(`${cb}\n${tk}`, context());
    const right = parseJmaTidePredictionFixedWidth(`${tk}\n${cb}`, context());

    expect(left.dailyRecords.map((record) => record.stationCode)).toEqual(["CB", "TK"]);
    expect(right.dailyRecords.map((record) => record.stationCode)).toEqual(["CB", "TK"]);
    expect(left.observations.map((observation) => observation.stationId)).toEqual(right.observations.map((observation) => observation.stationId));
  });

  it("collapses exact duplicate daily lines with warning", () => {
    const line = buildJmaLine();
    const result = parseJmaTidePredictionFixedWidth(`${line}\n${line}`, context());

    expect(result.dailyRecords).toHaveLength(1);
    expect(result.observationCount).toBe(24);
    expect(result.warnings).toContain("duplicate JMA tide prediction daily line ignored: TK|2026-01-01");
  });

  it("rejects conflicting duplicate station/date groups without adopting either line", () => {
    const base = buildJmaLine();
    const changed = buildJmaLine({ hourlyLevels: [99, ...Array.from({ length: 23 }, (_, index) => index + 20)] });
    const result = parseJmaTidePredictionFixedWidth(`${changed}\n${base}`, context());

    expect(result.dailyRecords).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.errors).toContain("conflicting JMA tide prediction daily lines: TK|2026-01-01");
  });

  it("does not throw on malformed non-string input", () => {
    expect(() => parseJmaTidePredictionFixedWidth(null, context())).not.toThrow();
    expect(parseJmaTidePredictionFixedWidth(null, context()).errors).toContain("input must be a string.");
  });
});

function context(overrides: Partial<JmaTidePredictionParseContext> = {}): JmaTidePredictionParseContext {
  return {
    provider: getJmaTidePredictionProviderDefinition(),
    stations: JMA_TIDE_PREDICTION_STATIONS_2026,
    sourceYear: 2026,
    collectedAt: "2025-12-31T01:00:00.000Z",
    normalizedAt: "2025-12-31T01:00:00.000Z",
    forecastIssuedAt: "2025-12-31T00:00:00.000Z",
    sourceUrl: "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/",
    sourceName: "Japan Meteorological Agency tide table",
    attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku.",
    ...overrides
  };
}

function buildJmaLine(options: {
  hourlyLevels?: number[];
  yy?: string;
  month?: string;
  day?: string;
  stationCode?: string;
  high?: Array<{ time: string; level: number }>;
  low?: Array<{ time: string; level: number }>;
} = {}): string {
  const hourlyLevels = options.hourlyLevels ?? Array.from({ length: 24 }, (_, index) => index + 10);
  const hourly = hourlyLevels.map(formatLevel3).join("");
  const date = `${options.yy ?? "26"}${options.month ?? " 1"}${options.day ?? " 1"}`;
  const station = options.stationCode ?? "TK";
  const high = formatExtrema(options.high ?? [{ time: "0630", level: 125 }]);
  const low = formatExtrema(options.low ?? [{ time: "0015", level: 20 }]);
  const line = `${hourly}${date}${station}${high}${low}`;
  expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
  return line;
}

function formatExtrema(items: Array<{ time: string; level: number }>): string {
  const slots = items.map((item) => `${item.time}${formatLevel3(item.level)}`);
  while (slots.length < 4) slots.push("9999999");
  return slots.slice(0, 4).join("");
}

function formatLevel3(value: number): string {
  return String(value).padStart(3, " ");
}
