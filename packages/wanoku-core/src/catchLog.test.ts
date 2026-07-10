import { describe, expect, it } from "vitest";
import { createLightweightCatchLog, isLightweightCatchLog, isLightweightCatchLogArray } from "./catchLog";

describe("wanoku lightweight catch log", () => {
  it("creates a lightweight catch log", () => {
    const log = createLightweightCatchLog({
      id: "catch-1",
      date: "2026-07-10",
      spotName: "豊洲ぐるり",
      targetFish: "シーバス",
      result: "1匹",
      lure: "ミノー",
      note: "短時間"
    });

    expect(log).toEqual({
      id: "catch-1",
      date: "2026-07-10",
      spotName: "豊洲ぐるり",
      targetFish: "シーバス",
      result: "1匹",
      lure: "ミノー",
      note: "短時間"
    });
    expect(isLightweightCatchLog(log)).toBe(true);
    expect(isLightweightCatchLogArray([log])).toBe(true);
  });

  it("rejects invalid required fields", () => {
    expect(() =>
      createLightweightCatchLog({
        id: "catch-1",
        date: "2026-07-10",
        spotName: "",
        targetFish: "シーバス",
        result: "1匹"
      })
    ).toThrow(TypeError);
    expect(() =>
      createLightweightCatchLog({
        id: "catch-1",
        date: "2026/07/10",
        spotName: "豊洲",
        targetFish: "シーバス",
        result: "1匹"
      })
    ).toThrow(TypeError);
  });
});

