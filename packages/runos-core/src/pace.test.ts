import { describe, expect, it } from "vitest";
import {
  averagePaceSecondsPerKilometer,
  formatPace,
  paceToSecondsPerKilometer,
  secondsPerKilometerToPaceParts
} from "./pace";

describe("RunOS pace helpers", () => {
  it("matches docs PACE-001: distance and time to seconds per kilometer", () => {
    expect(averagePaceSecondsPerKilometer(10, 3000)).toBe(300);
  });

  it("converts min/km parts to seconds per kilometer", () => {
    expect(paceToSecondsPerKilometer(4, 30)).toBe(270);
    expect(paceToSecondsPerKilometer(5, 0)).toBe(300);
  });

  it("converts seconds per kilometer to rounded pace parts", () => {
    expect(secondsPerKilometerToPaceParts(269.6)).toEqual({ minutes: 4, seconds: 30 });
    expect(secondsPerKilometerToPaceParts(300)).toEqual({ minutes: 5, seconds: 0 });
  });

  it("matches docs PACE-002: formats seconds per kilometer as min/km display", () => {
    expect(formatPace(270)).toBe("4:30/km");
    expect(formatPace(300)).toBe("5:00/km");
  });

  it("matches docs PACE-003: calculates average pace from distance and elapsed time", () => {
    expect(averagePaceSecondsPerKilometer(10, 45 * 60)).toBe(270);
    expect(averagePaceSecondsPerKilometer(5, 1475)).toBe(295);
    expect(formatPace(averagePaceSecondsPerKilometer(5, 1475))).toBe("4:55/km");
  });

  it("matches docs PACE-004: rounds only at display conversion", () => {
    expect(formatPace(299.4)).toBe("4:59/km");
    expect(formatPace(299.6)).toBe("5:00/km");
  });

  it("rejects invalid pace inputs", () => {
    expect(() => averagePaceSecondsPerKilometer(0, 60)).toThrow(RangeError);
    expect(() => paceToSecondsPerKilometer(4, 60)).toThrow(RangeError);
  });
});
