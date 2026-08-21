import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ICHIHARA_BACKFILL_SCHEMA_VERSION,
  IchiharaHistoricalBackfillError,
  parseIchiharaBackfillArgs,
  runIchiharaHistoricalBackfill
} from "../../../scripts/wanoku-ichihara-fixed-node-backfill.mjs";

const START = "2025-09-30";
const END = "2025-10-03";
const CLOCK = "2026-08-21T00:00:00.000Z";
const outputs = [];

afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

describe("Wanoku Ichihara historical backfill", () => {
  it("parses the safe low-rate CLI and rejects unsafe delay values", () => {
    expect(parseIchiharaBackfillArgs([])).toMatchObject({ delayMs: 400, offline: false });
    expect(parseIchiharaBackfillArgs(["--offline", "--delay-ms", "300"])).toMatchObject({ delayMs: 300, offline: true });
    expect(() => parseIchiharaBackfillArgs(["--delay-ms", "299"])).toThrow(IchiharaHistoricalBackfillError);
  });

  it("acquires sequential official-shaped artifacts and generates two monthly import files", async () => {
    const fixture = sourceFixture();
    const result = await runFixture(fixture);
    expect(fixture.maxActive).toBe(1);
    expect(result.summary).toMatchObject({
      firstObservationDate: "2025-09-30",
      lastObservationDate: "2025-10-02",
      reportCount: 3,
      speciesCount: 24,
      sourceRunCount: 2,
      closedCount: 1,
      interruptedCount: 1,
      incompleteCount: 2
    });
    expect(result.summary.missingCalendarDates).toEqual(["2025-10-03"]);
    expect(result.importFiles.map((item) => item.file)).toEqual(["import-2025-09.sql", "import-2025-10.sql"]);
    expect(result.manifest.schemaVersion).toBe(ICHIHARA_BACKFILL_SCHEMA_VERSION);
    expect(result.manifest.validation.logical.ok).toBe(true);
    expect(result.manifest.acquisition).toMatchObject({
      successfulArchiveGets: 2,
      successfulDetailGets: 3,
      successfulRobotsGets: 1,
      retries: 0,
      failures: 0
    });
    expect(result.acquisition.state.createdAt).toBe(CLOCK);
  });

  it("reuses frozen artifacts without any subsequent network request", async () => {
    const fixture = sourceFixture();
    const first = await runFixture(fixture);
    const callsAfterFirst = fixture.calls.length;
    const second = await runFixture({ fetchImpl: async () => { throw new Error("network must not be used"); } }, first.outputDir, true);
    expect(fixture.calls).toHaveLength(callsAfterFirst);
    expect(second.acquisition.stats.skippedCachedArtifacts).toBe(first.manifest.artifactCounts.total);
    expect(second.manifest.acquisition.successfulDetailGets).toBe(3);
    expect(second.manifest.acquisition.skippedCachedArtifacts).toBe(first.manifest.artifactCounts.total);
    expect(second.acquisition.state.completedAt).toBe(first.acquisition.state.completedAt);
    expect(second.normalizedDatasetHash).toBe(first.normalizedDatasetHash);
    expect(second.importFiles).toEqual(first.importFiles);
  });

  it("fails explicitly when a frozen raw artifact no longer matches its recorded hash", async () => {
    const first = await runFixture(sourceFixture());
    writeFileSync(path.join(first.outputDir, "raw/detail/1003.html"), "tampered", "utf8");
    await expect(runFixture({ fetchImpl: async () => { throw new Error("network must not be used"); } }, first.outputDir, true)).rejects.toMatchObject({ code: "artifact_hash_mismatch" });
  });

  it("keeps production finality and explicit-zero semantics for normal, interrupted, and closure reports", async () => {
    const result = await runFixture(sourceFixture());
    const normal = result.envelopes.find((item) => item.report.sourceRecordId === "fishing:1001");
    const interrupted = result.envelopes.find((item) => item.report.sourceRecordId === "fishing:1002");
    const closure = result.envelopes.find((item) => item.report.sourceRecordId === "fishing:1003");
    expect(normal.classification).toBe("REPORT_COMPLETE");
    expect(normal.report.species.find((row) => row.speciesId === "japanese-seabass").catchCount).toBe(9);
    expect(normal.report.species.find((row) => row.speciesId === "sardine")).toMatchObject({ catchCount: 60, sourceLabels: ["イワシ", "カタクチイワシ", "マイワシ"] });
    expect(normal.sourceFacts.unsupportedSourceLabels).toContain("カタボシイワシ");
    expect(interrupted.classification).toBe("INTERRUPTED");
    expect(interrupted.report.species.find((row) => row.speciesId === "bora")).toMatchObject({ catchCount: 4, presenceState: "present" });
    expect(interrupted.report.species.find((row) => row.speciesId === "sardine")).toMatchObject({ catchCount: null, presenceState: "unknown" });
    expect(closure.report.species.every((row) => row.catchCount === null && row.presenceState === "unknown")).toBe(true);
  });

  it("generates exact-retry-safe INSERTs in FK order and excludes the production canary date", async () => {
    const result = await runFixture(sourceFixture());
    const sql = result.monthPlans.map((item) => item.sql).join("\n");
    expect(sql.indexOf("INSERT INTO source_runs")).toBeLessThan(sql.indexOf("INSERT INTO fixed_node_daily_reports"));
    expect(sql.indexOf("INSERT INTO fixed_node_daily_reports")).toBeLessThan(sql.indexOf("INSERT INTO fixed_node_species_observations"));
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|BEGIN|COMMIT|SAVEPOINT)\b/iu);
    expect(sql).not.toMatch(/INSERT\s+OR\s+(?:IGNORE|REPLACE)/iu);
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM source_runs");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM fixed_node_daily_reports");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM fixed_node_species_observations");
    expect(sql).not.toContain("2026-08-20");
  });

  it("rejects conflicting IDs for one archive date before detail acquisition", async () => {
    const fixture = sourceFixture({ conflictDate: true });
    await expect(runFixture(fixture)).rejects.toMatchObject({ code: "duplicate_date_conflict" });
    expect(fixture.calls.some((call) => /\/fishing\/1001\/$/u.test(call.url))).toBe(false);
  });

  it("fails closed on malformed or ambiguous historical detail HTML", async () => {
    const fixture = sourceFixture({ ambiguousDetail: true });
    await expect(runFixture(fixture)).rejects.toMatchObject({ code: "historical_finality_unresolved" });
  });

  it("stops before archive acquisition when robots blocks the fishing path", async () => {
    const fixture = sourceFixture({ robots: "User-agent: *\nDisallow: /fishing/\n" });
    await expect(runFixture(fixture)).rejects.toMatchObject({ code: "robots_blocked" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("retries a transient 5xx within the bound", async () => {
    const fixture = sourceFixture({ failOnceUrl: "https://ichihara-umizuri.com/fishing/1001/" });
    const result = await runFixture(fixture);
    expect(result.acquisition.stats.retries).toBe(1);
    expect(result.manifest.acquisition.retries).toBe(1);
    expect(fixture.calls.filter((call) => call.url.endsWith("/1001/"))).toHaveLength(2);
  });

  it("materializes one source run per month with actual acquisition timestamps", async () => {
    let tick = 0;
    const result = await runFixture(sourceFixture(), undefined, false, () => new Date(Date.parse(CLOCK) + tick++ * 1000));
    expect(result.sourceRuns).toHaveLength(2);
    expect(result.sourceRuns.map((run) => run.id)).toEqual([
      expect.stringMatching(/^wanoku-fixed-node-ichihara-backfill:2025-09:/u),
      expect.stringMatching(/^wanoku-fixed-node-ichihara-backfill:2025-10:/u)
    ]);
    expect(result.envelopes.every((item) => item.report.publishedAt === null && item.report.collectedAt > item.report.observationDate)).toBe(true);
  });

  it("records unsupported label frequencies without leaking kataboshi into sardine", async () => {
    const result = await runFixture(sourceFixture());
    expect(result.summary.unsupportedLabelFrequencies).toMatchObject({ "カタボシイワシ": 1, "クロダイ": 1 });
    expect(result.validation.checks.kataboshiLeakAbsent).toBe(true);
    expect(result.envelopes.flatMap((item) => item.report.species).filter((row) => row.speciesId === "sardine").every((row) => !row.sourceLabels.includes("カタボシイワシ"))).toBe(true);
  });

  it("produces deterministic SQL and logical hashes from identical frozen inputs", async () => {
    const first = await runFixture(sourceFixture());
    const sqlBefore = first.monthPlans.map((item) => item.sql);
    const second = await runFixture({ fetchImpl: async () => { throw new Error("network must not be used"); } }, first.outputDir, true);
    expect(second.normalizedDatasetHash).toBe(first.normalizedDatasetHash);
    expect(second.rawArtifactAggregateHash).toBe(first.rawArtifactAggregateHash);
    expect(second.monthPlans.map((item) => item.sql)).toEqual(sqlBefore);
  });

  it("keeps the production import operator read-only unless Execute is explicit", () => {
    const operator = readFileSync(path.resolve("scripts/wanoku-ichihara-historical-import.ps1"), "utf8");
    const readOnlyExit = operator.indexOf("if (-not $Execute)");
    const bookmark = operator.indexOf("d1 time-travel info");
    const remoteFileImport = operator.indexOf("--remote --file");
    expect(operator).toContain("[switch]$Execute");
    expect(readOnlyExit).toBeGreaterThan(0);
    expect(bookmark).toBeGreaterThan(readOnlyExit);
    expect(remoteFileImport).toBeGreaterThan(bookmark);
    expect(operator).not.toContain("WANOKU_ADMIN_SECRET");
    expect(operator).not.toMatch(/d1\s+time-travel\s+restore/iu);
  });

  it("makes the operator verify hashes, baseline, bookmark, and post-import invariants", () => {
    const operator = readFileSync(path.resolve("scripts/wanoku-ichihara-historical-import.ps1"), "utf8");
    expect(operator).toContain("Get-FileHash -Algorithm SHA256");
    expect(operator).toContain("Pre-import Ichihara reports");
    expect(operator).toContain("pre-import-bookmark-");
    expect(operator).toContain("Post-import Ichihara reports");
    expect(operator).toContain("Post-import bad species bundles");
    expect(operator).toContain("Post-import kataboshi leaks");
  });
});

async function runFixture(fixture, outputDir, offline = false, clock = () => new Date(CLOCK)) {
  const directory = outputDir ?? mkdtempSync(path.join(tmpdir(), "wanoku-ichihara-backfill-test-"));
  if (!outputDir) outputs.push(directory);
  return runIchiharaHistoricalBackfill({
    outputDir: directory,
    startDate: START,
    endDate: END,
    delayMs: 0,
    offline,
    fetchImpl: fixture.fetchImpl,
    clock,
    skipLocalD1: true
  });
}

function sourceFixture(options = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const failures = new Set();
  const pages = new Map([
    ["https://ichihara-umizuri.com/fishing/", listing([
      ["2025-10-02", "1003"],
      ["2025-10-01", "1002"]
    ])],
    ["https://ichihara-umizuri.com/fishing/page/2/", listing([
      ["2025-09-30", "1001"],
      ["2025-09-29", options.conflictDate ? "9999" : "1000"],
      ...(options.conflictDate ? [["2025-10-01", "9998"]] : [])
    ])]
  ]);
  const details = new Map([
    ["1001", detail({
      date: "2025-09-30",
      visitor: "本日のご来場者数は５４５名様でした。",
      narrative: "1時間遅れて開園しました。本日もありがとうございました。",
      rows: [
        ["スズキ", "45cm", "合計2匹"], ["フッコ", "35cm", "合計3匹"], ["釣れた！(セイゴ)", "20cm", "合計4匹"],
        ["イワシ", "", "合計10匹"], ["マイワシ", "", "合計20匹"], ["カタクチイワシ", "", "合計30匹"],
        ["カタボシイワシ", "", "合計100匹"], ["クロダイ", "", "合計2匹"]
      ]
    })],
    ["1002", detail({ date: "2025-10-01", visitor: "本日の入園者数は24名様でした。", narrative: "14時00分を持ちまして本日の営業を中止いたします。", rows: [["ボラ", "30cm", "合計4匹"], ["ハゼ", "12cm", "合計2匹"]] })],
    ["1003", options.ambiguousDetail
      ? detail({ date: "2025-10-02", rows: [["アジ・サバ", "", "合計2匹"]] })
      : detail({ date: "2025-10-02", visitor: "", narrative: "荒天のため本日の営業は中止とし、臨時休館いたします。", rows: [["大荒れの海", "", ""]] })]
  ]);
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (options.failOnceUrl === url && !failures.has(url)) {
        failures.add(url);
        return response("temporary", 503);
      }
      if (url === "https://ichihara-umizuri.com/robots.txt") return response(options.robots ?? "User-agent: *\nDisallow: /wp-admin/\n");
      if (pages.has(url)) return response(pages.get(url));
      const id = /\/fishing\/(\d+)\/$/u.exec(new URL(url).pathname)?.[1];
      if (id && details.has(id)) return response(details.get(id));
      return response("not found", 404);
    } finally {
      active -= 1;
    }
  };
  return { fetchImpl, calls, get maxActive() { return maxActive; } };
}

function listing(entries) {
  return entries.map(([date, id]) => {
    const [year, month, day] = date.split("-");
    return `<article><p class="font-bold text-sm">${year}年${month}月${day}日(水)</p><a href="/fishing/${id}/">釣れた魚の詳細を見る</a></article>`;
  }).join("\n");
}

function detail({ date, narrative = "本日もありがとうございました。", visitor = "本日の入場者数は123名様でした。", rows }) {
  const [year, month, day] = date.split("-");
  return `<main><p class="font-bold text-sm">${year}年${month}月${day}日(水)</p><p>${narrative}</p><p>${visitor}</p>${rows.map(row).join("\n")}</main>`;
}

function row([label, size, count]) {
  return `<div class="flex border-b border-gray-300"><div><span>${label}</span></div><div><p>${size}</p></div><div><p>${count}</p></div></div>`;
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}
