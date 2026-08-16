import { describe, expect, it } from "vitest";
import {
  JAPANESE_SEABASS_EXTERNAL_EVIDENCE_SPECIES_ID,
  SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
  buildSeabassEvidenceSemanticContent,
  buildSeabassExternalEvidence,
  seabassExternalEvidenceSourceIdentity
} from "./external-evidence";

const EVENT_START_AT = "2026-08-15T03:00:00.000Z";
const EVENT_END_AT = "2026-08-15T04:00:00.000Z";
const PUBLISHED_AT = "2026-08-15T06:00:00.000Z";
const COLLECTED_AT = "2026-08-15T09:00:00.000Z";
const KNOWN_NODES = ["makuhari-shallow-01"];

describe("Wanoku External Evidence Foundation v1.1 contract", () => {
  it("preserves distinct event, publication, and Wanoku collection times", () => {
    const result = build(sampleEvidence());

    expect(result.valid).toBe(true);
    expect(result.evidence).toMatchObject({
      eventStartAt: EVENT_START_AT,
      eventEndAt: EVENT_END_AT,
      publishedAt: PUBLISHED_AT,
      collectedAt: COLLECTED_AT,
      provenance: {
        extractionMethod: "manual",
        extractorVersion: "manual-v1",
        mappingVersion: "wanoku-evidence-mapping.v1"
      }
    });
    expect(result.evidence?.provenance).not.toHaveProperty("collectedAt");
  });

  it("accepts an explicitly unknown publication time", () => {
    const value = sampleEvidence();
    value.publishedAt = null;
    value.qualityFlags.push("publication-time-unknown");

    expect(build(value)).toMatchObject({ valid: true, evidence: { publishedAt: null } });
  });

  it("requires collectedAt instead of inferring it from another timestamp", () => {
    const value = sampleEvidence() as Record<string, unknown>;
    delete value.collectedAt;

    const result = build(value);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("evidence.collectedAt is required.");
  });

  it("requires canonical UTC timestamps and eventEndAt >= eventStartAt", () => {
    const nonCanonical = sampleEvidence();
    nonCanonical.eventStartAt = "2026-08-15T03:00:00Z";
    expect(build(nonCanonical).errors).toContain("eventStartAt must be canonical UTC ISO datetime.");

    const reversed = sampleEvidence();
    reversed.eventEndAt = "2026-08-15T02:59:59.999Z";
    expect(build(reversed).errors).toContain("eventEndAt must be >= eventStartAt.");
  });

  it("rejects eventStartAt after collectedAt", () => {
    const value = sampleEvidence();
    value.eventStartAt = "2026-08-15T10:00:00.000Z";
    value.eventEndAt = null;

    expect(build(value).errors).toContain("eventStartAt must be <= collectedAt.");
  });

  it("rejects eventEndAt after collectedAt", () => {
    const value = sampleEvidence();
    value.eventEndAt = "2026-08-15T10:00:00.000Z";

    expect(build(value).errors).toContain("eventEndAt must be <= collectedAt.");
  });

  it("rejects publishedAt after collectedAt while allowing publication before event end", () => {
    const futurePublication = sampleEvidence();
    futurePublication.publishedAt = "2026-08-15T10:00:00.000Z";
    expect(build(futurePublication).errors).toContain("publishedAt must be <= collectedAt.");

    const liveReport = sampleEvidence();
    liveReport.eventEndAt = "2026-08-15T08:00:00.000Z";
    liveReport.publishedAt = "2026-08-15T07:00:00.000Z";
    expect(build(liveReport).valid).toBe(true);
  });

  it("represents a positive catch as direct positive presence evidence", () => {
    const result = build(sampleEvidence());

    expect(result).toMatchObject({
      valid: true,
      evidence: {
        evidenceType: "catch",
        presenceSupport: "positive",
        catchOutcome: "positive",
        directFishEvidence: true,
        catchCount: 1
      }
    });
  });

  it("requires an explicit interaction block and accepts unknown interaction", () => {
    const unknown = sampleEvidence();
    expect(build(unknown)).toMatchObject({
      valid: true,
      evidence: {
        interaction: {
          present: null,
          count: null,
          countLowerBound: null,
          biteMentioned: false,
          chaseMentioned: false,
          lostFishMentioned: false
        }
      }
    });

    const omitted = sampleEvidence() as unknown as Record<string, unknown>;
    delete omitted.interaction;
    expect(build(omitted).errors).toContain("evidence.interaction is required.");
  });

  it.each([
    "present",
    "count",
    "countLowerBound",
    "biteMentioned",
    "chaseMentioned",
    "lostFishMentioned"
  ])("rejects an omitted interaction.%s field instead of creating an alternate canonical shape", (field) => {
    const value = sampleEvidence() as unknown as { interaction: Record<string, unknown> };
    delete value.interaction[field];

    expect(build(value).errors).toContain(`interaction.${field} is required.`);
  });

  it("accepts positive interaction without a quantitative count", () => {
    const value = sampleEvidence();
    value.interaction.present = true;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: { interaction: { present: true, count: null, countLowerBound: null } }
    });
  });

  it("keeps exact interaction count distinct from a lower bound", () => {
    const exact = sampleEvidence();
    exact.interaction.present = true;
    exact.interaction.count = 5;
    const lowerBound = sampleEvidence();
    lowerBound.interaction.present = true;
    lowerBound.interaction.countLowerBound = 20;

    expect(build(exact)).toMatchObject({ valid: true, evidence: { interaction: { count: 5, countLowerBound: null } } });
    expect(build(lowerBound)).toMatchObject({ valid: true, evidence: { interaction: { count: null, countLowerBound: 20 } } });
  });

  it("rejects simultaneous exact and lower-bound interaction counts", () => {
    const value = sampleEvidence();
    value.interaction.present = true;
    value.interaction.count = 5;
    value.interaction.countLowerBound = 5;

    expect(build(value).errors).toContain("interaction.count and countLowerBound cannot both be non-null.");
  });

  it.each([
    ["count", 0],
    ["count", -1],
    ["countLowerBound", 0],
    ["countLowerBound", -1]
  ])("rejects non-positive interaction.%s value %s", (field, invalidValue) => {
    const value = sampleEvidence();
    value.interaction.present = true;
    (value.interaction as Record<string, unknown>)[field] = invalidValue;

    expect(build(value).valid).toBe(false);
  });

  it.each([
    ["exact count", (value: ReturnType<typeof sampleEvidence>) => { value.interaction.count = 5; }],
    ["lower-bound count", (value: ReturnType<typeof sampleEvidence>) => { value.interaction.countLowerBound = 20; }],
    ["bite", (value: ReturnType<typeof sampleEvidence>) => { value.interaction.biteMentioned = true; }],
    ["chase", (value: ReturnType<typeof sampleEvidence>) => { value.interaction.chaseMentioned = true; }],
    ["lost fish", (value: ReturnType<typeof sampleEvidence>) => { value.interaction.lostFishMentioned = true; }]
  ])("requires interaction.present true for positive %s detail", (_label, mutate) => {
    const value = sampleEvidence();
    mutate(value);

    expect(build(value).errors).toContain("positive interaction details require interaction.present true.");
  });

  it("rejects interaction.present false instead of inferring a negative", () => {
    const value = sampleEvidence() as unknown as { interaction: Record<string, unknown> };
    value.interaction.present = false;

    expect(build(value).errors).toContain("interaction.present must be true or null; false is not supported.");
  });

  it("represents Kachidoki-like 5hit 4get in one catch payload", () => {
    const value = sampleEvidence();
    value.catchCount = 4;
    value.interaction.present = true;
    value.interaction.count = 5;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: {
        evidenceType: "catch",
        catchOutcome: "positive",
        catchCount: 4,
        interaction: { present: true, count: 5, countLowerBound: null }
      }
    });
  });

  it("represents Kachidoki-like 20HIT以上 9GET without making the hit count exact", () => {
    const value = sampleEvidence();
    value.catchCount = 9;
    value.interaction.present = true;
    value.interaction.countLowerBound = 20;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: { catchCount: 9, interaction: { count: null, countLowerBound: 20 } }
    });
  });

  it("represents nonnumeric many-hits evidence as present with unknown count", () => {
    const value = sampleEvidence();
    value.interaction.present = true;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: { interaction: { present: true, count: null, countLowerBound: null } }
    });
  });

  it("keeps lost fish independent from landed catch count", () => {
    const value = sampleEvidence();
    value.catchCount = 4;
    value.interaction.present = true;
    value.interaction.lostFishMentioned = true;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: { catchCount: 4, interaction: { lostFishMentioned: true } }
    });
  });

  it("leaves interaction unknown when catch is known but hit detail is absent", () => {
    expect(build(sampleEvidence())).toMatchObject({
      valid: true,
      evidence: { catchCount: 1, interaction: { present: null, count: null } }
    });
  });

  it("allows explicit landed zero with positive interaction without claiming fish absence", () => {
    const value = sampleEvidence();
    value.evidenceType = "bite-or-contact";
    value.catchOutcome = "unknown";
    value.catchCount = 0;
    value.interaction.present = true;
    value.interaction.count = 5;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: {
        evidenceType: "bite-or-contact",
        presenceSupport: "positive",
        catchOutcome: "unknown",
        directFishEvidence: true,
        catchCount: 0,
        interaction: { present: true, count: 5 }
      }
    });
  });

  it("does not infer negative interaction from explicit effort-zero catch", () => {
    expect(build(explicitZeroEvidence())).toMatchObject({
      valid: true,
      evidence: { catchCount: 0, interaction: { present: null } }
    });
  });

  it("allows explicit effort-zero catch to coexist with confirmed positive interaction", () => {
    const value = explicitZeroEvidence();
    value.interaction.present = true;
    value.interaction.count = 5;
    value.interaction.biteMentioned = true;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: {
        evidenceType: "explicit-effort-zero-catch",
        presenceSupport: "none",
        catchOutcome: "explicit-zero",
        directFishEvidence: false,
        catchCount: 0,
        interaction: { present: true, count: 5, biteMentioned: true }
      }
    });
  });

  it.each(["fish-observation", "bite-or-contact", "survey-detection"])(
    "accepts positive %s evidence without inventing a catch count",
    (evidenceType) => {
      const value = sampleEvidence();
      value.evidenceType = evidenceType;
      value.catchOutcome = "unknown";
      value.catchCount = null;
      if (evidenceType === "bite-or-contact") value.interaction.present = true;

      expect(build(value)).toMatchObject({
        valid: true,
        evidence: {
          evidenceType,
          presenceSupport: "positive",
          catchOutcome: "unknown",
          directFishEvidence: true,
          catchCount: null
        }
      });
    }
  );

  it("rejects unknown-species contact as Japanese seabass interaction evidence", () => {
    const value = sampleEvidence();
    value.evidenceType = "bite-or-contact";
    value.catchOutcome = "unknown";
    value.catchCount = null;
    value.interaction.present = true;
    value.qualityFlags.push("species-identification-unverified");

    expect(build(value).errors).toEqual(expect.arrayContaining([
      "bite-or-contact requires explicit Japanese seabass attribution.",
      "positive interaction requires explicit Japanese seabass attribution."
    ]));
  });

  it("accepts explicit effort with zero catch without claiming fish absence", () => {
    const value = explicitZeroEvidence();
    const result = build(value);

    expect(result).toMatchObject({
      valid: true,
      evidence: {
        evidenceType: "explicit-effort-zero-catch",
        presenceSupport: "none",
        catchOutcome: "explicit-zero",
        directFishEvidence: false,
        catchCount: 0,
        effort: { known: true, targetSpeciesExplicit: true }
      }
    });
  });

  it("rejects inferred no-report evidence", () => {
    const value = sampleEvidence();
    value.evidenceType = "no-report";
    value.presenceSupport = "none";
    value.catchOutcome = "unknown";
    value.directFishEvidence = false;
    value.catchCount = null;

    expect(build(value).errors).toContain("evidenceType is invalid.");
  });

  it("rejects zero catch when explicit effort or target intent is missing", () => {
    const value = explicitZeroEvidence();
    value.effort.known = false;
    value.effort.targetSpeciesExplicit = null;
    value.effort.durationMinutes = null;
    value.effort.anglerCount = null;

    const result = build(value);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "explicit-effort-zero-catch requires effort.known true.",
      "explicit-effort-zero-catch requires effort.targetSpeciesExplicit true.",
      "explicit-effort-zero-catch requires explicit durationMinutes or anglerCount."
    ]));
  });

  it("preserves unknown effort on positive evidence", () => {
    const result = build(sampleEvidence());

    expect(result.evidence?.effort).toEqual({
      known: false,
      durationMinutes: null,
      anglerCount: null,
      targetSpeciesExplicit: null
    });
  });

  it("accepts exact-coordinate mapping only with coordinates and a known node", () => {
    const result = build(sampleEvidence());

    expect(result.evidence?.location).toMatchObject({
      latitude: 35.62,
      longitude: 140.03,
      mappedNodeId: "makuhari-shallow-01",
      mapping: { method: "exact-coordinate", status: "exact" }
    });
  });

  it("keeps nearest-node mapping explicitly approximate", () => {
    const value = sampleEvidence();
    value.location.mapping = { method: "nearest-node", status: "approximate" };

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: { location: { mapping: { method: "nearest-node", status: "approximate" } } }
    });
  });

  it("accepts unknown location with mappedNodeId null", () => {
    const value = sampleEvidence();
    value.location = {
      rawLabel: null,
      latitude: null,
      longitude: null,
      mappedNodeId: null,
      mapping: { method: "unknown", status: "unknown" }
    };
    value.qualityFlags.push("location-unknown");

    expect(build(value)).toMatchObject({ valid: true, evidence: { location: { mappedNodeId: null } } });
  });

  it("does not map a vague source area to an exact Habitat node", () => {
    const value = sampleEvidence();
    value.location = {
      rawLabel: "Tokyo Bay",
      latitude: null,
      longitude: null,
      mappedNodeId: "makuhari-shallow-01",
      mapping: { method: "source-area", status: "exact" }
    };

    expect(build(value).errors).toEqual(expect.arrayContaining([
      "source-area location must not be assigned to an exact Habitat node.",
      "source-area location cannot have exact mapping status."
    ]));
  });

  it("rejects a mapped node outside the existing Habitat node catalog", () => {
    const value = sampleEvidence();
    value.location.mappedNodeId = "invented-node";

    expect(build(value).errors).toContain("location.mappedNodeId is not a known Habitat node.");
  });

  it("limits v1 to Japanese seabass and rejects numeric confidence fields", () => {
    const wrongSpecies = sampleEvidence();
    wrongSpecies.species.id = "black-seabream";
    expect(build(wrongSpecies).valid).toBe(false);

    const scored = sampleEvidence() as Record<string, unknown>;
    scored.confidence = 0.9;
    expect(build(scored).errors).toContain("evidence.confidence is not supported.");
  });

  it("rejects a v1 payload instead of silently reinterpreting it as v1.1", () => {
    const value = sampleEvidence() as unknown as Record<string, unknown>;
    value.schemaVersion = "wanoku-seabass-external-evidence.v1";

    expect(build(value).errors).toContain(
      "schemaVersion must be wanoku-seabass-external-evidence.v1.1."
    );
  });

  it("derives source identity from provider, record, and event key, not URL", () => {
    const first = sampleEvidence();
    const second = sampleEvidence();
    second.source.sourceUrl = "https://mirror.example/records/1";
    second.source.title = "Corrected title";

    const expected = seabassExternalEvidenceSourceIdentity("manual-test", "record/1", null);
    expect(build(first).evidence?.sourceIdentity).toBe(expected);
    expect(build(second).evidence?.sourceIdentity).toBe(expected);
  });

  it("keeps parallel source events and delimiter-like components unambiguous", () => {
    const eventA = seabassExternalEvidenceSourceIdentity("charter-a", "2026-08-15-log", "catch-001");
    const eventB = seabassExternalEvidenceSourceIdentity("charter-a", "2026-08-15-log", "catch-002");

    expect(eventA).not.toBe(eventB);
    expect(seabassExternalEvidenceSourceIdentity("ab", "c", null))
      .not.toBe(seabassExternalEvidenceSourceIdentity("a", "bc", null));
    expect(seabassExternalEvidenceSourceIdentity("a|b", "c", null))
      .not.toBe(seabassExternalEvidenceSourceIdentity("a", "b|c", null));
    expect(seabassExternalEvidenceSourceIdentity("a", "b", null))
      .not.toBe(seabassExternalEvidenceSourceIdentity("a", "b", "null"));
  });

  it("rejects an empty sourceEventKey instead of conflating it with null", () => {
    const value = sampleEvidence();
    value.source.sourceEventKey = "";

    expect(build(value).errors).toContain(
      "source.sourceEventKey must be null or a non-empty string up to 500 characters."
    );
  });

  it("normalizes an omitted optional sourceEventKey to null", () => {
    const value = sampleEvidence() as unknown as { source: Record<string, unknown> };
    delete value.source.sourceEventKey;

    expect(build(value)).toMatchObject({
      valid: true,
      evidence: {
        source: { sourceEventKey: null },
        sourceIdentity: seabassExternalEvidenceSourceIdentity("manual-test", "record/1", null)
      }
    });
  });

  it("projects only semantic evidence fields", () => {
    const evidence = build(sampleEvidence()).evidence;
    if (!evidence) throw new Error("fixture must be valid");
    const semantic = buildSeabassEvidenceSemanticContent(evidence);

    expect(semantic).toMatchObject({
      schemaVersion: SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
      source: {
        providerId: "manual-test",
        sourceRecordId: "record/1",
        sourceEventKey: null,
        sourceClass: "structured-angler-log"
      },
      evidenceType: "catch",
      catchCount: 1,
      interaction: {
        present: null,
        count: null,
        countLowerBound: null,
        biteMentioned: false,
        chaseMentioned: false,
        lostFishMentioned: false
      },
      qualityFlags: ["effort-unknown"]
    });
    expect(semantic).not.toHaveProperty("collectedAt");
    expect(semantic).not.toHaveProperty("provenance");
    expect(semantic.source).not.toHaveProperty("sourceUrl");
    expect(semantic.source).not.toHaveProperty("title");
  });
});

