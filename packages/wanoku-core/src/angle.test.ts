import { describe, expect, it } from "vitest";
import { angleDiff } from "./angle";

describe("wanoku angleDiff", () => {
  it("uses the shortest circular difference across north", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(20);
  });

  it("handles opposite directions", () => {
    expect(angleDiff(90, 270)).toBe(180);
  });

  it("normalizes values outside 0-359 degrees", () => {
    expect(angleDiff(-10, 370)).toBe(20);
    expect(angleDiff(720, 0)).toBe(0);
  });

  it("rejects non-finite values", () => {
    expect(() => angleDiff(Number.NaN, 0)).toThrow(RangeError);
    expect(() => angleDiff(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
