import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlySql,
  createFixtureDir,
  main,
  runD1ReadOnlyAudit,
  runAudit,
  statusToExitCode
} from "../../../scripts/wanoku-audit-environment.mjs";

const PROVIDERS = ["open-meteo-weather", "open-meteo-marine"];
const NODE_IDS = Array.from({ length: 12 }, (_, index) => `node-${String(index + 1).padStart(2, "0")}`);
const BASE_TIME = "2099-01-01T00:00:00Z";

function snapshot(nodeId, provider, overrides = {}) {
  return {
    nodeId,
    source: provider,
    observedAt: "2099-01-01T03:00:00Z",
    collectedAt: BASE_TIME,
    coordinateDistanceKm: provider === "open-meteo-weather" ? 2.1 : 3.2,
    confidence: 0.8,
    missingFields: [],
    ...overrides
  };
}

function qualityRow(sourceSnapshot, overrides = {}) {
  return {
    nodeId: sourceSnapshot.nodeId,
    source: sourceSnapshot.source,
    collectedAt: sourceSnapshot.collectedAt,
    coordinateDistanceKm: sourceSnapshot.coordinateDistanceKm,
    stale: false,
    missingRate: 0,
    confidence: 0.75,
    warnings: [],
    ...overrides
  };
}

function healthyFixtures(overrides = {}) {
  const snapshots = PROVIDERS.flatMap((provider) => NODE_IDS.map((nodeId) => snapshot(nodeId, provider)));
  const quality = snapshots.map((item) => qualityRow(item));
  return {
    "health.json": { ok: true },
    "current.json": { snapshots: overrides.snapshots || snapshots },
    "quality.json": { quality: overrides.quality || quality },
    "d1.json": overrides.d1 || {
      recentRuns: PROVIDERS.map((provider) => ({
        provider,
        requestedAt: BASE_TIME,
        completedAt: BASE_TIME,
        status: "ok",
        nodeCount: 12,
        okCount: 12,
        failedCount: 0
      })),
      failedRuns: [],
      snapshotSummary: PROVIDERS.map((provider) => ({
        provider,
        latestCollectedAt: BASE_TIME,
        snapshotCount: 12,
        distinctNodes: 12,
        collectedMissing: 0,
        distanceMissing: 0,
        modelCount: 0,
        forecastIssuedAtMisuseCount: 0
      }))
    }
  };
}

async function withFixture(files, fn) {
  const fixture = createFixtureDir(files);
  try {
    return await fn(fixture.dir);
  } finally {
    fixture.cleanup();
  }
}

