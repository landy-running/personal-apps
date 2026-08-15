import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSeabassDecision,
  decideSeabassAction
} from "./seabass-decision";
import {
  JAPANESE_SEABASS_SCIENTIFIC_NAME,
  JAPANESE_SEABASS_SPECIES_ID,
  SEABASS_STATE_RULE_VERSION,
  SEABASS_STATE_SCHEMA_VERSION,
  type SeabassAxisState,
  type SeabassState
} from "./seabass-state";

const AS_OF = "2026-08-15T03:00:00.000Z";

describe("Wanoku Seabass Decision v1", () => {
  it("is deterministic for the same Seabass State", () => {
    const state = seabassState();

    expect(buildSeabassDecision(state)).toEqual(buildSeabassDecision(state));
  });

  it("keeps the decision core free of clocks, randomness, network and writes", () => {
    const source = readFileSync(new URL("./seabass-decision.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\.run\s*\(/);
    expect(source).not.toMatch(/\.batch\s*\(/);
  });

  it("prioritizes only when all axes are supportive", () => {
    const decision = buildSeabassDecision(seabassState());

    expect(decision.decision.action).toBe("PRIORITIZE");
    expect(decision.diagnostics.matchedRule).toBe("D");
  });

  it.each(["presence", "activation", "shoreCatchability"] as const)(
    "deprioritizes when %s is limiting",
    (axis) => {
      const decision = buildSeabassDecision(seabassState({ [axis]: "limiting" }));

      expect(decision.decision.action).toBe("DEPRIORITIZE");
      expect(decision.diagnostics.matchedRule).toBe("B");
    }
  );

  it("applies the limiting rule before the major-axis unknown rule", () => {
    const action = decideSeabassAction({
      presence: "unknown",
      activation: "supportive",
      shoreCatchability: "limiting"
    });

    expect(action).toEqual({ action: "DEPRIORITIZE", matchedRule: "B" });
  });

  it.each(["presence", "activation"] as const)(
    "returns insufficient data when %s is unknown",
    (axis) => {
      const decision = buildSeabassDecision(seabassState({ [axis]: "unknown" }));

      expect(decision.decision.action).toBe("INSUFFICIENT_DATA");
      expect(decision.diagnostics.matchedRule).toBe("C");
    }
  );

  it("considers supportive presence and activation with unknown shore catchability", () => {
    const decision = buildSeabassDecision(seabassState({ shoreCatchability: "unknown" }));

    expect(decision.decision.action).toBe("CONSIDER");
    expect(decision.diagnostics.matchedRule).toBe("E");
    expect(decision.drivers).toContainEqual({
      axis: "shoreCatchability",
      state: "unknown",
      effect: "prevents-prioritize"
    });
  });

  it("considers supportive presence and activation with neutral shore catchability", () => {
    const decision = buildSeabassDecision(seabassState({ shoreCatchability: "neutral" }));

    expect(decision.decision.action).toBe("CONSIDER");
    expect(decision.diagnostics.matchedRule).toBe("E");
  });

  it("considers other evaluable non-limiting neutral combinations", () => {
    const decision = buildSeabassDecision(seabassState({ presence: "neutral" }));

    expect(decision.decision.action).toBe("CONSIDER");
    expect(decision.diagnostics.matchedRule).toBe("F");
  });

  it("does not turn stale atmosphere into a limiting decision", () => {
    const decision = buildSeabassDecision(seabassState({ staleInputs: ["atmosphere"] }));

    expect(decision.decision.action).toBe("PRIORITIZE");
    expect(decision.quality.staleInputs).toEqual(["atmosphere"]);
  });

  it("keeps absent direct fish evidence as a constraint without deprioritizing", () => {
    const decision = buildSeabassDecision(seabassState());

    expect(decision.quality.directFishEvidenceAbsent).toBe(true);
    expect(decision.constraints).toContain("direct-fish-evidence-absent");
    expect(decision.decision.action).toBe("PRIORITIZE");
  });

  it("handles null input confidence without changing the action", () => {
    const decision = buildSeabassDecision(seabassState({ inputOverallConfidence: null }));

    expect(decision.quality.inputOverallConfidence).toBeNull();
    expect(decision.decision.action).toBe("PRIORITIZE");
  });

  it("returns insufficient data when all axes are unknown", () => {
    const decision = buildSeabassDecision(seabassState({
      presence: "unknown",
      activation: "unknown",
      shoreCatchability: "unknown"
    }));

    expect(decision.decision.action).toBe("INSUFFICIENT_DATA");
    expect(decision.diagnostics.matchedRule).toBe("C");
  });

  it("returns insufficient data before axis rules on state integrity failure", () => {
    const invalid = {
      ...seabassState({ shoreCatchability: "limiting" }),
      schemaVersion: "wanoku-seabass-state.invalid"
    } as unknown as SeabassState;
    const decision = buildSeabassDecision(invalid);

    expect(decision.decision.action).toBe("INSUFFICIENT_DATA");
    expect(decision.diagnostics).toMatchObject({
      matchedRule: "A",
      integrityFailures: ["invalid-seabass-state-schema-version"]
    });
  });

  it("states that access, safety and legality are not evaluated", () => {
    const decision = buildSeabassDecision(seabassState());

    expect(decision.constraints).toEqual(expect.arrayContaining([
      "access-not-evaluated",
      "safety-not-evaluated",
      "legality-not-evaluated"
    ]));
  });

  it("does not expose a numeric ranking or likelihood field", () => {
    const serialized = JSON.stringify(buildSeabassDecision(seabassState()));

    expect(serialized).not.toMatch(/\b(score|probability)\b/i);
  });

  it("returns CONSIDER for the production-like Makuhari state", () => {
    const decision = buildSeabassDecision(seabassState({
      shoreCatchability: "unknown",
      staleInputs: ["atmosphere"],
      unknownAxisReasons: [{
        field: "shoreCatchability.state",
        reasons: [
          "directional-exposure-unknown",
          "wave-classification-rule-undefined",
          "current-classification-rule-undefined"
        ]
      }]
    }));

    expect(decision).toMatchObject({
      schemaVersion: "wanoku-seabass-decision.v1",
      species: { id: "japanese-seabass" },
      nodeId: "makuhari-shallow-01",
      asOf: AS_OF,
      decision: { action: "CONSIDER" },
      axes: {
        presence: "supportive",
        activation: "supportive",
        shoreCatchability: "unknown"
      },
      quality: {
        staleInputs: ["atmosphere"],
        directFishEvidenceAbsent: true
      },
      provenance: {
        seabassStateSchemaVersion: "wanoku-seabass-state.v1",
        ruleVersion: "wanoku-seabass-decision-rules.v1",
        inputs: [
          "seabassState.presence.state",
          "seabassState.activation.state",
          "seabassState.shoreCatchability.state"
        ]
      }
    });
  });
});

type StateOverrides = {
  presence?: SeabassAxisState;
  activation?: SeabassAxisState;
  shoreCatchability?: SeabassAxisState;
  staleInputs?: string[];
  inputOverallConfidence?: number | null;
  unknownAxisReasons?: SeabassState["diagnostics"]["unknownAxisReasons"];
};

function seabassState(overrides: StateOverrides = {}): SeabassState {
  return {
    schemaVersion: SEABASS_STATE_SCHEMA_VERSION,
    species: {
      id: JAPANESE_SEABASS_SPECIES_ID,
      scientificName: JAPANESE_SEABASS_SCIENTIFIC_NAME
    },
    nodeId: "makuhari-shallow-01",
    asOf: AS_OF,
    presence: axis(overrides.presence ?? "supportive", ["direct-fish-evidence-absent"]),
    activation: axis(overrides.activation ?? "supportive", ["bait-density-unavailable"]),
    shoreCatchability: axis(overrides.shoreCatchability ?? "supportive", ["shore-safety-unavailable"]),
    quality: {
      inputOverallConfidence: overrides.inputOverallConfidence === undefined ? 0.8 : overrides.inputOverallConfidence,
      staleInputs: overrides.staleInputs ?? [],
      missingInputs: [],
      unknownDerivedComponents: [],
      directFishEvidenceAbsent: true
    },
    provenance: {
      environmentStateSchemaVersion: "wanoku-environment-state.v1",
      habitatStateSchemaVersion: "wanoku-habitat-state.v1",
      habitatGraphVersion: "wanoku-habitat-graph.v1",
      derivations: [
        { field: "presence", inputs: [], ruleVersion: SEABASS_STATE_RULE_VERSION },
        { field: "activation", inputs: [], ruleVersion: SEABASS_STATE_RULE_VERSION },
        { field: "shoreCatchability", inputs: [], ruleVersion: SEABASS_STATE_RULE_VERSION }
      ]
    },
    diagnostics: {
      unknownAxisReasons: overrides.unknownAxisReasons ?? []
    }
  };
}

function axis(state: SeabassAxisState, constraints: string[]): SeabassState["presence"] {
  return {
    state,
    meaning: `${state}-axis-fixture`,
    drivers: [],
    constraints
  };
}
