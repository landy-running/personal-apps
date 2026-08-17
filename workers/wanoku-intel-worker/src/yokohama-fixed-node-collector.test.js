import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXED_COASTAL_FACILITIES } from "../../../packages/wanoku-core/src/fixed-node-observation.ts";
import worker from "./index.js";
import {
  buildYokohamaFixedNodeReport,
  collectYokohamaFixedNode,
  jstDateAt
} from "./yokohama-fixed-node-collector.js";
import {
  YOKOHAMA_FIXED_NODE_ROOT_URL,
  fetchYokohamaFixedNodeDailySource,
  parseYokohamaLastPost
} from "./yokohama-fixed-node-source.js";

const DATE = "2026-08-15";
const COLLECTED_AT = "2026-08-16T03:00:00.000Z";
const APPSYNC_ENDPOINT = "https://collectorfixture.appsync-api.ap-northeast-1.amazonaws.com/graphql";
const BUNDLE_URL = "https://yokohama-fishingpiers.jp/assets/index-abcdef12.js";
const ADMIN_SECRET = "fixture-admin-secret";
const YOKOHAMA_FACILITIES = FIXED_COASTAL_FACILITIES.filter((facility) => facility.providerId === "yokohama-fishing-piers");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Wanoku Yokohama Fixed-Node Collector v1 source", () => {
  it.each([
    ["yokohama-honmoku", "honmoku"],
    ["yokohama-daikoku", "daikoku"],
    ["yokohama-isogo", "isogo"]
  ])("parses the stable UUID and JST observation date for %s", (facilityId, providerFacilityKey) => {
    const record = parseStrict(item(providerFacilityKey), facilityId);
    expect(record).toMatchObject({
      facilityId,
      sourceRecordId: `last-post:uuid-${providerFacilityKey}-20260815`,
      observationDate: DATE,
      observedAt: "2026-08-15T00:00:00+09:00",
      visitors: 150,
      operatingStatus: "operating",
      reportComplete: true
    });
  });

  it("keeps the source UUID stable when semantic content changes", () => {
    const first = parseStrict(item("honmoku"), "yokohama-honmoku");
    const revised = parseStrict(item("honmoku", { visitors: 151, fish1Count: 4 }), "yokohama-honmoku");
    expect(revised.sourceRecordId).toBe(first.sourceRecordId);
  });

  it("resolves an omitted date against an explicit JST clock boundary", () => {
    expect(jstDateAt("2026-08-14T14:59:59.999Z")).toBe("2026-08-14");
    expect(jstDateAt("2026-08-14T15:00:00.000Z")).toBe("2026-08-15");
  });

  it("keeps a null visitor count unknown without weakening a complete species report", () => {
    const record = parseStrict(item("honmoku", { visitors: null }), "yokohama-honmoku");
    expect(record.visitors).toBeNull();
    expect(record.reportComplete).toBe(true);
  });

  it("aggregates seabass aliases and keeps all bait species independent", () => {
    const source = parseStrict(item("honmoku", {
      fish2Name: "フッコ", fish2Count: 2, fish2MinSize: 41, fish2MaxSize: 50, fish2Unit: "cm", fish2Place: ["沖桟橋"],
      fish3Name: "イワシ", fish3Count: 11,
      fish4Name: "サッパ", fish4Count: 12,
      fish5Name: "コノシロ", fish5Count: 13,
      fish6Name: "アジ", fish6Count: 14,
      fish7Name: "サバ", fish7Count: 15,
      fish8Name: "ボラ", fish8Count: 16,
      fish9Name: "ハゼ", fish9Count: 17
    }), "yokohama-honmoku");
    const report = buildYokohamaFixedNodeReport(source, "fixture-run");
    expect(report.species.find((row) => row.speciesId === "japanese-seabass")).toMatchObject({ catchCount: 5, presenceState: "present" });
    expect(Object.fromEntries(report.species.filter((row) => row.speciesId !== "japanese-seabass").map((row) => [row.speciesId, row.catchCount]))).toEqual({
      aji: 14,
      bora: 16,
      haze: 17,
      konoshiro: 13,
      saba: 15,
      sappa: 12,
      sardine: 11
    });
  });

  it("passes through explicit centimetre sizes and facility area facts", () => {
    const report = buildYokohamaFixedNodeReport(parseStrict(item("honmoku", {
      fish2Name: "フッコ", fish2Count: 2, fish2MinSize: 41, fish2MaxSize: 50, fish2Unit: "cm", fish2Place: ["沖桟橋"]
    }), "yokohama-honmoku"), "fixture-run");
    expect(report.species.find((row) => row.speciesId === "japanese-seabass")).toMatchObject({
      minSizeCm: 25,
      maxSizeCm: 50,
      areaLabels: ["沖桟橋", "旧護岸"]
    });
  });

  it("creates explicit zero only from a complete operating report", () => {
    const report = buildYokohamaFixedNodeReport(parseStrict(item("honmoku", {
      fish1Name: "アジ", fish1Count: 10, fish1MinSize: null, fish1MaxSize: null, fish1Unit: null, fish1Place: []
    }), "yokohama-honmoku"), "fixture-run");
    expect(report.reportCompleteness).toBe("complete");
    expect(report.species.find((row) => row.speciesId === "japanese-seabass")).toMatchObject({
      catchCount: 0,
      presenceState: "absent",
      aliasCoverage: "sufficient"
    });
  });

  it("does not convert a closed report into zero", () => {
    const report = buildYokohamaFixedNodeReport(parseStrict(item("honmoku", {
      sentence: "強風のため臨時休業",
      visitors: 0,
      fish1Name: null,
      fish1Count: null,
      fish1MinSize: null,
      fish1MaxSize: null,
      fish1Unit: null,
      fish1Place: null
    }), "yokohama-honmoku"), "fixture-run");
    expect(report.operatingStatus).toBe("closed");
    expect(report.species.every((row) => row.catchCount === null && row.presenceState === "unknown")).toBe(true);
  });

  it("does not infer zero from an incomplete species table", () => {
    const report = buildYokohamaFixedNodeReport(parseStrict(item("honmoku", {
      fish1Name: "アジ",
      fish1Count: null,
      fish1MinSize: null,
      fish1MaxSize: null,
      fish1Unit: null,
      fish1Place: []
    }), "yokohama-honmoku"), "fixture-run");
    expect(report.reportCompleteness).toBe("incomplete");
    expect(report.species.find((row) => row.speciesId === "japanese-seabass")).toMatchObject({ catchCount: null, presenceState: "unknown" });
  });

  it("reports a missing daily record without generating an observation", async () => {
    const fixtures = fixtureItems();
    fixtures.delete("daikoku");
    const source = await fetchYokohamaFixedNodeDailySource({
      observationDate: DATE,
      collectedAt: COLLECTED_AT,
      facilities: YOKOHAMA_FACILITIES,
      fetchImpl: sourceFetch(fixtures).fetchImpl
    });
    expect(source.records).toHaveLength(2);
    expect(source.failures).toContainEqual(expect.objectContaining({ facilityId: "yokohama-daikoku", code: "missing_source_record" }));
  });

  it("fails closed on facility/date mismatch and required species shape drift", () => {
    expect(() => parseStrict(item("daikoku"), "yokohama-honmoku")).toThrow("facility");
    expect(() => parseStrict(item("honmoku", { date: "2026/08/14" }), "yokohama-honmoku")).toThrow("date");
    const drifted = item("honmoku");
    delete drifted.fish30Count;
    expect(() => parseStrict(drifted, "yokohama-honmoku")).toThrow("species field is missing");
  });

  it("rejects visitor and species type drift instead of coercing it to zero", () => {
    expect(() => parseStrict(item("honmoku", { visitors: "150" }), "yokohama-honmoku")).toThrow("visitors");
    expect(() => parseStrict(item("honmoku", { fish1Count: "3" }), "yokohama-honmoku")).toThrow("fish count");
  });

  it.each([
    ["size", { fish1MinSize: "25" }, "minimum size"],
    ["area", { fish1Place: "旧護岸" }, "facility area"]
  ])("rejects %s type drift", (_label, overrides, message) => {
    expect(() => parseStrict(item("honmoku", overrides), "yokohama-honmoku")).toThrow(message);
  });

  it("rejects populated or blank unnamed fish slots before completeness can create zero", () => {
    expect(() => parseStrict(item("honmoku", { fish2Count: 9 }), "yokohama-honmoku")).toThrow("unnamed fish slot");
    expect(() => parseStrict(item("honmoku", { fish2Name: " " }), "yokohama-honmoku")).toThrow("non-empty or null");
  });

  it.each([
    ["duplicate record", { duplicateFacility: "honmoku" }],
    ["pagination", { paginatedFacility: "honmoku" }],
    ["partial GraphQL response", { partialFacility: "honmoku" }]
  ])("fails closed on %s", async (_label, options) => {
    const source = await fetchYokohamaFixedNodeDailySource({
      observationDate: DATE,
      collectedAt: COLLECTED_AT,
      facilities: YOKOHAMA_FACILITIES,
      fetchImpl: sourceFetch(fixtureItems(), options).fetchImpl
    });
    expect(source.records.some((record) => record.facilityId === "yokohama-honmoku")).toBe(false);
    expect(source.failures).toContainEqual(expect.objectContaining({ facilityId: "yokohama-honmoku", code: "unexpected_schema" }));
  });
});

