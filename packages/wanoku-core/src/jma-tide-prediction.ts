import {
  HYDRO_COASTAL_PROVIDER_DEFINITIONS,
  HYDRO_COASTAL_SCHEMA_VERSION,
  type HydroCoastalObservation,
  type HydroCoastalParseResult,
  type HydroCoastalProviderAdapter,
  type HydroCoastalProviderDefinition,
  type HydroCoastalProvenance,
  type HydroCoastalStation,
  validateHydroCoastalObservation,
  validateHydroCoastalProviderDefinition,
  validateHydroCoastalStation
} from "./hydro-coastal";

export const JMA_TIDE_PREDICTION_PROVIDER_ID = "jma-tide-prediction";
export const JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION = "jma-tide-prediction-fixed-width-136.v1";
export const JMA_TIDE_PREDICTION_PARSER_ID = "wanoku-jma-tide-prediction-fixed-width";
export const JMA_TIDE_PREDICTION_PARSER_VERSION = "1.0.0";
export const JMA_TIDE_PREDICTION_LINE_LENGTH = 136;

export type JmaTidePredictionParseContext = {
  provider: HydroCoastalProviderDefinition;
  stations: readonly HydroCoastalStation[];
  sourceYear: number;
  collectedAt: string;
  normalizedAt: string;
  forecastIssuedAt: string;
  sourceUrl?: string;
  sourceName?: string;
  attribution?: string;
};

export type JmaTideExtremum = {
  kind: "high" | "low";
  localTime: string;
  levelCm: number;
};

export type JmaTidePredictionDailyRecord = {
  stationCode: string;
  localDate: string;
  hourlyLevelsCm: number[];
  highTides: JmaTideExtremum[];
  lowTides: JmaTideExtremum[];
  sourceLineNumber: number;
};

export type JmaTidePredictionParseResult = HydroCoastalParseResult & {
  dailyRecords: JmaTidePredictionDailyRecord[];
  inputLineCount: number;
  parsedLineCount: number;
  observationCount: number;
};

type ParsedLine = {
  rawLine: string;
  record: JmaTidePredictionDailyRecord;
};

