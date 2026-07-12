export type EvidenceSourceKind = "official" | "shop" | "youtube" | "sns" | "rss" | "manual" | "derived";

export type EvidenceSource = {
  id: string;
  name: string;
  kind: EvidenceSourceKind;
  reliabilityPrior: number;
  url?: string;
  termsNote?: string;
};

export type LocationEstimate = {
  label: string;
  lat?: number;
  lon?: number;
  radiusM?: number;
  confidence: number;
};

export type SpeciesObservation = {
  species: string;
  count?: number;
  sizeCm?: number;
  lifeStage?: string;
  behavior?: string;
  method?: string;
};

export type EnvironmentalSnapshot = {
  observedAt: string;
  waterTempC?: number;
  airTempC?: number;
  tideLevelCm?: number;
  tidePhase?: "rising" | "falling" | "high" | "low" | "slack" | "unknown";
  salinityPsu?: number;
  windDirectionDeg?: number;
  windSpeedMps?: number;
  rainfallMm?: number;
  sourceIds?: string[];
};

export type HabitatFeature = {
  id: string;
  kind: "light" | "current" | "dropoff" | "flat" | "river_mouth" | "bridge" | "structure" | "weed" | "sand" | "mud" | "other";
  name?: string;
  location: LocationEstimate;
  strength?: number;
  notes?: string;
};

export type EvidenceEvent = {
  id: string;
  source: EvidenceSource;
  sourceId?: string;
  observedAt?: string;
  publishedAt: string;
  species: SpeciesObservation[];
  location: LocationEstimate;
  locationConfidence: number;
  sourceReliability: number;
  timeConfidence: number;
  freshness?: number;
  duplicateGroupId?: string;
  evidenceUrl?: string;
  title?: string;
  rawText?: string;
  extractedFacts: string[];
};

export type FishPresenceEstimate = {
  species: string;
  location: LocationEstimate;
  probability: number;
  confidence: number;
  drivers: Array<{ factor: string; contribution: number; note?: string }>;
  computedAt: string;
  validUntil?: string;
};

export type MovementEstimate = {
  species: string;
  from?: LocationEstimate;
  to?: LocationEstimate;
  directionDeg?: number;
  speedKmh?: number;
  confidence: number;
  rationale: string[];
};

export type PredictionSnapshot = {
  id: string;
  generatedAt: string;
  targetWindowStart: string;
  targetWindowEnd: string;
  estimates: FishPresenceEstimate[];
  movements?: MovementEstimate[];
  evidenceIds: string[];
  modelVersion: string;
};

export type BacktestResult = {
  id: string;
  species: string;
  windowStart: string;
  windowEnd: string;
  sampleSize: number;
  brierScore?: number;
  hitRate?: number;
  precision?: number;
  recall?: number;
  notes?: string[];
};

export type EvidenceValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type SpeciesFreshnessProfile = {
  halfLifeHours: number;
  minFreshness?: number;
};

export type FreshnessResult = {
  score: number;
  ageHours: number;
  timeBasis: "observedAt" | "publishedAt";
  halfLifeHours: number;
  uncertaintyPenalty: number;
};

export type ReliabilityBreakdown = {
  total: number;
  components: {
    sourceReliability: number;
    timeConfidence: number;
    locationConfidence: number;
    freshness: number;
    independence: number;
    repostPenalty: number;
  };
  weights: {
    sourceReliability: number;
    timeConfidence: number;
    locationConfidence: number;
    freshness: number;
    independence: number;
    repostPenalty: number;
  };
  reasons: string[];
};

export type DuplicateCandidate = {
  leftId: string;
  rightId: string;
  score: number;
  confidence: "exact" | "likely" | "possible";
  reasons: string[];
};

export type ConflictCandidate = {
  leftId: string;
  rightId: string;
  species: string[];
  reasons: string[];
};

export const DEFAULT_SPECIES_FRESHNESS: Record<string, SpeciesFreshnessProfile> = {
  seabass: { halfLifeHours: 18 },
  suzuki: { halfLifeHours: 18 },
  シーバス: { halfLifeHours: 18 },
  chinu: { halfLifeHours: 24 },
  クロダイ: { halfLifeHours: 24 },
  チニング: { halfLifeHours: 24 },
  aji: { halfLifeHours: 10 },
  アジ: { halfLifeHours: 10 },
  mebaru: { halfLifeHours: 16 },
  メバル: { halfLifeHours: 16 },
  haze: { halfLifeHours: 36 },
  ハゼ: { halfLifeHours: 36 },
  default: { halfLifeHours: 18 }
};

