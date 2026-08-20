import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import {
  ICHIHARA_FIXED_NODE_ARCHIVE_URL,
  buildIchiharaFixedNodeReport,
  collectIchiharaFixedNode,
  fetchLatestFinalizedIchiharaSource,
  parseIchiharaArchive,
  parseIchiharaCatchRows,
  parseIchiharaDetail,
  parseIchiharaVisitorCount
} from "./ichihara-fixed-node-collector.js";
import { materializeFixedNodeDailyReport } from "./fixed-node-observation-persistence.js";

const COLLECTED_AT = "2026-08-20T09:00:00.000Z";
const ADMIN_SECRET = "fixture-admin-secret";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Wanoku Ichihara Fixed-Node Collector v1 parser", () => {
  it("extracts and deterministically orders numeric report identities from the official archive shape", () => {
    const result = parseIchiharaArchive(archive([
      ["2026-08-19", "29001"],
      ["2026-08-20", "29031"]
    ]));
    expect(result.records).toEqual([
      {
        sourceRecordId: "fishing:29031",
        numericId: "29031",
        observationDate: "2026-08-20",
        sourceUrl: "https://ichihara-umizuri.com/fishing/29031/"
      },
      {
        sourceRecordId: "fishing:29001",
        numericId: "29001",
        observationDate: "2026-08-19",
        sourceUrl: "https://ichihara-umizuri.com/fishing/29001/"
      }
    ]);
  });

  it("skips the current interim candidate and selects the latest safely finalized detail", async () => {
    const fixture = sourceFetch(new Map([
      ["29031", detail({ date: "2026-08-20", narrative: "釣果は7時00分現在：入場者率29％", rows: [["セイゴ", "20cm", "合計2匹"]] })],
      ["29001", detail({ date: "2026-08-19", visitorText: "本日の入場者数は１２３名様でした。", rows: [["セイゴ", "20cm", "合計3匹"]] })]
    ]), [["2026-08-20", "29031"], ["2026-08-19", "29001"]]);
    const result = await fetchLatestFinalizedIchiharaSource({ collectedAt: COLLECTED_AT, fetchImpl: fixture.fetchImpl });
    expect(result.record).toMatchObject({ sourceRecordId: "fishing:29001", finality: "final", visitors: 123 });
    expect(result).toMatchObject({ skippedInterim: 1, remoteReads: 3 });
    expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("classifies normal, full closure, early closure, and malformed finality conservatively", () => {
    const normal = parse(detail({ rows: [["スズキ", "40～50cm", "合計2匹"]] }), "29001");
    const closure = parse(detail({
      narrative: "荒天のため本日の営業は中止とし、臨時休館いたします。",
      visitorText: "",
      rows: [["大荒れの海", "", ""]]
    }), "29002");
    const early = parse(detail({
      narrative: "14時00分を持ちまして本日の営業を中止いたします。",
      visitorText: "本日の入園者数は24名様でした。",
      rows: [["ボラ", "30cm", "合計4匹"], ["ハゼ", "12cm", "合計2匹"]]
    }), "29003");
    const malformed = parse(detail({ rows: [["アジ・サバ", "20cm", "合計3匹"]] }), "29004");
    expect(normal).toMatchObject({ finality: "final", operatingStatus: "operating", reportComplete: true });
    expect(closure).toMatchObject({ finality: "closure", operatingStatus: "closed", reportComplete: false });
    expect(early).toMatchObject({ finality: "final", operatingStatus: "operating", reportComplete: false });
    expect(early.diagnostics).toContain("operating-day-interrupted");
    const earlyReport = buildIchiharaFixedNodeReport(early, "fixture-run");
    expect(species(earlyReport, "bora")).toMatchObject({ catchCount: 4, presenceState: "present" });
    expect(species(earlyReport, "japanese-seabass")).toMatchObject({ catchCount: null, presenceState: "unknown" });
    expect(malformed).toMatchObject({ finality: "unknown", operatingStatus: "unknown", reportComplete: false });
  });

  it.each([
    ["本日の入場者数は１２３名様でした。", 123],
    ["本日の入園者数は1,234名でした。", 1234],
    ["本日のご来場者数は９８名様でした。", 98],
    ["釣果は7時00分現在：入場者率29％", null]
  ])("parses only a confident final visitor total: %s", (text, expected) => {
    expect(parseIchiharaVisitorCount(text)).toBe(expected);
  });

  it("maps and sums audited seabass and sardine aliases exactly once", () => {
    const source = parse(detail({ rows: [
      ["スズキ", "40cm", "合計2匹"],
      ["フッコ", "35cm", "合計3匹"],
      ["釣れた！(セイゴ)", "20cm", "合計7匹"],
      ["フッコ・スズキ（モエビ餌）", "45cm", "合計4匹"],
      ["イワシ", "", "合計11匹"],
      ["マイワシ", "", "合計12匹"],
      ["カタクチイワシ", "", "合計13匹"]
    ] }), "29001");
    const report = buildIchiharaFixedNodeReport(source, "fixture-run");
    expect(species(report, "japanese-seabass")).toMatchObject({ catchCount: 16, presenceState: "present" });
    expect(species(report, "japanese-seabass").sourceLabels).toEqual([
      "スズキ", "フッコ", "フッコ・スズキ（モエビ餌）", "釣れた！(セイゴ)"
    ].sort((a, b) => a.localeCompare(b)));
    expect(species(report, "sardine")).toMatchObject({ catchCount: 36, presenceState: "present" });
  });

  it("maps every remaining target species while retaining unsupported chinu and kataboshi labels", () => {
    const source = parse(detail({ rows: [
      ["初めて釣りました(サッパ)", "", "合計1匹"],
      ["コノシロ", "", "合計2匹"],
      ["アジ", "", "合計3匹"],
      ["サバ", "", "合計4匹"],
      ["ボラ", "", "合計5匹"],
      ["ハゼ", "", "合計6匹"],
      ["カタボシイワシ", "", "合計100匹"],
      ["クロダイ", "", "合計7匹"],
      ["カイズ", "", "合計8匹"],
      ["キビレ", "", "合計9匹"]
    ] }), "29001");
    const report = buildIchiharaFixedNodeReport(source, "fixture-run");
    expect(Object.fromEntries(report.species.map((row) => [row.speciesId, row.catchCount]))).toMatchObject({
      sappa: 1, konoshiro: 2, aji: 3, saba: 4, bora: 5, haze: 6, sardine: 0
    });
    expect(source.unsupportedRows.map((row) => row.sourceName)).toEqual(["カタボシイワシ", "クロダイ", "カイズ", "キビレ"]);
  });

  it("creates omitted-species zero only for a trustworthy complete final report", () => {
    const report = buildIchiharaFixedNodeReport(parse(detail({ rows: [["アジ", "", "合計10匹"]] }), "29001"), "fixture-run");
    expect(report.species).toHaveLength(8);
    expect(species(report, "japanese-seabass")).toMatchObject({ catchCount: 0, presenceState: "absent", aliasCoverage: "sufficient" });
    expect(report.species.map((row) => row.speciesId)).toEqual([...report.species.map((row) => row.speciesId)].sort((a, b) => a.localeCompare(b)));
  });

  it("keeps omitted species unknown for blank-count rows and keeps missing visitors null", () => {
    const source = parse(detail({
      visitorText: "本日もありがとうございました。",
      rows: [["アジ", "", "合計10匹"], ["ボラの大群", "", ""]]
    }), "29001");
    const report = buildIchiharaFixedNodeReport(source, "fixture-run");
    expect(source.visitors).toBeNull();
    expect(report).toMatchObject({ visitorCount: null, reportCompleteness: "incomplete" });
    expect(species(report, "japanese-seabass")).toMatchObject({ catchCount: null, presenceState: "unknown", aliasCoverage: "unknown" });
    expect(species(report, "bora")).toMatchObject({ catchCount: null, presenceState: "unknown" });
  });

  it("never manufactures biological zeroes for a full closure", () => {
    const source = parse(detail({
      narrative: "荒天のため本日の営業は中止とし、臨時休館いたします。",
      visitorText: "",
      rows: [["大荒れの海", "", ""]]
    }), "29002");
    const report = buildIchiharaFixedNodeReport(source, "fixture-run");
    expect(report.species).toHaveLength(8);
    expect(report.species.every((row) => row.catchCount === null && row.presenceState === "unknown")).toBe(true);
  });

  it("uses existing semantic hashing for idempotency and revisions", async () => {
    const firstSource = parse(detail({ rows: [["セイゴ", "", "合計3匹"]] }), "29001", COLLECTED_AT);
    const laterSource = parse(detail({ rows: [["セイゴ", "", "合計3匹"]] }), "29001", "2026-08-21T09:00:00.000Z");
    const revisedSource = parse(detail({ rows: [["セイゴ", "", "合計4匹"]] }), "29001", COLLECTED_AT);
    const first = await materializeFixedNodeDailyReport(buildIchiharaFixedNodeReport(firstSource, "run-1"), COLLECTED_AT);
    const retry = await materializeFixedNodeDailyReport(buildIchiharaFixedNodeReport(laterSource, "run-2"), "2026-08-21T09:00:00.000Z");
    const revision = await materializeFixedNodeDailyReport(buildIchiharaFixedNodeReport(revisedSource, "run-1"), COLLECTED_AT);
    expect(retry.reportId).toBe(first.reportId);
    expect(retry.versionKey).toBe(first.versionKey);
    expect(revision.identityKey).toBe(first.identityKey);
    expect(revision.reportId).not.toBe(first.reportId);
  });
});

