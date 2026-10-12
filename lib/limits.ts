// Shared between the UI and the API
export const DEFAULT_RETRIES = 2; // On failure QStash retries 2 more times → up to 3 attempts
export const MAX_RETRIES = 3; // QStash free plan caps retries, so keep the demo within it

export function clampRetries(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_RETRIES, Math.max(0, Math.round(n))) : DEFAULT_RETRIES;
}