function build(value: unknown) {
  return buildSeabassExternalEvidence(value, KNOWN_NODES);
}

function sampleEvidence() {
  return {
    schemaVersion: SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
    species: {
      id: JAPANESE_SEABASS_EXTERNAL_EVIDENCE_SPECIES_ID,
      scientificName: "Lateolabrax japonicus"
    },
    evidenceType: "catch",
    eventStartAt: EVENT_START_AT,
    eventEndAt: EVENT_END_AT as string | null,
    publishedAt: PUBLISHED_AT as string | null,
    collectedAt: COLLECTED_AT,
    presenceSupport: "positive",
    catchOutcome: "positive",
    directFishEvidence: true,
    catchCount: 1 as number | null,
    interaction: {
      present: null as true | null,
      count: null as number | null,
      countLowerBound: null as number | null,
      biteMentioned: false,
      chaseMentioned: false,
      lostFishMentioned: false
    },
    effort: {
      known: false,
      durationMinutes: null as number | null,
      anglerCount: null as number | null,
      targetSpeciesExplicit: null as boolean | null
    },
    location: {
      rawLabel: "Makuhari shallow" as string | null,
      latitude: 35.62 as number | null,
      longitude: 140.03 as number | null,
      mappedNodeId: "makuhari-shallow-01" as string | null,
      mapping: { method: "exact-coordinate", status: "exact" }
    },
    source: {
      providerId: "manual-test",
      sourceClass: "structured-angler-log",
      sourceRecordId: "record/1",
      sourceEventKey: null as string | null,
      sourceUrl: "https://example.com/records/1" as string | null,
      title: "Short structured log" as string | null
    },
    provenance: {
      extractionMethod: "manual",
      extractorVersion: "manual-v1",
      mappingVersion: "wanoku-evidence-mapping.v1"
    },
    qualityFlags: ["effort-unknown"]
  };
}

function explicitZeroEvidence() {
  const value = sampleEvidence();
  value.evidenceType = "explicit-effort-zero-catch";
  value.presenceSupport = "none";
  value.catchOutcome = "explicit-zero";
  value.directFishEvidence = false;
  value.catchCount = 0;
  value.effort = {
    known: true,
    durationMinutes: 120,
    anglerCount: 1,
    targetSpeciesExplicit: true
  };
  value.qualityFlags = [];
  return value;
}