describe("Wanoku Ichihara Fixed-Node Collector v1 persistence and route", () => {
  it("persists through source_runs and the atomic fixed-node path, then retries idempotently", async () => {
    const db = new FixedNodeD1();
    const entries = new Map([["29001", detail({ rows: [["セイゴ", "", "合計3匹"]] })]]);
    const first = await runCollector(db, entries);
    const retry = await runCollector(db, entries);
    expect(first).toMatchObject({ reportsCreated: 1, speciesRowsCreated: 8, failed: 0 });
    expect(retry).toMatchObject({ reportsExisting: 1, speciesRowsExisting: 8, failed: 0 });
    expect(db.sourceRuns).toHaveLength(1);
    expect(db.reportRows).toHaveLength(1);
    expect(db.speciesRows).toHaveLength(8);
  });

  it("checks admin authorization before body read, source fetch, or D1 access", async () => {
    const text = vi.fn(async () => "{}");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const db = new FixedNodeD1();
    const response = await worker.fetch({
      method: "POST",
      url: "https://worker.test/admin/collect-fixed-node-ichihara",
      headers: new Headers({ "content-type": "application/json" }),
      text
    }, { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db });
    expect(response.status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.prepared).toHaveLength(0);
  });

  it("accepts only an empty authenticated body and returns a sanitized summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(COLLECTED_AT));
    const db = new FixedNodeD1();
    const fixture = sourceFetch(new Map([["29001", detail({ rows: [["セイゴ", "", "合計3匹"]] })]]));
    vi.stubGlobal("fetch", fixture.fetchImpl);
    const response = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-ichihara", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: "{}"
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ reportsCreated: 1, speciesRowsCreated: 8, failed: 0, remoteReads: 2 });
    expect(JSON.stringify(payload)).not.toContain(ADMIN_SECRET);
    expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);

    const rejectedFetch = vi.fn();
    vi.stubGlobal("fetch", rejectedFetch);
    const rejected = await worker.fetch(new Request("https://worker.test/admin/collect-fixed-node-ichihara", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_SECRET}` },
      body: JSON.stringify({ sourceUrl: "https://example.com" })
    }), { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: new FixedNodeD1() });
    expect(rejected.status).toBe(400);
    expect(rejectedFetch).not.toHaveBeenCalled();
  });

  it("fails closed without persistence when the newest detail has unknown finality", async () => {
    const db = new FixedNodeD1();
    const fixture = sourceFetch(new Map([["29001", detail({ rows: [["アジ・サバ", "", "合計2匹"]] })]]));
    await expect(collectIchiharaFixedNode({
      db,
      requestedAt: COLLECTED_AT,
      collectedAt: COLLECTED_AT,
      storedAt: COLLECTED_AT,
      fetchImpl: fixture.fetchImpl
    })).rejects.toMatchObject({ code: "ichihara_finality_unknown" });
    expect(db.sourceRuns).toHaveLength(0);
    expect(db.reportRows).toHaveLength(0);
    expect(db.speciesRows).toHaveLength(0);
  });

  it("contains no remote operator, direct mutation path, dependency, or non-GET source request", () => {
    const source = readFileSync("workers/wanoku-intel-worker/src/ichihara-fixed-node-collector.js", "utf8");
    expect(source).not.toMatch(/--remote|wrangler|INSERT\s+OR|REPLACE\s+INTO|\bUPDATE\b|\bDELETE\b|method:\s*["']POST["']/iu);
    expect(source).toContain('method: "GET"');
  });
});

function parse(html, id, collectedAt = COLLECTED_AT) {
  return parseIchiharaDetail({ html, sourceUrl: `${ICHIHARA_FIXED_NODE_ARCHIVE_URL}${id}/`, collectedAt });
}

function species(report, speciesId) {
  return report.species.find((row) => row.speciesId === speciesId);
}

function archive(entries = [["2026-08-19", "29001"]]) {
  return entries.map(([date, id]) => {
    const [year, month, day] = date.split("-");
    return `<article><p class="font-bold text-sm">${year}年${month}月${day}日(水)</p><a href="/fishing/${id}/">釣れた魚の詳細を見る</a></article>`;
  }).join("\n");
}

function detail({
  date = "2026-08-19",
  narrative = "本日もご来場ありがとうございました。",
  visitorText = "本日の入場者数は123名様でした。",
  rows = [["セイゴ", "20～30cm", "合計3匹"]]
} = {}) {
  const [year, month, day] = date.split("-");
  return `<main><p class="font-bold text-sm">${year}年${month}月${day}日(水)</p><p>${narrative}</p><p>${visitorText}</p>${rows.map(row).join("\n")}</main>`;
}

function row([label, size, count]) {
  return `<div class="flex border-b border-gray-300"><div><span>${label}</span></div><div><p>${size}</p></div><div><p>${count}</p></div></div>`;
}

function sourceFetch(entries, listing = [["2026-08-19", "29001"]]) {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init?.method });
    if (url.href === ICHIHARA_FIXED_NODE_ARCHIVE_URL) return response(archive(listing));
    const id = /\/fishing\/(\d+)\/$/u.exec(url.pathname)?.[1];
    if (id && entries.has(id)) return response(entries.get(id));
    return response("not found", 404);
  });
  return { fetchImpl, calls };
}

async function runCollector(db, entries) {
  return collectIchiharaFixedNode({
    db,
    requestedAt: COLLECTED_AT,
    collectedAt: COLLECTED_AT,
    storedAt: COLLECTED_AT,
    fetchImpl: sourceFetch(entries).fetchImpl
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
    const snapshot = structuredClone({ sourceRuns: this.sourceRuns, reportRows: this.reportRows, speciesRows: this.speciesRows });
    try {
      return await Promise.all(boundStatements.map((bound) => this.execute(bound._statement, "run")));
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
      return { facility_id: "ichihara-original-maker", provider_id: "ichihara-umizuri", provider_facility_key: "original-maker" };
    }
    if (sql.startsWith("SELECT id, provider") && sql.includes("FROM source_runs")) {
      return this.sourceRuns.find((row) => row.id === params[0]) ?? null;
    }
    if (sql.startsWith("INSERT INTO source_runs")) {
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
      const rowValue = Object.fromEntries(REPORT_COLUMNS.map((column, index) => [column, params[index]]));
      this.reportRows.push(rowValue);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO fixed_node_species_observations")) {
      this.speciesRows.push(Object.fromEntries(SPECIES_COLUMNS.map((column, index) => [column, params[index]])));
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unsupported fake D1 ${mode}: ${sql}`);
  }
}
