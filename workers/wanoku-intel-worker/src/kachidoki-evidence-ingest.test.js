import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  KACHIDOKI_PRODUCTION_WORKER_URL,
  kachidokiMonthlySourceUrl,
  parseKachidokiEvidenceIngestArgs,
  runKachidokiEvidenceIngest
} from "../../../scripts/wanoku-kachidoki-evidence-ingest.mjs";
import { validateKachidokiExternalEvidenceInput } from "../../../scripts/wanoku-kachidoki-evidence-preview.mjs";

const MONTH = "2026-06";
const COLLECTED_AT = "2026-08-16T11:00:00.000Z";
const WORKER_URL = "https://worker.example";
const SECRET = "test-admin-secret-never-log";
const JUNE_24_ID = "wanoku-seabass-evidence:b3ceb2bba24813621a3f0000b70a54c09f1dba06a1cc76318074309fe90b1ba2";
const JUNE_24 = "6/24（水）チョイノリ【NIGHT】<br>シーバス 5hit 4get";
const JUNE_19 = "6/19（金）チョイノリ【NIGHT】<br>シーバス 20HIT以上 9GET バラシあり";
const JUNE_4_ZERO = "6/4（木）チョイノリ【NIGHT】<br>後半戦のシーバスへ。シーバスは次回へ持ち越し。";
const MIXED_SPECIES = "6/18（木）チョイノリ【DAY】<br>シーバス 2get クロダイ 8hit 水面バイト チェイス バラシ";

