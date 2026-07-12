import { describe, expect, it } from "vitest";
import {
  calculateFreshness,
  findConflictingEvidence,
  findDuplicateCandidates,
  scoreEvidenceReliability,
  validateEvidenceEvent,
  type EvidenceEvent,
  type EvidenceSource
} from "./intelligence";

const shopSource: EvidenceSource = {
  id: "shop-alpha",
  name: "湾奥釣具店",
  kind: "shop",
  reliabilityPrior: 0.82,
  url: "https://example.com/shop"
};

const snsSource: EvidenceSource = {
  id: "sns-manual",
  name: "手動投入SNS",
  kind: "sns",
  reliabilityPrior: 0.55
};

function event(overrides: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    id: "ev-1",
    source: shopSource,
    sourceId: "post-1",
    observedAt: "2026-07-10T20:30:00+09:00",
    publishedAt: "2026-07-10T22:00:00+09:00",
    species: [{ species: "シーバス", count: 1, sizeCm: 62 }],
    location: { label: "荒川河口 明暗", lat: 35.642, lon: 139.849, radiusM: 500, confidence: 0.8 },
    locationConfidence: 0.78,
    sourceReliability: 0.8,
    timeConfidence: 0.9,
    freshness: 0.9,
    duplicateGroupId: "grp-a",
    evidenceUrl: "https://example.com/shop/catch/1",
    title: "荒川河口でシーバス",
    rawText: "7/10夜、荒川河口の明暗でシーバス62cmをキャッチ",
    extractedFacts: ["実釣は7/10夜", "シーバス62cm", "荒川河口の明暗"],
    ...overrides
  };
}

describe("wanoku intelligence evidence validation", () => {
  it("accepts a complete EvidenceEvent", () => {
    const result = validateEvidenceEvent(event());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects missing required time/species/location fields", () => {
    const broken = event({
      publishedAt: "not-a-date",
      species: [],
      location: { label: "", confidence: 1.2 },
      locationConfidence: -0.1
    });

    const result = validateEvidenceEvent(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("publishedAt");
    expect(result.errors.join("\n")).toContain("species");
    expect(result.errors.join("\n")).toContain("location.label");
    expect(result.errors.join("\n")).toContain("locationConfidence");
  });
});

describe("wanoku intelligence freshness and reliability", () => {
  it("uses observedAt before publishedAt for freshness", () => {
    const observed = event({ observedAt: "2026-07-10T20:00:00+09:00", publishedAt: "2026-07-11T12:00:00+09:00" });
    const freshness = calculateFreshness(observed, "2026-07-11T20:00:00+09:00");

    expect(freshness.timeBasis).toBe("observedAt");
    expect(freshness.ageHours).toBeCloseTo(24, 5);
    expect(freshness.score).toBeLessThan(0.5);
  });

  it("penalizes uncertainty when observedAt is missing", () => {
    const noObserved = event({ observedAt: undefined, publishedAt: "2026-07-11T12:00:00+09:00" });
    const freshness = calculateFreshness(noObserved, "2026-07-11T20:00:00+09:00");

    expect(freshness.timeBasis).toBe("publishedAt");
    expect(freshness.uncertaintyPenalty).toBeLessThan(1);
  });

  it("decays old evidence strongly", () => {
    const old = event({ observedAt: "2026-06-01T20:00:00+09:00", publishedAt: "2026-06-02T10:00:00+09:00" });
    const freshness = calculateFreshness(old, "2026-07-11T20:00:00+09:00");

    expect(freshness.score).toBeLessThan(0.05);
  });

  it("returns reliability as components, not only total score", () => {
    const repost = event({
      id: "ev-repost",
      source: snsSource,
      sourceReliability: 0.5,
      rawText: "釣具店投稿から転載。シーバス62cm。",
      extractedFacts: ["転載", "シーバス62cm"]
    });
    const result = scoreEvidenceReliability(repost, [event()], "2026-07-11T00:00:00+09:00");

    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.components.sourceReliability).toBeLessThan(0.7);
    expect(result.components.repostPenalty).toBeGreaterThan(0);
    expect(result.weights.freshness).toBeGreaterThan(0);
  });
});

describe("wanoku intelligence duplicate and conflict detection", () => {
  it("returns duplicate candidates instead of auto-merging", () => {
    const original = event({ id: "ev-original", sourceId: "post-1" });
    const repost = event({
      id: "ev-repost",
      source: snsSource,
      sourceId: "share-1",
      duplicateGroupId: undefined,
      evidenceUrl: "https://example.com/sns/repost",
      rawText: "湾奥釣具店の釣果を引用。荒川河口でシーバス62cm。",
      extractedFacts: ["引用", "シーバス62cm", "荒川河口"]
    });

    const candidates = findDuplicateCandidates([original, repost]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].leftId).toBe("ev-original");
    expect(candidates[0].rightId).toBe("ev-repost");
    expect(candidates[0].score).toBeGreaterThan(0.42);
    expect(candidates[0].confidence).not.toBe("exact");
  });

  it("detects exact duplicate by same url/source id", () => {
    const a = event({ id: "ev-a", sourceId: "same", evidenceUrl: "https://example.com/same" });
    const b = event({ id: "ev-b", sourceId: "same", evidenceUrl: "https://example.com/same" });

    const candidates = findDuplicateCandidates([a, b]);
    expect(candidates[0].confidence).toBe("exact");
    expect(candidates[0].reasons).toContain("same evidenceUrl");
  });

  it("detects conflicting catch/no-catch evidence in the same window", () => {
    const positive = event({ id: "ev-positive", rawText: "シーバスが入っている。2本キャッチ。", extractedFacts: ["シーバスをキャッチ"] });
    const negative = event({
      id: "ev-negative",
      source: snsSource,
      sourceId: "no-bite",
      observedAt: "2026-07-10T21:00:00+09:00",
      publishedAt: "2026-07-10T22:30:00+09:00",
      rawText: "同じ明暗でノーバイト。反応なし。",
      extractedFacts: ["シーバス反応なし"]
    });

    const conflicts = findConflictingEvidence([positive, negative]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].species).toContain("シーバス");
  });
});
