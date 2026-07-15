import { TOKYO_BAY_ENVIRONMENT_NODES } from "./environment-nodes.js";
import { ingestJmaTidePredictionSource } from "./jma-tide-prediction-ingestion.js";
import { getJmaTidePredictionSourceDefinition } from "./jma-tide-prediction-sources.js";

const SERVICE_NAME = "wanoku-intel-worker";
const DEFAULT_WANOKU_PWA_ORIGIN = "https://wanoku-pwa.pages.dev";
const DEFAULT_LOCAL_DEV_ORIGINS = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
const ENVIRONMENTAL_SCHEMA_VERSION = "wanoku-environmental-snapshot.v1";
const ENVIRONMENTAL_MODEL_VERSION = "wanoku-environmental-spine-v1";
const WEATHER_PROVIDER = "open-meteo-weather";
const MARINE_PROVIDER = "open-meteo-marine";
const MAX_SNAPSHOTS_PER_PROVIDER = 73;
const COLLECTED_SNAPSHOTS_PER_NODE_PROVIDER = 1;
const D1_MAX_BOUND_PARAMS_PER_STATEMENT = 90;
const ADMIN_JMA_TIDE_BODY_MAX_BYTES = 4096;
const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_RUN_COLUMNS = [
  "id",
  "provider",
  "node_id",
  "requested_at",
  "completed_at",
  "status",
  "http_status",
  "error_code",
  "model_version",
  "raw_hash",
  "normalized_schema_version"
];
const ENVIRONMENTAL_SNAPSHOT_COLUMNS = [
  "snapshot_key",
  "source_run_id",
  "provider",
  "node_id",
  "observed_at",
  "collected_at",
  "forecast_issued_at",
  "latitude",
  "longitude",
  "source",
  "model",
  "confidence",
  "freshness",
  "missing_fields_json",
  "normalized_schema_version",
  "raw_hash",
  "normalized_json",
  "created_at"
];

const SOURCES = [
  {
    id: "manual-sns",
    name: "Manual SNS/post URL",
    kind: "sns",
    reliabilityPrior: 0.55,
    policy: "Manual URL intake only; no unauthorized scraping dependency."
  },
  {
    id: "youtube-channel-alpha",
    name: "YouTube fishing report fixture",
    kind: "youtube",
    reliabilityPrior: 0.62,
    policy: "Prefer YouTube Data API or manual URL intake."
  },
  {
    id: "shop-report-beta",
    name: "Fishing shop report fixture",
    kind: "shop",
    reliabilityPrior: 0.82,
    policy: "Use official pages, RSS, or APIs only when terms permit."
  },
  {
    id: "official-environment",
    name: "Official/public environmental data",
    kind: "official",
    reliabilityPrior: 0.93,
    policy: "Prefer public APIs, RSS, and open datasets."
  },
  {
    id: WEATHER_PROVIDER,
    name: "Open-Meteo Weather API",
    kind: "official",
    reliabilityPrior: 0.82,
    policy: "Weather provider adapter normalizes wind, pressure, rain and temperature; raw API responses are not returned to clients."
  },
  {
    id: MARINE_PROVIDER,
    name: "Open-Meteo Marine API",
    kind: "official",
    reliabilityPrior: 0.78,
    policy: "Marine provider adapter normalizes wave, swell, SST, current and sea-level model output; not used as coastal tide truth."
  }
];

const EVIDENCE = [
  {
    id: "sns-seabass-ariake-20260710",
    sourceId: "sns-post-001",
    source: SOURCES[0],
    observedAt: "2026-07-10T21:20:00+09:00",
    publishedAt: "2026-07-10T23:05:00+09:00",
    species: [{ species: "seabass", count: 2, sizeCm: 58, behavior: "night bite near light/current edge" }],
    location: { label: "Ariake canal area", lat: 35.6368, lon: 139.7898, radiusM: 1200, confidence: 0.55 },
    locationConfidence: 0.55,
    sourceReliability: 0.52,
    timeConfidence: 0.76,
    duplicateGroupId: "grp-seabass-ariake-20260710",
    evidenceUrl: "https://example.com/sns/seabass-ariake-20260710",
    extractedFacts: ["observed at night", "Ariake canal area", "2 seabass", "baitfish noted"]
  },
  {
    id: "youtube-chinu-canal-20260708",
    sourceId: "yt-video-001",
    source: SOURCES[1],
    observedAt: "2026-07-08T19:00:00+09:00",
    publishedAt: "2026-07-11T18:00:00+09:00",
    species: [{ species: "chinu", count: 3, sizeCm: 42, behavior: "bottom bite" }],
    location: { label: "Inner bay canal zone", lat: 35.6502, lon: 139.7891, radiusM: 2500, confidence: 0.48 },
    locationConfidence: 0.48,
    sourceReliability: 0.64,
    timeConfidence: 0.7,
    evidenceUrl: "https://www.youtube.com/watch?v=example001",
    extractedFacts: ["published later than trip", "canal zone", "3 chinu", "bottom lure"]
  },
  {
    id: "shop-aji-report-20260711",
    sourceId: "shop-report-20260711-aji",
    source: SOURCES[2],
    observedAt: "2026-07-11T04:30:00+09:00",
    publishedAt: "2026-07-11T10:00:00+09:00",
    species: [{ species: "aji", count: 12, sizeCm: 18, behavior: "early morning school" }],
    location: { label: "Wakasu direction", lat: 35.6163, lon: 139.8324, radiusM: 1800, confidence: 0.72 },
    locationConfidence: 0.72,
    sourceReliability: 0.84,
    timeConfidence: 0.86,
    evidenceUrl: "https://example.com/shop/reports/20260711-aji",
    extractedFacts: ["early morning", "Wakasu direction", "12 aji", "small baitfish"]
  },
  {
    id: "official-env-tokyobay-20260711",
    sourceId: "env-20260711-tokyobay",
    source: SOURCES[3],
    observedAt: "2026-07-11T09:00:00+09:00",
    publishedAt: "2026-07-11T09:20:00+09:00",
    species: [{ species: "environment", behavior: "water temperature/wind/tide fixture" }],
    location: { label: "Tokyo Bay environmental fixture", lat: 35.62, lon: 139.82, radiusM: 12000, confidence: 0.9 },
    locationConfidence: 0.9,
    sourceReliability: 0.94,
    timeConfidence: 0.95,
    evidenceUrl: "https://example.com/official/environment/tokyobay",
    extractedFacts: ["SST 27.1C", "south wind", "falling tide", "post-rain turbidity"]
  },
  {
    id: "repost-seabass-ariake-20260710",
    sourceId: "rss-repost-001",
    source: { id: "summary-blog", name: "Fishing report summary blog", kind: "rss", reliabilityPrior: 0.42 },
    observedAt: "2026-07-10T21:20:00+09:00",
    publishedAt: "2026-07-11T08:00:00+09:00",
    species: [{ species: "seabass", count: 2, sizeCm: 58 }],
    location: { label: "Ariake canal area", lat: 35.6367, lon: 139.7897, radiusM: 1500, confidence: 0.5 },
    locationConfidence: 0.5,
    sourceReliability: 0.42,
    timeConfidence: 0.62,
    duplicateGroupId: "grp-seabass-ariake-20260710",
    evidenceUrl: "https://example.com/rss/repost-seabass-ariake",
    extractedFacts: ["repost", "Ariake canal area", "2 seabass"]
  }
];

