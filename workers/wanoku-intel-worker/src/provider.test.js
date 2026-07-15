import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import worker, {
  buildOpenMeteoMarineBatchUrl,
  buildOpenMeteoWeatherBatchUrl,
  chunkRowsForBoundLimit,
  collectEnvironment,
  fetchJsonWithTimeout,
  matchOpenMeteoResponsesToNodes,
  normalizeOpenMeteoMarine,
  normalizeOpenMeteoMarineBatch,
  normalizeOpenMeteoWeather,
  normalizeOpenMeteoWeatherBatch
} from "./index.js";
import {
  TOKYO_BAY_ENVIRONMENT_NODES
} from "./environment-nodes.js";
import {
  JMA_TIDE_PREDICTION_LINE_LENGTH
} from "../../../packages/wanoku-core/src/jma-tide-prediction.ts";

const node = TOKYO_BAY_ENVIRONMENT_NODES[0];

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/wanoku-intelligence/${name}`, import.meta.url), "utf8"));
}

function runMigrationSqliteFixture() {
  const script = String.raw`
import json
import sqlite3
from pathlib import Path

root = Path.cwd()
sql1 = (root / "workers/wanoku-intel-worker/migrations/0001_environmental_spine.sql").read_text(encoding="utf-8")
sql2 = (root / "workers/wanoku-intel-worker/migrations/0002_source_runs_node_id.sql").read_text(encoding="utf-8")
conn = sqlite3.connect(":memory:")
conn.executescript(sql1)

conn.executemany(
    """INSERT INTO source_runs (id, provider, requested_at, completed_at, status, http_status, error_code, model_version, raw_hash, normalized_schema_version)
       VALUES (?,?,?,?,?,?,?,?,?,?)""",
    [
        ("run-weather-a", "open-meteo-weather", "2026-07-12T00:00:00Z", "2026-07-12T00:00:02Z", "ok", 200, None, "v1", "hash-weather", "wanoku-environmental-snapshot.v1"),
        ("run-marine-a", "open-meteo-marine", "2026-07-12T00:00:00Z", "2026-07-12T00:00:04Z", "ok", 200, None, "v1", "hash-marine", "wanoku-environmental-snapshot.v1"),
        ("run-official-a", "official-forecast", "2026-07-12T00:00:00Z", "2026-07-12T00:00:10Z", "ok", 200, None, "v1", "hash-official", "wanoku-environmental-snapshot.v1"),
    ],
)