describe("Wanoku Yokohama Fixed-Node Collector v1 persistence", () => {
  it("persists one source run and three atomic eight-species reports", async () => {
    const db = new FixedNodeD1();
    const result = await runCollector(db, fixtureItems());
    expect(result).toMatchObject({ reportsGenerated: 3, reportsCreated: 3, reportsExisting: 0, speciesRowsCreated: 24, failed: 0 });
    expect(db.sourceRuns).toHaveLength(1);
    expect(db.reportRows).toHaveLength(3);
    expect(db.speciesRows).toHaveLength(24);
    expect(db.batchCalls).toBe(3);
  });

  it("treats exact semantic retry as existing", async () => {
    const db = new FixedNodeD1();
    await runCollector(db, fixtureItems());
    const retried = await runCollector(db, fixtureItems());
    expect(retried).toMatchObject({ reportsCreated: 0, reportsExisting: 3, semanticRevisionsCreated: 0, speciesRowsExisting: 24 });
    expect(db.reportRows).toHaveLength(3);
  });

  it("keeps collectedAt-only and sourceRun-only retries on the same semantic version", async () => {
    const db = new FixedNodeD1();
    const first = await runCollector(db, fixtureItems());
    const second = await runCollector(db, fixtureItems(), "2026-08-16T04:00:00.000Z");
    expect(second.records.filter((record) => record.status === "EXISTING").map((record) => record.reportId)).toEqual(
      first.records.filter((record) => record.status === "CREATED").map((record) => record.reportId)
    );
    expect(db.sourceRuns).toHaveLength(2);
    expect(db.reportRows).toHaveLength(3);
  });

  it("creates an append-only semantic revision for visitor changes", async () => {
    const db = new FixedNodeD1();
    await runCollector(db, fixtureItems());
    const revisedItems = fixtureItems();
    revisedItems.set("honmoku", item("honmoku", { visitors: 151 }));
    const revised = await runCollector(db, revisedItems, "2026-08-16T04:00:00.000Z");
    expect(revised).toMatchObject({ reportsCreated: 1, reportsExisting: 2, semanticRevisionsCreated: 1 });
    expect(db.reportRows.filter((row) => row.identity_key.includes("yokohama-honmoku"))).toHaveLength(2);
  });

  it("creates an append-only semantic revision for species changes", async () => {
    const db = new FixedNodeD1();
    await runCollector(db, fixtureItems());
    const revisedItems = fixtureItems();
    revisedItems.set("honmoku", item("honmoku", { fish1Count: 4 }));
    const revised = await runCollector(db, revisedItems, "2026-08-16T04:00:00.000Z");
    expect(revised.semanticRevisionsCreated).toBe(1);
    expect(db.reportRows).toHaveLength(4);
  });

  it("isolates one facility HTTP failure and persists the other two reports", async () => {
    const db = new FixedNodeD1();
    const fixture = sourceFetch(fixtureItems(), { failingFacility: "daikoku" });
    const result = await collectYokohamaFixedNode({ db, date: DATE, requestedAt: COLLECTED_AT, collectedAt: COLLECTED_AT, fetchImpl: fixture.fetchImpl });
    expect(result).toMatchObject({ facilitiesFetched: 2, reportsGenerated: 2, reportsCreated: 2, failed: 1 });
    expect(result.records).toContainEqual(expect.objectContaining({ facilityId: "yokohama-daikoku", status: "FAILED", reason: "http_error" }));
    expect(db.reportRows.some((row) => row.facility_id === "yokohama-daikoku")).toBe(false);
  });

  it("adds only the previously failed facility on retry", async () => {
    const db = new FixedNodeD1();
    await collectYokohamaFixedNode({
      db,
      date: DATE,
      requestedAt: COLLECTED_AT,
      collectedAt: COLLECTED_AT,
      fetchImpl: sourceFetch(fixtureItems(), { failingFacility: "daikoku" }).fetchImpl
    });
    const retried = await runCollector(db, fixtureItems());
    expect(retried).toMatchObject({ reportsCreated: 1, reportsExisting: 2, speciesRowsCreated: 8, speciesRowsExisting: 16, failed: 0 });
    expect(db.reportRows).toHaveLength(3);
    expect(db.speciesRows).toHaveLength(24);
  });

  it("rolls back a facility report and all species when its D1 batch fails", async () => {
    const db = new FixedNodeD1();
    db.failBatchAt = 1;
    const result = await runCollector(db, fixtureItems());
    expect(result).toMatchObject({ reportsCreated: 2, speciesRowsCreated: 16, failed: 1 });
    expect(db.reportRows.some((row) => row.facility_id === "yokohama-honmoku")).toBe(false);
    expect(db.speciesRows.some((row) => row.facility_id === "yokohama-honmoku")).toBe(false);
    expect(db.reportRows).toHaveLength(2);
    expect(db.speciesRows).toHaveLength(16);
  });
});