type ParseLineResult = {
  parsedLine?: ParsedLine;
  errors: string[];
  warnings: string[];
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const JMA_TIDE_PREDICTION_STATIONS_2026: HydroCoastalStation[] = [
  jmaTideStation("TK", "東京", 35, 39, 139, 46, -1.141),
  jmaTideStation("CB", "千葉港", 35, 36, 140, 6, null),
  jmaTideStation("KZ", "木更津", 35, 22, 139, 55, null),
  jmaTideStation("QS", "横浜", 35, 27, 139, 39, -1.15),
  jmaTideStation("TT", "館山", 34, 59, 139, 51, null)
];

export const JMA_TIDE_PREDICTION_FIXED_WIDTH_ADAPTER: HydroCoastalProviderAdapter<string, JmaTidePredictionParseContext> = {
  providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
  sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
  parse: parseJmaTidePredictionFixedWidth
};

export function parseJmaTidePredictionFixedWidth(input: unknown, context: JmaTidePredictionParseContext): JmaTidePredictionParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: HydroCoastalObservation[] = [];
  const dailyRecords: JmaTidePredictionDailyRecord[] = [];

  if (typeof input !== "string") {
    errors.push("input must be a string.");
    return parseResult({ dailyRecords, observations, errors, warnings, inputLineCount: 0 });
  }

  const contextErrors = validateContext(context);
  errors.push(...contextErrors);
  if (contextErrors.length) {
    return parseResult({ dailyRecords, observations, errors, warnings, inputLineCount: countInputLines(input) });
  }

  const provider = context.provider;
  const stations = new Map(context.stations.map((station) => [station.stationId, station]));
  const rawLines = normalizeInputLines(input);
  const parsedLines: ParsedLine[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.content.length === 0) continue;
    const parsed = parseLine(rawLine.content, rawLine.lineNumber, context.sourceYear);
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);
    if (parsed.parsedLine) parsedLines.push(parsed.parsedLine);
  }

  const byDailyKey = new Map<string, ParsedLine[]>();
  for (const parsed of parsedLines) {
    const key = `${parsed.record.stationCode}|${parsed.record.localDate}`;
    byDailyKey.set(key, [...(byDailyKey.get(key) ?? []), parsed]);
  }

  const acceptedLines: ParsedLine[] = [];
  for (const [key, group] of Array.from(byDailyKey.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    if (group.length === 1) {
      acceptedLines.push(group[0]);
      continue;
    }
    const uniqueRawLines = new Set(group.map((item) => item.rawLine));
    if (uniqueRawLines.size === 1) {
      warnings.push(`duplicate JMA tide prediction daily line ignored: ${key}`);
      acceptedLines.push(group[0]);
    } else {
      errors.push(`conflicting JMA tide prediction daily lines: ${key}`);
    }
  }

  for (const parsed of acceptedLines.sort(compareParsedLineStable)) {
    const station = stations.get(parsed.record.stationCode);
    if (!station) {
      errors.push(`line ${parsed.record.sourceLineNumber}: unknown JMA tide prediction station code ${parsed.record.stationCode}.`);
      continue;
    }
    const stationValidation = validateHydroCoastalStation(station);
    if (!stationValidation.valid) {
      errors.push(...stationValidation.errors.map((error) => `station ${station.stationId}: ${error}`));
      continue;
    }
    if (station.providerId !== JMA_TIDE_PREDICTION_PROVIDER_ID) {
      errors.push(`station ${station.stationId}: providerId must be ${JMA_TIDE_PREDICTION_PROVIDER_ID}.`);
      continue;
    }
    dailyRecords.push(parsed.record);
    for (let hour = 0; hour < 24; hour += 1) {
      const observedAt = jstDateTimeToUtcIso(context.sourceYear, monthFromLocalDate(parsed.record.localDate), dayFromLocalDate(parsed.record.localDate), hour, 0);
      const observation: HydroCoastalObservation = {
        schemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
        providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
        stationId: station.stationId,
        metric: "predicted-tide-level",
        observedAt,
        collectedAt: context.collectedAt,
        forecastIssuedAt: context.forecastIssuedAt,
        value: parsed.record.hourlyLevelsCm[hour],
        unit: "cm",
        status: "predicted",
        provisional: false,
        verticalDatum: station.verticalDatum,
        provenance: createProvenance(context, parsed.record, hour)
      };
      const validation = validateHydroCoastalObservation(observation, { station, provider });
      warnings.push(...validation.warnings.map((warning) => `line ${parsed.record.sourceLineNumber} hour ${hour}: ${warning}`));
      if (!validation.valid) {
        errors.push(...validation.errors.map((error) => `line ${parsed.record.sourceLineNumber} hour ${hour}: ${error}`));
        continue;
      }
      observations.push(observation);
    }
  }

  return parseResult({
    dailyRecords,
    observations,
    errors,
    warnings,
    inputLineCount: rawLines.length
  });
}

export function decimalDegreesFromDegreesMinutes(degrees: number, minutes: number): number {
  return Math.round((degrees + minutes / 60) * 1_000_000) / 1_000_000;
}

function parseLine(line: string, lineNumber: number, sourceYear: number): ParseLineResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (line.length !== JMA_TIDE_PREDICTION_LINE_LENGTH) {
    return {
      errors: [`line ${lineNumber}: expected ${JMA_TIDE_PREDICTION_LINE_LENGTH} characters, got ${line.length}.`],
      warnings
    };
  }

  const hourlyLevelsCm: number[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const field = line.slice(hour * 3, hour * 3 + 3);
    const parsed = parseSignedIntegerField(field);
    if (parsed == null) {
      errors.push(`line ${lineNumber} hour ${hour}: invalid hourly tide level field "${field}".`);
    } else {
      hourlyLevelsCm.push(parsed);
    }
  }

  const yyField = line.slice(72, 74);
  const monthField = line.slice(74, 76);
  const dayField = line.slice(76, 78);
  const yy = parseUnsignedIntegerField(yyField);
  const month = parseUnsignedIntegerField(monthField);
  const day = parseUnsignedIntegerField(dayField);
  const stationCode = line.slice(78, 80);

  if (yy == null) errors.push(`line ${lineNumber}: invalid year field "${yyField}".`);
  if (month == null) errors.push(`line ${lineNumber}: invalid month field "${monthField}".`);
  if (day == null) errors.push(`line ${lineNumber}: invalid day field "${dayField}".`);
  if (!/^[A-Z0-9]{2}$/.test(stationCode)) errors.push(`line ${lineNumber}: invalid station code "${stationCode}".`);
  if (yy != null && yy !== sourceYear % 100) {
    errors.push(`line ${lineNumber}: YY ${yyField} does not match sourceYear ${sourceYear}.`);
  }
  if (month != null && day != null && !isValidLocalDate(sourceYear, month, day)) {
    errors.push(`line ${lineNumber}: nonexistent local date ${sourceYear}-${pad2(month)}-${pad2(day)}.`);
  }

  const highTides = parseExtremaSlots(line.slice(80, 108), "high", lineNumber, errors);
  const lowTides = parseExtremaSlots(line.slice(108, 136), "low", lineNumber, errors);

  if (errors.length || yy == null || month == null || day == null) {
    return { errors, warnings };
  }

  return {
    parsedLine: {
      rawLine: line,
      record: {
        stationCode,
        localDate: `${sourceYear}-${pad2(month)}-${pad2(day)}`,
        hourlyLevelsCm,
        highTides,
        lowTides,
        sourceLineNumber: lineNumber
      }
    },
    errors,
    warnings
  };
}

