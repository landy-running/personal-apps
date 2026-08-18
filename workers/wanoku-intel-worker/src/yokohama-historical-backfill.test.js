import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  YOKOHAMA_BACKFILL_CANARY_DATE,
  YOKOHAMA_BACKFILL_END_DATE,
  YOKOHAMA_BACKFILL_START_DATE,
  buildMonthImportPlan,
  generateYokohamaHistoricalBackfillPlan,
  runYokohamaHistoricalBackfill,
  yokohamaBackfillDates
} from "../../../scripts/wanoku-yokohama-historical-backfill.mjs";

const COLLECTED_AT = "2026-08-17T06:00:00.000Z";
const LATER_COLLECTED_AT = "2026-08-17T07:00:00.000Z";
const APPSYNC_ENDPOINT = "https://backfillfixture.appsync-api.ap-northeast-1.amazonaws.com/graphql";
const ROOT_URL = "https://yokohama-fishingpiers.jp/";
const BUNDLE_URL = "https://yokohama-fishingpiers.jp/assets/index-abcdef12.js";
const FACILITIES = ["honmoku", "daikoku", "isogo"];
const EXPECTED_RECORDS = { honmoku: 342, daikoku: 342, isogo: 346 };
let generated;
let fixture;

beforeAll(async () => {
  fixture = sourceFixture();
  generated = await generateYokohamaHistoricalBackfillPlan({
    fetchImpl: fixture.fetchImpl,
    delayMs: 0,
    collectedAtByMonth: collectedAtByMonth(COLLECTED_AT)
  });
}, 30_000);

