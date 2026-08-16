import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildWakuwakuyaArticleEvidence,
  buildWakuwakuyaEvidencePreview,
  parseWakuwakuyaEvidencePreviewArgs,
  runWakuwakuyaEvidencePreview,
  validateWakuwakuyaExternalEvidenceInput
} from "../../../scripts/wanoku-wakuwakuya-evidence-preview.mjs";
import {
  parseWakuwakuyaRecord
} from "../../../scripts/wanoku-wakuwakuya-historical-audit.mjs";

const MONTH_URL = "https://wakuwakuya.jp/blog.php?f=m&mon=2026-06";
const COLLECTED_AT = "2026-08-16T09:00:00.000Z";

describe("Wanoku Wakuwakuya External Evidence Adapter v1", () => {
  it("requires a canonical month and accepts an explicit collection time", () => {
    expect(parseWakuwakuyaEvidencePreviewArgs([
      "--month",
      "2026-06",
      "--collected-at",
      COLLECTED_AT
    ])).toEqual({ month: "2026-06", collectedAt: COLLECTED_AT });
    expect(() => parseWakuwakuyaEvidencePreviewArgs([])).toThrow(/month/u);
    expect(() => parseWakuwakuyaEvidencePreviewArgs(["--month", "2026-6"])).toThrow(/YYYY-MM/u);
  });

  it("fetches the exact monthly page once and discovers section.frame articles", async () => {
    const fetchImpl = vi.fn(async () => response(monthFixture([
      sectionFixture({ id: 160001, body: "シーバス2本キャッチ。" }),
      sectionFixture({ id: 160002, date: "2026-06-06", heading: "午前カサゴ便", body: "カサゴ3匹キャッチ。" })
    ])));
    const preview = await runWakuwakuyaEvidencePreview({
      month: "2026-06",
      collectedAt: COLLECTED_AT,
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(MONTH_URL);
    expect(preview.summary).toMatchObject({ articlesDiscovered: 2, seabassRelevant: 1, evidenceGenerated: 1 });
  });

  it("uses the numeric detail identity and deterministic source event key", () => {
    const first = generatedArticle({ id: 160001, date: "2026-06-05", heading: "午前シーバス便", body: "シーバス2本キャッチ。" });
    const second = generatedArticle({ id: 160001, date: "2026-06-05", heading: "午前シーバス便", body: "シーバス2本キャッチ。" });
    expect(first.canonicalEvidence.source).toMatchObject({
      providerId: "wakuwakuya",
      sourceClass: "charter-or-guide-log",
      sourceRecordId: "post:160001",
      sourceEventKey: "2026-06-05-morning-seabass",
      sourceUrl: "https://wakuwakuya.jp/blog.php?f=d&id=160001"
    });
    expect(second.canonicalEvidence.source.sourceEventKey).toBe(first.canonicalEvidence.source.sourceEventKey);
  });

  it("selects one numeric article ID across multiple image variants", () => {
    const record = parseRecord({ imageIds: [160001, 160001, 160001] });
    expect(record.sourceRecordId).toBe("post:160001");
    expect(record.diagnostics).not.toContain("numeric-detail-id-ambiguous");
  });

  it("rejects multiple numeric article ID candidates in one article", () => {
    const record = parseRecord({ imageIds: [160001, 160002] });
    const result = buildWakuwakuyaArticleEvidence({ record, collectedAt: COLLECTED_AT });
    expect(record.sourceRecordId).toBeNull();
    expect(record.diagnostics).toContain("numeric-detail-id-ambiguous");
    expect(result.article).toMatchObject({ classification: "SKIPPED_AMBIGUOUS" });
  });

  it("skips unresolved numeric identities without a fallback", () => {
    const preview = buildPreview([
      sectionFixture({ id: null, body: "シーバス2本キャッチ。" })
    ]);
    expect(preview.articles[0]).toMatchObject({
      classification: "SKIPPED_AMBIGUOUS",
      sourceRecordId: null
    });
    expect(preview.articles[0].diagnostics).toContain("source-record-id-unresolved");
  });

  it("skips a duplicate source/event identity collision", () => {
    const preview = buildPreview([
      sectionFixture({ id: 160001, body: "シーバス2本キャッチ。" }),
      sectionFixture({ id: 160001, body: "シーバス3本キャッチ。" })
    ]);
    expect(preview.summary).toMatchObject({ evidenceGenerated: 0, skippedAmbiguous: 2 });
    expect(preview.articles.every((article) => article.diagnostics.includes("source-event-identity-collision"))).toBe(true);
  });

  it("keeps cancellation distinct from explicit zero", () => {
    const preview = buildPreview([
      sectionFixture({ body: "強風のため出船中止。シーバスの反応なし。" })
    ]);
    expect(preview.articles[0]).toMatchObject({ classification: "CANCELLED" });
    expect(preview.summary.explicitZero).toBe(0);
  });

  it("does not cancel a completed trip because prior cancellations are mentioned", () => {
    const article = generatedArticle({
      date: "2026-01-26",
      heading: "シーバス午前便",
      body: "強風で出船中止が2回続き、本日も危ぶまれたけれど何とか出船。港内でシーバスがポツポツヒットしました。"
    });
    expect(article.classification).toBe("GENERATED");
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "bite-or-contact",
      interaction: { present: true }
    });
  });

  it("builds exact numeric landed catch evidence", () => {
    const article = generatedArticle({ body: "シーバス2本キャッチ。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "catch",
      catchCount: 2,
      presenceSupport: "positive",
      catchOutcome: "positive",
      directFishEvidence: true
    });
  });

  it("does not convert a landed lower bound into an exact catch", () => {
    const article = generatedArticle({ body: "シーバス30本オーバーでした。" });
    expect(article.canonicalEvidence).toMatchObject({ evidenceType: "fish-observation", catchCount: null });
    expect(article.adapterMetadata.landedCountLowerBound).toBe(30);
    expect(article.adapterMetadata.sourceSemanticClass).toBe("landed-positive-lower-bound");
    expect(article.diagnostics).toContain("landed-count-lower-bound-not-representable");
  });

  it("preserves nonnumeric landed presence without inventing a count", () => {
    const article = generatedArticle({ body: "シーバスはポツポツ釣れて全員安打でした。" });
    expect(article.canonicalEvidence).toMatchObject({ evidenceType: "fish-observation", catchCount: null });
    expect(article.adapterMetadata.landedPositiveUnquantified).toBe(true);
    expect(article.adapterMetadata.sourceSemanticClass).toBe("landed-positive-unquantified");
  });

  it("represents nonnumeric interaction without inventing a count", () => {
    const article = generatedArticle({ body: "シーバスは終始ヒットが続きました。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "bite-or-contact",
      interaction: { present: true, count: null, countLowerBound: null }
    });
    expect(article.adapterMetadata.sourceSemanticClass).toBe("interaction-only");
  });

  it("keeps visible-only evidence distinct and does not promote it", () => {
    const preview = buildPreview([
      sectionFixture({ body: "シーバスの群れとボイルを確認しました。" })
    ]);
    expect(preview.articles[0]).toMatchObject({
      classification: "SKIPPED_NOT_REPRESENTABLE",
      adapterMetadata: { sourceSemanticClass: "visible-only" }
    });
    expect(preview.articles[0].diagnostics).toContain("visible-only-not-foundation-promoted");
  });

  it("preserves an exact interaction count separately from landed catch", () => {
    const article = generatedArticle({ body: "シーバス5ヒット2キャッチ。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "catch",
      catchCount: 2,
      interaction: { present: true, count: 5, countLowerBound: null }
    });
  });

  it("preserves an interaction lower bound", () => {
    const article = generatedArticle({ body: "シーバス7ヒット以上でした。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "bite-or-contact",
      interaction: { present: true, count: null, countLowerBound: 7 }
    });
  });

  it("maps bite and chase facts to Foundation interaction fields", () => {
    const bite = generatedArticle({ body: "シーバスのバイトがありました。" });
    const chase = generatedArticle({ id: 160002, body: "シーバスのチェイスを確認。" });
    expect(bite.canonicalEvidence.interaction).toMatchObject({ present: true, biteMentioned: true });
    expect(chase.canonicalEvidence.interaction).toMatchObject({ present: true, chaseMentioned: true });
  });

  it("keeps lost fish as interaction and never adds it to landed count", () => {
    const article = generatedArticle({ body: "シーバスがヒットするもラインブレイクでバラシ。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "bite-or-contact",
      catchCount: null,
      interaction: { present: true, count: null, lostFishMentioned: true }
    });
  });

  it("does not turn an ambiguous reaction into a hit", () => {
    const preview = buildPreview([
      sectionFixture({ body: "シーバス狙い。魚探の反応はあるものの生命感なし。" })
    ]);
    expect(preview.articles[0]).toMatchObject({ classification: "SKIPPED_AMBIGUOUS" });
    expect(preview.articles[0].diagnostics).toContain("ambiguous-reaction-not-contact");
  });

  it("does not treat bait leaving as a lost seabass", () => {
    const record = parseRecord({
      body: "シーバス狙いでしたがベイトが抜けたようで生命感なし。"
    });
    expect(record.lostFishMentioned).toBe(false);
  });

  it("does not mix another species count into seabass evidence", () => {
    const article = generatedArticle({
      body: "シーバス2本キャッチ。後半は移動してカサゴ狙いで10匹追加。"
    });
    expect(article.canonicalEvidence.catchCount).toBe(2);
  });

  it("keeps incidental seabass Evidence on a seabass event key", () => {
    const article = generatedArticle({
      heading: "午後マゴチ便",
      body: "マゴチ狙いの途中でシーバスが釣れた。"
    });
    expect(article.canonicalEvidence.effort.targetSpeciesExplicit).toBe(false);
    expect(article.sourceEventKey).toBe("2026-06-05-afternoon-seabass");
  });

  it("does not promote species-unknown interaction to seabass evidence", () => {
    const preview = buildPreview([
      sectionFixture({ heading: "午前乗合便", body: "魚探の反応があり5ヒット。" })
    ]);
    expect(preview.summary).toMatchObject({ seabassRelevant: 0, evidenceGenerated: 0 });
  });

  it("builds explicit trip zero only with explicit effort", () => {
    const article = generatedArticle({ body: "2名様でシーバス狙いに出船。最後までアタリなし、0本で終了でした。" });
    expect(article.canonicalEvidence).toMatchObject({
      evidenceType: "explicit-effort-zero-catch",
      presenceSupport: "none",
      catchOutcome: "explicit-zero",
      catchCount: 0,
      effort: { known: true, anglerCount: 2, targetSpeciesExplicit: true }
    });
  });

  it("does not preserve the former zero false positive when later seabass are landed", () => {
    const record = parseRecord({
      id: null,
      date: "2026-06-22",
      heading: "シーバス午後便",
      body: "シーバス狙いでしたがベイトが抜けたようで生命感なし。違うストラクチャーへ移動してセイゴがポツポツ。"
    });
    const result = buildWakuwakuyaArticleEvidence({ record, collectedAt: COLLECTED_AT });
    expect(record).toMatchObject({
      landedPositiveEvidence: true,
      explicitZeroCandidate: false,
      lostFishMentioned: false
    });
    expect(result.article).toMatchObject({
      classification: "SKIPPED_AMBIGUOUS",
      adapterMetadata: { sourceSemanticClass: "landed-positive-unquantified" }
    });
    expect(result.article.diagnostics).toContain("source-record-id-unresolved");
  });

  it("does not convert an early zero segment when the trip later catches", () => {
    const article = generatedArticle({ body: "シーバス狙い。最初は生命感なし。移動してシーバス2本キャッチ。" });
    expect(article.canonicalEvidence).toMatchObject({ evidenceType: "catch", catchCount: 2 });
    expect(article.adapterMetadata.zeroSegmentMentioned).toBe(true);
  });

  it("does not retroactively assume service-plan duration", () => {
    const unknown = generatedArticle({ body: "シーバス2本キャッチ。" });
    const explicit = generatedArticle({ id: 160002, body: "5時間のシーバス便で2本キャッチ。" });
    expect(unknown.canonicalEvidence.effort).toMatchObject({ known: false, durationMinutes: null });
    expect(explicit.canonicalEvidence.effort).toMatchObject({ known: true, durationMinutes: 300 });
  });

  it("uses angler count only when the article states it", () => {
    const unknown = generatedArticle({ body: "シーバス2本キャッチ。" });
    const explicit = generatedArticle({ id: 160002, body: "3名様でシーバス2本キャッチ。" });
    expect(unknown.canonicalEvidence.effort.anglerCount).toBeNull();
    expect(explicit.canonicalEvidence.effort.anglerCount).toBe(3);
  });

  it("uses a JST date-only interval capped by collectedAt", () => {
    const historical = generatedArticle({ date: "2026-06-05", body: "シーバス2本キャッチ。" });
    const sameDay = generatedArticle({
      id: 160002,
      date: "2026-08-16",
      body: "シーバス2本キャッチ。",
      collectedAt: COLLECTED_AT
    });
    expect(historical.canonicalEvidence).toMatchObject({
      eventStartAt: "2026-06-04T15:00:00.000Z",
      eventEndAt: "2026-06-05T14:59:59.999Z"
    });
    expect(sameDay.canonicalEvidence).toMatchObject({
      eventStartAt: "2026-08-15T15:00:00.000Z",
      eventEndAt: COLLECTED_AT
    });
  });

  it("does not invent clock time from morning, afternoon, night, or long", () => {
    for (const [heading, daypart] of [
      ["午前シーバス便", "morning"],
      ["午後シーバス便", "afternoon"],
      ["ナイトシーバス便", "night"],
      ["シーバスロング便", "long"]
    ]) {
      const article = generatedArticle({ heading, body: "シーバス2本キャッチ。" });
      expect(article.adapterMetadata.daypart).toBe(daypart);
      expect(article.canonicalEvidence.eventStartAt).toBe("2026-06-04T15:00:00.000Z");
    }
  });

  it("does not apply monthly metadata as trip publication time", () => {
    const preview = buildWakuwakuyaEvidencePreview({
      html: `<meta property="article:published_time" content="2026-06-30T00:00:00+09:00">${monthFixture([
        sectionFixture({ body: "シーバス2本キャッチ。" })
      ])}`,
      url: MONTH_URL,
      sourceMonth: "2026-06",
      collectedAt: COLLECTED_AT
    });
    expect(preview.articles[0].canonicalEvidence.publishedAt).toBeNull();
    expect(preview.articles[0].diagnostics).toContain("trip-publication-time-unavailable");
  });

  it("keeps location unknown while preserving an explicit raw label", () => {
    const article = generatedArticle({ body: "東京湾奥でシーバス2本キャッチ。" });
    expect(article.canonicalEvidence.location).toEqual({
      rawLabel: "東京湾奥",
      latitude: null,
      longitude: null,
      mappedNodeId: null,
      mapping: { method: "unknown", status: "unknown" }
    });
  });

  it("keeps condition changes in adapter metadata only", () => {
    const article = generatedArticle({ body: "シーバス狙い。ポイント移動してアタリが増えて連続ヒット。" });
    expect(article.adapterMetadata.conditionChanges).toEqual([
      { type: "location-change", outcomeBeforeAfterResolvable: true }
    ]);
    expect(article.externalEvidenceInput).not.toHaveProperty("conditionChanges");
  });

  it("keeps habitat clues in adapter metadata only", () => {
    const article = generatedArticle({ body: "橋脚の穴撃ちでシーバス2本キャッチ。" });
    expect(article.adapterMetadata.habitatClues).toEqual(expect.arrayContaining(["structure", "hole"]));
    expect(article.externalEvidenceInput).not.toHaveProperty("habitatClues");
  });

  it("keeps visible-fish facts in adapter metadata without extending Foundation", () => {
    const article = generatedArticle({ body: "シーバスの群れとボイルを確認し2本キャッチ。" });
    expect(article.adapterMetadata.visibleFishMentioned).toBe(true);
    expect(article.externalEvidenceInput).not.toHaveProperty("visibleFishMentioned");
  });

  it("changes semantic identity for interaction and catch corrections", () => {
    const article = generatedArticle({ body: "シーバス2本キャッチ。" });
    const interactionCorrection = structuredClone(article.externalEvidenceInput);
    interactionCorrection.interaction.present = true;
    interactionCorrection.interaction.biteMentioned = true;
    const catchCorrection = structuredClone(article.externalEvidenceInput);
    catchCorrection.catchCount = 3;
    expect(validateWakuwakuyaExternalEvidenceInput(interactionCorrection).evidenceId).not.toBe(article.evidenceId);
    expect(validateWakuwakuyaExternalEvidenceInput(catchCorrection).evidenceId).not.toBe(article.evidenceId);
  });

  it("keeps semantic identity stable across collectedAt and extractorVersion changes", () => {
    const article = generatedArticle({ body: "シーバス2本キャッチ。" });
    const collectedAtRevision = structuredClone(article.externalEvidenceInput);
    collectedAtRevision.collectedAt = "2026-08-16T10:00:00.000Z";
    const extractorRevision = structuredClone(article.externalEvidenceInput);
    extractorRevision.provenance.extractorVersion = "wanoku-wakuwakuya-evidence-adapter.v2-test";
    expect(validateWakuwakuyaExternalEvidenceInput(collectedAtRevision).evidenceId).toBe(article.evidenceId);
    expect(validateWakuwakuyaExternalEvidenceInput(extractorRevision).evidenceId).toBe(article.evidenceId);
  });

  it("keeps adapter-only condition and habitat changes out of semantic identity", () => {
    const article = generatedArticle({ body: "シーバス2本キャッチ。" });
    const changed = structuredClone(article);
    changed.adapterMetadata.conditionChanges = [{ type: "wind-change", outcomeBeforeAfterResolvable: false }];
    changed.adapterMetadata.habitatClues = ["harbor"];
    expect(changed.evidenceId).toBe(article.evidenceId);
    expect(changed.semanticHash).toBe(article.semanticHash);
  });

  it("passes the canonical Foundation builder and separates admin input from completed evidence", () => {
    const article = generatedArticle({ body: "シーバス5ヒット2キャッチ。" });
    const validation = validateWakuwakuyaExternalEvidenceInput(article.externalEvidenceInput);
    expect(validation).toMatchObject({ valid: true, errors: [], evidenceId: article.evidenceId });
    expect(article.externalEvidenceInput).not.toHaveProperty("sourceIdentity");
    expect(article.canonicalEvidence.sourceIdentity).toBe(
      JSON.stringify(["wakuwakuya", "post:160001", "2026-06-05-morning-seabass"])
    );
  });

  it("is deterministic for the same source HTML and collectedAt", () => {
    const sections = [sectionFixture({ body: "シーバス5ヒット2キャッチ。橋脚を移動。" })];
    expect(buildPreview(sections)).toEqual(buildPreview(sections));
  });

  it("reports all four relevant-article convertibility classifications", () => {
    const preview = buildPreview([
      sectionFixture({ id: 160001, body: "シーバス2本キャッチ。" }),
      sectionFixture({ id: 160002, date: "2026-06-06", body: "シーバスを探して各所を回りました。" }),
      sectionFixture({ id: 160003, date: "2026-06-07", body: "シーバス狙い。魚探の反応はあるものの生命感なし。" }),
      sectionFixture({ id: 160004, date: "2026-06-08", body: "強風でシーバス便は出船中止。" })
    ]);
    expect(preview.articles.map((article) => article.classification)).toEqual([
      "GENERATED",
      "SKIPPED_NOT_REPRESENTABLE",
      "SKIPPED_AMBIGUOUS",
      "CANCELLED"
    ]);
  });

  it("contains no persistence, D1, admin POST, or generic batch path", () => {
    const source = readFileSync(
      new URL("../../../scripts/wanoku-wakuwakuya-evidence-preview.mjs", import.meta.url),
      "utf8"
    );
    expect(source).not.toMatch(/\/admin\/evidence|wrangler|\bD1\b|\bINSERT\b|method:\s*["']POST["']/iu);
    expect(source).not.toMatch(/--apply|--execute/iu);
  });
});

function generatedArticle(options = {}) {
  const collectedAt = options.collectedAt ?? COLLECTED_AT;
  const record = parseRecord(options);
  const result = buildWakuwakuyaArticleEvidence({ record, collectedAt });
  expect(result.ok, JSON.stringify(result.article?.diagnostics ?? [])).toBe(true);
  return result.article;
}

function parseRecord({
  id = 160001,
  imageIds,
  date = "2026-06-05",
  heading = "午前シーバス便",
  body = "シーバスを探して出船しました。"
} = {}) {
  return parseWakuwakuyaRecord({
    sectionHtml: sectionFixture({ id, imageIds, date, heading, body, includeSection: false }),
    sourceUrl: MONTH_URL,
    sourceMonth: date.slice(0, 7)
  });
}

function buildPreview(sections) {
  return buildWakuwakuyaEvidencePreview({
    html: monthFixture(sections),
    url: MONTH_URL,
    sourceMonth: "2026-06",
    collectedAt: COLLECTED_AT
  });
}

function monthFixture(sections) {
  return `<html><body>${sections.join("")}</body></html>`;
}

function sectionFixture({
  id = 160001,
  imageIds,
  date = "2026-06-05",
  heading = "午前シーバス便",
  body = "シーバスを探して出船しました。",
  includeSection = true
} = {}) {
  const [year, month, day] = date.split("-").map(Number);
  const resolvedImageIds = imageIds ?? (id ? [id] : []);
  const content = `
    <h2><time>${year}年${month}月${day}日(金)</time>${heading}</h2>
    <div class="frame-inner"><p>${body}</p>
      ${resolvedImageIds.map((imageId, index) => `<img src="https://choka.fishing-v.jp/funayado_images/62_${imageId}_2026060512000${index}_${index + 1}.jpeg">`).join("")}
    </div>`;
  return includeSection ? `<section class="frame">${content}</section>` : content;
}

function response(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html };
}
