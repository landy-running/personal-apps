import { describe, expect, it } from "vitest";
import { angleDiff } from "./angle";

describe("wanoku angleDiff", () => {
  it("uses the shortest circular difference across north", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(20);
    expect(angleDiff(359, 1)).toBe(2);
  });

  it("handles opposite directions", () => {
    expect(angleDiff(90, 270)).toBe(180);
    expect(angleDiff(0, 180)).toBe(180);
    expect(angleDiff(180, 0)).toBe(180);
  });

  it("treats 0 and 360 degrees as the same direction", () => {
    expect(angleDiff(0, 360)).toBe(0);
    expect(angleDiff(360, 0)).toBe(0);
    expect(angleDiff(720, 360)).toBe(0);
  });

  it("normalizes values outside 0-359 degrees", () => {
    expect(angleDiff(-10, 370)).toBe(20);
    expect(angleDiff(720, 0)).toBe(0);
  });

  it("is left-right symmetric for representative boundaries", () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 1],
      [1, 359],
      [45, 315],
      [90, 270],
      [-10, 370]
    ];

    for (const [a, b] of cases) {
      expect(angleDiff(a, b)).toBe(angleDiff(b, a));
    }
  });

  it("rejects non-finite values", () => {
    expect(() => angleDiff(Number.NaN, 0)).toThrow(RangeError);
    expect(() => angleDiff(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
