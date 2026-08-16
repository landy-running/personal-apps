import { describe, expect, it, vi } from "vitest";
import {
  WAKUWAKUYA_ARCHIVE_URL,
  aggregateWakuwakuyaAudit,
  discoverWakuwakuyaMonths,
  parseWakuwakuyaMonthlyPage,
  parseWakuwakuyaRecord,
  runWakuwakuyaHistoricalAudit
} from "../../../scripts/wanoku-wakuwakuya-historical-audit.mjs";

const MONTH_URL = "https://wakuwakuya.jp/blog.php?f=m&mon=2026-07";
const COLLECTED_AT = "2026-08-16T03:00:00.000Z";

describe("Wanoku Wakuwakuya Historical Evidence Audit v1", () => {
  it("discovers monthly archives with advertised counts", () => {
    const months = discoverWakuwakuyaMonths(`
      <a href="./blog.php?f=m&amp;mon=2026-07">2026年07月（11）</a>
      <a href="./blog.php?f=m&amp;mon=2026-06">2026年06月（13）</a>`);
    expect(months).toEqual([
      { sourceMonth: "2026-07", url: MONTH_URL, advertisedRecordCount: 11 },
      { sourceMonth: "2026-06", url: "https://wakuwakuya.jp/blog.php?f=m&mon=2026-06", advertisedRecordCount: 13 }
    ]);
  });

  it("uses the numeric image namespace as the verified detail identity", () => {
    const record = parseRecord({ body: "シーバス2本キャッチ！", id: 155992 });
    expect(record).toMatchObject({
      sourceRecordId: "post:155992",
      url: "https://wakuwakuya.jp/blog.php?f=d&id=155992"
    });
  });

  it("deduplicates a repeated numeric detail ID across monthly pages", async () => {
    const archive = archiveFixture(["2026-08", "2026-07"]);
    const fetchImpl = vi.fn(async (url) => {
      if (url === WAKUWAKUYA_ARCHIVE_URL) return response(archive);
      const sourceMonth = new URL(url).searchParams.get("mon");
      return response(monthFixture({
        sourceMonth,
        sections: [sectionFixture({ date: `${sourceMonth}-01`, id: 155992, heading: "午前シーバス便", body: "シーバス2本キャッチ" })]
      }));
    });
    const result = await runWakuwakuyaHistoricalAudit({
      maxMonths: 2,
      maxRecords: 10,
      delayMs: 0,
      collectedAt: COLLECTED_AT,
      fetchImpl
    });
    expect(result.records).toHaveLength(1);
    expect(result.archive.duplicateCount).toBe(1);
  });

  it("keeps cancellation separate from explicit zero evidence", () => {
    const record = parseRecord({
      heading: "午前シーバス便",
      body: "強風のため出船中止。シーバスの反応なし。"
    });
    expect(record).toMatchObject({
      tripStatus: "cancelled",
      explicitZeroCandidate: false,
      currentFoundationConvertible: false
    });
    expect(record.diagnostics).toContain("cancelled-not-zero");
  });

  it("parses an exact numeric seabass landed count", () => {
    const record = parseRecord({ body: "シーバス2本キャッチ！" });
    expect(record).toMatchObject({ landedCountKnown: true, landedCount: 2, landedCountLowerBound: null });
  });

  it("preserves 30本オーバー as a lower bound", () => {
    const record = parseRecord({ body: "シーバス30本オーバーでした。" });
    expect(record).toMatchObject({ landedCountKnown: false, landedCount: null, landedCountLowerBound: 30 });
  });

  it("keeps nonnumeric positive catch language positive without inventing a count", () => {
    const record = parseRecord({ body: "シーバスはポツポツ釣れて全員安打でした。" });
    expect(record).toMatchObject({ landedPositiveEvidence: true, landedCountKnown: false, landedCount: null });
  });

  it("does not add another species count to seabass", () => {
    const record = parseRecord({
      heading: "午前シーバス便",
      body: "シーバス2本キャッチ。後半は移動してカサゴ狙いで10匹追加。"
    });
    expect(record.landedCount).toBe(2);
  });

  it("separates exact contact count from landed count", () => {
    const record = parseRecord({ body: "シーバスは5ヒット2キャッチでした。" });
    expect(record).toMatchObject({
      contactEvidencePresent: true,
      contactCountKnown: true,
      contactCount: 5,
      landedCountKnown: true,
      landedCount: 2
    });
  });

  it("tracks lost fish without adding it to landed or contact counts", () => {
    const record = parseRecord({ body: "シーバスがヒットするも惜しくもラインブレイク。" });
    expect(record).toMatchObject({
      contactEvidencePresent: true,
      contactCountKnown: false,
      landedCountKnown: false,
      lostFishMentioned: true
    });
  });

  it("does not treat a bare fishfinder reaction as bite contact", () => {
    const record = parseRecord({ body: "シーバス狙い。魚探の反応はあるものの生命感なし。" });
    expect(record.contactEvidencePresent).toBe(false);
    expect(record.environmentalClues).toContain("fish-response");
  });

  it("captures condition-change type and resolvable outcome", () => {
    const record = parseRecord({ body: "シーバス狙い。ポイント移動してみるとアタリが増えて連続ヒット。" });
    expect(record).toMatchObject({ conditionChangeMentioned: true, outcomeBeforeAfterResolvable: true });
    expect(record.conditionChangeTypes).toEqual(["location-change"]);
  });

  it("accepts trip-level zero only after completed explicit effort with no catch or contact", () => {
    const record = parseRecord({ body: "2名様でシーバス狙いに出船。最後までアタリなし、シーバスは釣れず終了でした。" });
    expect(record).toMatchObject({
      tripStatus: "completed",
      explicitSeabassEffort: true,
      contactEvidencePresent: false,
      explicitZeroCandidate: true,
      zeroSegmentCandidate: true,
      anglerCountKnown: true,
      anglerCount: 2,
      currentFoundationConvertible: true
    });
  });

  it("keeps an early zero segment distinct when a later point produces catch", () => {
    const record = parseRecord({ body: "シーバス狙い。最初のポイントは生命感なし。移動してシーバス2本キャッチ。" });
    expect(record).toMatchObject({
      zeroSegmentCandidate: true,
      explicitZeroCandidate: false,
      landedCount: 2
    });
    expect(record.diagnostics).toContain("segment-zero-not-trip-zero");
  });

  it("does not apply the current service-plan duration retroactively", () => {
    const unknown = parseRecord({ body: "シーバス狙いで出船。" });
    const explicit = parseRecord({ body: "5時間のシーバス便で出船。" });
    expect(unknown).toMatchObject({ durationKnown: false, durationMinutes: null, durationSource: "unknown" });
    expect(explicit).toMatchObject({ durationKnown: true, durationMinutes: 300, durationSource: "entry-explicit" });
  });

  it("preserves morning, afternoon, night, and long as dayparts without clock time", () => {
    expect(parseRecord({ heading: "午前シーバス便" }).daypart).toBe("morning");
    expect(parseRecord({ heading: "午後シーバス便" }).daypart).toBe("afternoon");
    expect(parseRecord({ heading: "ナイトシーバス便" }).daypart).toBe("night");
    const long = parseRecord({ heading: "シーバスロング便" });
    expect(long).toMatchObject({ daypart: "long", exactClockKnown: false, temporalPrecision: "daypart" });
  });

  it("assigns mutually exclusive three-way Foundation convertibility", () => {
    const withoutLoss = parseRecord({ body: "シーバス2本キャッチ。" });
    const withLoss = parseRecord({ body: "シーバス5ヒット2キャッチ。" });
    const notConvertible = parseRecord({ body: "シーバスを探して各所を回りました。" });
    expect(withoutLoss.foundationConvertibility).toBe("convertible-without-loss");
    expect(withLoss.foundationConvertibility).toBe("convertible-with-information-loss");
    expect(withLoss.informationLossFields).toContain("contact-count");
    expect(notConvertible.foundationConvertibility).toBe("not-convertible");
  });

  it("produces deterministic aggregate and three-source comparison output", () => {
    const records = [
      parseRecord({ body: "シーバス5ヒット2キャッチ。" }),
      parseRecord({ body: "2名様でシーバス狙いに出船。アタリなしで釣れず終了でした。", id: 155993 })
    ];
    const first = aggregateWakuwakuyaAudit(records, aggregateContext());
    const second = aggregateWakuwakuyaAudit(records, aggregateContext());
    expect(first).toEqual(second);
    expect(first.comparison.umineko.sampleSize).toBe(50);
    expect(first.comparison.kachidoki.sampleSize).toBe(100);
    expect(first.comparison.metricNote).toContain("overlap");
  });

  it("continues a monthly page after one malformed record", () => {
    const page = parseWakuwakuyaMonthlyPage({
      html: monthFixture({
        sourceMonth: "2026-07",
        sections: [
          "<section class=\"frame\"><p>broken</p></section>",
          sectionFixture({ body: "シーバス2本キャッチ。" })
        ]
      }),
      url: MONTH_URL,
      sourceMonth: "2026-07"
    });
    expect(page.records).toHaveLength(2);
    expect(page.records[0]).toMatchObject({ parseStatus: "error", diagnostics: ["record-heading-missing"] });
    expect(page.records[1]).toMatchObject({ parseStatus: "ok", landedCount: 2 });
  });

  it("does not retain article text in the per-record audit output", () => {
    const record = parseRecord({ body: "シーバス2本キャッチ。" });
    expect(record).not.toHaveProperty("body");
    expect(record).not.toHaveProperty("text");
    expect(record).not.toHaveProperty("heading");
  });
});

