import { describe, expect, it } from "vitest";
import {
  HYDRO_COASTAL_PROVIDER_DEFINITIONS,
  HYDRO_COASTAL_SCHEMA_VERSION,
  SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS,
  SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS,
  SYNTHETIC_HYDRO_COASTAL_STATIONS,
  canCompareVerticalDatums,
  convertWaterLevelToTp,
  findMappingsWithUnknownHabitatNode,
  findUnmappedHydroCoastalStations,
  hydroCoastalObservationIdentityKey,
  hydroCoastalObservationVersionKey,
  mapHydroCoastalObservationsToHabitatNodes,
  selectHydroCoastalObservationsAsOf,
  validateHydroCoastalObservation,
  validateHydroCoastalProviderDefinition,
  validateHydroCoastalStation,
  validateHydroCoastalStationNodeMapping,
  validateVerticalDatum,
  type HydroCoastalObservation,
  type HydroCoastalStation,
  type HydroCoastalStationNodeMapping,
  type VerticalDatum
} from "./hydro-coastal";
import { type HabitatGraph, type HabitatNode } from "./habitat";

describe("Wanoku Hydro-Coastal Data Contracts v1", () => {
  it("validates synthetic provider, station, and observation fixtures", () => {
    expect(HYDRO_COASTAL_PROVIDER_DEFINITIONS.map(validateHydroCoastalProviderDefinition).every((result) => result.valid)).toBe(true);
    expect(SYNTHETIC_HYDRO_COASTAL_STATIONS.map(validateHydroCoastalStation).every((result) => result.valid)).toBe(true);
    expect(SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS.map((observation) => validateHydroCoastalObservation(observation)).every((result) => result.valid)).toBe(true);
  });

  it("rejects metric and unit mismatches", () => {
    const result = validateHydroCoastalObservation(observation({
      metric: "river-discharge",
      unit: "m"
    }));

    expect(result.errors).toContain("unit m is not compatible with metric river-discharge.");
  });

  it("requires vertical datum for tide level and river stage metrics", () => {
    const result = validateHydroCoastalObservation(observation({
      metric: "observed-tide-level",
      unit: "m",
      verticalDatum: null
    }));

    expect(result.errors).toContain("verticalDatum is required.");
  });

  it("allows unknown datum but refuses comparison", () => {
    const unknown: VerticalDatum = {
      type: "unknown",
      stationSpecific: true,
      offsetToTpM: null,
      description: "Unknown official datum for registry-only source."
    };
    const validation = validateVerticalDatum(unknown);

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain("verticalDatum is unknown and cannot be compared or converted.");
    expect(canCompareVerticalDatums(unknown, tpDatum())).toBe(false);
  });

  it("rejects unknown datum with a finite TP offset and never converts it", () => {
    const unknownWithOffset: VerticalDatum = {
      type: "unknown",
      stationSpecific: true,
      offsetToTpM: 0.1,
      description: "Malformed unknown datum."
    };

    const validation = validateVerticalDatum(unknownWithOffset);

    expect(validation.errors).toContain("verticalDatum.type=unknown requires offsetToTpM=null.");
    expect(convertWaterLevelToTp(1.2, unknownWithOffset)).toBeNull();
    expect(canCompareVerticalDatums(unknownWithOffset, tpDatum())).toBe(false);
  });

  it("allows TP zero offset but rejects non-zero TP offsets", () => {
    expect(validateVerticalDatum({ ...tpDatum(), offsetToTpM: 0 }).valid).toBe(true);

    const invalid = validateVerticalDatum({ ...tpDatum(), offsetToTpM: 0.2 });

    expect(invalid.errors).toContain("verticalDatum.type=tp allows only offsetToTpM=null or 0.");
    expect(convertWaterLevelToTp(1.2, { ...tpDatum(), offsetToTpM: 0.2 })).toBeNull();
  });

  it("converts water levels to TP only when datum is TP or has explicit offset", () => {
    expect(convertWaterLevelToTp(1.2, tpDatum())).toBe(1.2);
    expect(convertWaterLevelToTp(1.2, { ...tpDatum(), type: "observation-datum", offsetToTpM: -0.3 })).toBe(0.9);
    expect(convertWaterLevelToTp(1.2, { ...tpDatum(), type: "observation-datum", offsetToTpM: null })).toBeNull();
    expect(canCompareVerticalDatums({ ...tpDatum(), type: "observation-datum", offsetToTpM: -0.3 }, { ...tpDatum(), type: "tide-table-datum", offsetToTpM: -0.1 })).toBe(true);
  });

  it("requires canonical UTC timestamps for normalized observations", () => {
    const result = validateHydroCoastalObservation(observation({
      observedAt: "2026-07-13T10:00:00+09:00"
    }));

    expect(result.errors).toContain("observedAt must be canonical UTC ISO datetime.");
  });

  it("requires forecastIssuedAt for predicted observations", () => {
    const result = validateHydroCoastalObservation(observation({
      status: "predicted",
      forecastIssuedAt: null,
      metric: "predicted-tide-level",
      unit: "cm"
    }));

    expect(result.errors).toContain("predicted observations require forecastIssuedAt.");
  });

  it("rejects predicted status on non-predicted metrics", () => {
    const result = validateHydroCoastalObservation(observation({
      status: "predicted",
      metric: "observed-tide-level",
      unit: "m",
      forecastIssuedAt: "2026-07-12T23:00:00.000Z"
    }));

    expect(result.errors).toContain("status=predicted is only valid for metric=predicted-tide-level.");
  });

  it("validates forecastIssuedAt chronology for predicted tide levels", () => {
    const result = validateHydroCoastalObservation(observation({
      status: "predicted",
      metric: "predicted-tide-level",
      unit: "cm",
      forecastIssuedAt: "2026-07-13T00:20:00.000Z",
      observedAt: "2026-07-13T00:00:00.000Z",
      collectedAt: "2026-07-13T00:10:00.000Z"
    }));

    expect(result.errors).toEqual(expect.arrayContaining([
      "predicted forecastIssuedAt must be <= collectedAt.",
      "predicted forecastIssuedAt must be <= observedAt."
    ]));
  });

  it("validates observedAt and collectedAt chronology for observations and reanalysis", () => {
    const observed = validateHydroCoastalObservation(observation({
      status: "observed",
      observedAt: "2026-07-13T00:20:00.000Z",
      collectedAt: "2026-07-13T00:10:00.000Z"
    }));
    const reanalyzed = validateHydroCoastalObservation(observation({
      status: "reanalyzed",
      observedAt: "2026-07-13T00:20:00.000Z",
      collectedAt: "2026-07-13T00:10:00.000Z"
    }));

    expect(observed.errors).toContain("observed/reanalyzed observedAt must be <= collectedAt.");
    expect(reanalyzed.errors).toContain("observed/reanalyzed observedAt must be <= collectedAt.");
  });

  it("enforces missing status value semantics", () => {
    const missing = validateHydroCoastalObservation(observation({ status: "missing", value: 1 }));
    const nonMissing = validateHydroCoastalObservation(observation({ status: "observed", value: null }));

    expect(missing.errors).toContain("status=missing requires value=null.");
    expect(nonMissing.errors).toContain("value must be finite unless status=missing or status=invalid.");
  });

  it("enforces invalid status value semantics", () => {
    const invalid = validateHydroCoastalObservation(observation({ status: "invalid", value: 1 }));

    expect(invalid.errors).toContain("status=invalid requires value=null.");
  });

  it("rejects negative wave height and discharge", () => {
    expect(validateHydroCoastalObservation(observation({
      metric: "significant-wave-height",
      unit: "m",
      value: -0.1,
      verticalDatum: null
    })).errors).toContain("significant-wave-height must be non-negative.");
    expect(validateHydroCoastalObservation(observation({
      metric: "river-discharge",
      unit: "m3/s",
      value: -1,
      verticalDatum: null
    })).errors).toContain("river-discharge must be non-negative.");
  });

  it("rejects wave direction outside [0, 360) instead of normalizing it", () => {
    const result = validateHydroCoastalObservation(observation({
      metric: "wave-direction",
      unit: "degree",
      value: 360,
      verticalDatum: null
    }));

    expect(result.errors).toContain("wave-direction must be within [0, 360).");
  });

  it("builds identity and version keys without mixing revisions", () => {
    const base = observation();
    const revised = { ...base, collectedAt: "2026-07-13T01:00:00.000Z" };

    expect(hydroCoastalObservationIdentityKey(base)).toBe(hydroCoastalObservationIdentityKey(revised));
    expect(hydroCoastalObservationVersionKey(base)).not.toBe(hydroCoastalObservationVersionKey(revised));
  });

  it("selects the latest revision as of calculatedAt without using future revisions", () => {
    const old = observation({ collectedAt: "2026-07-13T00:10:00.000Z", value: 1 });
    const latest = observation({ collectedAt: "2026-07-13T00:20:00.000Z", value: 2 });
    const future = observation({ collectedAt: "2026-07-13T00:40:00.000Z", value: 3 });
    const result = selectHydroCoastalObservationsAsOf([future, old, latest], "2026-07-13T00:30:00.000Z");

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].value).toBe(2);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("future hydro-coastal revision excluded")
    ]));
  });

  it("excludes invalid observations during as-of selection", () => {
    const valid = observation({ value: 1 });
    const invalid = { ...observation({ value: 2 }), observedAt: "2026-07-13T09:00:00+09:00" };
    const result = selectHydroCoastalObservationsAsOf([invalid, valid], "2026-07-13T01:00:00.000Z");

    expect(result.observations).toEqual([valid]);
    expect(result.errors).toContain("observedAt must be canonical UTC ISO datetime.");
  });

  it("collapses exact duplicate version keys with a warning", () => {
    const base = observation();
    const result = selectHydroCoastalObservationsAsOf([base, { ...base }], "2026-07-13T01:00:00.000Z");

    expect(result.observations).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate hydro-coastal observation ignored")
    ]));
  });

  it("rejects conflicting duplicate version keys without arbitrary adoption", () => {
    const base = observation();
    const result = selectHydroCoastalObservationsAsOf([base, { ...base, value: 99 }], "2026-07-13T01:00:00.000Z");

    expect(result.observations).toHaveLength(0);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("conflicting hydro-coastal observation version")
    ]));
  });

  it("validates station/provider consistency and supported metrics", () => {
    const station = SYNTHETIC_HYDRO_COASTAL_STATIONS[2];
    const provider = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((item) => item.providerId === "nowphas-wave");
    const valid = validateHydroCoastalObservation(observation({
      providerId: "nowphas-wave",
      stationId: station.stationId,
      metric: "significant-wave-period",
      unit: "second",
      value: 5,
      verticalDatum: null
    }), { station, provider });
    const invalid = validateHydroCoastalObservation(observation({
      providerId: "nowphas-wave",
      stationId: station.stationId,
      metric: "river-discharge",
      unit: "m3/s",
      value: 5,
      verticalDatum: null
    }), { station, provider });

    expect(valid.valid).toBe(true);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      "station does not support observation metric.",
      "provider does not support observation metric."
    ]));
  });

  it("maps observations to habitat nodes only through explicit station/provider mappings", () => {
    const graph = habitatGraph();
    const result = mapHydroCoastalObservationsToHabitatNodes(
      SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS,
      SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS,
      graph
    );

    expect(result.mappedObservations).toHaveLength(SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS.length);
    expect(result.unmappedStationKeys).toEqual([]);
    expect(result.mappingsWithUnknownHabitatNode).toEqual([]);
  });

  it("reports unmapped stations", () => {
    const unmapped = findUnmappedHydroCoastalStations([
      ...SYNTHETIC_HYDRO_COASTAL_STATIONS,
      { ...SYNTHETIC_HYDRO_COASTAL_STATIONS[0], stationId: "unmapped-station" }
    ], SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS);

    expect(unmapped).toContain("jma-tide-prediction|unmapped-station");
  });

  it("reports mappings with unknown habitat nodes", () => {
    const badMapping: HydroCoastalStationNodeMapping = {
      ...SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS[0],
      habitatNodeId: "missing-node"
    };

    expect(findMappingsWithUnknownHabitatNode([badMapping], habitatGraph())).toEqual([badMapping]);
    expect(mapHydroCoastalObservationsToHabitatNodes(
      [SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS[0]],
      [badMapping],
      habitatGraph()
    ).warnings).toEqual(["mapping references unknown habitat node: missing-node"]);
  });

  it("validates mapping methods, distance, confidence, and validity periods", () => {
    const base = SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS[0];

    expect(validateHydroCoastalStationNodeMapping({ ...base, mappingMethod: "nearest" }).errors).toContain("mappingMethod is invalid: nearest.");
    expect(validateHydroCoastalStationNodeMapping({ ...base, distanceKm: -1 }).errors).toContain("distanceKm must be finite and >= 0.");
    expect(validateHydroCoastalStationNodeMapping({ ...base, confidence: 1.1 }).errors).toContain("confidence must be null or within [0, 1].");
    expect(validateHydroCoastalStationNodeMapping({
      ...base,
      validFrom: "2026-07-13T01:00:00.000Z",
      validTo: "2026-07-13T00:00:00.000Z"
    }).errors).toContain("validFrom must be < validTo.");
  });

  it("does not map observations outside [validFrom, validTo)", () => {
    const base = SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS[0];
    const mapping: HydroCoastalStationNodeMapping = {
      ...base,
      validFrom: "2026-07-13T01:00:00.000Z",
      validTo: "2026-07-13T02:00:00.000Z"
    };
    const result = mapHydroCoastalObservationsToHabitatNodes(
      [SYNTHETIC_HYDRO_COASTAL_OBSERVATIONS[0]],
      [mapping],
      habitatGraph()
    );

    expect(result.mappedObservations).toEqual([]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("mapping outside validity period")
    ]));
  });

  it("does not throw on malformed observation, station, provider, or mapping objects", () => {
    expect(() => validateHydroCoastalObservation(null)).not.toThrow();
    expect(() => validateHydroCoastalStation({ supportedMetrics: null })).not.toThrow();
    expect(() => validateHydroCoastalProviderDefinition({ supportedMetrics: null })).not.toThrow();
    expect(() => validateHydroCoastalStationNodeMapping({ provenance: null })).not.toThrow();

    expect(validateHydroCoastalObservation(null).valid).toBe(false);
    expect(validateHydroCoastalStation({ supportedMetrics: null }).valid).toBe(false);
    expect(validateHydroCoastalProviderDefinition({ supportedMetrics: null }).valid).toBe(false);
    expect(validateHydroCoastalStationNodeMapping({ provenance: null }).valid).toBe(false);
  });

  it("keeps synthetic fixture mappings compatible with the 12-node habitat graph", () => {
    const graph = habitatGraph();
    const nodeIds = new Set(graph.nodes.map((node) => node.id));

    expect(graph.nodes).toHaveLength(12);
    expect(SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS.every((mapping) => nodeIds.has(mapping.habitatNodeId))).toBe(true);
    expect(SYNTHETIC_HYDRO_COASTAL_STATION_NODE_MAPPINGS.every((mapping) => mapping.mappingMethod === "explicit")).toBe(true);
    expect(SYNTHETIC_HYDRO_COASTAL_STATIONS.every((station) => station.sourceMetadata.syntheticFixture)).toBe(true);
  });

  it("keeps live acquisition disabled for registry-only or unimplemented official providers", () => {
    const mlit = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((provider) => provider.providerId === "mlit-river");
    const jcg = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((provider) => provider.providerId === "jcg-marine-information");
    const jmaPrediction = HYDRO_COASTAL_PROVIDER_DEFINITIONS.find((provider) => provider.providerId === "jma-tide-prediction");

    expect(mlit).toMatchObject({ accessMode: "licensed-distribution", automatedAcquisitionAllowed: false, implementationStatus: "registry-only" });
    expect(jcg).toMatchObject({ accessMode: "registry-only", automatedAcquisitionAllowed: false });
    expect(jmaPrediction).toMatchObject({ accessMode: "documented-download", automatedAcquisitionAllowed: false, implementationStatus: "adapter-not-implemented" });
  });

  it("rejects unknown provider IDs and automation on unimplemented providers", () => {
    const unknownProvider = validateHydroCoastalProviderDefinition({
      ...HYDRO_COASTAL_PROVIDER_DEFINITIONS[0],
      providerId: "unregistered-provider"
    });
    const automatedUnimplemented = validateHydroCoastalProviderDefinition({
      ...HYDRO_COASTAL_PROVIDER_DEFINITIONS[0],
      automatedAcquisitionAllowed: true
    });

    expect(unknownProvider.errors).toContain("providerId is unknown: unregistered-provider.");
    expect(automatedUnimplemented.errors).toContain("automated acquisition requires implementationStatus=implemented.");
  });
});

