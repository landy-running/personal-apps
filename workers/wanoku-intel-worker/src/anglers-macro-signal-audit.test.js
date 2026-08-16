import { describe, expect, it, vi } from "vitest";
import {
  ANGLERS_AREAS,
  ANGLERS_MACRO_SIGNAL_AUDIT_VERSION,
  ANGLERS_READ_SOURCES,
  aggregateMacroSignals,
  anonymizeReporterId,
  buildAnglersMacroSignalAudit,
  buildAreaStableId,
  normalizeAnglersReadUrl,
  normalizeCatchCount,
  normalizeJstDateToUtcDay,
  normalizeJstMinuteToUtc,
  parseAnglersAreaPage,
  parseAnglersFishingDetailPage,
  parseAnglersFishingListPage,
  parseAnglersMacroSignalAuditArgs,
  runAnglersMacroSignalAudit
} from "../../../scripts/wanoku-anglers-macro-signal-audit.mjs";

const COLLECTED_AT = "2026-08-17T03:00:00.000Z";

describe("Wanoku ANGLERS Macro Signal Audit v1", () => {
  it("uses numeric ANGLERS area ID as the stable area identity", () => {
    const area = ANGLERS_AREAS.find((entry) => entry.areaId === "1261");
    expect(area).toMatchObject({
      stableAreaId: "anglers-area:1261",
      displayName: "旧江戸川",
      wanokuSpatialLevel: "MULTI_SEGMENT"
    });
    expect(buildAreaStableId("1261")).toBe("anglers-area:1261");
  });

  it("parses area pagination and public source summary without adopting private APIs", () => {
    const parsed = parseAnglersAreaPage(areaHtml(), {
      url: "https://anglers.jp/areas/550",
      collectedAt: COLLECTED_AT
    });
    expect(parsed).toMatchObject({
      areaId: "550",
      displayName: "東京湾湾奥",
      totalPublicPosts: 241815,
      speciesCount: 78,
      childAreaCount: 15,
      latestPostDate: "2026-08-16",
      oldestVisibleMonth: "2021-08",
      publicReporterVisible: true
    });
    expect(parsed.pagination).toEqual({ visible: true, pages: [2, 5] });
  });

  it("keeps fishing event time distinct from publication time", () => {
    const parsed = parseAnglersFishingListPage(fishingListHtml(), {
      url: "https://anglers.jp/areas/1261/fishings"
    });
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: "fishing:5462856",
      eventTimeSemantics: "source-displayed-fishing-time",
      postPublicationAt: null,
      postPublicationSemantics: "not-visible-on-list"
    });
    expect(parsed.records[0].eventStartAt).toBe("2026-08-15T09:16:00.000Z");
  });

  it("normalizes explicit JST dates and minutes without locale dependence", () => {
    expect(normalizeJstDateToUtcDay("2026-08-15")).toBe("2026-08-15T00:00:00.000+09:00");
    expect(normalizeJstMinuteToUtc("2026-08-15T18:16")).toBe("2026-08-15T09:16:00.000Z");
  });

  it("uses only exact numeric catch counts", () => {
    expect(normalizeCatchCount("3")).toEqual({ count: 3, known: true, positivePresence: true });
    expect(normalizeCatchCount("0")).toEqual({ count: 0, known: true, positivePresence: false });
    expect(normalizeCatchCount("匹数不明")).toEqual({ count: null, known: false, positivePresence: false });
  });

  it("treats nonnumeric positive language as presence, not invented catch count", () => {
    expect(normalizeCatchCount("シーバスが釣れた")).toEqual({ count: null, known: false, positivePresence: true });
    const [row] = aggregateMacroSignals([{
      areaId: "1261",
      date: "2026-08-15",
      species: "seabass",
      positivePresence: true,
      explicitCatchCount: null,
      reporterPublicId: "public-user-a",
      sourceRecordId: "fishing:1"
    }]);
    expect(row).toMatchObject({
      postCount: 1,
      positivePresencePosts: 1,
      explicitCatchCountSum: null,
      explicitCatchCountKnownPosts: 0
    });
  });

  it("keeps no-post days as NO_OBSERVATION rather than zero catch", () => {
    expect(aggregateMacroSignals([{ noObservation: true, areaId: "1261", date: "2026-08-15", species: "seabass" }])).toEqual([]);
    const audit = buildAnglersMacroSignalAudit({ collectedAt: COLLECTED_AT, probes: [] });
    expect(audit.historicalDepth.caveat).toContain("NO_OBSERVATION");
  });

  it("aggregates unique reporters with anonymized stable keys only", () => {
    const rows = aggregateMacroSignals([
      record({ sourceRecordId: "fishing:1", reporterPublicId: "same-public-profile", explicitCatchCount: 2 }),
      record({ sourceRecordId: "fishing:2", reporterPublicId: "same-public-profile", explicitCatchCount: null }),
      record({ sourceRecordId: "fishing:3", reporterPublicId: "other-public-profile", explicitCatchCount: 1 })
    ]);
    expect(rows[0]).toMatchObject({
      postCount: 3,
      uniqueReporterCount: 2,
      explicitCatchCountSum: 3,
      explicitCatchCountKnownPosts: 2
    });
    expect(anonymizeReporterId("same-public-profile")).toMatch(/^public-reporter-sha256:[a-f0-9]{24}$/u);
  });

  it("deduplicates duplicate public record identities inside aggregate samples", () => {
    const rows = aggregateMacroSignals([
      record({ sourceRecordId: "fishing:1", explicitCatchCount: 2 }),
      record({ sourceRecordId: "fishing:1", explicitCatchCount: 2 })
    ]);
    expect(rows[0]).toMatchObject({ postCount: 1, explicitCatchCountSum: 2 });
  });

  it("keeps bait species macro signals isolated from seabass", () => {
    const rows = aggregateMacroSignals([
      record({ sourceRecordId: "fishing:1", species: "seabass", explicitCatchCount: 1 }),
      record({ sourceRecordId: "fishing:2", species: "konoshiro", explicitCatchCount: 8 })
    ]);
    expect(rows.find((row) => row.species === "seabass")).toMatchObject({ explicitCatchCountSum: 1 });
    expect(rows.find((row) => row.species === "konoshiro")).toMatchObject({ explicitCatchCountSum: 8 });
  });

  it("parses public fishing detail sizes as candidate size/cohort coverage only", () => {
    const parsed = parseAnglersFishingDetailPage(fishingDetailHtml(), {
      url: "https://anglers.jp/fishings/5462856"
    });
    expect(parsed).toMatchObject({
      sourceRecordId: "fishing:5462856",
      eventStartAt: "2026-08-15T09:16:00.000Z",
      species: "seabass",
      explicitCatchCount: 2
    });
    expect(parsed.sizeCmValues).toEqual([72, 55.5]);
  });

  it("keeps multi-segment areas multi-segment", () => {
    const kyuEdogawa = buildAnglersMacroSignalAudit({ collectedAt: COLLECTED_AT, probes: [] }).areasAudited.find((entry) => entry.anglersAreaId === "1261");
    expect(kyuEdogawa).toMatchObject({
      wanokuSpatialLevel: "MULTI_SEGMENT",
      wanokuSpatialIds: ["KED-0", "KED-1", "KED-2", "KED-3"]
    });
  });

  it("leaves unresolved river areas unmappable", () => {
    const mamagawa = buildAnglersMacroSignalAudit({ collectedAt: COLLECTED_AT, probes: [] }).areasAudited.find((entry) => entry.anglersAreaId === "mamagawa-unresolved");
    expect(mamagawa).toMatchObject({ wanokuSpatialLevel: "UNMAPPABLE", wanokuSpatialIds: [] });
  });

  it("does not emit public reporter names or profile text into the audit artifact", () => {
    const audit = buildAnglersMacroSignalAudit({
      collectedAt: COLLECTED_AT,
      probes: [{
        sourceId: "area-tokyo-inner-bay",
        kind: "coastal-representative",
        url: "https://anglers.jp/areas/550",
        ok: true,
        status: 200,
        jsChallenge: false,
        markersFound: ["東京湾湾奥", "釣果投稿"],
        areaSummary: parseAnglersAreaPage(areaHtml(), { url: "https://anglers.jp/areas/550", collectedAt: COLLECTED_AT })
      }]
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("湾奥のハングラー");
    expect(serialized).not.toContain("same-public-profile");
    expect(audit.privacyHandling.artifactContainsPii).toBe(false);
  });

  it("enforces read-only execution and never builds Authorization headers", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, method: init?.method, authorization: init?.headers?.authorization });
      return response(areaHtml());
    });
    const report = await runAnglersMacroSignalAudit({
      collectedAt: COLLECTED_AT,
      delayMs: 0,
      sources: [ANGLERS_READ_SOURCES.find((entry) => entry.sourceId === "area-tokyo-inner-bay")],
      fetchImpl
    });
    expect(calls).toEqual([{ url: "https://anglers.jp/areas/550", method: "GET", authorization: undefined }]);
    expect(report.remoteReads.total).toBe(1);
    expect(report.remoteWrites).toBe(0);
    expect(() => parseAnglersMacroSignalAuditArgs(["--apply"])).toThrow("Unknown option");
  });

  it("rejects every source outside the fixed ANGLERS allowlist", () => {
    expect(normalizeAnglersReadUrl("https://anglers.jp/areas/550")).toBe("https://anglers.jp/areas/550");
    expect(() => normalizeAnglersReadUrl("https://example.com/areas/550")).toThrow("https://anglers.jp");
    expect(() => normalizeAnglersReadUrl("https://anglers.jp/fishings/5462856")).toThrow("not in the ANGLERS audit allowlist");
  });

  it("builds deterministic audit output with permission-required verdict", () => {
    const input = { collectedAt: COLLECTED_AT, probes: [] };
    const left = buildAnglersMacroSignalAudit(input);
    const right = buildAnglersMacroSignalAudit(input);
    expect(left).toEqual(right);
    expect(left.schemaVersion).toBe(ANGLERS_MACRO_SIGNAL_AUDIT_VERSION);
    expect(left.finalVerdict).toBe("ANGLERS_PERMISSION_REQUIRED");
    expect(left.source.sustainabilityClass).toBe("C PERMISSION_REQUIRED");
  });
});

