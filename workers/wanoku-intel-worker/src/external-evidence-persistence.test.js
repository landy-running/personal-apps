import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
  buildSeabassExternalEvidence
} from "../../../packages/wanoku-core/src/external-evidence.ts";
import worker from "./index.js";
import {
  ExternalEvidenceIntegrityError,
  canonicalExternalEvidenceJson,
  hashSeabassExternalEvidence,
  materializeSeabassExternalEvidence,
  persistSeabassExternalEvidence,
  readSeabassExternalEvidence,
  seabassExternalEvidenceId
} from "./external-evidence-persistence.js";

const MIGRATION_0005 = readFileSync(
  new URL("../migrations/0005_seabass_external_evidence.sql", import.meta.url),
  "utf8"
);
const EVENT_START_AT = "2026-08-15T03:00:00.000Z";
const EVENT_END_AT = "2026-08-15T04:00:00.000Z";
const PUBLISHED_AT = "2026-08-15T06:00:00.000Z";
const COLLECTED_AT = "2026-08-15T09:00:00.000Z";
const STORED_AT = "2026-08-15T09:00:01.000Z";
const ADMIN_SECRET = "test-secret";

describe("External Evidence Foundation v1.1 canonical record", () => {
  it("canonicalizes object key order while preserving array order", async () => {
    const evidence = validEvidence();
    const reordered = reverseObjectKeys(evidence);
    const first = await hashSeabassExternalEvidence(evidence);
    const second = await hashSeabassExternalEvidence(reordered);

    expect(second).toEqual(first);

    const reorderedFlags = structuredClone(evidence);
    reorderedFlags.qualityFlags = ["location-approximate", "effort-unknown"];
    const reversedFlags = structuredClone(reorderedFlags);
    reversedFlags.qualityFlags.reverse();
    expect((await hashSeabassExternalEvidence(reorderedFlags)).payloadHash)
      .not.toBe((await hashSeabassExternalEvidence(reversedFlags)).payloadHash);
  });

  it("distinguishes explicit null from a missing field", () => {
    const explicitNull = validEvidence();
    explicitNull.publishedAt = null;
    const missing = structuredClone(explicitNull);
    delete missing.publishedAt;

    expect(canonicalExternalEvidenceJson(explicitNull))
      .not.toBe(canonicalExternalEvidenceJson(missing));
  });

  it("creates the same lowercase SHA-256 and deterministic evidence ID", async () => {
    const first = await hashSeabassExternalEvidence(validEvidence());
    const second = await hashSeabassExternalEvidence(validEvidence());

    expect(first).toEqual(second);
    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.evidenceId).toBe(`wanoku-seabass-evidence:${first.payloadHash}`);
    expect(seabassExternalEvidenceId(first.payloadHash)).toBe(first.evidenceId);
  });

  it("keeps the same semantic hash and ID when only collectedAt changes", async () => {
    const first = validEvidence();
    const secondInput = sampleEvidenceInput();
    secondInput.collectedAt = "2026-08-16T09:00:00.000Z";
    const second = validatedEvidence(secondInput);

    expect(await hashSeabassExternalEvidence(second)).toEqual(await hashSeabassExternalEvidence(first));
  });

  it("keeps the same semantic hash when only extractorVersion changes", async () => {
    const changedInput = sampleEvidenceInput();
    changedInput.provenance.extractorVersion = "manual-v2";

    expect((await hashSeabassExternalEvidence(validatedEvidence(changedInput))).evidenceId)
      .toBe((await hashSeabassExternalEvidence(validEvidence())).evidenceId);
  });

  it("keeps the same semantic hash when only extractionMethod changes", async () => {
    const changedInput = sampleEvidenceInput();
    changedInput.provenance.extractionMethod = "deterministic-parser";

    expect((await hashSeabassExternalEvidence(validatedEvidence(changedInput))).evidenceId)
      .toBe((await hashSeabassExternalEvidence(validEvidence())).evidenceId);
  });

  it("keeps the same semantic hash when only mappingVersion changes", async () => {
    const changedInput = sampleEvidenceInput();
    changedInput.provenance.mappingVersion = "wanoku-evidence-mapping.v2";

    expect((await hashSeabassExternalEvidence(validatedEvidence(changedInput))).evidenceId)
      .toBe((await hashSeabassExternalEvidence(validEvidence())).evidenceId);
  });

  it("keeps the same semantic hash when only source URL and title change", async () => {
    const changedInput = sampleEvidenceInput();
    changedInput.source.sourceUrl = "https://mirror.example/records/1";
    changedInput.source.title = "Mirrored title";

    expect((await hashSeabassExternalEvidence(validatedEvidence(changedInput))).evidenceId)
      .toBe((await hashSeabassExternalEvidence(validEvidence())).evidenceId);
  });

  it.each([
    ["catchCount", (input) => { input.catchCount = 2; }],
    ["interaction", (input) => {
      input.interaction.present = true;
      input.interaction.count = 5;
    }],
    ["eventStartAt", (input) => { input.eventStartAt = "2026-08-15T03:30:00.000Z"; }],
    ["location", (input) => {
      input.location.rawLabel = "Funabashi inner";
      input.location.latitude = 35.675;
      input.location.longitude = 139.995;
      input.location.mappedNodeId = "funabashi-inner-01";
    }],
    ["publishedAt", (input) => { input.publishedAt = "2026-08-15T06:30:00.000Z"; }],
    ["qualityFlags", (input) => { input.qualityFlags.push("event-time-approximate"); }]
  ])("creates a new semantic hash when %s changes", async (_field, mutate) => {
    const changedInput = sampleEvidenceInput();
    mutate(changedInput);

    expect((await hashSeabassExternalEvidence(validatedEvidence(changedInput))).evidenceId)
      .not.toBe((await hashSeabassExternalEvidence(validEvidence())).evidenceId);
  });

  it("changes the semantic hash when only the interaction count is corrected", async () => {
    const firstInput = sampleEvidenceInput();
    firstInput.interaction.present = true;
    firstInput.interaction.count = 5;
    const secondInput = structuredClone(firstInput);
    secondInput.interaction.count = 6;
    const first = validatedEvidence(firstInput);
    const second = validatedEvidence(secondInput);

    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect((await hashSeabassExternalEvidence(second)).evidenceId)
      .not.toBe((await hashSeabassExternalEvidence(first)).evidenceId);
  });

  it.each([
    ["present", true],
    ["count", 5],
    ["countLowerBound", 20],
    ["biteMentioned", true],
    ["chaseMentioned", true],
    ["lostFishMentioned", true]
  ])("includes interaction.%s in the semantic hash without changing source identity", async (field, changedValue) => {
    const firstInput = sampleEvidenceInput();
    const secondInput = structuredClone(firstInput);
    if (field !== "present") {
      firstInput.interaction.present = true;
      secondInput.interaction.present = true;
    }
    secondInput.interaction[field] = changedValue;
    const first = validatedEvidence(firstInput);
    const second = validatedEvidence(secondInput);

    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect((await hashSeabassExternalEvidence(second)).evidenceId)
      .not.toBe((await hashSeabassExternalEvidence(first)).evidenceId);
  });

  it("separates parallel source events while keeping revisions on one source identity", async () => {
    const eventAInput = sampleEvidenceInput();
    eventAInput.source.sourceEventKey = "catch-001";
    const eventBInput = sampleEvidenceInput();
    eventBInput.source.sourceEventKey = "catch-002";
    const revisionInput = sampleEvidenceInput();
    revisionInput.source.sourceEventKey = "catch-001";
    revisionInput.catchCount = 2;
    const eventA = validatedEvidence(eventAInput);
    const eventB = validatedEvidence(eventBInput);
    const revision = validatedEvidence(revisionInput);

    expect(eventA.sourceIdentity).not.toBe(eventB.sourceIdentity);
    expect(revision.sourceIdentity).toBe(eventA.sourceIdentity);
    expect((await hashSeabassExternalEvidence(revision)).evidenceId)
      .not.toBe((await hashSeabassExternalEvidence(eventA)).evidenceId);
  });

  it("keeps storedAt outside the canonical payload, hash, and ID", async () => {
    const evidence = validEvidence();
    const first = await materializeSeabassExternalEvidence(evidence, STORED_AT);
    const second = await materializeSeabassExternalEvidence(evidence, "2026-08-15T09:00:02.000Z");

    expect(second.id).toBe(first.id);
    expect(second.payloadHash).toBe(first.payloadHash);
    expect(second.semanticJson).toBe(first.semanticJson);
    expect(second.payloadJson).toBe(first.payloadJson);
    expect(second.storedAt).not.toBe(first.storedAt);
    expect(first.payloadJson).not.toContain("storedAt");
  });
});