describe("Wanoku Yokohama Fixed-Node Collector v1 admin route", () => {
  it("checks admin authorization before body read, source fetch, or D1 access", async () => {
    const text = vi.fn(async () => "{}");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const db = new FixedNodeD1();
    const response = await worker.fetch({
      method: "POST",
      url: "https://worker.test/admin/collect-fixed-node-yokohama",
      headers: new Headers({ "content-type": "application/json" }),
      text
    }, { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db });
    expect(response.status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.prepared).toHaveLength(0);
  });

  it("accepts an authenticated date and returns the sanitized collection summary", async () => {
    const db = new FixedNodeD1();
    const fixture = sourceFetch(fixtureItems());
    vi.stubGlobal("fetch", fixture.fetchImpl);
    const response = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-yokohama", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ date: DATE })
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ observationDate: DATE, facilitiesRequested: 3, reportsCreated: 3, speciesRowsCreated: 24, failed: 0 });
    expect(fixture.calls).toHaveLength(5);
    expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(ADMIN_SECRET);
  });

  it("rejects malformed JSON without a source GET", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const response = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-yokohama", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: "{"
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: new FixedNodeD1() });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "malformed_json" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the current JST date when date is omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00.000Z"));
    const db = new FixedNodeD1();
    vi.stubGlobal("fetch", sourceFetch(fixtureItems()).fetchImpl);
    const response = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-yokohama", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: "{}"
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ observationDate: DATE });
  });

  it("rejects invalid date and unsupported fields without a source GET", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const response = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-yokohama", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ date: "2026/08/15", sourceUrl: "https://example.com" })
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: new FixedNodeD1() });
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("contains no remote command, direct D1 operator, or non-GET source request", () => {
    const source = readFileSync("workers/wanoku-intel-worker/src/yokohama-fixed-node-source.js", "utf8");
    const collector = readFileSync("workers/wanoku-intel-worker/src/yokohama-fixed-node-collector.js", "utf8");
    expect(`${source}\n${collector}`).not.toMatch(/--remote|wrangler|INSERT\s+OR|REPLACE\s+INTO|\bUPDATE\b|\bDELETE\b/iu);
    expect(source).toContain('method: "GET"');
    expect(source).not.toMatch(/method:\s*["']POST["']/u);
  });
});

