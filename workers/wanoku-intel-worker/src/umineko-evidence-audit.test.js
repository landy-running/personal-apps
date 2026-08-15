import { describe, expect, it, vi } from "vitest";
import {
  aggregateUminekoAudit,
  runUminekoHistoricalAudit
} from "../../../scripts/wanoku-umineko-historical-audit.mjs";
import { UMINEKO_LISTING_URL } from "../../../scripts/wanoku-umineko-evidence-preview.mjs";

const AUDITED_AT = "2026-08-16T01:00:00.000Z";
const JULY_14_URL = "https://umineko.biz/?news=2026-7-14-night-seabass";
const JULY_7_URL = "https://umineko.biz/?news=2026-7-7-night-seabass";

describe("Wanoku Umineko Historical Evidence Audit v1", () => {
  it("deduplicates listing revisions by numeric sourceRecordId before detail fetch", async () => {
    const detailFetches = [];
    const fetchImpl = vi.fn(async (url) => {
      if (url === UMINEKO_LISTING_URL) {
        return response(listingFixture([
          listingRecord(44876, JULY_14_URL, "old title"),
          listingRecord(44876, "https://umineko.biz/?news=renamed", "new title")
        ]));
      }
      detailFetches.push(url);
      return response(july14Fixture());
    });

    const report = await runUminekoHistoricalAudit({ limit: 1, collectedAt: AUDITED_AT, delayMs: 0, fetchImpl });
    expect(report.discovery.discoveredArticleCount).toBe(1);
    expect(detailFetches).toEqual([JULY_14_URL]);
    expect(report.records[0].sourceRecordId).toBe("post:44876");
  });

  it("audits records beyond the preview-oriented first ten entries on a listing page", async () => {
    const fillers = Array.from({ length: 10 }, (_, index) => listingRecord(
      46000 + index,
      `https://umineko.biz/?news=filler-${index}`,
      `2026.8.${15 - index} チニング`
    ));
    const records = [...fillers, listingRecord(44876, JULY_14_URL, "2026.7.14 ナイトシーバス便")];
    const fetchImpl = vi.fn(async (url) => {
      if (url === UMINEKO_LISTING_URL) return response(listingFixture(records));
      if (url === JULY_14_URL) return response(july14Fixture());
      const filler = fillers.find((record) => record.url === url);
      return response(detailFixture({
        postId: filler.postId,
        url: filler.url,
        title: filler.title,
        body: "結果\nチヌ\n3枚キャッチ",
        published: "2026年8月15日"
      }));
    });

    const report = await runUminekoHistoricalAudit({ limit: 11, collectedAt: AUDITED_AT, delayMs: 0, fetchImpl });
    expect(report.discovery.discoveredArticleCount).toBe(11);
    expect(report.records.some((record) => record.sourceRecordId === "post:44876")).toBe(true);
    expect(report.knownRegressions.july14).toBe(true);
  });

  it("continues after one record fetch failure", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === UMINEKO_LISTING_URL) {
        return response(listingFixture([
          listingRecord(45000, "https://umineko.biz/?news=broken", "broken"),
          listingRecord(44791, JULY_7_URL, "2026.7.7 ナイトシーバス便")
        ]));
      }
      if (url.includes("broken")) return response("failed", 500);
      return response(july7Fixture());
    });

    const report = await runUminekoHistoricalAudit({ limit: 2, collectedAt: AUDITED_AT, delayMs: 0, fetchImpl });
    expect(report.records).toHaveLength(2);
    expect(report.records[0]).toMatchObject({ articleParsed: false, ignoredReason: "fetch-error" });
    expect(report.records[1]).toMatchObject({ sourceRecordId: "post:44791", catchCount: 22 });
    expect(report.discovery.fetchSuccessRate).toBe(0.5);
  });

  it("preserves both known production-like regressions through the audit", async () => {
    const report = await knownRegressionAudit();
    expect(report.knownRegressions).toEqual({ july14: true, july7: true, passed: true });
    expect(report.records.find((record) => record.sourceRecordId === "post:44876")).toMatchObject({
      catchCount: 29,
      anglerCount: 4
    });
    expect(report.records.find((record) => record.sourceRecordId === "post:44791")).toMatchObject({
      catchCount: 22,
      durationMinutes: 240,
      anglerCount: 3
    });
  });

  it("produces deterministic aggregate metrics", async () => {
    const records = (await knownRegressionAudit()).records;
    expect(aggregateUminekoAudit(records, aggregateContext())).toEqual(aggregateUminekoAudit(records, aggregateContext()));
  });

  it("counts zero catch only for explicit effort-zero evidence", () => {
    const positive = auditRecord({ sourceRecordId: "post:1", catchCount: 2, evidenceType: "catch" });
    const unsupportedZero = auditRecord({
      sourceRecordId: "post:2",
      catchCount: 0,
      explicitZeroCatch: true,
      evidenceType: null
    });
    const explicitZero = auditRecord({
      sourceRecordId: "post:3",
      catchCount: 0,
      explicitZeroCatch: true,
      evidenceType: "explicit-effort-zero-catch"
    });
    const result = aggregateUminekoAudit([positive, unsupportedZero, explicitZero]);
    expect(result.catch.explicitZeroCount).toBe(1);
    expect(result.catch.explicitZeroCoverage).toBe("observed");
  });

  it("does not count missing reports or no-seabass articles as zero catch", () => {
    const noReport = auditRecord({
      sourceRecordId: "post:1",
      seabassMentioned: false,
      seabassEvidenceGenerated: false,
      catchCountKnown: false,
      catchCount: null,
      evidenceType: null,
      ignoredReason: "no-seabass"
    });
    const result = aggregateUminekoAudit([noReport]);
    expect(result.catch.explicitZeroCount).toBe(0);
    expect(result.catch.explicitZeroCoverage).toBe("none");
    expect(result.catch.zeroCatchRate).toBeNull();
  });

  it("counts generated evidence with mappedNodeId null", () => {
    const result = aggregateUminekoAudit([auditRecord({ selectedMappedNodeId: null })]);
    expect(result.spatial.mappedNodeNullCount).toBe(1);
    expect(result.spatial.mappedNodeNullRate).toBe(1);
  });

  it("summarizes source usefulness deterministically without a numeric score", () => {
    const result = aggregateUminekoAudit([
      auditRecord({ sourceRecordId: "post:1", durationKnown: true, durationMinutes: 240 }),
      auditRecord({ sourceRecordId: "post:2", anglerCountKnown: true, anglerCount: 3 })
    ]);
    expect(result.sourceUsefulness).toMatchObject({
      catchEvidence: { level: "strong" },
      effortEvidence: { level: "moderate" },
      temporalPrecision: { level: "moderate" },
      spatialPrecision: { level: "weak" }
    });
    expect(result).not.toHaveProperty("overallScore");
  });

  it("classifies sparse live-like catch, effort, and spatial coverage as weak", () => {
    const records = Array.from({ length: 14 }, (_, index) => auditRecord({
      sourceRecordId: `post:${index + 1}`,
      seabassEvidenceGenerated: index < 3,
      catchCountKnown: index < 3,
      catchCount: index < 3 ? index + 1 : null,
      evidenceType: index < 3 ? "catch" : null,
      durationKnown: index === 0,
      durationMinutes: index === 0 ? 240 : null,
      anglerCountKnown: index < 2,
      anglerCount: index < 2 ? 3 : null,
      sourceLocationMentioned: index === 0,
      sourceLocationLabel: index === 0 ? "三番瀬" : null,
      selectedMappedNodeId: index === 0 ? "funabashi-inner-01" : null
    }));
    const result = aggregateUminekoAudit(records);
    expect(result.sourceUsefulness).toMatchObject({
      catchEvidence: { level: "weak" },
      effortEvidence: { level: "weak" },
      temporalPrecision: { level: "moderate" },
      spatialPrecision: { level: "weak" }
    });
  });

  it("keeps the current low Funabashi candidate and null canonical mapping", async () => {
    const report = await knownRegressionAudit();
    for (const record of report.records) {
      expect(record.inferredLocationCandidateCount).toBe(1);
      expect(record.inferenceCertainties).toEqual(["low"]);
      expect(record.selectedMappedNodeId).toBeNull();
    }
    expect(report.spatial.mappedNodeNullCount).toBe(2);
  });
});

