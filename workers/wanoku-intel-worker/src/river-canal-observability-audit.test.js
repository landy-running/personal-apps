import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_SOURCES,
  CORRIDORS,
  OFFICIAL_STATIONS,
  RIVER_CANAL_AUDIT_VERSION,
  assertCoordinatesHaveEvidence,
  assertNoDuplicateStations,
  buildObservabilityMatrix,
  buildRiverCanalObservabilityAudit,
  buildSegmentGraph,
  buildSegmentId,
  buildStationStableId,
  normalizeAuditReadUrl,
  normalizeJstTimestamp,
  normalizePublishedValue,
  parseRiverCanalAuditArgs,
  runRiverCanalObservabilityAudit
} from "../../../scripts/wanoku-river-canal-observability-audit.mjs";

const COLLECTED_AT = "2026-08-17T03:00:00.000Z";

describe("Wanoku River / Canal Observability Audit v1", () => {
  it("uses provider-native station identity as the stable key", () => {
    const iwabuchi = OFFICIAL_STATIONS.find((station) => station.stationId === "303041283309040");
    expect(iwabuchi).toMatchObject({
      providerId: "mlit-hydrology",
      stationId: "303041283309040",
      stableId: "mlit-hydrology:303041283309040",
      identityBasis: "native station code",
      sourceStructure: expect.stringContaining("HTML station metadata")
    });
    expect(buildStationStableId(iwabuchi.providerId, iwabuchi.stationId)).toBe(iwabuchi.stableId);
  });

  it("normalizes missing and paused source values to explicit null, never zero", () => {
    expect(normalizePublishedValue("欠測")).toEqual({ value: null, missingReason: "source-missing" });
    expect(normalizePublishedValue("休止・欠測等")).toEqual({ value: null, missingReason: "source-missing" });
    expect(normalizePublishedValue("--")).toEqual({ value: null, missingReason: "source-missing" });
    expect(normalizePublishedValue(null)).toEqual({ value: null, missingReason: "not-provided" });
    expect(normalizePublishedValue("0.00")).toEqual({ value: 0, missingReason: null });
  });

  it("normalizes an explicit JST station minute to canonical UTC", () => {
    expect(normalizeJstTimestamp("2026-08-17 09:10")).toBe("2026-08-17T00:10:00.000Z");
    expect(() => normalizeJstTimestamp("2026-02-30 09:10")).toThrow("timestamp is invalid");
  });

  it("retains explicit station-to-river and station-to-segment mapping", () => {
    const gateBack = OFFICIAL_STATIONS.find((station) => station.stationId === "303041283309101");
    expect(gateBack).toMatchObject({ corridorId: "nakagawa", segmentId: "NKG-0", river: "中川" });
    expect(CORRIDORS.find((corridor) => corridor.corridorId === gateBack.corridorId).segments.some((segment) => segment.segmentId === gateBack.segmentId)).toBe(true);
  });

  it("never invents segment coordinates and requires evidence for every station coordinate", () => {
    expect(CORRIDORS.flatMap((corridor) => corridor.segments).every((segment) => segment.coordinates === null)).toBe(true);
    expect(assertCoordinatesHaveEvidence(OFFICIAL_STATIONS)).toBe(true);
    expect(() => assertCoordinatesHaveEvidence([{ stableId: "bad", officialCoordinates: { latitude: 35, longitude: 139 } }])).toThrow("Coordinate evidence missing");
  });

  it("keeps hydraulic controls on graph edges", () => {
    const graph = buildSegmentGraph();
    expect(graph.edges.find((edge) => edge.edgeId === "BRANCH-NKG-ARA")).toMatchObject({
      connectionType: "branch-connection",
      gateControlled: true,
      controlName: "中川水門"
    });
    expect(graph.edges.find((edge) => edge.edgeId === "BRANCH-HNM-INBA")).toMatchObject({ gateControlled: true });
  });

  it("never promotes periodic water quality to realtime environment", () => {
    const waterQuality = OFFICIAL_STATIONS.find((station) => station.providerId === "chiba-water-quality");
    expect(waterQuality.metrics).toContainEqual(expect.objectContaining({ field: "waterQuality", temporalClass: "PERIODIC" }));
    const qualityCells = buildObservabilityMatrix().filter((cell) => ["temperature", "salinityProxy", "DO"].includes(cell.signal));
    expect(qualityCells.every((cell) => cell.temporalClass !== "REALTIME")).toBe(true);
  });

  it("keeps biological surveys separate from live observations", () => {
    const cells = buildObservabilityMatrix().filter((cell) => cell.signal === "biologicalPrior");
    expect(cells.every((cell) => ["PERIODIC", "HISTORICAL_ONLY", "UNAVAILABLE"].includes(cell.temporalClass))).toBe(true);
    expect(cells.some((cell) => cell.temporalClass === "REALTIME")).toBe(false);
  });

  it("builds deterministic segment identity and a deterministic audit", () => {
    expect(buildSegmentId("ARA", 0)).toBe("ARA-0");
    expect(buildSegmentId("ARA", 0)).toBe(buildSegmentId("ARA", 0));
    const input = { collectedAt: COLLECTED_AT, probes: [] };
    const left = buildRiverCanalObservabilityAudit(input);
    const right = buildRiverCanalObservabilityAudit(input);
    expect(left).toEqual(right);
    expect(left.schemaVersion).toBe(RIVER_CANAL_AUDIT_VERSION);
  });

  it("rejects duplicate provider/station identities", () => {
    expect(assertNoDuplicateStations(OFFICIAL_STATIONS)).toBe(true);
    expect(() => assertNoDuplicateStations([
      { providerId: "fixture", stationId: "1" },
      { providerId: "fixture", stationId: "1" }
    ])).toThrow("Duplicate station stable ID: fixture:1");
  });

  it("enforces GET-only execution and exposes zero remote writes", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, method: init?.method });
      return response('<a href="cgi-bin/SrchSite.exe">station search</a>');
    });
    const report = await runRiverCanalObservabilityAudit({
      collectedAt: COLLECTED_AT,
      delayMs: 0,
      sources: [AUDIT_SOURCES[0]],
      fetchImpl
    });
    expect(calls).toEqual([{ url: AUDIT_SOURCES[0].url, method: "GET" }]);
    expect(report.remoteReads).toMatchObject({ total: 1, official: 1, publicCatch: 0 });
    expect(report.remoteWrites).toBe(0);
    expect(() => parseRiverCanalAuditArgs(["--execute"])).toThrow("Unknown option");
  });

  it("rejects every URL outside the fixed audit allowlist", () => {
    expect(normalizeAuditReadUrl(AUDIT_SOURCES[0].url)).toBe(AUDIT_SOURCES[0].url);
    expect(() => normalizeAuditReadUrl("https://example.com/river")).toThrow("not in the river/canal audit allowlist");
    expect(() => normalizeAuditReadUrl("https://www1.river.go.jp/other.html")).toThrow("not in the river/canal audit allowlist");
  });

  it("links coastal nodes by macro adjacency without claiming co-location", () => {
    const links = buildSegmentGraph().externalHabitatLinks;
    expect(links).toContainEqual({
      segmentId: "EBI-0",
      habitatNodeId: "funabashi-inner-01",
      relationship: "bay-side-macro-adjacency",
      coLocated: false
    });
    expect(links.every((link) => link.coLocated === false)).toBe(true);
  });
});

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-type" ? "text/html; charset=utf-8" : null },
    text: async () => body
  };
}