const WEATHER_HOURLY = [
  "temperature_2m",
  "precipitation",
  "pressure_msl",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m"
].join(",");

const MARINE_HOURLY = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "wind_wave_height",
  "wind_wave_direction",
  "wind_wave_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "sea_surface_temperature",
  "ocean_current_velocity",
  "ocean_current_direction",
  "sea_level_height_msl"
].join(",");

export function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function allowedOrigins(env = {}) {
  return new Set([
    env.WANOKU_PWA_ORIGIN || DEFAULT_WANOKU_PWA_ORIGIN,
    ...splitOrigins(env.LOCAL_DEV_ORIGINS || DEFAULT_LOCAL_DEV_ORIGINS.join(","))
  ]);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Wanoku-Admin-Secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isCorsAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).has(origin);
}

function json(request, env, payload, init = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
      ...(init.headers || {})
    }
  });
}

function publicEnv(env) {
  return {
    wanokuPwaOriginConfigured: Boolean(env.WANOKU_PWA_ORIGIN),
    allowedOrigins: [...allowedOrigins(env)],
    d1Configured: hasD1(env),
    mockEvidence: true,
    environmentalSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
    modelVersion: ENVIRONMENTAL_MODEL_VERSION
  };
}

function filterEvidence(url) {
  const species = url.searchParams.get("species");
  if (!species) return EVIDENCE;
  return EVIDENCE.filter((event) => event.species.some((item) => item.species === species));
}

function duplicateCandidates() {
  return [
    {
      leftId: "sns-seabass-ariake-20260710",
      rightId: "repost-seabass-ariake-20260710",
      score: 0.79,
      confidence: "likely",
      reasons: ["same duplicateGroupId", "near observed time", "near location", "overlapping species", "similar text/facts"]
    }
  ];
}

function mockPredictions() {
  return {
    id: "pred-mock-20260711-night",
    generatedAt: "2026-07-11T12:00:00+09:00",
    targetWindowStart: "2026-07-11T18:00:00+09:00",
    targetWindowEnd: "2026-07-12T06:00:00+09:00",
    modelVersion: "wanoku-intel-mock-v0",
    evidenceIds: EVIDENCE.map((event) => event.id),
    estimates: [
      {
        species: "seabass",
        location: { label: "Ariake to river-mouth light/current belt", lat: 35.64, lon: 139.8, radiusM: 3500, confidence: 0.54 },
        probability: 0.61,
        confidence: 0.48,
        computedAt: "2026-07-11T12:00:00+09:00",
        drivers: [
          { factor: "recent evidence", contribution: 0.28, note: "fixture evidence only; duplicate/repost is downweighted" },
          { factor: "environment", contribution: 0.18, note: "falling tide, rain, south wind fixture" },
          { factor: "habitat", contribution: 0.15, note: "light/current/river-mouth structural belt" }
        ]
      }
    ],
    movements: [
      {
        species: "seabass",
        from: { label: "Tokyo Bay broad inner area", lat: 35.62, lon: 139.82, radiusM: 12000, confidence: 0.45 },
        to: { label: "canal light belt", lat: 35.64, lon: 139.8, radiusM: 3500, confidence: 0.48 },
        directionDeg: 315,
        speedKmh: 1.2,
        confidence: 0.35,
        rationale: ["fixture inference only", "no production SNS/API connection or AI free scoring"]
      }
    ]
  };
}

export function providerError(errorCode, message, details = {}) {
  const error = new Error(message);
  error.name = "ProviderError";
  error.errorCode = errorCode;
  Object.assign(error, details);
  return error;
}

export function classifyProviderError(error) {
  if (error?.errorCode) {
    return {
      errorCode: error.errorCode,
      httpStatus: error.httpStatus,
      message: error.message || String(error.errorCode)
    };
  }
  if (error?.name === "AbortError" || /aborted|timeout/i.test(String(error?.message || ""))) {
    return { errorCode: "timeout", message: "provider request timed out" };
  }
  if (error instanceof SyntaxError) {
    return { errorCode: "malformed_response", message: "provider JSON parse failed" };
  }
  if (/fetch|network/i.test(String(error?.message || ""))) {
    return { errorCode: "network_error", message: error.message };
  }
  return { errorCode: "unknown", message: error?.message || "unknown provider error" };
}

export async function fetchJsonWithTimeout(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const retries = options.retries ?? 1;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response || typeof response.ok !== "boolean") {
        throw providerError("malformed_response", "provider returned a non-Response object");
      }
      if (!response.ok) {
        throw providerError("http_error", `provider returned HTTP ${response.status}`, { httpStatus: response.status });
      }
      try {
        return await response.json();
      } catch (error) {
        throw providerError("malformed_response", "provider returned malformed JSON", { cause: error });
      }
    } catch (error) {
      clearTimeout(timer);
      lastError = classifyProviderError(error);
      const retryable = ["timeout", "network_error", "http_error"].includes(lastError.errorCode);
      if (!retryable || attempt === retries) {
        throw providerError(lastError.errorCode, lastError.message, { httpStatus: lastError.httpStatus });
      }
    }
  }

  throw providerError(lastError?.errorCode || "unknown", lastError?.message || "provider request failed");
}

export function buildOpenMeteoWeatherUrl(node) {
  return buildOpenMeteoWeatherBatchUrl([node]);
}

export function buildOpenMeteoWeatherBatchUrl(nodes) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", nodes.map((node) => String(node.latitude)).join(","));
  url.searchParams.set("longitude", nodes.map((node) => String(node.longitude)).join(","));
  url.searchParams.set("hourly", WEATHER_HOURLY);
  url.searchParams.set("forecast_hours", String(COLLECTED_SNAPSHOTS_PER_NODE_PROVIDER));
  url.searchParams.set("past_hours", "0");
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");
  return url.toString();
}

export function buildOpenMeteoMarineUrl(node) {
  return buildOpenMeteoMarineBatchUrl([node]);
}

export function buildOpenMeteoMarineBatchUrl(nodes) {
  const url = new URL("https://marine-api.open-meteo.com/v1/marine");
  url.searchParams.set("latitude", nodes.map((node) => String(node.latitude)).join(","));
  url.searchParams.set("longitude", nodes.map((node) => String(node.longitude)).join(","));
  url.searchParams.set("hourly", MARINE_HOURLY);
  url.searchParams.set("forecast_hours", String(COLLECTED_SNAPSHOTS_PER_NODE_PROVIDER));
  url.searchParams.set("past_hours", "0");
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("length_unit", "metric");
  url.searchParams.set("cell_selection", "sea");
  return url.toString();
}

