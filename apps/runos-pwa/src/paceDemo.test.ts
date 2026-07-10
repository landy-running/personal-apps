import { describe, expect, it } from "vitest";
import { calculatePaceDemo, describePaceDemoResult } from "./paceDemo";

describe("RunOS PWA pace demo", () => {
  it("calculates min/km display from distance and elapsed time", () => {
    const result = calculatePaceDemo({
      distanceKilometers: 10,
      elapsedMinutes: 45,
      elapsedSeconds: 0
    });

    expect(result).toMatchObject({
      ok: true,
      totalSeconds: 2700,
      secondsPerKilometer: 270,
      formattedPace: "4:30/km"
    });
    expect(describePaceDemoResult(result)).toContain("平均ペース: 4:30/km");
  });

  it("returns a user-facing validation message for invalid input", () => {
    const result = calculatePaceDemo({
      distanceKilometers: 0,
      elapsedMinutes: 45,
      elapsedSeconds: 0
    });

    expect(result.ok).toBe(false);
    expect(describePaceDemoResult(result)).toContain("距離");
  });
});