function parseExtremaSlots(section: string, kind: "high" | "low", lineNumber: number, errors: string[]): JmaTideExtremum[] {
  const extrema: JmaTideExtremum[] = [];
  for (let index = 0; index < 4; index += 1) {
    const slot = section.slice(index * 7, index * 7 + 7);
    const timeField = slot.slice(0, 4);
    const levelField = slot.slice(4, 7);
    const timeSentinel = timeField === "9999";
    const levelSentinel = levelField === "999";
    if (timeSentinel && levelSentinel) continue;
    if (timeSentinel !== levelSentinel) {
      errors.push(`line ${lineNumber} ${kind} tide slot ${index + 1}: partial sentinel is invalid.`);
      continue;
    }
    const localTime = parseJmaTimeField(timeField);
    const levelCm = parseSignedIntegerField(levelField);
    if (localTime == null) errors.push(`line ${lineNumber} ${kind} tide slot ${index + 1}: invalid HHMM "${timeField}".`);
    if (levelCm == null) errors.push(`line ${lineNumber} ${kind} tide slot ${index + 1}: invalid tide level "${levelField}".`);
    if (localTime != null && levelCm != null) extrema.push({ kind, localTime, levelCm });
  }
  return extrema;
}

function validateContext(context: JmaTidePredictionParseContext): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(context.sourceYear) || context.sourceYear < 1000 || context.sourceYear > 9999) {
    errors.push("sourceYear must be a four-digit integer.");
  }
  if (!isCanonicalUtcIsoDateTime(context.collectedAt)) errors.push("collectedAt must be canonical UTC ISO datetime.");
  if (!isCanonicalUtcIsoDateTime(context.normalizedAt)) errors.push("normalizedAt must be canonical UTC ISO datetime.");
  if (!isCanonicalUtcIsoDateTime(context.forecastIssuedAt)) errors.push("forecastIssuedAt must be caller supplied canonical UTC ISO datetime.");
  const providerValidation = validateHydroCoastalProviderDefinition(context.provider);
  if (!providerValidation.valid) errors.push(...providerValidation.errors.map((error) => `provider: ${error}`));
  if (context.provider?.providerId !== JMA_TIDE_PREDICTION_PROVIDER_ID) errors.push(`provider.providerId must be ${JMA_TIDE_PREDICTION_PROVIDER_ID}.`);
  if (!Array.isArray(context.stations) || context.stations.length === 0) {
    errors.push("stations must not be empty.");
  } else {
    for (const station of context.stations) {
      const stationValidation = validateHydroCoastalStation(station);
      if (!stationValidation.valid) errors.push(...stationValidation.errors.map((error) => `station ${station.stationId}: ${error}`));
      if (station.providerId !== JMA_TIDE_PREDICTION_PROVIDER_ID) errors.push(`station ${station.stationId}: providerId must be ${JMA_TIDE_PREDICTION_PROVIDER_ID}.`);
    }
  }
  return Array.from(new Set(errors));
}

function createProvenance(context: JmaTidePredictionParseContext, record: JmaTidePredictionDailyRecord, hour: number): HydroCoastalProvenance {
  return {
    sourceName: context.sourceName ?? "Japan Meteorological Agency tide table",
    sourceKind: "official",
    sourceUrl: context.sourceUrl,
    sourceTimestamp: `${record.localDate}T${pad2(hour)}:00:00+09:00`,
    sourceTimezone: "Asia/Tokyo",
    normalizedAt: context.normalizedAt,
    parserId: JMA_TIDE_PREDICTION_PARSER_ID,
    parserVersion: JMA_TIDE_PREDICTION_PARSER_VERSION,
    sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
    attribution: context.attribution ?? "Source: Japan Meteorological Agency. Normalized and processed by Wanoku.",
    notes: [
      `source line ${record.sourceLineNumber}`,
      `hour ${hour}`,
      `station code ${record.stationCode}`,
      "forecastIssuedAt is caller supplied dataset issuance metadata; it is not present in the fixed-width line."
    ]
  };
}

