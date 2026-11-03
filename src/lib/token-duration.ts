/** Deliberately accept one bounded format shared by JWT and cookie lifetimes. */
export function tokenDurationSeconds(value: string): number {
  const match = /^([1-9]\d*)([smhd])$/.exec(value);
  if (!match) throw new Error("Token lifetime must be a positive duration such as 15m or 7d");
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]!];
  const seconds = Number(match[1]) * multiplier!;
  if (!Number.isSafeInteger(seconds) || seconds > 365 * 86400) {
    throw new Error("Token lifetime must not exceed 365 days");
  }
  return seconds;
}