export async function fetchOpenMeteoWeather(node, options = {}) {
  return fetchJsonWithTimeout(buildOpenMeteoWeatherUrl(node), options);
}

export async function fetchOpenMeteoMarine(node, options = {}) {
  return fetchJsonWithTimeout(buildOpenMeteoMarineUrl(node), options);
}

export async function fetchOpenMeteoWeatherBatch(nodes, options = {}) {
  return fetchJsonWithTimeout(buildOpenMeteoWeatherBatchUrl(nodes), options);
}

export async function fetchOpenMeteoMarineBatch(nodes, options = {}) {
  return fetchJsonWithTimeout(buildOpenMeteoMarineBatchUrl(nodes), options);
}

export function normalizeOpenMeteoWeather(payload, node, meta = {}) {
  assertHourlyPayload(payload, WEATHER_PROVIDER);
  const hourly = payload.hourly;
  const collectedAt = meta.collectedAt || meta.completedAt || new Date().toISOString();
  const forecastIssuedAt = meta.forecastIssuedAt ?? null;
  const snapshots = hourly.time.slice(0, MAX_SNAPSHOTS_PER_PROVIDER).map((time, index) => {
    const pressure = asNumber(hourly.pressure_msl?.[index]);
    const previousPressure = asNumber(hourly.pressure_msl?.[index - 1]);
    const observedAt = normalizeTime(time);
    const snapshot = compactSnapshot({
      nodeId: node.id,
      observedAt,
      collectedAt,
      forecastIssuedAt,
      latitude: asNumber(payload.latitude) ?? node.latitude,
      longitude: asNumber(payload.longitude) ?? node.longitude,
      windSpeed: asNumber(hourly.wind_speed_10m?.[index]),
      windDirection: asNumber(hourly.wind_direction_10m?.[index]),
      windGust: asNumber(hourly.wind_gusts_10m?.[index]),
      pressure,
      pressureTrend: pressure != null && previousPressure != null ? round(pressure - previousPressure, 3) : undefined,
      precipitation: asNumber(hourly.precipitation?.[index]),
      accumulatedRain: sumPrevious(hourly.precipitation, index, 24),
      airTemperature: asNumber(hourly.temperature_2m?.[index]),
      source: WEATHER_PROVIDER,
      confidence: 0.82,
      freshness: freshness(observedAt, collectedAt),
      provenance: provenance(WEATHER_PROVIDER, meta.source || buildOpenMeteoWeatherUrl(node), meta)
    });
    snapshot.missingFields = missingFields(snapshot, ["windSpeed", "windDirection", "pressure", "precipitation", "airTemperature"]);
    snapshot.confidence = confidenceFromMissing(0.82, snapshot.missingFields.length, 5);
    return snapshot;
  });
  return snapshots;
}

export function normalizeOpenMeteoMarine(payload, node, meta = {}) {
  assertHourlyPayload(payload, MARINE_PROVIDER);
  const hourly = payload.hourly;
  const collectedAt = meta.collectedAt || meta.completedAt || new Date().toISOString();
  const forecastIssuedAt = meta.forecastIssuedAt ?? null;
  const snapshots = hourly.time.slice(0, MAX_SNAPSHOTS_PER_PROVIDER).map((time, index) => {
    const observedAt = normalizeTime(time);
    const snapshot = compactSnapshot({
      nodeId: node.id,
      observedAt,
      collectedAt,
      forecastIssuedAt,
      latitude: asNumber(payload.latitude) ?? node.latitude,
      longitude: asNumber(payload.longitude) ?? node.longitude,
      waveHeight: asNumber(hourly.wave_height?.[index]),
      waveDirection: asNumber(hourly.wave_direction?.[index]),
      wavePeriod: asNumber(hourly.wave_period?.[index]),
      windWaveHeight: asNumber(hourly.wind_wave_height?.[index]),
      windWaveDirection: asNumber(hourly.wind_wave_direction?.[index]),
      windWavePeriod: asNumber(hourly.wind_wave_period?.[index]),
      swellHeight: asNumber(hourly.swell_wave_height?.[index]),
      swellDirection: asNumber(hourly.swell_wave_direction?.[index]),
      swellPeriod: asNumber(hourly.swell_wave_period?.[index]),
      seaSurfaceTemperature: asNumber(hourly.sea_surface_temperature?.[index]),
      oceanCurrentVelocity: asNumber(hourly.ocean_current_velocity?.[index]),
      oceanCurrentDirection: asNumber(hourly.ocean_current_direction?.[index]),
      seaLevelHeightMsl: asNumber(hourly.sea_level_height_msl?.[index]),
      source: MARINE_PROVIDER,
      confidence: 0.78,
      freshness: freshness(observedAt, collectedAt),
      provenance: provenance(MARINE_PROVIDER, meta.source || buildOpenMeteoMarineUrl(node), meta)
    });
    snapshot.missingFields = missingFields(snapshot, [
      "waveHeight",
      "wavePeriod",
      "swellHeight",
      "seaSurfaceTemperature",
      "oceanCurrentVelocity",
      "seaLevelHeightMsl"
    ]);
    snapshot.confidence = confidenceFromMissing(0.78, snapshot.missingFields.length, 6);
    return snapshot;
  });
  return snapshots;
}

export function normalizeOpenMeteoWeatherBatch(payload, nodes, meta = {}) {
  return normalizeOpenMeteoBatch(payload, nodes, WEATHER_PROVIDER, normalizeOpenMeteoWeather, meta);
}

export function normalizeOpenMeteoMarineBatch(payload, nodes, meta = {}) {
  return normalizeOpenMeteoBatch(payload, nodes, MARINE_PROVIDER, normalizeOpenMeteoMarine, meta);
}

function normalizeOpenMeteoBatch(payload, nodes, provider, normalizeOne, meta) {
  const responses = Array.isArray(payload) ? payload : [payload];
  const matches = matchOpenMeteoResponsesToNodes(responses, nodes);

  return matches.map((match) => {
    if (!match.response) {
      return {
        nodeId: match.node.id,
        provider,
        status: "failed",
        errorCode: "malformed_response",
        message: "provider response missing for requested node",
        coordinateDistanceKm: null,
        snapshots: []
      };
    }
    try {
      const coordinateDistance = Number.isFinite(match.distanceKm) ? round(match.distanceKm, 3) : undefined;
      return {
        nodeId: match.node.id,
        provider,
        status: "ok",
        coordinateDistanceKm: match.distanceKm,
        snapshots: normalizeOne(match.response, match.node, meta).map((snapshot) => compactSnapshot({
          ...snapshot,
          coordinateDistanceKm: coordinateDistance
        }))
      };
    } catch (error) {
      const classified = classifyProviderError(error);
      return {
        nodeId: match.node.id,
        provider,
        status: "failed",
        errorCode: classified.errorCode,
        message: classified.message,
        coordinateDistanceKm: match.distanceKm,
        snapshots: []
      };
    }
  });
}