function parseStrict(sourceItem, facilityId) {
  return parseYokohamaLastPost(sourceItem, {
    facility: YOKOHAMA_FACILITIES.find((facility) => facility.facilityId === facilityId),
    facilityId,
    observationDate: DATE,
    collectedAt: COLLECTED_AT,
    strictSchema: true
  });
}

function item(providerFacilityKey, overrides = {}) {
  const output = {
    id: `uuid-${providerFacilityKey}-20260815`,
    date: "2026/08/15",
    month: "2026/08",
    facility: providerFacilityKey,
    sentence: "通常営業しました。",
    weather: "晴れ",
    waterTemp: 26,
    tide: "中潮",
    visitors: 150,
    createdAt: "2026-08-15T10:28:51.385Z",
    updatedAt: "2026-08-15T10:28:51.385Z"
  };
  for (let index = 1; index <= 30; index += 1) {
    output[`fish${index}Name`] = null;
    output[`fish${index}MinSize`] = null;
    output[`fish${index}MaxSize`] = null;
    output[`fish${index}Unit`] = null;
    output[`fish${index}Count`] = null;
    output[`fish${index}Place`] = null;
  }
  Object.assign(output, {
    fish1Name: "セイゴ",
    fish1MinSize: 25,
    fish1MaxSize: 35,
    fish1Unit: "cm",
    fish1Count: providerFacilityKey === "daikoku" ? 0 : 3,
    fish1Place: ["旧護岸"]
  }, overrides);
  return output;
}