describe("Wanoku Yokohama Historical Backfill Planner/Generator v1", () => {
  it("covers the exact inclusive 350-day range", () => {
    const dates = yokohamaBackfillDates();
    expect(dates).toHaveLength(350);
    expect(dates[0]).toBe(YOKOHAMA_BACKFILL_START_DATE);
    expect(dates.at(-1)).toBe(YOKOHAMA_BACKFILL_END_DATE);
  });

  it("fetches root and bundle once plus each facility/month once", () => {
    expect(generated.summary.sourceReads).toBe(38);
    expect(fixture.calls).toHaveLength(38);
    expect(fixture.calls.every((call) => call.method === "GET")).toBe(true);
    expect(fixture.calls.filter((call) => call.url === ROOT_URL)).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.url === BUNDLE_URL)).toHaveLength(1);
  });

  it("parses all three historical facilities with stable source UUIDs", () => {
    for (const [sourceKey, facilityId] of [
      ["honmoku", "yokohama-honmoku"],
      ["daikoku", "yokohama-daikoku"],
      ["isogo", "yokohama-isogo"]
    ]) {
      const record = generated.envelopes.find((item) => item.report.facilityId === facilityId);
      expect(record.report.sourceRecordId).toMatch(new RegExp(`^last-post:uuid-${sourceKey}-`));
      expect(record.report.providerId).toBe("yokohama-fishing-piers");
    }
  });

  it("classifies complete reports", () => {
    expect(generated.classifications.some((item) => item.status === "REPORT_COMPLETE")).toBe(true);
  });

  it("classifies missing source records without creating reports", () => {
    const missing = generated.classifications.filter((item) => item.status === "MISSING_SOURCE_RECORD");
    expect(missing).toHaveLength(20);
    expect(missing.every((item) => !generated.envelopes.some((record) => record.report.facilityId === item.facilityId && record.report.observationDate === item.observationDate))).toBe(true);
  });

  it("keeps closed reports distinct from zero", () => {
    const closed = generated.envelopes.find((item) => item.classification === "CLOSED");
    expect(closed.report.operatingStatus).toBe("closed");
    expect(closed.report.species.every((row) => row.catchCount === null && row.presenceState === "unknown")).toBe(true);
  });

  it("keeps incomplete reports distinct from zero", () => {
    const incomplete = generated.envelopes.find((item) => item.classification === "REPORT_INCOMPLETE");
    expect(incomplete.report.reportCompleteness).toBe("incomplete");
    expect(incomplete.report.species.every((row) => row.catchCount === null && row.presenceState === "unknown")).toBe(true);
  });

  it("creates explicit seabass zero only on complete operating reports", () => {
    const zero = generated.envelopes.find((item) => item.classification === "REPORT_COMPLETE" && species(item, "japanese-seabass").catchCount === 0);
    expect(zero.report.operatingStatus).toBe("operating");
    expect(zero.report.reportCompleteness).toBe("complete");
    expect(species(zero, "japanese-seabass")).toMatchObject({ catchCount: 0, presenceState: "absent", aliasCoverage: "sufficient" });
  });

  it("keeps bait species normalized independently", () => {
    const report = generated.envelopes.find((item) => species(item, "aji").catchCount > 0);
    expect(species(report, "aji").catchCount).toBeGreaterThan(0);
    expect(species(report, "konoshiro").catchCount).toBeGreaterThan(0);
    expect(species(report, "aji").sourceLabels).toEqual(["アジ"]);
  });

  it("uses the existing report identity and creates no duplicate identities", () => {
    const identities = generated.envelopes.map((item) => item.materialized.identityKey);
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities.every((value) => value.startsWith('["yokohama-fishing-piers"'))).toBe(true);
  });

  it("does not use historical event or publication time as collectedAt", () => {
    expect(generated.envelopes.every((item) => item.report.collectedAt === COLLECTED_AT)).toBe(true);
    expect(generated.envelopes.every((item) => item.report.collectedAt !== item.report.publishedAt)).toBe(true);
    expect(generated.envelopes.every((item) => !item.report.collectedAt.startsWith(item.report.observationDate))).toBe(true);
  });

  it("keeps semantic IDs stable when only collectedAt and sourceRunId change", async () => {
    const second = await generateYokohamaHistoricalBackfillPlan({
      fetchImpl: sourceFixture().fetchImpl,
      delayMs: 0,
      collectedAtByMonth: collectedAtByMonth(LATER_COLLECTED_AT)
    });
    expect(second.envelopes.map((item) => item.materialized.reportId)).toEqual(generated.envelopes.map((item) => item.materialized.reportId));
    expect(second.envelopes.map((item) => item.materialized.versionKey)).toEqual(generated.envelopes.map((item) => item.materialized.versionKey));
  }, 30_000);

  it("marks the three 2026-08-16 reports and 24 species as existing overlap", () => {
    expect(generated.summary.existingOverlapReports).toBe(3);
    expect(generated.summary.existingOverlapSpecies).toBe(24);
    expect(generated.summary.semanticRevisionsExpected).toBe(0);
    expect(generated.envelopes.filter((item) => item.report.observationDate === YOKOHAMA_BACKFILL_CANARY_DATE)).toHaveLength(3);
  });

  it("excludes canary rows from monthly import SQL", () => {
    const august = generated.monthPlans.find((item) => item.sourceMonth === "2026-08");
    expect(august.sql).not.toContain("2026-08-16");
    expect(august.reportsToCreate).toBe(generated.envelopes.filter((item) => item.sourceMonth === "2026-08").length - 3);
  });

  it("excludes the canary date from generated SQL independent of the plan's endDate", () => {
    const augustEnvelopes = generated.envelopes.filter((item) => item.sourceMonth === "2026-08");
    const augustSourceRun = generated.sourceRuns.find((run) => run.id.includes(":2026-08:"));
    const plan = buildMonthImportPlan("2026-08", augustSourceRun, augustEnvelopes);
    expect(plan.sql).not.toContain("2026-08-16");
    expect(plan.reportsToCreate).toBe(augustEnvelopes.length - 3);
  });

  it("uses 12 monthly source runs rather than daily synthetic runs", () => {
    expect(generated.sourceRuns).toHaveLength(12);
    expect(generated.sourceRuns.every((run) => run.requestedAt === COLLECTED_AT && run.completedAt === COLLECTED_AT)).toBe(true);
  });

  it("keeps historical rows invisible before acquisition and visible afterwards", () => {
    const row = generated.envelopes.find((item) => item.report.observationDate.startsWith("2025-"));
    expect(row.report.publishedAt < "2025-12-31T23:59:59.999Z").toBe(true);
    expect(row.report.collectedAt > "2025-12-31T23:59:59.999Z").toBe(true);
    expect(row.report.collectedAt <= "2026-08-18T00:00:00.000Z").toBe(true);
  });

  it("reconciles exact Audit continuity for all facilities", () => {
    expect(Object.fromEntries(generated.summary.facilitySummary.map((item) => [item.facilityId, item.recordsFound]))).toEqual({
      "yokohama-daikoku": 342,
      "yokohama-honmoku": 342,
      "yokohama-isogo": 346
    });
    expect(generated.summary.facilitySummary.every((item) => item.auditDelta === 0)).toBe(true);
  });

  it("generates canonical report and species counts from live-plan semantics", () => {
    expect(generated.summary.canonicalReports).toBe(1030);
    expect(generated.summary.canonicalSpecies).toBe(8240);
    expect(generated.summary.reportsToCreate).toBe(1027);
    expect(generated.summary.speciesToCreate).toBe(8216);
  });

  it("generates only plain INSERT month chunks", () => {
    const sql = generated.monthPlans.map((item) => item.sql).join("\n");
    expect(sql).toContain("INSERT INTO source_runs");
    expect(sql).toContain("INSERT INTO fixed_node_daily_reports");
    expect(sql).toContain("INSERT INTO fixed_node_species_observations");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|REPLACE|DROP|ALTER|BEGIN|COMMIT|SAVEPOINT)\b/iu);
    expect(sql).not.toMatch(/INSERT\s+OR\s+(?:IGNORE|REPLACE)/iu);
    expect(generated.summary.maxSqlStatementBytes).toBeLessThan(100_000);
  });

  it("writes summary, canonical, validation, plan, and 12 SQL artifacts", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "wanoku-yokohama-plan-"));
    try {
      await runYokohamaHistoricalBackfill({
        outputDir,
        fetchImpl: sourceFixture().fetchImpl,
        delayMs: 0,
        collectedAtByMonth: collectedAtByMonth(COLLECTED_AT)
      });
      for (const name of ["summary.json", "canonical.ndjson", "validation.json", "import-plan.json"]) {
        expect(existsSync(path.join(outputDir, name))).toBe(true);
      }
      expect(readFileSync(path.join(outputDir, "canonical.ndjson"), "utf8").trim().split("\n")).toHaveLength(1030);
      expect(existsSync(path.join(outputDir, "sql", "2025-09.sql"))).toBe(true);
      expect(existsSync(path.join(outputDir, "sql", "2026-08.sql"))).toBe(true);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function species(envelope, speciesId) {
  return envelope.report.species.find((row) => row.speciesId === speciesId);
}

function collectedAtByMonth(value) {
  return Object.fromEntries(unique(yokohamaBackfillDates().map((date) => date.slice(0, 7))).map((month) => [month, value]));
}

function sourceFixture() {
  const calls = [];
  const records = fixtureRecords();
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: init?.method });
    if (url.href === ROOT_URL) return response('<script type="module" src="/assets/index-abcdef12.js"></script>');
    if (url.href === BUNDLE_URL) return response(`const config={aws_appsync_graphqlEndpoint:"${APPSYNC_ENDPOINT}",aws_appsync_authenticationType:"API_KEY",aws_appsync_apiKey:"fixture-public-read-key"};`);
    const variables = JSON.parse(url.searchParams.get("variables"));
    const key = `${variables.facility.eq}:${variables.month.replace("/", "-")}`;
    return response(JSON.stringify({ data: { lastPostsByMonthAndFacility: { items: records.get(key) ?? [], nextToken: null } } }));
  };
  return { fetchImpl, calls };
}