async function knownRegressionAudit() {
  const fetchImpl = vi.fn(async (url) => {
    if (url === UMINEKO_LISTING_URL) {
      return response(listingFixture([
        listingRecord(44876, JULY_14_URL, "2026.7.14 ナイトシーバス便"),
        listingRecord(44791, JULY_7_URL, "2026.7.7 ナイトシーバス便")
      ]));
    }
    return response(url === JULY_14_URL ? july14Fixture() : july7Fixture());
  });
  return runUminekoHistoricalAudit({ limit: 2, collectedAt: AUDITED_AT, delayMs: 0, fetchImpl });
}

function listingRecord(postId, url, title) {
  return { postId, url, title, published: "2026年7月19日" };
}

function listingFixture(records) {
  return records.map((record) => `
    <article id="post-${record.postId}" class="news">
      <h4><a href="${record.url}">${record.title}</a></h4>
      <footer class="entry-meta"><span class="date">${record.published}</span></footer>
    </article>`).join("");
}

function july14Fixture() {
  return detailFixture({
    postId: 44876,
    url: JULY_14_URL,
    title: "2026.7.14 ナイトシーバス便",
    body: "初ゲスト3名様にて出船。\n結果\nシーバス\n30〜48cmまで\n29本キャッチ\nせんちょ13本",
    published: "2026年7月19日"
  });
}