function fixtureItems() {
  return new Map([
    ["honmoku", item("honmoku")],
    ["daikoku", item("daikoku")],
    ["isogo", item("isogo")]
  ]);
}

function sourceFetch(items, options = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init?.method, headers: init?.headers });
    if (url.href === YOKOHAMA_FIXED_NODE_ROOT_URL) return response(`<script type="module" src="/assets/index-abcdef12.js"></script>`);
    if (url.href === BUNDLE_URL) {
      return response(`const config={aws_appsync_graphqlEndpoint:"${APPSYNC_ENDPOINT}",aws_appsync_authenticationType:"API_KEY",aws_appsync_apiKey:"fixture-public-read-key"};`);
    }
    if (url.hostname.endsWith("appsync-api.ap-northeast-1.amazonaws.com")) {
      const variables = JSON.parse(url.searchParams.get("variables"));
      const key = variables.facility.eq;
      if (options.failingFacility === key) return response("upstream failed", 503);
      const sourceItem = items.get(key);
      return response(JSON.stringify({
        ...(options.partialFacility === key ? { errors: [{ message: "partial source failure" }] } : {}),
        data: {
          lastPostsByMonthAndFacility: {
            items: sourceItem
              ? options.duplicateFacility === key ? [sourceItem, structuredClone(sourceItem)] : [sourceItem]
              : [],
            nextToken: options.paginatedFacility === key ? "next-page" : null
          }
        }
      }));
    }
    throw new Error(`Unexpected fixture URL: ${url.href}`);
  });
  return { fetchImpl, calls };
}

