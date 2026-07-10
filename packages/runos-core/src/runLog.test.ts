import { describe, expect, it } from "vitest";
import { createLightweightRunLog, isLightweightRunLog, isLightweightRunLogArray } from "./runLog";

describe("RunOS lightweight run log", () => {
  it("creates a lightweight run log with avgPace", () => {
    const log = createLightweightRunLog({
      id: "run-1",
      date: "2026-07-10",
      distanceKm: 10,
      durationSec: 2700,
      note: "easy",
      painLevel: 1
    });

    expect(log).toEqual({
      id: "run-1",
      date: "2026-07-10",
      distanceKm: 10,
      durationSec: 2700,
      avgPace: 270,
      note: "easy",
      painLevel: 1
    });
    expect(isLightweightRunLog(log)).toBe(true);
    expect(isLightweightRunLogArray([log])).toBe(true);
  });

  it("rejects invalid values", () => {
    expect(() =>
      createLightweightRunLog({
        id: "run-1",
        date: "2026-07-10",
        distanceKm: 0,
        durationSec: 2700
      })
    ).toThrow(RangeError);
    expect(() =>
      createLightweightRunLog({
        id: "run-1",
        date: "2026/07/10",
        distanceKm: 10,
        durationSec: 2700
      })
    ).toThrow(TypeError);
    expect(() =>
      createLightweightRunLog({
        id: "run-1",
        date: "2026-07-10",
        distanceKm: 10,
        durationSec: 2700,
        painLevel: 11
      })
    ).toThrow(RangeError);
  });
});

