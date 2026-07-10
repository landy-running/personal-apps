import { averagePaceSecondsPerKilometer, formatPace } from "@personal/runos-core";

export type PaceDemoInput = {
  distanceKilometers: number;
  elapsedMinutes: number;
  elapsedSeconds: number;
};

export type PaceDemoResult =
  | {
      ok: true;
      totalSeconds: number;
      secondsPerKilometer: number;
      formattedPace: string;
    }
  | {
      ok: false;
      message: string;
    };

export function calculatePaceDemo(input: PaceDemoInput): PaceDemoResult {
  if (!Number.isFinite(input.distanceKilometers) || input.distanceKilometers <= 0) {
    return {
      ok: false,
      message: "距離は0より大きいkmで入力してください。"
    };
  }

  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < 0 || !Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds < 0) {
    return {
      ok: false,
      message: "時間は0以上の分・秒で入力してください。"
    };
  }

  const totalSeconds = input.elapsedMinutes * 60 + input.elapsedSeconds;
  if (totalSeconds <= 0) {
    return {
      ok: false,
      message: "合計時間は0秒より大きくしてください。"
    };
  }

  const secondsPerKilometer = averagePaceSecondsPerKilometer(input.distanceKilometers, totalSeconds);

  return {
    ok: true,
    totalSeconds,
    secondsPerKilometer,
    formattedPace: formatPace(secondsPerKilometer)
  };
}

export function describePaceDemoResult(result: PaceDemoResult): string {
  if (!result.ok) return result.message;

  return `平均ペース: ${result.formattedPace}
秒/km: ${result.secondsPerKilometer.toFixed(2)}
合計時間: ${result.totalSeconds}秒`;
}

