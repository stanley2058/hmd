const UNITS: Record<string, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  ms: 1,
  s: 1000,
};

export function parseDuration(value: string): number {
  if (value === "0") return 0;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use values such as 30s, 5m, or 1h.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit) throw new Error(`Invalid duration "${value}".`);
  return amount * UNITS[unit]!;
}
