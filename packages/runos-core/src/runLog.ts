import { averagePaceSecondsPerKilometer } from "./pace";

export type LightweightRunLog = {
  id: string;
  date: string;
  distanceKm: number;
  durationSec: number;
  avgPace: number;
  note: string;
  painLevel?: number;
};

export type CreateLightweightRunLogInput = {
  id: string;
  date: string;
  distanceKm: number;
  durationSec: number;
  note?: string;
  painLevel?: number;
};

export function createLightweightRunLog(input: CreateLightweightRunLogInput): LightweightRunLog {
  assertNonEmptyString(input.id, "id");
  assertIsoDate(input.date);
  assertPositiveFinite(input.distanceKm, "distanceKm");
  assertPositiveFinite(input.durationSec, "durationSec");

  if (input.painLevel !== undefined && (!Number.isInteger(input.painLevel) || input.painLevel < 0 || input.painLevel > 10)) {
    throw new RangeError("painLevel must be an integer from 0 to 10.");
  }

  return {
    id: input.id,
    date: input.date,
    distanceKm: input.distanceKm,
    durationSec: input.durationSec,
    avgPace: averagePaceSecondsPerKilometer(input.distanceKm, input.durationSec),
    note: input.note?.trim() ?? "",
    ...(input.painLevel === undefined ? {} : { painLevel: input.painLevel })
  };
}

export function isLightweightRunLog(value: unknown): value is LightweightRunLog {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    isIsoDateString(record.date) &&
    isPositiveFiniteNumber(record.distanceKm) &&
    isPositiveFiniteNumber(record.durationSec) &&
    isPositiveFiniteNumber(record.avgPace) &&
    typeof record.note === "string" &&
    (record.painLevel === undefined || isPainLevel(record.painLevel))
  );
}

export function isLightweightRunLogArray(value: unknown): value is LightweightRunLog[] {
  return Array.isArray(value) && value.every(isLightweightRunLog);
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

function assertPositiveFinite(value: number, label: string): void {
  if (!isPositiveFiniteNumber(value)) {
    throw new RangeError(`${label} must be a finite positive number.`);
  }
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPainLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