function july7Fixture() {
  return detailFixture({
    postId: 44791,
    url: JULY_7_URL,
    title: "2026.7.7 ナイトシーバス便",
    body: "初チャレゲスト3名様含め、4時間便でしたので短時間勝負。\n結果\nシーバス\n22本キャッチ",
    published: "2026年7月9日"
  });
}

function detailFixture({ postId, url, title, body, published }) {
  return `
    <link rel="canonical" href="${url}">
    <article id="post-${postId}" class="news">
      <h1 class="entry-title">${title}</h1>
      <div class="entry-content">${body.split("\n").map((line) => `<p>${line}</p>`).join("")}</div><!-- .entry-content -->
      <footer class="entry-meta"><span class="date">${published}</span></footer><!-- .entry-meta -->
    </article>`;
}

function auditRecord(overrides = {}) {
  const catchCount = overrides.catchCount === undefined ? 1 : overrides.catchCount;
  return {
    sourceRecordId: "post:1",
    url: "https://umineko.biz/?news=test",
    publicationDate: "2026-07-19",
    articleParsed: true,
    seabassMentioned: true,
    seabassTargeted: true,
    seabassEvidenceGenerated: true,
    catchCountKnown: Number.isInteger(catchCount),
    catchCount,
    explicitZeroCatch: false,
    evidenceType: "catch",
    durationKnown: false,
    durationMinutes: null,
    anglerCountKnown: false,
    anglerCount: null,
    eventDateKnown: true,
    eventTimePrecision: "day-only",
    publicationTimePrecision: "day-only",
    sourceLocationMentioned: false,
    sourceLocationLabel: null,
    inferredLocationCandidateCount: 1,
    inferenceCertainties: ["low"],
    selectedMappedNodeId: null,
    multipleSeabassEventsUnresolved: false,
    multiSpeciesArticle: false,
    sourceIdentity: '["umineko","post:1","seabass-main"]',
    evidenceId: "wanoku-seabass-evidence:test",
    ignoredReason: null,
    diagnostics: [],
    ...overrides
  };
}

function aggregateContext() {
  return {
    auditedAt: AUDITED_AT,
    requestedLimit: 2,
    listingPagesFetched: 1,
    discoveredArticleCount: 2,
    detailFetchAttempts: 2,
    detailFetchSuccesses: 2,
    detailIdentityDuplicates: 0,
    discoveryErrors: [],
    abortedReason: null
  };
}

function response(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}
