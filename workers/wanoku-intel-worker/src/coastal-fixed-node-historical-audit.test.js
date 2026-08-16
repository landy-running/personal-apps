import { describe, expect, it, vi } from "vitest";
import {
  COASTAL_FIXED_NODE_AUDIT_VERSION,
  ICHIHARA_ARCHIVE_URL,
  YOKOHAMA_ROOT_URL,
  aggregateCoastalFixedNodeAudit,
  buildNormalizedSpeciesPreview,
  discoverIchiharaArchiveMonths,
  extractYokohamaReadConfig,
  parseCoastalAuditArgs,
  parseIchiharaDetail,
  parseIchiharaListingPage,
  parseYokohamaLastPost,
  runCoastalFixedNodeHistoricalAudit
} from "../../../scripts/wanoku-coastal-fixed-node-historical-audit.mjs";

const COLLECTED_AT = "2026-08-16T03:00:00.000Z";
const APPSYNC_ENDPOINT = "https://auditfixture.appsync-api.ap-northeast-1.amazonaws.com/graphql";
const BUNDLE_URL = "https://yokohama-fishingpiers.jp/assets/index-abcdef12.js";

describe("Wanoku Coastal Fixed-Node Historical Audit v1", () => {
  it("validates bounded audit-only CLI options", () => {
    expect(parseCoastalAuditArgs(["--months", "12", "--delay-ms", "0", "--collected-at", COLLECTED_AT])).toEqual({
      months: 12,
      delayMs: 0,
      collectedAt: COLLECTED_AT
    });
    expect(() => parseCoastalAuditArgs(["--months", "0"])).toThrow("months must be 1..36");
    expect(() => parseCoastalAuditArgs(["--execute"])).toThrow("Unknown option");
  });

  it("extracts the official AppSync read config without changing its scope", () => {
    const config = extractYokohamaReadConfig(rootHtml(), bundleJs());
    expect(config).toEqual({ bundleUrl: BUNDLE_URL, endpoint: APPSYNC_ENDPOINT, apiKey: "fixture-public-read-key" });
    expect(() => extractYokohamaReadConfig(rootHtml(), bundleJs("https://example.com/graphql"))).toThrow("yokohama-appsync-endpoint-invalid");
  });

  it("keeps Yokohama UUID, observation date, and record-created timestamp separate", () => {
    const record = parseYokohamaLastPost(yokohamaItem(), context("yokohama-honmoku"));
    expect(record).toMatchObject({
      sourceRecordId: "last-post:uuid-honmoku-20260815",
      observationDate: "2026-08-15",
      observedAt: "2026-08-15T00:00:00+09:00",
      publishedAt: "2026-08-15T10:28:51.385Z",
      publicationSemantics: "source-record-created-at",
      collectedAt: COLLECTED_AT
    });
  });

  it("parses exact Yokohama species count, size, unit, and facility area", () => {
    const record = parseYokohamaLastPost(yokohamaItem(), context("yokohama-honmoku"));
    expect(record.species[0]).toEqual({
      sourceName: "セイゴ",
      canonicalGroup: "seabass",
      count: 3,
      countKnown: true,
      minSize: 25,
      maxSize: 35,
      sizeUnit: "cm",
      areaLabels: ["旧護岸"]
    });
  });

  it("sums seabass life-stage aliases without mixing bait species", () => {
    const record = parseYokohamaLastPost(yokohamaItem({
      fish2Name: "フッコ",
      fish2Count: 2,
      fish2MinSize: 41,
      fish2MaxSize: 50,
      fish2Unit: "cm",
      fish2Place: ["沖桟橋"],
      fish3Name: "コノシロ",
      fish3Count: 20
    }), context("yokohama-honmoku"));
    const rows = buildNormalizedSpeciesPreview([record]);
    expect(rows.find((row) => row.species === "seabass")).toMatchObject({ catchCount: 5, presence: true, sourceSpeciesNames: ["セイゴ", "フッコ"] });
    expect(rows.find((row) => row.species === "konoshiro")).toMatchObject({ catchCount: 20, presence: true });
  });

  it("creates an explicit zero only for a complete operating-day report", () => {
    const complete = parseYokohamaLastPost(yokohamaItem({ fish1Name: "アジ", fish1Count: 10 }), context("yokohama-honmoku"));
    const incomplete = parseYokohamaLastPost(yokohamaItem({ fish1Name: "アジ", fish1Count: null }), context("yokohama-honmoku"));
    expect(buildNormalizedSpeciesPreview([complete]).find((row) => row.species === "seabass")).toMatchObject({ catchCount: 0, presence: false, explicitZero: true });
    expect(buildNormalizedSpeciesPreview([incomplete]).find((row) => row.species === "seabass")).toMatchObject({ catchCount: null, presence: null, explicitZero: false });
  });

  it("keeps an explicit closure distinct from a zero-catch operating day", () => {
    const record = parseYokohamaLastPost(yokohamaItem({ sentence: "強風のため臨時休業", visitors: 0, fish1Name: null, fish1Count: null }), context("yokohama-honmoku"));
    const seabass = buildNormalizedSpeciesPreview([record]).find((row) => row.species === "seabass");
    expect(record).toMatchObject({ operatingStatus: "closed", reportComplete: false, closureMentioned: true });
    expect(seabass).toMatchObject({ catchCount: null, explicitZero: false });
  });

  it("discovers numeric Ichihara detail identities from listing cards", () => {
    const parsed = parseIchiharaListingPage(ichiharaListingHtml());
    expect(parsed.records).toEqual([
      {
        sourceRecordId: "fishing:28915",
        numericId: "28915",
        observationDate: "2026-08-16",
        sourceMonth: "2026-08",
        url: "https://ichihara-umizuri.com/fishing/28915/"
      }
    ]);
  });

  it("reports the advertised Ichihara archive depth from month options", () => {
    expect(discoverIchiharaArchiveMonths(ichiharaListingHtml())).toEqual(["2026-08", "2025-09", "2024-03"]);
  });

  it("parses Ichihara date, weather, water temperature, tide, and visitors", () => {
    const record = parseIchiharaDetail({ html: ichiharaDetailHtml(), url: "https://ichihara-umizuri.com/fishing/28915/", collectedAt: COLLECTED_AT });
    expect(record).toMatchObject({
      sourceRecordId: "fishing:28915",
      observationDate: "2026-08-16",
      observedAt: "2026-08-16T00:00:00+09:00",
      publishedAt: null,
      publicationSemantics: "unavailable",
      weather: "くもりのち雨",
      waterTemperatureC: 25.5,
      tideLabel: "中潮",
      visitors: 305
    });
  });

  it("parses Ichihara exact count and size rows without inventing an area", () => {
    const record = parseIchiharaDetail({ html: ichiharaDetailHtml(), url: "https://ichihara-umizuri.com/fishing/28915/", collectedAt: COLLECTED_AT });
    expect(record.species).toEqual([
      {
        sourceName: "セイゴ",
        canonicalGroup: "seabass",
        count: 8,
        countKnown: true,
        minSize: 29,
        maxSize: 33,
        sizeUnit: "cm",
        areaLabels: []
      },
      {
        sourceName: "サッパ",
        canonicalGroup: "sappa",
        count: 63,
        countKnown: true,
        minSize: 10,
        maxSize: 11,
        sizeUnit: "cm",
        areaLabels: []
      }
    ]);
  });

  it("keeps unknown species values null in the normalized preview", () => {
    const record = parseIchiharaDetail({ html: ichiharaDetailHtml({ countText: "匹数不明" }), url: "https://ichihara-umizuri.com/fishing/28915/", collectedAt: COLLECTED_AT });
    const seabass = buildNormalizedSpeciesPreview([record]).find((row) => row.species === "seabass");
    expect(record.reportComplete).toBe(false);
    expect(seabass).toMatchObject({ catchCount: null, catchCountKnown: false, presence: null, explicitZero: false });
  });

  it("calculates catch per 100 visitors only from known count and visitor data", () => {
    const record = parseYokohamaLastPost(yokohamaItem({ visitors: 150, fish1Count: 3 }), context("yokohama-honmoku"));
    const seabass = buildNormalizedSpeciesPreview([record]).find((row) => row.species === "seabass");
    expect(seabass.catchPer100Visitors).toBe(2);
  });

  it("aggregates continuity, positive days, zeros, total, median, and maximum deterministically", () => {
    const first = parseYokohamaLastPost(yokohamaItem(), context("yokohama-honmoku"));
    const second = parseYokohamaLastPost(yokohamaItem({ id: "uuid-2", date: "2026/08/16", fish1Name: "アジ", fish1Count: 10 }), context("yokohama-honmoku"));
    const input = aggregateInput([first, second]);
    const left = aggregateCoastalFixedNodeAudit(input);
    const right = aggregateCoastalFixedNodeAudit(input);
    const honmoku = left.facilities.find((facility) => facility.facilityId === "yokohama-honmoku");
    expect(left).toEqual(right);
    expect(left.schemaVersion).toBe(COASTAL_FIXED_NODE_AUDIT_VERSION);
    expect(honmoku.seabass).toMatchObject({ operatingDays: 2, positiveDays: 1, positiveRate: 0.5, totalCatch: 3, medianDailyCatch: 1.5, maxDailyCatch: 3, explicitZeroDays: 1 });
    expect(honmoku.continuity).toMatchObject({ calendarDays: 16, reportDays: 2, missingOrClosedUnknownDays: 14 });
  });

  it("uses only GET requests during the complete live runner path", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = new URL(input);
      calls.push({ url: url.href, method: init?.method, headers: init?.headers });
      if (url.href === YOKOHAMA_ROOT_URL) return response(rootHtml());
      if (url.href === BUNDLE_URL) return response(bundleJs());
      if (url.hostname.endsWith("appsync-api.ap-northeast-1.amazonaws.com")) {
        const variables = JSON.parse(url.searchParams.get("variables"));
        return response(JSON.stringify({
          data: {
            lastPostsByMonthAndFacility: {
              items: [yokohamaItem({
                id: `uuid-${variables.facility.eq}`,
                facility: variables.facility.eq
              })],
              nextToken: null
            }
          }
        }));
      }
      if (url.href === ICHIHARA_ARCHIVE_URL) return response(ichiharaListingHtml());
      if (url.href === `${ICHIHARA_ARCHIVE_URL}page/2/`) return response("<html></html>");
      if (url.href === "https://ichihara-umizuri.com/fishing/28915/") return response(ichiharaDetailHtml());
      throw new Error(`unexpected URL ${url.href}`);
    });

    const report = await runCoastalFixedNodeHistoricalAudit({ months: 1, delayMs: 0, collectedAt: COLLECTED_AT, fetchImpl });
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(report.remoteReads).toEqual({ total: 8, yokohamaRoot: 1, yokohamaBundle: 1, yokohamaAppSync: 3, ichiharaListings: 2, ichiharaDetails: 1 });
    expect(report.remoteWrites).toBe(0);
    expect(report.parser.parseFailureCount).toBe(0);
  });

  it("rejects arbitrary Ichihara and Yokohama source URLs", () => {
    expect(() => parseIchiharaListingPage("", "https://example.com/fishing/")).toThrow("Invalid Ichihara listing read URL");
    expect(() => parseIchiharaDetail({ html: ichiharaDetailHtml(), url: "https://example.com/fishing/28915/", collectedAt: COLLECTED_AT })).toThrow("Invalid Ichihara detail read URL");
    expect(() => extractYokohamaReadConfig(rootHtml("https://example.com/index.js"), bundleJs())).toThrow("Invalid Yokohama bundle URL");
  });
});