describe("External Evidence Foundation v1.1 existing schema", () => {
  it("creates one table and three bounded indexes without destructive SQL", () => {
    expect(MIGRATION_0005).toContain("CREATE TABLE IF NOT EXISTS seabass_external_evidence");
    expect(MIGRATION_0005).toContain("payload_hash TEXT NOT NULL UNIQUE");
    expect(MIGRATION_0005.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(3);
    expect(MIGRATION_0005).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|REPLACE)\b/i);
    expect(MIGRATION_0005).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it("applies to local SQLite with the expected immutable columns and indexes", () => {
    const script = String.raw`
import json
import sqlite3
from pathlib import Path

sql = Path("workers/wanoku-intel-worker/migrations/0005_seabass_external_evidence.sql").read_text(encoding="utf-8")
conn = sqlite3.connect(":memory:")
conn.executescript(sql)
columns = [row[1] for row in conn.execute("PRAGMA table_info(seabass_external_evidence)")]
indexes = [row[1] for row in conn.execute("PRAGMA index_list(seabass_external_evidence)")]
print(json.dumps({"columns": columns, "indexes": indexes}))
`;
    const result = spawnSync("python", ["-c", script], { cwd: process.cwd(), encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const schema = JSON.parse(result.stdout);

    expect(schema.columns).toEqual([
      "id",
      "payload_hash",
      "schema_version",
      "species_id",
      "source_identity",
      "provider_id",
      "source_class",
      "source_record_id",
      "event_start_at",
      "event_end_at",
      "published_at",
      "collected_at",
      "stored_at",
      "mapped_node_id",
      "evidence_type",
      "presence_support",
      "catch_outcome",
      "payload_json"
    ]);
    expect(schema.indexes).toEqual(expect.arrayContaining([
      "idx_seabass_external_evidence_node_event",
      "idx_seabass_external_evidence_species_event",
      "idx_seabass_external_evidence_source_version"
    ]));
  });
});

describe("External Evidence Foundation v1.1 repository", () => {
  it("plain-inserts once and treats an exact retry as idempotent", async () => {
    const db = new EvidenceD1();
    const input = sampleEvidenceInput();
    input.interaction.present = true;
    input.interaction.count = 5;
    const evidence = validatedEvidence(input);
    const first = await persist(db, evidence, STORED_AT);
    const second = await persist(db, evidence, "2026-08-15T09:00:02.000Z");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second.storedAt).toBe(STORED_AT);
    expect(db.evidenceRows).toHaveLength(1);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("rejects an invalid interaction before any persistence access", async () => {
    const db = new EvidenceD1();
    const invalid = validEvidence();
    invalid.interaction.present = false;

    await expect(persist(db, invalid, STORED_AT)).rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.prepared).toHaveLength(0);
    expect(db.evidenceRows).toHaveLength(0);
    expect(db.writeStatements).toHaveLength(0);
  });

  it("treats changed collection metadata as the same content and preserves first-known metadata", async () => {
    const db = new EvidenceD1();
    const firstEvidence = validEvidence();
    const recollectedInput = sampleEvidenceInput();
    recollectedInput.collectedAt = "2026-08-16T09:00:00.000Z";
    recollectedInput.provenance.extractorVersion = "manual-v2";
    recollectedInput.provenance.mappingVersion = "wanoku-evidence-mapping.v2";
    recollectedInput.source.sourceUrl = "https://mirror.example/records/1";
    recollectedInput.source.title = "Mirrored title";
    const recollected = validatedEvidence(recollectedInput);

    const first = await persist(db, firstEvidence, STORED_AT);
    const second = await persist(db, recollected, "2026-08-16T09:00:01.000Z");

    expect(second.created).toBe(false);
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second.storedAt).toBe(STORED_AT);
    expect(second.evidence.collectedAt).toBe(COLLECTED_AT);
    expect(second.evidence.provenance.extractorVersion).toBe("manual-v1");
    expect(second.evidence.source.sourceUrl).toBe("https://example.com/records/1");
    expect(db.evidenceRows).toHaveLength(1);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("fails integrity verification for a mismatched payload without overwriting it", async () => {
    const db = new EvidenceD1();
    const first = await persist(db, validEvidence(), STORED_AT);
    const corrupted = db.evidenceRows[0].payload_json.replace('"catchCount":1', '"catchCount":2');
    db.evidenceRows[0].payload_json = corrupted;

    await expect(persist(db, validEvidence(), "2026-08-15T09:00:02.000Z"))
      .rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.evidenceRows).toHaveLength(1);
    expect(db.evidenceRows[0].id).toBe(first.evidenceId);
    expect(db.evidenceRows[0].payload_json).toBe(corrupted);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("stores changed content under the same source identity as a separate version", async () => {
    const db = new EvidenceD1();
    const original = validEvidence();
    const changedInput = sampleEvidenceInput();
    changedInput.catchCount = 2;
    changedInput.collectedAt = "2026-08-15T10:00:00.000Z";
    const changed = validatedEvidence(changedInput);
    const first = await persist(db, original, STORED_AT);
    const second = await persist(db, changed, "2026-08-15T10:00:01.000Z");

    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(second.evidence.sourceIdentity).toBe(first.evidence.sourceIdentity);
    expect(db.evidenceRows).toHaveLength(2);
    expect(db.evidenceRows.map((row) => row.source_identity)).toEqual([
      original.sourceIdentity,
      original.sourceIdentity
    ]);
  });

  it("stores an interaction correction as a second semantic version on the same source identity", async () => {
    const db = new EvidenceD1();
    const original = validEvidence();
    const revisionInput = sampleEvidenceInput();
    revisionInput.interaction.present = true;
    revisionInput.interaction.count = 5;
    revisionInput.collectedAt = "2026-08-15T10:00:00.000Z";
    const revision = validatedEvidence(revisionInput);

    const first = await persist(db, original, STORED_AT);
    const second = await persist(db, revision, "2026-08-15T10:00:01.000Z");

    expect(second.created).toBe(true);
    expect(second.evidenceId).not.toBe(first.evidenceId);
    expect(second.evidence.sourceIdentity).toBe(first.evidence.sourceIdentity);
    expect(second.evidence.interaction).toMatchObject({ present: true, count: 5 });
    expect(db.evidenceRows).toHaveLength(2);
    expect(db.writeStatements).toHaveLength(2);
  });

  it("recovers an exact concurrent insert race as created=false", async () => {
    const db = new EvidenceD1({ raceOnInsert: true });
    const result = await persist(db, validEvidence(), STORED_AT);

    expect(result.created).toBe(false);
    expect(result.storedAt).toBe(STORED_AT);
    expect(db.evidenceRows).toHaveLength(1);
    expect(db.writeStatements).toHaveLength(0);
    expect(db.prepared.filter((entry) => /FROM seabass_external_evidence/.test(entry.sql))).toHaveLength(2);
  });

  it("rejects a concurrent insert race whose stored content mismatches the candidate", async () => {
    const db = new EvidenceD1({
      raceOnInsert: (row) => ({
        ...row,
        payload_json: row.payload_json.replace('"catchCount":1', '"catchCount":2')
      })
    });

    await expect(persist(db, validEvidence(), STORED_AT))
      .rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.evidenceRows).toHaveLength(1);
    expect(db.writeStatements).toHaveLength(0);
  });

  it("uses plain INSERT and never generates overwrite or destructive SQL", async () => {
    const db = new EvidenceD1();
    await persist(db, validEvidence(), STORED_AT);
    const sql = db.prepared.map((entry) => entry.sql).join("\n");

    expect(sql).toMatch(/INSERT INTO seabass_external_evidence/i);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|REPLACE)\b/i);
    expect(sql).not.toMatch(/INSERT\s+OR\s+(IGNORE|REPLACE)|ON\s+CONFLICT/i);
  });

  it("reads and verifies the stored canonical payload", async () => {
    const db = new EvidenceD1();
    const created = await persist(db, validEvidence(), STORED_AT);
    const read = await readSeabassExternalEvidence(db, created.evidenceId);

    expect(read).toMatchObject({
      found: true,
      evidenceId: created.evidenceId,
      payloadHash: created.payloadHash,
      storedAt: STORED_AT,
      evidence: created.evidence
    });
  });

  it("rejects corrupt stored JSON instead of repairing it", async () => {
    const db = new EvidenceD1();
    const created = await persist(db, validEvidence(), STORED_AT);
    db.evidenceRows[0].payload_json = "{";

    await expect(readSeabassExternalEvidence(db, created.evidenceId))
      .rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("rejects a stored payload that violates the v1.1 interaction contract", async () => {
    const db = new EvidenceD1();
    const created = await persist(db, validEvidence(), STORED_AT);
    db.evidenceRows[0].payload_json = db.evidenceRows[0].payload_json.replace('"present":null', '"present":false');

    await expect(readSeabassExternalEvidence(db, created.evidenceId))
      .rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.writeStatements).toHaveLength(1);
  });

  it("detects a valid-looking interaction count mutation when the stored hash and ID are unchanged", async () => {
    const db = new EvidenceD1();
    const input = sampleEvidenceInput();
    input.interaction.present = true;
    input.interaction.count = 5;
    const created = await persist(db, validatedEvidence(input), STORED_AT);
    db.evidenceRows[0].payload_json = db.evidenceRows[0].payload_json.replace('"count":5', '"count":6');

    await expect(readSeabassExternalEvidence(db, created.evidenceId))
      .rejects.toBeInstanceOf(ExternalEvidenceIntegrityError);
    expect(db.writeStatements).toHaveLength(1);
  });
});

describe("External Evidence Foundation v1.1 API", () => {
  it("requires admin auth before body reads or D1 access", async () => {
    const db = new EvidenceD1();
    const request = createRequest(sampleEvidenceInput(), false);
    const bodySpy = vi.spyOn(request, "text");
    const response = await worker.fetch(request, {
      WANOKU_ADMIN_SECRET: ADMIN_SECRET,
      WANOKU_INTEL_D1: db
    });

    expect(response.status).toBe(403);
    expect(bodySpy).not.toHaveBeenCalled();
    expect(db.prepared).toHaveLength(0);
    expect(db.writeStatements).toHaveLength(0);
  });

  it("validates before writing and rejects unsupported inference fields", async () => {
    const db = new EvidenceD1();
    const input = sampleEvidenceInput();
    input.probability = 0.8;
    const response = await worker.fetch(createRequest(input, true), apiEnv(db));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_external_evidence");
    expect(body.errors).toContain("evidence.probability is not supported.");
    expect(db.writeStatements).toHaveLength(0);
  });

  it("creates evidence with one D1 write, no internal HTTP, then returns created=false on retry", async () => {
    const db = new EvidenceD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("internal HTTP is not allowed"));
    try {
      const first = await worker.fetch(createRequest(sampleEvidenceInput(), true), apiEnv(db));
      const second = await worker.fetch(createRequest(sampleEvidenceInput(), true), apiEnv(db));
      const firstBody = await first.json();
      const secondBody = await second.json();

      expect(first.status).toBe(201);
      expect(firstBody.created).toBe(true);
      expect(firstBody.evidence.schemaVersion).toBe(SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION);
      expect(second.status).toBe(200);
      expect(secondBody.created).toBe(false);
      expect(secondBody.evidenceId).toBe(firstBody.evidenceId);
      expect(secondBody.storedAt).toBe(firstBody.storedAt);
      expect(db.writeStatements).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("GET returns only the stored verified payload without inference or writes", async () => {
    const db = new EvidenceD1();
    const create = await worker.fetch(createRequest(sampleEvidenceInput(), true), apiEnv(db));
    const created = await create.json();
    const statementStart = db.prepared.length;
    const writeCount = db.writeStatements.length;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("GET must not fetch"));
    try {
      const response = await worker.fetch(new Request(
        `https://worker.example/evidence/seabass/${encodeURIComponent(created.evidenceId)}`
      ), apiEnv(db));
      const body = await response.json();
      const reads = db.prepared.slice(statementStart);

      expect(response.status).toBe(200);
      expect(body.evidence).toEqual(created.evidence);
      expect(body.evidence).toMatchObject({
        schemaVersion: "wanoku-seabass-external-evidence.v1.1",
        interaction: {
          present: null,
          count: null,
          countLowerBound: null,
          biteMentioned: false,
          chaseMentioned: false,
          lostFishMentioned: false
        }
      });
      expect(reads).toHaveLength(1);
      expect(reads[0].sql).toContain("FROM seabass_external_evidence");
      expect(reads[0].sql).not.toMatch(/environmental_snapshots|prediction_snapshots/);
      expect(db.writeStatements).toHaveLength(writeCount);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 400 for an invalid ID and 404 for a missing valid ID", async () => {
    const db = new EvidenceD1();
    const invalid = await worker.fetch(
      new Request("https://worker.example/evidence/seabass/not-an-id"),
      { WANOKU_INTEL_D1: db }
    );
    expect(invalid.status).toBe(400);

    const missingId = `wanoku-seabass-evidence:${"0".repeat(64)}`;
    const missing = await worker.fetch(
      new Request(`https://worker.example/evidence/seabass/${missingId}`),
      { WANOKU_INTEL_D1: db }
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("external_evidence_not_found");
  });

  it("returns an integrity error for corrupted stored evidence without repairing it", async () => {
    const db = new EvidenceD1();
    const create = await worker.fetch(createRequest(sampleEvidenceInput(), true), apiEnv(db));
    const created = await create.json();
    db.evidenceRows[0].payload_json = db.evidenceRows[0].payload_json.replace("positive", "unknown");
    const writeCount = db.writeStatements.length;

    const response = await worker.fetch(new Request(
      `https://worker.example/evidence/seabass/${encodeURIComponent(created.evidenceId)}`
    ), apiEnv(db));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("external_evidence_integrity_error");
    expect(db.writeStatements).toHaveLength(writeCount);
  });

  it("keeps the fixture /evidence route and Prediction Preview unchanged", async () => {
    const existing = await worker.fetch(new Request("https://worker.example/evidence"), {});
    const existingBody = await existing.json();
    expect(existing.status).toBe(200);
    expect(existingBody.note).toBe("fixture/mock only; no production SNS API connection.");
    expect(Array.isArray(existingBody.evidence)).toBe(true);

    const preview = await worker.fetch(new Request(
      "https://worker.example/species/seabass/prediction-preview?nodeId=makuhari-shallow-01&knowledgeAt=2026-08-15T00:00:00.000Z&targetAt=2026-08-15T03:00:00.000Z"
    ), {});
    expect(preview.status).toBe(200);
    expect((await preview.json()).schemaVersion).toBe("wanoku-seabass-prediction-preview.v1");
  });

  it("keeps the immutable Prediction Snapshot read route independent", async () => {
    const db = new EvidenceD1();
    const missingId = `wanoku-seabass-prediction:${"0".repeat(64)}`;
    const response = await worker.fetch(new Request(
      `https://worker.example/predictions/seabass/snapshots/${missingId}`
    ), { WANOKU_INTEL_D1: db });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("prediction_snapshot_not_found");
    expect(db.writeStatements).toHaveLength(0);
  });
});

function sampleEvidenceInput() {
  return {
    schemaVersion: SEABASS_EXTERNAL_EVIDENCE_SCHEMA_VERSION,
    species: { id: "japanese-seabass", scientificName: "Lateolabrax japonicus" },
    evidenceType: "catch",
    eventStartAt: EVENT_START_AT,
    eventEndAt: EVENT_END_AT,
    publishedAt: PUBLISHED_AT,
    collectedAt: COLLECTED_AT,
    presenceSupport: "positive",
    catchOutcome: "positive",
    directFishEvidence: true,
    catchCount: 1,
    interaction: {
      present: null,
      count: null,
      countLowerBound: null,
      biteMentioned: false,
      chaseMentioned: false,
      lostFishMentioned: false
    },
    effort: {
      known: false,
      durationMinutes: null,
      anglerCount: null,
      targetSpeciesExplicit: null
    },
    location: {
      rawLabel: "Makuhari shallow",
      latitude: 35.62,
      longitude: 140.03,
      mappedNodeId: "makuhari-shallow-01",
      mapping: { method: "exact-coordinate", status: "exact" }
    },
    source: {
      providerId: "manual-test",
      sourceClass: "structured-angler-log",
      sourceRecordId: "record-1",
      sourceEventKey: null,
      sourceUrl: "https://example.com/records/1",
      title: "Short structured log"
    },
    provenance: {
      extractionMethod: "manual",
      extractorVersion: "manual-v1",
      mappingVersion: "wanoku-evidence-mapping.v1"
    },
    qualityFlags: ["effort-unknown"]
  };
}

function validEvidence() {
  return validatedEvidence(sampleEvidenceInput());
}

function validatedEvidence(input) {
  const result = buildSeabassExternalEvidence(input, ["makuhari-shallow-01", "funabashi-inner-01"]);
  if (!result.valid || !result.evidence) throw new Error(result.errors.join(" "));
  return result.evidence;
}

function persist(db, evidence, storedAt) {
  return persistSeabassExternalEvidence(db, { evidence, storedAt });
}

function apiEnv(db) {
  return { WANOKU_ADMIN_SECRET: ADMIN_SECRET, WANOKU_INTEL_D1: db };
}

function createRequest(body, authorized) {
  return new Request("https://worker.example/admin/evidence/seabass", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: `Bearer ${ADMIN_SECRET}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]));
}

class EvidenceD1 {
  constructor({ evidenceRows = [], raceOnInsert = false } = {}) {
    this.evidenceRows = evidenceRows;
    this.raceOnInsert = raceOnInsert;
    this.prepared = [];
    this.writeStatements = [];
  }

  prepare(sql) {
    const db = this;
    const prepared = { sql, params: [] };
    db.prepared.push(prepared);
    return {
      bind(...params) {
        prepared.params = params;
        return {
          async all() {
            if (sql.includes("FROM seabass_external_evidence")) {
              const [id, hash] = params;
              return {
                results: db.evidenceRows.filter((row) => row.id === id || row.payload_hash === hash).slice(0, 2)
              };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes("FROM seabass_external_evidence")) {
              return db.evidenceRows.find((row) => row.id === params[0]) ?? null;
            }
            return null;
          },
          async run() {
            if (!/^INSERT INTO seabass_external_evidence/i.test(sql)) throw new Error("unexpected D1 write");
            const row = evidenceRowFromParams(params);
            if (db.raceOnInsert) {
              const raceOnInsert = db.raceOnInsert;
              db.raceOnInsert = false;
              db.evidenceRows.push(typeof raceOnInsert === "function" ? raceOnInsert(row) : row);
              throw new Error("D1_CONSTRAINT");
            }
            if (db.evidenceRows.some((item) => item.id === row.id || item.payload_hash === row.payload_hash)) {
              throw new Error("D1_CONSTRAINT");
            }
            db.writeStatements.push(prepared);
            db.evidenceRows.push(row);
            return { success: true };
          }
        };
      }
    };
  }
}

function evidenceRowFromParams(params) {
  const [
    id,
    payloadHash,
    schemaVersion,
    speciesId,
    sourceIdentity,
    providerId,
    sourceClass,
    sourceRecordId,
    eventStartAt,
    eventEndAt,
    publishedAt,
    collectedAt,
    storedAt,
    mappedNodeId,
    evidenceType,
    presenceSupport,
    catchOutcome,
    payloadJson
  ] = params;
  return {
    id,
    payload_hash: payloadHash,
    schema_version: schemaVersion,
    species_id: speciesId,
    source_identity: sourceIdentity,
    provider_id: providerId,
    source_class: sourceClass,
    source_record_id: sourceRecordId,
    event_start_at: eventStartAt,
    event_end_at: eventEndAt,
    published_at: publishedAt,
    collected_at: collectedAt,
    stored_at: storedAt,
    mapped_node_id: mappedNodeId,
    evidence_type: evidenceType,
    presence_support: presenceSupport,
    catch_outcome: catchOutcome,
    payload_json: payloadJson
  };
}
