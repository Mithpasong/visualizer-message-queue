// Deliberately CPU-heavy task: count primes from 2 to N using trial division.
export const MAX_INPUT = 50_000_000;
const STEPS = 10; // Record progress only every 10% (saves Redis commands)

export class InvalidInputError extends Error {}
export class SimulatedFailure extends Error {}

/** Validate user input. Invalid input fails no matter how many retries, so it is not retried. */
export function parseInput(raw: string) {
  const text = raw.replaceAll(",", "").replaceAll("_", "").trim();
  if (!/^\d+$/.test(text)) {
    throw new InvalidInputError(`Not a number: "${raw}"`);
  }
  const n = Number(text);
  if (n < 2) throw new InvalidInputError(`Must be at least 2: ${n}`);
  if (n > MAX_INPUT) {
    throw new InvalidInputError(`Too large (max ${MAX_INPUT.toLocaleString("en-US")}): ${n.toLocaleString("en-US")}`);
  }
  return n;
}

function isPrime(n: number) {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) {
    if (n % d === 0) return false;
  }
  return true;
}

export async function countPrimes(
  limit: number,
  onProgress: (percent: number) => Promise<void>,
  options: { failAt?: number } = {},
) {
  const chunk = Math.ceil(limit / STEPS);
  let count = 0;

  for (let step = 0; step < STEPS; step++) {
    const from = step * chunk;
    const to = step === STEPS - 1 ? limit + 1 : from + chunk;
    for (let n = from; n < to; n++) {
      if (isPrime(n)) count++;
    }

    const percent = Math.round(((step + 1) / STEPS) * 100);
    await onProgress(percent);
    if (options.failAt !== undefined && percent >= options.failAt) {
      throw new SimulatedFailure(`Processing error at ${percent}%`);
    }
  }

  return count;
}