describe("wanoku environment audit script", () => {
  it("reports HEALTHY from fixture data with only gust informational warnings", async () => {
    await withFixture(healthyFixtures({
      quality: healthyFixtures()["quality.json"].quality.map((item, index) => index === 0
        ? { ...item, warnings: ["wind_gust_below_sustained_wind"] }
        : item)
    }), async (fixtureDir) => {
      const report = await runAudit({ fixtureDir, expectedNodes: 12, sinceHours: 6 });

      expect(report.status).toBe("HEALTHY");
      expect(statusToExitCode(report.status)).toBe(0);
      expect(report.current.snapshotCount).toBe(24);
      expect(report.quality.warningCounts.wind_gust_below_sustained_wind).toBe(1);
      expect(report.informationalWarnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "wind_gust_below_sustained_wind", count: 1 })
      ]));
    });
  });

  it("reports DEGRADED for stale quality or an 11/12 recent run", async () => {
    const base = healthyFixtures();
    await withFixture(healthyFixtures({
      quality: base["quality.json"].quality.map((item, index) => index === 0 ? { ...item, stale: true } : item),
      d1: {
        ...base["d1.json"],
        recentRuns: base["d1.json"].recentRuns.map((run, index) => index === 0
          ? { ...run, nodeCount: 11, okCount: 11, failedCount: 1, status: "partial" }
          : run)
      }
    }), async (fixtureDir) => {
      const report = await runAudit({ fixtureDir, expectedNodes: 12, sinceHours: 6 });

      expect(report.status).toBe("DEGRADED");
      expect(statusToExitCode(report.status)).toBe(1);
      expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["stale_quality", "recent_run_partial"]));
    });
  });

  it("reports FAILED when one provider is missing from current snapshots", async () => {
    const weatherOnly = NODE_IDS.map((nodeId) => snapshot(nodeId, "open-meteo-weather"));
    await withFixture(healthyFixtures({
      snapshots: weatherOnly,
      quality: weatherOnly.map((item) => qualityRow(item))
    }), async (fixtureDir) => {
      const report = await runAudit({ fixtureDir, expectedNodes: 12, sinceHours: 6 });

      expect(report.status).toBe("FAILED");
      expect(statusToExitCode(report.status)).toBe(2);
      expect(report.issues.map((issue) => issue.code)).toContain("provider_missing");
    });
  });

  it("detects legacy model contamination and missing coordinate distance", async () => {
    const base = healthyFixtures();
    const snapshots = base["current.json"].snapshots.map((item, index) => index === 0
      ? { ...item, model: "GMT+9", coordinateDistanceKm: undefined }
      : item);
    await withFixture(healthyFixtures({
      snapshots,
      quality: snapshots.map((item) => qualityRow(item)),
      d1: {
        ...base["d1.json"],
        snapshotSummary: base["d1.json"].snapshotSummary.map((row, index) => index === 0
          ? { ...row, distanceMissing: 1, modelCount: 1 }
          : row)
      }
    }), async (fixtureDir) => {
      const report = await runAudit({ fixtureDir, expectedNodes: 12, sinceHours: 6 });

      expect(report.status).toBe("DEGRADED");
      expect(report.current.modelCount).toBe(1);
      expect(report.current.coordinateDistanceMissing).toBe(1);
      expect(report.d1.modelCount).toBe(1);
    });
  });

  it("prints a single JSON object in --json fixture mode", async () => {
    await withFixture(healthyFixtures(), async (fixtureDir) => {
      const result = spawnSync("node", [
        path.join("scripts", "wanoku-audit-environment.mjs"),
        "--fixture-dir",
        fixtureDir,
        "--json"
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        shell: false
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe("HEALTHY");
      expect(result.stdout.trim().startsWith("{")).toBe(true);
      expect(result.stdout.trim().endsWith("}")).toBe(true);
    });
  });

  it("runs Wrangler through process.execPath with an argument array instead of spawning bare npx", () => {
    const calls = [];
    const wranglerCli = "C:\\repo with space\\node_modules\\wrangler\\bin\\wrangler.js";
    const config = "C:\\repo with space\\workers\\wanoku-intel-worker\\wrangler.toml";
    runD1ReadOnlyAudit({
      database: "WANOKU_INTEL_D1",
      config,
      sinceHours: 6,
      wranglerCli,
      processRunner: (file, args, options) => {
        calls.push({ file, args, options });
        return { status: 0, stdout: JSON.stringify([{ results: [] }]), stderr: "" };
      }
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.file).toBe(process.execPath);
      expect(call.file).not.toBe("npx");
      expect(call.args[0]).toBe(wranglerCli);
      expect(call.args).toEqual(expect.arrayContaining(["d1", "execute", "WANOKU_INTEL_D1", "--remote", "--json", "--config", config]));
      expect(call.args).not.toContain("npx");
      expect(call.options.shell).toBe(false);
      expect(call.options.windowsHide).toBe(true);
      expect(call.args[call.args.indexOf("--command") + 1]).toMatch(/select|with/i);
    }
  });

  it("does not resolve Wrangler or run D1 in fixture mode", async () => {
    await withFixture(healthyFixtures(), async (fixtureDir) => {
      const report = await runAudit({
        fixtureDir,
        expectedNodes: 12,
        sinceHours: 6,
        requireFn: { resolve: () => { throw new Error("should not resolve wrangler"); } },
        processRunner: () => { throw new Error("should not run D1"); }
      });

      expect(report.status).toBe("HEALTHY");
    });
  });

  it("returns exit code 3 with a clear message when local Wrangler cannot be resolved", async () => {
    let stdout = "";
    let stderr = "";
    const code = await main([], {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } }
    }, {
      fetchPublicApiImpl: async () => ({
        health: { ok: true },
        current: { snapshots: [] },
        quality: { quality: [] }
      }),
      requireFn: {
        resolve: () => { throw new Error("missing wrangler"); }
      }
    });

    expect(code).toBe(3);
    expect(stdout).toBe("");
    expect(stderr).toContain("Wrangler CLI could not be resolved from this repository.");
    expect(stderr).toContain("Run npm install and try again.");
    expect(stderr).not.toMatch(/stack|secret/i);
  });

  it("refuses mutating SQL", () => {
    expect(() => assertReadOnlySql("SELECT * FROM source_runs")).not.toThrow();
    expect(() => assertReadOnlySql("UPDATE source_runs SET status = 'ok'")).toThrow(/Refusing/);
  });
});
