import {
  JMA_TIDE_PREDICTION_PROVIDER_ID,
  JMA_TIDE_PREDICTION_STATIONS_2026
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";

export const JMA_TIDE_PREDICTION_SOURCE_BASE_URL = "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/";
export const JMA_TIDE_PREDICTION_SOURCE_YEARS = [2026];

const STATIONS_BY_ID = new Map(JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => [station.stationId, station]));
const STATION_ID_PATTERN = /^[A-Z0-9]{2}$/;

export function buildJmaTidePredictionSourceUrl(input = {}) {
  const validation = validateJmaTidePredictionSourceInput(input);
  if (!validation.ok) return validation;
  const url = new URL(`${validation.sourceYear}/${validation.stationId}.txt`, JMA_TIDE_PREDICTION_SOURCE_BASE_URL);
  return {
    ok: true,
    sourceUrl: url.toString(),
    errors: [],
    warnings: []
  };
}

export function getJmaTidePredictionSourceDefinition(input = {}) {
  const validation = validateJmaTidePredictionSourceInput(input);
  if (!validation.ok) return { ...validation, source: null };
  const station = STATIONS_BY_ID.get(validation.stationId);
  const url = new URL(`${validation.sourceYear}/${validation.stationId}.txt`, JMA_TIDE_PREDICTION_SOURCE_BASE_URL);
  return {
    ok: true,
    source: {
      providerId: JMA_TIDE_PREDICTION_PROVIDER_ID,
      stationId: station.stationId,
      stationName: station.name,
      sourceYear: validation.sourceYear,
      sourceUrl: url.toString(),
      sourceName: `Japan Meteorological Agency tide prediction text data ${validation.sourceYear} ${station.stationId}`,
      attribution: "Source: Japan Meteorological Agency. Normalized and processed by Wanoku."
    },
    errors: [],
    warnings: []
  };
}

export function listJmaTidePredictionSourceDefinitions(sourceYear = 2026) {
  return JMA_TIDE_PREDICTION_STATIONS_2026.map((station) => getJmaTidePredictionSourceDefinition({
    stationId: station.stationId,
    sourceYear
  }).source);
}

function validateJmaTidePredictionSourceInput(input) {
  const errors = [];
  const warnings = [];
  const stationIdInput = typeof input.stationId === "string" ? input.stationId : null;
  const stationId = stationIdInput && STATION_ID_PATTERN.test(stationIdInput) ? stationIdInput : null;
  const sourceYear = input.sourceYear;

  if (!stationId) {
    errors.push("stationId must be one of the supported two-character JMA station codes.");
  } else if (!STATIONS_BY_ID.has(stationId)) {
    errors.push(`unsupported JMA tide prediction stationId: ${stationId}`);
  }

  if (!Number.isInteger(sourceYear)) {
    errors.push("sourceYear must be an integer.");
  } else if (!JMA_TIDE_PREDICTION_SOURCE_YEARS.includes(sourceYear)) {
    errors.push(`unsupported JMA tide prediction sourceYear: ${sourceYear}`);
  }

  return {
    ok: errors.length === 0,
    stationId,
    sourceYear,
    errors,
    warnings
  };
}