export function matchOpenMeteoResponsesToNodes(responses, nodes) {
  const unused = responses.map((response, index) => ({ response, index }));
  return nodes.map((node, nodeIndex) => {
    const byLocationIdIndex = unused.findIndex(({ response }) => {
      const locationId = Number.parseInt(String(response?.location_id ?? ""), 10);
      return Number.isInteger(locationId) && locationId === nodeIndex;
    });
    if (byLocationIdIndex >= 0) {
      const [hit] = unused.splice(byLocationIdIndex, 1);
      const distanceKm = coordinateDistanceKm(node, hit.response);
      return distanceKm <= 50
        ? { node, response: hit.response, responseIndex: hit.index, distanceKm }
        : { node, response: null, responseIndex: hit.index, distanceKm };
    }

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < unused.length; i++) {
      const distance = coordinateDistanceKm(node, unused[i].response);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestDistance <= 50) {
      const [hit] = unused.splice(bestIndex, 1);
      return { node, response: hit.response, responseIndex: hit.index, distanceKm: bestDistance };
    }

    return { node, response: null, responseIndex: null, distanceKm: Number.isFinite(bestDistance) ? bestDistance : null };
  });
}

function assertHourlyPayload(payload, provider) {
  if (!payload || typeof payload !== "object" || payload.error) {
    throw providerError("malformed_response", `${provider} payload is not usable`);
  }
  if (!payload.hourly || !Array.isArray(payload.hourly.time)) {
    throw providerError("malformed_response", `${provider} payload is missing hourly.time`);
  }
}

function provenance(provider, source, meta) {
  return [
    {
      provider,
      source,
      model: meta.model,
      requestedAt: meta.requestedAt,
      completedAt: meta.completedAt,
      collectedAt: meta.collectedAt || meta.completedAt,
      forecastIssuedAt: meta.forecastIssuedAt ?? null,
      status: meta.status || "ok",
      httpStatus: meta.httpStatus,
      errorCode: meta.errorCode,
      modelVersion: ENVIRONMENTAL_MODEL_VERSION,
      rawHash: meta.rawHash,
      normalizedSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION,
      attribution: "Open-Meteo"
    }
  ];
}

const ENVIRONMENT_PROVIDERS = [
  {
    id: WEATHER_PROVIDER,
    shortName: "weather",
    fetchBatch: fetchOpenMeteoWeatherBatch,
    normalizeBatch: normalizeOpenMeteoWeatherBatch,
    batchUrl: buildOpenMeteoWeatherBatchUrl
  },
  {
    id: MARINE_PROVIDER,
    shortName: "marine",
    fetchBatch: fetchOpenMeteoMarineBatch,
    normalizeBatch: normalizeOpenMeteoMarineBatch,
    batchUrl: buildOpenMeteoMarineBatchUrl
  }
];

export async function safeCollectEnvironment(env, options = {}) {
  try {
    return { ok: true, ...(await collectEnvironment(env, options)) };
  } catch (error) {
    console.error("environment_collection_failed", {
      errorCode: error?.errorCode || "unknown",
      message: error?.message || "Environmental collection failed."
    });
    return {
      ok: false,
      error: "environment_collection_failed",
      message: "Environmental collection failed.",
      summary: {
        weather: options.provider === "marine" ? "not_requested" : "unknown",
        marine: options.provider === "weather" ? "not_requested" : "unknown"
      }
    };
  }
}

export async function collectEnvironment(env, options = {}) {
  const startedAt = Date.now();
  const requestedAt = options.requestedAt || new Date().toISOString();
  const db = hasD1(env) ? env.WANOKU_INTEL_D1 : null;
  const fetchOptions = { fetchImpl: options.fetchImpl || fetch, timeoutMs: options.timeoutMs ?? 8_000, retries: options.retries ?? 1 };
  const nodes = selectEnvironmentNodes(options.nodeId);
  const providers = selectEnvironmentProviders(options.provider);
  const results = [];
  const sourceRuns = [];
  const snapshotRows = [];
  const metrics = {
    nodeCount: nodes.length,
    providerCount: providers.length,
    externalFetchCount: 0,
    d1StatementCount: 0,
    snapshotCount: 0,
    insertedCount: 0,
    duplicateCount: 0,
    failureCount: 0,
    durationMs: 0
  };

  if (!nodes.length || !providers.length) {
    metrics.durationMs = Date.now() - startedAt;
    return {
      requestedAt,
      completedAt: new Date().toISOString(),
      dbConfigured: Boolean(db),
      ...metrics,
      estimatedSubrequestCount: 0,
      results
    };
  }

  for (const provider of providers) {
    const providerSource = provider.batchUrl(nodes);
    try {
      metrics.externalFetchCount += 1;
      const payload = await provider.fetchBatch(nodes, fetchOptions);
      const completedAt = options.collectedAt || new Date().toISOString();
      const rawHash = await sha256Hex(JSON.stringify(payload));
      const normalized = provider.normalizeBatch(payload, nodes, {
        requestedAt,
        completedAt,
        collectedAt: completedAt,
        forecastIssuedAt: null,
        rawHash,
        status: "ok",
        source: providerSource
      });

      for (const nodeResult of normalized) {
        const sourceRun = makeSourceRun({
          provider: provider.id,
          nodeId: nodeResult.nodeId,
          requestedAt,
          completedAt,
          status: nodeResult.status === "ok" ? "ok" : "failed",
          errorCode: nodeResult.status === "ok" ? null : nodeResult.errorCode,
          rawHash
        });
        sourceRuns.push(sourceRun);

        if (nodeResult.status !== "ok") {
          metrics.failureCount += 1;
          results.push({
            nodeId: nodeResult.nodeId,
            provider: provider.id,
            status: "failed",
            errorCode: nodeResult.errorCode,
            message: nodeResult.message
          });
          continue;
        }

        const snapshots = selectCollectionSnapshots(nodeResult.snapshots);
        metrics.snapshotCount += snapshots.length;
        for (const snapshot of snapshots) {
          snapshotRows.push({ sourceRunId: sourceRun.id, provider: provider.id, rawHash, snapshot });
        }
        results.push({
          nodeId: nodeResult.nodeId,
          provider: provider.id,
          status: "ok",
          snapshotCount: snapshots.length,
          coordinateDistanceKm: nodeResult.coordinateDistanceKm
        });
      }
    } catch (error) {
      const classified = classifyProviderError(error);
      metrics.failureCount += nodes.length;
      for (const node of nodes) {
        sourceRuns.push(makeSourceRun({
          provider: provider.id,
          nodeId: node.id,
          requestedAt,
          completedAt: new Date().toISOString(),
          status: "failed",
          httpStatus: classified.httpStatus ?? null,
          errorCode: classified.errorCode,
          rawHash: null
        }));
        results.push({
          nodeId: node.id,
          provider: provider.id,
          status: "failed",
          errorCode: classified.errorCode,
          message: classified.message
        });
      }
    }
  }

  if (db) {
    const writeStats = await writeEnvironmentBatch(db, sourceRuns, snapshotRows);
    metrics.d1StatementCount += writeStats.statementCount;
    metrics.insertedCount += writeStats.insertedCount;
    metrics.duplicateCount += writeStats.duplicateCount;
  }

  metrics.durationMs = Date.now() - startedAt;

  return {
    requestedAt,
    completedAt: new Date().toISOString(),
    dbConfigured: Boolean(db),
    ...metrics,
    estimatedSubrequestCount: metrics.externalFetchCount + metrics.d1StatementCount,
    results
  };
}