async function runCollector(db, items, collectedAt = COLLECTED_AT) {
  return collectYokohamaFixedNode({
    db,
    date: DATE,
    requestedAt: collectedAt,
    collectedAt,
    storedAt: collectedAt,
    fetchImpl: sourceFetch(items).fetchImpl
  });
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const REPORT_COLUMNS = [
  "report_id", "version_key", "identity_key", "semantic_hash", "facility_id", "provider_id", "observation_date",
  "source_record_id", "source_run_id", "published_at", "collected_at", "stored_at", "visitor_count", "operating_status",
  "report_completeness", "normalized_schema_version", "source_url", "payload_json"
];
const SPECIES_COLUMNS = [
  "observation_id", "report_id", "facility_id", "observation_date", "species_id", "source_labels_json", "catch_count",
  "presence_state", "min_size_cm", "max_size_cm", "area_labels_json", "completeness", "alias_coverage"
];
const RUN_COLUMNS = [
  "id", "provider", "node_id", "requested_at", "completed_at", "status", "http_status", "error_code", "model_version",
  "raw_hash", "normalized_schema_version"
];

class FixedNodeD1 {
  constructor() {
    this.sourceRuns = [];
    this.reportRows = [];
    this.speciesRows = [];
    this.prepared = [];
    this.batchCalls = 0;
    this.failBatchAt = null;
  }

  prepare(sql) {
    const statement = { sql: sql.trim(), params: [] };
    this.prepared.push(statement);
    return {
      bind: (...params) => {
        statement.params = params;
        return {
          all: async () => this.execute(statement, "all"),
          first: async () => this.execute(statement, "first"),
          run: async () => this.execute(statement, "run"),
          _statement: statement
        };
      }
    };
  }

  async batch(boundStatements) {
    this.batchCalls += 1;
    const snapshot = structuredClone({ sourceRuns: this.sourceRuns, reportRows: this.reportRows, speciesRows: this.speciesRows });
    try {
      const results = [];
      for (const bound of boundStatements) {
        results.push(await this.execute(bound._statement, "run"));
        if (this.failBatchAt === this.batchCalls && results.length === 4) throw new Error("injected D1 batch failure");
      }
      return results;
    } catch (error) {
      this.sourceRuns = snapshot.sourceRuns;
      this.reportRows = snapshot.reportRows;
      this.speciesRows = snapshot.speciesRows;
      throw error;
    }
  }

  execute(statement, mode) {
    const sql = statement.sql.replace(/\s+/gu, " ");
    const params = statement.params;
    if (sql.includes("FROM fixed_coastal_facilities")) {
      return { results: YOKOHAMA_FACILITIES.map((facility) => ({
        facility_id: facility.facilityId,
        provider_id: facility.providerId,
        provider_facility_key: facility.providerFacilityKey,
        display_name: facility.displayName
      })) };
    }
    if (sql.startsWith("SELECT id, provider") && sql.includes("FROM source_runs")) {
      return this.sourceRuns.find((row) => row.id === params[0]) ?? null;
    }
    if (sql.startsWith("INSERT INTO source_runs")) {
      if (this.sourceRuns.some((row) => row.id === params[0])) throw new Error("UNIQUE source run");
      this.sourceRuns.push(Object.fromEntries(RUN_COLUMNS.map((column, index) => [column, params[index]])));
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("SELECT report_id FROM fixed_node_daily_reports")) {
      return this.reportRows.find((row) => row.identity_key === params[0]) ?? null;
    }
    if (sql.includes("FROM fixed_node_daily_reports") && sql.includes("WHERE report_id = ? OR version_key = ?")) {
      return { results: this.reportRows.filter((row) => row.report_id === params[0] || row.version_key === params[1]) };
    }
    if (sql.includes("FROM fixed_node_species_observations") && sql.includes("WHERE report_id = ?")) {
      return { results: this.speciesRows.filter((row) => row.report_id === params[0]).sort((a, b) => a.species_id.localeCompare(b.species_id)) };
    }
    if (sql.startsWith("INSERT INTO fixed_node_daily_reports")) {
      const row = Object.fromEntries(REPORT_COLUMNS.map((column, index) => [column, params[index]]));
      if (!this.sourceRuns.some((run) => run.id === row.source_run_id)) throw new Error("FOREIGN KEY source run");
      if (this.reportRows.some((existing) => existing.report_id === row.report_id || existing.version_key === row.version_key)) throw new Error("UNIQUE report");
      this.reportRows.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO fixed_node_species_observations")) {
      const row = Object.fromEntries(SPECIES_COLUMNS.map((column, index) => [column, params[index]]));
      if (!this.reportRows.some((report) => report.report_id === row.report_id)) throw new Error("FOREIGN KEY report");
      if (this.speciesRows.some((existing) => existing.observation_id === row.observation_id)) throw new Error("UNIQUE species");
      this.speciesRows.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unsupported fake D1 ${mode}: ${sql}`);
  }
}