const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;

export function validateEvidenceEvent(event: EvidenceEvent): EvidenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!event || typeof event !== "object") {
    return { valid: false, errors: ["event must be an object."], warnings };
  }

  if (!isNonEmptyString(event.id)) errors.push("id is required.");
  if (!event.source || !isNonEmptyString(event.source.id)) errors.push("source.id is required.");
  if (event.source && !isScore(event.source.reliabilityPrior)) errors.push("source.reliabilityPrior must be 0..1.");
  if (!isIsoDateTime(event.publishedAt)) errors.push("publishedAt must be an ISO datetime string.");
  if (event.observedAt && !isIsoDateTime(event.observedAt)) errors.push("observedAt must be an ISO datetime string when present.");
  if (event.observedAt && isIsoDateTime(event.observedAt) && isIsoDateTime(event.publishedAt) && Date.parse(event.observedAt) > Date.parse(event.publishedAt) + 36 * 3600_000) {
    warnings.push("observedAt is much later than publishedAt.");
  }
  if (!Array.isArray(event.species) || event.species.length === 0) errors.push("species must contain at least one observation.");
  if (Array.isArray(event.species)) {
    event.species.forEach((item, index) => {
      if (!isNonEmptyString(item.species)) errors.push(`species[${index}].species is required.`);
      if (item.count != null && (!Number.isFinite(item.count) || item.count < 0)) errors.push(`species[${index}].count must be non-negative.`);
      if (item.sizeCm != null && (!Number.isFinite(item.sizeCm) || item.sizeCm <= 0)) errors.push(`species[${index}].sizeCm must be positive.`);
    });
  }
  if (!event.location || !isNonEmptyString(event.location.label)) errors.push("location.label is required.");
  if (event.location) {
    if (!isScore(event.location.confidence)) errors.push("location.confidence must be 0..1.");
    if (event.location.lat != null && (event.location.lat < -90 || event.location.lat > 90)) errors.push("location.lat must be -90..90.");
    if (event.location.lon != null && (event.location.lon < -180 || event.location.lon > 180)) errors.push("location.lon must be -180..180.");
    if (event.location.radiusM != null && (!Number.isFinite(event.location.radiusM) || event.location.radiusM < 0)) errors.push("location.radiusM must be non-negative.");
  }
  if (!isScore(event.locationConfidence)) errors.push("locationConfidence must be 0..1.");
  if (!isScore(event.sourceReliability)) errors.push("sourceReliability must be 0..1.");
  if (!isScore(event.timeConfidence)) errors.push("timeConfidence must be 0..1.");
  if (event.freshness != null && !isScore(event.freshness)) errors.push("freshness must be 0..1 when present.");
  if (event.evidenceUrl && !isUrl(event.evidenceUrl)) errors.push("evidenceUrl must be a valid URL when present.");
  if (!Array.isArray(event.extractedFacts)) errors.push("extractedFacts must be an array.");
  if (Array.isArray(event.extractedFacts) && event.extractedFacts.length === 0) warnings.push("extractedFacts is empty.");
  if (!event.observedAt) warnings.push("observedAt is missing; freshness uses publishedAt and time confidence is penalized.");

  return { valid: errors.length === 0, errors, warnings };
}

export function calculateFreshness(
  event: EvidenceEvent,
  asOf: string | Date = new Date(),
  profiles: Record<string, SpeciesFreshnessProfile> = DEFAULT_SPECIES_FRESHNESS
): FreshnessResult {
  const basis = event.observedAt ? "observedAt" : "publishedAt";
  const basisMs = Date.parse(event.observedAt || event.publishedAt);
  const asOfMs = typeof asOf === "string" ? Date.parse(asOf) : asOf.getTime();
  const ageHours = Math.max(0, (asOfMs - basisMs) / 3600_000);
  const halfLifeHours = speciesHalfLife(event, profiles);
  const profile = speciesProfile(event, profiles);
  const raw = Math.exp((-Math.LN2 * ageHours) / Math.max(1, halfLifeHours));
  const uncertaintyPenalty = event.observedAt ? 1 : 0.82;
  const score = clamp01(Math.max(profile.minFreshness ?? 0, raw) * uncertaintyPenalty);

  return { score, ageHours, timeBasis: basis, halfLifeHours, uncertaintyPenalty };
}

