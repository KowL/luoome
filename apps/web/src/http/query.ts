export const intQuery = (raw: string | undefined, fallback: number, min: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
};

export const enumQuery = <T extends string>(
  raw: string | undefined,
  fallback: T,
  allowed: readonly T[],
): T => {
  if (raw !== undefined && (allowed as readonly string[]).includes(raw)) return raw as T;
  return fallback;
};
