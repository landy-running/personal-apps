import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  discoverUminekoRecords,
  parseUminekoDetail,
  parseUminekoPreviewArgs,
  runUminekoEvidencePreview,
  sourceRecordIdFromUminekoUrl,
  UMINEKO_LISTING_URL
} from "../../../scripts/wanoku-umineko-evidence-preview.mjs";

const COLLECTED_AT = "2026-08-15T06:00:00.000Z";
const SAME_DAY_COLLECTED_AT = "2026-08-16T09:00:00.000Z";
const JULY_14_URL = "https://umineko.biz/?news=2026-7-14-night-seabass";
const JULY_7_URL = "https://umineko.biz/?news=2026-7-7-night-seabass";

describe("Wanoku Umineko External Evidence Adapter Preview v1", () => {
  it("derives the slug fallback identity from the canonical news permalink", () => {
    expect(sourceRecordIdFromUminekoUrl("https://www.UMINEKO.biz/?utm_source=x&news=2026-7-14-%E3%83%8A%E3%82%A4%E3%83%88"))
      .toBe("news:2026-7-14-ナイト");
    expect(sourceRecordIdFromUminekoUrl("/?news=2026-7-14-%e3%83%8a%e3%82%a4%e3%83%88#result"))
      .toBe("news:2026-7-14-ナイト");
  });

  it("rejects non-Umineko and non-detail URLs", () => {
    expect(() => sourceRecordIdFromUminekoUrl("https://example.com/?news=x")).toThrow("Only HTTPS Umineko");
    expect(() => sourceRecordIdFromUminekoUrl(UMINEKO_LISTING_URL)).toThrow("news parameter");
  });

  it("uses numeric WordPress post ID as the primary detail identity", async () => {
    const result = await parse(detail({
      postId: 12345,
      url: "https://umineko.biz/?news=old-title",
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n1本キャッチ"
    }));
    expect(result.source.sourceRecordId).toBe("post:12345");
    expect(firstEvent(result).externalEvidencePayload.source.sourceRecordId).toBe("post:12345");
    expect(result.diagnostics).not.toContain("source-record-id-slug-fallback");
  });

  it("keeps identity and evidence ID stable when title and canonical slug change", async () => {
    const body = "結果\nシーバス\n3本キャッチ";
    const before = firstEvent(await parse(detail({
      postId: 12345,
      url: "https://umineko.biz/?news=old-title",
      title: "2026.7.14 ナイトシーバス便 旧題",
      body
    })));
    const after = firstEvent(await parse(detail({
      postId: 12345,
      url: "https://umineko.biz/?news=new-title",
      title: "2026.7.14 ナイトシーバス便 新題",
      body
    })));
    expect(after.externalEvidencePayload.sourceIdentity).toBe(before.externalEvidencePayload.sourceIdentity);
    expect(after.evidenceId).toBe(before.evidenceId);
  });

  it("keeps source identity but changes evidence ID when catch content is corrected", async () => {
    const before = firstEvent(await parse(detail({
      postId: 12345,
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n3本キャッチ"
    })));
    const after = firstEvent(await parse(detail({
      postId: 12345,
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n4本キャッチ"
    })));
    expect(after.externalEvidencePayload.sourceIdentity).toBe(before.externalEvidencePayload.sourceIdentity);
    expect(after.evidenceId).not.toBe(before.evidenceId);
  });

  it("falls back to decoded slug with a diagnostic when post ID is absent", async () => {
    const result = await parse(detail({
      postId: null,
      url: "https://umineko.biz/?news=slug-fallback",
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n1本キャッチ"
    }));
    expect(result.source.sourceRecordId).toBe("news:slug-fallback");
    expect(result.diagnostics).toContain("source-record-id-slug-fallback");
  });

  it("discovers recent WordPress news articles with title and publication metadata", () => {
    const records = discoverUminekoRecords(listingFixture([
      { postId: 44876, url: JULY_14_URL, title: "2026.7.14 ナイトシーバス便", published: "2026年7月19日" },
      { postId: 44791, url: JULY_7_URL, title: "2026.7.7 ナイトシーバス便", published: "2026年7月9日" }
    ]), 2);

    expect(records).toEqual([
      {
        sourceRecordId: "post:44876",
        url: JULY_14_URL,
        title: "2026.7.14 ナイトシーバス便",
        publicationDate: "2026-07-19"
      },
      {
        sourceRecordId: "post:44791",
        url: JULY_7_URL,
        title: "2026.7.7 ナイトシーバス便",
        publicationDate: "2026-07-09"
      }
    ]);
  });

  it("deduplicates listing records by stable source identity", () => {
    const item = { postId: 44876, url: JULY_14_URL, title: "2026.7.14 ナイトシーバス便", published: "2026年7月19日" };
    expect(discoverUminekoRecords(listingFixture([item, item]), 10)).toHaveLength(1);
  });

  it("does not turn a non-seabass article into evidence", async () => {
    const result = await parse(detail({
      title: "2026.7.10 チニング便",
      body: "結果\nチヌ\n5枚キャッチ"
    }));
    expect(result.parsedEvents).toEqual([]);
    expect(result.ignoredSpecies).toContain("black-seabream");
    expect(result.diagnostics).toContain("no-japanese-seabass-catch-evidence");
  });

  it("parses the 2026-07-14-like result as 29 seabass catches", async () => {
    const event = firstEvent(await parse(july14Fixture()));
    expect(event.externalEvidencePayload.catchCount).toBe(29);
    expect(event.externalEvidencePayload.evidenceType).toBe("catch");
    expect(event.externalEvidencePayload.directFishEvidence).toBe(true);
    expect(event.extractionDiagnostics.sizeText).toBe("30〜48cmまで");
  });

  it("parses the 2026-07-07-like result as 22 seabass catches", async () => {
    expect(firstEvent(await parse(july7Fixture())).externalEvidencePayload.catchCount).toBe(22);
  });

  it("extracts the explicit completed 4-hour trip as 240 minutes", async () => {
    const event = firstEvent(await parse(july7Fixture()));
    expect(event.externalEvidencePayload.effort.durationMinutes).toBe(240);
    expect(event.extractionDiagnostics.durationText).toContain("4時間便でした");
  });

  it("does not replace actual duration with a later recommendation", async () => {
    const fixture = july7Fixture().replace("結果", "この先は5時間便がおすすめです。\n結果");
    expect(firstEvent(await parse(fixture)).externalEvidencePayload.effort.durationMinutes).toBe(240);
  });

  it("represents a date-only event as the full JST calendar-day interval", async () => {
    const evidence = firstEvent(await parse(july14Fixture())).externalEvidencePayload;
    expect(evidence.eventStartAt).toBe("2026-07-13T15:00:00.000Z");
    expect(evidence.eventEndAt).toBe("2026-07-14T14:59:59.999Z");
  });

  it("marks date-only and explicit night precision without inventing a clock", async () => {
    const evidence = firstEvent(await parse(july14Fixture())).externalEvidencePayload;
    expect(evidence.qualityFlags).toContain("event-time-day-only");
    expect(evidence.qualityFlags).toContain("event-daypart-night-explicit");
    expect(evidence.eventStartAt).not.toContain("10:00:00.000Z");
  });

  it("uses conservative JST end-of-day for date-only publication", async () => {
    const evidence = firstEvent(await parse(july14Fixture())).externalEvidencePayload;
    expect(evidence.publishedAt).toBe("2026-07-19T14:59:59.999Z");
    expect(evidence.qualityFlags).toContain("publication-time-day-only-conservative");
  });

  it("caps same-day date-only publication at collectedAt", async () => {
    const evidence = firstEvent(await parse(detail({
      title: "2026.8.16 ナイトシーバス便",
      body: "結果\nシーバス\n1本キャッチ",
      published: "2026年8月16日"
    }), SAME_DAY_COLLECTED_AT)).externalEvidencePayload;
    expect(evidence.publishedAt).toBe(SAME_DAY_COLLECTED_AT);
    expect(Date.parse(evidence.publishedAt)).toBeLessThanOrEqual(Date.parse(evidence.collectedAt));
    expect(evidence.qualityFlags).toContain("publication-time-day-only-conservative");
  });

  it("caps same-day date-only event end at collectedAt and remains valid", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.8.16 ナイトシーバス便",
      body: "結果\nシーバス\n1本キャッチ",
      published: "2026年8月16日"
    }), SAME_DAY_COLLECTED_AT));
    expect(event.externalEvidencePayload.eventStartAt).toBe("2026-08-15T15:00:00.000Z");
    expect(event.externalEvidencePayload.eventEndAt).toBe(SAME_DAY_COLLECTED_AT);
    expect(event.externalEvidencePayload.publishedAt).toBe(SAME_DAY_COLLECTED_AT);
    expect(event.externalEvidencePayload.qualityFlags).toContain("event-time-day-only");
  });

  it("uses an explicit publication datetime when the source provides one", async () => {
    const html = detail({
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n1本キャッチ",
      publicationHtml: '<time datetime="2026-07-19T08:30:00+09:00">2026年7月19日</time>'
    });
    const evidence = firstEvent(await parse(html)).externalEvidencePayload;
    expect(evidence.publishedAt).toBe("2026-07-18T23:30:00.000Z");
    expect(evidence.qualityFlags).not.toContain("publication-time-day-only-conservative");
  });

  it("does not treat a body time element as publication metadata", async () => {
    const html = detail({
      title: "2026.7.14 ナイトシーバス便",
      body: '<time datetime="2026-07-14T19:00:00+09:00">出船</time>\n結果\nシーバス\n1本キャッチ'
    });
    expect(firstEvent(await parse(html)).externalEvidencePayload.publishedAt).toBe("2026-07-19T14:59:59.999Z");
  });

  it("does not mix chinu or magochi results into the seabass count", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.7.14 ナイトシーバス便",
      body: "結果\nシーバス\n29本キャッチ\nチヌ 6枚\nマゴチ 2本キャッチ"
    })));
    expect(event.externalEvidencePayload.catchCount).toBe(29);
  });

  it("keeps incidental seabass as positive evidence on another target trip", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.7.14 チニング便",
      body: "チヌを狙いました。\n結果\nその他シーバス2本キャッチ"
    })));
    expect(event.externalEvidencePayload.catchCount).toBe(2);
    expect(event.externalEvidencePayload.effort.targetSpeciesExplicit).toBe(false);
  });

  it("extracts explicit guests and an explicitly catching captain", async () => {
    const event = firstEvent(await parse(july14Fixture()));
    expect(event.extractionDiagnostics.guestCount).toBe(3);
    expect(event.extractionDiagnostics.captainCatchCount).toBe(13);
    expect(event.externalEvidencePayload.effort.anglerCount).toBe(4);
  });

  it("keeps ambiguous angler count null", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.7.14 ナイトシーバス便",
      body: "数名で出船。\n結果\nシーバス\n3本キャッチ"
    })));
    expect(event.externalEvidencePayload.effort.anglerCount).toBeNull();
    expect(event.externalEvidencePayload.qualityFlags).toContain("effort-unknown");
  });

  it("uses the stable seabass-main event key", async () => {
    const evidence = firstEvent(await parse(july14Fixture())).externalEvidencePayload;
    expect(evidence.source.sourceEventKey).toBe("seabass-main");
    expect(evidence.sourceIdentity).toBe('["umineko","post:44876","seabass-main"]');
  });

  it("does not merge unresolved multiple seabass events", async () => {
    const result = await parse(detail({
      title: "2026.7.14 シーバス便",
      body: "結果\n午前 シーバス5本キャッチ\n午後 シーバス7本キャッチ"
    }));
    expect(result.parsedEvents).toEqual([]);
    expect(result.diagnostics).toContain("multiple-seabass-events-unresolved");
  });

  it("separates source-reported location from Wanoku inference", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.7.14 ナイトシーバス便",
      body: "三番瀬へ。\n結果\nシーバス\n8本キャッチ"
    })));
    expect(event.locationInference.sourceReported).toEqual({ rawLabel: "三番瀬", basis: "article-text" });
    expect(event.locationInference.selected.nodeId).toBe("funabashi-inner-01");
    expect(event.externalEvidencePayload.location.rawLabel).toBe("三番瀬");
  });

  it("never marks inferred location exact", async () => {
    const event = firstEvent(await parse(detail({
      title: "2026.7.14 ナイトシーバス便",
      body: "船橋周辺。\n結果\nシーバス\n8本キャッチ"
    })));
    expect(event.locationInference.selected.status).toBe("approximate");
    expect(event.externalEvidencePayload.location.mapping).toEqual({ method: "reviewed-manual", status: "approximate" });
  });

  it("leaves canonical mapping null when article location evidence is absent", async () => {
    const event = firstEvent(await parse(july14Fixture()));
    expect(event.locationInference.sourceReported.rawLabel).toBeNull();
    expect(event.locationInference.candidates).toContainEqual(expect.objectContaining({
      nodeId: "funabashi-inner-01",
      certainty: "low",
      reasons: ["operator-service-area"]
    }));
    expect(event.locationInference.selected).toBeNull();
    expect(event.externalEvidencePayload.location).toMatchObject({
      rawLabel: null,
      mappedNodeId: null,
      mapping: { method: "unknown", status: "unknown" }
    });
  });

  it("keeps catch evidence valid when mappedNodeId is null", async () => {
    const evidence = firstEvent(await parse(july14Fixture())).externalEvidencePayload;
    expect(evidence.location.mappedNodeId).toBeNull();
    expect(evidence.catchOutcome).toBe("positive");
    expect(evidence.qualityFlags).toContain("location-unknown");
  });

  it("produces a lowercase semantic hash and content-addressed evidence ID", async () => {
    const event = firstEvent(await parse(july14Fixture()));
    expect(event.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(event.evidenceId).toBe(`wanoku-seabass-evidence:${event.payloadHash}`);
  });

  it("keeps semantic ID stable across collection retries", async () => {
    const first = firstEvent(await parse(july14Fixture(), COLLECTED_AT));
    const second = firstEvent(await parse(july14Fixture(), "2026-08-16T06:00:00.000Z"));
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second.externalEvidencePayload.collectedAt).not.toBe(first.externalEvidencePayload.collectedAt);
  });

  it("is deterministic for identical HTML, URL, and collectedAt", async () => {
    expect(await parse(july7Fixture())).toEqual(await parse(july7Fixture()));
  });

  it("accepts exactly one preview mode and validates the recent limit", () => {
    expect(parseUminekoPreviewArgs(["--url", JULY_14_URL])).toMatchObject({ url: JULY_14_URL });
    expect(parseUminekoPreviewArgs(["--recent", "10"])).toEqual({ recent: 10 });
    expect(() => parseUminekoPreviewArgs([])).toThrow("exactly one");
    expect(() => parseUminekoPreviewArgs(["--recent", "11"])).toThrow("integer from 1 to 10");
  });

  it("fetches only the requested Umineko detail with GET", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(JULY_14_URL);
      expect(init.method).toBe("GET");
      return response(july14Fixture());
    });
    const result = await runUminekoEvidencePreview({ url: JULY_14_URL, collectedAt: COLLECTED_AT, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(firstEvent(result.records[0]).externalEvidencePayload.catchCount).toBe(29);
  });

  it("discovers and fetches recent details sequentially without retries", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(url);
      if (url === UMINEKO_LISTING_URL) {
        return response(listingFixture([
          { postId: 44876, url: JULY_14_URL, title: "2026.7.14 ナイトシーバス便", published: "2026年7月19日" },
          { postId: 44791, url: JULY_7_URL, title: "2026.7.7 ナイトシーバス便", published: "2026年7月9日" }
        ]));
      }
      return response(url === JULY_14_URL ? july14Fixture() : july7Fixture());
    });
    const result = await runUminekoEvidencePreview({ recent: 2, collectedAt: COLLECTED_AT, fetchImpl, delay: false });
    expect(calls).toEqual([UMINEKO_LISTING_URL, JULY_14_URL, JULY_7_URL]);
    expect(result.records).toHaveLength(2);
  });

  it("contains no Date.now, D1 write, admin ingestion, or internal Wanoku HTTP", () => {
    const source = readFileSync("scripts/wanoku-umineko-evidence-preview.mjs", "utf8");
    expect(source).not.toMatch(/Date\.now\s*\(/u);
    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM|DROP\s+TABLE)\b/iu);
    expect(source).not.toMatch(/wrangler\s+d1|\/admin\//iu);
    expect(source).not.toContain("wanoku-intel-worker.mtk0808.workers.dev");
  });
});

