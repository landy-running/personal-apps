import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WAKUWAKUYA_PRODUCTION_WORKER_URL,
  parseWakuwakuyaEvidenceIngestArgs,
  runWakuwakuyaEvidenceIngest,
  wakuwakuyaMonthlySourceUrl
} from "../../../scripts/wanoku-wakuwakuya-evidence-ingest.mjs";
import {
  validateWakuwakuyaExternalEvidenceInput
} from "../../../scripts/wanoku-wakuwakuya-evidence-preview.mjs";

const MONTH = "2026-06";
const COLLECTED_AT = "2026-08-16T14:30:00.000Z";
const WORKER_URL = "https://worker.example";
const SECRET = "test-admin-secret-never-log";

describe("Wanoku Wakuwakuya Batch Ingestion v1", () => {
  it("defaults to dry-run, requires a month, and fixes the official source URL", () => {
    expect(parseWakuwakuyaEvidenceIngestArgs(["--month", MONTH])).toEqual({ month: MONTH, apply: false });
    expect(parseWakuwakuyaEvidenceIngestArgs(["--month", MONTH, "--apply"])).toEqual({ month: MONTH, apply: true });
    expect(() => parseWakuwakuyaEvidenceIngestArgs([])).toThrow("--month YYYY-MM is required");
    expect(() => parseWakuwakuyaEvidenceIngestArgs(["--month", "2026-13"])).toThrow("month must be YYYY-MM");
    expect(WAKUWAKUYA_PRODUCTION_WORKER_URL).toBe("https://wanoku-intel-worker.mtk0808.workers.dev");
    expect(wakuwakuyaMonthlySourceUrl(MONTH)).toBe("https://wakuwakuya.jp/blog.php?f=m&mon=2026-06");
  });

  it("runs dry without a secret, fetches the source once, and never sends POST or Authorization", async () => {
    const http = mockHttp({ html: page([catchEntry()]) });
    const summary = await run(http.fetchImpl);

    expect(summary).toMatchObject({ mode: "DRY_RUN", sourceFetchedAt: COLLECTED_AT, wouldCreate: 1, created: 0 });
    expect(http.sourceCalls).toHaveLength(1);
    expect(http.postCalls).toHaveLength(0);
    expect(http.calls.filter((call) => call.init?.headers?.Authorization)).toHaveLength(0);
  });

  it("preflights GENERATED only and excludes skipped, cancelled, and unresolved articles", async () => {
    const http = mockHttp({
      html: page([
        catchEntry(),
        fishObservationEntry(),
        interactionEntry(),
        skippedEntry(),
        unresolvedEntry(),
        cancelledEntry()
      ])
    });
    const summary = await run(http.fetchImpl);

    expect(http.preflightCalls).toHaveLength(3);
    expect(http.postCalls).toHaveLength(0);
    expect(summary).toMatchObject({
      articlesDiscovered: 6,
      seabassRelevant: 6,
      generated: 3,
      skippedNotRepresentable: 1,
      skippedAmbiguous: 1,
      cancelled: 1,
      stableIdUnresolved: 2
    });
  });

  it("classifies verified 200 as EXISTING and 404 as WOULD_CREATE", async () => {
    const http = mockHttp({
      html: page([catchEntry(), interactionEntry()]),
      preflight: (id, index) => index === 0 ? existingResponse(id) : jsonResponse(404, {})
    });
    const summary = await run(http.fetchImpl);

    expect(summary).toMatchObject({ existing: 1, wouldCreate: 1, fatalErrors: [] });
    expect(summary.records.filter((record) => record.evidenceId).map((record) => record.status)).toEqual([
      "EXISTING",
      "WOULD_CREATE"
    ]);
  });

  it("makes an unexpected preflight response fatal before any POST", async () => {
    const http = mockHttp({
      html: page([catchEntry(), interactionEntry()]),
      preflight: () => jsonResponse(503, {})
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.ok).toBe(false);
    expect(summary.fatalErrors[0]).toMatchObject({ code: "preflight_http_error", httpStatus: 503 });
    expect(http.preflightCalls).toHaveLength(1);
    expect(http.postCalls).toHaveLength(0);
  });

  it("rejects apply without WANOKU_ADMIN_SECRET before source acquisition", async () => {
    const fetchImpl = vi.fn();
    await expect(runWakuwakuyaEvidenceIngest(runOptions({ apply: true, adminSecret: "", fetchImpl })))
      .rejects.toMatchObject({ code: "admin_secret_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts only missing externalEvidenceInput without derived or adapter fields", async () => {
    const http = mockHttp({
      html: page([catchEntry(), fishObservationEntry()]),
      preflight: (id, index) => index === 0 ? existingResponse(id) : jsonResponse(404, {}),
      post: createdPost
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });
    const request = JSON.parse(http.postCalls[0].init.body);

    expect(summary).toMatchObject({ existing: 1, created: 1 });
    expect(http.postCalls).toHaveLength(1);
    expect(request.source.sourceRecordId).toBe("post:160002");
    expect(request).not.toHaveProperty("sourceIdentity");
    expect(request).not.toHaveProperty("adapterMetadata");
    expect(request).not.toHaveProperty("canonicalEvidence");
    expect(request).not.toHaveProperty("evidenceId");
    expect(http.postCalls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("applies missing records sequentially", async () => {
    let activePosts = 0;
    let maxActivePosts = 0;
    const http = mockHttp({
      html: page([catchEntry(), fishObservationEntry(), interactionEntry()]),
      post: async (id) => {
        activePosts += 1;
        maxActivePosts = Math.max(maxActivePosts, activePosts);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activePosts -= 1;
        return createdResponse(id);
      }
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.created).toBe(3);
    expect(http.postCalls).toHaveLength(3);
    expect(maxActivePosts).toBe(1);
  });

  it("stops on the first create failure and reports partial progress", async () => {
    let postCount = 0;
    const http = mockHttp({
      html: page([catchEntry(), fishObservationEntry(), interactionEntry()]),
      post: (id) => {
        postCount += 1;
        return postCount === 2 ? jsonResponse(429, {}) : createdResponse(id);
      }
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(http.postCalls).toHaveLength(2);
    expect(summary).toMatchObject({
      created: 1,
      failed: 1,
      createdBeforeFailure: 1,
      remaining: 1,
      ok: false
    });
    expect(summary.failedEvidenceId).toMatch(/^wanoku-seabass-evidence:/u);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("is idempotent when an exact retry preflight finds the created evidence", async () => {
    const existing = new Set();
    const http = mockHttp({
      html: page([catchEntry()]),
      preflight: (id) => existing.has(id) ? existingResponse(id) : jsonResponse(404, {}),
      post: (id) => {
        existing.add(id);
        return createdResponse(id);
      }
    });
    const first = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });
    const second = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(first).toMatchObject({ created: 1, existing: 0 });
    expect(second).toMatchObject({ created: 0, existing: 1 });
    expect(http.postCalls).toHaveLength(1);

    const raced = mockHttp({
      html: page([catchEntry()]),
      post: (id) => jsonResponse(200, { evidenceId: id, payloadHash: hashFromId(id), created: false })
    });
    expect(await run(raced.fetchImpl, { apply: true, adminSecret: SECRET })).toMatchObject({
      created: 0,
      existing: 1,
      ok: true
    });
  });

  it("uses one collectedAt per acquisition while keeping evidence IDs stable across acquisitions", async () => {
    const html = page([catchEntry(), fishObservationEntry(), interactionEntry()]);
    const first = await run(mockHttp({ html }).fetchImpl);
    const second = await run(mockHttp({ html }).fetchImpl, { collectedAt: "2026-08-16T15:30:00.000Z" });
    const generated = (summary) => summary.records.filter((record) => record.evidenceId);

    expect(generated(first).map((record) => record.evidenceId)).toEqual(generated(second).map((record) => record.evidenceId));
    expect(first.collectedAt).toBe(COLLECTED_AT);
    expect(second.collectedAt).toBe("2026-08-16T15:30:00.000Z");
  });

  it("reports semantic classes and all skip categories without retaining article text", async () => {
    const rawMarker = "RAW_ARTICLE_TEXT_MUST_NOT_SURVIVE";
    const http = mockHttp({
      html: page([
        catchEntry({ body: `シーバス2本キャッチ。${rawMarker}` }),
        fishObservationEntry(),
        interactionEntry(),
        skippedEntry(),
        unresolvedEntry(),
        cancelledEntry()
      ])
    });
    const summary = await run(http.fetchImpl);

    expect(summary.evidenceTypeDistribution).toEqual({
      catch: 1,
      "fish-observation": 1,
      "bite-or-contact": 1,
      "explicit-effort-zero-catch": 0
    });
    expect(summary.records.find((record) => record.sourceRecordId === "post:160002")).toMatchObject({
      semanticClass: "landed-positive-unquantified",
      status: "WOULD_CREATE"
    });
    expect(summary.records.find((record) => record.sourceRecordId === "post:160003")).toMatchObject({
      diagnostics: expect.any(Array),
      conditionChanges: expect.any(Array),
      habitatClues: expect.any(Array)
    });
    expect(summary.records.map((record) => record.status)).toEqual(expect.arrayContaining([
      "SKIPPED_NOT_REPRESENTABLE",
      "SKIPPED_AMBIGUOUS",
      "CANCELLED"
    ]));
    expect(JSON.stringify(summary)).not.toContain(rawMarker);
  });

  it("treats source identity collisions as fatal before preflight or POST", async () => {
    const http = mockHttp({ html: page([catchEntry(), catchEntry({ date: "2026-06-06" })]) });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.identityCollision).toBe(2);
    expect(summary.fatalErrors[0].code).toBe("source_identity_collision");
    expect(http.preflightCalls).toHaveLength(0);
    expect(http.postCalls).toHaveLength(0);
  });

  it("writes only a safe summary artifact outside the repository when requested", async () => {
    const summaryPath = path.join(tmpdir(), `wanoku-wakuwakuya-ingest-test-${process.pid}.json`);
    const rawMarker = "RAW_ARTICLE_BODY_SECRETISH_MARKER";
    const http = mockHttp({ html: page([catchEntry({ body: `シーバス2本キャッチ。${rawMarker}` })]) });
    try {
      const summary = await run(http.fetchImpl, { summaryPath });
      const artifact = await readFile(summaryPath, "utf8");

      expect(summary.summaryArtifact).toBe(summaryPath);
      expect(artifact).toContain('"revisionDetection": "id-only-preflight"');
      expect(artifact).not.toContain(rawMarker);
      expect(artifact).not.toContain(SECRET);
    } finally {
      await rm(summaryPath, { force: true });
    }
  });

  it("contains no direct D1 write, scheduler, or alternate execution mode", async () => {
    const script = await readFile("scripts/wanoku-wakuwakuya-evidence-ingest.mjs", "utf8");

    expect(script).not.toMatch(/wrangler\s+d1|INSERT\s+INTO|UPDATE\s+[a-z_]+|DELETE\s+FROM/iu);
    expect(script).not.toMatch(/cron|setInterval|--execute|retry-existing/iu);
  });
});

async function run(fetchImpl, overrides = {}) {
  return runWakuwakuyaEvidenceIngest(runOptions({ fetchImpl, ...overrides }));
}

function runOptions(overrides = {}) {
  return {
    month: MONTH,
    collectedAt: COLLECTED_AT,
    workerBaseUrl: WORKER_URL,
    delayMs: 0,
    summaryPath: null,
    ...overrides
  };
}

function mockHttp({ html, preflight = () => jsonResponse(404, {}), post = createdPost }) {
  const calls = [];
  const sourceCalls = [];
  const preflightCalls = [];
  const postCalls = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (url === wakuwakuyaMonthlySourceUrl(MONTH)) {
      sourceCalls.push(call);
      return htmlResponse(html);
    }
    if (init.method === "GET") {
      preflightCalls.push(call);
      const id = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return preflight(id, preflightCalls.length - 1);
    }
    if (init.method === "POST") {
      postCalls.push(call);
      const request = JSON.parse(init.body);
      const id = validateWakuwakuyaExternalEvidenceInput(request).evidenceId;
      return post(id, postCalls.length - 1, request);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { fetchImpl, calls, sourceCalls, preflightCalls, postCalls };
}

function page(entries) {
  return `<html><body>${entries.join("")}</body></html>`;
}

function catchEntry(overrides = {}) {
  return section({ id: 160001, date: "2026-06-05", body: "シーバス2本キャッチ。", ...overrides });
}

function fishObservationEntry(overrides = {}) {
  return section({ id: 160002, date: "2026-06-06", body: "シーバスはポツポツ釣れて全員安打でした。", ...overrides });
}

function interactionEntry(overrides = {}) {
  return section({ id: 160003, date: "2026-06-07", body: "シーバスは終始ヒットが続きました。", ...overrides });
}

function skippedEntry(overrides = {}) {
  return section({ id: 160004, date: "2026-06-08", body: "シーバスを探して各所を回りました。", ...overrides });
}

function unresolvedEntry(overrides = {}) {
  return section({ id: null, date: "2026-06-09", body: "シーバス2本キャッチ。", ...overrides });
}

function cancelledEntry(overrides = {}) {
  return section({ id: null, date: "2026-06-10", body: "強風のため出船中止。シーバス便は欠航です。", ...overrides });
}

function section({ id, date, body, heading = "午前シーバス便" }) {
  const [year, month, day] = date.split("-").map(Number);
  return `<section class="frame">
    <h2><time>${year}年${month}月${day}日(日)</time>${heading}</h2>
    <div class="frame-inner"><p>${body}</p>
      ${id ? `<img src="https://choka.fishing-v.jp/funayado_images/62_${id}_20260610120000_1.jpeg">` : ""}
    </div>
  </section>`;
}

function htmlResponse(html) {
  return { ok: true, status: 200, text: async () => html };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function existingResponse(id) {
  return jsonResponse(200, { evidenceId: id, payloadHash: hashFromId(id) });
}

function createdPost(id) {
  return createdResponse(id);
}

function createdResponse(id) {
  return jsonResponse(201, { evidenceId: id, payloadHash: hashFromId(id), created: true });
}

function hashFromId(id) {
  return id.slice("wanoku-seabass-evidence:".length);
}
