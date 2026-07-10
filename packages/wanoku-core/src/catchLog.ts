export type LightweightCatchLog = {
  id: string;
  date: string;
  spotName: string;
  targetFish: string;
  result: string;
  lure: string;
  note: string;
};

export type CreateLightweightCatchLogInput = {
  id: string;
  date: string;
  spotName: string;
  targetFish: string;
  result: string;
  lure?: string;
  note?: string;
};

export function createLightweightCatchLog(input: CreateLightweightCatchLogInput): LightweightCatchLog {
  assertNonEmptyString(input.id, "id");
  assertIsoDate(input.date);
  assertNonEmptyString(input.spotName, "spotName");
  assertNonEmptyString(input.targetFish, "targetFish");
  assertNonEmptyString(input.result, "result");

  return {
    id: input.id,
    date: input.date,
    spotName: input.spotName.trim(),
    targetFish: input.targetFish.trim(),
    result: input.result.trim(),
    lure: input.lure?.trim() ?? "",
    note: input.note?.trim() ?? ""
  };
}

export function isLightweightCatchLog(value: unknown): value is LightweightCatchLog {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    isIsoDateString(record.date) &&
    typeof record.spotName === "string" &&
    record.spotName.trim() !== "" &&
    typeof record.targetFish === "string" &&
    record.targetFish.trim() !== "" &&
    typeof record.result === "string" &&
    record.result.trim() !== "" &&
    typeof record.lure === "string" &&
    typeof record.note === "string"
  );
}

export function isLightweightCatchLogArray(value: unknown): value is LightweightCatchLog[] {
  return Array.isArray(value) && value.every(isLightweightCatchLog);
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function assertIsoDate(value: string): void {
  if (!isIsoDateString(value)) {
    throw new TypeError("date must be YYYY-MM-DD.");
  }
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