async function parse(html, collectedAt = COLLECTED_AT) {
  return parseUminekoDetail({ html, url: JULY_14_URL, collectedAt });
}

function firstEvent(result) {
  expect(result.parsedEvents).toHaveLength(1);
  return result.parsedEvents[0];
}

function july14Fixture() {
  return detail({
    postId: 44876,
    title: "2026.7.14 ナイトシーバス便",
    body: "初ゲスト3名様にて出船。\n結果\nシーバス\n30〜48cmまで\n29本キャッチ！\nゲスト3〜8本/1人\nせんちょ13本",
    published: "2026年7月19日"
  });
}

function july7Fixture() {
  return detail({
    postId: 44791,
    url: JULY_7_URL,
    title: "2026.7.7 ナイトシーバス便",
    body: "初チャレゲスト3名様含め、4時間便でしたので短時間勝負。\n結果\nシーバス\n30〜69cmまで\n22本キャッチ",
    published: "2026年7月9日"
  });
}

function detail({ postId = 12345, url = JULY_14_URL, title, body, published = "2026年7月19日", publicationHtml = null }) {
  const bodyHtml = body.split("\n").map((line) => `<p>${line}</p>`).join("");
  const articleId = postId === null ? "" : ` id="post-${postId}"`;
  return `<!doctype html>
    <link rel="canonical" href="${url}">
    <article${articleId} class="news">
      <h1 class="entry-title">${title}</h1>
      <div class="entry-content">${bodyHtml}<img src="/wp-content/example.jpg" alt=""></div><!-- .entry-content -->
      <footer class="entry-meta"><span class="date">${publicationHtml ?? published}</span></footer><!-- .entry-meta -->
    </article>`;
}

function listingFixture(records) {
  return `<div class="hpb-viewtype-simple hpb-posttype-news">${records.map((record, index) => `
    <article id="post-${record.postId ?? index + 1}" class="news">
      <header class="entry-header"><h4><a href="${record.url}">${record.title}</a></h4></header>
      <div class="entry-content"><p>short excerpt</p></div>
      <footer class="entry-meta"><span class="date">${record.published}</span></footer>
    </article>`).join("")}</div>`;
}

function response(html) {
  return { ok: true, status: 200, text: async () => html };
}