function makeSourceRun({ provider, nodeId, requestedAt, completedAt, status, httpStatus = null, errorCode = null, rawHash = null }) {
  return {
    id: `${provider}:${nodeId}:${requestedAt}`,
    provider,
    nodeId,
    requestedAt,
    completedAt,
    status,
    httpStatus,
    errorCode,
    modelVersion: ENVIRONMENTAL_MODEL_VERSION,
    rawHash,
    normalizedSchemaVersion: ENVIRONMENTAL_SCHEMA_VERSION
  };
}

function selectEnvironmentNodes(nodeId) {
  if (!nodeId) return TOKYO_BAY_ENVIRONMENT_NODES;
  return TOKYO_BAY_ENVIRONMENT_NODES.filter((node) => node.id === nodeId);
}

function selectEnvironmentProviders(provider) {
  if (!provider) return ENVIRONMENT_PROVIDERS;
  const normalized = String(provider).trim().toLowerCase();
  return ENVIRONMENT_PROVIDERS.filter((item) => item.shortName === normalized || item.id === normalized);
}

function selectCollectionSnapshots(snapshots) {
  return snapshots
    .slice()
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    .slice(0, COLLECTED_SNAPSHOTS_PER_NODE_PROVIDER);
}

export function chunkRowsForBoundLimit(rows, columnsPerRow, maxParams = D1_MAX_BOUND_PARAMS_PER_STATEMENT) {
  const rowsPerChunk = Math.max(1, Math.floor(maxParams / columnsPerRow));
  const chunks = [];
  for (let index = 0; index < rows.length; index += rowsPerChunk) {
    chunks.push(rows.slice(index, index + rowsPerChunk));
  }
  return chunks;
}

async function writeEnvironmentBatch(db, sourceRuns, snapshotRows) {
  let statementCount = 0;
  let insertedCount = 0;
  let duplicateCount = 0;

  for (const chunk of chunkRowsForBoundLimit(sourceRuns, SOURCE_RUN_COLUMNS.length)) {
    const sql = multiRowInsertSql("source_runs", SOURCE_RUN_COLUMNS, chunk.length, "OR REPLACE");
    const params = chunk.flatMap((run) => [
      run.id,
      run.provider,
      run.nodeId,
      run.requestedAt,
      run.completedAt,
      run.status,
      run.httpStatus,
      run.errorCode,
      run.modelVersion,
      run.rawHash,
      run.normalizedSchemaVersion
    ]);
    await db.prepare(sql).bind(...params).run();
    statementCount += 1;
  }

  for (const chunk of chunkRowsForBoundLimit(snapshotRows, ENVIRONMENTAL_SNAPSHOT_COLUMNS.length)) {
    const sql = multiRowInsertSql("environmental_snapshots", ENVIRONMENTAL_SNAPSHOT_COLUMNS, chunk.length, "OR IGNORE");
    const params = chunk.flatMap(({ sourceRunId, provider, rawHash, snapshot }) => [
      environmentalSnapshotKey(snapshot),
      sourceRunId,
      provider,
      snapshot.nodeId,
      snapshot.observedAt,
      snapshot.collectedAt,
      snapshot.forecastIssuedAt,
      snapshot.latitude,
      snapshot.longitude,
      snapshot.source,
      snapshot.model ?? null,
      snapshot.confidence,
      snapshot.freshness,
      JSON.stringify(snapshot.missingFields || []),
      ENVIRONMENTAL_SCHEMA_VERSION,
      rawHash,
      JSON.stringify(snapshot),
      new Date().toISOString()
    ]);
    const result = await db.prepare(sql).bind(...params).run();
    const changes = Number(result?.meta?.changes || 0);
    insertedCount += changes;
    duplicateCount += Math.max(0, chunk.length - changes);
    statementCount += 1;
  }

  return { statementCount, insertedCount, duplicateCount };
}

function multiRowInsertSql(table, columns, rowCount, insertModifier) {
  const row = `(${columns.map(() => "?").join(", ")})`;
  return `
    INSERT ${insertModifier} INTO ${table}
      (${columns.join(", ")})
    VALUES ${Array.from({ length: rowCount }, () => row).join(", ")}
  `;
}

async function readCurrentEnvironment(env, url) {
  const nodeId = url.searchParams.get("nodeId");
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, TOKYO_BAY_ENVIRONMENT_NODES.length * 2);
  if (!hasD1(env)) {
    return { snapshots: fixtureEnvironmentSnapshots(nodeId).slice(0, limit), source: "fixture", dbConfigured: false };
  }

  const filters = [];
  const binds = [];
  if (nodeId) {
    filters.push("node_id = ?");
    binds.push(nodeId);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const queryLimit = Math.max(limit * 5, TOKYO_BAY_ENVIRONMENT_NODES.length * ENVIRONMENT_PROVIDERS.length * 5);
  const rows = await env.WANOKU_INTEL_D1.prepare(`
    SELECT snapshot_key, normalized_json, collected_at, forecast_issued_at, created_at
    FROM environmental_snapshots
    ${where}
    ORDER BY COALESCE(collected_at, forecast_issued_at, created_at) DESC, observed_at DESC, created_at DESC
    LIMIT ?
  `).bind(...binds, queryLimit).all();
  return { snapshots: pickLatestVintagePerNodeProvider(rowsToSnapshots(rows)).slice(0, limit), source: "d1", dbConfigured: true };
}

