import { angleDiff } from "@personal/wanoku-core";

export type WindDemoResult =
  | {
      ok: true;
      angleA: number;
      angleB: number;
      diff: number;
      usage: string;
    }
  | {
      ok: false;
      message: string;
    };

export function calculateWindDemo(angleA: number, angleB: number): WindDemoResult {
  if (!Number.isFinite(angleA) || !Number.isFinite(angleB)) {
    return {
      ok: false,
      message: "角度は数値で入力してください。"
    };
  }

  const diff = angleDiff(angleA, angleB);

  return {
    ok: true,
    angleA,
    angleB,
    diff,
    usage: describeWindFacing(diff)
  };
}

export function describeWindDemoResult(result: WindDemoResult): string {
  if (!result.ok) return result.message;

  return `風向差: ${result.diff}°
利用例: ${result.usage}
入力: ${result.angleA}° と ${result.angleB}°`;
}

function describeWindFacing(diff: number): string {
  if (diff <= 30) return "向きが近いので、風表判定に使いやすい差です。";
  if (diff >= 150) return "ほぼ反対方向なので、風裏判定に使いやすい差です。";
  return "横風寄りの差として扱えます。";
}

