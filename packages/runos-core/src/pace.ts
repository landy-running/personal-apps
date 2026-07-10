export type PaceParts = {
  minutes: number;
  seconds: number;
};

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number.`);
  }
}

export function paceToSecondsPerKilometer(minutes: number, seconds = 0): number {
  assertFinitePositive(minutes, "minutes");

  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= 60) {
    throw new RangeError("seconds must be a finite number from 0 to 59.");
  }

  return minutes * 60 + seconds;
}

export function secondsPerKilometerToPaceParts(secondsPerKilometer: number): PaceParts {
  assertFinitePositive(secondsPerKilometer, "secondsPerKilometer");

  const rounded = Math.round(secondsPerKilometer);

  return {
    minutes: Math.floor(rounded / 60),
    seconds: rounded % 60
  };
}

export function formatPace(secondsPerKilometer: number): string {
  const { minutes, seconds } = secondsPerKilometerToPaceParts(secondsPerKilometer);
  return `${minutes}:${seconds.toString().padStart(2, "0")}/km`;
}

export function averagePaceSecondsPerKilometer(distanceKilometers: number, elapsedSeconds: number): number {
  assertFinitePositive(distanceKilometers, "distanceKilometers");
  assertFinitePositive(elapsedSeconds, "elapsedSeconds");

  return elapsedSeconds / distanceKilometers;
}