function context(facilityId) {
  return { facilityId, collectedAt: COLLECTED_AT };
}

function yokohamaItem(overrides = {}) {
  return {
    id: "uuid-honmoku-20260815",
    date: "2026/08/15",
    month: "2026/08",
    facility: "honmoku",
    sentence: "通常営業しました。",
    weather: "晴れ",
    waterTemp: "26.0",
    tide: "中潮",
    visitors: 150,
    fish1Name: "セイゴ",
    fish1MinSize: 25,
    fish1MaxSize: 35,
    fish1Unit: "cm",
    fish1Count: 3,
    fish1Place: ["旧護岸"],
    createdAt: "2026-08-15T10:28:51.385Z",
    updatedAt: "2026-08-15T10:28:51.385Z",
    ...overrides
  };
}

function rootHtml(bundlePath = "/assets/index-abcdef12.js") {
  return `<html><head><script type="module" crossorigin src="${bundlePath}"></script></head></html>`;
}

function bundleJs(endpoint = APPSYNC_ENDPOINT) {
  return `const config={aws_appsync_graphqlEndpoint:"${endpoint}",aws_appsync_region:"ap-northeast-1",aws_appsync_authenticationType:"API_KEY",aws_appsync_apiKey:"fixture-public-read-key"};`;
}

