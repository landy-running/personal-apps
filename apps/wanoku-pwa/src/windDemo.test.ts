import { describe, expect, it } from "vitest";
import { calculateWindDemo, describeWindDemoResult } from "./windDemo";

describe("wanoku-navi PWA wind demo", () => {
  it("calculates angleDiff and describes wind-facing usage", () => {
    const result = calculateWindDemo(350, 10);

    expect(result).toMatchObject({
      ok: true,
      diff: 20
    });
    expect(describeWindDemoResult(result)).toContain("風表判定");
  });

  it("describes opposite angles as leeward-facing usage", () => {
    const result = calculateWindDemo(90, 270);

    expect(result).toMatchObject({
      ok: true,
      diff: 180
    });
    expect(describeWindDemoResult(result)).toContain("風裏判定");
  });
});

