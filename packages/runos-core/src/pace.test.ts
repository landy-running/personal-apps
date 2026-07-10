import { describe, expect, it } from "vitest";
import {
  averagePaceSecondsPerKilometer,
  formatPace,
  paceToSecondsPerKilometer,
  secondsPerKilometerToPaceParts
} from "./pace";

describe("RunOS pace helpers", () => {
  it("converts min/km parts to seconds per kilometer", () => {
    expect(paceToSecondsPerKilometer(4, 30)).toBe(270);
  });

  it("converts seconds per kilometer to rounded pace parts", () => {
    expect(secondsPerKilometerToPaceParts(269.6)).toEqual({ minutes: 4, seconds: 30 });
  });

  it("formats min/km pace", () => {
    expect(formatPace(270)).toBe("4:30/km");
  });

  it("calculates average pace from distance and elapsed time", () => {
    expect(averagePaceSecondsPerKilometer(10, 45 * 60)).toBe(270);
  });

  it("rejects invalid pace inputs", () => {
    expect(() => averagePaceSecondsPerKilometer(0, 60)).toThrow(RangeError);
    expect(() => paceToSecondsPerKilometer(4, 60)).toThrow(RangeError);
  });
});

