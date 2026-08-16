import { describe, expect, it, vi } from "vitest";
import {
  KACHIDOKI_RESULTS_URL,
  aggregateKachidokiAudit,
  discoverKachidokiMonths,
  parseKachidokiMonthlyPage,
  parseKachidokiTripEntry,
  runKachidokiHistoricalAudit
} from "../../../scripts/wanoku-kachidoki-historical-audit.mjs";

const SOURCE_URL = "https://kachidoki-marina.com/fishing-results-202606/";
const COLLECTED_AT = "2026-08-16T02:00:00.000Z";

describe("Wanoku Kachidoki Marina Historical Evidence Audit v1", () => {
  it("discovers archive months from the actual selector shape", () => {
    const months = discoverKachidokiMonths(monthPage({
      options: `
        <option value="202608" selected>2026年08月</option>
        <option value="https://kachidoki-marina.com/fishing-results-202607">2026年07月</option>
        <option value="https://kachidoki-marina.com/fishing-results-202606">2026年06月</option>`
    }), KACHIDOKI_RESULTS_URL);

    expect(months).toEqual([
      { sourceMonth: "2026-08", sourceYear: 2026, month: 8, url: KACHIDOKI_RESULTS_URL },
      { sourceMonth: "2026-07", sourceYear: 2026, month: 7, url: "https://kachidoki-marina.com/fishing-results-202607/" },
      { sourceMonth: "2026-06", sourceYear: 2026, month: 6, url: SOURCE_URL }
    ]);
  });

  it("uses monthly post identity plus deterministic event identity", () => {
    const first = parsePage([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]);
    const second = parsePage([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]);

    expect(first.sourceRecordId).toBe("post:5470");
    expect(first.records[0].sourceEventKey).toBe("2026-06-24-night-seabass");
    expect(first.records[0]).toEqual(second.records[0]);
  });

  it("parses 5hit 4get without retaining article text", () => {
    const record = parseCaption("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get 最大68cm");
    expect(record).toMatchObject({ hitCountKnown: true, hitCount: 5, getCountKnown: true, getCount: 4 });
    expect(record).not.toHaveProperty("text");
    expect(record).not.toHaveProperty("body");
  });

  it("parses 20HIT以上 as a lower bound and 9GET as exact catch", () => {
    const record = parseCaption("6/19（金）チョイノリ【NIGHT】<br>シーバス 20HIT以上 9GET");
    expect(record).toMatchObject({
      hitCountKnown: false,
      hitCount: null,
      hitCountLowerBound: 20,
      getCountKnown: true,
      getCount: 9
    });
  });

  it("preserves hit多数 as non-numeric hit evidence", () => {
    const record = parseCaption("6/21（日）チョイノリ【NIGHT】<br>シーバス hit多数 4get");
    expect(record).toMatchObject({
      hitEvidencePresent: true,
      hitCountKnown: false,
      hitCount: null,
      hitCountLowerBound: null,
      getCount: 4
    });
  });

  it.each([
    ["シーバス 3get", 3],
    ["シーバス7GET", 7]
  ])("parses compact catch form %s", (result, count) => {
    expect(parseCaption(`6/18（木）チョイノリ【DAY】<br>${result}`).getCount).toBe(count);
  });

  it("keeps seabass counts separate from other species", () => {
    const record = parseCaption("6/21（日）チョイノリ【DAY】<br>クロダイ 1GET シーバス 7GET マゴチ 2GET");
    expect(record.getCount).toBe(7);
  });

  it("recognizes explicit targeted failure only from explicit seabass zero wording", () => {
    const record = parseCaption(
      "6/4（木）チョイノリ【NIGHT】<br>後半戦のシーバスへ。ゴミが多く、シーバスは次回へ持ち越し。"
    );
    expect(record).toMatchObject({
      explicitSeabassAttempt: true,
      explicitZeroCatchCandidate: true,
      getCountKnown: true,
      getCount: 0,
      eligibilityReason: "explicit-seabass-attempt-and-explicit-zero",
      foundationConvertibleType: "explicit-effort-zero-catch"
    });
  });

  it("does not turn article absence, cancellation, or other-species reports into seabass zero", () => {
    const noSeabass = parseCaption("6/29（月）チョイノリ【NIGHT】<br>クロダイ 1get");
    const cancelled = parseCaption("6/28（日）チョイノリ【DAY】<br>強風のため出船中止");
    expect(noSeabass.explicitZeroCatchCandidate).toBe(false);
    expect(cancelled.explicitZeroCatchCandidate).toBe(false);
    expect(cancelled.getCount).toBeNull();
  });

  it.each(["DAY", "NIGHT"])("preserves %s as daypart without inventing clock time", (daypart) => {
    const record = parseCaption(`6/12（金）チョイノリ【${daypart}】<br>シーバス 3get`);
    expect(record).toMatchObject({ daypart, eventClockTime: null, temporalPrecision: "daypart" });
  });

  it("derives 120 minutes only for an unambiguous standard choinori plan", () => {
    const standard = parseCaption("6/12（金）チョイノリ【NIGHT】<br>シーバス 3get");
    const unknown = parseCaption("6/12（金）乗合便【NIGHT】<br>シーバス 3get");
    expect(standard).toMatchObject({ effortDurationKnown: true, effortDurationMinutes: 120, durationSource: "service-plan" });
    expect(unknown).toMatchObject({ effortDurationKnown: false, effortDurationMinutes: null, durationSource: null });
  });

  it("does not mistake combo plans for the standard two-hour service", () => {
    const combo4 = parseCaption("6/12（金）チョイノリコンボ4【NIGHT】<br>シーバス 3get");
    const genericCombo = parseCaption("6/12（金）チョイノリコンボ【NIGHT】<br>シーバス 3get");
    expect(combo4).toMatchObject({ effortDurationKnown: true, effortDurationMinutes: 240, durationSource: "service-plan" });
    expect(genericCombo).toMatchObject({ effortDurationKnown: false, effortDurationMinutes: null });
  });

  it("keeps combo entries without DAY/NIGHT as date-only and never invents a clock", () => {
    const record = parseCaption("6/12（金）【コンボ便】コンボ８<br>シーバス 3get");
    expect(record).toMatchObject({
      daypart: "unknown",
      temporalPrecision: "date-only",
      eventClockTime: null,
      effortDurationKnown: true,
      effortDurationMinutes: 480,
      durationSource: "service-plan"
    });
  });

  it("aggregates environmental, activation, and structural clues deterministically", () => {
    const caption = "6/22（月）チョイノリ【DAY】<br>シーバス 7hit 5get<br>台風後の雨で水が良く、流れとベイトあり。夕マズメの明暗で水面バイト、チェイス。橋脚へ移動。";
    const first = parseCaption(caption);
    const second = parseCaption(caption);
    expect(first.environmentalClues).toEqual({
      flow: true,
      rain: true,
      wind: false,
      garbage: false,
      tide: false,
      waterCondition: true,
      bait: true
    });
    expect(first.activationClues).toEqual(["twilight", "lighting", "current", "chase"]);
    expect(first.structuralClues).toEqual(["structure", "light", "area-movement"]);
    expect(first).toEqual(second);
  });

  it("keeps explicit broad source location as a source fact without node mapping", () => {
    const record = parseCaption("6/22（月）チョイノリ【NIGHT】<br>シーバス 5hit 3get<br>東京湾での初シーバスをキャッチ");
    expect(record).toMatchObject({ sourceLocationMentioned: true, sourceLocationLabel: "東京湾" });
    expect(record).not.toHaveProperty("mappedNodeId");
  });

  it("continues parsing a monthly page after one malformed entry", () => {
    const page = parsePage([
      trip("unsupported entry"),
      trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")
    ]);
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({ parseStatus: "error", diagnostics: ["entry-header-unrecognized"] });
    expect(page.records[1]).toMatchObject({ parseStatus: "ok", getCount: 4 });
  });

  it("marks detail-rich contact data as a Foundation gap while retaining direct catch convertibility", () => {
    const record = parseCaption("6/22（月）チョイノリ【DAY】<br>シーバス 7hit 5get<br>水面バイトやチェイスあり");
    expect(record.foundationConvertibleType).toBe("positive-catch");
    expect(record.foundationGaps).toEqual([
      "hit-count-not-representable",
      "chase-not-representable",
      "bite-detail-not-representable"
    ]);
  });

  it("classifies explicitly attributed seabass hit without a catch as bite-or-contact", () => {
    const record = parseCaption("6/22（月）チョイノリ【DAY】<br>シーバス 5hit");
    expect(record).toMatchObject({
      seabassTargeted: true,
      hitEvidencePresent: true,
      getCountKnown: false,
      foundationConvertibleType: "bite-or-contact"
    });
  });

  it("continues the live-style audit after one monthly fetch failure", async () => {
    const julyUrl = "https://kachidoki-marina.com/fishing-results-202607/";
    const juneUrl = SOURCE_URL;
    const archive = monthPage({
      month: 8,
      postId: 6000,
      options: `
        <option value="202608">2026年08月</option>
        <option value="${julyUrl.slice(0, -1)}">2026年07月</option>
        <option value="${juneUrl.slice(0, -1)}">2026年06月</option>`,
      entries: [trip("8/1（土）チョイノリ【DAY】<br>シーバス 2hit 1get")]
    });
    const fetchImpl = vi.fn(async (url) => {
      if (url === KACHIDOKI_RESULTS_URL) return response(archive);
      if (url === julyUrl) return response("failed", 500);
      return response(monthPage({
        entries: [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]
      }));
    });

    const report = await runKachidokiHistoricalAudit({
      maxEntries: 10,
      maxMonths: 3,
      delayMs: 0,
      collectedAt: COLLECTED_AT,
      fetchImpl
    });
    expect(report.records.filter((record) => record.parseStatus === "ok")).toHaveLength(2);
    expect(report.discovery.monthFetchAttempts).toBe(3);
    expect(report.discovery.monthFetchSuccesses).toBe(2);
    expect(report.discovery.fetchErrors).toHaveLength(1);
  });

  it("produces deterministic aggregate and Umineko comparison reports", () => {
    const records = [
      parseCaption("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get 東京湾"),
      parseCaption("6/4（木）チョイノリ【NIGHT】<br>後半戦のシーバスへ。シーバスは次回へ持ち越し。")
    ];
    const first = aggregateKachidokiAudit(records, aggregateContext());
    const second = aggregateKachidokiAudit(records, aggregateContext());
    expect(first).toEqual(second);
    expect(first.comparisonWithUmineko.baseline).toMatchObject({
      sampleSize: 50,
      seabassRelatedCount: 14,
      evidenceGeneratedCount: 3,
      explicitZeroCount: 0
    });
    expect(first.sourceUsefulness).not.toHaveProperty("overallScore");
  });
});