function observation(overrides: Partial<HydroCoastalObservation> = {}): HydroCoastalObservation {
  return {
    schemaVersion: HYDRO_COASTAL_SCHEMA_VERSION,
    providerId: "jma-tide-observation",
    stationId: "synthetic-jma-tokyo-tide-observation",
    metric: "observed-tide-level",
    observedAt: "2026-07-13T00:00:00.000Z",
    collectedAt: "2026-07-13T00:10:00.000Z",
    forecastIssuedAt: null,
    value: 1.2,
    unit: "m",
    status: "observed",
    provisional: true,
    verticalDatum: tpDatum(),
    provenance: {
      sourceName: "test",
      sourceKind: "synthetic-fixture",
      sourceTimestamp: "2026-07-13T09:00:00+09:00",
      sourceTimezone: "Asia/Tokyo",
      normalizedAt: "2026-07-13T00:10:00.000Z"
    },
    ...overrides
  };
}

function tpDatum(): VerticalDatum {
  return {
    type: "tp",
    stationSpecific: false,
    offsetToTpM: 0,
    description: "Tokyo Peil synthetic test datum."
  };
}

function habitatGraph(): HabitatGraph {
  return {
    version: "test",
    generatedAt: "2026-07-13T00:00:00.000Z",
    nodes: [
      "tokyo-inner-bay-01",
      "sumida-arakawa-mouth-01",
      "tama-river-mouth-01",
      "keihin-canal-01",
      "makuhari-shallow-01",
      "funabashi-inner-01",
      "bay-center-north-01",
      "bay-center-south-01",
      "kisarazu-north-01",
      "futtsu-cape-01",
      "kanaya-uchibo-01",
      "tateyama-north-01"
    ].map(node),
    edges: []
  };
}

function node(id: string): HabitatNode {
  return {
    id,
    displayName: id,
    latitude: 35,
    longitude: 139,
    region: "test",
    waterBodyType: "unknown",
    habitatTypes: ["open-water"],
    bayPosition: null,
    depthBand: "unknown",
    riverInfluence: null,
    freshwaterInfluence: null,
    tidalExposure: null,
    waveExposure: null,
    currentExposure: null,
    structureDensity: null,
    shallowAreaRatio: null,
    baitHoldingPotential: null,
    confidence: null,
    dataSources: ["test"],
    notes: []
  };
}