async function readEnvironmentHistory(env, url) {
  const nodeId = url.searchParams.get("nodeId");
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const collectedStart = url.searchParams.get("collectedStart") || url.searchParams.get("collected_start");
  const collectedEnd = url.searchParams.get("collectedEnd") || url.searchParams.get("collected_end");
  const orderBy = url.searchParams.get("orderBy") === "collectedAt" ? "collectedAt" : "observedAt";
  if (!hasD1(env)) {
    return { snapshots: fixtureEnvironmentSnapshots(nodeId).slice(0, limit), source: "fixture", dbConfigured: false };
  }

  const filters = [];
  const binds = [];
  if (nodeId) {
    filters.push("node_id = ?");
    binds.push(nodeId);
  }
  if (start) {
    filters.push("observed_at >= ?");
    binds.push(start);
  }
  if (end) {
    filters.push("observed_at <= ?");
    binds.push(end);
  }
  if (collectedStart) {
    filters.push("COALESCE(collected_at, forecast_issued_at, created_at) >= ?");
    binds.push(collectedStart);
  }
  if (collectedEnd) {
    filters.push("COALESCE(collected_at, forecast_issued_at, created_at) <= ?");
    binds.push(collectedEnd);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const orderSql = orderBy === "collectedAt"
    ? "COALESCE(collected_at, forecast_issued_at, created_at) DESC, observed_at DESC, created_at DESC"
    : "observed_at DESC, COALESCE(collected_at, forecast_issued_at, created_at) DESC, created_at DESC";
  const rows = await env.WANOKU_INTEL_D1.prepare(`
    SELECT snapshot_key, normalized_json, collected_at, forecast_issued_at, created_at
    FROM environmental_snapshots
    ${where}
    ORDER BY ${orderSql}
    LIMIT ?
  `).bind(...binds, limit).all();
  return { snapshots: rowsToSnapshots(rows), source: "d1", dbConfigured: true };
}

async function readEnvironmentQuality(env, url) {
  const current = await readCurrentEnvironment(env, url);
  return {
    ...current,
    quality: current.snapshots.map((snapshot) => qualityReport(snapshot))
  };
}

export function rowsToSnapshots(rows) {
  return (rows?.results || [])
    .map((row) => hydrateEnvironmentalSnapshotRow(row))
    .filter(Boolean);
}

export function hydrateEnvironmentalSnapshotRow(row) {
  const snapshot = safeJson(row.normalized_json);
  if (!snapshot) return null;
  const hasForecastIssuedAt = Object.prototype.hasOwnProperty.call(row, "forecast_issued_at");
  return sanitizeOpenMeteoModel({
    ...snapshot,
    snapshotKey: row.snapshot_key || snapshot.snapshotKey,
    collectedAt: snapshot.collectedAt || row.collected_at || row.forecast_issued_at || row.created_at,
    forecastIssuedAt: hasForecastIssuedAt ? row.forecast_issued_at : (snapshot.forecastIssuedAt ?? null)
  });
}

export function pickLatestVintagePerNodeProvider(snapshots) {
  const byKey = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.nodeId || "unknown-node"}|${snapshot.source || snapshot.provider || "unknown-provider"}`;
    const previous = byKey.get(key);
    if (!previous || vintageTimeMs(snapshot) > vintageTimeMs(previous)) {
      byKey.set(key, snapshot);
    }
  }
  return [...byKey.values()].sort((a, b) => vintageTimeMs(b) - vintageTimeMs(a));
}

function vintageTimeMs(snapshot) {
  return Date.parse(snapshot.collectedAt || snapshot.forecastIssuedAt || snapshot.observedAt || "");
}

function fixtureEnvironmentSnapshots(nodeId) {
  const nodes = nodeId
    ? TOKYO_BAY_ENVIRONMENT_NODES.filter((node) => node.id === nodeId)
    : TOKYO_BAY_ENVIRONMENT_NODES.slice(0, 3);
  return nodes.flatMap((node, index) => [
    compactSnapshot({
      nodeId: node.id,
      observedAt: "2026-07-12T00:00:00+09:00",
      collectedAt: "2026-07-11T18:00:00+09:00",
      forecastIssuedAt: null,
      latitude: node.latitude,
      longitude: node.longitude,
      windSpeed: 4 + index,
      windDirection: normalizeDegrees(180 + index * 20),
      windGust: 7 + index,
      pressure: 1007 - index,
      pressureTrend: -0.4,
      precipitation: index === 0 ? 0.6 : 0.1,
      accumulatedRain: 4 + index,
      airTemperature: 28 - index * 0.3,
      source: WEATHER_PROVIDER,
      model: "fixture",
      confidence: 0.78,
      freshness: 0.8,
      missingFields: [],
      provenance: provenance(WEATHER_PROVIDER, "fixture", { completedAt: "2026-07-11T18:00:00+09:00", collectedAt: "2026-07-11T18:00:00+09:00", forecastIssuedAt: null, status: "ok" })
    }),
    compactSnapshot({
      nodeId: node.id,
      observedAt: "2026-07-12T00:00:00+09:00",
      collectedAt: "2026-07-11T18:00:00+09:00",
      forecastIssuedAt: null,
      latitude: node.latitude,
      longitude: node.longitude,
      waveHeight: 0.4 + index * 0.1,
      waveDirection: 170,
      wavePeriod: 4.5,
      swellHeight: 0.2,
      swellDirection: 160,
      swellPeriod: 6.0,
      seaSurfaceTemperature: 26.5 - index * 0.2,
      oceanCurrentVelocity: 0.3,
      oceanCurrentDirection: 90,
      seaLevelHeightMsl: 0.12,
      source: MARINE_PROVIDER,
      model: "fixture",
      confidence: 0.72,
      freshness: 0.8,
      missingFields: [],
      provenance: provenance(MARINE_PROVIDER, "fixture", { completedAt: "2026-07-11T18:00:00+09:00", collectedAt: "2026-07-11T18:00:00+09:00", forecastIssuedAt: null, status: "ok" })
    })
  ]);
}

function qualityReport(snapshot) {
  const missing = Array.from(new Set([...(snapshot.missingFields || []), ...missingFields(snapshot, [
    "observedAt",
    "latitude",
    "longitude",
    "source",
    "confidence",
    "freshness"
  ])]));
  const freshnessValue = Math.min(asNumber(snapshot.freshness) ?? 0, freshness(snapshot.observedAt, new Date().toISOString()));
  const missingRate = missing.length / 14;
  return {
    snapshotKey: snapshot.snapshotKey || environmentalSnapshotKey(snapshot),
    nodeId: snapshot.nodeId,
    observedAt: snapshot.observedAt,
    collectedAt: snapshot.collectedAt,
    forecastIssuedAt: snapshot.forecastIssuedAt ?? null,
    coordinateDistanceKm: asNumber(snapshot.coordinateDistanceKm) ?? null,
    source: snapshot.source,
    freshness: freshnessValue,
    missingRate,
    confidence: round((asNumber(snapshot.confidence) ?? 0) * (1 - missingRate) * (0.5 + freshnessValue / 2), 4),
    missingFields: missing,
    stale: freshnessValue < 0.35,
    warnings: [
      ...(freshnessValue < 0.35 ? ["stale_environmental_data"] : []),
      ...(missingRate > 0.25 ? ["many_missing_fields"] : []),
      ...(hasWindGustBelowSustainedWind(snapshot) ? ["wind_gust_below_sustained_wind"] : [])
    ]
  };
}

function sanitizeOpenMeteoModel(snapshot) {
  if (!isOpenMeteoSource(snapshot.source) || !isOpenMeteoNonModelValue(snapshot.model)) {
    return snapshot;
  }
  const { model, ...rest } = snapshot;
  return rest;
}

function isOpenMeteoSource(source) {
  return source === WEATHER_PROVIDER || source === MARINE_PROVIDER;
}

function isOpenMeteoNonModelValue(model) {
  if (typeof model !== "string") return false;
  const value = model.trim().toLowerCase();
  return [
    "gmt+9",
    "gmt+09:00",
    "utc+9",
    "utc+09:00",
    "jst",
    "open-meteo-best-match",
    "open-meteo-marine-best-match"
  ].includes(value);
}

function hasWindGustBelowSustainedWind(snapshot) {
  const windSpeed = asNumber(snapshot.windSpeed);
  const windGust = asNumber(snapshot.windGust);
  return windSpeed != null && windGust != null && windGust < windSpeed;
}

function environmentalSnapshotKey(snapshot) {
  const vintage = snapshot.forecastIssuedAt
    ? `issued:${snapshot.forecastIssuedAt}`
    : `collected:${snapshot.collectedAt || "unknown"}`;
  return [
    snapshot.nodeId || "unknown-node",
    snapshot.source || "unknown-source",
    snapshot.observedAt,
    vintage,
    ENVIRONMENTAL_SCHEMA_VERSION
  ].join("|");
}

function missingFields(snapshot, fields) {
  return fields.filter((field) => {
    const value = snapshot[field];
    return value == null || value === "" || (typeof value === "number" && !Number.isFinite(value));
  });
}

function compactSnapshot(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined)
  );
}

function confidenceFromMissing(base, missingCount, expectedCount) {
  return round(Math.max(0.2, base * (1 - missingCount / Math.max(1, expectedCount))), 4);
}

function normalizeTime(value) {
  if (typeof value !== "string") return new Date().toISOString();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return value.length === 16 ? `${value}:00+09:00` : `${value}+09:00`;
}

function freshness(observedAt, asOf) {
  const observedMs = Date.parse(observedAt);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(observedMs) || !Number.isFinite(asOfMs)) return 0;
  const ageHours = Math.max(0, (asOfMs - observedMs) / 3600_000);
  return round(Math.exp(-ageHours / 18), 4);
}

function sumPrevious(values, index, hours) {
  if (!Array.isArray(values)) return undefined;
  let total = 0;
  let count = 0;
  for (let i = Math.max(0, index - hours + 1); i <= index; i++) {
    const value = asNumber(values[i]);
    if (value != null) {
      total += value;
      count += 1;
    }
  }
  return count ? round(total, 3) : undefined;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function coordinateDistanceKm(node, response) {
  const lat = asNumber(response?.latitude);
  const lon = asNumber(response?.longitude);
  if (lat == null || lon == null) return Number.POSITIVE_INFINITY;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthKm = 6371;
  const dLat = toRad(lat - node.latitude);
  const dLon = toRad(lon - node.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(node.latitude)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value || "", 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasD1(env) {
  return Boolean(env?.WANOKU_INTEL_D1 && typeof env.WANOKU_INTEL_D1.prepare === "function");
}

function isAdminAuthorized(request, env) {
  if (!env.WANOKU_ADMIN_SECRET) {
    return { ok: false, status: 503, error: "admin_secret_not_configured" };
  }
  const bearer = request.headers.get("Authorization") || "";
  const headerSecret = request.headers.get("X-Wanoku-Admin-Secret") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : headerSecret;
  if (token !== env.WANOKU_ADMIN_SECRET) {
    return { ok: false, status: 403, error: "admin_forbidden" };
  }
  return { ok: true };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function handleCollectJmaTidePrediction(request, env) {
  const auth = isAdminAuthorized(request, env);
  if (!auth.ok) return json(request, env, { error: auth.error }, { status: auth.status });
  if (!env?.WANOKU_INTEL_D1 || typeof env.WANOKU_INTEL_D1.prepare !== "function" || typeof env.WANOKU_INTEL_D1.batch !== "function") {
    return json(request, env, { ok: false, error: "d1_not_configured" }, { status: 503 });
  }

  const bodyResult = await readAdminJsonBody(request, ADMIN_JMA_TIDE_BODY_MAX_BYTES);
  if (!bodyResult.ok) {
    return json(request, env, { ok: false, error: bodyResult.error, message: bodyResult.message }, { status: 400 });
  }
  const validation = validateJmaTidePredictionAdminBody(bodyResult.body);
  if (!validation.ok) {
    return json(request, env, {
      ok: false,
      error: "invalid_request",
      errors: validation.errors
    }, { status: 400 });
  }

  const catalog = getJmaTidePredictionSourceDefinition({
    stationId: validation.body.stationId,
    sourceYear: validation.body.sourceYear
  });
  if (!catalog.ok) {
    return json(request, env, {
      ok: false,
      error: "unsupported_jma_tide_prediction_source",
      errors: catalog.errors
    }, { status: 400 });
  }

  try {
    const result = await ingestJmaTidePredictionSource({
      db: env.WANOKU_INTEL_D1,
      sourceUrl: catalog.source.sourceUrl,
      sourceYear: catalog.source.sourceYear,
      forecastIssuedAt: validation.body.forecastIssuedAt,
      sourceName: catalog.source.sourceName,
      attribution: catalog.source.attribution
    });
    return json(request, env, sanitizeJmaTidePredictionIngestionResponse(result, catalog.source), {
      status: httpStatusForJmaTidePredictionIngestion(result)
    });
  } catch (error) {
    console.error("jma_tide_prediction_ingestion_failed", {
      message: error?.message || "JMA tide prediction ingestion failed."
    });
    return json(request, env, {
      ok: false,
      error: "jma_tide_prediction_ingestion_failed",
      message: "JMA tide prediction ingestion failed."
    }, { status: 500 });
  }
}

async function readAdminJsonBody(request, maxBytes) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, error: "unsupported_content_type", message: "Content-Type must be application/json." };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, error: "body_read_failed", message: "Request body could not be read." };
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, error: "body_too_large", message: "Request body is too large." };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "malformed_json", message: "Request body must be valid JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_json_body", message: "Request body must be a JSON object." };
  }
  return { ok: true, body };
}

function validateJmaTidePredictionAdminBody(body) {
  const allowed = new Set(["stationId", "sourceYear", "forecastIssuedAt"]);
  const errors = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) errors.push(`unsupported field: ${key}`);
  }
  if (typeof body.stationId !== "string" || body.stationId.trim() === "") errors.push("stationId is required.");
  if (!Number.isInteger(body.sourceYear)) errors.push("sourceYear is required and must be an integer.");
  if (!isCanonicalUtcIsoDateTime(body.forecastIssuedAt)) errors.push("forecastIssuedAt is required and must be canonical UTC ISO datetime.");
  return {
    ok: errors.length === 0,
    body: {
      stationId: body.stationId,
      sourceYear: body.sourceYear,
      forecastIssuedAt: body.forecastIssuedAt
    },
    errors
  };
}

function httpStatusForJmaTidePredictionIngestion(result) {
  if (result?.status === "partial" && result?.persistence?.insertedCount > 0) return 207;
  if (result?.status === "ok" && result?.persistence?.ok === true && result?.ok === true) return 200;
  const errorCodes = new Set((result?.errors || []).map((item) => item?.code).filter(Boolean));
  if (errorCodes.has("invalid_input")) return 400;
  if (errorCodes.has("fetch_error") || errorCodes.has("http_error") || errorCodes.has("body_read_error") || errorCodes.has("empty_body") || errorCodes.has("decode_error") || errorCodes.has("parse_failed") || errorCodes.has("no_observations")) {
    return 502;
  }
  if (errorCodes.has("persistence_error") || result?.persistence?.ok === false) return 500;
  return 500;
}

function sanitizeJmaTidePredictionIngestionResponse(result, source) {
  return {
    ok: Boolean(result?.ok),
    status: result?.status || "failed",
    stationId: source.stationId,
    sourceYear: source.sourceYear,
    sourceRunId: result?.sourceRunId ?? null,
    sourceUrl: source.sourceUrl,
    requestedAt: result?.requestedAt ?? null,
    completedAt: result?.completedAt ?? null,
    forecastIssuedAt: result?.forecastIssuedAt ?? null,
    httpStatus: result?.httpStatus ?? null,
    rawHash: result?.rawHash ?? null,
    sourceByteLength: result?.sourceByteLength ?? null,
    parsedObservationCount: result?.parsedObservationCount ?? 0,
    parserErrorCount: result?.parserErrorCount ?? 0,
    parserWarningCount: result?.parserWarningCount ?? 0,
    persistence: sanitizePersistenceResult(result?.persistence),
    errors: sanitizeDiagnostics(result?.errors),
    warnings: sanitizeDiagnostics(result?.warnings)
  };
}

function sanitizePersistenceResult(persistence) {
  if (!persistence || typeof persistence !== "object") return null;
  return {
    ok: Boolean(persistence.ok),
    partial: Boolean(persistence.partial),
    sourceRunId: persistence.sourceRunId ?? null,
    inputObservationCount: numberOrZero(persistence.inputObservationCount),
    validObservationCount: numberOrZero(persistence.validObservationCount),
    insertedCount: numberOrZero(persistence.insertedCount),
    duplicateCount: numberOrZero(persistence.duplicateCount),
    conflictCount: numberOrZero(persistence.conflictCount),
    invalidCount: numberOrZero(persistence.invalidCount),
    statementCount: numberOrZero(persistence.statementCount),
    lookupStatementCount: numberOrZero(persistence.lookupStatementCount),
    writeStatementCount: numberOrZero(persistence.writeStatementCount),
    observationPayloadChunkCount: numberOrZero(persistence.observationPayloadChunkCount),
    observationPayloadByteCount: numberOrZero(persistence.observationPayloadByteCount),
    maximumPayloadChunkBytes: numberOrZero(persistence.maximumPayloadChunkBytes),
    queryBudgetExceeded: Boolean(persistence.queryBudgetExceeded),
    errors: stringArray(persistence.errors),
    warnings: stringArray(persistence.warnings)
  };
}

function sanitizeDiagnostics(items) {
  return Array.isArray(items)
    ? items.map((item) => ({
      code: typeof item?.code === "string" ? item.code : "diagnostic",
      message: typeof item?.message === "string" ? item.message : "diagnostic redacted."
    }))
    : [];
}

function stringArray(items) {
  return Array.isArray(items)
    ? items.filter((item) => typeof item === "string").map(sanitizeDiagnosticString)
    : [];
}

function sanitizeDiagnosticString(value) {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (/secret|token|authorization|stack|injected/i.test(normalized)) return "diagnostic redacted.";
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isCanonicalUtcIsoDateTime(value) {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

async function handleRequest(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: isCorsAllowed(request, env) ? 204 : 403,
      headers: corsHeaders(request, env)
    });
  }

  if (!isCorsAllowed(request, env)) {
    return json(request, env, { error: "cors_forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/admin/collect-environment") {
    const auth = isAdminAuthorized(request, env);
    if (!auth.ok) return json(request, env, { error: auth.error }, { status: auth.status });
    const result = await safeCollectEnvironment(env, {
      provider: url.searchParams.get("provider") || undefined,
      nodeId: url.searchParams.get("node_id") || url.searchParams.get("nodeId") || undefined
    });
    return json(request, env, result, { status: result.ok ? 200 : 500 });
  }

  if (request.method === "POST" && url.pathname === "/admin/collect-jma-tide-prediction") {
    return handleCollectJmaTidePrediction(request, env);
  }

  if (request.method !== "GET") {
    return json(request, env, { error: "method_not_allowed" }, { status: 405 });
  }

  if (url.pathname === "/health") {
    return json(request, env, {
      ok: true,
      service: SERVICE_NAME,
      env: publicEnv(env),
      endpoints: [
        "/health",
        "/sources",
        "/intel",
        "/evidence",
        "/predictions",
        "/environment/nodes",
        "/environment/current",
        "/environment/history",
        "/environment/quality",
        "POST /admin/collect-environment",
        "POST /admin/collect-jma-tide-prediction"
      ]
    });
  }
  if (url.pathname === "/sources") {
    return json(request, env, { sources: SOURCES });
  }
  if (url.pathname === "/evidence") {
    return json(request, env, {
      evidence: filterEvidence(url),
      duplicateCandidates: duplicateCandidates(),
      note: "fixture/mock only; no production SNS API connection."
    });
  }
  if (url.pathname === "/predictions") {
    return json(request, env, { prediction: mockPredictions() });
  }
  if (url.pathname === "/intel") {
    return json(request, env, {
      sources: SOURCES,
      evidence: filterEvidence(url),
      duplicateCandidates: duplicateCandidates(),
      prediction: mockPredictions(),
      policy: "manual selected use only; no secret is returned to client."
    });
  }
  if (url.pathname === "/environment/nodes") {
    return json(request, env, {
      nodes: TOKYO_BAY_ENVIRONMENT_NODES,
      note: "Environmental estimation nodes only; not fishing spot rankings."
    });
  }
  if (url.pathname === "/environment/current") {
    return json(request, env, await readCurrentEnvironment(env, url));
  }
  if (url.pathname === "/environment/history") {
    return json(request, env, await readEnvironmentHistory(env, url));
  }
  if (url.pathname === "/environment/quality") {
    return json(request, env, await readEnvironmentQuality(env, url));
  }

  return json(request, env, { error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env || {});
    } catch (error) {
      console.error("worker_request_failed", {
        message: error?.message || "Request failed."
      });
      return json(request, env || {}, {
        ok: false,
        error: "worker_request_failed",
        message: "Request failed."
      }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      safeCollectEnvironment(env || {}, {
        requestedAt: new Date(event.scheduledTime || Date.now()).toISOString()
      }).then((result) => {
        if (!result.ok) {
          console.error("environment_scheduled_collection_failed", {
            error: result.error,
            message: result.message
          });
        }
      })
    );
  }
};