describe("Wanoku Kachidoki Batch Ingestion v1", () => {
  it("defaults to dry-run and requires an explicit month", () => {
    expect(parseKachidokiEvidenceIngestArgs(["--month", MONTH])).toEqual({ month: MONTH, apply: false });
    expect(parseKachidokiEvidenceIngestArgs(["--month", MONTH, "--apply"])).toEqual({ month: MONTH, apply: true });
    expect(() => parseKachidokiEvidenceIngestArgs([])).toThrow("--month YYYY-MM is required");
    expect(() => parseKachidokiEvidenceIngestArgs(["--month", "2026-13"])).toThrow("month must be YYYY-MM");
  });

  it("uses the fixed production origin and deterministic official monthly URL", () => {
    expect(KACHIDOKI_PRODUCTION_WORKER_URL).toBe("https://wanoku-intel-worker.mtk0808.workers.dev");
    expect(kachidokiMonthlySourceUrl(MONTH)).toBe("https://kachidoki-marina.com/fishing-results-202606/");
  });

  it("runs dry without a secret, fetches the source once, and performs zero POSTs", async () => {
    const http = mockHttp({ html: page([JUNE_24]) });
    const summary = await run(http.fetchImpl);

    expect(summary.mode).toBe("DRY_RUN");
    expect(summary.collectedAt).toBe(COLLECTED_AT);
    expect(summary.wouldCreate).toBe(1);
    expect(http.sourceCalls).toHaveLength(1);
    expect(http.postCalls).toHaveLength(0);
    expect(http.calls.filter((call) => call.init?.headers?.Authorization)).toHaveLength(0);
  });

  it("requires WANOKU_ADMIN_SECRET before any apply fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(runKachidokiEvidenceIngest(runOptions({ apply: true, adminSecret: "", fetchImpl })))
      .rejects.toMatchObject({ code: "admin_secret_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts exact externalEvidenceInput without sourceIdentity or output envelopes", async () => {
    const http = mockHttp({ html: page([JUNE_24]), post: createdPost });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });
    const request = JSON.parse(http.postCalls[0].init.body);

    expect(summary.created).toBe(1);
    expect(request.source.sourceEventKey).toBe("2026-06-24-night-seabass");
    expect(request).not.toHaveProperty("sourceIdentity");
    expect(request).not.toHaveProperty("evidenceId");
    expect(request).not.toHaveProperty("payloadHash");
    expect(request).not.toHaveProperty("canonicalEvidence");
    expect(http.postCalls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("does not expose the admin secret in summaries or controlled failures", async () => {
    const http = mockHttp({ html: page([JUNE_24]), post: () => jsonResponse(503, { error: SECRET }) });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.fatalErrors[0]).toMatchObject({ code: "create_http_error", httpStatus: 503 });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("marks a verified preflight 200 as EXISTING", async () => {
    const http = mockHttp({ html: page([JUNE_24]), preflight: existingPreflight });
    const summary = await run(http.fetchImpl);

    expect(summary.existing).toBe(1);
    expect(summary.wouldCreate).toBe(0);
    expect(summary.records[0]).toMatchObject({ evidenceId: JUNE_24_ID, status: "EXISTING" });
  });

  it("marks preflight 404 as WOULD_CREATE", async () => {
    const http = mockHttp({ html: page([JUNE_24]) });
    const summary = await run(http.fetchImpl);

    expect(summary.existing).toBe(0);
    expect(summary.wouldCreate).toBe(1);
    expect(summary.records[0].status).toBe("WOULD_CREATE");
  });

  it("aborts preflight 500 before all writes", async () => {
    const http = mockHttp({ html: page([JUNE_24]), preflight: () => jsonResponse(500, { error: "integrity" }) });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.ok).toBe(false);
    expect(summary.fatalErrors[0]).toMatchObject({ code: "preflight_integrity_or_server_error", httpStatus: 500 });
    expect(http.postCalls).toHaveLength(0);
  });

  it("aborts an unexpected preflight status before all writes", async () => {
    const http = mockHttp({ html: page([JUNE_24]), preflight: () => jsonResponse(429, {}) });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.fatalErrors[0]).toMatchObject({ code: "preflight_http_error", httpStatus: 429 });
    expect(http.postCalls).toHaveLength(0);
  });

  it("treats a preflight ID or hash mismatch as fatal", async () => {
    const wrongId = mockHttp({
      html: page([JUNE_24]),
      preflight: (id) => jsonResponse(200, { evidenceId: `${id}x`, payloadHash: hashFromId(id) })
    });
    const wrongHash = mockHttp({
      html: page([JUNE_24]),
      preflight: (id) => jsonResponse(200, { evidenceId: id, payloadHash: "0".repeat(64) })
    });

    expect((await run(wrongId.fetchImpl)).fatalErrors[0].code).toBe("preflight_identity_mismatch");
    expect((await run(wrongHash.fetchImpl)).fatalErrors[0].code).toBe("preflight_identity_mismatch");
  });

  it("aborts source identity collisions before preflight or POST", async () => {
    const http = mockHttp({ html: page([JUNE_24, JUNE_24]) });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.ambiguous).toBe(2);
    expect(summary.fatalErrors[0].code).toBe("source_identity_collision");
    expect(http.preflightCalls).toHaveLength(0);
    expect(http.postCalls).toHaveLength(0);
  });

  it("aborts an invalid builder result before preflight or POST", async () => {
    const http = mockHttp({ html: page([JUNE_24]) });
    const validateEvidenceImpl = () => ({ valid: false, errors: ["invalid"], warnings: [], evidence: null });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET, validateEvidenceImpl });

    expect(summary.fatalErrors[0].code).toBe("invalid_generated_evidence");
    expect(http.preflightCalls).toHaveLength(0);
    expect(http.postCalls).toHaveLength(0);
  });

  it("skips preflight-existing records during apply", async () => {
    const http = mockHttp({ html: page([JUNE_24]), preflight: existingPreflight, post: createdPost });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.existing).toBe(1);
    expect(summary.created).toBe(0);
    expect(http.postCalls).toHaveLength(0);
  });

  it("applies missing records sequentially", async () => {
    let activePosts = 0;
    let maxActivePosts = 0;
    const http = mockHttp({
      html: page([JUNE_24, JUNE_19, JUNE_4_ZERO]),
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

  it("accepts only matching 201 created=true and matching 200 created=false", async () => {
    const created = mockHttp({ html: page([JUNE_24]), post: createdPost });
    const raced = mockHttp({
      html: page([JUNE_24]),
      post: (id) => jsonResponse(200, { evidenceId: id, payloadHash: hashFromId(id), created: false })
    });

    expect((await run(created.fetchImpl, { apply: true, adminSecret: SECRET })).created).toBe(1);
    expect((await run(raced.fetchImpl, { apply: true, adminSecret: SECRET })).existing).toBe(1);
  });

  it("stops on a create response evidence ID mismatch", async () => {
    const http = mockHttp({
      html: page([JUNE_24]),
      post: (id) => jsonResponse(201, { evidenceId: `${id}x`, payloadHash: hashFromId(id), created: true })
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.failed).toBe(1);
    expect(summary.fatalErrors[0].code).toBe("create_evidence_id_mismatch");
  });

  it("stops on a create response payload hash mismatch", async () => {
    const http = mockHttp({
      html: page([JUNE_24]),
      post: (id) => jsonResponse(201, { evidenceId: id, payloadHash: "0".repeat(64), created: true })
    });
    const summary = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(summary.failed).toBe(1);
    expect(summary.fatalErrors[0].code).toBe("create_payload_hash_mismatch");
  });

  it("reports partial progress and leaves remaining records retryable", async () => {
    const existing = new Set();
    let failSecondPost = true;
    let postCount = 0;
    const http = mockHttp({
      html: page([JUNE_24, JUNE_19, JUNE_4_ZERO]),
      preflight: (id) => existing.has(id) ? existingPreflight(id) : jsonResponse(404, {}),
      post: (id) => {
        postCount += 1;
        if (failSecondPost && postCount === 2) return jsonResponse(429, {});
        existing.add(id);
        return createdResponse(id);
      }
    });
    const first = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });

    expect(first).toMatchObject({ created: 1, failed: 1, createdBeforeFailure: 1, remaining: 1 });
    expect(first.failedEvidenceId).toMatch(/^wanoku-seabass-evidence:/u);

    failSecondPost = false;
    postCount = 0;
    const second = await run(http.fetchImpl, { apply: true, adminSecret: SECRET });
    expect(second).toMatchObject({ existing: 1, created: 2, failed: 0, remaining: 0, ok: true });
  });

  it("preserves explicit zero, lower-bound interaction, and mixed-species isolation", async () => {
    const http = mockHttp({ html: page([JUNE_24, JUNE_19, JUNE_4_ZERO, MIXED_SPECIES]) });
    const summary = await run(http.fetchImpl);
    const june19 = record(summary, "2026-06-19-night-seabass");
    const june4 = record(summary, "2026-06-04-night-seabass");
    const mixed = record(summary, "2026-06-18-day-seabass");

    expect(june19).toMatchObject({ catchCount: 9, interaction: { present: true, count: null, countLowerBound: 20 } });
    expect(june4).toMatchObject({
      evidenceType: "explicit-effort-zero-catch",
      presenceSupport: "none",
      directFishEvidence: false,
      catchCount: 0
    });
    expect(mixed).toMatchObject({ catchCount: 2, interaction: { present: null, count: null, countLowerBound: null } });
  });

  it("uses one explicit collectedAt for every generated admin request", async () => {
    const seen = [];
    const http = mockHttp({ html: page([JUNE_24, JUNE_19, JUNE_4_ZERO]) });
    const validateEvidenceImpl = (input) => {
      seen.push(input.collectedAt);
      return validateKachidokiExternalEvidenceInput(input);
    };
    const summary = await run(http.fetchImpl, { validateEvidenceImpl });

    expect(summary.sourceFetchedAt).toBe(COLLECTED_AT);
    expect(seen).toEqual([COLLECTED_AT, COLLECTED_AT, COLLECTED_AT]);
  });

  it("writes only a safe summary artifact outside the repository when requested", async () => {
    const summaryPath = path.join(tmpdir(), `wanoku-kachidoki-ingest-test-${process.pid}.json`);
    const http = mockHttp({ html: page([JUNE_24]) });
    try {
      const summary = await run(http.fetchImpl, { summaryPath });
      const artifact = await readFile(summaryPath, "utf8");

      expect(summary.summaryArtifact).toBe(summaryPath);
      expect(artifact).toContain('"mode": "DRY_RUN"');
      expect(artifact).not.toContain(JUNE_24);
      expect(artifact).not.toContain(SECRET);
    } finally {
      await rm(summaryPath, { force: true });
    }
  });

  it("contains no direct D1 write, retry-existing mode, or scheduler", async () => {
    const script = await readFile("scripts/wanoku-kachidoki-evidence-ingest.mjs", "utf8");

    expect(script).not.toMatch(/wrangler\s+d1|INSERT\s+INTO|UPDATE\s+[a-z_]+|DELETE\s+FROM/iu);
    expect(script).not.toContain("retry-existing");
    expect(script).not.toMatch(/cron|setInterval/iu);
  });
});

async function run(fetchImpl, overrides = {}) {
  return runKachidokiEvidenceIngest(runOptions({ fetchImpl, ...overrides }));
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
    if (url === kachidokiMonthlySourceUrl(MONTH)) {
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
      const id = validateKachidokiExternalEvidenceInput(request).evidenceId;
      return post(id, postCalls.length - 1, request);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { fetchImpl, calls, sourceCalls, preflightCalls, postCalls };
}

function page(captions) {
  return `<!doctype html>
    <meta property="article:published_time" content="2026-07-01T16:05:12+09:00">
    <article id="post-5470" class="article page">
      <div class="swiper-wrapper">${captions.map((caption) => (
        `<div class="swiper-slide"><figure class="slide"><div class="slide-media"></div><figcaption class="slide-title">${caption}</figcaption></figure></div>`
      )).join("")}</div>
    </article>`;
}

function htmlResponse(html) {
  return { ok: true, status: 200, text: async () => html };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function existingPreflight(id) {
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

function record(summary, sourceEventKey) {
  const value = summary.records.find((item) => item.sourceEventKey === sourceEventKey);
  if (!value) throw new Error(`Record not found: ${sourceEventKey}`);
  return value;
}