function parseCaption(captionHtml) {
  return parseKachidokiTripEntry({
    captionHtml,
    sourceRecordId: "post:5470",
    sourceUrl: SOURCE_URL,
    sourceYear: 2026,
    sourceMonth: 6
  });
}

function parsePage(entries) {
  return parseKachidokiMonthlyPage({
    html: monthPage({ entries }),
    url: SOURCE_URL,
    sourceYear: 2026,
    sourceMonth: 6
  });
}

function monthPage({ month = 6, postId = 5470, options = "", entries = [] } = {}) {
  return `
    <meta property="article:published_time" content="2026-07-01T16:05:12+09:00">
    <meta property="article:modified_time" content="2026-08-12T14:25:51+09:00">
    <article id="post-${postId}" class="article post-${postId} page">
      <select>${options}</select>
      <div class="swiper-wrapper">${entries.join("")}</div>
      <span data-month="${month}"></span>
    </article>`;
}

function trip(captionHtml) {
  return `<div class="swiper-slide"><figure class="slide"><div class="slide-media"></div><figcaption class="slide-title">${captionHtml}</figcaption></figure></div>`;
}

function response(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}

function aggregateContext() {
  return {
    auditedAt: COLLECTED_AT,
    requestCount: 2,
    discoveredMonths: [{ sourceMonth: "2026-06" }],
    fetchedMonths: [{ sourceMonth: "2026-06", sourceRecordId: "post:5470", entryCount: 2, parseErrorCount: 0 }],
    monthFetchAttempts: 1,
    monthFetchSuccesses: 1,
    fetchErrors: [],
    abortedReason: null
  };
}