function fixtureRecords() {
  const dates = yokohamaBackfillDates();
  const missing = {
    honmoku: new Set(dates.slice(0, 8)),
    daikoku: new Set(dates.slice(8, 16)),
    isogo: new Set(dates.slice(16, 20))
  };
  const map = new Map();
  for (const facility of FACILITIES) {
    const kept = dates.filter((date) => !missing[facility].has(date));
    EXPECTED_RECORDS[facility] = kept.length;
    for (const [index, date] of kept.entries()) {
      const month = date.slice(0, 7);
      const key = `${facility}:${month}`;
      const kind = index === 0 ? "closed" : index === 1 ? "incomplete" : "complete";
      const record = sourceItem(facility, date, kind, index);
      map.set(key, [...(map.get(key) ?? []), record]);
    }
  }
  return map;
}

function sourceItem(facility, date, kind, index) {
  const slashDate = date.replace(/-/gu, "/");
  const value = {
    id: `uuid-${facility}-${date.replace(/-/gu, "")}`,
    date: slashDate,
    month: slashDate.slice(0, 7),
    facility,
    sentence: kind === "closed" ? "強風のため臨時休業" : "通常営業しました。",
    weather: "晴れ",
    waterTemp: 24,
    tide: "中潮",
    visitors: kind === "closed" ? 0 : 100 + (index % 50),
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`
  };
  for (let slot = 1; slot <= 30; slot += 1) {
    value[`fish${slot}Name`] = null;
    value[`fish${slot}MinSize`] = null;
    value[`fish${slot}MaxSize`] = null;
    value[`fish${slot}Unit`] = null;
    value[`fish${slot}Count`] = null;
    value[`fish${slot}Place`] = null;
  }
  if (kind !== "closed") {
    Object.assign(value, {
      fish1Name: "アジ", fish1Count: kind === "incomplete" ? null : 10 + (index % 5), fish1Place: ["中央桟橋"],
      fish2Name: "コノシロ", fish2Count: kind === "incomplete" ? null : 20 + (index % 7), fish2Place: ["中央桟橋"]
    });
    if (kind === "complete" && index % 3 === 0) {
      Object.assign(value, { fish3Name: "セイゴ", fish3Count: 2, fish3MinSize: 30, fish3MaxSize: 40, fish3Unit: "cm", fish3Place: ["東桟橋"] });
    }
  }
  return value;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}