function jmaTideStation(
  stationId: string,
  name: string,
  latitudeDegrees: number,
  latitudeMinutes: number,
  longitudeDegrees: number,
  longitudeMinutes: number,
  offsetToTpM: number | null
): HydroCoastalStation {
  return {
    stationId,
    providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
    name,
    latitude: decimalDegreesFromDegreesMinutes(latitudeDegrees, latitudeMinutes),
    longitude: decimalDegreesFromDegreesMinutes(longitudeDegrees, longitudeMinutes),
    stationType: "forecast-point",
    supportedMetrics: ["predicted-tide-level"],
    timezone: "Asia/Tokyo",
    active: true,
    verticalDatum: {
      type: "tide-table-datum",
      stationSpecific: true,
      offsetToTpM,
      description: "JMA 2026 tide table datum for the station. TP offset is set only when listed in the official station list as of 2026-06-12."
    },
    sourceMetadata: {
      authority: "Japan Meteorological Agency",
      sourceName: "2026年気象庁潮位表掲載地点一覧",
      sourceUrl: "https://www.data.jma.go.jp/kaiyou/db/tide/suisan/",
      syntheticFixture: false,
      notes: [
        "Station fixture for local fixed-width parser tests based on official values as of 2026-06-12.",
        "Coordinates are encoded from degree-minute station metadata and should be rechecked when the annual JMA station list is updated.",
        "TP offsets are set only for stations whose tide table datum elevation is listed in the official station list."
      ]
    }
  };
}

function parseResult(input: {
  dailyRecords: JmaTidePredictionDailyRecord[];
  observations: HydroCoastalObservation[];
  errors: string[];
  warnings: string[];
  inputLineCount: number;
}): JmaTidePredictionParseResult {
  return {
    providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
    sourceFormatVersion: JMA_TIDE_PREDICTION_SOURCE_FORMAT_VERSION,
    dailyRecords: input.dailyRecords,
    observations: input.observations,
    errors: Array.from(new Set(input.errors)),
    warnings: Array.from(new Set(input.warnings)),
    inputLineCount: input.inputLineCount,
    parsedLineCount: input.dailyRecords.length,
    observationCount: input.observations.length
  };
}

function normalizeInputLines(input: string): Array<{ content: string; lineNumber: number }> {
  const lines = input.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => ({
    content: line.endsWith("\r") ? line.slice(0, -1) : line,
    lineNumber: index + 1
  }));
}

function countInputLines(input: string): number {
  return normalizeInputLines(input).length;
}

function parseSignedIntegerField(field: string): number | null {
  const trimmed = field.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

function parseUnsignedIntegerField(field: string): number | null {
  const trimmed = field.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

function parseJmaTimeField(field: string): string | null {
  const trimmed = field.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const padded = trimmed.padStart(4, "0");
  const hour = Number.parseInt(padded.slice(0, 2), 10);
  const minute = Number.parseInt(padded.slice(2, 4), 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function jstDateTimeToUtcIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0)).toISOString();
}

function isValidLocalDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function monthFromLocalDate(localDate: string): number {
  return Number.parseInt(localDate.slice(5, 7), 10);
}

function dayFromLocalDate(localDate: string): number {
  return Number.parseInt(localDate.slice(8, 10), 10);
}

function compareParsedLineStable(left: ParsedLine, right: ParsedLine): number {
  const keyLeft = `${left.record.stationCode}|${left.record.localDate}|${left.record.sourceLineNumber}`;
  const keyRight = `${right.record.stationCode}|${right.record.localDate}|${right.record.sourceLineNumber}`;
  return keyLeft.localeCompare(keyRight);
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function getJmaTidePredictionProviderDefinition(): HydroCoastalProviderDefinition {
  const provider = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((item) => item.providerId === JMA_TIDE_PREDICTION_PROVIDER_ID);
  if (!provider) throw new Error("JMA tide prediction provider definition is missing.");
  return provider;
}