function record(overrides = {}) {
  return {
    areaId: "1261",
    date: "2026-08-15",
    species: "seabass",
    positivePresence: true,
    explicitCatchCount: 1,
    reporterPublicId: "reporter-a",
    sourceRecordId: "fishing:base",
    sizeCmValues: [],
    ...overrides
  };
}

function areaHtml() {
  return `
    <html>
      <title>東京湾湾奥の釣果・釣り場情報</title>
      <body>
        <h1>東京湾湾奥の釣果・釣り場情報</h1>
        <a>241815 釣果投稿</a>
        <a>78 魚の種類</a>
        <a>15 釣り場</a>
        最近１ヶ月は シーバス 、 ハゼ 、 イワシ が釣れています！
        最新投稿は2026年08月16日(日)の湾奥のハングラーの釣果です。
        <h2>東京湾湾奥の釣行記</h2>
        <h5>2026年08月</h5>
        <a href="/fishings/5462856">16日(日) 〖9‡船橋港親水公園〗 18:28〜18:28 1投稿 湾奥のハングラー さんの釣行</a>
        <a href="/areas/550/fishings?page=2">2</a>
        <a href="/areas/550/fishings?page=5">5</a>
        <h2>昔の東京湾湾奥の釣行記</h2>
        <h5>2021年08月</h5>
        <a href="/fishings/100">18日(水) 〖86‡東京湾湾奥〗 21:40〜21:40 1投稿 old user さんの釣行</a>
        <h2>東京湾湾奥での最近の釣り人</h2>
        <a>湾奥のハングラー 公開釣果 953 年間釣行 98</a>
      </body>
    </html>`;
}

function fishingListHtml() {
  return `
    <html>
      <body>
        <h1>旧江戸川の釣行</h1>
        <h3>2026年08月</h3>
        <a href="/fishings/5462856">15日(土) 〖9‡旧江戸川河口〗 18:16〜19:30 2投稿 public-reporter-a さんの釣行</a>
        <a href="/areas/1261/fishings?page=2">2</a>
      </body>
    </html>`;
}

function fishingDetailHtml() {
  return `
    <html>
      <body>
        <h2>釣行の概要</h2>
        釣り人 public-reporter-a
        日時 2026年08月15日(土) 18:16〜19:30
        釣果投稿 2 釣果
        釣った魚
        シーバス
        天気 28.0℃ 東南東 5.0m/s
        <h2>釣行の内容</h2>
        18:16 シーバス 72.0cm
        19:30 セイゴ 55.5cm
      </body>
    </html>`;
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-type" ? "text/html; charset=utf-8" : null },
    text: async () => body
  };
}