export function scoreEvidenceReliability(
  event: EvidenceEvent,
  relatedEvents: EvidenceEvent[] = [],
  asOf: string | Date = new Date()
): ReliabilityBreakdown {
  const freshness = calculateFreshness(event, asOf).score;
  const duplicateSiblings = relatedEvents.filter((other) => other.id !== event.id && isLikelySameObservation(event, other));
  const sameGroupCount = relatedEvents.filter((other) => event.duplicateGroupId && other.duplicateGroupId === event.duplicateGroupId).length;
  const independence = clamp01(1 - Math.max(duplicateSiblings.length, sameGroupCount - 1) * 0.22);
  const repostPenalty = repostSuspicion(event, duplicateSiblings);
  const timeConfidence = clamp01(event.timeConfidence * (event.observedAt ? 1 : 0.85));
  const sourceReliability = clamp01((event.sourceReliability + event.source.reliabilityPrior) / 2);
  const locationConfidence = clamp01((event.locationConfidence + event.location.confidence) / 2);

  const weights = {
    sourceReliability: 0.24,
    timeConfidence: 0.18,
    locationConfidence: 0.18,
    freshness: 0.22,
    independence: 0.18,
    repostPenalty: 0.15
  };
  const positive =
    sourceReliability * weights.sourceReliability +
    timeConfidence * weights.timeConfidence +
    locationConfidence * weights.locationConfidence +
    freshness * weights.freshness +
    independence * weights.independence;
  const total = clamp01(positive - repostPenalty * weights.repostPenalty);
  const reasons: string[] = [];
  if (!event.observedAt) reasons.push("observedAt missing: time confidence reduced.");
  if (duplicateSiblings.length > 0 || sameGroupCount > 1) reasons.push("similar or grouped evidence exists: independence reduced.");
  if (repostPenalty > 0) reasons.push("repost-like wording or duplicated source pattern detected.");

  return {
    total,
    components: { sourceReliability, timeConfidence, locationConfidence, freshness, independence, repostPenalty },
    weights,
    reasons
  };
}

export function findDuplicateCandidates(events: EvidenceEvent[], threshold = 0.42): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const candidate = duplicateCandidate(events[i], events[j]);
      if (candidate.score >= threshold) out.push(candidate);
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

export function findConflictingEvidence(events: EvidenceEvent[]): ConflictCandidate[] {
  const out: ConflictCandidate[] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const left = events[i];
      const right = events[j];
      const sharedSpecies = speciesNames(left).filter((name) => speciesNames(right).includes(name));
      if (!sharedSpecies.length) continue;
      if (!timeClose(left, right, 8)) continue;
      if (locationDistanceM(left.location, right.location) > 3000) continue;
      const leftPolarity = catchPolarity(left);
      const rightPolarity = catchPolarity(right);
      if (leftPolarity === 0 || rightPolarity === 0 || leftPolarity === rightPolarity) continue;
      out.push({
        leftId: left.id,
        rightId: right.id,
        species: sharedSpecies,
        reasons: ["same species/time/location window but catch/no-catch facts conflict"]
      });
    }
  }

  return out;
}

function duplicateCandidate(left: EvidenceEvent, right: EvidenceEvent): DuplicateCandidate {
  let score = 0;
  const reasons: string[] = [];

  if (left.evidenceUrl && right.evidenceUrl && left.evidenceUrl === right.evidenceUrl) {
    score += 0.45;
    reasons.push("same evidenceUrl");
  }
  if (left.sourceId && right.sourceId && left.source.id === right.source.id && left.sourceId === right.sourceId) {
    score += 0.45;
    reasons.push("same source and sourceId");
  }
  if (left.duplicateGroupId && left.duplicateGroupId === right.duplicateGroupId) {
    score += 0.35;
    reasons.push("same duplicateGroupId");
  }
  if (timeClose(left, right, 4)) {
    score += 0.16;
    reasons.push("near observed/published time");
  } else if (timeClose(left, right, 24)) {
    score += 0.08;
    reasons.push("same-day-ish time");
  }
  const distance = locationDistanceM(left.location, right.location);
  if (distance <= 1000) {
    score += 0.16;
    reasons.push("near location");
  } else if (distance <= 3000) {
    score += 0.08;
    reasons.push("same area location");
  } else if (labelSimilarity(left.location.label, right.location.label) > 0.65) {
    score += 0.07;
    reasons.push("similar location label");
  }
  if (speciesNames(left).some((name) => speciesNames(right).includes(name))) {
    score += 0.1;
    reasons.push("overlapping species");
  }
  if (sizeClose(left, right)) {
    score += 0.05;
    reasons.push("similar fish size");
  }
  if (textSimilarity(left, right) > 0.45) {
    score += 0.08;
    reasons.push("similar text/facts");
  }

  score = clamp01(score);
  return {
    leftId: left.id,
    rightId: right.id,
    score,
    confidence: score >= 0.82 ? "exact" : score >= 0.62 ? "likely" : "possible",
    reasons
  };
}

