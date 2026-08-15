import {
  JAPANESE_SEABASS_SPECIES_ID,
  SEABASS_STATE_SCHEMA_VERSION,
  type SeabassAxisState,
  type SeabassState
} from "./seabass-state";

export const SEABASS_DECISION_SCHEMA_VERSION = "wanoku-seabass-decision.v1";
export const SEABASS_DECISION_RULE_VERSION = "wanoku-seabass-decision-rules.v1";

export type SeabassDecisionAction =
  | "PRIORITIZE"
  | "CONSIDER"
  | "DEPRIORITIZE"
  | "INSUFFICIENT_DATA";

export type SeabassDecisionAxis = "presence" | "activation" | "shoreCatchability";
export type SeabassDecisionDriverEffect =
  | "supports-priority"
  | "allows-consideration"
  | "deprioritizes"
  | "prevents-prioritize"
  | "prevents-assessment";

export type SeabassDecisionDriver = {
  axis: SeabassDecisionAxis;
  state: SeabassAxisState;
  effect: SeabassDecisionDriverEffect;
};

export type SeabassDecision = {
  schemaVersion: typeof SEABASS_DECISION_SCHEMA_VERSION;
  species: {
    id: typeof JAPANESE_SEABASS_SPECIES_ID;
  };
  nodeId: string;
  asOf: string;
  decision: {
    action: SeabassDecisionAction;
    meaning: string;
  };
  axes: Record<SeabassDecisionAxis, SeabassAxisState>;
  drivers: SeabassDecisionDriver[];
  constraints: string[];
  quality: SeabassState["quality"];
  provenance: {
    seabassStateSchemaVersion: typeof SEABASS_STATE_SCHEMA_VERSION;
    ruleVersion: typeof SEABASS_DECISION_RULE_VERSION;
    inputs: [
      "seabassState.presence.state",
      "seabassState.activation.state",
      "seabassState.shoreCatchability.state"
    ];
  };
  diagnostics: {
    matchedRule: "A" | "B" | "C" | "D" | "E" | "F";
    integrityFailures: string[];
    unknownAxisReasons: SeabassState["diagnostics"]["unknownAxisReasons"];
  };
};

const CANONICAL_UTC_ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AXIS_STATES = new Set<SeabassAxisState>(["supportive", "neutral", "limiting", "unknown"]);

const DECISION_MEANINGS: Record<SeabassDecisionAction, string> = {
  PRIORITIZE: "available-evidence-supports-prioritizing-candidate-not-catch-outcome-safety-access-or-legality-approval",
  CONSIDER: "plausible-candidate-with-neutral-or-uncertain-axis-not-safety-access-or-legality-approval",
  DEPRIORITIZE: "one-or-more-established-axes-are-limiting",
  INSUFFICIENT_DATA: "core-biological-opportunity-cannot-be-meaningfully-assessed"
};

export function buildSeabassDecision(seabassState: SeabassState): SeabassDecision {
  const integrityFailures = findSeabassStateIntegrityFailures(seabassState);
  const axes = {
    presence: seabassState.presence.state,
    activation: seabassState.activation.state,
    shoreCatchability: seabassState.shoreCatchability.state
  };
  const result = decideSeabassAction(axes, integrityFailures);

  return {
    schemaVersion: SEABASS_DECISION_SCHEMA_VERSION,
    species: { id: JAPANESE_SEABASS_SPECIES_ID },
    nodeId: seabassState.nodeId,
    asOf: seabassState.asOf,
    decision: {
      action: result.action,
      meaning: DECISION_MEANINGS[result.action]
    },
    axes,
    drivers: (Object.entries(axes) as Array<[SeabassDecisionAxis, SeabassAxisState]>).map(
      ([axis, state]) => ({ axis, state, effect: decisionDriverEffect(axis, state) })
    ),
    constraints: uniqueStrings([
      ...seabassState.presence.constraints,
      ...seabassState.activation.constraints,
      ...seabassState.shoreCatchability.constraints,
      ...(seabassState.quality.directFishEvidenceAbsent ? ["direct-fish-evidence-absent"] : []),
      "access-not-evaluated",
      "safety-not-evaluated",
      "legality-not-evaluated"
    ]),
    quality: {
      inputOverallConfidence: seabassState.quality.inputOverallConfidence,
      staleInputs: [...seabassState.quality.staleInputs],
      missingInputs: [...seabassState.quality.missingInputs],
      unknownDerivedComponents: [...seabassState.quality.unknownDerivedComponents],
      directFishEvidenceAbsent: seabassState.quality.directFishEvidenceAbsent
    },
    provenance: {
      seabassStateSchemaVersion: SEABASS_STATE_SCHEMA_VERSION,
      ruleVersion: SEABASS_DECISION_RULE_VERSION,
      inputs: [
        "seabassState.presence.state",
        "seabassState.activation.state",
        "seabassState.shoreCatchability.state"
      ]
    },
    diagnostics: {
      matchedRule: result.matchedRule,
      integrityFailures,
      unknownAxisReasons: seabassState.diagnostics.unknownAxisReasons.map((entry) => ({
        field: entry.field,
        reasons: [...entry.reasons]
      }))
    }
  };
}

export function decideSeabassAction(
  axes: Record<SeabassDecisionAxis, SeabassAxisState>,
  integrityFailures: readonly string[] = []
): { action: SeabassDecisionAction; matchedRule: "A" | "B" | "C" | "D" | "E" | "F" } {
  if (integrityFailures.length > 0) return { action: "INSUFFICIENT_DATA", matchedRule: "A" };

  if (Object.values(axes).includes("limiting")) {
    return { action: "DEPRIORITIZE", matchedRule: "B" };
  }

  if (axes.presence === "unknown" || axes.activation === "unknown") {
    return { action: "INSUFFICIENT_DATA", matchedRule: "C" };
  }

  if (
    axes.presence === "supportive" &&
    axes.activation === "supportive" &&
    axes.shoreCatchability === "supportive"
  ) {
    return { action: "PRIORITIZE", matchedRule: "D" };
  }

  if (axes.shoreCatchability === "neutral" || axes.shoreCatchability === "unknown") {
    return { action: "CONSIDER", matchedRule: "E" };
  }

  return { action: "CONSIDER", matchedRule: "F" };
}

function decisionDriverEffect(
  axis: SeabassDecisionAxis,
  state: SeabassAxisState
): SeabassDecisionDriverEffect {
  if (state === "supportive") return "supports-priority";
  if (state === "neutral") return "allows-consideration";
  if (state === "limiting") return "deprioritizes";
  return axis === "shoreCatchability" ? "prevents-prioritize" : "prevents-assessment";
}

function findSeabassStateIntegrityFailures(seabassState: SeabassState): string[] {
  const failures: string[] = [];
  if (seabassState.schemaVersion !== SEABASS_STATE_SCHEMA_VERSION) failures.push("invalid-seabass-state-schema-version");
  if (seabassState.species.id !== JAPANESE_SEABASS_SPECIES_ID) failures.push("invalid-species-id");
  if (!seabassState.nodeId) failures.push("missing-node-id");
  if (!isCanonicalUtcIsoDateTime(seabassState.asOf)) failures.push("invalid-as-of");
  for (const [axis, state] of Object.entries({
    presence: seabassState.presence?.state,
    activation: seabassState.activation?.state,
    shoreCatchability: seabassState.shoreCatchability?.state
  })) {
    if (!AXIS_STATES.has(state as SeabassAxisState)) failures.push(`invalid-${axis}-state`);
  }
  return failures;
}

function isCanonicalUtcIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_ISO_DATETIME.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
