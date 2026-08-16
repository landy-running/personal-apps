import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildSeabassExternalEvidence } from "../../../packages/wanoku-core/src/external-evidence.ts";
import { hashSeabassExternalEvidence } from "./external-evidence-persistence.js";
import {
  KACHIDOKI_EVIDENCE_ADAPTER_VERSION,
  buildKachidokiEvidencePreview,
  parseKachidokiEvidencePreviewArgs,
  runKachidokiEvidencePreview
} from "../../../scripts/wanoku-kachidoki-evidence-preview.mjs";

const SOURCE_URL = "https://kachidoki-marina.com/fishing-results-202606/";
const COLLECTED_AT = "2026-08-16T02:00:00.000Z";

describe("Wanoku Kachidoki Marina External Evidence Adapter v1", () => {
  it("requires and parses an explicit source month", () => {
    expect(parseKachidokiEvidencePreviewArgs(["--month", "2026-06", "--collected-at", COLLECTED_AT]))
      .toEqual({ month: "2026-06", collectedAt: COLLECTED_AT });
    expect(() => parseKachidokiEvidencePreviewArgs([])).toThrow("--month YYYY-MM is required");
    expect(() => parseKachidokiEvidencePreviewArgs(["--month", "2026-13"])).toThrow("month must be YYYY-MM");
  });

  it("uses the monthly article numeric ID as sourceRecordId", () => {
    const result = preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]);

    expect(result.source.sourceRecordId).toBe("post:5470");
    expect(firstTrip(result).canonicalEvidence.source.sourceRecordId).toBe("post:5470");
  });

  it("discovers trips only from figure.slide captions", () => {
    const html = monthPage({
      entries: [
        trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get"),
        trip("6/25（木）チョイノリ【DAY】<br>シーバス 3get")
      ],
      extra: '<figcaption class="slide-title">6/26（金）チョイノリ【DAY】 シーバス 9get</figcaption>'
    });
    const result = build(html);

    expect(result.summary.discoveredTripCount).toBe(2);
    expect(result.summary.evidenceGeneratedCount).toBe(2);
  });

  it("derives a deterministic sourceEventKey without catch content", () => {
    const first = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const second = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 6hit 4get")]));

    expect(first.sourceEventKey).toBe("2026-06-24-night-seabass");
    expect(second.sourceEventKey).toBe(first.sourceEventKey);
  });

  it("skips every trip when a stable sourceEventKey collision is ambiguous", () => {
    const result = preview([
      trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get"),
      trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 3hit 2get")
    ]);

    expect(result.parsedTrips).toHaveLength(0);
    expect(result.ignoredTrips).toHaveLength(2);
    expect(result.ignoredTrips.every((item) => item.diagnostics.includes("source-event-identity-ambiguous"))).toBe(true);
  });

  it("keeps source identity stable while catch correction changes semantic ID", () => {
    const before = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const after = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 6hit 4get")]));

    expect(after.canonicalEvidence.sourceIdentity).toBe(before.canonicalEvidence.sourceIdentity);
    expect(after.evidenceId).not.toBe(before.evidenceId);
  });

  it("builds one catch Evidence for 5hit 4get", () => {
    const evidence = evidenceFor("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get");

    expect(evidence).toMatchObject({
      schemaVersion: "wanoku-seabass-external-evidence.v1.1",
      evidenceType: "catch",
      presenceSupport: "positive",
      catchOutcome: "positive",
      directFishEvidence: true,
      catchCount: 4,
      interaction: { present: true, count: 5, countLowerBound: null }
    });
  });

  it("keeps 20HIT以上 as a lower bound with exact 9GET", () => {
    const evidence = evidenceFor("6/19（金）チョイノリ【NIGHT】<br>シーバス 20HIT以上 9GET");

    expect(evidence.catchCount).toBe(9);
    expect(evidence.interaction).toMatchObject({ present: true, count: null, countLowerBound: 20 });
  });

  it.each(["hit多数", "HIT連発"])("keeps nonnumeric %s interaction positive without inventing a count", (wording) => {
    const interaction = evidenceFor(`6/21（日）チョイノリ【NIGHT】<br>シーバス ${wording} 4get`).interaction;

    expect(interaction).toMatchObject({ present: true, count: null, countLowerBound: null });
  });

  it("leaves interaction unknown for numeric GET without hit detail", () => {
    const evidence = evidenceFor("6/18（木）チョイノリ【DAY】<br>シーバス 3get");

    expect(evidence.catchCount).toBe(3);
    expect(evidence.interaction).toEqual(unknownInteraction());
  });

  it("sets biteMentioned only for a seabass-scoped bite", () => {
    const interaction = evidenceFor("6/18（木）チョイノリ【DAY】<br>シーバス 3get 水面バイト").interaction;

    expect(interaction).toMatchObject({ present: true, biteMentioned: true });
  });

  it("sets chaseMentioned only for a seabass-scoped chase", () => {
    const interaction = evidenceFor("6/18（木）チョイノリ【DAY】<br>シーバス 3get チェイス").interaction;

    expect(interaction).toMatchObject({ present: true, chaseMentioned: true });
  });

  it("sets lostFishMentioned without adding it to landed catch", () => {
    const evidence = evidenceFor("6/18（木）チョイノリ【DAY】<br>シーバス 3get バラシあり");

    expect(evidence.catchCount).toBe(3);
    expect(evidence.interaction).toMatchObject({ present: true, lostFishMentioned: true });
  });

  it("does not mix another species interaction into seabass", () => {
    const evidence = evidenceFor(
      "6/18（木）チョイノリ【DAY】<br>シーバス 2get クロダイ 8hit 水面バイト チェイス バラシ"
    );

    expect(evidence.catchCount).toBe(2);
    expect(evidence.interaction).toEqual(unknownInteraction());
  });

  it("represents an incidental seabass catch without claiming targeted effort", () => {
    const evidence = evidenceFor("6/18（木）チョイノリ【DAY】<br>クロダイ 4get シーバス 2get");

    expect(evidence.catchCount).toBe(2);
    expect(evidence.effort.targetSpeciesExplicit).toBe(false);
  });

  it("represents attributed incidental seabass contact without claiming targeted effort", () => {
    const evidence = evidenceFor("6/18（木）チョイノリ【DAY】<br>クロダイ 4get シーバス 2hit");

    expect(evidence).toMatchObject({
      evidenceType: "bite-or-contact",
      catchCount: null,
      interaction: { present: true, count: 2 },
      effort: { targetSpeciesExplicit: false }
    });
  });

  it("builds bite-or-contact Evidence for attributed seabass hit without catch", () => {
    const evidence = evidenceFor("6/22（月）チョイノリ【DAY】<br>シーバス 5hit");

    expect(evidence).toMatchObject({
      evidenceType: "bite-or-contact",
      catchOutcome: "unknown",
      catchCount: null,
      interaction: { present: true, count: 5 }
    });
  });

  it("builds bite-or-contact Evidence for an explicit seabass bite without catch", () => {
    const evidence = evidenceFor("6/22（月）チョイノリ【DAY】<br>シーバス 水面バイト");

    expect(evidence).toMatchObject({
      evidenceType: "bite-or-contact",
      catchCount: null,
      interaction: { present: true, count: null, biteMentioned: true }
    });
  });

  it("builds explicit-effort-zero-catch only from explicit targeted zero", () => {
    const evidence = evidenceFor(
      "6/4（木）チョイノリ【NIGHT】<br>後半戦のシーバスへ。シーバスは次回へ持ち越し。"
    );

    expect(evidence).toMatchObject({
      evidenceType: "explicit-effort-zero-catch",
      presenceSupport: "none",
      catchOutcome: "explicit-zero",
      directFishEvidence: false,
      catchCount: 0,
      interaction: { present: null }
    });
  });

  it("allows explicit landed zero to coexist with positive interaction", () => {
    const evidence = evidenceFor(
      "6/4（木）チョイノリ【NIGHT】<br>後半戦のシーバスへ。シーバス 5hit 0get、シーバスは次回へ持ち越し。"
    );

    expect(evidence).toMatchObject({
      evidenceType: "explicit-effort-zero-catch",
      catchCount: 0,
      interaction: { present: true, count: 5 }
    });
  });

  it("skips cancelled trips instead of converting them to zero", () => {
    const result = preview([trip("6/28（日）チョイノリ【DAY】<br>シーバス狙い、強風のため出船中止")]);

    expect(result.parsedTrips).toHaveLength(0);
    expect(result.ignoredTrips[0].diagnostics).toContain("trip-cancelled");
  });

  it("does not convert no-report or another-species-only content to zero", () => {
    const result = preview([
      trip("6/27（土）チョイノリ【DAY】<br>釣果情報なし"),
      trip("6/28（日）チョイノリ【NIGHT】<br>クロダイ 2get")
    ]);

    expect(result.parsedTrips).toHaveLength(0);
    expect(result.summary.explicitZeroCount).toBe(0);
  });

  it("uses 120 minutes only for the unambiguous standard choinori plan", () => {
    const evidence = evidenceFor("6/18（木）チョイノリ【DAY】<br>シーバス 3get");

    expect(evidence.effort).toMatchObject({ known: true, durationMinutes: 120 });
  });

  it("uses the explicit combo duration instead of treating it as standard two-hour", () => {
    const evidence = evidenceFor("6/18（木）チョイノリコンボ4【DAY】<br>シーバス 3get");

    expect(evidence.effort).toMatchObject({ known: true, durationMinutes: 240 });
  });

  it("keeps duration unknown when plan identity is unknown", () => {
    const evidence = evidenceFor("6/18（木）乗合便【DAY】<br>シーバス 3get");

    expect(evidence.effort).toMatchObject({ known: false, durationMinutes: null });
    expect(evidence.qualityFlags).toContain("effort-unknown");
  });

  it("uses an explicitly written angler count and never infers one from capacity", () => {
    const explicit = evidenceFor("6/18（木）乗合便【DAY】<br>ゲスト3名 シーバス 3get");
    const absent = evidenceFor("6/18（木）乗合便【DAY】<br>シーバス 3get");

    expect(explicit.effort.anglerCount).toBe(3);
    expect(absent.effort.anglerCount).toBeNull();
  });

  it("uses the JST calendar-day interval capped at collectedAt", () => {
    const historical = evidenceFor("6/24（水）チョイノリ【DAY】<br>シーバス 3get");
    const sameDay = evidenceFor(
      "6/24（水）チョイノリ【DAY】<br>シーバス 3get",
      { collectedAt: "2026-06-24T06:00:00.000Z" }
    );

    expect(historical.eventStartAt).toBe("2026-06-23T15:00:00.000Z");
    expect(historical.eventEndAt).toBe("2026-06-24T14:59:59.999Z");
    expect(sameDay.eventEndAt).toBe("2026-06-24T06:00:00.000Z");
  });

  it.each(["DAY", "NIGHT"])("does not turn %s into an invented clock time", (daypart) => {
    const evidence = evidenceFor(`6/24（水）チョイノリ【${daypart}】<br>シーバス 3get`);

    expect(evidence.eventStartAt).toBe("2026-06-23T15:00:00.000Z");
    expect(evidence.eventEndAt).toBe("2026-06-24T14:59:59.999Z");
  });

  it("is deterministic for the same HTML and explicit collectedAt", () => {
    const entries = [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")];

    expect(preview(entries)).toEqual(preview(entries));
  });

  it("skips one future-dated trip without losing an earlier valid trip", () => {
    const result = preview([
      trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get"),
      trip("6/18（木）チョイノリ【DAY】<br>シーバス 3get")
    ], { collectedAt: "2026-06-20T00:00:00.000Z" });

    expect(result.parsedTrips).toHaveLength(1);
    expect(result.parsedTrips[0].sourceEventKey).toBe("2026-06-18-day-seabass");
    expect(result.ignoredTrips[0].diagnostics).toContain("future_event");
  });

  it("keeps source location as raw fact and leaves Habitat mapping unknown", () => {
    const evidence = evidenceFor("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get 東京湾");

    expect(evidence.location).toEqual({
      rawLabel: "東京湾",
      latitude: null,
      longitude: null,
      mappedNodeId: null,
      mapping: { method: "unknown", status: "unknown" }
    });
  });

  it("separates the exact admin create input from completed canonical Evidence", async () => {
    const result = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const validation = buildSeabassExternalEvidence(result.externalEvidenceInput);
    const canonical = await hashSeabassExternalEvidence(validation.evidence);

    expect(result.externalEvidenceInput).not.toHaveProperty("sourceIdentity");
    expect(result.externalEvidenceInput).not.toHaveProperty("evidenceId");
    expect(result.externalEvidenceInput).not.toHaveProperty("payloadHash");
    expect(result.externalEvidenceInput).not.toHaveProperty("storedAt");
    expect(result.externalEvidenceInput).not.toHaveProperty("created");
    expect(result.canonicalEvidence.schemaVersion).toBe("wanoku-seabass-external-evidence.v1.1");
    expect(result.canonicalEvidence.sourceIdentity).toBe('["kachidoki-marina","post:5470","2026-06-24-night-seabass"]');
    expect(Object.keys(result.canonicalEvidence).filter((key) => !(key in result.externalEvidenceInput)))
      .toEqual(["sourceIdentity"]);
    expect(validation).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(validation.evidence).toEqual(result.canonicalEvidence);
    expect(result.externalEvidenceInput).toMatchObject({
      catchCount: 4,
      interaction: { present: true, count: 5, countLowerBound: null }
    });
    expect(canonical.payloadHash).toBe("b3ceb2bba24813621a3f0000b70a54c09f1dba06a1cc76318074309fe90b1ba2");
    expect(canonical.evidenceId).toBe("wanoku-seabass-evidence:b3ceb2bba24813621a3f0000b70a54c09f1dba06a1cc76318074309fe90b1ba2");
    expect(result.semanticHash).toBe(canonical.payloadHash);
    expect(result.evidenceId).toBe(canonical.evidenceId);
  });

  it("matches the existing canonical External Evidence hash and ID implementation", async () => {
    const result = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const canonical = await hashSeabassExternalEvidence(result.canonicalEvidence);

    expect(result.semanticHash).toBe(canonical.payloadHash);
    expect(result.evidenceId).toBe(canonical.evidenceId);
  });

  it("changes semantic ID for interaction revision while keeping source identity", () => {
    const five = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const six = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 6hit 4get")]));

    expect(six.canonicalEvidence.sourceIdentity).toBe(five.canonicalEvidence.sourceIdentity);
    expect(six.evidenceId).not.toBe(five.evidenceId);
  });

  it("keeps semantic ID stable when only collectedAt changes", () => {
    const first = firstTrip(preview([trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]));
    const second = firstTrip(preview(
      [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")],
      { collectedAt: "2026-08-17T02:00:00.000Z" }
    ));

    expect(second.externalEvidenceInput).not.toHaveProperty("sourceIdentity");
    expect(second.canonicalEvidence.collectedAt).not.toBe(first.canonicalEvidence.collectedAt);
    expect(second.evidenceId).toBe(first.evidenceId);
  });

  it("keeps semantic ID stable when only extractorVersion changes", async () => {
    const evidence = evidenceFor("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get");
    const changed = structuredClone(evidence);
    changed.provenance.extractorVersion = `${KACHIDOKI_EVIDENCE_ADAPTER_VERSION}.revision`;

    expect((await hashSeabassExternalEvidence(changed)).evidenceId)
      .toBe((await hashSeabassExternalEvidence(evidence)).evidenceId);
  });

  it("requires numeric page identity and skips fallback month identity", () => {
    const result = build(monthPage({
      postId: null,
      entries: [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]
    }));

    expect(result.source.sourceRecordId).toBeNull();
    expect(result.parsedTrips).toHaveLength(0);
    expect(result.ignoredTrips[0].diagnostics).toContain("source-record-id-numeric-required");
  });

  it("does not use monthly page publication metadata as a trip timestamp", () => {
    const evidence = evidenceFor("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get");

    expect(evidence.publishedAt).toBeNull();
    expect(evidence.qualityFlags).toContain("publication-time-unknown");
  });

  it("keeps source identity and semantic ID stable when ambiguous page metadata changes", () => {
    const first = firstTrip(build(monthPage({
      publishedAt: "2026-07-01T16:05:12+09:00",
      entries: [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]
    })));
    const second = firstTrip(build(monthPage({
      publishedAt: "2026-07-02T16:05:12+09:00",
      entries: [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]
    })));

    expect(second.canonicalEvidence.publishedAt).toBeNull();
    expect(second.canonicalEvidence.sourceIdentity).toBe(first.canonicalEvidence.sourceIdentity);
    expect(second.evidenceId).toBe(first.evidenceId);
  });

  it("performs official GET-only preview fetches with no Worker POST or D1 access", async () => {
    const html = monthPage({
      options: '<option value="202606">2026年06月</option>',
      entries: [trip("6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get")]
    });
    const fetchImpl = vi.fn(async (_url, options) => ({ ok: true, status: 200, text: async () => html, options }));
    const result = await runKachidokiEvidencePreview({ month: "2026-06", collectedAt: COLLECTED_AT, fetchImpl });

    expect(result.summary.evidenceGeneratedCount).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://kachidoki-marina.com/fishing-results/");
    expect(fetchImpl.mock.calls[0][1]?.method).toBeUndefined();

    const script = readFileSync(new URL("../../../scripts/wanoku-kachidoki-evidence-preview.mjs", import.meta.url), "utf8");
    expect(script).not.toMatch(/wrangler\s+d1|\/admin\/evidence|method:\s*["']POST["']/iu);
  });
});

function evidenceFor(caption, options = {}) {
  return firstTrip(preview([trip(caption)], options)).canonicalEvidence;
}

function firstTrip(result) {
  if (result.parsedTrips.length !== 1) throw new Error(`Expected one parsed trip, got ${result.parsedTrips.length}.`);
  return result.parsedTrips[0];
}

function preview(entries, options = {}) {
  return build(monthPage({ entries }), options);
}

function build(html, options = {}) {
  return buildKachidokiEvidencePreview({
    html,
    url: SOURCE_URL,
    sourceYear: 2026,
    sourceMonth: 6,
    collectedAt: options.collectedAt ?? COLLECTED_AT
  });
}

function monthPage({
  postId = 5470,
  publishedAt = "2026-07-01T16:05:12+09:00",
  options = "",
  entries = [],
  extra = ""
} = {}) {
  const articleId = postId === null ? "" : ` id="post-${postId}"`;
  return `
    <meta property="article:published_time" content="${publishedAt}">
    <meta property="article:modified_time" content="2026-08-12T14:25:51+09:00">
    <article${articleId} class="article page">
      <select>${options}</select>
      <div class="swiper-wrapper">${entries.join("")}</div>
      ${extra}
    </article>`;
}

function trip(captionHtml) {
  return `<div class="swiper-slide"><figure class="slide"><div class="slide-media"></div><figcaption class="slide-title">${captionHtml}</figcaption></figure></div>`;
}

function unknownInteraction() {
  return {
    present: null,
    count: null,
    countLowerBound: null,
    biteMentioned: false,
    chaseMentioned: false,
    lostFishMentioned: false
  };
}