function parseRecord({
  date = "2026-07-05",
  heading = "午前シーバス便",
  body = "シーバスを探して出船しました。",
  id = 155992
} = {}) {
  return parseWakuwakuyaRecord({
    sectionHtml: sectionFixture({ date, heading, body, id, includeSection: false }),
    sourceUrl: MONTH_URL,
    sourceMonth: date.slice(0, 7)
  });
}

function archiveFixture(months) {
  return months.map((month) => {
    const [year, number] = month.split("-");
    return `<a href="./blog.php?f=m&amp;mon=${month}">${year}年${number}月（10）</a>`;
  }).join("");
}

function monthFixture({ sections = [], sourceMonth = "2026-07" } = {}) {
  return `<html data-month="${sourceMonth}"><body>${sections.join("")}</body></html>`;
}

function sectionFixture({
  date = "2026-07-05",
  heading = "午前シーバス便",
  body = "シーバスを探して出船しました。",
  id = 155992,
  includeSection = true
} = {}) {
  const [year, month, day] = date.split("-").map(Number);
  const content = `
    <h2><time>${year}年${month}月${day}日(日)</time>${heading}</h2>
    <div class="frame-inner"><div><p>${body}</p>
      ${id ? `<div class="blog__photo"><img src="https://choka.fishing-v.jp/funayado_images/62_${id}_20260706120000_1.jpeg"></div>` : ""}
    </div></div>`;
  return includeSection ? `<section class="frame">${content}</section>` : content;
}

function aggregateContext() {
  return {
    auditedAt: COLLECTED_AT,
    requestCount: 2,
    discoveredMonths: [{ sourceMonth: "2026-07" }],
    fetchedMonths: [{ sourceMonth: "2026-07", pageRecordCount: 2, parseErrorCount: 0 }],
    monthFetchAttempts: 1,
    monthFetchSuccesses: 1,
    fetchErrors: [],
    abortedReason: null,
    duplicateCount: 0
  };
}

function response(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}