rows = [
    ("snap-weather-old", "run-weather-a", "open-meteo-weather", "node-a", "2026-07-12T09:00:00Z", "2026-07-12T00:00:02Z", 35.0, 139.0, "open-meteo-weather", "model", 0.8, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-weather", "{}", "2026-07-12T00:00:03Z"),
    ("snap-weather-new", "run-weather-a", "open-meteo-weather", "node-a", "2026-07-12T09:00:00Z", "2026-07-12T03:00:02Z", 35.0, 139.0, "open-meteo-weather", "model", 0.8, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-weather", "{}", "2026-07-12T03:00:03Z"),
    ("snap-marine", "run-marine-a", "open-meteo-marine", "node-b", "2026-07-12T09:00:00Z", "2026-07-12T00:00:04Z", 35.1, 139.1, "open-meteo-marine", "model", 0.8, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-marine", "{}", "2026-07-12T00:00:05Z"),
    ("snap-official", "run-official-a", "official-forecast", "node-c", "2026-07-12T09:00:00Z", "2026-07-11T18:00:00Z", 35.2, 139.2, "official-forecast", "model", 0.9, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-official", "{}", "2026-07-12T00:00:11Z"),
    ("snap-missing-source", "missing-run", "open-meteo-weather", "node-d", "2026-07-12T10:00:00Z", "2026-07-12T00:05:00Z", 35.3, 139.3, "open-meteo-weather", "model", 0.7, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-missing", "{}", "2026-07-12T00:06:00Z"),
    ("snap-created-fallback", "missing-run-2", "manual-provider", "node-e", "2026-07-12T11:00:00Z", None, 35.4, 139.4, "manual-provider", "model", 0.7, 1.0, "[]", "wanoku-environmental-snapshot.v1", "hash-manual", "{}", "2026-07-12T00:07:00Z"),
]
conn.executemany(
    """INSERT INTO environmental_snapshots (snapshot_key, source_run_id, provider, node_id, observed_at, forecast_issued_at, latitude, longitude, source, model, confidence, freshness, missing_fields_json, normalized_schema_version, raw_hash, normalized_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
    rows,
)

before = conn.execute("SELECT COUNT(*) FROM environmental_snapshots").fetchone()[0]
conn.executescript(sql2)
after = conn.execute("SELECT COUNT(*) FROM environmental_snapshots").fetchone()[0]
print(json.dumps({
    "beforeRows": before,
    "afterRows": after,
    "deletedRows": before - after,
    "collectedNullRows": conn.execute("SELECT COUNT(*) FROM environmental_snapshots WHERE collected_at IS NULL").fetchone()[0],
    "openMeteoForecastNotNullRows": conn.execute("SELECT COUNT(*) FROM environmental_snapshots WHERE (provider IN ('open-meteo-weather','open-meteo-marine') OR source IN ('open-meteo-weather','open-meteo-marine')) AND forecast_issued_at IS NOT NULL").fetchone()[0],
    "officialForecastIssuedAt": conn.execute("SELECT forecast_issued_at FROM environmental_snapshots WHERE snapshot_key='snap-official'").fetchone()[0],
    "createdFallbackCollectedAt": conn.execute("SELECT collected_at FROM environmental_snapshots WHERE snapshot_key='snap-created-fallback'").fetchone()[0],
    "weatherVintageCount": conn.execute("SELECT COUNT(*) FROM environmental_snapshots WHERE node_id='node-a' AND provider='open-meteo-weather' AND observed_at='2026-07-12T09:00:00Z'").fetchone()[0],
    "logicalIndexExists": conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_environmental_snapshots_unique_logical'").fetchone()[0],
    "createdUniqueIndexCount": conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql LIKE 'CREATE UNIQUE INDEX%'").fetchone()[0],
    "sourceRunNodeId": conn.execute("SELECT node_id FROM source_runs WHERE id='run-weather-a'").fetchone()[0],
}))
`;
  const result = spawnSync("python", ["-c", script], { cwd: process.cwd(), encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`sqlite migration fixture failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function payloadForNode(name, item, index = 0) {
  const payload = fixture(name);
  return {
    ...payload,
    latitude: item.latitude,
    longitude: item.longitude,
    location_id: index
  };
}

function batchPayload(name, nodes = TOKYO_BAY_ENVIRONMENT_NODES) {
  return nodes.map((item, index) => payloadForNode(name, item, index));
}

function weatherPayloadWithValues(item, index, values) {
  return {
    ...payloadForNode("open-meteo-weather-hourly.json", item, index),
    latitude: item.latitude + (values.latitudeOffset ?? 0),
    longitude: item.longitude + (values.longitudeOffset ?? 0),
    hourly: {
      time: ["2026-07-12T00:00", "2026-07-12T01:00"],
      temperature_2m: [values.temperature, values.temperature + 100],
      precipitation: [values.precipitation, values.precipitation + 100],
      pressure_msl: [1008, 1007],
      wind_speed_10m: [values.windSpeed, values.windSpeed + 100],
      wind_direction_10m: [values.windDirection ?? 90, values.windDirection ?? 90],
      wind_gusts_10m: [values.windGust, values.windGust + 100]
    }
  };
}

function okJson(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

class FakeD1 {
  constructor(options = {}) {
    this.fail = options.fail ?? false;
    this.prepared = [];
    this.existingSnapshots = new Set(options.existingSnapshots || []);
    this.queryRows = options.queryRows || [];
  }

  prepare(sql) {
    if (this.fail) throw new Error("D1 exploded");
    const db = this;
    return {
      bind(...params) {
        return {
          async run() {
            db.prepared.push({ sql, params });
            if (sql.includes("environmental_snapshots")) {
              let changes = 0;
              for (let index = 0; index < params.length; index += 18) {
                const key = params[index];
                if (!db.existingSnapshots.has(key)) {
                  db.existingSnapshots.add(key);
                  changes += 1;
                }
              }
              return { meta: { changes } };
            }
            if (sql.includes("source_runs")) {
              return { meta: { changes: params.length / 11 } };
            }
            return { meta: { changes: 0 } };
          },
          async all() {
            db.prepared.push({ sql, params });
            return { results: db.queryRows };
          }
        };
      }
    };
  }
}

class HydroD1 {
  constructor(options = {}) {
    this.sourceRuns = new Map();
    this.observations = new Map();
    this.statements = [];
    this.failBatch = options.failBatch ?? false;
  }

  prepare(sql) {
    return new HydroD1Statement(this, sql);
  }

  async batch(statements) {
    const sourceRuns = new Map(this.sourceRuns);
    const observations = new Map(this.observations);
    try {
      if (this.failBatch) throw new Error("Injected hydro D1 batch failure with SECRET_INTERNAL_DETAIL");
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.sourceRuns = sourceRuns;
      this.observations = observations;
      throw error;
    }
  }
}

class HydroD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    this.db.statements.push({ sql: this.sql, params });
    return this;
  }

  async first() {
    if (this.sql.includes("FROM hydro_coastal_source_runs")) {
      return this.db.sourceRuns.get(this.params[0]) || null;
    }
    return null;
  }

  async all() {
    if (this.sql.includes("WHERE version_key IN")) {
      const versionKeys = this.sql.includes("json_each(?)") ? JSON.parse(this.params[0]) : this.params;
      return {
        results: versionKeys
          .map((versionKey) => this.db.observations.get(versionKey))
          .filter(Boolean)
          .map((row) => ({ version_key: row.version_key, normalized_json: row.normalized_json }))
      };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("INTO hydro_coastal_source_runs")) {
      const row = hydroSourceRunRowFromParams(this.params);
      if (this.db.sourceRuns.has(row.id)) throw new Error("UNIQUE constraint failed: hydro_coastal_source_runs.id");
      this.db.sourceRuns.set(row.id, row);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INTO hydro_coastal_observations")) {
      const rows = this.sql.includes("json_each(?)")
        ? JSON.parse(this.params[0]).map(hydroObservationRowFromJsonPayload)
        : [];
      let changes = 0;
      for (const row of rows) {
        if (this.db.observations.has(row.version_key)) throw new Error("UNIQUE constraint failed: hydro_coastal_observations.version_key");
        this.db.observations.set(row.version_key, row);
        changes += 1;
      }
      return { meta: { changes } };
    }
    return { meta: { changes: 0 } };
  }
}

function hydroSourceRunRowFromParams(params) {
  const [
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json
  ] = params;
  return {
    id,
    provider_id,
    requested_at,
    completed_at,
    status,
    http_status,
    error_code,
    raw_hash,
    source_name,
    source_url,
    parser_id,
    parser_version,
    source_format_version,
    normalized_schema_version,
    run_json,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function hydroObservationRowFromJsonPayload(item) {
  return {
    id: 1,
    version_key: item.versionKey,
    identity_key: item.identityKey,
    source_run_id: item.sourceRunId,
    provider_id: item.providerId,
    station_id: item.stationId,
    metric: item.metric,
    observed_at: item.observedAt,
    collected_at: item.collectedAt,
    forecast_issued_at: item.forecastIssuedAt,
    value: item.value,
    unit: item.unit,
    status: item.status,
    provisional: item.provisional,
    vertical_datum_json: item.verticalDatumJson,
    normalized_schema_version: item.normalizedSchemaVersion,
    normalized_json: item.normalizedJson,
    created_at: "2026-07-15T00:00:00.000Z"
  };
}

function responseFromText(text, { status = 200, ok = status >= 200 && status < 300, onArrayBuffer } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok,
    status,
    async arrayBuffer() {
      onArrayBuffer?.();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function annualJmaBody(station) {
  return Array.from({ length: 365 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index));
    return jmaLine(station, {
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      startLevel: 60 + (index % 40)
    });
  }).join("\n");
}

function jmaLine(station, { month = 1, day = 1, startLevel = 100 } = {}) {
  const hourly = Array.from({ length: 24 }, (_, hour) => String(startLevel + hour).padStart(3, " ")).join("");
  const date = `26${String(month).padStart(2, " ")}${String(day).padStart(2, " ")}`;
  const highTides = ["0130123", "1410134", "9999999", "9999999"].join("");
  const lowTides = ["0720 45", "2000 56", "9999999", "9999999"].join("");
  const line = `${hourly}${date}${station}${highTides}${lowTides}`;
  expect(line).toHaveLength(JMA_TIDE_PREDICTION_LINE_LENGTH);
  return line;
}

function postJmaAdmin(db) {
  return worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-secret"
    },
    body: JSON.stringify({
      stationId: "TK",
      sourceYear: 2026,
      forecastIssuedAt: "2025-12-30T00:00:00.000Z"
    })
  }), {
    WANOKU_ADMIN_SECRET: "test-secret",
    WANOKU_INTEL_D1: db
  });
}

function snapshotRow({
  snapshotKey,
  nodeId = node.id,
  source = "open-meteo-weather",
  observedAt = "2026-07-12T00:00:00+09:00",
  collectedAt,
  forecastIssuedAt = null,
  coordinateDistanceKm,
  model,
  windSpeed,
  windGust,
  createdAt = collectedAt || "2026-07-12T00:00:00Z",
  includeTimesInJson = true
}) {
  const snapshot = {
    nodeId,
    source,
    observedAt,
    latitude: node.latitude,
    longitude: node.longitude,
    coordinateDistanceKm,
    model,
    windSpeed,
    windGust,
    confidence: 0.8,
    freshness: 0.9,
    missingFields: []
  };
  if (includeTimesInJson) {
    snapshot.collectedAt = collectedAt;
    snapshot.forecastIssuedAt = forecastIssuedAt;
  }
  return {
    snapshot_key: snapshotKey,
    normalized_json: JSON.stringify(snapshot),
    collected_at: collectedAt,
    forecast_issued_at: forecastIssuedAt,
    created_at: createdAt
  };
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
      collectedAt: "2026-07-12T00:00:02Z",
      forecastIssuedAt: null,
      windSpeed: 4.2,
      windDirection: 350,
      pressure: 1008.2,
      airTemperature: 27.8
    });
    expect(snapshots[0].hourly).toBeUndefined();
    expect(snapshots[0].model).toBeUndefined();
    expect(snapshots[0].provenance[0].rawHash).toBe("fixture-hash");
  });

  it("does not store timezone_abbreviation as Open-Meteo weather or marine model", () => {
    const weatherPayload = {
      ...fixture("open-meteo-weather-hourly.json"),
      timezone_abbreviation: "GMT+9"
    };
    const marinePayload = {
      ...fixture("open-meteo-marine-hourly.json"),
      timezone_abbreviation: "GMT+9"
    };

    expect(normalizeOpenMeteoWeather(weatherPayload, node, {
      completedAt: "2026-07-12T00:00:02Z"
    })[0].model).toBeUndefined();
    expect(normalizeOpenMeteoMarine(marinePayload, node, {
      completedAt: "2026-07-12T00:00:02Z"
    })[0].model).toBeUndefined();
  });

  it("does not treat Open-Meteo live fetch time as forecastIssuedAt", () => {
    const snapshots = normalizeOpenMeteoWeather(fixture("open-meteo-weather-hourly.json"), node, {
      requestedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(snapshots[0].collectedAt).toBe("2026-07-12T00:00:02Z");
    expect(snapshots[0].forecastIssuedAt).toBeNull();
  });

  it("preserves a true provider forecastIssuedAt when explicitly supplied", () => {
    const snapshots = normalizeOpenMeteoWeather(fixture("open-meteo-weather-hourly.json"), node, {
      collectedAt: "2026-07-12T00:00:02Z",
      forecastIssuedAt: "2026-07-11T18:00:00Z"
    });

    expect(snapshots[0].collectedAt).toBe("2026-07-12T00:00:02Z");
    expect(snapshots[0].forecastIssuedAt).toBe("2026-07-11T18:00:00Z");
  });

  it("normalizes Open-Meteo marine values including currents and sea level model output", () => {
    const snapshots = normalizeOpenMeteoMarine(fixture("open-meteo-marine-hourly.json"), node, {
      requestedAt: "2026-07-12T00:00:00Z",
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toMatchObject({
      source: "open-meteo-marine",
      collectedAt: "2026-07-12T00:00:02Z",
      forecastIssuedAt: null,
      waveHeight: 0.7,
      swellHeight: 0.22,
      seaSurfaceTemperature: 26.7,
      oceanCurrentVelocity: 0.35,
      oceanCurrentDirection: 95,
      seaLevelHeightMsl: 0.15
    });
    expect(snapshots[2].model).toBeUndefined();
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

  it("builds batch URLs with all node latitudes and longitudes", () => {
    const weatherUrl = new URL(buildOpenMeteoWeatherBatchUrl(TOKYO_BAY_ENVIRONMENT_NODES));
    const marineUrl = new URL(buildOpenMeteoMarineBatchUrl(TOKYO_BAY_ENVIRONMENT_NODES));

    expect(weatherUrl.searchParams.get("latitude")?.split(",")).toHaveLength(12);
    expect(weatherUrl.searchParams.get("longitude")?.split(",")).toHaveLength(12);
    expect(marineUrl.searchParams.get("latitude")?.split(",")).toHaveLength(12);
    expect(marineUrl.searchParams.get("longitude")?.split(",")).toHaveLength(12);
  });

  it("maps shuffled multi-location responses back to the correct nodes by coordinates", () => {
    const nodes = TOKYO_BAY_ENVIRONMENT_NODES.slice(0, 3);
    const shuffled = [2, 0, 1].map((nodeIndex) => payloadForNode("open-meteo-weather-hourly.json", nodes[nodeIndex], nodeIndex));
    const matches = matchOpenMeteoResponsesToNodes(shuffled, nodes);
    const normalized = normalizeOpenMeteoWeatherBatch(shuffled, nodes, {
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(matches.map((match) => match.node.id)).toEqual(nodes.map((item) => item.id));
    expect(normalized.map((item) => item.nodeId)).toEqual(nodes.map((item) => item.id));
    expect(normalized.every((item) => item.status === "ok")).toBe(true);
  });

  it("keeps per-node weather values and hourly indexes aligned in batch normalization", () => {
    const nodes = TOKYO_BAY_ENVIRONMENT_NODES.slice(0, 3);
    const values = [
      { windSpeed: 1.1, windGust: 1.0, temperature: 21, precipitation: 0.1, latitudeOffset: 0.01, longitudeOffset: 0.00 },
      { windSpeed: 2.2, windGust: 3.3, temperature: 22, precipitation: 0.2, latitudeOffset: 0.00, longitudeOffset: 0.02 },
      { windSpeed: 4.4, windGust: 5.5, temperature: 23, precipitation: 0.3, latitudeOffset: 0.02, longitudeOffset: 0.01 }
    ];
    const shuffled = [2, 0, 1].map((nodeIndex) => weatherPayloadWithValues(nodes[nodeIndex], nodeIndex, values[nodeIndex]));
    const normalized = normalizeOpenMeteoWeatherBatch(shuffled, nodes, {
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(normalized.map((item) => item.nodeId)).toEqual(nodes.map((item) => item.id));
    expect(normalized.map((item) => item.coordinateDistanceKm)).toEqual(expect.arrayContaining([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    ]));
    expect(new Set(normalized.map((item) => item.coordinateDistanceKm)).size).toBe(3);
    for (const [index, nodeResult] of normalized.entries()) {
      expect(nodeResult.snapshots[0]).toMatchObject({
        windSpeed: values[index].windSpeed,
        windGust: values[index].windGust,
        airTemperature: values[index].temperature,
        precipitation: values[index].precipitation
      });
      expect(nodeResult.snapshots[0].windSpeed).not.toBe(values[index].windSpeed + 100);
      expect(nodeResult.snapshots[0].windGust).not.toBe(values[index].windGust + 100);
      expect(nodeResult.snapshots[0].coordinateDistanceKm).toBeCloseTo(nodeResult.coordinateDistanceKm, 3);
    }
  });

  it("returns a node-level failure when one requested location is absent", () => {
    const nodes = TOKYO_BAY_ENVIRONMENT_NODES.slice(0, 3);
    const payloads = nodes.slice(0, 2).map((item, index) => payloadForNode("open-meteo-weather-hourly.json", item, index));
    const normalized = normalizeOpenMeteoWeatherBatch(payloads, nodes, {
      completedAt: "2026-07-12T00:00:02Z"
    });

    expect(normalized).toHaveLength(3);
    expect(normalized[2]).toMatchObject({
      nodeId: nodes[2].id,
      status: "failed",
      errorCode: "malformed_response"
    });
  });

  it("collects all 12 nodes with two external fetches and batched D1 statements", async () => {
    const calls = [];
    const db = new FakeD1();
    const result = await collectEnvironment({
      WANOKU_INTEL_D1: db
    }, {
      requestedAt: "2026-07-12T00:00:00Z",
      retries: 0,
      fetchImpl: async (url) => {
        calls.push(url);
        return okJson(url.includes("marine-api")
          ? batchPayload("open-meteo-marine-hourly.json")
          : batchPayload("open-meteo-weather-hourly.json"));
      }
    });

    expect(calls).toHaveLength(2);
    expect(result.externalFetchCount).toBe(2);
    expect(result.nodeCount).toBe(12);
    expect(result.providerCount).toBe(2);
    expect(result.snapshotCount).toBe(24);
    expect(result.d1StatementCount).toBe(8);
    expect(result.estimatedSubrequestCount).toBeLessThan(20);
    expect(result.insertedCount).toBe(24);
    expect(db.prepared.every((statement) => statement.params.length <= 90)).toBe(true);
    const sourceRunStatement = db.prepared.find((statement) => statement.sql.includes("source_runs"));
    const snapshotStatement = db.prepared.find((statement) => statement.sql.includes("environmental_snapshots"));
    expect(sourceRunStatement.params[2]).toBe(TOKYO_BAY_ENVIRONMENT_NODES[0].id);
    expect(snapshotStatement.params[5]).toBeTruthy();
    expect(snapshotStatement.params[6]).toBeNull();
    expect(snapshotStatement.params[10]).toBeNull();
    const savedSnapshot = JSON.parse(snapshotStatement.params[16]);
    expect(savedSnapshot.model).toBeUndefined();
    expect(savedSnapshot.coordinateDistanceKm).toEqual(expect.any(Number));
  });

  it("keeps weather data when marine fails", async () => {
    const result = await collectEnvironment({
      WANOKU_INTEL_D1: new FakeD1()
    }, {
      requestedAt: "2026-07-12T00:00:00Z",
      retries: 0,
      fetchImpl: async (url) => {
        if (url.includes("marine-api")) return { ok: false, status: 503, json: async () => ({}) };
        return okJson(batchPayload("open-meteo-weather-hourly.json"));
      }
    });

    expect(result.externalFetchCount).toBe(2);
    expect(result.snapshotCount).toBe(12);
    expect(result.failureCount).toBe(12);
    expect(result.results.filter((item) => item.provider === "open-meteo-weather" && item.status === "ok")).toHaveLength(12);
    expect(result.results.filter((item) => item.provider === "open-meteo-marine" && item.status === "failed")).toHaveLength(12);
  });

  it("keeps marine data when weather fails", async () => {
    const result = await collectEnvironment({
      WANOKU_INTEL_D1: new FakeD1()
    }, {
      requestedAt: "2026-07-12T00:00:00Z",
      retries: 0,
      fetchImpl: async (url) => {
        if (!url.includes("marine-api")) return { ok: false, status: 502, json: async () => ({}) };
        return okJson(batchPayload("open-meteo-marine-hourly.json"));
      }
    });

    expect(result.externalFetchCount).toBe(2);
    expect(result.snapshotCount).toBe(12);
    expect(result.failureCount).toBe(12);
    expect(result.results.filter((item) => item.provider === "open-meteo-marine" && item.status === "ok")).toHaveLength(12);
    expect(result.results.filter((item) => item.provider === "open-meteo-weather" && item.status === "failed")).toHaveLength(12);
  });

  it("chunks D1 rows without exceeding the configured bound-parameter limit", () => {
    expect(chunkRowsForBoundLimit(Array.from({ length: 24 }), 11).map((chunk) => chunk.length)).toEqual([8, 8, 8]);
    expect(chunkRowsForBoundLimit(Array.from({ length: 24 }), 18).map((chunk) => chunk.length)).toEqual([5, 5, 5, 5, 4]);
  });

  it("reports duplicate snapshot upserts from D1 changes", async () => {
    const db = new FakeD1();
    const options = {
      requestedAt: "2026-07-12T00:00:00Z",
      collectedAt: "2026-07-12T00:00:02Z",
      retries: 0,
      fetchImpl: async (url) => okJson(url.includes("marine-api")
        ? batchPayload("open-meteo-marine-hourly.json")
        : batchPayload("open-meteo-weather-hourly.json"))
    };

    const first = await collectEnvironment({ WANOKU_INTEL_D1: db }, options);
    const second = await collectEnvironment({ WANOKU_INTEL_D1: db }, options);

    expect(first.insertedCount).toBe(24);
    expect(second.insertedCount).toBe(0);
    expect(second.duplicateCount).toBe(24);
  });

  it("keeps different collectedAt values as separate forecast vintages for the same observedAt", async () => {
    const db = new FakeD1();
    const baseOptions = {
      requestedAt: "2026-07-12T00:00:00Z",
      retries: 0,
      fetchImpl: async (url) => okJson(url.includes("marine-api")
        ? batchPayload("open-meteo-marine-hourly.json")
        : batchPayload("open-meteo-weather-hourly.json"))
    };

    const first = await collectEnvironment({ WANOKU_INTEL_D1: db }, {
      ...baseOptions,
      collectedAt: "2026-07-12T00:00:02Z"
    });
    const second = await collectEnvironment({ WANOKU_INTEL_D1: db }, {
      ...baseOptions,
      requestedAt: "2026-07-12T03:00:00Z",
      collectedAt: "2026-07-12T03:00:02Z"
    });

    expect(first.insertedCount).toBe(24);
    expect(second.insertedCount).toBe(24);
    expect(second.duplicateCount).toBe(0);
  });

  it("converts collection exceptions to stable JSON 500 responses", async () => {
    vi.stubGlobal("fetch", async (url) => okJson(url.includes("marine-api")
      ? batchPayload("open-meteo-marine-hourly.json")
      : batchPayload("open-meteo-weather-hourly.json")));
    const response = await worker.fetch(new Request("https://worker.example/admin/collect-environment", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" }
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new FakeD1({ fail: true })
    });
    vi.unstubAllGlobals();

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: "environment_collection_failed",
      message: "Environmental collection failed."
    });
    expect(JSON.stringify(body)).not.toContain("D1 exploded");
  });

  it("supports admin diagnostic provider and node filters", async () => {
    vi.stubGlobal("fetch", async () => okJson(batchPayload("open-meteo-weather-hourly.json", [node])));
    const response = await worker.fetch(new Request(`https://worker.example/admin/collect-environment?provider=weather&node_id=${node.id}`, {
      method: "POST",
      headers: { "X-Wanoku-Admin-Secret": "test-secret" }
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new FakeD1()
    });
    vi.unstubAllGlobals();

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.externalFetchCount).toBe(1);
    expect(body.nodeCount).toBe(1);
    expect(body.providerCount).toBe(1);
  });

  it("collects one JMA tide prediction station through the protected admin route at annual scale", async () => {
    const db = new HydroD1();
    const sourceText = annualJmaBody("TK");
    let bodyReadCount = 0;
    vi.stubGlobal("fetch", async () => responseFromText(sourceText, { onArrayBuffer: () => { bodyReadCount += 1; } }));

    const response = await worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret"
      },
      body: JSON.stringify({
        stationId: "TK",
        sourceYear: 2026,
        forecastIssuedAt: "2025-12-30T00:00:00.000Z"
      })
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: db
    });
    vi.unstubAllGlobals();

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "ok",
      stationId: "TK",
      sourceYear: 2026,
      sourceUrl: "https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/2026/TK.txt",
      parsedObservationCount: 8_760
    });
    expect(body.persistence).toMatchObject({
      ok: true,
      insertedCount: 8_760,
      queryBudgetExceeded: false
    });
    expect(body.persistence.statementCount).toBeLessThan(20);
    expect(body.persistence.maximumPayloadChunkBytes).toBeLessThanOrEqual(1_500_000);
    expect(bodyReadCount).toBe(1);
    expect(db.sourceRuns.size).toBe(1);
    expect(db.observations.size).toBe(8_760);
    expect(db.statements.every((statement) => statement.params.length <= 100)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(sourceText.slice(0, 100));
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  it("validates the JMA tide prediction admin route before any fetch", async () => {
    const invalidRequests = [
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Authorization: "Bearer test-secret" },
        body: "{}"
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: "{bad"
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify([])
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ sourceYear: 2026, forecastIssuedAt: "2025-12-30T00:00:00.000Z" })
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ stationId: "ZZ", sourceYear: 2026, forecastIssuedAt: "2025-12-30T00:00:00.000Z" })
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ stationId: "TK", sourceYear: 2027, forecastIssuedAt: "2025-12-30T00:00:00.000Z" })
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ stationId: "TK", sourceYear: 2026, forecastIssuedAt: "2025-12-30T09:00:00+09:00" })
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ stationId: "TK", sourceYear: 2026, forecastIssuedAt: "2025-12-30T00:00:00.000Z", sourceUrl: "https://evil.example/secret.txt" })
      }),
      new Request("https://worker.example/admin/collect-jma-tide-prediction", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
        body: JSON.stringify({ stationId: "TK", sourceYear: 2026, forecastIssuedAt: "2025-12-30T00:00:00.000Z", extra: "nope" })
      })
    ];
    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => {
      fetchCalled = true;
      return responseFromText(jmaLine("TK"));
    });

    for (const request of invalidRequests) {
      const response = await worker.fetch(request, {
        WANOKU_ADMIN_SECRET: "test-secret",
        WANOKU_INTEL_D1: new HydroD1()
      });
      expect(response.status).toBe(400);
    }
    const largeResponse = await worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify({ stationId: "TK", sourceYear: 2026, forecastIssuedAt: "2025-12-30T00:00:00.000Z", filler: "x".repeat(5000) })
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new HydroD1()
    });
    vi.unstubAllGlobals();

    expect(largeResponse.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  it("maps JMA tide prediction admin auth, upstream, partial, and persistence failures safely", async () => {
    const unauthorized = await worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new HydroD1()
    });
    const missingSecret = await worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: "{}"
    }), {
      WANOKU_INTEL_D1: new HydroD1()
    });
    const wrongMethod = await worker.fetch(new Request("https://worker.example/admin/collect-jma-tide-prediction", {
      method: "PUT",
      headers: { Authorization: "Bearer test-secret" }
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new HydroD1()
    });

    vi.stubGlobal("fetch", async () => responseFromText("not parsed", { status: 404 }));
    const upstream = await postJmaAdmin(new HydroD1());
    vi.stubGlobal("fetch", async () => responseFromText([jmaLine("TK"), jmaLine("ZZ")].join("\n")));
    const partial = await postJmaAdmin(new HydroD1());
    vi.stubGlobal("fetch", async () => responseFromText(jmaLine("TK")));
    const persistence = await postJmaAdmin(new HydroD1({ failBatch: true }));
    vi.unstubAllGlobals();

    expect(unauthorized.status).toBe(403);
    expect(missingSecret.status).toBe(503);
    expect(wrongMethod.status).toBe(405);
    expect(upstream.status).toBe(502);
    expect((await upstream.json()).errors.map((item) => item.code)).toContain("http_error");
    const partialBody = await partial.json();
    expect(partial.status).toBe(207);
    expect(partialBody.status).toBe("partial");
    expect(partialBody.persistence.insertedCount).toBe(24);
    const persistenceBody = await persistence.json();
    expect(persistence.status).toBe(500);
    expect(persistenceBody.errors.map((item) => item.code)).toContain("persistence_error");
    expect(JSON.stringify(persistenceBody)).not.toContain("Injected");
  });

  it("lists the JMA tide prediction admin route in health without changing collect-environment", async () => {
    const health = await worker.fetch(new Request("https://worker.example/health"), {});
    const healthBody = await health.json();

    expect(healthBody.endpoints).toContain("POST /admin/collect-jma-tide-prediction");
    vi.stubGlobal("fetch", async () => okJson(batchPayload("open-meteo-weather-hourly.json", [node])));
    const environment = await worker.fetch(new Request(`https://worker.example/admin/collect-environment?provider=weather&node_id=${node.id}`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" }
    }), {
      WANOKU_ADMIN_SECRET: "test-secret",
      WANOKU_INTEL_D1: new FakeD1()
    });
    vi.unstubAllGlobals();
    expect(environment.status).toBe(200);
  });

  it("keeps legacy snapshot_key readable without regenerating it", async () => {
    const legacyKey = `${node.id}|open-meteo-weather|2026-07-12T00:00:00+09:00|2026-07-12T00:00:02Z|wanoku-environmental-snapshot.v1`;
    const response = await worker.fetch(new Request("https://worker.example/environment/history"), {
      WANOKU_INTEL_D1: new FakeD1({
        queryRows: [
          snapshotRow({
            snapshotKey: legacyKey,
            collectedAt: "2026-07-12T00:00:02Z",
            forecastIssuedAt: null,
            model: "GMT+9",
            includeTimesInJson: false
          })
        ]
      })
    });

    const body = await response.json();
    expect(body.snapshots[0].snapshotKey).toBe(legacyKey);
    expect(body.snapshots[0].collectedAt).toBe("2026-07-12T00:00:02Z");
    expect(body.snapshots[0].forecastIssuedAt).toBeNull();
    expect(body.snapshots[0].model).toBeUndefined();
  });

  it("current returns only the latest collectedAt vintage per node/provider", async () => {
    const response = await worker.fetch(new Request("https://worker.example/environment/current"), {
      WANOKU_INTEL_D1: new FakeD1({
        queryRows: [
          snapshotRow({
            snapshotKey: "old",
            collectedAt: "2026-07-12T00:00:02Z"
          }),
          snapshotRow({
            snapshotKey: "new",
            collectedAt: "2026-07-12T03:00:02Z",
            coordinateDistanceKm: 2.606
          })
        ]
      })
    });

    const body = await response.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].snapshotKey).toBe("new");
    expect(body.snapshots[0].coordinateDistanceKm).toBe(2.606);
  });

  it("history can return multiple vintages for the same node/provider/observedAt", async () => {
    const response = await worker.fetch(new Request("https://worker.example/environment/history?orderBy=collectedAt"), {
      WANOKU_INTEL_D1: new FakeD1({
        queryRows: [
          snapshotRow({
            snapshotKey: "old",
            collectedAt: "2026-07-12T00:00:02Z",
            coordinateDistanceKm: 1.234
          }),
          snapshotRow({
            snapshotKey: "new",
            collectedAt: "2026-07-12T03:00:02Z",
            coordinateDistanceKm: 2.345
          })
        ]
      })
    });

    const body = await response.json();
    expect(body.snapshots.map((item) => item.snapshotKey)).toEqual(["old", "new"]);
    expect(body.snapshots.map((item) => item.coordinateDistanceKm)).toEqual([1.234, 2.345]);
  });

  it("quality exposes coordinate distance and flags gust below sustained wind without changing values", async () => {
    const response = await worker.fetch(new Request("https://worker.example/environment/quality"), {
      WANOKU_INTEL_D1: new FakeD1({
        queryRows: [
          snapshotRow({
            snapshotKey: "gust-anomaly",
            collectedAt: "2026-07-12T03:00:02Z",
            coordinateDistanceKm: 2.606,
            windSpeed: 5.33,
            windGust: 2.3
          })
        ]
      })
    });

    const body = await response.json();
    expect(body.snapshots[0].windSpeed).toBe(5.33);
    expect(body.snapshots[0].windGust).toBe(2.3);
    expect(body.quality[0].coordinateDistanceKm).toBe(2.606);
    expect(body.quality[0].warnings).toContain("wind_gust_below_sustained_wind");
  });

  it("quality tolerates legacy snapshots without coordinate distance", async () => {
    const response = await worker.fetch(new Request("https://worker.example/environment/quality"), {
      WANOKU_INTEL_D1: new FakeD1({
        queryRows: [
          snapshotRow({
            snapshotKey: "legacy-no-distance",
            collectedAt: "2026-07-12T03:00:02Z"
          })
        ]
      })
    });

    const body = await response.json();
    expect(body.quality[0].coordinateDistanceKm).toBeNull();
  });

  it("migration 0002 does not delete data or recreate a logical unique index", () => {
    const sql = readFileSync(new URL("../migrations/0002_source_runs_node_id.sql", import.meta.url), "utf8").toLowerCase();
    const dropLogicalIndexPosition = sql.indexOf("drop index if exists idx_environmental_snapshots_unique_logical");
    const firstEnvironmentalUpdatePosition = sql.indexOf("update environmental_snapshots");

    expect(dropLogicalIndexPosition).toBeGreaterThanOrEqual(0);
    expect(firstEnvironmentalUpdatePosition).toBeGreaterThan(dropLogicalIndexPosition);
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdrop\s+table\b/);
    expect(sql).toContain("alter table source_runs add column node_id text");
    expect(sql).toContain("alter table environmental_snapshots add column collected_at text");
    expect(sql).toContain("drop index if exists idx_environmental_snapshots_unique_logical");
    expect(sql).not.toMatch(/\bcreate\s+unique\s+index\b/);
    expect(sql).toMatch(/set\s+collected_at\s*=\s*coalesce[\s\S]*source_runs\.completed_at[\s\S]*source_runs\.requested_at[\s\S]*forecast_issued_at[\s\S]*created_at/);
    expect(sql).toMatch(/set\s+forecast_issued_at\s*=\s*null[\s\S]*provider\s+in\s*\('open-meteo-weather',\s*'open-meteo-marine'\)[\s\S]*or\s+source\s+in\s*\('open-meteo-weather',\s*'open-meteo-marine'\)/);
  });

  it("migration 0002 succeeds in local sqlite while preserving multiple forecast vintages", () => {
    const metrics = runMigrationSqliteFixture();

    expect(metrics.beforeRows).toBe(6);
    expect(metrics.afterRows).toBe(6);
    expect(metrics.deletedRows).toBe(0);
    expect(metrics.collectedNullRows).toBe(0);
    expect(metrics.openMeteoForecastNotNullRows).toBe(0);
    expect(metrics.officialForecastIssuedAt).toBe("2026-07-11T18:00:00Z");
    expect(metrics.createdFallbackCollectedAt).toBe("2026-07-12T00:07:00Z");
    expect(metrics.weatherVintageCount).toBe(2);
    expect(metrics.logicalIndexExists).toBe(0);
    expect(metrics.createdUniqueIndexCount).toBe(0);
    expect(metrics.sourceRunNodeId).toBe("node-a");
  });
});