function isLikelySameObservation(left: EvidenceEvent, right: EvidenceEvent): boolean {
  return duplicateCandidate(left, right).score >= 0.62;
}

function speciesProfile(event: EvidenceEvent, profiles: Record<string, SpeciesFreshnessProfile>): SpeciesFreshnessProfile {
  const names = speciesNames(event);
  const hit = names.map((name) => profiles[name]).find(Boolean);
  return hit || profiles.default || { halfLifeHours: 18 };
}

function speciesHalfLife(event: EvidenceEvent, profiles: Record<string, SpeciesFreshnessProfile>): number {
  return speciesProfile(event, profiles).halfLifeHours;
}

function speciesNames(event: EvidenceEvent): string[] {
  return event.species.map((item) => item.species.trim()).filter(Boolean);
}

function eventTimeMs(event: EvidenceEvent): number {
  return Date.parse(event.observedAt || event.publishedAt);
}

function timeClose(left: EvidenceEvent, right: EvidenceEvent, hours: number): boolean {
  const a = eventTimeMs(left);
  const b = eventTimeMs(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= hours * 3600_000;
}

function locationDistanceM(left: LocationEstimate, right: LocationEstimate): number {
  if (!Number.isFinite(left.lat) || !Number.isFinite(left.lon) || !Number.isFinite(right.lat) || !Number.isFinite(right.lon)) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const earthM = 6_371_000;
  const dLat = toRad((right.lat as number) - (left.lat as number));
  const dLon = toRad((right.lon as number) - (left.lon as number));
  const lat1 = toRad(left.lat as number);
  const lat2 = toRad(right.lat as number);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function labelSimilarity(left: string, right: string): number {
  return jaccard(tokenize(left), tokenize(right));
}

function textSimilarity(left: EvidenceEvent, right: EvidenceEvent): number {
  const leftText = [left.title, left.rawText, ...left.extractedFacts].filter(Boolean).join(" ");
  const rightText = [right.title, right.rawText, ...right.extractedFacts].filter(Boolean).join(" ");
  return jaccard(tokenize(leftText), tokenize(rightText));
}

function sizeClose(left: EvidenceEvent, right: EvidenceEvent): boolean {
  const leftSizes = left.species.map((item) => item.sizeCm).filter((value): value is number => Number.isFinite(value));
  const rightSizes = right.species.map((item) => item.sizeCm).filter((value): value is number => Number.isFinite(value));
  return leftSizes.some((a) => rightSizes.some((b) => Math.abs(a - b) <= 3));
}

function repostSuspicion(event: EvidenceEvent, duplicateSiblings: EvidenceEvent[]): number {
  const text = [event.title, event.rawText, ...event.extractedFacts].filter(Boolean).join(" ").toLowerCase();
  const wording = /(転載|引用|repost|まとめ|拾い|再掲|from\s+)/i.test(text) ? 0.45 : 0;
  const duplicatePenalty = duplicateSiblings.length > 0 ? Math.min(0.5, duplicateSiblings.length * 0.18) : 0;
  return clamp01(Math.max(wording, duplicatePenalty));
}

function catchPolarity(event: EvidenceEvent): -1 | 0 | 1 {
  const text = [event.title, event.rawText, ...event.extractedFacts].filter(Boolean).join(" ").toLowerCase();
  const positive = /(釣れた|ヒット|キャッチ|入っている|確認|好調|catch|caught|hit)/i.test(text);
  const negative = /(釣れない|反応なし|不在|空振り|ノーバイト|no catch|no bite|absent)/i.test(text);
  if (positive && !negative) return 1;
  if (negative && !positive) return -1;
  return 0;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function jaccard(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