function ichiharaListingHtml() {
  return `
    <select name="sort[date]">
      <option value="2026年08月">2026年08月</option>
      <option value="2025年09月">2025年09月</option>
      <option value="2024年03月">2024年03月</option>
    </select>
    <p class="font-bold text-[1.125rem]">2026年08月16日(日) </p>
    <a href="https://ichihara-umizuri.com/fishing/28915/">釣れた魚の詳細を見る</a>`;
}

function ichiharaDetailHtml({ countText = "合計 8匹" } = {}) {
  return `
    <p class="font-bold text-[1.125rem]">2026年08月16日(日) </p>
    <span>天気</span><span>くもりのち雨</span>
    <div><p>水温</p><p>上 <span>25.5</span> ℃ 下 <span>24.0</span> ℃</p></div>
    <div><p>潮</p><p>中潮</p></div>
    <p>本日の入場者数は305名様でした。</p>
    ${fishRow("セイゴ", "29.0cm～33.0cm", countText)}
    ${fishRow("サッパ", "10.0cm～11.0cm", "合計 63匹")}`;
}

function fishRow(name, size, count) {
  return `<div class="flex border-b border-gray-300">
    <div class="bg-[#E5E5E5]">${name}</div>
    <div><p>${size}</p></div>
    <div><p>${count}</p></div>
  </div>`;
}

function aggregateInput(records) {
  return {
    records,
    inventoryByFacility: {
      "yokohama-honmoku": records.map((record) => ({ sourceRecordId: record.sourceRecordId, observationDate: record.observationDate })),
      "yokohama-daikoku": [],
      "yokohama-isogo": [],
      "ichihara-original-maker": []
    },
    targetMonths: ["2026-08"],
    archiveMetadata: {},
    collectedAt: COLLECTED_AT,
    remoteReads: { total: 0 },
    parseFailures: []
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}
